import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { computeTaskGraph, filterTasksForGraph } from '../src/services/dag.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import type { FastifyInstance } from 'fastify';

describe('Task DAG Graph Computation', () => {
  it('handles empty task list', () => {
    const res = computeTaskGraph([]);
    expect(res.nodes).toEqual([]);
    expect(res.edges).toEqual([]);
    expect(res.criticalPath).toEqual([]);
    expect(res.maxBlockingTaskId).toBeNull();
    expect(res.maxBlockedCount).toBe(0);
  });

  it('computes critical path for linear chain of unfinished tasks', () => {
    const tasks = [
      { id: 't1', projectId: 'p1', slug: 't1', title: 'Task 1', status: 'running', dependsOn: [] },
      { id: 't2', projectId: 'p1', slug: 't2', title: 'Task 2', status: 'queued', dependsOn: ['t1'] },
      { id: 't3', projectId: 'p1', slug: 't3', title: 'Task 3', status: 'draft', dependsOn: ['t2'] },
    ];
    const res = computeTaskGraph(tasks);
    expect(res.criticalPath).toEqual(['t1', 't2', 't3']);
    expect(res.edges).toHaveLength(2);
    expect(res.edges.every((e) => e.isCritical)).toBe(true);
    expect(res.nodes.find((n) => n.id === 't1')?.isCritical).toBe(true);
    expect(res.nodes.find((n) => n.id === 't2')?.isCritical).toBe(true);
    expect(res.nodes.find((n) => n.id === 't3')?.isCritical).toBe(true);
  });

  it('selects the longest chain when branches exist', () => {
    const tasks = [
      { id: 'root', projectId: 'p1', slug: 'root', title: 'Root', status: 'running', dependsOn: [] },
      // Branch 1 (length 3 from root)
      { id: 'b1_1', projectId: 'p1', slug: 'b1_1', title: 'B1 1', status: 'queued', dependsOn: ['root'] },
      { id: 'b1_2', projectId: 'p1', slug: 'b1_2', title: 'B1 2', status: 'queued', dependsOn: ['b1_1'] },
      // Branch 2 (length 2 from root)
      { id: 'b2_1', projectId: 'p1', slug: 'b2_1', title: 'B2 1', status: 'queued', dependsOn: ['root'] },
    ];
    const res = computeTaskGraph(tasks);
    expect(res.criticalPath).toEqual(['root', 'b1_1', 'b1_2']);
  });

  it('excludes already-done tasks from critical path', () => {
    const tasks = [
      { id: 't0', projectId: 'p1', slug: 't0', title: 'Task 0', status: 'done', dependsOn: [] },
      { id: 't1', projectId: 'p1', slug: 't1', title: 'Task 1', status: 'running', dependsOn: ['t0'] },
      { id: 't2', projectId: 'p1', slug: 't2', title: 'Task 2', status: 'queued', dependsOn: ['t1'] },
    ];
    const res = computeTaskGraph(tasks);
    expect(res.criticalPath).toEqual(['t1', 't2']);
    expect(res.nodes.find((n) => n.id === 't0')?.isCritical).toBe(false);
    expect(res.nodes.find((n) => n.id === 't1')?.isCritical).toBe(true);
    expect(res.nodes.find((n) => n.id === 't2')?.isCritical).toBe(true);
  });

  it('calculates blocked counts and identifies max blocker ("đang chặn 4 task")', () => {
    const tasks = [
      { id: 'A', projectId: 'p1', slug: 'A', title: 'Task A', status: 'running', dependsOn: [] },
      { id: 'B', projectId: 'p1', slug: 'B', title: 'Task B', status: 'queued', dependsOn: ['A'] },
      { id: 'C', projectId: 'p1', slug: 'C', title: 'Task C', status: 'queued', dependsOn: ['A'] },
      { id: 'D', projectId: 'p1', slug: 'D', title: 'Task D', status: 'queued', dependsOn: ['B'] },
      { id: 'E', projectId: 'p1', slug: 'E', title: 'Task E', status: 'queued', dependsOn: ['C'] },
    ];
    const res = computeTaskGraph(tasks);
    // A blocks B, C, D, E -> 4
    expect(res.maxBlockingTaskId).toBe('A');
    expect(res.maxBlockedCount).toBe(4);

    const nodeA = res.nodes.find((n) => n.id === 'A')!;
    expect(nodeA.blockedCount).toBe(4);
    expect(nodeA.isMaxBlocker).toBe(true);

    const nodeB = res.nodes.find((n) => n.id === 'B')!;
    expect(nodeB.blockedCount).toBe(1); // blocks D
    expect(nodeB.isMaxBlocker).toBe(false);

    const nodeD = res.nodes.find((n) => n.id === 'D')!;
    expect(nodeD.blockedCount).toBe(0);
    expect(nodeD.isMaxBlocker).toBe(false);
  });

  it('does not count tasks as blocked by a done task', () => {
    const tasks = [
      { id: 'A', projectId: 'p1', slug: 'A', title: 'Task A', status: 'done', dependsOn: [] },
      { id: 'B', projectId: 'p1', slug: 'B', title: 'Task B', status: 'running', dependsOn: ['A'] },
      { id: 'C', projectId: 'p1', slug: 'C', title: 'Task C', status: 'queued', dependsOn: ['B'] },
    ];
    const res = computeTaskGraph(tasks);
    const nodeA = res.nodes.find((n) => n.id === 'A')!;
    expect(nodeA.blockedCount).toBe(0);

    const nodeB = res.nodes.find((n) => n.id === 'B')!;
    expect(nodeB.blockedCount).toBe(1); // blocks C
    expect(res.maxBlockingTaskId).toBe('B');
    expect(res.maxBlockedCount).toBe(1);
  });

  it('handles cycle gracefully without infinite loop', () => {
    const tasks = [
      { id: 'c1', projectId: 'p1', slug: 'c1', title: 'Cycle 1', status: 'running', dependsOn: ['c2'] },
      { id: 'c2', projectId: 'p1', slug: 'c2', title: 'Cycle 2', status: 'queued', dependsOn: ['c1'] },
    ];
    const res = computeTaskGraph(tasks);
    expect(res.criticalPath.length).toBeGreaterThanOrEqual(1);
  });

  it('filterTasksForGraph defaults to active chains (hiding standalone done tasks)', () => {
    const tasks = [
      { id: 'done_isolated', projectId: 'p1', slug: 'done_isolated', title: 'Isolated Done', status: 'done', dependsOn: [] },
      { id: 'done_prereq', projectId: 'p1', slug: 'done_prereq', title: 'Prereq Done', status: 'done', dependsOn: [] },
      { id: 'running_child', projectId: 'p1', slug: 'running_child', title: 'Running Child', status: 'running', dependsOn: ['done_prereq'] },
    ];
    // Default: active_chains
    const filtered = filterTasksForGraph(tasks);
    expect(filtered.map((t) => t.id)).toEqual(['done_prereq', 'running_child']);
  });

  it('filterTasksForGraph includes all when includeDone=all/true', () => {
    const tasks = [
      { id: 'done_isolated', projectId: 'p1', slug: 'done_isolated', title: 'Isolated Done', status: 'done', dependsOn: [] },
      { id: 'running_task', projectId: 'p1', slug: 'running_task', title: 'Running', status: 'running', dependsOn: [] },
    ];
    const filtered = filterTasksForGraph(tasks, { includeDone: 'all' });
    expect(filtered).toHaveLength(2);
  });
});

describe('GET /api/tasks/graph API endpoint', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let server: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dag-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    const config = loadConfig(tmpDir);
    config.port = 7789;
    config.agyHomesDir = agyHomesDir;
    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    server = await createServer(ctx.service, config);
    await server.ready();

    // Seed test project
    const p1Path = path.join(tmpDir, 'p1');
    fs.mkdirSync(p1Path, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: p1Path });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: p1Path });
    fs.writeFileSync(path.join(p1Path, 'README.md'), '# p1\n');
    execFileSync('git', ['add', '.'], { cwd: p1Path });
    execFileSync('git', ['commit', '-m', 'chore: init', '--allow-empty'], {
      cwd: p1Path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_COMMITTER_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    ctx.service.createProject({
      name: 'Project 1',
      path: p1Path,
      defaultBranch: 'main',
    });

    // Create tasks
    const tA = ctx.service.createTask({
      project: 'project-1',
      slug: 'task-a',
      title: 'Task A',
      level: 'easy',
      dependsOn: [],
    });
    const tB = ctx.service.createTask({
      project: 'project-1',
      slug: 'task-b',
      title: 'Task B',
      level: 'easy',
      dependsOn: [tA.id],
    });
    ctx.service.createTask({
      project: 'project-1',
      slug: 'task-c',
      title: 'Task C',
      level: 'easy',
      dependsOn: [tB.id],
    });
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
  });

  it('returns graph data with nodes, edges, criticalPath, and blocking counts', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/graph?project=project-1',
      headers: {
        host: '127.0.0.1:7789',
        authorization: `Bearer ${token}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toHaveLength(2);
    expect(body.criticalPath).toHaveLength(3);
    expect(body.maxBlockedCount).toBe(2); // task-a blocks task-b and task-c
  });

  it('treats project=all as no project filter (the dashboard default)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/graph?project=all&includeDone=false',
      headers: {
        host: '127.0.0.1:7789',
        authorization: `Bearer ${token}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toHaveLength(2);
  });
});
