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

describe('AgentHub SSE /api/events', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-sse-test-'));
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

  it('receives events emitted from EventBus over SSE with unified envelope and id', async () => {
    const receivedEvents: Array<{ event: string; id?: string; data: Record<string, unknown> }> = [];

    const eventBus = ctx.scheduler.getEventBus();
    const initialCount = eventBus.listenerCount('*');

    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      { headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          while (parts.length > 1) {
            const rawEvent = parts.shift()!;
            const lines = rawEvent.split('\n');
            let eventName = 'message';
            let eventId: string | undefined;
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('id: ')) {
                eventId = line.slice(4).trim();
              } else if (line.startsWith('event: ')) {
                eventName = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                dataStr = line.slice(6).trim();
              }
            }
            if (dataStr) {
              try {
                receivedEvents.push({ event: eventName, id: eventId, data: JSON.parse(dataStr) as Record<string, unknown> });
              } catch {
                receivedEvents.push({ event: eventName, id: eventId, data: { raw: dataStr } });
              }
            }
          }
          buffer = parts[0] || '';
        });
      },
    );

    req.end();

    try {
      // Wait for connection to establish
      await vi.waitFor(() => {
        expect(eventBus.listenerCount('*')).toBe(initialCount + 1);
      }, { timeout: 3000 });

      // Emit event from EventBus
      eventBus.emit('task.done', 'myproj/task1', { custom: 123 });

      // Wait for event to arrive
      await vi.waitFor(() => {
        expect(receivedEvents.some((e) => e.event === 'task.done')).toBe(true);
      }, { timeout: 5000 });

      const taskDoneEvent = receivedEvents.find((e) => e.event === 'task.done');
      expect(taskDoneEvent).toBeDefined();
      expect(taskDoneEvent?.id).toBeDefined();
      expect(Number(taskDoneEvent?.id)).toBeGreaterThan(0);
      expect(taskDoneEvent?.data.type).toBe('task.done');
      expect(taskDoneEvent?.data.taskId).toBe('myproj/task1');
      expect(taskDoneEvent?.data.ts).toBeDefined();
      expect((taskDoneEvent?.data.payload as Record<string, unknown>).custom).toBe(123);
    } finally {
      req.destroy();
    }
  });

  it('streams run.output for active runs with unified envelope', async () => {
    const logDir = path.join(tmpDir, 'logs', 'p_t');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'r1.log');
    fs.writeFileSync(logPath, 'initial output\n');

    ctx.projectRepo.insert({
      id: 'p',
      name: 'Project P',
      path: '/tmp',
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({
      id: 'p/t',
      projectId: 'p',
      slug: 't',
      title: 'Task T',
      status: 'running',
    });

    ctx.runRepo.insert({
      id: 'r1',
      taskId: 'p/t',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      logPath,
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    ctx.scheduler.getRunning().set('p/t', {
      runId: 'r1',
      taskId: 'p/t',
      pid: 9999,
      pidStart: null,
      profileName: 'p1',
      model: 'gemini-3.8-flash-high',
      engine: fakeEngine,
      startTime: Date.now(),
      timeoutMs: 10000,
      retryCount: 0,
      projectId: 'p',
    });

    const receivedOutputs: Array<Record<string, unknown>> = [];

    const eventBus = ctx.scheduler.getEventBus();
    const initialCount = eventBus.listenerCount('*');

    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      { headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          while (parts.length > 1) {
            const rawEvent = parts.shift()!;
            const lines = rawEvent.split('\n');
            let eventName = '';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) eventName = line.slice(7).trim();
              if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
            }
            if (eventName === 'run.output' && dataStr) {
              receivedOutputs.push(JSON.parse(dataStr));
            }
          }
          buffer = parts[0] || '';
        });
      },
    );

    req.end();

    try {
      // Wait for initial SSE connection
      await vi.waitFor(() => {
        expect(eventBus.listenerCount('*')).toBe(initialCount + 1);
      }, { timeout: 3000 });

      // Append to log file
      fs.appendFileSync(logPath, 'new line from worker\n');

      // Wait for the interval to pick up the log output
      await vi.waitFor(() => {
        expect(receivedOutputs.length).toBeGreaterThan(0);
        const lastOutput = receivedOutputs[receivedOutputs.length - 1];
        expect(lastOutput.type).toBe('run.output');
        expect(lastOutput.taskId).toBe('p/t');
        const payload = lastOutput.payload as { runId: string; chunk: string };
        expect(payload.runId).toBe('r1');
        expect(payload.chunk).toContain('new line from worker');
      }, { timeout: 5000 });
    } finally {
      req.destroy();
      ctx.scheduler.getRunning().delete('p/t');
    }
  });

  it('streams run.output for active reviewer runs with unified envelope', async () => {
    const logDir = path.join(tmpDir, 'logs', 'p_rev');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'r_rev.log');
    fs.writeFileSync(logPath, 'initial reviewer output\n');

    ctx.projectRepo.insert({
      id: 'p',
      name: 'Project P',
      path: '/tmp',
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });

    ctx.taskRepo.insert({
      id: 'p/rev',
      projectId: 'p',
      slug: 'rev',
      title: 'Review Task',
      status: 'review',
    });

    ctx.runRepo.insert({
      id: 'r_rev',
      taskId: 'p/rev',
      engine: 'claude',
      model: 'claude:sonnet',
      profileName: 'claude-may',
      kind: 'reviewer',
      logPath,
    });

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    ctx.scheduler.getReviewerRuns().set('p/rev', {
      taskId: 'p/rev',
      runId: 'r_rev',
      pid: 9998,
      profileName: 'claude-may',
      engine: fakeEngine,
      actor: 'claude-reviewer',
      outputPath: path.join(logDir, 'r_rev.out.json'),
      startedAt: Date.now(),
      timeout: setTimeout(() => {}, 100000),
    });

    const receivedOutputs: Array<Record<string, unknown>> = [];

    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      { headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          while (parts.length > 1) {
            const rawEvent = parts.shift()!;
            const lines = rawEvent.split('\n');
            let eventName = '';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) eventName = line.slice(7).trim();
              if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
            }
            if (eventName === 'run.output' && dataStr) {
              receivedOutputs.push(JSON.parse(dataStr));
            }
          }
          buffer = parts[0] || '';
        });
      },
    );
    req.end();

    try {
      // Append reviewer progress to log file
      fs.appendFileSync(logPath, 'Bắt đầu duyệt code reviewer\n');

      // Wait for SSE interval to stream reviewer output
      await vi.waitFor(() => {
        expect(receivedOutputs.length).toBeGreaterThan(0);
        const revOutput = receivedOutputs.find((o) => o.taskId === 'p/rev');
        expect(revOutput).toBeDefined();
        expect(revOutput?.type).toBe('run.output');
        const payload = revOutput?.payload as { runId: string; chunk: string };
        expect(payload.runId).toBe('r_rev');
        expect(payload.chunk).toContain('Bắt đầu duyệt code reviewer');
      }, { timeout: 5000 });
    } finally {
      req.destroy();
      const r = ctx.scheduler.getReviewerRuns().get('p/rev');
      if (r) clearTimeout(r.timeout);
      ctx.scheduler.getReviewerRuns().delete('p/rev');
    }
  });

  it('replays missed bus events when Last-Event-ID header is provided (up to 200, strictly in order)', async () => {
    // Insert 5 events in DB
    ctx.service.eventRepo.insert('task.queued', 'p/t1', { step: 1 });
    const id2 = ctx.service.eventRepo.insert('task.running', 'p/t1', { step: 2 });
    const id3 = ctx.service.eventRepo.insert('task.done', 'p/t1', { step: 3 });
    const id4 = ctx.service.eventRepo.insert('task.queued', 'p/t2', { step: 4 });
    const id5 = ctx.service.eventRepo.insert('task.done', 'p/t2', { step: 5 });

    const receivedEvents: Array<{ event: string; id: string; data: Record<string, unknown> }> = [];

    // Connect with Last-Event-ID: id2 -> should replay id3, id4, id5
    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      {
        headers: {
          host: `127.0.0.1:${port}`,
          'last-event-id': String(id2),
        },
      },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          while (parts.length > 1) {
            const rawEvent = parts.shift()!;
            const lines = rawEvent.split('\n');
            let eventName = '';
            let eventId = '';
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith('id: ')) eventId = line.slice(4).trim();
              if (line.startsWith('event: ')) eventName = line.slice(7).trim();
              if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
            }
            if (eventName && dataStr) {
              receivedEvents.push({ event: eventName, id: eventId, data: JSON.parse(dataStr) as Record<string, unknown> });
            }
          }
          buffer = parts[0] || '';
        });
      },
    );

    req.end();

    try {
      // Wait for replay to complete
      await vi.waitFor(() => {
        expect(receivedEvents).toHaveLength(3);
      }, { timeout: 5000 });
      expect(receivedEvents.map((e) => Number(e.id))).toEqual([id3, id4, id5]);
      expect(receivedEvents[0].event).toBe('task.done');
      expect(receivedEvents[0].data.type).toBe('task.done');
      expect((receivedEvents[0].data.payload as Record<string, unknown>).step).toBe(3);
      expect(receivedEvents[1].event).toBe('task.queued');
      expect((receivedEvents[1].data.payload as Record<string, unknown>).step).toBe(4);
      expect(receivedEvents[2].event).toBe('task.done');
      expect((receivedEvents[2].data.payload as Record<string, unknown>).step).toBe(5);
    } finally {
      req.destroy();
    }
  });

  it('limits replay to at most 200 events when more than 200 events are missed', async () => {
    const baseId = ctx.service.eventRepo.insert('init.event', undefined, { init: true });

    // Insert 220 events
    for (let i = 1; i <= 220; i++) {
      ctx.service.eventRepo.insert('bulk.event', undefined, { index: i });
    }

    const receivedEvents: Array<{ id: string }> = [];

    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      {
        headers: {
          host: `127.0.0.1:${port}`,
          'last-event-id': String(baseId),
        },
      },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          while (parts.length > 1) {
            const rawEvent = parts.shift()!;
            const lines = rawEvent.split('\n');
            let eventId = '';
            for (const line of lines) {
              if (line.startsWith('id: ')) eventId = line.slice(4).trim();
            }
            if (eventId) {
              receivedEvents.push({ id: eventId });
            }
          }
          buffer = parts[0] || '';
        });
      },
    );

    req.end();

    try {
      await vi.waitFor(() => {
        expect(receivedEvents.length).toBe(200);
      }, { timeout: 5000 });
    } finally {
      req.destroy();
    }
  });

  it('cleans up EventBus listeners on client disconnect (no leak)', async () => {
    const eventBus = ctx.scheduler.getEventBus();
    const initialCount = eventBus.listenerCount('*');

    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      { headers: { host: `127.0.0.1:${port}` } },
      () => {},
    );
    req.end();

    // Wait for connection to register listener
    await vi.waitFor(() => {
      expect(eventBus.listenerCount('*')).toBe(initialCount + 1);
    }, { timeout: 3000 });

    // Disconnect client
    req.destroy();

    // Verify listener count returned to initial
    await vi.waitFor(() => {
      expect(eventBus.listenerCount('*')).toBe(initialCount);
    }, { timeout: 3000 });
  });

  it('closes server in less than 2 seconds when an active SSE connection is open', async () => {
    let sseConnected = false;
    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      { headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        if (res.statusCode === 200) {
          sseConnected = true;
        }
      },
    );
    req.end();

    const eventBus = ctx.scheduler.getEventBus();
    await vi.waitFor(() => {
      expect(sseConnected).toBe(true);
      expect(eventBus.listenerCount('*')).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const startTime = Date.now();
    await server.close();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(2000);
  });
});
