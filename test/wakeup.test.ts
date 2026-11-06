import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, parseWakeupConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { planWakeup, wakeupSucceeded, DEFAULT_WAKEUP_CONFIG, type WakeupCommand } from '../src/quota/wakeup.js';
import { writeAgyIsolatedToken } from '../src/profiles/agyToken.js';
import type { ProfileRow, QuotaUsageRow } from '../src/db/index.js';

const NOW = 1_800_000_000;
const agy = { name: 'g1', engine: 'agy', kind: 'isolated', home: '/tmp/g1', email: 'a@x.com', enabled: 1 } as ProfileRow;
const row = (grp: string, remainingPct: number, resetAt: number): QuotaUsageRow => ({ profileName: 'g1', grp, window: '5h', remainingPct, resetAt, fetchedAt: NOW });

describe('planWakeup', () => {
  const state = { loggedIn: true, busy: false, nowSec: NOW };

  it('wakes only the agy families whose 5h window is idle', () => {
    const usage = [row('Gemini Models', 70, NOW + 3600), row('Claude and GPT models', 100, NOW + 18_000)];
    expect(planWakeup(agy, usage, DEFAULT_WAKEUP_CONFIG, state).models).toEqual(['claude-sonnet-4-6']);
  });

  it('skips running windows unless forced, and never wakes busy, disabled or logged-out profiles', () => {
    const usage = [row('Gemini Models', 70, NOW + 3600), row('Claude and GPT models', 40, NOW + 3600)];
    expect(planWakeup(agy, usage, DEFAULT_WAKEUP_CONFIG, state).skip).toBe('Cửa sổ 5 giờ đang chạy');
    expect(planWakeup(agy, usage, DEFAULT_WAKEUP_CONFIG, { ...state, force: true }).models).toHaveLength(2);
    expect(planWakeup(agy, [], DEFAULT_WAKEUP_CONFIG, { ...state, busy: true }).skip).toBe('Hồ sơ đang chạy task');
    expect(planWakeup({ ...agy, enabled: 0 }, [], DEFAULT_WAKEUP_CONFIG, state).skip).toBe('Hồ sơ đang tắt');
    expect(planWakeup(agy, [], DEFAULT_WAKEUP_CONFIG, { ...state, loggedIn: false }).skip).toBe('Hồ sơ chưa đăng nhập');
  });

  it('judges agy by output because its exit code is unreliable', () => {
    expect(wakeupSucceeded('agy', { output: 'OK\n', error: 'exit 1' })).toBe(true);
    expect(wakeupSucceeded('agy', { output: 'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED"}' })).toBe(false);
    expect(wakeupSucceeded('codex', { output: 'OK' })).toBe(true);
    expect(wakeupSucceeded('codex', { output: '', error: 'boom' })).toBe(false);
  });

  it('parses config and drops invalid values', () => {
    expect(parseWakeupConfig({ enabled: true, times: ['6:30', '25:00', 'x'], profiles: ['g1', 'bad name'] }))
      .toEqual({ enabled: true, times: ['6:30'], profiles: ['g1'], agyModels: DEFAULT_WAKEUP_CONFIG.agyModels });
  });
});

describe('AppService wake-up', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let ran: WakeupCommand[];
  let previousAgyBin: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-wakeup-'));
    previousAgyBin = process.env.AGENTHUB_AGY_BIN;
    // Đọc quota sau khi đánh thức dùng agy giả; lệnh đánh thức dùng runner giả.
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-usage.mjs');
    process.env.AGENTHUB_HOME = tmpDir;
    const config = loadConfig(tmpDir);
    config.agyHomesDir = path.join(tmpDir, 'agy-homes');
    ctx = createContext(config);
    ran = [];
    ctx.service.wakeupRunner = async (cmd) => {
      ran.push(cmd);
      return { output: 'OK\n' };
    };
    ctx.service.createProfile({ name: 'g1', engine: 'agy', accountType: 'team' });
    writeAgyIsolatedToken(path.join(config.agyHomesDir, 'g1'), { accessToken: 'at', refreshToken: 'rt' }, 'g1@example.com');
    ctx.profileRepo.upsert({ ...ctx.profileRepo.get('g1')!, email: 'g1@example.com' });
  });

  afterEach(() => {
    if (previousAgyBin === undefined) delete process.env.AGENTHUB_AGY_BIN;
    else process.env.AGENTHUB_AGY_BIN = previousAgyBin;
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('wakes a profile on demand with its isolated HOME and reports per model', async () => {
    const result = await ctx.service.wakeupProfile('g1', { force: true });

    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.target)).toEqual(DEFAULT_WAKEUP_CONFIG.agyModels);
    expect(ran[0].args.slice(0, 4)).toEqual(['-p', 'Reply with the single word OK.', '--model', 'gemini-3.8-flash-low']);
    expect(ran[0].env.HOME).toBe(path.join(tmpDir, 'agy-homes', 'g1'));
    expect(ran[0].env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/nonexistent/agy-no-keyring');
  });

  it('runs a scheduled time once per day and only when enabled', async () => {
    const at = new Date(2026, 9, 22, 6, 0, 10);
    expect(await ctx.service.runScheduledWakeups(at)).toEqual([]);

    ctx.service.updateConfig({ wakeup: { enabled: true, times: ['06:00'] } });
    expect(await ctx.service.runScheduledWakeups(at)).toEqual(['g1']);
    expect(await ctx.service.runScheduledWakeups(new Date(2026, 9, 22, 6, 0, 40))).toEqual([]);
    expect(await ctx.service.runScheduledWakeups(new Date(2026, 9, 22, 7, 0, 0))).toEqual([]);
  });
});
