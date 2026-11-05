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
    for (const [id, externalRef] of [['fe', '42'], ['be', '42'], ['no-ticket', null] as const]) taskRepo.insert({ id, projectId: 'p', slug: id, title: id, branch: 'task', externalRef, status: 'done' });
    runRepo.insert({ id: 'r', taskId: 'fe', engine: 'test', model: 'test', profileName: 'test', startedAt: '2026-11-04T09:00:00Z', kind: 'worker' }); runRepo.finish('r', 'done');
    let post = 0; let patch = 0;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => { const value = url.toString(); if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1 })); if (value.includes('/time_entries')) { if (init?.method === 'PATCH') patch++; else post++; return new Response(JSON.stringify({ id: 99, hours: 'PT8H', spentOn: '2026-11-04' })); } throw new Error(`unexpected ${value}`); }) as typeof fetch;
    const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, fetchFn, eventBus: { emit: () => true } });
    const first = await service.run('op', '2026-11-04'); expect(first.entries).toHaveLength(1); expect(first.entries[0].run).toBeGreaterThan(0); expect(first.withoutTicket).toHaveLength(1); expect(post).toBe(1);
    await service.run('op', '2026-11-04'); expect(patch).toBe(1); db.close(); fs.rmSync(root, { recursive: true, force: true });
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
