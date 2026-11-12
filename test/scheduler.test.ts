import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { openDatabase, ProjectRepo, DepartmentRepo, ProfileRepo, QuotaMarkRepo, TaskRepo, RunRepo, EventRepo, ReviewRepo } from '../src/db/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { QuotaService } from '../src/quota/index.js';
import { ClaudeFailoverState } from '../src/chat/failover.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let db: ReturnType<typeof openDatabase>;
let projectRepo: ProjectRepo;
let profileRepo: ProfileRepo;
let quotaMarkRepo: QuotaMarkRepo;
let taskRepo: TaskRepo;
let runRepo: RunRepo;
let eventRepo: EventRepo;

function setupTestEnv() {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-sched-test-')));
  const agyHomesDir = path.join(tmpDir, 'agy-homes');
  fs.mkdirSync(agyHomesDir, { recursive: true });

  process.env.AGENTHUB_HOME = tmpDir;
  process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
  process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
  process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');

  config = loadConfig(tmpDir);
  config.agyHomesDir = agyHomesDir;
  config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;

  db = openDatabase(config.dbPath);
  projectRepo = new ProjectRepo(db);
  profileRepo = new ProfileRepo(db);
  quotaMarkRepo = new QuotaMarkRepo(db);
  taskRepo = new TaskRepo(db);
  runRepo = new RunRepo(db);
  eventRepo = new EventRepo(db);
}

function teardownTestEnv() {
  db.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  delete process.env.AGENTHUB_HOME;
  delete process.env.AGENTHUB_AGY_HOMES;
  delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
  delete process.env.AGENTHUB_AGY_BIN;
}

function createTestProject(projectPath: string) {
  // Create a git repo for the project
  fs.mkdirSync(projectPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: projectPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
  fs.writeFileSync(path.join(projectPath, 'README.md'), '# Test');
  execFileSync('git', ['add', '.'], { cwd: projectPath });
  execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], { cwd: projectPath, env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' } });

  projectRepo.insert({
    id: 'test-project',
    name: 'Test Project',
    path: projectPath,
    defaultBranch: 'main',
    envTemplate: null,
    maxParallel: 3,
  });
}

describe('Quota mark propagation to same-email profiles', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('marks quota for profiles with same email', async () => {
    // Create profiles with same email
    profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/p1',
      email: 'test@example.com',
      enabled: 1,
    });
    profileRepo.upsert({
      name: 'p2',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/p2',
      email: 'test@example.com',
      enabled: 1,
    });
    profileRepo.upsert({
      name: 'p3',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/p3',
      email: 'other@example.com',
      enabled: 1,
    });

    const quotaService = new QuotaService(quotaMarkRepo, profileRepo);
    quotaService.mark('p1', 'claude', 3600, 'test');

    // p2 should also be marked (same email as p1)
    expect(quotaService.isExhausted('p1', 'claude')).toBe(true);
    expect(quotaService.isExhausted('p2', 'claude')).toBe(true);
    // p3 should not be marked (different email)
    expect(quotaService.isExhausted('p3', 'claude')).toBe(false);
  });
});

describe('Claude profiles are never worker scheduler profiles', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('does not select an engine=claude profile for the default worker chain', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'claude-may', engine: 'claude', kind: 'system', home: os.homedir(), email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]));
    await scheduler.tick();

    expect(runRepo.getByTask('test-project/t1')).toHaveLength(0);
    expect(taskRepo.get('test-project/t1')?.status).toBe('waiting_quota');
    scheduler.stop();
  });
});

describe('Task dependencies', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('task with dependency only runs when dependency is done', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/p1',
      email: 'test@example.com',
      enabled: 1,
    });

    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
    });
    taskRepo.insert({
      id: 'test-project/t2',
      projectId: 'test-project',
      slug: 't2',
      title: 'Task 2',
      dependsOn: ['test-project/t1'],
      status: 'queued',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    // One tick
    await scheduler.tick();

    // t1 should be running, t2 should still be queued
    const t1 = taskRepo.get('test-project/t1')!;
    const t2 = taskRepo.get('test-project/t2')!;
    expect(t1.status).toBe('running');
    expect(t2.status).toBe('queued');

    scheduler.stop();
  });

  it('dependent task starts after dependency is done', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/p1',
      email: null,
      enabled: 1,
    });
    profileRepo.upsert({
      name: 'p2',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/p2',
      email: null,
      enabled: 1,
    });

    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      status: 'done',
    });
    taskRepo.insert({
      id: 'test-project/t2',
      projectId: 'test-project',
      slug: 't2',
      title: 'Task 2',
      dependsOn: ['test-project/t1'],
      status: 'queued',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    const t2 = taskRepo.get('test-project/t2')!;
    // t1 is done, so t2 should be running
    expect(t2.status).toBe('running');

    scheduler.stop();
  });
});

describe('maxParallel limit', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('respects maxParallel=2 with 3 tasks', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    // Override maxParallel to 2
    db.prepare('UPDATE projects SET maxParallel = 2 WHERE id = ?').run('test-project');

    // Create 3 profiles so we have enough
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'p3', engine: 'agy', kind: 'isolated', home: '/tmp/p3', email: null, enabled: 1 });

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });
    taskRepo.insert({ id: 'test-project/t2', projectId: 'test-project', slug: 't2', title: 'Task 2', status: 'queued' });
    taskRepo.insert({ id: 'test-project/t3', projectId: 'test-project', slug: 't3', title: 'Task 3', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    // Count running tasks
    const tasks = taskRepo.getAll();
    const runningCount = tasks.filter(t => t.status === 'running').length;
    const waitingParallelCount = tasks.filter(t => t.status === 'queued' && t.waitReason === 'parallel').length;

    expect(runningCount).toBe(2);
    expect(waitingParallelCount).toBe(1);

    scheduler.stop();
  });

  it('counts recovered live runs against the project limit', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'p3', engine: 'agy', kind: 'isolated', home: '/tmp/p3', email: null, enabled: 1 });

    const workers = ['r1', 'r2', 'r3'].map((runId, index) => {
      const taskId = `test-project/running-${index}`;
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      taskRepo.insert({ id: taskId, projectId: 'test-project', slug: `running-${index}`, title: taskId, status: 'running' });
      runRepo.insert({ id: runId, taskId, engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: `p${index + 1}`, pid: child.pid });
      return child;
    });
    taskRepo.insert({ id: 'test-project/queued-1', projectId: 'test-project', slug: 'queued-1', title: 'Queued 1', status: 'queued' });
    taskRepo.insert({ id: 'test-project/queued-2', projectId: 'test-project', slug: 'queued-2', title: 'Queued 2', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]),
    );
    try {
      scheduler.start();
      await scheduler.tick();
      expect(scheduler.getRunning().size).toBe(3);
      expect(taskRepo.get('test-project/queued-1')?.status).toBe('queued');
      expect(taskRepo.get('test-project/queued-1')?.waitReason).toBe('parallel');
      expect(taskRepo.get('test-project/queued-2')?.status).toBe('queued');
      expect(taskRepo.get('test-project/queued-2')?.waitReason).toBe('parallel');
    } finally {
      scheduler.stop();
      for (const child of workers) child.kill();
    }
  });

  it('enforces the department limit across projects', async () => {
    const firstProjectPath = path.join(tmpDir, 'repo-first');
    createTestProject(firstProjectPath);
    const secondProjectPath = path.join(tmpDir, 'repo-second');
    fs.mkdirSync(secondProjectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: secondProjectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: secondProjectPath });
    fs.writeFileSync(path.join(secondProjectPath, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: secondProjectPath });
    execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
      cwd: secondProjectPath,
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
    });
    projectRepo.insert({ id: 'second-project', name: 'Second Project', path: secondProjectPath, defaultBranch: 'main', maxParallel: 3 });

    const departmentRepo = new DepartmentRepo(db);
    departmentRepo.insert({ id: 'eng', name: 'Engineering', priority: 10, maxParallel: 1, claudeDailyTokenBudget: 0, telegramTopicId: null });
    projectRepo.update('test-project', { departmentId: 'eng' });
    projectRepo.update('second-project', { departmentId: 'eng' });
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/low', projectId: 'test-project', slug: 'low', title: 'Low', status: 'queued' });
    taskRepo.insert({ id: 'second-project/high', projectId: 'second-project', slug: 'high', title: 'High', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, undefined, undefined, undefined, undefined, departmentRepo,
    );
    await scheduler.tick();

    expect(taskRepo.get('test-project/low')?.status).toBe('running');
    expect(taskRepo.get('second-project/high')?.status).toBe('queued');
    expect(taskRepo.get('second-project/high')?.waitReason).toBe('department_parallel');
    expect(scheduler.getRunning().size).toBe(1);
    scheduler.stop();
  });

  it('shares a busy machine between departments by weighted fair share', async () => {
    createTestProject(path.join(tmpDir, 'repo'));
    const secondProjectPath = path.join(tmpDir, 'repo-fair-second');
    fs.mkdirSync(secondProjectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: secondProjectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: secondProjectPath });
    fs.writeFileSync(path.join(secondProjectPath, 'README.md'), '# Fair share');
    execFileSync('git', ['add', '.'], { cwd: secondProjectPath });
    execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
      cwd: secondProjectPath,
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
    });
    const departmentRepo = new DepartmentRepo(db);
    departmentRepo.insert({ id: 'priority', name: 'Priority', priority: 4, maxParallel: 6, claudeDailyTokenBudget: 0, telegramTopicId: null });
    departmentRepo.insert({ id: 'normal', name: 'Normal', priority: 1, maxParallel: 6, claudeDailyTokenBudget: 0, telegramTopicId: null });
    projectRepo.update('test-project', { maxParallel: 6, departmentId: 'priority' });
    projectRepo.insert({ id: 'fair-second', name: 'Fair Second', path: secondProjectPath, defaultBranch: 'main', envTemplate: null, maxParallel: 6, departmentId: 'normal' });
    for (const name of ['p1', 'p2', 'p3']) {
      profileRepo.upsert({ name, engine: 'agy', kind: 'isolated', home: `/tmp/${name}`, email: null, enabled: 1 });
    }
    for (let i = 1; i <= 8; i++) {
      taskRepo.insert({ id: `test-project/priority-${i}`, projectId: 'test-project', slug: `priority-${i}`, title: 'Priority', status: 'queued' });
      taskRepo.insert({ id: `fair-second/normal-${i}`, projectId: 'fair-second', slug: `normal-${i}`, title: 'Normal', status: 'queued' });
    }

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, undefined, undefined, undefined, undefined, departmentRepo,
    );
    await scheduler.tick();

    const running = taskRepo.getAll().filter((task) => task.status === 'running');
    const priorityCount = running.filter((task) => task.projectId === 'test-project').length;
    const normalCount = running.filter((task) => task.projectId === 'fair-second').length;
    expect(priorityCount).toBeGreaterThan(normalCount);
    expect(normalCount).toBeGreaterThan(0);
    expect(running.length).toBe(6);
    scheduler.stop();
  });
});

describe('Profile uses both agy slots', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('single profile runs 2 of 3 tasks at a time', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    // Only one profile
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });
    taskRepo.insert({ id: 'test-project/t2', projectId: 'test-project', slug: 't2', title: 'Task 2', status: 'queued' });
    taskRepo.insert({ id: 'test-project/t3', projectId: 'test-project', slug: 't3', title: 'Task 3', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    const tasks = taskRepo.getAll();
    const runningCount = tasks.filter(t => t.status === 'running').length;
    expect(runningCount).toBe(2);

    scheduler.stop();
  });
});

describe('Scheduler regression fixes', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  function makeScheduler() {
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    return new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]));
  }

  it('does not repeat load.high while overloaded metrics stay flat', async () => {
    config.load.enabled = true;
    const scheduler = makeScheduler();
    const loadEvents: unknown[] = [];
    scheduler.getEventBus().on('load.high', (_taskId, payload) => loadEvents.push(payload));
    let snapshot = {
      load1: 10,
      freeMemGB: 6,
      overloaded: true,
      recoveringSince: null,
      highSince: 0,
      autoPauseTriggered: false,
    };
    const loadGuard = (scheduler as unknown as { loadGuard: { setConfig: (value: typeof config.load) => void; update: () => typeof snapshot; isAutoPauseTriggered: () => boolean; isOverloaded: () => boolean } }).loadGuard;
    loadGuard.setConfig = () => {};
    loadGuard.update = () => snapshot;
    loadGuard.isAutoPauseTriggered = () => false;
    loadGuard.isOverloaded = () => true;
    vi.spyOn(Date, 'now').mockReturnValue(0);

    await scheduler.tick();
    vi.mocked(Date.now).mockReturnValue(30 * 60 * 1000);
    await scheduler.tick();
    vi.mocked(Date.now).mockReturnValue(60 * 60 * 1000);
    await scheduler.tick();
    expect(loadEvents).toHaveLength(1);

    snapshot = { ...snapshot, load1: 13 };
    await scheduler.tick();
    expect(loadEvents).toHaveLength(2);
    scheduler.stop();
    vi.restoreAllMocks();
  });

  it('does not treat a zero load baseline as worsening when it stays zero', async () => {
    config.load.enabled = true;
    const scheduler = makeScheduler();
    const loadEvents: unknown[] = [];
    scheduler.getEventBus().on('load.high', (_taskId, payload) => loadEvents.push(payload));
    const snapshot = {
      load1: 0,
      freeMemGB: 6,
      overloaded: true,
      recoveringSince: null,
      highSince: 0,
      autoPauseTriggered: false,
    };
    const loadGuard = (scheduler as unknown as { loadGuard: { setConfig: (value: typeof config.load) => void; update: () => typeof snapshot; isAutoPauseTriggered: () => boolean; isOverloaded: () => boolean } }).loadGuard;
    loadGuard.setConfig = () => {};
    loadGuard.update = () => snapshot;
    loadGuard.isAutoPauseTriggered = () => false;
    loadGuard.isOverloaded = () => true;
    vi.spyOn(Date, 'now').mockReturnValue(0);

    await scheduler.tick();
    vi.mocked(Date.now).mockReturnValue(60 * 60 * 1000);
    await scheduler.tick();

    expect(loadEvents).toHaveLength(1);
    scheduler.stop();
    vi.restoreAllMocks();
  });

  it('uses the second profile slot before waiting for completion', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/a', projectId: 'test-project', slug: 'a', title: 'A', status: 'queued' });
    taskRepo.insert({ id: 'test-project/b', projectId: 'test-project', slug: 'b', title: 'B', status: 'queued' });
    process.env.FAKE_MODE = 'done';
    const scheduler = makeScheduler();
    await scheduler.tick();
    expect(taskRepo.get('test-project/b')!.status).toBe('running');
    scheduler.cancelAll();
    delete process.env.FAKE_MODE;
  });

  it('keeps the event loop responsive while startTask awaits slow git', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/slow-start', projectId: 'test-project', slug: 'slow-start', title: 'Slow start', status: 'queued' });
    process.env.FAKE_MODE = 'slow';
    const fakeBin = path.join(tmpDir, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nsleep 2\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath || ''}`;
    const scheduler = makeScheduler();
    try {
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 100);
      await scheduler.tick();
      clearInterval(timer);
      expect(ticks).toBeGreaterThanOrEqual(10);
      expect(taskRepo.get('test-project/slow-start')?.status).toBe('running');
    } finally {
      scheduler.cancelAll();
      scheduler.stop();
      process.env.PATH = originalPath;
      delete process.env.FAKE_MODE;
    }
  });

  it('stop leaves detached workers running and cancelAll cancels them explicitly', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/a', projectId: 'test-project', slug: 'a', title: 'A', status: 'queued' });
    process.env.FAKE_MODE = 'slow';
    const scheduler = makeScheduler();
    await scheduler.tick();
    await vi.waitFor(() => expect(taskRepo.get('test-project/a')!.status).toBe('running'));
    scheduler.stop();
    expect(taskRepo.get('test-project/a')!.status).toBe('running');
    expect(runRepo.getByTask('test-project/a')[0].outcome).toBeNull();
    scheduler.cancelAll();
    delete process.env.FAKE_MODE;
  });

  it('re-runs checks for a task left checking by a restart', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    taskRepo.insert({ id: 'test-project/chk', projectId: 'test-project', slug: 'chk', title: 'Chk', status: 'checking' });
    db.prepare("INSERT INTO runs (id, taskId, engine, model, profileName, kind, outcome, endedAt) VALUES ('w-chk', 'test-project/chk', 'agy', 'gemini-3.8-flash-high', 'p', 'worker', 'done', datetime('now'))").run();
    const scheduler = makeScheduler();
    const seen: string[] = [];
    (scheduler as unknown as { runChecksForTask: (id: string, run: string) => Promise<void> }).runChecksForTask = async (id, run) => { seen.push(`${id}:${run}`); };
    scheduler.start();
    expect(seen).toEqual(['test-project/chk:w-chk']);
    scheduler.stop();
  });

  it('requeues a task left running without any run after a restart', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    taskRepo.insert({ id: 'test-project/orphan', projectId: 'test-project', slug: 'orphan', title: 'Orphan', status: 'running' });
    const scheduler = makeScheduler();
    scheduler.start();
    expect(taskRepo.get('test-project/orphan')?.status).not.toBe('running');
    scheduler.stop();
  });

  it('recovers a live worker into the running map', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/a', projectId: 'test-project', slug: 'a', title: 'A', status: 'queued' });
    process.env.FAKE_MODE = 'slow';
    config.defaultTimeout = 24 * 60 * 60;
    const first = makeScheduler();
    await first.tick();
    await vi.waitFor(() => {
      expect(first.getRunning().has('test-project/a')).toBe(true);
    });
    const second = makeScheduler();
    second.start();
    expect(second.getRunning().has('test-project/a')).toBe(true);
    second.cancelAll();
    second.stop();
    first.stop();
    delete process.env.FAKE_MODE;
  });

  it('does not kill a recovered run immediately when its old timeout has elapsed', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/a', projectId: 'test-project', slug: 'a', title: 'A', status: 'running' });
    runRepo.insert({ id: 'run-old', taskId: 'test-project/a', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: process.pid });
    db.prepare("UPDATE runs SET startedAt = datetime('now', '-1 minute') WHERE id = 'run-old'").run();
    config.defaultTimeout = 1;

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]),
    );
    scheduler.start();
    expect(scheduler.getRunning().has('test-project/a')).toBe(true);
    expect(runRepo.get('run-old')?.outcome).toBeNull();
    scheduler.stop();
  });

  it('persists transient retry backoff in the task instead of using a delayed callback', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/a', projectId: 'test-project', slug: 'a', title: 'A', status: 'queued' });
    process.env.FAKE_MODE = 'transient';
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]),
    );
    await scheduler.tick();
    await vi.waitFor(() => {
      const task = taskRepo.get('test-project/a')!;
      expect(task.status).toBe('queued');
      expect(task.transientRetries).toBe(1);
      expect(task.notBefore).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(scheduler.getRunning().has('test-project/a')).toBe(false);
    }, { timeout: 5000 });
    scheduler.stop();
    delete process.env.FAKE_MODE;
  });

  it('keeps slots stable when an earlier task is cancelled', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    db.prepare('UPDATE projects SET maxParallel = 2, envTemplate = ? WHERE id = ?').run(
      JSON.stringify({ file: '.env', vars: { PORT: '4{slot}0' } }), 'test-project');
    for (const name of ['p1', 'p2', 'p3']) {
      profileRepo.upsert({ name, engine: 'agy', kind: 'isolated', home: `/tmp/${name}`, email: null, enabled: 1 });
    }
    for (const slug of ['a', 'b', 'c']) {
      taskRepo.insert({ id: `test-project/${slug}`, projectId: 'test-project', slug, title: slug, status: 'queued' });
    }
    process.env.FAKE_MODE = 'slow';
    const scheduler = makeScheduler();
    await scheduler.tick();
    expect(taskRepo.get('test-project/a')!.slot).toBe(1);
    expect(taskRepo.get('test-project/b')!.slot).toBe(2);
    scheduler.cancelTask('test-project/a');
    await scheduler.triggerTick();
    expect(taskRepo.get('test-project/c')!.slot).toBe(1);
    expect(fs.readFileSync(path.join(taskRepo.get('test-project/b')!.worktreePath!, '.env'), 'utf8')).toContain('PORT=420');
    scheduler.cancelAll();
    delete process.env.FAKE_MODE;
  });

  it('rejects an empty review feedback', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    taskRepo.insert({ id: 'test-project/a', projectId: 'test-project', slug: 'a', title: 'A', status: 'review' });
    const scheduler = makeScheduler();
    expect(() => scheduler.reviewTask('test-project/a', 'changes_requested', '  ')).toThrow('Feedback is required');
  });
});

describe('Codex reviewer failover lifecycle', () => {
  beforeEach(setupTestEnv);
  afterEach(() => {
    delete process.env.FAKE_MODE;
    teardownTestEnv();
  });

  function makeReviewer(mode: string, withChecks = true) {
    const projectPath = path.join(tmpDir, 'review-repo');
    if (!projectRepo.get('test-project') || !fs.existsSync(projectPath)) createTestProject(projectPath);
    profileRepo.upsert({ name: 'codex-1', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    const worktreePath = path.join(tmpDir, 'review-worktree');
    fs.rmSync(worktreePath, { recursive: true, force: true });
    try {
      execFileSync('git', ['-C', projectPath, 'worktree', 'prune']);
      execFileSync('git', ['-C', projectPath, 'worktree', 'add', '-q', '-b', `review-${Date.now()}-${Math.random().toString(36).slice(2)}`, worktreePath, 'main']);
    } catch {
      fs.cpSync(projectPath, worktreePath, { recursive: true });
    }
    taskRepo.insert({ id: 'test-project/review', projectId: 'test-project', slug: 'review', title: 'Review me', body: 'Check the change.', status: 'review' });
    taskRepo.update('test-project/review', { worktreePath });
    process.env.FAKE_MODE = mode;
    config.reviewer.enabled = true;
    const fake = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    (fake as unknown as { id: string }).id = 'codex';
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['codex', fake]]), undefined, undefined, db);
    if (withChecks) {
      db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)')
        .run('autocheck-run', 'test-project/review', 'agy', 'gemini-3.8-flash-low', 'codex-1');
      db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('test-project/review', 'autocheck-run', 'test', 1, 0, 10, 'OK');
    }
    const reviewRepo = new ReviewRepo(db);
    const failover = new ClaudeFailoverState(path.join(tmpDir, 'failover.json'));
    failover.activate(3600);
    scheduler.configureReviewer(reviewRepo, failover);
    return { scheduler, reviewRepo, failover };
  }

  it('selects a review task once and accepts chatter around output-last-message JSON', async () => {
    const { scheduler, reviewRepo } = makeReviewer('reviewer-chatter');
    await scheduler.tick();
    expect(scheduler.getReviewerStatus().running).toEqual(['test-project/review']);
    await vi.waitFor(() => {
      expect(taskRepo.get('test-project/review')?.status).toBe('done');
    });
    expect(reviewRepo.getByTask('test-project/review')[0]?.actor).toBe('codex-reviewer');
    expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.kind).toBe('reviewer');
    scheduler.stop();
  });

  it('routes changes_requested back to queued with feedback', async () => {
    const { scheduler, reviewRepo } = makeReviewer('reviewer-changes');
    await scheduler.tick();
    await vi.waitFor(() => {
      expect(reviewRepo.getByTask('test-project/review')[0]?.verdict).toBe('changes_requested');
    });
    expect(['queued', 'running']).toContain(taskRepo.get('test-project/review')?.status);
    expect(taskRepo.get('test-project/review')?.resume).toBe(1);
    scheduler.cancelAll();
    scheduler.stop();
  });

  it('does not approve quota or malformed reviewer output', async () => {
    const { scheduler } = makeReviewer('reviewer-malformed');
    await scheduler.tick();
    await vi.waitFor(() => {
      expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.outcome).toBe('crashed');
    });
    expect(taskRepo.get('test-project/review')?.status).toBe('review');
    scheduler.stop();
  });

  it('does not parse reviewer verdict from log when output file is missing', async () => {
    const { scheduler } = makeReviewer('reviewer-missing-output');
    await scheduler.tick();
    await vi.waitFor(() => {
      expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.outcome).toBe('crashed');
    });
    expect(taskRepo.get('test-project/review')?.status).toBe('review');
    scheduler.stop();
  });

  it('cleans up a reviewer when the child emits an asynchronous spawn error', async () => {
    const { scheduler } = makeReviewer('reviewer-error');
    await scheduler.tick();
    await vi.waitFor(() => {
      expect(scheduler.getReviewerStatus().running).toEqual([]);
      expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.outcome).toBe('crashed');
    });
    expect(taskRepo.get('test-project/review')?.status).toBe('review');
    scheduler.stop();
  });

  it('marks Codex quota and leaves the task in review', async () => {
    const { scheduler } = makeReviewer('reviewer-quota');
    await scheduler.tick();
    await vi.waitFor(() => {
      expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.outcome).toBe('quota');
    });
    expect(taskRepo.get('test-project/review')?.status).toBe('review');
    expect(new QuotaService(quotaMarkRepo, profileRepo).isExhausted('codex-1', 'codex')).toBe(true);
    scheduler.stop();
  });

  it('escalates read-only reviewer feedback once without requeueing', async () => {
    const { scheduler } = makeReviewer('reviewer-erofs');
    await scheduler.tick();
    await vi.waitFor(() => {
      expect(taskRepo.get('test-project/review')?.reviewerEscalated).toBe(1);
    });
    await scheduler.tick();
    await scheduler.tick();
    const task = taskRepo.get('test-project/review')!;
    expect(task.status).toBe('review');
    expect(task.reviewerEscalated).toBe(1);
    expect(task.reviewerEscalationReason).toBe('reviewer_environment');
    expect(runRepo.getByTask(task.id).filter((run) => run.kind === 'reviewer')).toHaveLength(1);
    expect(eventRepo.getRecent(20).filter((event) => event.type === 'review.escalated')).toHaveLength(1);
    scheduler.stop();
  });

  it('ignores environment wording in the reviewer log and processes the final quality verdict', async () => {
    const { scheduler } = makeReviewer('reviewer-erofs-log');
    await scheduler.tick();
    await vi.waitFor(() => {
      expect(taskRepo.get('test-project/review')?.body).toContain('race condition');
    });
    expect(taskRepo.get('test-project/review')?.reviewerEscalated).toBe(0);
    expect(['queued', 'running']).toContain(taskRepo.get('test-project/review')?.status);
    scheduler.cancelAll();
    scheduler.stop();
  });

  it('announces a finished review chain once instead of on every tick', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]) });
    new ReviewRepo(db).insert({ id: 'codex-ok', taskId: 'test-project/review', verdict: 'approved', feedback: 'ok', actor: 'codex-reviewer' });
    taskRepo.update('test-project/review', { reviewStep: 1 });
    for (let tick = 0; tick < 10; tick++) await scheduler.tick();
    const ready = () => eventRepo.getRecent(50).filter((event) => event.type === 'task.review_ready' && event.taskId === 'test-project/review');
    expect(ready()).toHaveLength(1);
    // A new review round may announce again.
    scheduler.reviewTask('test-project/review', 'changes_requested', 'fix it', 'brain');
    taskRepo.update('test-project/review', { status: 'review', reviewStep: 1 });
    await scheduler.tick();
    expect(ready()).toHaveLength(2);
    scheduler.stop();
  });

  it('runs a Codex final step itself and completes the chain when it approves', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'final' }]) });
    await scheduler.tick();
    expect(runRepo.getByTask('test-project/review').filter((run) => run.kind === 'reviewer')).toHaveLength(1);
    await vi.waitFor(() => {
      expect(taskRepo.get('test-project/review')?.reviewStep).toBe(1);
    });
    const ready = eventRepo.getRecent(50).filter((event) => event.type === 'task.review_ready' && event.taskId === 'test-project/review');
    expect(ready).toHaveLength(1);
    expect(ready[0].payload).toContain('"reviewChainComplete":true');
    expect(taskRepo.get('test-project/review')?.status).toBe('review');
    scheduler.stop();
  });

  it('leaves a Claude final step to the brain or a person', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'claude', mode: 'final' }]) });
    await scheduler.tick();
    expect(runRepo.getByTask('test-project/review').filter((run) => run.kind === 'reviewer')).toHaveLength(0);
    scheduler.stop();
  });

  it('reviews a Codex-built task from another Codex account instead of skipping the gate', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]) });
    db.prepare("INSERT INTO runs (id, taskId, engine, model, profileName, kind) VALUES ('w1', 'test-project/review', 'codex', 'codex:gpt-5.6-luna', 'codex-1', 'worker')").run();

    profileRepo.upsert({ name: 'codex-2', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    await scheduler.tick();
    const reviewer = runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer');
    expect(reviewer?.profileName).toBe('codex-2');
    scheduler.stop();
  });

  it('uses Claude for a chain gate when the worker is the only Codex profile', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]) });
    db.prepare("INSERT INTO runs (id, taskId, engine, model, profileName, kind) VALUES ('chain-worker', 'test-project/review', 'codex', 'codex:gpt-5.6-luna', 'codex-1', 'worker')").run();
    withClaudeReviewer(scheduler);

    await scheduler.tick();

    expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.engine).toBe('claude');
    expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.profileName).toBe('claude-1');
    scheduler.stop();
  });

  it('reuses the worker Codex profile when chain Claude fallback is disabled', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    config.reviewer.fallback.onUnavailable = false;
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]) });
    db.prepare("INSERT INTO runs (id, taskId, engine, model, profileName, kind) VALUES ('chain-worker', 'test-project/review', 'codex', 'codex:gpt-5.6-luna', 'codex-1', 'worker')").run();

    await scheduler.tick();

    expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.profileName).toBe('codex-1');
    scheduler.stop();
  });

  it('reports a chain gate with no reviewer once per 30-minute window', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]) });
    profileRepo.update('codex-1', { authState: 'not_logged_in' });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    const waiting = eventRepo.getRecent(30).filter((event) => event.type === 'review.waiting' && event.taskId === 'test-project/review');
    expect(waiting).toHaveLength(1);
    expect(waiting[0].payload).toContain('no_reviewer_profile');
    scheduler.stop();
  });

  it('sends a task past a Codex gate without a Codex review back to the gate', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]) });
    taskRepo.update('test-project/review', { reviewStep: 1 });
    await scheduler.tick();
    expect(taskRepo.get('test-project/review')?.reviewStep).toBe(0);
    expect(eventRepo.getRecent(50).filter((event) => event.type === 'task.review_ready')).toHaveLength(0);
    scheduler.stop();
  });

  it('does not start a reviewer with a logged-out Codex profile', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    profileRepo.update('codex-1', { authState: 'not_logged_in' });
    profileRepo.upsert({ name: 'codex-2', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1, authState: 'ok' });

    await scheduler.tick();

    const reviewer = runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer');
    expect(reviewer?.profileName).toBe('codex-2');
    scheduler.stop();
  });

  function withClaudeReviewer(scheduler: Scheduler) {
    profileRepo.upsert({ name: 'claude-1', engine: 'claude', kind: 'isolated', home: path.join(tmpDir, 'claude-1'), email: null, enabled: 1 });
    const claude = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    (claude as unknown as { id: string }).id = 'claude';
    (scheduler as unknown as { engines: Map<string, Engine> }).engines.set('claude-review', claude);
  }

  function exhaustDepartmentClaudeBudget(scheduler: Scheduler) {
    const departmentRepo = new DepartmentRepo(db);
    departmentRepo.insert({ id: 'review-eng', name: 'Review Engineering', priority: 0, maxParallel: 3, claudeDailyTokenBudget: 100, telegramTopicId: null });
    projectRepo.update('test-project', { departmentId: 'review-eng' });
    vi.spyOn(departmentRepo, 'claudeUsageToday').mockReturnValue(100);
    (scheduler as unknown as { departmentRepo: DepartmentRepo }).departmentRepo = departmentRepo;
  }

  it('falls back to a Claude reviewer when every Codex account is out of quota', async () => {
    const { scheduler, reviewRepo } = makeReviewer('reviewer-chatter');
    withClaudeReviewer(scheduler);
    new QuotaService(quotaMarkRepo, profileRepo).mark('codex-1', 'codex', 3600, 'test');
    await scheduler.tick();
    const reviewer = runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer');
    expect(reviewer?.profileName).toBe('claude-1');
    expect(reviewer?.engine).toBe('claude');
    await vi.waitFor(() => expect(taskRepo.get('test-project/review')?.status).toBe('done'));
    expect(reviewRepo.getByTask('test-project/review').at(-1)?.actor).toBe('claude-reviewer');
    expect(eventRepo.getRecent(30).some((event) => event.type === 'review.fallback')).toBe(true);
    scheduler.stop();
  });

  it('lets the Claude reviewer give a final verdict after a second escalation', async () => {
    const { scheduler, reviewRepo } = makeReviewer('reviewer-chatter');
    withClaudeReviewer(scheduler);
    for (let i = 0; i < 2; i++) {
      db.prepare("INSERT INTO events (type, taskId, payload) VALUES ('review.escalated', 'test-project/review', ?)").run(JSON.stringify({ reason: 'reviewer_changes_limit' }));
    }
    taskRepo.update('test-project/review', { reviewerEscalated: 1, reviewerEscalationReason: 'reviewer_changes_limit' });
    await scheduler.tick();
    const reviewer = runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer');
    expect(reviewer?.profileName).toBe('claude-1');
    await vi.waitFor(() => expect(reviewRepo.getByTask('test-project/review').at(-1)?.actor).toBe('claude-reviewer'));
    scheduler.stop();
  });

  it('uses an independent Codex arbiter when Claude reviewers are unavailable', async () => {
    const { scheduler, reviewRepo } = makeReviewer('reviewer-approved');
    withClaudeReviewer(scheduler);
    profileRepo.upsert({ name: 'codex-2', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    db.prepare("INSERT INTO runs (id, taskId, engine, model, profileName, kind) VALUES ('arb-worker', 'test-project/review', 'codex', 'codex:gpt-5.6-luna', 'codex-1', 'worker')").run();
    // The rejection that caused escalation can share its second-resolution timestamp with the
    // escalation event. It must not be mistaken for a new arbiter verdict.
    reviewRepo.insert({ id: 'pre-escalation-review', taskId: 'test-project/review', verdict: 'changes_requested', feedback: 'old rejection', actor: 'codex-reviewer' });
    for (let i = 0; i < 2; i++) {
      db.prepare("INSERT INTO events (type, taskId, payload) VALUES ('review.escalated', 'test-project/review', ?)").run(JSON.stringify({ reason: 'reviewer_changes_limit' }));
    }
    taskRepo.update('test-project/review', { reviewerEscalated: 1, reviewerEscalationReason: 'reviewer_changes_limit' });
    (scheduler as unknown as { reviewerBackoffUntil: Map<string, number> }).reviewerBackoffUntil.set('claude-1', Date.now() + 60_000);

    await scheduler.tick();

    const reviewer = runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer');
    expect(reviewer?.profileName).toBe('codex-2');
    expect(eventRepo.getRecent(30).some((event) => event.type === 'review.fallback' && event.payload?.includes('arbiter_unavailable'))).toBe(true);
    await vi.waitFor(() => expect(reviewRepo.getByTask('test-project/review').at(-1)?.actor).toBe('codex-reviewer'));
    scheduler.stop();
  });

  it('waits when a Claude arbiter exceeds the department budget', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    withClaudeReviewer(scheduler);
    exhaustDepartmentClaudeBudget(scheduler);
    for (let i = 0; i < 2; i++) {
      db.prepare("INSERT INTO events (type, taskId, payload) VALUES ('review.escalated', 'test-project/review', ?)").run(JSON.stringify({ reason: 'reviewer_changes_limit' }));
    }
    taskRepo.update('test-project/review', { reviewerEscalated: 1, reviewerEscalationReason: 'reviewer_changes_limit' });

    await scheduler.tick();

    expect(runRepo.getByTask('test-project/review').filter((run) => run.kind === 'reviewer')).toHaveLength(0);
    expect(eventRepo.getRecent(30).some((event) => event.type === 'review.waiting' && event.payload?.includes('department_claude_budget'))).toBe(true);
    scheduler.stop();
  });

  it('still runs a Codex arbiter when the department Claude budget is exhausted', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    exhaustDepartmentClaudeBudget(scheduler);
    config.reviewer.arbiter = { engine: 'codex', model: 'gpt-5.6-luna' };
    for (let i = 0; i < 2; i++) {
      db.prepare("INSERT INTO events (type, taskId, payload) VALUES ('review.escalated', 'test-project/review', ?)").run(JSON.stringify({ reason: 'reviewer_changes_limit' }));
    }
    taskRepo.update('test-project/review', { reviewerEscalated: 1, reviewerEscalationReason: 'reviewer_changes_limit' });

    await scheduler.tick();

    expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.engine).toBe('codex');
    scheduler.stop();
  });

  it('clears an escalation once an automated reviewer approved, so the finished chain can merge', async () => {
    const { scheduler, reviewRepo } = makeReviewer('reviewer-approved');
    projectRepo.update('test-project', { reviewChain: JSON.stringify([{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }]) });
    taskRepo.update('test-project/review', { reviewerEscalated: 1, reviewerEscalationReason: 'reviewer_changes_limit', reviewStep: 1 });
    reviewRepo.insert({ id: 'arb-ok', taskId: 'test-project/review', verdict: 'approved', feedback: 'ok', actor: 'claude-reviewer' });
    await scheduler.tick();
    expect(taskRepo.get('test-project/review')?.reviewerEscalated).toBe(0);
    expect(eventRepo.getRecent(30).filter((event) => event.type === 'task.review_ready' && event.taskId === 'test-project/review')).toHaveLength(1);
    scheduler.stop();
  });

  it('sends an arbiter rejection back to the worker, then blocks after the allowed rounds', async () => {
    const { scheduler, reviewRepo } = makeReviewer('reviewer-approved');
    const escalate = () => {
      db.prepare("INSERT INTO events (type, taskId, payload) VALUES ('review.escalated', 'test-project/review', ?)").run(JSON.stringify({ reason: 'reviewer_changes_limit' }));
      taskRepo.update('test-project/review', { status: 'review', reviewerEscalated: 1, reviewerEscalationReason: 'reviewer_changes_limit' });
    };
    escalate(); escalate();
    for (let round = 1; round <= 3; round++) {
      if (round > 1) escalate();
      reviewRepo.insert({ id: `arb-no-${round}`, taskId: 'test-project/review', verdict: 'changes_requested', feedback: `thiếu test ${round}`, actor: 'claude-reviewer' });
      db.prepare("INSERT INTO events (type, taskId, payload) VALUES ('review.completed', 'test-project/review', ?)").run(JSON.stringify({ actor: 'claude-reviewer', verdict: 'changes_requested' }));
      await scheduler.tick();
      const task = taskRepo.get('test-project/review')!;
      if (round <= 2) {
        // Back in the queue; the same tick may already mark it waiting for a free account.
        expect(['queued', 'waiting_quota']).toContain(task.status);
        expect(JSON.parse(task.modelChain!)[0]).toBe('claude-opus-4-6-thinking');
      } else {
        expect(task.status).toBe('blocked');
      }
    }
    scheduler.stop();
  });

  it('leaves a first escalation for the retry path, not the arbiter', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    withClaudeReviewer(scheduler);
    db.prepare("INSERT INTO events (type, taskId, payload) VALUES ('review.escalated', 'test-project/review', ?)").run(JSON.stringify({ reason: 'reviewer_changes_limit' }));
    taskRepo.update('test-project/review', { reviewerEscalated: 1, reviewerEscalationReason: 'reviewer_changes_limit' });
    await scheduler.tick();
    expect(runRepo.getByTask('test-project/review').filter((run) => run.kind === 'reviewer')).toHaveLength(0);
    scheduler.stop();
  });

  it('lets Claude review once a busy Codex has kept the task waiting too long', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    withClaudeReviewer(scheduler);
    (scheduler as unknown as { reviewerRunsForProfile: (name: string) => boolean }).reviewerRunsForProfile = (name) => name === 'codex-1';
    db.prepare("UPDATE tasks SET updatedAt = datetime('now', '-30 minutes') WHERE id = 'test-project/review'").run();
    await scheduler.tick();
    expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.profileName).toBe('claude-1');
    scheduler.stop();
  });

  it('keeps waiting for Codex when its accounts are only busy', async () => {
    const { scheduler } = makeReviewer('reviewer-approved');
    withClaudeReviewer(scheduler);
    (scheduler as unknown as { reviewerRunsForProfile: (name: string) => boolean }).reviewerRunsForProfile = (name) => name === 'codex-1';
    await scheduler.tick();
    expect(runRepo.getByTask('test-project/review').filter((run) => run.kind === 'reviewer')).toHaveLength(0);
    scheduler.stop();
  });

  it('escalates before spawning when autocheck results are missing', async () => {
    const { scheduler } = makeReviewer('reviewer-approved', false);
    await scheduler.tick();
    const task = taskRepo.get('test-project/review')!;
    expect(task.status).toBe('review');
    expect(task.reviewerEscalated).toBe(1);
    expect(runRepo.getByTask(task.id).filter((run) => run.kind === 'reviewer')).toHaveLength(0);
    expect(eventRepo.getRecent(20).filter((event) => event.type === 'review.escalated')).toHaveLength(1);
    scheduler.stop();
  });

  it('allows two reviewer changes requests, then escalates and survives restart ticks', async () => {
    const { scheduler, failover, reviewRepo } = makeReviewer('reviewer-changes');
    for (let count = 0; count < 3; count++) {
      scheduler.reviewTask('test-project/review', 'changes_requested', `feedback ${count + 1}`, 'codex-reviewer');
      if (count < 2) taskRepo.update('test-project/review', { status: 'review' });
    }
    const task = taskRepo.get('test-project/review')!;
    expect(task.status).toBe('review');
    expect(task.reviewerChangesRequested).toBe(2);
    expect(task.reviewerEscalated).toBe(1);
    expect(eventRepo.getRecent(30).filter((event) => event.type === 'review.escalated')).toHaveLength(1);
    scheduler.stop();
    const fake = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const recovery = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['codex', fake]]), undefined, undefined, db);
    recovery.configureReviewer(reviewRepo, failover);
    // Reuse persisted task state and prove a new scheduler does not start it.
    await recovery.tick();
    expect(runRepo.getByTask(task.id).filter((run) => run.kind === 'reviewer')).toHaveLength(0);
    recovery.stop();
  });

  it('counts content feedback across reviewers and steps, but not operational returns', async () => {
    const { scheduler } = makeReviewer('reviewer-changes');
    projectRepo.update('test-project', {
      review: JSON.stringify({ maxRounds: 2, chain: [
        { reviewer: 'codex:gpt-5.6-luna', mode: 'gate' },
        { reviewer: 'claude:sonnet', mode: 'gate' },
      ] }),
    });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'merge failed is mentioned, but this is a real code defect', 'claude-review');
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(1);
    taskRepo.update('test-project/review', { status: 'review' });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'Xung đột is mentioned in a code comment, still a content defect', 'claude-review');
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(2);
    taskRepo.update('test-project/review', { status: 'review' });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'merge conflict: operational failure', 'claude-review', 'operational');
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(2);
    expect(taskRepo.get('test-project/review')?.reviewerEscalated).toBe(0);
    scheduler.stop();
  });

  it('escalation includes all open findings and the reviewer actor', async () => {
    const { scheduler } = makeReviewer('reviewer-changes');
    scheduler.reviewTask('test-project/review', 'changes_requested', 'first missing case', 'codex-reviewer');
    taskRepo.update('test-project/review', { status: 'review' });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'second missing case', 'claude-reviewer');
    taskRepo.update('test-project/review', { status: 'review' });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'third missing case', 'claude-reviewer');
    const event = eventRepo.getRecent(30).find((entry) => entry.type === 'review.escalated');
    expect(event?.payload).toContain('first missing case');
    expect(event?.payload).toContain('second missing case');
    expect(event?.payload).toContain('third missing case');
    expect(event?.payload).toContain('claude-reviewer');
    expect(event?.payload).toContain('Lịch sử các vòng review:');
    scheduler.stop();
  });

  it('retains reviewerChangesRequested counter without reset or increase on reviewer crash', async () => {
    const errorSetup = makeReviewer('reviewer-error');
    taskRepo.update('test-project/review', { reviewerChangesRequested: 1 });
    await errorSetup.scheduler.tick();
    await vi.waitFor(() => {
      expect(errorSetup.scheduler.getReviewerStatus().running).toEqual([]);
      expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.outcome).toBe('crashed');
    });
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(1);
    errorSetup.scheduler.stop();
  });

  it('retains reviewerChangesRequested counter without reset or increase on reviewer quota', async () => {
    const quotaSetup = makeReviewer('reviewer-quota');
    taskRepo.update('test-project/review', { reviewerChangesRequested: 1 });
    await quotaSetup.scheduler.tick();
    await vi.waitFor(() => {
      expect(runRepo.getByTask('test-project/review').find((run) => run.kind === 'reviewer')?.outcome).toBe('quota');
    });
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(1);
    quotaSetup.scheduler.stop();
  });

  it('accumulates reviewerChangesRequested across advanceReviewStep chain steps', async () => {
    const { scheduler } = makeReviewer('reviewer-changes');
    projectRepo.update('test-project', {
      review: JSON.stringify({
        maxRounds: 3,
        chain: [
          { reviewer: 'codex:gpt-5.6-luna', mode: 'gate' },
          { reviewer: 'claude', mode: 'gate' },
        ],
      }),
    });
    expect(taskRepo.get('test-project/review')?.reviewStep).toBe(0);
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(0);

    // Step 0 passes gate -> reviewStep advances to 1
    scheduler.reviewTask('test-project/review', 'approved', 'step 0 ok', 'codex-reviewer');
    expect(taskRepo.get('test-project/review')?.reviewStep).toBe(1);
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(0);

    // Step 1 returns changes_requested -> counter increments to 1, reviewStep resets to 0
    scheduler.reviewTask('test-project/review', 'changes_requested', 'step 1 found defect', 'claude-reviewer');
    expect(taskRepo.get('test-project/review')?.reviewStep).toBe(0);
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(1);
    expect(taskRepo.get('test-project/review')?.status).toBe('queued');

    // Simulate task re-entering review after worker fix
    taskRepo.update('test-project/review', { status: 'review' });

    // Step 0 passes gate again -> advances to step 1, counter stays 1
    scheduler.reviewTask('test-project/review', 'approved', 'step 0 ok again', 'codex-reviewer');
    expect(taskRepo.get('test-project/review')?.reviewStep).toBe(1);
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(1);

    // Step 1 returns changes_requested again -> counter increments to 2
    scheduler.reviewTask('test-project/review', 'changes_requested', 'step 1 found another defect', 'claude-reviewer');
    expect(taskRepo.get('test-project/review')?.reviewStep).toBe(0);
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(2);
    scheduler.stop();
  });

  it('emits review.escalated only once when exceeding maxRounds and ignores subsequent calls', async () => {
    const { scheduler } = makeReviewer('reviewer-changes');
    projectRepo.update('test-project', {
      review: JSON.stringify({ maxRounds: 1 }),
    });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'round 1 defect', 'codex-reviewer');
    expect(taskRepo.get('test-project/review')?.reviewerChangesRequested).toBe(1);
    expect(taskRepo.get('test-project/review')?.reviewerEscalated).toBe(0);

    // Second changes_requested exceeds maxRounds 1
    taskRepo.update('test-project/review', { status: 'review' });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'round 2 defect exceeds limit', 'codex-reviewer');
    expect(taskRepo.get('test-project/review')?.reviewerEscalated).toBe(1);
    const escalatedEvents = eventRepo.getRecent(30).filter((e) => e.type === 'review.escalated');
    expect(escalatedEvents).toHaveLength(1);

    // Calling again while reviewerEscalated is active does not emit another escalation event
    scheduler.reviewTask('test-project/review', 'changes_requested', 'round 3 after escalation', 'codex-reviewer');
    const escalatedEventsAfter = eventRepo.getRecent(30).filter((e) => e.type === 'review.escalated');
    expect(escalatedEventsAfter).toHaveLength(1);
    scheduler.stop();
  });

  it('highlights missed-earlier findings distinctly in review.escalated open feedback', async () => {
    const { scheduler } = makeReviewer('reviewer-changes');
    projectRepo.update('test-project', {
      review: JSON.stringify({ maxRounds: 1 }),
    });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'P1: missed-earlier - src/notify.ts:433 còn sót', 'codex-reviewer');
    taskRepo.update('test-project/review', { status: 'review' });
    scheduler.reviewTask('test-project/review', 'changes_requested', 'P2: lỗi mới vòng 2', 'claude-reviewer');
    const event = eventRepo.getRecent(30).find((e) => e.type === 'review.escalated');
    expect(event?.payload).toContain('[Lỗi vòng hiện tại] P2: lỗi mới vòng 2');
    expect(event?.payload).toContain('[Lỗi bỏ sót ghi nhận từ vòng trước (missed-earlier - codex-reviewer)] P1: missed-earlier - src/notify.ts:433 còn sót');
    expect(event?.payload).toContain('Lịch sử các vòng review:');
    scheduler.stop();
  });

  it('recovers a durable reviewer run without putting it in the worker map', async () => {
    const { scheduler, failover } = makeReviewer('reviewer-approved');
    runRepo.insert({ id: 'old-review', taskId: 'test-project/review', engine: 'codex', model: 'codex:gpt-5.6-luna', profileName: 'codex-1', kind: 'reviewer' });
    failover.clear();
    scheduler.start();
    expect(scheduler.getRunning().has('test-project/review')).toBe(false);
    expect(runRepo.get('old-review')?.outcome).toBe('crashed');
    scheduler.stop();
  });

  it('kills a live durable reviewer run during restart recovery', async () => {
    const { scheduler, failover } = makeReviewer('reviewer-approved');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    expect(child.pid).toBeDefined();
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    runRepo.insert({ id: 'live-review', taskId: 'test-project/review', engine: 'codex', model: 'codex:gpt-5.6-luna', profileName: 'codex-1', pid: child.pid, kind: 'reviewer' });
    failover.clear();
    scheduler.start();
    expect(scheduler.getRunning().has('test-project/review')).toBe(false);
    expect(runRepo.get('live-review')?.outcome).toBe('crashed');
    const exitCode = await exited;
    expect(exitCode === null || typeof exitCode === 'number').toBe(true);
    scheduler.stop();
  });
});

describe('Quota → profile marked → task runs on another profile', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('switches profile when quota is exhausted', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: 'a@test.com', enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: 'b@test.com', enabled: 1 });

    // Mark p1 as quota exhausted for gemini
    const quotaService = new QuotaService(quotaMarkRepo, profileRepo);
    quotaService.mark('p1', 'gemini', 3600, 'quota hit');

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued', level: 'easy' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    // The task should be running on p2 (p1 is quota-exhausted for gemini, easy model chain starts with gemini)
    const runs = runRepo.getByTask('test-project/t1');
    expect(runs.length).toBe(1);
    expect(runs[0].profileName).toBe('p2');

    scheduler.stop();
  });

  it('continues a running task after quota on the same worktree without increasing attempt', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: 'a@test.com', enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: 'b@test.com', enabled: 1 });
    const worktreePath = path.join(tmpDir, 'worktree');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    const logPath = path.join(tmpDir, 'run.log');
    fs.writeFileSync(logPath, 'worker output');
    taskRepo.insert({
      id: 'test-project/live-quota', projectId: 'test-project', slug: 'live-quota', title: 'Live quota',
      status: 'running', worktreePath,
    });
    taskRepo.update('test-project/live-quota', { attempt: 2 });
    runRepo.insert({ id: 'quota-run', taskId: 'test-project/live-quota', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', logPath });
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>());
    const schedulerInternal = scheduler as unknown as {
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
      running: Map<string, unknown>;
    };
    const rt = {
      runId: 'quota-run', taskId: 'test-project/live-quota', pid: 999991, pidStart: null,
      engine: { id: 'agy', detectQuota: () => ({ exhausted: true, resetSeconds: 3600 }), detectAuthError: () => ({ expired: false }), detectTransientError: () => false },
      model: 'gemini-3.8-flash-medium', profileName: 'p1', projectId: 'test-project',
      startTime: Date.now() - 10_000, timeoutMs: 60_000, timeoutAt: Date.now() + 60_000,
      retryCount: 0, lastOutputAt: Date.now(), lastActivityAt: Date.now(), activitySource: 'terminal',
      activityCheckedAt: Date.now(), cachedConversationMtime: 0, cachedWorktreeMtime: 0, usageBefore: null,
    };
    schedulerInternal.running.set('test-project/live-quota', rt);

    await schedulerInternal.handleRunCompletion('test-project/live-quota', rt);

    const task = taskRepo.get('test-project/live-quota')!;
    expect(task.status).toBe('queued');
    expect(task.attempt).toBe(2);
    expect(task.worktreePath).toBe(worktreePath);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('Failover: p1/gemini-3.8-flash-medium → p2/gemini-3.8-flash-medium; reason');
    const failover = eventRepo.getRecent(20).find((event) => event.type === 'task.failover');
    expect(failover).toBeDefined();
    const payload = JSON.parse(failover!.payload);
    expect(payload.from).toEqual({ profile: 'p1', model: 'gemini-3.8-flash-medium', engine: 'agy' });
    expect(payload.to).toEqual({ profile: 'p2', model: 'gemini-3.8-flash-medium', engine: 'agy' });
    expect(payload.reason).toContain('quota exhausted on agy/gemini-3.8-flash-medium');
    expect(payload.worktreePath).toBe(worktreePath);
    expect(payload.runId).toBe('quota-run');
    scheduler.stop();
  });

  it('fails over to another profile with the exact same model when profile A exhausts quota for model M', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'prof-a', engine: 'agy', kind: 'isolated', home: '/tmp/prof-a', email: 'a@test.com', enabled: 1 });
    profileRepo.upsert({ name: 'prof-b', engine: 'agy', kind: 'isolated', home: '/tmp/prof-b', email: 'b@test.com', enabled: 1 });

    const quotaService = new QuotaService(quotaMarkRepo, profileRepo);
    quotaService.mark('prof-a', 'claude', 3600, 'quota hit');

    taskRepo.insert({
      id: 'test-project/same-model-failover',
      projectId: 'test-project',
      slug: 'same-model-failover',
      title: 'Same Model Failover',
      status: 'queued',
      modelChain: JSON.stringify(['claude-sonnet-4-6']),
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines);

    await scheduler.tick();

    const runs = runRepo.getByTask('test-project/same-model-failover');
    expect(runs).toHaveLength(1);
    expect(runs[0].profileName).toBe('prof-b');
    expect(runs[0].model).toBe('claude-sonnet-4-6');

    scheduler.stop();
  });

  it('continues a running task into waiting_quota on same worktree when all models/profiles are exhausted', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: 'a@test.com', enabled: 1 });
    const worktreePath = path.join(tmpDir, 'worktree-all-exhausted');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    const logPath = path.join(tmpDir, 'run-all-exhausted.log');
    fs.writeFileSync(logPath, 'worker output before quota\n');
    taskRepo.insert({
      id: 'test-project/exhausted-quota', projectId: 'test-project', slug: 'exhausted-quota', title: 'Exhausted quota',
      status: 'running', worktreePath,
    });
    taskRepo.update('test-project/exhausted-quota', { attempt: 3 });
    runRepo.insert({ id: 'quota-run-exhausted', taskId: 'test-project/exhausted-quota', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', logPath });
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>());
    const schedulerInternal = scheduler as unknown as {
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
      running: Map<string, unknown>;
    };
    const rt = {
      runId: 'quota-run-exhausted', taskId: 'test-project/exhausted-quota', pid: 999992, pidStart: null,
      engine: { id: 'agy', detectQuota: () => ({ exhausted: true, resetSeconds: 3600 }), detectAuthError: () => ({ expired: false }), detectTransientError: () => false },
      model: 'gemini-3.8-flash-medium', profileName: 'p1', projectId: 'test-project',
      startTime: Date.now() - 10_000, timeoutMs: 60_000, timeoutAt: Date.now() + 60_000,
      retryCount: 0, lastOutputAt: Date.now(), lastActivityAt: Date.now(), activitySource: 'terminal',
      activityCheckedAt: Date.now(), cachedConversationMtime: 0, cachedWorktreeMtime: 0, usageBefore: null,
    };
    schedulerInternal.running.set('test-project/exhausted-quota', rt);

    await schedulerInternal.handleRunCompletion('test-project/exhausted-quota', rt);

    const task = taskRepo.get('test-project/exhausted-quota')!;
    // handleRunCompletion triggers a tick; with all profiles exhausted the task is placed in waiting_quota
    expect(task.status).toBe('waiting_quota');
    expect(task.waitReason).toBe('quota');
    expect(task.attempt).toBe(3);
    expect(task.worktreePath).toBe(worktreePath);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('Failover: p1/gemini-3.8-flash-medium → waiting_quota; reason');
    const failover = eventRepo.getRecent(20).find((event) => event.type === 'task.failover');
    expect(failover).toBeDefined();
    const payload = JSON.parse(failover!.payload);
    expect(payload.from).toEqual({ profile: 'p1', model: 'gemini-3.8-flash-medium', engine: 'agy' });
    expect(payload.to).toBeNull();
    expect(payload.reason).toContain('all models/profiles unavailable');
    scheduler.stop();
  });

  it('dispatches queued task to waiting_quota when all models in chain are exhausted, and requeues on quota reset and claude.quota_available', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'agy-p1', engine: 'agy', kind: 'isolated', home: '/tmp/agy-p1', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'codex-p1', engine: 'codex', kind: 'codex', home: '/tmp/codex-p1', email: null, enabled: 1 });

    const now = Math.floor(Date.now() / 1000);
    // Mark both models in chain as exhausted
    quotaMarkRepo.mark('agy-p1', 'gemini', now + 10, 'gemini quota');
    quotaMarkRepo.mark('codex-p1', 'codex', now + 10, 'codex quota');

    taskRepo.insert({
      id: 'test-project/chain-wait',
      projectId: 'test-project',
      slug: 'chain-wait',
      title: 'Chain Wait Task',
      status: 'queued',
      modelChain: JSON.stringify(['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna']),
    });

    const fakeAgent = path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs');
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', new FakeEngine(fakeAgent)], ['codex', new FakeEngine(fakeAgent)]]),
    );

    // 1. When findModelProfilePair returns null, dispatch puts task into waiting_quota
    await scheduler.tick();
    let task = taskRepo.get('test-project/chain-wait')!;
    expect(task.status).toBe('waiting_quota');
    expect(task.waitReason).toBe('quota');
    const waitEvents = eventRepo.getRecent(10).filter((e) => e.type === 'task.waiting_quota' && e.taskId === 'test-project/chain-wait');
    expect(waitEvents.length).toBeGreaterThan(0);

    // 2. Next dispatch tick while quota marks are expired moves waiting_quota tasks back to queued and runs them
    // Simulate quota expiry by marking in the past
    quotaMarkRepo.mark('agy-p1', 'gemini', now - 10, 'expired');
    quotaMarkRepo.mark('codex-p1', 'codex', now - 10, 'expired');
    await scheduler.tick();
    task = taskRepo.get('test-project/chain-wait')!;
    expect(['queued', 'running']).toContain(task.status);
    const allRecent = eventRepo.getRecent(50);
    expect(allRecent.some((e) => e.type === 'task.queued' && e.taskId === 'test-project/chain-wait' && (e.payload?.includes('quota_cleared') || e.payload?.includes('quota_expired')))).toBe(true);

    // 3. Re-exhaust and verify wake on claude.quota_available
    quotaMarkRepo.mark('agy-p1', 'gemini', now + 3600, 'gemini quota again');
    quotaMarkRepo.mark('codex-p1', 'codex', now + 3600, 'codex quota again');
    taskRepo.updateStatus('test-project/chain-wait', 'waiting_quota', 'quota');

    // Emitting claude.quota_available while marks remain leaves task in waiting_quota after recheck
    scheduler.getEventBus().emit('claude.quota_available');
    await scheduler.tick();
    task = taskRepo.get('test-project/chain-wait')!;
    expect(task.status).toBe('waiting_quota');

    // Clear quota mark and emit claude.quota_available -> task requeues
    quotaMarkRepo.clear('agy-p1', 'gemini');
    scheduler.getEventBus().emit('claude.quota_available');
    await scheduler.tick();
    task = taskRepo.get('test-project/chain-wait')!;
    expect(['queued', 'running']).toContain(task.status);
    const availableEvents = eventRepo.getRecent(10).filter((e) => e.type === 'task.queued' && e.taskId === 'test-project/chain-wait');
    expect(availableEvents.some((e) => e.payload && e.payload.includes('quota_available'))).toBe(true);

    scheduler.stop();
  });

  it('moves to waiting_quota when all profiles exhausted', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    // Mark p1 as quota exhausted for all families
    const quotaService = new QuotaService(quotaMarkRepo, profileRepo);
    quotaService.mark('p1', 'gemini', 3600, 'quota hit');
    quotaService.mark('p1', 'claude', 3600, 'quota hit');
    quotaService.mark('p1', 'codex', 3600, 'quota hit');

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued', level: 'easy' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    const t = taskRepo.get('test-project/t1')!;
    expect(t.status).toBe('waiting_quota');

    scheduler.stop();
  });

  it('falls through the task model chain when the first model family is exhausted', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'agy-1', engine: 'agy', kind: 'isolated', home: '/tmp/agy-1', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'codeX1', engine: 'codex', kind: 'codex', home: '/tmp/codex', email: null, enabled: 1 });
    new QuotaService(quotaMarkRepo, profileRepo).mark('agy-1', 'gemini', 3600, 'quota hit');
    taskRepo.insert({
      id: 'test-project/fallback', projectId: 'test-project', slug: 'fallback', title: 'Fallback',
      status: 'queued', level: 'easy', modelChain: JSON.stringify(['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna']),
    });

    const fakeAgent = path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs');
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', new FakeEngine(fakeAgent)], ['codex', new FakeEngine(fakeAgent)]]),
    );
    await scheduler.tick();

    expect(runRepo.getByTask('test-project/fallback')[0]).toMatchObject({ model: 'codex:gpt-5.6-luna', profileName: 'codeX1' });
    expect(taskRepo.get('test-project/fallback')?.status).toBe('running');
    scheduler.stop();
  });

  it('marks auth as not logged in, propagates by email, and requeues on another profile', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: 'same@test.com', enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: 'other@test.com', enabled: 1 });
    profileRepo.upsert({ name: 'p3', engine: 'agy', kind: 'isolated', home: '/tmp/p3', email: 'same@test.com', enabled: 1 });
    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });
    process.env.FAKE_MODE = 'auth-p1';
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]),
    );
    await scheduler.tick();
    await vi.waitFor(() => expect(profileRepo.get('p1')?.authState).toBe('not_logged_in'), { timeout: 5000 });
    expect(profileRepo.get('p3')?.authState).toBe('not_logged_in');
    expect(profileRepo.get('p1')?.authMessage).toBe('Phiên đăng nhập hết hạn (401) – cần đăng nhập lại');
    const authRun = runRepo.getByTask('test-project/t1')[0];
    expect(authRun).toMatchObject({ outcome: 'crashed', reason: 'auth', profileName: 'p1' });
    await vi.waitFor(() => expect(runRepo.getByTask('test-project/t1').some((run) => run.profileName === 'p2')).toBe(true), { timeout: 5000 });
    scheduler.stop();
    delete process.env.FAKE_MODE;
  });

  it('fails clearly when every matching profile needs login again', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    for (const name of ['p1', 'p2']) {
      profileRepo.upsert({ name, engine: 'agy', kind: 'isolated', home: `/tmp/${name}`, email: null, enabled: 1, authState: 'not_logged_in' });
    }
    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]),
    );
    await scheduler.tick();
    expect(taskRepo.get('test-project/t1')).toMatchObject({ status: 'failed' });
    scheduler.stop();
  });
});

describe('Review: DONE → review, changes_requested → re-queue', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('review changes_requested → feedback written, marker deleted, task re-queued with resume', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    // Create a task in review status with a worktree-like dir
    const worktreePath = path.join(tmpDir, 'worktree');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'done report');

    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      body: 'original body',
      status: 'review',
    });
    taskRepo.update('test-project/t1', { worktreePath });
    taskRepo.update('test-project/t1', {
      reviewerChangesRequested: 2,
      reviewerEscalated: 1,
      reviewerEscalatedAt: '2026-10-15T10:00:00Z',
      reviewerEscalationReason: 'reviewer_changes_limit',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    scheduler.reviewTask('test-project/t1', 'changes_requested', 'Fix the linting errors');

    const task = taskRepo.get('test-project/t1')!;
    expect(task.status).toBe('queued');
    expect(task.resume).toBe(1);
    expect(task.body).toContain('Feedback review');
    expect(task.body).toContain('Fix the linting errors');
    expect(task.reviewerChangesRequested).toBe(2);
    expect(task.reviewerEscalated).toBe(0);
    expect(task.reviewerEscalatedAt).toBeNull();
    expect(task.reviewerEscalationReason).toBeNull();

    // DONE marker should be deleted
    expect(fs.existsSync(path.join(worktreePath, '.agenthub', 'DONE'))).toBe(false);

    scheduler.stop();
  });

  it('does not check again after changes_requested until a new worker completion', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    const worktreePath = path.join(tmpDir, 'worktree-retry');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'old done');
    taskRepo.insert({ id: 'test-project/retry-check', projectId: 'test-project', slug: 'retry-check', title: 'Retry check', body: 'body', status: 'review', worktreePath: worktreePath });
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map(), undefined, undefined, db);
    const run = vi.fn(async () => ({ passed: true, failed: [], results: [] }));
    scheduler.checkRunner = { run };

    scheduler.reviewTask('test-project/retry-check', 'changes_requested', 'Fix it');
    await scheduler.recoverCheckingTasks();

    expect(taskRepo.get('test-project/retry-check')?.status).toBe('queued');
    expect(run).not.toHaveBeenCalled();
    expect(eventRepo.getRecent(20).filter((event) => event.type === 'task.review_ready' && event.taskId === 'test-project/retry-check')).toHaveLength(0);
    scheduler.stop();
  });
});

describe('Cancel task → process group killed', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('cancels a running task', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      body: 'slow task',
      status: 'queued',
    });

    // Use slow mode so the process stays alive
    process.env.FAKE_MODE = 'slow';

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    // Task should be running
    let t = taskRepo.get('test-project/t1')!;
    expect(t.status).toBe('running');

    // Wait a moment for process to start
    await vi.waitFor(() => {
      const running = scheduler.getRunning().get('test-project/t1');
      expect(running).toBeDefined();
      expect(running?.pid).toBeGreaterThan(0);
    });

    // Cancel
    scheduler.cancelTask('test-project/t1');

    t = taskRepo.get('test-project/t1')!;
    expect(t.status).toBe('cancelled');

    // Run should have cancelled outcome
    const runs = runRepo.getByTask('test-project/t1');
    const lastRun = runs[runs.length - 1];
    expect(lastRun.outcome).toBe('cancelled');

    delete process.env.FAKE_MODE;
    scheduler.stop();
  });
});

describe('Watchdog', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  function makeActivityFixture(options: {
    profileKind?: 'isolated' | 'keyring';
    home?: string;
    worktreePath?: string;
    startTime?: number;
  } = {}) {
    if (!projectRepo.get('test-project')) createTestProject(path.join(tmpDir, 'activity-repo'));
    const home = options.home || path.join(tmpDir, 'profile-home');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
    const worktreePath = options.worktreePath || path.join(tmpDir, 'activity-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    const profileName = `watchdog-${options.profileKind || 'isolated'}`;
    profileRepo.upsert({
      name: profileName,
      engine: 'agy',
      kind: options.profileKind || 'isolated',
      home: options.profileKind === 'keyring' ? path.join(tmpDir, 'wrong-home') : home,
      email: null,
      enabled: 1,
    });
    const taskId = `test-project/activity-${profileName}`;
    taskRepo.insert({ id: taskId, projectId: 'test-project', slug: `activity-${profileName}`, title: 'Activity', status: 'running' });
    taskRepo.update(taskId, { worktreePath });
    const logPath = path.join(tmpDir, `${profileName}.log`);
    fs.writeFileSync(logPath, 'worker output\n');
    const startTime = options.startTime || Date.now();
    runRepo.insert({ id: `run-${profileName}`, taskId, engine: 'agy', model: 'gemini-3.8-flash-low', profileName, logPath });
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]));
    const running = {
      runId: `run-${profileName}`,
      taskId,
      pid: 1,
      pidStart: null,
      profileName,
      model: 'gemini-3.8-flash-low',
      engine: new FakeEngine(),
      startTime,
      timeoutMs: 300_000,
      timeoutAt: Date.now() + 300_000,
      retryCount: 0,
      projectId: 'test-project',
      lastOutputAt: startTime,
      lastActivityAt: startTime,
      activitySource: 'log' as const,
      activityCheckedAt: 0,
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
    };
    return { home, worktreePath, logPath, startTime, scheduler, running, conversationDir: path.join(home, '.gemini', 'antigravity-cli', 'conversations') };
  }

  it('stalls a silent worker, records the outcome, and requeues with a resume note', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/stalled', projectId: 'test-project', slug: 'stalled', title: 'Stalled', status: 'queued' });
    config.watchdog = { stallMinutes: 0.01, waitingMinutes: 0.001 };
    process.env.FAKE_MODE = 'slow';

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]));
    await scheduler.tick();
    projectRepo.update('test-project', { maxParallel: 0 });
    await vi.waitFor(() => {
      (scheduler as unknown as { checkRunningTasks: () => void }).checkRunningTasks();
      expect(runRepo.getByTask('test-project/stalled').at(-1)).toMatchObject({ outcome: 'crashed', reason: 'stalled' });
    }, { timeout: 3000 });

    expect(taskRepo.get('test-project/stalled')?.status).toBe('queued');
    expect(taskRepo.get('test-project/stalled')?.body).toContain('Lượt trước bị kẹt khi chờ tác vụ nền.');
    expect(eventRepo.getRecent().some((event) => event.type === 'run.stalled')).toBe(true);
    scheduler.stop();
    delete process.env.FAKE_MODE;
  });

  it('does not stall when the agy conversation changes while its log is silent', async () => {
    const fixture = makeActivityFixture({ startTime: Date.now() - 120_000 });
    fs.writeFileSync(path.join(fixture.conversationDir, 'run.db'), 'conversation activity');
    fs.utimesSync(fixture.logPath, new Date(fixture.startTime - 60_000), new Date(fixture.startTime - 60_000));
    config.watchdog = { stallMinutes: 0.01, waitingMinutes: 0.001 };

    const stalled = (fixture.scheduler as unknown as { isStalled: (running: unknown) => boolean }).isStalled(fixture.running);
    expect(stalled).toBe(false);
    expect(fixture.running.activitySource).toBe('conversation');
  });

  it('stalls when every activity source is silent', async () => {
    const fixture = makeActivityFixture({ startTime: Date.now() - 120_000 });
    const old = new Date(fixture.startTime - 60_000);
    fs.utimesSync(fixture.logPath, old, old);
    fs.writeFileSync(path.join(fixture.conversationDir, 'old.db'), 'old conversation');
    fs.utimesSync(path.join(fixture.conversationDir, 'old.db'), old, old);
    fs.writeFileSync(path.join(fixture.worktreePath, 'old.txt'), 'old work');
    fs.utimesSync(path.join(fixture.worktreePath, 'old.txt'), old, old);
    config.watchdog = { stallMinutes: 0.01, waitingMinutes: 0.001 };

    const stalled = (fixture.scheduler as unknown as { isStalled: (running: unknown) => boolean }).isStalled(fixture.running);
    expect(stalled).toBe(true);
  });

  it('uses the real HOME for a keyring profile', async () => {
    const realHome = process.env.HOME;
    const fixture = makeActivityFixture({ profileKind: 'keyring', startTime: Date.now() - 120_000 });
    const conversationPath = path.join(fixture.home, '.gemini', 'antigravity-cli', 'conversations', 'keyring.db');
    fs.writeFileSync(conversationPath, 'keyring conversation');
    process.env.HOME = fixture.home;
    try {
      const mtime = (fixture.scheduler as unknown as { getConversationMtime: (running: unknown) => number }).getConversationMtime(fixture.running);
      expect(mtime).toBeGreaterThan(fixture.startTime);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it('keeps a worker alive when a worktree file changes', async () => {
    const fixture = makeActivityFixture({ startTime: Date.now() - 120_000 });
    const changed = path.join(fixture.worktreePath, 'changed.txt');
    fs.writeFileSync(changed, 'new work');
    config.watchdog = { stallMinutes: 0.01, waitingMinutes: 0.001 };

    const stalled = (fixture.scheduler as unknown as { isStalled: (running: unknown) => boolean }).isStalled(fixture.running);
    expect(stalled).toBe(false);
  });

  it('ignores conversation files changed before the run started', async () => {
    const fixture = makeActivityFixture({ startTime: Date.now() });
    const oldConversation = path.join(fixture.conversationDir, 'before.db');
    fs.writeFileSync(oldConversation, 'old conversation');
    const old = new Date(fixture.startTime - 60_000);
    fs.utimesSync(oldConversation, old, old);

    const mtime = (fixture.scheduler as unknown as { getConversationMtime: (running: unknown) => number }).getConversationMtime(fixture.running);
    expect(mtime).toBe(0);
  });
});

describe('Codex slots', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('runs two hard tasks concurrently on one Codex profile', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    for (const slug of ['hard-a', 'hard-b']) {
      taskRepo.insert({ id: `test-project/${slug}`, projectId: 'test-project', slug, title: slug, level: 'hard', status: 'queued' });
    }
    process.env.FAKE_MODE = 'slow';
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    (fakeEngine as unknown as { id: 'codex' }).id = 'codex';
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['codex', fakeEngine]]));
    await scheduler.tick();

    expect(scheduler.getRunning().size).toBe(2);
    expect(runRepo.getByTask('test-project/hard-a')[0].model).toBe('codex:gpt-5.6-luna');
    expect(runRepo.getByTask('test-project/hard-b')[0].model).toBe('codex:gpt-5.6-luna');
    scheduler.stop();
    scheduler.cancelAll();
    delete process.env.FAKE_MODE;
  });

  it('dispatches two codex tasks in a single tick with two different lockFiles', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    for (const slug of ['t1', 't2']) {
      taskRepo.insert({ id: `test-project/${slug}`, projectId: 'test-project', slug, title: slug, level: 'hard', status: 'queued' });
    }
    process.env.FAKE_MODE = 'slow';
    const spawnedOpts: Array<{ lockFile?: string }> = [];
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    (fakeEngine as unknown as { id: 'codex' }).id = 'codex';
    const origSpawn = fakeEngine.spawn.bind(fakeEngine);
    fakeEngine.spawn = (opts) => {
      spawnedOpts.push({ lockFile: opts.lockFile });
      return origSpawn(opts);
    };

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['codex', fakeEngine]]));
    await scheduler.tick();

    expect(spawnedOpts).toHaveLength(2);
    expect(spawnedOpts[0].lockFile).toBeTruthy();
    expect(spawnedOpts[1].lockFile).toBeTruthy();
    expect(spawnedOpts[0].lockFile).not.toBe(spawnedOpts[1].lockFile);
    expect(spawnedOpts[0].lockFile).toMatch(/codex\.lock$/);
    expect(spawnedOpts[1].lockFile).toMatch(/codex\.lock2$/);

    scheduler.stop();
    scheduler.cancelAll();
    delete process.env.FAKE_MODE;
  });

  it('requeues without failing when run exits immediately with exit 1 and empty log under flock (lock_busy)', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/flock-busy-task', projectId: 'test-project', slug: 'flock-busy-task', title: 'Flock busy task', level: 'hard', status: 'queued' });

    // Mock an engine that simulates flock contention: exits 1 immediately without output
    const fakeEngine: Engine = {
      id: 'codex',
      family: () => 'codex',
      spawn: (opts) => {
        fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
        fs.writeFileSync(opts.logPath, '');
        return spawn('node', ['-e', 'process.exit(1)'], { stdio: 'ignore', detached: true });
      },
      detectQuota: () => ({ exhausted: false }),
      detectAuthError: () => ({ expired: false }),
      detectTransientError: () => false,
    };

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['codex', fakeEngine]]));

    await scheduler.tick();

    await vi.waitFor(() => {
      const task = taskRepo.get('test-project/flock-busy-task');
      expect(task?.status).toBe('queued');
      expect(task?.notBefore).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(task?.transientRetries).toBe(0);
    }, { timeout: 3000 });

    const runs = runRepo.getByTask('test-project/flock-busy-task');
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('crashed');
    expect(runs[0].reason).toBe('lock_busy');

    const events = eventRepo.getRecent(20);
    expect(events.some((e) => e.type === 'task.queued' && e.payload?.includes('lock_busy'))).toBe(true);
    expect(events.some((e) => e.type === 'task.failed')).toBe(false);

    scheduler.stop();
  });

  it('keeps third task queued when all profile slots are occupied', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    for (const slug of ['t1', 't2', 't3']) {
      taskRepo.insert({ id: `test-project/${slug}`, projectId: 'test-project', slug, title: slug, level: 'hard', status: 'queued' });
    }
    process.env.FAKE_MODE = 'slow';
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    (fakeEngine as unknown as { id: 'codex' }).id = 'codex';
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['codex', fakeEngine]]));

    await scheduler.tick();

    expect(scheduler.getRunning().size).toBe(2);
    expect(taskRepo.get('test-project/t1')?.status).toBe('running');
    expect(taskRepo.get('test-project/t2')?.status).toBe('running');
    expect(taskRepo.get('test-project/t3')?.status).toBe('queued');
    expect(taskRepo.get('test-project/t3')?.waitReason).toBe('profile_busy');

    scheduler.stop();
    scheduler.cancelAll();
    delete process.env.FAKE_MODE;
  });
});

describe('Checking after worker completion', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('moves a DONE task through checking to review and emits task.checking', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      status: 'checking',
      worktreePath: projectPath,
    });
    runRepo.insert({
      id: 'run-1',
      taskId: 'test-project/t1',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });
    db.prepare("UPDATE runs SET outcome = 'done' WHERE id = 'run-1'").run();

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>(), undefined, undefined, db,
    );

    await scheduler.runChecksForTask('test-project/t1', 'run-1');

    expect(taskRepo.get('test-project/t1')?.status).toBe('review');
    expect(eventRepo.getRecent(10).map((event) => event.type)).toContain('task.review_ready');
    scheduler.stop();
  });

  it('blocks triage with code changes and accepts a valid read-only analysis', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    const report = `Kết luận: lỗi\nĐộ lớn: vừa\nRepo: test-project\n\n### Tóm tắt yêu cầu\nBug\n\n### Bằng chứng\nĐã tái hiện\n\n### Nguyên nhân dự kiến\nCause\n\n### Hướng sửa đề xuất (và phương án nếu có nhiều)\nFix\n\n### Rủi ro / ảnh hưởng\nRisk\n\n### Câu hỏi cho tester (nếu thiếu thông tin)\nNone`;
    taskRepo.insert({ id: 'test-project/op-1-triage', projectId: 'test-project', slug: 'op-1-triage', title: 'Triage', status: 'checking', worktreePath: projectPath, baseRef: 'main', branch: 'main', doneReport: report });
    runRepo.insert({ id: 'triage-run-1', taskId: 'test-project/op-1-triage', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
    runRepo.finish('triage-run-1', 'done');
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map<string, Engine>(), undefined, undefined, db);
    await scheduler.runChecksForTask('test-project/op-1-triage', 'triage-run-1');
    expect(taskRepo.get('test-project/op-1-triage')?.status).toBe('done');

    taskRepo.insert({ id: 'test-project/op-2-triage', projectId: 'test-project', slug: 'op-2-triage', title: 'Triage', status: 'checking', worktreePath: projectPath, baseRef: 'main', branch: 'main', doneReport: report, diffStat: 'changed.ts | 1 +' });
    runRepo.insert({ id: 'triage-run-2', taskId: 'test-project/op-2-triage', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
    runRepo.finish('triage-run-2', 'done');
    await scheduler.runChecksForTask('test-project/op-2-triage', 'triage-run-2');
    expect(taskRepo.get('test-project/op-2-triage')?.status).toBe('blocked');
    expect(eventRepo.getRecent(20).some((event) => event.type === 'tracker.triage_invalid' && event.payload?.includes('code_changes'))).toBe(true);
    scheduler.stop();
  });

  it('blocks a triage task whose DONE report is missing the analysis format', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    taskRepo.insert({ id: 'test-project/bad-triage', projectId: 'test-project', slug: 'bad-triage', title: 'Triage', status: 'checking', worktreePath: projectPath, baseRef: 'main', branch: 'main', doneReport: 'DONE nhưng không có phân tích' });
    runRepo.insert({ id: 'bad-triage-run', taskId: 'test-project/bad-triage', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
    runRepo.finish('bad-triage-run', 'done');
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map<string, Engine>(), undefined, undefined, db);
    await scheduler.runChecksForTask('test-project/bad-triage', 'bad-triage-run');
    expect(taskRepo.get('test-project/bad-triage')?.status).toBe('blocked');
    expect(taskRepo.get('test-project/bad-triage')?.blockedReport).toContain('Kết luận thiếu hoặc không hợp lệ');
    scheduler.stop();
  });

  it('starts completion handling for every finished task before awaiting any completion', async () => {
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>(), undefined, undefined, db,
    );
    const schedulerInternal = scheduler as unknown as {
      isProcessAlive: (pid: number | null, pidStart?: number | null) => boolean;
      running: Map<string, unknown>;
      checkRunningTasks: () => Promise<void>;
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
    };
    const firstCompletion = new Promise<void>(() => {});
    const completionSpy = vi.spyOn(schedulerInternal, 'handleRunCompletion')
      .mockImplementation((taskId) => taskId === 'test-project/t1' ? firstCompletion : Promise.resolve());
    vi.spyOn(schedulerInternal, 'isProcessAlive').mockReturnValue(false);

    const runningTask = { pid: 999999, pidStart: null };
    schedulerInternal.running.set('test-project/t1', runningTask);
    schedulerInternal.running.set('test-project/t2', runningTask);

    const checkPromise = schedulerInternal.checkRunningTasks();
    await vi.waitFor(() => {
      expect(completionSpy).toHaveBeenCalledWith('test-project/t2', runningTask);
    });

    expect(completionSpy).toHaveBeenCalledTimes(2);
    scheduler.stop();
    void checkPromise;
  });

  it('logs error on completion failure only when not stopped', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    fs.mkdirSync(path.join(projectPath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.agenthub', 'DONE'), 'done');

    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      status: 'running',
      worktreePath: projectPath,
    });
    runRepo.insert({
      id: 'run-1',
      taskId: 'test-project/t1',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>(), undefined, undefined, db,
    );

    const fakeRt: unknown = {
      runId: 'run-1',
      taskId: 'test-project/t1',
      pid: 999999,
      pidStart: null,
      engine: { detectQuota: () => ({ exhausted: false }) },
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
      projectId: 'test-project',
      startTime: Date.now() - 5000,
      timeoutMs: 60000,
      timeoutAt: Date.now() + 60000,
      retryCount: 0,
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      activitySource: 'terminal',
      activityCheckedAt: Date.now(),
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
    };

    const schedulerInternal = scheduler as unknown as {
      isProcessAlive: (pid: number | null, pidStart?: number | null) => boolean;
      recoverFinishedWork: (run: unknown) => boolean;
      running: Map<string, unknown>;
      checkRunningTasks: () => Promise<void>;
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
    };

    vi.spyOn(schedulerInternal, 'isProcessAlive').mockReturnValue(false);
    vi.spyOn(schedulerInternal, 'recoverFinishedWork').mockReturnValue(false);
    const completionSpy = vi.spyOn(schedulerInternal, 'handleRunCompletion');
    const checkSpy = vi.spyOn(scheduler, 'runChecksForTask').mockRejectedValue(new Error('simulated check error'));

    try {
      // Case 1: scheduler is running (not stopped) -> console.error is called
      schedulerInternal.running.set('test-project/t1', fakeRt);
      await schedulerInternal.checkRunningTasks();
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          '[scheduler] handleRunCompletion failed for test-project/t1:',
          expect.any(Error),
        );
      });
      await completionSpy.mock.results[0]?.value;

      // Case 2: scheduler is stopped -> console.error is NOT called
      errorSpy.mockClear();
      checkSpy.mockImplementationOnce(async () => {
        scheduler.stop();
        throw new Error('simulated check error');
      });
      taskRepo.update('test-project/t1', { status: 'running' });
      db.prepare("UPDATE runs SET outcome = NULL WHERE id = 'run-1'").run();
      schedulerInternal.running.set('test-project/t1', fakeRt);
      await schedulerInternal.checkRunningTasks();
      await vi.waitFor(() => {
        expect(checkSpy).toHaveBeenCalledTimes(2);
      });
      await completionSpy.mock.results[1]?.value;

      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
      errorSpy.mockRestore();
    }
  });

  it('does not re-check queued task when an old worker finishes after changes_requested until a new worker completes', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    const worktreePath = path.join(tmpDir, 'worktree-live-changes');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });

    taskRepo.insert({
      id: 'test-project/live-changes',
      projectId: 'test-project',
      slug: 'live-changes',
      title: 'Live Changes',
      body: 'Task body',
      status: 'review',
      worktreePath,
    });
    runRepo.insert({
      id: 'run-old',
      taskId: 'test-project/live-changes',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>(), undefined, undefined, db,
    );
    const checkSpy = vi.fn(async () => ({ passed: true, failed: [], results: [] }));
    scheduler.checkRunner = { run: checkSpy };

    // 1. Reviewer rejects task: changes_requested -> queued
    scheduler.reviewTask('test-project/live-changes', 'changes_requested', 'Please fix issues');
    expect(taskRepo.get('test-project/live-changes')?.status).toBe('queued');

    // 2. Old worker process now completes and writes DONE
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'old worker done');
    const schedulerInternal = scheduler as unknown as {
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
      running: Map<string, unknown>;
    };
    const fakeRtOld = {
      runId: 'run-old',
      taskId: 'test-project/live-changes',
      pid: 999991,
      pidStart: null,
      engine: { detectQuota: () => ({ exhausted: false }), detectAuthError: () => ({ expired: false }), detectTransientError: () => false },
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
      projectId: 'test-project',
      startTime: Date.now() - 10000,
      timeoutMs: 60000,
      timeoutAt: Date.now() + 60000,
      retryCount: 0,
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      activitySource: 'terminal',
      activityCheckedAt: Date.now(),
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
    };

    await schedulerInternal.handleRunCompletion('test-project/live-changes', fakeRtOld);

    // Verify: Task MUST REMAIN queued, checks MUST NOT run, no review_ready event
    expect(taskRepo.get('test-project/live-changes')?.status).toBe('queued');
    expect(checkSpy).not.toHaveBeenCalled();
    expect(eventRepo.getRecent(20).filter((e) => e.taskId === 'test-project/live-changes' && (e.type === 'task.review_ready' || e.type === 'task.checking'))).toHaveLength(0);
    expect(runRepo.get('run-old')?.outcome).toBe('crashed');

    // 3. Now a new worker run starts for the queued task
    taskRepo.update('test-project/live-changes', { status: 'running' });
    runRepo.insert({
      id: 'run-new',
      taskId: 'test-project/live-changes',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });
    const fakeRtNew = {
      ...fakeRtOld,
      runId: 'run-new',
      pid: 999992,
      startTime: Date.now() - 2000,
    };
    schedulerInternal.running.set('test-project/live-changes', fakeRtNew);
    // Write fresh DONE marker
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'new worker done');

    await schedulerInternal.handleRunCompletion('test-project/live-changes', fakeRtNew);

    // Verify: Now checks run, task goes to review, review_ready is emitted
    expect(taskRepo.get('test-project/live-changes')?.status).toBe('review');
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(eventRepo.getRecent(20).filter((e) => e.taskId === 'test-project/live-changes' && e.type === 'task.review_ready')).toHaveLength(1);
    expect(runRepo.get('run-new')?.outcome).toBe('done');

    scheduler.stop();
  });

  it('does not check or emit review_ready when an older worker finishes while a newer worker is actively running', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    const worktreePath = path.join(tmpDir, 'worktree-live-overlap');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });

    taskRepo.insert({
      id: 'test-project/live-overlap',
      projectId: 'test-project',
      slug: 'live-overlap',
      title: 'Live Overlap',
      status: 'running',
      worktreePath,
    });
    runRepo.insert({
      id: 'run-old-overlap',
      taskId: 'test-project/live-overlap',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });
    runRepo.insert({
      id: 'run-active-overlap',
      taskId: 'test-project/live-overlap',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>(), undefined, undefined, db,
    );
    const checkSpy = vi.fn(async () => ({ passed: true, failed: [], results: [] }));
    scheduler.checkRunner = { run: checkSpy };

    const schedulerInternal = scheduler as unknown as {
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
      running: Map<string, unknown>;
    };

    const fakeRtActive = {
      runId: 'run-active-overlap',
      taskId: 'test-project/live-overlap',
      pid: 999994,
      pidStart: null,
      engine: { detectQuota: () => ({ exhausted: false }), detectAuthError: () => ({ expired: false }), detectTransientError: () => false },
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
      projectId: 'test-project',
      startTime: Date.now() - 1000,
      timeoutMs: 60000,
      timeoutAt: Date.now() + 60000,
      retryCount: 0,
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      activitySource: 'terminal',
      activityCheckedAt: Date.now(),
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
    };
    // The newer worker is registered as running in scheduler
    schedulerInternal.running.set('test-project/live-overlap', fakeRtActive);

    const fakeRtOld = {
      ...fakeRtActive,
      runId: 'run-old-overlap',
      pid: 999993,
      startTime: Date.now() - 10000,
    };
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'done');

    // Old worker finishes
    await schedulerInternal.handleRunCompletion('test-project/live-overlap', fakeRtOld);

    // Verify: Task remains running, the active worker is NOT deleted from running map, checks do not run
    expect(taskRepo.get('test-project/live-overlap')?.status).toBe('running');
    expect(schedulerInternal.running.get('test-project/live-overlap')).toBe(fakeRtActive);
    expect(checkSpy).not.toHaveBeenCalled();
    expect(eventRepo.getRecent(20).filter((e) => e.taskId === 'test-project/live-overlap' && e.type === 'task.review_ready')).toHaveLength(0);
    expect(runRepo.get('run-old-overlap')?.outcome).toBe('crashed');
    expect(runRepo.get('run-active-overlap')?.outcome).toBeNull();

    scheduler.stop();
  });

  it('ignores stale completion before reference modifications can block the retried task', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    const worktreePath = path.join(tmpDir, 'worktree-stale-reference');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    const referencePath = path.join(tmpDir, 'reference.txt');
    fs.writeFileSync(referencePath, 'before');

    taskRepo.insert({
      id: 'test-project/stale-reference',
      projectId: 'test-project',
      slug: 'stale-reference',
      title: 'Stale Reference',
      status: 'review',
      body: 'Task body',
      worktreePath,
    });
    runRepo.insert({
      id: 'run-stale-reference',
      taskId: 'test-project/stale-reference',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>(), undefined, undefined, db,
    );
    const schedulerInternal = scheduler as unknown as {
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
    };

    scheduler.reviewTask('test-project/stale-reference', 'changes_requested', 'Retry this task');
    fs.writeFileSync(referencePath, 'after');
    await schedulerInternal.handleRunCompletion('test-project/stale-reference', {
      runId: 'run-stale-reference',
      taskId: 'test-project/stale-reference',
      pid: 999996,
      pidStart: null,
      engine: { detectQuota: () => ({ exhausted: false }) },
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
      projectId: 'test-project',
      startTime: Date.now() - 5000,
      timeoutMs: 60000,
      timeoutAt: Date.now() + 60000,
      retryCount: 0,
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      activitySource: 'terminal',
      activityCheckedAt: Date.now(),
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
      referenceSnapshots: [{ kind: 'file', name: 'reference', path: referencePath, mtimeMs: 0, size: 6 }],
    });

    expect(taskRepo.get('test-project/stale-reference')?.status).toBe('queued');
    expect(runRepo.get('run-stale-reference')?.outcome).toBe('crashed');
    expect(runRepo.get('run-stale-reference')?.reason).toBe('stale_worker');
    expect(fs.existsSync(path.join(worktreePath, '.agenthub', 'BLOCKED'))).toBe(false);
    expect(eventRepo.getRecent(20).filter((event) => event.taskId === 'test-project/stale-reference' && event.type === 'task.blocked')).toHaveLength(0);

    scheduler.stop();
  });

  it('does not check or emit review_ready when worker finishes on a done task during live execution', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    const worktreePath = path.join(tmpDir, 'worktree-live-done');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'done');

    taskRepo.insert({
      id: 'test-project/live-done',
      projectId: 'test-project',
      slug: 'live-done',
      title: 'Live Done',
      status: 'done',
      worktreePath,
    });
    runRepo.insert({
      id: 'run-done-live',
      taskId: 'test-project/live-done',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
    });

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>(), undefined, undefined, db,
    );
    const checkSpy = vi.fn(async () => ({ passed: true, failed: [], results: [] }));
    scheduler.checkRunner = { run: checkSpy };

    const schedulerInternal = scheduler as unknown as {
      handleRunCompletion: (taskId: string, rt: unknown) => Promise<void>;
      running: Map<string, unknown>;
    };

    const fakeRt = {
      runId: 'run-done-live',
      taskId: 'test-project/live-done',
      pid: 999995,
      pidStart: null,
      engine: { detectQuota: () => ({ exhausted: false }), detectAuthError: () => ({ expired: false }), detectTransientError: () => false },
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
      projectId: 'test-project',
      startTime: Date.now() - 5000,
      timeoutMs: 60000,
      timeoutAt: Date.now() + 60000,
      retryCount: 0,
      lastOutputAt: Date.now(),
      lastActivityAt: Date.now(),
      activitySource: 'terminal',
      activityCheckedAt: Date.now(),
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
    };

    await schedulerInternal.handleRunCompletion('test-project/live-done', fakeRt);

    expect(taskRepo.get('test-project/live-done')?.status).toBe('done');
    expect(checkSpy).not.toHaveBeenCalled();
    expect(eventRepo.getRecent(20).filter((e) => e.taskId === 'test-project/live-done' && e.type === 'task.review_ready')).toHaveLength(0);

    scheduler.stop();
  });
});

describe('Checking queue lifecycle', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  beforeEach(() => createTestProject(path.join(tmpDir, 'repo')));

  function makeCheckingScheduler(maxConcurrent = 2) {
    config.checks.maxConcurrent = maxConcurrent;
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map(), undefined, undefined, db);
    return scheduler as Scheduler & { checkRunner: { run: (...args: unknown[]) => Promise<unknown> } };
  }

  function addCheckTask(slug: string, worktreePath = path.join(tmpDir, slug), status: 'checking' | 'done' | 'cancelled' = 'checking') {
    fs.mkdirSync(worktreePath, { recursive: true });
    taskRepo.insert({ id: `test-project/${slug}`, projectId: 'test-project', slug, title: slug, status, worktreePath });
    if (status === 'checking') {
      runRepo.insert({ id: `run-${slug}`, taskId: `test-project/${slug}`, engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
      runRepo.finish(`run-${slug}`, 'done');
    }
  }

  it('runs at most maxConcurrent checks and starts the FIFO third after one completes', async () => {
    addCheckTask('c1'); addCheckTask('c2'); addCheckTask('c3');
    const scheduler = makeCheckingScheduler(2);
    let active = 0; let peak = 0;
    const releases: Array<() => void> = [];
    scheduler.checkRunner = { run: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return { passed: true, failed: [], results: [] };
    } };

    const first = scheduler.runChecksForTask('test-project/c1', 'run-c1');
    const second = scheduler.runChecksForTask('test-project/c2', 'run-c2');
    const third = scheduler.runChecksForTask('test-project/c3', 'run-c3');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peak).toBe(2);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peak).toBe(2);
    releases.shift()!(); releases.shift()!();
    await Promise.all([first, second, third]);
    scheduler.stop();
  });

  it('deduplicates the same runId but queues a newer runId after the old run releases the worktree', async () => {
    addCheckTask('same');
    runRepo.insert({ id: 'old', taskId: 'test-project/same', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
    runRepo.insert({ id: 'new', taskId: 'test-project/same', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
    runRepo.finish('old', 'done');
    runRepo.finish('new', 'done');
    const scheduler = makeCheckingScheduler();
    let calls = 0; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    scheduler.checkRunner = { run: async () => { calls++; await gate; return { passed: true, failed: [], results: [] }; } };
    const old = scheduler.runChecksForTask('test-project/same', 'old');
    const duplicate = scheduler.runChecksForTask('test-project/same', 'old');
    expect(duplicate).toBeDefined();
    const newer = scheduler.runChecksForTask('test-project/same', 'new');
    release();
    await vi.waitFor(() => expect(calls).toBe(1));
    release = () => {};
    await Promise.all([old, newer]);
    expect(calls).toBe(1);
    expect(taskRepo.get('test-project/same')?.status).toBe('review');
    scheduler.stop();
  });

  it('does not run checks concurrently for the same worktree', async () => {
    const worktree = path.join(tmpDir, 'shared');
    addCheckTask('w1', worktree); addCheckTask('w2', worktree);
    const scheduler = makeCheckingScheduler(2);
    let active = 0; let peak = 0; const releases: Array<() => void> = [];
    scheduler.checkRunner = { run: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--; return { passed: true, failed: [], results: [] };
    } };
    const first = scheduler.runChecksForTask('test-project/w1', 'run-w1');
    const second = scheduler.runChecksForTask('test-project/w2', 'run-w2');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(peak).toBe(1);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await Promise.all([first, second]);
    scheduler.stop();
  });

  it('keeps a cancelled task unchanged when an old check completes', async () => {
    addCheckTask('cancel');
    const scheduler = makeCheckingScheduler();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    scheduler.checkRunner = { run: async () => { await gate; return { passed: true, failed: [], results: [] }; } };
    const check = scheduler.runChecksForTask('test-project/cancel', 'run-cancel');
    await vi.waitFor(() => expect(taskRepo.get('test-project/cancel')?.status).toBe('checking'));
    scheduler.cancelTask('test-project/cancel');
    release();
    await check;
    expect(taskRepo.get('test-project/cancel')?.status).toBe('cancelled');
    scheduler.stop();
  });

  it('never changes done or cancelled tasks when recovery asks for checks', async () => {
    addCheckTask('done', path.join(tmpDir, 'done'), 'done');
    addCheckTask('cancelled', path.join(tmpDir, 'cancelled'), 'cancelled');
    const scheduler = makeCheckingScheduler();
    const runner = scheduler as unknown as { checkRunner: { run: (...args: unknown[]) => Promise<unknown> } };
    runner.checkRunner = { run: async () => { throw new Error('must not run'); } };
    await scheduler.runChecksForTask('test-project/done', 'run-done');
    await scheduler.runChecksForTask('test-project/cancelled', 'run-cancelled');
    await scheduler.recoverCheckingTasks();
    expect(taskRepo.get('test-project/done')?.status).toBe('done');
    expect(taskRepo.get('test-project/cancelled')?.status).toBe('cancelled');
    scheduler.stop();
  });

  it('does not re-check a stale checking task without the completed worker run', async () => {
    addCheckTask('stale', path.join(tmpDir, 'stale'), 'review');
    taskRepo.update('test-project/stale', { status: 'checking' });
    const scheduler = makeCheckingScheduler();
    const run = vi.fn(async () => ({ passed: true, failed: [], results: [] }));
    scheduler.checkRunner = { run };

    await scheduler.recoverCheckingTasks();

    expect(run).not.toHaveBeenCalled();
    expect(taskRepo.get('test-project/stale')?.status).toBe('checking');
    scheduler.stop();
  });

  it('rejects an unknown or stale run and a task that is still running', async () => {
    addCheckTask('strict');
    const scheduler = makeCheckingScheduler();
    const run = vi.fn(async () => ({ passed: true, failed: [], results: [] }));
    scheduler.checkRunner = { run };

    await scheduler.runChecksForTask('test-project/strict', 'missing-run');
    expect(run).not.toHaveBeenCalled();

    taskRepo.update('test-project/strict', { status: 'running' });
    await scheduler.runChecksForTask('test-project/strict', 'run-strict');
    expect(run).not.toHaveBeenCalled();

    taskRepo.update('test-project/strict', { status: 'checking' });
    runRepo.insert({ id: 'stale-run', taskId: 'test-project/strict', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', outcome: 'crashed' });
    await scheduler.runChecksForTask('test-project/strict', 'stale-run');
    expect(run).not.toHaveBeenCalled();

    runRepo.insert({ id: 'completed-strict', taskId: 'test-project/strict', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
    runRepo.finish('completed-strict', 'done');
    runRepo.insert({ id: 'active-strict', taskId: 'test-project/strict', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1' });
    await scheduler.runChecksForTask('test-project/strict', 'completed-strict');
    expect(run).not.toHaveBeenCalled();
    scheduler.stop();
  });
});

describe('Crash recovery on startup', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('marks running runs as crashed and re-queues tasks on startup', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      status: 'running',
    });

    // Insert a run with a dead pid
    runRepo.insert({
      id: 'run-1',
      taskId: 'test-project/t1',
      engine: 'agy',
      model: 'gemini-3.8-flash-medium',
      profileName: 'p1',
      pid: 999999, // should be dead
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    // Start triggers recovery
    scheduler.start();

    const run = runRepo.get('run-1')!;
    expect(run.outcome).toBe('crashed');

    const task = taskRepo.get('test-project/t1')!;
    expect(task.status).toBe('queued');
    expect(task.resume).toBe(1);

    scheduler.stop();
  });

  it('keeps a done task terminal when daemon recovery finds an old worker row', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    fs.mkdirSync(path.join(projectPath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.agenthub', 'DONE'), 'old done');
    taskRepo.insert({ id: 'test-project/done-old', projectId: 'test-project', slug: 'done-old', title: 'Done', status: 'done', worktreePath: projectPath });
    runRepo.insert({ id: 'run-done-old', taskId: 'test-project/done-old', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: 999999 });

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map());
    scheduler.start();

    expect(taskRepo.get('test-project/done-old')?.status).toBe('done');
    expect(eventRepo.getRecent(20).filter((event) => event.type === 'task.review_ready' && event.taskId === 'test-project/done-old')).toHaveLength(0);
    scheduler.stop();
  });

  it('does not treat a stale marker on a queued task as a new completion', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    fs.mkdirSync(path.join(projectPath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.agenthub', 'DONE'), 'stale done');
    taskRepo.insert({ id: 'test-project/queued-old', projectId: 'test-project', slug: 'queued-old', title: 'Queued', status: 'queued', worktreePath: projectPath });
    runRepo.insert({ id: 'run-queued-old', taskId: 'test-project/queued-old', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: 999999 });

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map());
    scheduler.start();

    expect(taskRepo.get('test-project/queued-old')?.status).toBe('queued');
    expect(eventRepo.getRecent(20).filter((event) => event.type === 'task.review_ready' && event.taskId === 'test-project/queued-old')).toHaveLength(0);
    scheduler.stop();
  });

  it('does not let an older worker run claim a marker when a newer run is active', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    fs.mkdirSync(path.join(projectPath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.agenthub', 'DONE'), 'stale done');
    taskRepo.insert({ id: 'test-project/overlap', projectId: 'test-project', slug: 'overlap', title: 'Overlap', status: 'running', worktreePath: projectPath });
    runRepo.insert({ id: 'run-old-overlap', taskId: 'test-project/overlap', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: 999998 });
    runRepo.insert({ id: 'run-new-overlap', taskId: 'test-project/overlap', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: 999997 });

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map());
    scheduler.start();

    expect(taskRepo.get('test-project/overlap')?.status).toBe('queued');
    expect(eventRepo.getRecent(20).filter((event) => event.type === 'task.review_ready' && event.taskId === 'test-project/overlap')).toHaveLength(0);
    scheduler.stop();
  });

  it('recovers a newer DONE marker as done and restarts checks', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    fs.mkdirSync(path.join(projectPath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.agenthub', 'DONE'), 'done');
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/done', projectId: 'test-project', slug: 'done', title: 'Done', status: 'running', worktreePath: projectPath });
    runRepo.insert({ id: 'run-done', taskId: 'test-project/done', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: 999999 });
    db.prepare("UPDATE runs SET startedAt = datetime('now', '-1 minute') WHERE id = 'run-done'").run();

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map(), undefined, undefined, db);
    scheduler.start();
    expect(runRepo.get('run-done')?.outcome).toBe('done');
    expect(taskRepo.get('test-project/done')?.status).toBe('checking');
    await vi.waitFor(() => expect(taskRepo.get('test-project/done')?.status).toBe('review'));
    scheduler.stop();
  });

  it('recovers a newer BLOCKED marker without marking the run crashed', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    fs.mkdirSync(path.join(projectPath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.agenthub', 'BLOCKED'), 'blocked');
    taskRepo.insert({ id: 'test-project/blocked', projectId: 'test-project', slug: 'blocked', title: 'Blocked', status: 'running', worktreePath: projectPath });
    runRepo.insert({ id: 'run-blocked', taskId: 'test-project/blocked', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: 999999 });
    db.prepare("UPDATE runs SET startedAt = datetime('now', '-1 minute') WHERE id = 'run-blocked'").run();

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map());
    scheduler.start();
    expect(runRepo.get('run-blocked')).toMatchObject({ outcome: 'done' });
    expect(taskRepo.get('test-project/blocked')?.status).toBe('blocked');
    scheduler.stop();
  });

  it('re-queues progress after a dead worker without increasing attempt', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    execFileSync('git', ['checkout', '-b', 'agenthub/progress'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'progress.txt'), 'progress');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'progress'], { cwd: projectPath, env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' } });
    taskRepo.insert({ id: 'test-project/progress', projectId: 'test-project', slug: 'progress', title: 'Progress', status: 'running', branch: 'agenthub/progress', worktreePath: projectPath });
    runRepo.insert({ id: 'run-progress', taskId: 'test-project/progress', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: 999999 });
    db.prepare("UPDATE runs SET startedAt = datetime('now', '-1 minute') WHERE id = 'run-progress'").run();

    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, new Map());
    scheduler.start();
    expect(runRepo.get('run-progress')).toMatchObject({ outcome: 'crashed', reason: 'resume_after_progress' });
    expect(taskRepo.get('test-project/progress')).toMatchObject({ status: 'queued', resume: 1, attempt: 0 });
    scheduler.stop();
  });
});

describe('Worktree creation', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('creates worktree with correct branch and base', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    taskRepo.insert({
      id: 'test-project/t1',
      projectId: 'test-project',
      slug: 't1',
      title: 'Task 1',
      body: 'test body',
      status: 'queued',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    const task = taskRepo.get('test-project/t1')!;
    expect(task.worktreePath).toBeTruthy();
    expect(task.branch).toBe('agenthub/t1');
    expect(fs.existsSync(task.worktreePath!)).toBe(true);

    // Check that .agenthub/task.md was created
    expect(fs.existsSync(path.join(task.worktreePath!, '.agenthub', 'task.md'))).toBe(true);

    scheduler.stop();
  });
});

describe('Env file generation', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('generates env file with correct slot substitution', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    // Set envTemplate
    const envTemplate = JSON.stringify({
      file: '.env',
      vars: {
        API_PORT: '41{slot}0',
        DB_NAME: 'test_{slug_underscored}',
      },
    });
    db.prepare('UPDATE projects SET envTemplate = ? WHERE id = ?').run(envTemplate, 'test-project');

    // Create .env.example in project
    fs.writeFileSync(path.join(projectPath, '.env.example'), 'EXISTING=value\n');

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    taskRepo.insert({
      id: 'test-project/my-task',
      projectId: 'test-project',
      slug: 'my-task',
      title: 'Task 1',
      body: 'test body',
      status: 'queued',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    const task = taskRepo.get('test-project/my-task')!;
    expect(task.worktreePath).toBeTruthy();

    const envPath = path.join(task.worktreePath!, '.env');
    expect(fs.existsSync(envPath)).toBe(true);

    const envContent = fs.readFileSync(envPath, 'utf-8');
    // Slot should be 1 (first slot available)
    expect(envContent).toContain('API_PORT=4110');
    expect(envContent).toContain('DB_NAME=test_my_task');

    scheduler.stop();
  });

  it('wakes waiting_quota tasks on eventBus quota.cleared or profile.updated', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    quotaMarkRepo.mark('p1', 'gemini', Math.floor(Date.now() / 1000) + 3600);

    taskRepo.insert({
      id: 'test-project/waiting-t1',
      projectId: 'test-project',
      slug: 'waiting-t1',
      title: 'Waiting Task',
      status: 'waiting_quota',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    expect(taskRepo.get('test-project/waiting-t1')?.status).toBe('waiting_quota');

    scheduler.getEventBus().emit('claude.quota_available');
    await scheduler.tick();
    expect(taskRepo.get('test-project/waiting-t1')?.status).toBe('waiting_quota');
    quotaMarkRepo.clear('p1', 'gemini');
    scheduler.getEventBus().emit('claude.quota_available');
    await scheduler.tick();
    // Task woke up and was immediately scheduled to run because p1 is available
    expect(['queued', 'running']).toContain(taskRepo.get('test-project/waiting-t1')?.status);

    scheduler.stop();
  });

  it('re-queues tasks left in waiting_quota by a previous daemon once disk is ok (restart loses in-memory disk waiters)', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    taskRepo.insert({
      id: 'test-project/disk-waiter',
      projectId: 'test-project',
      slug: 'disk-waiter',
      title: 'Disk waiter from previous daemon',
      status: 'waiting_quota',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();
    expect(['queued', 'running']).toContain(taskRepo.get('test-project/disk-waiter')?.status);

    scheduler.stop();
  });

  it('uses gemini-3.8-flash-high for hard level by default and opus only when specified in modelChain', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });

    taskRepo.insert({
      id: 'test-project/hard-t1',
      projectId: 'test-project',
      slug: 'hard-t1',
      title: 'Hard Task',
      level: 'hard',
      status: 'queued',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    const runs = runRepo.getByTask('test-project/hard-t1');
    expect(runs.length).toBe(1);
    expect(runs[0].model).toBe('gemini-3.8-flash-high');

    scheduler.stop();
  });

  it('skips unknown models, emits task.model_skipped, and fails when none are usable', async () => {
    const projectPath = path.join(tmpDir, 'repo-model-skip');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    taskRepo.insert({
      id: 'test-project/skip-known', projectId: 'test-project', slug: 'skip-known', title: 'Skip unknown',
      level: 'easy', status: 'queued', modelChain: JSON.stringify(['made-up-model', 'gemini-3.8-flash-medium']),
    });
    taskRepo.insert({
      id: 'test-project/skip-all', projectId: 'test-project', slug: 'skip-all', title: 'No usable model',
      level: 'easy', status: 'queued', modelChain: JSON.stringify(['made-up-model']),
    });
    const skipped: unknown[] = [];
    eventRepo.getRecent(100);
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]));

    scheduler.getEventBus().on('task.model_skipped', (_taskId, payload) => skipped.push(payload));
    await scheduler.tick();

    expect(runRepo.getByTask('test-project/skip-known')[0]?.model).toBe('gemini-3.8-flash-medium');
    expect(taskRepo.get('test-project/skip-all')?.status).toBe('failed');
    expect(skipped).toHaveLength(2);
    expect(eventRepo.getRecent(100).some((event) => event.type === 'task.failed' && event.taskId === 'test-project/skip-all')).toBe(true);
    scheduler.stop();
  });

  it('fails clearly when all profiles have a non-ok authState', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({
      name: 'unverified-prof',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/unverified',
      email: 'unverified@example.com',
      enabled: 1,
      authState: 'needs_verification',
    });

    taskRepo.insert({
      id: 'test-project/verify-t1',
      projectId: 'test-project',
      slug: 'verify-t1',
      title: 'Task 1',
      level: 'easy',
      status: 'queued',
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
    );

    await scheduler.tick();

    // Since the only enabled profile has a non-ok authState, task cannot run.
    expect(taskRepo.get('test-project/verify-t1')?.status).toBe('failed');
    expect(runRepo.getByTask('test-project/verify-t1').length).toBe(0);

    scheduler.stop();
  });
});

describe('Profile selection: email load spreading and remaining quota priority', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('selects g2 instead of g1 when chinh and g1 share the same email and chinh has 1 active run', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'chinh', engine: 'agy', kind: 'isolated', home: '/tmp/chinh', email: 'user@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: '/tmp/g1', email: 'user@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'g2', engine: 'agy', kind: 'isolated', home: '/tmp/g2', email: 'other@example.com', enabled: 1 });

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      taskRepo.insert({ id: 'test-project/t-running', projectId: 'test-project', slug: 't-running', title: 'Task Running', status: 'running' });
      runRepo.insert({ id: 'run-chinh', taskId: 'test-project/t-running', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'chinh', pid: child.pid });

      taskRepo.insert({ id: 'test-project/t-new', projectId: 'test-project', slug: 't-new', title: 'Task New', status: 'queued' });

      const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
      const scheduler = new Scheduler(
        config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
        new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, db,
      );

      (scheduler as unknown as { running: Map<string, unknown> }).running.set('test-project/t-running', {
        runId: 'run-chinh',
        taskId: 'test-project/t-running',
        pid: child.pid,
        pidStart: null,
        profileName: 'chinh',
        model: 'gemini-3.8-flash-medium',
        engine: fakeEngine,
        startTime: Date.now(),
        timeoutMs: 300_000,
        timeoutAt: Date.now() + 300_000,
        retryCount: 0,
        projectId: 'test-project',
        lastOutputAt: Date.now(),
        lastActivityAt: Date.now(),
        activitySource: 'log',
        activityCheckedAt: 0,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
      });

      await scheduler.tick();

      const runs = runRepo.getByTask('test-project/t-new');
      expect(runs.length).toBe(1);
      expect(runs[0].profileName).toBe('g2');

      scheduler.stop();
    } finally {
      child.kill();
    }
  });

  it('selects profile with higher remaining quota when two profiles with different emails are both idle', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: 'email1@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: 'email2@example.com', enabled: 1 });

    // p1 has 30% quota, p2 has 80% quota for Gemini Models
    db.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p1', 'Gemini Models', '5h', 30, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));
    db.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p2', 'Gemini Models', '5h', 80, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
      undefined, undefined, db,
    );

    await scheduler.tick();

    const runs = runRepo.getByTask('test-project/t1');
    expect(runs.length).toBe(1);
    expect(runs[0].profileName).toBe('p2');

    scheduler.stop();
  });

  it('does not select a profile with active quota mark even if it is idle', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: 'email1@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: 'email2@example.com', enabled: 1 });

    // p2 has higher quota recorded (80%), but has active quota mark
    db.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p1', 'Gemini Models', '5h', 30, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));
    db.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p2', 'Gemini Models', '5h', 80, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));

    const quotaService = new QuotaService(quotaMarkRepo, profileRepo);
    quotaService.mark('p2', 'gemini', 3600, 'quota mark active');

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines,
      undefined, undefined, db,
    );

    await scheduler.tick();

    const runs = runRepo.getByTask('test-project/t1');
    expect(runs.length).toBe(1);
    expect(runs[0].profileName).toBe('p1');

    scheduler.stop();
  });

  it('defaults to 50 when quota usage is missing and prefers profile with higher quota', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p-no-data', engine: 'agy', kind: 'isolated', home: '/tmp/pnd', email: 'a@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'p-high', engine: 'agy', kind: 'isolated', home: '/tmp/ph', email: 'b@example.com', enabled: 1 });

    // p-high has 70% (> 50 default), p-no-data has no row
    db.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p-high', 'Gemini Models', '5h', 70, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, db,
    );

    await scheduler.tick();

    const runs = runRepo.getByTask('test-project/t1');
    expect(runs[0].profileName).toBe('p-high');

    scheduler.stop();
  });

  it('defaults to 50 when quota usage is missing and prefers it over lower quota profile', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p-low', engine: 'agy', kind: 'isolated', home: '/tmp/pl', email: 'a@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'p-no-data', engine: 'agy', kind: 'isolated', home: '/tmp/pnd', email: 'b@example.com', enabled: 1 });

    // p-low has 30% (< 50 default), p-no-data has no row
    db.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('p-low', 'Gemini Models', '5h', 30, Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000));

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, db,
    );

    await scheduler.tick();

    const runs = runRepo.getByTask('test-project/t1');
    expect(runs[0].profileName).toBe('p-no-data');

    scheduler.stop();
  });

  it('treats profile name as email when email is null', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: '/tmp/p1', email: null, enabled: 1 });
    profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: '/tmp/p2', email: null, enabled: 1 });

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      taskRepo.insert({ id: 'test-project/t-running', projectId: 'test-project', slug: 't-running', title: 'Task Running', status: 'running' });
      runRepo.insert({ id: 'run-p1', taskId: 'test-project/t-running', engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'p1', pid: child.pid });

      taskRepo.insert({ id: 'test-project/t-new', projectId: 'test-project', slug: 't-new', title: 'Task New', status: 'queued' });

      const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
      const scheduler = new Scheduler(
        config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
        new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, db,
      );

      (scheduler as unknown as { running: Map<string, unknown> }).running.set('test-project/t-running', {
        runId: 'run-p1',
        taskId: 'test-project/t-running',
        pid: child.pid,
        pidStart: null,
        profileName: 'p1',
        model: 'gemini-3.8-flash-medium',
        engine: fakeEngine,
        startTime: Date.now(),
        timeoutMs: 300_000,
        timeoutAt: Date.now() + 300_000,
        retryCount: 0,
        projectId: 'test-project',
        lastOutputAt: Date.now(),
        lastActivityAt: Date.now(),
        activitySource: 'log',
        activityCheckedAt: 0,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
      });

      await scheduler.tick();

      const runs = runRepo.getByTask('test-project/t-new');
      expect(runs[0].profileName).toBe('p2');

      scheduler.stop();
    } finally {
      child.kill();
    }
  });

  it('preserves existing order when both email runs and remaining quota tie', async () => {
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);

    profileRepo.upsert({ name: 'alpha', engine: 'agy', kind: 'isolated', home: '/tmp/alpha', email: 'same@example.com', enabled: 1 });
    profileRepo.upsert({ name: 'beta', engine: 'agy', kind: 'isolated', home: '/tmp/beta', email: 'other@example.com', enabled: 1 });

    taskRepo.insert({ id: 'test-project/t1', projectId: 'test-project', slug: 't1', title: 'Task 1', status: 'queued' });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, db,
    );

    await scheduler.tick();

    const runs = runRepo.getByTask('test-project/t1');
    expect(runs[0].profileName).toBe('alpha');

    scheduler.stop();
  });
});


describe('Run metrics after a normal worker exit', () => {
  beforeEach(setupTestEnv);
  afterEach(teardownTestEnv);

  it('records Codex token usage before handing the DONE marker to recovery', async () => {
    const { RunMetricsRepo } = await import('../src/db/index.js');
    const projectPath = path.join(tmpDir, 'repo');
    createTestProject(projectPath);
    profileRepo.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: tmpDir, email: null, enabled: 1 });
    taskRepo.insert({ id: 'test-project/tok', projectId: 'test-project', slug: 'tok', title: 'Tokens', status: 'queued', modelChain: JSON.stringify(['codex:gpt-test']) });

    class CodexFake extends FakeEngine { id = 'codex' as unknown as 'agy'; }
    const fake = new CodexFake(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const metrics = new RunMetricsRepo(db);
    const prevMode = process.env.FAKE_MODE;
    process.env.FAKE_MODE = 'done-tokens';
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['codex', fake as unknown as Engine]]), undefined, undefined, undefined, metrics);
    try {
      await scheduler.tick();
      await vi.waitFor(() => {
        const run = runRepo.getByTask('test-project/tok')[0];
        expect(run).toBeDefined();
        expect(metrics.get(run.id)?.tokensUsed).toBe(1234);
      }, { timeout: 20000 });
    } finally {
      scheduler.stop();
      if (prevMode === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prevMode;
    }
  }, 30000);
});
