import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '../src/daemon.js';
import { loadConfig } from '../src/config.js';

describe('Claude auth recovery', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;

  function setupExpiredProfile(recordExpiry = true) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-recovery-'));
    process.env.AGENTHUB_HOME = tmpDir;
    const config = loadConfig(tmpDir);
    config.hubHome = tmpDir;
    ctx = createContext(config);
    const home = path.join(tmpDir, 'profiles', 'NCS');
    fs.mkdirSync(home, { recursive: true });
    const credentialsPath = path.join(home, '.credentials.json');
    fs.writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-oauth-access-token' } }));
    ctx.profileRepo.upsert({ name: 'NCS', engine: 'claude', kind: 'isolated', home, email: 'ncs@example.test', enabled: 1, authState: 'not_logged_in', authMessage: 'expired' });
    if (recordExpiry) {
      ctx.scheduler.getEventBus().emit('profile.auth_expired', undefined, {
        name: 'NCS', email: 'ncs@example.test', engine: 'claude', home,
        loginCommand: `CLAUDE_CONFIG_DIR=${home} claude /login`,
      });
    }
    return { home, credentialsPath };
  }

  afterEach(() => {
    if (ctx) {
      ctx.service.shutdownForUser('test_cleanup');
      ctx.db.close();
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    ctx = undefined as unknown as ReturnType<typeof createContext>;
  });

  it('restores only after credentials change and injected OAuth verification succeeds', async () => {
    const { home, credentialsPath } = setupExpiredProfile();
    const changedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(credentialsPath, changedAt, changedAt);
    const restored: unknown[] = [];
    ctx.scheduler.getEventBus().on('profile.auth_restored', (_id, payload) => restored.push(payload));
    ctx.chatService['failoverState'].activateAuthExpired('NCS');

    await ctx.service.recheckExpiredClaudeProfiles(async () => ({ email: 'ncs@example.test' }));

    expect(ctx.profileRepo.get('NCS')).toMatchObject({ authState: 'ok', authMessage: null });
    expect(restored).toHaveLength(1);
    expect(ctx.chatService.getClaudeFailover().active).toBe(false);
    expect(home).toContain('NCS');
  });

  it('keeps the profile expired when verification fails', async () => {
    const { credentialsPath } = setupExpiredProfile();
    const changedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(credentialsPath, changedAt, changedAt);

    await ctx.service.recheckExpiredClaudeProfiles(async () => { throw new Error('fake verification failure'); });

    expect(ctx.profileRepo.get('NCS')).toMatchObject({ authState: 'not_logged_in', authMessage: 'expired' });
  });

  it('does not recover when credentials are not newer than the persisted expiry event', async () => {
    const { credentialsPath } = setupExpiredProfile();
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(credentialsPath, old, old);
    let verifications = 0;

    await ctx.service.recheckExpiredClaudeProfiles(async () => { verifications += 1; return { email: 'ncs@example.test' }; });

    expect(verifications).toBe(0);
    expect(ctx.profileRepo.get('NCS')).toMatchObject({ authState: 'not_logged_in', authMessage: 'expired' });
  });

  it('allows verification-only recovery when no persisted expiry timestamp exists', async () => {
    setupExpiredProfile(false);

    await ctx.service.recheckExpiredClaudeProfiles(async () => ({ email: 'ncs@example.test' }));

    expect(ctx.profileRepo.get('NCS')).toMatchObject({ authState: 'ok', authMessage: null });
  });
});
