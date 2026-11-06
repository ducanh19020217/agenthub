import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';

function initGitRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# project\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], {
    cwd: repoPath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
}

describe('project archive and purge', () => {
  let root: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: ReturnType<typeof createServer>;
  let token: string;

  const headers = () => ({ host: '127.0.0.1', authorization: `Bearer ${token}` });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-project-delete-'));
    process.env.AGENTHUB_HOME = root;
    config = loadConfig(root);
    config.port = 0;
    token = getOrCreateToken(config.tokenPath);
    const fake = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    ctx = createContext(config, new Map<string, Engine>([['agy', fake]]));
    ctx.scheduler.stop();
    server = await createServer(ctx.service, config, { webDir: path.join(root, 'web') });
    await server.ready();
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    delete process.env.AGENTHUB_HOME;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('archives safely, pauses queued work, restores original statuses, and re-registers by path', async () => {
    const repo = path.join(root, 'repo');
    initGitRepo(repo);
    ctx.projectRepo.insert({ id: 'archive-me', name: 'Archive Me', path: repo, defaultBranch: 'main', maxParallel: 2 });
    ctx.taskRepo.insert({ id: 'archive-me/queued', projectId: 'archive-me', slug: 'queued', title: 'Queued', status: 'queued' });
    ctx.taskRepo.insert({ id: 'archive-me/review', projectId: 'archive-me', slug: 'review', title: 'Review', status: 'review' });

    const archived = await server.inject({ method: 'DELETE', url: '/api/projects/archive-me', headers: headers() });
    expect(archived.statusCode).toBe(200);
    expect(ctx.projectRepo.get('archive-me')).toBeUndefined();
    expect(ctx.projectRepo.getIncludingArchived('archive-me')?.archivedAt).toBeTruthy();
    expect(ctx.taskRepo.get('archive-me/queued')?.status).toBe('paused');
    expect(ctx.taskRepo.get('archive-me/review')?.status).toBe('paused');
    expect(ctx.taskNoteRepo.getByProject('archive-me')).toHaveLength(2);
    expect((await server.inject({ method: 'GET', url: '/api/tasks/archive-me~queued', headers: headers() })).statusCode).toBe(200);
    ctx.profileRepo.upsert({ name: 'archive-worker', engine: 'agy', kind: 'isolated', home: root, email: null, enabled: 1 });
    ctx.taskRepo.update('archive-me/queued', { status: 'queued' });
    ctx.scheduler.start();
    expect(ctx.scheduler.getRunning().has('archive-me/queued')).toBe(false);
    expect(ctx.taskRepo.get('archive-me/queued')?.status).toBe('queued');
    ctx.scheduler.stop();
    expect(JSON.parse((await server.inject({ method: 'GET', url: '/api/projects', headers: headers() })).body)).toEqual([]);
    expect(JSON.parse((await server.inject({ method: 'GET', url: '/api/projects/archive-me', headers: headers() })).body).error).toBe('not_found');

    const restored = await server.inject({ method: 'POST', url: '/api/projects/archive-me/restore', headers: headers() });
    expect(restored.statusCode).toBe(200);
    expect(ctx.projectRepo.get('archive-me')).toBeDefined();
    expect(ctx.taskRepo.get('archive-me/queued')?.status).toBe('queued');
    expect(ctx.taskRepo.get('archive-me/review')?.status).toBe('review');

    await server.inject({ method: 'DELETE', url: '/api/projects/archive-me', headers: headers() });
    const reRegistered = ctx.service.createProject({ name: 'Archive Again', id: 'new-id', path: repo, defaultBranch: 'main' });
    expect(reRegistered.id).toBe('archive-me');
    expect(ctx.projectRepo.get('archive-me')?.name).toBe('Archive Again');
  });

  it('requires exact purge confirmation and purges dependent data without touching the user repo', async () => {
    const repo = path.join(root, 'repo');
    initGitRepo(repo);
    const otherRepo = path.join(root, 'other-repo');
    initGitRepo(otherRepo);
    ctx.projectRepo.insert({ id: 'purge-me', name: 'Purge Me', path: repo, defaultBranch: 'main', maxParallel: 2 });
    ctx.projectRepo.insert({ id: 'other', name: 'Other', path: otherRepo, defaultBranch: 'main', maxParallel: 2 });
    const cleanWorktree = path.join(config.worktreesDir, 'purge-me', 'clean');
    const dirtyWorktree = path.join(config.worktreesDir, 'purge-me', 'dirty');
    fs.mkdirSync(path.dirname(cleanWorktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', cleanWorktree, 'main'], { cwd: repo });
    execFileSync('git', ['worktree', 'add', '--detach', dirtyWorktree, 'main'], { cwd: repo });
    fs.writeFileSync(path.join(dirtyWorktree, 'uncommitted.txt'), 'keep me\n');
    ctx.taskRepo.insert({ id: 'purge-me/clean', projectId: 'purge-me', slug: 'clean', title: 'Clean', status: 'done', worktreePath: cleanWorktree });
    ctx.taskRepo.insert({ id: 'purge-me/dirty', projectId: 'purge-me', slug: 'dirty', title: 'Dirty', status: 'done', worktreePath: dirtyWorktree });
    ctx.taskRepo.insert({ id: 'other/task', projectId: 'other', slug: 'task', title: 'Other', status: 'done' });
    ctx.db.prepare('INSERT INTO task_deps (taskId, dependsOnId) VALUES (?, ?), (?, ?)').run('purge-me/clean', 'other/task', 'other/task', 'purge-me/dirty');
    ctx.db.prepare("INSERT INTO runs (id, taskId, engine, model, profileName, outcome) VALUES ('run-purge', 'purge-me/clean', 'agy', 'gemini-3.8-flash-low', 'p', 'done')").run();
    ctx.db.prepare("INSERT INTO reviews (id, taskId, verdict, feedback) VALUES ('review-purge', 'purge-me/clean', 'approved', 'ok')").run();
    ctx.db.prepare("INSERT INTO check_results (taskId, runId, name, ok, durationMs, outputTail) VALUES ('purge-me/clean', 'run-purge', 'lint', 1, 1, '')").run();
    ctx.db.prepare("INSERT INTO run_metrics (runId, taskId, engine, model, profileName) VALUES ('run-purge', 'purge-me/clean', 'agy', 'gemini-3.8-flash-low', 'p')").run();
    ctx.db.prepare("INSERT INTO claude_task_usage (taskId, sessionId, turnId, effectiveTokens) VALUES ('purge-me/clean', 's', 't', 1)").run();
    ctx.db.prepare("INSERT INTO task_notes (projectId, taskId, kind, content) VALUES ('purge-me', 'purge-me/clean', 'note', 'note')").run();
    ctx.db.prepare("INSERT INTO knowledge_entries (projectId, taskId, content) VALUES ('purge-me', 'purge-me/clean', 'knowledge')").run();
    ctx.db.prepare("INSERT INTO task_batches (id, projectId, title) VALUES ('batch-purge', 'purge-me', 'batch')").run();
    ctx.db.prepare("INSERT INTO chat_sessions (id, projectId, title) VALUES ('session-purge', 'purge-me', 'chat')").run();
    ctx.db.prepare("INSERT INTO chat_messages (id, sessionId, role, content) VALUES ('message-purge', 'session-purge', 'user', 'hello')").run();
    ctx.db.prepare("INSERT INTO chat_permissions (id, sessionId, toolName, input, status) VALUES ('permission-purge', 'session-purge', 'tool', '{}', 'pending')").run();
    ctx.db.prepare("INSERT INTO chat_retries (sessionId, messageId, text, resetAt, status) VALUES ('session-purge', 'retry-purge', 'retry', 1, 'pending')").run();
    ctx.db.prepare("INSERT INTO permission_rules (id, scope, projectId, sessionId, toolName, pattern, createdBy) VALUES ('rule-purge', 'project', 'purge-me', 'session-purge', 'tool', '*', 'test')").run();
    ctx.db.prepare("INSERT INTO ci_runs (projectId, runId, workflow, sha, status) VALUES ('purge-me', 1, 'ci', 'sha', 'completed')").run();
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, status, projectId) VALUES ('turn-purge', 'test', 'input', 'done', 'purge-me')").run();
    ctx.db.prepare("INSERT INTO brain_directives (id, projectId, text, createdBy) VALUES ('directive-purge', 'purge-me', 'directive', 'test')").run();
    fs.mkdirSync(path.join(config.logsDir, 'purge-me', 'clean'), { recursive: true });
    fs.writeFileSync(path.join(config.logsDir, 'purge-me', 'clean', 'run.log'), 'log');
    fs.writeFileSync(path.join(repo, 'user-file.txt'), 'must remain\n');

    for (const url of ['/api/projects/purge-me?purge=true', '/api/projects/purge-me?purge=true&confirm=wrong']) {
      const response = await server.inject({ method: 'DELETE', url, headers: headers() });
      expect(response.statusCode).toBe(400);
    }
    const response = await server.inject({ method: 'DELETE', url: '/api/projects/purge-me?purge=true&confirm=purge-me', headers: headers() });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { counts: Record<string, number>; warnings?: string[] };
    expect(body.counts.tasks).toBe(2);
    expect(body.counts.runs).toBe(1);
    expect(body.counts.chatSessions).toBe(1);
    expect(body.warnings?.some((warning) => warning.includes('chưa commit'))).toBe(true);
    expect(fs.existsSync(cleanWorktree)).toBe(false);
    expect(fs.existsSync(dirtyWorktree)).toBe(true);
    expect(fs.existsSync(path.join(repo, 'user-file.txt'))).toBe(true);
    expect(ctx.projectRepo.getIncludingArchived('purge-me')).toBeUndefined();
    const count = (sql: string, ...params: string[]) => (ctx.db.prepare(sql).get(...params) as { count: number }).count;
    expect(count('SELECT COUNT(*) AS count FROM tasks WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM runs WHERE taskId LIKE ?', 'purge-me/%')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM reviews WHERE taskId LIKE ?', 'purge-me/%')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM check_results WHERE taskId LIKE ?', 'purge-me/%')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM run_metrics WHERE taskId LIKE ?', 'purge-me/%')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM claude_task_usage WHERE taskId LIKE ?', 'purge-me/%')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM task_notes WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM knowledge_entries WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM task_batches WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM chat_sessions WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM chat_messages WHERE sessionId = ?', 'session-purge')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM chat_permissions WHERE sessionId = ?', 'session-purge')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM chat_retries WHERE sessionId = ?', 'session-purge')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM permission_rules WHERE projectId = ? OR sessionId = ?', 'purge-me', 'session-purge')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM ci_runs WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM brain_turns WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM brain_directives WHERE projectId = ?', 'purge-me')).toBe(0);
    expect(count('SELECT COUNT(*) AS count FROM task_deps WHERE taskId LIKE ? OR dependsOnId LIKE ?', 'purge-me/%', 'purge-me/%')).toBe(0);
  });

  it('rejects archive and purge while a checking task exists', async () => {
    const repo = path.join(root, 'repo-running');
    initGitRepo(repo);
    ctx.projectRepo.insert({ id: 'busy', name: 'Busy', path: repo, defaultBranch: 'main', maxParallel: 1 });
    ctx.taskRepo.insert({ id: 'busy/checking', projectId: 'busy', slug: 'checking', title: 'Checking', status: 'checking' });
    const response = await server.inject({ method: 'DELETE', url: '/api/projects/busy?purge=true&confirm=busy', headers: headers() });
    expect(response.statusCode).toBe(409);
    expect(ctx.projectRepo.get('busy')).toBeDefined();
  });

  it('allows purging an already archived project', async () => {
    const repo = path.join(root, 'repo-archived-purge');
    initGitRepo(repo);
    ctx.projectRepo.insert({ id: 'archived-then-purged', name: 'Archived Then Purged', path: repo, defaultBranch: 'main', maxParallel: 1 });
    const archiveRes = await server.inject({ method: 'DELETE', url: '/api/projects/archived-then-purged', headers: headers() });
    expect(archiveRes.statusCode).toBe(200);
    expect(ctx.projectRepo.get('archived-then-purged')).toBeUndefined();
    expect(ctx.projectRepo.getIncludingArchived('archived-then-purged')?.archivedAt).toBeTruthy();

    const purgeRes = await server.inject({ method: 'DELETE', url: '/api/projects/archived-then-purged?purge=true&confirm=archived-then-purged', headers: headers() });
    expect(purgeRes.statusCode).toBe(200);
    expect(ctx.projectRepo.getIncludingArchived('archived-then-purged')).toBeUndefined();
  });
});

