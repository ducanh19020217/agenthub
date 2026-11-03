import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDigest } from '../src/brain/digest.js';
import { openDatabase, ProfileRepo, QuotaMarkRepo, TaskRepo } from '../src/db/index.js';
import { QuotaService, formatRunnableCapacity } from '../src/quota/index.js';

describe('QuotaService capacity and snapshots', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let profileRepo: ProfileRepo;
  let quotaMarkRepo: QuotaMarkRepo;
  let taskRepo: TaskRepo;
  let quotaService: QuotaService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-quota-cap-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    profileRepo = new ProfileRepo(db);
    quotaMarkRepo = new QuotaMarkRepo(db);
    taskRepo = new TaskRepo(db);
    quotaService = new QuotaService(quotaMarkRepo, profileRepo);
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for Windows/open handles.
    }
  });

  it('runnableCapacity returns empty when no profiles exist or all are disabled/errored', () => {
    expect(quotaService.runnableCapacity()).toEqual([]);

    profileRepo.upsert({ name: 'p-disabled', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 0 });
    profileRepo.upsert({ name: 'p-auth-err', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1, authState: 'error' });
    profileRepo.upsert({ name: 'p-auth-login', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1, authState: 'not_logged_in' });
    profileRepo.upsert({ name: 'p-auth-verify', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1, authState: 'needs_verification' });

    expect(quotaService.runnableCapacity()).toEqual([]);
  });

  it('runnableCapacity returns empty when all enabled profiles have active marks for every model', () => {
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1, authState: 'ok' });
    profileRepo.upsert({ name: 'codeX1', engine: 'codex', kind: 'codex', home: tmpDir, email: null, enabled: 1, authState: 'ok' });

    const now = 1_000_000;
    // AgY models cover gemini, claude, gpt. Codex covers codex.
    quotaMarkRepo.mark('g1', 'gemini', now + 3600);
    quotaMarkRepo.mark('g1', 'claude', now + 3600);
    quotaMarkRepo.mark('g1', 'gpt', now + 3600);
    quotaMarkRepo.mark('codeX1', 'codex', now + 3600);

    const runnable = quotaService.runnableCapacity(undefined, now);
    expect(runnable).toEqual([]);
  });

  it('capacitySnapshot calculates nextReset correctly when capacity is completely exhausted', () => {
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    profileRepo.upsert({ name: 'codeX1', engine: 'codex', kind: 'codex', home: tmpDir, email: null, enabled: 1 });

    const now = 1_000_000;
    quotaMarkRepo.mark('g1', 'gemini', now + 1800);
    quotaMarkRepo.mark('g1', 'claude', now + 7200);
    quotaMarkRepo.mark('g1', 'gpt', now + 7200);
    quotaMarkRepo.mark('codeX1', 'codex', now + 3600);

    const snapshot = quotaService.capacitySnapshot(undefined, now);
    expect(snapshot.runnable).toHaveLength(0);
    // Earliest reset is gemini on g1 at now + 1800
    expect(snapshot.nextResetAt).toBe(now + 1800);
    expect(snapshot.nextReset).toMatchObject({
      profileName: 'g1',
      model: expect.stringContaining('gemini'),
      at: now + 1800,
    });
  });

  it('capacitySnapshot isolates nextReset to exhausted families and does not report reset for available families', () => {
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: 'a@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'g2', engine: 'agy', kind: 'isolated', home: tmpDir, email: 'b@example.com', enabled: 1 });

    const now = 1_000_000;
    // g1 has a mark on gemini ending at now + 10, BUT g2 still has gemini available!
    quotaMarkRepo.mark('g1', 'gemini', now + 10);
    // Both g1 and g2 are exhausted for claude, with earliest reset at now + 300
    quotaMarkRepo.mark('g1', 'claude', now + 500);
    quotaMarkRepo.mark('g2', 'claude', now + 300);

    const snapshot = quotaService.capacitySnapshot(['gemini-3.8-flash-high', 'claude-sonnet-4-6'], now);
    // gemini is still runnable (via g2)
    expect(snapshot.runnable.some((entry) => entry.family === 'gemini' && entry.profileName === 'g2')).toBe(true);
    // claude has no runnable profile, so nextReset must be claude at now + 300 (not gemini at now + 10!)
    expect(snapshot.nextResetAt).toBe(now + 300);
    expect(snapshot.nextReset).toMatchObject({
      profileName: 'g2',
      model: 'claude-sonnet-4-6',
      at: now + 300,
    });
  });

  it('capacitySnapshot returns null nextReset when everything is runnable', () => {
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    const snapshot = quotaService.capacitySnapshot(['gemini-3.8-flash-high']);
    expect(snapshot.runnable).toHaveLength(1);
    expect(snapshot.nextResetAt).toBeNull();
    expect(snapshot.nextReset).toBeUndefined();
  });

  it('capacitySnapshot ignores marks belonging to disabled or unauthenticated profiles', () => {
    profileRepo.upsert({ name: 'disabled', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 0 });
    profileRepo.upsert({ name: 'logged-out', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1, authState: 'not_logged_in' });
    const now = 1_000_000;
    quotaMarkRepo.mark('disabled', 'claude', now + 10);
    quotaMarkRepo.mark('logged-out', 'claude', now + 20);

    const snapshot = quotaService.capacitySnapshot(['claude-sonnet-4-6'], now);
    expect(snapshot.runnable).toHaveLength(0);
    expect(snapshot.nextResetAt).toBeNull();
    expect(snapshot.nextReset).toBeUndefined();
  });

  it('formatRunnableCapacity formats single-account and multi-account groups cleanly', () => {
    const formatted = formatRunnableCapacity({
      runnable: [
        { profileName: 'g1', engine: 'agy', family: 'gemini', model: 'gemini-3.8-flash-high' },
        { profileName: 'g2', engine: 'agy', family: 'gemini', model: 'gemini-3.8-flash-high' },
        { profileName: 'codeX1', engine: 'codex', family: 'codex', model: 'codex:gpt-5.6-luna' },
      ],
      nextResetAt: null,
    });
    expect(formatted).toBe('Gemini (2 tài khoản), Codex (codeX1)');
  });

  it('digest distinguishes partial family exhaustion from a total capacity outage', () => {
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    const now = 1_000_000;
    quotaMarkRepo.mark('g1', 'claude', now + 3600);
    quotaMarkRepo.mark('g1', 'gpt', now + 3600);

    let digest = generateDigest({ taskRepo, profileRepo, quotaMarkRepo, quotaService, now: () => now * 1000 });
    expect(digest.quota.summary).not.toContain('Hệ thống tạm dừng thực thi task');
    expect(digest.quota.summary).toContain('Tất cả tài khoản đều sẵn sàng');

    quotaMarkRepo.mark('g1', 'gemini', now + 3600);
    digest = generateDigest({ taskRepo, profileRepo, quotaMarkRepo, quotaService, now: () => now * 1000 });
    expect(digest.quota.summary).toContain('Hệ thống tạm dừng thực thi task');
  });
});
