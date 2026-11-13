import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { HealthSweepService } from '../src/health/sweep.js';
import { HealthIssueCooldownRepo, BrainTurnRepo, openDatabase } from '../src/db/index.js';
import { BrainRunner } from '../src/brain/runner.js';

describe('Health Sweep & Brain Wakeup (t-health-sweep-brain)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let projectPath: string;
  let sweepService: HealthSweepService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-health-sweep-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);

    const origInsert = ctx.taskRepo.insert.bind(ctx.taskRepo);
    ctx.taskRepo.insert = (row: Parameters<typeof origInsert>[0]) => {
      const slug = row.slug ?? (row.id.includes('/') ? row.id.split('/')[1] : row.id);
      return origInsert({ ...row, slug });
    };

    projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Main Repo');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial commit', '--allow-empty'], {
      cwd: projectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    ctx.projectRepo.insert({
      id: 'p1',
      name: 'Project 1',
      path: projectPath,
      defaultBranch: 'main',
      maxParallel: 2,
    });

    ctx.profileRepo.upsert({
      name: 'prof1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(agyHomesDir, 'prof1'),
      email: 'prof1@example.com',
      enabled: 1,
    });

    sweepService = ctx.healthSweepService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.scheduler.stop();
    sweepService.stop();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  // 1. checking_orphan
  describe('Rule checking_orphan', () => {
    it('phát hiện đúng khi task checking > 20 phút không có check chạy và tự chạy lại check', async () => {
      const now = Date.now();
      const past25m = new Date(now - 25 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-checking-stuck',
        projectId: 'p1',
        title: 'Task checking stuck',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-checking-stuck', {
        status: 'checking',
        statusChangedAt: past25m,
      });

      // Insert previous done worker run
      ctx.runRepo.insert({
        id: 'run-w1',
        taskId: 'p1/t-checking-stuck',
        engine: 'agy',
        model: 'gemini-3.8-flash-medium',
        profileName: 'prof1',
        pid: 1234,
        kind: 'worker',
      });
      ctx.runRepo.finish('run-w1', 'done');

      let runChecksCalledWith: { taskId: string; runId: string } | null = null;
      vi.spyOn(ctx.scheduler, 'runChecksForTask').mockImplementation(async (taskId, runId) => {
        runChecksCalledWith = { taskId, runId };
      });

      const emitted: unknown[] = [];
      ctx.scheduler.getEventBus().on('task.health_issue', (_id, payload) => {
        emitted.push(payload);
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].rule).toBe('checking_orphan');
      expect(result.issues[0].taskId).toBe('p1/t-checking-stuck');
      expect(result.issues[0].evidence.workerRuns).toBe(1);

      expect(runChecksCalledWith).toEqual({
        taskId: 'p1/t-checking-stuck',
        runId: 'run-w1',
      });
      expect(emitted).toHaveLength(1);
    });

    it('không báo nhầm khi task mới chuyển sang checking (dưới 20 phút)', async () => {
      const now = Date.now();
      const past5m = new Date(now - 5 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-checking-recent',
        projectId: 'p1',
        title: 'Task checking recent',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-checking-recent', {
        status: 'checking',
        statusChangedAt: past5m,
      });

      const result = await sweepService.runSweep(now);
      const checkingIssues = result.issues.filter((i) => i.rule === 'checking_orphan');
      expect(checkingIssues).toHaveLength(0);
    });

    it('không báo nhầm khi task checking đang có check thực sự chạy', async () => {
      const now = Date.now();
      const past25m = new Date(now - 25 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-checking-active',
        projectId: 'p1',
        title: 'Task checking active',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-checking-active', {
        status: 'checking',
        statusChangedAt: past25m,
      });

      vi.spyOn(ctx.scheduler, 'isChecking').mockReturnValue(true);

      const result = await sweepService.runSweep(now);
      const checkingIssues = result.issues.filter((i) => i.rule === 'checking_orphan');
      expect(checkingIssues).toHaveLength(0);
    });
  });

  // 2. review_orphan
  describe('Rule review_orphan', () => {
    it('phát hiện đúng khi task review > 30 phút với auto review bật nhưng không có reviewer chạy', async () => {
      const now = Date.now();
      const past35m = new Date(now - 35 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-review-orphan',
        projectId: 'p1',
        title: 'Task review orphan',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-review-orphan', {
        status: 'review',
        statusChangedAt: past35m,
        worktreePath: projectPath,
      });

      // Mock scheduler that auto review is enabled and eligible (not waiting for manual gate or quota)
      vi.spyOn(ctx.scheduler, 'isReviewOrphanEligible').mockReturnValue(true);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'review_orphan' && i.taskId === 'p1/t-review-orphan')).toBe(true);
    });

    it('không báo nhầm khi task review đang chờ người duyệt thủ công (manual gate)', async () => {
      const now = Date.now();
      const past35m = new Date(now - 35 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-review-manual',
        projectId: 'p1',
        title: 'Task review manual',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-review-manual', {
        status: 'review',
        statusChangedAt: past35m,
        worktreePath: projectPath,
      });

      // Eligible is false because it is waiting for manual approval
      vi.spyOn(ctx.scheduler, 'isReviewOrphanEligible').mockReturnValue(false);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'review_orphan')).toBe(false);
    });

    it('không báo nhầm khi task review thiếu worktreePath', async () => {
      const now = Date.now();
      const past35m = new Date(now - 35 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-review-noworktree',
        projectId: 'p1',
        title: 'Task review no worktree',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-review-noworktree', {
        status: 'review',
        statusChangedAt: past35m,
        worktreePath: null,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'review_orphan' && i.taskId === 'p1/t-review-noworktree')).toBe(false);
    });

    it('không báo nhầm khi task review thiếu kết quả autocheck', async () => {
      const now = Date.now();
      const past35m = new Date(now - 35 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-review-nochecks',
        projectId: 'p1',
        title: 'Task review no checks',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-review-nochecks', {
        status: 'review',
        statusChangedAt: past35m,
        worktreePath: projectPath,
      });

      const isEligible = ctx.scheduler.isReviewOrphanEligible(ctx.taskRepo.get('p1/t-review-nochecks')!);
      expect(isEligible).toBe(false);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'review_orphan' && i.taskId === 'p1/t-review-nochecks')).toBe(false);
    });

    it('isReviewOrphanEligible trả về false khi thiếu worktreePath hoặc autocheck results', () => {
      ctx.taskRepo.insert({
        id: 'p1/t-elig-test',
        projectId: 'p1',
        title: 'Eligibility test',
        level: 'easy',
      });

      // 1. Missing worktreePath
      ctx.taskRepo.update('p1/t-elig-test', {
        status: 'review',
        worktreePath: null,
      });
      expect(ctx.scheduler.isReviewOrphanEligible(ctx.taskRepo.get('p1/t-elig-test')!)).toBe(false);

      // 2. Has worktreePath, but no check_results
      ctx.taskRepo.update('p1/t-elig-test', {
        worktreePath: projectPath,
      });
      expect(ctx.scheduler.isReviewOrphanEligible(ctx.taskRepo.get('p1/t-elig-test')!)).toBe(false);

      // 3. With check_results inserted into DB
      ctx.runRepo.insert({
        id: 'run-test',
        taskId: 'p1/t-elig-test',
        engine: 'agy',
        model: 'model',
        profileName: 'prof1',
      });
      ctx.db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('p1/t-elig-test', 'run-test', 'test', 1, 0, 100, 'pass');
      expect(ctx.scheduler.getCheckResults('p1/t-elig-test').length).toBe(1);
    });
  });

  // 3. queued_starved
  describe('Rule queued_starved', () => {
    it('phát hiện đúng khi task queued > 60 phút không chờ quota, không có dependency, có slot', async () => {
      const now = Date.now();
      const past65m = new Date(now - 65 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-queued-starved',
        projectId: 'p1',
        title: 'Task queued starved',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-queued-starved', {
        status: 'queued',
        statusChangedAt: past65m,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'queued_starved' && i.taskId === 'p1/t-queued-starved')).toBe(true);
    });

    it('không báo nhầm khi task queued đang có dependency chưa hoàn thành', async () => {
      const now = Date.now();
      const past65m = new Date(now - 65 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/dep-task',
        projectId: 'p1',
        title: 'Dependency task',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/dep-task', { status: 'running' });

      ctx.taskRepo.insert({
        id: 'p1/t-queued-dep',
        projectId: 'p1',
        title: 'Task queued with dep',
        level: 'easy',
        dependsOn: ['p1/dep-task'],
      });
      ctx.taskRepo.update('p1/t-queued-dep', {
        status: 'queued',
        statusChangedAt: past65m,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'queued_starved' && i.taskId === 'p1/t-queued-dep')).toBe(false);
    });

    it('không báo nhầm khi task queued đang có waitReason quota', async () => {
      const now = Date.now();
      const past65m = new Date(now - 65 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-queued-quota',
        projectId: 'p1',
        title: 'Task queued waiting quota',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-queued-quota', {
        status: 'queued',
        statusChangedAt: past65m,
        waitReason: 'quota',
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'queued_starved' && i.taskId === 'p1/t-queued-quota')).toBe(false);
    });

    it('không báo nhầm khi task queued có notBefore ở tương lai', async () => {
      const now = Date.now();
      const past65m = new Date(now - 65 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-queued-notbefore',
        projectId: 'p1',
        title: 'Task queued notBefore',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-queued-notbefore', {
        status: 'queued',
        statusChangedAt: past65m,
        notBefore: Math.floor(now / 1000) + 30 * 60,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'queued_starved' && i.taskId === 'p1/t-queued-notbefore')).toBe(false);
    });

    it('phát hiện đúng khi task queued có notBefore trong quá khứ', async () => {
      const now = Date.now();
      const past65m = new Date(now - 65 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-queued-past-notbefore',
        projectId: 'p1',
        title: 'Task queued past notBefore',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-queued-past-notbefore', {
        status: 'queued',
        statusChangedAt: past65m,
        notBefore: Math.floor(now / 1000) - 60,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'queued_starved' && i.taskId === 'p1/t-queued-past-notbefore')).toBe(true);
    });

    it('không báo nhầm khi project đã hết slot chạy song song', async () => {
      const now = Date.now();
      const past65m = new Date(now - 65 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-queued-noslot',
        projectId: 'p1',
        title: 'Task queued no slot',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-queued-noslot', {
        status: 'queued',
        statusChangedAt: past65m,
      });

      vi.spyOn(ctx.scheduler, 'hasParallelCapacity').mockReturnValue(false);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'queued_starved' && i.taskId === 'p1/t-queued-noslot')).toBe(false);
    });
  });

  // 4. running_no_progress
  describe('Rule running_no_progress', () => {
    it('phát hiện đúng khi worker chạy > 90 phút mà không có commit mới và không đổi file trong worktree', async () => {
      const start95m = Date.now();
      const now = start95m + 95 * 60 * 1000;

      ctx.taskRepo.insert({
        id: 'p1/t-running-stuck',
        projectId: 'p1',
        title: 'Task running stuck',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-stuck', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r1',
        taskId: 'p1/t-running-stuck',
        pid: 99999,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start95m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: start95m,
        lastActivityAt: start95m,
        activitySource: 'log',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: start95m - 1000, // No changes after start
        usageBefore: null,
        noCommitMinutes: 95,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-stuck')).toBe(true);
    });

    it('không báo nhầm khi worker có file thay đổi trong worktree', async () => {
      const start95m = Date.now();
      const now = start95m + 95 * 60 * 1000;

      ctx.taskRepo.insert({
        id: 'p1/t-running-active',
        projectId: 'p1',
        title: 'Task running active',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-active', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r2',
        taskId: 'p1/t-running-active',
        pid: 99998,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start95m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: now - 5000,
        lastActivityAt: now - 5000,
        activitySource: 'worktree',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: now - 5000, // Files modified recently
        usageBefore: null,
        noCommitMinutes: 95,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-active')).toBe(false);
    });
  });

  // 5. churn
  describe('Rule churn', () => {
    it('phát hiện đúng khi task có tổng số lượt worker >= 8', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-churn-runs',
        projectId: 'p1',
        title: 'Task churn runs',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-churn-runs', {
        status: 'queued',
        runCount: 8,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'churn' && i.taskId === 'p1/t-churn-runs')).toBe(true);
    });

    it('phát hiện đúng khi task bị review.escalated >= 2 lần', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-churn-escalate',
        projectId: 'p1',
        title: 'Task churn escalate',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-churn-escalate', {
        status: 'queued',
        runCount: 3,
      });

      // Insert 2 review.escalated events
      ctx.eventRepo.insert('review.escalated', 'p1/t-churn-escalate', { reason: 'reviewer_changes_limit' });
      ctx.eventRepo.insert('review.escalated', 'p1/t-churn-escalate', { reason: 'reviewer_changes_limit' });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'churn' && i.taskId === 'p1/t-churn-escalate')).toBe(true);
    });

    it('không báo nhầm khi task chỉ có 2 worker runs và không bị escalate', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-normal-runs',
        projectId: 'p1',
        title: 'Task normal runs',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-normal-runs', {
        status: 'queued',
        runCount: 2,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'churn' && i.taskId === 'p1/t-normal-runs')).toBe(false);
    });
  });

  // 6. failover_churn
  describe('Rule failover_churn', () => {
    it('phát hiện đúng khi task bị failover/quota_retry >= 4 lần trong 2 giờ', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-failover-churn',
        projectId: 'p1',
        title: 'Task failover churn',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-failover-churn', {
        status: 'queued',
      });

      // Insert 4 failover events within 2 hours
      for (let i = 0; i < 4; i++) {
        ctx.eventRepo.insert('task.failover', 'p1/t-failover-churn', { reason: 'quota_exhausted' });
      }

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'failover_churn' && i.taskId === 'p1/t-failover-churn')).toBe(true);
    });

    it('không báo nhầm khi chỉ có 1 lần failover', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-failover-normal',
        projectId: 'p1',
        title: 'Task failover normal',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-failover-normal', {
        status: 'queued',
      });

      ctx.eventRepo.insert('task.failover', 'p1/t-failover-normal', { reason: 'quota_exhausted' });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'failover_churn' && i.taskId === 'p1/t-failover-normal')).toBe(false);
    });
  });

  // 7. stale_run
  describe('Rule stale_run', () => {
    it('phát hiện đúng khi run có outcome IS NULL nhưng pid đã chết, tự sửa bằng cách crashed và requeue', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-stale-run',
        projectId: 'p1',
        title: 'Task stale run',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-stale-run', {
        status: 'running',
      });

      // Insert run with a dead pid (pid 999999 does not exist)
      ctx.runRepo.insert({
        id: 'run-dead',
        taskId: 'p1/t-stale-run',
        engine: 'agy',
        model: 'gemini',
        profileName: 'prof1',
        pid: 999999,
        kind: 'worker',
      });

      const queuedEvents: Array<{ id?: string; p?: Record<string, unknown> }> = [];
      ctx.scheduler.getEventBus().on('task.queued', (id, p) => {
        queuedEvents.push({ id, p: p as Record<string, unknown> });
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'stale_run' && i.taskId === 'p1/t-stale-run')).toBe(true);

      // Verify self-repair: run marked crashed, task requeued
      const finishedRun = ctx.runRepo.get('run-dead');
      expect(finishedRun?.outcome).toBe('crashed');

      const updatedTask = ctx.taskRepo.get('p1/t-stale-run');
      expect(updatedTask?.status).toBe('queued');
      expect(updatedTask?.resume).toBe(1);

      expect(queuedEvents.some((e) => e.id === 'p1/t-stale-run' && e.p?.reason === 'stale_run_sweep')).toBe(true);
    });

    it('không báo nhầm khi run đang hoạt động bình thường trong scheduler.running', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-active-run',
        projectId: 'p1',
        title: 'Task active run',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-active-run', {
        status: 'running',
      });

      ctx.runRepo.insert({
        id: 'run-active',
        taskId: 'p1/t-active-run',
        engine: 'agy',
        model: 'gemini',
        profileName: 'prof1',
        pid: process.pid, // current living process
        kind: 'worker',
      });

      vi.spyOn(ctx.scheduler, 'isRunActive').mockReturnValue(true);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'stale_run')).toBe(false);
    });
  });

  // Cooldown
  describe('Cooldown chống báo lặp và duy trì qua mở lại DB', () => {
    it('chặn báo lại trong thời gian cooldown và duy trì khi mở lại DB', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-cooldown',
        projectId: 'p1',
        title: 'Task cooldown',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-cooldown', {
        status: 'queued',
        runCount: 9,
      });

      // Lần 1: phát hiện churn
      const res1 = await sweepService.runSweep(now);
      expect(res1.issues).toHaveLength(1);
      expect(res1.issues[0].rule).toBe('churn');

      // Lần 2 (ngay sau đó): bị cooldown chặn
      const res2 = await sweepService.runSweep(now + 1000);
      expect(res2.issues).toHaveLength(0);

      // Mở lại DB mới từ cùng đường dẫn file hub.db
      const dbPath = path.join(tmpDir, 'hub.db');
      const reopenDb = openDatabase(dbPath);
      const reopenCooldownRepo = new HealthIssueCooldownRepo(reopenDb);
      const cooldownEntry = reopenCooldownRepo.get('p1/t-cooldown', 'churn');
      expect(cooldownEntry).toBeDefined();
      expect(cooldownEntry?.taskStatus).toBe('queued');
      reopenDb.close();

      // Nếu trạng thái task thay đổi (ví dụ: sang running rồi lại về queued): cooldown được reset
      ctx.taskRepo.update('p1/t-cooldown', { status: 'running' });
      const res3 = await sweepService.runSweep(now + 2000);
      expect(res3.issues).toHaveLength(1);
      expect(res3.issues[0].rule).toBe('churn');
      expect(res3.issues[0].status).toBe('running');
    });
  });

  // Brain wake up single batch
  describe('Đánh thức Brain một lần (batch) cho nhiều issue trong một lượt sweep', () => {
    it('chỉ đánh thức brain một lần khi sweep phát hiện nhiều issue', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/task-issue-1',
        projectId: 'p1',
        title: 'Task issue 1',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/task-issue-1', {
        status: 'queued',
        runCount: 8,
      });

      ctx.taskRepo.insert({
        id: 'p1/task-issue-2',
        projectId: 'p1',
        title: 'Task issue 2',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/task-issue-2', {
        status: 'queued',
        runCount: 10,
      });

      const brainSent: string[] = [];
      const chatServiceMock = {
        getOrCreateSession: vi.fn((id: string) => {
          return ctx.chatSessionRepo.get(id) || ctx.chatSessionRepo.insert({
            id,
            title: 'Brain session',
            kind: 'brain',
            projectId: 'p1',
          });
        }),
        sendMessage: vi.fn((_id: string, text: string) => {
          brainSent.push(text);
          return { userMessageId: 'u1', assistantMessageId: 'a1' };
        }),
      };

      const brainRunner = new BrainRunner({
        config: {
          fallback: [],
          policy: [],
          claudeProfile: 'prof1',
          model: 'opus',
          mode: 'suggest',
          permissions: 'standard',
          maxConcurrent: 2,
          maxTurnsPerHour: 20,
          dailyTokenBudget: 0,
        },
        eventBus: ctx.scheduler.getEventBus(),
        chatService: chatServiceMock,
        chatSessionRepo: ctx.chatSessionRepo,
        turnRepo: new BrainTurnRepo(ctx.db),
        projectRepo: ctx.projectRepo,
        debounceMs: 5000,
      });

      brainRunner.start();

      // Run health sweep -> detects 2 issues in p1
      const result = await sweepService.runSweep(now);
      expect(result.issues).toHaveLength(2);

      // Flush brain runner to process all batched events
      brainRunner.flush();

      // Brain is only woken once (1 message sent for the project turn)
      expect(brainSent).toHaveLength(1);
      expect(brainSent[0]).toContain('task.health_issue');
      expect(brainSent[0]).toContain('p1/task-issue-1');
      expect(brainSent[0]).toContain('p1/task-issue-2');
      expect(brainSent[0]).toContain('HƯỚNG DẪN XỬ LÝ SỰ CỐ SỨC KHOẺ TASK (task.health_issue)');

      brainRunner.stop();
    });
  });

  // Drain & Stopped check
  describe('Không chạy sweep khi đang drain restart hoặc scheduler stopped', () => {
    it('bỏ qua quét khi scheduler đang drain', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-drain',
        projectId: 'p1',
        title: 'Task during drain',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-drain', {
        status: 'queued',
        runCount: 12,
      });

      vi.spyOn(ctx.scheduler, 'isDraining').mockReturnValue(true);

      const result = await sweepService.runSweep(now);
      expect(result.issues).toHaveLength(0);
    });

    it('bỏ qua quét khi scheduler đã stop', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-stopped',
        projectId: 'p1',
        title: 'Task during stopped scheduler',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-stopped', {
        status: 'queued',
        runCount: 12,
      });

      vi.spyOn(ctx.scheduler, 'isStopped').mockReturnValue(true);

      const result = await sweepService.runSweep(now);
      expect(result.issues).toHaveLength(0);
    });
  });

  // API endpoints
  describe('API GET /api/health/sweep and POST /api/health/sweep', () => {
    it('service trả về kết quả qua getHealthSweepStatus và runHealthSweep', async () => {
      const statusBefore = ctx.service.getHealthSweepStatus();
      expect(statusBefore.timestamp).toBeNull();
      expect(statusBefore.issues).toEqual([]);

      const sweepResult = await ctx.service.runHealthSweep();
      expect(sweepResult.timestamp).toBeTruthy();

      const statusAfter = ctx.service.getHealthSweepStatus();
      expect(statusAfter.timestamp).toBe(sweepResult.timestamp);
    });
  });
});
