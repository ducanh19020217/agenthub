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
import { buildGitUrls } from '../src/publish.js';
import { toRouteId } from '../src/services/index.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeEngine: FakeEngine;

const cleanEnvPath = (process.env.PATH || '')
  .split(path.delimiter)
  .filter((entry) => !entry.includes(`${path.sep}shims${path.sep}worker`))
  .join(path.delimiter);

const testEnv = {
  ...process.env,
  PATH: cleanEnvPath,
  GIT_AUTHOR_NAME: 'Tester',
  GIT_AUTHOR_EMAIL: 'tester@example.com',
  GIT_COMMITTER_NAME: 'Tester',
  GIT_COMMITTER_EMAIL: 'tester@example.com',
};

function authHeaders() {
  return {
    host: '127.0.0.1',
    authorization: `Bearer ${token}`,
  };
}

function initBareRemote(remotePath: string) {
  fs.mkdirSync(remotePath, { recursive: true });
  execFileSync('git', ['init', '--bare', remotePath], { env: testEnv });
}

function initGitRepoWithRemote(repoPath: string, remotePath: string, branch = 'main') {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-b', branch], { cwd: repoPath, env: testEnv });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test Project\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: repoPath, env: testEnv });
  execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, env: testEnv });
  execFileSync('git', ['push', '-u', 'origin', branch], { cwd: repoPath, env: testEnv });
}

describe('Publish Service (t-auto-push-after-done)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-publish-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    config = loadConfig(tmpDir);
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine('codex');
    const engines = new Map<string, Engine>();
    engines.set('codex', fakeEngine);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx?.scheduler?.stop();
    await server?.close();
    ctx?.db?.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('buildGitUrls formats URLs correctly for GitHub, GitLab, and local remotes', () => {
    const ghUrl = 'git@github.com:myorg/myrepo.git';
    const gh = buildGitUrls(ghUrl, 'abcdef1234567890', '1234567890abcdef');
    expect(gh.commitUrl).toBe('https://github.com/myorg/myrepo/commit/abcdef1234567890');
    expect(gh.compareUrl).toBe('https://github.com/myorg/myrepo/compare/1234567890abcdef...abcdef1234567890');

    const glUrl = 'https://gitlab.com/group/subgroup/project.git';
    const gl = buildGitUrls(glUrl, 'abcdef1234567890', '1234567890abcdef');
    expect(gl.commitUrl).toBe('https://gitlab.com/subgroup/project/-/commit/abcdef1234567890');
    expect(gl.compareUrl).toBe('https://gitlab.com/subgroup/project/-/compare/1234567890abcdef...abcdef1234567890');

    const localUrl = '/tmp/bare-repo.git';
    const local = buildGitUrls(localUrl, 'abcdef1234567890');
    expect(local.commitUrl).toBeUndefined();
    expect(local.compareUrl).toBeUndefined();
  });

  it('tự động publish task lên git bare remote và chuyển status sang pushed', async () => {
    const remotePath = path.join(tmpDir, 'remote.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    // Create a feature branch with a commit
    execFileSync('git', ['checkout', '-b', 'agenthub/feature-1'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature 1\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: feature 1'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

    ctx.service.createProject({
      id: 'proj-pub-1',
      name: 'Project Publish 1',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        publish: { enabled: true, remote: 'origin', branch: 'main' },
      },
    });

    ctx.taskRepo.insert({
      id: 'proj-pub-1/task-1',
      projectId: 'proj-pub-1',
      slug: 'feature-1',
      title: 'Feature 1',
      status: 'done',
      branch: 'agenthub/feature-1',
      baseRef: 'main',
    });
    const task = ctx.taskRepo.get('proj-pub-1/task-1')!;

    const events: Array<{ type: string; payload: unknown }> = [];
    ctx.scheduler.getEventBus().on('task.publishing', (id, p) => events.push({ type: 'task.publishing', payload: p }));
    ctx.scheduler.getEventBus().on('task.pushed', (id, p) => events.push({ type: 'task.pushed', payload: p }));

    const result = await ctx.service.publishTask(task.id);
    expect(result.ok).toBe(true);

    const updated = ctx.taskRepo.get(task.id);
    expect(updated?.status).toBe('pushed');
    expect(updated?.pushedAt).toBeDefined();
    expect(updated?.pushResult).toBeDefined();

    const pushResult = JSON.parse(updated!.pushResult!);
    expect(pushResult.remote).toBe('origin');
    expect(pushResult.branch).toBe('main');
    expect(pushResult.commit).toBeDefined();

    // Verify bare remote received the commit in main
    const remoteHead = execFileSync('git', ['--git-dir', remotePath, 'rev-parse', 'main'], { encoding: 'utf8', env: testEnv }).trim();
    expect(remoteHead).toBe(pushResult.commit);

    // Verify events emitted
    expect(events.some((e) => e.type === 'task.publishing')).toBe(true);
    expect(events.some((e) => e.type === 'task.pushed')).toBe(true);
  });

  it('publish an toàn ngay cả khi repo chính của user đang checkout main và bị dirty', async () => {
    const remotePath = path.join(tmpDir, 'remote-dirty.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo-dirty');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    // Create a feature branch
    execFileSync('git', ['checkout', '-b', 'agenthub/feature-dirty'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'file-dirty.txt'), 'clean in branch\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: feature dirty'], { cwd: repoPath, env: testEnv });

    // Switch repo back to main and make it DIRTY (uncommitted change)
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'uncommitted.txt'), 'dirty uncommitted work\n');

    ctx.service.createProject({
      id: 'proj-dirty',
      name: 'Project Dirty',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        publish: { enabled: true, remote: 'origin', branch: 'main' },
      },
    });

    ctx.taskRepo.insert({
      id: 'proj-dirty/task-dirty',
      projectId: 'proj-dirty',
      slug: 'feature-dirty',
      title: 'Feature Dirty',
      status: 'done',
      branch: 'agenthub/feature-dirty',
      baseRef: 'main',
    });
    const task = ctx.taskRepo.get('proj-dirty/task-dirty')!;

    const result = await ctx.service.publishTask(task.id);
    expect(result.ok).toBe(true);

    // Verify task is pushed
    const updated = ctx.taskRepo.get(task.id);
    expect(updated?.status).toBe('pushed');

    // Verify user repo is STILL dirty and uncommitted work is intact
    expect(fs.existsSync(path.join(repoPath, 'uncommitted.txt'))).toBe(true);
    const uncommittedContent = fs.readFileSync(path.join(repoPath, 'uncommitted.txt'), 'utf8');
    expect(uncommittedContent).toBe('dirty uncommitted work\n');
  });

  it('đẩy cả nhánh integration lên remote khi pushIntegrationBranch = true', async () => {
    const remotePath = path.join(tmpDir, 'remote-integ.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo-integ');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    // Create integration branch
    execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'integ.txt'), 'integ work\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: integration commit'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

    ctx.service.createProject({
      id: 'proj-integ',
      name: 'Project Integ',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        integration: { enabled: true, branch: 'agenthub/integration' },
        publish: { enabled: true, remote: 'origin', branch: 'main', pushIntegrationBranch: true },
      },
    });

    ctx.taskRepo.insert({
      id: 'proj-integ/task-integ',
      projectId: 'proj-integ',
      slug: 'task-integ',
      title: 'Task Integ',
      status: 'done',
      branch: 'agenthub/integration',
      baseRef: 'main',
    });
    const task = ctx.taskRepo.get('proj-integ/task-integ')!;

    const result = await ctx.service.publishTask(task.id);
    expect(result.ok).toBe(true);

    // Verify integration branch exists on remote
    const remoteIntegHead = execFileSync(
      'git',
      ['--git-dir', remotePath, 'rev-parse', 'agenthub/integration'],
      { encoding: 'utf8', env: testEnv },
    ).trim();
    expect(remoteIntegHead).toBeDefined();
    expect(remoteIntegHead.length).toBe(40);
  });

  it('xử lý thất bại khi remote không tồn tại: giữ nguyên status done và phát task.push_failed', async () => {
    const repoPath = path.join(tmpDir, 'local-repo-no-remote');
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# No remote\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

    ctx.service.createProject({
      id: 'proj-no-remote',
      name: 'Project No Remote',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        publish: { enabled: true, remote: 'nonexistent-remote' },
      },
    });

    ctx.taskRepo.insert({
      id: 'proj-no-remote/task-fail',
      projectId: 'proj-no-remote',
      slug: 'task-fail',
      title: 'Task Fail',
      status: 'done',
    });
    const task = ctx.taskRepo.get('proj-no-remote/task-fail')!;

    let failedEvent: unknown = null;
    ctx.scheduler.getEventBus().on('task.push_failed', (_id, p) => {
      failedEvent = p;
    });

    const result = await ctx.service.publishTask(task.id);
    expect(result.ok).toBe(false);

    // Status MUST remain 'done'
    const updated = ctx.taskRepo.get(task.id);
    expect(updated?.status).toBe('done');
    expect(updated?.pushResult).toBeDefined();
    const pushResult = JSON.parse(updated!.pushResult!);
    expect(pushResult.error).toContain('nonexistent-remote');
    expect(pushResult.retryable).toBe(true);
    expect(failedEvent).toBeDefined();
  });

  it('endpoint POST /api/tasks/:id/publish cho phép publish lại thủ công', async () => {
    const remotePath = path.join(tmpDir, 'remote-api.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo-api');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    execFileSync('git', ['checkout', '-b', 'agenthub/api-feat'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'api-feat.txt'), 'api test\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: api feat'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

    ctx.service.createProject({
      id: 'proj-api',
      name: 'Project API',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        publish: { enabled: false }, // publish is disabled by default
      },
    });

    ctx.taskRepo.insert({
      id: 'proj-api/task-manual',
      projectId: 'proj-api',
      slug: 'api-feat',
      title: 'API Feat',
      status: 'done',
      branch: 'agenthub/api-feat',
    });
    const task = ctx.taskRepo.get('proj-api/task-manual')!;

    // Manual POST /api/tasks/:id/publish succeeds even if publish.enabled is false
    const res = await server.inject({
      method: 'POST',
      url: `/api/tasks/${toRouteId(task.id)}/publish`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);

    const updated = ctx.taskRepo.get(task.id);
    expect(updated?.status).toBe('pushed');
  });

  it('chạy tuần tự các lượt publish cho cùng một project để tránh xung đột', async () => {
    const remotePath = path.join(tmpDir, 'remote-seq.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo-seq');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    // Create 2 branches
    execFileSync('git', ['checkout', '-b', 'agenthub/seq-1'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'seq1.txt'), '1\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: seq 1'], { cwd: repoPath, env: testEnv });

    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['checkout', '-b', 'agenthub/seq-2'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'seq2.txt'), '2\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: seq 2'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

    ctx.service.createProject({
      id: 'proj-seq',
      name: 'Project Seq',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        publish: { enabled: true, remote: 'origin', branch: 'main' },
      },
    });

    ctx.taskRepo.insert({
      id: 'proj-seq/t1',
      projectId: 'proj-seq',
      slug: 'seq-1',
      title: 'Seq 1',
      status: 'done',
      branch: 'agenthub/seq-1',
    });
    const task1 = ctx.taskRepo.get('proj-seq/t1')!;

    ctx.taskRepo.insert({
      id: 'proj-seq/t2',
      projectId: 'proj-seq',
      slug: 'seq-2',
      title: 'Seq 2',
      status: 'done',
      branch: 'agenthub/seq-2',
    });
    const task2 = ctx.taskRepo.get('proj-seq/t2')!;

    // Launch both concurrently
    const [res1, res2] = await Promise.all([
      ctx.service.publishTask(task1.id),
      ctx.service.publishTask(task2.id),
    ]);

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    expect(ctx.taskRepo.get(task1.id)?.status).toBe('pushed');
    expect(ctx.taskRepo.get(task2.id)?.status).toBe('pushed');
  });

  it('publish tắt: tự động bỏ qua, status giữ nguyên done và không phát task.pushed', async () => {
    const repoPath = path.join(tmpDir, 'local-repo-disabled');
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Disabled\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

    ctx.service.createProject({
      id: 'proj-disabled',
      name: 'Project Disabled',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        publish: { enabled: false },
      },
    });

    ctx.taskRepo.insert({
      id: 'proj-disabled/t-off',
      projectId: 'proj-disabled',
      slug: 't-off',
      title: 'Task Off',
      status: 'done',
    });
    const task = ctx.taskRepo.get('proj-disabled/t-off')!;

    let pushedFired = false;
    ctx.scheduler.getEventBus().on('task.pushed', () => {
      pushedFired = true;
    });

    const res = await ctx.service.publishTask(task.id);
    expect(res.ok).toBe(true);
    if ('skipped' in res) {
      expect(res.skipped).toBe(true);
      expect(res.reason).toBe('publish_disabled');
    }
    expect(pushedFired).toBe(false);
    expect(ctx.taskRepo.get(task.id)?.status).toBe('done');
  });

  it('xử lý khi remote từ chối do xung đột (non-fast-forward/diverged remote): giữ nguyên status done và phát task.push_failed', async () => {
    const remotePath = path.join(tmpDir, 'remote-conflict.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo-conflict');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    ctx.service.createProject({
      id: 'proj-conflict',
      name: 'Project Conflict',
      path: repoPath,
      defaultBranch: 'main',
      settings: {
        publish: { enabled: true, remote: 'origin', branch: 'main' },
      },
    });

    // Make local task branch
    execFileSync('git', ['checkout', '-b', 'agenthub/conflicting-task'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'conflict.txt'), 'Local change\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: local change'], { cwd: repoPath, env: testEnv });

    // Push conflicting commit directly to bare remote main from a separate clone
    const otherClone = path.join(tmpDir, 'other-clone');
    execFileSync('git', ['clone', '-b', 'main', remotePath, otherClone], { env: testEnv });
    execFileSync('git', ['config', 'user.name', 'Other Tester'], { cwd: otherClone, env: testEnv });
    execFileSync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone, env: testEnv });
    fs.writeFileSync(path.join(otherClone, 'conflict.txt'), 'Remote change diverged\n');
    execFileSync('git', ['add', '.'], { cwd: otherClone, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: remote diverged change'], { cwd: otherClone, env: testEnv });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: otherClone, env: testEnv });

    ctx.taskRepo.insert({
      id: 'proj-conflict/t-diverged',
      projectId: 'proj-conflict',
      slug: 'conflicting-task',
      title: 'Conflicting Task',
      status: 'done',
      branch: 'agenthub/conflicting-task',
    });
    const task = ctx.taskRepo.get('proj-conflict/t-diverged')!;

    let failedEvent: unknown = null;
    ctx.scheduler.getEventBus().on('task.push_failed', (_id, p) => {
      failedEvent = p;
    });

    const res = await ctx.service.publishTask(task.id);
    expect(res.ok).toBe(false);

    const updated = ctx.taskRepo.get(task.id);
    expect(updated?.status).toBe('done');
    expect(failedEvent).toBeDefined();
    expect(updated?.pushResult).toBeDefined();
    const pushResult = JSON.parse(updated!.pushResult!);
    expect(pushResult.error).toBeDefined();
  });
});
