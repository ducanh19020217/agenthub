import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '../src/daemon.js';
import { loadConfig } from '../src/config.js';
import { FakeEngine, type Engine, canRunBubblewrap } from '../src/engines/index.js';

describe('Claude auth failure chat integration', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let previousEnv: Record<string, string | undefined>;
  const fakeClaudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');
  const fakeCodexBin = path.resolve(__dirname, 'fixtures', 'fake-codex.mjs');

  function createClaudeProfile(name: string): string {
    const home = path.join(tmpDir, 'profiles', name);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${name.toLowerCase()}@example.test` } }));
    ctx.profileRepo.upsert({ name, engine: 'claude', kind: 'isolated', home, email: `${name.toLowerCase()}@example.test`, enabled: 1, authState: 'ok' });
    return home;
  }

  function createCodexProfile(name: string): void {
    const home = path.join(tmpDir, 'profiles', name);
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ fake: true }));
    ctx.profileRepo.upsert({ name, engine: 'codex', kind: 'codex', home, email: `${name}@example.test`, enabled: 1 });
  }

  async function sendTurn(sessionId: string, text: string): Promise<void> {
    const completed = new Promise<void>((resolve, reject) => {
      const bus = ctx.scheduler.getEventBus();
      const timeout = setTimeout(() => {
        bus.off('chat.done', onDone);
        reject(new Error(`Timed out waiting for chat turn ${sessionId}`));
      }, 15_000);
      const finish = (payload?: unknown) => {
        if ((payload as { sessionId?: string })?.sessionId !== sessionId) return;
        clearTimeout(timeout);
        bus.off('chat.done', onDone);
        resolve();
      };
      const onDone = (_id?: string, payload?: unknown) => finish(payload);
      bus.on('chat.done', onDone);
    });
    await ctx.chatService.sendMessage(sessionId, text);
    await completed;
  }

  beforeEach(() => {
    previousEnv = Object.fromEntries(['AGENTHUB_HOME', 'AGENTHUB_CODEX_BIN', 'AGENTHUB_CLAUDE_BIN', 'AGENTHUB_BWRAP_BIN', 'FAKE_CLAUDE_AUTH_FAIL_HOME', 'FAKE_CLAUDE_PROFILE_LOG', 'FAKE_CLAUDE_STREAM_JSON', 'FAKE_CODEX_NO_TOOLS'].map((key) => [key, process.env[key]]));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-chat-auth-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_CODEX_BIN = fakeCodexBin;
    process.env.AGENTHUB_CLAUDE_BIN = fakeClaudeBin;
    process.env.FAKE_CLAUDE_STREAM_JSON = '';
    process.env.FAKE_CODEX_NO_TOOLS = '1';
    if (!canRunBubblewrap()) process.env.AGENTHUB_BWRAP_BIN = path.resolve(__dirname, 'fixtures', 'mock-bwrap.sh');
    const config = loadConfig(tmpDir);
    config.hubHome = tmpDir;
    config.port = 0;
    config.chat.claudeBin = fakeClaudeBin;
    config.brain.codexModel = 'gpt-5.6-luna';
    const fakeAgy = new FakeEngine(path.resolve(__dirname, 'fixtures', 'fake-agent.mjs'));
    ctx = createContext(config, new Map<string, Engine>([['agy', fakeAgy]]));
    ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
    ctx.chatService.setCodexBinOverride(fakeCodexBin);
  });

  afterEach(() => {
    ctx.service.shutdownForUser('test_cleanup');
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('marks one auth expiry, retries the brain turn on fake Codex, and routes later turns to fallback', async () => {
    const home = createClaudeProfile('NCS');
    createCodexProfile('codex-auth');
    ctx.config.brain.engine = 'claude';
    ctx.config.brain.claudeProfile = 'NCS';
    ctx.config.brain.claudeProfileExplicit = true;
    ctx.config.brain.codexProfile = 'codex-auth';
    ctx.config.brain.permissions = 'full';
    ctx.chatService.configureFailoverSteps([{ type: 'engine', engine: 'codex' }]);
    process.env.FAKE_CLAUDE_AUTH_FAIL_HOME = home;
    process.env.FAKE_CLAUDE_PROFILE_LOG = path.join(tmpDir, 'profile-uses.log');

    const sessionId = 'brain:claude-auth';
    ctx.chatSessionRepo.insert({ id: sessionId, title: 'Auth brain', model: 'sonnet', profileName: 'NCS', kind: 'brain' });
    const expired: Array<Record<string, unknown>> = [];
    const failovers: Array<Record<string, unknown>> = [];
    ctx.scheduler.getEventBus().on('profile.auth_expired', (_id, payload) => expired.push(payload as Record<string, unknown>));
    ctx.scheduler.getEventBus().on('chat.failover', (_id, payload) => failovers.push(payload as Record<string, unknown>));

    await sendTurn(sessionId, 'first failed Claude turn');
    expect(ctx.profileRepo.get('NCS'), JSON.stringify({ errors: ctx.chatMessageRepo.getBySession(sessionId).filter((message) => message.role === 'error'), profileUses: fs.readFileSync(process.env.FAKE_CLAUDE_PROFILE_LOG!, 'utf8') })).toMatchObject({ authState: 'not_logged_in', authMessage: 'Phiên đăng nhập Claude hết hạn – cần đăng nhập lại' });
    await sendTurn(sessionId, 'later brain turn');

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ name: 'NCS', loginCommand: `CLAUDE_CONFIG_DIR=${home} claude /login` });
    expect(failovers).toHaveLength(1);
    expect(failovers[0]).toMatchObject({ reason: 'claude_auth_expired', toEngine: 'codex' });
    expect(ctx.chatService.getLastEngine(sessionId)).toBe('codex');
    expect(ctx.chatMessageRepo.getBySession(sessionId).some((message) => message.role === 'assistant' && message.meta?.includes('"engine":"codex"'))).toBe(true);
  });

  it('rotates only through a configured profile step and ignores auth words in successful assistant text', async () => {
    const ncsHome = createClaudeProfile('NCS');
    const backupHome = createClaudeProfile('backup');
    ctx.config.brain.engine = 'claude';
    ctx.config.brain.claudeProfile = 'NCS';
    ctx.config.brain.claudeProfileExplicit = true;
    ctx.config.brain.permissions = 'full';
    ctx.chatService.configureFailoverSteps([{ type: 'profile', profile: 'backup' }]);
    const usageLog = path.join(tmpDir, 'profile-uses.log');
    process.env.FAKE_CLAUDE_PROFILE_LOG = usageLog;
    process.env.FAKE_CLAUDE_AUTH_FAIL_HOME = ncsHome;

    const sessionId = 'brain:claude-profile-rotation';
    ctx.chatSessionRepo.insert({ id: sessionId, title: 'Profile rotation brain', model: 'sonnet', profileName: 'NCS', kind: 'brain' });
    await sendTurn(sessionId, 'fail first profile');
    expect(ctx.profileRepo.get('NCS')?.authState).toBe('not_logged_in');
    expect(ctx.chatService.getLastEngine(sessionId)).toBe('claude');
    expect(fs.readFileSync(usageLog, 'utf8').trim().split('\n')).toEqual([ncsHome, backupHome]);

    ctx.chatService.clearClaudeFailover();
    ctx.config.brain.claudeProfile = 'backup';
    process.env.FAKE_CLAUDE_AUTH_FAIL_HOME = '';
    const successSession = 'brain:successful-auth-phrases';
    ctx.chatSessionRepo.insert({ id: successSession, title: 'Successful text brain', model: 'sonnet', profileName: 'backup', kind: 'brain' });
    await sendTurn(successSession, 'mention-auth-phrases');
    expect(ctx.profileRepo.get('backup')?.authState).toBe('ok');
  });

  it('ends with a clear error when the auth failover chain is exhausted without resolving Codex', () => {
    ctx.chatService.configureFailoverSteps([]);
    ctx.chatService['failoverState'].activateAuthExpired('NCS');
    const planned = ctx.chatService['failoverExecution']({
      sessionId: 'brain:empty-auth-chain', messageId: 'empty-chain', text: 'hello', model: 'sonnet', profileName: 'NCS', mode: 'safe',
    });
    expect(planned.error).toMatch(/fallback steps were exhausted/);
    expect(planned.engine).not.toBe('codex');
  });
});
