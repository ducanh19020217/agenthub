import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentHubConfig, loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { createMcpServer } from '../src/mcp/index.js';
import { getOrCreateToken } from '../src/auth.js';
import {
  RemoteDeployService,
  loadRemoteDeploySecrets,
  saveRemoteDeploySecrets,
  redactSecrets,
} from '../src/remote-deploy.js';
import { EventBus } from '../src/scheduler/index.js';
import { NotificationService } from '../src/notify.js';
import { TelegramBotService } from '../src/telegram.js';

describe('Remote Deploy Service', () => {
  let tmpDir: string;
  let hubHome: string;
  let repoDir: string;
  let config: AgentHubConfig;
  const serversToClose: http.Server[] = [];

  function createTestEventBus(events?: Array<{ type: string; payload: unknown }>): EventBus {
    const bus = new EventBus({ insert: () => {} } as never);
    if (events) {
      bus.on('*', (type, _id, payload) => events.push({ type, payload }));
    }
    return bus;
  }

  function createTestServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<{ server: http.Server; url: string }> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      serversToClose.push(server);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ server, url: `http://127.0.0.1:${addr.port}/health` });
      });
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-remote-deploy-'));
    hubHome = path.join(tmpDir, 'hub');
    repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(hubHome, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    process.env.AGENTHUB_HOME = hubHome;
    config = {
      ...loadConfig(hubHome),
      hubHome,
      worktreesDir: path.join(tmpDir, 'worktrees'),
      logsDir: path.join(hubHome, 'logs'),
    };
  });

  afterEach(async () => {
    delete process.env.AGENTHUB_HOME;
    for (const server of serversToClose.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('redacts secrets from logs and text', () => {
    const text = 'curl -H "Authorization: Bearer secret-token-xyz" https://api.com?key=api-key-123';
    const redacted = redactSecrets(text, ['secret-token-xyz', 'api-key-123']);
    expect(redacted).toBe('curl -H "Authorization: Bearer ***" https://api.com?key=***');
    expect(redactSecrets('', ['foo'])).toBe('');
    expect(redactSecrets('no secrets here', [])).toBe('no secrets here');
  });

  it('saves secrets to 0600 file and loads them, returning only key names', () => {
    const keys = saveRemoteDeploySecrets(hubHome, 'proj-1', {
      API_TOKEN: 'token-abc-123',
      DB_PASSWORD: 'secret-password',
    });
    expect(keys).toEqual(['API_TOKEN', 'DB_PASSWORD']);

    const secretFile = path.join(hubHome, 'secrets', 'deploy-proj-1.env');
    expect(fs.existsSync(secretFile)).toBe(true);

    const stat = fs.statSync(secretFile);
    expect((stat.mode & 0o777)).toBe(0o600);

    const loaded = loadRemoteDeploySecrets(hubHome, 'proj-1');
    expect(loaded).toEqual({
      API_TOKEN: 'token-abc-123',
      DB_PASSWORD: 'secret-password',
    });
  });

  it('runs successfully with health check passing and emits events', async () => {
    const { url } = await createTestServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ALL SYSTEMS OPERATIONAL');
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    const eventBus = createTestEventBus(events);

    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [[process.execPath, '-e', 'console.log("running step 1"); process.exit(0)']],
                  healthChecks: [{ url, expectStatusBelow: 500, contains: 'OPERATIONAL' }],
                  waitMinutes: 1,
                  timeoutSec: 30,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus, {
      pollIntervalMs: 50,
    });

    const status = service.trigger('p1');
    expect(status.status).toBe('running');

    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.succeeded', () => resolve());
    });

    const finalStatus = service.getStatus('p1');
    expect(finalStatus?.status).toBe('succeeded');
    expect(finalStatus?.logPath).toBeDefined();
    expect(fs.existsSync(finalStatus!.logPath!)).toBe(true);

    const logContent = fs.readFileSync(finalStatus!.logPath!, 'utf8');
    expect(logContent).toContain('running step 1');
    expect(logContent).toContain('Health checks passed');
    expect(logContent).toContain('Remote deploy succeeded');

    expect(events.some((e) => e.type === 'remote_deploy.started')).toBe(true);
    expect(events.some((e) => e.type === 'remote_deploy.succeeded')).toBe(true);
  });

  it('stops immediately when a step fails', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const eventBus = createTestEventBus(events);

    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [
                    [process.execPath, '-e', 'console.log("step 1 failed"); process.exit(2)'],
                    [process.execPath, '-e', 'console.log("step 2 SHOULD NOT RUN"); process.exit(0)'],
                  ],
                  timeoutSec: 30,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus);
    service.trigger('p1');

    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.failed', () => resolve());
    });

    const finalStatus = service.getStatus('p1');
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.error).toContain('exit code 2');

    const logContent = fs.readFileSync(finalStatus!.logPath!, 'utf8');
    expect(logContent).toContain('step 1 failed');
    expect(logContent).not.toContain('step 2 SHOULD NOT RUN');
  });

  it('handles step timeout', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const eventBus = createTestEventBus(events);

    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [[process.execPath, '-e', 'setTimeout(() => {}, 10000)']],
                  timeoutSec: 1,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus);
    service.trigger('p1');

    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.failed', () => resolve());
    });

    const finalStatus = service.getStatus('p1');
    expect(finalStatus?.status).toBe('failed');
    expect(finalStatus?.error).toMatch(/timed out/i);
  });

  it('polls health checks and passes after initial waiting', async () => {
    let callCount = 0;
    const { url } = await createTestServer((req, res) => {
      callCount++;
      if (callCount < 3) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Starting up...');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('App is ready');
      }
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    const eventBus = createTestEventBus(events);

    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [[process.execPath, '-e', 'process.exit(0)']],
                  healthChecks: [{ url, expectStatusBelow: 500, contains: 'ready' }],
                  waitMinutes: 1,
                  timeoutSec: 30,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus, {
      pollIntervalMs: 50,
    });

    service.trigger('p1');

    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.succeeded', () => resolve());
    });

    const finalStatus = service.getStatus('p1');
    expect(finalStatus?.status).toBe('succeeded');
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('fails with health_timeout when health check never passes', async () => {
    const { url } = await createTestServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    const eventBus = createTestEventBus(events);

    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [[process.execPath, '-e', 'process.exit(0)']],
                  healthChecks: [{ url, expectStatusBelow: 500 }],
                  waitMinutes: 0.003, // ~180ms
                  timeoutSec: 30,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus, {
      pollIntervalMs: 30,
    });

    service.trigger('p1');

    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.health_timeout', () => resolve());
    });

    const finalStatus = service.getStatus('p1');
    expect(finalStatus?.status).toBe('health_timeout');
    expect(finalStatus?.error).toContain('status 500');

    expect(events.some((e) => e.type === 'remote_deploy.health_timeout')).toBe(true);
  });

  it('masks secrets in log and output with ***', async () => {
    saveRemoteDeploySecrets(hubHome, 'p1', {
      SUPER_SECRET: 'my_very_secret_token_123',
    });

    const eventBus = createTestEventBus();
    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [
                    [
                      process.execPath,
                      '-e',
                      'console.log("Logged token: " + process.env.SUPER_SECRET); process.exit(0)',
                    ],
                  ],
                  timeoutSec: 30,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus);
    service.trigger('p1');

    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.succeeded', () => resolve());
    });

    const finalStatus = service.getStatus('p1');
    const logContent = fs.readFileSync(finalStatus!.logPath!, 'utf8');
    expect(logContent).toContain('Logged token: ***');
    expect(logContent).not.toContain('my_very_secret_token_123');
  });

  it('loads secrets into child process environment', async () => {
    saveRemoteDeploySecrets(hubHome, 'p1', {
      CUSTOM_ENV_VAR: 'expected_env_value_42',
    });

    const eventBus = createTestEventBus();
    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [
                    [
                      process.execPath,
                      '-e',
                      'if (process.env.CUSTOM_ENV_VAR !== "expected_env_value_42") process.exit(42);',
                    ],
                  ],
                  timeoutSec: 30,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus);
    service.trigger('p1');

    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.succeeded', () => resolve());
    });

    const finalStatus = service.getStatus('p1');
    expect(finalStatus?.status).toBe('succeeded');
  });

  it('triggers on gitea.sync.succeeded only when merged=true and trigger=after-gitea-sync', async () => {
    const eventBus = createTestEventBus();
    let p1Settings = {
      remoteDeploy: {
        enabled: true,
        trigger: 'after-gitea-sync',
        steps: [[process.execPath, '-e', 'console.log("gitea triggered"); process.exit(0)']],
        timeoutSec: 30,
      },
    };

    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify(p1Settings),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus);
    service.start();

    // 1. Emit with merged=false -> should not trigger
    eventBus.emit('gitea.sync.succeeded', undefined, {
      projectId: 'p1',
      prNumber: 10,
      prUrl: 'http://gitea/pr/10',
      merged: false,
    });
    expect(service.getStatus('p1')).toBeUndefined();

    // 2. Change trigger to manual -> should not trigger
    p1Settings = {
      remoteDeploy: {
        enabled: true,
        trigger: 'manual',
        steps: [[process.execPath, '-e', 'process.exit(0)']],
        timeoutSec: 30,
      },
    };
    eventBus.emit('gitea.sync.succeeded', undefined, {
      projectId: 'p1',
      prNumber: 11,
      prUrl: 'http://gitea/pr/11',
      merged: true,
    });
    expect(service.getStatus('p1')).toBeUndefined();

    // 3. Set trigger back to after-gitea-sync and merged=true -> triggers!
    p1Settings = {
      remoteDeploy: {
        enabled: true,
        trigger: 'after-gitea-sync',
        steps: [[process.execPath, '-e', 'console.log("gitea triggered"); process.exit(0)']],
        timeoutSec: 30,
      },
    };

    const done = new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.succeeded', () => resolve());
    });

    eventBus.emit('gitea.sync.succeeded', undefined, {
      projectId: 'p1',
      prNumber: 12,
      prUrl: 'http://gitea/pr/12',
      merged: true,
      pushedCommit: 'commit-hash-999',
    });

    await done;
    const finalStatus = service.getStatus('p1');
    expect(finalStatus?.status).toBe('succeeded');
    expect(finalStatus?.trigger).toBe('after-gitea-sync');
    expect(finalStatus?.commit).toBe('commit-hash-999');

    service.stop();
  });

  it('coalesces multiple requests into one subsequent run while busy', async () => {
    const eventBus = createTestEventBus();
    const runsExecuted: string[] = [];

    const projectRepo = {
      get: (id: string) =>
        id === 'p1'
          ? {
              id: 'p1',
              name: 'P1',
              path: repoDir,
              settings: JSON.stringify({
                remoteDeploy: {
                  enabled: true,
                  trigger: 'manual',
                  steps: [[process.execPath, '-e', 'process.exit(0)']],
                  timeoutSec: 30,
                },
              }),
            }
          : undefined,
    };

    const service = new RemoteDeployService(config, projectRepo as never, eventBus, {
      processRunner: async (_cmd, _args, _opts) => {
        runsExecuted.push('run');
        await new Promise((r) => setTimeout(r, 80));
        return { code: 0, output: 'ok' };
      },
    });

    // Start run 1
    const res1 = service.trigger('p1', { commit: 'c1' });
    expect(res1.status).toBe('running');

    // While run 1 is executing, trigger multiple times
    const res2 = service.trigger('p1', { commit: 'c2' });
    expect(res2.status).toBe('queued');

    const res3 = service.trigger('p1', { commit: 'c3' });
    expect(res3.status).toBe('queued');

    // Wait until both run 1 and the coalesced run finish
    let successCount = 0;
    await new Promise<void>((resolve) => {
      eventBus.on('remote_deploy.succeeded', () => {
        successCount++;
        if (successCount === 2) resolve();
      });
    });

    expect(runsExecuted).toHaveLength(2);
    expect(service.getStatus('p1')?.commit).toBe('c3');
  });

  it('handles API routes for env, trigger, and status', async () => {
    const ctx = createContext(config);
    const token = getOrCreateToken(config.tokenPath);
    ctx.projectRepo.insert({
      id: 'demo-proj',
      name: 'Demo Project',
      path: repoDir,
      defaultBranch: 'main',
      maxParallel: 1,
      settings: JSON.stringify({
        remoteDeploy: {
          enabled: true,
          trigger: 'manual',
          steps: [[process.execPath, '-e', 'console.log("api deploy ok"); process.exit(0)']],
          timeoutSec: 30,
        },
      }),
    });

    const server = await createServer(ctx.service, config);
    const headers = {
      host: '127.0.0.1:7700',
      authorization: `Bearer ${token}`,
    };

    // 1. PUT env secrets
    const putRes = await server.inject({
      method: 'PUT',
      url: '/api/projects/demo-proj/remote-deploy/env',
      headers,
      payload: {
        SECRET_KEY_1: 'val1',
        SECRET_KEY_2: 'val2',
      },
    });
    expect(putRes.statusCode).toBe(200);
    const keys = JSON.parse(putRes.body);
    expect(keys).toEqual(['SECRET_KEY_1', 'SECRET_KEY_2']);

    // Check secrets on disk
    const secretFile = path.join(hubHome, 'secrets', 'deploy-demo-proj.env');
    expect(fs.existsSync(secretFile)).toBe(true);

    // 2. GET status before trigger
    const statusRes1 = await server.inject({
      method: 'GET',
      url: '/api/projects/demo-proj/remote-deploy/status',
      headers,
    });
    expect(statusRes1.statusCode).toBe(200);
    expect(JSON.parse(statusRes1.body).status).toBe('idle');

    // 3. POST trigger
    const postRes = await server.inject({
      method: 'POST',
      url: '/api/projects/demo-proj/remote-deploy',
      headers,
      payload: { commit: 'commit-123' },
    });
    expect(postRes.statusCode).toBe(202);
    expect(JSON.parse(postRes.body).status).toBe('running');

    // Wait for event
    await new Promise<void>((resolve) => {
      ctx.scheduler.getEventBus().on('remote_deploy.succeeded', () => resolve());
    });

    // 4. GET status after trigger
    const statusRes2 = await server.inject({
      method: 'GET',
      url: '/api/projects/demo-proj/remote-deploy/status',
      headers,
    });
    expect(statusRes2.statusCode).toBe(200);
    const statusJson = JSON.parse(statusRes2.body);
    expect(statusJson.status).toBe('succeeded');
    expect(statusJson.commit).toBe('commit-123');

    // 5. GET alias route /api/projects/:id/remote-deploy
    const statusRes3 = await server.inject({
      method: 'GET',
      url: '/api/projects/demo-proj/remote-deploy',
      headers,
    });
    expect(statusRes3.statusCode).toBe(200);
    expect(JSON.parse(statusRes3.body).status).toBe('succeeded');

    await server.close();
  });

  it('MCP tool hub_remote_deploy triggers deployment', async () => {
    const ctx = createContext(config);
    const token = getOrCreateToken(config.tokenPath);
    ctx.projectRepo.insert({
      id: 'mcp-proj',
      name: 'MCP Project',
      path: repoDir,
      defaultBranch: 'main',
      maxParallel: 1,
      settings: JSON.stringify({
        remoteDeploy: {
          enabled: true,
          trigger: 'manual',
          steps: [[process.execPath, '-e', 'process.exit(0)']],
          timeoutSec: 30,
        },
      }),
    });

    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as { port: number }).port;

    const mcpServer = createMcpServer({
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      token,
    });

    const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(sTrans);
    const client = new Client({ name: 'test-client', version: '1.0' }, { capabilities: {} });
    await client.connect(cTrans);

    const result = (await client.callTool({
      name: 'hub_remote_deploy',
      arguments: { projectId: 'mcp-proj' },
    })) as { content: Array<{ type: string; text: string }> };

    expect(result.content[0].text).toContain('✓ Đã kích hoạt remote deploy cho project "mcp-proj"');

    await client.close();
    await server.close();
  });

  it('notifies desktop and telegram on remote_deploy events', async () => {
    const eventBus = createTestEventBus();
    const desktopNotified: string[] = [];
    const telegramMessages: string[] = [];

    const notifier = new NotificationService({
      eventBus,
      config: {
        ...config,
        notifications: { desktop: true, desktopLevel: 'all' },
      },
      exec: ((_cmd: string, args: string[]) => {
        desktopNotified.push(args[args.length - 1] || '');
      }) as never,
    });
    notifier.start();

    const telegram = new TelegramBotService({
      config: {
        ...config,
        telegram: {
          enabled: true,
          botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
          allowedChatIds: [12345],
          notify: { fallback: true },
        },
      },
      tokenOverride: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      service: { getStatus: () => ({ brain: {} }) } as never,
      eventBus,
      taskRepo: {} as never,
      projectRepo: { get: () => undefined } as never,
      sleep: async () => {},
      sleepFn: async () => {},
      fetch: (async (_url: string, init?: RequestInit) => {
        if (init && typeof init.body === 'string') {
          const data = JSON.parse(init.body);
          if (data.text) telegramMessages.push(data.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as never,
    });
    eventBus.on('*', (type: string, taskId?: string, payload?: unknown) => {
      (telegram as unknown as { handleEvent: (t: string, tid?: string, p?: unknown) => void }).handleEvent(type, taskId, payload);
    });

    // 1. remote_deploy.started
    eventBus.emit('remote_deploy.started', undefined, { projectId: 'p1' });
    await telegram.flushQueue(12345);
    expect(desktopNotified.some((m) => m.includes('Bắt đầu remote deploy'))).toBe(true);
    expect(telegramMessages.some((m) => m.includes('Bắt đầu remote deploy'))).toBe(true);

    // 2. remote_deploy.succeeded
    eventBus.emit('remote_deploy.succeeded', undefined, { projectId: 'p1' });
    await telegram.flushQueue(12345);
    expect(desktopNotified.some((m) => m.includes('Remote deploy thành công'))).toBe(true);
    expect(telegramMessages.some((m) => m.includes('Remote deploy thành công'))).toBe(true);

    // 3. remote_deploy.failed
    eventBus.emit('remote_deploy.failed', undefined, { projectId: 'p1', error: 'Step failed' });
    await telegram.flushQueue(12345);
    expect(desktopNotified.some((m) => m.includes('Remote deploy thất bại'))).toBe(true);
    expect(telegramMessages.some((m) => m.includes('Remote deploy thất bại'))).toBe(true);

    // 4. remote_deploy.health_timeout
    eventBus.emit('remote_deploy.health_timeout', undefined, { projectId: 'p1', error: 'Timed out' });
    await telegram.flushQueue(12345);
    expect(desktopNotified.some((m) => m.includes('hết thời gian chờ health check'))).toBe(true);
    expect(telegramMessages.some((m) => m.includes('hết thời gian chờ health check'))).toBe(true);

    notifier.stop();
  });
});
