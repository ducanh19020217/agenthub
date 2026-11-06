import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase } from '../src/db/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('database migrations', () => {
  it('adds chat state when reopening a database at the previous latest schema version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-state-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    for (let version = 0; version < MIGRATIONS.length - 1; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
    }
    oldDb.close();

    const db = openDatabase(dbPath);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get()).toBe(String(MIGRATIONS.length - 1));
    expect(db.prepare('PRAGMA table_info(chat_sessions)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'state' })]),
    );
    db.close();
  });

  it('migrates a populated schema 0-6 database without breaking check_results foreign keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    oldDb.pragma('foreign_keys = ON');

    for (let version = 0; version <= 6; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
      if (version === 0) {
        oldDb.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p', 'Project', dir);
        oldDb.prepare('INSERT INTO profiles (name, engine, kind) VALUES (?, ?, ?)').run('profile', 'agy', 'isolated');
        oldDb.prepare('INSERT INTO tasks (id, projectId, slug, title) VALUES (?, ?, ?, ?)').run('p/task', 'p', 'task', 'Task');
        oldDb.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run('run-1', 'p/task', 'agy', 'gemini-3.8-flash-low', 'profile');
      }
      if (version === 2) {
        oldDb.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)').run('profile', 'gemini', '5h', 50, 100, 100);
      }
      if (version === 3) {
        oldDb.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)').run('p/task', 'run-1', 'lint', 1, 0, 10, 'ok');
      }
      if (version === 5) {
        oldDb.prepare('INSERT INTO chat_sessions (id, projectId) VALUES (?, ?)').run('session-1', 'p');
        oldDb.prepare('INSERT INTO chat_messages (id, sessionId, role, content) VALUES (?, ?, ?, ?)').run('message-1', 'session-1', 'user', 'hello');
      }
    }
    oldDb.close();

    const db = openDatabase(dbPath);
    expect(db.prepare('SELECT value FROM meta WHERE key = \'schema_version\'').pluck().get()).toBe(String(MIGRATIONS.length - 1));
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT outcome, reason FROM runs WHERE id = \'run-1\'').get()).toEqual({ outcome: null, reason: null });
    expect(db.prepare('SELECT waitReason FROM tasks WHERE id = \'p/task\'').get()).toEqual({ waitReason: null });
    expect(db.prepare('SELECT doneReport, diffStat FROM tasks WHERE id = \'p/task\'').get()).toEqual({ doneReport: null, diffStat: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM check_results').get()).toMatchObject({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_list(check_results)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'runs' })]),
    );
    db.close();
  });

  it('marks an existing installation with multiple personal profiles for compatibility', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-policy-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    for (let version = 0; version <= 28; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
    }
    oldDb.prepare("INSERT INTO profiles (name, engine, kind) VALUES ('old-a', 'agy', 'isolated')").run();
    oldDb.prepare("INSERT INTO profiles (name, engine, kind) VALUES ('old-b', 'agy', 'isolated')").run();
    oldDb.close();

    const db = openDatabase(dbPath);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'multiple_per_provider_legacy'").pluck().get()).toBe('true');
    expect(db.prepare('SELECT accountType FROM profiles ORDER BY name').all()).toEqual([
      { accountType: 'personal' },
      { accountType: 'personal' },
    ]);
    db.close();
  });

  it('migration 42 retains existing waitReason values when updating schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-waitreason-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    for (let version = 0; version <= 41; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
      if (version === 0) {
        oldDb.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p', 'Project', dir);
      }
    }

    // Insert tasks with different waitReasons prior to migration 42
    oldDb.prepare('INSERT INTO tasks (id, projectId, slug, title, status, waitReason) VALUES (?, ?, ?, ?, ?, ?)').run('t1', 'p', 't1', 'Task 1', 'waiting_quota', 'quota');
    oldDb.prepare('INSERT INTO tasks (id, projectId, slug, title, status, waitReason) VALUES (?, ?, ?, ?, ?, ?)').run('t2', 'p', 't2', 'Task 2', 'waiting_quota', 'disk');
    oldDb.prepare('INSERT INTO tasks (id, projectId, slug, title, status, waitReason) VALUES (?, ?, ?, ?, ?, ?)').run('t3', 'p', 't3', 'Task 3', 'waiting_quota', 'parallel');
    oldDb.prepare('INSERT INTO tasks (id, projectId, slug, title, status, waitReason) VALUES (?, ?, ?, ?, ?, ?)').run('t4', 'p', 't4', 'Task 4', 'waiting_quota', 'profile_busy');
    oldDb.prepare('INSERT INTO tasks (id, projectId, slug, title, status, waitReason) VALUES (?, ?, ?, ?, ?, ?)').run('t5', 'p', 't5', 'Task 5', 'queued', null);
    oldDb.close();

    const db = openDatabase(dbPath);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get()).toBe(String(MIGRATIONS.length - 1));

    const rows = db.prepare('SELECT id, waitReason FROM tasks ORDER BY id').all() as { id: string; waitReason: string | null }[];
    expect(rows).toEqual([
      { id: 't1', waitReason: 'quota' },
      { id: 't2', waitReason: 'disk' },
      { id: 't3', waitReason: 'parallel' },
      { id: 't4', waitReason: 'profile_busy' },
      { id: 't5', waitReason: null },
    ]);

    // Also verify 'project_unavailable' is allowed now
    db.prepare("UPDATE tasks SET waitReason = 'project_unavailable' WHERE id = 't5'").run();
    expect(db.prepare("SELECT waitReason FROM tasks WHERE id = 't5'").pluck().get()).toBe('project_unavailable');

    db.close();
  });

  it('migration 56 keeps the schema 55 task column order and preserves rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-56-order-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    for (let version = 0; version <= 55; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
      if (version === 0) {
        oldDb.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p', 'Project', dir);
      }
    }
    oldDb.prepare(`
      INSERT INTO tasks (id, projectId, slug, title, externalRef, body, level, status, waitReason)
      VALUES ('p/task', 'p', 'task', 'Title', 'ref-1', 'body', 'hard', 'queued', 'focus')
    `).run();
    oldDb.close();

    const migrated = openDatabase(dbPath);
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-56-fresh-test-'));
    tempDirs.push(freshDir);
    const fresh = openDatabase(path.join(freshDir, 'hub.db'));
    const columns = (db: Database.Database) =>
      (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name);

    expect(columns(migrated)).toEqual(columns(fresh));
    expect(migrated.prepare('SELECT id, externalRef, body, level, waitReason FROM tasks').get()).toEqual({
      id: 'p/task', externalRef: 'ref-1', body: 'body', level: 'hard', waitReason: 'focus',
    });
    expect(migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get()).toBe(String(MIGRATIONS.length - 1));
    migrated.close();
    fresh.close();
  });

  it('migration 72 adds pushedAt, pushResult, and allows status pushed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-72-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    for (let version = 0; version <= 71; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
      if (version === 0) {
        oldDb.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p', 'Project', dir);
      }
    }
    oldDb.prepare(`
      INSERT INTO tasks (id, projectId, slug, title, body, status)
      VALUES ('p/task', 'p', 'task', 'Title', 'body', 'done')
    `).run();
    oldDb.close();

    const migrated = openDatabase(dbPath);
    const cols = (migrated.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('pushedAt');
    expect(cols).toContain('pushResult');

    // Update existing task to pushed
    migrated.prepare("UPDATE tasks SET status = 'pushed', pushedAt = '2026-11-07T00:00:00Z', pushResult = '{\"commit\":\"abc\"}' WHERE id = 'p/task'").run();
    const task = migrated.prepare('SELECT status, pushedAt, pushResult FROM tasks WHERE id = ?').get('p/task') as { status: string; pushedAt: string; pushResult: string };
    expect(task.status).toBe('pushed');
    expect(task.pushedAt).toBe('2026-11-07T00:00:00Z');
    expect(JSON.parse(task.pushResult)).toEqual({ commit: 'abc' });
    migrated.close();
  });
});
