import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRepo, openDatabase, TaskNoteRepo, TaskRepo } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { closeContext, createContext } from '../src/daemon.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('API query performance support', () => {
  it('loads retention defaults and config overrides', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-retention-config-'));
    dirs.push(dir);
    expect(loadConfig(dir).retention).toEqual({ noisyEventDays: 14, eventDays: 90, taskNoteDays: 90 });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ retention: { noisyEventDays: 3, eventDays: 12, taskNoteDays: 21 } }));
    expect(loadConfig(dir).retention).toEqual({ noisyEventDays: 3, eventDays: 12, taskNoteDays: 21 });
  });

  it('retains protected event types while deleting old noisy and ordinary events in batches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-retention-db-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'hub.db'));
    const events = new EventRepo(db);
    const old = '2000-01-01 00:00:00';
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run(old, 'brain.updated', 'p/t');
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run(old, 'task.created', 'p/t');
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run(old, 'review.fallback', 'p/t');
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run(old, 'task.merged', 'p/t');
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run(old, 'tracker.timesheet.posted', 'p/t');
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run('2026-11-01 00:00:00', 'brain.updated', 'p/t');
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run('2026-11-01 00:00:00', 'task.created', 'p/t');
    expect(events.deleteExpired(
      ['brain.updated', 'brain.status', 'deploy.restart_waiting'],
      ['review.fallback', 'review.auto_merge_skipped', 'task.merged', 'tracker.timesheet.posted'],
      '2020-01-01 00:00:00',
      '2020-01-01 00:00:00',
      100,
    )).toBe(2);
    expect(db.prepare('SELECT type FROM events ORDER BY id').all()).toEqual([
      { type: 'review.fallback' },
      { type: 'task.merged' },
      { type: 'tracker.timesheet.posted' },
      { type: 'brain.updated' },
      { type: 'task.created' },
    ]);
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run(old, 'brain.updated', 'p/t');
    db.prepare("INSERT INTO events (ts, type, taskId) VALUES (?, ?, ?)").run(old, 'brain.updated', 'p/t');
    expect(events.deleteExpired(['brain.updated'], [], '2020-01-01 00:00:00', '2020-01-01 00:00:00', 1)).toBe(1);
    expect(events.deleteExpired(['brain.updated'], [], '2020-01-01 00:00:00', '2020-01-01 00:00:00', 1)).toBe(1);
    db.close();
  });

  it('deletes only old completed overlap notes and retains active-task notes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-retention-notes-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'hub.db'));
    const tasks = new TaskRepo(db);
    const notes = new TaskNoteRepo(db);
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p', 'P', ?)").run(dir);
    tasks.insert({ id: 'p/done', projectId: 'p', slug: 'done', title: 'Done', status: 'done' });
    tasks.insert({ id: 'p/running', projectId: 'p', slug: 'running', title: 'Running', status: 'running' });
    db.prepare("UPDATE tasks SET updatedAt = '2000-01-01 00:00:00' WHERE id = 'p/done'").run();
    const deleted = notes.insert({ projectId: 'p', taskId: 'p/done', kind: 'overlap', content: 'old' });
    notes.insert({ projectId: 'p', taskId: 'p/running', kind: 'overlap', content: 'active' });
    notes.insert({ projectId: 'p', taskId: 'p/done', kind: 'note', content: 'keep' });
    expect(notes.deleteOldCompletedOverlaps('2020-01-01 00:00:00', 1)).toBe(1);
    expect(notes.get(deleted.id)).toBeUndefined();
    expect(notes.getByTask('p/running')).toHaveLength(1);
    expect(notes.getByTask('p/done')).toHaveLength(1);
    db.close();
  });

  it('runs scheduler retention to completion and preserves historical timesheet markers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-retention-scheduler-'));
    dirs.push(dir);
    const config = loadConfig(dir);
    config.retention = { noisyEventDays: 14, eventDays: 90, taskNoteDays: 90 };
    const ctx = createContext(config);
    try {
      for (let i = 0; i < 1105; i++) ctx.eventRepo.insert('brain.updated', 'p/t', { i });
      ctx.eventRepo.insert('tracker.timesheet.posted', 'p/t', { sourceId: 's', date: '2000-01-01' });
      ctx.db.prepare("UPDATE events SET ts = '2000-01-01 00:00:00'").run();
      await (ctx.scheduler as unknown as { runRetentionBatch: () => Promise<void> }).runRetentionBatch();
      expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'brain.updated'").get()).toEqual({ count: 0 });
      expect(ctx.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'tracker.timesheet.posted'").get()).toEqual({ count: 1 });
    } finally {
      closeContext(ctx);
    }
  });

  it('decorates listTasks and listTasksPage like the legacy per-task lookup across batches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-api-decoration-'));
    dirs.push(dir);
    const config = loadConfig(dir);
    const ctx = createContext(config);
    try {
      ctx.projectRepo.insert({
        id: 'p', name: 'P', path: dir, defaultBranch: 'main', envTemplate: null, maxParallel: 1,
        review: JSON.stringify({ chain: [{ reviewer: 'codex' }] }),
      });
      for (let i = 0; i < 905; i++) {
        const id = `p/task-${i}`;
        ctx.taskRepo.insert({ id, projectId: 'p', slug: `task-${i}`, title: `Task ${i}`, status: 'review' });
        if (i === 7) {
          ctx.eventRepo.insert('review.fallback', id, { to: 'claude' });
          ctx.eventRepo.insert('review.fallback', id, { to: 'codex' });
          ctx.eventRepo.insert('review.auto_merge_skipped', id, { reason: 'checks_failed', checks: ['lint'], retried: true });
        }
      }
      const list = ctx.service.listTasks();
      const page = ctx.service.listTasksPage({ limit: 100, order: 'asc' });
      expect(list).toHaveLength(905);
      expect(page.items).toHaveLength(100);
      for (const pageItem of page.items) expect(pageItem).toEqual(list.find((task) => task.id === pageItem.id));
      const item = list.find((task) => task.id === 'p/task-7')!;
      expect(item.reviewer).toBe('codex');
      expect(item.autoMergeSkippedReason).toBe('checks_failed');
      expect(item.autoMergeSkippedChecks).toEqual(['lint']);
      expect(item.autoMergeSkippedRetried).toBe(true);
      const pageItem = page.items[0];
      expect(pageItem).toEqual(list.find((task) => task.id === pageItem.id));
      expect(pageItem).toMatchObject({
        reviewer: 'codex',
        reviewChain: [],
        autoMergeSkippedReason: null,
        autoMergeSkippedRetried: false,
      });
      const legacyEvents = ctx.taskRepo.getAll().map((task) => [
        task.id,
        ctx.eventRepo.getByTask(task.id).filter((event) => event.type === 'review.fallback' || event.type === 'review.auto_merge_skipped'),
      ] as const);
      expect(legacyEvents.find(([id]) => id === item.id)?.[1].map((event) => event.type)).toEqual([
        'review.fallback', 'review.fallback', 'review.auto_merge_skipped',
      ]);
    } finally {
      closeContext(ctx);
    }
  });

  it('benchmarks 500 tasks with 100 events each: batched query reduces event-row work', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-api-benchmark-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'hub.db'));
    const tasks = new TaskRepo(db);
    const events = new EventRepo(db);
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p', 'P', ?)").run(dir);
    for (let i = 0; i < 500; i++) {
      const taskId = `p/t-${i}`;
      tasks.insert({ id: taskId, projectId: 'p', slug: `t-${i}`, title: `T ${i}` });
    }
    const insertEvents = db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const taskId = `p/t-${i}`;
        for (let j = 0; j < 100; j++) events.insert(j === 99 ? 'review.fallback' : 'brain.updated', taskId, { j });
      }
    });
    insertEvents();
    const ids = tasks.getAll().map((task) => task.id);
    const before = performance.now();
    const legacy = ids.flatMap((id) => events.getByTask(id).filter((event) => event.type === 'review.fallback'));
    const legacyMs = performance.now() - before;
    const after = performance.now();
    const batched = events.getByTasksAndTypes(ids, ['review.fallback', 'review.auto_merge_skipped']);
    const batchedMs = performance.now() - after;
    console.log(`[perf-api-queries] 500x100 legacy=${legacyMs.toFixed(2)}ms batched=${batchedMs.toFixed(2)}ms`);
    expect(legacy).toHaveLength(500);
    expect(batched).toHaveLength(500);
    expect(batchedMs).toBeLessThan(legacyMs);
    db.close();
  });

  it('uses WAL-safe SQLite pragmas and scoped worktree queries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-query-repo-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'hub.db'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    const tasks = new TaskRepo(db);
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p', 'P', ?)").run(dir);
    tasks.insert({ id: 'p/done', projectId: 'p', slug: 'done', title: 'Done', status: 'done', worktreePath: '/tmp/wt-done' });
    tasks.insert({ id: 'p/queued', projectId: 'p', slug: 'queued', title: 'Queued', status: 'queued', worktreePath: '/tmp/wt-queued' });
    expect(tasks.getCompletedWithWorktrees().map((task) => task.id)).toEqual(['p/done']);
    expect(tasks.getWorktreeReferences().map((task) => task.id)).toEqual(['p/done', 'p/queued']);
    new TaskNoteRepo(db);
    db.close();
  });
});
