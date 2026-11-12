import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';

describe('Project Focus Mode (agenthub/p-project-priority)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let token: string;

  function initProject(id: string, name: string, maxParallel = 3): string {
    const projectPath = path.join(tmpDir, id);
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), `# ${name}`);
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
      id,
      name,
      path: projectPath,
      defaultBranch: 'main',
      maxParallel,
    });
    return projectPath;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-focus-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.FAKE_MODE = 'sleep-loop';

    config = loadConfig(tmpDir);
    config.port = 0;
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([
      ['agy', fakeEngine],
      ['codex', fakeEngine],
    ]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    initProject('proj-x', 'Project X', 3);
    initProject('proj-y', 'Project Y', 3);
    initProject('proj-z', 'Project Z', 3);

    for (let i = 1; i <= 6; i++) {
      ctx.profileRepo.upsert({
        name: `p${i}`,
        engine: 'agy',
        kind: 'isolated',
        home: path.join(agyHomesDir, `p${i}`),
        email: `p${i}@example.com`,
        enabled: 1,
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.scheduler.stop();
    ctx.scheduler.cancelAll();
    ctx.db.close();
    delete process.env.FAKE_MODE;
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('1. Bật focus X: pause task đang chạy của Y, đánh dấu waitReason=focus cho task chờ của Y, dispatch task của X', async () => {
    // Y có 1 task chạy và 2 task chờ
    ctx.taskRepo.insert({
      id: 'proj-y/t1',
      projectId: 'proj-y',
      slug: 't1',
      title: 'Task Y1',
      status: 'queued',
    });
    await ctx.scheduler.tick();

    const rtY1 = ctx.scheduler.getRunning().get('proj-y/t1');
    expect(rtY1).toBeDefined();
    expect(rtY1!.paused).toBe(false);

    ctx.taskRepo.insert({
      id: 'proj-y/t2',
      projectId: 'proj-y',
      slug: 't2',
      title: 'Task Y2',
      status: 'queued',
    });
    ctx.taskRepo.insert({
      id: 'proj-y/t3',
      projectId: 'proj-y',
      slug: 't3',
      title: 'Task Y3',
      status: 'queued',
    });

    // X có 1 task chờ
    ctx.taskRepo.insert({
      id: 'proj-x/t1',
      projectId: 'proj-x',
      slug: 't1',
      title: 'Task X1',
      status: 'queued',
    });

    // Bật focus cho proj-x
    const res = ctx.service.setFocus({ projectId: 'proj-x' });
    expect(res.focus.projectId).toBe('proj-x');
    expect(res.paused).toBe(1);
    expect(res.waiting).toBe(2);

    // Task chạy của Y bị pause với pauseReason='focus'
    expect(rtY1!.paused).toBe(true);
    expect(rtY1!.pauseReason).toBe('focus');

    // 2 task chờ của Y có waitReason='focus'
    expect(ctx.taskRepo.get('proj-y/t2')?.waitReason).toBe('focus');
    expect(ctx.taskRepo.get('proj-y/t3')?.waitReason).toBe('focus');

    // Dispatch: task của X được chạy, task của Y tiếp tục chờ
    await ctx.scheduler.tick();
    const rtX1 = ctx.scheduler.getRunning().get('proj-x/t1');
    expect(rtX1).toBeDefined();
    expect(rtX1!.paused).toBe(false);

    expect(ctx.taskRepo.get('proj-y/t2')?.status).toBe('queued');
    expect(ctx.taskRepo.get('proj-y/t3')?.status).toBe('queued');
  });

  it('2. Tắt focus: resume task bị pause vì focus, xóa waitReason và dispatch lại', async () => {
    ctx.taskRepo.insert({
      id: 'proj-y/t1',
      projectId: 'proj-y',
      slug: 't1',
      title: 'Task Y1',
      status: 'queued',
    });
    await ctx.scheduler.tick();
    const rtY1 = ctx.scheduler.getRunning().get('proj-y/t1')!;

    ctx.taskRepo.insert({
      id: 'proj-y/t2',
      projectId: 'proj-y',
      slug: 't2',
      title: 'Task Y2',
      status: 'queued',
    });

    // Bật focus
    ctx.service.setFocus({ projectId: 'proj-x' });
    expect(rtY1.paused).toBe(true);
    expect(rtY1.pauseReason).toBe('focus');
    expect(ctx.taskRepo.get('proj-y/t2')?.waitReason).toBe('focus');

    // Tắt focus
    const res = ctx.service.setFocus({ projectId: null });
    expect(res.focus.projectId).toBeNull();
    expect(res.resumed).toBe(1);

    // Task Y1 được resume
    expect(rtY1.paused).toBe(false);
    expect(rtY1.pauseReason).toBeNull();

    // Task Y2 bỏ waitReason='focus'
    expect(ctx.taskRepo.get('proj-y/t2')?.waitReason).toBeNull();

    // Scheduler dispatch tiếp
    await ctx.scheduler.tick();
    const rtY2 = ctx.scheduler.getRunning().get('proj-y/t2');
    expect(rtY2).toBeDefined();
    expect(rtY2!.paused).toBe(false);
  });

  it('3. Task người dùng tự pause (manual) thì không bị resume khi thay đổi hoặc tắt focus', async () => {
    ctx.taskRepo.insert({
      id: 'proj-y/t-manual',
      projectId: 'proj-y',
      slug: 't-manual',
      title: 'Manual Paused Task',
      status: 'queued',
    });
    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('proj-y/t-manual')!;

    // Người dùng tự pause
    const ok = ctx.scheduler.pauseTask('proj-y/t-manual', 'manual');
    expect(ok).toBe(true);
    expect(rt.paused).toBe(true);
    expect(rt.pauseReason).toBe('manual');

    // Bật focus cho proj-x
    ctx.service.setFocus({ projectId: 'proj-x' });
    expect(rt.paused).toBe(true);
    expect(rt.pauseReason).toBe('manual');

    // Tắt focus
    ctx.service.setFocus({ projectId: null });
    expect(rt.paused).toBe(true);
    expect(rt.pauseReason).toBe('manual');

    // Chuyển focus sang proj-y
    ctx.service.setFocus({ projectId: 'proj-y' });
    expect(rt.paused).toBe(true);
    expect(rt.pauseReason).toBe('manual');
  });

  it('4. Chuyển focus sang project khác với pauseRunning=false: resume các task đã bị pause vì focus, không pause task của project khác', async () => {
    // 1. Khởi động task trên X, Y, Z
    ctx.taskRepo.insert({
      id: 'proj-y/t1',
      projectId: 'proj-y',
      slug: 't1',
      title: 'Task Y1',
      status: 'queued',
    });
    ctx.taskRepo.insert({
      id: 'proj-z/t1',
      projectId: 'proj-z',
      slug: 't1',
      title: 'Task Z1',
      status: 'queued',
    });
    await ctx.scheduler.tick();

    const rtY = ctx.scheduler.getRunning().get('proj-y/t1')!;
    const rtZ = ctx.scheduler.getRunning().get('proj-z/t1')!;
    expect(rtY.paused).toBe(false);
    expect(rtZ.paused).toBe(false);

    // 2. Bật focus cho X với pauseRunning=true -> Y và Z bị pause với pauseReason='focus'
    ctx.service.setFocus({ projectId: 'proj-x', pauseRunning: true });
    expect(rtY.paused).toBe(true);
    expect(rtY.pauseReason).toBe('focus');
    expect(rtZ.paused).toBe(true);
    expect(rtZ.pauseReason).toBe('focus');

    // Khởi động task trên X
    ctx.taskRepo.insert({
      id: 'proj-x/t1',
      projectId: 'proj-x',
      slug: 't1',
      title: 'Task X1',
      status: 'queued',
    });
    await ctx.scheduler.tick();
    const rtX = ctx.scheduler.getRunning().get('proj-x/t1')!;
    expect(rtX.paused).toBe(false);

    // 3. Bây giờ chuyển focus sang project Y với pauseRunning=false
    // - Task của Y (project được focus mới) phải được resume
    // - Task của X (project cũ, không còn được focus) KHÔNG bị pause vì pauseRunning=false
    // - Task của Z (project khác không được focus, trước đó bị pause vì focus) PHẢI được resume vì pauseRunning=false
    const changeResult = ctx.service.setFocus({ projectId: 'proj-y', pauseRunning: false });
    expect(changeResult.focus.projectId).toBe('proj-y');
    expect(changeResult.focus.pauseRunning).toBe(false);
    expect(changeResult.resumed).toBe(2); // Y và Z
    expect(changeResult.paused).toBe(0);

    // Kiểm tra trạng thái runtime
    expect(rtY.paused).toBe(false);
    expect(rtY.pauseReason).toBeNull();

    expect(rtX.paused).toBe(false);
    expect(rtX.pauseReason).toBeNull();

    expect(rtZ.paused).toBe(false);
    expect(rtZ.pauseReason).toBeNull();
  });

  it('5. Chuyển focus từ X sang Y với pauseRunning=true: pause task của X, resume task của Y', async () => {
    ctx.taskRepo.insert({
      id: 'proj-y/t1',
      projectId: 'proj-y',
      slug: 't1',
      title: 'Task Y1',
      status: 'queued',
    });
    await ctx.scheduler.tick();
    const rtY = ctx.scheduler.getRunning().get('proj-y/t1')!;

    // Bật focus cho X
    ctx.service.setFocus({ projectId: 'proj-x', pauseRunning: true });
    expect(rtY.paused).toBe(true);
    expect(rtY.pauseReason).toBe('focus');

    // Khởi động task của X
    ctx.taskRepo.insert({
      id: 'proj-x/t1',
      projectId: 'proj-x',
      slug: 't1',
      title: 'Task X1',
      status: 'queued',
    });
    await ctx.scheduler.tick();
    const rtX = ctx.scheduler.getRunning().get('proj-x/t1')!;
    expect(rtX.paused).toBe(false);

    // Chuyển focus sang Y với pauseRunning=true
    const result = ctx.service.setFocus({ projectId: 'proj-y', pauseRunning: true });
    expect(result.paused).toBe(1); // X bị pause
    expect(result.resumed).toBe(1); // Y được resume

    expect(rtX.paused).toBe(true);
    expect(rtX.pauseReason).toBe('focus');

    expect(rtY.paused).toBe(false);
    expect(rtY.pauseReason).toBeNull();
  });

  it('6. Reviewer và lượt check chỉ chạy cho project được focus', async () => {
    ctx.profileRepo.upsert({
      name: 'codex-p1',
      engine: 'codex',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-homes', 'codex-p1'),
      email: 'codex1@example.com',
      enabled: 1,
    });

    const chain = [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }];
    ctx.projectRepo.update('proj-x', { review: JSON.stringify({ chain }) });
    ctx.projectRepo.update('proj-y', { review: JSON.stringify({ chain }) });

    ctx.taskRepo.insert({
      id: 'proj-x/t-rev',
      projectId: 'proj-x',
      slug: 't-rev',
      title: 'Review Task X',
      status: 'review',
    });
    ctx.taskRepo.update('proj-x/t-rev', { worktreePath: path.join(tmpDir, 'proj-x') });

    ctx.taskRepo.insert({
      id: 'proj-y/t-rev',
      projectId: 'proj-y',
      slug: 't-rev',
      title: 'Review Task Y',
      status: 'review',
    });
    ctx.taskRepo.update('proj-y/t-rev', { worktreePath: path.join(tmpDir, 'proj-y') });

    // Autocheck results cho cả 2 task
    ctx.db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)')
      .run('run-chk-x', 'proj-x/t-rev', 'agy', 'gemini-3.8-flash', 'p1');
    ctx.db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('proj-x/t-rev', 'run-chk-x', 'test', 1, 0, 10, 'OK');

    ctx.db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)')
      .run('run-chk-y', 'proj-y/t-rev', 'agy', 'gemini-3.8-flash', 'p1');
    ctx.db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('proj-y/t-rev', 'run-chk-y', 'test', 1, 0, 10, 'OK');

    // Bật focus cho proj-x
    ctx.service.setFocus({ projectId: 'proj-x' });

    // Kích hoạt tick scheduler
    await ctx.scheduler.tick();

    // Reviewer runs chỉ chứa task của proj-x, không có proj-y
    const reviewerRuns = (ctx.scheduler as unknown as { reviewerRuns: Map<string, unknown> }).reviewerRuns;
    expect(reviewerRuns.has('proj-x/t-rev')).toBe(true);
    expect(reviewerRuns.has('proj-y/t-rev')).toBe(false);

    // Kiểm tra thêm pumpChecks: check của proj-y không được dequeue khi đang focus proj-x
    void ctx.scheduler.runChecksForTask('proj-y/t-rev', 'run-chk-y');
    const checkingActive = (ctx.scheduler as unknown as { checkingActive: Set<string> }).checkingActive;
    expect(checkingActive.has('proj-y/t-rev')).toBe(false);
  });

  it('7. Focus bền vững qua restart và xử lý worker đã chết khi hub khởi động lại', async () => {
    // 1. Bật focus cho proj-x
    ctx.service.setFocus({ projectId: 'proj-x', pauseRunning: true });

    // Kiểm tra cấu hình lưu trên đĩa
    const savedConfig = loadConfig(tmpDir);
    expect(savedConfig.focus.projectId).toBe('proj-x');
    expect(savedConfig.focus.pauseRunning).toBe(true);

    // Tạo một task đang chạy trên proj-y nhưng tiến trình worker giả đã chết
    // Chú ý: tasks row phải tồn tại trước khi insert runs row (foreign key constraint)
    ctx.taskRepo.insert({
      id: 'proj-y/dead-task',
      projectId: 'proj-y',
      slug: 'dead-task',
      title: 'Dead Task',
      status: 'running',
    });
    const runId = 'dead-run-1';
    ctx.runRepo.insert({
      id: runId,
      taskId: 'proj-y/dead-task',
      engine: 'agy',
      model: 'gemini-3.8-flash',
      profileName: 'p1',
      logPath: path.join(tmpDir, 'dead.log'),
    });
    ctx.runRepo.updatePid(runId, 99999999, 12345); // PID không tồn tại

    // Tạo context mới mô phỏng restart daemon
    ctx.scheduler.stop();
    ctx.db.close();

    const newConfig = loadConfig(tmpDir);
    const newCtx = createContext(newConfig, new Map<string, Engine>([['agy', fakeEngine]]));
    newCtx.scheduler.start();
    newCtx.scheduler.stop();

    // Task của worker đã chết được requeue với resume: 1
    const recoveredTask = newCtx.taskRepo.get('proj-y/dead-task');
    expect(recoveredTask?.status).toBe('queued');
    expect(recoveredTask?.resume).toBe(1);
    // Vì đang focus cho proj-x nên task của proj-y có waitReason='focus'
    expect(recoveredTask?.waitReason).toBe('focus');

    newCtx.scheduler.cancelAll();
    newCtx.db.close();
  });

  it('8. Project được focus không bị load guard hạ effectiveParallel về 1 trừ khi máy vượt ngưỡng high', () => {
    const projX = ctx.projectRepo.get('proj-x')!;
    const projY = ctx.projectRepo.get('proj-y')!;

    // Chưa bật focus: cả 2 dùng loadGuard bình thường
    expect(ctx.scheduler.effectiveParallel(projX)).toBe(3);
    expect(ctx.scheduler.effectiveParallel(projY)).toBe(3);

    // Bật focus cho X
    ctx.service.setFocus({ projectId: 'proj-x' });

    // Mô phỏng load status: moderate (không phải high)
    const loadGuard = (ctx.scheduler as unknown as { loadGuard: { getStatus: () => { highSince: number | null; effectiveParallel: (n: number) => number } } }).loadGuard;
    const origGetStatus = loadGuard.getStatus.bind(loadGuard);
    const origEffective = loadGuard.effectiveParallel.bind(loadGuard);

    loadGuard.getStatus = () => ({ highSince: null, effectiveParallel: () => 1 });
    loadGuard.effectiveParallel = () => 1;

    // proj-x vẫn giữ maxParallel (3), không bị hạ về 1
    expect(ctx.scheduler.effectiveParallel(projX)).toBe(3);
    // proj-y bị hạ về 1
    expect(ctx.scheduler.effectiveParallel(projY)).toBe(1);

    // Khi máy vượt ngưỡng high thật (highSince != null): cả 2 đều bị hạ
    loadGuard.getStatus = () => ({ highSince: Date.now() - 60000, effectiveParallel: () => 1 });
    expect(ctx.scheduler.effectiveParallel(projX)).toBe(1);
    expect(ctx.scheduler.effectiveParallel(projY)).toBe(1);

    loadGuard.getStatus = origGetStatus;
    loadGuard.effectiveParallel = origEffective;
  });

  it('9. API GET /api/focus và PUT /api/focus hoạt động và yêu cầu xác thực', async () => {
    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as net.AddressInfo).port;

    try {
      // 1. GET /api/focus không token -> 401
      const getUnauth = await fetch(`http://127.0.0.1:${port}/api/focus`);
      expect(getUnauth.status).toBe(401);

      // 2. GET /api/focus có token -> 200
      const getAuth = await fetch(`http://127.0.0.1:${port}/api/focus`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(getAuth.status).toBe(200);
      const focusData = (await getAuth.json()) as { projectId: string | null; pauseRunning: boolean };
      expect(focusData.projectId).toBeNull();

      // 3. PUT /api/focus không token -> 401
      const putUnauth = await fetch(`http://127.0.0.1:${port}/api/focus`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-x' }),
      });
      expect(putUnauth.status).toBe(401);

      // 4. PUT /api/focus với project không tồn tại -> 404
      const putNotFound = await fetch(`http://127.0.0.1:${port}/api/focus`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ projectId: 'proj-non-existent' }),
      });
      expect(putNotFound.status).toBe(404);

      // 5. PUT /api/focus hợp lệ -> 200
      const putValid = await fetch(`http://127.0.0.1:${port}/api/focus`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ projectId: 'proj-x', pauseRunning: false }),
      });
      expect(putValid.status).toBe(200);
      const putResult = (await putValid.json()) as { focus: { projectId: string | null; pauseRunning: boolean } };
      expect(putResult.focus.projectId).toBe('proj-x');
      expect(putResult.focus.pauseRunning).toBe(false);

      // 6. GET /api/focus phản ánh giá trị mới
      const getUpdated = await fetch(`http://127.0.0.1:${port}/api/focus`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const updatedData = (await getUpdated.json()) as { projectId: string | null; pauseRunning: boolean };
      expect(updatedData.projectId).toBe('proj-x');
      expect(updatedData.pauseRunning).toBe(false);
    } finally {
      await server.close();
    }
  });
});
