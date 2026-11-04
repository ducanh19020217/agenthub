import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { formatEventSummary } from '../src/services/index.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeEngine: FakeEngine;

function authHeaders() {
  return {
    host: '127.0.0.1:7790',
    authorization: `Bearer ${token}`,
  };
}

describe('GET /api/status enrichment', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-status-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 7790;
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    // Stop scheduler loop to avoid unwanted automatic transitions
    ctx.scheduler.stop();
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
  });

  it('enriches running tasks with title, projectId, slug, and worktreePath', async () => {
    // 1. Create a project and task
    ctx.projectRepo.insert({
      id: 'test-project',
      name: 'Test Project',
      path: '/tmp/test-project',
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });

    ctx.taskRepo.insert({
      id: 'test-project/task-1',
      projectId: 'test-project',
      slug: 'task-1',
      title: 'Tích hợp thanh toán',
      body: 'Mô tả task',
      level: 'easy',
      baseRef: 'main',
      branch: 'agenthub/task-1',
      status: 'running',
    });
    ctx.taskRepo.update('test-project/task-1', {
      worktreePath: '/tmp/worktrees/test-project/task-1',
    });

    // 2. Mock a running entry in scheduler
    const runningMap = ctx.scheduler.getRunning();
    runningMap.set('test-project/task-1', {
      runId: 'run-test-1',
      taskId: 'test-project/task-1',
      pid: 1234,
      pidStart: 1234,
      profileName: 'chinh',
      model: 'gemini-3.8-flash-high',
      engine: fakeEngine,
      startTime: Date.now() - 5000,
      timeoutMs: 3600000,
      retryCount: 0,
      projectId: 'test-project',
    });

    // 3. Call GET /api/status
    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.running).toHaveLength(1);
    const runningWorker = body.running[0];

    expect(runningWorker.taskId).toBe('test-project/task-1');
    expect(runningWorker.title).toBe('Tích hợp thanh toán');
    expect(runningWorker.projectId).toBe('test-project');
    expect(runningWorker.slug).toBe('task-1');
    expect(runningWorker.worktreePath).toBe('/tmp/worktrees/test-project/task-1');

    expect(body.disk).toBeDefined();
    expect(typeof body.disk.freeGB).toBe('number');
    expect(typeof body.disk.totalGB).toBe('number');
  });

  describe('formatEventSummary unit tests', () => {
    it('generates summary for task.review_ready matching example', () => {
      expect(formatEventSummary('task.review_ready', null, 'a1')).toBe('a1 chuyển sang chờ review');
      expect(formatEventSummary('task.review_ready', null, 'agenthub/a1')).toBe('a1 chuyển sang chờ review');
      expect(formatEventSummary('task.review', null, 'a1')).toBe('a1 chuyển sang chờ review');
    });

    it('generates summary for quota.exhausted matching example', () => {
      expect(
        formatEventSummary('quota.exhausted', {
          profile: 'g2',
          family: 'claude',
          time: '16:35',
        }),
      ).toBe('g2 hết quota claude tới 16:35');

      expect(
        formatEventSummary('quota.exhausted', {
          profile: 'g2',
          family: 'claude',
          untilStr: '16:35',
        }),
      ).toBe('g2 hết quota claude tới 16:35');
    });

    it('generates summary for various event types', () => {
      expect(formatEventSummary('task.blocked', null, 'task-b')).toBe('task-b bị chặn');
      expect(formatEventSummary('task.failed', null, 'task-f')).toBe('task-f thất bại');
      expect(formatEventSummary('task.done', null, 'task-d')).toBe('task-d hoàn thành');
      expect(formatEventSummary('task.done', { reason: 'merged_elsewhere' }, 'task-d')).toBe('task-d hoàn thành (đã merge qua nhánh khác)');
      expect(formatEventSummary('task.auto_closed', { reason: 'merged_elsewhere' }, 'task-a')).toBe('task-a tự động hoàn thành (đã merge qua nhánh khác)');
      expect(formatEventSummary('task.cancelled', null, 'task-c')).toBe('task-c đã bị hủy');
      expect(formatEventSummary('task.waiting_quota', null, 'task-w')).toBe('task-w chờ quota khả dụng');
      expect(formatEventSummary('task.queued', null, 'task-q')).toBe('task-q được đưa vào hàng đợi');
      expect(formatEventSummary('task.queued', { reason: 'quota_retry' }, 'task-q')).toBe(
        'task-q được đưa vào hàng đợi (thử lại do hết quota)',
      );
      expect(
        formatEventSummary('task.running', { model: 'claude-sonnet-4-6', profile: 'chinh' }, 'task-r'),
      ).toBe('task-r đang chạy (claude-sonnet-4-6@chinh)');
    });
  });

  describe('recentEvents in GET /api/status', () => {
    it('returns at most 30 recent events with id, ts, type, taskId, summary', async () => {
      // Insert 35 events
      for (let i = 1; i <= 35; i++) {
        ctx.eventRepo.insert('task.queued', `proj/task-${i}`, { reason: 'normal' });
      }

      // Insert specific events to verify order and summary
      ctx.eventRepo.insert('task.review_ready', 'a1');
      ctx.eventRepo.insert('quota.exhausted', undefined, {
        profile: 'g2',
        family: 'claude',
        time: '16:35',
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/status',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.recentEvents).toBeDefined();
      expect(Array.isArray(body.recentEvents)).toBe(true);
      expect(body.recentEvents.length).toBe(30);

      // Verify the newest event (id desc) is first
      const newest = body.recentEvents[0];
      expect(newest.type).toBe('quota.exhausted');
      expect(newest.summary).toBe('g2 hết quota claude tới 16:35');
      expect(newest).toHaveProperty('id');
      expect(newest).toHaveProperty('ts');
      expect(newest).toHaveProperty('type');
      expect(newest).toHaveProperty('taskId');
      expect(newest).toHaveProperty('summary');

      // Verify second newest
      const secondNewest = body.recentEvents[1];
      expect(secondNewest.type).toBe('task.review_ready');
      expect(secondNewest.taskId).toBe('a1');
      expect(secondNewest.summary).toBe('a1 chuyển sang chờ review');

      // Verify keys for all items
      for (const item of body.recentEvents) {
        expect(item).toEqual({
          id: expect.any(Number),
          ts: expect.any(String),
          type: expect.any(String),
          taskId: item.taskId === null ? null : expect.any(String),
          summary: expect.any(String),
        });
      }
    });
  });

  describe('tasksByProject in GET /api/status', () => {
    it('returns task counts by status separated by project', async () => {
      ctx.projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: '/tmp/p1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      ctx.projectRepo.insert({
        id: 'p2',
        name: 'Project 2',
        path: '/tmp/p2',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      ctx.projectRepo.insert({
        id: 'p3',
        name: 'Project 3 (empty)',
        path: '/tmp/p3',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      // Tasks for p1: 2 queued, 1 running, 1 done
      ctx.taskRepo.insert({ id: 'p1/t1', projectId: 'p1', slug: 't1', title: 'T1', status: 'queued' });
      ctx.taskRepo.insert({ id: 'p1/t2', projectId: 'p1', slug: 't2', title: 'T2', status: 'queued' });
      ctx.taskRepo.insert({ id: 'p1/t3', projectId: 'p1', slug: 't3', title: 'T3', status: 'running' });
      ctx.taskRepo.insert({ id: 'p1/t4', projectId: 'p1', slug: 't4', title: 'T4', status: 'done' });

      // Tasks for p2: 1 review, 1 blocked
      ctx.taskRepo.insert({ id: 'p2/t1', projectId: 'p2', slug: 't1', title: 'T1', status: 'review' });
      ctx.taskRepo.insert({ id: 'p2/t2', projectId: 'p2', slug: 't2', title: 'T2', status: 'blocked' });
      ctx.taskRepo.insert({ id: 'p2/t3', projectId: 'p2', slug: 't3', title: 'T3', status: 'checking' });

      const res = await server.inject({
        method: 'GET',
        url: '/api/status',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.tasksByProject).toBeDefined();
      expect(body.tasksByProject.p1).toEqual({
        draft: 0,
        queued: 2,
        running: 1,
        checking: 0,
        review: 0,
        done: 1,
        blocked: 0,
        failed: 0,
        cancelled: 0,
        waiting_quota: 0,
      });

      expect(body.tasksByProject.p2).toEqual({
        draft: 0,
        queued: 0,
        running: 0,
        checking: 1,
        review: 1,
        done: 0,
        blocked: 1,
        failed: 0,
        cancelled: 0,
        waiting_quota: 0,
      });

      expect(body.tasksByProject.p3).toEqual({
        draft: 0,
        queued: 0,
        running: 0,
        checking: 0,
        review: 0,
        done: 0,
        blocked: 0,
        failed: 0,
        cancelled: 0,
        waiting_quota: 0,
      });
    });
  });
});
