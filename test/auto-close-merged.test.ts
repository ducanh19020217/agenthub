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

  it('closes a blocked task when its branch was merged into target branch', () => {
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

    const closed = ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(1);

    const updated = ctx.taskRepo.get('proj/task-merged');
    expect(updated?.status).toBe('done');

    const autoClosedEvent = ctx.eventRepo.getByTask('proj/task-merged').find((e) => e.type === 'task.auto_closed');
    expect(autoClosedEvent).toBeDefined();
    expect(autoClosedEvent?.payload).toContain('merged_elsewhere');

    const doneEvent = ctx.eventRepo.getByTask('proj/task-merged').find((e) => e.type === 'task.done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.payload).toContain('merged_elsewhere');
  });

  it('keeps task as is when its branch has not been merged', () => {
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

    const closed = ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(0);

    const task = ctx.taskRepo.get('proj/task-unmerged');
    expect(task?.status).toBe('blocked');
  });

  it('keeps task as is when branch has no commits compared to base', () => {
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

    const closed = ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(0);

    const task = ctx.taskRepo.get('proj/task-no-commits');
    expect(task?.status).toBe('blocked');
  });

  it('keeps task as is when task is running or queued even if branch is merged', () => {
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

    const closed = ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(0);

    expect(ctx.taskRepo.get('proj/task-running')?.status).toBe('running');
    expect(ctx.taskRepo.get('proj/task-queued')?.status).toBe('queued');
  });

  it('closes tasks in review and failed when merged into target branch', () => {
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

    ctx.taskRepo.insert({
      id: 'proj/task-failed',
      projectId: 'proj',
      slug: 'task-failed',
      title: 'Task Failed',
      status: 'failed',
      branch: 'agenthub/task-failed',
      baseRef: 'main',
    });

    const closed = ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(2);

    expect(ctx.taskRepo.get('proj/task-review')?.status).toBe('done');
    expect(ctx.taskRepo.get('proj/task-failed')?.status).toBe('done');
  });

  it('supports integration branch when integration is enabled', () => {
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

    const closed = ctx.scheduler.autoCloseMergedTasks();
    expect(closed).toBe(1);

    expect(ctx.taskRepo.get('proj/task-integ')?.status).toBe('done');
  });
});
