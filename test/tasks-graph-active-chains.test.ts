import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';

describe('active task graph service and route', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let server: FastifyInstance;
  let token: string;
  let runningId: string;
  let queuedId: string;
  let cancelledId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-active-graph-'));
    process.env.AGENTHUB_HOME = tmpDir;
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    const config = loadConfig(tmpDir);
    config.port = 7789;
    config.agyHomesDir = agyHomesDir;
    token = getOrCreateToken(config.tokenPath);
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    ctx = createContext(config, new Map<string, Engine>([['agy', fakeEngine]]));
    server = await createServer(ctx.service, config);
    await server.ready();

    const projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(projectPath, { recursive: true });
    const projectId = 'agenthub-video-auto';
    ctx.projectRepo.insert({ id: projectId, name: 'AgentHub Video Auto', path: projectPath, defaultBranch: 'main', envTemplate: null, maxParallel: 3 });
    const project = { id: projectId };
    const running = ctx.service.createTask({ project: project.id, slug: 'image-review-stage', title: 'Image review stage', level: 'easy' });
    const queued = ctx.service.createTask({ project: project.id, slug: 'per-channel-image-source-order', title: 'Per channel image source order', level: 'easy', dependsOn: [running.id] });
    const done = ctx.service.createTask({ project: project.id, slug: 'completed-prerequisite', title: 'Completed prerequisite', level: 'easy' });
    const cancelled = ctx.service.createTask({ project: project.id, slug: 'cancelled-task', title: 'Cancelled task', level: 'easy' });
    const pushed = ctx.service.createTask({ project: project.id, slug: 'pushed-task', title: 'Pushed task', level: 'easy' });
    runningId = running.id;
    queuedId = queued.id;
    cancelledId = cancelled.id;
    ctx.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(running.id);
    ctx.db.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(queued.id);
    ctx.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(done.id);
    ctx.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(cancelled.id);
    ctx.db.prepare("UPDATE tasks SET status = 'pushed' WHERE id = ?").run(pushed.id);
    ctx.runRepo.insert({ id: 'active-run', taskId: running.id, engine: 'agy', model: 'gemini-3.8-flash-medium', profileName: 'test', pid: 12345 });
    expect(ctx.runRepo.getRunning().map((run) => run.taskId)).toContain(running.id);
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  it('retains running and queued dependency nodes for includeDone variants via service and HTTP', async () => {
    for (const includeDone of [false, 'active_chains', 'all', '7d'] as const) {
      const graph = ctx.service.getTasksGraph({ includeDone });
      expect(graph.nodes.map((node) => node.id)).toContain(runningId);
      expect(graph.nodes.map((node) => node.id)).toContain(queuedId);
      expect(graph.edges).toContainEqual(expect.objectContaining({ from: runningId, to: queuedId }));
      expect(graph.nodes.map((node) => node.id)).toContain(cancelledId);
    }
    const response = await server.inject({
      method: 'GET',
      url: '/api/tasks/graph?includeDone=false',
      headers: { host: '127.0.0.1:7789', authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.nodes.map((node: { id: string }) => node.id)).toContain(runningId);
    expect(body.nodes.map((node: { id: string }) => node.id)).toContain(queuedId);
    expect(body.edges).toContainEqual(expect.objectContaining({ from: runningId, to: queuedId }));
  });
});
