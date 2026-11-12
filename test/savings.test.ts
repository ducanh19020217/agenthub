import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import {
  parseCodexTokens,
  parseShortstat,
  calculateAgyTokens,
  calculateSavingsRatio,
  recalculateTaskLines,
} from '../src/savings.js';

describe('Savings calculation functions', () => {
  describe('parseCodexTokens', () => {
    it('parses tokens with dot separator: 117.250', () => {
      const log = 'Starting task...\nProcessing...\ntokens used\n117.250\nDone.';
      expect(parseCodexTokens(log)).toBe(117250);
    });

    it('parses tokens with comma separator: 117,250', () => {
      const log = 'Some initial output...\ntokens used\n117,250\nCompleted.';
      expect(parseCodexTokens(log)).toBe(117250);
    });

    it('parses tokens without separator: 117250', () => {
      const log = 'Run finished.\ntokens used\n117250';
      expect(parseCodexTokens(log)).toBe(117250);
    });

    it('parses tokens with colon: tokens used:\n50,000', () => {
      const log = 'tokens used:\n50,000';
      expect(parseCodexTokens(log)).toBe(50000);
    });

    it('returns the last token count if multiple appear in log', () => {
      const log = 'tokens used\n10,000\nre-evaluating...\ntokens used\n150.000\nall finished';
      expect(parseCodexTokens(log)).toBe(150000);
    });

    it('returns null if tokens used header is not found or empty', () => {
      expect(parseCodexTokens('')).toBeNull();
      expect(parseCodexTokens('Just regular output without token counts')).toBeNull();
      expect(parseCodexTokens('tokens used\nnot_a_number')).toBeNull();
    });
  });

  describe('parseShortstat', () => {
    it('parses insertions and deletions', () => {
      const stat = ' 3 files changed, 120 insertions(+), 45 deletions(-)';
      expect(parseShortstat(stat)).toEqual({
        filesChanged: 3,
        linesAdded: 120,
        linesDeleted: 45,
      });
    });

    it('parses insertions only', () => {
      const stat = ' 1 file changed, 50 insertions(+)';
      expect(parseShortstat(stat)).toEqual({
        filesChanged: 1,
        linesAdded: 50,
        linesDeleted: 0,
      });
    });

    it('parses deletions only', () => {
      const stat = ' 2 files changed, 30 deletions(-)';
      expect(parseShortstat(stat)).toEqual({
        filesChanged: 2,
        linesAdded: 0,
        linesDeleted: 30,
      });
    });

    it('returns 0 for empty or unparseable input', () => {
      expect(parseShortstat('')).toEqual({
        filesChanged: 0,
        linesAdded: 0,
        linesDeleted: 0,
      });
    });
  });

  describe('calculateAgyTokens', () => {
    it('calculates tokens correctly for single run with quota reduction', () => {
      const res = calculateAgyTokens({
        usageBefore: 100,
        usageAfter: 90, // 10% used
        bucketTokens: 5_000_000,
        concurrentRuns: 1,
      });
      expect(res.tokens).toBe(500_000);
      expect(res.estimated).toBe(false);
    });

    it('marks estimated: true when concurrent runs > 1 and divides tokens evenly', () => {
      const res = calculateAgyTokens({
        usageBefore: 100,
        usageAfter: 80, // 20% used = 1_000_000
        bucketTokens: 5_000_000,
        concurrentRuns: 2,
      });
      expect(res.tokens).toBe(500_000);
      expect(res.estimated).toBe(true);
    });

    it('marks estimated: true and returns 0 tokens when diff <= 0 (e.g. quota reset)', () => {
      const res = calculateAgyTokens({
        usageBefore: 80,
        usageAfter: 85, // Quota increased / reset
        bucketTokens: 5_000_000,
        concurrentRuns: 1,
      });
      expect(res.tokens).toBe(0);
      expect(res.estimated).toBe(true);
    });

    it('marks estimated: true when usageBefore or usageAfter is missing', () => {
      const res1 = calculateAgyTokens({
        usageBefore: null,
        usageAfter: 90,
        bucketTokens: 5_000_000,
      });
      expect(res1.estimated).toBe(true);
      expect(res1.tokens).toBe(0);

      const res2 = calculateAgyTokens({
        usageBefore: 100,
        usageAfter: null,
        bucketTokens: 5_000_000,
      });
      expect(res2.estimated).toBe(true);
      expect(res2.tokens).toBe(0);
    });
  });

  describe('calculateSavingsRatio', () => {
    it('calculates ratio: saved / (saved + cost)', () => {
      expect(calculateSavingsRatio(90_000, 10_000)).toBeCloseTo(0.9);
      expect(calculateSavingsRatio(50_000, 50_000)).toBeCloseTo(0.5);
    });

    it('returns 0 when saved is 0', () => {
      expect(calculateSavingsRatio(0, 40_000)).toBe(0);
    });

    it('returns 0 when both saved and cost are 0', () => {
      expect(calculateSavingsRatio(0, 0)).toBe(0);
    });
  });
});

describe('SavingsService and GET /api/savings integration', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: ReturnType<typeof createServer>;
  let token: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-savings-test-'));
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
    config.port = 7788;
    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
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

  function authHeaders() {
    return {
      host: '127.0.0.1:7788',
      authorization: `Bearer ${token}`,
    };
  }

  it('returns empty savings report when no tasks exist', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/savings',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.summary).toEqual({
      totalWorkerTokens: 0,
      claudeSavedTokens: 0,
      claudeCostTokens: 0,
      savingsRatio: 0,
      totalLinesAdded: 0,
      totalLinesDeleted: 0,
      totalLinesChanged: 0,
      tasksApprovedCount: 0,
      avgReviewRounds: 0,
    });
    expect(body.tasks).toEqual([]);
    expect(body.byDay).toEqual([]);
  });

  it('calculates savings across done tasks and codex / agy runs', async () => {
    // 1. Seed project
    ctx.db.prepare(
      `INSERT INTO projects (id, name, path, defaultBranch) VALUES ('proj-a', 'Project A', '/tmp/repo', 'main')`,
    ).run();

    // 2. Seed task 1 (done, agy engine with 10% quota usage)
    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, status)
       VALUES ('proj-a/t-1', 'proj-a', 't-1', 'Agy Task', 'done')`,
    ).run();

    // Run for task 1
    const run1Id = 'run-1';
    ctx.db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES (?, 'proj-a/t-1', 'agy', 'gemini-3.8-flash-high', 'p1', '2026-10-15T10:00:00.000Z', '2026-10-15T10:30:00.000Z', 'done')`,
    ).run(run1Id);

    // Run metric for run 1: 100% down to 90% in 5h window => 10% * 5_000_000 = 500,000 tokens
    ctx.db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed, usageBefore, usageAfter, linesAdded, linesDeleted, filesChanged, durationMs)
       VALUES (?, 'proj-a/t-1', 'agy', 'gemini-3.8-flash-high', 'p1', NULL, 100, 90, 150, 20, 4, 1800000)`,
    ).run(run1Id);

    // 3. Seed task 2 (done, codex engine with 120,000 tokens parsed, 1 review round)
    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, status)
       VALUES ('proj-a/t-2', 'proj-a', 't-2', 'Codex Task', 'done')`,
    ).run();

    const run2Id = 'run-2';
    ctx.db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES (?, 'proj-a/t-2', 'codex', 'codex:gpt-5.6-luna', 'p1', '2026-10-15T11:00:00.000Z', '2026-10-15T11:45:00.000Z', 'done')`,
    ).run(run2Id);

    ctx.db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed, usageBefore, usageAfter, linesAdded, linesDeleted, filesChanged, durationMs)
       VALUES (?, 'proj-a/t-2', 'codex', 'codex:gpt-5.6-luna', 'p1', 120000, NULL, NULL, 80, 10, 2, 2700000)`,
    ).run(run2Id);

    // Add 1 changes_requested review for task 2
    ctx.db.prepare(
      `INSERT INTO reviews (taskId, verdict, createdAt)
       VALUES ('proj-a/t-2', 'changes_requested', '2026-10-15T11:20:00.000Z')`,
    ).run();

    // Call GET /api/savings
    const res = await server.inject({
      method: 'GET',
      url: '/api/savings',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Total worker tokens = 500,000 (agy) + 120,000 (codex) = 620,000
    expect(body.summary.totalWorkerTokens).toBe(620_000);
    // Claude saved = 620,000 * 0.9 = 558,000
    expect(body.summary.claudeSavedTokens).toBe(558_000);

    // Claude cost:
    // Task 1: 0 reviews => 40,000 * (1 + 0) = 40,000
    // Task 2: 1 review => 40,000 * (1 + 1) = 80,000
    // Total cost = 120,000
    expect(body.summary.claudeCostTokens).toBe(120_000);

    // Savings ratio = 558,000 / (558,000 + 120,000) = 0.823...
    expect(body.summary.savingsRatio).toBeCloseTo(558000 / 678000, 3);

    // Lines code
    expect(body.summary.totalLinesAdded).toBe(230);
    expect(body.summary.totalLinesDeleted).toBe(30);
    expect(body.summary.tasksApprovedCount).toBe(2);
    expect(body.summary.avgReviewRounds).toBe(0.5); // (0 + 1) / 2 = 0.5

    // byEngine
    expect(body.byEngine['agy'].tokens).toBe(500_000);
    expect(body.byEngine['codex'].tokens).toBe(120_000);

    // byDay has 2026-10-15
    expect(body.byDay.length).toBe(1);
    expect(body.byDay[0].date).toBe('2026-10-15');
    expect(body.byDay[0].geminiTokens).toBe(500_000);
    expect(body.byDay[0].codexTokens).toBe(120_000);

    // Tasks list
    expect(body.tasks.length).toBe(2);
    expect(body.tasksTotal).toBe(2);

    const pageRes = await server.inject({
      method: 'GET',
      url: '/api/savings?project=proj-a&limit=1&offset=1',
      headers: authHeaders(),
    });
    expect(pageRes.statusCode).toBe(200);
    const pageBody = JSON.parse(pageRes.body);
    expect(pageBody.tasks).toHaveLength(1);
    expect(pageBody.tasksTotal).toBe(2);
    expect(pageBody.tasksNextCursor).toBeNull();
  });

  it('filters savings report by project and since date', async () => {
    // Seed project A and B
    ctx.db.prepare(`INSERT INTO projects (id, name, path) VALUES ('p-a', 'Proj A', '/tmp/a')`).run();
    ctx.db.prepare(`INSERT INTO projects (id, name, path) VALUES ('p-b', 'Proj B', '/tmp/b')`).run();

    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, status, createdAt, updatedAt)
       VALUES ('p-a/t-1', 'p-a', 't-1', 'Task A', 'done', '2026-10-10T10:00:00.000Z', '2026-10-10T10:30:00.000Z')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES ('run-a', 'p-a/t-1', 'codex', 'm1', 'p1', '2026-10-10T10:00:00.000Z', '2026-10-10T10:30:00.000Z', 'done')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed)
       VALUES ('run-a', 'p-a/t-1', 'codex', 'm1', 'p1', 50000)`,
    ).run();

    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, status, createdAt, updatedAt)
       VALUES ('p-b/t-2', 'p-b', 't-2', 'Task B', 'done', '2026-10-15T10:00:00.000Z', '2026-10-15T10:30:00.000Z')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES ('run-b', 'p-b/t-2', 'codex', 'm1', 'p1', '2026-10-15T10:00:00.000Z', '2026-10-15T10:30:00.000Z', 'done')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed)
       VALUES ('run-b', 'p-b/t-2', 'codex', 'm1', 'p1', 75000)`,
    ).run();

    // Filter project=p-a
    const resA = await server.inject({
      method: 'GET',
      url: '/api/savings?project=p-a',
      headers: authHeaders(),
    });
    const bodyA = JSON.parse(resA.body);
    expect(bodyA.summary.totalWorkerTokens).toBe(50000);
    expect(bodyA.tasks.length).toBe(1);
    expect(bodyA.tasks[0].taskId).toBe('p-a/t-1');

    // Filter since=2026-10-12
    const resSince = await server.inject({
      method: 'GET',
      url: '/api/savings?since=2026-10-12',
      headers: authHeaders(),
    });
    const bodySince = JSON.parse(resSince.body);
    expect(bodySince.summary.totalWorkerTokens).toBe(75000);
    expect(bodySince.tasks.length).toBe(1);
    expect(bodySince.tasks[0].taskId).toBe('p-b/t-2');
  });

  it('imports legacy codex logs and attaches tokens to matching task', async () => {
    const { cmdSavings } = await import('../src/cli-main.js');

    // Seed task with slug t-legacy
    ctx.db.prepare(`INSERT INTO projects (id, name, path) VALUES ('proj-leg', 'Legacy Proj', '/tmp/leg')`).run();
    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, status)
       VALUES ('proj-leg/t-legacy', 'proj-leg', 't-legacy', 'Legacy Task', 'done')`,
    ).run();

    // Create a mock legacy log directory structure:
    // legacy-logs/t-legacy/2026-10-14_run_codex.log
    const legacyDir = path.join(tmpDir, 'legacy-logs');
    const taskLogDir = path.join(legacyDir, 't-legacy');
    fs.mkdirSync(taskLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskLogDir, '2026-10-14_run_codex.log'),
      'Starting worker execution...\nGenerating code...\ntokens used\n117.250\nComplete.',
    );

    await cmdSavings(config, 'import-legacy', [legacyDir]);

    // Verify task metric is recorded
    const metrics = ctx.runMetricsRepo.getByTask('proj-leg/t-legacy');
    expect(metrics.length).toBe(1);
    expect(metrics[0].tokensUsed).toBe(117250);
    expect(metrics[0].engine).toBe('codex');
  });

  it('recalculates line diff with a temporary git repo with 2 commits (+N/-M), and keeps old lines if branch deleted', async () => {
    // 1. Create a temporary git repo
    const testRepoDir = path.join(tmpDir, 'test-repo');
    fs.mkdirSync(testRepoDir, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: testRepoDir });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: testRepoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testRepoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepoDir });

    // Initial commit on main
    fs.writeFileSync(path.join(testRepoDir, 'app.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
    execFileSync('git', ['add', '.'], { cwd: testRepoDir });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: testRepoDir });

    // Create branch agenthub/task-diff
    execFileSync('git', ['checkout', '-b', 'agenthub/task-diff'], { cwd: testRepoDir });

    // Commit 1 on branch: add 3 lines to app.txt, add helper.txt with 4 lines
    fs.appendFileSync(path.join(testRepoDir, 'app.txt'), 'line 6\nline 7\nline 8\n');
    fs.writeFileSync(path.join(testRepoDir, 'helper.txt'), 'h1\nh2\nh3\nh4\n');
    execFileSync('git', ['add', '.'], { cwd: testRepoDir });
    execFileSync('git', ['commit', '-m', 'feature step 1'], { cwd: testRepoDir });

    // Commit 2 on branch: delete 2 lines from app.txt
    const content = fs.readFileSync(path.join(testRepoDir, 'app.txt'), 'utf-8').replace('line 1\nline 2\n', '');
    fs.writeFileSync(path.join(testRepoDir, 'app.txt'), content);
    execFileSync('git', ['add', '.'], { cwd: testRepoDir });
    execFileSync('git', ['commit', '-m', 'feature step 2'], { cwd: testRepoDir });

    // Switch back to main so branch is not checked out
    execFileSync('git', ['checkout', 'main'], { cwd: testRepoDir });

    // Seed project and task in AgentHub DB
    ctx.db.prepare(`INSERT INTO projects (id, name, path, defaultBranch) VALUES ('proj-git', 'Git Proj', ?, 'main')`).run(testRepoDir);
    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, branch, status)
       VALUES ('proj-git/task-diff', 'proj-git', 'task-diff', 'Task Diff', 'agenthub/task-diff', 'review')`,
    ).run();

    const runId = 'run-diff-1';
    ctx.db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName, startedAt, endedAt, outcome)
       VALUES (?, 'proj-git/task-diff', 'agy', 'gemini-3.8-flash-high', 'p1', '2026-10-15T10:00:00.000Z', '2026-10-15T10:30:00.000Z', 'done')`,
    ).run(runId);

    // Initial metrics had 0 lines
    ctx.db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed, usageBefore, usageAfter, linesAdded, linesDeleted, filesChanged)
       VALUES (?, 'proj-git/task-diff', 'agy', 'gemini-3.8-flash-high', 'p1', NULL, NULL, NULL, 0, 0, 0)`,
    ).run(runId);

    // Call recalculateTaskLines
    const stats = await recalculateTaskLines(
      ctx.taskRepo,
      ctx.projectRepo,
      ctx.runRepo,
      ctx.runMetricsRepo,
      'proj-git/task-diff',
    );

    expect(stats).toEqual({
      linesAdded: 7,
      linesDeleted: 2,
      filesChanged: 2,
    });

    const metricsAfter = ctx.runMetricsRepo.getByTask('proj-git/task-diff');
    expect(metricsAfter[0].linesAdded).toBe(7);
    expect(metricsAfter[0].linesDeleted).toBe(2);
    expect(metricsAfter[0].filesChanged).toBe(2);

    // Delete branch and verify it DOES NOT overwrite with 0
    execFileSync('git', ['branch', '-D', 'agenthub/task-diff'], { cwd: testRepoDir });

    const statsDeleted = await recalculateTaskLines(
      ctx.taskRepo,
      ctx.projectRepo,
      ctx.runRepo,
      ctx.runMetricsRepo,
      'proj-git/task-diff',
    );
    expect(statsDeleted).toBeNull();

    const metricsPreserved = ctx.runMetricsRepo.getByTask('proj-git/task-diff');
    expect(metricsPreserved[0].linesAdded).toBe(7);
    expect(metricsPreserved[0].linesDeleted).toBe(2);
    expect(metricsPreserved[0].filesChanged).toBe(2);
  });

  it('agenthub savings backfill-lines calculates lines for existing branches and skips deleted ones', async () => {
    const { cmdSavings } = await import('../src/cli-main.js');

    const testRepoDir = path.join(tmpDir, 'test-backfill-repo');
    fs.mkdirSync(testRepoDir, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: testRepoDir });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: testRepoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: testRepoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testRepoDir });

    fs.writeFileSync(path.join(testRepoDir, 'main.txt'), 'init\n');
    execFileSync('git', ['add', '.'], { cwd: testRepoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: testRepoDir });

    // Branch 1: exists
    execFileSync('git', ['checkout', '-b', 'agenthub/t-exist'], { cwd: testRepoDir });
    fs.writeFileSync(path.join(testRepoDir, 'feature.txt'), 'feat1\nfeat2\n');
    execFileSync('git', ['add', '.'], { cwd: testRepoDir });
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: testRepoDir });
    execFileSync('git', ['checkout', 'main'], { cwd: testRepoDir });

    ctx.db.prepare(`INSERT INTO projects (id, name, path, defaultBranch) VALUES ('proj-bf', 'Backfill Proj', ?, 'main')`).run(testRepoDir);

    // Task 1: branch exists, lines currently 0
    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, branch, status)
       VALUES ('proj-bf/t-exist', 'proj-bf', 't-exist', 'Task Existing', 'agenthub/t-exist', 'done')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName)
       VALUES ('run-bf-1', 'proj-bf/t-exist', 'agy', 'gemini-3.8-flash-high', 'p1')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, linesAdded, linesDeleted, filesChanged)
       VALUES ('run-bf-1', 'proj-bf/t-exist', 'agy', 'gemini-3.8-flash-high', 'p1', 0, 0, 0)`,
    ).run();

    // Task 2: branch does not exist, lines currently 50
    ctx.db.prepare(
      `INSERT INTO tasks (id, projectId, slug, title, branch, status)
       VALUES ('proj-bf/t-gone', 'proj-bf', 't-gone', 'Task Gone', 'agenthub/t-gone', 'done')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO runs (id, taskId, engine, model, profileName)
       VALUES ('run-bf-2', 'proj-bf/t-gone', 'codex', 'codex:gpt-5.6-luna', 'p1')`,
    ).run();
    ctx.db.prepare(
      `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, linesAdded, linesDeleted, filesChanged)
       VALUES ('run-bf-2', 'proj-bf/t-gone', 'codex', 'codex:gpt-5.6-luna', 'p1', 50, 10, 1)`,
    ).run();

    // Run backfill-lines
    await cmdSavings(config, 'backfill-lines', ['--project', 'proj-bf']);

    // Task 1 updated
    const m1 = ctx.runMetricsRepo.getByTask('proj-bf/t-exist');
    expect(m1[0].linesAdded).toBe(2);
    expect(m1[0].linesDeleted).toBe(0);
    expect(m1[0].filesChanged).toBe(1);

    // Task 2 kept old numbers (not overwritten to 0)
    const m2 = ctx.runMetricsRepo.getByTask('proj-bf/t-gone');
    expect(m2[0].linesAdded).toBe(50);
    expect(m2[0].linesDeleted).toBe(10);
  });

  it('agenthub savings backfill-lines CLI process terminates on its own within 20s timeout', async () => {
    const cliTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-backfill-'));
    const cliPath = path.resolve(__dirname, '../src/cli.ts');

    try {
      const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number | null }>(
        (resolve, reject) => {
          let output = '';
          const proc = spawn(
            process.execPath,
            ['--import', 'tsx', cliPath, 'savings', 'backfill-lines'],
            {
              env: {
                ...process.env,
                AGENTHUB_HOME: cliTempDir,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );

          proc.stdout?.on('data', (d) => {
            output += d.toString();
          });
          proc.stderr?.on('data', (d) => {
            output += d.toString();
          });

          const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Process did not terminate within 20s timeout'));
          }, 20_000);

          proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });

          proc.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ stdout: output, exitCode: code });
          });
        },
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Bắt đầu tính lại số dòng');
      expect(stdout).toMatch(/Hoàn thành:\s+\d+\s+task được cập nhật,\s+\d+\s+task bỏ qua\./);
    } finally {
      fs.rmSync(cliTempDir, { recursive: true, force: true });
    }
  }, 25_000);
});

