import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { UpdateConfigSchema } from '../src/services/index.js';
import { quotaLowText } from '../src/quota/alerts.js';
import type { QuotaUsageRow } from '../src/db/index.js';

describe('quota.low alerts', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let events: unknown[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-quota-low-'));
    process.env.AGENTHUB_HOME = tmpDir;
    const config = loadConfig(tmpDir);
    config.agyHomesDir = path.join(tmpDir, 'agy-homes');
    ctx = createContext(config);
    ctx.service.createProfile({ name: 'g1', engine: 'agy', accountType: 'team' });
    events = [];
    ctx.scheduler.getEventBus().on('quota.low', (_taskId: unknown, payload: unknown) => events.push(payload));
  });

  afterEach(() => {
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const row = (remainingPct: number): QuotaUsageRow => ({
    profileName: 'g1', grp: 'Gemini Models', window: '5h', remainingPct, resetAt: 1_800_000_000, fetchedAt: Math.floor(Date.now() / 1000),
  });

  it('fires once when a window drops below the default 20% threshold', () => {
    const store = (r: QuotaUsageRow) => ctx.service.usageService['store'](r);
    store(row(60));
    store(row(18));
    store(row(12));
    store(row(0));
    expect(events).toEqual([expect.objectContaining({ profile: 'g1', window: '5h', remainingPct: 18, threshold: 20 })]);

    // Sau khi hồi lại trên ngưỡng thì lần tụt kế tiếp được báo lại.
    store(row(80));
    store(row(10));
    expect(events).toHaveLength(2);
  });

  it('stays silent when the threshold is 0', () => {
    ctx.service.updateConfig({ notifications: { desktop: true, quotaLowPct: 0 } });
    ctx.service.usageService['store'](row(5));
    expect(events).toEqual([]);
  });

  it('formats a readable message', () => {
    expect(quotaLowText({ profile: 'g1', remainingPct: 15, window: 'week', group: 'Codex', resetAt: 0 })).toBe('Hồ sơ g1 còn 15% quota tuần (Codex)');
  });

  it('keeps quiet hours and the threshold when settings are saved', () => {
    const parsed = UpdateConfigSchema.parse({
      notifications: { desktop: true, quietHours: { enabled: true, start: '23:00', end: '06:00' }, quotaLowPct: 30 },
    });
    expect(parsed.notifications).toEqual({ desktop: true, quietHours: { enabled: true, start: '23:00', end: '06:00' }, quotaLowPct: 30 });
  });
});
