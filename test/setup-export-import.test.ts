import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SetupTools } from '../src/setup-tools.js';

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-bundle-'));
  tempDirs.push(home);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT, path TEXT, defaultBranch TEXT, envTemplate TEXT,
    settings TEXT, departmentId TEXT, archivedAt INTEGER
  );
  CREATE TABLE departments (
    id TEXT PRIMARY KEY, name TEXT, priority INTEGER, maxParallel INTEGER,
    claudeDailyTokenBudget INTEGER, brainEngine TEXT, brainModel TEXT,
    brainCodexProfile TEXT, brainMode TEXT, brainPermissions TEXT,
    brainDailyTokenBudget INTEGER, brainMaxTurnsPerHour INTEGER
  )`);
  db.prepare('INSERT INTO projects (id,name,path,defaultBranch,envTemplate,settings) VALUES (?,?,?,?,?,?)')
    .run('demo', 'Demo', repo, 'main', JSON.stringify({ TOKEN: 'should-not-export' }), JSON.stringify({
      preset: 'balanced', brain: { dailyTokenBudget: 12000, maxTokens: 24000 },
      gitea: { enabled: true, url: 'https://gitea.test/api/v1' },
      remoteDeploy: { enabled: true, steps: [['npm', 'run', 'deploy']] },
    }));
  db.prepare('INSERT INTO departments (id,name,priority,maxParallel,claudeDailyTokenBudget,brainDailyTokenBudget,brainMaxTurnsPerHour) VALUES (?,?,?,?,?,?,?)')
    .run('eng', 'Engineering', 1, 2, 30000, 40000, 20);
  const config = loadConfig(home);
  config.integrations.openproject.sources = [{ id: 'op', url: 'https://openproject.test', project: 'demo' }];
  const service = {
    getEffectiveConfig: vi.fn(() => ({})), getPresets: vi.fn(() => []), listDepartments: vi.fn(() => []),
    getDepartment: vi.fn(), createDepartment: vi.fn(), updateDepartment: vi.fn(), updateDepartmentProjects: vi.fn(),
    applyPreset: vi.fn(), getProject: vi.fn((id: string) => ({ id, path: repo, settings: JSON.stringify({ brain: { mode: 'auto' } }) })),
    updateProject: vi.fn(), getConfig: vi.fn(() => ({ integrations: config.integrations, deploy: config.deploy, brain: {}, reviewer: {} })), updateConfig: vi.fn(),
  };
  const tools = new SetupTools(config, db, { emit: () => true } as never, () => service);
  return { home, repo, db, tools, service };
}

describe('setup export/import bundle', () => {
  it('exports non-secret integrations and never exports secret-looking values', () => {
    const { tools } = fixture();
    const bundle = tools.exportSetup();
    const serialized = JSON.stringify(bundle);
    expect(bundle.integrations).toMatchObject({ openproject: { sources: [{ url: 'https://openproject.test' }] } });
    expect(serialized).toContain('https://gitea.test/api/v1');
    expect(bundle.projects[0]).toMatchObject({ settings: expect.anything() });
    expect(JSON.parse(bundle.projects[0].settings as string).brain).toEqual({ dailyTokenBudget: 12000, maxTokens: 24000 });
    expect(bundle.departments[0]).toMatchObject({ claudeDailyTokenBudget: 30000, brainDailyTokenBudget: 40000 });
    expect(serialized).not.toContain('should-not-export');
    const secretKeys: string[] = [];
    const collectKeys = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(collectKeys);
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:token|password|secret|credential|api[-_]?key|private[-_]?key|(?:api|access|auth)Token)$/i.test(key)) secretKeys.push(key);
        collectKeys(item);
      }
    };
    collectKeys(bundle);
    expect(secretKeys).toEqual([]);
    expect(serialized).not.toMatch(/\/home\/[^" ]+/);
  });

  it('round-trips an exported bundle through import dry-run with a settings diff', () => {
    const { tools } = fixture();
    const bundle = tools.exportSetup();
    const result = tools.importSetup(bundle, true);
    expect(result).toMatchObject({ dryRun: true, schemaVersion: 1, projects: [{ id: 'demo', status: 'present' }] });
    expect(result.diffs).toEqual([expect.objectContaining({ id: 'demo', diff: expect.any(Object) })]);
  });

  it('reports only secrets actually missing and projects that need cloning', () => {
    const { tools, db, home } = fixture();
    fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(home, 'secrets', 'gitea-demo.token'), 'configured\n');
    const result = tools.importSetup({ schemaVersion: 1, projects: [
      { id: 'demo', name: 'Demo', settings: { gitea: { enabled: true }, remoteDeploy: { enabled: true } } },
      { id: 'new-repo', name: 'New', remoteGit: 'https://git.test/new.git', settings: { gitea: { enabled: true } } },
    ] }, true);
    expect(result.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'demo', status: 'present' }),
      expect.objectContaining({ id: 'new-repo', needsClone: true, status: 'needs_clone' }),
    ]));
    expect(result.missingSecrets).toEqual(expect.arrayContaining(['deploy-env:demo', 'gitea-token:new-repo']));
    expect(result.missingSecrets).not.toContain('gitea-token:demo');
    expect(db).toBeTruthy();
  });
});
