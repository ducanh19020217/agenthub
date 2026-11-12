import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase, ProfileRepo } from '../src/db/index.js';
import { isProfileLoggedIn, resolveClaudeProfile } from '../src/profiles/index.js';
import { claudeLoginCommand, isClaudeAuthError, markClaudeProfileAuthExpired } from '../src/profiles/auth.js';
import { ClaudeFailoverState } from '../src/chat/failover.js';

describe('Claude auth failure handling', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

  it('detects auth errors without matching ordinary successful assistant text', () => {
    expect(isClaudeAuthError('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
    expect(isClaudeAuthError('HTTP 401 authentication_error')).toBe(true);
    expect(isClaudeAuthError('The docs mention a 401 response, but the task completed successfully.')).toBe(false);
  });

  it('excludes expired profiles from login and resolution and emits only on state transition', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-auth-'));
    dirs.push(dir);
    const config = loadConfig(dir);
    const db = openDatabase(config.dbPath);
    try {
      const repo = new ProfileRepo(db);
      repo.upsert({ name: 'expired', engine: 'claude', kind: 'isolated', home: dir, email: 'expired@example.com', enabled: 1 });
      repo.upsert({ name: 'healthy', engine: 'claude', kind: 'isolated', home: dir, email: 'healthy@example.com', enabled: 1 });
      repo.updateAuthState('expired', 'not_logged_in', 'expired', null);
      const stale = repo.get('expired')!;
      expect(isProfileLoggedIn(stale)).toBe(false);
      expect(resolveClaudeProfile(repo, 'expired', true)).toBe('expired');
      expect(resolveClaudeProfile(repo, 'expired', false)).toBe('healthy');
      const events: unknown[] = [];
      const emit = (_type: string, _taskId: string | undefined, payload: unknown) => events.push(payload);
      markClaudeProfileAuthExpired(repo, emit, 'healthy');
      markClaudeProfileAuthExpired(repo, emit, 'healthy');
      expect(events).toHaveLength(1);
      expect((events[0] as { loginCommand: string }).loginCommand).toBe(`CLAUDE_CONFIG_DIR=${dir} claude /login`);
      expect(claudeLoginCommand({ kind: 'system', home: dir })).toBe('claude /login');
      expect(claudeLoginCommand({ kind: 'isolated', home: null })).toBe('claude /login');
    } finally { db.close(); }
  });

  it('keeps auth failover active without a reset time and advances through configured steps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-failover-'));
    dirs.push(dir);
    const state = new ClaudeFailoverState(path.join(dir, 'failover.json'), () => 1000, { steps: [{ type: 'profile', profile: 'backup' }, { type: 'engine', engine: 'codex' }] });
    const first = state.activateAuthExpired('expired');
    expect(first.until).toBeNull();
    expect(first.step).toEqual({ type: 'profile', profile: 'backup' });
    const next = state.advance('claude_auth_expired');
    expect(next.step).toEqual({ type: 'engine', engine: 'codex' });
    expect(next.until).toBeNull();
  });
});
