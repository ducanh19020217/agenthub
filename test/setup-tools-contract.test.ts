import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SetupTools } from '../src/setup-tools.js';

const tempDirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-tools-'));
  tempDirs.push(home);
  const db = new Database(':memory:');
  const config = loadConfig(home);
  config.port = 7700;
  const events: Array<{ type: string; payload: unknown }> = [];
  const service = {
    getEffectiveConfig: vi.fn(() => ({ brain: {} })), getPresets: vi.fn(() => []), listDepartments: vi.fn(() => []),
    getDepartment: vi.fn(), createDepartment: vi.fn(), updateDepartment: vi.fn(), updateDepartmentProjects: vi.fn(),
    applyPreset: vi.fn(({ dryRun }: { dryRun: boolean }) => ({ applied: !dryRun, diff: { before: { old: true }, after: { old: false } } })),
    getProject: vi.fn(() => ({ path: home, defaultBranch: 'main', settings: JSON.stringify({ brain: { mode: 'inherit' }, review: { autoMerge: false } }), checks: JSON.stringify([]), reviewChain: JSON.stringify([]) })),
    updateProject: vi.fn((_, input) => ({ ...input, settings: { ...input.settings }, checks: input.checks || [], reviewChain: input.reviewChain || [] })),
    getConfig: vi.fn(() => ({ brain: { mode: 'auto', model: 'sonnet' }, notifications: { desktop: true } })),
    updateConfig: vi.fn((input) => input),
  };
  const tools = new SetupTools(config, db, { emit: (type, _task, payload) => { events.push({ type, payload }); return true; } } as never, () => service);
  return { db, config, service, tools, events };
}

describe('setup MCP tool contracts', () => {
  it('uses the real preset diff in dry-run and merges nested project settings/checks', () => {
    const { tools, service } = fixture();
    expect(tools.applyPreset({ scope: 'project:p', preset: 'safe' })).toMatchObject({ dryRun: true, diff: { before: { old: true } } });
    const preview = tools.projectSettings('p', { brain: { mode: 'auto' }, reviewChain: [{ reviewer: 'codex' }], checks: [{ name: 'test', cmd: ['npm', 'test'] }] });
    expect(preview.diff.changed).toBe(true);
    expect((preview.diff.after as { settings: { brain: { mode: string }; review: { autoMerge: boolean } } }).settings).toMatchObject({ brain: { mode: 'auto' }, review: { autoMerge: false } });
    expect(service.updateProject).not.toHaveBeenCalled();
  });

  it('only allows explicit non-secret config keys and returns a meaningful nested diff', () => {
    const { tools, service } = fixture();
    expect(tools.configSet('notifications.desktop', false).diff).toMatchObject({ changed: true, after: { brain: { mode: 'auto', model: 'sonnet' }, notifications: { desktop: false } } });
    expect(() => tools.configSet('notifications.telegram.botToken', 'secret')).toThrow();
    expect(() => tools.configSet('scheduler.secret', 'secret')).toThrow();
    expect(service.updateConfig).not.toHaveBeenCalled();
  });

  it('waits for secret configuration and never places the value in event or result', async () => {
    const { tools, db, events } = fixture();
    const pending = tools.requestSecret({ kind: 'gitea-token', target: 'repo', label: 'Gitea' });
    const request = db.prepare('SELECT id FROM secret_requests').get() as { id: string };
    expect(events[0].payload).not.toHaveProperty('value');
    const result = tools.saveSecret(request.id, 'super-secret');
    expect(result).toEqual({ configured: true });
    await expect(pending).resolves.toEqual({ configured: true });
    expect(JSON.stringify(events)).not.toContain('super-secret');
  });

  it('discovers checks and gitea safely with required project', async () => {
    const { tools } = fixture();
    await expect(tools.discover('checks', {})).rejects.toThrow('Project là bắt buộc');
    await expect(tools.discover('gitea', { project: 'p' })).rejects.toThrow('remote origin');
  });

  it('discovers OpenProject through the client and scores closed/open status mappings', async () => {
    const { tools, config } = fixture();
    config.integrations.openproject.sources = [{ id: 'op', url: 'https://op.test' }];
    fs.mkdirSync(path.join(config.hubHome, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(config.hubHome, 'secrets', 'openproject-op.key'), 'stored-key\n');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes('/users/me') ? { id: 1, name: 'Tester' }
        : url.includes('/projects') ? { _embedded: { elements: [{ id: 7, identifier: 'demo' }] } }
          : { _embedded: { elements: [{ id: 1, name: 'New', isClosed: false }, { id: 2, name: 'Done', isClosed: true }] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const result = await tools.discover('openproject', { sourceId: 'op' }) as { suggestions: { watch: Array<{ id: number; confidence: number }>; resolved: Array<{ id: number; confidence: number }> } };
      expect(result.suggestions.watch).toEqual(expect.arrayContaining([expect.objectContaining({ id: 1, confidence: 1 })]));
      expect(result.suggestions.resolved).toEqual(expect.arrayContaining([expect.objectContaining({ id: 2, confidence: 1 })]));
    } finally {
      fetcher.mockRestore();
    }
  });
});
