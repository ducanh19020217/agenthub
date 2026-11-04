import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, OpenProjectSourceSchema, type AgentHubConfig } from '../src/config.js';
import { openDatabase, ProjectRepo, TaskRepo, TrackerItemRepo } from '../src/db/index.js';
import { mergeProjectSettings, DEFAULT_PROJECT_SETTINGS } from '../src/projects/settings.js';
import { OpenProjectIntakeService } from '../src/integrations/openproject/intake.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';
import Fastify from 'fastify';
import { HttpError } from '../src/errors.js';
import { registerOpenProjectRoutes } from '../src/integrations/openproject/routes.js';
import { Scheduler } from '../src/scheduler/index.js';

describe('OpenProjectIntakeService', () => {
  let home: string;
  let config: AgentHubConfig;
  let db: ReturnType<typeof openDatabase>;
  let projectRepo: ProjectRepo;
  let taskRepo: TaskRepo;
  let trackerRepo: TrackerItemRepo;
  let source: ReturnType<typeof OpenProjectSourceSchema.parse>;
  let workPackage: Record<string, unknown>;
  let activities: Array<Record<string, unknown>>;
  let workPackages: Map<number, Record<string, unknown>>;
  let activitiesMap: Map<number, Array<Record<string, unknown>>>;
  let fetchFn: ReturnType<typeof vi.fn>;
  let created: Array<Record<string, unknown>>;
  let events: Array<{ type: string; taskId?: string; payload?: unknown }>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-intake-'));
    config = loadConfig(home);
    config.integrations.openproject.sources = [source = OpenProjectSourceSchema.parse({
      id: 'demo', url: 'https://op.example.test', project: 'demo',
      watchStatusIds: [1], reopenedStatusIds: [2], minTicketNumber: 100,
      autoStart: false,
    })];
    db = openDatabase(path.join(home, 'hub.db'));
    projectRepo = new ProjectRepo(db);
    taskRepo = new TaskRepo(db);
    trackerRepo = new TrackerItemRepo(db);
    projectRepo.insert({
      id: 'primary', name: 'Primary', path: home, defaultBranch: 'main', envTemplate: null, maxParallel: 1,
      settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
        openproject: { enabled: true, sourceId: 'demo', role: 'primary' },
      })),
    });
    saveOpenProjectKey(home, 'demo', 'test-key');
    workPackage = {
      id: 42, displayId: 'OP-123', subject: 'Broken export', updatedAt: '2026-11-03T10:00:00Z',
      lockVersion: 1, description: { raw: 'Description' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    };
    activities = [];
    workPackages = new Map();
    workPackages.set(42, workPackage);
    activitiesMap = new Map();
    fetchFn = vi.fn(async (url: string | URL) => {
      const value = url.toString();
      if (value.includes('/users/me')) return new Response(JSON.stringify({ id: 1, name: 'Me' }));
      if (value.includes('/users/')) return new Response(JSON.stringify({ id: 2, name: 'Tester' }));
      if (value.includes('/work_packages?')) {
        const elements = Array.from(workPackages.keys()).map((id) => ({ id }));
        return new Response(JSON.stringify({ total: elements.length, _embedded: { elements } }));
      }
      const actMatch = value.match(/\/work_packages\/(\d+)\/activities/);
      if (actMatch) {
        const wpId = Number(actMatch[1]);
        const list = activitiesMap.get(wpId) || activities;
        return new Response(JSON.stringify({ _embedded: { elements: list } }));
      }
      const wpMatch = value.match(/\/work_packages\/(\d+)$/);
      if (wpMatch) {
        const wpId = Number(wpMatch[1]);
        const wp = workPackages.get(wpId) || (wpId === 42 ? workPackage : undefined);
        if (wp) return new Response(JSON.stringify(wp));
      }
      throw new Error(`unexpected URL ${value}`);
    });
    created = [];
    events = [];
  });

  afterEach(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function service(): OpenProjectIntakeService {
    return new OpenProjectIntakeService({
      config, projectRepo, taskRepo, trackerRepo,
      taskService: {
        createTask(raw: unknown) {
          const row = raw as Record<string, unknown>;
          const id = `${row.project}/${row.slug}`;
          taskRepo.insert({ id, projectId: String(row.project), slug: String(row.slug), title: String(row.title), body: String(row.body), externalRef: String(row.externalRef), status: 'queued' });
          created.push({ ...row, id });
          return { id };
        },
      },
      eventBus: { emit: (type, taskId, payload) => { events.push({ type, taskId, payload }); return true; } },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
  }

  it('poll 1 records baseline for 3 tickets, poll 2 unchanged yields 0 tasks', async () => {
    workPackages.clear();
    workPackages.set(101, {
      id: 101, displayId: 'OP-101', subject: 'Bug 1', updatedAt: '2026-11-03T10:00:00Z',
      lockVersion: 1, description: { raw: 'Desc 1' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    });
    workPackages.set(102, {
      id: 102, displayId: 'OP-102', subject: 'Bug 2', updatedAt: '2026-11-03T10:00:00Z',
      lockVersion: 1, description: { raw: 'Desc 2' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    });
    workPackages.set(103, {
      id: 103, displayId: 'OP-103', subject: 'Bug 3', updatedAt: '2026-11-03T10:00:00Z',
      lockVersion: 1, description: { raw: 'Desc 3' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    });

    const intake = service();
    const res1 = await intake.sync('demo');
    expect(res1).toEqual({ imported: 0, comments: 0, baseline: 3, watched: 3 });
    expect(created).toHaveLength(0);

    const items = trackerRepo.list('demo');
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(JSON.parse(item.writeback)).toMatchObject({ baseline: true });
      expect(item.task_ids).toBe('[]');
    }

    const res2 = await intake.sync('demo');
    expect(res2).toEqual({ imported: 0, comments: 0, baseline: 0, watched: 3 });
    expect(created).toHaveLength(0);
  });

  it('baseline ticket transitioning to Reopened creates 1 task, while comments without open task are ignored', async () => {
    workPackages.clear();
    workPackages.set(101, {
      id: 101, displayId: 'OP-101', subject: 'Bug 1', updatedAt: '2026-11-03T10:00:00Z',
      lockVersion: 1, description: { raw: 'Desc 1' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    });
    workPackages.set(102, {
      id: 102, displayId: 'OP-102', subject: 'Bug 2', updatedAt: '2026-11-03T10:00:00Z',
      lockVersion: 1, description: { raw: 'Desc 2' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    });

    const intake = service();
    await intake.sync('demo'); // Poll 1: baseline for 101 and 102
    expect(created).toHaveLength(0);

    // 101 is reopened: status 2 is in source.reopenedStatusIds
    workPackages.set(101, {
      ...workPackages.get(101)!,
      updatedAt: '2026-11-03T11:00:00Z',
      _links: { status: { href: '/api/v3/statuses/2' } },
      status: { title: 'Reopened' },
    });

    // 102 gets a new comment from Tester, but status remains 1
    workPackages.set(102, {
      ...workPackages.get(102)!,
      updatedAt: '2026-11-03T11:00:00Z',
    });
    activitiesMap.set(102, [{ id: 10, comment: { raw: 'Still broken' }, _links: { user: { href: '/api/v3/users/2' } } }]);

    const res = await intake.sync('demo');
    expect(res).toEqual({ imported: 1, comments: 0, baseline: 0, watched: 2 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ slug: 'op-op-101', externalRef: 'OP-101' });

    // Verify comment on baseline ticket 102 without open task was ignored
    expect(events.some((e) => e.type === 'tracker.comment')).toBe(false);

    // Verify baseline was cleared for 101
    const row101 = trackerRepo.get('demo', 101)!;
    expect(JSON.parse(row101.task_ids)).toHaveLength(1);
    expect(JSON.parse(row101.writeback).baseline).toBeUndefined();

    // Verify 102 still has baseline flag
    const row102 = trackerRepo.get('demo', 102)!;
    expect(JSON.parse(row102.writeback).baseline).toBe(true);
  });

  it('new ticket appearing after baseline creates a task idempotently', async () => {
    workPackages.clear();
    workPackages.set(101, {
      id: 101, displayId: 'OP-101', subject: 'Bug 1', updatedAt: '2026-11-03T10:00:00Z',
      lockVersion: 1, description: { raw: 'Desc 1' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    });

    const intake = service();
    await intake.sync('demo'); // Poll 1: baseline for 101
    expect(created).toHaveLength(0);

    // Ticket 104 appears after baseline
    workPackages.set(104, {
      id: 104, displayId: 'OP-104', subject: 'New Feature', updatedAt: '2026-11-03T11:00:00Z',
      lockVersion: 1, description: { raw: 'Description 104' },
      _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Reporter' },
    });

    const res1 = await intake.sync('demo');
    expect(res1).toEqual({ imported: 1, comments: 0, baseline: 0, watched: 2 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ slug: 'op-op-104', externalRef: 'OP-104' });
    expect(String(created[0].body)).toContain('## Comment cho tester');

    // Poll 2 with no changes: idempotent
    const res2 = await intake.sync('demo');
    expect(res2).toEqual({ imported: 0, comments: 0, baseline: 0, watched: 2 });
    expect(created).toHaveLength(1);
  });

  it('sync returns 400 when source is not attached to any project', async () => {
    projectRepo.update('primary', {
      settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
        openproject: { enabled: false, sourceId: null, role: 'primary' },
      })),
    });

    const intake = service();
    await expect(intake.sync('demo')).rejects.toThrow(
      'Nguồn chưa được gắn vào project nào (Dự án → Cài đặt → OpenProject → Bật + chọn nguồn, vai trò primary)',
    );

    const app = Fastify();
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof HttpError) {
        return reply.status(error.statusCode).send({ error: error.error, message: error.message });
      }
      reply.send(error);
    });
    registerOpenProjectRoutes(app, config, { sync: (id) => intake.sync(id) });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/api/integrations/openproject/sources/demo/sync' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'bad_request',
      message: 'Nguồn chưa được gắn vào project nào (Dự án → Cài đặt → OpenProject → Bật + chọn nguồn, vai trò primary)',
    });
    await app.close();
  });

  it('creates a revision after reopening a completed task and skips comments by me', async () => {
    workPackages.clear();
    const intake = service();
    await intake.sync('demo'); // poll 1: baseline (empty)
    workPackages.set(42, workPackage);
    await intake.sync('demo'); // poll 2: imports ticket 42 as new
    taskRepo.updateStatus('primary/op-op-123', 'done');
    workPackage = { ...workPackage, updatedAt: '2026-11-03T11:00:00Z', _links: { status: { href: '/api/v3/statuses/2' } } };
    workPackages.set(42, workPackage);
    activities = [{ id: 1, comment: { raw: 'my comment' }, _links: { user: { href: '/api/v3/users/1' } } }];
    await intake.sync('demo');
    expect(created.map((task) => task.slug)).toEqual(['op-op-123', 'op-op-123-r2']);
    expect(events.some((event) => event.type === 'tracker.comment')).toBe(false);
    workPackage = { ...workPackage, updatedAt: '2026-11-03T12:00:00Z' };
    workPackages.set(42, workPackage);
    activities = [{ id: 2, comment: { raw: 'another comment' }, _links: { user: { href: '/api/v3/users/2' } } }];
    await intake.sync('demo');
    expect(events.some((event) => event.type === 'tracker.comment')).toBe(true);
  });

  it('emits COMMENT for an open task, honors minTicketNumber, and does not start without a source', async () => {
    workPackages.clear();
    const intake = service();
    await intake.sync('demo'); // poll 1: baseline (empty)
    workPackages.set(42, workPackage);
    await intake.sync('demo'); // poll 2: imports ticket 42 as new
    workPackage = { ...workPackage, updatedAt: '2026-11-03T13:00:00Z' };
    workPackages.set(42, workPackage);
    activities = [{ id: 3, comment: { raw: 'please investigate' }, _links: { user: { href: '/api/v3/users/2' } } }];
    expect(await intake.sync('demo')).toEqual({ imported: 0, comments: 1, baseline: 0, watched: 1 });
    expect(events.some((event) => event.type === 'tracker.comment')).toBe(true);
    source = { ...source, minTicketNumber: 999 };
    config.integrations.openproject.sources = [source];
    expect(await service().sync('demo')).toEqual({ imported: 0, comments: 0, baseline: 0, watched: 1 });
    config.integrations.openproject.sources = [];
    fetchFn = vi.fn();
    const noTimer = service();
    noTimer.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchFn).not.toHaveBeenCalled();
    noTimer.stop();
  });

  it('backs off failed polls and caps the retry delay at 1800 seconds', async () => {
    source = { ...source, pollIntervalSec: 1 };
    config.integrations.openproject.sources = [source];
    const intake = service();
    fetchFn.mockImplementation(async () => { throw new Error('offline'); });
    vi.useFakeTimers();
    intake.start();
    await vi.advanceTimersByTimeAsync(20_000_000);
    expect(events.at(-1)?.type).toBe('tracker.poll_failed');
    expect(events.at(-1)?.payload).toMatchObject({ retryInSec: 1800 });
    intake.stop();
    vi.useRealTimers();
  });

  it('copies matching tracker ticket context into a prepared worktree only', () => {
    const worktree = path.join(home, 'worktree');
    const matching = path.join(home, 'tracker', 'demo', '42');
    const other = path.join(home, 'tracker', 'demo', '99');
    fs.mkdirSync(matching, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(matching, 'ticket.md'), 'matching ticket');
    fs.writeFileSync(path.join(other, 'ticket.md'), 'other ticket');
    trackerRepo.upsert({ source_id: 'demo', wp_id: 42, display_id: 'OP-123', status_id: 1, updated_at: '', last_comment_id: null, task_ids: '[]', writeback: '{}' });
    projectRepo.insert({ id: 'other', name: 'Other', path: home, defaultBranch: 'main', envTemplate: null, maxParallel: 1, settings: '{}' });

    const writeTaskFile = vi.fn();
    const fakeScheduler = {
      projectRepo,
      config,
      trackerRepo,
      knowledgeRepo: undefined,
      worktreeService: { writeTaskFile },
      getDependencyContext: () => [],
    } as unknown as Scheduler;
    const writeTaskFiles = (Scheduler.prototype as unknown as {
      writeTaskFiles: (task: unknown, body: string, resume: boolean) => void;
    }).writeTaskFiles;
    writeTaskFiles.call(fakeScheduler, { projectId: 'primary', worktreePath: worktree, externalRef: 'OP-123' }, 'body', false);
    expect(fs.readFileSync(path.join(worktree, '.agenthub/context/ticket/ticket.md'), 'utf8')).toBe('matching ticket');

    const unmatched = path.join(home, 'unmatched');
    writeTaskFiles.call(fakeScheduler, { projectId: 'primary', worktreePath: unmatched, externalRef: 'OP-999' }, 'body', false);
    expect(fs.existsSync(path.join(unmatched, '.agenthub/context/ticket'))).toBe(false);
  });

  it('sync route invokes intake without exposing its secret and returns 503 when unavailable', async () => {
    config.integrations.openproject.sources = [source];
    saveOpenProjectKey(home, 'demo', 'route-secret');
    const app = Fastify();
    registerOpenProjectRoutes(app, config, { sync: async (sourceId) => {
      expect(sourceId).toBe('demo');
      return { imported: 2, comments: 1, baseline: 0, watched: 2 };
    } });
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/integrations/openproject/sources/demo/sync' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ imported: 2, comments: 1, baseline: 0, watched: 2 });
    expect(response.body).not.toContain('route-secret');
    await app.close();

    const unavailable = Fastify();
    registerOpenProjectRoutes(unavailable, config);
    await unavailable.ready();
    const unavailableResponse = await unavailable.inject({ method: 'POST', url: '/api/integrations/openproject/sources/demo/sync' });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.body).not.toContain('route-secret');
    await unavailable.close();
  });
});
