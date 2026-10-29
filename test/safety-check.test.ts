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
    // web-staging-* / web-previous-*
    expect(isIgnoredHubEntry('web-staging-abc')).toBe(true);
    expect(isIgnoredHubEntry('web-staging-df7pHi')).toBe(true);
    expect(isIgnoredHubEntry('web-previous-1234-5678')).toBe(true);

    // Deploy runtime files and web directory
    expect(isIgnoredHubEntry('web')).toBe(true);
    expect(isIgnoredHubEntry('deploy-restart.json')).toBe(true);
    expect(isIgnoredHubEntry('deploy-push-state.json')).toBe(true);
    expect(isIgnoredHubEntry('deploy-pending-state.json')).toBe(true);

    // Sensitive entries must NEVER be ignored
    expect(isIgnoredHubEntry('config.json')).toBe(false);
    expect(isIgnoredHubEntry('token')).toBe(false);
    expect(isIgnoredHubEntry('hub.db')).toBe(false);
    expect(isIgnoredHubEntry('hub.db-wal')).toBe(false);
    expect(isIgnoredHubEntry('hub.db-shm')).toBe(false);
    expect(isIgnoredHubEntry('secrets')).toBe(false);
    expect(isIgnoredHubEntry('profiles')).toBe(false);

    // unexpected entries and entries outside minimal allowlist
    expect(isIgnoredHubEntry('unknown.txt')).toBe(false);
    expect(isIgnoredHubEntry('chat-mcp.json')).toBe(false);
    expect(isIgnoredHubEntry('chat-mcp.txt')).toBe(false);
    expect(isIgnoredHubEntry('unexpected-dir')).toBe(false);
    expect(isIgnoredHubEntry('web-other')).toBe(false);
    expect(isIgnoredHubEntry('daemon.log')).toBe(false);
    expect(isIgnoredHubEntry('claude-failover.json')).toBe(false);
    expect(isIgnoredHubEntry('logs')).toBe(false);
    expect(isIgnoredHubEntry('worktrees')).toBe(false);
    expect(isIgnoredHubEntry('cache')).toBe(false);
    expect(isIgnoredHubEntry('foo.tmp')).toBe(false);
  });

  it('filters out ignored entries and detects unexpected additions', () => {
    const before = ['web'];
    const after = ['web', 'web-staging-test', 'deploy-restart.json', 'hub.db-wal', 'unrecognized-file.txt'];
    // hub.db-wal is NOT ignored (sensitive), so it shows as unexpected
    expect(findUnexpectedHubEntries(before, after)).toEqual(['hub.db-wal', 'unrecognized-file.txt']);
  });

  it('reports violation when a new entry has an unexpected name', () => {
    fs.mkdirSync(path.join(tempDir, 'web'));
    const snap = getHubSnapshot(tempDir);

    fs.writeFileSync(path.join(tempDir, 'suspicious-file.txt'), 'content');

    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*suspicious-file\.txt/,
    );
  });

  it('does not report violation when allowlisted runtime entries are added or modified', () => {
    fs.writeFileSync(path.join(tempDir, 'deploy-restart.json'), '{"initial":true}');
    fs.mkdirSync(path.join(tempDir, 'web'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'web', 'index.html'), 'initial');
    const snap = getHubSnapshot(tempDir);

    // Modify existing allowlisted files
    fs.writeFileSync(path.join(tempDir, 'deploy-restart.json'), '{"modified":true}');
    fs.writeFileSync(path.join(tempDir, 'web', 'index.html'), 'modified');

    // Add new allowlisted runtime entries
    fs.writeFileSync(path.join(tempDir, 'deploy-push-state.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'deploy-pending-state.json'), '{}');
    fs.mkdirSync(path.join(tempDir, 'web-staging-abc'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'web-previous-12345'), { recursive: true });

    expect(() => verifyHubHomeSafety(snap)).not.toThrow();
  });

  it('allows web-staging-abc and web-previous additions without error, but reports unexpected directories', () => {
    fs.writeFileSync(path.join(tempDir, 'deploy-restart.json'), 'initial');
    const snap = getHubSnapshot(tempDir);

    fs.mkdirSync(path.join(tempDir, 'web-staging-abc'));
    fs.mkdirSync(path.join(tempDir, 'web-previous-9999'));
    expect(() => verifyHubHomeSafety(snap)).not.toThrow();

    fs.mkdirSync(path.join(tempDir, 'unexpected-dir'));
    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*unexpected-dir/,
    );
  });

  it('reports violation when sensitive files are created during test', () => {
    for (const name of ['config.json', 'token', 'hub.db', 'secrets', 'profiles']) {
      const snap = getHubSnapshot(tempDir);
      if (name === 'secrets' || name === 'profiles') {
        fs.mkdirSync(path.join(tempDir, name));
      } else {
        fs.writeFileSync(path.join(tempDir, name), '{}');
      }
      expect(() => verifyHubHomeSafety(snap)).toThrow(
        /SAFETY NET VIOLATION/,
      );
      fs.rmSync(path.join(tempDir, name), { recursive: true, force: true });
    }
  });

  it('reports violation when existing sensitive files are modified during test', () => {
    // Pre-populate sensitive files
    fs.writeFileSync(path.join(tempDir, 'config.json'), '{"original":true}');
    fs.writeFileSync(path.join(tempDir, 'token'), 'original-token');
    fs.writeFileSync(path.join(tempDir, 'hub.db'), 'original-db');
    fs.mkdirSync(path.join(tempDir, 'secrets'));
    fs.writeFileSync(path.join(tempDir, 'secrets', 'key.pem'), 'original');
    fs.mkdirSync(path.join(tempDir, 'profiles'));
    fs.writeFileSync(path.join(tempDir, 'profiles', 'default.json'), '{}');
    const snap = getHubSnapshot(tempDir);

    // Modify config.json
    fs.writeFileSync(path.join(tempDir, 'config.json'), '{"modified":true}');
    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*Sensitive entry changed: config\.json/,
    );
    // Restore
    fs.writeFileSync(path.join(tempDir, 'config.json'), '{"original":true}');

    // Modify token
    fs.writeFileSync(path.join(tempDir, 'token'), 'modified-token');
    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*Sensitive entry changed: token/,
    );
    fs.writeFileSync(path.join(tempDir, 'token'), 'original-token');

    // Modify hub.db
    fs.writeFileSync(path.join(tempDir, 'hub.db'), 'modified-db');
    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*Sensitive entry changed: hub\.db/,
    );
    fs.writeFileSync(path.join(tempDir, 'hub.db'), 'original-db');

    // Modify secrets/ contents
    fs.writeFileSync(path.join(tempDir, 'secrets', 'key.pem'), 'modified');
    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*Sensitive entry changed: secrets/,
    );
    fs.writeFileSync(path.join(tempDir, 'secrets', 'key.pem'), 'original');

    // Modify profiles/ contents
    fs.writeFileSync(path.join(tempDir, 'profiles', 'default.json'), '{"changed":true}');
    expect(() => verifyHubHomeSafety(snap)).toThrow(
      /SAFETY NET VIOLATION:.*Sensitive entry changed: profiles/,
    );
  });

  it('does not report violation when only directory mtime changes', () => {
    fs.writeFileSync(path.join(tempDir, 'deploy-restart.json'), 'initial');
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
