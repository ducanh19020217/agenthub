import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { isGitAncestor, computeDeliveryIssue, clearGitCheckCache } from '../src/services/delivery-issues.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeEngine: FakeEngine;

function authHeaders() {
  return {
    host: '127.0.0.1:7791',
    authorization: `Bearer ${token}`,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function setupGitRepo(): { repoPath: string; taskBranch: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-repo-'));
  git(repoPath, 'init');
  git(repoPath, 'checkout', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'AgentHub Test');
  fs.writeFileSync(path.join(repoPath, 'file.txt'), 'line 1\n');
  git(repoPath, 'add', 'file.txt');
  git(repoPath, 'commit', '-m', 'Initial commit');

  // Create integration branch
  git(repoPath, 'branch', 'agenthub/integration');

  // Create task branch
  const taskBranch = 'agenthub/t-test-1';
  git(repoPath, 'checkout', '-b', taskBranch);
  fs.writeFileSync(path.join(repoPath, 'file.txt'), 'line 1\nline 2 task\n');
  git(repoPath, 'add', 'file.txt');
  git(repoPath, 'commit', '-m', 'Task commit');

  git(repoPath, 'checkout', 'main');
  return { repoPath, taskBranch };
}

describe('Delivery issues (merge_failed & push_failed)', () => {
  beforeEach(async () => {
    clearGitCheckCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-delivery-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.port = 7791;
    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    clearGitCheckCache();
    await server.close();
    ctx.db.close();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects merge_failed derived status and returns it in GET /api/tasks and GET /api/tasks/:id', async () => {
    ctx.projectRepo.insert({
      id: 'proj1',
      name: 'Project 1',
      path: path.join(tmpDir, 'nonexistent'),
      defaultBranch: 'main',
      maxParallel: 1,
    });

    const taskId = 'task-1';
    ctx.taskRepo.insert({
      id: taskId,
      projectId: 'proj1',
      slug: 't-test-1',
      title: 'Task with merge failure',
      status: 'review',
    });

    // Emit merge.conflict event
    ctx.eventRepo.insert('merge.conflict', taskId, {
      actor: 'auto-merge',
      message: 'Xung đột merge ở: src/index.ts, docs/DECISIONS.md',
      files: ['src/index.ts', 'docs/DECISIONS.md'],
    });

    // 1. GET /api/tasks/:id has deliveryIssue
    const resTask = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: authHeaders(),
    });
    expect(resTask.statusCode).toBe(200);
    const taskData = resTask.json();
    expect(taskData.deliveryIssue).toBeDefined();
    expect(taskData.deliveryIssue.kind).toBe('merge_failed');
    expect(taskData.deliveryIssue.files).toEqual(['src/index.ts', 'docs/DECISIONS.md']);

    // 2. GET /api/tasks?derived=merge_failed
    const resList = await server.inject({
      method: 'GET',
      url: '/api/tasks?derived=merge_failed',
      headers: authHeaders(),
    });
    expect(resList.statusCode).toBe(200);
    const list = resList.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(taskId);

    // 3. GET /api/tasks?limit=10&derived=merge_failed (pagination)
    const resPage = await server.inject({
      method: 'GET',
      url: '/api/tasks?limit=10&derived=merge_failed',
      headers: authHeaders(),
    });
    expect(resPage.statusCode).toBe(200);
    const page = resPage.json();
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);

    // 4. GET /api/status has merge_failed count
    const resStatus = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: authHeaders(),
    });
    expect(resStatus.statusCode).toBe(200);
    const statusData = resStatus.json();
    expect(statusData.tasks.merge_failed).toBe(1);

    // 5. GET /api/tasks/:id/timeline has merge_failed step
    const resTimeline = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/timeline`,
      headers: authHeaders(),
    });
    expect(resTimeline.statusCode).toBe(200);
    const timeline = resTimeline.json();
    expect(timeline.some((step: { status: string }) => step.status === 'merge_failed')).toBe(true);
  });

  it('detects push_failed derived status for done tasks and returns it in APIs', async () => {
    ctx.projectRepo.insert({
      id: 'proj2',
      name: 'Project 2',
      path: path.join(tmpDir, 'nonexistent'),
      defaultBranch: 'main',
      maxParallel: 1,
    });

    const taskId = 'task-2';
    ctx.taskRepo.insert({
      id: taskId,
      projectId: 'proj2',
      slug: 't-test-2',
      title: 'Task with push failure',
      status: 'done',
    });

    ctx.taskRepo.update(taskId, {
      pushResult: JSON.stringify({ state: 'push_failed', error: 'remote rejected: protected branch', failedAt: '2026-11-13T10:00:00.000Z' }),
    });
    ctx.eventRepo.insert('task.push_failed', taskId, {
      error: 'remote rejected: protected branch',
    });

    // 1. GET /api/tasks/:id has deliveryIssue
    const resTask = await server.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: authHeaders(),
    });
    expect(resTask.statusCode).toBe(200);
    const taskData = resTask.json();
    expect(taskData.deliveryIssue).toBeDefined();
    expect(taskData.deliveryIssue.kind).toBe('push_failed');
    expect(taskData.deliveryIssue.error).toContain('remote rejected');

    // 2. GET /api/tasks?derived=push_failed
    const resList = await server.inject({
      method: 'GET',
      url: '/api/tasks?derived=push_failed',
      headers: authHeaders(),
    });
    expect(resList.statusCode).toBe(200);
    const list = resList.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(taskId);

    // 3. Status counts
    const resStatus = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: authHeaders(),
    });
    expect(resStatus.statusCode).toBe(200);
    expect(resStatus.json().tasks.push_failed).toBe(1);
  });

  it('does not falsely report merge_failed when branch was manually merged into target in git', async () => {
    const { repoPath, taskBranch } = setupGitRepo();
    try {
      ctx.projectRepo.insert({
        id: 'proj-git',
        name: 'Project Git',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 1,
      });

      const taskId = 'task-git';
      ctx.taskRepo.insert({
        id: taskId,
        projectId: 'proj-git',
        slug: 't-test-1',
        branch: taskBranch,
        title: 'Task merged manually',
        status: 'done',
      });

      // Initially there was a merge conflict event
      ctx.eventRepo.insert('merge.conflict', taskId, {
        actor: 'auto-merge',
        message: 'Xung đột merge ở: file.txt',
      });

      const project = ctx.projectRepo.get('proj-git')!;

      // Before manual merge: isGitAncestor is false
      expect(isGitAncestor(repoPath, taskBranch, 'agenthub/integration')).toBe(false);
      let issue = computeDeliveryIssue(ctx.taskRepo.get(taskId)!, ctx.eventRepo.getByTask(taskId), project);
      expect(issue).not.toBeNull();
      expect(issue?.kind).toBe('merge_failed');

      // Now someone manually merges taskBranch into agenthub/integration!
      git(repoPath, 'checkout', 'agenthub/integration');
      git(repoPath, 'merge', '--no-ff', taskBranch, '-m', "Manual merge of task");
      git(repoPath, 'checkout', 'main');

      // After manual merge: isGitAncestor is true!
      clearGitCheckCache();
      expect(isGitAncestor(repoPath, taskBranch, 'agenthub/integration')).toBe(true);

      // computeDeliveryIssue now returns null!
      issue = computeDeliveryIssue(ctx.taskRepo.get(taskId)!, ctx.eventRepo.getByTask(taskId), project);
      expect(issue).toBeNull();

      // GET /api/tasks/:id has deliveryIssue: null
      const resTask = await server.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: authHeaders(),
      });
      expect(resTask.json().deliveryIssue).toBeNull();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('POST /api/tasks/:id/merge/retry returns conflict files on conflict and disappears on success', async () => {
    const { repoPath, taskBranch } = setupGitRepo();
    try {
      // Create integration worktree
      const intWorktree = path.join(tmpDir, 'int-worktree');
      git(repoPath, 'worktree', 'add', intWorktree, 'agenthub/integration');

      ctx.projectRepo.insert({
        id: 'proj-retry',
        name: 'Project Retry',
        path: repoPath,
        defaultBranch: 'main',
        maxParallel: 1,
        settings: JSON.stringify({ publish: { enabled: false } }),
        merge: JSON.stringify({
          enabled: true,
          worktrees: { 'agenthub/integration': intWorktree, 'main': intWorktree },
          checks: [],
          timeoutSec: 30,
        }),
      });

      const taskId = 'task-retry';
      ctx.taskRepo.insert({
        id: taskId,
        projectId: 'proj-retry',
        slug: 't-test-1',
        branch: taskBranch,
        title: 'Task retry test',
        status: 'review',
      });

      // Create a conflicting change on integration
      fs.writeFileSync(path.join(intWorktree, 'file.txt'), 'line 1\nconflicting change\n');
      git(intWorktree, 'add', 'file.txt');
      git(intWorktree, 'commit', '-m', 'Conflicting commit on integration');

      // 1. Retry merge -> fails with conflict and returns list of files
      const resRetryConflict = await server.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/merge/retry`,
        headers: authHeaders(),
      });
      expect(resRetryConflict.statusCode).toBe(409);
      const conflictBody = resRetryConflict.json();
      expect(conflictBody.error).toBe('conflict');
      expect(conflictBody.files).toBeDefined();
      expect(conflictBody.files).toContain('file.txt');

      // 2. Assign worker to resolve conflict
      const resAssign = await server.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/merge/retry`,
        headers: authHeaders(),
        payload: { assignWorker: true },
      });
      expect(resAssign.statusCode).toBe(200);
      const assignBody = resAssign.json();
      expect(assignBody.ok).toBe(true);
      expect(assignBody.status).toBe('queued');
      expect(assignBody.assignedWorker).toBe(true);

      const updatedTask = ctx.taskRepo.get(taskId)!;
      expect(updatedTask.status).toBe('queued');
      expect(updatedTask.body).toContain('file.txt');

      // 3. Resolve the conflict on task branch
      git(repoPath, 'checkout', taskBranch);
      // Merge integration and resolve
      try {
        git(repoPath, 'merge', 'agenthub/integration');
      } catch {
        // Resolve conflict
        fs.writeFileSync(path.join(repoPath, 'file.txt'), 'line 1\nconflicting change\nline 2 task\n');
        git(repoPath, 'add', 'file.txt');
        git(repoPath, 'commit', '-m', 'Resolved conflict');
      }
      git(repoPath, 'checkout', 'main');

      // Put task back to review/done
      ctx.taskRepo.update(taskId, { status: 'review' });

      // 4. Retry merge again -> succeeds!
      const resRetrySuccess = await server.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/merge/retry`,
        headers: authHeaders(),
      });
      expect(resRetrySuccess.statusCode).toBe(200);
      const successBody = resRetrySuccess.json();
      expect(successBody.ok).toBe(true);
      expect(successBody.mergeCommit).toBeDefined();

      // Derived status disappears
      const resFinalTask = await server.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: authHeaders(),
      });
      expect(resFinalTask.json().deliveryIssue).toBeNull();
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
