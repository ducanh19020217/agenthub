import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

describe('Auto-close tasks merged elsewhere', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let projectPath: string;

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-auto-close-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    // Setup git repo for project
    projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Test\n');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: projectPath, env: gitEnv });

    ctx.projectRepo.insert({
      id: 'proj',
      name: 'Project',
      path: projectPath,
      defaultBranch: 'main',
      maxParallel: 2,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.scheduler.stop();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  it('closes a blocked task when its branch was merged into target branch', async () => {
    // Create task branch and commit
    execFileSync('git', ['checkout', '-b', 'agenthub/task-merged', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'feature.txt'), 'feature content');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: add feature'], { cwd: projectPath, env: gitEnv });

    // Merge task branch into main
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-merged', '-m', 'Merge branch agenthub/task-merged'], {
      cwd: projectPath,
      env: gitEnv,
    });

    // Insert task in blocked status
    ctx.taskRepo.insert({
      id: 'proj/task-merged',
      projectId: 'proj',
      slug: 'task-merged',
      title: 'Task Merged Elsewhere',
      status: 'blocked',
      branch: 'agenthub/task-merged',
      baseRef: 'main',
    });

    const closed = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(1);

    const updated = ctx.taskRepo.get('proj/task-merged');
    expect(updated?.status).toBe('done');

    const autoClosedEvent = ctx.eventRepo.getByTask('proj/task-merged').find((e) => e.type === 'task.auto_closed');
    expect(autoClosedEvent).toBeDefined();
    expect(autoClosedEvent?.payload).toContain('merged_elsewhere');

    const doneEvent = ctx.eventRepo.getByTask('proj/task-merged').find((e) => e.type === 'task.done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.payload).toContain('merged_elsewhere');

    const mergedEvent = ctx.eventRepo.getByTask('proj/task-merged').find((e) => e.type === 'task.merged');
    expect(mergedEvent).toBeUndefined();
  });

  it('keeps task as is when its branch has not been merged', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-unmerged', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'unmerged.txt'), 'unmerged content');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: unmerged'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });

    ctx.taskRepo.insert({
      id: 'proj/task-unmerged',
      projectId: 'proj',
      slug: 'task-unmerged',
      title: 'Task Unmerged',
      status: 'blocked',
      branch: 'agenthub/task-unmerged',
      baseRef: 'main',
    });

    const closed = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(0);

    const task = ctx.taskRepo.get('proj/task-unmerged');
    expect(task?.status).toBe('blocked');
  });

  it('keeps task as is when branch has no commits compared to base', async () => {
    // Create branch at main with 0 new commits
    execFileSync('git', ['branch', 'agenthub/task-no-commits', 'main'], { cwd: projectPath });

    // Advance main with an unrelated merge commit
    execFileSync('git', ['checkout', '-b', 'other-feature', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'other.txt'), 'other');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: other'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'other-feature', '-m', 'Merge other-feature'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-no-commits',
      projectId: 'proj',
      slug: 'task-no-commits',
      title: 'Task No Commits',
      status: 'blocked',
      branch: 'agenthub/task-no-commits',
      baseRef: 'main',
    });

    const closed = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(0);

    const task = ctx.taskRepo.get('proj/task-no-commits');
    expect(task?.status).toBe('blocked');
  });

  it('keeps task as is when task is running or queued even if branch is merged', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-running', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'running.txt'), 'content');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: running'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-running', '-m', 'Merge running'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-running',
      projectId: 'proj',
      slug: 'task-running',
      title: 'Task Running',
      status: 'running',
      branch: 'agenthub/task-running',
      baseRef: 'main',
    });

    ctx.taskRepo.insert({
      id: 'proj/task-queued',
      projectId: 'proj',
      slug: 'task-queued',
      title: 'Task Queued',
      status: 'queued',
      branch: 'agenthub/task-running',
      baseRef: 'main',
    });

    const closed = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(0);

    expect(ctx.taskRepo.get('proj/task-running')?.status).toBe('running');
    expect(ctx.taskRepo.get('proj/task-queued')?.status).toBe('queued');
  });

  it('closes tasks in review and failed when merged into target branch', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-review', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'review.txt'), 'review content');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: review'], { cwd: projectPath, env: gitEnv });

    execFileSync('git', ['checkout', '-b', 'agenthub/task-failed', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'failed.txt'), 'failed content');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: failed'], { cwd: projectPath, env: gitEnv });

    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-review', '-m', 'Merge review'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-failed', '-m', 'Merge failed'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-review',
      projectId: 'proj',
      slug: 'task-review',
      title: 'Task Review',
      status: 'review',
      branch: 'agenthub/task-review',
      baseRef: 'main',
    });
    // Review task updatedAt must be older than 15 minutes
    ctx.db.prepare("UPDATE tasks SET updatedAt = datetime('now', '-20 minutes') WHERE id = ?").run('proj/task-review');

    ctx.taskRepo.insert({
      id: 'proj/task-failed',
      projectId: 'proj',
      slug: 'task-failed',
      title: 'Task Failed',
      status: 'failed',
      branch: 'agenthub/task-failed',
      baseRef: 'main',
    });

    const closed = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(2);

    expect(ctx.taskRepo.get('proj/task-review')?.status).toBe('done');
    expect(ctx.taskRepo.get('proj/task-failed')?.status).toBe('done');
  });

  it('supports integration branch when integration is enabled', async () => {
    // Setup integration branch
    execFileSync('git', ['checkout', '-b', 'agenthub/integration', 'main'], { cwd: projectPath });

    ctx.projectRepo.update('proj', {
      settings: JSON.stringify({
        integration: {
          enabled: true,
          branch: 'agenthub/integration',
        },
      }),
    });

    execFileSync('git', ['checkout', '-b', 'agenthub/task-integration', 'agenthub/integration'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'integ.txt'), 'integ content');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: integ'], { cwd: projectPath, env: gitEnv });

    // Merge into integration branch (not main)
    execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-integration', '-m', 'Merge into integration'], {
      cwd: projectPath,
      env: gitEnv,
    });

    ctx.taskRepo.insert({
      id: 'proj/task-integ',
      projectId: 'proj',
      slug: 'task-integ',
      title: 'Task Integrated',
      status: 'blocked',
      branch: 'agenthub/task-integration',
      baseRef: 'agenthub/integration',
    });

    const closed = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(1);

    expect(ctx.taskRepo.get('proj/task-integ')?.status).toBe('done');
  });

  it('skips review task updated within 15 minutes to avoid race with reviewer/merge', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-review-recent', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'review-recent.txt'), 'recent');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: review-recent'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-review-recent', '-m', 'Merge review recent'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-review-recent',
      projectId: 'proj',
      slug: 'task-review-recent',
      title: 'Task Review Recent',
      status: 'review',
      branch: 'agenthub/task-review-recent',
      baseRef: 'main',
    });
    // Task created just now (updatedAt is within 15 mins)
    const closed1 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed1).toBe(0);
    expect(ctx.taskRepo.get('proj/task-review-recent')?.status).toBe('review');

    // After 16 minutes, it should be eligible and closed
    ctx.db.prepare("UPDATE tasks SET updatedAt = datetime('now', '-16 minutes') WHERE id = ?").run('proj/task-review-recent');
    const closed2 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed2).toBe(1);
    expect(ctx.taskRepo.get('proj/task-review-recent')?.status).toBe('done');
  });

  it('skips task when merge is in progress', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-merging', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'merging.txt'), 'merging');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: merging'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-merging', '-m', 'Merge merging'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-merging',
      projectId: 'proj',
      slug: 'task-merging',
      title: 'Task Merging',
      status: 'review',
      branch: 'agenthub/task-merging',
      baseRef: 'main',
    });
    ctx.db.prepare("UPDATE tasks SET updatedAt = datetime('now', '-20 minutes') WHERE id = ?").run('proj/task-merging');

    // Mark task as merging
    ctx.scheduler.setTaskMerging('proj/task-merging', true);
    expect(ctx.scheduler.isTaskMerging('proj/task-merging')).toBe(true);

    const closed1 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed1).toBe(0);
    expect(ctx.taskRepo.get('proj/task-merging')?.status).toBe('review');

    // Unmark merging
    ctx.scheduler.setTaskMerging('proj/task-merging', false);
    const closed2 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed2).toBe(1);
    expect(ctx.taskRepo.get('proj/task-merging')?.status).toBe('done');
  });

  it('skips task when reviewer is actively running', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-reviewing', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'reviewing.txt'), 'reviewing');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: reviewing'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-reviewing', '-m', 'Merge reviewing'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-reviewing',
      projectId: 'proj',
      slug: 'task-reviewing',
      title: 'Task Reviewing',
      status: 'review',
      branch: 'agenthub/task-reviewing',
      baseRef: 'main',
    });
    ctx.db.prepare("UPDATE tasks SET updatedAt = datetime('now', '-20 minutes') WHERE id = ?").run('proj/task-reviewing');

    // Simulate reviewer running on task
    (ctx.scheduler as unknown as { reviewerRuns: Map<string, unknown> }).reviewerRuns.set('proj/task-reviewing', {
      taskId: 'proj/task-reviewing',
      runId: 'run-1',
      profileName: 'codex-1',
      engine: 'codex',
      actor: 'codex-reviewer',
      outputPath: '/tmp/out',
      startedAt: Date.now(),
    });

    const closed1 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed1).toBe(0);
    expect(ctx.taskRepo.get('proj/task-reviewing')?.status).toBe('review');

    // Clear reviewer run
    (ctx.scheduler as unknown as { reviewerRuns: Map<string, unknown> }).reviewerRuns.delete('proj/task-reviewing');
    const closed2 = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed2).toBe(1);
    expect(ctx.taskRepo.get('proj/task-reviewing')?.status).toBe('done');
  });

  it('skips failed task older than 30 days but closes newer failed task', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-failed-old', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'failed-old.txt'), 'old');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: failed old'], { cwd: projectPath, env: gitEnv });

    execFileSync('git', ['checkout', '-b', 'agenthub/task-failed-new', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'failed-new.txt'), 'new');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: failed new'], { cwd: projectPath, env: gitEnv });

    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-failed-old', '-m', 'Merge failed old'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-failed-new', '-m', 'Merge failed new'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-failed-old',
      projectId: 'proj',
      slug: 'task-failed-old',
      title: 'Task Failed Old',
      status: 'failed',
      branch: 'agenthub/task-failed-old',
      baseRef: 'main',
    });
    ctx.db.prepare("UPDATE tasks SET updatedAt = datetime('now', '-35 days') WHERE id = ?").run('proj/task-failed-old');

    ctx.taskRepo.insert({
      id: 'proj/task-failed-new',
      projectId: 'proj',
      slug: 'task-failed-new',
      title: 'Task Failed New',
      status: 'failed',
      branch: 'agenthub/task-failed-new',
      baseRef: 'main',
    });
    ctx.db.prepare("UPDATE tasks SET updatedAt = datetime('now', '-5 days') WHERE id = ?").run('proj/task-failed-new');

    const closed = await ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(1);

    expect(ctx.taskRepo.get('proj/task-failed-old')?.status).toBe('failed');
    expect(ctx.taskRepo.get('proj/task-failed-new')?.status).toBe('done');
  });

  it('does not rerun autoCloseMergedTasks in scheduler tick before 10 minutes interval', async () => {
    // Note: createContext already invoked autoCloseMergedTasks once on startup and initialized lastMergedTasksCheck.
    const autoCloseSpy = vi.spyOn(ctx.scheduler, 'autoCloseMergedTasks');

    // First tick immediately after startup (< 10 minutes) -> should NOT call autoCloseMergedTasks
    await ctx.scheduler.tick();
    expect(autoCloseSpy).toHaveBeenCalledTimes(0);

    // Advance Date.now by 5 minutes (< 10 minutes) -> should NOT call
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000);
    await ctx.scheduler.tick();
    expect(autoCloseSpy).toHaveBeenCalledTimes(0);

    // Advance Date.now by 10 minutes + 1 second -> should call
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1000);
    await ctx.scheduler.tick();
    expect(autoCloseSpy).toHaveBeenCalledTimes(1);
  });

  it('emits task.auto_closed with reason and targetBranch, and does not emit task.merged', async () => {
    execFileSync('git', ['checkout', '-b', 'agenthub/task-event-check', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'event.txt'), 'event test');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: event test'], { cwd: projectPath, env: gitEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: projectPath });
    execFileSync('git', ['merge', '--no-ff', 'agenthub/task-event-check', '-m', 'Merge event test'], { cwd: projectPath, env: gitEnv });

    ctx.taskRepo.insert({
      id: 'proj/task-event-check',
      projectId: 'proj',
      slug: 'task-event-check',
      title: 'Task Event Check',
      status: 'blocked',
      branch: 'agenthub/task-event-check',
      baseRef: 'main',
    });

    const emittedEvents: Array<{ type: string; taskId?: string; payload?: unknown }> = [];
    ctx.scheduler.getEventBus().on('*', (type, taskId, payload) => {
      emittedEvents.push({ type, taskId, payload });
    });

    await ctx.scheduler.autoCloseMergedTasks();

    const autoClosed = emittedEvents.find((e) => e.type === 'task.auto_closed');
    expect(autoClosed).toBeDefined();
    expect(autoClosed?.payload).toEqual(expect.objectContaining({
      reason: 'merged_elsewhere',
      targetBranch: 'main',
    }));

    const merged = emittedEvents.find((e) => e.type === 'task.merged');
    expect(merged).toBeUndefined();
  });
});
