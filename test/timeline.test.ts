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
    host: '127.0.0.1:7790',
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

describe('Task Timeline API (GET /api/tasks/:id/timeline)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-timeline-test-'));
    process.env.AGENTHUB_HOME = tmpDir;

    const config = loadConfig();
    config.hubHome = tmpDir;
    config.tokenPath = path.join(tmpDir, 'token');
    config.port = 7790;
    config.dbPath = path.join(tmpDir, 'hub.db');

    token = getOrCreateToken(config.tokenPath);
    ctx = createContext(config);
    server = await createServer(ctx.service, config);
  });

  afterEach(async () => {
    await server.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for nonexistent task', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/p~nonexistent/timeline',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns chronological status transitions and durations for standard task flow', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    initGitRepo(repoPath);

    ctx.projectRepo.insert({
      id: 'proj',
      name: 'Project',
      path: repoPath,
      defaultBranch: 'main',
      maxParallel: 3,
    });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Timeline task',
      status: 'pushed',
      pushedAt: '2026-11-12T10:20:00.000Z',
    });

    // Populate events in chronological order
    ctx.eventRepo.insert('task.queued', 'proj/t1', { reason: 'start' });
    ctx.eventRepo.insert('task.running', 'proj/t1', { runId: 'run-1', profile: 'g1' });
    ctx.eventRepo.insert('task.checking', 'proj/t1');
    ctx.eventRepo.insert('task.review_ready', 'proj/t1');
    ctx.eventRepo.insert('task.done', 'proj/t1', { by: 'claude' });
    ctx.eventRepo.insert('task.pushed', 'proj/t1');

    // Update timestamps of events to specific values
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:00:00' WHERE taskId = 'proj/t1' AND type = 'task.queued'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:02:00' WHERE taskId = 'proj/t1' AND type = 'task.running'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:14:00' WHERE taskId = 'proj/t1' AND type = 'task.checking'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:15:00' WHERE taskId = 'proj/t1' AND type = 'task.review_ready'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:18:00' WHERE taskId = 'proj/t1' AND type = 'task.done'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:20:00' WHERE taskId = 'proj/t1' AND type = 'task.pushed'").run();

    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/proj~t1/timeline',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const timeline = res.json();
    expect(timeline).toHaveLength(6);

    expect(timeline[0]).toEqual({
      status: 'queued',
      at: '2026-11-12T10:00:00.000Z',
      durationMs: 2 * 60 * 1000, // 2 mins
    });
    expect(timeline[1]).toEqual({
      status: 'running',
      at: '2026-11-12T10:02:00.000Z',
      durationMs: 12 * 60 * 1000, // 12 mins
      runId: 'run-1',
      actor: 'g1',
    });
    expect(timeline[2]).toEqual({
      status: 'checking',
      at: '2026-11-12T10:14:00.000Z',
      durationMs: 1 * 60 * 1000, // 1 min
    });
    expect(timeline[3]).toEqual({
      status: 'review',
      at: '2026-11-12T10:15:00.000Z',
      durationMs: 3 * 60 * 1000, // 3 mins
    });
    expect(timeline[4]).toEqual({
      status: 'done',
      at: '2026-11-12T10:18:00.000Z',
      durationMs: 2 * 60 * 1000, // 2 mins
      actor: 'claude',
    });
    expect(timeline[5]).toEqual({
      status: 'pushed',
      at: '2026-11-12T10:20:00.000Z',
    });
  });

  it('preserves multiple rework rounds without collapsing them', async () => {
    const repoPath = path.join(tmpDir, 'repo2');
    initGitRepo(repoPath);

    ctx.projectRepo.insert({
      id: 'proj2',
      name: 'Project 2',
      path: repoPath,
      defaultBranch: 'main',
      maxParallel: 3,
    });

    ctx.taskRepo.insert({
      id: 'proj2/t2',
      projectId: 'proj2',
      slug: 't2',
      title: 'Rework task',
      status: 'done',
    });

    // Round 1
    ctx.eventRepo.insert('task.queued', 'proj2/t2');
    ctx.eventRepo.insert('task.running', 'proj2/t2', { runId: 'run-1', profile: 'g1' });
    ctx.eventRepo.insert('task.review_ready', 'proj2/t2');
    ctx.reviewRepo.insert({
      id: 'rev-1',
      taskId: 'proj2/t2',
      verdict: 'changes_requested',
      actor: 'reviewer-claude',
      feedback: 'Please fix edge cases',
    });

    // Round 2
    ctx.eventRepo.insert('task.queued', 'proj2/t2', { reason: 'changes_requested' });
    ctx.eventRepo.insert('task.running', 'proj2/t2', { runId: 'run-2', profile: 'g2' });
    ctx.eventRepo.insert('task.review_ready', 'proj2/t2');
    ctx.eventRepo.insert('task.done', 'proj2/t2', { by: 'reviewer-claude' });

    // Set timestamps to simulate round progression
    const eventIds = (ctx.db.prepare("SELECT id, type FROM events WHERE taskId = 'proj2/t2' ORDER BY id ASC").all() as Array<{ id: number; type: string }>);
    const times = [
      '2026-11-12 10:00:00', // queued (round 1)
      '2026-11-12 10:02:00', // running (round 1)
      '2026-11-12 10:10:00', // review (round 1)
      '2026-11-12 10:15:00', // queued (round 2)
      '2026-11-12 10:16:00', // running (round 2)
      '2026-11-12 10:24:00', // review (round 2)
      '2026-11-12 10:27:00', // done (round 2)
    ];
    eventIds.forEach((e, idx) => {
      ctx.db.prepare('UPDATE events SET ts = ? WHERE id = ?').run(times[idx], e.id);
    });
    ctx.db.prepare("UPDATE reviews SET createdAt = '2026-11-12 10:14:00' WHERE id = 'rev-1'").run();

    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/proj2~t2/timeline',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const timeline = res.json();

    const statuses = timeline.map((item: any) => item.status);
    expect(statuses).toEqual([
      'queued',
      'running',
      'review',
      'changes_requested',
      'queued',
      'running',
      'review',
      'done',
    ]);

    expect(timeline[1].runId).toBe('run-1');
    expect(timeline[1].actor).toBe('g1');

    expect(timeline[3].status).toBe('changes_requested');
    expect(timeline[3].actor).toBe('reviewer-claude');

    expect(timeline[5].runId).toBe('run-2');
    expect(timeline[5].actor).toBe('g2');

    expect(timeline[7].status).toBe('done');
    expect(timeline[7].actor).toBe('reviewer-claude');
  });

  it('falls back to updatedAt and marks as estimated for legacy tasks missing events', async () => {
    const repoPath = path.join(tmpDir, 'repo3');
    initGitRepo(repoPath);

    ctx.projectRepo.insert({
      id: 'proj3',
      name: 'Project 3',
      path: repoPath,
      defaultBranch: 'main',
      maxParallel: 3,
    });

    ctx.taskRepo.insert({
      id: 'proj3/t3',
      projectId: 'proj3',
      slug: 't3',
      title: 'Old task without events',
      status: 'blocked',
      statusChangedAtEstimated: 1,
    });
    ctx.db.prepare("UPDATE tasks SET updatedAt = '2026-10-10 12:00:00', statusChangedAt = '2026-10-10T12:00:00.000Z' WHERE id = 'proj3/t3'").run();

    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/proj3~t3/timeline',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const timeline = res.json();
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toEqual({
      status: 'blocked',
      at: '2026-10-10T12:00:00.000Z',
      estimated: true,
    });
  });

  it('correctly handles auto-merged task without duplicate trailing done step and computes durations', async () => {
    const repoPath = path.join(tmpDir, 'repo-automerge');
    initGitRepo(repoPath);

    ctx.projectRepo.insert({
      id: 'proj-auto',
      name: 'Project Auto',
      path: repoPath,
      defaultBranch: 'main',
      maxParallel: 3,
    });

    ctx.taskRepo.insert({
      id: 'proj-auto/t4',
      projectId: 'proj-auto',
      slug: 't4',
      title: 'Auto-merged task',
      status: 'done',
      statusChangedAt: '2026-11-12T10:18:00.000Z',
    });

    ctx.eventRepo.insert('task.queued', 'proj-auto/t4');
    ctx.eventRepo.insert('task.running', 'proj-auto/t4', { runId: 'run-4', profile: 'w1' });
    ctx.eventRepo.insert('task.checking', 'proj-auto/t4');
    ctx.eventRepo.insert('task.review_ready', 'proj-auto/t4');
    ctx.eventRepo.insert('task.done', 'proj-auto/t4', { by: 'claude-reviewer' });
    ctx.eventRepo.insert('task.merged', 'proj-auto/t4', { mergeCommit: 'abc1234' });

    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:00:00' WHERE taskId = 'proj-auto/t4' AND type = 'task.queued'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:02:00' WHERE taskId = 'proj-auto/t4' AND type = 'task.running'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:14:00' WHERE taskId = 'proj-auto/t4' AND type = 'task.checking'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:15:00' WHERE taskId = 'proj-auto/t4' AND type = 'task.review_ready'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:18:00' WHERE taskId = 'proj-auto/t4' AND type = 'task.done'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:20:00' WHERE taskId = 'proj-auto/t4' AND type = 'task.merged'").run();

    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/proj-auto~t4/timeline',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const timeline = res.json();

    // Verify exactly 6 steps, ending with 'merged', not done -> merged -> done
    expect(timeline.map((item: { status: string }) => item.status)).toEqual([
      'queued',
      'running',
      'checking',
      'review',
      'done',
      'merged',
    ]);

    expect(timeline[4]).toEqual({
      status: 'done',
      at: '2026-11-12T10:18:00.000Z',
      durationMs: 2 * 60 * 1000, // 2 mins from 10:18 to 10:20
      actor: 'claude-reviewer',
    });

    expect(timeline[5]).toEqual({
      status: 'merged',
      at: '2026-11-12T10:20:00.000Z',
    });

    // Also verify getTask returns identical timeline without duplicate reading
    const taskDetail = await ctx.service.getTask('proj-auto~t4');
    expect(taskDetail.timeline).toEqual(timeline);
  });

  it('correctly handles pushed task with status done without duplicate trailing done step', async () => {
    const repoPath = path.join(tmpDir, 'repo-pushed');
    initGitRepo(repoPath);

    ctx.projectRepo.insert({
      id: 'proj-push',
      name: 'Project Push',
      path: repoPath,
      defaultBranch: 'main',
      maxParallel: 3,
    });

    ctx.taskRepo.insert({
      id: 'proj-push/t5',
      projectId: 'proj-push',
      slug: 't5',
      title: 'Pushed task',
      status: 'done',
      statusChangedAt: '2026-11-12T10:18:00.000Z',
      pushedAt: '2026-11-12T10:25:00.000Z',
    });

    ctx.eventRepo.insert('task.done', 'proj-push/t5', { by: 'user' });
    ctx.eventRepo.insert('task.merged', 'proj-push/t5');
    ctx.eventRepo.insert('task.pushed', 'proj-push/t5');

    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:18:00' WHERE taskId = 'proj-push/t5' AND type = 'task.done'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:20:00' WHERE taskId = 'proj-push/t5' AND type = 'task.merged'").run();
    ctx.db.prepare("UPDATE events SET ts = '2026-11-12 10:25:00' WHERE taskId = 'proj-push/t5' AND type = 'task.pushed'").run();

    const res = await server.inject({
      method: 'GET',
      url: '/api/tasks/proj-push~t5/timeline',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const timeline = res.json();

    expect(timeline.map((item: { status: string }) => item.status)).toEqual([
      'done',
      'merged',
      'pushed',
    ]);

    expect(timeline[0]).toEqual({
      status: 'done',
      at: '2026-11-12T10:18:00.000Z',
      durationMs: 2 * 60 * 1000,
      actor: 'user',
    });

    expect(timeline[1]).toEqual({
      status: 'merged',
      at: '2026-11-12T10:20:00.000Z',
      durationMs: 5 * 60 * 1000,
    });

    expect(timeline[2]).toEqual({
      status: 'pushed',
      at: '2026-11-12T10:25:00.000Z',
    });
  });

  it('restoreProject emits standard events and does not replay stale notes', async () => {
    const repoPath = path.join(tmpDir, 'repo-restore');
    initGitRepo(repoPath);

    ctx.projectRepo.insert({
      id: 'proj-res',
      name: 'Project Restore',
      path: repoPath,
      defaultBranch: 'main',
      maxParallel: 3,
    });

    ctx.taskRepo.insert({
      id: 'proj-res/t-rev',
      projectId: 'proj-res',
      slug: 't-rev',
      title: 'Review Task',
      status: 'review',
    });

    ctx.taskRepo.insert({
      id: 'proj-res/t-q',
      projectId: 'proj-res',
      slug: 't-q',
      title: 'Queued Task',
      status: 'queued',
    });

    // Simulate an old archive note from a previous cycle that should be consumed/cleaned up
    ctx.taskNoteRepo.insert({
      projectId: 'proj-res',
      taskId: 'proj-res/t-rev',
      kind: 'note',
      content: 'project_archive_status:{"status":"draft","waitReason":null}',
    });

    // Archive project (delete without purge)
    ctx.service.deleteProject('proj-res');

    expect(ctx.taskRepo.get('proj-res/t-rev')!.status).toBe('paused');
    expect(ctx.taskRepo.get('proj-res/t-q')!.status).toBe('paused');

    // Capture events emitted during restore
    const emittedEvents: Array<{ type: string; taskId?: string; payload?: unknown }> = [];
    ctx.scheduler.getEventBus().on('*', (type, taskId, payload) => {
      emittedEvents.push({ type, taskId, payload });
    });

    // Restore project
    ctx.service.restoreProject('proj-res');

    // Verify status restored
    expect(ctx.taskRepo.get('proj-res/t-rev')!.status).toBe('review');
    expect(ctx.taskRepo.get('proj-res/t-q')!.status).toBe('queued');

    // Emitted event for review must be standard task.review_ready, NOT task.review
    const revEvents = emittedEvents.filter((e) => e.taskId === 'proj-res/t-rev');
    expect(revEvents).toHaveLength(1);
    expect(revEvents[0].type).toBe('task.review_ready');
    expect(revEvents[0].payload).toMatchObject({ reason: 'project_restored', status: 'review' });

    // Emitted event for queued task
    const qEvents = emittedEvents.filter((e) => e.taskId === 'proj-res/t-q');
    expect(qEvents).toHaveLength(1);
    expect(qEvents[0].type).toBe('task.queued');

    // Stale/archive notes for this project should be deleted
    const remainingNotes = ctx.taskNoteRepo.getByProject('proj-res').filter((n) => n.content.startsWith('project_archive_status:'));
    expect(remainingNotes).toHaveLength(0);

    // Verify timeline understands task.review_ready
    const timeline = ctx.service.getTaskTimeline('proj-res/t-rev');
    expect(timeline.some((item) => item.status === 'review')).toBe(true);
  });
});
