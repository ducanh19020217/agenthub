import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { QuotaService } from '../src/quota/index.js';
import type { DiskSpace } from '../src/disk.js';

describe('Task waitReason (lý do chờ)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let fakeDiskReader: (p: string) => DiskSpace;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-wait-reason-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.disk.minFreeGB = 5;

    // Default: plenty of disk — individual tests override as needed
    fakeDiskReader = (_p: string) => ({ freeGB: 100, totalGB: 200 });

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines, (p) => fakeDiskReader(p));
    ctx.scheduler.stop();

    const projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Test Project');
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
      maxParallel: 1,
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

  it('sets waitReason to disk when disk space is below minFreeGB and clears when disk recovers', () => {
    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });

    // Inject disk reader: below threshold (3GB < 5GB)
    let mockFreeGB = 3;
    fakeDiskReader = (_p: string) => ({ freeGB: mockFreeGB, totalGB: 100 });

    ctx.taskRepo.insert({
      id: 'proj/t-disk',
      projectId: 'proj',
      slug: 't-disk',
      title: 'Disk Test Task',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const task = ctx.taskRepo.get('proj/t-disk');
    expect(task?.status).toBe('waiting_quota');
    expect(task?.waitReason).toBe('disk');

    // API returns waitReason
    const apiTasks = ctx.service.listTasks();
    const apiTask = apiTasks.find((t) => t.id === 'proj/t-disk');
    expect(apiTask?.waitReason).toBe('disk');

    // Status returns disk threshold
    const status = ctx.service.getStatus();
    expect(status.disk?.minFreeGB).toBe(5);

    // Disk space recovers (10GB >= 5GB)
    mockFreeGB = 10;
    ctx.scheduler.tick();

    const recovered = ctx.taskRepo.get('proj/t-disk');
    expect(['queued', 'running']).toContain(recovered?.status);
    expect(recovered?.waitReason).toBeNull();
  });

  it('sets waitReason to quota when all matching profiles are quota-exhausted and clears when quota expires', () => {
    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });

    // Mark p1 exhausted for gemini
    const quotaService = new QuotaService(ctx.quotaMarkRepo, ctx.profileRepo);
    quotaService.mark('p1', 'gemini', 3600, 'quota limit');

    ctx.taskRepo.insert({
      id: 'proj/t-quota',
      projectId: 'proj',
      slug: 't-quota',
      title: 'Quota Test Task',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const task = ctx.taskRepo.get('proj/t-quota');
    expect(task?.status).toBe('waiting_quota');
    expect(task?.waitReason).toBe('quota');

    // Clear quota mark
    quotaService.clear('p1', 'gemini');
    ctx.scheduler.wakeWaitingQuotaTasks('quota_cleared');

    const recovered = ctx.taskRepo.get('proj/t-quota');
    expect(['queued', 'running']).toContain(recovered?.status);
    expect(recovered?.waitReason).toBeNull();
  });

  it('sets waitReason to parallel when project maxParallel is reached and clears when a slot opens', () => {
    // Project maxParallel is 1
    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });
    ctx.profileRepo.upsert({
      name: 'p2',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p2'),
      email: 'p2@example.com',
      enabled: 1,
    });

    ctx.taskRepo.insert({
      id: 'proj/t-parallel-1',
      projectId: 'proj',
      slug: 't-parallel-1',
      title: 'First Parallel Task',
      status: 'queued',
      level: 'easy',
    });
    ctx.taskRepo.insert({
      id: 'proj/t-parallel-2',
      projectId: 'proj',
      slug: 't-parallel-2',
      title: 'Second Parallel Task',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    // First task starts running, second task waits for parallel slot
    const t1 = ctx.taskRepo.get('proj/t-parallel-1');
    const t2 = ctx.taskRepo.get('proj/t-parallel-2');

    expect(t1?.status).toBe('running');
    expect(t1?.waitReason).toBeNull();

    expect(t2?.status).toBe('queued');
    expect(t2?.waitReason).toBe('parallel');

    // Increase maxParallel to 2
    ctx.projectRepo.update('proj', { maxParallel: 2 });
    ctx.scheduler.tick();

    const t2After = ctx.taskRepo.get('proj/t-parallel-2');
    expect(['queued', 'running']).toContain(t2After?.status);
    expect(t2After?.waitReason).toBeNull();
  });

  it('sets waitReason to profile_busy when profile is occupied and clears when profile is freed', () => {
    // 2 projects each maxParallel 3, but only 1 profile p1 (which has 2 slots)
    ctx.projectRepo.insert({
      id: 'proj2',
      name: 'Project 2',
      path: path.join(tmpDir, 'repo'),
      defaultBranch: 'main',
      maxParallel: 3,
    });
    ctx.projectRepo.update('proj', { maxParallel: 3 });

    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });

    ctx.taskRepo.insert({
      id: 'proj/t-p1-a',
      projectId: 'proj',
      slug: 't-p1-a',
      title: 'Task A on P1',
      status: 'queued',
      level: 'easy',
    });
    ctx.taskRepo.insert({
      id: 'proj/t-p1-b',
      projectId: 'proj',
      slug: 't-p1-b',
      title: 'Task B on P1',
      status: 'queued',
      level: 'easy',
    });
    ctx.taskRepo.insert({
      id: 'proj2/t-p2',
      projectId: 'proj2',
      slug: 't-p2',
      title: 'Task waiting for P1',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const t1a = ctx.taskRepo.get('proj/t-p1-a');
    const t1b = ctx.taskRepo.get('proj/t-p1-b');
    const t2 = ctx.taskRepo.get('proj2/t-p2');

    expect(t1a?.status).toBe('running');
    expect(t1b?.status).toBe('running');
    // Third task has available parallel slot in proj2, but p1 has no free slots!
    expect(t2?.status).toBe('queued');
    expect(t2?.waitReason).toBe('profile_busy');

    // Add another profile p2
    ctx.profileRepo.upsert({
      name: 'p2',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p2'),
      email: 'p2@example.com',
      enabled: 1,
    });
    ctx.scheduler.tick();

    const t2After = ctx.taskRepo.get('proj2/t-p2');
    expect(['queued', 'running']).toContain(t2After?.status);
    expect(t2After?.waitReason).toBeNull();
  });

  it('sets waitReason to no_department_profile when no allowed profiles exist for the department, and runs when profile is assigned', async () => {
    // Create department 'system' and assign p1 to it
    ctx.departmentRepo.insert({
      id: 'system',
      name: 'Phòng SYSTEM',
      priority: 0,
      maxParallel: 0,
      claudeDailyTokenBudget: 0,
      telegramTopicId: null,
    });
    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });
    ctx.departmentRepo.setProfiles('system', [{ profileName: 'p1', share: null }]);

    // 'proj' is in department 'chung', which now has 0 allowed profiles because p1 is assigned to 'system'
    const waitingEvents: Array<{ taskId: string; payload: unknown }> = [];
    ctx.scheduler.getEventBus().on('task.waiting_quota', (taskId, payload) => {
      waitingEvents.push({ taskId, payload });
    });

    ctx.taskRepo.insert({
      id: 'proj/t-no-dept',
      projectId: 'proj',
      slug: 't-no-dept',
      title: 'No Department Profile Task',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const task = ctx.taskRepo.get('proj/t-no-dept');
    expect(task?.status).toBe('waiting_quota');
    expect(task?.waitReason).toBe('no_department_profile');

    expect(waitingEvents).toHaveLength(1);
    expect(waitingEvents[0]).toMatchObject({
      taskId: 'proj/t-no-dept',
      payload: {
        reason: 'no_department_profile',
        departmentId: 'chung',
        departmentName: 'Chung',
        message: 'Gán tài khoản cho phòng Chung hoặc bỏ gán',
      },
    });

    // Assign p1 to 'chung' via updateDepartmentProfiles (simulating PUT /api/departments/chung/profiles)
    // When scheduler is running (!stopped), department.changed wakes and triggers tick automatically
    (ctx.scheduler as unknown as { stopped: boolean }).stopped = false;
    ctx.service.updateDepartmentProfiles('chung', {
      profiles: [{ profileName: 'p1', share: null }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const recovered = ctx.taskRepo.get('proj/t-no-dept');
    expect(recovered?.status).toBe('running');
    expect(recovered?.waitReason).toBeNull();
  });

  it('distinguishes between quota exhaustion and no_matching_profile', () => {
    ctx.profileRepo.upsert({
      name: 'p-agy',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p-agy'),
      email: 'p-agy@example.com',
      enabled: 1,
    });

    // 1. Quota exhaustion: profile matches engine but is quota marked
    const quotaService = new QuotaService(ctx.quotaMarkRepo, ctx.profileRepo);
    quotaService.mark('p-agy', 'gemini', 3600, 'quota limit');

    ctx.taskRepo.insert({
      id: 'proj/t-quota-exhausted',
      projectId: 'proj',
      slug: 't-quota-exhausted',
      title: 'Quota Exhausted Task',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const quotaTask = ctx.taskRepo.get('proj/t-quota-exhausted');
    expect(quotaTask?.status).toBe('waiting_quota');
    expect(quotaTask?.waitReason).toBe('quota');

    // 2. No matching profile: department has allowed profile (p-agy), but task requests a codex engine model
    ctx.taskRepo.insert({
      id: 'proj/t-codex-engine',
      projectId: 'proj',
      slug: 't-codex-engine',
      title: 'Codex Task on Agy Department',
      status: 'queued',
      level: 'easy',
      modelChain: JSON.stringify(['codex:gpt-5.6-luna']),
    });

    ctx.scheduler.tick();

    const noMatchingTask = ctx.taskRepo.get('proj/t-codex-engine');
    expect(noMatchingTask?.status).toBe('waiting_quota');
    expect(noMatchingTask?.waitReason).toBe('no_matching_profile');
  });

  it('wakes waiting task when project is moved to another department that has allowed profiles', async () => {
    ctx.departmentRepo.insert({
      id: 'dept-empty',
      name: 'Phòng Trống',
      priority: 0,
      maxParallel: 0,
      claudeDailyTokenBudget: 0,
      telegramTopicId: null,
    });
    ctx.departmentRepo.insert({
      id: 'dept-active',
      name: 'Phòng Hoạt Động',
      priority: 0,
      maxParallel: 0,
      claudeDailyTokenBudget: 0,
      telegramTopicId: null,
    });

    ctx.profileRepo.upsert({
      name: 'p-active',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'p-active'),
      email: 'p-active@example.com',
      enabled: 1,
    });
    ctx.departmentRepo.setProfiles('dept-active', [{ profileName: 'p-active', share: null }]);

    // Create a new project in dept-empty
    const projectPath = path.join(tmpDir, 'repo-moved');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Moved Project');
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
      id: 'proj-moved',
      name: 'Project Moved',
      path: projectPath,
      defaultBranch: 'main',
      maxParallel: 1,
      departmentId: 'dept-empty',
    });

    ctx.taskRepo.insert({
      id: 'proj-moved/t-wait',
      projectId: 'proj-moved',
      slug: 't-wait',
      title: 'Task in Empty Department',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();

    const waitingTask = ctx.taskRepo.get('proj-moved/t-wait');
    expect(waitingTask?.status).toBe('waiting_quota');
    expect(waitingTask?.waitReason).toBe('no_department_profile');

    // Move project to dept-active (simulating project moving department)
    (ctx.scheduler as unknown as { stopped: boolean }).stopped = false;
    ctx.service.updateProject('proj-moved', { departmentId: 'dept-active' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const runningTask = ctx.taskRepo.get('proj-moved/t-wait');
    expect(runningTask?.status).toBe('running');
    expect(runningTask?.waitReason).toBeNull();
  });

  it('wakes waiting tasks when a department is created or deleted', () => {
    ctx.taskRepo.insert({
      id: 'proj/t-dept-create-wake',
      projectId: 'proj',
      slug: 't-dept-create-wake',
      title: 'Wait on Department Change',
      status: 'waiting_quota',
      level: 'easy',
      waitReason: 'no_department_profile',
    });

    const queuedEvents: Array<{ taskId: string; payload: unknown }> = [];
    ctx.scheduler.getEventBus().on('task.queued', (taskId, payload) => {
      queuedEvents.push({ taskId, payload });
    });

    // Creating department emits department.changed and wakes waiting tasks
    ctx.service.createDepartment({ name: 'New Dept' });
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0]).toMatchObject({
      taskId: 'proj/t-dept-create-wake',
      payload: { reason: 'department_changed' },
    });

    // Put task back into waiting_quota
    ctx.taskRepo.updateStatus('proj/t-dept-create-wake', 'waiting_quota', 'no_department_profile');
    queuedEvents.length = 0;

    // Deleting department also emits department.changed and wakes waiting tasks
    ctx.service.deleteDepartment('new-dept');
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0]).toMatchObject({
      taskId: 'proj/t-dept-create-wake',
      payload: { reason: 'department_changed' },
    });
  });

  it('marks queued tasks while restart drain is active and clears the reason on cancel', () => {
    ctx.profileRepo.upsert({
      name: 'restart-profile',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'restart-profile'),
      email: 'restart@example.com',
      enabled: 1,
    });
    ctx.taskRepo.insert({
      id: 'proj/t-restart-wait',
      projectId: 'proj',
      slug: 't-restart-wait',
      title: 'Restart wait',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.beginRestartDrain(120, 'test');
    expect(ctx.taskRepo.get('proj/t-restart-wait')?.waitReason).toBe('restart');

    ctx.scheduler.cancelRestartDrain();
    expect(ctx.taskRepo.get('proj/t-restart-wait')?.waitReason).toBeNull();
    expect(ctx.scheduler.getRestartState().draining).toBe(false);
  });
});
