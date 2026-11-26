import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { createContext, DaemonContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { createMcpServer } from '../src/mcp/index.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import { HttpError } from '../src/errors.js';
import { clearGitCheckCache } from '../src/services/delivery-issues.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initGitRepo(repoPath: string, branch = 'main'): void {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--template=');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'AgentHub Test');
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial Repo\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'Initial commit');
  git(repoPath, 'checkout', '-B', branch);
}

describe('Stale baseRef & merge_failed handling', () => {
  let tmpDir: string;
  let token: string;
  let port: number;
  let ctx: DaemonContext;
  let server: FastifyInstance;

  beforeEach(async () => {
    clearGitCheckCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-stale-baseref-'));
    const agyHomes = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomes, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomes;

    token = getOrCreateToken(path.join(tmpDir, 'token'));
    const config = loadConfig(tmpDir);
    config.port = 0;
    config.agyHomesDir = agyHomes;

    const engines = new Map<string, Engine>([
      ['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))],
    ]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    const profileHome = path.join(agyHomes, 'prof-1');
    fs.mkdirSync(profileHome, { recursive: true });
    ctx.profileRepo.upsert({
      name: 'prof-1',
      engine: 'agy',
      kind: 'isolated',
      home: profileHome,
      email: 'prof1@example.com',
      enabled: 1,
    });

    server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    port = (server.server.address() as net.AddressInfo).port;
    process.env.AGENTHUB_PORT = String(port);
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    ctx.healthSweepService.stop();
    await server.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_PORT;
  });

  function authHeaders() {
    return {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${token}`,
    };
  }

  function persistPassedCheck(taskId: string, suffix: string): void {
    const runId = `check-${suffix}`;
    ctx.runRepo.insert({ id: runId, taskId, engine: 'hub', model: 'checks', profileName: 'hub' });
    ctx.db.prepare("INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, 'lint', 1, 0, 1, 'ok')").run(taskId, runId);
  }

  it('blocks config errors on auto-merge without requeueing workers across scheduler ticks and health sweep', async () => {
    const repo = path.join(tmpDir, 'repo-config-err');
    initGitRepo(repo, 'main');
    git(repo, 'checkout', '-b', 'agenthub/feat-missing-base');
    fs.writeFileSync(path.join(repo, 'feat.txt'), 'feat\n');
    git(repo, 'add', 'feat.txt');
    git(repo, 'commit', '-m', 'feat commit');
    git(repo, 'checkout', '--detach');
    const intWt = path.join(tmpDir, 'int-config-err');
    git(repo, 'worktree', 'add', intWt, 'main');

    ctx.service.createProject({
      id: 'cfg-proj',
      name: 'Config Error Project',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: false }, review: { autoMerge: true } },
      reviewChain: [{ reviewer: 'codex:gpt-5.6-luna', mode: 'gate' }],
      merge: { enabled: true, worktrees: { main: intWt }, checks: [], timeoutSec: 30 },
    });

    ctx.taskRepo.insert({
      id: 'cfg-proj/feat-missing-base',
      projectId: 'cfg-proj',
      slug: 'feat-missing-base',
      title: 'Missing baseRef',
      branch: 'agenthub/feat-missing-base',
      baseRef: 'agenthub/nonexistent-parent',
      status: 'review',
    });
    ctx.taskRepo.update('cfg-proj/feat-missing-base', { reviewStep: 1 });
    persistPassedCheck('cfg-proj/feat-missing-base', 'cfg1');
    ctx.reviewRepo.insert({
      id: 'rev-cfg-1',
      taskId: 'cfg-proj/feat-missing-base',
      verdict: 'approved',
      feedback: 'approved',
      actor: 'codex-reviewer',
    });

    await ctx.service.autoMergeReviewedTask('cfg-proj/feat-missing-base');

    const blockedTask = ctx.taskRepo.get('cfg-proj/feat-missing-base')!;
    expect(blockedTask.status).toBe('blocked');

    const events = ctx.eventRepo.getByTask(blockedTask.id);
    expect(events.some((e) => e.type === 'merge.conflict')).toBe(false);
    expect(events.some((e) => e.type === 'task.queued')).toBe(false);

    const skipped = events.find((e) => e.type === 'review.auto_merge_skipped');
    expect(skipped).toBeDefined();
    expect(JSON.parse(skipped!.payload!)).toMatchObject({ reason: 'base_ref_unavailable' });

    const blockedEvt = events.find((e) => e.type === 'task.blocked');
    expect(blockedEvt).toBeDefined();
    expect(JSON.parse(blockedEvt!.payload!)).toMatchObject({ reason: 'merge_config' });

    // Scheduler tick and health sweep must NOT spawn any worker run
    const runsBeforeSweep = ctx.runRepo.getByTask(blockedTask.id).length;
    ctx.scheduler.tick();
    await ctx.healthSweepService.runSweep();
    const runsAfterSweep = ctx.runRepo.getByTask(blockedTask.id);
    expect(runsAfterSweep).toHaveLength(runsBeforeSweep);
    expect(ctx.taskRepo.get(blockedTask.id)!.status).toBe('blocked');

    // Assigning worker via retryTaskMerge must also refuse with 409 config
    await expect(
      ctx.service.retryTaskMerge(blockedTask.id, { assignWorker: true }),
    ).rejects.toMatchObject<Partial<HttpError>>({ statusCode: 409, error: 'config' });
    expect(ctx.taskRepo.get(blockedTask.id)!.status).toBe('blocked');
  });

  it('warns and clears stale baseRef on API and MCP hub_create_task for pushed and cancelled source tasks', async () => {
    const repo = path.join(tmpDir, 'repo-create');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'create-proj',
      name: 'Create Project',
      path: repo,
      defaultBranch: 'main',
      merge: { enabled: true, worktrees: { main: repo }, checks: [], timeoutSec: 30 },
    });

    ctx.taskRepo.insert({
      id: 'create-proj/old-pushed',
      projectId: 'create-proj',
      slug: 'old-pushed',
      title: 'Old pushed task',
      branch: 'agenthub/old-pushed',
      status: 'pushed',
    });
    ctx.taskRepo.insert({
      id: 'create-proj/old-cancelled',
      projectId: 'create-proj',
      slug: 'old-cancelled',
      title: 'Old cancelled task',
      branch: 'agenthub/old-cancelled',
      status: 'cancelled',
    });

    const mcpServer = createMcpServer({ port, token, baseUrl: `http://127.0.0.1:${port}` });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      const mcpResult = await client.callTool({
        name: 'hub_create_task',
        arguments: {
          project: 'create-proj',
          slug: 'follow-pushed',
          title: 'Follow pushed',
          body: 'Do work',
          baseRef: 'agenthub/old-pushed',
        },
      });
      const text = (mcpResult.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('⚠');
      expect(text).toContain('agenthub/old-pushed');

      const createdFromMcp = ctx.taskRepo.get('create-proj/follow-pushed')!;
      expect(createdFromMcp.baseRef).toBeNull();
      expect(ctx.eventRepo.getByTask(createdFromMcp.id).some((e) => e.type === 'merge.base_ref_retargeted')).toBe(true);
    } finally {
      await client.close();
    }

    const apiCreated = ctx.service.createTask({
      project: 'create-proj',
      slug: 'follow-cancelled',
      title: 'Follow cancelled',
      body: 'Do work',
      baseRef: 'agenthub/old-cancelled',
    }) as unknown as { baseRef: string | null; baseRefWarning?: string };
    expect(apiCreated.baseRef).toBeNull();
    expect(apiCreated.baseRefWarning).toContain('agenthub/old-cancelled');
  });

  it('rebases dependent task baseRef to defaultBranch when parent dependency is pushed', () => {
    const repo = path.join(tmpDir, 'repo-dep');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'dep-proj',
      name: 'Dependency Rebase Project',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: false } },
      merge: { enabled: true, worktrees: { main: repo }, checks: [], timeoutSec: 30 },
    });

    ctx.taskRepo.insert({
      id: 'dep-proj/parent',
      projectId: 'dep-proj',
      slug: 'parent',
      title: 'Parent',
      branch: 'agenthub/parent',
      status: 'running',
    });

    ctx.service.createTask({
      project: 'dep-proj',
      slug: 'child',
      title: 'Child',
      body: 'Child task',
      dependsOn: ['dep-proj/parent'],
      baseRef: 'agenthub/parent',
      start: true,
    });

    // Parent task is pushed
    ctx.taskRepo.update('dep-proj/parent', { status: 'pushed', pushedAt: new Date().toISOString() });
    ctx.scheduler.tick();

    const child = ctx.taskRepo.get('dep-proj/child')!;
    expect(child.baseRef).toBe('main');
    expect(ctx.eventRepo.getByTask(child.id).some((e) => e.type === 'merge.base_ref_retargeted')).toBe(true);
    expect(child.worktreePath).toBeTruthy();
    expect(git(child.worktreePath!, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
  });

  it('excludes pushed, done+pushedAt, and cancelled tasks from /api/status merge_failed and clears autoMergeSkippedReason', async () => {
    const repo = path.join(tmpDir, 'repo-status');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'st-proj',
      name: 'Status Project',
      path: repo,
      defaultBranch: 'main',
      merge: { enabled: true, worktrees: { main: repo }, checks: [], timeoutSec: 30 },
    });

    const insertWithLegacySkip = (slug: string, status: string, pushedAt?: string) => {
      const id = `st-proj/${slug}`;
      ctx.taskRepo.insert({
        id,
        projectId: 'st-proj',
        slug,
        title: slug,
        branch: `agenthub/${slug}`,
        status,
      });
      if (pushedAt) {
        ctx.taskRepo.update(id, { pushedAt });
      }
      ctx.eventRepo.insert('merge.failed', id, { message: 'Legacy merge failure' });
      ctx.eventRepo.insert('review.auto_merge_skipped', id, { reason: 'merge_failed', reviewId: `r-${slug}` });
      return id;
    };

    const pushedId = insertWithLegacySkip('legacy-pushed', 'pushed', new Date().toISOString());
    const donePushedId = insertWithLegacySkip('legacy-done-pushed', 'done', new Date().toISOString());
    const cancelledId = insertWithLegacySkip('legacy-cancelled', 'cancelled');
    const activeFailedId = insertWithLegacySkip('active-merge-failed', 'review');

    const statusRes = await server.inject({ method: 'GET', url: '/api/status', headers: authHeaders() });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().tasks.merge_failed).toBe(1);

    const listRes = await server.inject({ method: 'GET', url: '/api/tasks?derived=merge_failed', headers: authHeaders() });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().map((t: { id: string }) => t.id)).toEqual([activeFailedId]);

    for (const id of [pushedId, donePushedId, cancelledId]) {
      const detailRes = await server.inject({
        method: 'GET',
        url: `/api/tasks/${encodeURIComponent(id.replace('/', '~'))}`,
        headers: authHeaders(),
      });
      expect(detailRes.statusCode).toBe(200);
      expect(detailRes.json().autoMergeSkippedReason).toBeNull();
    }

    const activeDetail = await server.inject({
      method: 'GET',
      url: `/api/tasks/${encodeURIComponent(activeFailedId.replace('/', '~'))}`,
      headers: authHeaders(),
    });
    expect(activeDetail.json().autoMergeSkippedReason).toBe('merge_failed');
  });

  it('retargets stale baseRef during retryTaskMerge, emits event, updates DB baseRef, and clears autoMergeSkippedReason', async () => {
    const repo = path.join(tmpDir, 'repo-retry');
    initGitRepo(repo, 'main');

    // Prior task already merged into main and pushed
    git(repo, 'checkout', '-b', 'agenthub/prior');
    fs.writeFileSync(path.join(repo, 'prior.txt'), 'prior\n');
    git(repo, 'add', 'prior.txt');
    git(repo, 'commit', '-m', 'prior');

    // Follow-up task branched from prior
    git(repo, 'checkout', '-b', 'agenthub/next', 'agenthub/prior');
    fs.writeFileSync(path.join(repo, 'next.txt'), 'next\n');
    git(repo, 'add', 'next.txt');
    git(repo, 'commit', '-m', 'next');
    git(repo, 'checkout', '--detach');

    const intWt = path.join(tmpDir, 'int-retry');
    git(repo, 'worktree', 'add', intWt, 'main');
    git(intWt, 'merge', '--no-ff', 'agenthub/prior', '-m', 'merge prior');

    ctx.service.createProject({
      id: 'rt-proj',
      name: 'Retry Retarget Project',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: false } },
      merge: { enabled: true, worktrees: { main: intWt }, checks: [], timeoutSec: 30 },
    });

    ctx.taskRepo.insert({
      id: 'rt-proj/prior',
      projectId: 'rt-proj',
      slug: 'prior',
      title: 'Prior',
      branch: 'agenthub/prior',
      status: 'pushed',
    });
    ctx.taskRepo.insert({
      id: 'rt-proj/next',
      projectId: 'rt-proj',
      slug: 'next',
      title: 'Next',
      branch: 'agenthub/next',
      baseRef: 'agenthub/prior',
      status: 'review',
    });
    ctx.eventRepo.insert('review.auto_merge_skipped', 'rt-proj/next', { reason: 'merge_failed', reviewId: 'r-1' });

    const retryResult = await ctx.service.retryTaskMerge('rt-proj~next');
    expect(retryResult.ok).toBe(true);

    const updated = await ctx.service.getTask('rt-proj~next');
    expect(updated.status).toBe('done');
    expect(updated.baseRef).toBe('main');
    expect(updated.autoMergeSkippedReason).toBeNull();
    expect(ctx.eventRepo.getByTask('rt-proj/next').some((e) => e.type === 'merge.base_ref_retargeted')).toBe(true);
  });

  it('optimizes findBaseRefSourceTask via TaskRepo.findByBranch and slug fast-path', () => {
    const repo = path.join(tmpDir, 'repo-find-src');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'fsrc-proj',
      name: 'Find Source Project',
      path: repo,
      defaultBranch: 'main',
      merge: { enabled: true, worktrees: { main: repo }, checks: [], timeoutSec: 30 },
    });

    // 1. Task with explicit custom branch
    ctx.taskRepo.insert({
      id: 'fsrc-proj/explicit-src',
      projectId: 'fsrc-proj',
      slug: 'explicit-src',
      title: 'Explicit Branch Source',
      branch: 'agenthub/custom-explicit-branch',
      status: 'pushed',
    });
    expect(ctx.taskRepo.findByBranch('fsrc-proj', 'agenthub/custom-explicit-branch')?.id).toBe('fsrc-proj/explicit-src');
    expect(ctx.taskRepo.findByBranch('fsrc-proj', 'nonexistent')).toBeUndefined();

    const t1 = ctx.service.createTask({
      project: 'fsrc-proj',
      slug: 'follow-explicit',
      title: 'Follow explicit',
      baseRef: 'agenthub/custom-explicit-branch',
    }) as unknown as { baseRef: string | null; baseRefWarning?: string };
    expect(t1.baseRef).toBeNull();
    expect(t1.baseRefWarning).toContain('agenthub/custom-explicit-branch');

    // 2. Standard template task without explicit branch column set
    ctx.taskRepo.insert({
      id: 'fsrc-proj/std-src',
      projectId: 'fsrc-proj',
      slug: 'std-src',
      title: 'Standard Slug Source',
      status: 'pushed',
    });
    const t2 = ctx.service.createTask({
      project: 'fsrc-proj',
      slug: 'follow-std',
      title: 'Follow standard slug',
      baseRef: 'agenthub/std-src',
    }) as unknown as { baseRef: string | null; baseRefWarning?: string };
    expect(t2.baseRef).toBeNull();
    expect(t2.baseRefWarning).toContain('agenthub/std-src');

    // 3. Unknown branch leaves baseRef as requested
    const t3 = ctx.service.createTask({
      project: 'fsrc-proj',
      slug: 'follow-unknown',
      title: 'Follow unknown',
      baseRef: 'agenthub/completely-unknown-branch',
    }) as unknown as { baseRef: string | null; baseRefWarning?: string };
    expect(t3.baseRef).toBe('agenthub/completely-unknown-branch');
    expect(t3.baseRefWarning).toBeUndefined();
  });

  it('supports custom commitConvention branchTemplate in findBaseRefSourceTask and respects project isolation', () => {
    const repoA = path.join(tmpDir, 'repo-conv-a');
    const repoB = path.join(tmpDir, 'repo-conv-b');
    initGitRepo(repoA, 'main');
    initGitRepo(repoB, 'main');

    ctx.service.createProject({
      id: 'proj-custom-conv',
      name: 'Custom Convention Project',
      path: repoA,
      defaultBranch: 'main',
      settings: {
        commitConvention: {
          branchTemplate: 'agenthub/{ref}-{slug}',
          defaultRef: 'DEFAULT',
        },
      },
      merge: { enabled: true, worktrees: { main: repoA }, checks: [], timeoutSec: 30 },
    });

    ctx.service.createProject({
      id: 'proj-other',
      name: 'Other Project',
      path: repoB,
      defaultBranch: 'main',
      merge: { enabled: true, worktrees: { main: repoB }, checks: [], timeoutSec: 30 },
    });

    // Insert task in proj-custom-conv with externalRef
    ctx.taskRepo.insert({
      id: 'proj-custom-conv/feat-xyz',
      projectId: 'proj-custom-conv',
      slug: 'feat-xyz',
      title: 'Feature XYZ',
      externalRef: 'TASK-999',
      status: 'pushed',
    });

    // Creating task in proj-custom-conv targeting rendered branch agenthub/TASK-999-feat-xyz
    const customCreated = ctx.service.createTask({
      project: 'proj-custom-conv',
      slug: 'follow-custom-conv',
      title: 'Follow custom conv',
      baseRef: 'agenthub/TASK-999-feat-xyz',
    }) as unknown as { baseRef: string | null; baseRefWarning?: string };
    expect(customCreated.baseRef).toBeNull();
    expect(customCreated.baseRefWarning).toContain('agenthub/TASK-999-feat-xyz');

    // Isolation check: proj-other should NOT match proj-custom-conv's task branch
    const otherCreated = ctx.service.createTask({
      project: 'proj-other',
      slug: 'other-task',
      title: 'Other task',
      baseRef: 'agenthub/TASK-999-feat-xyz',
    }) as unknown as { baseRef: string | null; baseRefWarning?: string };
    expect(otherCreated.baseRef).toBe('agenthub/TASK-999-feat-xyz');
    expect(otherCreated.baseRefWarning).toBeUndefined();
  });
});
