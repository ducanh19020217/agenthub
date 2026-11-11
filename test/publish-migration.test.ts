import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, ensureProjectPublishMigration } from '../src/db/index.js';
import { projectSettings } from '../src/projects/settings.js';

describe('Publish default-on migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('bật publish mặc định cho project chưa có settings hoặc chưa có publish', () => {
    // Reset meta marker to test migration logic on specific data
    db.prepare("DELETE FROM meta WHERE key = 'migration:publish_default_on'").run();

    // 1. Project with no settings
    db.prepare(
      'INSERT INTO projects (id, name, path, defaultBranch, settings) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-no-settings', 'No Settings', '/tmp/p1', 'main', null);

    // 2. Project with settings but no publish field
    db.prepare(
      'INSERT INTO projects (id, name, path, defaultBranch, settings) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-existing-settings', 'Existing Settings', '/tmp/p2', 'develop', JSON.stringify({
      brain: { mode: 'auto' },
      integration: { enabled: true, branch: 'agenthub/integration' },
    }));

    // 3. Project with explicitly disabled publish (drone-strike-online case)
    db.prepare(
      'INSERT INTO projects (id, name, path, defaultBranch, settings) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-explicit-disabled', 'Explicit Disabled', '/tmp/p3', 'main', JSON.stringify({
      publish: { enabled: false },
    }));

    // 4. Project already having publish enabled with custom remote
    db.prepare(
      'INSERT INTO projects (id, name, path, defaultBranch, settings) VALUES (?, ?, ?, ?, ?)',
    ).run('proj-already-enabled', 'Already Enabled', '/tmp/p4', 'main', JSON.stringify({
      publish: { enabled: true, remote: 'upstream' },
    }));

    const result = ensureProjectPublishMigration(db);

    expect(result.migrated).toContain('proj-no-settings');
    expect(result.migrated).toContain('proj-existing-settings');
    expect(result.migrated).not.toContain('proj-explicit-disabled');
    expect(result.migrated).not.toContain('proj-already-enabled');

    expect(result.explicitlyDisabled).toContain('proj-explicit-disabled');
    expect(result.explicitlyDisabled).not.toContain('proj-already-enabled');

    // Verify row 1
    const p1 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-no-settings') as any;
    const s1 = projectSettings(p1);
    expect(s1.publish.enabled).toBe(true);
    expect(s1.publish.remote).toBe('origin');
    expect(s1.publish.audit?.enabled).toBe(true);

    // Verify row 2 (kept existing settings + added publish)
    const p2 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-existing-settings') as any;
    const s2 = projectSettings(p2);
    expect(s2.brain.mode).toBe('auto');
    expect(s2.integration.enabled).toBe(true);
    expect(s2.publish.enabled).toBe(true);
    expect(s2.publish.remote).toBe('origin');

    // Verify row 3 (explicitly disabled kept as is)
    const p3 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-explicit-disabled') as any;
    const s3 = projectSettings(p3);
    expect(s3.publish.enabled).toBe(false);

    // Verify row 4 (custom remote kept as is)
    const p4 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-already-enabled') as any;
    const s4 = projectSettings(p4);
    expect(s4.publish.enabled).toBe(true);
    expect(s4.publish.remote).toBe('upstream');

    // Verify meta table
    const metaMigration = db.prepare("SELECT value FROM meta WHERE key = 'migration:publish_default_on'").get() as any;
    expect(metaMigration.value).toBe('1');

    const metaDisabled = db.prepare("SELECT value FROM meta WHERE key = 'migration:publish_disabled_projects'").get() as any;
    expect(JSON.parse(metaDisabled.value)).toEqual(['proj-explicit-disabled']);

    // Running again does nothing
    const secondRun = ensureProjectPublishMigration(db);
    expect(secondRun.migrated).toEqual([]);
    expect(secondRun.explicitlyDisabled).toEqual([]);
  });
});
