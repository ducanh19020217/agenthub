import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { measureProcessTree } from '../src/process-tree.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { LoadGuard } from '../src/load.js';

interface WorkerStatus {
  taskId: string;
  rss?: number;
  cpu?: number;
  paused?: boolean;
  pauseReason?: string | null;
}

interface StatusResponse {
  running: WorkerStatus[];
}

interface TaskDetailResponse {
  paused?: boolean;
  pauseReason?: string | null;
}

interface PauseEventPayload {
  reason?: string;
  runId?: string;
}

function getProcessState(pid: number): string | null {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^State:\s+([A-Z])/m);
    if (m) return m[1];
  } catch {
    // /proc is not available on macOS
  }
  try {
    const out = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const firstChar = out.charAt(0).toUpperCase();
    return firstChar || null;
  } catch {
    return null;
  }
}

describe('Task Pause and Resume (c-pause-resume)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let projectPath: string;
  let token: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-pause-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.FAKE_MODE = 'sleep-loop';

    config = loadConfig(tmpDir);
    config.port = 0;
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Main Repo');
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
      id: 'p-test',
      name: 'Project Test',
      path: projectPath,
      defaultBranch: 'main',
      maxParallel: 5,
    });

    for (let i = 1; i <= 5; i++) {
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

  it('1. measureProcessTree đo tổng RSS và %CPU của tiến trình thực', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    try {
      expect(child.pid).toBeDefined();
      const pid = child.pid!;

      // Chờ tiến trình khởi động
      await new Promise((resolve) => setTimeout(resolve, 100));

      const measurement1 = measureProcessTree(pid);
      expect(measurement1.rss).toBeGreaterThan(0);
      expect(measurement1.cpu).toBeGreaterThanOrEqual(0);

      // Đo lần 2 sau một khoảng thời gian
      await new Promise((resolve) => setTimeout(resolve, 100));
      const measurement2 = measureProcessTree(pid, undefined, {
        ticks: measurement1.totalTicks,
        at: measurement1.measuredAt,
      });
      expect(measurement2.rss).toBeGreaterThan(0);
      expect(measurement2.cpu).toBeGreaterThanOrEqual(0);
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    }
  });

  it('2. Scheduler pauseTask và resumeTask gửi SIGSTOP/SIGCONT thật, cập nhật trạng thái trong /proc', async () => {
    ctx.taskRepo.insert({
      id: 'p-test/t1',
      projectId: 'p-test',
      slug: 't1',
      title: 'Sleep Task',
      status: 'queued',
    });

    await ctx.scheduler.tick();

    const rt = ctx.scheduler.getRunning().get('p-test/t1');
    expect(rt).toBeDefined();
    expect(rt!.paused).toBe(false);
    expect(rt!.pid).toBeGreaterThan(0);

    // Chờ process chạy
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Ban đầu process đang chạy (S hoặc R)
    const initialState = getProcessState(rt!.pid);
    expect(['S', 'R']).toContain(initialState);

    // Bắt event
    let pausedEventReceived = false;
    ctx.scheduler.getEventBus().once('task.paused', (taskId: string, payload?: PauseEventPayload) => {
      if (taskId === 'p-test/t1' && payload?.reason === 'manual') {
        pausedEventReceived = true;
      }
    });

    // 1. Pause task
    const pauseOk = ctx.scheduler.pauseTask('p-test/t1', 'manual');
    expect(pauseOk).toBe(true);
    expect(rt!.paused).toBe(true);
    expect(rt!.pauseReason).toBe('manual');
    expect(pausedEventReceived).toBe(true);

    // Kiểm tra /proc/<pid>/status chuyển sang T (stopped)
    await vi.waitFor(() => {
      expect(getProcessState(rt!.pid)).toBe('T');
    }, { timeout: 2000 });

    // Bắt event resumed
    let resumedEventReceived = false;
    ctx.scheduler.getEventBus().once('task.resumed', (taskId: string) => {
      if (taskId === 'p-test/t1') {
        resumedEventReceived = true;
      }
    });

    // 2. Resume task
    const resumeOk = ctx.scheduler.resumeTask('p-test/t1');
    expect(resumeOk).toBe(true);
    expect(rt!.paused).toBe(false);
    expect(rt!.pauseReason).toBeNull();
    expect(resumedEventReceived).toBe(true);

    // Kiểm tra /proc/<pid>/status quay lại S hoặc R
    await vi.waitFor(() => {
      expect(['S', 'R']).toContain(getProcessState(rt!.pid));
    }, { timeout: 2000 });
  });

  it('3. Đóng băng đồng hồ timeout và stall watchdog khi task bị pause', async () => {
    ctx.taskRepo.insert({
      id: 'p-test/t-timeout',
      projectId: 'p-test',
      slug: 't-timeout',
      title: 'Timeout Test',
      status: 'queued',
    });

    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('p-test/t-timeout')!;
    expect(rt).toBeDefined();

    // Pause task
    ctx.scheduler.pauseTask('p-test/t-timeout', 'manual');
    expect(rt.paused).toBe(true);

    // Giả lập thời gian đã quá timeout
    const savedTimeoutAt = Date.now() - 5000;
    rt.timeoutAt = savedTimeoutAt;

    // Gọi checkRunningTasks: task không được coi là timeout hay stall vì đang paused
    await (ctx.scheduler as unknown as { checkRunningTasks: () => Promise<void> }).checkRunningTasks();
    expect(ctx.scheduler.getRunning().has('p-test/t-timeout')).toBe(true);
    const taskInDb = ctx.taskRepo.get('p-test/t-timeout')!;
    expect(taskInDb.status).toBe('running');

    // Chờ 100ms pause duration rồi resume
    await new Promise((resolve) => setTimeout(resolve, 100));
    ctx.scheduler.resumeTask('p-test/t-timeout');
    expect(rt.paused).toBe(false);

    // TimeoutAt được đẩy lùi về tương lai theo thời gian đã pause
    expect(rt.timeoutAt).toBeGreaterThan(savedTimeoutAt);
  });

  it('4. Load guard tự động pause task theo chính sách (recent vs rss) và tự động resume tuần tự khi tải giảm', async () => {
    // 3 tasks
    for (const slug of ['t1', 't2', 't3']) {
      ctx.taskRepo.insert({
        id: `p-test/${slug}`,
        projectId: 'p-test',
        slug,
        title: `Task ${slug}`,
        status: 'queued',
      });
    }

    await ctx.scheduler.tick();
    await vi.waitFor(() => {
      expect(ctx.scheduler.getRunning().size).toBe(3);
    }, { timeout: 5000 });
    const running = Array.from(ctx.scheduler.getRunning().values());

    // Gán thời gian bắt đầu và RSS giả lập
    const t1 = ctx.scheduler.getRunning().get('p-test/t1')!;
    const t2 = ctx.scheduler.getRunning().get('p-test/t2')!;
    const t3 = ctx.scheduler.getRunning().get('p-test/t3')!;

    // Keep this policy test independent from worker startup/exit timing. The workers are
    // cleaned up by afterEach; this test only exercises the scheduler's load decisions.
    vi.spyOn(ctx.scheduler as unknown as { isProcessAlive: (pid: number | null, pidStart?: number | null) => boolean }, 'isProcessAlive')
      .mockReturnValue(true);
    for (const task of [t1, t2, t3]) task.lastCommitCheckAt = Date.now();

    t1.startTime = 1000;
    t2.startTime = 2000;
    t3.startTime = 3000; // Most recent

    t1.rss = 100 * 1024 * 1024;
    t2.rss = 500 * 1024 * 1024; // Highest RSS
    t3.rss = 200 * 1024 * 1024;

    const loadGuard = (ctx.scheduler as unknown as { loadGuard: LoadGuard }).loadGuard;
    expect(loadGuard).toBeDefined();
    vi.spyOn(loadGuard, 'update').mockImplementation(() => ({
      load1: 0,
      freeMemGB: 16,
      overloaded: loadGuard.isOverloaded(),
      recoveringSince: null,
      highSince: null,
      autoPauseTriggered: loadGuard.isAutoPauseTriggered(),
    }));

    // 4.1 Chính sách 'recent': task gần nhất (t3) bị pause trước
    ctx.config.load.enabled = true;
    ctx.config.load.pausePolicy = 'recent';
    ctx.config.load.maxAutoPaused = 1;
    vi.spyOn(loadGuard, 'isAutoPauseTriggered').mockReturnValue(true);
    vi.spyOn(loadGuard, 'isOverloaded').mockReturnValue(true);

    await ctx.scheduler.tick();

    expect(t3.paused).toBe(true);
    expect(t3.pauseReason).toBe('load');
    expect(t1.paused).toBe(false);
    expect(t2.paused).toBe(false);

    // 4.2 maxAutoPaused = 1 ngăn không pause thêm task thứ 2
    await ctx.scheduler.tick();
    expect(running.filter((t) => t.paused).length).toBe(1);

    // 4.3 Tăng maxAutoPaused = 2 -> task recent tiếp theo (t2) bị pause
    ctx.config.load.maxAutoPaused = 2;
    await ctx.scheduler.tick();
    expect(t2.paused).toBe(true);
    expect(t2.pauseReason).toBe('load');
    expect(t1.paused).toBe(false);

    // 4.4 Load hồi phục: tự động resume tuần tự (mỗi tick resume 1 task)
    vi.spyOn(loadGuard, 'isAutoPauseTriggered').mockReturnValue(false);
    vi.spyOn(loadGuard, 'isOverloaded').mockReturnValue(false);

    // Tick 1: resume 1 task
    await ctx.scheduler.tick();
    expect(running.filter((t) => t.paused).length).toBe(1);

    // Tick 2: resume task còn lại
    await ctx.scheduler.tick();
    expect(running.filter((t) => t.paused).length).toBe(0);

    // 4.5 Chính sách 'rss': task có RSS cao nhất (t2: 500MB) bị pause trước
    ctx.config.load.pausePolicy = 'rss';
    ctx.config.load.maxAutoPaused = 1;
    vi.spyOn(loadGuard, 'isAutoPauseTriggered').mockReturnValue(true);
    vi.spyOn(loadGuard, 'isOverloaded').mockReturnValue(true);

    await ctx.scheduler.tick();
    expect(t2.paused).toBe(true);
    expect(t2.pauseReason).toBe('load');
    expect(t1.paused).toBe(false);
    expect(t3.paused).toBe(false);
  });

  it('5. Daemon stop() gửi SIGCONT tới tất cả các task paused để dọn sạch tiến trình', async () => {
    ctx.taskRepo.insert({
      id: 'p-test/t-stop',
      projectId: 'p-test',
      slug: 't-stop',
      title: 'Stop Test',
      status: 'queued',
    });

    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('p-test/t-stop')!;
    expect(rt).toBeDefined();

    // Chờ process chạy
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Pause task
    ctx.scheduler.pauseTask('p-test/t-stop', 'manual');
    expect(rt.paused).toBe(true);
    await vi.waitFor(() => {
      expect(getProcessState(rt.pid)).toBe('T');
    }, { timeout: 2000 });

    // Dừng scheduler -> Requirement 4: gửi SIGCONT tới mọi task paused
    ctx.scheduler.stop();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Task không còn bị treo ở trạng thái T (đã được SIGCONT, trở lại S hoặc R)
    expect(rt.paused).toBe(false);
    expect(['S', 'R']).toContain(getProcessState(rt.pid));

    // Dọn tiến trình để kết thúc test
    try {
      process.kill(-rt.pid, 'SIGKILL');
    } catch {
      try {
        process.kill(rt.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  });

  it('6. API POST /api/tasks/:id/pause và /resume và các trường tài nguyên lộ qua /api/status', async () => {
    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as net.AddressInfo).port;

    ctx.taskRepo.insert({
      id: 'p-test/t-api',
      projectId: 'p-test',
      slug: 't-api',
      title: 'API Test',
      status: 'queued',
    });

    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('p-test/t-api')!;
    expect(rt).toBeDefined();
    rt.rss = 157286400; // 150 MB
    rt.cpu = 18.2;

    try {
      // 1. Kiểm tra /api/status ban đầu
      const statusRes1 = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const statusData1 = (await statusRes1.json()) as StatusResponse;
      const worker1 = statusData1.running.find((w) => w.taskId === 'p-test/t-api');
      expect(worker1).toBeDefined();
      expect(worker1!.rss).toBe(157286400);
      expect(worker1!.cpu).toBe(18.2);
      expect(worker1!.paused).toBe(false);

      // 2. Gọi POST /api/tasks/:id/pause
      const pauseRes = await fetch(`http://127.0.0.1:${port}/api/tasks/p-test~t-api/pause`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(pauseRes.status).toBe(200);
      const pauseData = (await pauseRes.json()) as { ok: boolean; paused: boolean };
      expect(pauseData.ok).toBe(true);
      expect(pauseData.paused).toBe(true);

      // 3. /api/status phản ánh trạng thái paused
      const statusRes2 = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const statusData2 = (await statusRes2.json()) as StatusResponse;
      const worker2 = statusData2.running.find((w) => w.taskId === 'p-test/t-api');
      expect(worker2!.paused).toBe(true);
      expect(worker2!.pauseReason).toBe('manual');

      // 4. /api/tasks/:id phản ánh paused
      const taskDetailRes = await fetch(`http://127.0.0.1:${port}/api/tasks/p-test~t-api`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const taskDetailData = (await taskDetailRes.json()) as TaskDetailResponse;
      expect(taskDetailData.paused).toBe(true);
      expect(taskDetailData.pauseReason).toBe('manual');

      // 5. Gọi POST /api/tasks/:id/resume
      const resumeRes = await fetch(`http://127.0.0.1:${port}/api/tasks/p-test~t-api/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(resumeRes.status).toBe(200);
      const resumeData = (await resumeRes.json()) as { ok: boolean; paused: boolean };
      expect(resumeData.ok).toBe(true);
      expect(resumeData.paused).toBe(false);

      // 6. /api/status phản ánh unpaused
      const statusRes3 = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const statusData3 = (await statusRes3.json()) as StatusResponse;
      const worker3 = statusData3.running.find((w) => w.taskId === 'p-test/t-api');
      expect(worker3!.paused).toBe(false);
      expect(worker3!.pauseReason).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('7. Brain pause với reason load tự động resume khi nhận event load.ok', async () => {
    ctx.taskRepo.insert({
      id: 'p-test/t-brain-load',
      projectId: 'p-test',
      slug: 't-brain-load',
      title: 'Brain Load Test',
      status: 'queued',
    });

    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('p-test/t-brain-load')!;
    expect(rt).toBeDefined();

    // Giả lập brain gọi pause với reason 'load'
    ctx.scheduler.pauseTask('p-test/t-brain-load', 'load');
    expect(rt.paused).toBe(true);
    expect(rt.pauseReason).toBe('load');

    // Bắn event load.ok
    ctx.scheduler.getEventBus().emit('load.ok');

    // Scheduler lắng nghe load.ok và tự động resume task
    expect(rt.paused).toBe(false);
    expect(rt.pauseReason).toBeNull();
  });

  it('8. Pause manual không tự resume khi có load.ok hoặc tick không quá tải, nhưng gửi nhắc nhở sau 30 phút', async () => {
    ctx.taskRepo.insert({
      id: 'p-test/t-manual-remind',
      projectId: 'p-test',
      slug: 't-manual-remind',
      title: 'Manual Pause Reminder Test',
      status: 'queued',
    });

    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('p-test/t-manual-remind')!;
    expect(rt).toBeDefined();

    // User pause thủ công
    ctx.scheduler.pauseTask('p-test/t-manual-remind', 'manual');
    expect(rt.paused).toBe(true);
    expect(rt.pauseReason).toBe('manual');

    // Bắn load.ok -> không được tự resume
    ctx.scheduler.getEventBus().emit('load.ok');
    expect(rt.paused).toBe(true);

    // Thu thập event task.pause_reminder
    const reminders: Array<{ taskId: string; payload: unknown }> = [];
    ctx.scheduler.getEventBus().on('task.pause_reminder', (taskId, payload) => {
      reminders.push({ taskId, payload });
    });

    // Tick bình thường (thời gian pause chưa đủ 30 phút)
    await ctx.scheduler.tick();
    expect(rt.paused).toBe(true);
    expect(reminders.length).toBe(0);

    // Giả lập đã pause 31 phút trước
    rt.pausedAt = Date.now() - 31 * 60 * 1000;

    // Tick lần 1 -> phát thông báo nhắc nhở 1 lần
    await ctx.scheduler.tick();
    expect(rt.paused).toBe(true); // Vẫn pause, không tự resume
    expect(reminders.length).toBe(1);
    expect(reminders[0].taskId).toBe('p-test/t-manual-remind');
    expect(reminders[0].payload).toMatchObject({
      reason: 'manual',
      pausedMin: 31,
    });

    // Tick lần 2 -> không gửi lại (chỉ nhắc 1 lần)
    await ctx.scheduler.tick();
    expect(reminders.length).toBe(1);
  });

  it('9. Safety net: task pause reason load tự resume trong tick nếu máy không quá tải', async () => {
    ctx.taskRepo.insert({
      id: 'p-test/t-load-safety',
      projectId: 'p-test',
      slug: 't-load-safety',
      title: 'Load Safety Resume Test',
      status: 'queued',
    });

    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('p-test/t-load-safety')!;
    expect(rt).toBeDefined();

    ctx.scheduler.pauseTask('p-test/t-load-safety', 'brain_load');
    expect(rt.paused).toBe(true);

    // Máy không quá tải, gọi tick -> tự động resume
    await ctx.scheduler.tick();
    expect(rt.paused).toBe(false);
    expect(rt.pauseReason).toBeNull();
  });

  it('10. Watchdog stall check bỏ qua các task đang paused', async () => {
    ctx.taskRepo.insert({
      id: 'p-test/t-stall-paused',
      projectId: 'p-test',
      slug: 't-stall-paused',
      title: 'Stall Paused Test',
      status: 'queued',
    });

    await ctx.scheduler.tick();
    const rt = ctx.scheduler.getRunning().get('p-test/t-stall-paused')!;
    expect(rt).toBeDefined();

    ctx.scheduler.pauseTask('p-test/t-stall-paused', 'manual');

    // Giả lập lastActivityAt và lastOutputAt rất cũ (> 10 phút trước)
    rt.lastActivityAt = Date.now() - 10 * 60 * 1000;
    rt.lastOutputAt = Date.now() - 10 * 60 * 1000;

    // Check running tasks
    await (ctx.scheduler as unknown as { checkRunningTasks: () => Promise<void> }).checkRunningTasks();

    // Task không bị kill hay stall do đang paused
    expect(ctx.scheduler.getRunning().has('p-test/t-stall-paused')).toBe(true);
    expect(rt.paused).toBe(true);
  });
});
