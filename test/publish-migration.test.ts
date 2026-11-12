import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase, ensureProjectPublishMigration, type ProjectRow } from '../src/db/index.js';
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
    const p1 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-no-settings') as ProjectRow;
    const s1 = projectSettings(p1);
    expect(s1.publish.enabled).toBe(true);
    expect(s1.publish.remote).toBe('origin');
    expect(s1.publish.audit?.enabled).toBe(true);
    expect(s1.publish.enabledAt).toBeDefined();

    // Verify row 2 (kept existing settings + added publish)
    const p2 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-existing-settings') as ProjectRow;
    const s2 = projectSettings(p2);
    expect(s2.brain.mode).toBe('auto');
    expect(s2.integration.enabled).toBe(true);
    expect(s2.publish.enabled).toBe(true);
    expect(s2.publish.remote).toBe('origin');
    expect(s2.publish.enabledAt).toBe(s1.publish.enabledAt);

    // Verify row 3 (explicitly disabled kept as is)
    const p3 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-explicit-disabled') as ProjectRow;
    const s3 = projectSettings(p3);
    expect(s3.publish.enabled).toBe(false);

    // Verify row 4 (custom remote kept as is, enabledAt populated if missing)
    const p4 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-already-enabled') as ProjectRow;
    const s4 = projectSettings(p4);
    expect(s4.publish.enabled).toBe(true);
    expect(s4.publish.remote).toBe('upstream');
    expect(s4.publish.enabledAt).toBe(s1.publish.enabledAt);

    // Verify meta table
    const metaMigration = db.prepare("SELECT value FROM meta WHERE key = 'migration:publish_default_on'").get() as { value: string };
    expect(metaMigration.value).toBe('1');

    const metaMigrationAt = db.prepare("SELECT value FROM meta WHERE key = 'migration:publish_default_on_at'").get() as { value: string };
    expect(metaMigrationAt.value).toBe(s1.publish.enabledAt);

    const metaDisabled = db.prepare("SELECT value FROM meta WHERE key = 'migration:publish_disabled_projects'").get() as { value: string };
    expect(JSON.parse(metaDisabled.value)).toEqual(['proj-explicit-disabled']);

    // Running again does nothing
    const secondRun = ensureProjectPublishMigration(db);
    expect(secondRun.migrated).toEqual([]);
    expect(secondRun.explicitlyDisabled).toEqual([]);
  });

  it('nhánh đã migrate (meta = 1): project cũ giữ enabledAt theo project.createdAt, project chưa có settings được migrate bổ sung', () => {
    // Simulate database migrated by earlier version of publish_default_on
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('migration:publish_default_on', '1')").run();
    db.prepare("DELETE FROM meta WHERE key = 'migration:publish_default_on_at'").run();

    // 1. Project already enabled in old version, created in past
    const pastCreatedAt = '2026-01-01T08:00:00.000Z';
    db.prepare(
      'INSERT INTO projects (id, name, path, defaultBranch, settings, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('proj-old-enabled', 'Old Enabled', '/tmp/p-old', 'main', JSON.stringify({
      publish: { enabled: true, remote: 'origin' },
    }), pastCreatedAt);

    // 2. Project created without settings in already-migrated database
    db.prepare(
      'INSERT INTO projects (id, name, path, defaultBranch, settings, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('proj-old-null-settings', 'Null Settings', '/tmp/p-null', 'main', null, '2026-02-01T08:00:00.000Z');

    // 3. Project with settings but missing publish field in already-migrated database
    db.prepare(
      'INSERT INTO projects (id, name, path, defaultBranch, settings, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('proj-old-no-publish', 'No Publish Field', '/tmp/p-nopub', 'main', JSON.stringify({
      brain: { mode: 'auto' },
    }), '2026-02-01T08:00:00.000Z');

    const result = ensureProjectPublishMigration(db);

    expect(result.migrated).toContain('proj-old-null-settings');
    expect(result.migrated).toContain('proj-old-no-publish');
    expect(result.migrated).not.toContain('proj-old-enabled');

    // proj-old-enabled must NOT have enabledAt set to new Date(), but project.createdAt
    const p1 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-old-enabled') as ProjectRow;
    const s1 = projectSettings(p1);
    expect(s1.publish.enabled).toBe(true);
    expect(s1.publish.enabledAt).toBe(pastCreatedAt);

    // proj-old-null-settings must have publish enabled and enabledAt populated
    const p2 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-old-null-settings') as ProjectRow;
    const s2 = projectSettings(p2);
    expect(s2.publish.enabled).toBe(true);
    expect(s2.publish.enabledAt).toBeDefined();

    // proj-old-no-publish must have publish enabled and enabledAt populated
    const p3 = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-old-no-publish') as ProjectRow;
    const s3 = projectSettings(p3);
    expect(s3.publish.enabled).toBe(true);
    expect(s3.publish.enabledAt).toBe(s2.publish.enabledAt);
  });
});
