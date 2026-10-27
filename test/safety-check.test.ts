import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  isIgnoredHubEntry,
  findUnexpectedHubEntries,
  getHubSnapshot,
  verifyHubHomeSafety,
} from './safety-check';

describe('safety-check hub home comparison', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-safety-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('correctly classifies ignored hub entries', () => {
    // Sensitive files must NOT be ignored
    expect(isIgnoredHubEntry('hub.db')).toBe(false);
    expect(isIgnoredHubEntry('hub.db-wal')).toBe(false);
    expect(isIgnoredHubEntry('hub.db-shm')).toBe(false);
    expect(isIgnoredHubEntry('config.json')).toBe(false);
    expect(isIgnoredHubEntry('token')).toBe(false);
    expect(isIgnoredHubEntry('secrets')).toBe(false);
    expect(isIgnoredHubEntry('profiles')).toBe(false);

    // chat-mcp*.json
    expect(isIgnoredHubEntry('chat-mcp.json')).toBe(true);
    expect(isIgnoredHubEntry('chat-mcp-x.json')).toBe(true);
    expect(isIgnoredHubEntry('chat-mcp-123.json')).toBe(true);

    // Runtime state and directories written by the daemon/worker
    expect(isIgnoredHubEntry('claude-failover.json')).toBe(true);
    expect(isIgnoredHubEntry('deploy-push-state.json')).toBe(true);
    expect(isIgnoredHubEntry('deploy-pending-state.json')).toBe(true);
    expect(isIgnoredHubEntry('deploy-restart.json')).toBe(true);
    expect(isIgnoredHubEntry('daemon.log')).toBe(true);
    expect(isIgnoredHubEntry('sessions')).toBe(true);
    expect(isIgnoredHubEntry('empty-hooks')).toBe(true);
    expect(isIgnoredHubEntry('no-browser-bin')).toBe(true);

    // web-staging-* / web-previous-*
    expect(isIgnoredHubEntry('web-staging-abc')).toBe(true);
    expect(isIgnoredHubEntry('web-staging-df7pHi')).toBe(true);
    expect(isIgnoredHubEntry('web-previous-1234-5678')).toBe(true);

    // *.tmp / *.tmp-*
    expect(isIgnoredHubEntry('foo.tmp')).toBe(true);
    expect(isIgnoredHubEntry('foo.tmp-123')).toBe(true);
    expect(isIgnoredHubEntry('.tmp')).toBe(true);
    expect(isIgnoredHubEntry('.tmp-something')).toBe(true);

    // allowed directories
    const ignoredDirs = [
      'logs',
      'worktrees',
      'cache',
      'web',
      'claude-homes',
      'codex-homes',
      'claude-usage-cwd',
      'shims',
    ];
    for (const dir of ignoredDirs) {
      expect(isIgnoredHubEntry(dir)).toBe(true);
    }

    // unexpected entries
    expect(isIgnoredHubEntry('unknown.txt')).toBe(false);
    expect(isIgnoredHubEntry('chat-mcp.txt')).toBe(false);
    expect(isIgnoredHubEntry('unexpected-dir')).toBe(false);
    expect(isIgnoredHubEntry('web-other')).toBe(false);
  });

  it('filters out ignored entries and detects unexpected additions', () => {
    const before = ['daemon.log'];
    const after = ['daemon.log', 'chat-mcp-1.json', 'web-staging-test', 'unrecognized-file.txt'];
    expect(findUnexpectedHubEntries(before, after)).toEqual(['unrecognized-file.txt']);
  });

  it('reports violation when a new entry has an unexpected name', () => {
    fs.writeFileSync(path.join(tempDir, 'daemon.log'), 'initial');
    const snap = getHubSnapshot(tempDir);

    fs.writeFileSync(path.join(tempDir, 'suspicious-file.txt'), 'content');

    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*suspicious-file\.txt/,
    );
  });

  it('does not report violation when allowlisted runtime entries are added or modified', () => {
    fs.writeFileSync(path.join(tempDir, 'chat-mcp-x.json'), '{"initial":true}');
    fs.mkdirSync(path.join(tempDir, 'web'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'web', 'index.html'), 'initial web');
    const snap = getHubSnapshot(tempDir);

    // Modify existing runtime file / directory
    fs.writeFileSync(path.join(tempDir, 'chat-mcp-x.json'), '{"modified":true}');
    fs.writeFileSync(path.join(tempDir, 'web', 'index.html'), 'updated web');

    // Add new ignored files and directories
    fs.writeFileSync(path.join(tempDir, 'chat-mcp-another.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'claude-failover.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'deploy-push-state.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'deploy-pending-state.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'deploy-restart.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'atomic.tmp-123'), 'temp');
    fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'empty-hooks'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'web-staging-abc'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'web-previous-12345'), { recursive: true });

    expect(() => verifyHubHomeSafety(snap)).not.toThrow();
  });

  it('allows web-staging-abc and web-previous additions without error, but reports unexpected directories', () => {
    fs.writeFileSync(path.join(tempDir, 'daemon.log'), 'initial');
    const snap = getHubSnapshot(tempDir);

    fs.mkdirSync(path.join(tempDir, 'web-staging-abc'));
    fs.mkdirSync(path.join(tempDir, 'web-previous-9999'));
    expect(() => verifyHubHomeSafety(snap)).not.toThrow();

    fs.mkdirSync(path.join(tempDir, 'unexpected-dir'));
    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*unexpected-dir/,
    );
  });

  it('reports violation when sensitive entries like config.json, token, hub.db, secrets, or profiles are created', () => {
    const sensitiveItems = ['config.json', 'token', 'hub.db', 'secrets', 'profiles'];

    for (const item of sensitiveItems) {
      const snap = getHubSnapshot(tempDir);
      if (item === 'secrets' || item === 'profiles') {
        fs.mkdirSync(path.join(tempDir, item));
      } else {
        fs.writeFileSync(path.join(tempDir, item), 'created');
      }

      expect(() => verifyHubHomeSafety(snap)).toThrow(
        new RegExp(`SAFETY NET VIOLATION:.*${item.replace('.', '\\.')}`),
      );

      fs.rmSync(path.join(tempDir, item), { recursive: true, force: true });
    }
  });

  it('reports violation when existing sensitive files (config.json, token, hub.db) are modified', () => {
    fs.writeFileSync(path.join(tempDir, 'config.json'), '{"initial":true}');
    fs.writeFileSync(path.join(tempDir, 'token'), 'secret-token');
    fs.writeFileSync(path.join(tempDir, 'hub.db'), 'sqlite database');
    const snap = getHubSnapshot(tempDir);

    // Modify config.json
    fs.writeFileSync(path.join(tempDir, 'config.json'), '{"modified":true}');
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*config\.json/);
    fs.writeFileSync(path.join(tempDir, 'config.json'), '{"initial":true}');

    // Modify token
    fs.writeFileSync(path.join(tempDir, 'token'), 'tampered-token');
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*token/);
    fs.writeFileSync(path.join(tempDir, 'token'), 'secret-token');

    // Modify hub.db
    fs.writeFileSync(path.join(tempDir, 'hub.db'), 'tampered db');
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*hub\.db/);
  });

  it('reports violation when hub.db is corrupted or tampered even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);
    expect(snap.dbInfo?.isValid).toBe(true);

    // Tamper with hub.db content
    fs.writeFileSync(dbPath, 'corrupted non-sqlite data');

    // Even if external daemon is holding it, tampering must be caught and reported
    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*hub\.db/);
  });

  it('reports violation when hub.db sensitive tables (projects, profiles, meta) are modified', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT);
      INSERT INTO projects VALUES ('proj1', 'Project 1', '/home/user/p1');
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT, provider TEXT);
      INSERT INTO profiles VALUES ('prof1', 'Profile 1', 'codex');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Modify sensitive table 'projects'
    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO projects VALUES ('proj2', 'Project 2', '/home/user/p2')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*hub\.db sensitive tables/);
  });

  it('reports violation when a test process has hub.db open', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Modify hub.db
    const db2 = new Database(dbPath);
    db2.exec(`INSERT INTO meta VALUES ('extra', '1');`);
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: true }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*accessed by a test process/);
  });

  it('reports violation when hub.db contains test tasks pointing to temporary directories', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT, worktreePath TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Insert task pointing to agenthub-test temp dir
    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO tasks VALUES ('t1', 'p1', '/tmp/agenthub-test-run-123/wt')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*(contains test tasks|table "tasks" was modified)/);
  });

  it('reports violation when valid event (e.g. heartbeat) is inserted because write source cannot be proven even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT);
      INSERT INTO projects VALUES ('p1', 'Project 1', '/home/user/p1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT, worktreePath TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Test attempts to insert a valid event like heartbeat while daemon holds DB
    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO events (type, payload) VALUES ('heartbeat', '{}')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*events table was modified.*cannot be proven/);
  });

  it('allows legitimate external daemon background activity on events when genuinely attributed to daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT);
      INSERT INTO projects VALUES ('p1', 'Project 1', '/home/user/p1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT, worktreePath TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Genuine external daemon logs heartbeat
    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO events (type, payload) VALUES ('heartbeat', '{}')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false, daemonAttributed: true }),
      }),
    ).not.toThrow();
  });

  it('reports violation when a non-sensitive table (e.g. tasks) is modified even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT);
      INSERT INTO projects VALUES ('p1', 'Project 1', '/home/user/p1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT, worktreePath TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Modify non-sensitive table 'tasks' with normal (non-test) path
    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO tasks VALUES ('t-normal', 'p1', '/home/user/normal-project')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*table "tasks" was modified/);
  });

  it('reports violation when events table receives unauthorized event type even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO events (type, payload) VALUES ('unauthorized_test_event', '{}')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*events table contains unauthorized event type/);
  });

  it('reports violation when existing events are tampered or deleted even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      INSERT INTO events (id, type, payload) VALUES (1, 'heartbeat', '{}');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("UPDATE events SET type = 'brain.updated' WHERE id = 1").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*existing events were modified/);
  });

  it('reports violation when event references unexpected or test task even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, taskId TEXT, payload TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT, worktreePath TEXT);
      INSERT INTO tasks VALUES ('task-valid', 'p1', '/home/user/p1');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO events (type, taskId, payload) VALUES ('heartbeat', 'agenthub-test-task-1', '{}')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*events table contains unexpected task reference/);
  });

  it('reports violation when brain_turns is modified even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE brain_turns (id TEXT PRIMARY KEY, sessionId TEXT, status TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO brain_turns VALUES ('turn-1', 'session-1', 'done')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*table "brain_turns" was modified/);
  });

  it('reports violation when claude_sessions references test cwd even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_sessions (sessionId TEXT PRIMARY KEY, cwd TEXT, title TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO claude_sessions VALUES ('sess-1', '/tmp/agenthub-test-run/project', 'Session 1')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*claude_sessions/);
  });

  it('reports violation when claude_sessions is modified with normal path or cwd even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_sessions (sessionId TEXT PRIMARY KEY, cwd TEXT, title TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO claude_sessions VALUES ('sess-normal', '/home/user/my-project', 'Normal Session')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*table "claude_sessions" was modified/);
  });

  it('reports violation when claude_scan_state references test path even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_scan_state (path TEXT PRIMARY KEY, inode INTEGER, size INTEGER, offset INTEGER, mtime INTEGER, turnId TEXT, turnTasks TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO claude_scan_state VALUES ('/tmp/test.jsonl', 1, 10, 10, 1000, '', '[]')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*claude_scan_state/);
  });

  it('reports violation when claude_scan_state is modified with normal path even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_scan_state (path TEXT PRIMARY KEY, inode INTEGER, size INTEGER, offset INTEGER, mtime INTEGER, turnId TEXT, turnTasks TEXT);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO claude_scan_state VALUES ('/home/user/project/chat.jsonl', 1, 10, 10, 1000, '', '[]')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*table "claude_scan_state" was modified/);
  });

  it('reports violation when quota_marks is modified (even with valid profile and increased until) even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT, provider TEXT);
      INSERT INTO profiles VALUES ('prof1', 'prof1', 'claude');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE quota_marks (profileName TEXT, family TEXT, until INTEGER, reason TEXT);
      INSERT INTO quota_marks VALUES ('prof1', 'claude', 1000, 'initial');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("UPDATE quota_marks SET until = 2000 WHERE profileName = 'prof1'").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*table "quota_marks" was modified/);
  });

  it('reports violation when claude_usage is modified (even without test markers) even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_usage (sessionId TEXT, messageId TEXT, turnId TEXT);
      INSERT INTO claude_usage VALUES ('sess-init', 'msg-init', 'turn-init');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO claude_usage VALUES ('sess-new', 'msg-new', 'turn-new')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*table "claude_usage" was modified/);
  });

  it('reports violation when claude_task_usage is modified (even without test markers) even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT, worktreePath TEXT);
      INSERT INTO tasks VALUES ('task-valid', 'p1', '/home/user/p1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_task_usage (taskId TEXT, sessionId TEXT, turnId TEXT);
      INSERT INTO claude_task_usage VALUES ('task-valid', 'sess-init', 'turn-init');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("INSERT INTO claude_task_usage VALUES ('task-valid', 'sess-new', 'turn-new')").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*table "claude_task_usage" was modified/);
  });

  it('reports violation when existing quota_usage record is modified even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE quota_usage (profileName TEXT, grp TEXT, window TEXT, remainingPct INTEGER, resetAt INTEGER, fetchedAt INTEGER);
      INSERT INTO quota_usage VALUES ('prof1', 'grp1', '5h', 100, 1000, 1000);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("UPDATE quota_usage SET remainingPct = 50 WHERE profileName = 'prof1'").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*quota_usage.*modified/);
  });

  it('reports violation when claude_quota record with id=1 is modified even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_quota (id INTEGER PRIMARY KEY, status TEXT, resetsAt INTEGER, rateLimitType TEXT, isUsingOverage INTEGER, observedAt TEXT);
      INSERT INTO claude_quota VALUES (1, 'allowed', 1000, 'five_hour', 0, '2026-10-27T00:00:00.000Z');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("UPDATE claude_quota SET status = 'unauthorized_test_status' WHERE id = 1").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*claude_quota/);
  });

  it('reports violation when claude_quota_profiles record is modified with invalid status even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_quota_profiles (profileName TEXT PRIMARY KEY, status TEXT, resetsAt INTEGER, rateLimitType TEXT, isUsingOverage INTEGER, observedAt TEXT);
      INSERT INTO claude_quota_profiles VALUES ('prof1', 'allowed', 1000, 'five_hour', 0, '2026-10-27T00:00:00.000Z');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    const db2 = new Database(dbPath);
    db2.prepare("UPDATE claude_quota_profiles SET status = 'unauthorized_test_status' WHERE profileName = 'prof1'").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*claude_quota_profiles/);
  });

  it('reports violation when valid-looking quota updates are made because write source cannot be proven even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_quota (id INTEGER PRIMARY KEY, status TEXT, resetsAt INTEGER, rateLimitType TEXT, isUsingOverage INTEGER, observedAt TEXT);
      INSERT INTO claude_quota VALUES (1, 'allowed', 1000, 'five_hour', 0, '2026-10-27T00:00:00.000Z');
      CREATE TABLE claude_quota_profiles (profileName TEXT PRIMARY KEY, status TEXT, resetsAt INTEGER, rateLimitType TEXT, isUsingOverage INTEGER, observedAt TEXT);
      INSERT INTO claude_quota_profiles VALUES ('prof1', 'allowed', 1000, 'five_hour', 0, '2026-10-27T00:00:00.000Z');
      CREATE TABLE quota_usage (profileName TEXT, grp TEXT, window TEXT, remainingPct INTEGER, resetAt INTEGER, fetchedAt INTEGER);
      INSERT INTO quota_usage VALUES ('prof1', 'grp1', '5h', 100, 1000, 1000);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Test attempts valid-looking quota update with advanced observedAt
    const db2 = new Database(dbPath);
    db2.prepare("UPDATE claude_quota SET observedAt = '2026-10-27T01:00:00.000Z' WHERE id = 1").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*claude_quota was modified.*cannot be proven/);
  });

  it('reports violation when valid-looking claude_quota_profiles update is made because write source cannot be proven even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_quota_profiles (profileName TEXT PRIMARY KEY, status TEXT, resetsAt INTEGER, rateLimitType TEXT, isUsingOverage INTEGER, observedAt TEXT);
      INSERT INTO claude_quota_profiles VALUES ('prof1', 'allowed', 1000, 'five_hour', 0, '2026-10-27T00:00:00.000Z');
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Test attempts valid-looking profile update with advanced observedAt
    const db2 = new Database(dbPath);
    db2.prepare("UPDATE claude_quota_profiles SET observedAt = '2026-10-27T01:00:00.000Z' WHERE profileName = 'prof1'").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*claude_quota_profiles was modified.*cannot be proven/);
  });

  it('reports violation when valid-looking quota_usage update is made because write source cannot be proven even if held by external daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE quota_usage (profileName TEXT, grp TEXT, window TEXT, remainingPct INTEGER, resetAt INTEGER, fetchedAt INTEGER);
      INSERT INTO quota_usage VALUES ('prof1', 'grp1', '5h', 100, 1000, 1000);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Test attempts valid-looking quota_usage update with advanced fetchedAt
    const db2 = new Database(dbPath);
    db2.prepare("UPDATE quota_usage SET remainingPct = 90, fetchedAt = 2000 WHERE profileName = 'prof1'").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false }),
      }),
    ).toThrow(/SAFETY NET VIOLATION:.*quota_usage was modified.*cannot be proven/);
  });

  it('allows legitimate external daemon background updates on claude_quota, claude_quota_profiles, and quota_usage when genuinely attributed to daemon', () => {
    const dbPath = path.join(tempDir, 'hub.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT, payload TEXT);
      CREATE TABLE claude_quota (id INTEGER PRIMARY KEY, status TEXT, resetsAt INTEGER, rateLimitType TEXT, isUsingOverage INTEGER, observedAt TEXT);
      INSERT INTO claude_quota VALUES (1, 'allowed', 1000, 'five_hour', 0, '2026-10-27T00:00:00.000Z');
      CREATE TABLE claude_quota_profiles (profileName TEXT PRIMARY KEY, status TEXT, resetsAt INTEGER, rateLimitType TEXT, isUsingOverage INTEGER, observedAt TEXT);
      INSERT INTO claude_quota_profiles VALUES ('prof1', 'allowed', 1000, 'five_hour', 0, '2026-10-27T00:00:00.000Z');
      CREATE TABLE quota_usage (profileName TEXT, grp TEXT, window TEXT, remainingPct INTEGER, resetAt INTEGER, fetchedAt INTEGER);
      INSERT INTO quota_usage VALUES ('prof1', 'grp1', '5h', 100, 1000, 1000);
    `);
    db.close();

    const snap = getHubSnapshot(tempDir);

    // Daemon legitimately advances observedAt and fetchedAt
    const db2 = new Database(dbPath);
    db2.prepare("UPDATE claude_quota SET observedAt = '2026-10-27T01:00:00.000Z' WHERE id = 1").run();
    db2.prepare("UPDATE claude_quota_profiles SET observedAt = '2026-10-27T01:00:00.000Z' WHERE profileName = 'prof1'").run();
    db2.prepare("UPDATE quota_usage SET remainingPct = 90, fetchedAt = 2000 WHERE profileName = 'prof1'").run();
    db2.close();

    expect(() =>
      verifyHubHomeSafety(snap, tempDir, {
        processHoldingChecker: () => ({ daemonHolding: true, testHolding: false, daemonAttributed: true }),
      }),
    ).not.toThrow();
  });

  it('reports violation when existing sensitive directories (secrets, profiles) are modified', () => {
    const secretsDir = path.join(tempDir, 'secrets');
    const profilesDir = path.join(tempDir, 'profiles');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, 'telegram.token'), 'initial-token');
    fs.writeFileSync(path.join(profilesDir, 'default.json'), '{"profile":1}');
    const snap = getHubSnapshot(tempDir);

    // Modify file inside secrets
    fs.writeFileSync(path.join(secretsDir, 'telegram.token'), 'modified-token');
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*secrets/);
    fs.writeFileSync(path.join(secretsDir, 'telegram.token'), 'initial-token');

    // Add new file inside secrets
    fs.writeFileSync(path.join(secretsDir, 'extra.key'), 'extra');
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*secrets/);
    fs.rmSync(path.join(secretsDir, 'extra.key'));

    // Delete file inside secrets
    fs.rmSync(path.join(secretsDir, 'telegram.token'));
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*secrets/);
    fs.writeFileSync(path.join(secretsDir, 'telegram.token'), 'initial-token');

    // Modify file inside profiles
    fs.writeFileSync(path.join(profilesDir, 'default.json'), '{"profile":2}');
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*profiles/);
    fs.writeFileSync(path.join(profilesDir, 'default.json'), '{"profile":1}');

    // Add new file inside profiles
    fs.writeFileSync(path.join(profilesDir, 'worker2.json'), '{}');
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*profiles/);
    fs.rmSync(path.join(profilesDir, 'worker2.json'));

    // Delete file inside profiles
    fs.rmSync(path.join(profilesDir, 'default.json'));
    expect(() => verifyHubHomeSafety(snap)).toThrow(/SAFETY NET VIOLATION:.*profiles/);
  });

  it('does not report violation when only directory mtime changes', () => {
    fs.writeFileSync(path.join(tempDir, 'daemon.log'), 'initial');
    const snap = getHubSnapshot(tempDir);

    // Explicitly modify the directory mtime
    const past = new Date(Date.now() - 100000);
    fs.utimesSync(tempDir, past, past);

    expect(() => verifyHubHomeSafety(snap)).not.toThrow();
  });

  it('reports violation when hub directory was created during test execution', () => {
    const nonExistent = path.join(tempDir, 'new-hub-dir');
    const snap = getHubSnapshot(nonExistent);
    expect(snap.exists).toBe(false);

    fs.mkdirSync(nonExistent);

    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*was created during test execution/,
    );
  });
});
