import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { openDatabase, TaskRepo, QuotaMarkRepo, EventRepo, ProjectRepo, ProfileRepo } from '../src/db/index.js';
import { EventBus } from '../src/scheduler/index.js';
import { NotificationService } from '../src/notify.js';
import { areAllProfilesQuotaExhaustedForFamily } from '../src/brain/digest.js';
import { QuotaService, formatRunnableCapacity } from '../src/quota/index.js';

describe('NotificationService (Desktop Notifications)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let projectRepo: ProjectRepo;
  let profileRepo: ProfileRepo;
  let taskRepo: TaskRepo;
  let quotaMarkRepo: QuotaMarkRepo;
  let eventRepo: EventRepo;
  let eventBus: EventBus;
  let config: ReturnType<typeof loadConfig>;
  let execCalls: Array<{ file: string; args: string[] }>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00+07:00'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-notify-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    config = loadConfig(tmpDir);
    // Legacy cases below exercise the unfiltered notification formatter.
    config.notifications.desktopLevel = 'all';

    db = openDatabase(config.dbPath);
    projectRepo = new ProjectRepo(db);
    profileRepo = new ProfileRepo(db);
    taskRepo = new TaskRepo(db);
    quotaMarkRepo = new QuotaMarkRepo(db);
    eventRepo = new EventRepo(db);
    eventBus = new EventBus(eventRepo);

    projectRepo.insert({ id: 'proj', name: 'Proj', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 2 });
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    profileRepo.upsert({ name: 'chinh', engine: 'agy', kind: 'keyring', home: tmpDir, email: null, enabled: 1 });

    execCalls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
  });

  const fakeExec = (file: string, args: string[]) => {
    execCalls.push({ file, args });
  };

  it('important level suppresses account-specific quota and overlap notifications', () => {
    config.notifications.desktopLevel = 'important';
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();
    eventBus.emit('quota.exhausted', undefined, { profile: 'g1', family: 'gemini' });
    eventBus.emit('task.overlap', 'proj/task-1', { otherTaskId: 'proj/task-2', file: 'shared.ts' });
    expect(execCalls).toHaveLength(0);
  });

  it('suppresses account-specific quota notifications even at all level', () => {
    const notifier = new NotificationService({ eventBus, config, profileRepo, quotaMarkRepo, exec: fakeExec });
    notifier.start();
    eventBus.emit('quota.exhausted', undefined, { profile: 'g1', family: 'gemini', engine: 'agy' });
    expect(execCalls).toHaveLength(0);
    notifier.stop();
  });

  it('notifies on task.review_ready with title and optional checks indicator', () => {
    taskRepo.insert({
      id: 'proj/task-1',
      projectId: 'proj',
      slug: 'task-1',
      title: 'Fix issue with login',
      status: 'review',
    });

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // 1. Without checksPassed
    eventBus.emit('task.review_ready', 'proj/task-1');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Fix issue with login chờ review'],
    });

    // 2. With checksPassed: true (different key so not deduped)
    eventBus.emit('task.review_ready', 'proj/task-1', { checksPassed: true });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Fix issue with login chờ review (✓ checks)'],
    });

    // 3. With checksPassed: false
    eventBus.emit('task.review_ready', 'proj/task-1', { checksPassed: false });
    expect(execCalls).toHaveLength(3);
    expect(execCalls[2]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Fix issue with login chờ review (✗ checks)'],
    });

    notifier.stop();
  });

  it('notifies when Claude has no fallback step without including credentials', () => {
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();
    eventBus.emit('claude.fallback_changed', undefined, { step: { type: 'wait' }, reason: 'quota' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('Claude fallback: đang dùng chờ reset');
    expect(execCalls.join(' ')).not.toContain('sk-');
  });

  it('does not notify when Claude still has a fallback step', () => {
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();

    eventBus.emit('claude.fallback_changed', undefined, { step: { type: 'model', model: 'claude-sonnet' }, reason: 'quota' });

    expect(execCalls).toHaveLength(0);
    notifier.stop();
  });

  it('uses critical urgency only for task.failed', () => {
    taskRepo.insert({
      id: 'proj/task-fail',
      projectId: 'proj',
      slug: 'task-fail',
      title: 'Build task',
      status: 'failed',
    });
    taskRepo.insert({
      id: 'proj/task-block',
      projectId: 'proj',
      slug: 'task-block',
      title: 'Auth task',
      status: 'blocked',
    });

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    eventBus.emit('task.failed', 'proj/task-fail');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual({
      file: 'notify-send',
      args: ['-u', 'critical', '-t', '10000', '-a', 'AgentHub', 'AgentHub: Build task thất bại'],
    });

    eventBus.emit('task.blocked', 'proj/task-block');
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Auth task bị chặn'],
    });

    notifier.stop();
  });

  it('maps CI warning level to explicit normal desktop urgency', () => {
    const notifier = new NotificationService({ config, eventBus, exec: fakeExec });
    notifier.start();

    eventBus.emit('ci.failed', 'proj', { projectId: 'proj', workflow: 'CI', sha: 'abcdef' });

    expect(execCalls[0].args.slice(0, 2)).toEqual(['-u', 'normal']);
    notifier.stop();
  });

  it('notifies when a task is escalated to a human reviewer', () => {
    taskRepo.insert({
      id: 'proj/task-escalated',
      projectId: 'proj',
      slug: 'task-escalated',
      title: 'Needs human review',
      status: 'review',
    });
    const notifier = new NotificationService({ eventBus, config, taskRepo, exec: fakeExec });
    notifier.start();

    eventBus.emit('review.escalated', 'proj/task-escalated');

    expect(execCalls[0].file).toBe('notify-send');
    expect(execCalls[0].args).toEqual(['-t', '10000', '-a', 'AgentHub', 'Cần người duyệt: Needs human review']);
    notifier.stop();
  });

  it('suppresses quota.exhausted for an individual profile', () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // Individual quota is dashboard-only, even when desktop level is `all`.
    eventBus.emit('quota.exhausted', undefined, {
      profile: 'g1',
      family: 'gemini',
      resetAt: resetEpoch,
    });
    expect(execCalls).toHaveLength(0);

    // From an active quota mark, while another account remains available.
    quotaMarkRepo.mark('g1', 'claude', resetEpoch, 'test');
    eventBus.emit('quota.exhausted', undefined, {
      profile: 'g1',
      family: 'claude',
    });
    expect(execCalls).toHaveLength(0);

    notifier.stop();
  });

  it('groups waiting quota tasks and notifies again after the blockage clears', async () => {
    for (let i = 1; i <= 3; i += 1) {
      taskRepo.insert({
        id: `proj/quota-${i}`,
        projectId: 'proj',
        slug: `quota-${i}`,
        title: `Quota ${i}`,
        status: 'waiting_quota',
        waitReason: 'quota',
      });
    }

    const notifier = new NotificationService({ eventBus, config, taskRepo, quotaMarkRepo, exec: fakeExec });
    notifier.start();
    eventBus.emit('task.waiting_quota', 'proj/quota-1', { reason: 'quota' });
    eventBus.emit('task.waiting_quota', 'proj/quota-2', { reason: 'quota' });
    eventBus.emit('task.waiting_quota', 'proj/quota-3', { reason: 'quota' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toContain('3 task đang chờ quota');

    eventBus.emit('quota.cleared', undefined, { family: 'gemini' });
    for (let i = 1; i <= 3; i += 1) taskRepo.updateStatus(`proj/quota-${i}`, 'queued');
    await new Promise((resolve) => setTimeout(resolve, 120));

    taskRepo.updateStatus('proj/quota-1', 'waiting_quota', 'quota');
    eventBus.emit('task.waiting_quota', 'proj/quota-1', { reason: 'quota' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(execCalls).toHaveLength(2);

    notifier.stop();
  });

  it('notifies when a profile authentication expires', () => {
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();
    eventBus.emit('profile.auth_expired', undefined, { name: 'g3' });
    expect(execCalls[0]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'Hồ sơ g3 cần đăng nhập lại'],
    });
    notifier.stop();
  });

  it('notifies on disk.low and disk.ok with normal urgency', () => {
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();

    eventBus.emit('disk.low', undefined, { freeGB: 1.25, minFreeGB: 3 });
    eventBus.emit('disk.ok', undefined, { freeGB: 10 });

    expect(execCalls.map((call) => call.args)).toEqual([
      ['-t', '10000', '-a', 'AgentHub', 'Ổ đĩa còn 1.25 GB (< 3 GB): tạm dừng khởi chạy task'],
      ['-t', '10000', '-a', 'AgentHub', 'Ổ đĩa đã đủ chỗ (10 GB): tiếp tục chạy task'],
    ]);

    notifier.stop();
  });

  it('limits each disk state to one desktop notification per hour', () => {
    let current = 1_000_000;
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec, now: () => current });
    notifier.start();

    eventBus.emit('disk.low', undefined, { freeGB: 1, minFreeGB: 3 });
    current += 30 * 60_000;
    eventBus.emit('disk.low', undefined, { freeGB: 0.5, minFreeGB: 3 });
    current += 30 * 60_000;
    eventBus.emit('disk.low', undefined, { freeGB: 0.25, minFreeGB: 3 });

    expect(execCalls).toHaveLength(2);
    notifier.stop();
  });

  it('treats quota exhaustion per engine, not across all profiles', () => {
    config.notifications.desktopLevel = 'important';
    quotaMarkRepo.mark('g1', 'gemini', Math.floor(Date.now() / 1000) + 3600);
    const notifier = new NotificationService({ eventBus, config, profileRepo, quotaMarkRepo, exec: fakeExec });
    notifier.start();
    eventBus.emit('quota.exhausted', undefined, { profile: 'g1', family: 'gemini', engine: 'agy' });
    expect(execCalls).toHaveLength(0);

    quotaMarkRepo.mark('chinh', 'gemini', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('g1', 'claude', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('chinh', 'claude', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('g1', 'gpt', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('chinh', 'gpt', Math.floor(Date.now() / 1000) + 3600);
    eventBus.emit('quota.exhausted', undefined, { profile: 'chinh', family: 'gemini', engine: 'agy' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toContain('🚨 Hết sạch quota ở mọi tài khoản và model');
    eventBus.emit('quota.exhausted', undefined, { profile: 'g1', family: 'claude', engine: 'agy' });
    expect(execCalls).toHaveLength(1);
    for (const profile of ['g1', 'chinh']) {
      for (const family of ['gemini', 'claude', 'gpt']) quotaMarkRepo.clear(profile, family);
    }
    eventBus.emit('quota.cleared', undefined, { family: 'claude' });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1].args.at(-1)).toContain('✅ Có quota trở lại');
    notifier.stop();
  });

  it('silences notifications when claude/gpt are exhausted on agy but gemini and codex remain (incident 2026-11-03)', async () => {
    profileRepo.update('g1', { enabled: 0 });
    profileRepo.update('chinh', { enabled: 0 });
    for (const name of ['g3', 'g4', 'pa-gemini', 'g2']) {
      profileRepo.upsert({ name, engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    }
    profileRepo.upsert({ name: 'codeX1', engine: 'codex', kind: 'codex', home: tmpDir, email: null, enabled: 1 });
    const future = Math.floor(Date.now() / 1000) + 3600;
    for (const profile of ['g3', 'g4', 'pa-gemini', 'g2']) {
      quotaMarkRepo.mark(profile, 'claude', future);
      quotaMarkRepo.mark(profile, 'gpt', future);
    }
    const quota = new QuotaService(quotaMarkRepo, profileRepo);
    expect(formatRunnableCapacity(quota.capacitySnapshot())).toBe('Gemini (4 tài khoản), Codex (codeX1)');
    const notifier = new NotificationService({ eventBus, config, profileRepo, quotaMarkRepo, exec: fakeExec });
    notifier.start();
    eventBus.emit('quota.exhausted', undefined, { profile: 'g2', family: 'gpt', engine: 'agy' });
    eventBus.emit('quota.exhausted', undefined, { profile: 'g2', family: 'claude', engine: 'agy' });
    eventBus.emit('claude.quota_exhausted', undefined, { profileName: 'g2', fallbackAvailable: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(execCalls).toHaveLength(0);
    notifier.stop();
  });

  it('silences claude.quota_exhausted when other models/engines remain available', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    quotaMarkRepo.mark('g1', 'claude', future);
    quotaMarkRepo.mark('chinh', 'claude', future);

    const notifier = new NotificationService({ eventBus, config, profileRepo, quotaMarkRepo, exec: fakeExec });
    notifier.start();

    // Claude is exhausted on agy, but Gemini on g1/chinh remains runnable:
    eventBus.emit('claude.quota_exhausted', undefined, { profileName: 'g1', fallbackAvailable: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(execCalls).toHaveLength(0);

    // When all runnable capacity across all profiles is exhausted:
    quotaMarkRepo.mark('g1', 'gemini', future);
    quotaMarkRepo.mark('chinh', 'gemini', future);
    quotaMarkRepo.mark('g1', 'gpt', future);
    quotaMarkRepo.mark('chinh', 'gpt', future);
    eventBus.emit('claude.quota_exhausted', undefined, { profileName: 'g1', fallbackAvailable: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toContain('🚨 Hết sạch quota ở mọi tài khoản và model');
    notifier.stop();
  });

  it('capacity ignores disabled/auth-error profiles and reports reset only for unavailable families', () => {
    const quota = new QuotaService(quotaMarkRepo, profileRepo);
    profileRepo.update('chinh', { enabled: 0 });
    profileRepo.update('g1', { authState: 'not_logged_in' });
    expect(quota.runnableCapacity(['gemini-3.8-flash-medium'])).toEqual([]);
    expect(quota.capacitySnapshot(['gemini-3.8-flash-medium'])).toMatchObject({ runnable: [], nextResetAt: null, nextReset: undefined });

    profileRepo.update('g1', { authState: 'ok' });
    profileRepo.update('chinh', { enabled: 1 });
    const now = Math.floor(Date.now() / 1000);
    quotaMarkRepo.mark('g1', 'gemini', now + 10);
    quotaMarkRepo.mark('g1', 'claude', now + 20);
    quotaMarkRepo.mark('chinh', 'claude', now + 20);
    const snapshot = quota.capacitySnapshot(['gemini-3.8-flash-medium', 'claude-sonnet-4-6'], now);
    expect(snapshot.runnable.some((entry) => entry.family === 'gemini' && entry.profileName === 'chinh')).toBe(true);
    expect(snapshot.nextResetAt).toBe(now + 20);
    expect(snapshot.nextReset?.model).toBe('claude-sonnet-4-6');
  });

  it('areAllProfilesQuotaExhaustedForFamily does not conflate claude engine profiles with agy profiles', () => {
    profileRepo.upsert({ name: 'claude-1', engine: 'claude', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    const future = Math.floor(Date.now() / 1000) + 3600;

    // Only claude engine profile exhausted on claude family, agy profiles are still available
    quotaMarkRepo.mark('claude-1', 'claude', future);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude', undefined, 'claude')).toBe(true);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude', undefined, 'agy')).toBe(false);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude')).toBe(false);
    quotaMarkRepo.clear('claude-1', 'claude');

    // Both agy profiles exhausted on claude family
    quotaMarkRepo.mark('g1', 'claude', future);
    quotaMarkRepo.mark('chinh', 'claude', future);

    // agy engine is exhausted for claude, but claude engine is not
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude', undefined, 'agy')).toBe(true);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude', undefined, 'claude')).toBe(false);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude')).toBe(false);

    // When claude engine exhausts as well
    quotaMarkRepo.mark('claude-1', 'claude', future);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude', undefined, 'claude')).toBe(true);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'claude')).toBe(true);

    // For gemini, claude-1 profile is not conflated with agy
    quotaMarkRepo.mark('g1', 'gemini', future);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'gemini')).toBe(false);
    quotaMarkRepo.mark('chinh', 'gemini', future);
    expect(areAllProfilesQuotaExhaustedForFamily(profileRepo, quotaMarkRepo, 'gemini')).toBe(true);
  });

  it('deduplicates identical notifications within 30 minutes', () => {
    let mockCurrentTime = 1_000_000;
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
      now: () => mockCurrentTime,
    });
    notifier.start();

    // First event at t=1,000,000
    eventBus.emit('task.failed', 'task-x', { title: 'X' });
    expect(execCalls).toHaveLength(1);

    // Same event 10 minutes later (within the window) -> ignored
    mockCurrentTime += 10 * 60_000;
    eventBus.emit('task.failed', 'task-x', { title: 'X' });
    expect(execCalls).toHaveLength(1);

    // Same event 31 minutes after the first -> sent
    mockCurrentTime += 21 * 60_000;
    eventBus.emit('task.failed', 'task-x', { title: 'X' });
    expect(execCalls).toHaveLength(2);

    notifier.stop();
  });

  it('respects config notifications.desktop toggle (enabled by default, can be disabled)', () => {
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // Default enabled
    eventBus.emit('task.failed', 'task-1', { title: 'T1' });
    expect(execCalls).toHaveLength(1);

    // Disabled via config
    config.notifications.desktop = false;
    eventBus.emit('task.failed', 'task-2', { title: 'T2' });
    expect(execCalls).toHaveLength(1);

    // Re-enabled
    config.notifications.desktop = true;
    eventBus.emit('task.failed', 'task-3', { title: 'T3' });
    expect(execCalls).toHaveLength(2);

    notifier.stop();
  });

  it('silently ignores errors if exec fails without throwing or crashing', () => {
    const failingExec = () => {
      const err = new Error('spawn notify-send ENOENT') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    };

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: failingExec,
    });
    notifier.start();

    expect(() => {
      eventBus.emit('task.review_ready', 't', { title: 'T' });
    }).not.toThrow();

    notifier.stop();
  });

  it('in brain auto mode, suppresses raw task notifications and only notifies brain.notify and system incidents', () => {
    config.brain.mode = 'auto';
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // 1. Raw task events should be suppressed
    eventBus.emit('task.review_ready', 'task-1', { title: 'T1' });
    eventBus.emit('task.failed', 'task-2', { title: 'T2' });
    eventBus.emit('task.blocked', 'task-3', { title: 'T3' });
    eventBus.emit('batch.created', undefined, { taskCount: 3 });
    // Single quota exhaustion when another profile is free should be suppressed
    quotaMarkRepo.mark('g1', 'gemini', Math.floor(Date.now() / 1000) + 3600);
    eventBus.emit('quota.exhausted', undefined, { profile: 'g1', family: 'gemini' });
    expect(execCalls).toHaveLength(0);

    // 2. brain.notify should be sent
    eventBus.emit('brain.notify', undefined, { text: 'Cần xác nhận từ người dùng', level: 'decision' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('📌 Cần quyết định: Cần xác nhận từ người dùng');

    // 3. System incidents should be sent
    eventBus.emit('disk.low', undefined, { freeGB: 1, minFreeGB: 3 });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1].args.at(-1)).toContain('Ổ đĩa còn 1 GB');

    // 4. All profiles quota exhausted is a system incident and should be notified
    quotaMarkRepo.mark('g1', 'claude', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('chinh', 'claude', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('chinh', 'gemini', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('g1', 'gpt', Math.floor(Date.now() / 1000) + 3600);
    quotaMarkRepo.mark('chinh', 'gpt', Math.floor(Date.now() / 1000) + 3600);
    eventBus.emit('quota.exhausted', undefined, { profile: 'chinh', family: 'claude' });
    expect(execCalls).toHaveLength(3);
    expect(execCalls[2].args.at(-1)).toContain('🚨 Hết sạch quota ở mọi tài khoản và model');

    notifier.stop();
  });

  it('filters raw notifications by each project brain mode', () => {
    projectRepo.insert({ id: 'p1', name: 'P1', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1, settings: JSON.stringify({ brain: { mode: 'auto' } }) });
    projectRepo.insert({ id: 'p2', name: 'P2', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    const notifier = new NotificationService({ eventBus, config, taskRepo, profileRepo, quotaMarkRepo, projectRepo, exec: fakeExec });
    notifier.start();

    eventBus.emit('task.review_ready', 'p1/task', { title: 'P1 task' });
    eventBus.emit('task.review_ready', 'p2/task', { title: 'P2 task' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toContain('P2 task');

    projectRepo.update('p2', { settings: JSON.stringify({ brain: { mode: 'suggest' } }) });
    config.brain.mode = 'auto';
    eventBus.emit('task.failed', 'p1/failed', { title: 'P1 failed' });
    eventBus.emit('task.failed', 'p2/failed', { title: 'P2 failed' });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1].args.at(-1)).toContain('P2 failed');
    notifier.stop();
  });

  it('during quiet hours, defers non-incident notifications and sends only incidents', () => {
    config.notifications.quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };

    // 23:30 is in quiet hours
    const mockNightTime = new Date();
    mockNightTime.setHours(23, 30, 0, 0);
    const currentMockTime = mockNightTime.getTime();

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      exec: fakeExec,
      now: () => currentMockTime,
    });
    notifier.start();

    // 1. Normal/info notifications should be queued into quietHoursQueue and not sent to exec
    eventBus.emit('brain.notify', undefined, { text: 'Bản cập nhật thường', level: 'info' });
    eventBus.emit('task.review_ready', 'task-1', { title: 'T1' });
    expect(execCalls).toHaveLength(0);
    expect(notifier.getQuietHoursQueue()).toHaveLength(2);

    // 2. Incident notification should bypass quiet hours and be sent immediately
    eventBus.emit('brain.notify', undefined, { text: 'Sự cố khẩn cấp', level: 'incident' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('🚨 Sự cố AgentHub: Sự cố khẩn cấp');

    // 3. Disk low is an incident and should bypass quiet hours
    eventBus.emit('disk.low', undefined, { freeGB: 0.5, minFreeGB: 3 });
    expect(execCalls).toHaveLength(2);

    // 4. Flush quiet hours queue returns the accumulated items
    const flushed = notifier.flushQuietHoursQueue();
    expect(flushed).toHaveLength(2);
    expect(notifier.getQuietHoursQueue()).toHaveLength(0);

    notifier.stop();
  });

  it('caps quietHoursQueue at 200 items, dropping oldest', () => {
    config.notifications.quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };
    const mockNightTime = new Date();
    mockNightTime.setHours(23, 0, 0, 0);

    const notifier = new NotificationService({
      eventBus,
      config,
      exec: fakeExec,
      now: () => mockNightTime.getTime(),
    });
    notifier.start();

    for (let i = 1; i <= 250; i++) {
      eventBus.emit('brain.notify', undefined, { text: `Notice ${i}`, level: 'info' });
    }

    const queue = notifier.getQuietHoursQueue();
    expect(queue).toHaveLength(200);
    expect((queue[0].payload as { text: string }).text).toBe('Notice 51');
    expect((queue[199].payload as { text: string }).text).toBe('Notice 250');

    notifier.stop();
  });

  it('when quiet hours end, sends grouped summary "N thông báo trong đêm" and flushes queue', () => {
    config.notifications.quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };
    let mockTime = new Date();
    mockTime.setHours(23, 0, 0, 0);

    const notifier = new NotificationService({
      eventBus,
      config,
      exec: fakeExec,
      now: () => mockTime.getTime(),
    });
    notifier.start();

    // Accumulate 3 notifications in the night
    eventBus.emit('brain.notify', undefined, { text: 'N1', level: 'info' });
    eventBus.emit('brain.notify', undefined, { text: 'N2', level: 'info' });
    eventBus.emit('brain.notify', undefined, { text: 'N3', level: 'info' });
    expect(execCalls).toHaveLength(0);
    expect(notifier.getQuietHoursQueue()).toHaveLength(3);

    // Advance time to 07:00 (quiet hours end)
    mockTime = new Date();
    mockTime.setHours(7, 0, 0, 0);

    // Calling checkQuietHoursEnd triggers the flush
    const flushed = notifier.checkQuietHoursEnd(mockTime.getTime());
    expect(flushed).toBe(true);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('AgentHub: 3 thông báo trong đêm');
    expect(notifier.getQuietHoursQueue()).toHaveLength(0);

    // Subsequent call does not duplicate
    const flushedAgain = notifier.checkQuietHoursEnd(mockTime.getTime());
    expect(flushedAgain).toBe(false);
    expect(execCalls).toHaveLength(1);

    notifier.stop();
  });

  it('checkQuietHoursEnd khong gui thong bao khi ngoai cua so 2h sau quietHours.end hoac khi hang doi rong', () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    let mockTime = new Date();
    mockTime.setHours(23, 0, 0, 0);

    const notifier = new NotificationService({
      eventBus,
      config,
      exec: fakeExec,
      now: () => mockTime.getTime(),
    });
    notifier.start();

    // 1. In night: queue 1 notification
    eventBus.emit('brain.notify', undefined, { text: 'N-night', level: 'info' });
    expect(notifier.getQuietHoursQueue()).toHaveLength(1);

    // Advance time to 15:00 (outside 2h window after 07:00)
    mockTime = new Date();
    mockTime.setHours(15, 0, 0, 0);

    const flushedAt15 = notifier.checkQuietHoursEnd(mockTime.getTime());
    expect(flushedAt15).toBe(false);
    expect(execCalls).toHaveLength(0);

    // 2. Clear queue and check at 07:30 (inside window but empty queue)
    notifier.flushQuietHoursQueue();
    mockTime = new Date();
    mockTime.setHours(7, 30, 0, 0);

    const flushedEmpty = notifier.checkQuietHoursEnd(mockTime.getTime());
    expect(flushedEmpty).toBe(false);
    expect(execCalls).toHaveLength(0);

    notifier.stop();
  });

  it('simulates 1 hour of high-noise events and verifies desktop notifications <= 10 at important level', () => {
    config.notifications.desktopLevel = 'important';
    let mockTime = 1_000_000_000;
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      projectRepo,
      exec: fakeExec,
      now: () => mockTime,
    });
    notifier.start();

    // 1936 deploy.restart_waiting
    for (let i = 0; i < 1936; i++) {
      mockTime += Math.floor(3600_000 / 1936);
      eventBus.emit('deploy.restart_waiting', undefined, { checks: 1, editing: 1 });
    }
    // 150 claude.quota_available
    for (let i = 0; i < 150; i++) {
      mockTime += Math.floor(3600_000 / 150);
      eventBus.emit('claude.quota_available', undefined, { profileName: 'chinh' });
    }
    // 69 brain.updated
    for (let i = 0; i < 69; i++) {
      mockTime += Math.floor(3600_000 / 69);
      eventBus.emit('brain.updated', undefined, {});
    }
    // 58 task.overlap
    for (let i = 0; i < 58; i++) {
      mockTime += Math.floor(3600_000 / 58);
      eventBus.emit('task.overlap', 'proj/t', { file: 'shared.ts', otherTaskId: 'proj/t2' });
    }
    // 42 quota.exhausted (individual profiles; chinh is still free when g1 exhausts)
    for (let i = 0; i < 42; i++) {
      mockTime += Math.floor(3600_000 / 42);
      eventBus.emit('quota.exhausted', undefined, { profile: 'g1', family: 'gemini', engine: 'agy' });
    }
    // 7 disk.low / 5 disk.ok (flapping)
    for (let i = 0; i < 7; i++) {
      mockTime += 200_000;
      eventBus.emit('disk.low', undefined, { freeGB: 1, minFreeGB: 3 });
      if (i < 5) {
        mockTime += 100_000;
        eventBus.emit('disk.ok', undefined, { freeGB: 4.5, minFreeGB: 3 });
      }
    }
    // 6 load.task_paused, 6 task.paused, 6 load.high
    for (let i = 0; i < 6; i++) {
      mockTime += 300_000;
      eventBus.emit('load.task_paused', undefined, { reason: 'load' });
      eventBus.emit('task.paused', undefined, { reason: 'load' });
      eventBus.emit('load.high', undefined, { cpu: 95 });
    }

    expect(execCalls.length).toBeLessThanOrEqual(10);
    notifier.stop();
  });

  it('applies updated notification config immediately without restarting notifier', () => {
    config.notifications.desktop = true;
    config.notifications.desktopLevel = 'critical';

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      projectRepo,
      exec: fakeExec,
      now: () => Date.now(),
    });
    notifier.start();

    // At desktopLevel='critical', normal events like task.review_ready do not trigger critical alert
    eventBus.emit('task.review_ready', 'proj/t1', {});
    expect(execCalls.length).toBe(0);

    // Update config to 'all' via config.updated eventBus event
    eventBus.emit('config.updated', undefined, {
      notifications: { desktopLevel: 'all' },
    });

    // Now task.review_ready triggers notification immediately
    eventBus.emit('task.review_ready', 'proj/t2', {});
    expect(execCalls.length).toBe(1);

    // Update to desktop=false via notifier.updateConfig
    notifier.updateConfig({
      ...config,
      notifications: {
        ...config.notifications,
        desktop: false,
      },
    });

    // Should not notify when desktop is disabled
    eventBus.emit('task.failed', 'proj/t3', { error: 'fail' });
    expect(execCalls.length).toBe(1);

    notifier.stop();
  });

  it('notifies for no_department_profile wait reason with critical urgency, ignores other wait reasons, and deduplicates for 30 minutes', () => {
    config.notifications.desktopLevel = 'critical';
    let mockTime = 1_000_000_000;
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      projectRepo,
      exec: fakeExec,
      now: () => mockTime,
    });
    notifier.start();

    // 1. no_department_profile should send critical notification
    eventBus.emit('task.waiting_quota', 'proj/t-no-dept', {
      reason: 'no_department_profile',
      departmentName: 'Phòng SYSTEM',
      message: 'Gán tài khoản cho phòng Phòng SYSTEM hoặc bỏ gán',
    });

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args).toContain('-u');
    expect(execCalls[0].args).toContain('critical');
    expect(execCalls[0].args.at(-1)).toContain('task đang chờ vì phòng Phòng SYSTEM chưa có tài khoản được phép');
    expect(execCalls[0].args.at(-1)).toContain('Gán tài khoản cho phòng Phòng SYSTEM hoặc bỏ gán');

    // 2. other wait reasons (e.g. no_matching_profile, disk) must not send desktop notification
    eventBus.emit('task.waiting_quota', 'proj/t-no-matching', {
      reason: 'no_matching_profile',
    });
    eventBus.emit('task.waiting_quota', 'proj/t-disk', {
      reason: 'disk',
    });
    expect(execCalls).toHaveLength(1);

    // 3. Deduplication: same task with no_department_profile within 30 minutes is ignored
    mockTime += 10 * 60 * 1000; // 10 minutes later
    eventBus.emit('task.waiting_quota', 'proj/t-no-dept', {
      reason: 'no_department_profile',
      departmentName: 'Phòng SYSTEM',
      message: 'Gán tài khoản cho phòng Phòng SYSTEM hoặc bỏ gán',
    });
    expect(execCalls).toHaveLength(1);

    // 4. After 30 minutes (31 minutes later), notification fires again
    mockTime += 21 * 60 * 1000; // Total 31 minutes since first notification
    eventBus.emit('task.waiting_quota', 'proj/t-no-dept', {
      reason: 'no_department_profile',
      departmentName: 'Phòng SYSTEM',
      message: 'Gán tài khoản cho phòng Phòng SYSTEM hoặc bỏ gán',
    });
    expect(execCalls).toHaveLength(2);

    notifier.stop();
  });

  it('notifies for no_department_profile wait reason even in brain auto mode', () => {
    config.brain.mode = 'auto';
    config.notifications.desktopLevel = 'critical';
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      projectRepo,
      exec: fakeExec,
    });
    notifier.start();

    // Raw task events and other wait reasons are suppressed in auto mode
    eventBus.emit('task.waiting_quota', 'proj/t-no-match', {
      reason: 'no_matching_profile',
    });
    expect(execCalls).toHaveLength(0);

    // no_department_profile is a configuration error that must bypass auto mode suppression
    eventBus.emit('task.waiting_quota', 'proj/t-no-dept', {
      reason: 'no_department_profile',
      departmentName: 'Phòng SYSTEM',
      message: 'Gán tài khoản cho phòng Phòng SYSTEM hoặc bỏ gán',
    });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toContain('task đang chờ vì phòng Phòng SYSTEM chưa có tài khoản được phép');

    notifier.stop();
  });
});
