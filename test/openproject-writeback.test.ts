import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenProjectWritebackService } from '../src/integrations/openproject/writeback.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';

type TestTask = Record<string, unknown> & { id: string; projectId: string; externalRef: string };

function harness(input: { tasks: TestTask[]; autoResolve?: boolean; pushProjects?: string[]; targetProject?: string; fetchFn?: typeof fetch; git?: (cwd: string, args: string[]) => Promise<{ code: number; output: string }> }) {
  const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-writeback-'));
  saveOpenProjectKey(hubHome, 'op', 'key');
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  const row = { source_id: 'op', wp_id: 10, display_id: 'OP-1', status_id: 1, updated_at: '', last_comment_id: null, task_ids: JSON.stringify(input.tasks.map((task) => task.id)), writeback: '{}', created_at: '' } as any;
  let listener: ((type: string, taskId?: string, payload?: unknown) => void) | undefined;
  const events: Array<{ type: string; taskId?: string; payload?: any }> = [];
  const bus = { on: (_event: string, handler: typeof listener) => { listener = handler; }, off: () => undefined, emit: (type: string, taskId?: string, payload?: unknown) => { events.push({ type, taskId, payload }); return true; } };
  const projects = new Map<string, any>();
  for (const projectId of new Set(input.tasks.map((task) => task.projectId).concat(input.targetProject ? [input.targetProject] : []))) {
    projects.set(projectId, { id: projectId, path: hubHome, settings: JSON.stringify({ openproject: { enabled: true, sourceId: 'op', role: projectId === 'app' ? 'primary' : 'secondary', ...(input.targetProject === projectId ? {} : {}) }, ...(input.pushProjects?.includes(projectId) ? { gitea: { enabled: true, targetBranch: 'main' } } : {}) }) });
  }
  const created: unknown[] = [];
  const service = new OpenProjectWritebackService({
    config: { hubHome, integrations: { openproject: { sources: [{ id: 'op', url: 'https://op.test', project: 'main', autoResolve: input.autoResolve !== false, resolvedStatusId: 5, reviewStatusId: 6, watchStatusIds: [], reopenedStatusIds: [], openStatusIds: [], minTicketNumber: 0, pollIntervalSec: 60, autoStart: true, language: 'vi' }] } }, deploy: {} } as never,
    projectRepo: { get: (id: string) => projects.get(id) } as never,
    taskRepo: { get: (id: string) => tasks.get(id) } as never,
    trackerRepo: { listAll: () => [row], get: () => row, upsert: (next: any) => { Object.assign(row, next); return row; } } as never,
    taskService: { createTask: (raw: any) => { const createdTask = { id: `${raw.project}/${raw.slug}`, ...raw }; created.push(createdTask); tasks.set(createdTask.id, createdTask); return createdTask; } },
    eventBus: bus,
    fetchFn: input.fetchFn || (async () => new Response(JSON.stringify({ id: 11, lockVersion: 1 }), { status: 200 })) as typeof fetch,
    git: input.git,
    timerMs: 10,
  });
  service.start();
  const emit = async (type: string, taskId?: string, payload?: unknown) => { listener?.(type, taskId, payload); await new Promise((resolve) => setTimeout(resolve, 20)); };
  return { service, row, events, created, emit, cleanup: () => { service.stop(); fs.rmSync(hubHome, { recursive: true, force: true }); } };
}

const done = (id: string, projectId: string, comment = `## Comment cho tester\n${id} đã sửa`) => ({ id, projectId, slug: id, title: id, externalRef: 'OP-1', doneReport: comment, blockedReport: null, status: 'done' });

describe('OpenProjectWritebackService', () => {
  it('comments and resolves once after a merged task without push configuration', async () => {
    const h = harness({ tasks: [done('app/fix', 'app')] });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    expect(h.events.filter((event) => event.type === 'tracker.resolved')).toHaveLength(1);
    expect(JSON.parse(h.row.writeback).commented).toBe(true);
    h.cleanup();
  });

  it('waits for every task to be merged and pushed', async () => {
    let pushed = false;
    const h = harness({ tasks: [done('app/fe', 'app'), done('app/be', 'app')], pushProjects: ['app'], git: async (_cwd, args) => ({ code: args[0] === 'fetch' || pushed ? 0 : 1, output: '' }) });
    await h.emit('task.merged', 'app/fe', { mergeCommit: 'fe' });
    await h.emit('task.merged', 'app/be', { mergeCommit: 'be' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(false);
    pushed = true;
    await h.emit('gitea.sync.succeeded', undefined, { projectId: 'app', merged: true });
    expect(h.events.filter((event) => event.type === 'tracker.resolved')).toHaveLength(1);
    h.cleanup();
  });

  it('does not resolve before push and only comments when autoResolve is disabled', async () => {
    let pushed = false;
    const h = harness({ tasks: [done('app/fix', 'app')], autoResolve: false, pushProjects: ['app'], git: async (_cwd, args) => ({ code: args[0] === 'fetch' || pushed ? 0 : 1, output: '' }) });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(false);
    pushed = true;
    await h.emit('deploy.succeeded', undefined, { projectId: 'app' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(false);
    expect(JSON.parse(h.row.writeback).commented).toBe(true);
    h.cleanup();
  });

  it('requests review once per blocked task and permits later resolution', async () => {
    const task = { ...done('app/fix', 'app'), blockedReport: '## Cần quyết định\nChọn phương án 1.' };
    const h = harness({ tasks: [task] });
    await h.emit('task.blocked', task.id);
    await h.emit('task.blocked', task.id);
    expect(h.events.filter((event) => event.type === 'tracker.review_requested')).toHaveLength(1);
    await h.emit('task.merged', task.id, { mergeCommit: 'abc' });
    expect(h.events.some((event) => event.type === 'tracker.resolved')).toBe(true);
    h.cleanup();
  });

  it('retries a temporary OpenProject failure', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response('{}', { status: calls === 1 ? 503 : 200 }); }) as typeof fetch;
    const h = harness({ tasks: [done('app/fix', 'app')], fetchFn });
    await h.emit('task.merged', 'app/fix', { mergeCommit: 'abc' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBeGreaterThanOrEqual(2);
    h.cleanup();
  });

  it('creates only a hub linked task and reports an invalid target project', async () => {
    const task = { ...done('app/fix', 'app'), doneReport: '## Cần sửa ở project web\nNội dung cần sửa.' };
    const h = harness({ tasks: [task], targetProject: 'web' });
    await h.emit('task.done', task.id);
    expect(h.created).toHaveLength(1);
    expect((h.created[0] as any).externalRef).toBe('OP-1');
    expect((h.created[0] as any).dependsOn).toEqual([task.id]);
    h.cleanup();
    const invalid = harness({ tasks: [task] });
    await invalid.emit('task.done', task.id);
    expect(invalid.created).toHaveLength(0);
    const failure = invalid.events.find((event) => event.type === 'tracker.writeback_failed');
    expect(failure?.taskId).toBeUndefined();
    expect(failure?.payload.error).toContain('không hợp lệ');
    invalid.cleanup();
  });
});
