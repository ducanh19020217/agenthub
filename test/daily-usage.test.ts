import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import {
  formatHoChiMinhDate,
  getDailyDateList,
  extractProfileQuota,
  isProfileSuggestedIdle,
  getDailyUsageReport,
  DAILY_USAGE_TIMEZONE,
} from '../src/daily-usage.js';
import { ProfileRow, QuotaUsageRow } from '../src/db/index.js';

describe('Daily Usage Functions & Timezone', () => {
  describe('formatHoChiMinhDate', () => {
    it('formats ISO UTC strings into Asia/Ho_Chi_Minh dates across midnight boundary', () => {
      // 2026-10-15 16:59:59 UTC is 2026-10-15 23:59:59 in Asia/Ho_Chi_Minh (UTC+7)
      expect(formatHoChiMinhDate('2026-10-15T16:59:59.000Z')).toBe('2026-10-15');

      // 2026-10-15 17:00:00 UTC is 2026-10-16 00:00:00 in Asia/Ho_Chi_Minh (UTC+7)
      expect(formatHoChiMinhDate('2026-10-15T17:00:00.000Z')).toBe('2026-10-16');

      // 2026-10-15 18:30:00 UTC is 2026-10-16 01:30:00 in Asia/Ho_Chi_Minh
      expect(formatHoChiMinhDate('2026-10-15T18:30:00.000Z')).toBe('2026-10-16');
    });

    it('formats SQLite UTC datetime string into Asia/Ho_Chi_Minh', () => {
      // SQLite datetime('now') format 'YYYY-MM-DD HH:MM:SS' in UTC
      expect(formatHoChiMinhDate('2026-10-15 16:59:59')).toBe('2026-10-15');
      expect(formatHoChiMinhDate('2026-10-15 17:00:00')).toBe('2026-10-16');
      expect(formatHoChiMinhDate('2026-10-20 02:00:00')).toBe('2026-10-20');
    });

    it('formats epoch timestamps and Date objects', () => {
      const epoch = Date.parse('2026-10-15T18:00:00Z');
      expect(formatHoChiMinhDate(epoch)).toBe('2026-10-16');
      expect(formatHoChiMinhDate(new Date(epoch))).toBe('2026-10-16');
    });

    it('returns empty string for invalid dates', () => {
      expect(formatHoChiMinhDate('invalid-date')).toBe('');
    });
  });

  describe('getDailyDateList', () => {
    it('returns today and past 7 days (8 dates in total)', () => {
      // Set fixed reference time: 2026-10-20T03:00:00Z (which is 10:00:00 in Asia/Ho_Chi_Minh)
      const refTime = new Date('2026-10-20T03:00:00Z');
      const dates = getDailyDateList(7, refTime);

      expect(dates).toHaveLength(8);
      expect(dates[0]).toBe('2026-10-20'); // Hôm nay
      expect(dates[1]).toBe('2026-10-19');
      expect(dates[2]).toBe('2026-10-18');
      expect(dates[3]).toBe('2026-10-17');
      expect(dates[4]).toBe('2026-10-16');
      expect(dates[5]).toBe('2026-10-15');
      expect(dates[6]).toBe('2026-10-14');
      expect(dates[7]).toBe('2026-10-13');
    });

    it('handles custom days parameter', () => {
      const refTime = new Date('2026-10-20T03:00:00Z');
      const dates = getDailyDateList(3, refTime);
      expect(dates).toHaveLength(4);
      expect(dates).toEqual(['2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17']);
    });
  });

  describe('extractProfileQuota', () => {
    it('extracts gemini and claude 5h and week quotas', () => {
      const rows: QuotaUsageRow[] = [
        {
          profileName: 'g1',
          grp: 'Gemini Models',
          window: '5h',
          remainingPct: 85,
          resetAt: 1700000000,
          fetchedAt: 1699999000,
        },
        {
          profileName: 'g1',
          grp: 'Gemini Models',
          window: 'week',
          remainingPct: 92,
          resetAt: 1700500000,
          fetchedAt: 1699999000,
        },
        {
          profileName: 'g1',
          grp: 'Claude and GPT models',
          window: '5h',
          remainingPct: 40,
          resetAt: 1700000000,
          fetchedAt: 1699999000,
        },
        {
          profileName: 'g1',
          grp: 'Claude and GPT models',
          window: 'week',
          remainingPct: 75,
          resetAt: 1700500000,
          fetchedAt: 1699999000,
        },
      ];

      const quota = extractProfileQuota(rows);
      expect(quota).toEqual({
        gemini5h: 85,
        geminiWeek: 92,
        claude5h: 40,
        claudeWeek: 75,
      });
    });

    it('returns nulls when no quota rows are present', () => {
      const quota = extractProfileQuota([]);
      expect(quota).toEqual({
        gemini5h: null,
        geminiWeek: null,
        claude5h: null,
        claudeWeek: null,
      });
    });
  });

  describe('isProfileSuggestedIdle', () => {
    const baseProfile: ProfileRow = {
      name: 'g1',
      engine: 'agy',
      kind: 'isolated',
      home: '/home/g1',
      email: 'g1@example.com',
      enabled: 1,
      createdAt: '2026-10-01 00:00:00',
    };

    it('suggests idle when profile has plenty of quota and 0 runs today', () => {
      const res = isProfileSuggestedIdle({
        profile: baseProfile,
        quota: { gemini5h: 90, geminiWeek: 95, claude5h: 80, claudeWeek: 85 },
        hasQuotaMarks: false,
        isBusy: false,
        todayRuns: 0,
        todayTokens: 0,
      });
      expect(res.isIdle).toBe(true);
    });

    it('does not suggest idle when profile is locked by quota mark', () => {
      const res = isProfileSuggestedIdle({
        profile: baseProfile,
        quota: { gemini5h: 90, geminiWeek: 95, claude5h: 80, claudeWeek: 85 },
        hasQuotaMarks: true,
        isBusy: false,
        todayRuns: 0,
        todayTokens: 0,
      });
      expect(res.isIdle).toBe(false);
    });

    it('does not suggest idle when profile is disabled', () => {
      const res = isProfileSuggestedIdle({
        profile: { ...baseProfile, enabled: 0 },
        quota: { gemini5h: 90, geminiWeek: 95, claude5h: 80, claudeWeek: 85 },
        hasQuotaMarks: false,
        isBusy: false,
        todayRuns: 0,
        todayTokens: 0,
      });
      expect(res.isIdle).toBe(false);
    });

    it('does not suggest idle when profile is currently busy running a task', () => {
      const res = isProfileSuggestedIdle({
        profile: baseProfile,
        quota: { gemini5h: 90, geminiWeek: 95, claude5h: 80, claudeWeek: 85 },
        hasQuotaMarks: false,
        isBusy: true,
        todayRuns: 0,
        todayTokens: 0,
      });
      expect(res.isIdle).toBe(false);
    });

    it('does not suggest idle when profile ran many tasks today', () => {
      const res = isProfileSuggestedIdle({
        profile: baseProfile,
        quota: { gemini5h: 90, geminiWeek: 95, claude5h: 80, claudeWeek: 85 },
        hasQuotaMarks: false,
        isBusy: false,
        todayRuns: 5,
        todayTokens: 120000,
      });
      expect(res.isIdle).toBe(false);
    });

    it('does not suggest idle when remaining quota is below 50%', () => {
      const res = isProfileSuggestedIdle({
        profile: baseProfile,
        quota: { gemini5h: 15, geminiWeek: 30, claude5h: 20, claudeWeek: 25 },
        hasQuotaMarks: false,
        isBusy: false,
        todayRuns: 0,
        todayTokens: 0,
      });
      expect(res.isIdle).toBe(false);
    });

    it('suggests idle for codex profile without locks and with low runs', () => {
      const codexProfile: ProfileRow = {
        name: 'codex',
        engine: 'codex',
        kind: 'codex',
        home: null,
        email: null,
        enabled: 1,
        createdAt: '2026-10-01 00:00:00',
      };
      const res = isProfileSuggestedIdle({
        profile: codexProfile,
        quota: { gemini5h: null, geminiWeek: null, claude5h: null, claudeWeek: null },
        hasQuotaMarks: false,
        isBusy: false,
        todayRuns: 0,
        todayTokens: 0,
      });
      expect(res.isIdle).toBe(true);
    });
  });
});

describe('GET /api/usage/daily integration & report generation', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: ReturnType<typeof createServer>;
  let token: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00+07:00'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-daily-usage-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    const webDir = path.join(tmpDir, 'web');
    fs.mkdirSync(webDir, { recursive: true });
    process.env.AGENTHUB_WEB_DIR = webDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.port = 7799;
    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    vi.useRealTimers();
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_WEB_DIR;
  });

  function authHeaders() {
    return {
      host: '127.0.0.1:7799',
      authorization: `Bearer ${token}`,
    };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/usage/daily',
      headers: { host: '127.0.0.1:7799' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('aggregates daily usage accurately according to Asia/Ho_Chi_Minh timezone', async () => {
    const db = ctx.db;

    // Create project & task
    db.prepare(`INSERT INTO projects (id, name, path) VALUES ('proj-1', 'Test Project', '/tmp/test')`).run();
    db.prepare(`INSERT INTO tasks (id, projectId, slug, title, status) VALUES ('task-1', 'proj-1', 't1', 'Task 1', 'done')`).run();

    // Create profiles: chinh, g1, g2, g3, codex
    const insertProfile = db.prepare(`INSERT INTO profiles (name, engine, kind, home, email, enabled) VALUES (?, ?, ?, ?, ?, 1)`);
    insertProfile.run('chinh', 'agy', 'keyring', null, 'chinh@example.com');
    insertProfile.run('g1', 'agy', 'isolated', '/tmp/g1', 'g1@example.com');
    insertProfile.run('g2', 'agy', 'isolated', '/tmp/g2', 'g2@example.com');
    insertProfile.run('g3', 'agy', 'isolated', '/tmp/g3', 'g3@example.com');
    insertProfile.run('codex', 'codex', 'codex', null, null);

    // Insert live quota usage for g1 and g2
    const insertQuota = db.prepare(`INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)`);
    insertQuota.run('g1', 'Gemini Models', '5h', 90, 1700000000, 1699990000);
    insertQuota.run('g1', 'Gemini Models', 'week', 95, 1700500000, 1699990000);
    insertQuota.run('g1', 'Claude and GPT models', '5h', 80, 1700000000, 1699990000);
    insertQuota.run('g1', 'Claude and GPT models', 'week', 85, 1700500000, 1699990000);

    // g2 has low quota
    insertQuota.run('g2', 'Gemini Models', '5h', 20, 1700000000, 1699990000);
    insertQuota.run('g2', 'Claude and GPT models', '5h', 15, 1700000000, 1699990000);

    // g3 is quota-locked
    db.prepare(`INSERT INTO quota_marks (profileName, family, until, reason) VALUES ('g3', 'gemini', strftime('%s', 'now') + 3600, 'Quota exhausted')`).run();

    // Insert runs:
    // Run 1: On 2026-10-15 16:00:00 UTC -> in Asia/Ho_Chi_Minh is 2026-10-15 (23:00)
    // Profile: chinh, duration: 60s, codex/metrics tokens: 50,000
    db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES ('run-1', 'task-1', 'agy', 'gemini-3.8-flash-high', 'chinh', '2026-10-15 16:00:00', '2026-10-15 16:01:00', 'done')`
    ).run();
    db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed, durationMs)
       VALUES ('run-1', 'task-1', 'agy', 'gemini-3.8-flash-high', 'chinh', 50000, 60000)`
    ).run();

    // Run 2: On 2026-10-15 18:00:00 UTC -> in Asia/Ho_Chi_Minh is 2026-10-16 (01:00)!
    // Profile: g1, duration: 120s, usageBefore: 90, usageAfter: 89 (1% drop = 50,000 tokens)
    db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES ('run-2', 'task-1', 'agy', 'gemini-3.8-flash-high', 'g1', '2026-10-15 18:00:00', '2026-10-15 18:02:00', 'done')`
    ).run();
    db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, usageBefore, usageAfter, durationMs)
       VALUES ('run-2', 'task-1', 'agy', 'gemini-3.8-flash-high', 'g1', 90, 89, 120000)`
    ).run();

    // Run 3: On 2026-10-16 02:00:00 UTC -> in Asia/Ho_Chi_Minh is 2026-10-16 (09:00)
    // Profile: codex, tokensUsed: 75,000, duration: 45s
    db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES ('run-3', 'task-1', 'codex', 'gpt-5.6-luna', 'codex', '2026-10-16 02:00:00', '2026-10-16 02:00:45', 'done')`
    ).run();
    db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed, durationMs)
       VALUES ('run-3', 'task-1', 'codex', 'gpt-5.6-luna', 'codex', 75000, 45000)`
    ).run();

    // Insert claude_usage on 2026-10-16 03:00:00 UTC (10:00 Asia/Ho_Chi_Minh)
    db.prepare(
      `INSERT INTO claude_usage (sessionId, messageId, ts, turnId, input, output, cacheCreation, cacheRead, effective)
       VALUES ('sess-1', 'msg-1', '2026-10-16 03:00:00', 'turn-1', 1000, 500, 200, 100, 42000)`
    ).run();

    // Test calling getDailyUsageReport directly with fixed reference time
    const report = getDailyUsageReport({
      days: 7,
      db,
      now: new Date('2026-10-16T10:00:00Z'), // Today is 2026-10-16 in Vietnam
    });

    expect(report.timezone).toBe(DAILY_USAGE_TIMEZONE);
    expect(report.dates[0]).toBe('2026-10-16');
    expect(report.dates[1]).toBe('2026-10-15');

    // Check chinh on 2026-10-15
    const chinh = report.profiles.find((p) => p.name === 'chinh')!;
    expect(chinh).toBeDefined();
    expect(chinh.daily['2026-10-15']).toEqual({
      runs: 1,
      durationMs: 60000,
      tokens: 50000,
    });
    // On 2026-10-16 (today), chinh has 0 runs
    expect(chinh.daily['2026-10-16']).toEqual({
      runs: 0,
      durationMs: 0,
      tokens: 0,
    });

    // Check g1 on 2026-10-16: should contain Run 2 because 18:00 UTC crosses into 2026-10-16 in Vietnam!
    const g1 = report.profiles.find((p) => p.name === 'g1')!;
    expect(g1).toBeDefined();
    expect(g1.daily['2026-10-16']).toEqual({
      runs: 1,
      durationMs: 120000,
      tokens: 50000, // 1% of 5,000,000
    });
    expect(g1.daily['2026-10-15']).toEqual({
      runs: 0,
      durationMs: 0,
      tokens: 0,
    });
    // g1 has high quota (90% Gemini) and only 1 run today -> isIdle should be true ("gợi ý đang rảnh")
    expect(g1.isIdle).toBe(true);

    // Check codex on 2026-10-16
    const codex = report.profiles.find((p) => p.name === 'codex')!;
    expect(codex.daily['2026-10-16']).toEqual({
      runs: 1,
      durationMs: 45000,
      tokens: 75000,
    });

    // Check g2: low quota (20% Gemini, 15% Claude) -> isIdle should be false
    const g2 = report.profiles.find((p) => p.name === 'g2')!;
    expect(g2.isIdle).toBe(false);

    // Check g3: quota locked -> isIdle should be false
    const g3 = report.profiles.find((p) => p.name === 'g3')!;
    expect(g3.isIdle).toBe(false);

    // Check byDay structure for 2026-10-16
    const dayToday = report.byDay.find((d) => d.date === '2026-10-16')!;
    expect(dayToday).toBeDefined();
    expect(dayToday.isToday).toBe(true);
    expect(dayToday.totalRuns).toBe(2); // g1 (1) + codex (1)
    expect(dayToday.totalDurationMs).toBe(165000); // 120000 + 45000
    expect(dayToday.totalTokens).toBe(125000); // 50000 + 75000
    expect(dayToday.claudeTokens).toBe(42000);

    // Test API response via Fastify GET /api/usage/daily (the API uses the real clock, so pin it to the fixture day)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    let res;
    try {
      res = await server.inject({
        method: 'GET',
        url: '/api/usage/daily?days=7',
        headers: authHeaders(),
      });
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(body.dates).toBeDefined();
    expect(body.dates.length).toBe(8); // today + 7 past days
    expect(body.profiles).toBeDefined();
    expect(body.profiles.length).toBe(5);
    expect(body.byDay).toBeDefined();
    const apiDayToday = body.byDay.find((d: { date: string; claudeTokens?: number }) => d.date === '2026-10-16');
    expect(apiDayToday.claudeTokens).toBe(42000);
  });

  it('supports days query parameter', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/usage/daily?days=3',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.dates).toHaveLength(4); // today + 3 past days
    expect(body.days).toBe(3);
  });
});
