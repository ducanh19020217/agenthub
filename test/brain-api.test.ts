import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let port: number;

function authHeaders() {
  return {
    host: `127.0.0.1:${port}`,
    authorization: `Bearer ${token}`,
  };
}

describe('Brain API Endpoints (/api/brain)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 0;
    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    server = await createServer(ctx.service, config);
    await server['listen']({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    port = addr.port;
    config.port = port;
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

  it('PUT /api/brain with invalid activity returns 400', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/brain',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      payload: {
        activity: 'invalid_activity',
        detail: 'Học bài',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('bad_request');
  });

  it('PUT /api/brain with detail > 300 characters returns 400', async () => {
    const longDetail = 'a'.repeat(301);
    const res = await server.inject({
      method: 'PUT',
      url: '/api/brain',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      payload: {
        activity: 'planning',
        detail: longDetail,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('bad_request');
    expect(body.message).toContain('300');
  });

  it('PUT /api/brain with valid data updates status, records event, and emits SSE', async () => {
    // 1. Connect SSE client
    const eventsReceived: Array<{ type: string; payload?: Record<string, unknown> | null }> = [];
    let sseReq: http.ClientRequest | null = null;

    const eventBus = ctx.scheduler.getEventBus();
    const initialCount = eventBus.listenerCount('*');

    sseReq = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/events?token=${token}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Host: `127.0.0.1:${port}`,
        },
      },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          for (const block of lines) {
            const dataMatch = block.match(/^data: (.*)$/m);
            if (dataMatch) {
              try {
                const ev = JSON.parse(dataMatch[1]);
                eventsReceived.push(ev);
              } catch {
                // ignore non-json
              }
            }
          }
        });
      },
    );
    sseReq.end();

    try {
      // Give SSE connection a moment to establish
      await vi.waitFor(() => {
        expect(eventBus.listenerCount('*')).toBe(initialCount + 1);
      }, { timeout: 3000 });

      // 2. Perform valid PUT /api/brain
      const putRes = await server.inject({
        method: 'PUT',
        url: '/api/brain',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        payload: {
          activity: 'reviewing',
          detail: 'Đang review task agenthub/task-1',
          taskId: 'agenthub/task-1',
        },
      });

      expect(putRes.statusCode).toBe(200);
      const updated = JSON.parse(putRes.body);
      expect(updated.activity).toBe('reviewing');
      expect(updated.detail).toBe('Đang review task agenthub/task-1');
      expect(updated.taskId).toBe('agenthub/task-1');
      expect(updated.stale).toBe(false);

      // 3. Verify SSE event arrived
      await vi.waitFor(() => {
        expect(eventsReceived.some((e) => e.type === 'brain.status')).toBe(true);
      }, { timeout: 10_000 });
    } finally {
      if (sseReq) {
        (sseReq as http.ClientRequest).destroy();
      }
    }

    const brainEvent = eventsReceived.find((e) => e.type === 'brain.status');
    expect(brainEvent).toBeDefined();
    expect(brainEvent?.payload?.activity).toBe('reviewing');
    expect(brainEvent?.payload?.taskId).toBe('agenthub/task-1');

    // 4. Verify recorded in events table
    const recentEvents = ctx.eventRepo.getRecent(5);
    const recorded = recentEvents.find((e) => e.type === 'brain.status');
    expect(recorded).toBeDefined();
    expect(recorded?.taskId).toBe('agenthub/task-1');
  });

  it('GET /api/brain returns stale: true when updatedAt is older than 15 minutes', async () => {
    // Manually set brain_status updatedAt to 20 minutes ago
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    ctx.brainRepo.upsert('waiting', 'Đang chờ worker chạy xong', 'proj/t-1', twentyMinsAgo);

    const getRes = await server.inject({
      method: 'GET',
      url: '/api/brain',
      headers: authHeaders(),
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.activity).toBe('waiting');
    expect(body.detail).toBe('Đang chờ worker chạy xong');
    expect(body.taskId).toBe('proj/t-1');
    expect(body.stale).toBe(true);
  });

  it('GET /api/brain returns project brains with effective mode and usage', async () => {
    ctx.projectRepo.insert({
      id: 'p1',
      name: 'Project One',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
      settings: JSON.stringify({ brain: { mode: 'auto' } }),
    });
    ctx.projectRepo.insert({
      id: 'p2',
      name: 'Project Two',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    const now = new Date().toISOString();
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, projectId, status, inputTokens, outputTokens, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('p1-turn', 'event', 'p1', 'p1', 'done', 5, 7, now);
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, projectId, status, inputTokens, outputTokens, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('p2-turn', 'event', 'p2', 'p2', 'done', 3, 4, now);

    ctx.brainRunner.start();
    // task.done is intentionally ignored by an explicitly configured wake-up list.
    ctx.scheduler.getEventBus().emit('task.failed', 'p1/task');
    const response = await server.inject({
      method: 'GET',
      url: '/api/brain',
      headers: authHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.brains).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: null, projectName: 'Hệ thống', mode: config.brain.mode, queued: false, tokensToday: 0 }),
      expect.objectContaining({ projectId: 'p1', projectName: 'Project One', mode: 'auto', queued: true, tokensToday: 12 }),
      expect.objectContaining({ projectId: 'p2', projectName: 'Project Two', mode: config.brain.mode, queued: false, tokensToday: 7 }),
    ]));
    ctx.brainRunner.stop();
  });

  it('GET /api/status includes brain object', async () => {
    ctx.brainRepo.upsert('talking', 'Trao đổi về kiến trúc mới', null);

    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const status = JSON.parse(res.body);
    expect(status.brain).toBeDefined();
    expect(status.brain.activity).toBe('talking');
    expect(status.brain.detail).toBe('Trao đổi về kiến trúc mới');
    expect(status.brain.stale).toBe(false);
  });

  it('GET and POST /api/brain/digest return structured digest data', async () => {
    ctx.projectRepo.insert({
      id: 'p1',
      name: 'Project 1',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({ id: 'p1/done-1', projectId: 'p1', slug: 'done-1', title: 'Task xong', status: 'done' });

    // GET /api/brain/digest
    const getRes = await server.inject({
      method: 'GET',
      url: '/api/brain/digest',
      headers: authHeaders(),
    });
    expect(getRes.statusCode).toBe(200);
    const getData = JSON.parse(getRes.body);
    expect(getData.tasks).toBeDefined();
    expect(getData.tasks.done).toBe(1);
    expect(getData.text).toContain('TÓM TẮT HỆ THỐNG AGENTHUB');

    // POST /api/brain/digest
    const postRes = await server.inject({
      method: 'POST',
      url: '/api/brain/digest',
      headers: authHeaders(),
    });
    expect(postRes.statusCode).toBe(200);
    const postData = JSON.parse(postRes.body);
    expect(postData.tasks.done).toBe(1);
  });

  it('GET and POST /api/brain/decisions manage pending decisions', async () => {
    const tracker = ctx.telegramService.getDecisionTracker();
    tracker.recordDecision('dec-api-1', 'Xác nhận xóa tài nguyên tạm?', [123]);

    // GET /api/brain/decisions
    const getRes = await server.inject({
      method: 'GET',
      url: '/api/brain/decisions',
      headers: authHeaders(),
    });
    expect(getRes.statusCode).toBe(200);
    const list = JSON.parse(getRes.body);
    expect(list.decisions).toHaveLength(1);
    expect(list.decisions[0].id).toBe('dec-api-1');

    const getOrCreateSpy = vi.spyOn(ctx.chatService, 'getOrCreateSession');
    const sendSpy = vi.spyOn(ctx.chatService, 'sendMessage').mockReturnValue({
      userMessageId: 'u-1',
      assistantMessageId: 'a-1',
    });

    // POST /api/brain/decisions/:id/answer
    const ansRes = await server.inject({
      method: 'POST',
      url: '/api/brain/decisions/dec-api-1/answer',
      headers: authHeaders(),
      payload: { answer: 'agree' },
    });
    expect(ansRes.statusCode).toBe(200);
    const ansData = JSON.parse(ansRes.body);
    expect(ansData.ok).toBe(true);
    expect(ansData.decision.answered).toBe(true);
    expect(ansData.decision.answer).toBe('agree');
    expect(getOrCreateSpy).toHaveBeenCalledWith('brain', { title: 'Bộ não', kind: 'brain' });
    expect(sendSpy).toHaveBeenCalledWith(
      'brain',
      'Người dùng trả lời quyết định dec-api-1 («Xác nhận xóa tài nguyên tạm?»): Đồng ý',
      { queueIfBusy: true },
    );

    // Answering again should fail with 404 "Quyết định đã hết hạn hoặc đã trả lời"
    const ansResAgain = await server.inject({
      method: 'POST',
      url: '/api/brain/decisions/dec-api-1/answer',
      headers: authHeaders(),
      payload: { answer: 'reject' },
    });
    expect(ansResAgain.statusCode).toBe(404);
    expect(JSON.parse(ansResAgain.body).message).toContain('Quyết định đã hết hạn hoặc đã trả lời');

    // Answering non-existent should fail with 404 "Quyết định đã hết hạn hoặc đã trả lời"
    const ansResNonExistent = await server.inject({
      method: 'POST',
      url: '/api/brain/decisions/non-existent-id/answer',
      headers: authHeaders(),
      payload: { answer: 'agree' },
    });
    expect(ansResNonExistent.statusCode).toBe(404);
    expect(JSON.parse(ansResNonExistent.body).message).toContain('Quyết định đã hết hạn hoặc đã trả lời');

    // Check again, pending decisions should now be 0
    const getRes2 = await server.inject({
      method: 'GET',
      url: '/api/brain/decisions',
      headers: authHeaders(),
    });
    const list2 = JSON.parse(getRes2.body);
    expect(list2.decisions).toHaveLength(0);
  });

  it('forwards a dashboard decision to the related project brain', async () => {
    ctx.projectRepo.insert({
      id: 'p1',
      name: 'Project 1',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    const tracker = ctx.telegramService.getDecisionTracker();
    tracker.recordDecision('dec-api-project', 'Duyệt task?', [], Date.now(), 'p1/task-1');
    const getOrCreateSpy = vi.spyOn(ctx.chatService, 'getOrCreateSession');
    const sendSpy = vi.spyOn(ctx.chatService, 'sendMessage').mockReturnValue({ userMessageId: 'u-2', assistantMessageId: 'a-2' });

    const response = await server.inject({
      method: 'POST',
      url: '/api/brain/decisions/dec-api-project/answer',
      headers: authHeaders(),
      payload: { answer: 'reject' },
    });

    expect(response.statusCode).toBe(200);
    expect(getOrCreateSpy).toHaveBeenCalledWith('brain:p1', { title: 'Bộ não · p1', kind: 'brain', projectId: 'p1' });
    expect(sendSpy).toHaveBeenCalledWith('brain:p1', expect.stringContaining('Không'), { queueIfBusy: true });
  });

  it('PATCH /api/projects/:id with permissions=full requires confirm and emits event', async () => {
    ctx.projectRepo.insert({
      id: 'p-full',
      name: 'Project Full',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    const trustEvents: unknown[] = [];
    ctx.scheduler.getEventBus().on('brain.trust_changed', (_taskId, payload) => trustEvents.push(payload));

    // Without confirm -> 409
    const resNoConfirm = await server.inject({
      method: 'PATCH',
      url: '/api/projects/p-full',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      payload: { settings: { brain: { permissions: 'full' } } },
    });
    expect(resNoConfirm.statusCode).toBe(409);
    expect(trustEvents).toHaveLength(0);

    // With confirm -> 200 + event
    const resConfirm = await server.inject({
      method: 'PATCH',
      url: '/api/projects/p-full',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      payload: { settings: { brain: { permissions: 'full' } }, confirm: true },
    });
    expect(resConfirm.statusCode).toBe(200);
    expect(trustEvents).toContainEqual(expect.objectContaining({ projectId: 'p-full', permissions: 'full' }));
  });

  it('PUT /api/config with brain.permissions=full requires confirm and emits event', async () => {
    const trustEvents: unknown[] = [];
    ctx.scheduler.getEventBus().on('brain.trust_changed', (_taskId, payload) => trustEvents.push(payload));

    // Without confirm -> 409
    const resNoConfirm = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      payload: { brain: { permissions: 'full' } },
    });
    expect(resNoConfirm.statusCode).toBe(409);
    expect(trustEvents).toHaveLength(0);

    // With confirm -> 200 + event
    const resConfirm = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      payload: { brain: { permissions: 'full' }, confirm: true },
    });
    expect(resConfirm.statusCode).toBe(200);
    expect(trustEvents).toContainEqual(expect.objectContaining({ projectId: null, permissions: 'full' }));
  });
});
