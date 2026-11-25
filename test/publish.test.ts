import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import { buildGitUrls, clearPublishLocks, normalizePublishErrorKey } from '../src/publish.js';
import { clearAuditPassCache } from '../src/pre-publish-audit.js';
import { toRouteId } from '../src/services/index.js';
import { NotificationService } from '../src/notify.js';
import { HttpError } from '../src/errors.js';
import { projectSettings } from '../src/projects/settings.js';

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
    clearPublishLocks();
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

    // Switch repo back to main and make it DIRTY (modify tracked file and untracked file)
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
    const initialHead = execFileSync('git', ['rev-parse', 'main'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# modified tracked work\n');
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
    expect((result as any).localUpdate).toBe('skipped_dirty');

    // Verify task is pushed with skipped_dirty
    const updated = ctx.taskRepo.get(task.id);
    expect(updated?.status).toBe('pushed');
    const pushResult = JSON.parse(updated!.pushResult!);
    expect(pushResult.localUpdate).toBe('skipped_dirty');

    // Remote received the commit
    const remoteHead = execFileSync('git', ['--git-dir', remotePath, 'rev-parse', 'main'], { encoding: 'utf8', env: testEnv }).trim();
    expect(remoteHead).toBe(pushResult.commit);
    expect(remoteHead).not.toBe(initialHead);

    // Local main branch pointer was NOT touched
    const localHead = execFileSync('git', ['rev-parse', 'main'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();
    expect(localHead).toBe(initialHead);

    // User's uncommitted work is intact
    expect(fs.readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('# modified tracked work\n');
    expect(fs.readFileSync(path.join(repoPath, 'uncommitted.txt'), 'utf8')).toBe('dirty uncommitted work\n');
  });

  it('nhánh đích đang checkout và sạch → sau publish, HEAD và file trong thư mục đều khớp commit đã push', async () => {
    const remotePath = path.join(tmpDir, 'remote-clean-checkout.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo-clean-checkout');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    // Create a feature branch
    execFileSync('git', ['checkout', '-b', 'agenthub/clean-feat'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'clean-file.txt'), 'feature content\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: clean commit'], { cwd: repoPath, env: testEnv });

    // Switch repo back to main; add an untracked file (which should be ignored by -uno)
    execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'ignored-untracked.txt'), 'untracked note\n');

    ctx.service.createProject({
      id: 'proj-clean-checkout',
      name: 'Project Clean Checkout',
      path: repoPath,
      defaultBranch: 'main',
    });

    ctx.taskRepo.insert({
      id: 'proj-clean-checkout/t1',
      projectId: 'proj-clean-checkout',
      slug: 'clean-feat',
      title: 'Clean Feature',
      status: 'done',
      branch: 'agenthub/clean-feat',
      baseRef: 'main',
    });
    const task = ctx.taskRepo.get('proj-clean-checkout/t1')!;

    const result = await ctx.service.publishTask(task.id);
    expect(result.ok).toBe(true);
    expect((result as any).localUpdate).toBe('updated');

    const updated = ctx.taskRepo.get(task.id);
    expect(updated?.status).toBe('pushed');
    const pushResult = JSON.parse(updated!.pushResult!);
    expect(pushResult.localUpdate).toBe('updated');

    // Local HEAD updated to pushed commit
    const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();
    expect(localHead).toBe(pushResult.commit);

    // Files on disk match the new commit
    expect(fs.existsSync(path.join(repoPath, 'clean-file.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, 'clean-file.txt'), 'utf8')).toBe('feature content\n');

    // Untracked file remains untouched
    expect(fs.existsSync(path.join(repoPath, 'ignored-untracked.txt'))).toBe(true);

    // Tracked git status is completely clean
    const status = execFileSync('git', ['status', '--porcelain', '-uno'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();
    expect(status).toBe('');
  });

  it('nhánh đích không checkout → update-ref như cũ', async () => {
    const remotePath = path.join(tmpDir, 'remote-not-checkout.git');
    initBareRemote(remotePath);

    const repoPath = path.join(tmpDir, 'local-repo-not-checkout');
    initGitRepoWithRemote(repoPath, remotePath, 'main');

    // Create a feature branch
    execFileSync('git', ['checkout', '-b', 'agenthub/feat-not-checkout'], { cwd: repoPath, env: testEnv });
    fs.writeFileSync(path.join(repoPath, 'file-nc.txt'), 'not checkout\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
    execFileSync('git', ['commit', '-m', 'feat: nc commit'], { cwd: repoPath, env: testEnv });

    // Switch repo to a completely different branch (develop)
    execFileSync('git', ['checkout', '-b', 'develop'], { cwd: repoPath, env: testEnv });
    const developHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();

    ctx.service.createProject({
      id: 'proj-not-checkout',
      name: 'Project Not Checkout',
      path: repoPath,
      defaultBranch: 'main',
    });

    ctx.taskRepo.insert({
      id: 'proj-not-checkout/t1',
      projectId: 'proj-not-checkout',
      slug: 'feat-not-checkout',
      title: 'Feat Not Checkout',
      status: 'done',
      branch: 'agenthub/feat-not-checkout',
      baseRef: 'main',
    });
    const task = ctx.taskRepo.get('proj-not-checkout/t1')!;

    const result = await ctx.service.publishTask(task.id);
    expect(result.ok).toBe(true);
    expect((result as any).localUpdate).toBe('updated');

    const pushResult = JSON.parse(ctx.taskRepo.get(task.id)!.pushResult!);
    expect(pushResult.localUpdate).toBe('updated');

    // main ref was updated
    const mainRef = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();
    expect(mainRef).toBe(pushResult.commit);

    // Current branch remains develop and unchanged
    const currentBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();
    expect(currentBranch).toBe('develop');
    const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, env: testEnv, encoding: 'utf8' }).trim();
    expect(currentHead).toBe(developHead);
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

    // Manual POST /api/tasks/:id/publish returns 202 and starts background publish
    const res = await server.inject({
      method: 'POST',
      url: `/api/tasks/${toRouteId(task.id)}/publish`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.started).toBe(true);

    await vi.waitFor(() => {
      const updated = ctx.taskRepo.get(task.id);
      expect(updated?.status).toBe('pushed');
    }, { timeout: 15000, interval: 50 });
  });

  it('từ chối publish đồng thời cho cùng một project mà không xếp hàng thêm', async () => {
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
    const results = await Promise.allSettled([
      ctx.service.publishTask(task1.id),
      ctx.service.publishTask(task2.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('đang trong quá trình publish');
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

    it('P2-only audit does not block: pushes and queues one follow-up task, which never spawns another', async () => {
      const remotePath = path.join(tmpDir, 'remote-audit-p2.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-audit-p2');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/audit-task-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'pass.txt'), 'clean code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: clean feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-audit-p2',
        name: 'Project Audit P2',
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
        id: 'proj-audit-p2/task-1',
        projectId: 'proj-audit-p2',
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

      process.env.FAKE_MODE = 'audit-p2';
      const result = await ctx.service.publishTask('proj-audit-p2/task-1');
      expect(result.ok).toBe(true);

      const updated = ctx.taskRepo.get('proj-audit-p2/task-1');
      expect(updated?.status).toBe('pushed');
      const pushResult = JSON.parse(updated!.pushResult!);
      expect(pushResult.auditPassed).toBe(true);
      expect(pushResult.auditSkipped).toBe(false);

      expect(pushResult.findings).toHaveLength(1);
      expect(pushResult.findings[0].severity).toBe('P2');

      const followUp = ctx.taskRepo.get('proj-audit-p2/audit-task-1-audit-followup');
      expect(['queued', 'running']).toContain(followUp?.status);
      expect(followUp?.level).toBe('easy');
      expect(followUp?.body).toContain('src/util.ts:7');
      expect(followUp?.body).toContain('Default changed without updating one caller');

      // No duplicate for the same source, and a follow-up never gets its own follow-up.
      const finding = [{ severity: 'P2', kind: 'regression_risk', file: 'a.ts', line: 1, detail: 'x' }];
      expect(ctx.service.createAuditFollowUpTask(updated!, finding)).toBeNull();
      expect(ctx.service.createAuditFollowUpTask(followUp!, finding)).toBeNull();
    });

    it('a successful audit whose log mentions rate limit / 429 still passes and pushes', async () => {
      const remotePath = path.join(tmpDir, 'remote-audit-limit.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-audit-limit');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/audit-task-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'pass.txt'), 'clean code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: clean feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-audit-limit',
        name: 'Project Audit Limit',
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
        id: 'proj-audit-limit/task-1',
        projectId: 'proj-audit-limit',
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

      process.env.FAKE_MODE = 'audit-pass-mentions-limit';
      const result = await ctx.service.publishTask('proj-audit-limit/task-1');
      expect(result.ok).toBe(true);

      const updated = ctx.taskRepo.get('proj-audit-limit/task-1');
      expect(updated?.status).toBe('pushed');
      const pushResult = JSON.parse(updated!.pushResult!);
      expect(pushResult.auditPassed).toBe(true);
      expect(pushResult.auditSkipped).toBe(false);

      expect(events.some((e) => e.type === 'task.audit_started')).toBe(true);
      expect(events.some((e) => e.type === 'task.audit_passed')).toBe(true);
      expect(events.some((e) => e.type === 'task.pushed')).toBe(true);
    });

    it('a quota failure on the first reviewer profile fails over to the next profile and blocks the first until its reported reset', async () => {
      const remotePath = path.join(tmpDir, 'remote-audit-failover.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-audit-failover');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/audit-task-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'pass.txt'), 'clean code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: clean feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-audit-failover',
        name: 'Project Audit Failover',
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
        id: 'proj-audit-failover/task-1',
        projectId: 'proj-audit-failover',
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

      ctx.profileRepo.upsert({
        name: 'codex-a-exhausted',
        engine: 'codex',
        kind: 'codex',
        home: path.join(tmpDir, 'codex-home-exhausted'),
        email: 'exhausted@example.com',
        enabled: 1,
      });
      process.env.FAKE_MODE = 'audit-quota-first-profile';
      const result = await ctx.service.publishTask('proj-audit-failover/task-1');
      expect(result.ok).toBe(true);

      const updated = ctx.taskRepo.get('proj-audit-failover/task-1');
      expect(updated?.status).toBe('pushed');
      const pushResult = JSON.parse(updated!.pushResult!);
      expect(pushResult.auditPassed).toBe(true);
      expect(pushResult.auditSkipped).toBe(false);

      expect(events.some((e) => e.type === 'task.audit_started')).toBe(true);
      expect(events.some((e) => e.type === 'task.audit_passed')).toBe(true);
      expect(events.some((e) => e.type === 'task.pushed')).toBe(true);
      const mark = ctx.quotaMarkRepo.getActive().find((m) => m.profileName === 'codex-a-exhausted' && m.family === 'codex');
      expect(mark).toBeDefined();
      // Blocked until the reset Codex reported (year 2099), not for 5 minutes.
      expect(mark!.until - Math.floor(Date.now() / 1000)).toBeGreaterThan(365 * 24 * 3600);
      expect(ctx.quotaMarkRepo.getActive().some((m) => m.profileName === 'codex-publish-tester')).toBe(false);
    });

    it('a failed audit run with a usage-limit error is still reported as reviewer quota', async () => {
      const remotePath = path.join(tmpDir, 'remote-audit-quota.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-audit-quota');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/audit-task-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'pass.txt'), 'clean code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: clean feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-audit-quota',
        name: 'Project Audit Quota',
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
        id: 'proj-audit-quota/task-1',
        projectId: 'proj-audit-quota',
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

      process.env.FAKE_MODE = 'audit-quota';
      const result = await ctx.service.publishTask('proj-audit-quota/task-1');
      expect(result.ok).toBe(false);

      const updated = ctx.taskRepo.get('proj-audit-quota/task-1');
      expect(updated?.status).toBe('done');
      expect(updated?.pushResult ?? '').toContain('Hết quota reviewer khi audit trước khi publish');
      expect(events.some((e) => e.type === 'task.pushed')).toBe(false);
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

      // Task 1 was the one being published: must be marked blocked by task 2 without auditFailed
      const updatedT1 = ctx.taskRepo.get('proj-multi-audit/t1');
      expect(updatedT1?.status).toBe('done');
      const pr1 = JSON.parse(updatedT1!.pushResult!);
      expect(pr1.auditFailed).toBeUndefined();
      expect(pr1.blockedByTask).toBe('multi-2');
      expect(pr1.error).toContain('multi-2');

      // Now fix task 2 and publish again: both task 1 and task 2 should become 'pushed'
      process.env.FAKE_MODE = 'audit-pass';
      ctx.taskRepo.update('proj-multi-audit/t2', { status: 'done', reviewerChangesRequested: 0 });
      const retryRes = await ctx.service.publishTask('proj-multi-audit/t2');
      expect(retryRes.ok).toBe(true);

      const pushedT1 = ctx.taskRepo.get('proj-multi-audit/t1');
      const pushedT2 = ctx.taskRepo.get('proj-multi-audit/t2');
      expect(pushedT1?.status).toBe('pushed');
      expect(pushedT2?.status).toBe('pushed');
      const pr1After = JSON.parse(pushedT1!.pushResult!);
      expect(pr1After.state).toBe('pushed');
      expect(pr1After.blockedByTask).toBeUndefined();
      expect(pr1After.error).toBeUndefined();
    });

    it('ghi các finding P3 của audit pass vào pushResult khi push thành công', async () => {
      const remotePath = path.join(tmpDir, 'remote-p3-findings.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-p3-findings');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/p3-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'p3.txt'), 'p3 feature\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: p3 feature'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/p3-task', '-m', "Merge branch 'agenthub/p3-task' into main"], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-p3',
        name: 'Project P3 Findings',
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
        id: 'proj-p3/task-p3',
        projectId: 'proj-p3',
        slug: 'p3-task',
        title: 'P3 Task',
        status: 'done',
        branch: 'agenthub/p3-task',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-p3';
      const res = await ctx.service.publishTask('proj-p3/task-p3');
      expect(res.ok).toBe(true);
      expect((res as any).findings).toHaveLength(1);
      expect((res as any).findings[0].severity).toBe('P3');

      const updated = ctx.taskRepo.get('proj-p3/task-p3');
      expect(updated?.status).toBe('pushed');
      const pr = JSON.parse(updated!.pushResult!);
      expect(pr.auditPassed).toBe(true);
      expect(pr.findings).toHaveLength(1);
      expect(pr.findings[0].severity).toBe('P3');
      expect(pr.findings[0].file).toBe('README.md');
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
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.started).toBe(true);

      await vi.waitFor(() => {
        const updated = ctx.taskRepo.get('proj-skip/task-skip');
        expect(updated?.status).toBe('pushed');
        const pushResult = JSON.parse(updated!.pushResult!);
        expect(pushResult.auditSkipped).toBe(true);
      }, { timeout: 15000, interval: 50 });

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
      expect(res.ok).toBe(false);
      expect((res as any).error).toMatch(/publish snapshot|audit/i);

      // A deleted task branch cannot be inferred from the merge message alone.
      const { getCachedAuditPass } = await import('../src/pre-publish-audit.js');
      expect(getCachedAuditPass('proj-deleted-branch/task-del', mergeCommitSha)).toBeUndefined();
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

    it('2 task merge tuần tự (A rồi B, nhánh task vẫn còn) -> A được audit bằng diff của merge A', async () => {
      const { findMergeCommitForTask, getTaskDiff } = await import('../src/publish.js');
      const remotePath = path.join(tmpDir, 'remote-seq-merges.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-seq-merges');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Create integration branch from main
      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });

      // Task A: create branch, commit, merge into integration
      execFileSync('git', ['checkout', '-b', 'agenthub/seq-a'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file-a.txt'), 'content A\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: seq A'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/seq-a', '-m', "Merge branch 'agenthub/seq-a' into agenthub/integration"], { cwd: repoPath, env: testEnv });
      const mergeASha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

      // Task B: create branch from integration, commit, merge into integration
      execFileSync('git', ['checkout', '-b', 'agenthub/seq-b'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file-b.txt'), 'content B\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: seq B'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/seq-b', '-m', "Merge branch 'agenthub/seq-b' into agenthub/integration"], { cwd: repoPath, env: testEnv });
      const mergeBSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

      expect(mergeASha).not.toBe(mergeBSha);

      // Verify task branches still exist
      const branchesOut = execFileSync('git', ['-C', repoPath, 'branch'], { encoding: 'utf8', env: testEnv });
      expect(branchesOut).toContain('agenthub/seq-a');
      expect(branchesOut).toContain('agenthub/seq-b');

      const taskA: any = {
        id: 'proj/task-a',
        projectId: 'proj',
        slug: 'seq-a',
        title: 'Task A',
        branch: 'agenthub/seq-a',
      };
      const taskB: any = {
        id: 'proj/task-b',
        projectId: 'proj',
        slug: 'seq-b',
        title: 'Task B',
        branch: 'agenthub/seq-b',
      };

      // 1. findMergeCommitForTask for Task A must return mergeA, NOT mergeB
      const foundMergeA = await findMergeCommitForTask(repoPath, taskA, ['agenthub/integration'], testEnv);
      expect(foundMergeA).toBe(mergeASha);

      // 2. getTaskDiff for Task A must use mergeA diff
      const diffA = await getTaskDiff(repoPath, taskA, 'agenthub/integration', 'main', 'main', testEnv);
      expect(diffA.commitSha).toBe(mergeASha);
      expect(diffA.changedFiles).toEqual(['file-a.txt']);
      expect(diffA.diff).toContain('content A');
      expect(diffA.diff).not.toContain('content B');

      // 3. findMergeCommitForTask and getTaskDiff for Task B must return mergeB
      const foundMergeB = await findMergeCommitForTask(repoPath, taskB, ['agenthub/integration'], testEnv);
      expect(foundMergeB).toBe(mergeBSha);
      const diffB = await getTaskDiff(repoPath, taskB, 'agenthub/integration', 'main', 'main', testEnv);
      expect(diffB.commitSha).toBe(mergeBSha);
      // Khi mốc gốc là main (chưa có task A), diff của task B (rẽ từ integration đã có A) chứa cả file-a và file-b
      expect(diffB.changedFiles).toEqual(expect.arrayContaining(['file-a.txt', 'file-b.txt']));
      expect(diffB.diff).toContain('content B');
      expect(diffB.diff).toContain('content A');
    });

    it('findMergeCommitForTask fallback --grep không khớp chuỗi con (t-foo không khớp t-foo-fix)', async () => {
      const { findMergeCommitForTask } = await import('../src/publish.js');
      const repoPath = path.join(tmpDir, 'local-repo-grep-boundary');
      fs.mkdirSync(repoPath, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'README.md'), '# Base\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });

      // First merge: t-foo-fix
      execFileSync('git', ['checkout', '-b', 'agenthub/t-foo-fix'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'fix.txt'), 'fix\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: t-foo-fix'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/t-foo-fix', '-m', "Merge branch 'agenthub/t-foo-fix' into agenthub/integration"], { cwd: repoPath, env: testEnv });
      const mergeFixSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

      // Second merge: t-foo
      execFileSync('git', ['checkout', '-b', 'agenthub/t-foo'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'foo.txt'), 'foo\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: t-foo'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/t-foo', '-m', "Merge branch 'agenthub/t-foo' into agenthub/integration"], { cwd: repoPath, env: testEnv });
      const mergeFooSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

      // Delete local branches so findMergeCommitForTask is forced to use commit message grep fallback
      execFileSync('git', ['branch', '-D', 'agenthub/t-foo-fix'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['branch', '-D', 'agenthub/t-foo'], { cwd: repoPath, env: testEnv });

      const taskFoo = {
        id: 'proj/t-foo',
        projectId: 'proj',
        slug: 't-foo',
        title: 'Task Foo',
        branch: 'agenthub/t-foo',
      } as unknown as import('../src/db/index.js').TaskRow;

      const foundMerge = await findMergeCommitForTask(repoPath, taskFoo, ['agenthub/integration'], testEnv);
      // Must find mergeFooSha, NOT the older mergeFixSha!
      expect(foundMerge).toBe(mergeFooSha);
      expect(foundMerge).not.toBe(mergeFixSha);
    });

    it('mô phỏng task B merge vào trong lúc audit A đang chạy -> B không bị đẩy theo A; sau đó B được audit và publish', async () => {
      const remotePath = path.join(tmpDir, 'remote-race-publish.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-race-publish');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Create integration branch from main
      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });

      // Create and merge Task A into integration before project creation
      execFileSync('git', ['checkout', '-b', 'agenthub/task-a'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file-a.txt'), 'Task A code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task A'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/task-a', '-m', "Merge branch 'agenthub/task-a' into agenthub/integration"], { cwd: repoPath, env: testEnv });

      // Prepare Task B branch
      execFileSync('git', ['checkout', '-b', 'agenthub/task-b'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file-b.txt'), 'Task B code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task B'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-race',
        name: 'Project Race Test',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: true, branch: 'agenthub/integration' },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-race/task-a',
        projectId: 'proj-race',
        slug: 'task-a',
        title: 'Task A',
        status: 'done',
        branch: 'agenthub/task-a',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'proj-race/task-b',
        projectId: 'proj-race',
        slug: 'task-b',
        title: 'Task B',
        status: 'done',
        branch: 'agenthub/task-b',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-pass';

      let taskBMergedDuringAudit = false;
      let remoteCommitsAfterA = '';
      const integWorktree = path.join(config.hubHome, 'integration', 'proj-race');

      // When audit for Task A starts: merge Task B into integration and trigger auto-publish for B
      ctx.scheduler.getEventBus().on('task.audit_started', async (_id, p) => {
        if (p.taskId === 'proj-race/task-a' && !taskBMergedDuringAudit) {
          taskBMergedDuringAudit = true;
          // Merge Task B into integration worktree now!
          execFileSync('git', ['merge', '--no-ff', 'agenthub/task-b', '-m', "Merge branch 'agenthub/task-b' into agenthub/integration"], { cwd: integWorktree, env: testEnv });

          // Trigger auto-publish for B (should get 409 because A is publishing, and get queued)
          ctx.service.enqueueAutoPublish('proj-race', 'proj-race/task-b');
        }
      });

      // Listen for when A is pushed
      ctx.scheduler.getEventBus().on('task.pushed', async (_id, p) => {
        if (p.taskId === 'proj-race/task-a') {
          // Immediately inspect remote main right after A is pushed
          remoteCommitsAfterA = execFileSync('git', ['--git-dir', remotePath, 'log', '--oneline', 'main'], { encoding: 'utf8', env: testEnv });
        }
      });

      // Start publishing Task A
      const resultA = await ctx.service.publishTask('proj-race/task-a');
      expect(resultA.ok).toBe(true);

      // Verify Task A was pushed
      const taskAAfter = ctx.taskRepo.get('proj-race/task-a');
      expect(taskAAfter?.status).toBe('pushed');

      // Verify that when A was pushed, Task B was NOT included on remote main!
      expect(remoteCommitsAfterA).toContain('feat: task A');
      expect(remoteCommitsAfterA).not.toContain('feat: task B');

      // Now wait for Task B's queued publish to complete
      await vi.waitFor(() => {
        const taskBAfter = ctx.taskRepo.get('proj-race/task-b');
        expect(taskBAfter?.status).toBe('pushed');
      }, { timeout: 15000, interval: 50 });

      // Verify remote main now contains Task B as well
      const remoteCommitsFinal = execFileSync('git', ['--git-dir', remotePath, 'log', '--oneline', 'main'], { encoding: 'utf8', env: testEnv });
      expect(remoteCommitsFinal).toContain('feat: task B');
    });

    it('chế độ không integration: Task B merge vào main local trong lúc audit Task A đang chạy -> B không bị đẩy theo A; sau đó B được audit và publish', async () => {
      const remotePath = path.join(tmpDir, 'remote-no-integ-race.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-no-integ-race');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Prepare Task A branch and merge it into main local
      execFileSync('git', ['checkout', '-b', 'agenthub/task-a'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file-a.txt'), 'Task A code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task A'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/task-a', '-m', "Merge branch 'agenthub/task-a' into main"], { cwd: repoPath, env: testEnv });

      // Prepare Task B branch (not yet merged into main)
      execFileSync('git', ['checkout', '-b', 'agenthub/task-b'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file-b.txt'), 'Task B code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task B'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-no-integ-race',
        name: 'Project No Integ Race',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: false },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true, maxFixRounds: 2 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-no-integ-race/task-a',
        projectId: 'proj-no-integ-race',
        slug: 'task-a',
        title: 'Task A',
        status: 'done',
        branch: 'agenthub/task-a',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'proj-no-integ-race/task-b',
        projectId: 'proj-no-integ-race',
        slug: 'task-b',
        title: 'Task B',
        status: 'done',
        branch: 'agenthub/task-b',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-pass';

      let taskBMergedDuringAudit = false;
      let remoteCommitsAfterA = '';

      // When audit for Task A starts: merge Task B into main local and enqueue auto-publish for B
      ctx.scheduler.getEventBus().on('task.audit_started', async (_id, p) => {
        if (p.taskId === 'proj-no-integ-race/task-a' && !taskBMergedDuringAudit) {
          taskBMergedDuringAudit = true;
          // Merge Task B into main local now while A's audit is running!
          execFileSync('git', ['merge', '--no-ff', 'agenthub/task-b', '-m', "Merge branch 'agenthub/task-b' into main"], { cwd: repoPath, env: testEnv });

          // Trigger auto-publish for B (queued due to publish lock)
          ctx.service.enqueueAutoPublish('proj-no-integ-race', 'proj-no-integ-race/task-b');
        }
      });

      // Listen for when A is pushed
      ctx.scheduler.getEventBus().on('task.pushed', async (_id, p) => {
        if (p.taskId === 'proj-no-integ-race/task-a') {
          // Inspect remote main right after A is pushed
          remoteCommitsAfterA = execFileSync('git', ['--git-dir', remotePath, 'log', '--oneline', 'main'], { encoding: 'utf8', env: testEnv });
        }
      });

      // Start publishing Task A
      const resultA = await ctx.service.publishTask('proj-no-integ-race/task-a');
      expect(resultA.ok).toBe(true);

      // Verify Task A was pushed
      const taskAAfter = ctx.taskRepo.get('proj-no-integ-race/task-a');
      expect(taskAAfter?.status).toBe('pushed');

      // Verify that when A was pushed, Task B was NOT included on remote main!
      expect(remoteCommitsAfterA).toContain('feat: task A');
      expect(remoteCommitsAfterA).not.toContain('feat: task B');

      // Now wait for Task B's queued publish to complete with audit
      await vi.waitFor(() => {
        const taskBAfter = ctx.taskRepo.get('proj-no-integ-race/task-b');
        expect(taskBAfter?.status).toBe('pushed');
      }, { timeout: 15000, interval: 50 });

      // Verify remote main now contains Task B as well
      const remoteCommitsFinal = execFileSync('git', ['--git-dir', remotePath, 'log', '--oneline', 'main'], { encoding: 'utf8', env: testEnv });
      expect(remoteCommitsFinal).toContain('feat: task B');
    });

    it('fail-closed khi cả nhánh đích local lẫn remote đều không tồn tại', async () => {
      const remotePath = path.join(tmpDir, 'remote-no-target-branch.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-no-target-branch');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Neither local nor remote 'production' branch exists.
      // Create task branch
      execFileSync('git', ['checkout', '-b', 'agenthub/task-init'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file-init.txt'), 'initial commit\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: initial audited code'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-no-target',
        name: 'Project No Target',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: false },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'production',
            audit: { enabled: true },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-no-target/task-init',
        projectId: 'proj-no-target',
        slug: 'task-init',
        title: 'Task Init',
        status: 'done',
        branch: 'agenthub/task-init',
        baseRef: 'production',
      });

      process.env.FAKE_MODE = 'audit-pass';

      let commitAddedDuringAudit = false;
      ctx.scheduler.getEventBus().on('task.audit_started', async (_id, p) => {
        if (p.taskId === 'proj-no-target/task-init' && !commitAddedDuringAudit) {
          commitAddedDuringAudit = true;
          // Commit added to agenthub/task-init during audit
          fs.writeFileSync(path.join(repoPath, 'file-uncommitted-audit.txt'), 'late change\n');
          execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
          execFileSync('git', ['commit', '-m', 'feat: late change after snapshot'], { cwd: repoPath, env: testEnv });
        }
      });

      const res = await ctx.service.publishTask('proj-no-target/task-init');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/Failed to resolve remote base commit/);
      }

      const updated = ctx.taskRepo.get('proj-no-target/task-init');
      expect(updated?.pushResult).toContain('Failed to resolve remote base commit');
    });

    it('chế độ không integration: task đã thực sự nằm trong commit đã push và đã audit được đánh dấu pushed', async () => {
      const remotePath = path.join(tmpDir, 'remote-batch-no-integ.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-batch-no-integ');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Task 1 and Task 2 both merged into main local before publish
      execFileSync('git', ['checkout', '-b', 'agenthub/task-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'f1.txt'), 'f1\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task 1'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/task-1', '-m', "Merge branch 'agenthub/task-1' into main"], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', '-b', 'agenthub/task-2'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'f2.txt'), 'f2\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task 2'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/task-2', '-m', "Merge branch 'agenthub/task-2' into main"], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-batch-no-integ',
        name: 'Project Batch No Integ',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: false },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-batch-no-integ/task-1',
        projectId: 'proj-batch-no-integ',
        slug: 'task-1',
        title: 'Task 1',
        status: 'done',
        branch: 'agenthub/task-1',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'proj-batch-no-integ/task-2',
        projectId: 'proj-batch-no-integ',
        slug: 'task-2',
        title: 'Task 2',
        status: 'done',
        branch: 'agenthub/task-2',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-pass';

      // Publish task-2 (which also contains task-1 in local main snapshot)
      const res = await ctx.service.publishTask('proj-batch-no-integ/task-2');
      expect(res.ok).toBe(true);

      const t1 = ctx.taskRepo.get('proj-batch-no-integ/task-1');
      const t2 = ctx.taskRepo.get('proj-batch-no-integ/task-2');
      expect(t1?.status).toBe('pushed');
      expect(t2?.status).toBe('pushed');
      expect(JSON.parse(t1!.pushResult!).auditPassed).toBe(true);
      expect(JSON.parse(t2!.pushResult!).auditPassed).toBe(true);
    });

    it('verdict fail + findings rỗng -> không push, retryable, task không bị trả về', async () => {
      const remotePath = path.join(tmpDir, 'remote-fail-empty.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-fail-empty');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/fail-empty-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'empty.txt'), 'fail empty\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: fail empty task'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/fail-empty-task', '-m', "Merge branch 'agenthub/fail-empty-task' into main"], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-fail-empty',
        name: 'Project Fail Empty',
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
        id: 'proj-fail-empty/task-1',
        projectId: 'proj-fail-empty',
        slug: 'fail-empty-task',
        title: 'Fail Empty Task',
        status: 'done',
        branch: 'agenthub/fail-empty-task',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-fail-empty';
      const res = await ctx.service.publishTask('proj-fail-empty/task-1');
      expect(res.ok).toBe(false);
      expect((res as any).auditFailed).toBe(true);
      expect((res as any).retryable).toBe(true);

      const taskAfter = ctx.taskRepo.get('proj-fail-empty/task-1');
      // Task must NOT be returned to worker (must remain 'done', not 'running' or 'queued')
      expect(taskAfter?.status).toBe('done');
      const pushResult = JSON.parse(taskAfter!.pushResult!);
      expect(pushResult.retryable).toBe(true);
      expect(pushResult.auditFailed).toBe(true);

      // Verify remote branch was not pushed
      const remoteCommits = execFileSync('git', ['--git-dir', remotePath, 'log', '--oneline', 'main'], { encoding: 'utf8', env: testEnv });
      expect(remoteCommits).not.toContain('feat: fail empty task');
    });

    it('API publish trả 202 ngay, trạng thái được cập nhật qua DB/SSE và chặn publish trùng', async () => {
      const remotePath = path.join(tmpDir, 'remote-async-pub.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-async-pub');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/async-pub-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'async.txt'), 'async publish\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: async publish task'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/async-pub-task', '-m', "Merge branch 'agenthub/async-pub-task' into main"], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-async',
        name: 'Project Async Pub',
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
        id: 'proj-async/task-1',
        projectId: 'proj-async',
        slug: 'async-pub-task',
        title: 'Async Pub Task',
        status: 'done',
        branch: 'agenthub/async-pub-task',
        baseRef: 'main',
      });

      const events: Array<{ type: string; payload: any }> = [];
      ctx.scheduler.getEventBus().on('task.auditing', (_id, p) => events.push({ type: 'task.auditing', payload: p }));
      ctx.scheduler.getEventBus().on('task.audit_passed', (_id, p) => events.push({ type: 'task.audit_passed', payload: p }));
      ctx.scheduler.getEventBus().on('task.pushed', (_id, p) => events.push({ type: 'task.pushed', payload: p }));

      process.env.FAKE_MODE = 'audit-pass';

      // 1. POST /api/tasks/:id/publish returns 202 immediately
      const res = await server.inject({
        method: 'POST',
        url: '/api/tasks/proj-async~task-1/publish',
        headers: authHeaders(),
      });
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body);
      expect(body.started).toBe(true);

      // 2. DB has state: 'auditing' and SSE emitted task.auditing
      const immediateTask = ctx.taskRepo.get('proj-async/task-1');
      const immediatePr = JSON.parse(immediateTask?.pushResult || '{}');
      expect(immediatePr.state).toBe('auditing');
      expect(events.some((e) => e.type === 'task.auditing')).toBe(true);

      // 3. Subsequent publish request while project is publishing returns 409 conflict
      const dupRes = await server.inject({
        method: 'POST',
        url: '/api/tasks/proj-async~task-1/publish',
        headers: authHeaders(),
      });
      // Either 409 because it is publishing or background task already completed
      if (dupRes.statusCode === 409) {
        expect(JSON.parse(dupRes.body).message || JSON.parse(dupRes.body).error).toContain('đang trong quá trình publish');
      }

      // 4. Background execution completes and updates state to pushed
      await vi.waitFor(() => {
        const finishedTask = ctx.taskRepo.get('proj-async/task-1');
        expect(finishedTask?.status).toBe('pushed');
      }, { timeout: 15000, interval: 50 });

      expect(events.some((e) => e.type === 'task.audit_passed')).toBe(true);
      expect(events.some((e) => e.type === 'task.pushed')).toBe(true);
    });

    it('khi background publish thất bại, trạng thái auditing không bị kẹt và chuyển sang push_failed', async () => {
      const repoPath = path.join(tmpDir, 'local-repo-stuck-auditing');
      fs.mkdirSync(repoPath, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'README.md'), '# Stuck\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-stuck',
        name: 'Project Stuck',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-stuck/t-stuck',
        projectId: 'proj-stuck',
        slug: 't-stuck',
        title: 'Stuck Task',
        status: 'done',
        baseRef: 'main',
      });

      // Mock publishTask to reject with error (e.g. 409 conflict or network/lock error)
      vi.spyOn(ctx.service, 'publishTask').mockRejectedValueOnce(new Error('Race 409: Dự án đang trong quá trình publish'));

      let pushFailedEmitted = false;
      ctx.scheduler.getEventBus().on('task.push_failed', (_id, p) => {
        if (p.taskId === 'proj-stuck/t-stuck') pushFailedEmitted = true;
      });

      const res = ctx.service.startPublishTask('proj-stuck/t-stuck', { manual: true });
      expect(res.started).toBe(true);

      // Verify that after the rejection, pushResult transitions out of 'auditing' to 'push_failed'
      await vi.waitFor(() => {
        const t = ctx.taskRepo.get('proj-stuck/t-stuck');
        const pr = JSON.parse(t?.pushResult || '{}');
        expect(pr.state).toBe('push_failed');
        expect(pr.error).toContain('Race 409');
      }, { timeout: 15000, interval: 50 });
      expect(pushFailedEmitted).toBe(true);
    });

    it('huỷ bỏ publish khi số lượng task cần audit vượt quá maxTasks và phát sự kiện push_failed', async () => {
      const remotePath = path.join(tmpDir, 'remote-max-tasks.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-max-tasks');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });

      // Task 1
      execFileSync('git', ['checkout', '-b', 'agenthub/mt-1'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file1.txt'), 'Task 1 content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task 1'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/mt-1', '-m', "Merge branch 'agenthub/mt-1' into agenthub/integration"], { cwd: repoPath, env: testEnv });

      // Task 2
      execFileSync('git', ['checkout', '-b', 'agenthub/mt-2'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'file2.txt'), 'Task 2 content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task 2'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/mt-2', '-m', "Merge branch 'agenthub/mt-2' into agenthub/integration"], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-max-tasks',
        name: 'Max Tasks Test Project',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            pushIntegrationBranch: false,
            audit: { enabled: true, maxTasks: 1 },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-max-tasks/task-1',
        projectId: 'proj-max-tasks',
        slug: 'mt-1',
        title: 'Task 1',
        status: 'done',
        branch: 'agenthub/mt-1',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'proj-max-tasks/task-2',
        projectId: 'proj-max-tasks',
        slug: 'mt-2',
        title: 'Task 2',
        status: 'done',
        branch: 'agenthub/mt-2',
        baseRef: 'main',
      });

      const failedEvents: Array<{ type: string; payload: any }> = [];
      ctx.scheduler.getEventBus().on('task.push_failed', (_id, p) => failedEvents.push({ type: 'task.push_failed', payload: p }));

      const res = await ctx.service.publishTask('proj-max-tasks/task-2', { manual: true });
      expect(res.ok).toBe(false);
      expect(res.retryable).toBe(false);
      expect(res.error).toContain('vượt quá giới hạn tối đa cho phép');

      const task2 = ctx.taskRepo.get('proj-max-tasks/task-2');
      const pr = JSON.parse(task2?.pushResult || '{}');
      expect(pr.state).toBe('push_failed');
      expect(pr.exceededMaxTasks).toBe(true);
      expect(pr.maxTasks).toBe(1);
      expect(pr.tasksCount).toBe(2);

      expect(failedEvents.length).toBeGreaterThan(0);
      expect(failedEvents[0].payload.error).toContain('vượt quá giới hạn');
    });

    it('baseline tasks merged trước enabledAt được miễn audit gate và đánh dấu pushed với baseline: true', async () => {
      const remotePath = path.join(tmpDir, 'remote-baseline-test.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-baseline-test');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });

      const pastEnv = {
        ...testEnv,
        GIT_AUTHOR_DATE: '2026-01-01T10:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T10:00:00Z',
      };

      // Create 3 tasks merged in the past (before publish was enabled)
      for (let i = 1; i <= 3; i++) {
        execFileSync('git', ['checkout', '-b', `agenthub/base-${i}`], { cwd: repoPath, env: pastEnv });
        fs.writeFileSync(path.join(repoPath, `base${i}.txt`), `Base task ${i}\n`);
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: pastEnv });
        execFileSync('git', ['commit', '-m', `feat: base task ${i}`], { cwd: repoPath, env: pastEnv });

        execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: pastEnv });
        execFileSync('git', ['merge', '--no-ff', `agenthub/base-${i}`, '-m', `Merge branch 'agenthub/base-${i}' into agenthub/integration`], { cwd: repoPath, env: pastEnv });
      }

      // Project enabled publish at 2026-01-02T00:00:00Z with maxTasks: 2
      ctx.service.createProject({
        id: 'proj-baseline',
        name: 'Baseline Test Project',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            pushIntegrationBranch: false,
            audit: { enabled: true, maxTasks: 2 },
          },
        },
      });

      // Simulate system-recorded enabledAt in database (since client input cannot set enabledAt)
      const baselineProj = ctx.projectRepo.get('proj-baseline')!;
      const baselineSettings = projectSettings(baselineProj);
      baselineSettings.publish.enabledAt = '2026-01-02T00:00:00Z';
      ctx.projectRepo.update('proj-baseline', { settings: JSON.stringify(baselineSettings) });

      for (let i = 1; i <= 3; i++) {
        ctx.taskRepo.insert({
          id: `proj-baseline/task-${i}`,
          projectId: 'proj-baseline',
          slug: `base-${i}`,
          title: `Base Task ${i}`,
          status: 'done',
          branch: `agenthub/base-${i}`,
          baseRef: 'main',
          createdAt: '2026-01-01T10:00:00Z',
        });
      }

      // Create 1 new task merged after enabledAt
      const recentEnv = {
        ...testEnv,
        GIT_AUTHOR_DATE: '2026-01-03T10:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-03T10:00:00Z',
      };
      execFileSync('git', ['checkout', '-b', 'agenthub/new-task'], { cwd: repoPath, env: recentEnv });
      fs.writeFileSync(path.join(repoPath, 'new.txt'), 'New task content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: recentEnv });
      execFileSync('git', ['commit', '-m', 'feat: new task'], { cwd: repoPath, env: recentEnv });

      execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: recentEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/new-task', '-m', "Merge branch 'agenthub/new-task' into agenthub/integration"], { cwd: repoPath, env: recentEnv });

      ctx.taskRepo.insert({
        id: 'proj-baseline/task-new',
        projectId: 'proj-baseline',
        slug: 'new-task',
        title: 'New Task',
        status: 'done',
        branch: 'agenthub/new-task',
        baseRef: 'main',
        createdAt: '2026-01-03T10:00:00Z',
      });

      // Total unpushed tasks = 4 > maxTasks (2). But 3 are baseline.
      process.env.FAKE_MODE = 'audit-pass';
      const res = await ctx.service.publishTask('proj-baseline/task-new', { manual: true });
      expect(res.ok).toBe(true);

      // Verify new task was audited and pushed
      const updatedNew = ctx.taskRepo.get('proj-baseline/task-new');
      expect(updatedNew?.status).toBe('pushed');
      const prNew = JSON.parse(updatedNew?.pushResult || '{}');
      expect(prNew.auditPassed).toBe(true);
      expect(prNew.baseline).toBeUndefined();

      // Verify baseline tasks were marked pushed with baseline: true, auditSkipped: true
      for (let i = 1; i <= 3; i++) {
        const baseTask = ctx.taskRepo.get(`proj-baseline/task-${i}`);
        expect(baseTask?.status).toBe('pushed');
        const prBase = JSON.parse(baseTask?.pushResult || '{}');
        expect(prBase.baseline).toBe(true);
        expect(prBase.auditSkipped).toBe(true);
      }
    });

    it('từ chối enabledAt ở tương lai: không coi task là baseline và giữ fail-closed khi vượt maxTasks', async () => {
      const repoPath = path.join(tmpDir, 'repo-future-enabled');
      fs.mkdirSync(repoPath, { recursive: true });
      execFileSync('git', ['init', repoPath], { env: testEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'init.txt'), 'init');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, env: testEnv });

      const remoteBarePath = path.join(tmpDir, 'remote-future-enabled.git');
      execFileSync('git', ['init', '--bare', remoteBarePath], { env: testEnv });
      execFileSync('git', ['remote', 'add', 'origin', remoteBarePath], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoPath, env: testEnv });

      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['push', '-u', 'origin', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      // Create 11 tasks (exceeding default maxTasks = 10)
      for (let i = 1; i <= 11; i++) {
        execFileSync('git', ['checkout', '-b', `agenthub/task-${i}`], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, `f${i}.txt`), `Content ${i}\n`);
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', `feat: task ${i}`], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', `agenthub/task-${i}`, '-m', `Merge branch 'agenthub/task-${i}' into agenthub/integration`], { cwd: repoPath, env: testEnv });
      }
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-future-enabled',
        name: 'Future Enabled Project',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: true, branch: 'agenthub/integration' },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            pushIntegrationBranch: false,
          },
        },
      });

      // Simulate a future enabledAt maliciously injected into DB (+1 hour, strictly in future)
      const futureDate = new Date(Date.now() + 3_600_000).toISOString();
      const proj = ctx.projectRepo.get('proj-future-enabled')!;
      const s = projectSettings(proj);
      s.publish.enabledAt = futureDate;
      ctx.projectRepo.update('proj-future-enabled', { settings: JSON.stringify(s) });

      for (let i = 1; i <= 11; i++) {
        ctx.taskRepo.insert({
          id: `proj-future-enabled/task-${i}`,
          projectId: 'proj-future-enabled',
          slug: `task-${i}`,
          title: `Task ${i}`,
          status: 'done',
          branch: `agenthub/task-${i}`,
          baseRef: 'main',
        });
      }

      // If future enabledAt were accepted, all 11 tasks would be treated as baseline and push would succeed without audit.
      // But because future enabledAt is rejected, all 11 tasks must be audited, which exceeds maxTasks (10).
      process.env.FAKE_MODE = 'audit-pass';
      const res = await ctx.service.publishTask('proj-future-enabled/task-11', { manual: true });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('vượt quá giới hạn tối đa cho phép');
    });

    it('không spam thông báo: cùng một lỗi publish thất bại phát suppressNotification: true ở lần lặp lại', async () => {
      const repoPath = path.join(tmpDir, 'repo-notify-dedup');
      fs.mkdirSync(repoPath, { recursive: true });
      execFileSync('git', ['init', repoPath], { env: testEnv });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'init.txt'), 'init');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-notify-dedup',
        name: 'Notify Dedup Project',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          publish: {
            enabled: true,
            remote: 'non-existent-remote',
            branch: 'main',
            pushIntegrationBranch: false,
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-notify-dedup/t1',
        projectId: 'proj-notify-dedup',
        slug: 't1',
        title: 'Task 1',
        status: 'done',
        branch: 'main',
        baseRef: 'main',
      });

      const pushFailedEvents: any[] = [];
      ctx.scheduler.getEventBus().on('task.push_failed', (_id, p) => pushFailedEvents.push(p));

      // Attempt 1: auto-publish should emit suppressNotification: false
      const res1 = await ctx.service.publishTask('proj-notify-dedup/t1');
      expect(res1.ok).toBe(false);
      expect(pushFailedEvents.length).toBe(1);
      expect(pushFailedEvents[0].suppressNotification).toBe(false);

      // Attempt 2: identical error in auto-publish should emit suppressNotification: true
      const res2 = await ctx.service.publishTask('proj-notify-dedup/t1');
      expect(res2.ok).toBe(false);
      expect(pushFailedEvents.length).toBe(2);
      expect(pushFailedEvents[1].suppressNotification).toBe(true);

      // Attempt 3: manual retry with same error should NOT suppress notification (manual = true)
      const res3 = await ctx.service.publishTask('proj-notify-dedup/t1', { manual: true });
      expect(res3.ok).toBe(false);
      expect(pushFailedEvents.length).toBe(3);
      expect(pushFailedEvents[2].suppressNotification).toBe(false);

      // Verify NotificationService skips notification when suppressNotification is true
      const fakeExec = vi.fn();
      const testConfig = {
        ...config,
        notifications: {
          ...config.notifications,
          desktop: true,
          desktopLevel: 'all' as const,
        },
      };
      const notifService = new NotificationService({
        config: testConfig,
        eventBus: ctx.scheduler.getEventBus(),
        exec: fakeExec,
      });
      const sentNotifications: any[] = [];
      const origNotify = notifService.notify.bind(notifService);
      notifService.notify = (msg: string, level: any) => {
        sentNotifications.push({ msg, level });
        return origNotify(msg, level);
      };

      // Replay events to notification service
      (notifService as any).handleEvent('task.push_failed', 'proj-notify-dedup/t1', pushFailedEvents[0]);
      expect(sentNotifications.length).toBe(1);

      (notifService as any).handleEvent('task.push_failed', 'proj-notify-dedup/t1', pushFailedEvents[1]);
      // Length should still be 1 because suppressNotification: true is skipped!
      expect(sentNotifications.length).toBe(1);
    });

    it('normalizePublishErrorKey chuẩn hoá thông điệp lỗi chứa số đếm và hash động để chống spam', () => {
      const err1 = 'Số lượng task cần audit (11) vượt quá giới hạn tối đa cho phép (10). Vui lòng kiểm tra hoặc điều chỉnh maxTasks.';
      const err2 = 'Số lượng task cần audit (12) vượt quá giới hạn tối đa cho phép (10). Vui lòng kiểm tra hoặc điều chỉnh maxTasks.';
      expect(normalizePublishErrorKey(err1)).toBe(normalizePublishErrorKey(err2));

      const err3 = 'Commit a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4 failed for task proj/task-abc123';
      const err4 = 'Commit fedcba9876543210fedcba9876543210fedcba98 failed for task proj/task-xyz789';
      expect(normalizePublishErrorKey(err3)).toBe(normalizePublishErrorKey(err4));
    });

    it('root task không có branch và không có merge commit vẫn được audit và đánh dấu pushed thành công', async () => {
      const remotePath = path.join(tmpDir, 'remote-no-branch.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-no-branch');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Create integration branch
      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'base.txt'), 'base\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'chore: integration base'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['push', '-u', 'origin', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-no-branch',
        name: 'Project No Branch',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: true, branch: 'agenthub/integration' },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            pushIntegrationBranch: false,
            audit: { enabled: true },
          },
        },
      });

      // Insert root task without a branch and without merge commit
      ctx.taskRepo.insert({
        id: 'proj-no-branch/task-root-nobranch',
        projectId: 'proj-no-branch',
        slug: 'task-root-nobranch',
        title: 'Task Root No Branch',
        status: 'done',
        branch: null,
      });

      process.env.FAKE_MODE = 'audit-pass';
      const res = await ctx.service.publishTask('proj-no-branch/task-root-nobranch');
      expect(res.ok).toBe(false);
      expect((res as any).error).toMatch(/publish snapshot|audit/i);

      const updated = ctx.taskRepo.get('proj-no-branch/task-root-nobranch');
      expect(updated?.status).toBe('done');
      const pr = JSON.parse(updated!.pushResult!);
      expect(pr.state).toBe('push_failed');
    });

    it('task có nhánh nhưng chưa được merge vào sourceSha -> báo lỗi push_failed thay vì trả ok im lặng', async () => {
      const remotePath = path.join(tmpDir, 'remote-unmerged.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-unmerged');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'base.txt'), 'base\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'chore: integration base'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['push', '-u', 'origin', 'agenthub/integration'], { cwd: repoPath, env: testEnv });

      // Create branch for task-unmerged with a commit that is NOT merged into integration
      execFileSync('git', ['checkout', '-b', 'agenthub/task-unmerged'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'unmerged.txt'), 'unmerged\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: unmerged change'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-unmerged',
        name: 'Project Unmerged',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: true, branch: 'agenthub/integration' },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            pushIntegrationBranch: false,
            audit: { enabled: true },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-unmerged/task-unmerged',
        projectId: 'proj-unmerged',
        slug: 'task-unmerged',
        title: 'Task Unmerged',
        status: 'done',
        branch: 'agenthub/task-unmerged',
      });

      const pushFailedEvents: any[] = [];
      ctx.scheduler.getEventBus().on('task.push_failed', (_id, p) => pushFailedEvents.push(p));

      const remoteShaBefore = execFileSync('git', ['--git-dir', remotePath, 'rev-parse', 'refs/heads/main'], { env: testEnv }).toString().trim();

      const res = await ctx.service.publishTask('proj-unmerged/task-unmerged');
      expect(res.ok).toBe(false);
      expect(res.error).toContain('not included in the push commit');

      // Verify remote target branch was NOT pushed before error was reported
      const remoteShaAfter = execFileSync('git', ['--git-dir', remotePath, 'rev-parse', 'refs/heads/main'], { env: testEnv }).toString().trim();
      expect(remoteShaAfter).toBe(remoteShaBefore);

      const updated = ctx.taskRepo.get('proj-unmerged/task-unmerged');
      expect(updated?.status).not.toBe('pushed');
      const pr = JSON.parse(updated!.pushResult!);
      expect(pr.state).toBe('push_failed');
      expect(pushFailedEvents.length).toBe(1);

      // Verify skipAudit also rejects unmerged task early and does not push to remote
      const resSkip = await ctx.service.publishTask('proj-unmerged/task-unmerged', { manual: true, skipAudit: true });
      expect(resSkip.ok).toBe(false);
      expect(resSkip.error).toContain('not included in the push commit');
      const remoteShaAfterSkip = execFileSync('git', ['--git-dir', remotePath, 'rev-parse', 'refs/heads/main'], { env: testEnv }).toString().trim();
      expect(remoteShaAfterSkip).toBe(remoteShaBefore);
    });

    it('enqueueAutoPublish: lock nhả trước khi đăng ký listener 409 -> tự động drain và publish ngay', async () => {
      const projectId = 'proj-lock-race';
      const taskId = 'proj-lock-race/t-race';

      const repoPath = path.join(tmpDir, 'repo-lock-race');
      fs.mkdirSync(repoPath, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: projectId,
        name: 'Project Lock Race',
        path: repoPath,
        defaultBranch: 'main',
      });

      ctx.taskRepo.insert({
        id: taskId,
        projectId,
        slug: 't-race',
        title: 'Task Race',
        status: 'done',
      });

      let callCount = 0;
      const origPublishTask = ctx.service.publishTask.bind(ctx.service);
      ctx.service.publishTask = vi.fn(async (_id: string, _options?: any) => {
        callCount++;
        if (callCount === 1) {
          // First call throws 409, while publish lock is ALREADY NOT active (simulating race)
          throw new HttpError(409, 'conflict', 'Dự án đang trong quá trình publish');
        }
        // Second call (drain) succeeds
        ctx.taskRepo.update(taskId, { status: 'pushed' });
        return { ok: true, remote: 'origin', branch: 'main', commit: 'abc', pushedIntegrationBranch: false };
      }) as any;

      ctx.service.enqueueAutoPublish(projectId, taskId);

      // Wait for promise chain to drain and publish to complete
      await vi.waitFor(() => {
        expect(callCount).toBe(2);
        const task = ctx.taskRepo.get(taskId);
        expect(task?.status).toBe('pushed');
        const pendingSet = (ctx.service as any).pendingAutoPublishTasks.get(projectId);
        expect(pendingSet?.size ?? 0).toBe(0);
      }, { timeout: 15000, interval: 50 });

      ctx.service.publishTask = origPublishTask;
    });

    it('getTaskDiff dùng snapshot sourceSha: khi nhánh task thay đổi sau snapshot, diff và branchSha chỉ phản ánh đúng commit snapshot', async () => {
      const { getTaskDiff } = await import('../src/publish.js');
      const remotePath = path.join(tmpDir, 'remote-diff-snapshot.git');
      initBareRemote(remotePath);
      const repoPath = path.join(tmpDir, 'repo-diff-snapshot');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      execFileSync('git', ['checkout', '-b', 'agenthub/diff-task'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'task.txt'), 'commit 1 snapshot content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: commit 1 in snapshot'], { cwd: repoPath, env: testEnv });

      const snapshotSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

      // Later commit made after snapshot
      fs.writeFileSync(path.join(repoPath, 'task.txt'), 'commit 1 snapshot content\ncommit 2 late content\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: commit 2 after snapshot'], { cwd: repoPath, env: testEnv });

      const lateSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();
      expect(lateSha).not.toBe(snapshotSha);

      const task: TaskRow = {
        id: 'proj-diff/t1',
        projectId: 'proj-diff',
        slug: 'diff-task',
        title: 'Diff Task',
        status: 'done',
        branch: 'agenthub/diff-task',
        baseRef: 'main',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any;

      const diffResult = await getTaskDiff(
        repoPath,
        task,
        'agenthub/diff-task',
        'main',
        'main',
        testEnv,
        snapshotSha,
      );

      expect(diffResult.commitSha).toBe(snapshotSha);
      expect(diffResult.branchSha).toBe(snapshotSha);
      expect(diffResult.diff).toContain('commit 1 snapshot content');
      expect(diffResult.diff).not.toContain('commit 2 late content');
    });

    it('candidate discovery ưu tiên mergeCommit của snapshot: khi task B đã nằm trong targetSha nhưng nhánh task B có commit mới sau snapshot, task B vẫn được phát hiện và publish thành công', async () => {
      const remotePath = path.join(tmpDir, 'remote-candidate-discovery.git');
      initBareRemote(remotePath);

      const repoPath = path.join(tmpDir, 'local-repo-candidate-discovery');
      initGitRepoWithRemote(repoPath, remotePath, 'main');

      // Create Task B, merge into main local
      execFileSync('git', ['checkout', '-b', 'agenthub/task-b'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'b.txt'), 'b code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task b initial'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/task-b', '-m', "Merge branch 'agenthub/task-b' into main"], { cwd: repoPath, env: testEnv });

      // Create Task A, merge into main local
      execFileSync('git', ['checkout', '-b', 'agenthub/task-a'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task a initial'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['merge', '--no-ff', 'agenthub/task-a', '-m', "Merge branch 'agenthub/task-a' into main"], { cwd: repoPath, env: testEnv });

      // After merge, new commit is added to agenthub/task-b
      execFileSync('git', ['checkout', 'agenthub/task-b'], { cwd: repoPath, env: testEnv });
      fs.writeFileSync(path.join(repoPath, 'b-late.txt'), 'b late code\n');
      execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['commit', '-m', 'feat: task b late commit after merge'], { cwd: repoPath, env: testEnv });
      execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

      ctx.service.createProject({
        id: 'proj-candidate-discovery',
        name: 'Project Candidate Discovery',
        path: repoPath,
        defaultBranch: 'main',
        settings: {
          integration: { enabled: false },
          publish: {
            enabled: true,
            remote: 'origin',
            branch: 'main',
            audit: { enabled: true },
          },
        },
      });

      ctx.taskRepo.insert({
        id: 'proj-candidate-discovery/task-a',
        projectId: 'proj-candidate-discovery',
        slug: 'task-a',
        title: 'Task A',
        status: 'done',
        branch: 'agenthub/task-a',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'proj-candidate-discovery/task-b',
        projectId: 'proj-candidate-discovery',
        slug: 'task-b',
        title: 'Task B',
        status: 'done',
        branch: 'agenthub/task-b',
        baseRef: 'main',
      });

      process.env.FAKE_MODE = 'audit-pass';

      // Publish task A: candidate discovery discovers both task A and task B from targetSha snapshot
      // (even though agenthub/task-b has late commits not in targetSha)
      const res = await ctx.service.publishTask('proj-candidate-discovery/task-a');
      expect(res.ok).toBe(true);

      const updatedA = ctx.taskRepo.get('proj-candidate-discovery/task-a');
      const updatedB = ctx.taskRepo.get('proj-candidate-discovery/task-b');
      expect(updatedA?.status).toBe('pushed');
      expect(updatedB?.status).toBe('pushed');
      expect(JSON.parse(updatedB!.pushResult!).state).toBe('pushed');

      const remoteLog = execFileSync('git', ['--git-dir', remotePath, 'log', '--oneline', 'main'], { encoding: 'utf8', env: testEnv });
      expect(remoteLog).toContain('feat: task a initial');
      expect(remoteLog).toContain('feat: task b initial');
      expect(remoteLog).not.toContain('feat: task b late commit after merge');
    });

    describe('Audit diff base and range fix (DEC-037 / t-audit-diff-base-fix)', () => {
      it('tái hiện sự cố ui-dashboard: task A đã push lên remote, task B merge master ngược chiều rồi merge vào master 2 lần -> diff audit không chứa file của A và chứa trọn vẹn cả 2 lần merge của B', async () => {
        const { getTaskDiff, findForwardMergeCommitsForTask, findMergeCommitForTask } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-ui-dashboard.git');
        initBareRemote(remotePath);

        const repoPath = path.join(tmpDir, 'local-ui-dashboard');
        initGitRepoWithRemote(repoPath, remotePath, 'master');

        // 1. Task A (approvals): ~1800 dòng, đã push lên remote origin/master
        fs.writeFileSync(
          path.join(repoPath, 'approvals.txt'),
          Array.from({ length: 1800 }, (_, i) => `approvals rule row ${i + 1}`).join('\n') + '\n',
        );
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat(approvals): add story points approvals page (~1800 lines)'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['push', 'origin', 'master'], { cwd: repoPath, env: testEnv });
        const remoteShaWithA = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // 2. Nhánh task B (agenthub/ui-dashboard) rẽ nhánh từ commit trước khi có task A
        const initialCommit = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD~1'], { encoding: 'utf8', env: testEnv }).trim();
        execFileSync('git', ['checkout', '-b', 'agenthub/ui-dashboard', initialCommit], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'dashboard-1.ts'), 'export const dashboardPart1 = "v1";\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat(dashboard): part 1'], { cwd: repoPath, env: testEnv });

        // Merge ngược chiều: master (đã có task A) vào nhánh agenthub/ui-dashboard
        execFileSync('git', ['merge', '--no-ff', 'master', '-m', "Merge branch 'master' into agenthub/ui-dashboard"], { cwd: repoPath, env: testEnv });
        const reverseMergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Thêm thay đổi part 2 trên nhánh task B
        fs.writeFileSync(path.join(repoPath, 'dashboard-2.ts'), 'export const dashboardPart2 = "v2";\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat(dashboard): part 2'], { cwd: repoPath, env: testEnv });

        // Lần merge 1 vào master:
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/ui-dashboard', '-m', "Merge branch 'agenthub/ui-dashboard' into master"], { cwd: repoPath, env: testEnv });
        const fwdMerge1Sha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Thêm thay đổi part 3 trên nhánh task B
        execFileSync('git', ['checkout', 'agenthub/ui-dashboard'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'dashboard-3.ts'), 'export const dashboardPart3 = "v3";\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat(dashboard): part 3'], { cwd: repoPath, env: testEnv });
        const taskBTipSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Lần merge 2 vào master:
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/ui-dashboard', '-m', "Merge branch 'agenthub/ui-dashboard' into master"], { cwd: repoPath, env: testEnv });
        const fwdMerge2Sha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo project không dùng integration (như dev-insight-rust)
        ctx.service.createProject({
          id: 'proj-ui-dashboard',
          name: 'Project Dev Insight Rust',
          path: repoPath,
          defaultBranch: 'master',
          settings: {
            integration: { enabled: false },
            publish: {
              enabled: true,
              remote: 'origin',
              branch: 'master',
              audit: { enabled: true, maxFixRounds: 2 },
            },
          },
        });

        const taskRow: any = {
          id: 'proj-ui-dashboard/ui-dashboard',
          projectId: 'proj-ui-dashboard',
          slug: 'ui-dashboard',
          title: 'UI Dashboard',
          status: 'done',
          branch: 'agenthub/ui-dashboard',
          baseRef: 'master',
        };
        ctx.taskRepo.insert(taskRow);

        // Kiểm tra phát hiện merge commits: không bao giờ chọn reverseMergeSha, tìm đúng [fwd2, fwd1]
        const fwdMerges = await findForwardMergeCommitsForTask(repoPath, taskRow, ['master'], testEnv);
        expect(fwdMerges).toEqual([fwdMerge2Sha, fwdMerge1Sha]);
        expect(fwdMerges).not.toContain(reverseMergeSha);

        const latestMerge = await findMergeCommitForTask(repoPath, taskRow, ['master'], testEnv);
        expect(latestMerge).toBe(fwdMerge2Sha);

        // Kiểm tra getTaskDiff:
        const taskDiffRes = await getTaskDiff(
          repoPath,
          taskRow,
          'agenthub/ui-dashboard',
          'master',
          remoteShaWithA,
          testEnv,
          null,
          fwdMerge2Sha,
        );

        // Diff KHÔNG chứa file của task A (approvals.txt)
        expect(taskDiffRes.diff).not.toContain('approvals rule row');
        expect(taskDiffRes.changedFiles).not.toContain('approvals.txt');

        // Diff CHỨA mọi thay đổi của B ở cả 2 lần merge (dashboard-1, dashboard-2, dashboard-3)
        expect(taskDiffRes.changedFiles).toEqual(
          expect.arrayContaining(['dashboard-1.ts', 'dashboard-2.ts', 'dashboard-3.ts']),
        );
        expect(taskDiffRes.diff).toContain('dashboardPart1');
        expect(taskDiffRes.diff).toContain('dashboardPart2');
        expect(taskDiffRes.diff).toContain('dashboardPart3');
        expect(taskDiffRes.auditRange).toBe(`${remoteShaWithA}..${taskBTipSha}`);

        // Bắt event audit để kiểm tra auditRange
        const events: Array<{ type: string; payload: any }> = [];
        ctx.scheduler.getEventBus().on('task.audit_started', (_id, p) => events.push({ type: 'task.audit_started', payload: p }));
        ctx.scheduler.getEventBus().on('task.audit_passed', (_id, p) => events.push({ type: 'task.audit_passed', payload: p }));

        process.env.FAKE_MODE = 'audit-pass';
        const publishRes = await ctx.service.publishTask('proj-ui-dashboard/ui-dashboard');

        expect(publishRes.ok).toBe(true);
        expect((publishRes as any).auditPassed).toBe(true);
        expect((publishRes as any).auditRange).toBe(`${remoteShaWithA}..${taskBTipSha}`);

        const auditStarted = events.find((e) => e.type === 'task.audit_started');
        expect(auditStarted?.payload?.auditRange).toBe(`${remoteShaWithA}..${taskBTipSha}`);

        const auditPassed = events.find((e) => e.type === 'task.audit_passed');
        expect(auditPassed?.payload?.auditRange).toBe(`${remoteShaWithA}..${taskBTipSha}`);

        const updatedTask = ctx.taskRepo.get('proj-ui-dashboard/ui-dashboard');
        expect(updatedTask?.status).toBe('pushed');
        const pr = JSON.parse(updatedTask!.pushResult!);
        expect(pr.auditRange).toBe(`${remoteShaWithA}..${taskBTipSha}`);
      });

      it('project dùng integration (agenthub): task có reverse merge và 2 lần merge vào integration -> diff chuẩn, bao trọn cả 2 lần merge và loại trừ task khác', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-integ-multi-merge.git');
        initBareRemote(remotePath);

        const repoPath = path.join(tmpDir, 'local-integ-multi-merge');
        initGitRepoWithRemote(repoPath, remotePath, 'main');

        execFileSync('git', ['checkout', '-b', 'agenthub/integration'], { cwd: repoPath, env: testEnv });

        // Task 1: đã merge vào integration và đã push lên remote main (mốc remote trước khi publish task-main)
        execFileSync('git', ['checkout', '-b', 'agenthub/task-other'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'other.txt'), 'other content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: other task'], { cwd: repoPath, env: testEnv });

        execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/task-other', '-m', "Merge branch 'agenthub/task-other' into agenthub/integration"], { cwd: repoPath, env: testEnv });

        // Merge agenthub/integration (đã có task-other) vào main và push lên remote main để thiết lập remote base trước publish
        execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/integration', '-m', "Merge branch 'agenthub/integration' into main"], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['push', 'origin', 'main'], { cwd: repoPath, env: testEnv });
        const remoteShaWithOther = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Đồng bộ main (đã push remote) vào integration
        execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--ff-only', 'main'], { cwd: repoPath, env: testEnv });

        // Task Main (agenthub/task-main): merge 1
        execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['checkout', '-b', 'agenthub/task-main'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'main-step-1.txt'), 'step 1\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: step 1'], { cwd: repoPath, env: testEnv });

        // Reverse merge integration into agenthub/task-main
        execFileSync('git', ['merge', '--no-ff', 'agenthub/integration', '-m', "Merge branch 'agenthub/integration' into agenthub/task-main"], { cwd: repoPath, env: testEnv });

        fs.writeFileSync(path.join(repoPath, 'main-step-2.txt'), 'step 2\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: step 2'], { cwd: repoPath, env: testEnv });

        execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/task-main', '-m', "Merge branch 'agenthub/task-main' into agenthub/integration"], { cwd: repoPath, env: testEnv });

        // Thêm commit và merge 2
        execFileSync('git', ['checkout', 'agenthub/task-main'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'main-step-3.txt'), 'step 3\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: step 3'], { cwd: repoPath, env: testEnv });
        const taskMainTip = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        execFileSync('git', ['checkout', 'agenthub/integration'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/task-main', '-m', "Merge branch 'agenthub/task-main' into agenthub/integration"], { cwd: repoPath, env: testEnv });
        const integSnapshot = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Checkout main để giải phóng agenthub/integration trước khi createProject (tránh xung đột worktree)
        execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });

        ctx.service.createProject({
          id: 'proj-integ-audit',
          name: 'Project Integ Audit',
          path: repoPath,
          defaultBranch: 'main',
          settings: {
            integration: { enabled: true, branch: 'agenthub/integration' },
            publish: {
              enabled: true,
              remote: 'origin',
              branch: 'main',
              audit: { enabled: true },
            },
          },
        });

        const taskRow: any = {
          id: 'proj-integ-audit/task-main',
          projectId: 'proj-integ-audit',
          slug: 'task-main',
          title: 'Task Main',
          status: 'done',
          branch: 'agenthub/task-main',
          baseRef: 'main',
        };
        ctx.taskRepo.insert(taskRow);

        const diffRes = await getTaskDiff(
          repoPath,
          taskRow,
          'agenthub/integration',
          'main',
          'main',
          testEnv,
          integSnapshot,
        );

        // Không chứa file other.txt từ task khác (vì đã có trên remote main)
        expect(diffRes.diff).not.toContain('other content');
        expect(diffRes.changedFiles).not.toContain('other.txt');

        // Chứa đủ 3 step của task-main
        expect(diffRes.changedFiles).toEqual(
          expect.arrayContaining(['main-step-1.txt', 'main-step-2.txt', 'main-step-3.txt']),
        );
        expect(diffRes.diff).toContain('step 1');
        expect(diffRes.diff).toContain('step 2');
        expect(diffRes.diff).toContain('step 3');
        expect(diffRes.auditRange).toBe(`${remoteShaWithOther}..${taskMainTip}`);

        process.env.FAKE_MODE = 'audit-pass';
        const pubRes = await ctx.service.publishTask('proj-integ-audit/task-main');
        expect(pubRes.ok).toBe(true);
        expect((pubRes as any).auditRange).toBe(`${remoteShaWithOther}..${taskMainTip}`);
      });

      it('task có 1 merge thường: hành vi diff và commitSha giữ nguyên, bổ sung auditRange chính xác', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-single-merge.git');
        initBareRemote(remotePath);

        const repoPath = path.join(tmpDir, 'local-single-merge');
        initGitRepoWithRemote(repoPath, remotePath, 'main');
        const baseMainSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        execFileSync('git', ['checkout', '-b', 'agenthub/single-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'single.txt'), 'single content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: single feature'], { cwd: repoPath, env: testEnv });
        const singleTipSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        execFileSync('git', ['checkout', 'main'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/single-task', '-m', "Merge branch 'agenthub/single-task' into main"], { cwd: repoPath, env: testEnv });
        const mergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow: any = {
          id: 'proj-single/single-task',
          projectId: 'proj-single',
          slug: 'single-task',
          title: 'Single Task',
          status: 'done',
          branch: 'agenthub/single-task',
          baseRef: 'main',
        };

        const diffRes = await getTaskDiff(
          repoPath,
          taskRow,
          'agenthub/single-task',
          'main',
          baseMainSha,
          testEnv,
          null,
          mergeSha,
        );

        expect(diffRes.commitSha).toBe(mergeSha);
        expect(diffRes.branchSha).toBe(singleTipSha);
        expect(diffRes.changedFiles).toEqual(['single.txt']);
        expect(diffRes.diff).toContain('single content');
        expect(diffRes.auditRange).toBe(`${baseMainSha}..${singleTipSha}`);
      });

      it('loại trừ reverse merge có message tùy biến không khớp regex nhờ kiểm tra cấu trúc parent (p1 trên task)', async () => {
        const { findForwardMergeCommitsForTask } = await import('../src/publish.js');
        const repoPath = path.join(tmpDir, 'local-custom-reverse-merge');
        fs.mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'README.md'), '# Base\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

        // Tạo nhánh task
        execFileSync('git', ['checkout', '-b', 'agenthub/custom-rev'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'task.txt'), 'task content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: task work'], { cwd: repoPath, env: testEnv });

        // Master có commit mới
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'master.txt'), 'master content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: master work'], { cwd: repoPath, env: testEnv });

        // Reverse merge master vào task branch với subject tùy biến / lừa đảo (không chứa "into agenthub/custom-rev")
        execFileSync('git', ['checkout', 'agenthub/custom-rev'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'master', '-m', "Merge branch 'agenthub/custom-rev'"], { cwd: repoPath, env: testEnv });
        const customReverseMergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Forward merge task vào master
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/custom-rev', '-m', "Merge branch 'agenthub/custom-rev' into master"], { cwd: repoPath, env: testEnv });
        const forwardMergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow: any = {
          id: 'proj/custom-rev',
          projectId: 'proj',
          slug: 'custom-rev',
          title: 'Custom Rev Task',
          branch: 'agenthub/custom-rev',
        };

        const merges = await findForwardMergeCommitsForTask(repoPath, taskRow, ['master'], testEnv);
        // Phải tìm đúng forward merge và loại trừ reverse merge dù subject lừa đảo
        expect(merges).toContain(forwardMergeSha);
        expect(merges).not.toContain(customReverseMergeSha);
      });

      it('loại trừ reverse merge có message tùy biến khi nhánh task không còn tồn tại cục bộ (hasBranch === false)', async () => {
        const { findForwardMergeCommitsForTask } = await import('../src/publish.js');
        const repoPath = path.join(tmpDir, 'local-deleted-rev-merge');
        fs.mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'README.md'), '# Base\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

        // Tạo nhánh task
        execFileSync('git', ['checkout', '-b', 'agenthub/deleted-rev'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'task.txt'), 'task content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: task work'], { cwd: repoPath, env: testEnv });

        // Master có commit mới
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'master.txt'), 'master content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: master work'], { cwd: repoPath, env: testEnv });

        // Reverse merge master vào task branch với subject tùy biến / lừa đảo (không chứa "into agenthub/deleted-rev")
        execFileSync('git', ['checkout', 'agenthub/deleted-rev'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'master', '-m', "Merge branch 'agenthub/deleted-rev'"], { cwd: repoPath, env: testEnv });
        const customReverseMergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Forward merge task vào master
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/deleted-rev', '-m', "Merge branch 'agenthub/deleted-rev' into master"], { cwd: repoPath, env: testEnv });
        const forwardMergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Xóa hoàn toàn nhánh task cục bộ để hasBranch === false
        execFileSync('git', ['branch', '-D', 'agenthub/deleted-rev'], { cwd: repoPath, env: testEnv });

        const taskRow: any = {
          id: 'proj/deleted-rev',
          projectId: 'proj',
          slug: 'deleted-rev',
          title: 'Deleted Rev Task',
          branch: 'agenthub/deleted-rev',
          baseRef: 'master',
        };

        const merges = await findForwardMergeCommitsForTask(repoPath, taskRow, ['master'], testEnv);
        // Khi hasBranch === false, vẫn phải loại trừ reverse merge và nhận diện đúng forward merge
        expect(merges).toContain(forwardMergeSha);
        expect(merges).not.toContain(customReverseMergeSha);

        // Nếu candidateBranches trỏ trực tiếp vào commit reverse merge, phải fail closed
        const revMerges = await findForwardMergeCommitsForTask(repoPath, taskRow, [customReverseMergeSha], testEnv);
        expect(revMerges).toEqual([]);
      });

      it('luôn dùng remote base (baseRef) làm mốc gốc ngay cả khi remote và earliestMergeP1 diverge', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-diverge.git');
        initBareRemote(remotePath);

        const repoPath = path.join(tmpDir, 'local-diverge');
        initGitRepoWithRemote(repoPath, remotePath, 'master');
        const initialSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo commit local trên master (L1)
        fs.writeFileSync(path.join(repoPath, 'local.txt'), 'local content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: local commit L1'], { cwd: repoPath, env: testEnv });

        // Task branch rẽ từ L1
        execFileSync('git', ['checkout', '-b', 'agenthub/diverge-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'task-div.txt'), 'task div content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: task div work'], { cwd: repoPath, env: testEnv });
        const taskTipSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Merge task vào local master
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/diverge-task', '-m', "Merge branch 'agenthub/diverge-task' into master"], { cwd: repoPath, env: testEnv });
        const mergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo clone phụ để đẩy commit R1 lên origin/master (làm remote và local diverge)
        const otherClone = path.join(tmpDir, 'other-clone-diverge');
        execFileSync('git', ['clone', remotePath, otherClone], { env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: otherClone, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: otherClone, env: testEnv });
        fs.writeFileSync(path.join(otherClone, 'remote.txt'), 'remote content R1\n');
        execFileSync('git', ['add', '.'], { cwd: otherClone, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: remote commit R1'], { cwd: otherClone, env: testEnv });
        execFileSync('git', ['push', 'origin', 'master'], { cwd: otherClone, env: testEnv });

        // Fetch origin về local repo: refs/remotes/origin/master giờ trỏ tới commit R1
        execFileSync('git', ['fetch', 'origin', 'master'], { cwd: repoPath, env: testEnv });

        const taskRow: any = {
          id: 'proj/diverge-task',
          projectId: 'proj',
          slug: 'diverge-task',
          title: 'Diverge Task',
          status: 'done',
          branch: 'agenthub/diverge-task',
          baseRef: 'master',
        };

        const diffRes = await getTaskDiff(
          repoPath,
          taskRow,
          'agenthub/diverge-task',
          'master',
          'refs/remotes/origin/master',
          testEnv,
          null,
          mergeSha,
        );

        // remoteR1Sha và localCommitSha diverge (earliestMergeP1 là localCommitSha, không phải ancestor của remoteR1Sha)
        // Mốc gốc phải phản ánh remote base (merge-base(remoteR1Sha, taskTipSha) = initialSha)
        expect(diffRes.auditRange).toBe(`${initialSha}..${taskTipSha}`);
        expect(diffRes.commitSha).toBe(mergeSha);
        expect(diffRes.changedFiles).toEqual(expect.arrayContaining(['local.txt', 'task-div.txt']));
        expect(diffRes.diff).toContain('task div content');
        expect(diffRes.diff).toContain('local content');
      });

      it('khi merge commit có diff hợp lệ rỗng, không rơi xuống snapshot fallback và không kéo diff của task khác', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-empty-diff-merge.git');
        initBareRemote(remotePath);
        const repoPath = path.join(tmpDir, 'local-empty-diff-merge');
        initGitRepoWithRemote(repoPath, remotePath, 'master');

        // Task A: tạo file a-other.txt
        execFileSync('git', ['checkout', '-b', 'agenthub/task-a'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'a-other.txt'), 'other task A\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: task A'], { cwd: repoPath, env: testEnv });

        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/task-a', '-m', "Merge branch 'agenthub/task-a' into master"], { cwd: repoPath, env: testEnv });
        const masterWithASha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();
        execFileSync('git', ['push', 'origin', 'master'], { cwd: repoPath, env: testEnv });

        // Task B: rẽ từ master (đã có A), thêm file rồi xóa file đó (diff rỗng so với master)
        execFileSync('git', ['checkout', '-b', 'agenthub/empty-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'temp.txt'), 'temp\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: add temp'], { cwd: repoPath, env: testEnv });
        fs.unlinkSync(path.join(repoPath, 'temp.txt'));
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'revert: remove temp'], { cwd: repoPath, env: testEnv });
        const emptyTipSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Merge task B vào master
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/empty-task', '-m', "Merge branch 'agenthub/empty-task' into master"], { cwd: repoPath, env: testEnv });
        const mergeBSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRowB: any = {
          id: 'proj/empty-task',
          projectId: 'proj',
          slug: 'empty-task',
          title: 'Empty Task',
          status: 'done',
          branch: 'agenthub/empty-task',
          baseRef: 'master',
        };

        // Giả sử sourceSha là masterWithASha (chứa task A)
        const diffRes = await getTaskDiff(
          repoPath,
          taskRowB,
          'agenthub/empty-task',
          'master',
          masterWithASha,
          testEnv,
          masterWithASha,
          mergeBSha,
        );

        // Merge range được bảo toàn, không rơi xuống snapshot fallback làm kéo task A vào
        expect(diffRes.commitSha).toBe(mergeBSha);
        expect(diffRes.auditRange).toBe(`${masterWithASha}..${emptyTipSha}`);
        expect(diffRes.diff).toBe('');
        expect(diffRes.changedFiles).toEqual([]);
        expect(diffRes.diff).not.toContain('other task A');
      });

      it('luôn dùng remote base (baseRef) làm mốc gốc khi remote base là tổ tiên của earliestMergeP1', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-ancestor-base.git');
        initBareRemote(remotePath);

        const repoPath = path.join(tmpDir, 'local-ancestor-base');
        initGitRepoWithRemote(repoPath, remotePath, 'master');
        const r0Sha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo commit local L1 trên master (chưa push lên remote)
        fs.writeFileSync(path.join(repoPath, 'local-unpushed.txt'), 'local unpushed content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: local unpushed L1'], { cwd: repoPath, env: testEnv });

        // Task branch rẽ từ L1
        execFileSync('git', ['checkout', '-b', 'agenthub/ancestor-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'task-ancestor.txt'), 'task ancestor content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: task ancestor work'], { cwd: repoPath, env: testEnv });
        const taskTipSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Merge task vào master (earliestMergeP1 là L1)
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/ancestor-task', '-m', "Merge branch 'agenthub/ancestor-task' into master"], { cwd: repoPath, env: testEnv });
        const mergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow: any = {
          id: 'proj/ancestor-task',
          projectId: 'proj',
          slug: 'ancestor-task',
          title: 'Ancestor Task',
          status: 'done',
          branch: 'agenthub/ancestor-task',
          baseRef: 'master',
        };

        // baseRef là refs/remotes/origin/master (trỏ tới r0Sha, là tổ tiên của earliestMergeP1 = L1)
        const diffRes = await getTaskDiff(
          repoPath,
          taskRow,
          'agenthub/ancestor-task',
          'master',
          'refs/remotes/origin/master',
          testEnv,
          null,
          mergeSha,
        );

        // Mốc gốc bắt buộc là remote base r0Sha (không được dùng L1)
        expect(diffRes.commitSha).toBe(mergeSha);
        expect(diffRes.auditRange).toBe(`${r0Sha}..${taskTipSha}`);
        expect(diffRes.changedFiles).toEqual(expect.arrayContaining(['local-unpushed.txt', 'task-ancestor.txt']));
        expect(diffRes.diff).toContain('local unpushed content');
        expect(diffRes.diff).toContain('task ancestor content');
      });

      it('loại trừ merge commit khi xác minh ancestry thất bại (fail-closed)', async () => {
        const { isAncestor, isFirstParentAncestor, findForwardMergeCommitsForTask } = await import('../src/publish.js');
        const repoPath = path.join(tmpDir, 'local-fail-closed-ancestry');
        fs.mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'README.md'), '# Base\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });
        const initialSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        fs.writeFileSync(path.join(repoPath, 'file.txt'), 'file content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: second'], { cwd: repoPath, env: testEnv });
        const secondSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // 1. Kiểm tra isAncestor:
        // - Đúng tổ tiên: true
        expect(await isAncestor(repoPath, initialSha, secondSha, testEnv)).toBe(true);
        // - Không phải tổ tiên: false (exit code 1)
        expect(await isAncestor(repoPath, secondSha, initialSha, testEnv)).toBe(false);
        // - Lỗi git fatal / ref không tồn tại: ném lỗi (không quy thành false)
        await expect(isAncestor(repoPath, 'nonexistent_commit_hash_1234567890', secondSha, testEnv)).rejects.toThrow();

        // 2. Kiểm tra isFirstParentAncestor:
        // - Đúng trong chuỗi first-parent: true
        expect(await isFirstParentAncestor(repoPath, initialSha, secondSha, testEnv)).toBe(true);
        // - Không nằm trong chuỗi first-parent: false
        expect(await isFirstParentAncestor(repoPath, secondSha, initialSha, testEnv)).toBe(false);
        // - Lỗi git fatal / ref không tồn tại: ném lỗi (fail-closed, không nuốt lỗi trả false)
        await expect(isFirstParentAncestor(repoPath, initialSha, 'nonexistent_ref_1234567890', testEnv)).rejects.toThrow();

        // 3. Tạo một merge commit hợp lệ
        execFileSync('git', ['checkout', '-b', 'agenthub/fail-closed-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'task-fc.txt'), 'fc\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: task fc'], { cwd: repoPath, env: testEnv });

        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/fail-closed-task', '-m', "Merge branch 'agenthub/fail-closed-task' into master"], { cwd: repoPath, env: testEnv });

        const taskRow: any = {
          id: 'proj/fail-closed-task',
          projectId: 'proj',
          slug: 'fail-closed-task',
          title: 'Fail Closed Task',
          branch: 'agenthub/fail-closed-task',
          baseRef: 'master',
        };

        // Khi môi trường bình thường, tìm thấy forward merge
        const normalMerges = await findForwardMergeCommitsForTask(repoPath, taskRow, ['master'], testEnv);
        expect(normalMerges.length).toBe(1);

        // 4. Khi task branch trỏ tới ref/SHA không hợp lệ dẫn tới ancestry verification thất bại:
        // findForwardMergeCommitsForTask bắt buộc fail-closed và trả về rỗng, không chấp nhận merge
        const invalidTaskRow: any = {
          ...taskRow,
          branch: '0000000000000000000000000000000000000000',
        };
        const invalidMerges = await findForwardMergeCommitsForTask(repoPath, invalidTaskRow, ['master'], testEnv);
        expect(invalidMerges).toEqual([]);

        // 5. Khi nhánh task đã bị xoá (hasBranch === false) và baseRef trỏ tới ref không hợp lệ,
        // không thể xác minh cấu trúc ancestry -> fail-closed và trả về rỗng
        execFileSync('git', ['branch', '-D', 'agenthub/fail-closed-task'], { cwd: repoPath, env: testEnv });
        const deletedTaskRowWithBadBase = {
          ...taskRow,
          baseRef: 'nonexistent-base-ref-12345',
        };
        const badBaseMerges = await findForwardMergeCommitsForTask(repoPath, deletedTaskRowWithBadBase, [], testEnv);
        expect(badBaseMerges).toEqual([]);
      });

      it('khi forward merge tồn tại nhưng remote base không resolve được, getTaskDiff fail-closed ném lỗi chứ không dùng earliestMergeP1', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const repoPath = path.join(tmpDir, 'local-unresolvable-remote-base');
        fs.mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'README.md'), '# Base\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

        // Tạo nhánh task
        execFileSync('git', ['checkout', '-b', 'agenthub/unres-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'unres.txt'), 'unres content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: unres work'], { cwd: repoPath, env: testEnv });

        // Merge task vào master
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/unres-task', '-m', "Merge branch 'agenthub/unres-task' into master"], { cwd: repoPath, env: testEnv });
        const mergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow = {
          id: 'proj/unres-task',
          projectId: 'proj',
          slug: 'unres-task',
          title: 'Unresolvable Remote Base Task',
          status: 'done',
          branch: 'agenthub/unres-task',
          baseRef: 'nonexistent-remote-base',
        } as unknown as Parameters<typeof getTaskDiff>[1];

        // Khi baseRef không tồn tại và không có remote tracking ref nào, getTaskDiff bắt buộc ném lỗi fail-closed,
        // tuyệt đối không dùng earliestMergeP1 hay fallback sang snapshot diff.
        await expect(
          getTaskDiff(
            repoPath,
            taskRow,
            'agenthub/unres-task',
            'nonexistent-target-branch',
            'nonexistent-base-ref',
            testEnv,
            null,
            mergeSha,
          ),
        ).rejects.toThrow(/Failed to resolve remote base commit/);
      });

      it('khi nhánh task không còn tồn tại cục bộ và p2 không chứa commit của task, không chấp nhận merge chỉ dựa vào commit message', async () => {
        const { findForwardMergeCommitsForTask } = await import('../src/publish.js');
        const repoPath = path.join(tmpDir, 'local-deleted-branch-unrelated-p2');
        fs.mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'README.md'), '# Base\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

        // Tạo một nhánh hoàn toàn khác với commit không liên quan đến task
        execFileSync('git', ['checkout', '-b', 'other-feature'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'unrelated.txt'), 'unrelated content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: completely unrelated commit'], { cwd: repoPath, env: testEnv });

        // Merge nhánh khác này vào master nhưng đặt message có tên nhánh task bị xoá
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'other-feature', '-m', "Merge branch 'agenthub/ghost-task' into master"], { cwd: repoPath, env: testEnv });

        const taskRow: any = {
          id: 'proj/ghost-task',
          projectId: 'proj',
          slug: 'ghost-task',
          title: 'Ghost Task',
          branch: 'agenthub/ghost-task',
          baseRef: 'master',
        };

        // Nhánh task không hề tồn tại (hasBranch === false), message khớp pattern nhưng p2 log không chứa task slug hay title.
        // findForwardMergeCommitsForTask bắt buộc fail closed và không chấp nhận merge này.
        const merges = await findForwardMergeCommitsForTask(repoPath, taskRow, ['master'], testEnv);
        expect(merges).toEqual([]);
      });

      it('khi rơi vào snapshot fallback nhưng remote base không resolve được, getTaskDiff fail-closed ném lỗi chứ không fallback sang branch/HEAD local', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const repoPath = path.join(tmpDir, 'local-snapshot-fallback-unresolvable-base');
        fs.mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'README.md'), '# Base\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

        // Tạo nhánh task với commit riêng, nhưng chưa hề merge
        execFileSync('git', ['checkout', '-b', 'agenthub/snapshot-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'snapshot.txt'), 'snapshot content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: snapshot task work'], { cwd: repoPath, env: testEnv });
        const snapshotSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow = {
          id: 'proj/snapshot-task',
          projectId: 'proj',
          slug: 'snapshot-task',
          title: 'Snapshot Task',
          status: 'done',
          branch: 'agenthub/snapshot-task',
          baseRef: 'master',
        } as unknown as Parameters<typeof getTaskDiff>[1];

        // Không có forward merge nào, getTaskDiff rơi vào khối snapshot fallback (!usedMergeDiff).
        // Khi remote base không resolve được (baseRef và targetBranch không có remote tracking ref tương ứng),
        // getTaskDiff bắt buộc fail-closed ném lỗi, tuyệt đối không dùng snapshotSha/master local/HEAD.
        await expect(
          getTaskDiff(
            repoPath,
            taskRow,
            'agenthub/snapshot-task',
            'master',
            'nonexistent-remote-base-ref',
            testEnv,
            snapshotSha,
          ),
        ).rejects.toThrow(/Failed to resolve remote base commit/);
      });

      it('khi baseRef là một SHA local chưa từng push lên remote, resolveRemoteAuditBase từ chối và fail-closed', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-local-sha.git');
        initBareRemote(remotePath);
        const repoPath = path.join(tmpDir, 'local-snapshot-sha-not-on-remote');
        initGitRepoWithRemote(repoPath, remotePath, 'master');

        // Tạo commit local-only trên master (chưa push)
        fs.writeFileSync(path.join(repoPath, 'local-unpushed.txt'), 'local only\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: local only'], { cwd: repoPath, env: testEnv });
        const localOnlySha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        execFileSync('git', ['checkout', '-b', 'agenthub/local-sha-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'file.txt'), 'content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: task work'], { cwd: repoPath, env: testEnv });
        const snapshotSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow = {
          id: 'proj/local-sha-task',
          projectId: 'proj',
          slug: 'local-sha-task',
          title: 'Local SHA Task',
          status: 'done',
          branch: 'agenthub/local-sha-task',
          baseRef: 'nonexistent-base',
        } as unknown as Parameters<typeof getTaskDiff>[1];

        // localOnlySha là 40 ký tự hex nhưng là commit local, không hề có trên refs/remotes/*.
        // resolveRemoteAuditBase bắt buộc từ chối và fail-closed ném lỗi, không được dùng local SHA này làm remote base.
        await expect(
          getTaskDiff(
            repoPath,
            taskRow,
            'agenthub/local-sha-task',
            'nonexistent-remote-target',
            localOnlySha,
            testEnv,
            snapshotSha,
          ),
        ).rejects.toThrow(/Failed to resolve remote base commit/);
      });

      describe('resolveRemoteAuditBase chỉ chấp nhận remote của đúng nhánh đích (audit P1)', () => {
        const git = (repo: string, ...args: string[]) =>
          execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: testEnv }).trim();
        const commitFile = (repo: string, name: string, msg: string) => {
          fs.writeFileSync(path.join(repo, name), `${msg}\n`);
          git(repo, 'add', '.');
          git(repo, 'commit', '-m', msg);
          return git(repo, 'rev-parse', 'HEAD');
        };
        const taskRow = (slug: string, baseRef = 'master') =>
          ({
            id: `proj/${slug}`,
            projectId: 'proj',
            slug,
            title: slug,
            status: 'done',
            branch: `agenthub/${slug}`,
            baseRef,
          }) as unknown as Parameters<typeof import('../src/publish.js').getTaskDiff>[1];

        /** Repo có origin/master, nhánh task chưa merge, trả về snapshot SHA của nhánh task. */
        const setup = (name: string) => {
          const remotePath = path.join(tmpDir, `${name}.git`);
          initBareRemote(remotePath);
          const repoPath = path.join(tmpDir, name);
          initGitRepoWithRemote(repoPath, remotePath, 'master');
          const initialSha = git(repoPath, 'rev-parse', 'HEAD');
          return { repoPath, remotePath, initialSha };
        };
        const addTaskBranch = (repoPath: string, slug: string) => {
          git(repoPath, 'checkout', '-q', '-b', `agenthub/${slug}`, 'master');
          return commitFile(repoPath, `${slug}.txt`, `feat: ${slug}`);
        };

        it('SHA local chưa push trong khi origin/master tồn tại -> ném lỗi, không dùng tip khác', async () => {
          const { getTaskDiff } = await import('../src/publish.js');
          const { repoPath } = setup('rrab-local-sha');
          const localOnlySha = commitFile(repoPath, 'local.txt', 'chore: local only');
          const snapshotSha = addTaskBranch(repoPath, 'local-sha');
          await expect(
            getTaskDiff(repoPath, taskRow('local-sha'), 'agenthub/local-sha', 'master', localOnlySha, testEnv, snapshotSha),
          ).rejects.toThrow(/is not on refs\/remotes\/origin\/master/);
        });

        it('SHA chỉ nằm trên một nhánh remote khác nhánh đích -> ném lỗi', async () => {
          const { getTaskDiff } = await import('../src/publish.js');
          const { repoPath } = setup('rrab-other-remote-sha');
          git(repoPath, 'checkout', '-q', '-b', 'feature-x');
          const otherSha = commitFile(repoPath, 'x.txt', 'feat: other branch');
          git(repoPath, 'push', '-q', 'origin', 'feature-x');
          git(repoPath, 'fetch', '-q', 'origin');
          expect(git(repoPath, 'rev-parse', 'refs/remotes/origin/feature-x')).toBe(otherSha);
          const snapshotSha = addTaskBranch(repoPath, 'other-remote');
          await expect(
            getTaskDiff(repoPath, taskRow('other-remote'), 'agenthub/other-remote', 'master', otherSha, testEnv, snapshotSha),
          ).rejects.toThrow(/is not on refs\/remotes\/origin\/master/);
        });

        it('baseRef tên một nhánh remote khác nhánh đích -> ném lỗi', async () => {
          const { getTaskDiff } = await import('../src/publish.js');
          const { repoPath } = setup('rrab-other-remote-name');
          git(repoPath, 'push', '-q', 'origin', 'master:feature-y');
          git(repoPath, 'fetch', '-q', 'origin');
          const snapshotSha = addTaskBranch(repoPath, 'other-name');
          await expect(
            getTaskDiff(repoPath, taskRow('other-name'), 'agenthub/other-name', 'master', 'origin/feature-y', testEnv, snapshotSha),
          ).rejects.toThrow(/baseRef does not point to refs\/remotes\/origin\/master/);
        });

        it('origin/<targetBranch> không tồn tại dù origin/<task.baseRef> có -> ném lỗi', async () => {
          const { getTaskDiff } = await import('../src/publish.js');
          const { repoPath } = setup('rrab-missing-target');
          const snapshotSha = addTaskBranch(repoPath, 'missing-target');
          expect(git(repoPath, 'rev-parse', 'refs/remotes/origin/master')).toBeTruthy();
          await expect(
            getTaskDiff(repoPath, taskRow('missing-target', 'master'), 'agenthub/missing-target', 'release', 'release', testEnv, snapshotSha),
          ).rejects.toThrow(/refs\/remotes\/origin\/release does not exist/);
        });

        it('lỗi git khi xác minh ancestry (SHA không tồn tại) -> ném lỗi, không fallback', async () => {
          const { getTaskDiff } = await import('../src/publish.js');
          const { repoPath } = setup('rrab-git-error');
          const snapshotSha = addTaskBranch(repoPath, 'git-error');
          await expect(
            getTaskDiff(repoPath, taskRow('git-error'), 'agenthub/git-error', 'master', 'f'.repeat(40), testEnv, snapshotSha),
          ).rejects.toThrow();
          await expect(
            getTaskDiff(repoPath, taskRow('git-error'), 'agenthub/git-error', 'master', 'f'.repeat(40), testEnv, snapshotSha),
          ).rejects.not.toThrow(/is not on/);
        });

        it('SHA là tổ tiên của origin/master -> dùng đúng SHA đó làm mốc', async () => {
          const { getTaskDiff } = await import('../src/publish.js');
          const { repoPath, initialSha } = setup('rrab-valid-sha');
          const snapshotSha = addTaskBranch(repoPath, 'valid-sha');
          const res = await getTaskDiff(repoPath, taskRow('valid-sha'), 'agenthub/valid-sha', 'master', initialSha, testEnv, snapshotSha);
          expect(res.changedFiles).toEqual(['valid-sha.txt']);
        });

        it('discovery fail-closed: ref nhánh task tồn tại nhưng không đọc được commit -> ném lỗi, không coi như nhánh đã xoá', async () => {
          const { findMergeCandidatesForTask } = await import('../src/publish.js');
          const { repoPath } = setup('rrab-broken-branch-ref');
          // Ref tồn tại nhưng trỏ tới blob, nên `rev-parse <ref>^{commit}` thất bại.
          const blobSha = execFileSync('git', ['-C', repoPath, 'hash-object', '-w', '--stdin'], {
            input: 'not a commit\n', encoding: 'utf8', env: testEnv,
          }).trim();
          // git update-ref từ chối nhánh trỏ vào non-commit, nên ghi thẳng file ref.
          fs.mkdirSync(path.join(repoPath, '.git', 'refs', 'heads', 'agenthub'), { recursive: true });
          fs.writeFileSync(path.join(repoPath, '.git', 'refs', 'heads', 'agenthub', 'broken-ref'), `${blobSha}\n`);
          await expect(
            findMergeCandidatesForTask(repoPath, taskRow('broken-ref'), ['master'], testEnv, true),
          ).rejects.toThrow(/Failed to verify task branch ref "refs\/heads\/agenthub\/broken-ref"/);
          // Không fail-closed thì vẫn giữ hành vi cũ: coi như không có nhánh và tiếp tục.
          await expect(
            findMergeCandidatesForTask(repoPath, taskRow('broken-ref'), ['master'], testEnv, false),
          ).resolves.toEqual({ forwardMerges: [], rejectedMerges: [] });
        });

        it('discovery fail-closed: nhánh task đã xoá, merge có message khớp slug -> ném lỗi thay vì tin heuristic', async () => {
          const { findMergeCandidatesForTask } = await import('../src/publish.js');
          const { repoPath } = setup('rrab-deleted-branch');
          addTaskBranch(repoPath, 'gone');
          git(repoPath, 'checkout', '-q', 'master');
          git(repoPath, 'merge', '--no-ff', '-q', '-m', "Merge branch 'agenthub/gone' into master", 'agenthub/gone');
          git(repoPath, 'branch', '-D', 'agenthub/gone');
          await expect(
            findMergeCandidatesForTask(repoPath, taskRow('gone'), ['master'], testEnv, true, true),
          ).rejects.toThrow(/Cannot verify task source for audit discovery/);
          // getTaskDiff (audit diff) luôn bắt buộc có ref nhánh task.
          const { getTaskDiff } = await import('../src/publish.js');
          await expect(
            getTaskDiff(repoPath, taskRow('gone'), 'master', 'master', 'master', testEnv),
          ).rejects.toThrow(/Cannot verify task source for audit discovery/);
          // Liệt kê task cần audit (không bắt buộc ref) không bị chặn bởi một task cũ đã xoá nhánh.
          await expect(
            findMergeCandidatesForTask(repoPath, taskRow('gone'), ['master'], testEnv, true),
          ).resolves.toBeDefined();
        });

        it('remote không phải origin: dùng refs/remotes/<remote>/<targetBranch>', async () => {
          const { getTaskDiff } = await import('../src/publish.js');
          const { repoPath, remotePath } = setup('rrab-custom-remote');
          git(repoPath, 'remote', 'add', 'upstream', remotePath);
          git(repoPath, 'fetch', '-q', 'upstream');
          const snapshotSha = addTaskBranch(repoPath, 'custom-remote');
          const res = await getTaskDiff(
            repoPath, taskRow('custom-remote'), 'agenthub/custom-remote', 'master',
            'refs/remotes/upstream/master', testEnv, snapshotSha, undefined, 'upstream',
          );
          expect(res.changedFiles).toEqual(['custom-remote.txt']);
          await expect(
            getTaskDiff(repoPath, taskRow('custom-remote'), 'agenthub/custom-remote', 'master', 'refs/remotes/upstream/master', testEnv, snapshotSha),
          ).rejects.toThrow(/baseRef does not point to refs\/remotes\/origin\/master/);
        });
      });

      it('publishTask fail-closed khi không có prevRemoteSha và không thể resolve remote base (không dùng targetSha local)', async () => {
        const remotePath = path.join(tmpDir, 'remote-publish-no-remote-base.git');
        initBareRemote(remotePath);
        const repoPath = path.join(tmpDir, 'local-publish-no-remote-base');
        fs.mkdirSync(repoPath, { recursive: true });
        execFileSync('git', ['init', '-b', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoPath, env: testEnv });

        execFileSync('git', ['checkout', '-b', 'agenthub/no-remote-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature code\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: no remote feature'], { cwd: repoPath, env: testEnv });

        // Tạo project không có remote tracking branch
        ctx.service.createProject({
          id: 'proj-no-remote',
          name: 'Project No Remote',
          path: repoPath,
          defaultBranch: 'master',
          settings: {
            integration: { enabled: false },
            publish: {
              enabled: true,
              remote: 'origin',
              branch: 'master',
              audit: { enabled: true, maxFixRounds: 2 },
            },
          },
        });

        const taskRow: any = {
          id: 'proj-no-remote/no-remote-task',
          projectId: 'proj-no-remote',
          slug: 'no-remote-task',
          title: 'No Remote Task',
          status: 'done',
          branch: 'agenthub/no-remote-task',
          baseRef: 'master',
        };
        ctx.taskRepo.insert(taskRow);

        // Khi publish, vì không có prevRemoteSha và origin/master không tồn tại,
        // publishTask bắt buộc fail-closed với state push_failed và không được dùng targetSha/sourceSha local
        const pubResult = await ctx.service.publishTask('proj-no-remote/no-remote-task');
        expect(pubResult.ok).toBe(false);
        if (!pubResult.ok) {
          expect(pubResult.error).toMatch(/Failed to resolve remote base commit/);
        }
        const updatedTask = ctx.taskRepo.get('proj-no-remote/no-remote-task');
        const pr = JSON.parse(updatedTask?.pushResult || '{}');
        expect(pr.state).toBe('push_failed');
        expect(pr.error).toMatch(/Failed to resolve remote base commit/);
      });

      it('ở project không dùng integration, khi nhánh task có reverse merge và không có forward merge, getTaskDiff fail-closed ném lỗi chứ không snapshot fallback', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-non-integ-rev.git');
        initBareRemote(remotePath);
        const repoPath = path.join(tmpDir, 'local-non-integ-rev');
        initGitRepoWithRemote(repoPath, remotePath, 'master');
        const initialCommit = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Commit ngoài phạm vi trên master (đã có trên remote)
        fs.writeFileSync(path.join(repoPath, 'approvals.txt'), 'other approvals content\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat(approvals): approvals feature'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['push', 'origin', 'master'], { cwd: repoPath, env: testEnv });
        const remoteMasterSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'origin/master'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo nhánh task agenthub/rev-task từ initialCommit
        execFileSync('git', ['checkout', '-b', 'agenthub/rev-task', initialCommit], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'rev-task.txt'), 'rev task work\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: rev task work'], { cwd: repoPath, env: testEnv });

        // Reverse merge master vào nhánh task
        execFileSync('git', ['merge', '--no-ff', 'master', '-m', "Merge branch 'master' into agenthub/rev-task"], { cwd: repoPath, env: testEnv });
        const taskTipSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow = {
          id: 'proj/rev-task',
          projectId: 'proj',
          slug: 'rev-task',
          title: 'Rev Task',
          status: 'done',
          branch: 'agenthub/rev-task',
          baseRef: 'master',
        } as unknown as Parameters<typeof getTaskDiff>[1];

        // Nhánh task chưa hề forward merge vào master. Tip nhánh task chứa reverse merge mang approvals sang.
        // getTaskDiff bắt buộc fail-closed ném lỗi, tuyệt đối không rơi xuống snapshot fallback lấy tip sau reverse merge.
        await expect(
          getTaskDiff(
            repoPath,
            taskRow,
            'agenthub/rev-task',
            'master',
            remoteMasterSha,
            testEnv,
            taskTipSha,
            null,
          ),
        ).rejects.toThrow(/reverse merge/i);
      });

      it('ở project không dùng integration, khi candidate merge bị loại (rejected) và không có forward merge, getTaskDiff fail-closed ném lỗi', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-rejected-merge.git');
        initBareRemote(remotePath);
        const repoPath = path.join(tmpDir, 'local-rejected-merge');
        initGitRepoWithRemote(repoPath, remotePath, 'master');
        const remoteMasterSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'origin/master'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo nhánh task
        execFileSync('git', ['checkout', '-b', 'agenthub/rej-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'rej-task.txt'), 'rej task work\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: rej task work'], { cwd: repoPath, env: testEnv });
        const taskSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo một reverse merge trên master với subject "into agenthub/rej-task"
        execFileSync('git', ['checkout', 'master'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['merge', '--no-ff', 'agenthub/rej-task', '-m', "Merge branch 'master' into agenthub/rej-task"], { cwd: repoPath, env: testEnv });
        const rejMergeSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow = {
          id: 'proj/rej-task',
          projectId: 'proj',
          slug: 'rej-task',
          title: 'Rej Task',
          status: 'done',
          branch: 'agenthub/rej-task',
          baseRef: 'master',
        } as unknown as Parameters<typeof getTaskDiff>[1];

        // Merge commit bị loại do reverse merge, và không có forward merge hợp lệ nào.
        // getTaskDiff bắt buộc fail-closed ném lỗi, tuyệt đối không rơi xuống snapshot fallback.
        await expect(
          getTaskDiff(
            repoPath,
            taskRow,
            'agenthub/rej-task',
            'master',
            remoteMasterSha,
            testEnv,
            taskSha,
            rejMergeSha,
          ),
        ).rejects.toThrow(/candidate merge was rejected/i);
      });

      it('ở project không dùng integration, khi nhánh task sạch không có merge, snapshot fallback hoạt động bình thường', async () => {
        const { getTaskDiff } = await import('../src/publish.js');
        const remotePath = path.join(tmpDir, 'remote-clean-linear.git');
        initBareRemote(remotePath);
        const repoPath = path.join(tmpDir, 'local-clean-linear');
        initGitRepoWithRemote(repoPath, remotePath, 'master');
        const remoteMasterSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'origin/master'], { encoding: 'utf8', env: testEnv }).trim();

        // Tạo nhánh task với các commit sạch tuần tự
        execFileSync('git', ['checkout', '-b', 'agenthub/clean-task'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'clean-1.txt'), 'clean 1\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: clean 1'], { cwd: repoPath, env: testEnv });
        fs.writeFileSync(path.join(repoPath, 'clean-2.txt'), 'clean 2\n');
        execFileSync('git', ['add', '.'], { cwd: repoPath, env: testEnv });
        execFileSync('git', ['commit', '-m', 'feat: clean 2'], { cwd: repoPath, env: testEnv });
        const cleanTipSha = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: testEnv }).trim();

        const taskRow = {
          id: 'proj/clean-task',
          projectId: 'proj',
          slug: 'clean-task',
          title: 'Clean Task',
          status: 'done',
          branch: 'agenthub/clean-task',
          baseRef: 'master',
        } as unknown as Parameters<typeof getTaskDiff>[1];

        // Nhánh task sạch không có reverse merge, getTaskDiff snapshot fallback hoạt động thành công
        const diffRes = await getTaskDiff(
          repoPath,
          taskRow,
          'agenthub/clean-task',
          'master',
          remoteMasterSha,
          testEnv,
          cleanTipSha,
          null,
        );

        expect(diffRes.commitSha).toBe(cleanTipSha);
        expect(diffRes.auditRange).toBe(`${remoteMasterSha}..${cleanTipSha}`);
        expect(diffRes.changedFiles).toEqual(expect.arrayContaining(['clean-1.txt', 'clean-2.txt']));
        expect(diffRes.diff).toContain('clean 1');
        expect(diffRes.diff).toContain('clean 2');
      });
    });
  });
});
