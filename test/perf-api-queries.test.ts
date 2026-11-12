import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRepo, openDatabase, TaskNoteRepo, TaskRepo } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';

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
    expect(events.deleteExpired(
      ['brain.updated', 'brain.status', 'deploy.restart_waiting'],
      ['review.fallback', 'review.auto_merge_skipped', 'task.merged'],
      '2020-01-01 00:00:00',
      '2020-01-01 00:00:00',
      100,
    )).toBe(2);
    expect(db.prepare('SELECT type FROM events ORDER BY id').all()).toEqual([
      { type: 'review.fallback' },
      { type: 'task.merged' },
    ]);
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
