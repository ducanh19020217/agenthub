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
    // hub.db*
    expect(isIgnoredHubEntry('hub.db')).toBe(true);
    expect(isIgnoredHubEntry('hub.db-wal')).toBe(true);
    expect(isIgnoredHubEntry('hub.db-shm')).toBe(true);

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
    expect(isIgnoredHubEntry('config.json')).toBe(false);
    expect(isIgnoredHubEntry('token')).toBe(false);
    expect(isIgnoredHubEntry('secrets')).toBe(false);
    expect(isIgnoredHubEntry('profiles')).toBe(false);
  });

  it('filters out ignored entries and detects unexpected additions', () => {
    const before = ['daemon.log'];
    const after = ['daemon.log', 'chat-mcp-1.json', 'hub.db-wal', 'unrecognized-file.txt'];
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
    fs.writeFileSync(path.join(tempDir, 'hub.db'), 'initial');
    const snap = getHubSnapshot(tempDir);

    // Modify existing file
    fs.writeFileSync(path.join(tempDir, 'chat-mcp-x.json'), '{"modified":true}');

    // Add new ignored files
    fs.writeFileSync(path.join(tempDir, 'hub.db-wal'), 'wal data');
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

  it('reports violation when sensitive files like config.json, token, secrets, or profiles appear', () => {
    for (const name of ['config.json', 'token', 'secrets', 'profiles']) {
      const snap = getHubSnapshot(tempDir);
      if (name === 'secrets' || name === 'profiles') {
        fs.mkdirSync(path.join(tempDir, name));
      } else {
        fs.writeFileSync(path.join(tempDir, name), '{}');
      }
      expect(() => verifyHubHomeSafety(snap)).toThrow(
        new RegExp(`SAFETY NET VIOLATION:.*${name}`),
      );
      fs.rmSync(path.join(tempDir, name), { recursive: true, force: true });
    }
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
