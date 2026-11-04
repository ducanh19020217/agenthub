import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import type { DiskSpace } from '../src/disk.js';

describe('Disk Guard (chống đầy ổ đĩa)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let fakeDiskReader: (p: string) => DiskSpace;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-disk-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.disk.minFreeGB = 3;

    // Default: plenty of disk — overridden per test
    fakeDiskReader = (_p: string) => ({ freeGB: 100, totalGB: 200 });

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines, (p) => fakeDiskReader(p));
    ctx.scheduler.stop();

    // Setup git repo for project
    const projectPath = path.join(tmpDir, 'repo');
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

    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(agyHomesDir, 'p1'),
      email: 'p1@example.com',
      enabled: 1,
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

  it('blocks task from starting when disk space is below minFreeGB', () => {
    // Inject fake disk reader: 1GB free (less than 3GB threshold)
    fakeDiskReader = (_p: string) => ({ freeGB: 1, totalGB: 100 });

    const emittedEvents: Array<{ type: string; taskId?: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, taskId, payload) => {
      emittedEvents.push({ type, taskId, payload: payload as Record<string, unknown> });
    });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    // Run scheduler tick
    ctx.scheduler.tick();

    const task = ctx.taskRepo.get('proj/t1');
    expect(task).toBeDefined();
    // Task should NOT have started
    expect(task!.status).toBe('waiting_quota');

    // Should emit disk.low and task.waiting_quota with reason 'disk'
    const diskLowEvent = emittedEvents.find((e) => e.type === 'disk.low');
    expect(diskLowEvent).toBeDefined();
    expect(diskLowEvent?.payload?.minFreeGB).toBe(3);
    expect(diskLowEvent?.payload?.isBlocking).toBe(true);
    expect(diskLowEvent?.payload?.tasks).toEqual(['t1']);

    const waitingEvent = emittedEvents.find((e) => e.type === 'task.waiting_quota' && e.taskId === 'proj/t1');
    expect(waitingEvent).toBeDefined();
    expect(waitingEvent?.payload?.reason).toBe('disk');

    // Running tasks map should be empty
    expect(ctx.scheduler.getRunning().size).toBe(0);
  });

  it('automatically resumes waiting task when disk space recovers', () => {
    let mockFreeGB = 1; // below 3GB initially
    fakeDiskReader = (_p: string) => ({ freeGB: mockFreeGB, totalGB: 100 });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    // Tick 1: disk is low -> task moved to waiting_quota
    ctx.scheduler.tick();
    expect(ctx.taskRepo.get('proj/t1')!.status).toBe('waiting_quota');
    expect(ctx.scheduler.getRunning().size).toBe(0);

    // Disk recovers to 10GB (>= 3GB)
    mockFreeGB = 10;

    // Tick 2: disk recovered -> task re-queued and started
    ctx.scheduler.tick();

    const taskAfter = ctx.taskRepo.get('proj/t1');
    expect(taskAfter!.status).toBe('running');
    expect(ctx.scheduler.getRunning().has('proj/t1')).toBe(true);
  });

  it('emits disk transitions once even when ticks repeat', () => {
    let mockFreeGB = 1;
    fakeDiskReader = (_p: string) => ({ freeGB: mockFreeGB, totalGB: 100 });

    const diskEvents: string[] = [];
    ctx.scheduler.getEventBus().on('*', (type) => {
      if (type === 'disk.low' || type === 'disk.ok') diskEvents.push(type);
    });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();
    ctx.scheduler.tick();
    expect(diskEvents).toEqual(['disk.low']);

    mockFreeGB = 10;
    ctx.scheduler.tick();
    ctx.scheduler.tick();
    expect(diskEvents).toEqual(['disk.low', 'disk.ok']);

    mockFreeGB = 1;
    ctx.taskRepo.insert({
      id: 'proj/t2',
      projectId: 'proj',
      slug: 't2',
      title: 'Task 2',
      status: 'queued',
      level: 'easy',
    });
    ctx.scheduler.tick();
    ctx.scheduler.tick();
    expect(diskEvents).toEqual(['disk.low', 'disk.ok', 'disk.low']);
  });

  it('works with injected low-disk reader', () => {
    // 0.5 GB < 3 GB threshold
    fakeDiskReader = (_p: string) => ({ freeGB: 0.5, totalGB: 50 });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();
    expect(ctx.taskRepo.get('proj/t1')!.status).toBe('waiting_quota');
  });

  it('blocks on a configured extra disk and includes its label in the wait event', () => {
    const extraPath = path.join(tmpDir, 'shared-docker');
    fs.mkdirSync(extraPath);
    config.disk.extraPaths = [{ path: extraPath, minFreeGB: 5, label: 'Ổ Docker dùng chung' }];
    fakeDiskReader = (p: string) => {
      const freeGB = p === extraPath ? 1 : 20;
      return { freeGB, totalGB: 100 };
    };

    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, _taskId, payload) => events.push({ type, payload: payload as Record<string, unknown> }));
    ctx.taskRepo.insert({ id: 'proj/t-extra', projectId: 'proj', slug: 't-extra', title: 'Extra disk', status: 'queued', level: 'easy' });

    ctx.scheduler.tick();

    expect(ctx.taskRepo.get('proj/t-extra')?.status).toBe('waiting_quota');
    expect(events.find((event) => event.type === 'task.waiting_quota')?.payload).toMatchObject({
      reason: 'disk',
      label: 'Ổ Docker dùng chung',
      freeGB: 1,
      minFreeGB: 5,
    });
  });

  it('monitors the configured project worktree root', () => {
    const configuredRoot = path.join(tmpDir, 'encrypted-worktrees');
    fs.mkdirSync(configuredRoot);
    ctx.projectRepo.update('proj', { settings: JSON.stringify({ worktree: { root: configuredRoot } }) });
    const seen: string[] = [];
    fakeDiskReader = (p: string) => {
      seen.push(p);
      return { freeGB: p === configuredRoot ? 1 : 20, totalGB: 100 };
    };
    ctx.taskRepo.insert({ id: 'proj/t-configured-disk', projectId: 'proj', slug: 't-configured-disk', title: 'Configured disk', status: 'queued', level: 'easy' });

    ctx.scheduler.tick();

    expect(seen).toContain(configuredRoot);
    expect(ctx.taskRepo.get('proj/t-configured-disk')?.status).toBe('waiting_quota');
  });

  it('supports injecting diskSpace via options object in createContext and exposes via getStatus', () => {
    const customCtx = createContext(config, { diskSpace: () => ({ freeGB: 42, totalGB: 100 }) });
    try {
      customCtx.scheduler.stop();
      const status = customCtx.service.getStatus();
      expect(status.disk.freeGB).toBe(42);
      expect(status.disk.totalGB).toBe(100);
    } finally {
      customCtx.scheduler.stop();
      customCtx.db.close();
    }
  });

  it('dispatches task for project on free drive even when default worktree drive is low', () => {
    const configuredRoot = path.join(tmpDir, 'separate-encrypted-drive');
    fs.mkdirSync(configuredRoot);

    const project2Path = path.join(tmpDir, 'repo2');
    fs.mkdirSync(project2Path, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: project2Path });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: project2Path });
    fs.writeFileSync(path.join(project2Path, 'README.md'), '# Test 2');
    execFileSync('git', ['add', '.'], { cwd: project2Path });
    execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
      cwd: project2Path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    ctx.projectRepo.insert({
      id: 'proj2',
      name: 'Project 2',
      path: project2Path,
      defaultBranch: 'main',
      maxParallel: 2,
      settings: JSON.stringify({ worktree: { root: configuredRoot } }),
    });

    fakeDiskReader = (p: string) => {
      const normalized = path.resolve(p);
      if (normalized.startsWith(path.resolve(configuredRoot))) {
        return { freeGB: 15, totalGB: 100 };
      }
      if (normalized.startsWith(path.resolve(config.worktreesDir))) {
        return { freeGB: 0.5, totalGB: 100 };
      }
      return { freeGB: 10, totalGB: 100 };
    };

    ctx.taskRepo.insert({
      id: 'proj/t-default',
      projectId: 'proj',
      slug: 't-default',
      title: 'Task on default worktrees',
      status: 'queued',
      level: 'easy',
    });

    ctx.taskRepo.insert({
      id: 'proj2/t-custom',
      projectId: 'proj2',
      slug: 't-custom',
      title: 'Task on custom drive',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    expect(ctx.taskRepo.get('proj/t-default')?.status).toBe('waiting_quota');
    expect(ctx.taskRepo.get('proj/t-default')?.waitReason).toBe('disk');

    expect(ctx.taskRepo.get('proj2/t-custom')?.status).toBe('running');
    expect(ctx.scheduler.getRunning().has('proj2/t-custom')).toBe(true);
  });

  it('blocks all projects when hub home disk is below hubHomeMinFreeGB', () => {
    config.disk.hubHomeMinFreeGB = 1;
    fakeDiskReader = (p: string) => {
      const normalized = path.resolve(p);
      if (normalized === path.resolve(config.hubHome)) {
        return { freeGB: 0.5, totalGB: 50 };
      }
      return { freeGB: 50, totalGB: 100 };
    };

    const emittedEvents: Array<{ type: string; taskId?: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, taskId, payload) => {
      emittedEvents.push({ type, taskId, payload: payload as Record<string, unknown> });
    });

    ctx.taskRepo.insert({
      id: 'proj/t-hub-home',
      projectId: 'proj',
      slug: 't-hub-home',
      title: 'Task blocked by hub home',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const task = ctx.taskRepo.get('proj/t-hub-home');
    expect(task?.status).toBe('waiting_quota');
    expect(task?.waitReason).toBe('disk');

    const waitingEvent = emittedEvents.find((e) => e.type === 'task.waiting_quota' && e.taskId === 'proj/t-hub-home');
    expect(waitingEvent).toBeDefined();
    expect(waitingEvent?.payload?.message).toContain('Ổ chứa dữ liệu hub (~/.agenthub) sắp đầy');
    expect(waitingEvent?.payload?.message).toContain(config.hubHome);
    expect(waitingEvent?.payload?.message).toContain('0.5 GB');
    expect(waitingEvent?.payload?.message).toContain('1 GB');
    expect(waitingEvent?.payload?.label).toBe('Ổ chứa dữ liệu hub (~/.agenthub)');
    expect(waitingEvent?.payload?.freeGB).toBe(0.5);
    expect(waitingEvent?.payload?.minFreeGB).toBe(1);

    expect(ctx.scheduler.getRunning().size).toBe(0);
  });

  it('formats wait message with label, path, freeGB, and minFreeGB for worktree disk', () => {
    fakeDiskReader = (_p: string) => ({ freeGB: 1.2, totalGB: 100 });

    const emittedEvents: Array<{ type: string; taskId?: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, taskId, payload) => {
      emittedEvents.push({ type, taskId, payload: payload as Record<string, unknown> });
    });

    ctx.taskRepo.insert({
      id: 'proj/t-msg',
      projectId: 'proj',
      slug: 't-msg',
      title: 'Check message format',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const waitingEvent = emittedEvents.find((e) => e.type === 'task.waiting_quota' && e.taskId === 'proj/t-msg');
    expect(waitingEvent?.payload?.message).toBe(
      `Chờ Worktrees (${path.join(config.worktreesDir, 'proj')}) (còn 1.2 GB / cần 3 GB)`
    );
    expect(waitingEvent?.payload?.path).toBe(path.join(config.worktreesDir, 'proj'));
    expect(waitingEvent?.payload?.label).toBe('Worktrees');
  });

  it('exposes distinct blockingDisk metadata per task when multiple projects have low space on different drives', async () => {
    const drive1 = path.join(tmpDir, 'drive1');
    const drive2 = path.join(tmpDir, 'drive2');
    fs.mkdirSync(drive1, { recursive: true });
    fs.mkdirSync(drive2, { recursive: true });

    ctx.projectRepo.insert({
      id: 'proj1',
      name: 'Project 1',
      path: path.join(tmpDir, 'repo'),
      defaultBranch: 'main',
      maxParallel: 2,
      settings: JSON.stringify({ worktree: { root: drive1 } }),
    });

    ctx.projectRepo.insert({
      id: 'proj2',
      name: 'Project 2',
      path: path.join(tmpDir, 'repo'),
      defaultBranch: 'main',
      maxParallel: 2,
      settings: JSON.stringify({ worktree: { root: drive2 } }),
    });

    fakeDiskReader = (p: string) => {
      const normalized = path.resolve(p);
      if (normalized.startsWith(path.resolve(drive1))) {
        return { freeGB: 0.4, totalGB: 100 };
      }
      if (normalized.startsWith(path.resolve(drive2))) {
        return { freeGB: 1.2, totalGB: 100 };
      }
      return { freeGB: 20, totalGB: 100 };
    };

    ctx.taskRepo.insert({
      id: 'proj1/t1',
      projectId: 'proj1',
      slug: 't1',
      title: 'Task 1 on drive1',
      status: 'queued',
      level: 'easy',
    });

    ctx.taskRepo.insert({
      id: 'proj2/t2',
      projectId: 'proj2',
      slug: 't2',
      title: 'Task 2 on drive2',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    expect(ctx.taskRepo.get('proj1/t1')?.status).toBe('waiting_quota');
    expect(ctx.taskRepo.get('proj1/t1')?.waitReason).toBe('disk');
    expect(ctx.taskRepo.get('proj2/t2')?.status).toBe('waiting_quota');
    expect(ctx.taskRepo.get('proj2/t2')?.waitReason).toBe('disk');

    // Verify listTasks exposes accurate blockingDisk per task
    const tasks = ctx.service.listTasks();
    const task1 = tasks.find((t) => t.id === 'proj1/t1');
    const task2 = tasks.find((t) => t.id === 'proj2/t2');

    expect(task1?.blockingDisk).toBeDefined();
    expect(task1?.blockingDisk?.freeGB).toBe(0.4);
    expect(task1?.blockingDisk?.minFreeGB).toBe(3);
    expect(task1?.blockingDisk?.path).toBe(drive1);
    expect(task1?.blockingDisk?.label).toBe(`Worktrees (${drive1})`);

    expect(task2?.blockingDisk).toBeDefined();
    expect(task2?.blockingDisk?.freeGB).toBe(1.2);
    expect(task2?.blockingDisk?.minFreeGB).toBe(3);
    expect(task2?.blockingDisk?.path).toBe(drive2);
    expect(task2?.blockingDisk?.label).toBe(`Worktrees (${drive2})`);

    // Verify getTask exposes accurate blockingDisk per task
    const detail1 = await ctx.service.getTask('proj1/t1');
    const detail2 = await ctx.service.getTask('proj2/t2');
    expect(detail1.blockingDisk?.freeGB).toBe(0.4);
    expect(detail1.blockingDisk?.path).toBe(drive1);
    expect(detail2.blockingDisk?.freeGB).toBe(1.2);
    expect(detail2.blockingDisk?.path).toBe(drive2);
  });

  it('emits disk.low with isBlocking=true and task list when task is blocked by low project disk', () => {
    fakeDiskReader = (_p: string) => ({ freeGB: 1, totalGB: 100 });

    const emittedEvents: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, _taskId, payload) => {
      emittedEvents.push({ type, payload: payload as Record<string, unknown> });
    });

    ctx.taskRepo.insert({
      id: 'proj/t-blocking-1',
      projectId: 'proj',
      slug: 't-blocking-1',
      title: 'Task Blocking 1',
      status: 'queued',
      level: 'easy',
    });
    ctx.taskRepo.insert({
      id: 'proj/t-blocking-2',
      projectId: 'proj',
      slug: 't-blocking-2',
      title: 'Task Blocking 2',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    expect(ctx.taskRepo.get('proj/t-blocking-1')?.status).toBe('waiting_quota');
    expect(ctx.taskRepo.get('proj/t-blocking-2')?.status).toBe('waiting_quota');

    const diskLowEvents = emittedEvents.filter((e) => e.type === 'disk.low');
    expect(diskLowEvents).toHaveLength(1);
    expect(diskLowEvents[0].payload?.isBlocking).toBe(true);
    expect(diskLowEvents[0].payload?.tasks).toEqual(['t-blocking-1', 't-blocking-2']);
  });

  it('filters waiting tasks in disk.low alerts per specific blocking disk when multiple drives are low', () => {
    const driveA = path.join(tmpDir, 'drive-a');
    const driveB = path.join(tmpDir, 'drive-b');
    fs.mkdirSync(driveA, { recursive: true });
    fs.mkdirSync(driveB, { recursive: true });

    ctx.projectRepo.insert({
      id: 'proj-a',
      name: 'Project A',
      path: path.join(tmpDir, 'repo'),
      defaultBranch: 'main',
      maxParallel: 2,
      settings: JSON.stringify({ worktree: { root: driveA } }),
    });

    ctx.projectRepo.insert({
      id: 'proj-b',
      name: 'Project B',
      path: path.join(tmpDir, 'repo'),
      defaultBranch: 'main',
      maxParallel: 2,
      settings: JSON.stringify({ worktree: { root: driveB } }),
    });

    fakeDiskReader = (p: string) => {
      const normalized = path.resolve(p);
      if (normalized.startsWith(path.resolve(driveA))) {
        return { freeGB: 0.5, totalGB: 100 };
      }
      if (normalized.startsWith(path.resolve(driveB))) {
        return { freeGB: 0.8, totalGB: 100 };
      }
      return { freeGB: 20, totalGB: 100 };
    };

    const emittedEvents: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, _taskId, payload) => {
      emittedEvents.push({ type, payload: payload as Record<string, unknown> });
    });

    ctx.taskRepo.insert({
      id: 'proj-a/t-a',
      projectId: 'proj-a',
      slug: 't-a',
      title: 'Task A on drive A',
      status: 'queued',
      level: 'easy',
    });
    ctx.taskRepo.insert({
      id: 'proj-b/t-b',
      projectId: 'proj-b',
      slug: 't-b',
      title: 'Task B on drive B',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    expect(ctx.taskRepo.get('proj-a/t-a')?.status).toBe('waiting_quota');
    expect(ctx.taskRepo.get('proj-b/t-b')?.status).toBe('waiting_quota');

    const lowEvents = emittedEvents.filter((e) => e.type === 'disk.low');
    const driveAEvent = lowEvents.find((e) => e.payload?.path === driveA);
    const driveBEvent = lowEvents.find((e) => e.payload?.path === driveB);

    expect(driveAEvent).toBeDefined();
    expect(driveAEvent?.payload?.tasks).toEqual(['t-a']);

    expect(driveBEvent).toBeDefined();
    expect(driveBEvent?.payload?.tasks).toEqual(['t-b']);
  });

  it('emits disk.ok with resumed tasks when one project disk recovers while another project disk remains low', () => {
    const driveA = path.join(tmpDir, 'recovery-drive-a');
    const driveB = path.join(tmpDir, 'recovery-drive-b');
    fs.mkdirSync(driveA, { recursive: true });
    fs.mkdirSync(driveB, { recursive: true });

    ctx.projectRepo.insert({
      id: 'p-rec-a',
      name: 'Project Rec A',
      path: path.join(tmpDir, 'repo'),
      defaultBranch: 'main',
      maxParallel: 2,
      settings: JSON.stringify({ worktree: { root: driveA } }),
    });

    ctx.projectRepo.insert({
      id: 'p-rec-b',
      name: 'Project Rec B',
      path: path.join(tmpDir, 'repo'),
      defaultBranch: 'main',
      maxParallel: 2,
      settings: JSON.stringify({ worktree: { root: driveB } }),
    });

    let driveAFree = 0.5;
    const driveBFree = 0.5;
    fakeDiskReader = (p: string) => {
      const normalized = path.resolve(p);
      if (normalized.startsWith(path.resolve(driveA))) {
        return { freeGB: driveAFree, totalGB: 100 };
      }
      if (normalized.startsWith(path.resolve(driveB))) {
        return { freeGB: driveBFree, totalGB: 100 };
      }
      return { freeGB: 20, totalGB: 100 };
    };

    const emittedEvents: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, _taskId, payload) => {
      emittedEvents.push({ type, payload: payload as Record<string, unknown> });
    });

    ctx.taskRepo.insert({ id: 'p-rec-a/t1', projectId: 'p-rec-a', slug: 't1', title: 'Task 1', status: 'queued', level: 'easy' });
    ctx.taskRepo.insert({ id: 'p-rec-b/t2', projectId: 'p-rec-b', slug: 't2', title: 'Task 2', status: 'queued', level: 'easy' });

    ctx.scheduler.tick();
    expect(ctx.taskRepo.get('p-rec-a/t1')?.status).toBe('waiting_quota');
    expect(ctx.taskRepo.get('p-rec-b/t2')?.status).toBe('waiting_quota');

    // Drive A recovers to 15 GB, Drive B remains low at 0.5 GB
    driveAFree = 15;
    emittedEvents.length = 0;
    ctx.scheduler.tick();

    expect(['queued', 'running']).toContain(ctx.taskRepo.get('p-rec-a/t1')?.status);
    expect(ctx.scheduler.getRunning().has('p-rec-a/t1')).toBe(true);
    expect(ctx.taskRepo.get('p-rec-b/t2')?.status).toBe('waiting_quota');

    const okEvents = emittedEvents.filter((e) => e.type === 'disk.ok');
    expect(okEvents).toHaveLength(1);
    expect(okEvents[0].payload?.resumedCount).toBe(1);
    expect(okEvents[0].payload?.tasks).toEqual(['t1']);
    expect(okEvents[0].payload?.remainingCount).toBe(1);
  });
});
