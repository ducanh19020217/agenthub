import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeEngine: FakeEngine;

function authHeaders() {
  return {
    host: '127.0.0.1:7789',
    authorization: `Bearer ${token}`,
  };
}

function initGitRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial Repo\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'chore: initial commit', '--allow-empty'], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('AgentHub HTTP API Endpoints', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-api-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    const webDir = path.join(tmpDir, 'web');
    fs.mkdirSync(webDir, { recursive: true });
    process.env.AGENTHUB_WEB_DIR = webDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 7789;
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_WEB_DIR;
  });

  // --- Static web fallback ---
  it('GET / returns HTML placeholder when web is not built', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/',
      headers: { host: '127.0.0.1:7789' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('chưa build web');
  });

  it('marks legacy merge unavailable when its base worktree is missing', async () => {
    ctx.projectRepo.insert({
      id: 'legacy-merge',
      name: 'Legacy merge',
      path: '/tmp',
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
      merge: JSON.stringify({ enabled: true, worktrees: {} }),
    });
    ctx.taskRepo.insert({
      id: 'legacy-merge/review-task',
      projectId: 'legacy-merge',
      slug: 'review-task',
      title: 'Review task',
      status: 'review',
      baseRef: 'main',
    });

    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/legacy-merge~review-task',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).mergeAvailable).toBe(false);
  });

  it('serves newly added static assets dynamically without server restart', async () => {
    const webDir = process.env.AGENTHUB_WEB_DIR!;
    const assetsDir = path.join(webDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });

    // File written after server already started
    const newJsFile = path.join(assetsDir, 'new-123.js');
    fs.writeFileSync(newJsFile, 'console.log("new asset loaded");', 'utf-8');

    const res = await server.inject({
      method: 'GET',
      url: '/assets/new-123.js',
      headers: { host: '127.0.0.1:7789' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log("new asset loaded");');
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('serves dynamically created index.html and SPA route fallback after startup', async () => {
    const webDir = process.env.AGENTHUB_WEB_DIR!;

    // 1. Before index.html exists: returns placeholder
    const beforeRes = await server.inject({
      method: 'GET',
      url: '/',
      headers: { host: '127.0.0.1:7789' },
    });
    expect(beforeRes.statusCode).toBe(200);
    expect(beforeRes.body).toContain('chưa build web');

    // 2. Write index.html while server is running
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!DOCTYPE html><html><body>Live Dashboard Build</body></html>', 'utf-8');

    // 3. GET / now serves new index.html
    const afterRes = await server.inject({
      method: 'GET',
      url: '/',
      headers: { host: '127.0.0.1:7789' },
    });
    expect(afterRes.statusCode).toBe(200);
    expect(afterRes.body).toContain('Live Dashboard Build');

    // 4. SPA route with Accept: text/html serves index.html
    const spaRes = await server.inject({
      method: 'GET',
      url: '/tasks/my-task',
      headers: { host: '127.0.0.1:7789', accept: 'text/html,application/xhtml+xml' },
    });
    expect(spaRes.statusCode).toBe(200);
    expect(spaRes.body).toContain('Live Dashboard Build');

    // 5. Non-HTML request for nonexistent file returns 404 JSON
    const notFoundRes = await server.inject({
      method: 'GET',
      url: '/assets/nonexistent.js',
      headers: { host: '127.0.0.1:7789', accept: '*/*' },
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(JSON.parse(notFoundRes.body).error).toBe('not_found');
  });

  it('prevents path traversal when serving static files', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/../package.json',
      headers: { host: '127.0.0.1:7789' },
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('never serves static files from under /api even if files exist in webDir', async () => {
    const webDir = process.env.AGENTHUB_WEB_DIR!;
    const fakeApiDir = path.join(webDir, 'api');
    fs.mkdirSync(fakeApiDir, { recursive: true });
    fs.writeFileSync(path.join(fakeApiDir, 'secret.json'), '{"fake":true}', 'utf-8');

    // Unauthenticated -> 401
    const unauthRes = await server.inject({
      method: 'GET',
      url: '/api/secret.json',
      headers: { host: '127.0.0.1:7789' },
    });
    expect(unauthRes.statusCode).toBe(401);

    // Authenticated -> 404 JSON (not serving static file)
    const authRes = await server.inject({
      method: 'GET',
      url: '/api/secret.json',
      headers: authHeaders(),
    });
    expect(authRes.statusCode).toBe(404);
    expect(JSON.parse(authRes.body).error).toBe('not_found');
  });

  // --- Config API ---
  it('GET and PUT /api/config manages default model chains and timeout', async () => {
    // 1. GET config
    const getRes = await server.inject({
      method: 'GET',
      url: '/api/config',
      headers: authHeaders(),
    });
    expect(getRes.statusCode).toBe(200);
    const initialConfig = JSON.parse(getRes.body);
    expect(initialConfig.modelChainHard).toEqual(['codex:gpt-5.6-luna', 'gemini-3.8-flash-high']);
    expect(initialConfig.modelChainEasy).toEqual(['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna']);
    expect(initialConfig.slotsPerCodexProfile).toBe(2);
    expect(initialConfig.watchdog).toEqual({ stallMinutes: 20, waitingMinutes: 15 });

    // 2. PUT config with invalid model -> 400
    const invalidRes = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: authHeaders(),
      payload: {
        modelChainHard: ['invalid-nonexistent-model'],
      },
    });
    expect(invalidRes.statusCode).toBe(400);

    // 3. PUT config with valid models -> 200
    const validRes = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: authHeaders(),
      payload: {
        modelChainHard: ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-low', 'codex:gpt-5.6-luna'],
        defaultTimeout: 7200,
        slotsPerCodexProfile: 3,
        watchdog: { stallMinutes: 4, waitingMinutes: 2 },
        notifications: { desktop: false },
      },
    });
    expect(validRes.statusCode).toBe(200);
    const updated = JSON.parse(validRes.body);
    expect(updated.modelChainHard).toEqual(['claude-opus-4-6-thinking', 'gemini-3.8-flash-high']);
    expect(updated.defaultTimeout).toBe(7200);
    expect(updated.slotsPerCodexProfile).toBe(3);
    expect(updated.watchdog).toEqual({ stallMinutes: 4, waitingMinutes: 2 });
    expect(updated.notifications).toEqual({ desktop: false, desktopLevel: 'important', quotaLowPct: 20 });

    // 4. Verify in-memory config updated immediately
    expect(config.defaultModelChains.hard).toEqual(['claude-opus-4-6-thinking', 'gemini-3.8-flash-high']);
    expect(config.defaultTimeout).toBe(7200);
    expect(config.notifications).toEqual({ desktop: false, desktopLevel: 'important', quotaLowPct: 20 });

    // 5. Verify saved to config.json
    const diskConfig = JSON.parse(fs.readFileSync(config.configFilePath, 'utf-8'));
    expect(diskConfig.modelChainHard).toEqual(['claude-opus-4-6-thinking', 'gemini-3.8-flash-high']);
    expect(diskConfig.defaultTimeout).toBe(7200);
    expect(diskConfig.notifications).toEqual({ desktop: false });
  });

  // --- Projects API ---
  it('Projects CRUD and rejects deleting project with running tasks (409)', async () => {
    const repoPath = path.join(tmpDir, 'test-repo');
    initGitRepo(repoPath);

    // 1. Create project
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: {
        id: 'proj1',
        name: 'Project One',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 2,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const project = JSON.parse(createRes.body);
    expect(project.id).toBe('proj1');

    // 2. List projects
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: authHeaders(),
    });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.length).toBe(1);

    // 3. Update project
    const updateRes = await server.inject({
      method: 'PATCH',
      url: '/api/projects/proj1',
      headers: authHeaders(),
      payload: {
        maxParallel: 4,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.body).maxParallel).toBe(4);

    // 4. Simulate a running task in this project
    ctx.scheduler.getRunning().set('proj1/task1', {
      runId: 'r1',
      taskId: 'proj1/task1',
      pid: 12345,
      pidStart: null,
      profileName: 'p1',
      model: 'gemini-3.8-flash-high',
      engine: fakeEngine,
      startTime: Date.now(),
      timeoutMs: 10000,
      retryCount: 0,
      projectId: 'proj1',
    });

    // 5. Try deleting project -> 409 Conflict
    const delConflictRes = await server.inject({
      method: 'DELETE',
      url: '/api/projects/proj1',
      headers: authHeaders(),
    });
    expect(delConflictRes.statusCode).toBe(409);

    // 6. Remove running task and delete -> 200
    ctx.scheduler.getRunning().delete('proj1/task1');
    const delRes = await server.inject({
      method: 'DELETE',
      url: '/api/projects/proj1',
      headers: authHeaders(),
    });
    expect(delRes.statusCode).toBe(200);
  });

  it('POST /api/projects validates absolute path, directory existence, git repo and default branch', async () => {
    const validRepoPath = path.join(tmpDir, 'valid-repo');
    initGitRepo(validRepoPath);

    // 1. Relative path -> 400
    const relRes = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: {
        name: 'Rel Proj',
        path: 'relative/path/to/repo',
        defaultBranch: 'main',
      },
    });
    expect(relRes.statusCode).toBe(400);
    expect(JSON.parse(relRes.body).message).toMatch(/tuyệt đối/i);

    // 2. Non-existent path -> 400
    const nonExistRes = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: {
        name: 'Non Exist Proj',
        path: path.join(tmpDir, 'does-not-exist'),
        defaultBranch: 'main',
      },
    });
    expect(nonExistRes.statusCode).toBe(400);
    expect(JSON.parse(nonExistRes.body).message).toMatch(/không tồn tại/i);

    // 3. Not a git repository -> 400
    const notGitPath = path.join(tmpDir, 'not-git-dir');
    fs.mkdirSync(notGitPath, { recursive: true });
    const notGitRes = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: {
        name: 'Not Git Proj',
        path: notGitPath,
        defaultBranch: 'main',
      },
    });
    expect(notGitRes.statusCode).toBe(400);
    expect(JSON.parse(notGitRes.body).message).toMatch(/git repository/i);

    // 4. Default branch does not exist -> 400
    const invalidBranchRes = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: {
        name: 'Invalid Branch Proj',
        path: validRepoPath,
        defaultBranch: 'nonexistent-branch',
      },
    });
    expect(invalidBranchRes.statusCode).toBe(400);
    expect(JSON.parse(invalidBranchRes.body).message).toMatch(/không tồn tại trong repository/i);

    // 5. Valid git repo and branch -> 201
    const validRes = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: {
        name: 'Valid Proj',
        path: validRepoPath,
        defaultBranch: 'main',
      },
    });
    expect(validRes.statusCode).toBe(201);
    expect(JSON.parse(validRes.body).name).toBe('Valid Proj');
  });

  // --- Profiles and Quota API ---
  it('GET /api/profiles does not create any directories when listing profiles', async () => {
    const agyHomesBefore = fs.readdirSync(config.agyHomesDir);
    const res = await server.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const profiles = JSON.parse(res.body);
    expect(Array.isArray(profiles)).toBe(true);
    const agyHomesAfter = fs.readdirSync(config.agyHomesDir);
    expect(agyHomesAfter).toEqual(agyHomesBefore);
  });

  it('GET /api/profiles auto refreshes email for logged-in profile and caches for 30s', async () => {
    // 1. Create isolated profile with null email
    const profDir = path.join(config.agyHomesDir, 'cached-user');
    const tokenDir = path.join(profDir, '.gemini', 'antigravity-cli');
    const logDir = path.join(tokenDir, 'log');
    fs.mkdirSync(logDir, { recursive: true });
    // Write fake token so isProfileLoggedIn returns true
    fs.writeFileSync(path.join(tokenDir, 'antigravity-oauth-token'), 'dummy-token');

    ctx.profileRepo.upsert({
      name: 'cached-user',
      engine: 'agy',
      kind: 'isolated',
      home: profDir,
      email: null,
      enabled: 1,
    });

    // Write log with authenticated email
    fs.writeFileSync(
      path.join(logDir, 'latest.log'),
      'authenticated successfully as cached@example.com\n',
    );

    // 2. Call GET /api/profiles -> auto reads email
    const res = await server.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const profiles = JSON.parse(res.body) as Array<{ name: string; email: string | null }>;
    const prof = profiles.find((p) => p.name === 'cached-user');
    expect(prof).toBeDefined();
    expect(prof?.email).toBe('cached@example.com');
    expect(ctx.profileRepo.get('cached-user')?.email).toBe('cached@example.com');

    // 3. Reset email in DB directly to test 30s cache
    ctx.db.prepare("UPDATE profiles SET email = NULL WHERE name = 'cached-user'").run();
    expect(ctx.profileRepo.get('cached-user')?.email).toBeNull();

    // Call GET /api/profiles again within 30s -> should NOT re-read from disk
    const resCached = await server.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: authHeaders(),
    });
    expect(resCached.statusCode).toBe(200);
    const profilesCached = JSON.parse(resCached.body) as Array<{ name: string; email: string | null }>;
    const profCached = profilesCached.find((p) => p.name === 'cached-user');
    expect(profCached?.email).toBeNull();
  });

  it('Profiles and quota marks with waiting_quota wake up', async () => {
    // 1. Create isolated profile
    const createProfRes = await server.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: authHeaders(),
      payload: { name: 'worker1' },
    });
    expect(createProfRes.statusCode).toBe(201);
    expect(JSON.parse(createProfRes.body).name).toBe('worker1');
    // New agy profiles start as not_logged_in; simulate a completed login.
    ctx.profileRepo.updateAuthState('worker1', 'ok', null, null);

    // 2. Mark quota
    const markRes = await server.inject({
      method: 'POST',
      url: '/api/profiles/worker1/quota',
      headers: authHeaders(),
      payload: {
        family: 'gemini',
        seconds: 3600,
        reason: 'rate limit',
      },
    });
    expect(markRes.statusCode).toBe(200);

    // 3. Insert waiting_quota task
    const repoPath = path.join(tmpDir, 'test-repo');
    initGitRepo(repoPath);
    ctx.projectRepo.insert({
      id: 'proj',
      name: 'Project',
      path: repoPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });
    ctx.taskRepo.insert({
      id: 'proj/wait1',
      projectId: 'proj',
      slug: 'wait1',
      title: 'Wait Task',
      status: 'waiting_quota',
    });

    expect(ctx.taskRepo.get('proj/wait1')?.status).toBe('waiting_quota');

    // 4. Clear quota mark -> wakes waiting_quota task
    const clearRes = await server.inject({
      method: 'DELETE',
      url: '/api/profiles/worker1/quota',
      headers: authHeaders(),
      payload: { family: 'gemini' },
    });
    expect(clearRes.statusCode).toBe(200);

    // Task is unblocked and moved to queued / running
    expect(['queued', 'running']).toContain(ctx.taskRepo.get('proj/wait1')?.status);
  });

  // --- Tasks API ---
  it('GET /api/tasks supports cursor pagination, filters, totals, and legacy responses', async () => {
    ctx.projectRepo.insert({ id: 'pageproj', name: 'Page Project', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 2 });
    for (const [slug, status, title, date] of [
      ['one', 'queued', 'Đăng nhập', '2026-01-01'],
      ['two', 'running', 'Build app', '2026-01-02'],
      ['three', 'done', 'Đăng xuất', '2026-01-03'],
    ] as const) {
      ctx.taskRepo.insert({ id: `pageproj/${slug}`, projectId: 'pageproj', slug, title, status });
      ctx.db.prepare('UPDATE tasks SET createdAt = ?, updatedAt = ? WHERE id = ?').run(date, date, `pageproj/${slug}`);
    }

    const legacy = await server.inject({ method: 'GET', url: '/api/tasks?project=pageproj', headers: authHeaders() });
    expect(legacy.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(legacy.body))).toBe(true);

    const first = await server.inject({ method: 'GET', url: '/api/tasks?project=pageproj&limit=1', headers: authHeaders() });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.total).toBe(3);
    expect(firstBody.items.map((task: { slug: string }) => task.slug)).toEqual(['three']);

    const second = await server.inject({ method: 'GET', url: `/api/tasks?project=pageproj&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, headers: authHeaders() });
    expect(JSON.parse(second.body).items.map((task: { slug: string }) => task.slug)).toEqual(['two']);
    const filtered = JSON.parse((await server.inject({ method: 'GET', url: '/api/tasks?project=pageproj&status=running&search=BUILD&limit=20', headers: authHeaders() })).body);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].projectId).toBe('pageproj');
    expect(JSON.parse((await server.inject({ method: 'GET', url: '/api/tasks?project=missing&limit=20', headers: authHeaders() })).body).items).toHaveLength(0);
    expect(JSON.parse((await server.inject({ method: 'GET', url: '/api/tasks?project=pageproj&search=%25&limit=20', headers: authHeaders() })).body).items).toHaveLength(0);
    expect(JSON.parse((await server.inject({ method: 'GET', url: '/api/tasks?project=pageproj&search=%5F&limit=20', headers: authHeaders() })).body).items).toHaveLength(0);
    expect((await server.inject({ method: 'GET', url: '/api/tasks?project=pageproj&cursor=broken&limit=1', headers: authHeaders() })).statusCode).toBe(400);
  });

  it('GET /api/claude/sessions pages sessions and keeps the legacy response without limit', async () => {
    ctx.claudeSessionRepo.upsert({ sessionId: 'session-old', cwd: tmpDir, title: 'Old', lastAt: '2026-01-01T00:00:00Z' });
    ctx.claudeSessionRepo.upsert({ sessionId: 'session-new', cwd: tmpDir, title: 'New', lastAt: '2026-01-02T00:00:00Z' });

    const legacy = await server.inject({ method: 'GET', url: '/api/claude/sessions', headers: authHeaders() });
    expect(Array.isArray(JSON.parse(legacy.body))).toBe(true);

    const page = await server.inject({ method: 'GET', url: '/api/claude/sessions?limit=1', headers: authHeaders() });
    expect(page.statusCode).toBe(200);
    const body = JSON.parse(page.body);
    expect(body.total).toBe(2);
    expect(body.items.map((session: { sessionId: string }) => session.sessionId)).toEqual(['session-new']);
    const next = await server.inject({ method: 'GET', url: `/api/claude/sessions?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`, headers: authHeaders() });
    expect(JSON.parse(next.body).items.map((session: { sessionId: string }) => session.sessionId)).toEqual(['session-old']);
    expect((await server.inject({ method: 'GET', url: '/api/claude/sessions?limit=1&cursor=broken', headers: authHeaders() })).statusCode).toBe(400);
  });

  it('GET /api/batches supports cursor pagination and keeps the legacy response', async () => {
    ctx.projectRepo.insert({ id: 'batchproj', name: 'Batch Project', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 2 });
    ctx.service.taskBatchRepo?.create({ id: 'batch-old', projectId: 'batchproj', title: 'Old batch' });
    ctx.service.taskBatchRepo?.create({ id: 'batch-new', projectId: 'batchproj', title: 'New batch' });
    ctx.db.prepare("UPDATE task_batches SET createdAt = CASE id WHEN 'batch-old' THEN '2026-01-01' ELSE '2026-01-02' END WHERE id IN ('batch-old', 'batch-new')").run();

    const legacy = await server.inject({ method: 'GET', url: '/api/batches?project=batchproj', headers: authHeaders() });
    expect(Array.isArray(JSON.parse(legacy.body))).toBe(true);
    const first = await server.inject({ method: 'GET', url: '/api/batches?project=batchproj&limit=1', headers: authHeaders() });
    const firstBody = JSON.parse(first.body);
    expect(firstBody.total).toBe(2);
    expect(firstBody.items.map((batch: { id: string }) => batch.id)).toEqual(['batch-new']);
    const next = await server.inject({ method: 'GET', url: `/api/batches?project=batchproj&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, headers: authHeaders() });
    expect(JSON.parse(next.body).items.map((batch: { id: string }) => batch.id)).toEqual(['batch-old']);
    expect((await server.inject({ method: 'GET', url: '/api/batches?limit=1&cursor=broken', headers: authHeaders() })).statusCode).toBe(400);
  });

  it('keeps the Claude reviewer in task lists after older fallback events leave the global recent window', async () => {
    ctx.projectRepo.insert({
      id: 'fallback-list',
      name: 'Fallback list',
      path: '/tmp',
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({
      id: 'fallback-list/task',
      projectId: 'fallback-list',
      slug: 'task',
      title: 'Fallback task',
      status: 'review',
    });
    ctx.eventRepo.insert('review.fallback', 'fallback-list/task', { from: 'codex', to: 'claude' });
    for (let i = 0; i < 201; i += 1) {
      ctx.eventRepo.insert('unrelated.event');
    }

    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks?project=fallback-list',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      expect.objectContaining({ id: 'fallback-list/task', reviewer: 'claude' }),
    ]);
  });

  it('Tasks workflow: create, start, cancel, review, retry, commits, and worktree removal', async () => {
    const repoPath = path.join(tmpDir, 'test-repo');
    initGitRepo(repoPath);
    ctx.projectRepo.insert({
      id: 'myproj',
      name: 'My Project',
      path: repoPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });

    ctx.profileRepo.upsert({ name: 'worker1', engine: 'agy', kind: 'isolated', home: '/tmp/worker1', email: null, enabled: 1 });

    // 1. Create task (draft)
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: authHeaders(),
      payload: {
        project: 'myproj',
        slug: 'task-abc',
        title: 'Task ABC',
        body: 'Implement feature ABC',
        level: 'easy',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const task = JSON.parse(createRes.body);
    expect(task.id).toBe('myproj/task-abc');
    expect(task.status).toBe('draft');

    // 2. Start task -> queued or running
    const startRes = await server.inject({
      method: 'POST',
      url: '/api/tasks/myproj~task-abc/start',
      headers: authHeaders(),
    });
    expect(startRes.statusCode).toBe(200);
    expect(['queued', 'running']).toContain(JSON.parse(startRes.body).status);

    // 3. Cancel task -> cancelled
    const cancelRes = await server.inject({
      method: 'POST',
      url: '/api/tasks/myproj~task-abc/cancel',
      headers: authHeaders(),
      payload: { reason: 'Trùng với task khác', by: 'dashboard' },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(JSON.parse(cancelRes.body).status).toBe('cancelled');
    expect(JSON.parse(cancelRes.body).cancelReason).toBe('Trùng với task khác');
    expect(JSON.parse(cancelRes.body).cancelledBy).toBe('dashboard');
    const cancelledDetail = await server.inject({ method: 'GET', url: '/api/tasks/myproj~task-abc', headers: authHeaders() });
    expect(JSON.parse(cancelledDetail.body).cancelReason).toBe('Trùng với task khác');

    // 4. Set to failed and retry task -> queued
    ctx.taskRepo.updateStatus('myproj/task-abc', 'failed');
    ctx.taskRepo.update('myproj/task-abc', { reviewerChangesRequested: 2 });
    const retryRes = await server.inject({
      method: 'POST',
      url: '/api/tasks/myproj~task-abc/retry',
      headers: authHeaders(),
      payload: { note: 'Retrying task abc' },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(JSON.parse(retryRes.body)).toEqual(expect.objectContaining({
      status: expect.any(String),
      reviewerChangesRequested: 2,
    }));
    expect(['queued', 'running']).toContain(JSON.parse(retryRes.body).status);

    // Cancel the retried task to avoid background process race with step 5
    await server.inject({
      method: 'POST',
      url: '/api/tasks/myproj~task-abc/cancel',
      headers: authHeaders(),
    });
    await new Promise((r) => setTimeout(r, 50));

    // 5. Test detail endpoint with git commits and worktree DONE/BLOCKED
    const worktreeDir = path.join(tmpDir, 'worktrees', 'myproj', 'task-abc');
    fs.mkdirSync(path.join(worktreeDir, '.agenthub'), { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: worktreeDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: worktreeDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeDir });
    fs.writeFileSync(path.join(worktreeDir, '.agenthub', 'DONE'), 'All completed successfully');

    ctx.taskRepo.update('myproj/task-abc', {
      worktreePath: worktreeDir,
      branch: 'agenthub/task-abc',
      status: 'review',
    });

    // Create commit on worktree branch
    fs.writeFileSync(path.join(worktreeDir, 'feature.txt'), 'done');
    execFileSync('git', ['add', '.'], { cwd: worktreeDir });
    execFileSync('git', ['commit', '-m', 'feat: add feature'], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });

    const detailRes = await server.inject({
      method: 'GET',
      url: '/api/tasks/myproj~task-abc',
      headers: authHeaders(),
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = JSON.parse(detailRes.body);
    expect(detail.doneContent).toBe('All completed successfully');
    expect(detail.worktreePath).toBe(worktreeDir);
    expect(detail.commits.length).toBeGreaterThan(0);
    expect(detail.commits[0]).toContain('feat: add feature');

    // 6. Retry an escalated reviewer without changing the task status
    ctx.taskRepo.update('myproj/task-abc', {
      reviewerEscalated: 1,
      reviewerEscalatedAt: new Date().toISOString(),
      reviewerEscalationReason: 'reviewer_environment',
    });
    const reviewerRetryRes = await server.inject({
      method: 'POST',
      url: '/api/tasks/myproj~task-abc/review/retry-reviewer',
      headers: authHeaders(),
    });
    expect(reviewerRetryRes.statusCode).toBe(200);
    const reviewerRetryTask = JSON.parse(reviewerRetryRes.body);
    expect(reviewerRetryTask.status).toBe('review');
    expect(reviewerRetryTask.reviewerEscalated).toBe(0);

    // 7. Review: changes_requested -> re-queue
    const reviewChangesRes = await server.inject({
      method: 'POST',
      url: '/api/tasks/myproj~task-abc/review',
      headers: authHeaders(),
      payload: {
        verdict: 'changes_requested',
        feedback: 'Please fix the lint error',
      },
    });
    expect(reviewChangesRes.statusCode).toBe(200);
    expect(JSON.parse(reviewChangesRes.body).status).toBe('queued');

    // 8. Review: approved -> done
    ctx.taskRepo.updateStatus('myproj/task-abc', 'review');
    const reviewApproveRes = await server.inject({
      method: 'POST',
      url: '/api/tasks/myproj~task-abc/review',
      headers: authHeaders(),
      payload: {
        verdict: 'approved',
      },
    });
    expect(reviewApproveRes.statusCode).toBe(200);
    expect(JSON.parse(reviewApproveRes.body).status).toBe('done');

    // 9. Delete worktree
    const delWtRes = await server.inject({
      method: 'DELETE',
      url: '/api/tasks/myproj~task-abc/worktree',
      headers: authHeaders(),
    });
    expect(delWtRes.statusCode).toBe(200);
    expect(fs.existsSync(worktreeDir)).toBe(false);
  });

  it('cancels an unstarted merge-fix task when its source is done', async () => {
    ctx.projectRepo.insert({ id: 'merge-cleanup', name: 'Merge cleanup', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    ctx.taskRepo.insert({ id: 'merge-cleanup/source', projectId: 'merge-cleanup', slug: 'source', title: 'Source', status: 'done' });
    ctx.taskRepo.insert({
      id: 'merge-cleanup/source-fix-merge',
      projectId: 'merge-cleanup',
      slug: 'source-fix-merge',
      title: 'Fix merge',
      status: 'draft',
      sourceRef: JSON.stringify({ taskId: 'merge-cleanup/source', checkName: 'merge', excerptHash: 'hash' }),
    });

    ctx.scheduler.getEventBus().emit('task.done', 'merge-cleanup/source');
    await vi.waitFor(() => expect(ctx.taskRepo.get('merge-cleanup/source-fix-merge')?.status).toBe('cancelled'));
    const event = ctx.eventRepo.getByTask('merge-cleanup/source-fix-merge').find((item) => item.type === 'task.cancelled');
    expect(event?.payload).toContain('orphaned_merge_fix');
  });

  it('keeps a merge-fix task that has already attempted work', async () => {
    ctx.projectRepo.insert({ id: 'merge-keep', name: 'Merge keep', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    ctx.taskRepo.insert({ id: 'merge-keep/source', projectId: 'merge-keep', slug: 'source', title: 'Source', status: 'done' });
    ctx.taskRepo.insert({
      id: 'merge-keep/source-fix-merge',
      projectId: 'merge-keep',
      slug: 'source-fix-merge',
      title: 'Fix merge',
      status: 'queued',
      sourceRef: JSON.stringify({ taskId: 'merge-keep/source', checkName: 'merge', excerptHash: 'hash' }),
    });
    ctx.taskRepo.update('merge-keep/source-fix-merge', { attempt: 1 });

    ctx.scheduler.getEventBus().emit('task.done', 'merge-keep/source');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ctx.taskRepo.get('merge-keep/source-fix-merge')?.status).toBe('queued');
    expect(ctx.eventRepo.getByTask('merge-keep/source-fix-merge').some((item) => item.type === 'task.cancelled')).toBe(false);
  });

  it('rejects a concurrent merge review and does not create a merge-fix task', async () => {
    const repoPath = path.join(tmpDir, 'race-repo');
    initGitRepo(repoPath);
    execFileSync('git', ['checkout', '-b', 'feature-race'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'feat: race branch'], {
      cwd: repoPath,
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    });
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath });
    ctx.projectRepo.insert({
      id: 'race',
      name: 'Race',
      path: repoPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
      merge: JSON.stringify({ enabled: true, worktrees: { main: repoPath }, checks: [] }),
    });
    ctx.taskRepo.insert({ id: 'race/task', projectId: 'race', slug: 'task', title: 'Race task', branch: 'feature-race', baseRef: 'main', status: 'review' });

    const results = await Promise.allSettled([
      server.inject({ method: 'POST', url: '/api/tasks/race~task/review', headers: authHeaders(), payload: { verdict: 'approved', merge: true } }),
      server.inject({ method: 'POST', url: '/api/tasks/race~task/review', headers: authHeaders(), payload: { verdict: 'approved', merge: true } }),
    ]);
    const responses = results.map((result) => result.status === 'fulfilled' ? result.value : null).filter(Boolean);
    expect(responses.filter((response) => response?.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((response) => response?.statusCode === 409)).toHaveLength(1);
    expect(responses.find((response) => response?.statusCode === 409)?.body).toContain('Task đang được duyệt');
    expect(ctx.taskRepo.getAll().filter((task) => task.slug.endsWith('-fix-merge'))).toHaveLength(0);
  });

  // --- Task Log Tail API ---
  it('GET /api/tasks/:id/log reads log tail up to 512KB', async () => {
    ctx.projectRepo.insert({
      id: 'logproj',
      name: 'Log Proj',
      path: '/tmp',
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({
      id: 'logproj/t1',
      projectId: 'logproj',
      slug: 't1',
      title: 'Log task',
      status: 'running',
    });

    const logDir = path.join(tmpDir, 'logs', 'logproj_t1');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'run1.log');
    fs.writeFileSync(logPath, 'Line 1: started\nLine 2: working\nLine 3: finished\n');

    ctx.runRepo.insert({
      id: 'run1',
      taskId: 'logproj/t1',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      logPath,
    });

    const logRes = await server.inject({
      method: 'GET',
      url: '/api/tasks/logproj~t1/log?tail=10',
      headers: authHeaders(),
    });
    expect(logRes.statusCode).toBe(200);
    expect(logRes.body).toContain('Line 3: finished');
  });

  // --- 404 and SPA Fallback Handling ---
  it('handles nonexistent /api routes with 401 (unauthenticated) or 404 JSON (authenticated)', async () => {
    // Without token: 401
    const unauthRes = await server.inject({
      method: 'GET',
      url: '/api/nonexistent',
      headers: { host: '127.0.0.1:7789' },
    });
    expect(unauthRes.statusCode).toBe(401);

    // With token: 404 JSON
    const authRes = await server.inject({
      method: 'GET',
      url: '/api/nonexistent',
      headers: authHeaders(),
    });
    expect(authRes.statusCode).toBe(404);
    const body = JSON.parse(authRes.body);
    expect(body.error).toBe('not_found');
  });

  it('restricts SPA fallback to GET with Accept: text/html and returns 404 JSON otherwise', async () => {
    // POST /nonexistent: 404 JSON
    const postRes = await server.inject({
      method: 'POST',
      url: '/nonexistent-route',
      headers: { host: '127.0.0.1:7789' },
    });
    expect(postRes.statusCode).toBe(404);
    expect(JSON.parse(postRes.body).error).toBe('not_found');

    // GET /nonexistent without Accept text/html: 404 JSON
    const getNoHtmlRes = await server.inject({
      method: 'GET',
      url: '/nonexistent-route',
      headers: { host: '127.0.0.1:7789', accept: 'application/json' },
    });
    expect(getNoHtmlRes.statusCode).toBe(404);
    expect(JSON.parse(getNoHtmlRes.body).error).toBe('not_found');

    // GET /nonexistent with Accept text/html: 200 HTML
    const getHtmlRes = await server.inject({
      method: 'GET',
      url: '/nonexistent-route',
      headers: { host: '127.0.0.1:7789', accept: 'text/html,application/xhtml+xml' },
    });
    expect(getHtmlRes.statusCode).toBe(200);
    expect(getHtmlRes.headers['content-type']).toContain('text/html');
  });

  it('PATCH /api/tasks/:id: updates modelChain, title, level, body, appendBody, dependsOn and validates properly', async () => {
    const repoPath = path.join(tmpDir, 'test-patch-repo');
    initGitRepo(repoPath);
    ctx.projectRepo.insert({
      id: 'patchproj',
      name: 'Patch Project',
      path: repoPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });

    ctx.taskRepo.insert({
      id: 'patchproj/task-1',
      projectId: 'patchproj',
      slug: 'task-1',
      title: 'Task 1',
      body: 'Initial body 1',
      level: 'easy',
      status: 'queued',
    });

    ctx.taskRepo.insert({
      id: 'patchproj/task-2',
      projectId: 'patchproj',
      slug: 'task-2',
      title: 'Task 2',
      body: 'Initial body 2',
      level: 'easy',
      status: 'queued',
      dependsOn: ['patchproj/task-1'],
    });

    let sseUpdatedEvent: { taskId: string; payload: unknown } | null = null;
    ctx.scheduler.getEventBus().on('task.updated', (taskId, payload) => {
      sseUpdatedEvent = { taskId, payload };
    });

    // 1. sửa được modelChain khi queued
    const resQueued = await server.inject({
      method: 'PATCH',
      url: '/api/tasks/patchproj~task-1',
      headers: authHeaders(),
      payload: {
        modelChain: ['claude-sonnet-4-6', 'codex:gpt-5.6-luna'],
        level: 'hard',
      },
    });
    expect(resQueued.statusCode).toBe(200);
    const updated1 = JSON.parse(resQueued.body);
    expect(JSON.parse(updated1.modelChain)).toEqual(['claude-sonnet-4-6', 'codex:gpt-5.6-luna']);
    expect(updated1.level).toBe('hard');
    expect(sseUpdatedEvent?.taskId).toBe('patchproj/task-1');

    // 2. 409 khi running
    ctx.taskRepo.update('patchproj/task-1', { status: 'running' });
    const resRunning = await server.inject({
      method: 'PATCH',
      url: '/api/tasks/patchproj~task-1',
      headers: authHeaders(),
      payload: {
        title: 'New Title',
      },
    });
    expect(resRunning.statusCode).toBe(409);

    // 3. 422 khi dependsOn tạo vòng (task-2 depends on task-1; updating task-1 to depend on task-2 creates a cycle)
    ctx.taskRepo.update('patchproj/task-1', { status: 'queued' });
    const resCycle = await server.inject({
      method: 'PATCH',
      url: '/api/tasks/patchproj~task-1',
      headers: authHeaders(),
      payload: {
        dependsOn: ['patchproj/task-2'],
      },
    });
    expect(resCycle.statusCode).toBe(422);

    // Self cycle also 422
    const resSelfCycle = await server.inject({
      method: 'PATCH',
      url: '/api/tasks/patchproj~task-1',
      headers: authHeaders(),
      payload: {
        dependsOn: ['patchproj/task-1'],
      },
    });
    expect(resSelfCycle.statusCode).toBe(422);

    // Non-existent dependency also 422
    const resNonExistent = await server.inject({
      method: 'PATCH',
      url: '/api/tasks/patchproj~task-1',
      headers: authHeaders(),
      payload: {
        dependsOn: ['patchproj/nonexistent-task'],
      },
    });
    expect(resNonExistent.statusCode).toBe(422);

    // 4. appendBody nối đúng
    const resAppend = await server.inject({
      method: 'PATCH',
      url: '/api/tasks/patchproj~task-1',
      headers: authHeaders(),
      payload: {
        appendBody: 'Appended note',
      },
    });
    expect(resAppend.statusCode).toBe(200);
    const updatedAppend = JSON.parse(resAppend.body);
    expect(updatedAppend.body).toBe('Initial body 1\nAppended note');
  });
});
