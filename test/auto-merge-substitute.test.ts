import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';

describe('Auto-merge with Claude substitute and review_ready flow', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;

  function initGitRepo(repoPath: string, branch = 'main'): void {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'AgentHub Test'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial Repo\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
    execFileSync('git', ['checkout', '-B', branch], { cwd: repoPath });
  }

  function persistPassedCheck(taskId: string, suffix: string): void {
    const runId = `check-${suffix}`;
    ctx.runRepo.insert({ id: runId, taskId, engine: 'hub', model: 'checks', profileName: 'hub' });
    ctx.db.prepare("INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, 'test', 1, 0, 1, 'ok')").run(taskId, runId);
  }

  function persistFailedCheck(taskId: string, suffix: string): void {
    const runId = `check-fail-${suffix}`;
    ctx.runRepo.insert({ id: runId, taskId, engine: 'hub', model: 'checks', profileName: 'hub' });
    ctx.db.prepare("INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, 'test', 0, 1, 1, 'failed')").run(taskId, runId);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-automerge-substitute-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });

    const config = loadConfig(tmpDir);
    config.port = 0;
    const engines = new Map<string, Engine>([
      ['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))],
    ]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    const profileHome = path.join(tmpDir, 'profile-home');
    fs.mkdirSync(profileHome, { recursive: true });
    ctx.profileRepo.upsert({
      name: 'test-profile',
      engine: 'agy',
      kind: 'isolated',
      home: profileHome,
      email: null,
      enabled: 1,
    });
  });

  afterEach(() => {
    try {
      ctx.scheduler.stop();
      ctx.db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('auto-merges when Claude substitutes for Codex gate step and approves with autoMerge enabled', async () => {
    const repo = path.join(tmpDir, 'claude-sub-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'sub-proj',
      name: 'Claude substitute auto merge',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: { enabled: true, branch: 'agenthub/integration', autoMerge: true },
        review: { autoMerge: true },
      },
      reviewChain: [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }],
      merge: { enabled: true, worktrees: {}, checks: ['node -e "process.exit(0)"'], timeoutSec: 30 },
    });
    const intPath = path.join(tmpDir, 'integration', 'sub-proj');
    ctx.service.createTask({ project: 'sub-proj', slug: 'feat-claude', title: 'Feature Claude', body: 'Do it', level: 'easy', start: true });
    ctx.scheduler.tick();
    const task = ctx.taskRepo.get('sub-proj/feat-claude')!;
    fs.writeFileSync(path.join(task.worktreePath!, 'claude.txt'), 'claude approved\n');
    execFileSync('git', ['-C', task.worktreePath!, 'add', '.']);
    execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'feat: claude approved']);
    ctx.taskRepo.update(task.id, { status: 'review', reviewStep: 1 });
    persistPassedCheck(task.id, 'claude-1');

    // Claude substitute approval
    ctx.reviewRepo.insert({
      id: 'claude-ok-1',
      taskId: task.id,
      verdict: 'approved',
      feedback: 'looks great',
      actor: 'claude-reviewer',
    });

    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('done');
    expect(fs.existsSync(path.join(intPath, 'claude.txt'))).toBe(true);

    const reviews = ctx.reviewRepo.getByTask(task.id);
    const autoMergeReview = reviews.find((r) => r.actor === 'auto-merge');
    expect(autoMergeReview?.feedback).toBe('Tự merge sau khi reviewer tự động (claude-reviewer) chấp thuận.');
  });

  it('auto-merges when Codex reviewer approves, preserving existing behavior', async () => {
    const repo = path.join(tmpDir, 'codex-sub-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'codex-proj',
      name: 'Codex auto merge',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: { enabled: true, branch: 'agenthub/integration', autoMerge: true },
        review: { autoMerge: true },
      },
      reviewChain: [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }],
      merge: { enabled: true, worktrees: {}, checks: ['node -e "process.exit(0)"'], timeoutSec: 30 },
    });
    const intPath = path.join(tmpDir, 'integration', 'codex-proj');
    ctx.service.createTask({ project: 'codex-proj', slug: 'feat-codex', title: 'Feature Codex', body: 'Do it', level: 'easy', start: true });
    ctx.scheduler.tick();
    const task = ctx.taskRepo.get('codex-proj/feat-codex')!;
    fs.writeFileSync(path.join(task.worktreePath!, 'codex.txt'), 'codex approved\n');
    execFileSync('git', ['-C', task.worktreePath!, 'add', '.']);
    execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'feat: codex approved']);
    ctx.taskRepo.update(task.id, { status: 'review', reviewStep: 1 });
    persistPassedCheck(task.id, 'codex-1');

    ctx.reviewRepo.insert({
      id: 'codex-ok-1',
      taskId: task.id,
      verdict: 'approved',
      feedback: 'looks great',
      actor: 'codex-reviewer',
    });

    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('done');
    expect(fs.existsSync(path.join(intPath, 'codex.txt'))).toBe(true);

    const reviews = ctx.reviewRepo.getByTask(task.id);
    const autoMergeReview = reviews.find((r) => r.actor === 'auto-merge');
    expect(autoMergeReview?.feedback).toBe('Tự merge sau khi reviewer tự động (codex-reviewer) chấp thuận.');
  });

  it('does not merge when autoMerge is disabled, and emits review_ready exactly once without spam', async () => {
    const repo = path.join(tmpDir, 'no-automerge-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'no-auto-proj',
      name: 'No auto merge',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: { enabled: true, branch: 'agenthub/integration', autoMerge: false },
        review: { autoMerge: false },
      },
      reviewChain: [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }],
      merge: { enabled: true, worktrees: {}, checks: [], timeoutSec: 30 },
    });
    ctx.service.createTask({ project: 'no-auto-proj', slug: 'feat-manual', title: 'Feature Manual', body: 'Do it', level: 'easy', start: false });
    const task = ctx.taskRepo.get('no-auto-proj/feat-manual')!;
    const wtPath = path.join(tmpDir, 'wt-manual');
    initGitRepo(wtPath, 'feat-manual');
    ctx.taskRepo.update(task.id, { status: 'review', reviewStep: 0, worktreePath: wtPath });
    persistPassedCheck(task.id, 'manual-1');

    const emittedReviewReady: Array<{ taskId: string; payload?: unknown }> = [];
    ctx.scheduler.getEventBus().on('task.review_ready', (taskId, payload) => {
      if (taskId === task.id) {
        emittedReviewReady.push({ taskId, payload });
      }
    });

    // Claude substitute approves the gate review
    ctx.scheduler.reviewTask(task.id, 'approved', 'Claude says good', 'claude-reviewer');

    // Run multiple scheduler ticks
    for (let i = 0; i < 5; i++) {
      ctx.scheduler.tick();
    }

    // autoMergeReviewedTask is called (daemon would call this on task.review_ready)
    await ctx.service.autoMergeReviewedTask(task.id);

    // Stays in review because autoMerge is false
    expect(ctx.taskRepo.get(task.id)!.status).toBe('review');

    // review_ready must be emitted exactly ONCE, not spammed across ticks
    expect(emittedReviewReady).toHaveLength(1);
    expect(emittedReviewReady[0].payload).toMatchObject({ reviewChainComplete: true });
  });

  it('does not merge when checks fail', async () => {
    const repo = path.join(tmpDir, 'failed-checks-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'fail-chk-proj',
      name: 'Failed checks auto merge',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: { enabled: true, branch: 'agenthub/integration', autoMerge: true },
        review: { autoMerge: true },
      },
      reviewChain: [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }],
      merge: { enabled: true, worktrees: {}, checks: [], timeoutSec: 30 },
    });
    ctx.service.createTask({ project: 'fail-chk-proj', slug: 'feat-fail-chk', title: 'Feature Fail', body: 'Do it', level: 'easy', start: true });
    ctx.scheduler.tick();
    const task = ctx.taskRepo.get('fail-chk-proj/feat-fail-chk')!;
    fs.writeFileSync(path.join(task.worktreePath!, 'fail.txt'), 'fail\n');
    execFileSync('git', ['-C', task.worktreePath!, 'add', '.']);
    execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'feat: fail']);
    ctx.taskRepo.update(task.id, { status: 'review', reviewStep: 1 });

    // Fails checks
    persistFailedCheck(task.id, 'fail-chk-1');

    ctx.reviewRepo.insert({
      id: 'claude-ok-fail',
      taskId: task.id,
      verdict: 'approved',
      feedback: 'approved',
      actor: 'claude-reviewer',
    });

    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('review');
  });

  it('does not merge when task is escalated or review step is not complete', async () => {
    const repo = path.join(tmpDir, 'guard-checks-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'guard-proj',
      name: 'Guard auto merge',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: { enabled: true, branch: 'agenthub/integration', autoMerge: true },
        review: { autoMerge: true },
      },
      reviewChain: [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }],
      merge: { enabled: true, worktrees: {}, checks: [], timeoutSec: 30 },
    });
    ctx.service.createTask({ project: 'guard-proj', slug: 'feat-guard', title: 'Feature Guard', body: 'Do it', level: 'easy', start: true });
    ctx.scheduler.tick();
    const task = ctx.taskRepo.get('guard-proj/feat-guard')!;
    fs.writeFileSync(path.join(task.worktreePath!, 'guard.txt'), 'guard\n');
    execFileSync('git', ['-C', task.worktreePath!, 'add', '.']);
    execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'feat: guard']);
    persistPassedCheck(task.id, 'guard-1');
    ctx.reviewRepo.insert({
      id: 'rev-ok-guard',
      taskId: task.id,
      verdict: 'approved',
      feedback: 'approved',
      actor: 'claude-reviewer',
    });

    // 1. reviewStep < chain.length: does not merge
    ctx.taskRepo.update(task.id, { status: 'review', reviewStep: 0, reviewerEscalated: 0 });
    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('review');

    // 2. reviewerEscalated: does not merge
    ctx.taskRepo.update(task.id, { status: 'review', reviewStep: 1, reviewerEscalated: 1 });
    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('review');
  });

  it('does not merge when the last reviewer is not an automated reviewer', async () => {
    const repo = path.join(tmpDir, 'human-rev-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'human-proj',
      name: 'Human reviewer',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: { enabled: true, branch: 'agenthub/integration', autoMerge: true },
        review: { autoMerge: true },
      },
      reviewChain: [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }],
      merge: { enabled: true, worktrees: {}, checks: [], timeoutSec: 30 },
    });
    ctx.service.createTask({ project: 'human-proj', slug: 'feat-human', title: 'Feature Human', body: 'Do it', level: 'easy', start: true });
    ctx.scheduler.tick();
    const task = ctx.taskRepo.get('human-proj/feat-human')!;
    fs.writeFileSync(path.join(task.worktreePath!, 'human.txt'), 'human\n');
    execFileSync('git', ['-C', task.worktreePath!, 'add', '.']);
    execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'feat: human']);
    persistPassedCheck(task.id, 'human-1');
    ctx.taskRepo.update(task.id, { status: 'review', reviewStep: 1 });

    ctx.reviewRepo.insert({
      id: 'human-ok',
      taskId: task.id,
      verdict: 'approved',
      feedback: 'approved by human',
      actor: 'alice-reviewer',
    });

    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('review');
  });
});
