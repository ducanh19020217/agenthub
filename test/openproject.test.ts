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
  let prevHome: string | undefined;
  let config: AgentHubConfig;

  beforeEach(() => {
    prevHome = process.env.AGENTHUB_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-op-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    config = loadConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevHome !== undefined) process.env.AGENTHUB_HOME = prevHome;
    else delete process.env.AGENTHUB_HOME;
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

    it('searches all project tickets with optional filters, default wildcard status, and pagination', async () => {
      const calls: string[] = [];
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = url.toString();
        calls.push(u);
        if (u.includes('offset=1')) {
          const elements = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, displayId: `SIE-${i + 1}`, lockVersion: 1 }));
          return new Response(JSON.stringify({ total: 101, _embedded: { elements } }), { status: 200 });
        }
        return new Response(JSON.stringify({ total: 101, _embedded: { elements: [{ id: 101, displayId: 'SIE-101', lockVersion: 1 }] } }), { status: 200 });
      });

      // Search without status defaults to status = '*' (including closed tickets)
      const client = new OpenProjectClient({ baseUrl: 'https://op.example.com', project: 'sie', apiKey: 'key', fetch: fakeFetch as unknown as typeof fetch });
      const result = await client.searchWorkPackages({ assignee: 'me' });
      expect(result).toHaveLength(101);
      expect(result[0]?.displayId).toBe('SIE-1');
      expect(result[100]?.displayId).toBe('SIE-101');
      expect(decodeURIComponent(calls[0])).toContain('"status":{"operator":"*","values":[]}');
      expect(decodeURIComponent(calls[0])).toContain('"assignee":{"operator":"=","values":["me"]}');
      expect(calls[0]).toContain('offset=1');
      expect(calls[1]).toContain('offset=2');
    });

    it('searches by display id SIE-25 by querying numeric id and subject', async () => {
      const urls: string[] = [];
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const u = decodeURIComponent(url.toString());
        urls.push(u);
        if (u.includes('"id":{"operator":"=","values":["25"]}')) {
          return new Response(JSON.stringify({ total: 1, _embedded: { elements: [{ id: 25, displayId: 'SIE-25', subject: 'Refactor UI', lockVersion: 1 }] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ total: 0, _embedded: { elements: [] } }), { status: 200 });
      });

      const client = new OpenProjectClient({ baseUrl: 'https://op.example.com', project: 'sie', apiKey: 'key', fetch: fakeFetch as unknown as typeof fetch });
      const result = await client.searchWorkPackages({ query: 'SIE-25', status: '95' });
      expect(result).toHaveLength(1);
      expect(result[0]?.displayId).toBe('SIE-25');
      expect(urls.some((u) => u.includes('"id":{"operator":"=","values":["25"]}'))).toBe(true);
      expect(urls.some((u) => u.includes('"status":{"operator":"=","values":["95"]}'))).toBe(true);
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

    it('sets parent and retries with a fresh lock version after 409', async () => {
      let patchAttempts = 0;
      let getAttempts = 0;
      const fakeFetch = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patchAttempts++;
          if (patchAttempts === 1) return new Response('{}', { status: 409 });
          return new Response(JSON.stringify({ id: 123, lockVersion: 8, _links: { parent: { href: '/api/v3/work_packages/25' } } }), { status: 200 });
        }
        getAttempts++;
        return new Response(JSON.stringify({ id: 123, lockVersion: getAttempts, _links: {} }), { status: 200 });
      });
      const client = new OpenProjectClient({ baseUrl: 'https://op.example.com', apiKey: 'key', fetch: fakeFetch as unknown as typeof globalThis.fetch });

      await client.setParent(123, 25);
      const patches = fakeFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(patches).toHaveLength(2);
      expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ lockVersion: 1, _links: { parent: { href: '/api/v3/work_packages/25' } } });
      expect(JSON.parse(String(patches[1][1]?.body))).toEqual({ lockVersion: 2, _links: { parent: { href: '/api/v3/work_packages/25' } } });
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

    it('listStatuses calls /api/v3/statuses?pageSize=100 with auth headers', async () => {
      let requestedUrl = '';
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        requestedUrl = url.toString();
        return new Response(
          JSON.stringify({
            _embedded: {
              elements: [
                { id: 2, name: 'Closed', isClosed: true, position: 2 },
                { id: 1, name: 'New', isClosed: false, position: 1 },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
        );
      });

      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com',
        apiKey: 'secret-key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      const res = await client.listStatuses();
      expect(requestedUrl).toBe('https://op.example.com/api/v3/statuses?pageSize=100');
      expect(res._embedded?.elements).toHaveLength(2);
      expect(res._embedded?.elements?.[0].name).toBe('Closed');
    });

    it('createWorkPackage sends markdown, type, assignee, parent and status links', async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: url.toString(), init });
        if (url.toString().endsWith('/users/me')) {
          return new Response(JSON.stringify({ id: 7, name: 'Me' }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 88, displayId: 'OP-88' }), { status: 201 });
      });
      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com/', project: 'my project', apiKey: 'key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });

      await expect(client.createWorkPackage({
        subject: 'New task', descriptionMarkdown: '# Body', typeId: 3, parentId: 12, assigneeMe: true, statusId: 4,
      })).resolves.toEqual({ id: 88, displayId: 'OP-88', url: 'https://op.example.com/work_packages/88' });
      const post = calls.find((call) => call.init?.method === 'POST');
      expect(post?.url).toBe('https://op.example.com/api/v3/projects/my%20project/work_packages');
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        subject: 'New task', description: { format: 'markdown', raw: '# Body' },
        _links: {
          type: { href: '/api/v3/types/3' }, assignee: { href: '/api/v3/users/7' },
          parent: { href: '/api/v3/work_packages/12' }, status: { href: '/api/v3/statuses/4' },
        },
      });
    });

    it('createWorkPackage exposes useful OpenProject 422 messages', async () => {
      const fakeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        _embedded: { errors: [{ message: 'Type is required' }, { message: 'Status is invalid' }] },
      }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
      const client = new OpenProjectClient({
        baseUrl: 'https://op.example.com', project: 'p', apiKey: 'key',
        fetch: fakeFetch as unknown as typeof globalThis.fetch,
      });
      await expect(client.createWorkPackage({ subject: 'Task', descriptionMarkdown: '' }))
        .rejects.toThrow('Type is required; Status is invalid');
    });

    it('listTypes calls the project types endpoint', async () => {
      let url = '';
      const fakeFetch = vi.fn().mockImplementation(async (target: string | URL) => {
        url = target.toString();
        return new Response(JSON.stringify({ _embedded: { elements: [{ id: 3, name: 'Task', position: 1 }] } }), { status: 200 });
      });
      const client = new OpenProjectClient({ baseUrl: 'https://op.example.com', project: 'p', apiKey: 'key', fetch: fakeFetch as unknown as typeof globalThis.fetch });
      await expect(client.listTypes()).resolves.toMatchObject({ _embedded: { elements: [{ id: 3, name: 'Task' }] } });
      expect(url).toBe('https://op.example.com/api/v3/projects/p/types');
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

    it('links ticket to task, preserves tracker row state on update, and validates source and task existence', () => {
      const trackerRepo = new TrackerItemRepo(db);
      const taskRepo = new TaskRepo(db);
      service.taskRepo = taskRepo;
      service.setTrackerRepo(trackerRepo);

      projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 1,
      });
      taskRepo.insert({
        id: 'p1/task-1',
        projectId: 'p1',
        slug: 'task-1',
        title: 'Task 1',
        level: 'easy',
      });
      taskRepo.insert({
        id: 'p1/task-2',
        projectId: 'p1',
        slug: 'task-2',
        title: 'Task 2',
        level: 'easy',
      });

      // 404 on missing source
      expect(() => service.linkOpenProjectTicket('unknown-source', 10, 'SIE-10', 'p1/task-1')).toThrowError(/Nguồn OpenProject "unknown-source" không tồn tại/);

      // 404 on missing task
      expect(() => service.linkOpenProjectTicket('soar', 10, 'SIE-10', 'p1/missing-task')).toThrowError(/Task "p1\/missing-task" không tồn tại/);

      // New link creates row
      service.linkOpenProjectTicket('soar', 10, 'SIE-10', 'p1/task-1');
      const row1 = trackerRepo.get('soar', 10);
      expect(row1).toBeDefined();
      expect(JSON.parse(row1!.task_ids)).toEqual(['p1/task-1']);
      expect(row1!.writeback).toBe('{}');

      // Update existing tracker row with status and writeback to simulate prior work
      trackerRepo.upsert({
        ...row1!,
        status_id: 95,
        last_comment_id: 1234,
        writeback: JSON.stringify({ commented: true, resolved: true }),
      });

      // Linking another task preserves state and merges task_ids
      service.linkOpenProjectTicket('soar', 10, 'SIE-99', 'p1/task-2');
      const row2 = trackerRepo.get('soar', 10);
      expect(row2).toBeDefined();
      expect(row2!.display_id).toBe('SIE-10');
      expect(row2!.status_id).toBe(95);
      expect(row2!.last_comment_id).toBe(1234);
      expect(JSON.parse(row2!.writeback)).toEqual({ commented: true, resolved: true });
      expect(JSON.parse(row2!.task_ids)).toEqual(['p1/task-1', 'p1/task-2']);
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

    it('GET /api/integrations/openproject/sources/:id/statuses returns sorted statuses and handles missing key / errors', async () => {
      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-status',
          url: 'https://op.example.com',
          project: '123',
        }),
      ];

      // Missing key -> 400
      const noKeyRes = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources/src-status/statuses',
      });
      expect(noKeyRes.statusCode).toBe(400);

      // Nonexistent source -> 404
      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources/nonexistent/statuses',
      });
      expect(notFoundRes.statusCode).toBe(404);

      // Save key
      saveOpenProjectKey(tmpDir, 'src-status', 'status-api-key');

      // Mock fetch success: unsorted elements
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            _embedded: {
              elements: [
                { id: 12, name: 'Closed', isClosed: true, position: 3 },
                { id: 1, name: 'New', isClosed: false, position: 1 },
                { id: 7, name: 'In progress', isClosed: false, position: 2 },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
        ),
      );

      const successRes = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources/src-status/statuses',
      });
      expect(successRes.statusCode).toBe(200);
      const statuses = JSON.parse(successRes.body);
      expect(statuses).toEqual([
        { id: 1, name: 'New', isClosed: false, position: 1 },
        { id: 7, name: 'In progress', isClosed: false, position: 2 },
        { id: 12, name: 'Closed', isClosed: true, position: 3 },
      ]);

      // Mock fetch failure -> 502 without leaking key
      fetchSpy.mockResolvedValue(new Response('Server error', { status: 500 }));
      const failRes = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources/src-status/statuses',
      });
      expect(failRes.statusCode).toBe(502);
      expect(failRes.body).not.toContain('status-api-key');
    });

    it('GET /api/integrations/openproject/sources/:id/types returns sorted types', async () => {
      config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'src-types', url: 'https://op.example.com', project: '123' })];
      saveOpenProjectKey(tmpDir, 'src-types', 'types-api-key');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        _embedded: { elements: [{ id: 9, name: 'Bug', position: 2 }, { id: 3, name: 'Task', position: 1 }] },
      }), { status: 200, headers: { 'Content-Type': 'application/hal+json' } }));
      const response = await app.inject({ method: 'GET', url: '/api/integrations/openproject/sources/src-types/types' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([
        { id: 3, name: 'Task', position: 1 }, { id: 9, name: 'Bug', position: 2 },
      ]);
    });

    it('updates a ticket by display id in comment, parent, status order and maps status names', async () => {
      config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'src-update', url: 'https://op.example.com', project: '123' })];
      saveOpenProjectKey(tmpDir, 'src-update', 'update-key');
      const calls: Array<{ url: string; method: string; body?: string }> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL, init?: RequestInit) => {
        const url = input.toString();
        calls.push({ url, method: init?.method || 'GET', body: init?.body ? String(init.body) : undefined });
        if (url.includes('/projects/123/work_packages?')) {
          return new Response(JSON.stringify({ total: 2, _embedded: { elements: [
            { id: 27, displayId: 'SIE-27', subject: 'Child', lockVersion: 1 },
            { id: 25, displayId: 'SIE-25', subject: 'Parent', lockVersion: 1 },
          ] } }), { status: 200 });
        }
        if (url.endsWith('/statuses?pageSize=100')) {
          return new Response(JSON.stringify({ _embedded: { elements: [{ id: 5, name: 'Done' }, { id: 1, name: 'New' }] } }), { status: 200 });
        }
        if (url.endsWith('/activities') && init?.method === 'POST') return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        if (url.endsWith('/work_packages/27') && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ id: 27, displayId: 'SIE-27', lockVersion: 2, status: body._links.status ? { title: 'Done' } : undefined, _links: { parent: { title: 'SIE-25' }, status: { title: 'Done' } } }), { status: 200 });
        }
        if (url.endsWith('/work_packages/27')) return new Response(JSON.stringify({ id: 27, displayId: 'SIE-27', lockVersion: 1 }), { status: 200 });
        throw new Error(`unexpected URL ${url}`);
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-update/work-packages/SIE-27/update',
        payload: { comment: 'Đã xử lý', parent: 'SIE-25', status: 'done' },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ id: 27, displayId: 'SIE-27', status: 'Done', parent: 'SIE-25', url: 'https://op.example.com/work_packages/27' });
      expect(calls.filter((call) => call.method === 'POST' || call.method === 'PATCH').map((call) => call.method + ':' + call.url.split('/').pop())).toEqual([
        'POST:activities', 'PATCH:27', 'PATCH:27',
      ]);
    });

    it('rejects an unknown status with the valid names and blocks a work package from another project', async () => {
      config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'src-scope', url: 'https://op.example.com', project: '123' })];
      saveOpenProjectKey(tmpDir, 'src-scope', 'scope-key');
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL) => {
        const url = input.toString();
        if (url.endsWith('/work_packages/99')) return new Response(JSON.stringify({ id: 99, lockVersion: 1, _links: { project: { href: '/api/v3/projects/other', title: 'other' } } }), { status: 200 });
        if (url.includes('/projects/123/work_packages?')) return new Response(JSON.stringify({ total: 1, _embedded: { elements: [{ id: 27, displayId: 'SIE-27', lockVersion: 1 }] } }), { status: 200 });
        if (url.endsWith('/statuses?pageSize=100')) return new Response(JSON.stringify({ _embedded: { elements: [{ id: 5, name: 'Done' }, { id: 1, name: 'New' }] } }), { status: 200 });
        throw new Error(`unexpected URL ${url}`);
      });

      const invalid = await app.inject({ method: 'POST', url: '/api/integrations/openproject/sources/src-scope/work-packages/SIE-27/update', payload: { status: 'missing' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).toContain('Done, New');

      const forbidden = await app.inject({ method: 'POST', url: '/api/integrations/openproject/sources/src-scope/work-packages/99/update', payload: { comment: 'nope' } });
      expect(forbidden.statusCode).toBe(403);
    });

    it('GET /api/integrations/openproject/sources/:id/tickets searches tickets, maps status names, and hides API key', async () => {
      config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'src-tickets-get', url: 'https://op.example.com', project: '123' })];
      saveOpenProjectKey(tmpDir, 'src-tickets-get', 'secret-search-key');

      let requestedUrl = '';
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL) => {
        const url = input.toString();
        requestedUrl = url;
        if (url.endsWith('/statuses?pageSize=100')) {
          return new Response(JSON.stringify({ _embedded: { elements: [{ id: 95, name: 'Resolved' }, { id: 1, name: 'New' }] } }), { status: 200 });
        }
        if (url.includes('/projects/123/work_packages?')) {
          return new Response(JSON.stringify({
            total: 1,
            _embedded: {
              elements: [{
                id: 25,
                displayId: 'SIE-25',
                subject: 'Auth fix',
                status: { title: 'Resolved' },
                _links: { parent: { title: 'SIE-1' }, assignee: { title: 'Alice' } },
              }],
            },
          }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      // Valid search with status name mapping
      const res = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources/src-tickets-get/tickets?q=Auth&status=Resolved&assignee=me',
      });
      expect(res.statusCode).toBe(200);
      const results = JSON.parse(res.body);
      expect(results).toEqual([{
        displayId: 'SIE-25',
        subject: 'Auth fix',
        status: 'Resolved',
        parent: 'SIE-1',
        assignee: 'Alice',
        url: 'https://op.example.com/work_packages/25',
      }]);
      expect(decodeURIComponent(requestedUrl)).toContain('"status":{"operator":"=","values":["95"]}');
      expect(res.body).not.toContain('secret-search-key');

      // Invalid status returns 400
      const invalidStatusRes = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources/src-tickets-get/tickets?status=nonexistent',
      });
      expect(invalidStatusRes.statusCode).toBe(400);
      expect(JSON.parse(invalidStatusRes.body).message).toContain('Trạng thái "nonexistent" không hợp lệ');

      // 502 on failure does not leak secret key
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error with key secret-search-key'));
      const failRes = await app.inject({
        method: 'GET',
        url: '/api/integrations/openproject/sources/src-tickets-get/tickets',
      });
      expect(failRes.statusCode).toBe(502);
      expect(failRes.body).not.toContain('secret-search-key');
    });

    it('POST /api/integrations/openproject/sources/:id/tickets creates ticket, links taskId, and validates parent/status without leaking key', async () => {
      config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'src-tickets-post', url: 'https://op.example.com', project: '123' })];
      saveOpenProjectKey(tmpDir, 'src-tickets-post', 'secret-create-key');

      let linkedArgs: unknown[] = [];
      const testApp = Fastify();
      testApp.setErrorHandler((error, _req, reply) => {
        if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        return reply.status(500).send({ error: 'internal_error', message: error.message });
      });
      registerOpenProjectRoutes(testApp, config, {
        linkTicket: (sourceId, wpId, displayId, taskId) => {
          linkedArgs = [sourceId, wpId, displayId, taskId];
        },
      });
      await testApp.ready();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL, init?: RequestInit) => {
        const url = input.toString();
        if (url.endsWith('/statuses?pageSize=100')) {
          return new Response(JSON.stringify({ _embedded: { elements: [{ id: 94, name: 'In progress' }, { id: 95, name: 'Resolved' }] } }), { status: 200 });
        }
        if (url.endsWith('/users/me')) {
          return new Response(JSON.stringify({ id: 5, name: 'Me' }), { status: 200 });
        }
        if (url.includes('/projects/123/work_packages?')) {
          return new Response(JSON.stringify({ total: 1, _embedded: { elements: [{ id: 10, displayId: 'SIE-10', lockVersion: 1 }] } }), { status: 200 });
        }
        if (url.endsWith('/work_packages/99')) {
          return new Response(JSON.stringify({ id: 99, lockVersion: 1, _links: { project: { href: '/api/v3/projects/other', title: 'other' } } }), { status: 200 });
        }
        if (url.includes('/projects/123/work_packages') && init?.method === 'POST') {
          return new Response(JSON.stringify({ id: 35, displayId: 'SIE-35' }), { status: 201 });
        }
        return new Response('Not found', { status: 404 });
      });

      // Successful creation with taskId and mapped status name
      const createRes = await testApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-tickets-post/tickets',
        payload: {
          subject: 'New feature',
          description: 'Description markdown',
          parent: 'SIE-10',
          status: 'In progress',
          taskId: 'p1/task-35',
        },
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(createRes.body);
      expect(created).toEqual({
        id: 35,
        displayId: 'SIE-35',
        url: 'https://op.example.com/work_packages/35',
        taskId: 'p1/task-35',
      });
      expect(linkedArgs).toEqual(['src-tickets-post', 35, 'SIE-35', 'p1/task-35']);
      expect(createRes.body).not.toContain('secret-create-key');

      // Parent outside project returns 403
      const forbiddenRes = await testApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-tickets-post/tickets',
        payload: {
          subject: 'Another',
          parent: 99,
        },
      });
      expect(forbiddenRes.statusCode).toBe(403);

      // Invalid status returns 400
      const invalidStatusRes = await testApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-tickets-post/tickets',
        payload: {
          subject: 'Another',
          status: 'BadStatus',
        },
      });
      expect(invalidStatusRes.statusCode).toBe(400);

      await testApp.close();
    });

    it('POST /api/integrations/openproject/sources/:id/clone copies config and key, disables timesheet, rejects duplicate project', async () => {
      const sourceApp = Fastify();
      sourceApp.setErrorHandler((error, _req, reply) => {
        if (error instanceof ZodError) {
          return reply.status(400).send({ error: 'bad_request', message: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ') });
        }
        if (error instanceof HttpError) {
          return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        }
        return reply.status(500).send({ error: 'internal_error', message: error.message });
      });

      // Setup: a source with timesheet enabled, a known API key, and type IDs
      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-clone-orig',
          url: 'https://op.example.com',
          project: 'SIE',
          timesheet: { enabled: true, time: '08:00', activityId: 5, hours: 8, min: 0.5, roundTo: 0.25, dailyReport: { enabled: true, time: '09:00', weekdaysOnly: true, maxItems: 10, telegram: false } },
          split: { typeIds: [1, 2, 99] },
          createTypeId: 1,
        }),
      ];
      saveOpenProjectKey(tmpDir, 'src-clone-orig', 'my-secret-key');

      // Fake fetch: returns types 1 and 2 (not 99) for the new project
      const fakeFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/api/v3/projects/NEW-PROJ/types')) {
          return new Response(
            JSON.stringify({ _embedded: { elements: [{ id: 1, name: 'Bug' }, { id: 2, name: 'Feature' }] } }),
            { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      });

      registerOpenProjectRoutes(sourceApp, config, { fetch: fakeFetch as unknown as typeof globalThis.fetch });
      await sourceApp.ready();

      // Clone the source
      const res = await sourceApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-clone-orig/clone',
        payload: { project: 'NEW-PROJ' },
      });
      expect(res.statusCode).toBe(200);
      const cloned = JSON.parse(res.body);

      // id generated correctly
      expect(cloned.id).toMatch(/^openproject-\d+$/);
      // project changed
      expect(cloned.project).toBe('NEW-PROJ');
      // timesheet disabled
      expect(cloned.timesheet?.enabled).toBe(false);
      // API key NOT in response body
      expect(res.body).not.toContain('my-secret-key');
      // key was copied server-side
      expect(readOpenProjectKey(tmpDir, cloned.id)).toBe('my-secret-key');
      // keyConfigured reported correctly
      expect(cloned.keyConfigured).toBe(true);
      // type IDs filtered – 99 not in new project types
      expect(cloned.split?.typeIds).toEqual([1, 2]);
      expect(cloned.createTypeId).toBe(1);
      // source was persisted
      expect(config.integrations.openproject.sources).toHaveLength(2);

      // 404 when source does not exist
      const notFoundRes = await sourceApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/nonexistent/clone',
        payload: { project: 'OTHER' },
      });
      expect(notFoundRes.statusCode).toBe(404);

      // 400 when project conflicts with another source sharing the same url
      const conflictRes = await sourceApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-clone-orig/clone',
        payload: { project: 'NEW-PROJ' }, // already taken by the clone we just created
      });
      expect(conflictRes.statusCode).toBe(400);
      expect(JSON.parse(conflictRes.body).error).toBe('duplicate_project');

      await sourceApp.close();
    });

    it('POST /api/integrations/openproject/sources/:id/clone keeps type IDs when network fails', async () => {
      const networkFailApp = Fastify();
      networkFailApp.setErrorHandler((error, _req, reply) => {
        if (error instanceof HttpError) {
          return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        }
        return reply.status(500).send({ error: 'internal_error', message: error.message });
      });

      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-clone-net',
          url: 'https://op.example.com',
          project: 'ALPHA',
          split: { typeIds: [10, 20] },
          createTypeId: 10,
        }),
      ];
      saveOpenProjectKey(tmpDir, 'src-clone-net', 'net-key');

      // Fetch always fails
      const failFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      registerOpenProjectRoutes(networkFailApp, config, { fetch: failFetch as unknown as typeof globalThis.fetch });
      await networkFailApp.ready();

      const res = await networkFailApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-clone-net/clone',
        payload: { project: 'BETA' },
      });
      expect(res.statusCode).toBe(200);
      const cloned = JSON.parse(res.body);
      // Network failure → original type IDs preserved
      expect(cloned.split?.typeIds).toEqual([10, 20]);
      expect(cloned.createTypeId).toBe(10);
      expect(cloned.timesheet?.enabled).toBe(false);

      await networkFailApp.close();
    });

    it('POST /api/integrations/openproject/sources/:id/clone rejects duplicate newId', async () => {
      const dupIdApp = Fastify();
      dupIdApp.setErrorHandler((error, _req, reply) => {
        if (error instanceof HttpError) {
          return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        }
        return reply.status(500).send({ error: 'internal_error', message: error.message });
      });

      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-dup-orig',
          url: 'https://op.example.com',
          project: 'ORIG',
          split: { typeIds: [] },
        }),
        OpenProjectSourceSchema.parse({
          id: 'src-existing',
          url: 'https://op.example.com',
          project: 'EXISTING',
          split: { typeIds: [] },
        }),
      ];

      registerOpenProjectRoutes(dupIdApp, config, { fetch: vi.fn() as unknown as typeof globalThis.fetch });
      await dupIdApp.ready();

      // Sending id that already exists → 400 duplicate_id
      const res = await dupIdApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-dup-orig/clone',
        payload: { project: 'NEW-DUP', id: 'src-existing' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('duplicate_id');

      // Ensure no source was added
      expect(config.integrations.openproject.sources).toHaveLength(2);

      await dupIdApp.close();
    });

    it('POST /api/integrations/openproject/sources/:id/clone filters type IDs when project has empty type list', async () => {
      const emptyTypesApp = Fastify();
      emptyTypesApp.setErrorHandler((error, _req, reply) => {
        if (error instanceof HttpError) {
          return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        }
        return reply.status(500).send({ error: 'internal_error', message: error.message });
      });

      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-empty-types-orig',
          url: 'https://op.example.com',
          project: 'ORIG',
          split: { typeIds: [5, 6] },
          createTypeId: 5,
        }),
      ];
      saveOpenProjectKey(tmpDir, 'src-empty-types-orig', 'empty-key');

      // Fetch returns a valid response with an empty elements list
      const emptyFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        if (url.toString().includes('/api/v3/projects/')) {
          return new Response(
            JSON.stringify({ _embedded: { elements: [] } }),
            { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      });

      registerOpenProjectRoutes(emptyTypesApp, config, { fetch: emptyFetch as unknown as typeof globalThis.fetch });
      await emptyTypesApp.ready();

      const res = await emptyTypesApp.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/src-empty-types-orig/clone',
        payload: { project: 'DEST' },
      });
      expect(res.statusCode).toBe(200);
      const cloned = JSON.parse(res.body);
      // Empty type list → all type IDs must be filtered out
      expect(cloned.split?.typeIds).toEqual([]);
      expect(cloned.createTypeId).toBeNull();

      await emptyTypesApp.close();
    });

    it('POST /api/integrations/openproject/sources/:id/clone handles concurrent clones safely without race conditions', async () => {
      const concurApp = Fastify();
      concurApp.setErrorHandler((error, _req, reply) => {
        if (error instanceof HttpError) {
          return reply.status(error.statusCode).send({ error: error.error, message: error.message });
        }
        return reply.status(500).send({ error: 'internal_error', message: error.message });
      });

      config.integrations.openproject.sources = [
        OpenProjectSourceSchema.parse({
          id: 'src-concur-orig',
          url: 'https://op.example.com',
          project: 'ORIG',
          split: { typeIds: [1] },
          createTypeId: 1,
        }),
      ];
      saveOpenProjectKey(tmpDir, 'src-concur-orig', 'concur-key');

      // Delayed fetch to ensure concurrent requests overlap in flight
      const delayedFetch = vi.fn().mockImplementation(async (url: string | URL) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (url.toString().includes('/api/v3/projects/')) {
          return new Response(
            JSON.stringify({ _embedded: { elements: [{ id: 1, name: 'Task' }] } }),
            { status: 200, headers: { 'Content-Type': 'application/hal+json' } },
          );
        }
        return new Response('Not found', { status: 404 });
      });

      registerOpenProjectRoutes(concurApp, config, { fetch: delayedFetch as unknown as typeof globalThis.fetch });
      await concurApp.ready();

      // 1. Two concurrent requests with the SAME explicit ID
      const [res1, res2] = await Promise.all([
        concurApp.inject({
          method: 'POST',
          url: '/api/integrations/openproject/sources/src-concur-orig/clone',
          payload: { project: 'CONCUR-1', id: 'shared-clone-id' },
        }),
        concurApp.inject({
          method: 'POST',
          url: '/api/integrations/openproject/sources/src-concur-orig/clone',
          payload: { project: 'CONCUR-2', id: 'shared-clone-id' },
        }),
      ]);

      const statuses = [res1.statusCode, res2.statusCode].sort();
      expect(statuses).toEqual([200, 400]);
      const errRes = res1.statusCode === 400 ? res1 : res2;
      expect(JSON.parse(errRes.body).error).toBe('duplicate_id');

      // 2. Two concurrent requests with the SAME project on same url
      const [sameProj1, sameProj2] = await Promise.all([
        concurApp.inject({
          method: 'POST',
          url: '/api/integrations/openproject/sources/src-concur-orig/clone',
          payload: { project: 'DUPLICATE-PROJ' },
        }),
        concurApp.inject({
          method: 'POST',
          url: '/api/integrations/openproject/sources/src-concur-orig/clone',
          payload: { project: 'DUPLICATE-PROJ' },
        }),
      ]);
      const sameProjStatuses = [sameProj1.statusCode, sameProj2.statusCode].sort();
      expect(sameProjStatuses).toEqual([200, 400]);
      const sameProjErr = sameProj1.statusCode === 400 ? sameProj1 : sameProj2;
      expect(JSON.parse(sameProjErr.body).error).toBe('duplicate_project');

      // 3. Two concurrent requests with default (auto-generated) IDs
      const [auto1, auto2] = await Promise.all([
        concurApp.inject({
          method: 'POST',
          url: '/api/integrations/openproject/sources/src-concur-orig/clone',
          payload: { project: 'AUTO-1' },
        }),
        concurApp.inject({
          method: 'POST',
          url: '/api/integrations/openproject/sources/src-concur-orig/clone',
          payload: { project: 'AUTO-2' },
        }),
      ]);
      expect(auto1.statusCode).toBe(200);
      expect(auto2.statusCode).toBe(200);
      const autoCloned1 = JSON.parse(auto1.body);
      const autoCloned2 = JSON.parse(auto2.body);
      expect(autoCloned1.id).toMatch(/^openproject-\d+$/);
      expect(autoCloned2.id).toMatch(/^openproject-\d+$/);
      expect(autoCloned1.id).not.toBe(autoCloned2.id);

      await concurApp.close();
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

      expect(repo.listForTask('task-2').map((row) => row.wp_id)).toEqual([100]);
      expect(repo.listForTask('missing')).toEqual([]);

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
