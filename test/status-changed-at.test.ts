import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  openDatabase,
  TaskRepo,
} from '../src/db/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Task statusChangedAt and backfill', () => {
  it('backfills statusChangedAt from events when events exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-status-changed-at-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');

    // Create database up to migration 74 (without statusChangedAt)
    const rawDb = new Database(dbPath);
    for (let i = 0; i <= 74; i++) {
      rawDb.exec(MIGRATIONS[i]);
      rawDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(i));
    }

    // Insert project and tasks
    rawDb.prepare("INSERT INTO projects (id, name, path) VALUES ('p', 'Project', '/tmp')").run();
    rawDb.prepare(`
      INSERT INTO tasks (id, projectId, slug, title, status, createdAt, updatedAt)
      VALUES
        ('p/t1', 'p', 't1', 'Queued task', 'queued', '2026-10-15 08:00:00', '2026-10-15 08:05:00'),
        ('p/t2', 'p', 't2', 'Done task', 'done', '2026-10-15 08:00:00', '2026-10-15 08:30:00'),
        ('p/t3', 'p', 't3', 'Missing event task', 'failed', '2026-10-15 08:00:00', '2026-10-15 09:00:00')
    `).run();

    // Insert events for t1 and t2
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:10:00', 'task.queued', 'p/t1')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:05:00', 'task.queued', 'p/t2')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:25:00', 'task.done', 'p/t2')").run();
    rawDb.close();

    // Now open with openDatabase, which runs migration 75 and ensureStatusChangedAtBackfill
    const db = openDatabase(dbPath);
    const taskRepo = new TaskRepo(db);

    const t1 = taskRepo.get('p/t1')!;
    expect(t1.statusChangedAt).toBe(new Date(Date.parse('2026-10-15T08:10:00Z')).toISOString());
    expect(t1.statusChangedAtEstimated).toBe(0);

    const t2 = taskRepo.get('p/t2')!;
    expect(t2.statusChangedAt).toBe(new Date(Date.parse('2026-10-15T08:25:00Z')).toISOString());
    expect(t2.statusChangedAtEstimated).toBe(0);

    // t3 has no events: fallback to updatedAt and marked as estimated
    const t3 = taskRepo.get('p/t3')!;
    expect(t3.statusChangedAt).toBe(new Date(Date.parse('2026-10-15T09:00:00Z')).toISOString());
    expect(t3.statusChangedAtEstimated).toBe(1);

    db.close();
  });

  it('updates statusChangedAt and clears estimated flag on updateStatus and update', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-status-update-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');

    const db = openDatabase(dbPath);
    const taskRepo = new TaskRepo(db);
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p', 'Project', '/tmp')").run();

    taskRepo.insert({
      id: 'p/task-1',
      projectId: 'p',
      slug: 'task-1',
      title: 'Task 1',
      status: 'draft',
    });

    const initial = taskRepo.get('p/task-1')!;
    expect(initial.status).toBe('draft');
    expect(initial.statusChangedAt).toBeDefined();
    expect(initial.statusChangedAtEstimated).toBe(0);

    const oldTime = '2026-11-12T00:00:00.000Z';
    // Update status to queued
    taskRepo.updateStatus('p/task-1', 'queued', null, oldTime);
    const queued = taskRepo.get('p/task-1')!;
    expect(queued.status).toBe('queued');
    expect(queued.statusChangedAt).toBe(oldTime);
    expect(queued.statusChangedAtEstimated).toBe(0);

    // Update status via update()
    const newTime = '2026-11-12T01:00:00.000Z';
    taskRepo.update('p/task-1', { status: 'running', statusChangedAt: newTime });
    const running = taskRepo.get('p/task-1')!;
    expect(running.status).toBe('running');
    expect(running.statusChangedAt).toBe(newTime);
    expect(running.statusChangedAtEstimated).toBe(0);

    // Page sorting by statusChangedAt
    taskRepo.insert({
      id: 'p/task-2',
      projectId: 'p',
      slug: 'task-2',
      title: 'Task 2',
      status: 'running',
      statusChangedAt: '2026-11-12T02:00:00.000Z',
    });

    const pageDesc = taskRepo.page({ sort: 'statusChangedAt', order: 'desc' });
    expect(pageDesc.items[0].id).toBe('p/task-2');
    expect(pageDesc.items[1].id).toBe('p/task-1');

    const pageAsc = taskRepo.page({ sort: 'statusChangedAt', order: 'asc' });
    expect(pageAsc.items[0].id).toBe('p/task-1');
    expect(pageAsc.items[1].id).toBe('p/task-2');

    db.close();
  });
});
