import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, closeContext } from '../src/daemon.js';
import { loadConfig, OpenProjectSourceSchema } from '../src/config.js';
import { mergeProjectSettings, DEFAULT_PROJECT_SETTINGS } from '../src/projects/settings.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';

describe('create task with OpenProject ticket', () => {
  let home: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-create-ticket-'));
    config = loadConfig(home);
    config.integrations.openproject.sources = [OpenProjectSourceSchema.parse({
      id: 'demo', url: 'https://op.example.test', project: 'demo', watchStatusIds: [1],
      createTypeId: 3, createStatusId: 1,
    })];
    saveOpenProjectKey(home, 'demo', 'test-key');
    const wp = {
      id: 88, displayId: 'OP-88', subject: 'Create me', updatedAt: '2026-11-04T10:00:00Z', lockVersion: 1,
      description: { raw: 'Body' }, _links: { status: { href: '/api/v3/statuses/1' } },
      status: { title: 'New' }, priority: { title: 'Normal' }, author: { title: 'Me' },
    };
    fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/users/me')) return new Response(JSON.stringify({ id: 7, name: 'Me' }));
      if (init?.method === 'POST' && url.endsWith('/work_packages')) {
        if (String(init.body).includes('Failure')) return new Response(JSON.stringify({ message: 'Subject rejected' }), { status: 422 });
        return new Response(JSON.stringify({ id: 88, displayId: 'OP-88' }), { status: 201 });
      }
      if (url.endsWith('/activities')) return new Response(JSON.stringify({ _embedded: { elements: [] } }));
      if (/\/work_packages\/88$/.test(url)) return new Response(JSON.stringify(wp));
      if (url.includes('/work_packages?')) return new Response(JSON.stringify({ total: 1, _embedded: { elements: [{ id: 88 }] } }));
      throw new Error(`unexpected OpenProject request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    ctx = createContext(config, new Map());
    ctx.scheduler.stop();
    ctx.intakeService.stop();
    ctx.projectRepo.insert({
      id: 'primary', name: 'Primary', path: home, defaultBranch: 'main', envTemplate: null, maxParallel: 1,
      settings: JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
        openproject: { enabled: true, sourceId: 'demo', role: 'primary' },
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeContext(ctx);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates a linked task, records tracker_items, and intake does not duplicate it', async () => {
    const task = await ctx.service.createTaskWithTicket({
      project: 'primary', slug: 'create-me', title: 'Create me', body: 'Body', level: 'easy', createTicket: {},
    });
    expect(task.title).toBe('[OP-88] Create me');
    expect(task.externalRef).toBe('OP-88');
    expect(ctx.trackerRepo.get('demo', 88)?.task_ids).toBe(JSON.stringify([task.id]));

    const sync = await ctx.intakeService.sync('demo');
    expect(sync.imported).toBe(0);
    expect(ctx.taskRepo.list()).toHaveLength(1);
  });

  it('does not create a task when OpenProject rejects the ticket', async () => {
    await expect(ctx.service.createTaskWithTicket({
      project: 'primary', slug: 'failure', title: 'Failure', body: '', level: 'easy', createTicket: {},
    })).rejects.toThrow('Subject rejected');
    expect(ctx.taskRepo.list()).toHaveLength(0);
  });
});
