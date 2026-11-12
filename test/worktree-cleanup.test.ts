import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { WorktreeService } from '../src/worktrees/index.js';

describe('Worktree Auto-Cleanup', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cleanup-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.cleanup.nodeModulesOnDone = true;
    config.cleanup.worktreeOnDoneAfterHours = 24;

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    // Setup git repo for project
    projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
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

  it('keeps node_modules when task is in review, deletes node_modules on done', () => {
    const worktreePath = path.join(tmpDir, 'worktrees', 'proj', 't1');
    fs.mkdirSync(path.join(worktreePath, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(worktreePath, 'web', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, 'node_modules', 'dep.txt'), 'dep');
    fs.writeFileSync(path.join(worktreePath, 'web', 'node_modules', 'web-dep.txt'), 'web-dep');

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'review',
      level: 'easy',
    });
    ctx.taskRepo.update('proj/t1', { worktreePath });

    // Review state: node_modules must remain
    expect(fs.existsSync(path.join(worktreePath, 'node_modules'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'web', 'node_modules'))).toBe(true);

    // Approve the task -> status becomes 'done'
    ctx.scheduler.reviewTask('proj/t1', 'approved');

    const task = ctx.taskRepo.get('proj/t1');
    expect(task?.status).toBe('done');

    // Worktree directory is KEPT, but node_modules folders are DELETED
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, 'web', 'node_modules'))).toBe(false);
  });

  it('deletes node_modules when task is cancelled', () => {
    const worktreePath = path.join(tmpDir, 'worktrees', 'proj', 't2');
    fs.mkdirSync(path.join(worktreePath, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(worktreePath, 'web', 'node_modules'), { recursive: true });

    ctx.taskRepo.insert({
      id: 'proj/t2',
      projectId: 'proj',
      slug: 't2',
      title: 'Task 2',
      status: 'queued',
      level: 'easy',
    });
    ctx.taskRepo.update('proj/t2', { worktreePath });

    ctx.scheduler.cancelTask('proj/t2');

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(worktreePath, 'web', 'node_modules'))).toBe(false);
  });

  it('keeps node_modules on done when cleanup.nodeModulesOnDone is false', () => {
    config.cleanup.nodeModulesOnDone = false;

    const worktreePath = path.join(tmpDir, 'worktrees', 'proj', 't3');
    fs.mkdirSync(path.join(worktreePath, 'node_modules'), { recursive: true });

    ctx.taskRepo.insert({
      id: 'proj/t3',
      projectId: 'proj',
      slug: 't3',
      title: 'Task 3',
      status: 'review',
      level: 'easy',
    });
    ctx.taskRepo.update('proj/t3', { worktreePath });

    ctx.scheduler.reviewTask('proj/t3', 'approved');

    expect(fs.existsSync(path.join(worktreePath, 'node_modules'))).toBe(true);
  });

  it('prunes expired worktrees for done tasks older than worktreeOnDoneAfterHours, never touching non-done tasks', () => {
    config.cleanup.worktreeOnDoneAfterHours = 24;

    // Create a real worktree using git so remove() succeeds
    const doneWorktree = path.join(tmpDir, 'worktrees', 'proj', 't-old-done');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', doneWorktree, '-b', 'agenthub/t-old-done', 'main']);

    const reviewWorktree = path.join(tmpDir, 'worktrees', 'proj', 't-old-review');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', reviewWorktree, '-b', 'agenthub/t-old-review', 'main']);

    const blockedWorktree = path.join(tmpDir, 'worktrees', 'proj', 't-old-blocked');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', blockedWorktree, '-b', 'agenthub/t-old-blocked', 'main']);

    ctx.taskRepo.insert({
      id: 'proj/t-old-done',
      projectId: 'proj',
      slug: 't-old-done',
      title: 'Old Done Task',
      status: 'done',
      level: 'easy',
    });
    ctx.taskRepo.update('proj/t-old-done', { worktreePath: doneWorktree });

    ctx.taskRepo.insert({
      id: 'proj/t-old-review',
      projectId: 'proj',
      slug: 't-old-review',
      title: 'Review Task',
      status: 'review',
      level: 'easy',
    });
    ctx.taskRepo.update('proj/t-old-review', { worktreePath: reviewWorktree });

    ctx.taskRepo.insert({
      id: 'proj/t-old-blocked',
      projectId: 'proj',
      slug: 't-old-blocked',
      title: 'Blocked Task',
      status: 'blocked',
      level: 'easy',
    });
    ctx.taskRepo.update('proj/t-old-blocked', { worktreePath: blockedWorktree });

    // Set updatedAt to 25 hours ago for all 3 tasks in DB
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    ctx.db.prepare("UPDATE tasks SET updatedAt = ? WHERE id IN ('proj/t-old-done', 'proj/t-old-review', 'proj/t-old-blocked')").run(oldTime);

    // Trigger tick
    ctx.scheduler.tick();

    // t-old-done worktree should be completely removed
    expect(fs.existsSync(doneWorktree)).toBe(false);
    expect(ctx.taskRepo.get('proj/t-old-done')?.worktreePath).toBeNull();

    // t-old-review and t-old-blocked worktrees MUST NEVER be removed
    expect(fs.existsSync(reviewWorktree)).toBe(true);
    expect(ctx.taskRepo.get('proj/t-old-review')?.worktreePath).toBe(reviewWorktree);

    expect(fs.existsSync(blockedWorktree)).toBe(true);
    expect(ctx.taskRepo.get('proj/t-old-blocked')?.worktreePath).toBe(blockedWorktree);
  });

  it('prunes cancelled tasks and keeps dirty worktrees', () => {
    const cancelledWorktree = path.join(tmpDir, 'worktrees', 'proj', 't-cancelled');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', cancelledWorktree, '-b', 'agenthub/t-cancelled', 'main']);
    const dirtyWorktree = path.join(tmpDir, 'worktrees', 'proj', 't-dirty');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', dirtyWorktree, '-b', 'agenthub/t-dirty', 'main']);
    fs.writeFileSync(path.join(dirtyWorktree, 'uncommitted.txt'), 'keep me');
    ctx.taskRepo.insert({ id: 'proj/t-cancelled', projectId: 'proj', slug: 't-cancelled', title: 'Cancelled', status: 'cancelled' });
    ctx.taskRepo.update('proj/t-cancelled', { worktreePath: cancelledWorktree });
    ctx.taskRepo.insert({ id: 'proj/t-dirty', projectId: 'proj', slug: 't-dirty', title: 'Dirty', status: 'done' });
    ctx.taskRepo.update('proj/t-dirty', { worktreePath: dirtyWorktree });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    ctx.db.prepare("UPDATE tasks SET updatedAt = ? WHERE id IN ('proj/t-cancelled', 'proj/t-dirty')").run(oldTime);

    ctx.scheduler.tick();

    expect(fs.existsSync(cancelledWorktree)).toBe(false);
    expect(ctx.taskRepo.get('proj/t-cancelled')?.worktreePath).toBeNull();
    expect(fs.existsSync(dirtyWorktree)).toBe(true);
    expect(ctx.taskRepo.get('proj/t-dirty')?.worktreePath).toBe(dirtyWorktree);
  });

  it('backs off re-checking a dirty worktree instead of running git status every tick', () => {
    const dirtyWorktree = path.join(tmpDir, 'worktrees', 'proj', 't-dirty-backoff');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', dirtyWorktree, '-b', 'agenthub/t-dirty-backoff', 'main']);
    fs.writeFileSync(path.join(dirtyWorktree, 'uncommitted.txt'), 'keep me');
    ctx.taskRepo.insert({ id: 'proj/t-dirty-backoff', projectId: 'proj', slug: 't-dirty-backoff', title: 'Dirty', status: 'cancelled' });
    ctx.taskRepo.update('proj/t-dirty-backoff', { worktreePath: dirtyWorktree });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    ctx.db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = 'proj/t-dirty-backoff'").run(oldTime);

    ctx.scheduler.tick();
    expect(fs.existsSync(dirtyWorktree)).toBe(true);

    // Now clean: the next tick must not re-check yet (backed off), so the worktree stays.
    fs.rmSync(path.join(dirtyWorktree, 'uncommitted.txt'));
    ctx.scheduler.tick();
    expect(fs.existsSync(dirtyWorktree)).toBe(true);

    // After the back-off window the clean worktree is pruned.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    ctx.scheduler.tick();
    expect(fs.existsSync(dirtyWorktree)).toBe(false);
    expect(ctx.taskRepo.get('proj/t-dirty-backoff')?.worktreePath).toBeNull();
  });

  it('keeps the DB path and backs off when worktree removal fails', () => {
    const worktreePath = path.join(tmpDir, 'worktrees', 'proj', 't-failing-remove');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', 'agenthub/t-failing-remove', 'main']);
    ctx.taskRepo.insert({ id: 'proj/t-failing-remove', projectId: 'proj', slug: 't-failing-remove', title: 'Failing remove', status: 'done' });
    ctx.taskRepo.update('proj/t-failing-remove', { worktreePath });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    ctx.db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = 'proj/t-failing-remove'").run(oldTime);
    const remove = vi.spyOn(WorktreeService.prototype, 'remove').mockReturnValue(false);

    ctx.scheduler.tick();
    ctx.scheduler.tick();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(ctx.taskRepo.get('proj/t-failing-remove')?.worktreePath).toBe(worktreePath);
  });

  it('cleans expired worktrees before parking queued work when disk is low', () => {
    config.disk.minFreeGB = Number.MAX_SAFE_INTEGER;
    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });
    const worktreePath = path.join(tmpDir, 'worktrees', 'proj', 't-low-disk-cleanup');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', 'agenthub/t-low-disk-cleanup', 'main']);
    ctx.taskRepo.insert({
      id: 'proj/t-low-disk-cleanup',
      projectId: 'proj',
      slug: 't-low-disk-cleanup',
      title: 'Low disk cleanup',
      status: 'done',
    });
    ctx.taskRepo.update('proj/t-low-disk-cleanup', { worktreePath });
    ctx.taskRepo.insert({ id: 'proj/queued', projectId: 'proj', slug: 'queued', title: 'Queued', status: 'queued', level: 'easy' });
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    ctx.db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = 'proj/t-low-disk-cleanup'").run(oldTime);

    ctx.scheduler.tick();

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(ctx.taskRepo.get('proj/t-low-disk-cleanup')?.worktreePath).toBeNull();
    expect(ctx.taskRepo.get('proj/queued')?.status).toBe('waiting_quota');
    expect(ctx.taskRepo.get('proj/queued')?.waitReason).toBe('disk');
  });

  it('removes an orphan git worktree while preserving its branch and ignores outside paths', () => {
    const orphanWorktree = path.join(tmpDir, 'worktrees', 'proj', 'orphan');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', orphanWorktree, '-b', 'agenthub/orphan', 'main']);
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    ctx.taskRepo.insert({ id: 'proj/outside', projectId: 'proj', slug: 'outside', title: 'Outside', status: 'done' });
    ctx.taskRepo.update('proj/outside', { worktreePath: outside });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
    ctx.db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = 'proj/outside'").run(oldTime);

    ctx.scheduler.start();
    ctx.scheduler.stop();

    expect(fs.existsSync(orphanWorktree)).toBe(false);
    expect(execFileSync('git', ['-C', projectPath, 'branch', '--list', 'agenthub/orphan'], { encoding: 'utf8' })).toContain('agenthub/orphan');
    expect(fs.existsSync(outside)).toBe(true);
  });
});
