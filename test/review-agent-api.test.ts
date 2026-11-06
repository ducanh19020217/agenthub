import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';

let tmpDir: string;
let ctx: ReturnType<typeof createContext>;
let server: Awaited<ReturnType<typeof createServer>>;
let token: string;

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

describe('API & Scheduler agent metadata for reviews and runs (t-model-agent-badge)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-agent-badge-test-'));
    process.env.AGENTHUB_HOME = tmpDir;

    const config = loadConfig();
    config.hubHome = tmpDir;
    config.tokenPath = path.join(tmpDir, 'token');
    config.port = 7789;

    token = getOrCreateToken(config.tokenPath);
    ctx = createContext(config);
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records engine and profileName via POST /api/tasks/:id/review and returns them in GET /api/tasks/:id', async () => {
    const projectRepoPath = path.join(tmpDir, 'test-repo');
    initGitRepo(projectRepoPath);

    // Create project
    const projRes = await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: { id: 'badge-proj', name: 'Badge Project', path: projectRepoPath },
    });
    expect(projRes.statusCode).toBe(201);

    // Create task
    const taskRes = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: authHeaders(),
      payload: { project: 'badge-proj', slug: 't1', title: 'Task with agent badge' },
    });
    expect(taskRes.statusCode).toBe(201);

    // Move task to review status
    ctx.taskRepo.updateStatus('badge-proj/t1', 'review');

    // Submit review with engine and profileName
    const reviewRes = await server.inject({
      method: 'POST',
      url: '/api/tasks/badge-proj~t1/review',
      headers: authHeaders(),
      payload: {
        verdict: 'approved',
        feedback: 'LGTM',
        by: 'claude-custom',
        engine: 'claude',
        profileName: 'claude-main',
      },
    });
    expect(reviewRes.statusCode).toBe(200);

    // Fetch task and check reviews[]
    const getRes = await server.inject({
      method: 'GET',
      url: '/api/tasks/badge-proj~t1',
      headers: authHeaders(),
    });
    expect(getRes.statusCode).toBe(200);
    const task = JSON.parse(getRes.body);

    expect(task.reviews).toBeDefined();
    expect(task.reviews).toHaveLength(1);
    expect(task.reviews[0].actor).toBe('claude-custom');
    expect(task.reviews[0].engine).toBe('claude');
    expect(task.reviews[0].profileName).toBe('claude-main');
    expect(task.reviews[0].verdict).toBe('approved');
  });

  it('enriches reviewChain steps with engine and profileName from completed reviews', async () => {
    const projectRepoPath = path.join(tmpDir, 'chain-repo');
    initGitRepo(projectRepoPath);

    await server.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authHeaders(),
      payload: {
        id: 'chain-proj',
        name: 'Chain Proj',
        path: projectRepoPath,
        reviewChain: [
          { reviewer: 'codex:gpt-5.6-luna', mode: 'gate' },
          { reviewer: 'claude', mode: 'final' },
        ],
      },
    });

    const taskRes = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: authHeaders(),
      payload: { project: 'chain-proj', slug: 't-chain', title: 'Chain Task' },
    });
    expect(taskRes.statusCode).toBe(201);

    // Directly insert a review corresponding to step 0
    ctx.reviewRepo.insert({
      id: 'rev-0',
      taskId: 'chain-proj/t-chain',
      verdict: 'approved',
      feedback: 'Gate passed',
      actor: 'codex-reviewer',
      engine: 'codex',
      profileName: 'codex-fast',
    });
    ctx.taskRepo.update('chain-proj/t-chain', { reviewStep: 1, status: 'review' });

    const getRes = await server.inject({
      method: 'GET',
      url: '/api/tasks/chain-proj~t-chain',
      headers: authHeaders(),
    });
    expect(getRes.statusCode).toBe(200);
    const task = JSON.parse(getRes.body);

    expect(task.reviewChain).toHaveLength(2);
    // Step 0 was completed: has engine and profileName
    expect(task.reviewChain[0].reviewer).toBe('codex:gpt-5.6-luna');
    expect(task.reviewChain[0].engine).toBe('codex');
    expect(task.reviewChain[0].profileName).toBe('codex-fast');

    // Step 1 not yet reviewed: has inferred engine 'claude' and null profileName
    expect(task.reviewChain[1].reviewer).toBe('claude');
    expect(task.reviewChain[1].engine).toBe('claude');
    expect(task.reviewChain[1].profileName).toBeNull();
  });
});
