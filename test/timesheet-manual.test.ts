import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { loadConfig, OpenProjectSourceSchema } from '../src/config.js';
import { openDatabase, EventRepo, ProjectRepo, RunRepo, TaskRepo, TimesheetEntryRepo, TimesheetManualEntryRepo, TimesheetDayOverrideRepo } from '../src/db/index.js';
import { mergeProjectSettings, DEFAULT_PROJECT_SETTINGS } from '../src/projects/settings.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';
import { OpenProjectTimesheetService } from '../src/integrations/openproject/timesheet.js';
import { registerOpenProjectRoutes } from '../src/integrations/openproject/routes.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-manual-timesheet-'));
  const repoPath = path.join(root, 'repo'); fs.mkdirSync(repoPath);
  const git = (args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-04T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-04T10:00:00Z' } });
  git(['init', '-q']); git(['config', 'user.email', 'test@example.test']); git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repoPath, 'README'), 'base'); git(['add', 'README']); git(['commit', '-qm', 'base']); git(['branch', '-M', 'main']);
  git(['checkout', '-qb', 'task']); fs.writeFileSync(path.join(repoPath, 'README'), 'work'); git(['add', 'README']);
  git(['commit', '-qm', 'implement export', '--date', '2026-11-04T10:00:00Z']);
  const config = loadConfig(root);
  config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo', activityId: 7, timesheet: { enabled: true, activityId: 7, minEntryHours: 0.5, roundTo: 0.25 } })];
  saveOpenProjectKey(root, 'op', 'test-key');
  const db = openDatabase(path.join(root, 'hub.db')); const projectRepo = new ProjectRepo(db); const taskRepo = new TaskRepo(db); const runRepo = new RunRepo(db); const eventRepo = new EventRepo(db); const entryRepo = new TimesheetEntryRepo(db); const manualRepo = new TimesheetManualEntryRepo(db); const dayOverrideRepo = new TimesheetDayOverrideRepo(db);
  projectRepo.insert({ id: 'p', name: 'P', path: repoPath, defaultBranch: 'main', maxParallel: 1, settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, { openproject: { enabled: true, sourceId: 'op', role: 'primary' } })) });
  taskRepo.insert({ id: 't', projectId: 'p', slug: 't', title: 't', branch: 'task', externalRef: '42', status: 'done', level: 'easy' });
  runRepo.insert({ id: 'r', taskId: 't', engine: 'test', model: 'test', profileName: 'test', startedAt: '2026-11-04T08:00:00Z', endedAt: '2026-11-04T10:00:00Z', kind: 'worker' });
  const fetchFn = (async (url: string | URL, _init?: RequestInit) => {
    const value = url.toString();
    if (value.endsWith('/work_packages/42')) return new Response(JSON.stringify({ id: 42, displayId: 'OP-42', subject: 'Export', lockVersion: 1 }));
    if (value.includes('/work_packages?')) return new Response(JSON.stringify({ _embedded: { elements: [] }, total: 0 }));
    if (value.includes('/time_entries')) return new Response(JSON.stringify({ id: 99 }));
    throw new Error(`unexpected ${value}`);
  }) as typeof fetch;
  const service = new OpenProjectTimesheetService({ config, projectRepo, taskRepo, runRepo, eventRepo, entryRepo, manualRepo, dayOverrideRepo, fetchFn, eventBus: { emit: () => true } });
  return { root, db, service, manualRepo, dayOverrideRepo, entryRepo, fetchFn };
}

describe('manual timesheet allocation and persistence', () => {
  it('merges manual work with commits, includes raw estimate, and keeps pinned hours first', async () => {
    const f = fixture();
    f.manualRepo.insert({ id: 'm1', source_id: 'op', spent_on: '2026-11-04', wp_id: 42, display_id: 'OP-42', description: 'Cài lại máy', active_hours: 2, wait_hours: 1, level: 'hard', pinned: 0 });
    const mixed = await f.service.preview('op', '2026-11-04');
    expect(mixed.entries[0]).toMatchObject({ kind: 'mixed', manualIds: ['m1'] }); expect(mixed.entries[0].rawHours).toBeGreaterThan(2); expect(mixed.entries[0].estimateHours).toBe(mixed.entries[0].rawHours); expect(mixed.entries[0].comment).toContain('Cài lại máy');
    f.manualRepo.insert({ id: 'm2', source_id: 'op', spent_on: '2026-11-04', wp_id: 42, display_id: 'OP-42', description: 'Cố định', active_hours: 9, wait_hours: 0, level: 'easy', pinned: 1 });
    const pinned = await f.service.preview('op', '2026-11-04');
    expect(pinned.fixedHours).toBe(9); expect(pinned.fixedOverHours).toBe(true); expect(pinned.entries[0].hours).toBeGreaterThanOrEqual(9);
    f.db.close(); fs.rmSync(f.root, { recursive: true, force: true });
  });

  it('uses a day override, warns about unavailable tickets, and preserves removed OP entries', async () => {
    const f = fixture(); f.dayOverrideRepo.upsert('op', '2026-11-04', 10);
    expect((await f.service.preview('op', '2026-11-04')).hours).toBe(10);
    f.manualRepo.insert({ id: 'missing', source_id: 'op', spent_on: '2026-11-04', wp_id: 404, display_id: 'OP-404', description: 'Không đọc được', active_hours: 1, wait_hours: 0, level: 'easy', pinned: 0 });
    const oldFetch = f.fetchFn; const service = f.service;
    (service as unknown as { fetchFn: typeof fetch }).fetchFn = (async (url: string | URL, init?: RequestInit) => url.toString().endsWith('/work_packages/404') ? new Response('{}', { status: 404 }) : oldFetch(url, init)) as typeof fetch;
    const preview = await service.preview('op', '2026-11-04'); expect(preview.withoutTicket).toEqual([{ taskId: 'missing', subject: 'Không đọc được' }]);
    f.manualRepo.delete('missing'); f.entryRepo.upsert({ source_id: 'op', spent_on: '2026-11-04', wp_id: 404, entry_id: 7, hours: 1, raw_hours: 1, written_estimate: null });
    expect((await service.preview('op', '2026-11-04')).missingFromDate).toContain(404);
    f.db.close(); fs.rmSync(f.root, { recursive: true, force: true });
  });

  it('allocates flexible manual work by raw weight and caps comments at 255 characters', async () => {
    const f = fixture();
    f.manualRepo.insert({ id: 'm-flex-a', source_id: 'op', spent_on: '2026-11-04', wp_id: 42, display_id: 'OP-42', description: 'A'.repeat(240), active_hours: 2, wait_hours: 0, level: 'easy', pinned: 0 });
    f.manualRepo.insert({ id: 'm-flex-b', source_id: 'op', spent_on: '2026-11-04', wp_id: 43, display_id: 'OP-43', description: 'Việc B', active_hours: 1, wait_hours: 0, level: 'easy', pinned: 0 });
    (f.service as unknown as { fetchFn: typeof fetch }).fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString();
      if (value.endsWith('/work_packages/43')) return new Response(JSON.stringify({ id: 43, displayId: 'OP-43', subject: 'B', lockVersion: 1 }));
      return f.fetchFn(url, init);
    }) as typeof fetch;
    const preview = await f.service.preview('op', '2026-11-04');
    expect(preview.entries).toHaveLength(2);
    expect(preview.entries.find((entry) => entry.wpId === 42)?.hours).toBeGreaterThan(preview.entries.find((entry) => entry.wpId === 43)?.hours || 0);
    expect(preview.entries.find((entry) => entry.wpId === 42)?.comment).toHaveLength(255);
    f.db.close(); fs.rmSync(f.root, { recursive: true, force: true });
  });

  it('keeps pinned work fixed and gives flexible work the minimum when pinned hours exceed the day', async () => {
    const f = fixture();
    f.manualRepo.insert({ id: 'm-fixed', source_id: 'op', spent_on: '2026-11-04', wp_id: 43, display_id: 'OP-43', description: 'Cài đặt cố định', active_hours: 9, wait_hours: 1, level: 'easy', pinned: 1 });
    f.manualRepo.insert({ id: 'm-flex', source_id: 'op', spent_on: '2026-11-04', wp_id: 44, display_id: 'OP-44', description: 'Trao đổi', active_hours: 1, wait_hours: 0, level: 'easy', pinned: 0 });
    (f.service as unknown as { fetchFn: typeof fetch }).fetchFn = (async (url: string | URL, init?: RequestInit) => {
      if (url.toString().endsWith('/work_packages/43')) return new Response(JSON.stringify({ id: 43, displayId: 'OP-43', subject: 'Fixed', lockVersion: 1 }));
      if (url.toString().endsWith('/work_packages/44')) return new Response(JSON.stringify({ id: 44, displayId: 'OP-44', subject: 'Flexible', lockVersion: 1 }));
      return f.fetchFn(url, init);
    }) as typeof fetch;
    const preview = await f.service.preview('op', '2026-11-04');
    expect(preview.fixedHours).toBe(10);
    expect(preview.fixedOverHours).toBe(true);
    expect(preview.entries.find((entry) => entry.wpId === 43)?.hours).toBe(10);
    expect(preview.entries.find((entry) => entry.wpId === 44)?.hours).toBe(0.5);
    f.db.close(); fs.rmSync(f.root, { recursive: true, force: true });
  });

  it('creates a ticket before saving and leaves no orphan when creation fails', async () => {
    const f = fixture(); let createCalls = 0;
    (f.service as unknown as { fetchFn: typeof fetch }).fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const value = url.toString(); if (value.endsWith('/users/me')) return new Response(JSON.stringify({ id: 1 }));
      if (value.includes('/work_packages') && init?.method === 'POST') { createCalls++; if (createCalls === 2) return new Response('failed', { status: 500 }); return new Response(JSON.stringify({ id: 77, displayId: 'OP-77' })); }
      return f.fetchFn(url, init);
    }) as typeof fetch;
    await f.service.addManual({ sourceId: 'op', date: '2026-11-04', createTicket: { subject: 'Trao đổi' }, description: 'Trao đổi', activeHours: 1 });
    expect(f.manualRepo.listForDate('op', '2026-11-04')).toHaveLength(1);
    await expect(f.service.addManual({ sourceId: 'op', date: '2026-11-04', createTicket: { subject: 'Lỗi' }, description: 'Lỗi', activeHours: 1 })).rejects.toThrow();
    expect(f.manualRepo.listForDate('op', '2026-11-04')).toHaveLength(1);
    f.db.close(); fs.rmSync(f.root, { recursive: true, force: true });
  });

  it('validates manual API payloads and day totals', async () => {
    const app = Fastify({ logger: false }); app.setErrorHandler((error, _request, reply) => reply.status(error.statusCode && error.statusCode >= 400 ? error.statusCode : 400).send({ message: error.message })); const config = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-routes-'))); config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({ id: 'op', url: 'https://op.test', project: 'demo' })];
    registerOpenProjectRoutes(app, config, { timesheetManualAdd: async (input) => input, timesheetManualUpdate: async (_id, input) => input, timesheetDaySet: async (sourceId, date, hours) => ({ sourceId, date, hours }) }); await app.ready();
    expect((await app.inject({ method: 'POST', url: '/api/timesheet/manual', payload: { sourceId: 'op', date: '2026-11-04', ticket: 'OP-1', description: 'x', activeHours: 0, waitHours: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/timesheet/manual', payload: { sourceId: 'op', date: '2026-11-04', ticket: 'OP-1', description: 'x', activeHours: 1, waitHours: 24 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/timesheet/manual/m1', payload: { activeHours: 1, nope: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/timesheet/day', payload: { sourceId: 'op', date: '2026-11-04', hours: 7.75 } })).statusCode).toBe(400);
    await app.close();
  });
});
