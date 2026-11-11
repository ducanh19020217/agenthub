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
import { clearAuditPassCache } from '../src/pre-publish-audit.js';
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
    delete process.env.FAKE_MODE;
    clearAuditPassCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-publish-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    config = loadConfig(tmpDir);
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine();
    (fakeEngine as any).id = 'codex';
    const engines = new Map<string, Engine>();
    engines.set('codex', fakeEngine);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    ctx.profileRepo.upsert({
      name: 'codex-publish-tester',
      engine: 'codex',
      kind: 'codex',
      home: path.join(tmpDir, 'codex-home'),
      email: 'tester@example.com',
      enabled: 1,
    });

    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    delete process.env.FAKE_MODE;
    clearAuditPassCache();
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

  describe('Pre-publish audit gate', () => {
    it('audit pass -> push succeeds, emits audit_started and audit_passed, populates pushResult.auditPassed', async () => {
      const remotePath = path.join(tmpDir, 'remote-audit-pass.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-audit-pass');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/audit-task-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'pass.txt'), 'clean code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: clean feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-audit-pass',
        name: 'Project Audit Pass',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-audit-pass/task-1',
        projectId: 'proj-audit-pass',
        slug: 'audit-task-1',
        title: 'Audit Task 1',
        status: 'done',
        branch: 'agenthub/audit-task-1',
        baseRef: 'main',
      });

      const events: Array<{ type: string; payload: any }> = [];
      ctx.scheduler.getEventBus().on('task.audit_started', (_id, p) => events.push({ type: 'task.audit_started', payload: p }));
      ctx.scheduler.getEventBus().on('task.audit_passed', (_id, p) => events.push({ type: 'task.audit_passed', payload: p }));
      ctx.scheduler.getEventBus().on('task.pushed', (_id, p) => events.push({ type: 'task.pushed', payload: p }));

      process.env.FAKE_MODE = 'audit-pass';
      const result = await ctx.service.publishTask('proj-audit-pass/task-1');
      expect(result.ok).toBe(true);

      const updated = ctx.taskRepo.get('proj-audit-pass/task-1');
      expect(updated?.status).toBe('pushed');
      const pushResult = JSON.parse(updated!.pushResult!);
      expect(pushResult.auditPassed).toBe(true);
      expect(pushResult.auditSkipped).toBe(false);

      expect(events.some((e) => e.type === 'task.audit_started')).toBe(true);
      expect(events.some((e) => e.type === 'task.audit_passed')).toBe(true);
      expect(events.some((e) => e.type === 'task.pushed')).toBe(true);
    });

    it('audit fail with P1 finding -> blocks push, returns task to worker via changes_requested flow', async () => {
      const remotePath = path.join(tmpDir, 'remote-audit-fail.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-audit-fail');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/audit-task-fail'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'bug.txt'), 'buggy code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: buggy feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-audit-fail',
        name: 'Project Audit Fail',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-audit-fail/task-fail',
        projectId: 'proj-audit-fail',
        slug: 'audit-task-fail',
        title: 'Audit Task Fail',
        status: 'done',
        branch: 'agenthub/audit-task-fail',
        baseRef: 'main',
        body: 'Original task body',
      });

      const events: Array<{ type: string; payload: any }> = [];
      ctx.scheduler.getEventBus().on('task.audit_started', (_id, p) => events.push({ type: 'task.audit_started', payload: p }));
      ctx.scheduler.getEventBus().on('task.audit_failed', (_id, p) => events.push({ type: 'task.audit_failed', payload: p }));
      ctx.scheduler.getEventBus().on('task.queued', (_id, p) => events.push({ type: 'task.queued', payload: p }));

      process.env.FAKE_MODE = 'audit-fail';
      const result = await ctx.service.publishTask('proj-audit-fail/task-fail');
      expect(result.ok).toBe(false);
      expect((result as any).auditFailed).toBe(true);

      const updated = ctx.taskRepo.get('proj-audit-fail/task-fail');
      // Task returned to worker
      expect(updated?.status).toBe('queued');
      expect(updated?.resume).toBe(1);
      expect(updated?.reviewerChangesRequested).toBe(1);
      expect(updated?.reviewStep).toBe(0);
      expect(updated?.body).toContain('Feedback audit trước khi publish');

      // Check review record created
      const reviews = ctx.reviewRepo.getByTask('proj-audit-fail/task-fail');
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      const auditReview = reviews.find((r) => r.actor === 'audit-prepublish');
      expect(auditReview).toBeDefined();
      expect(auditReview?.verdict).toBe('changes_requested');
      expect(auditReview?.feedback).toContain('Missing required feature X');

      // Verify remote did not receive feature commit
      const remoteCommitLog = execFileSync('git', ['--git-dir', remotePath, 'log', 'main', '--oneline'], {
        encoding: 'utf8',
        env: testEnv,
      });
      expect(remoteCommitLog).not.toContain('buggy feature');

      // Verify audit_failed event emitted
      expect(events.some((e) => e.type === 'task.audit_failed')).toBe(true);
      const queuedEvt = events.find((e) => e.type === 'task.queued');
      expect(queuedEvt?.payload.reason).toBe('changes_requested');
    });

    it('multi-task audit: blocks push for all if any merged unpushed task fails audit', async () => {
      const remotePath = path.join(tmpDir, 'remote-multi-audit.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-multi-audit');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Task 1: Clean
      execFileSync('git', ['checkout', '-b', 'agenthub/multi-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'clean.txt'), 'clean\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: multi 1 clean'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/multi-1', '-m', 'Merge branch agenthub/multi-1'], { cwd: repoPath, env: testEnv });

      // Task 2: Buggy
      execFileSync('git', ['checkout', '-b', 'agenthub/multi-2'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'buggy.txt'), 'bug\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: multi 2 bug'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/multi-2', '-m', 'Merge branch agenthub/multi-2'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-multi-audit',
        name: 'Project Multi Audit',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-multi-audit/t1',
        projectId: 'proj-multi-audit',
        slug: 'multi-1',
        title: 'Multi 1',
        status: 'done',
        branch: 'agenthub/multi-1',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'proj-multi-audit/t2',
        projectId: 'proj-multi-audit',
        slug: 'multi-2',
        title: 'Multi 2',
        status: 'done',
        branch: 'agenthub/multi-2',
        baseRef: 'main',
      });

      // t1 passes audit, t2 fails audit
      // We can use FAKE_MODE='audit-pass' to pass t1 and cache it, then FAKE_MODE='audit-fail' for t2
      process.env.FAKE_MODE = 'audit-pass';
      // Audit t1 first by publishing or precaching:
      const t1Commit = execFileSync('git', ['-C', repoPath, 'rev-parse', 'refs/heads/agenthub/multi-1'], { encoding: 'utf8', env: testEnv }).trim();
      // Precache pass for t1
      const { setCachedAuditPass } = await import('../src/pre-publish-audit.js');
      setCachedAuditPass('proj-multi-audit/t1', t1Commit, {
        verdict: 'pass',
        findings: [],
        summary: 't1 clean',
      });

      // Now set FAKE_MODE='audit-fail' so t2 fails
      process.env.FAKE_MODE = 'audit-fail';
      const result = await ctx.service.publishTask('proj-multi-audit/t1');
      expect(result.ok).toBe(false);
      expect((result as any).auditFailed).toBe(true);

      // Verify remote did not receive any commits
      const remoteLog = execFileSync('git', ['--git-dir', remotePath, 'log', 'main', '--oneline'], {
        encoding: 'utf8',
        env: testEnv,
      });
      expect(remoteLog).not.toContain('multi 1 clean');
      expect(remoteLog).not.toContain('multi 2 bug');

      // Task 2 was returned to worker
      const updatedT2 = ctx.taskRepo.get('proj-multi-audit/t2');
      expect(updatedT2?.status).toBe('queued');
    });

    it('cached pass avoids re-running audit engine for same commitSha', async () => {
      const remotePath = path.join(tmpDir, 'remote-cache.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-cache');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/cached-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'cache.txt'), 'cached\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: cache test'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-cache',
        name: 'Project Cache',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-cache/task-cache',
        projectId: 'proj-cache',
        slug: 'cached-task',
        title: 'Cached Task',
        status: 'done',
        branch: 'agenthub/cached-task',
        baseRef: 'main',
      });

      // First run: audit-pass
      process.env.FAKE_MODE = 'audit-pass';
      const res1 = await ctx.service.publishTask('proj-cache/task-cache');
      expect(res1.ok).toBe(true);

      // Reset task to 'done' so we can publish again
      ctx.taskRepo.update('proj-cache/task-cache', { status: 'done', pushResult: null });

      // Change FAKE_MODE to 'audit-fail'. Because the pass is cached for (taskId, commitSha),
      // it must use cache and still succeed!
      process.env.FAKE_MODE = 'audit-fail';
      const res2 = await ctx.service.publishTask('proj-cache/task-cache');
      expect(res2.ok).toBe(true);
    });

    it('audit agent crash or corrupted JSON output -> fails closed (retryable: true, does not return task to worker)', async () => {
      const remotePath = path.join(tmpDir, 'remote-crash.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-crash');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/crash-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'crash.txt'), 'content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: crash test'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-crash',
        name: 'Project Crash',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-crash/task-crash',
        projectId: 'proj-crash',
        slug: 'crash-task',
        title: 'Crash Task',
        status: 'done',
        branch: 'agenthub/crash-task',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-error';
      const res = await ctx.service.publishTask('proj-crash/task-crash');
      expect(res.ok).toBe(false);
      expect((res as any).auditFailed).toBe(true);

      const updated = ctx.taskRepo.get('proj-crash/task-crash');
      // Task remains in done (NOT queued, NOT returned to worker because failure was engine crash)
      expect(updated?.status).toBe('done');
      const pushResult = JSON.parse(updated!.pushResult!);
      expect(pushResult.retryable).toBe(true);
      expect(pushResult.error).toContain('Audit agent gặp lỗi');
    });

    it('exceeding maxFixRounds halts without returning to worker', async () => {
      const remotePath = path.join(tmpDir, 'remote-maxrounds.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-maxrounds');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/maxrounds-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'rounds.txt'), 'content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: max rounds test'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-maxrounds',
        name: 'Project Max Rounds',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-maxrounds/task-max',
        projectId: 'proj-maxrounds',
        slug: 'maxrounds-task',
        title: 'Max Rounds Task',
        status: 'done',
        branch: 'agenthub/maxrounds-task',
        baseRef: 'main',
      });
      ctx.reviewRepo.insert({
        id: 'rev-audit-1',
        taskId: 'proj-maxrounds/task-max',
        verdict: 'changes_requested',
        actor: 'audit-prepublish',
      });
      ctx.reviewRepo.insert({
        id: 'rev-audit-2',
        taskId: 'proj-maxrounds/task-max',
        verdict: 'changes_requested',
        actor: 'audit-prepublish',
      });
      ctx.taskRepo.update('proj-maxrounds/task-max', {
        reviewerChangesRequested: 2,
        pushResult: JSON.stringify({ auditFixRounds: 2 }),
      });

      process.env.FAKE_MODE = 'audit-fail';
      const res = await ctx.service.publishTask('proj-maxrounds/task-max');
      expect(res.ok).toBe(false);
      expect((res as any).auditFailed).toBe(true);
      expect((res as any).error).toContain('vượt quá số vòng sửa tối đa (2)');

      const updated = ctx.taskRepo.get('proj-maxrounds/task-max');
      // Must NOT be returned to worker (remains done)
      expect(updated?.status).toBe('done');
      expect(updated?.reviewerChangesRequested).toBe(2);
    });

    it('manual publish with skipAudit: true bypasses audit gate and pushes', async () => {
      const remotePath = path.join(tmpDir, 'remote-skip.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-skip');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/skip-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'skip.txt'), 'bypass audit\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: bypass audit test'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-skip',
        name: 'Project Skip',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-skip/task-skip',
        projectId: 'proj-skip',
        slug: 'skip-task',
        title: 'Skip Task',
        status: 'done',
        branch: 'agenthub/skip-task',
        baseRef: 'main',
      });

      const events: Array<{ type: string; payload: any }> = [];
      ctx.scheduler.getEventBus().on('task.audit_skipped', (_id, p) => events.push({ type: 'task.audit_skipped', payload: p }));
      ctx.scheduler.getEventBus().on('task.pushed', (_id, p) => events.push({ type: 'task.pushed', payload: p }));

      // Set FAKE_MODE='audit-fail' so if audit ran, it would fail
      process.env.FAKE_MODE = 'audit-fail';

      // 1. Non-manual call with skipAudit: true must ignore skipAudit and FAIL
      const nonManualRes = await ctx.service.publishTask('proj-skip/task-skip', { manual: false, skipAudit: true });
      expect(nonManualRes.ok).toBe(false);
      expect((nonManualRes as any).auditFailed).toBe(true);

      // Reset task to 'done' for manual publish
      ctx.taskRepo.update('proj-skip/task-skip', { status: 'done', pushResult: null, reviewerChangesRequested: 0 });

      // 2. Manual publish via API endpoint with skipAudit: true
      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/proj-skip~task-skip/publish',
        headers: authHeaders(),
        payload: { skipAudit: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.auditSkipped).toBe(true);

      const updated = ctx.taskRepo.get('proj-skip/task-skip');
      expect(updated?.status).toBe('pushed');
      const pushResult = JSON.parse(updated!.pushResult!);
      expect(pushResult.auditSkipped).toBe(true);

      expect(events.some((e) => e.type === 'task.audit_skipped')).toBe(true);
      expect(events.some((e) => e.type === 'task.pushed')).toBe(true);
    });

    it('audit uses merge commit diff and commitSha when task branch is deleted', async () => {
      const remotePath = path.join(tmpDir, 'remote-deleted-branch.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-deleted-branch');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/deleted-branch-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'del-feature.txt'), 'feature content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: feature with deleted branch'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/deleted-branch-task', '-m', "Merge branch 'agenthub/deleted-branch-task' into main"], { cwd: repoPath, env: testEnv });
      const mergeCommitSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

      // Delete the branch completely
      execFileSync('git', ['branch', '-D', 'agenthub/deleted-branch-task'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-deleted-branch',
        name: 'Project Deleted Branch',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-deleted-branch/task-del',
        projectId: 'proj-deleted-branch',
        slug: 'deleted-branch-task',
        title: 'Deleted Branch Task',
        status: 'done',
        branch: 'agenthub/deleted-branch-task',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-pass';
      const res = await ctx.service.publishTask('proj-deleted-branch/task-del');
      expect(res.ok).toBe(true);

      // Verify that audit result was cached under the merge commit SHA!
      const { getCachedAuditPass } = await import('../src/pre-publish-audit.js');
      const cached = getCachedAuditPass('proj-deleted-branch/task-del', mergeCommitSha);
      expect(cached).toBeDefined();
      expect(cached?.verdict).toBe('pass');
    });

    it('independent audit fix rounds: task with prior reviewer changes still gets audit fix chances', async () => {
      const remotePath = path.join(tmpDir, 'remote-indep-rounds.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-indep-rounds');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/indep-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'indep.txt'), 'indep feature\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: indep feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/indep-task', '-m', "Merge branch 'agenthub/indep-task' into main"], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-indep',
        name: 'Project Indep Rounds',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-indep/task-indep',
        projectId: 'proj-indep',
        slug: 'indep-task',
        title: 'Indep Task',
        status: 'done',
        branch: 'agenthub/indep-task',
        baseRef: 'main',
      });
      // Task already had 2 rounds of standard reviewer changes
      ctx.taskRepo.update('proj-indep/task-indep', { reviewerChangesRequested: 2 });

      process.env.FAKE_MODE = 'audit-fail';
      const res = await ctx.service.publishTask('proj-indep/task-indep');
      expect(res.ok).toBe(false);
      expect((res as any).auditFailed).toBe(true);

      const updated = ctx.taskRepo.get('proj-indep/task-indep');
      // Must be returned to worker (queued) for its FIRST audit fix round despite reviewerChangesRequested == 2
      expect(updated?.status).toBe('queued');
      const pushResult = JSON.parse(updated!.pushResult!);
      expect(pushResult.auditFixRounds).toBe(1);
    });
  });
});
