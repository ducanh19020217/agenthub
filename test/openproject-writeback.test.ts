import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenProjectWritebackService } from '../src/integrations/openproject/writeback.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';

describe('OpenProjectWritebackService', () => {
  it('comments and resolves once after a merged task without push configuration', async () => {
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-writeback-'));
    saveOpenProjectKey(hubHome, 'op', 'key');
    const task = {
      id: 'app/fix', projectId: 'app', slug: 'fix', title: 'Fix', externalRef: 'OP-1',
      doneReport: '## Comment cho tester\nĐã sửa xong.', blockedReport: null, status: 'done',
    } as never;
    const row = {
      source_id: 'op', wp_id: 10, display_id: 'OP-1', status_id: 1, updated_at: '', last_comment_id: null,
      task_ids: JSON.stringify([task.id]), writeback: '{}', created_at: '',
    } as never;
    const events: Array<{ type: string; payload?: unknown }> = [];
    let listener: ((type: string, taskId?: string, payload?: unknown) => void) | undefined;
    const bus = {
      on: (_event: string, handler: typeof listener) => { listener = handler; },
      off: () => undefined,
      emit: (type: string, _taskId?: string, payload?: unknown) => { events.push({ type, payload }); return true; },
    };
    let upserts = 0;
    const trackerRepo = {
      listAll: () => [row],
      upsert: (next: typeof row) => { Object.assign(row, next); upserts++; return row; },
    };
    const fetchFn = async (_url: string | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ id: 11, lockVersion: 1 }), { status: 200 });
    };
    const service = new OpenProjectWritebackService({
      config: { hubHome, integrations: { openproject: { sources: [{ id: 'op', url: 'https://op.test', project: 'main', autoResolve: true, resolvedStatusId: 5, reviewStatusId: 6, watchStatusIds: [], reopenedStatusIds: [], openStatusIds: [], minTicketNumber: 0, pollIntervalSec: 60, autoStart: true, language: 'vi' }] } }, deploy: {} } as never,
      projectRepo: { get: (id: string) => id === 'app' ? { id, path: hubHome, settings: JSON.stringify({ openproject: { enabled: true, sourceId: 'op', role: 'primary' } }) } : undefined } as never,
      taskRepo: { get: (id: string) => id === task.id ? task : undefined } as never,
      trackerRepo: trackerRepo as never,
      taskService: { createTask: () => ({ id: 'unused' }) },
      eventBus: bus,
      fetchFn: fetchFn as typeof fetch,
      timerMs: 10,
    });
    service.start();
    listener?.('task.merged', task.id, { mergeCommit: 'abc' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    listener?.('task.merged', task.id, { mergeCommit: 'abc' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((event) => event.type === 'tracker.resolved')).toHaveLength(1);
    expect(upserts).toBeGreaterThan(0);
    service.stop();
    fs.rmSync(hubHome, { recursive: true, force: true });
  });
});
