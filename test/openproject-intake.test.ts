import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, OpenProjectSourceSchema, type AgentHubConfig } from '../src/config.js';
import { openDatabase, ProjectRepo, TaskRepo, TrackerItemRepo } from '../src/db/index.js';
import { mergeProjectSettings, DEFAULT_PROJECT_SETTINGS } from '../src/projects/settings.js';
import { OpenProjectIntakeService } from '../src/integrations/openproject/intake.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';

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
    fetchFn = vi.fn(async (url: string | URL) => {
      const value = url.toString();
      if (value.includes('/users/me')) return new Response(JSON.stringify({ id: 1, name: 'Me' }));
      if (value.includes('/users/')) return new Response(JSON.stringify({ id: 2, name: 'Tester' }));
      if (value.includes('/work_packages?')) return new Response(JSON.stringify({ total: 1, _embedded: { elements: [{ id: 42 }] } }));
      if (value.endsWith('/activities')) return new Response(JSON.stringify({ _embedded: { elements: activities } }));
      if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify(workPackage));
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

  it('only records a marker on the first poll, then imports NEW idempotently', async () => {
    const intake = service();
    expect(await intake.sync('demo')).toEqual({ imported: 0, comments: 0 });
    expect(created).toHaveLength(0);
    expect(await intake.sync('demo')).toEqual({ imported: 1, comments: 0 });
    expect(created[0]).toMatchObject({ slug: 'op-op-123', externalRef: 'OP-123', start: false });
    expect(String(created[0].body)).toContain('## Comment cho tester');
    expect(fs.existsSync(path.join(home, 'tracker', 'demo', '42', 'ticket.md'))).toBe(true);
    expect(await intake.sync('demo')).toEqual({ imported: 0, comments: 0 });
    expect(created).toHaveLength(1);
  });

  it('creates a revision after reopening a completed task and skips comments by me', async () => {
    const intake = service();
    await intake.sync('demo');
    await intake.sync('demo');
    taskRepo.updateStatus('primary/op-op-123', 'done');
    workPackage = { ...workPackage, updatedAt: '2026-11-03T11:00:00Z', _links: { status: { href: '/api/v3/statuses/2' } } };
    activities = [{ id: 1, comment: { raw: 'my comment' }, _links: { user: { href: '/api/v3/users/1' } } }];
    await intake.sync('demo');
    expect(created.map((task) => task.slug)).toEqual(['op-op-123', 'op-op-123-r2']);
    expect(events.some((event) => event.type === 'tracker.comment')).toBe(false);
    workPackage = { ...workPackage, updatedAt: '2026-11-03T12:00:00Z' };
    activities = [{ id: 2, comment: { raw: 'another comment' }, _links: { user: { href: '/api/v3/users/2' } } }];
    await intake.sync('demo');
    expect(events.some((event) => event.type === 'tracker.comment')).toBe(true);
  });

  it('emits COMMENT for an open task, honors minTicketNumber, and does not start without a source', async () => {
    const intake = service();
    await intake.sync('demo');
    await intake.sync('demo');
    workPackage = { ...workPackage, updatedAt: '2026-11-03T13:00:00Z' };
    activities = [{ id: 3, comment: { raw: 'please investigate' }, _links: { user: { href: '/api/v3/users/2' } } }];
    expect(await intake.sync('demo')).toEqual({ imported: 0, comments: 1 });
    expect(events.some((event) => event.type === 'tracker.comment')).toBe(true);
    source = { ...source, minTicketNumber: 999 };
    config.integrations.openproject.sources = [source];
    expect(await service().sync('demo')).toEqual({ imported: 0, comments: 0 });
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
});
