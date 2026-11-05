import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNewGitProject, inspectProject } from '../src/projects/inspect.js';
import { inspectGitProject } from '../src/projects/git.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-inspect-')); dirs.push(dir); return dir; }

describe('project wizard inspection', () => {
  it('reports git branches, sanitized origin, dirty files and ahead/behind asynchronously', async () => {
    const dir = tempDir();
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', dir, 'checkout', '-qb', 'main']);
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one');
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial']);
    execFileSync('git', ['-C', dir, 'branch', 'dev']);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://user:password@example.com/team/repo.git']);
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted');

    const result = await inspectGitProject(dir, 'main');
    expect(result.localBranches).toEqual(expect.arrayContaining([result.currentBranch as string, 'dev']));
    expect(result.remoteBranches).toEqual(expect.arrayContaining(['main', 'dev']));
    expect(result.remote).toBe('https://example.com/team/repo.git');
    expect(result.dirty).toEqual({ changed: true, files: 1 });
    expect(result.aheadBehind).toEqual({ ahead: 0, behind: 0 });
  });

  it('reports git, monorepo, hooks, lockfile and guidance metadata without reading secrets', () => {
    const dir = tempDir();
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'integration']);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' }, workspaces: ['packages/*'] }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    fs.writeFileSync(path.join(dir, 'nx.json'), '{}');
    fs.mkdirSync(path.join(dir, '.husky'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'rules');
    const result = inspectProject(dir, tempDir());
    expect(result.isGitRepo).toBe(true);
    expect(result.currentBranch).toBe('integration');
    expect(result.lockfiles).toContain('pnpm-lock.yaml');
    expect(result.monorepo).toEqual({ detected: true, type: 'nx' });
    expect(result.gitHooks.husky).toBe(true);
    expect(result.guidanceFiles).toContain('AGENTS.md');
    expect(result.suggestedSettings.skipInstall).toBe(true);
    expect(result.suggestedSettings.checks[0].cmd).toEqual(['npm', 'run', 'lint']);
  });

  it('creates a new project with the requested branch and empty initial commit', () => {
    const parent = tempDir();
    const dir = path.join(parent, 'new project');
    createNewGitProject(dir, 'integration');
    expect(inspectProject(dir, tempDir()).currentBranch).toBe('integration');
    expect(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1');
  });

  it('rejects an invalid default branch before creating the directory', () => {
    const parent = tempDir();
    const dir = path.join(parent, 'invalid');
    expect(() => createNewGitProject(dir, '-bad')).toThrow(/không hợp lệ/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('stops size inspection at the entry limit', () => {
    const dir = tempDir();
    for (let i = 0; i < 20_005; i += 1) fs.writeFileSync(path.join(dir, `file-${i}`), 'x');
    const result = inspectProject(dir, tempDir());
    expect(result.sizeTruncated).toBe(true);
  });

  it('returns safe session metadata and a bounded memory preview', () => {
    const dir = tempDir();
    const home = tempDir();
    const encoded = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeDir = path.join(home, '.claude', 'projects', encoded);
    fs.mkdirSync(path.join(claudeDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'session.jsonl'), '{"secret":"should not be returned"}\n');
    fs.writeFileSync(path.join(claudeDir, 'memory', 'MEMORY.md'), '# remembered\nUse the project conventions.');

    const result = inspectProject(dir, home);
    expect(result.claudeSessions).toHaveLength(1);
    expect(result.claudeSessions[0]).toMatchObject({ name: 'session.jsonl', sizeBytes: expect.any(Number) });
    expect(result.claudeSessions[0]).not.toHaveProperty('path');
    expect(result.memoryPreview).toContain('Use the project conventions.');
    expect(result.memoryPreview).not.toContain('secret');
  });
});

describe('project inspection and creation at service level', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = tempDir();
    process.env.AGENTHUB_HOME = tmpDir;
    previousHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    const config = loadConfig(tmpDir);
    config.port = 0;
    const engines = new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();
  });

  afterEach(() => {
    ctx.scheduler.stop();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  it('rejects relative path on inspectProject via service', () => {
    expect(() => ctx.service.inspectProject({ path: 'relative/dir' })).toThrow(/đường dẫn tuyệt đối/);
  });

  it('rejects relative path on createNewProject via service', () => {
    expect(() => ctx.service.createNewProject({ name: 'New', path: 'relative/dir' })).toThrow(/đường dẫn tuyệt đối/);
  });

  it('rejects an invalid default branch starting with dash on createNewProject via service', () => {
    const target = path.join(tmpDir, 'repo-dash');
    expect(() => ctx.service.createNewProject({ name: 'New', path: target, defaultBranch: '-bad' })).toThrow(/không hợp lệ/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rejects non-existent parent directory on createNewProject via service', () => {
    const target = path.join(tmpDir, 'does-not-exist', 'repo');
    expect(() => ctx.service.createNewProject({ name: 'New', path: target, defaultBranch: 'main' })).toThrow(/Thư mục cha không tồn tại/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('creates a tracking task and waits for the worker result before exposing a summary', async () => {
    const target = path.join(tmpDir, 'valid-repo');
    const created = ctx.service.createNewProject({ name: 'Summary Project', path: target, defaultBranch: 'main' });
    const sessionDir = path.join(process.env.HOME as string, '.claude', 'projects', target.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session-old.jsonl'), JSON.stringify({ message: { role: 'assistant', content: 'Keep the project conventions.' } }) + '\n');
    const result = ctx.service.summarizeProjectContext(created.id, { sessions: ['session-old.jsonl'] });
    expect(result.taskId).toBeTruthy();
    expect(['queued', 'waiting_quota']).toContain(result.status);
    expect(result.summary).toBeNull();
    expect(await ctx.service.getProjectContextSummary(created.id, result.taskId)).toMatchObject({
      taskId: result.taskId,
      status: result.status,
      summary: null,
    });
  });

  it('rejects summarizeProjectContext for non-existent project', () => {
    expect(() => ctx.service.summarizeProjectContext('not-found', { sessions: ['s.jsonl'] })).toThrow(/không tồn tại/);
  });

  it('rejects summarizeProjectContext for invalid or missing session file', () => {
    const target = path.join(tmpDir, 'repo-invalid-session');
    const created = ctx.service.createNewProject({ name: 'Invalid Session Project', path: target, defaultBranch: 'main' });
    expect(() => ctx.service.summarizeProjectContext(created.id, { sessions: ['non-existent.jsonl'] })).toThrow(/không hợp lệ hoặc không còn tồn tại/);
    expect(() => ctx.service.summarizeProjectContext(created.id, { sessions: ['bad-format.txt'] })).toThrow(/không hợp lệ hoặc không còn tồn tại/);
  });

  it('supports retry on summarizeProjectContext without 409 conflict and resets failed task', async () => {
    const target = path.join(tmpDir, 'repo-retry');
    const created = ctx.service.createNewProject({ name: 'Retry Project', path: target, defaultBranch: 'main' });
    const sessionDir = path.join(process.env.HOME as string, '.claude', 'projects', target.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'sess-1.jsonl'), JSON.stringify({ message: { role: 'assistant', content: 'Some knowledge' } }) + '\n');

    const first = ctx.service.summarizeProjectContext(created.id, { sessions: ['sess-1.jsonl'] });
    expect(first.taskId).toBeTruthy();

    // Mark task as failed with blockedContent containing a stack trace
    ctx.taskRepo.update(first.taskId, {
      status: 'failed',
    });
    ctx.taskRepo.updateStatus(first.taskId, 'failed');

    // Calling summarizeProjectContext again (retry) should NOT throw 409 conflict
    const second = ctx.service.summarizeProjectContext(created.id, { sessions: ['sess-1.jsonl'], notes: 'Retried note' });
    expect(second.taskId).toBe(first.taskId);
    expect(['queued', 'waiting_quota']).toContain(second.status);

    const taskAfter = ctx.taskRepo.get(first.taskId);
    expect(taskAfter?.body).toContain('Retried note');
  });

  it('getProjectContextSummary reports waiting_quota when engine has no quota', async () => {
    const target = path.join(tmpDir, 'repo-quota');
    const created = ctx.service.createNewProject({ name: 'Quota Project', path: target, defaultBranch: 'main' });
    const sessionDir = path.join(process.env.HOME as string, '.claude', 'projects', target.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'sess-q.jsonl'), JSON.stringify({ message: { role: 'assistant', content: 'Quota knowledge' } }) + '\n');

    const result = ctx.service.summarizeProjectContext(created.id, { sessions: ['sess-q.jsonl'] });
    ctx.taskRepo.updateStatus(result.taskId, 'waiting_quota', 'quota');

    const summaryStatus = await ctx.service.getProjectContextSummary(created.id, result.taskId);
    expect(summaryStatus.status).toBe('waiting_quota');
    expect(summaryStatus.waitReason).toBe('quota');
    expect(summaryStatus.error).toContain('Chưa có engine khả dụng hoặc đang hết quota');
  });

  it('getProjectContextSummary sanitizes error stack traces on failed task', async () => {
    const target = path.join(tmpDir, 'repo-failed');
    const created = ctx.service.createNewProject({ name: 'Failed Project', path: target, defaultBranch: 'main' });
    const sessionDir = path.join(process.env.HOME as string, '.claude', 'projects', target.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'sess-f.jsonl'), JSON.stringify({ message: { role: 'assistant', content: 'Fail knowledge' } }) + '\n');

    const result = ctx.service.summarizeProjectContext(created.id, { sessions: ['sess-f.jsonl'] });
    const taskWorktree = path.join(tmpDir, 'worktree-failed');
    fs.mkdirSync(path.join(taskWorktree, '.agenthub'), { recursive: true });
    fs.writeFileSync(
      path.join(taskWorktree, '.agenthub', 'BLOCKED'),
      'Error: Claude engine timed out\n    at WorkerProcess.exec (/src/worker.ts:42:15)\n    at processTicksAndRejections',
    );
    ctx.taskRepo.update(result.taskId, {
      status: 'failed',
      worktreePath: taskWorktree,
    });

    const summaryStatus = await ctx.service.getProjectContextSummary(created.id, result.taskId);
    expect(summaryStatus.status).toBe('failed');
    expect(summaryStatus.error).toBe('Claude engine timed out');
    expect(summaryStatus.error).not.toContain('at WorkerProcess');
  });

  it('getProjectContextSummary returns summary when task is done', async () => {
    const target = path.join(tmpDir, 'repo-done');
    const created = ctx.service.createNewProject({ name: 'Done Project', path: target, defaultBranch: 'main' });
    const sessionDir = path.join(process.env.HOME as string, '.claude', 'projects', target.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'sess-d.jsonl'), JSON.stringify({ message: { role: 'assistant', content: 'Done knowledge' } }) + '\n');

    const result = ctx.service.summarizeProjectContext(created.id, { sessions: ['sess-d.jsonl'] });
    ctx.taskRepo.update(result.taskId, {
      status: 'done',
      doneReport: '# Durable Knowledge\n- Rule 1: Always test\n- Rule 2: Keep API clean',
    });

    const summaryStatus = await ctx.service.getProjectContextSummary(created.id, result.taskId);
    expect(summaryStatus.status).toBe('done');
    expect(summaryStatus.summary).toContain('# Durable Knowledge');

    // Also calling summarizeProjectContext again returns the existing summary immediately
    const recheck = ctx.service.summarizeProjectContext(created.id, { sessions: ['sess-d.jsonl'] });
    expect(recheck.status).toBe('done');
    expect(recheck.summary).toContain('# Durable Knowledge');
  });
});
