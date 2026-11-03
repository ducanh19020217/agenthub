import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify, { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from '../src/errors.js';
import {
  loadConfig,
  saveConfig,
  updateConfigInMemory,
  OpenProjectSourceSchema,
  AgentHubConfig,
} from '../src/config.js';
import {
  DEFAULT_PROJECT_SETTINGS,
  mergeProjectSettings,
  parseProjectSettings,
  ProjectSettingsInputSchema,
} from '../src/projects/settings.js';
import {
  OpenProjectClient,
  OpenProjectError,
  OpenProjectWorkPackage,
  OpenProjectActivity,
} from '../src/integrations/openproject/client.js';
import {
  saveOpenProjectKey,
  readOpenProjectKey,
} from '../src/integrations/openproject/secrets.js';
import {
  renderTicketMarkdown,
  writeTicketDirectory,
} from '../src/integrations/openproject/ticket.js';
import { registerOpenProjectRoutes } from '../src/integrations/openproject/routes.js';
import {
  openDatabase,
  ProjectRepo,
  TrackerItemRepo,
  TaskRepo,
  EventRepo,
} from '../src/db/index.js';
import { EventBus, type Scheduler } from '../src/scheduler/index.js';
import { AppService } from '../src/services/index.js';

describe('OpenProject Integration', () => {
  let tmpDir: string;
  let config: AgentHubConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-op-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    config = loadConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('OpenProjectClient', () => {
    it('sets correct Authorization and Accept headers and sends JSON body', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedInit = init;
        return new Response(JSON.stringify({ id: 10, name: 'Test User' }), {
          status: 200,
          headers: { 'Content-Type': 'application/hal+json' },
        });
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'secret123',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      const user = await client.me();
      expect(user).toEqual({ id: 10, name: 'Test User' });
      expect(capturedUrl).toBe('https://op.example.com/api/v3/users/me');

      const headers = capturedInit?.headers as Headers;
      const expectedAuth = `Basic ${Buffer.from('apikey:secret123').toString('base64')}`;
      expect(headers.get('Authorization')).toBe(expectedAuth);
      expect(headers.get('Accept')).toBe('application/hal+json');
    });

    it('paginates listWatched and parses query filters and offset properly', async () => {
      const calls: string[] = [];
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString();
        calls.push(urlStr);

        if (urlStr.includes('offset=1')) {
          return new Response(
            JSON.stringify({
              total: 3,
              _embedded: {
                elements: [
                  { id: 101, displayId: 'OP-101', subject: 'Bug 1', lockVersion: 1 },
                  { id: 102, displayId: 'OP-102', subject: 'Bug 2', lockVersion: 1 },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
          );
        }

        if (urlStr.includes('offset=2')) {
          return new Response(
            JSON.stringify({
              total: 3,
              _embedded: {
                elements: [{ id: 103, displayId: 'OP-103', subject: 'Bug 3', lockVersion: 1 }],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
          );
        }

        return new Response(JSON.stringify({ total: 3, _embedded: { elements: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/hal+json' },
        });
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'key',
        project: 'my-proj',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      const items = await client.listWatched([1, 100]);
      expect(items).toHaveLength(3);
      expect(items.map((i) => i.displayId)).toEqual(['OP-101', 'OP-102', 'OP-103']);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('/projects/my-proj/work_packages?filters=');
      expect(calls[0]).toContain('offset=1');
      expect(calls[1]).toContain('offset=2');
      expect(calls[0]).toContain('pageSize=100');
    });

    it('retries setStatus up to 3 times when receiving 409 conflict', async () => {
      let attempts = 0;
      let wpFetchCount = 0;

      const fakeFetch = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          attempts++;
          if (attempts < 3) {
            return new Response(JSON.stringify({ error: 'Conflict: lock version mismatch' }), {
              status: 409,
              headers: { 'Content-Type': 'application/hal+json' },
            });
          }
          return new Response(
            JSON.stringify({ id: 123, lockVersion: 5, _links: { status: { href: '/api/v3/statuses/95' } } }),
            { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
          );
        }

        // GET work package
        wpFetchCount++;
        return new Response(
          JSON.stringify({ id: 123, lockVersion: wpFetchCount, subject: 'Task' }),
          { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
        );
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      const result = await client.setStatus(123, 95);
      expect(result.id).toBe(123);
      expect(result.lockVersion).toBe(5);
      expect(attempts).toBe(3);
      expect(wpFetchCount).toBe(3);
    });

    it('throws setStatus error if 409 continues past 3 attempts', async () => {
      const fakeFetch = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return new Response(JSON.stringify({ error: 'Conflict' }), {
            status: 409,
            headers: { 'Content-Type': 'application/hal+json' },
          });
        }
        return new Response(
          JSON.stringify({ id: 123, lockVersion: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
        );
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      await expect(client.setStatus(123, 95)).rejects.toThrow(OpenProjectError);
    });

    it('caches getUserName responses by href', async () => {
      let fetchCount = 0;
      const fakeFetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        return new Response(JSON.stringify({ id: 42, name: 'Alice Bob' }), {
          status: 200,
          headers: { 'Content-Type': 'application/hal+json' },
        });
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      const name1 = await client.getUserName('/api/v3/users/42');
      const name2 = await client.getUserName('/api/v3/users/42');
      expect(name1).toBe('Alice Bob');
      expect(name2).toBe('Alice Bob');
      expect(fetchCount).toBe(1);
    });

    it('downloads attachments and adds comments', async () => {
      let postedBody = '';
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr.includes('/attachments/88/content')) {
          return new Response(Buffer.from('binary-image-data'), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        if (init?.method === 'POST') {
          postedBody = String(init.body);
          return new Response(JSON.stringify({ id: 99, comment: { raw: 'new comment' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/hal+json' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      const att = await client.downloadAttachment(88);
      expect(att.status).toBe(200);
      expect(att.headers.get('content-type')).toBe('image/png');

      const comment = await client.addComment(123, 'Testing 1 2 3');
      expect(comment.id).toBe(99);
      expect(JSON.parse(postedBody)).toEqual({ comment: { raw: 'Testing 1 2 3' } });
    });
  });

  describe('Ticket rendering and directory writing', () => {
    it('renderTicketMarkdown strips baseUrl and formats description and comments', () => {
      const wp: OpenProjectWorkPackage = {
        id: 42,
        displayId: 'PROJ-42',
        subject: 'Fix login overflow',
        lockVersion: 1,
        description: {
          raw: 'Here is an image: <img src="https://op.example.com/api/v3/attachments/99/content">',
        },
      };
      const activities: OpenProjectActivity[] = [
        { id: 1, comment: { raw: 'Comment 1 with [att](https://op.example.com/api/v3/attachments/100/content)' } },
        { id: 2, comment: undefined }, // activity without comment
      ];

      const md = renderTicketMarkdown(wp, activities, 'https://op.example.com');
      expect(md).toContain('# PROJ-42: Fix login overflow');
      expect(md).toContain('/api/v3/attachments/99/content');
      expect(md).not.toContain('https://op.example.com/api/v3/attachments/99/content');
      expect(md).toContain('## Comment 1');
      expect(md).toContain('/api/v3/attachments/100/content');
      expect(md).not.toContain('## Comment 2');
    });

    it('writeTicketDirectory downloads images, rewrites markdown links, and sets 0600/0700 permissions', async () => {
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/attachments/101/content')) {
          return new Response(Buffer.from('png-bytes'), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          });
        }
        if (urlStr.includes('/attachments/102/content')) {
          return new Response(Buffer.from('jpeg-bytes'), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      const targetDir = path.join(tmpDir, 'ticket-out');
      const wp: OpenProjectWorkPackage = {
        id: 7,
        displayId: 'TICK-7',
        subject: 'Image test',
        lockVersion: 1,
        description: {
          raw: 'Look at <img src="/api/v3/attachments/101/content"> and [link](/api/v3/attachments/102/content)',
        },
      };

      await writeTicketDirectory(client, wp, [], targetDir, 'https://op.example.com');

      expect(fs.existsSync(path.join(targetDir, 'ticket.md'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'images', '101.png'))).toBe(true);
      expect(fs.existsSync(path.join(targetDir, 'images', '102.jpeg'))).toBe(true);

      const ticketContent = fs.readFileSync(path.join(targetDir, 'ticket.md'), 'utf-8');
      expect(ticketContent).toContain('images/101.png');
      expect(ticketContent).toContain('images/102.jpeg');
      expect(ticketContent).not.toContain('/api/v3/attachments/101/content');

      const imgDirStat = fs.statSync(path.join(targetDir, 'images'));
      expect(imgDirStat.mode & 0o777).toBe(0o700);

      const ticketStat = fs.statSync(path.join(targetDir, 'ticket.md'));
      expect(ticketStat.mode & 0o777).toBe(0o600);

      const imgStat = fs.statSync(path.join(targetDir, 'images', '101.png'));
      expect(imgStat.mode & 0o777).toBe(0o600);
    });
  });

  describe('Secrets management', () => {
    it('saveOpenProjectKey creates secrets directory with 0700 and key file with 0600', () => {
      saveOpenProjectKey(tmpDir, 'test-src', 'my-api-key-123');

      const secretsDir = path.join(tmpDir, 'secrets');
      const keyFile = path.join(secretsDir, 'openproject-test-src.key');

      expect(fs.existsSync(keyFile)).toBe(true);

      const dirStat = fs.statSync(secretsDir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      const fileStat = fs.statSync(keyFile);
      expect(fileStat.mode & 0o777).toBe(0o600);

      const readBack = readOpenProjectKey(tmpDir, 'test-src');
      expect(readBack).toBe('my-api-key-123');
    });

    it('readOpenProjectKey returns null when key does not exist or is empty', () => {
      expect(readOpenProjectKey(tmpDir, 'nonexistent')).toBeNull();

      const keyFile = path.join(tmpDir, 'secrets', 'openproject-empty.key');
      fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true });
      fs.writeFileSync(keyFile, '   \n');
      expect(readOpenProjectKey(tmpDir, 'empty')).toBeNull();
    });
  });

  describe('Config and Project Settings validation', () => {
    it('validates OpenProjectSourceSchema and enforces regex and default values', () => {
      const valid = OpenProjectSourceSchema.parse({
        id: 'soar-dev',
        url: 'https://op.example.com',
        project: '123',
      });
      expect(valid.pollIntervalSec).toBe(120);
      expect(valid.minTicketNumber).toBe(0);
      expect(valid.autoStart).toBe(true);
      expect(valid.autoResolve).toBe(true);
      expect(valid.language).toBe('vi');
      expect(valid.watchStatusIds).toEqual([]);
      expect(valid.resolvedStatusId).toBeNull();

      expect(() =>
        OpenProjectSourceSchema.parse({
          id: 'INVALID_CAPS',
          url: 'https://op.example.com',
          project: '123',
        }),
      ).toThrow(ZodError);

      expect(() =>
        OpenProjectSourceSchema.parse({
          id: 'valid-id',
          url: 'not-a-url',
          project: '123',
        }),
      ).toThrow(ZodError);
    });

    it('persists sources via saveConfig and updateConfigInMemory', () => {
      const source = OpenProjectSourceSchema.parse({
        id: 'soar',
        url: 'https://op.example.com',
        project: 'p1',
        dailyReport: {
          enabled: true,
          time: '09:00',
        },
      });

      saveConfig(tmpDir, {
        integrations: {
          openproject: {
            sources: [source],
          },
        },
      });

      const reloaded = loadConfig(tmpDir);
      expect(reloaded.integrations.openproject.sources).toHaveLength(1);
      expect(reloaded.integrations.openproject.sources[0].id).toBe('soar');
      expect(reloaded.integrations.openproject.sources[0].dailyReport?.time).toBe('09:00');

      updateConfigInMemory(reloaded, {
        integrations: {
          openproject: {
            sources: [],
          },
        },
      });
      expect(reloaded.integrations.openproject.sources).toEqual([]);
    });

    it('validates project openproject settings schema and merging', () => {
      expect(DEFAULT_PROJECT_SETTINGS.openproject).toEqual({
        enabled: false,
        sourceId: null,
        role: 'primary',
      });

      const parsed = ProjectSettingsInputSchema.parse({
        openproject: {
          enabled: true,
          sourceId: 'soar',
        },
      });

      const merged = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, parsed);
      expect(merged.openproject).toEqual({
        enabled: true,
        sourceId: 'soar',
        role: 'primary',
      });

      const storedJson = JSON.stringify(merged);
      const rehydrated = parseProjectSettings(storedJson);
      expect(rehydrated.openproject).toEqual({
        enabled: true,
        sourceId: 'soar',
        role: 'primary',
      });
    });
  });

  describe('Service OpenProject binding validation', () => {
    let db: ReturnType<typeof openDatabase>;
    let projectRepo: ProjectRepo;
    let service: AppService;

    beforeEach(() => {
      db = openDatabase(path.join(tmpDir, 'hub.db'));
      projectRepo = new ProjectRepo(db);
      const taskRepo = new TaskRepo(db);
      const eventRepo = new EventRepo(db);
      const eventBus = new EventBus(eventRepo);

      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'soar',
          url: 'https://op.example.com',
          project: '123',
        }),
      ];

      service = new AppService(
        config,
        projectRepo,
        taskRepo,
        null as unknown as Scheduler,
        eventBus,
        eventRepo,
      );
    });

    afterEach(() => {
      db.close();
    });

    it('rejects project settings when sourceId does not exist (400)', () => {
      projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 1,
      });

      expect(() =>
        service.updateProject('p1', {
          settings: {
            openproject: {
              enabled: true,
              sourceId: 'nonexistent-src',
              role: 'primary',
            },
          },
        }),
      ).toThrowError(/Nguồn OpenProject "nonexistent-src" không tồn tại/);
    });

    it('rejects multiple enabled primary projects for the same source (400)', () => {
      projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 1,
        settings: JSON.stringify(
          mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
            openproject: {
              enabled: true,
              sourceId: 'soar',
              role: 'primary',
            },
          }),
        ),
      });

      projectRepo.insert({
        id: 'p2',
        name: 'Project 2',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 1,
      });

      expect(() =>
        service.updateProject('p2', {
          settings: {
            openproject: {
              enabled: true,
              sourceId: 'soar',
              role: 'primary',
            },
          },
        }),
      ).toThrowError(/đã có project primary đang bật: p1/);
    });

    it('allows secondary role or disabled primary projects on the same source', () => {
      projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 1,
        settings: JSON.stringify(
          mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
            openproject: {
              enabled: true,
              sourceId: 'soar',
              role: 'primary',
            },
          }),
        ),
      });

      projectRepo.insert({
        id: 'p2',
        name: 'Project 2',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 1,
      });

      // Secondary project succeeds
      expect(() =>
        service.updateProject('p2', {
          settings: {
            openproject: {
              enabled: true,
              sourceId: 'soar',
              role: 'secondary',
            },
          },
        }),
      ).not.toThrow();

      // Disabled primary succeeds
      expect(() =>
        service.updateProject('p2', {
          settings: {
            openproject: {
              enabled: false,
              sourceId: 'soar',
              role: 'primary',
            },
          },
        }),
      ).not.toThrow();
    });
  });

  describe('OpenProject HTTP Routes', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = Fastify();
      app.setErrorHandler((error, _req, reply) => {
        if (error instanceof ZodError) {
          return reply.status(400).send({
            error: 'bad_request',
            message: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          });
        }
        if (error instanceof HttpError) {
          return reply.status(error.statusCode).send({
            error: error.error,
            message: error.message,
          });
        }
        return reply.status(500).send({ error: 'internal_error', message: error.message });
      });

      registerOpenProjectRoutes(app, config);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('GET /api/integrations/openproject/sources never exposes key but reports keyConfigured', async () => {
      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src1',
          url: 'https://op.example.com',
          project: '123',
        }),
      ];
      saveOpenProjectKey(tmpDir, 'src1', 'secret-key-xyz');

      const res = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json).toHaveLength(1);
      expect(json[0].id).toBe('src1');
      expect(json[0].keyConfigured).toBe(true);
      expect(json[0].key).toBeUndefined();
      expect(json[0].apiKey).toBeUndefined();
      expect(res.body).not.toContain('secret-key-xyz');
    });

    it('PUT and DELETE /api/integrations/openproject/sources/:id manage sources without leaking key', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/integrations/openproject/sources/new-src',
        payload: {
          url: 'https://op.example.com',
          project: '10',
          autoResolve: false,
        },
      });

      expect(putRes.statusCode).toBe(200);
      const putJson = JSON.parse(putRes.body);
      expect(putJson.id).toBe('new-src');
      expect(putJson.keyConfigured).toBe(false);
      expect(putJson.autoResolve).toBe(false);

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/api/integrations/openproject/sources/new-src',
      });
      expect(delRes.statusCode).toBe(200);
      expect(JSON.parse(delRes.body)).toEqual({ ok: true });
      expect(config.integrations.openproject.sources).toEqual([]);
    });

    it('PUT /api/integrations/openproject/sources/:id/key saves secret and returns configured: true', async () => {
      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-key',
          url: 'https://op.example.com',
          project: '123',
        }),
      ];

      const res = await app.inject({
        method: 'PUT',
        url: '/api/integrations/openproject/sources/src-key/key',
        payload: { key: 'secret-token-123' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ configured: true });
      expect(readOpenProjectKey(tmpDir, 'src-key')).toBe('secret-token-123');
    });

    it('POST /api/integrations/openproject/sources/:id/test calls me() and returns username or safe 502', async () => {
      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-test',
          url: 'https://op.example.com',
          project: '123',
        }),
      ];

      // Missing key -> 400
      const noKeyRes = await app.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-test/test',
      });
      expect(noKeyRes.statusCode).toBe(400);

      // Save key
      saveOpenProjectKey(tmpDir, 'src-test', 'my-api-key');

      // Mock fetch success
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id: 5, name: 'Alice Test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/hal+json' },
        }),
      );

      const successRes = await app.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-test/test',
      });
      expect(successRes.statusCode).toBe(200);
      expect(JSON.parse(successRes.body)).toEqual({ ok: true, name: 'Alice Test' });

      // Mock fetch failure -> 502
      fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
      const failRes = await app.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-test/test',
      });
      expect(failRes.statusCode).toBe(502);
      expect(failRes.body).not.toContain('my-api-key');
    });
  });

  describe('Database migration & TrackerItemRepo', () => {
    let db: ReturnType<typeof openDatabase>;
    let repo: TrackerItemRepo;

    beforeEach(() => {
      db = openDatabase(path.join(tmpDir, 'hub.db'));
      repo = new TrackerItemRepo(db);
    });

    afterEach(() => {
      db.close();
    });

    it('creates and manages tracker_items rows with TrackerItemRepo', () => {
      const columns = (db.prepare('PRAGMA table_info(tracker_items)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      expect(columns).toEqual([
        'source_id', 'wp_id', 'display_id', 'status_id', 'updated_at', 'last_comment_id',
        'task_ids', 'writeback', 'created_at',
      ]);

      const row1 = repo.upsert({
        source_id: 'src1',
        wp_id: 100,
        display_id: 'SOAR-100',
        status_id: 1,
        updated_at: '2026-11-03T10:00:00Z',
        last_comment_id: null,
        task_ids: JSON.stringify(['task-1']),
        writeback: JSON.stringify({ resolved: false }),
      });

      expect(row1.source_id).toBe('src1');
      expect(row1.wp_id).toBe(100);
      expect(row1.display_id).toBe('SOAR-100');

      const fetched = repo.get('src1', 100);
      expect(fetched).toBeDefined();
      expect(fetched?.status_id).toBe(1);
      expect(fetched?.task_ids).toBe(JSON.stringify(['task-1']));

      // Upsert update
      repo.upsert({
        source_id: 'src1',
        wp_id: 100,
        display_id: 'SOAR-100',
        status_id: 95,
        updated_at: '2026-11-03T11:00:00Z',
        last_comment_id: 42,
        task_ids: JSON.stringify(['task-1', 'task-2']),
        writeback: JSON.stringify({ resolved: true }),
      });

      const updated = repo.get('src1', 100);
      expect(updated?.status_id).toBe(95);
      expect(updated?.last_comment_id).toBe(42);
      expect(updated?.writeback).toBe(JSON.stringify({ resolved: true }));

      // List
      repo.upsert({
        source_id: 'src1',
        wp_id: 101,
        display_id: 'SOAR-101',
        status_id: 1,
        updated_at: '2026-11-03T10:30:00Z',
        last_comment_id: null,
        task_ids: '[]',
        writeback: '{}',
      });

      const list = repo.list('src1');
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.wp_id)).toEqual([100, 101]);
    });
  });
});
