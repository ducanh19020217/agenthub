import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

describe('task detail runs and logs', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: Awaited<ReturnType<typeof createServer>>;
  let token: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-task-detail-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_WEB_DIR = path.join(tmpDir, 'web');
    fs.mkdirSync(process.env.AGENTHUB_WEB_DIR, { recursive: true });

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.port = 7791;
    token = getOrCreateToken(config.tokenPath);
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    ctx = createContext(config, new Map<string, Engine>([['agy', fakeEngine]]));
    server = await createServer(ctx.service, config);
    await server.ready();

    ctx.projectRepo.insert({ id: 'agenthub-video-auto', name: 'Video auto', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 2 });
    ctx.taskRepo.insert({ id: 'agenthub-video-auto/image-review-stage', projectId: 'agenthub-video-auto', slug: 'image-review-stage', title: 'Image review', status: 'running' });
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const finishedLog = path.join(logDir, 'finished.log');
    const currentLog = path.join(logDir, 'current.log');
    fs.writeFileSync(finishedLog, 'finished worker output\n');
    fs.writeFileSync(currentLog, 'current worker output\nappended while running\n');
    ctx.runRepo.insert({ id: 'run-finished', taskId: 'agenthub-video-auto/image-review-stage', engine: 'codex', model: 'codex:gpt-5.6-luna', profileName: 'codex', startedAt: '2026-11-14T08:00:00.000Z', endedAt: '2026-11-14T08:01:00.000Z', outcome: 'done', logPath: finishedLog });
    ctx.runRepo.insert({ id: 'run-current', taskId: 'agenthub-video-auto/image-review-stage', engine: 'codex', model: 'codex:gpt-5.6-luna', profileName: 'codex', startedAt: '2026-11-14T08:02:00.000Z', endedAt: null, outcome: null, logPath: currentLog });
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_WEB_DIR;
  });

  it('returns both runs and their readable logs for route IDs using tilde and encoded tilde', async () => {
    const headers = { host: '127.0.0.1:7791', authorization: `Bearer ${token}` };
    for (const id of ['agenthub-video-auto~image-review-stage', 'agenthub-video-auto%7Eimage-review-stage']) {
      const detail = await server.inject({ method: 'GET', url: `/api/tasks/${id}`, headers });
      expect(detail.statusCode).toBe(200);
      expect(JSON.parse(detail.body)).toMatchObject({ runs: expect.arrayContaining([expect.objectContaining({ id: 'run-finished' }), expect.objectContaining({ id: 'run-current', endedAt: null })]) });

      const page = await server.inject({ method: 'GET', url: `/api/tasks/${id}/runs?limit=20`, headers });
      expect(page.statusCode).toBe(200);
      expect(JSON.parse(page.body)).toMatchObject({ total: 2, items: expect.arrayContaining([expect.objectContaining({ id: 'run-finished' }), expect.objectContaining({ id: 'run-current' })]) });

      const allLogs = await server.inject({ method: 'GET', url: `/api/tasks/${id}/log?tail=500&scope=all`, headers });
      expect(allLogs.statusCode).toBe(200);
      expect(allLogs.body).toContain('finished worker output');
      expect(allLogs.body).toContain('appended while running');

      const currentLog = await server.inject({ method: 'GET', url: `/api/tasks/${id}/log`, headers });
      expect(currentLog.statusCode).toBe(200);
      expect(currentLog.body).toContain('appended while running');
      expect(currentLog.body).not.toContain('finished worker output');
    }
  });

  it('returns 404 for an unknown task', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/tasks/agenthub-video-auto~missing', headers: { host: '127.0.0.1:7791', authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(404);
  });
});
