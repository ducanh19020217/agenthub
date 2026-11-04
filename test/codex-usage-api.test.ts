import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { parseCodexUsage, readCodexAccessToken } from '../src/quota/codex-api.js';

describe('Codex quota and plan from wham/usage (DEC-014)', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let originalFetch: typeof globalThis.fetch;
  let home: string;
  let previousCodexBin: string | undefined;

  beforeEach(() => {
    // Không bao giờ chạy Codex thật: refreshUsage còn đọc lại email bằng `codex login status`.
    previousCodexBin = process.env.AGENTHUB_CODEX_BIN;
    process.env.AGENTHUB_CODEX_BIN = path.resolve(__dirname, 'fixtures', 'fake-codex-login-status.mjs');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-api-'));
    process.env.AGENTHUB_HOME = tmpDir;
    const config = loadConfig(tmpDir);
    config.agyHomesDir = path.join(tmpDir, 'agy-homes');
    config.multiplePerProvider = true;
    ctx = createContext(config);
    originalFetch = globalThis.fetch;
    ctx.service.createProfile({ name: 'cx', engine: 'codex', accountType: 'personal' });
    home = ctx.profileRepo.get('cx')!.home!;
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: 'idt', access_token: 'cx-access', refresh_token: 'cx-refresh', account_id: 'acc-9' },
      last_refresh: new Date().toISOString(),
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousCodexBin === undefined) delete process.env.AGENTHUB_CODEX_BIN;
    else process.env.AGENTHUB_CODEX_BIN = previousCodexBin;
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses windows by length and reset fields', () => {
    const now = 1_000_000;
    expect(parseCodexUsage({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 600 },
        secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: now + 86_400 },
      },
    }, now)).toEqual({
      plan: 'plus',
      windows: [
        { window: '5h', usedPercent: 25, resetAt: now + 600 },
        { window: 'week', usedPercent: 60, resetAt: now + 86_400 },
      ],
    });
  });

  it('only exposes access token and account id from auth.json', () => {
    expect(readCodexAccessToken(home)).toEqual({ accessToken: 'cx-access', accountId: 'acc-9' });
  });

  it('refresh stores quota and plan without running codex, sending the account header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
        },
      }),
    } as unknown as Response);

    const profile = await ctx.service.refreshUsage('cx');

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect((init?.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe('acc-9');
    expect(profile?.plan).toBe('pro');
    expect(profile?.refreshMessage).toMatch(/Đã cập nhật quota Codex · Gói PRO/);
    const usage = ctx.usageRepo.getForProfile('cx');
    expect(usage.find((u) => u.window === '5h')?.remainingPct).toBe(90);
    expect(usage.find((u) => u.window === 'week')?.remainingPct).toBe(60);
    expect(JSON.stringify(profile)).not.toContain('cx-access');
  });

  it('explains an expired token and keeps older log data from overwriting newer API data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
    expect((await ctx.service.refreshUsage('cx'))?.refreshMessage).toMatch(/HTTP 401/);

    const now = Math.floor(Date.now() / 1000);
    ctx.usageRepo.upsert({ profileName: 'cx', grp: 'Codex', window: '5h', remainingPct: 90, resetAt: now + 3600, fetchedAt: now });
    const day = path.join(home, 'sessions', '2026', '01', '01');
    fs.mkdirSync(day, { recursive: true });
    const old = path.join(day, 'rollout-old.jsonl');
    fs.writeFileSync(old, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 99, window_minutes: 300, resets_in_seconds: 60 } } } }) + '\n');
    fs.utimesSync(old, now - 86_400, now - 86_400);

    ctx.service.usageService.collectCodex(ctx.profileRepo.get('cx')!);
    expect(ctx.usageRepo.getForProfile('cx').find((u) => u.window === '5h')?.remainingPct).toBe(90);
  });
});
