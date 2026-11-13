import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, openDatabase } from '../src/db/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeVersion72Database(withLeftover: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mig73-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'hub.db');
  const db = new Database(dbPath);
  for (let i = 0; i <= 72; i++) db.exec(MIGRATIONS[i]);
  db.exec(`ALTER TABLE tasks ADD COLUMN runCount INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN consecutiveCrashes INTEGER NOT NULL DEFAULT 0;`);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '72')").run();
  db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('project', 'Project', dir);
  const insertTask = db.prepare(`INSERT INTO tasks
    (id, projectId, slug, title, runCount, consecutiveCrashes) VALUES (?, ?, ?, ?, ?, ?)`);
  insertTask.run('project/one', 'project', 'one', 'One', 4, 2);
  insertTask.run('project/two', 'project', 'two', 'Two', 7, 3);
  if (withLeftover) db.exec('CREATE TABLE tasks_new (id TEXT)');
  db.close();
  return dbPath;
}

function expectMigratedDatabase(dbPath: string): void {
  const db = openDatabase(dbPath);
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  expect(Number(version.value)).toBe(MIGRATIONS.length - 1);
  expect((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count).toBe(2);
  expect(db.prepare('SELECT id, runCount, consecutiveCrashes FROM tasks ORDER BY id').all()).toEqual([
    { id: 'project/one', runCount: 4, consecutiveCrashes: 2 },
    { id: 'project/two', runCount: 7, consecutiveCrashes: 3 },
  ]);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks_new'").get()).toBeUndefined();
  const columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all('tasks') as Array<{ name: string }>).map((row) => row.name);
  expect(columns).toEqual(expect.arrayContaining(['runCount', 'consecutiveCrashes']));
  db.prepare("UPDATE tasks SET waitReason = 'restart' WHERE id = ?").run('project/one');
  expect((db.prepare('SELECT waitReason FROM tasks WHERE id = ?').get('project/one') as { waitReason: string }).waitReason).toBe('restart');
  db.close();
}

describe('Migration 73 restart wait reason', () => {
  it('migrates version 72 tasks and preserves scheduler counters', () => {
    expectMigratedDatabase(makeVersion72Database(false));
  });

  it('drops a leftover tasks_new table before rebuilding tasks', () => {
    expectMigratedDatabase(makeVersion72Database(true));
  });

  it('adds scheduler counters before migration 73 on a fresh database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mig73-fresh-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'hub.db'));
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(version.value)).toBe(MIGRATIONS.length - 1);
    const columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all('tasks') as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(['runCount', 'consecutiveCrashes']));
    db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('project', 'Project', dir);
    db.prepare('INSERT INTO tasks (id, projectId, slug, title) VALUES (?, ?, ?, ?)').run('project/restart', 'project', 'restart', 'Restart');
    db.prepare("UPDATE tasks SET waitReason = 'restart' WHERE id = ?").run('project/restart');
    expect((db.prepare('SELECT waitReason FROM tasks WHERE id = ?').get('project/restart') as { waitReason: string }).waitReason).toBe('restart');
    db.close();
  });
});
