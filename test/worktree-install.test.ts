import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { openDatabase, ProjectRepo, ProfileRepo, QuotaMarkRepo, TaskRepo, RunRepo, EventRepo, TaskNoteRepo } from '../src/db/index.js';
import { Scheduler, buildProtocolPrompt, getNodeModulesPromptInstruction } from '../src/scheduler/index.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import * as cacheModule from '../src/cache.js';
import { CheckRunner } from '../src/checks.js';
import { ProjectSettingsSchema, ProjectSettingsInputSchema, parseProjectSettings, mergeProjectSettings, DEFAULT_PROJECT_SETTINGS } from '../src/projects/settings.js';

describe('settings.worktree.install option', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let db: ReturnType<typeof openDatabase>;
  let projectRepo: ProjectRepo;
  let profileRepo: ProfileRepo;
  let quotaMarkRepo: QuotaMarkRepo;
  let taskRepo: TaskRepo;
  let runRepo: RunRepo;
  let eventRepo: EventRepo;
  let taskNoteRepo: TaskNoteRepo;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-wt-install-test-'));
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
    taskNoteRepo = new TaskNoteRepo(db);

    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Project');
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'test' }));
    fs.writeFileSync(path.join(projectPath, 'package-lock.json'), JSON.stringify({ name: 'test', lockfileVersion: 3 }));
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

  it('install=skip không gọi ensureWorktreeNodeModules ở cả tạo worktree và checks; install=auto thì có gọi', async () => {
    const spy = vi.spyOn(cacheModule, 'ensureWorktreeNodeModules').mockImplementation(async () => {});

    // 1. Project with install = 'skip'
    projectRepo.insert({
      id: 'proj-skip',
      name: 'Project Skip',
      path: projectPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
      settings: JSON.stringify({ worktree: { install: 'skip' } }),
    });

    taskRepo.insert({
      id: 'proj-skip/task-1',
      projectId: 'proj-skip',
      slug: 'task-1',
      title: 'Task 1',
      status: 'queued',
    });

    const fakeEngine = new FakeEngine();
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);

    const task = taskRepo.get('proj-skip/task-1')!;
    await scheduler.startTask(task, 'gemini-3.8-flash-high', 'p1');

    // Scheduler startTask should NOT call ensureWorktreeNodeModules for install=skip
    expect(spy).not.toHaveBeenCalled();

    // CheckRunner.run should NOT call ensureWorktreeNodeModules for install=skip
    const checkRunner = new CheckRunner(db);
    const projSkip = projectRepo.get('proj-skip')!;
    const runningTask = taskRepo.get('proj-skip/task-1')!;
    const runs = runRepo.getByTask('proj-skip/task-1');
    expect(runs.length).toBeGreaterThan(0);
    await checkRunner.run(runningTask, projSkip, runs[0].id);
    expect(spy).not.toHaveBeenCalled();

    scheduler.stop();

    // 2. Project with install = 'auto' (default)
    projectRepo.insert({
      id: 'proj-auto',
      name: 'Project Auto',
      path: projectPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
      settings: JSON.stringify({ worktree: { install: 'auto' } }),
    });

    taskRepo.insert({
      id: 'proj-auto/task-2',
      projectId: 'proj-auto',
      slug: 'task-2',
      title: 'Task 2',
      status: 'queued',
    });

    const schedulerAuto = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);
    const taskAuto = taskRepo.get('proj-auto/task-2')!;
    await schedulerAuto.startTask(taskAuto, 'gemini-3.8-flash-high', 'p1');

    // Scheduler startTask SHOULD call ensureWorktreeNodeModules
    expect(spy).toHaveBeenCalled();
    const callsAfterStart = spy.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThan(0);

    const projAuto = projectRepo.get('proj-auto')!;
    const runningTaskAuto = taskRepo.get('proj-auto/task-2')!;
    const runsAuto = runRepo.getByTask('proj-auto/task-2');
    expect(runsAuto.length).toBeGreaterThan(0);
    await checkRunner.run(runningTaskAuto, projAuto, runsAuto[0].id);

    // CheckRunner SHOULD call ensureWorktreeNodeModules
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterStart);

    schedulerAuto.stop();
  });

  it('lỗi cài phụ thuộc không đánh failed task: ghi event worktree.install_failed + ghi chú vào task, worker vẫn chạy', async () => {
    vi.spyOn(cacheModule, 'ensureWorktreeNodeModules').mockImplementation(async () => {
      throw new Error('EACCES: permission denied or network failure');
    });

    projectRepo.insert({
      id: 'proj-fail',
      name: 'Project Fail',
      path: projectPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 3,
      settings: JSON.stringify({ worktree: { install: 'auto' } }),
    });

    taskRepo.insert({
      id: 'proj-fail/task-fail',
      projectId: 'proj-fail',
      slug: 'task-fail',
      title: 'Task Fail',
      status: 'queued',
    });

    const emittedEvents: Array<{ type: string; taskId?: string; payload?: unknown }> = [];
    const fakeEngine = new FakeEngine();
    const spawnSpy = vi.spyOn(fakeEngine, 'spawn');
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);
    scheduler.getEventBus().on('worktree.install_failed', (taskId, payload) => {
      emittedEvents.push({ type: 'worktree.install_failed', taskId, payload });
    });
    scheduler.getEventBus().on('task.failed', (taskId, payload) => {
      emittedEvents.push({ type: 'task.failed', taskId, payload });
    });

    const task = taskRepo.get('proj-fail/task-fail')!;
    await scheduler.startTask(task, 'gemini-3.8-flash-high', 'p1');

    // 1. Task must NOT be failed; it must be running
    const updatedTask = taskRepo.get('proj-fail/task-fail')!;
    expect(updatedTask.status).toBe('running');

    // 2. Event worktree.install_failed was emitted
    const installFailedEvents = emittedEvents.filter((e) => e.type === 'worktree.install_failed');
    expect(installFailedEvents.length).toBe(1);
    expect(installFailedEvents[0].taskId).toBe('proj-fail/task-fail');
    expect(installFailedEvents[0].payload.error).toContain('EACCES');

    // 3. No task.failed event
    const taskFailedEvents = emittedEvents.filter((e) => e.type === 'task.failed');
    expect(taskFailedEvents.length).toBe(0);

    // 4. Note added to task
    const notes = taskNoteRepo.getByTask('proj-fail/task-fail');
    expect(notes.length).toBe(1);
    expect(notes[0].content).toContain('Lỗi cài phụ thuộc');
    expect(notes[0].content).toContain('EACCES');

    // 5. Worker engine was still spawned
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  describe('schema worktree.install & project cũ', () => {
    it('nhận giá trị worker, auto, skip và từ chối giá trị khác', () => {
      expect(ProjectSettingsSchema.parse({ worktree: { install: 'worker' } }).worktree.install).toBe('worker');
      expect(ProjectSettingsSchema.parse({ worktree: { install: 'auto' } }).worktree.install).toBe('auto');
      expect(ProjectSettingsSchema.parse({ worktree: { install: 'skip' } }).worktree.install).toBe('skip');

      expect(() => ProjectSettingsSchema.parse({ worktree: { install: 'manual' } })).toThrow();
    });

    it('ProjectSettingsInputSchema nhận worker khi cập nhật', () => {
      const parsed = ProjectSettingsInputSchema.parse({ worktree: { install: 'worker' } });
      expect(parsed.worktree?.install).toBe('worker');
    });

    it('project cũ không đổi hành vi (mặc định vẫn là auto)', () => {
      expect(DEFAULT_PROJECT_SETTINGS.worktree.install).toBe('auto');
      expect(parseProjectSettings(null).worktree.install).toBe('auto');
      expect(parseProjectSettings('{}').worktree.install).toBe('auto');
      expect(parseProjectSettings(JSON.stringify({ worktree: { gitHooks: 'run' } })).worktree.install).toBe('auto');

      const merged = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, { worktree: { install: 'worker' } });
      expect(merged.worktree.install).toBe('worker');
      // Các trường khác giữ nguyên
      expect(merged.worktree.gitHooks).toBe('run');
      expect(merged.commitConvention).toEqual(DEFAULT_PROJECT_SETTINGS.commitConvention);
    });
  });

  describe('sinh lời nhắc node_modules cho 4 trường hợp', () => {
    it('1. auto và hub đã chuẩn bị thành công: giữ câu hiện tại', () => {
      const instruction = getNodeModulesPromptInstruction({ worktree: { install: 'auto' } }, 'prepared');
      expect(instruction).toBe('`node_modules` đã được chuẩn bị sẵn, KHÔNG chạy `npm ci`/`npm install` trừ khi bạn sửa `package.json`.');

      const prompt = buildProtocolPrompt({ worktree: { install: 'auto' } }, 'prepared');
      expect(prompt).toContain('`node_modules` đã được chuẩn bị sẵn, KHÔNG chạy `npm ci`/`npm install` trừ khi bạn sửa `package.json`.');

      // Khi không truyền kết quả chuẩn bị (tương thích ngược mặc định), giữ nguyên câu hiện tại
      expect(getNodeModulesPromptInstruction({ worktree: { install: 'auto' } })).toBe(instruction);
      expect(buildProtocolPrompt({ worktree: { install: 'auto' } })).toBe(prompt);
      expect(buildProtocolPrompt()).toBe(prompt);
    });

    it('2. auto nhưng không có lockfile hoặc cài lỗi: nói rõ chưa có và được chạy npm ci khi cần test/build', () => {
      const instructionNoLock = getNodeModulesPromptInstruction({ worktree: { install: 'auto' } }, 'no_lockfile');
      expect(instructionNoLock).toBe('`node_modules` chưa có, được chạy `npm ci` khi cần test/build.');
      expect(instructionNoLock).not.toContain('đã được chuẩn bị sẵn');

      const instructionFailed = getNodeModulesPromptInstruction({ worktree: { install: 'auto' } }, 'failed');
      expect(instructionFailed).toBe('`node_modules` chưa có, được chạy `npm ci` khi cần test/build.');

      const promptNoLock = buildProtocolPrompt({ worktree: { install: 'auto' } }, 'no_lockfile');
      expect(promptNoLock).toContain('`node_modules` chưa có, được chạy `npm ci` khi cần test/build.');
      expect(promptNoLock).not.toContain('đã được chuẩn bị sẵn');

      const promptFailed = buildProtocolPrompt({ worktree: { install: 'auto' } }, { status: 'failed', error: 'network error' });
      expect(promptFailed).toContain('`node_modules` chưa có, được chạy `npm ci` khi cần test/build.');
    });

    it('3. worker: cho phép npm ci/npm install trong thư mục module (bọc timeout 900), dọn node_modules/dist khi xong nếu project yêu cầu', () => {
      const instruction = getNodeModulesPromptInstruction({ worktree: { install: 'worker' } });
      expect(instruction).toBe('Được phép chạy `npm ci`/`npm install` trong thư mục module (bọc `timeout 900`), dọn node_modules/dist khi xong nếu project yêu cầu.');

      const prompt = buildProtocolPrompt({ worktree: { install: 'worker' } });
      expect(prompt).toContain('Được phép chạy `npm ci`/`npm install` trong thư mục module (bọc `timeout 900`), dọn node_modules/dist khi xong nếu project yêu cầu.');
      expect(prompt).not.toContain('đã được chuẩn bị sẵn');
    });

    it('4. skip: không nhắc tới node_modules', () => {
      const instruction = getNodeModulesPromptInstruction({ worktree: { install: 'skip' } });
      expect(instruction).toBe('');

      const prompt = buildProtocolPrompt({ worktree: { install: 'skip' } });
      expect(prompt).not.toContain('node_modules');
      expect(prompt).not.toContain('npm ci');
      expect(prompt).not.toContain('npm install');
      // Prompt vẫn chứa các phần khác
      expect(prompt).toContain('Đọc `.agenthub/task.md` và thực hiện');
      expect(prompt).toContain('KHÔNG chạy test/lệnh ở chế độ nền');
    });
  });

  describe('tích hợp Scheduler với install=worker và sinh prompt thực tế', () => {
    it('install=worker không gọi ensureWorktreeNodeModules ở cả scheduler và checkRunner, prompt sinh đúng', async () => {
      const spy = vi.spyOn(cacheModule, 'ensureWorktreeNodeModules').mockImplementation(async () => {});

      projectRepo.insert({
        id: 'proj-worker',
        name: 'Project Worker',
        path: projectPath,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 3,
        settings: JSON.stringify({ worktree: { install: 'worker' } }),
      });

      taskRepo.insert({
        id: 'proj-worker/task-worker',
        projectId: 'proj-worker',
        slug: 'task-worker',
        title: 'Task Worker',
        status: 'queued',
      });

      const fakeEngine = new FakeEngine();
      const spawnSpy = vi.spyOn(fakeEngine, 'spawn');
      const engines = new Map<string, Engine>([['agy', fakeEngine]]);
      const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);

      const task = taskRepo.get('proj-worker/task-worker')!;
      await scheduler.startTask(task, 'gemini-3.8-flash-high', 'p1');

      // Scheduler không được gọi ensureWorktreeNodeModules
      expect(spy).not.toHaveBeenCalled();

      // Engine được gọi với prompt chứa câu cho phép worker tự cài
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnArgs = spawnSpy.mock.calls[0][0];
      expect(spawnArgs.prompt).toContain('Được phép chạy `npm ci`/`npm install` trong thư mục module (bọc `timeout 900`), dọn node_modules/dist khi xong nếu project yêu cầu.');
      expect(spawnArgs.prompt).not.toContain('đã được chuẩn bị sẵn');

      // CheckRunner không được gọi ensureWorktreeNodeModules
      const checkRunner = new CheckRunner(db);
      const projWorker = projectRepo.get('proj-worker')!;
      const runningTask = taskRepo.get('proj-worker/task-worker')!;
      const runs = runRepo.getByTask('proj-worker/task-worker');
      await checkRunner.run(runningTask, projWorker, runs[0].id);
      expect(spy).not.toHaveBeenCalled();

      scheduler.stop();
    });

    it('install=auto nhưng không có lockfile ở gốc/web: sinh prompt báo chưa có node_modules và cho chạy npm ci', async () => {
      const spy = vi.spyOn(cacheModule, 'ensureWorktreeNodeModules').mockImplementation(async () => {});

      // Tạo repo không có package-lock.json / pnpm-lock.yaml
      const noLockProjectPath = path.join(tmpDir, 'project-no-lock');
      fs.mkdirSync(noLockProjectPath, { recursive: true });
      execFileSync('git', ['init', '--template='], { cwd: noLockProjectPath });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: noLockProjectPath });
      fs.writeFileSync(path.join(noLockProjectPath, 'README.md'), '# No Lock');
      execFileSync('git', ['add', '.'], { cwd: noLockProjectPath });
      execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
        cwd: noLockProjectPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      });

      projectRepo.insert({
        id: 'proj-no-lock',
        name: 'Project No Lock',
        path: noLockProjectPath,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 3,
        settings: JSON.stringify({ worktree: { install: 'auto' } }),
      });

      taskRepo.insert({
        id: 'proj-no-lock/task-1',
        projectId: 'proj-no-lock',
        slug: 'task-1',
        title: 'Task 1',
        status: 'queued',
      });

      const fakeEngine = new FakeEngine();
      const spawnSpy = vi.spyOn(fakeEngine, 'spawn');
      const engines = new Map<string, Engine>([['agy', fakeEngine]]);
      const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);

      const task = taskRepo.get('proj-no-lock/task-1')!;
      await scheduler.startTask(task, 'gemini-3.8-flash-high', 'p1');

      // Không có lockfile nên ensureWorktreeNodeModules không được gọi
      expect(spy).not.toHaveBeenCalled();

      // Engine được gọi với prompt báo node_modules chưa có
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnArgs = spawnSpy.mock.calls[0][0];
      expect(spawnArgs.prompt).toContain('`node_modules` chưa có, được chạy `npm ci` khi cần test/build.');
      expect(spawnArgs.prompt).not.toContain('đã được chuẩn bị sẵn');

      scheduler.stop();
    });

    it('install=auto và cài lỗi: sinh prompt báo node_modules chưa có và cho chạy npm ci', async () => {
      vi.spyOn(cacheModule, 'ensureWorktreeNodeModules').mockImplementation(async () => {
        throw new Error('Fake install error');
      });

      projectRepo.insert({
        id: 'proj-install-err',
        name: 'Project Install Err',
        path: projectPath,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 3,
        settings: JSON.stringify({ worktree: { install: 'auto' } }),
      });

      taskRepo.insert({
        id: 'proj-install-err/task-1',
        projectId: 'proj-install-err',
        slug: 'task-1',
        title: 'Task 1',
        status: 'queued',
      });

      const fakeEngine = new FakeEngine();
      const spawnSpy = vi.spyOn(fakeEngine, 'spawn');
      const engines = new Map<string, Engine>([['agy', fakeEngine]]);
      const scheduler = new Scheduler(config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo, engines, undefined, undefined, db);

      const task = taskRepo.get('proj-install-err/task-1')!;
      await scheduler.startTask(task, 'gemini-3.8-flash-high', 'p1');

      // Engine được gọi với prompt báo node_modules chưa có
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnArgs = spawnSpy.mock.calls[0][0];
      expect(spawnArgs.prompt).toContain('`node_modules` chưa có, được chạy `npm ci` khi cần test/build.');
      expect(spawnArgs.prompt).not.toContain('đã được chuẩn bị sẵn');

      scheduler.stop();
    });
  });
});
