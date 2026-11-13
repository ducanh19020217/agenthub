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

    it('bắt và log lỗi an toàn khi scheduler.runChecksForTask bị reject trong self-repair', async () => {
      const now = Date.now();
      const past25m = new Date(now - 25 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-checking-reject',
        projectId: 'p1',
        title: 'Task checking reject',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-checking-reject', {
        status: 'checking',
        statusChangedAt: past25m,
      });

      ctx.runRepo.insert({
        id: 'run-w-reject',
        taskId: 'p1/t-checking-reject',
        engine: 'agy',
        model: 'gemini-3.8-flash-medium',
        profileName: 'prof1',
        pid: 1235,
        kind: 'worker',
      });
      ctx.runRepo.finish('run-w-reject', 'done');

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(ctx.scheduler, 'runChecksForTask').mockRejectedValue(new Error('re-check runner crashed'));

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'checking_orphan' && i.taskId === 'p1/t-checking-reject')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[health] self-repair check failed for p1/t-checking-reject:'),
        expect.any(Error),
      );
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

    it('không báo nhầm review_orphan khi task reviewerEscalated nhưng arbiter bị quota/backoff', async () => {
      const now = Date.now();
      const past35m = new Date(now - 35 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-review-escalated-quota',
        projectId: 'p1',
        title: 'Task review escalated in quota backoff',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-review-escalated-quota', {
        status: 'review',
        statusChangedAt: past35m,
        worktreePath: projectPath,
        reviewerEscalated: 1,
        reviewerEscalationReason: 'reviewer_changes_limit',
      });

      ctx.runRepo.insert({
        id: 'run-check-esc',
        taskId: 'p1/t-review-escalated-quota',
        engine: 'agy',
        model: 'model',
        profileName: 'prof1',
      });
      ctx.db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('p1/t-review-escalated-quota', 'run-check-esc', 'test', 1, 0, 100, 'pass');

      ctx.eventRepo.insert('review.escalated', 'p1/t-review-escalated-quota', {
        reason: 'reviewer_changes_limit',
      });
      ctx.eventRepo.insert('review.escalated', 'p1/t-review-escalated-quota', {
        reason: 'reviewer_changes_limit',
      });

      vi.spyOn(ctx.scheduler, 'canStartEscalationArbiter').mockReturnValue(false);

      const isEligible = ctx.scheduler.isReviewOrphanEligible(ctx.taskRepo.get('p1/t-review-escalated-quota')!);
      expect(isEligible).toBe(false);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'review_orphan' && i.taskId === 'p1/t-review-escalated-quota')).toBe(false);
    });

    it('phát hiện đúng review_orphan khi task reviewerEscalated và arbiter có thể chạy', async () => {
      const now = Date.now();
      const past35m = new Date(now - 35 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-review-escalated-ready',
        projectId: 'p1',
        title: 'Task review escalated arbiter ready',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-review-escalated-ready', {
        status: 'review',
        statusChangedAt: past35m,
        worktreePath: projectPath,
        reviewerEscalated: 1,
        reviewerEscalationReason: 'reviewer_changes_limit',
      });

      ctx.runRepo.insert({
        id: 'run-check-esc-ready',
        taskId: 'p1/t-review-escalated-ready',
        engine: 'agy',
        model: 'model',
        profileName: 'prof1',
      });
      ctx.db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('p1/t-review-escalated-ready', 'run-check-esc-ready', 'test', 1, 0, 100, 'pass');

      ctx.eventRepo.insert('review.escalated', 'p1/t-review-escalated-ready', {
        reason: 'reviewer_changes_limit',
      });
      ctx.eventRepo.insert('review.escalated', 'p1/t-review-escalated-ready', {
        reason: 'reviewer_changes_limit',
      });

      vi.spyOn(ctx.scheduler, 'canStartEscalationArbiter').mockReturnValue(true);

      const isEligible = ctx.scheduler.isReviewOrphanEligible(ctx.taskRepo.get('p1/t-review-escalated-ready')!);
      expect(isEligible).toBe(true);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'review_orphan' && i.taskId === 'p1/t-review-escalated-ready')).toBe(true);
    });

    it('không báo nhầm review_orphan khi task reviewerEscalated chờ người duyệt thủ công (không cần arbiter)', async () => {
      const now = Date.now();
      const past35m = new Date(now - 35 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-review-escalated-manual',
        projectId: 'p1',
        title: 'Task review escalated manual',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-review-escalated-manual', {
        status: 'review',
        statusChangedAt: past35m,
        worktreePath: projectPath,
        reviewerEscalated: 1,
        reviewerEscalationReason: 'manual_escalation',
      });

      ctx.runRepo.insert({
        id: 'run-check-manual',
        taskId: 'p1/t-review-escalated-manual',
        engine: 'agy',
        model: 'model',
        profileName: 'prof1',
      });
      ctx.db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('p1/t-review-escalated-manual', 'run-check-manual', 'test', 1, 0, 100, 'pass');

      const isEligible = ctx.scheduler.isReviewOrphanEligible(ctx.taskRepo.get('p1/t-review-escalated-manual')!);
      expect(isEligible).toBe(false);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'review_orphan' && i.taskId === 'p1/t-review-escalated-manual')).toBe(false);
    });

    it('canStartEscalationArbiter kiểm tra đúng quota và backoff của arbiter profile', () => {
      ctx.config.reviewer = {
        ...ctx.config.reviewer,
        enabled: true,
        arbiter: { engine: 'codex', model: 'gpt-5.6-luna' },
      } as unknown as typeof ctx.config.reviewer;

      (ctx.scheduler as unknown as { engines: Map<string, Engine> }).engines.set('codex', fakeEngine);
      ctx.profileRepo.upsert({
        name: 'codex-arbiter-1',
        engine: 'codex',
        kind: 'isolated',
        home: path.join(tmpDir, 'agy-homes', 'codex-arbiter-1'),
        email: 'codex-arbiter@example.com',
        enabled: 1,
      });

      ctx.taskRepo.insert({
        id: 'p1/t-arbiter-test',
        projectId: 'p1',
        title: 'Arbiter test',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-arbiter-test', {
        status: 'review',
        worktreePath: projectPath,
      });
      const task = ctx.taskRepo.get('p1/t-arbiter-test')!;

      // 1. When arbiter is available
      expect(ctx.scheduler.canStartEscalationArbiter(task)).toBe(true);

      // 2. When arbiter profile is exhausted
      ctx.quotaMarkRepo.mark('codex-arbiter-1', 'codex', Math.floor(Date.now() / 1000) + 3600, 'exhausted');
      expect(ctx.scheduler.canStartEscalationArbiter(task)).toBe(false);
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

    it('không báo nhầm khi scheduler đang bị pause (scheduler.isPaused() = true)', async () => {
      const now = Date.now();
      const past65m = new Date(now - 65 * 60 * 1000).toISOString();

      ctx.taskRepo.insert({
        id: 'p1/t-queued-paused',
        projectId: 'p1',
        title: 'Task queued when paused',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-queued-paused', {
        status: 'queued',
        statusChangedAt: past65m,
      });

      ctx.scheduler.pause();
      try {
        const result = await sweepService.runSweep(now);
        expect(result.issues.some((i) => i.rule === 'queued_starved' && i.taskId === 'p1/t-queued-paused')).toBe(false);
      } finally {
        ctx.scheduler.resume();
      }
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

    it('phát hiện đúng khi worktree đổi 1 lần sau start rồi đứng yên quá ngưỡng runningNoProgressMin', async () => {
      const start95m = Date.now();
      const now = start95m + 95 * 60 * 1000;
      const change2m = start95m + 2 * 60 * 1000;

      const gitIndex = path.join(projectPath, '.git', 'index');
      if (fs.existsSync(gitIndex)) {
        fs.utimesSync(gitIndex, new Date(change2m), new Date(change2m));
      }

      ctx.taskRepo.insert({
        id: 'p1/t-running-stalled-after-change',
        projectId: 'p1',
        title: 'Task running stalled after change',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-stalled-after-change', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-stalled',
        taskId: 'p1/t-running-stalled-after-change',
        pid: 99997,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start95m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: change2m,
        lastActivityAt: change2m,
        activitySource: 'worktree',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: change2m, // Changed once 2 minutes after start, then hung
        usageBefore: null,
        noCommitMinutes: 95,
      });

      const result = await sweepService.runSweep(now);
      expect(
        result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-stalled-after-change'),
      ).toBe(true);
    });

    it('không báo khi worktree đổi gần đây (trong cửa sổ runningNoProgressMin)', async () => {
      const start95m = Date.now();
      const now = start95m + 95 * 60 * 1000;
      const recentChange = now - 10 * 60 * 1000;

      ctx.taskRepo.insert({
        id: 'p1/t-running-recent',
        projectId: 'p1',
        title: 'Task running recent',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-recent', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-recent',
        taskId: 'p1/t-running-recent',
        pid: 99996,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start95m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: recentChange,
        lastActivityAt: recentChange,
        activitySource: 'worktree',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: recentChange,
        usageBefore: null,
        noCommitMinutes: 95,
      });

      const result = await sweepService.runSweep(now);
      expect(
        result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-recent'),
      ).toBe(false);
    });

    it('không báo khi .git là file (git worktree) có index thay đổi gần đây', async () => {
      const start95m = Date.now();
      const now = start95m + 95 * 60 * 1000;
      const recentChange = now - 5 * 60 * 1000;

      const wtDir = path.join(tmpDir, 'worktree-wt');
      const gitDir = path.join(tmpDir, 'gitdir-wt');
      fs.mkdirSync(wtDir, { recursive: true });
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(wtDir, '.git'), `gitdir: ${gitDir}\n`);
      const wtIndex = path.join(gitDir, 'index');
      fs.writeFileSync(wtIndex, 'mock index');
      fs.utimesSync(wtIndex, new Date(recentChange), new Date(recentChange));

      ctx.taskRepo.insert({
        id: 'p1/t-running-wt',
        projectId: 'p1',
        title: 'Task running git worktree',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-wt', {
        status: 'running',
        worktreePath: wtDir,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-wt',
        taskId: 'p1/t-running-wt',
        pid: 99995,
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
        cachedWorktreeMtime: 0,
        usageBefore: null,
        noCommitMinutes: 95,
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-wt')).toBe(false);
    });

    it('phát hiện đúng khi runningNoProgressMin < stall.noCommitMin của watchdog và worker chưa commit (lastCommitCheckAt không che giấu lỗi)', async () => {
      const now = Date.now();
      const start35m = now - 35 * 60 * 1000;

      const gitIndex = path.join(projectPath, '.git', 'index');
      if (fs.existsSync(gitIndex)) {
        fs.utimesSync(gitIndex, new Date(start35m), new Date(start35m));
      }

      // Configure health sweep threshold to 30m (< watchdog default 45m)
      ctx.config.healthSweep.rules.runningNoProgressMin = 30;

      ctx.taskRepo.insert({
        id: 'p1/t-running-starved-commits',
        projectId: 'p1',
        title: 'Task running starved commits',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-starved-commits', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-watchdog-lower',
        taskId: 'p1/t-running-starved-commits',
        pid: 99994,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start35m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: start35m,
        lastActivityAt: start35m,
        activitySource: 'log',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
        lastCommitCheckAt: now, // Watchdog just checked at now
        noCommitMinutes: undefined, // Watchdog did not set noCommitMinutes because 35m < watchdog threshold 45m
        lastCommitAt: undefined, // No commits made
      });

      const result = await sweepService.runSweep(now);
      expect(
        result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-starved-commits'),
      ).toBe(true);

      // Restore threshold
      ctx.config.healthSweep.rules.runningNoProgressMin = 90;
    });

    it('không báo khi runningNoProgressMin < stall.noCommitMin của watchdog nhưng worker đã commit gần đây', async () => {
      const now = Date.now();
      const start35m = now - 35 * 60 * 1000;
      const commit10m = now - 10 * 60 * 1000;

      // Configure health sweep threshold to 30m (< watchdog default 45m)
      ctx.config.healthSweep.rules.runningNoProgressMin = 30;

      ctx.taskRepo.insert({
        id: 'p1/t-running-committed-recently',
        projectId: 'p1',
        title: 'Task running committed recently',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-committed-recently', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-committed-recently',
        taskId: 'p1/t-running-committed-recently',
        pid: 99993,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start35m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: commit10m,
        lastActivityAt: commit10m,
        activitySource: 'log',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
        lastCommitCheckAt: now,
        noCommitMinutes: undefined, // Watchdog has not hit 45m
        lastCommitAt: commit10m, // Worker committed 10m ago (within 30m window)
      });

      const result = await sweepService.runSweep(now);
      expect(
        result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-committed-recently'),
      ).toBe(false);

      // Restore threshold
      ctx.config.healthSweep.rules.runningNoProgressMin = 90;
    });

    it('không báo khi watchdog chưa chạy nhưng git log worktree có commit trong cửa sổ progress', async () => {
      const now = Date.now();
      const start35m = now - 35 * 60 * 1000;
      const commit10m = now - 10 * 60 * 1000;

      ctx.config.healthSweep.rules.runningNoProgressMin = 30;

      const wtDir = path.join(tmpDir, 'worktree-commit');
      fs.mkdirSync(wtDir, { recursive: true });
      execFileSync('git', ['init', '--template='], { cwd: wtDir });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: wtDir });
      fs.writeFileSync(path.join(wtDir, 'README.md'), '# Main');
      execFileSync('git', ['add', '.'], { cwd: wtDir });
      execFileSync('git', ['commit', '-m', 'initial commit'], {
        cwd: wtDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
          GIT_AUTHOR_DATE: `${Math.floor(start35m / 1000)} +0000`,
          GIT_COMMITTER_DATE: `${Math.floor(start35m / 1000)} +0000`,
        },
      });

      // Checkout task branch and make commit 10m ago
      execFileSync('git', ['checkout', '-b', 'agenthub/t-running-git-commit'], { cwd: wtDir });
      fs.writeFileSync(path.join(wtDir, 'file.txt'), 'progress content');
      execFileSync('git', ['add', '.'], { cwd: wtDir });
      execFileSync('git', ['commit', '-m', 'worker commit 10m ago'], {
        cwd: wtDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
          GIT_AUTHOR_DATE: `${Math.floor(commit10m / 1000)} +0000`,
          GIT_COMMITTER_DATE: `${Math.floor(commit10m / 1000)} +0000`,
        },
      });

      // Intentionally touch index to an older time to ensure commit timestamp is what prevents alert
      const gitIndex = path.join(wtDir, '.git', 'index');
      if (fs.existsSync(gitIndex)) {
        fs.utimesSync(gitIndex, new Date(start35m), new Date(start35m));
      }

      ctx.taskRepo.insert({
        id: 'p1/t-running-git-commit',
        projectId: 'p1',
        title: 'Task running git commit',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-git-commit', {
        status: 'running',
        worktreePath: wtDir,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-git-commit',
        taskId: 'p1/t-running-git-commit',
        pid: 99992,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start35m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: start35m,
        lastActivityAt: start35m,
        activitySource: 'log',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
        lastCommitCheckAt: undefined, // watchdog hasn't run
        noCommitMinutes: undefined,
        lastCommitAt: undefined,
      });

      const result = await sweepService.runSweep(now);
      expect(
        result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-git-commit'),
      ).toBe(false);

      // Restore threshold
      ctx.config.healthSweep.rules.runningNoProgressMin = 90;
    });

    it('không báo nhầm khi worker runtime đang bị pause (rt.paused = true)', async () => {
      const start95m = Date.now();
      const now = start95m + 95 * 60 * 1000;

      ctx.taskRepo.insert({
        id: 'p1/t-running-paused',
        projectId: 'p1',
        title: 'Task running paused',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-paused', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-paused',
        taskId: 'p1/t-running-paused',
        pid: 99991,
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
        cachedWorktreeMtime: 0,
        usageBefore: null,
        paused: true,
        pauseReason: 'manual',
        pausedAt: now - 30 * 60 * 1000,
        noCommitMinutes: 95,
      });

      const result = await sweepService.runSweep(now);
      expect(
        result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-paused'),
      ).toBe(false);
    });

    it('không báo nhầm khi worker vừa được resume trong cửa sổ runningNoProgressMin (rt.resumedAt)', async () => {
      const start120m = Date.now();
      const resume10m = start120m + 110 * 60 * 1000;
      const now = start120m + 120 * 60 * 1000;

      ctx.taskRepo.insert({
        id: 'p1/t-running-resumed',
        projectId: 'p1',
        title: 'Task running resumed recently',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-running-resumed', {
        status: 'running',
        worktreePath: projectPath,
      });

      vi.spyOn(ctx.scheduler, 'getRunningTask').mockReturnValue({
        runId: 'r-resumed',
        taskId: 'p1/t-running-resumed',
        pid: 99990,
        pidStart: null,
        profileName: 'prof1',
        model: 'gemini',
        engine: fakeEngine,
        startTime: start120m,
        timeoutMs: 3600000,
        timeoutAt: now + 3600000,
        retryCount: 0,
        projectId: 'p1',
        lastOutputAt: resume10m,
        lastActivityAt: resume10m,
        activitySource: 'log',
        activityCheckedAt: now,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
        paused: false,
        resumedAt: resume10m,
        noCommitMinutes: 120,
      });

      const result = await sweepService.runSweep(now);
      expect(
        result.issues.some((i) => i.rule === 'running_no_progress' && i.taskId === 'p1/t-running-resumed'),
      ).toBe(false);
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

    it('bỏ qua an toàn khi event task.queued có payload JSON hỏng (malformed string)', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-failover-corrupt-payload',
        projectId: 'p1',
        title: 'Task corrupt payload',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-failover-corrupt-payload', {
        status: 'queued',
      });

      // Insert event with corrupted JSON payload string directly into DB
      ctx.db
        .prepare('INSERT INTO events (ts, type, taskId, payload) VALUES (?, ?, ?, ?)')
        .run(new Date(now).toISOString(), 'task.queued', 'p1/t-failover-corrupt-payload', '{malformed json string');

      // Also insert 3 valid failover events (total 3, below threshold of 4)
      for (let i = 0; i < 3; i++) {
        ctx.eventRepo.insert('task.failover', 'p1/t-failover-corrupt-payload', { reason: 'quota_exhausted' });
      }

      // Sweep should not throw error and should not count the corrupted event as quota_retry
      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'failover_churn' && i.taskId === 'p1/t-failover-corrupt-payload')).toBe(false);
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

    it('không đánh dấu crashed với run mới tạo chưa có PID (pid IS NULL dưới ngưỡng 10 phút)', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-new-run-nopid',
        projectId: 'p1',
        title: 'Task new run no pid',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-new-run-nopid', {
        status: 'running',
      });

      // Insert newly created run (started 2 minutes ago) without PID
      const past2m = new Date(now - 2 * 60 * 1000).toISOString();
      ctx.runRepo.insert({
        id: 'run-new-nopid',
        taskId: 'p1/t-new-run-nopid',
        engine: 'agy',
        model: 'gemini',
        profileName: 'prof1',
        startedAt: past2m,
        kind: 'worker',
      });

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'stale_run' && i.taskId === 'p1/t-new-run-nopid')).toBe(false);

      const runRow = ctx.runRepo.get('run-new-nopid');
      expect(runRow?.outcome).toBeNull();
    });

    it('tự sửa run không có PID nhưng mồ côi quá 10 phút và task không còn running trong scheduler', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-orphaned-nopid',
        projectId: 'p1',
        title: 'Task orphaned no pid',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-orphaned-nopid', {
        status: 'running',
      });

      // Insert run without PID started 15 minutes ago
      const past15m = new Date(now - 15 * 60 * 1000).toISOString();
      ctx.runRepo.insert({
        id: 'run-orphaned-nopid',
        taskId: 'p1/t-orphaned-nopid',
        engine: 'agy',
        model: 'gemini',
        profileName: 'prof1',
        startedAt: past15m,
        kind: 'worker',
      });

      // Task is not running in scheduler
      vi.spyOn(ctx.scheduler, 'isRunning').mockReturnValue(false);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'stale_run' && i.taskId === 'p1/t-orphaned-nopid')).toBe(true);

      const runRow = ctx.runRepo.get('run-orphaned-nopid');
      expect(runRow?.outcome).toBe('crashed');
      const updatedTask = ctx.taskRepo.get('p1/t-orphaned-nopid');
      expect(updatedTask?.status).toBe('queued');
      expect(updatedTask?.resume).toBe(1);
    });

    it('phát hiện stale_run khi PID của run còn sống nhưng pidStart không khớp (PID bị tái sử dụng)', async () => {
      const now = Date.now();
      ctx.taskRepo.insert({
        id: 'p1/t-reused-pid',
        projectId: 'p1',
        title: 'Task reused pid',
        level: 'easy',
      });
      ctx.taskRepo.update('p1/t-reused-pid', {
        status: 'running',
      });

      // Insert run with current living process pid, but with a mismatched pidStart
      const realStart = ctx.scheduler.getProcessStartTime(process.pid) ?? 10000;
      ctx.runRepo.insert({
        id: 'run-reused-pid',
        taskId: 'p1/t-reused-pid',
        engine: 'agy',
        model: 'gemini',
        profileName: 'prof1',
        pid: process.pid,
        pidStart: realStart + 999999, // Mismatched start time indicates reused PID
        kind: 'worker',
      });

      vi.spyOn(ctx.scheduler, 'isRunActive').mockReturnValue(false);

      const result = await sweepService.runSweep(now);
      expect(result.issues.some((i) => i.rule === 'stale_run' && i.taskId === 'p1/t-reused-pid')).toBe(true);

      const runRow = ctx.runRepo.get('run-reused-pid');
      expect(runRow?.outcome).toBe('crashed');
      const updatedTask = ctx.taskRepo.get('p1/t-reused-pid');
      expect(updatedTask?.status).toBe('queued');
      expect(updatedTask?.resume).toBe(1);
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

  // Periodic sweep timer error handling
  describe('Periodic sweep timer error handling', () => {
    it('bắt và log lỗi an toàn khi runSweep bị reject trong timer setInterval', async () => {
      vi.useFakeTimers();
      try {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(sweepService, 'runSweep').mockRejectedValue(new Error('database locked'));

        sweepService.start();
        // Fast-forward interval
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[health] periodic sweep failed:',
          expect.any(Error),
        );
      } finally {
        sweepService.stop();
        vi.useRealTimers();
      }
    });
  });
});
