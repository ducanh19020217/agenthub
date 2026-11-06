import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, OpenProjectSourceSchema } from '../src/config.js';
import { openDatabase, EventRepo, ProjectRepo, RunRepo, TaskRepo, TimesheetEntryRepo } from '../src/db/index.js';
import { mergeProjectSettings, DEFAULT_PROJECT_SETTINGS } from '../src/projects/settings.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';
import { OpenProjectTimesheetService } from '../src/integrations/openproject/timesheet.js';
import { allocateTimesheetHours } from '../src/integrations/openproject/timesheet.js';
import Fastify from 'fastify';
import { HttpError } from '../src/errors.js';
import { registerOpenProjectRoutes } from '../src/integrations/openproject/routes.js';
import { NotificationService } from '../src/notify.js';
import { TelegramBotService } from '../src/telegram.js';

describe('OpenProject timesheet allocation', () => {
  it('keeps the configured total after minimum and rounding', () => {
    const result = allocateTimesheetHours([{ weight: 3 }, { weight: 2 }, { weight: 1 }], 8, 0.5, 0.25);
    expect(result.reduce((sum, value) => sum + value, 0)).toBe(8);
    expect(result.every((value) => value >= 0.5 && Math.round(value * 4) === value * 4)).toBe(true);
  });

  it('allows the total to exceed the day when minimums require it', () => {
    expect(allocateTimesheetHours([{ weight: 1 }, { weight: 1 }, { weight: 1 }], 8, 3, 0.25)).toEqual([3, 3, 3]);
  });

  it('does not turn zero weights into a fake unit of work', () => {
    expect(allocateTimesheetHours([{ weight: 10 }, { weight: 0 }], 8, 0.5, 0.25)).toEqual([7.5, 0.5]);
  });

  it('reduces rounded excess and assigns the remainder to the largest weight', () => {
    expect(allocateTimesheetHours([{ weight: 1 }, { weight: 1 }, { weight: 1 }], 8, 0.5, 0.25)).toEqual([2.5, 2.75, 2.75]);
    expect(allocateTimesheetHours([{ weight: 3 }, { weight: 1 }, { weight: 1 }], 8, 0.5, 0.25)).toEqual([5, 1.5, 1.5]);
  });
});

describe('OpenProject timesheet service', () => {
  it('groups tasks, excludes tasks without tickets, and PATCHes on the second run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-timesheet-'));
    const repoPath = path.join(root, 'repo'); fs.mkdirSync(repoPath);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync('git', ['-C', repoPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoPath, 'README'), 'base'); git(['add', 'README']); git(['commit', '-qm', 'base'], { GIT_AUTHOR_DATE: '2026-11-03T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-03T10:00:00Z' }); git(['branch', '-M', 'main']);
    git(['checkout', '-qb', 'task']); fs.writeFileSync(path.join(repoPath, 'README'), 'work'); git(['add', 'README']); git(['commit', '-qm', 'implement export', '--date', '2026-11-04T10:00:00Z'], { GIT_AUTHOR_DATE: '2026-11-04T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-04T10:00:00Z' });
    const config = loadConfig(root); config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', activityId: 7, timesheet: { enabled: true, activityId: 7 } })]; saveOpenProjectKey(root, 'op', 'test-key');
    const db = openDatabase(path.join(root, 'hub.db')); const projectRepo = new ProjectRepo(db); const taskRepo = new TaskRepo(db); const runRepo = new RunRepo(db); const eventRepo = new EventRepo(db); const entryRepo = new TimesheetEntryRepo(db);
    projectRepo.insert({ id: 'p', name: 'P', path: repoPath, defaultBranch: 'main', maxParallel: 1, settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, { openproject: { enabled: true, sourceId: 'op', role: 'primary' } })) });
    taskRepo.insert({ id: 'fe', projectId: 'p', slug: 'fe', title: 'fe', branch: 'task', externalRef: '42', status: 'done', level: 'hard' });
    taskRepo.insert({ id: 'be', projectId: 'p', slug: 'be', title: 'be', branch: 'task', externalRef: '42', status: 'done', level: 'easy' });
    taskRepo.insert({ id: 'no-ticket', projectId: 'p', slug: 'no-ticket', title: 'no-ticket', branch: 'task', externalRef: null, status: 'done' });
    runRepo.insert({ id: 'r', taskId: 'fe', engine: 'test', model: 'test', profileName: 'test', startedAt: '2026-11-04T09:00:00Z', kind: 'worker' }); runRepo.finish('r', 'done');
    runRepo.insert({ id: 'r-be', taskId: 'be', engine: 'test', model: 'test', profileName: 'test', startedAt: '2026-11-04T10:00:00Z', kind: 'worker' }); runRepo.finish('r-be', 'done');
    db.prepare('UPDATE runs SET endedAt = ? WHERE id = ?').run('2026-11-04T10:00:00Z', 'r');
    db.prepare('UPDATE runs SET endedAt = ? WHERE id = ?').run('2026-11-04T12:00:00Z', 'r-be');
    eventRepo.insert('review.waiting', 'fe'); eventRepo.insert('tracker.comment', 'fe'); eventRepo.insert('tracker.comment', 'be');
    db.prepare('UPDATE events SET ts = ? WHERE taskId = ? AND type = ?').run('2026-11-04T09:30:00Z', 'fe', 'review.waiting');
    db.prepare('UPDATE events SET ts = ? WHERE taskId = ? AND type = ?').run('2026-11-04T09:40:00Z', 'fe', 'tracker.comment');
    db.prepare('UPDATE events SET ts = ? WHERE taskId = ? AND type = ?').run('2026-11-04T11:00:00Z', 'be', 'tracker.comment');
    let post = 0; let patch = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => { const value = url.toString(); if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1 })); if (value.includes('/time_entries')) { if (init?.method === 'PATCH') patch++; else post++; return new Response(JSON.stringify({ id: 99, hours: 'PT8H', spentOn: '2026-11-04' })); } throw new Error(`unexpected ${value}`); }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    const first = await service.run('op', '2026-11-04'); expect(first.entries).toHaveLength(1); expect(first.entries[0].run).toBe(180); expect(first.entries[0].wait).toBe(60); expect(first.entries[0].chat).toBe(30); expect(first.entries[0].weight).toBe(295); expect(first.entries[0].level).toBeCloseTo(295 / 240); expect(first.withoutTicket).toHaveLength(1); expect(post).toBe(1);
    await service.run('op', '2026-11-04'); expect(patch).toBe(1); db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('emits a redacted partial failure and keeps successful idempotency rows', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-timesheet-partial-')); const repoPath = path.join(root, 'repo'); fs.mkdirSync(repoPath);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync('git', ['-C', repoPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']); fs.writeFileSync(path.join(repoPath, 'README'), 'base'); git(['add', 'README']); git(['commit', '-qm', 'base']); git(['branch', '-M', 'main']);
    git(['checkout', '-qb', 'task']); fs.writeFileSync(path.join(repoPath, 'README'), 'work'); git(['add', 'README']); git(['commit', '-qm', 'work', '--date', '2026-11-04T10:00:00Z'], { GIT_AUTHOR_DATE: '2026-11-04T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-04T10:00:00Z' });
    const config = loadConfig(root); config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', timesheet: { enabled: true, activityId: 7 } })]; saveOpenProjectKey(root, 'op', 'secret-api-key');
    const db = openDatabase(path.join(root, 'hub.db')); const projectRepo = new ProjectRepo(db); const taskRepo = new TaskRepo(db); const runRepo = new RunRepo(db); const eventRepo = new EventRepo(db); const entryRepo = new TimesheetEntryRepo(db);
    projectRepo.insert({ id: 'p', name: 'P', path: repoPath, defaultBranch: 'main', maxParallel: 1, settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, { openproject: { enabled: true, sourceId: 'op', role: 'primary' } })) });
    taskRepo.insert({ id: 'a', projectId: 'p', slug: 'a', title: 'a', branch: 'task', externalRef: '42', status: 'done' }); taskRepo.insert({ id: 'b', projectId: 'p', slug: 'b', title: 'b', branch: 'task', externalRef: '43', status: 'done' });
    const emitted: Array<{ type: string; payload?: unknown }> = []; const eventBus = { emit: (type: string, _task?: string, payload?: unknown) => { emitted.push({ type, payload }); return true; } };
    const fetchFn = (async (url: string | URL, init?: RequestInit) => { const value = url.toString(); if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'First' })); if (value.endsWith('/work_packages/43')) return new Response(JSON.stringify({ id: 43, displayId: 'OP-43', subject: 'Second' })); if (value.includes('/time_entries')) { if (init?.method === 'POST' && String(init.body).includes('43')) throw new Error('request failed for secret-api-key'); return new Response(JSON.stringify({ id: 99 })); } throw new Error(`unexpected ${value}`); }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus });
    await expect(service.run('op', '2026-11-04')).rejects.toThrow('[REDACTED]');
    const failed = emitted.find((item) => item.type === 'tracker.timesheet.failed'); expect(failed).toBeDefined(); expect(JSON.stringify(failed)).not.toContain('secret-api-key'); expect((failed?.payload as { entries: unknown[] }).entries).toHaveLength(1); expect(entryRepo.listForDate('op', '2026-11-04')).toHaveLength(1);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('skips weekends, previews when writing is disabled, and does not write without activity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-timesheet-weekend-')); const repoPath = path.join(root, 'repo'); fs.mkdirSync(repoPath);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync('git', ['-C', repoPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']); fs.writeFileSync(path.join(repoPath, 'README'), 'base'); git(['add', 'README']); git(['commit', '-qm', 'base']); git(['branch', '-M', 'main']);
    git(['checkout', '-qb', 'task']); fs.writeFileSync(path.join(repoPath, 'README'), 'work'); git(['add', 'README']); git(['commit', '-qm', 'feat: export report', '--date', '2026-11-06T10:00:00Z'], { GIT_AUTHOR_DATE: '2026-11-06T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-06T10:00:00Z' });
    const config = loadConfig(root); config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', timesheet: { enabled: true, activityId: 7 } })]; saveOpenProjectKey(root, 'op', 'test-key');
    const db = openDatabase(path.join(root, 'hub.db')); const projectRepo = new ProjectRepo(db); const taskRepo = new TaskRepo(db); const runRepo = new RunRepo(db); const eventRepo = new EventRepo(db); const entryRepo = new TimesheetEntryRepo(db); projectRepo.insert({ id: 'p', name: 'P', path: repoPath, defaultBranch: 'main', maxParallel: 1, settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, { openproject: { enabled: true, sourceId: 'op', role: 'primary' } })) }); taskRepo.insert({ id: 't', projectId: 'p', slug: 't', title: 't', branch: 'task', externalRef: '42', status: 'done' });
    const fetchFn = (async (url: string | URL) => url.toString().endsWith('/work_packages/42') ? new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export' })) : new Response(JSON.stringify({ id: 99 }))) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    expect((await service.preview('op', '2026-11-07')).entries).toEqual([]);
    expect((await service.preview('op', '2026-11-06')).entries).toHaveLength(1);
    config.integrations.openproject.sources[0].timesheet!.enabled = false;
    expect((await service.preview('op', '2026-11-06')).entries).toHaveLength(1);
    config.integrations.openproject.sources[0].timesheet!.activityId = null;
    await expect(service.run('op', '2026-11-06')).resolves.toMatchObject({ entries: [{ wpId: 42 }] });
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs at or after the configured time, retries after failure, and does not run twice', async () => {
    const config = loadConfig('/tmp/agenthub-timesheet-schedule');
    config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', pollIntervalSec: 1, timesheet: { enabled: true, activityId: 7, time: '17:30' } })];
    let now = new Date('2026-11-05T17:29:00').getTime(); let calls = 0;
    const service = new OpenProjectTimesheetService({ config, projectRepo: {} as never, taskRepo: {} as never, runRepo: {} as never, eventRepo: {} as never, entryRepo: {} as never, eventBus: { emit: () => true }, now: () => now });
    (service as unknown as { run: () => Promise<void> }).run = async () => { calls += 1; if (calls === 1) throw new Error('temporary'); };
    await service.checkScheduled(); expect(calls).toBe(0);
    now = new Date('2026-11-05T17:30:00').getTime(); await service.checkScheduled(); expect(calls).toBe(1);
    now += 1_000; await service.checkScheduled(); expect(calls).toBe(1);
    now += 1_000; await service.checkScheduled(); expect(calls).toBe(2);
    await service.checkScheduled(); expect(calls).toBe(2);
  });

  it('validates time and quarter-hour configuration without floating-point multipleOf errors', () => {
    expect(() => OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', timesheet: { time: '25:00' } })).toThrow();
    expect(() => OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', timesheet: { hours: 8.1 } })).toThrow();
    expect(() => OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', timesheet: { enabled: true } })).toThrow();
  });

  it('serves preview and validates manual run hours', async () => {
    const config = loadConfig('/tmp/agenthub-timesheet-routes');
    config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo' })];
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: error.error, message: error.message });
      return reply.status(400).send({ error: 'bad_request', message: error.message });
    });
    const preview = { sourceId: 'op', date: '2026-11-05', entries: [] };
    const calls: Array<{ date?: string; hours?: number }> = [];
    registerOpenProjectRoutes(app, config, {
      timesheetPreview: async () => preview,
      timesheetRun: async (_id, date, hours) => { calls.push({ date, hours }); return preview; },
    });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/integrations/openproject/sources/op/timesheet?date=2026-11-05' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/openproject/sources/op/timesheet/run', payload: { date: '2026-11-05', hours: 8.25 } })).statusCode).toBe(200);
    expect(calls).toEqual([{ date: '2026-11-05', hours: 8.25 }]);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/openproject/sources/op/timesheet/run', payload: { hours: 7.75 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/integrations/openproject/sources/op/timesheet/run', payload: { hours: 8.1 } })).statusCode).toBe(400);
    await app.close();
  });
});

describe('OpenProject timesheet commit selection regressions', () => {
  it('uses merged task commits, ignores default-branch commits, old tasks, and allocates zero weights', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-timesheet-commits-')); const repoPath = path.join(root, 'repo'); fs.mkdirSync(repoPath);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync('git', ['-C', repoPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoPath, 'README'), 'base'); git(['add', 'README']); git(['commit', '-qm', 'base'], { GIT_AUTHOR_DATE: '2026-11-03T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-03T10:00:00Z' }); git(['branch', '-M', 'main']);
    git(['checkout', '-qb', 'task']); fs.writeFileSync(path.join(repoPath, 'task.txt'), 'task'); git(['add', 'task.txt']); git(['commit', '-qm', '[SIE-31] task work'], { GIT_AUTHOR_DATE: '2026-11-05T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T10:00:00Z' }); const taskSha = String(git(['rev-parse', 'HEAD'])).trim();
    git(['checkout', 'main']); fs.writeFileSync(path.join(repoPath, 'main.txt'), 'main'); git(['add', 'main.txt']); git(['commit', '-qm', 'unrelated default work'], { GIT_AUTHOR_DATE: '2026-11-05T11:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T11:00:00Z' });
    git(['merge', '--no-ff', 'task', '-m', 'merge task'], { GIT_AUTHOR_DATE: '2026-11-05T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T12:00:00Z' }); const mergeSha = String(git(['rev-parse', 'HEAD'])).trim(); git(['branch', '-D', 'task']);
    const config = loadConfig(root); config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', timesheet: { enabled: true, activityId: 7, minEntryHours: 0.5, roundTo: 0.25 } })]; saveOpenProjectKey(root, 'op', 'test-key');
    const db = openDatabase(path.join(root, 'hub.db')); const projectRepo = new ProjectRepo(db); const taskRepo = new TaskRepo(db); const runRepo = new RunRepo(db); const eventRepo = new EventRepo(db); const entryRepo = new TimesheetEntryRepo(db);
    projectRepo.insert({ id: 'p', name: 'P', path: repoPath, defaultBranch: 'main', maxParallel: 1, settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, { openproject: { enabled: true, sourceId: 'op', role: 'primary' } })) });
    taskRepo.insert({ id: 'p/task', projectId: 'p', slug: 'task', title: 'task', branch: 'task', externalRef: null, status: 'done' });
    taskRepo.insert({ id: 'p/no-branch', projectId: 'p', slug: 'no-branch', title: 'no branch', branch: null, externalRef: '32', status: 'done' });
    taskRepo.insert({ id: 'p/old', projectId: 'p', slug: 'old', title: 'old', branch: 'main', externalRef: '33', status: 'done' });
    eventRepo.insert('task.merged', 'p/task', { mergeCommit: mergeSha });
    const fetchFn = (async (url: string | URL) => { const value = url.toString(); const id = value.match(/work_packages\/(\d+)/)?.[1]; if (id) return new Response(JSON.stringify({ id: Number(id), displayId: `SIE-${id}`, subject: `Ticket ${id}` })); if (value.includes('/work_packages?')) return new Response(JSON.stringify({ total: 1, _embedded: { elements: [{ id: 31, displayId: 'SIE-31', subject: 'Ticket 31' }] } })); throw new Error(`unexpected ${value}`); }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    const preview = await service.preview('op', '2026-11-05');
    expect(preview.entries.map((entry) => entry.displayId)).toEqual(['SIE-31']);
    expect(preview.entries[0].hours).toBe(8);
    expect(preview.entries[0].comment).toContain('task work');
    expect(preview.entries[0].comment).not.toContain('unrelated default work');
    expect(taskSha).toMatch(/^[0-9a-f]{40}$/);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads activities from the time entry form before the legacy endpoint', async () => {
    const config = loadConfig('/tmp/agenthub-timesheet-activity-form'); config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo' })]; saveOpenProjectKey(config.hubHome, 'op', 'test-key');
    const calls: Array<{ url: string; method: string }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString(); calls.push({ url: value, method: init?.method || 'GET' });
      if (value.includes('/work_packages?')) return new Response(JSON.stringify({ total: 1, _embedded: { elements: [{ id: 17, displayId: 'SIE-17', subject: 'Ticket' }] } }));
      if (value.endsWith('/time_entries/form')) return new Response(JSON.stringify({ _embedded: { schema: { activity: { _embedded: { allowedValues: [{ id: 9, name: 'Development' }] } } } } }));
      if (value.includes('/time_entries/activities')) throw new Error('legacy endpoint must not be called');
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => reply.status(error instanceof HttpError ? error.statusCode : 500).send({ message: error.message }));
    registerOpenProjectRoutes(app, config, { fetch: fetchFn }); await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/integrations/openproject/sources/op/time-entry-activities' });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual([{ id: 9, name: 'Development' }]);
    expect(calls.some((call) => call.url.endsWith('/time_entries/form') && call.method === 'POST')).toBe(true);
    await app.close();
  });
});

describe('OpenProject timesheet notifications', () => {
  const payload = {
    sourceId: 'op', hours: 8.25, overMinimum: true, missingFromDate: [41],
    withoutTicket: [{ taskId: 'p/no-ticket', subject: 'Unlinked work' }],
    entries: [{ displayId: 'OP-42', subject: 'Export report', hours: 8.25, rawHours: 6.25, estimateHours: 6.25 }],
    estimateSkipped: [{ wpId: 42, displayId: 'OP-42', reason: 'estimate đã do người khác đặt' }],
  };

  it('includes posted details and partial failures in desktop notifications', () => {
    const config = loadConfig('/tmp/agenthub-timesheet-notify'); config.notifications.desktop = true; config.notifications.desktopLevel = 'all';
    const calls: string[] = [];
    const service = new NotificationService({ config, eventBus: {} as never, exec: (_file, args) => { calls.push(args.join(' ')); } });
    service.handleEvent('tracker.timesheet.posted', undefined, payload);
    service.handleEvent('tracker.timesheet.failed', undefined, { error: 'temporary failure', entries: payload.entries, estimateSkipped: payload.estimateSkipped });
    expect(calls.join('\n')).toContain('[OP-42] Export report — thực tế 8,25h · estimate 6,25h');
    expect(calls.join('\n')).toContain('bỏ qua estimate: [OP-42] estimate đã do người khác đặt');
    expect(calls.join('\n')).toContain('chưa có ticket');
    expect(calls.join('\n')).toContain('ticket không còn trong ngày');
    expect(calls.join('\n')).toContain('tổng vượt giờ do mức tối thiểu');
    expect(calls.join('\n')).toContain('ghi bảng giờ thất bại');
    expect(calls.join('\n')).toContain('đã ghi được: [OP-42] 8,25h');
  });

  it('includes posted details and partial failures in Telegram notifications', () => {
    const config = loadConfig('/tmp/agenthub-timesheet-telegram'); config.telegram.enabled = true; config.telegram.allowedChatIds = [123];
    const messages: string[] = [];
    const service = new TelegramBotService({ config, service: {} as never, eventBus: {} as never, taskRepo: {} as never, projectRepo: {} as never, tokenOverride: 'test-token' });
    (service as unknown as { broadcastMessage: (text: string) => void }).broadcastMessage = (text) => { messages.push(text); };
    service.handleEvent('tracker.timesheet.posted', undefined, payload);
    service.handleEvent('tracker.timesheet.failed', undefined, { error: 'temporary failure', entries: payload.entries, estimateSkipped: payload.estimateSkipped });
    expect(messages.join('\n')).toContain('[OP-42] Export report — thực tế 8,25h · estimate 6,25h');
    expect(messages.join('\n')).toContain('Bỏ qua estimate: [OP-42] estimate đã do người khác đặt');
    expect(messages.join('\n')).toContain('Chưa có ticket');
    expect(messages.join('\n')).toContain('Ticket không còn trong ngày');
    expect(messages.join('\n')).toContain('Tổng vượt giờ do mức tối thiểu');
    expect(messages.join('\n')).toContain('Đã ghi được: [OP-42] 8,25h');
  });
});

describe('OpenProject timesheet estimate writeback', () => {
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-est-'));
    const repoPath = path.join(root, 'repo'); fs.mkdirSync(repoPath);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync('git', ['-C', repoPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
    git(['init', '-q']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repoPath, 'README'), 'base'); git(['add', 'README']); git(['commit', '-qm', 'base'], { GIT_AUTHOR_DATE: '2026-11-03T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-03T10:00:00Z' }); git(['branch', '-M', 'main']);
    git(['checkout', '-qb', 'task']); fs.writeFileSync(path.join(repoPath, 'README'), 'work'); git(['add', 'README']);
    git(['commit', '-qm', 'implement export', '--date', '2026-11-04T10:00:00Z'], { GIT_AUTHOR_DATE: '2026-11-04T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-04T10:00:00Z' });
    const config = loadConfig(root);
    config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', activityId: 7, timesheet: { enabled: true, activityId: 7 } })];
    saveOpenProjectKey(root, 'op', 'test-key');
    const db = openDatabase(path.join(root, 'hub.db'));
    const projectRepo = new ProjectRepo(db); const taskRepo = new TaskRepo(db); const runRepo = new RunRepo(db); const eventRepo = new EventRepo(db); const entryRepo = new TimesheetEntryRepo(db);
    projectRepo.insert({ id: 'p', name: 'P', path: repoPath, defaultBranch: 'main', maxParallel: 1, settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, { openproject: { enabled: true, sourceId: 'op', role: 'primary' } })) });
    taskRepo.insert({ id: 't', projectId: 'p', slug: 't', title: 't', branch: 'task', externalRef: '42', status: 'done', level: 'easy' });
    runRepo.insert({ id: 'r', taskId: 't', engine: 'test', model: 'test', profileName: 'test', startedAt: '2026-11-04T08:00:00Z', kind: 'worker' }); runRepo.finish('r', 'done');
    db.prepare('UPDATE runs SET endedAt = ? WHERE id = ?').run('2026-11-04T10:00:00Z', 'r'); // 2h run
    return { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo };
  }

  it('writes estimate when field is empty on OP', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    const patches: Array<{ url: string; body: string }> = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (value.includes('/work_packages/42') && init?.method === 'PATCH') {
        patches.push({ url: value, body: String(init.body) });
        return new Response(JSON.stringify({ id: 42, lockVersion: 2, estimatedTime: JSON.parse(String(init.body)).estimatedTime }));
      }
      if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1, estimatedTime: null }));
      if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    await service.run('op', '2026-11-04');
    // Should have patched estimate
    const estimatePatch = patches.find((p) => JSON.parse(p.body).estimatedTime);
    expect(estimatePatch).toBeDefined();
    // Check DB stored written_estimate
    const row = entryRepo.get('op', '2026-11-04', 42);
    expect(row?.raw_hours).toBeGreaterThan(0);
    expect(row?.written_estimate).toBeGreaterThan(0);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not overwrite estimate set by someone else', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    const patches: string[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      // OP has estimate of 10h set by someone (not what hub wrote)
      if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1, estimatedTime: 'PT10H' }));
      if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
      if (init?.method === 'PATCH' && String(init.body).includes('estimatedTime')) { patches.push(value); return new Response(JSON.stringify({ id: 42, lockVersion: 2 })); }
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    const result = await service.run('op', '2026-11-04');
    // No estimate patch since OP has a foreign estimate
    expect(patches).toHaveLength(0);
    expect(result.estimateSkipped).toBeDefined();
    expect(result.estimateSkipped!.length).toBeGreaterThan(0);
    expect(result.estimateSkipped![0].reason).toContain('người khác');
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('running same day twice does not double-count raw hours', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    const writtenEstimates: number[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        if (body.estimatedTime) {
          const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(body.estimatedTime);
          if (m) writtenEstimates.push((parseInt(m[1] || '0', 10)) + parseInt(m[2] || '0', 10) / 60);
        }
        return new Response(JSON.stringify({ id: 42, lockVersion: 2 }));
      }
      if (value.endsWith('/work_packages/42')) {
        // Track what was written as estimate, then reflect it back
        const latestEst = writtenEstimates.at(-1);
        return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1, estimatedTime: latestEst != null ? `PT${Math.round(latestEst * 60)}M` : null }));
      }
      if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    await service.run('op', '2026-11-04');
    const firstEstimate = writtenEstimates.at(-1);
    // Run again same day
    await service.run('op', '2026-11-04');
    const secondEstimate = writtenEstimates.at(-1);
    // Estimate should be same (not doubled)
    expect(secondEstimate).toBeCloseTo(firstEstimate ?? 0, 5);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('accumulates estimate across two days', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    // Add commit on day 2 too
    const repoPath = path.join(root, 'repo');
    const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync('git', ['-C', repoPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
    git(['checkout', 'task']); fs.writeFileSync(path.join(repoPath, 'README'), 'work2'); git(['add', 'README']);
    git(['commit', '-qm', 'more work', '--date', '2026-11-05T10:00:00Z'], { GIT_AUTHOR_DATE: '2026-11-05T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T10:00:00Z' });
    // Add run on day 2
    runRepo.insert({ id: 'r2', taskId: 't', engine: 'test', model: 'test', profileName: 'test', startedAt: '2026-11-05T08:00:00Z', kind: 'worker' }); runRepo.finish('r2', 'done');
    db.prepare('UPDATE runs SET endedAt = ? WHERE id = ?').run('2026-11-05T10:00:00Z', 'r2');
    const writtenEstimates: number[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        if (body.estimatedTime) {
          const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(body.estimatedTime);
          if (m) writtenEstimates.push((parseInt(m[1] || '0', 10)) + parseInt(m[2] || '0', 10) / 60);
        }
        return new Response(JSON.stringify({ id: 42, lockVersion: 2 }));
      }
      if (value.endsWith('/work_packages/42')) {
        const latestEst = writtenEstimates.at(-1);
        return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1, estimatedTime: latestEst != null ? `PT${Math.round(latestEst * 60)}M` : null }));
      }
      if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    await service.run('op', '2026-11-04');
    const day1Estimate = writtenEstimates.at(-1) ?? 0;
    await service.run('op', '2026-11-05');
    const day2Estimate = writtenEstimates.at(-1) ?? 0;
    // Day 2 estimate should be greater than day 1 (cumulative)
    expect(day2Estimate).toBeGreaterThan(day1Estimate);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('retries estimate PATCH on 409', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    let estimateCalls = 0;
    let lockVersion = 1;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
      if (init?.method === 'PATCH' && String(init.body).includes('estimatedTime')) {
        estimateCalls++;
        if (estimateCalls === 1) return new Response(JSON.stringify({ message: 'Conflict' }), { status: 409 });
        return new Response(JSON.stringify({ id: 42, lockVersion: 3 }));
      }
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ id: 42, lockVersion: 2 }));
      if (value.endsWith('/work_packages/42')) {
        const resp = { id: 42, displayId: 'OP-42', subject: 'Export', lockVersion, estimatedTime: null };
        // After first PATCH conflict, bump lockVersion so retry succeeds
        if (estimateCalls === 1) lockVersion = 2;
        return new Response(JSON.stringify(resp));
      }
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    await service.run('op', '2026-11-04');
    expect(estimateCalls).toBe(2); // 1 fail + 1 retry
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('preview includes cumulative estimate across days', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    const repoPath = path.join(root, 'repo');
    const git = (args: string[], env?: NodeJS.ProcessEnv) => execFileSync('git', ['-C', repoPath, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
    git(['checkout', 'task']); fs.writeFileSync(path.join(repoPath, 'README'), 'work2'); git(['add', 'README']);
    git(['commit', '-qm', 'more work', '--date', '2026-11-05T10:00:00Z'], { GIT_AUTHOR_DATE: '2026-11-05T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-05T10:00:00Z' });
    runRepo.insert({ id: 'r2', taskId: 't', engine: 'test', model: 'test', profileName: 'test', startedAt: '2026-11-05T08:00:00Z', kind: 'worker' }); runRepo.finish('r2', 'done');
    db.prepare('UPDATE runs SET endedAt = ? WHERE id = ?').run('2026-11-05T10:00:00Z', 'r2');
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ id: 42, lockVersion: 2 }));
      if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1, estimatedTime: null }));
      if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    await service.run('op', '2026-11-04');
    const previewDay2 = await service.preview('op', '2026-11-05');
    expect(previewDay2.entries).toHaveLength(1);
    expect(previewDay2.entries[0].rawHours).toBe(2);
    expect(previewDay2.entries[0].estimateHours).toBe(4); // 2h from day 1 + 2h from day 2
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not overwrite if estimate was changed by someone else during 409 retry', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    let estimateCalls = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
      if (init?.method === 'PATCH' && String(init.body).includes('estimatedTime')) {
        estimateCalls++;
        return new Response(JSON.stringify({ message: 'Conflict' }), { status: 409 });
      }
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ id: 42, lockVersion: 2 }));
      if (value.endsWith('/work_packages/42')) {
        // First GET before attempt 0: estimate is null
        // Second GET on 409 retry: another user has set estimatedTime to PT5H
        const estimatedTime = estimateCalls === 0 ? null : 'PT5H';
        return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: estimateCalls + 1, estimatedTime }));
      }
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    const result = await service.run('op', '2026-11-04');
    // Only 1 attempt sent PATCH; retry aborted without sending another PATCH
    expect(estimateCalls).toBe(1);
    expect(result.estimateSkipped).toBeDefined();
    expect(result.estimateSkipped![0].reason).toContain('người khác');
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });

  it('422 on estimate does not block Spent time write', async () => {
    const { root, db, config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo } = setup();
    let spentTimePosts = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (init?.method === 'PATCH' && String(init.body).includes('estimatedTime')) {
        return new Response(JSON.stringify({ message: 'Unprocessable' }), { status: 422 });
      }
      if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1, estimatedTime: null }));
      if (value.includes('/time_entries')) { spentTimePosts++; return new Response(JSON.stringify({ id: 99 })); }
      throw new Error(`unexpected ${value}`);
    }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    const result = await service.run('op', '2026-11-04');
    expect(spentTimePosts).toBe(1);
    expect(result.entries).toHaveLength(1);
    // estimateSkipped should contain the ticket
    expect(result.estimateSkipped?.length).toBeGreaterThan(0);
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  });
});
