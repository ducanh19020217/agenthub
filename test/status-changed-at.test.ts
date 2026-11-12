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
        ('p/t3', 'p', 't3', 'Missing event task', 'failed', '2026-10-15 08:00:00', '2026-10-15 09:00:00'),
        ('p/t4', 'p', 't4', 'Pushed task', 'pushed', '2026-10-15 08:00:00', '2026-10-15 08:40:00'),
        ('p/t5', 'p', 't5', 'Review task', 'review', '2026-10-15 08:00:00', '2026-10-15 08:50:00'),
        ('p/t6', 'p', 't6', 'Checking task', 'checking', '2026-10-15 08:00:00', '2026-10-15 08:55:00'),
        ('p/t7', 'p', 't7', 'Waiting quota task', 'waiting_quota', '2026-10-15 08:00:00', '2026-10-15 08:58:00')
    `).run();

    // Insert events
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:10:00', 'task.queued', 'p/t1')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:05:00', 'task.queued', 'p/t2')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:25:00', 'task.done', 'p/t2')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:35:00', 'task.pushed', 'p/t4')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:45:00', 'task.review_ready', 'p/t5')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:52:00', 'task.checking', 'p/t6')").run();
    rawDb.prepare("INSERT INTO events (ts, type, taskId) VALUES ('2026-10-15 08:56:00', 'task.waiting_quota', 'p/t7')").run();
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

    const t4 = taskRepo.get('p/t4')!;
    expect(t4.statusChangedAt).toBe(new Date(Date.parse('2026-10-15T08:35:00Z')).toISOString());
    expect(t4.statusChangedAtEstimated).toBe(0);

    const t5 = taskRepo.get('p/t5')!;
    expect(t5.statusChangedAt).toBe(new Date(Date.parse('2026-10-15T08:45:00Z')).toISOString());
    expect(t5.statusChangedAtEstimated).toBe(0);

    const t6 = taskRepo.get('p/t6')!;
    expect(t6.statusChangedAt).toBe(new Date(Date.parse('2026-10-15T08:52:00Z')).toISOString());
    expect(t6.statusChangedAtEstimated).toBe(0);

    const t7 = taskRepo.get('p/t7')!;
    expect(t7.statusChangedAt).toBe(new Date(Date.parse('2026-10-15T08:56:00Z')).toISOString());
    expect(t7.statusChangedAtEstimated).toBe(0);

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

  it('preserves statusChangedAt and statusChangedAtEstimated when status is unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-status-preserve-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');

    const db = openDatabase(dbPath);
    const taskRepo = new TaskRepo(db);
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p', 'Project', '/tmp')").run();

    const originalTime = '2026-11-12T00:00:00.000Z';
    taskRepo.insert({
      id: 'p/task-same',
      projectId: 'p',
      slug: 'task-same',
      title: 'Task Same Status',
      status: 'queued',
      statusChangedAt: originalTime,
    });

    // Mark as estimated to verify estimated flag is also preserved
    db.prepare('UPDATE tasks SET statusChangedAtEstimated = 1 WHERE id = ?').run('p/task-same');

    const before = taskRepo.get('p/task-same')!;
    expect(before.status).toBe('queued');
    expect(before.statusChangedAt).toBe(originalTime);
    expect(before.statusChangedAtEstimated).toBe(1);

    // 1. updateStatus without changing status
    taskRepo.updateStatus('p/task-same', 'queued', 'focus');
    const afterUpdateStatus = taskRepo.get('p/task-same')!;
    expect(afterUpdateStatus.status).toBe('queued');
    expect(afterUpdateStatus.waitReason).toBe('focus');
    expect(afterUpdateStatus.statusChangedAt).toBe(originalTime);
    expect(afterUpdateStatus.statusChangedAtEstimated).toBe(1);

    // 2. update() without changing status
    taskRepo.update('p/task-same', { status: 'queued', waitReason: 'disk' });
    const afterUpdate = taskRepo.get('p/task-same')!;
    expect(afterUpdate.status).toBe('queued');
    expect(afterUpdate.waitReason).toBe('disk');
    expect(afterUpdate.statusChangedAt).toBe(originalTime);
    expect(afterUpdate.statusChangedAtEstimated).toBe(1);

    // 3. updateStatus WITH a status change refreshes timestamp and resets estimated to 0
    const runningTime = '2026-11-12T01:00:00.000Z';
    taskRepo.updateStatus('p/task-same', 'running', null, runningTime);
    const afterStatusChange = taskRepo.get('p/task-same')!;
    expect(afterStatusChange.status).toBe('running');
    expect(afterStatusChange.statusChangedAt).toBe(runningTime);
    expect(afterStatusChange.statusChangedAtEstimated).toBe(0);

    // 4. update() WITH a status change without explicit timestamp automatically sets now and resets estimated to 0
    const beforeDone = Date.now();
    taskRepo.update('p/task-same', { status: 'done' });
    const afterUpdateChange = taskRepo.get('p/task-same')!;
    expect(afterUpdateChange.status).toBe('done');
    expect(afterUpdateChange.statusChangedAt).not.toBe(runningTime);
    expect(Date.parse(afterUpdateChange.statusChangedAt)).toBeGreaterThanOrEqual(beforeDone - 1000);
    expect(afterUpdateChange.statusChangedAtEstimated).toBe(0);

    db.close();
  });

  it('paginates correctly using cursor when sort=statusChangedAt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cursor-pagination-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');

    const db = openDatabase(dbPath);
    const taskRepo = new TaskRepo(db);
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p', 'Project', '/tmp')").run();

    // Insert 5 tasks with distinct statusChangedAt
    const timestamps = [
      '2026-11-12T01:00:00.000Z',
      '2026-11-12T02:00:00.000Z',
      '2026-11-12T03:00:00.000Z',
      '2026-11-12T04:00:00.000Z',
      '2026-11-12T05:00:00.000Z',
    ];

    for (let i = 0; i < timestamps.length; i++) {
      taskRepo.insert({
        id: `p/task-${i + 1}`,
        projectId: 'p',
        slug: `task-${i + 1}`,
        title: `Task ${i + 1}`,
        status: 'done',
        statusChangedAt: timestamps[i],
      });
    }

    // Test DESC order pagination with limit 2
    const page1Desc = taskRepo.page({ sort: 'statusChangedAt', order: 'desc', limit: 2 });
    expect(page1Desc.total).toBe(5);
    expect(page1Desc.items).toHaveLength(2);
    expect(page1Desc.items[0].id).toBe('p/task-5');
    expect(page1Desc.items[1].id).toBe('p/task-4');
    expect(page1Desc.nextCursor).toBeDefined();

    const page2Desc = taskRepo.page({ sort: 'statusChangedAt', order: 'desc', limit: 2, cursor: page1Desc.nextCursor! });
    expect(page2Desc.items).toHaveLength(2);
    expect(page2Desc.items[0].id).toBe('p/task-3');
    expect(page2Desc.items[1].id).toBe('p/task-2');
    expect(page2Desc.nextCursor).toBeDefined();

    const page3Desc = taskRepo.page({ sort: 'statusChangedAt', order: 'desc', limit: 2, cursor: page2Desc.nextCursor! });
    expect(page3Desc.items).toHaveLength(1);
    expect(page3Desc.items[0].id).toBe('p/task-1');
    expect(page3Desc.nextCursor).toBeNull();

    // Test ASC order pagination with limit 2
    const page1Asc = taskRepo.page({ sort: 'statusChangedAt', order: 'asc', limit: 2 });
    expect(page1Asc.items).toHaveLength(2);
    expect(page1Asc.items[0].id).toBe('p/task-1');
    expect(page1Asc.items[1].id).toBe('p/task-2');
    expect(page1Asc.nextCursor).toBeDefined();

    const page2Asc = taskRepo.page({ sort: 'statusChangedAt', order: 'asc', limit: 2, cursor: page1Asc.nextCursor! });
    expect(page2Asc.items).toHaveLength(2);
    expect(page2Asc.items[0].id).toBe('p/task-3');
    expect(page2Asc.items[1].id).toBe('p/task-4');
    expect(page2Asc.nextCursor).toBeDefined();

    const page3Asc = taskRepo.page({ sort: 'statusChangedAt', order: 'asc', limit: 2, cursor: page2Asc.nextCursor! });
    expect(page3Asc.items).toHaveLength(1);
    expect(page3Asc.items[0].id).toBe('p/task-5');
    expect(page3Asc.nextCursor).toBeNull();

    db.close();
  });
});
