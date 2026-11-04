import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { DeployService } from '../src/deploy.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeEngine: FakeEngine;
let previousHome: string | undefined;

function authHeaders() {
  return {
    host: '127.0.0.1',
    authorization: `Bearer ${token}`,
  };
}

function initGitRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Repo\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'chore: initial commit', '--allow-empty'], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('AgentHub API Extra Endpoints', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-api-extra-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    previousHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    const webDir = path.join(tmpDir, 'web');
    fs.mkdirSync(webDir, { recursive: true });
    process.env.AGENTHUB_WEB_DIR = webDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 0;
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();
    server = await createServer(ctx.service, config, { webDir });
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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_WEB_DIR;
  });

  // =========================================================================
  // 1. GET/PUT /api/config
  // =========================================================================
  describe('GET/PUT /api/config', () => {
    it('GET /api/config returns full configuration', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/config',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('modelChainHard');
      expect(body).toHaveProperty('modelChainEasy');
      expect(body).toHaveProperty('slotsPerAgyProfile');
      expect(body).toHaveProperty('slotsPerCodexProfile');
      expect(body).toHaveProperty('watchdog');
      expect(body).toHaveProperty('notifications');
      expect(body).toHaveProperty('chat');
      expect(body.watchdog).toHaveProperty('stallMinutes');
      expect(body.watchdog).toHaveProperty('waitingMinutes');
      expect(body.notifications).toHaveProperty('desktop');
    });

    it('PUT /api/config successfully updates valid configuration and persists to disk', async () => {
      const payload = {
        modelChainHard: ['gemini-3.8-flash-high', 'codex:gpt-5.6-luna'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        slotsPerAgyProfile: 4,
        slotsPerCodexProfile: 3,
        defaultTimeout: 7200,
        watchdog: {
          stallMinutes: 12,
          waitingMinutes: 6,
        },
        notifications: {
          desktop: false,
        },
        chat: {
          model: 'haiku',
          maxConcurrent: 5,
          idleTimeoutSec: 900,
          allowFullMode: true,
          disableToolSearch: false,
        },
      };

      const res = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.modelChainHard).toEqual(['gemini-3.8-flash-high', 'codex:gpt-5.6-luna']);
      expect(body.modelChainEasy).toEqual(['gemini-3.8-flash-medium']);
      expect(body.slotsPerAgyProfile).toBe(4);
      expect(body.slotsPerCodexProfile).toBe(3);
      expect(body.defaultTimeout).toBe(7200);
      expect(body.watchdog.stallMinutes).toBe(12);
      expect(body.watchdog.waitingMinutes).toBe(6);
      expect(body.notifications.desktop).toBe(false);
      expect(body.chat.model).toBe('haiku');
      expect(body.chat.maxConcurrent).toBe(5);
      expect(body.chat.idleTimeoutSec).toBe(900);
      expect(body.chat.allowFullMode).toBe(true);
      expect(body.chat.disableToolSearch).toBe(false);

      // Verify in-memory state
      expect(config.slotsPerAgyProfile).toBe(4);
      expect(config.notifications.desktop).toBe(false);

      // Verify written to config.json
      const onDisk = JSON.parse(fs.readFileSync(config.configFilePath, 'utf-8'));
      expect(onDisk.slotsPerAgyProfile).toBe(4);
      expect(onDisk.notifications.desktop).toBe(false);
      expect(onDisk.chat.model).toBe('haiku');
    });

    it('PUT /api/config validates model id (rejects invalid id or empty list)', async () => {
      // Unknown model id
      const res1 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          modelChainHard: ['invalid-nonexistent-model'],
        },
      });
      expect(res1.statusCode).toBe(400);
      expect(JSON.parse(res1.body).error).toBe('bad_request');

      // Invalid codex model (prefix too short or empty name)
      const res2 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          modelChainHard: ['codex:'],
        },
      });
      expect(res2.statusCode).toBe(400);
      expect(JSON.parse(res2.body).error).toBe('bad_request');

      // Empty model chain array
      const res3 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          modelChainEasy: [],
        },
      });
      expect(res3.statusCode).toBe(400);
      expect(JSON.parse(res3.body).error).toBe('bad_request');
    });

    it('PUT /api/config validates slotsPerAgyProfile (must be positive integer)', async () => {
      for (const invalidVal of [0, -1, 1.5, 'two']) {
        const res = await server.inject({
          method: 'PUT',
          url: '/api/config',
          headers: authHeaders(),
          payload: {
            slotsPerAgyProfile: invalidVal,
          },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe('bad_request');
      }
    });

    it('PUT /api/config validates watchdog (must be positive numbers)', async () => {
      const res1 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          watchdog: { stallMinutes: 0 },
        },
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          watchdog: { waitingMinutes: -3 },
        },
      });
      expect(res2.statusCode).toBe(400);
    });

    it('PUT /api/config validates notifications (desktop must be boolean, desktopLevel enum, quietHours format)', async () => {
      // Invalid desktop type
      const res1 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: { desktop: 'enabled' },
        },
      });
      expect(res1.statusCode).toBe(400);
      expect(JSON.parse(res1.body).error).toBe('bad_request');

      // Invalid desktopLevel enum
      const res2 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: { desktopLevel: 'super_high' },
        },
      });
      expect(res2.statusCode).toBe(400);

      // Invalid quietHours start time (out of range hour)
      const res3 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: { quietHours: { start: '25:00' } },
        },
      });
      expect(res3.statusCode).toBe(400);

      // Invalid quietHours end time (invalid minute)
      const res4 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: { quietHours: { end: '07:60' } },
        },
      });
      expect(res4.statusCode).toBe(400);

      // Invalid quietHours format (non-HH:MM string)
      const res5 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: { quietHours: { start: 'not-a-time' } },
        },
      });
      expect(res5.statusCode).toBe(400);
    });

    it('PUT /api/config saves desktopLevel and quietHours independently and persists to file', async () => {
      // 1. Initial state check
      const getRes1 = await server.inject({
        method: 'GET',
        url: '/api/config',
        headers: authHeaders(),
      });
      expect(getRes1.statusCode).toBe(200);
      const initialDesktop = JSON.parse(getRes1.body).notifications.desktop;

      // 2. PUT with only desktopLevel
      const putRes1 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: { desktopLevel: 'critical' },
        },
      });
      expect(putRes1.statusCode).toBe(200);
      const body1 = JSON.parse(putRes1.body);
      expect(body1.notifications.desktopLevel).toBe('critical');
      expect(body1.notifications.desktop).toBe(initialDesktop);

      // Read back via GET
      const getRes2 = await server.inject({
        method: 'GET',
        url: '/api/config',
        headers: authHeaders(),
      });
      const getBody2 = JSON.parse(getRes2.body);
      expect(getBody2.notifications.desktopLevel).toBe('critical');
      expect(getBody2.notifications.desktop).toBe(initialDesktop);

      // Read back from config.json on disk
      const onDisk1 = JSON.parse(fs.readFileSync(config.configFilePath, 'utf-8'));
      expect(onDisk1.notifications.desktopLevel).toBe('critical');

      // 3. PUT with desktop: false (preserves desktopLevel)
      const putRes2 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: { desktop: false },
        },
      });
      expect(putRes2.statusCode).toBe(200);
      const body2 = JSON.parse(putRes2.body);
      expect(body2.notifications.desktop).toBe(false);
      expect(body2.notifications.desktopLevel).toBe('critical');

      // Verify on disk that both desktop and desktopLevel are now present
      const onDisk2 = JSON.parse(fs.readFileSync(config.configFilePath, 'utf-8'));
      expect(onDisk2.notifications.desktop).toBe(false);
      expect(onDisk2.notifications.desktopLevel).toBe('critical');

      // 4. PUT with quietHours
      const putRes3 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: {
            quietHours: { enabled: true, start: '23:30', end: '06:30' },
          },
        },
      });
      expect(putRes3.statusCode).toBe(200);
      const body3 = JSON.parse(putRes3.body);
      expect(body3.notifications.desktopLevel).toBe('critical');
      expect(body3.notifications.desktop).toBe(false);
      expect(body3.notifications.quietHours).toEqual({
        enabled: true,
        start: '23:30',
        end: '06:30',
      });

      // Partial patch to quietHours (only change end)
      const putRes4 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          notifications: {
            quietHours: { end: '08:00' },
          },
        },
      });
      expect(putRes4.statusCode).toBe(200);
      const body4 = JSON.parse(putRes4.body);
      expect(body4.notifications.quietHours.enabled).toBe(true);
      expect(body4.notifications.quietHours.start).toBe('23:30');
      expect(body4.notifications.quietHours.end).toBe('08:00');
      expect(body4.notifications.desktopLevel).toBe('critical');
      expect(body4.notifications.desktop).toBe(false);

      // Verify on disk file
      const onDisk3 = JSON.parse(fs.readFileSync(config.configFilePath, 'utf-8'));
      expect(onDisk3.notifications.desktop).toBe(false);
      expect(onDisk3.notifications.desktopLevel).toBe('critical');
      expect(onDisk3.notifications.quietHours.enabled).toBe(true);
      expect(onDisk3.notifications.quietHours.start).toBe('23:30');
      expect(onDisk3.notifications.quietHours.end).toBe('08:00');
    });

    it('PUT /api/config validates chat.* properties', async () => {
      // Invalid chat.model enum
      const res1 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          chat: { model: 'gpt-4o' },
        },
      });
      expect(res1.statusCode).toBe(400);

      // Non-positive maxConcurrent
      const res2 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          chat: { maxConcurrent: 0 },
        },
      });
      expect(res2.statusCode).toBe(400);

      // Negative idleTimeoutSec
      const res3 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          chat: { idleTimeoutSec: -60 },
        },
      });
      expect(res3.statusCode).toBe(400);
    });

    it('PUT /api/config validates and persists load.autoPauseThresholdSec', async () => {
      // 1. Validation: non-positive or non-integer is rejected
      const res1 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          load: { autoPauseThresholdSec: 0 },
        },
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          load: { autoPauseThresholdSec: -10 },
        },
      });
      expect(res2.statusCode).toBe(400);

      const res3 = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          load: { autoPauseThresholdSec: 45.5 },
        },
      });
      expect(res3.statusCode).toBe(400);

      // 2. PUT with valid autoPauseThresholdSec
      const putRes = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: {
          load: { autoPauseThresholdSec: 90 },
        },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.load.autoPauseThresholdSec).toBe(90);

      // 3. GET /api/config reflects the saved value
      const getRes = await server.inject({
        method: 'GET',
        url: '/api/config',
        headers: authHeaders(),
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body);
      expect(getBody.load.autoPauseThresholdSec).toBe(90);

      // 4. Persisted on disk in config.json
      const onDisk = JSON.parse(fs.readFileSync(config.configFilePath, 'utf-8'));
      expect(onDisk.load.autoPauseThresholdSec).toBe(90);
    });

    it('GET /api/config returns the saved brain.permissions', async () => {
      const putRes = await server.inject({
        method: 'PUT',
        url: '/api/config',
        headers: authHeaders(),
        payload: { brain: { permissions: 'full' }, confirm: true },
      });
      expect(putRes.statusCode).toBe(200);
      expect(JSON.parse(putRes.body).brain.permissions).toBe('full');

      const getRes = await server.inject({
        method: 'GET',
        url: '/api/config',
        headers: authHeaders(),
      });
      expect(getRes.statusCode).toBe(200);
      expect(JSON.parse(getRes.body).brain.permissions).toBe('full');
    });
  });

  describe('branding logo security headers', () => {
    it('serves sanitized SVG with a restrictive policy and inline disposition', async () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>';
      const upload = await server.inject({
        method: 'PUT',
        url: '/api/branding/logo',
        headers: authHeaders(),
        payload: { mimeType: 'image/svg+xml', data: Buffer.from(svg).toString('base64') },
      });
      expect(upload.statusCode).toBe(200);

      const response = await server.inject({ method: 'GET', url: '/api/branding/logo', headers: authHeaders() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toBe('inline; filename="logo.svg"');
    });
  });

  // =========================================================================
  // 2. PATCH /api/projects/:id (checks validation) & DELETE /api/projects/:id (409)
  // =========================================================================
  describe('PATCH /api/projects/:id & DELETE /api/projects/:id', () => {
    it('PATCH /api/projects/:id updates checks with valid array or null', async () => {
      const repoPath = path.join(tmpDir, 'repo-patch-valid');
      initGitRepo(repoPath);

      ctx.projectRepo.insert({
        id: 'proj-checks',
        name: 'Project Checks',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
        checks: null,
      });

      // 1. Update with valid checks
      const validChecks = [
        { name: 'lint', cmd: ['npm', 'run', 'lint'], timeoutSec: 60 },
        { name: 'test', cmd: ['npm', 'test'] },
      ];
      const res1 = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-checks',
        headers: authHeaders(),
        payload: {
          checks: validChecks,
        },
      });
      expect(res1.statusCode).toBe(200);
      const updated1 = JSON.parse(res1.body);
      expect(JSON.parse(updated1.checks!)).toEqual(validChecks);

      // 2. Clear checks with null
      const res2 = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-checks',
        headers: authHeaders(),
        payload: {
          checks: null,
        },
      });
      expect(res2.statusCode).toBe(200);
      const updated2 = JSON.parse(res2.body);
      expect(updated2.checks).toBeNull();
    });

    it('PATCH /api/projects/:id keeps fields that are not sent', async () => {
      const repoPath = path.join(tmpDir, 'repo-patch-partial');
      initGitRepo(repoPath);
      const checks = [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }];
      ctx.projectRepo.insert({
        id: 'proj-partial',
        name: 'Project Partial',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
        checks: JSON.stringify(checks),
      });

      const res = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-partial',
        headers: authHeaders(),
        payload: { maxParallel: 5 },
      });
      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.body);
      expect(updated.maxParallel).toBe(5);
      expect(JSON.parse(updated.checks!)).toEqual(checks);
    });

    it('does not accept deploy configuration through PATCH and returns a queued deploy immediately', async () => {
      const repoPath = path.join(tmpDir, 'repo-deploy-api');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'proj-deploy-api',
        name: 'Project Deploy API',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      config.deploy = {
        'proj-deploy-api': { steps: [['never-run']], timeoutSec: 2, restartHub: false },
      };

      const patchRes = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-deploy-api',
        headers: authHeaders(),
        payload: { deploy: { steps: [['attacker-command']] }, afterMerge: { steps: [['attacker-command']] } },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(JSON.parse(patchRes.body).afterMerge).toEqual(config.deploy['proj-deploy-api']);

      const rerun = vi.spyOn(ctx.service, 'rerunDeploy');
      const deployRes = await server.inject({
        method: 'POST',
        url: '/api/projects/proj-deploy-api/deploy',
        headers: authHeaders(),
      });
      expect(deployRes.statusCode).toBe(202);
      expect(JSON.parse(deployRes.body)).toMatchObject({ projectId: 'proj-deploy-api', status: 'queued' });
      expect(rerun).toHaveBeenCalledWith('proj-deploy-api');
      rerun.mockRestore();

      const pushSpy = vi.spyOn(ctx.service, 'pushDeployNow').mockResolvedValue({
        projectId: 'proj-deploy-api',
        status: 'succeeded',
        pushStatus: 'push lúc 12:00',
      });
      const pushNowRes = await server.inject({
        method: 'POST',
        url: '/api/projects/proj-deploy-api/deploy',
        headers: authHeaders(),
        payload: { pushNow: true },
      });
      expect(pushNowRes.statusCode).toBe(200);
      expect(JSON.parse(pushNowRes.body)).toMatchObject({ projectId: 'proj-deploy-api', status: 'succeeded', pushStatus: 'push lúc 12:00' });
      expect(pushSpy).toHaveBeenCalledWith('proj-deploy-api');
      pushSpy.mockRestore();
    });

    it('POST /api/projects/:id/deploy {pushNow: true} returns 500 when commandRunner fails with code!=0', async () => {
      const repoPath = path.join(tmpDir, 'repo-deploy-fail');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'proj-deploy-fail',
        name: 'Project Deploy Fail',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
        merge: JSON.stringify({ enabled: true, worktrees: { main: repoPath } }),
      });
      config.deploy = {
        'proj-deploy-fail': {
          steps: [],
          timeoutSec: 2,
          restartHub: false,
          push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true },
        },
      };

      const failingRunner = vi.fn(async () => ({ code: 1, output: 'push rejected' }));
      const deployService = new DeployService(
        config,
        ctx.projectRepo,
        ctx.scheduler.getEventBus(),
        0,
        failingRunner,
      );
      (deployService as unknown as { latest: Map<string, unknown> }).latest.set('proj-deploy-fail', {
        projectId: 'proj-deploy-fail',
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
      });
      ctx.service.deployService = deployService;

      const res = await server.inject({
        method: 'POST',
        url: '/api/projects/proj-deploy-fail/deploy',
        headers: authHeaders(),
        payload: { pushNow: true },
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        projectId: 'proj-deploy-fail',
        status: 'failed',
        error: expect.stringContaining('exit 1'),
      });
      expect(failingRunner).toHaveBeenCalled();
    });

    it('PATCH /api/projects/:id rejects invalid checks schema', async () => {
      const repoPath = path.join(tmpDir, 'repo-patch-invalid');
      initGitRepo(repoPath);

      ctx.projectRepo.insert({
        id: 'proj-checks-inv',
        name: 'Project Checks Inv',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
        checks: null,
      });

      // Empty check name
      const res1 = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-checks-inv',
        headers: authHeaders(),
        payload: {
          checks: [{ name: '', cmd: ['npm', 'test'] }],
        },
      });
      expect(res1.statusCode).toBe(400);

      // Empty cmd array
      const res2 = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-checks-inv',
        headers: authHeaders(),
        payload: {
          checks: [{ name: 'test', cmd: [] }],
        },
      });
      expect(res2.statusCode).toBe(400);

      // Non-positive timeoutSec
      const res3 = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-checks-inv',
        headers: authHeaders(),
        payload: {
          checks: [{ name: 'test', cmd: ['npm', 'test'], timeoutSec: 0 }],
        },
      });
      expect(res3.statusCode).toBe(400);

      // Negative timeoutSec
      const res4 = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-checks-inv',
        headers: authHeaders(),
        payload: {
          checks: [{ name: 'test', cmd: ['npm', 'test'], timeoutSec: -10 }],
        },
      });
      expect(res4.statusCode).toBe(400);

      // checks is not an array
      const res5 = await server.inject({
        method: 'PATCH',
        url: '/api/projects/proj-checks-inv',
        headers: authHeaders(),
        payload: {
          checks: 'npm test',
        },
      });
      expect(res5.statusCode).toBe(400);
    });

    it('DELETE /api/projects/:id returns 409 conflict when a task is currently running', async () => {
      const repoPath = path.join(tmpDir, 'repo-del-conflict');
      initGitRepo(repoPath);

      ctx.projectRepo.insert({
        id: 'proj-del',
        name: 'Project Delete',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });

      // Simulate active task in scheduler running map
      ctx.scheduler.getRunning().set('proj-del/task-active', {
        runId: 'r-del-1',
        taskId: 'proj-del/task-active',
        pid: 99999,
        pidStart: null,
        profileName: 'p1',
        model: 'gemini-3.8-flash-high',
        engine: fakeEngine,
        startTime: Date.now(),
        timeoutMs: 10000,
        retryCount: 0,
        projectId: 'proj-del',
      });

      // Attempt deletion while task is running -> 409 Conflict
      const resConflict = await server.inject({
        method: 'DELETE',
        url: '/api/projects/proj-del',
        headers: authHeaders(),
      });
      expect(resConflict.statusCode).toBe(409);
      const conflictBody = JSON.parse(resConflict.body);
      expect(conflictBody.error).toBe('conflict');
      expect(conflictBody.message).toContain('Không thể xóa project khi còn task đang chạy');

      // Verify project was NOT deleted
      expect(ctx.projectRepo.get('proj-del')).toBeDefined();

      // Clear running task -> deletion succeeds
      ctx.scheduler.getRunning().delete('proj-del/task-active');
      const resOk = await server.inject({
        method: 'DELETE',
        url: '/api/projects/proj-del',
        headers: authHeaders(),
      });
      expect(resOk.statusCode).toBe(200);
      expect(JSON.parse(resOk.body)).toEqual({ ok: true });
      expect(ctx.projectRepo.get('proj-del')).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. POST /api/tasks/:id/review/retry-reviewer
  // =========================================================================
  describe('POST /api/tasks/:id/review/retry-reviewer', () => {
    it('returns 404 if task does not exist', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/proj~nonexistent/review/retry-reviewer',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('not_found');
    });

    it('returns 400 if task is not in review status', async () => {
      const repoPath = path.join(tmpDir, 'repo-retry-rev-not-review');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'p-rev',
        name: 'P Rev',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.taskRepo.insert({
        id: 'p-rev/t-queued',
        projectId: 'p-rev',
        slug: 't-queued',
        title: 'Queued Task',
        status: 'queued',
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/p-rev~t-queued/review/retry-reviewer',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('không ở trạng thái chờ người duyệt');
    });

    it('returns 400 if task is in review but not reviewerEscalated', async () => {
      const repoPath = path.join(tmpDir, 'repo-retry-rev-not-esc');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'p-rev2',
        name: 'P Rev2',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.taskRepo.insert({
        id: 'p-rev2/t-not-esc',
        projectId: 'p-rev2',
        slug: 't-not-esc',
        title: 'Review Task Not Escalated',
        status: 'review',
        reviewerEscalated: 0,
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/p-rev2~t-not-esc/review/retry-reviewer',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('không ở trạng thái chờ người duyệt');
    });

    it('successfully resets escalation and triggers review ready when task is escalated', async () => {
      const repoPath = path.join(tmpDir, 'repo-retry-rev-esc');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'p-rev3',
        name: 'P Rev3',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.taskRepo.insert({
        id: 'p-rev3/t-esc',
        projectId: 'p-rev3',
        slug: 't-esc',
        title: 'Review Task Escalated',
        status: 'review',
      });
      ctx.taskRepo.update('p-rev3/t-esc', {
        reviewerEscalated: 1,
        reviewerEscalatedAt: '2026-10-15 12:00:00',
        reviewerEscalationReason: 'reviewer timed out',
      });

      let eventFired = false;
      ctx.scheduler.getEventBus().once('task.review_ready', (tId) => {
        if (tId === 'p-rev3/t-esc') eventFired = true;
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/p-rev3~t-esc/review/retry-reviewer',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.body);
      expect(updated.reviewerEscalated).toBe(0);
      expect(updated.reviewerEscalatedAt).toBeNull();
      expect(updated.reviewerEscalationReason).toBeNull();
      expect(eventFired).toBe(true);

      const dbRow = ctx.taskRepo.get('p-rev3/t-esc')!;
      expect(dbRow.reviewerEscalated).toBe(0);
      expect(dbRow.reviewerEscalatedAt).toBeNull();
      expect(dbRow.reviewerEscalationReason).toBeNull();
    });
  });

  // =========================================================================
  // 4. POST /api/tasks/:id/checks/rerun
  // =========================================================================
  describe('POST /api/tasks/:id/checks/rerun', () => {
    it('returns 404 if task does not exist', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/proj~nonexistent/checks/rerun',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('not_found');
    });

    it('returns 400 if task has no runs', async () => {
      const repoPath = path.join(tmpDir, 'repo-checks-norun');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'p-checks',
        name: 'P Checks',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.taskRepo.insert({
        id: 'p-checks/t1',
        projectId: 'p-checks',
        slug: 't1',
        title: 'Task 1',
        status: 'draft',
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/p-checks~t1/checks/rerun',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('Task chưa có run để lưu kết quả kiểm tra');
    });

    it('executes checks for task with a run and records results in DB', async () => {
      const repoPath = path.join(tmpDir, 'repo-checks-rerun');
      initGitRepo(repoPath);
      const customChecks = [{ name: 'custom-echo', cmd: ['echo', 'rerun-ok'] }];
      ctx.projectRepo.insert({
        id: 'p-checks2',
        name: 'P Checks 2',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
        checks: JSON.stringify(customChecks),
      });
      ctx.taskRepo.insert({
        id: 'p-checks2/t-with-run',
        projectId: 'p-checks2',
        slug: 't-with-run',
        title: 'Task With Run',
        status: 'review',
      });
      ctx.runRepo.insert({
        id: 'run-check-1',
        taskId: 'p-checks2/t-with-run',
        engine: 'agy',
        model: 'gemini-3.8-flash-high',
        profileName: 'p1',
        startedAt: '2026-10-15 10:00:00',
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/p-checks2~t-with-run/checks/rerun',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toHaveProperty('passed');
      expect(data).toHaveProperty('results');
      expect(Array.isArray(data.results)).toBe(true);

      // Verify custom check was executed and passed
      const customRes = data.results.find((r: { name: string }) => r.name === 'custom-echo');
      expect(customRes).toBeDefined();
      expect(customRes.ok).toBe(true);
      expect(customRes.outputTail).toContain('rerun-ok');

      // Verify results are stored in SQLite
      const dbResults = ctx.db.prepare('SELECT * FROM check_results WHERE taskId = ? AND runId = ?').all(
        'p-checks2/t-with-run',
        'run-check-1',
      ) as Array<{ name: string; ok: number }>;
      expect(dbResults.length).toBeGreaterThan(0);
      expect(dbResults.some((r) => r.name === 'custom-echo' && r.ok === 1)).toBe(true);
    });
  });

  // =========================================================================
  // 5. GET /api/tasks/:id/log?tail= with boundary limits
  // =========================================================================
  describe('GET /api/tasks/:id/log?tail=', () => {
    it('returns 404 for non-existent task', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/tasks/proj~nonexistent/log',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns empty string when task has no runs or log file is missing', async () => {
      const repoPath = path.join(tmpDir, 'repo-log-missing');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'p-log',
        name: 'P Log',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.taskRepo.insert({
        id: 'p-log/t-norun',
        projectId: 'p-log',
        slug: 't-norun',
        title: 'Task No Run',
        status: 'draft',
      });

      // No runs
      const res1 = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log~t-norun/log',
        headers: authHeaders(),
      });
      expect(res1.statusCode).toBe(200);
      expect(res1.body).toBe('');

      // Run with missing file
      ctx.runRepo.insert({
        id: 'run-missing-log',
        taskId: 'p-log/t-norun',
        engine: 'agy',
        model: 'gemini-3.8-flash-high',
        profileName: 'p1',
        startedAt: '2026-10-15 10:00:00',
        logPath: path.join(tmpDir, 'nonexistent-log.log'),
      });
      const res2 = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log~t-norun/log',
        headers: authHeaders(),
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.body).toBe('');
    });

    it('returns tail of log with boundary clamped values (tail=1, tail=0, tail=1000, NaN)', async () => {
      const repoPath = path.join(tmpDir, 'repo-log-boundaries');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'p-log-bounds',
        name: 'P Log Bounds',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.taskRepo.insert({
        id: 'p-log-bounds/t1',
        projectId: 'p-log-bounds',
        slug: 't1',
        title: 'Task Log Bounds',
        status: 'review',
      });

      // Write a log file with 4 KB of data (>1024 bytes)
      const logFilePath = path.join(tmpDir, 'boundary-test.log');
      let fullContent = '';
      for (let i = 1; i <= 200; i++) {
        fullContent += `Line ${String(i).padStart(4, '0')}: some log output here for testing boundary clamp\n`;
      }
      fs.writeFileSync(logFilePath, fullContent, 'utf-8');
      expect(Buffer.byteLength(fullContent, 'utf-8')).toBeGreaterThan(2048);

      ctx.runRepo.insert({
        id: 'run-bound-1',
        taskId: 'p-log-bounds/t1',
        engine: 'agy',
        model: 'gemini-3.8-flash-high',
        profileName: 'p1',
        startedAt: '2026-10-15 10:00:00',
        logPath: logFilePath,
      });

      // 1. Default (no tail param): returns full log because full size < 512 KB
      const resDefault = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-bounds~t1/log',
        headers: authHeaders(),
      });
      expect(resDefault.statusCode).toBe(200);
      expect(resDefault.body).toBe(fullContent);

      // 2. tail=1 (1 KB = 1024 bytes from end)
      const res1 = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-bounds~t1/log?tail=1',
        headers: authHeaders(),
      });
      expect(res1.statusCode).toBe(200);
      expect(Buffer.byteLength(res1.body, 'utf-8')).toBe(1024);
      expect(res1.body.endsWith('Line 0200: some log output here for testing boundary clamp\n')).toBe(true);

      // 3. tail=0 clamped to at least 1 KB (1024 bytes)
      const resZero = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-bounds~t1/log?tail=0',
        headers: authHeaders(),
      });
      expect(resZero.statusCode).toBe(200);
      expect(Buffer.byteLength(resZero.body, 'utf-8')).toBe(1024);

      // 4. Negative tail (tail=-5) clamped to at least 1 KB (1024 bytes)
      const resNeg = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-bounds~t1/log?tail=-5',
        headers: authHeaders(),
      });
      expect(resNeg.statusCode).toBe(200);
      expect(Buffer.byteLength(resNeg.body, 'utf-8')).toBe(1024);

      // 5. tail=1000 clamped to at most 512 KB
      const resHuge = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-bounds~t1/log?tail=1000',
        headers: authHeaders(),
      });
      expect(resHuge.statusCode).toBe(200);
      expect(resHuge.body).toBe(fullContent);

      // 6. tail=invalid_abc parsed as NaN, falls back to default 512 KB
      const resNaN = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-bounds~t1/log?tail=invalid_abc',
        headers: authHeaders(),
      });
      expect(resNaN.statusCode).toBe(200);
      expect(resNaN.body).toBe(fullContent);
    });

    it('returns log for specific run when query.run is specified', async () => {
      const repoPath = path.join(tmpDir, 'repo-log-multi-run');
      initGitRepo(repoPath);
      ctx.projectRepo.insert({
        id: 'p-log-runs',
        name: 'P Log Runs',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.taskRepo.insert({
        id: 'p-log-runs/t2',
        projectId: 'p-log-runs',
        slug: 't2',
        title: 'Task Multi Runs',
        status: 'review',
      });

      const logPath1 = path.join(tmpDir, 'run1.log');
      const logPath2 = path.join(tmpDir, 'run2.log');
      fs.writeFileSync(logPath1, 'Log from Run 1\n', 'utf-8');
      fs.writeFileSync(logPath2, 'Log from Run 2\n', 'utf-8');

      ctx.runRepo.insert({
        id: 'run-r1',
        taskId: 'p-log-runs/t2',
        engine: 'agy',
        model: 'gemini-3.8-flash-high',
        profileName: 'p1',
        startedAt: '2026-10-15 10:00:00',
        logPath: logPath1,
      });
      ctx.runRepo.insert({
        id: 'run-r2',
        taskId: 'p-log-runs/t2',
        engine: 'agy',
        model: 'gemini-3.8-flash-high',
        profileName: 'p1',
        startedAt: '2026-10-15 11:00:00',
        logPath: logPath2,
      });

      // Target run-r1
      const resR1 = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-runs~t2/log?run=run-r1',
        headers: authHeaders(),
      });
      expect(resR1.statusCode).toBe(200);
      expect(resR1.body).toBe('Log from Run 1\n');

      // Target run-r2
      const resR2 = await server.inject({
        method: 'GET',
        url: '/api/tasks/p-log-runs~t2/log?run=run-r2',
        headers: authHeaders(),
      });
      expect(resR2.statusCode).toBe(200);
      expect(resR2.body).toBe('Log from Run 2\n');
    });
  });

  // =========================================================================
  // 6. POST /api/profiles/:name/usage/refresh (codex profile skipped)
  // =========================================================================
  describe('POST /api/profiles/:name/usage/refresh', () => {
    it('returns 401 when request is unauthenticated', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles/any-profile/usage/refresh',
        headers: { host: '127.0.0.1' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 for non-existent profile', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles/nonexistent-profile/usage/refresh',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error).toBe('not_found');
    });

    it('bypasses usage collection for codex profile and returns profile info', async () => {
      ctx.profileRepo.upsert({
        name: 'codex-prof-test',
        engine: 'codex',
        kind: 'codex',
        home: path.join(tmpDir, 'codex-home-test'),
        email: 'codex-agent@example.com',
        enabled: 1,
        authState: 'ok',
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/profiles/codex-prof-test/usage/refresh',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe('codex-prof-test');
      expect(data.engine).toBe('codex');

      // Verify no usage entries were inserted for this codex profile
      const usageRows = ctx.db
        .prepare('SELECT * FROM quota_usage WHERE profileName = ?')
        .all('codex-prof-test');
      expect(usageRows).toHaveLength(0);
    });
  });

  // =========================================================================
  // 7. GET /api/version
  // =========================================================================
  describe('GET /api/version', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/version',
        headers: { host: '127.0.0.1' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns version and null webBuildId when index.html does not exist', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/version',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        version: '0.1.0',
        webBuildId: null,
      });
    });

    it('returns version and webBuildId timestamp when index.html exists in web directory', async () => {
      const indexPath = path.join(process.env.AGENTHUB_WEB_DIR!, 'index.html');
      fs.writeFileSync(indexPath, '<!DOCTYPE html><html><head></head><body>AgentHub Web</body></html>');
      const expectedMtime = fs.statSync(indexPath).mtimeMs;

      const res = await server.inject({
        method: 'GET',
        url: '/api/version',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.version).toBe('0.1.0');
      expect(body.webBuildId).toBe(expectedMtime);
    });
  });

  // =========================================================================
  // 8. GET /api/status (disk, tasksByProject, recentEvents)
  // =========================================================================
  describe('GET /api/status', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/status',
        headers: { host: '127.0.0.1' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns status containing disk freeGB and totalGB metrics', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/status',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('disk');
      expect(typeof body.disk.freeGB).toBe('number');
      expect(typeof body.disk.totalGB).toBe('number');
      expect(body.disk.freeGB).toBeGreaterThanOrEqual(0);
      expect(body.disk.totalGB).toBeGreaterThanOrEqual(0);
    });

    it('returns tasksByProject mapping with accurate status counters across projects', async () => {
      const repoPathA = path.join(tmpDir, 'repo-status-a');
      const repoPathB = path.join(tmpDir, 'repo-status-b');
      initGitRepo(repoPathA);
      initGitRepo(repoPathB);

      ctx.projectRepo.insert({
        id: 'proj-status-a',
        name: 'Project Status A',
        path: repoPathA,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.projectRepo.insert({
        id: 'proj-status-b',
        name: 'Project Status B',
        path: repoPathB,
        defaultBranch: 'main',
        maxParallel: 2,
      });

      // Tasks in proj-status-a: 1 running, 1 queued, 1 review
      ctx.taskRepo.insert({
        id: 'proj-status-a/t1',
        projectId: 'proj-status-a',
        slug: 't1',
        title: 'Task A1',
        status: 'running',
      });
      ctx.taskRepo.insert({
        id: 'proj-status-a/t2',
        projectId: 'proj-status-a',
        slug: 't2',
        title: 'Task A2',
        status: 'queued',
      });
      ctx.taskRepo.insert({
        id: 'proj-status-a/t3',
        projectId: 'proj-status-a',
        slug: 't3',
        title: 'Task A3',
        status: 'review',
      });

      // Tasks in proj-status-b: 1 draft, 1 done, 1 failed
      ctx.taskRepo.insert({
        id: 'proj-status-b/t1',
        projectId: 'proj-status-b',
        slug: 't1',
        title: 'Task B1',
        status: 'draft',
      });
      ctx.taskRepo.insert({
        id: 'proj-status-b/t2',
        projectId: 'proj-status-b',
        slug: 't2',
        title: 'Task B2',
        status: 'done',
      });
      ctx.taskRepo.insert({
        id: 'proj-status-b/t3',
        projectId: 'proj-status-b',
        slug: 't3',
        title: 'Task B3',
        status: 'failed',
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/status',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body).toHaveProperty('tasksByProject');
      const byProjA = body.tasksByProject['proj-status-a'];
      expect(byProjA).toBeDefined();
      expect(byProjA.running).toBe(1);
      expect(byProjA.queued).toBe(1);
      expect(byProjA.review).toBe(1);
      expect(byProjA.draft).toBe(0);
      expect(byProjA.done).toBe(0);

      const byProjB = body.tasksByProject['proj-status-b'];
      expect(byProjB).toBeDefined();
      expect(byProjB.draft).toBe(1);
      expect(byProjB.done).toBe(1);
      expect(byProjB.failed).toBe(1);
      expect(byProjB.running).toBe(0);

      // Also global tasks counts should match
      expect(body.tasks.running).toBeGreaterThanOrEqual(1);
      expect(body.tasks.queued).toBeGreaterThanOrEqual(1);
      expect(body.tasks.review).toBeGreaterThanOrEqual(1);
      expect(body.tasks.draft).toBeGreaterThanOrEqual(1);
      expect(body.tasks.done).toBeGreaterThanOrEqual(1);
      expect(body.tasks.failed).toBeGreaterThanOrEqual(1);
    });

    it('returns recentEvents list populated with formatted event summaries', async () => {
      ctx.eventRepo.insert('task.queued', 'proj-status-a/t1', { title: 'First Task Queued' });
      ctx.eventRepo.insert('task.review_ready', 'proj-status-a/t3', { reviewer: 'codex' });

      const res = await server.inject({
        method: 'GET',
        url: '/api/status',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body).toHaveProperty('recentEvents');
      expect(Array.isArray(body.recentEvents)).toBe(true);
      expect(body.recentEvents.length).toBeGreaterThanOrEqual(2);

      const queuedEvt = body.recentEvents.find((e: { type: string }) => e.type === 'task.queued');
      expect(queuedEvt).toBeDefined();
      expect(queuedEvt.taskId).toBe('proj-status-a/t1');
      expect(queuedEvt).toHaveProperty('summary');
      expect(typeof queuedEvt.summary).toBe('string');
      expect(queuedEvt).toHaveProperty('ts');
      expect(queuedEvt).toHaveProperty('id');

      const reviewEvt = body.recentEvents.find((e: { type: string }) => e.type === 'task.review_ready');
      expect(reviewEvt).toBeDefined();
      expect(reviewEvt.taskId).toBe('proj-status-a/t3');
    });
  });

  describe('project wizard context API', () => {
    it('returns bounded inspect metadata and exposes context task status without raw transcript content', async () => {
      const repoPath = path.join(tmpDir, 'wizard-api-repo');
      initGitRepo(repoPath);
      const sessionDir = path.join(process.env.HOME as string, '.claude', 'projects', repoPath.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'old.jsonl'), JSON.stringify({ message: { role: 'assistant', content: 'Use the stable API contract.' } }) + '\n');
      ctx.projectRepo.insert({ id: 'wizard-api', name: 'Wizard API', path: repoPath, defaultBranch: 'main', maxParallel: 1 });

      const inspect = await server.inject({ method: 'POST', url: '/api/projects/inspect', headers: authHeaders(), payload: { path: repoPath } });
      expect(inspect.statusCode).toBe(200);
      expect(JSON.parse(inspect.body)).toMatchObject({ path: repoPath, isGitRepo: true, sizeTruncated: false });

      const start = await server.inject({
        method: 'POST',
        url: '/api/projects/wizard-api/summarize-context',
        headers: authHeaders(),
        payload: { sessions: ['old.jsonl'], selections: [{ session: 'old.jsonl', text: 'Use the stable API contract.' }] },
      });
      expect(start.statusCode).toBe(200);
      const started = JSON.parse(start.body) as { taskId: string; status: string; summary: string | null };
      expect(started.taskId).toContain('summarize-previous-context');
      expect(started.summary).toBeNull();

      const status = await server.inject({ method: 'GET', url: `/api/projects/wizard-api/summarize-context/${encodeURIComponent(started.taskId.replace('/', '~'))}`, headers: authHeaders() });
      expect(status.statusCode).toBe(200);
      expect(JSON.parse(status.body)).toMatchObject({ taskId: started.taskId, summary: null });
      expect(status.body).not.toContain('Use the stable API contract.');
    });

    it('creates a sensitive new project and provisions its project-local worktree root', async () => {
      const projectPath = path.join(tmpDir, 'sensitive-new');
      const response = await server.inject({
        method: 'POST',
        url: '/api/projects/new',
        headers: authHeaders(),
        payload: {
          name: 'Sensitive New',
          path: projectPath,
          defaultBranch: 'main',
          settings: {
            brain: { permissions: 'standard' },
            worktree: { root: path.join(tmpDir, '.agenthub-worktrees'), logsInRoot: true },
            notifications: { telegramContent: 'minimal' },
          },
        },
      });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body) as { settings: { worktree: { root: string; logsInRoot: boolean }; notifications: { telegramContent: string } } };
      expect(fs.statSync(path.join(tmpDir, '.agenthub-worktrees')).isDirectory()).toBe(true);
      expect(body.settings.worktree).toMatchObject({ root: path.join(tmpDir, '.agenthub-worktrees'), logsInRoot: true });
      expect(body.settings.notifications.telegramContent).toBe('minimal');
    });
  });

  describe('GET /api/tasks pagination', () => {
    it('returns paged metadata/cursor and preserves the legacy array response', async () => {
      ctx.projectRepo.insert({ id: 'page-api-a', name: 'Page A', path: path.join(tmpDir, 'page-a'), defaultBranch: 'main', maxParallel: 2 });
      ctx.projectRepo.insert({ id: 'page-api-b', name: 'Page B', path: path.join(tmpDir, 'page-b'), defaultBranch: 'main', maxParallel: 2 });
      for (const [projectId, slug, status] of [['page-api-a', 'first', 'queued'], ['page-api-a', 'second', 'running'], ['page-api-b', 'other', 'queued']] as const) {
        ctx.taskRepo.insert({ id: `${projectId}/${slug}`, projectId, slug, title: `${projectId} ${slug}`, status });
      }

      const first = await server.inject({ method: 'GET', url: '/api/tasks?project=page-api-a&limit=1', headers: authHeaders() });
      expect(first.statusCode).toBe(200);
      const firstBody = JSON.parse(first.body) as { items: Array<{ projectId: string }>; total: number; nextCursor: string | null };
      expect(firstBody.total).toBe(2);
      expect(firstBody.items).toHaveLength(1);
      expect(firstBody.items[0].projectId).toBe('page-api-a');
      expect(firstBody.nextCursor).toBeTruthy();

      const second = await server.inject({ method: 'GET', url: `/api/tasks?project=page-api-a&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`, headers: authHeaders() });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body).items).toHaveLength(1);

      const legacy = await server.inject({ method: 'GET', url: '/api/tasks?project=page-api-a', headers: authHeaders() });
      expect(legacy.statusCode).toBe(200);
      expect(Array.isArray(JSON.parse(legacy.body))).toBe(true);
    });
  });
});
