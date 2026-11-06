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

describe('Migration 65 on a DB at version 64 without timesheet_entries', () => {
  it('recreates the table, drops the empty leftover and finishes migrating', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mig65-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');

    // schema_version = 64, but timesheet_entries is missing and a failed migration 65 left an empty _new table.
    const legacy = new Database(dbPath);
    for (let i = 0; i <= 63; i++) legacy.exec(MIGRATIONS[i]);
    legacy.exec(`CREATE TABLE timesheet_entries_new (
      source_id TEXT NOT NULL, spent_on TEXT NOT NULL, wp_id INTEGER NOT NULL, entry_id INTEGER NOT NULL,
      hours REAL NOT NULL, raw_hours REAL, written_estimate REAL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_id, spent_on, wp_id))`);
    legacy.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '64')").run();
    legacy.close();

    const db = openDatabase(dbPath);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(version.value)).toBe(MIGRATIONS.length - 1);
    const columns = (db.prepare('SELECT name FROM pragma_table_info(?)').all('timesheet_entries') as Array<{ name: string }>).map((r) => r.name);
    expect(columns).toEqual(expect.arrayContaining(['raw_hours', 'written_estimate']));
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'timesheet_entries_new'").get()).toBeUndefined();
    db.close();
  });
});
