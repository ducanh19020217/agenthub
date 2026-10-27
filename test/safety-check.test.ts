import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
