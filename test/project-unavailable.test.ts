import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { openDatabase, ProjectRepo, ProfileRepo, QuotaMarkRepo, TaskRepo, RunRepo, EventRepo } from '../src/db/index.js';
import { Scheduler, isProjectAccessible } from '../src/scheduler/index.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

describe('Project availability and unmounted drive handling', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let db: ReturnType<typeof openDatabase>;
  let projectRepo: ProjectRepo;
  let profileRepo: ProfileRepo;
  let quotaMarkRepo: QuotaMarkRepo;
  let taskRepo: TaskRepo;
  let runRepo: RunRepo;
  let eventRepo: EventRepo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-proj-unavail-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.disk.minFreeGB = 0;

    db = openDatabase(config.dbPath);
    projectRepo = new ProjectRepo(db);
    profileRepo = new ProfileRepo(db);
    quotaMarkRepo = new QuotaMarkRepo(db);
    taskRepo = new TaskRepo(db);
    runRepo = new RunRepo(db);
    eventRepo = new EventRepo(db);

    profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(agyHomesDir, 'p1'),
      email: 'test@example.com',
      enabled: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  it('isProjectAccessible checks path existence and git repository', () => {
    const unmountedPath = path.join(tmpDir, 'unmounted-drive', 'repo');
    expect(isProjectAccessible(unmountedPath)).toBe(false);

    const nonGitDir = path.join(tmpDir, 'regular-dir');
    fs.mkdirSync(nonGitDir);
    expect(isProjectAccessible(nonGitDir)).toBe(false);

    const gitDir = path.join(tmpDir, 'git-repo');
    fs.mkdirSync(gitDir);
    execFileSync('git', ['init', '--template='], { cwd: gitDir });
    expect(isProjectAccessible(gitDir)).toBe(true);
  });

  it('dự án mất đường dẫn → waiting_quota/project_unavailable, khôi phục đường dẫn → task chạy', async () => {
    const unmountedPath = path.join(tmpDir, 'external-drive', 'my-repo');

    projectRepo.insert({
      id: 'proj-unavail',
      name: 'Unmounted Project',
      path: unmountedPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
    });

    taskRepo.insert({
      id: 'proj-unavail/task-1',
      projectId: 'proj-unavail',
      slug: 'task-1',
      title: 'Task 1',
      status: 'queued',
    });

    const emittedEvents: Array<{ type: string; taskId?: string; payload?: unknown }> = [];
    const fakeEngine = new FakeEngine();
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    // Daemon starts with unmounted path without errors
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);
    scheduler.getEventBus().on('*', (type, taskId, payload) => {
      emittedEvents.push({ type, taskId, payload });
    });

    // 1. First tick: project is inaccessible
    await scheduler.tick();

    const waitingTask = taskRepo.get('proj-unavail/task-1')!;
    expect(waitingTask.status).toBe('waiting_quota');
    expect(waitingTask.waitReason).toBe('project_unavailable');

    // project.unavailable event emitted exactly once
    const unavailEvents = emittedEvents.filter((e) => e.type === 'project.unavailable');
    expect(unavailEvents.length).toBe(1);
    expect(unavailEvents[0].payload.projectId).toBe('proj-unavail');

    // Another tick while still unavailable should not re-emit project.unavailable
    await scheduler.tick();
    expect(emittedEvents.filter((e) => e.type === 'project.unavailable').length).toBe(1);

    // 2. Restore project path (drive mounted)
    fs.mkdirSync(unmountedPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: unmountedPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: unmountedPath });
    fs.writeFileSync(path.join(unmountedPath, 'README.md'), '# Repo');
    execFileSync('git', ['add', '.'], { cwd: unmountedPath });
    execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
      cwd: unmountedPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    // 3. Next tick: project is restored
    await scheduler.tick();

    // project.available event emitted
    const availEvents = emittedEvents.filter((e) => e.type === 'project.available');
    expect(availEvents.length).toBe(1);
    expect(availEvents[0].payload.projectId).toBe('proj-unavail');

    // Wait a short moment for startTask async promise in tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Task is picked up and runs
    const runningTask = taskRepo.get('proj-unavail/task-1')!;
    expect(['running', 'queued']).toContain(runningTask.status);
    expect(runningTask.waitReason).toBeNull();

    scheduler.stop();
  });

  it('task đã có worktree mà worktree mất cũng chuyển waiting_quota/project_unavailable và khôi phục khi worktree trở lại', async () => {
    const repoPath = path.join(tmpDir, 'valid-repo');
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: repoPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Valid Repo');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    projectRepo.insert({
      id: 'proj-wt',
      name: 'Project WT',
      path: repoPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
    });

    // Task points to a worktree on an unmounted path that does not exist
    const missingWorktreePath = path.join(tmpDir, 'missing-drive', 'worktrees', 'proj-wt', 'task-wt');

    taskRepo.insert({
      id: 'proj-wt/task-wt',
      projectId: 'proj-wt',
      slug: 'task-wt',
      title: 'Task WT',
      status: 'queued',
      worktreePath: missingWorktreePath,
    });

    const fakeEngine = new FakeEngine();
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);

    // 1. Tick: worktreePath does not exist
    await scheduler.tick();

    const waitingTask = taskRepo.get('proj-wt/task-wt')!;
    expect(waitingTask.status).toBe('waiting_quota');
    expect(waitingTask.waitReason).toBe('project_unavailable');

    // 2. Re-create the worktree directory (e.g. drive re-mounted)
    fs.mkdirSync(missingWorktreePath, { recursive: true });

    // 3. Next tick: worktree is back
    await scheduler.tick();

    const queuedTask = taskRepo.get('proj-wt/task-wt')!;
    expect(queuedTask.status).not.toBe('waiting_quota');

    scheduler.stop();
  });
});
