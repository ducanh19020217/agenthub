import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { FastifyInstance } from 'fastify';
import { createContext, DaemonContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { getOrCreateToken } from '../src/auth.js';
import { effectiveBrainEngine } from '../src/brain/engine.js';
import { resolveCodexProfile } from '../src/profiles/index.js';
import { CodexEngine, canRunBubblewrap } from '../src/engines/index.js';

function initGitRepo(repoPath: string, branch = 'main'): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'AgentHub Test'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial Repo\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
  execFileSync('git', ['checkout', '-B', branch], { cwd: repoPath });
}

describe('Brain Codex Engine Integration and Failover', () => {
  let tmpDir: string;
  let ctx: DaemonContext;
  let server: FastifyInstance;
  let port: number;
  const fakeCodexBin = path.resolve(__dirname, 'fixtures', 'fake-codex.mjs');

  function createCodexProfile(name: string): string {
    const homeDir = path.join(tmpDir, 'profiles', name);
    const codexDir = path.join(homeDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ token: 'fake' }));
    ctx.profileRepo.upsert({ name, engine: 'codex', kind: 'codex', home: homeDir, email: `${name}@example.com`, enabled: 1 });
    return homeDir;
  }

  let prevBwrap: string | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-brain-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_CODEX_BIN = fakeCodexBin;
    prevBwrap = process.env.AGENTHUB_BWRAP_BIN;
    if (!canRunBubblewrap()) {
      process.env.AGENTHUB_BWRAP_BIN = path.resolve(__dirname, 'fixtures', 'mock-bwrap.sh');
    }

    const tokenPath = path.join(tmpDir, 'token');
    getOrCreateToken(tokenPath);

    const config = loadConfig(tmpDir);
    config.hubHome = tmpDir;
    config.chat.claudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');
    ctx = createContext(config);
    ctx.chatService.setCodexBinOverride(fakeCodexBin);
    ctx.chatService.setClaudeBinOverride(path.resolve(__dirname, 'fixtures', 'fake-claude.mjs'));

    server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    port = addr.port;
    ctx.config.port = port;
    process.env.AGENTHUB_PORT = String(port);
  });

  afterEach(async () => {
    delete process.env.AGENTHUB_CODEX_BIN;
    delete process.env.FAKE_CODEX_QUOTA;
    delete process.env.FAKE_CLAUDE_STREAM_JSON;
    if (prevBwrap === undefined) delete process.env.AGENTHUB_BWRAP_BIN;
    else process.env.AGENTHUB_BWRAP_BIN = prevBwrap;
    await server.close();
    ctx.scheduler.stop();
    ctx.chatService.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Engine & Profile Resolution Unit Tests', () => {
    it('resolves engine according to project setting then global', () => {
      expect(effectiveBrainEngine(null, { engine: 'claude' })).toBe('claude');
      expect(effectiveBrainEngine(null, { engine: 'codex' })).toBe('codex');
      expect(effectiveBrainEngine({ settings: JSON.stringify({ brain: { engine: 'inherit' } }) }, { engine: 'codex' })).toBe('codex');
      expect(effectiveBrainEngine({ settings: JSON.stringify({ brain: { engine: 'claude' } }) }, { engine: 'codex' })).toBe('claude');
      expect(effectiveBrainEngine({ settings: JSON.stringify({ brain: { engine: 'codex' } }) }, { engine: 'claude' })).toBe('codex');
    });

    it('resolves codex profile by quota remaining percentage among unexhausted profiles', () => {
      createCodexProfile('codex-a');
      createCodexProfile('codex-b');

      ctx.usageRepo.upsert({ profileName: 'codex-a', grp: 'codex', window: '5h', remainingPct: 30, resetAt: 1000, fetchedAt: 1000 });
      ctx.usageRepo.upsert({ profileName: 'codex-b', grp: 'codex', window: '5h', remainingPct: 85, resetAt: 1000, fetchedAt: 1000 });

      // codex-b has higher remaining percentage (85% > 30%)
      const resolved = resolveCodexProfile(ctx.profileRepo, undefined, ctx.usageRepo, ctx.quotaMarkRepo);
      expect(resolved).toBe('codex-b');

      // Explicit configuration overrides auto selection
      const explicit = resolveCodexProfile(ctx.profileRepo, 'codex-a', ctx.usageRepo, ctx.quotaMarkRepo);
      expect(explicit).toBe('codex-a');

      // When codex-b is marked exhausted, codex-a is chosen
      ctx.quotaMarkRepo.mark('codex-b', 'codex', Math.floor(Date.now() / 1000) + 3600, 'quota');
      const fallback = resolveCodexProfile(ctx.profileRepo, undefined, ctx.usageRepo, ctx.quotaMarkRepo);
      expect(fallback).toBe('codex-a');
    });

    it('maps permission modes correctly to sandbox flags in CodexEngine', () => {
      const engine = new CodexEngine(fakeCodexBin);
      const fullLog = path.join(tmpDir, 'test-full.log');
      const safeLog = path.join(tmpDir, 'test-safe.log');
      const profile = { name: 'codex', engine: 'codex' as const, kind: 'codex' as const, home: null, email: null, enabled: 1 };

      const procFull = engine.spawn({
        profile,
        model: 'gpt-5.6-luna',
        cwd: tmpDir,
        prompt: 'test full',
        logPath: fullLog,
        codexSandbox: 'off',
      });
      procFull.kill();

      const procSafe = engine.spawn({
        profile,
        model: 'gpt-5.6-luna',
        cwd: tmpDir,
        prompt: 'test safe',
        logPath: safeLog,
        codexSandbox: 'workspace-write',
      });
      procSafe.kill();
    });
  });

  describe('Failover Execution Tests', () => {
    it('failoverExecution uses codex when step.type is engine', () => {
      createCodexProfile('codex-1');
      ctx.chatSessionRepo.insert({ id: 'test-sess', title: 'Test', mode: 'safe', model: 'sonnet', profileName: 'claude-1', kind: 'brain' });

      // Configure failover step with engine: codex
      ctx.chatService.configureFailoverSteps([{ type: 'engine', engine: 'codex' }]);
      ctx.chatService['failoverState'].activate(3600, 'usage_limit');

      const planned = ctx.chatService['failoverExecution']({
        sessionId: 'test-sess',
        messageId: 'msg-1',
        text: 'hello',
        model: 'sonnet',
        profileName: 'claude-1',
        mode: 'safe',
      });

      expect(planned.engine).toBe('codex');
      expect(planned.profileName).toBe('codex-1');
    });

    it('falls back to claude when brain.engine=codex but no codex profile is unexhausted', () => {
      ctx.config.brain.engine = 'codex';
      ctx.chatSessionRepo.insert({ id: 'brain-codex', title: 'Brain', mode: 'safe', model: 'sonnet', profileName: 'claude-1', kind: 'brain' });

      let fallbackEmitted = false;
      ctx.scheduler.getEventBus().on('claude.fallback_changed', (_id, payload) => {
        if ((payload as { reason?: string })?.reason === 'codex_unavailable') fallbackEmitted = true;
      });

      const planned = ctx.chatService['failoverExecution']({
        sessionId: 'brain-codex',
        messageId: 'msg-1',
        text: 'hello',
        model: 'sonnet',
        profileName: 'claude-1',
        mode: 'safe',
      });

      expect(planned.engine).toBe('claude');
      expect(fallbackEmitted).toBe(true);
    });
  });

  describe('Integration with Fake Codex CLI', () => {
    it('fails over a Claude quota error to the configured Codex profile without waiting', async () => {
      createCodexProfile('codex-failover');
      ctx.config.brain.engine = 'claude';
      ctx.config.brain.codexProfile = 'codex-failover';
      ctx.chatService.configureFailoverSteps([{ type: 'engine', engine: 'codex' }]);

      const sessionId = 'brain:global-failover';
      ctx.chatSessionRepo.insert({ id: sessionId, title: 'Brain', mode: 'safe', model: 'sonnet', profileName: 'claude-default', kind: 'brain' });
      const done = new Promise<void>((resolve) => {
        ctx.scheduler.getEventBus().on('chat.done', (_id, payload) => {
          if ((payload as { sessionId?: string }).sessionId === sessionId) resolve();
        });
      });

      await ctx.chatService.sendMessage(sessionId, 'quota');
      await done;

      expect(ctx.chatService.getLastEngine(sessionId)).toBe('codex');
      expect(ctx.chatSessionRepo.get(sessionId)?.state).toBe('idle');
      expect(ctx.chatMessageRepo.getBySession(sessionId).some((message) => message.role === 'assistant' && message.meta?.includes('"engine":"codex"'))).toBe(true);
    });

    it('does not loop when Codex is unavailable after Claude quota exhaustion', async () => {
      createCodexProfile('codex-unavailable');
      ctx.config.brain.codexProfile = 'codex-unavailable';
      ctx.chatService.configureFailoverSteps([{ type: 'engine', engine: 'codex' }]);
      process.env.FAKE_CODEX_QUOTA = '1';
      const sessionId = 'brain:codex-unavailable';
      ctx.chatSessionRepo.insert({ id: sessionId, title: 'Brain', mode: 'safe', model: 'sonnet', profileName: 'claude-default', kind: 'brain' });
      const error = new Promise<Record<string, unknown>>((resolve) => {
        ctx.scheduler.getEventBus().on('chat.error', (_id, payload) => {
          if ((payload as { sessionId?: string }).sessionId === sessionId) resolve(payload as Record<string, unknown>);
        });
      });

      await ctx.chatService.sendMessage(sessionId, 'quota');
      const payload = await error;

      expect(payload.message).toContain('Codex hiện không khả dụng');
      expect(ctx.chatSessionRepo.get(sessionId)?.state).toBe('waiting_limit');
      expect(ctx.chatService.getLastEngine(sessionId)).toBe('codex');
    });

    it('fails over a persistent Claude quota error to Codex without losing the turn', async () => {
      const streamClaudeBin = path.join(tmpDir, 'fake-claude-stream.mjs');
      fs.symlinkSync(path.resolve(__dirname, 'fixtures', 'fake-claude.mjs'), streamClaudeBin);
      process.env.FAKE_CLAUDE_STREAM_JSON = '1';
      createCodexProfile('codex-persistent-failover');
      ctx.config.brain.engine = 'claude';
      ctx.config.brain.codexProfile = 'codex-persistent-failover';
      ctx.chatService.setClaudeBinOverride(streamClaudeBin);
      ctx.chatService.configureFailoverSteps([{ type: 'engine', engine: 'codex' }]);

      const sessionId = 'brain:persistent-failover';
      ctx.chatSessionRepo.insert({ id: sessionId, title: 'Persistent Brain', mode: 'safe', model: 'sonnet', profileName: 'claude-default', kind: 'brain' });
      const done = new Promise<void>((resolve) => {
        ctx.scheduler.getEventBus().on('chat.done', (_id, payload) => {
          if ((payload as { sessionId?: string }).sessionId === sessionId) resolve();
        });
      });

      await ctx.chatService.sendMessage(sessionId, 'quota');
      await done;

      const messages = ctx.chatMessageRepo.getBySession(sessionId);
      expect(ctx.chatService.getLastEngine(sessionId)).toBe('codex');
      expect(ctx.chatSessionRepo.get(sessionId)?.state).toBe('idle');
      expect(messages.some((message) => message.role === 'assistant' && message.meta?.includes('"engine":"codex"'))).toBe(true);
      expect(messages.filter((message) => message.role === 'error')).toHaveLength(0);
    });

    it('keeps a department Brain on its pinned Codex profile when global Brain uses Claude', () => {
      createCodexProfile('codex-department');
      ctx.config.brain.engine = 'claude';
      ctx.chatSessionRepo.insert({ id: 'brain:department:eng', title: 'Department Brain', mode: 'safe', model: 'gpt-5.6-luna', profileName: 'codex-department', kind: 'brain' });

      const planned = ctx.chatService['failoverExecution']({
        sessionId: 'brain:department:eng', messageId: 'msg-dept', text: 'hello', model: 'gpt-5.6-luna', profileName: 'codex-department', mode: 'safe',
      });

      expect(planned).toMatchObject({ engine: 'codex', profileName: 'codex-department' });
    });

    it('executes a brain turn with Codex, calls hub_review and creates session config.toml with mode 0600', async () => {
      createCodexProfile('codex-worker');
      ctx.config.brain.engine = 'codex';

      // Setup a project and task to review
      const repoDir = path.join(tmpDir, 'test-repo');
      initGitRepo(repoDir, 'main');
      ctx.service.createProject({
        id: 'rev-proj',
        name: 'Review Project',
        path: repoDir,
        defaultBranch: 'main',
        settings: { review: { autoMerge: true } },
      });
      ctx.service.createTask({
        project: 'rev-proj',
        slug: 'feat-codex',
        title: 'Codex Feature',
        body: 'Do something',
        level: 'easy',
        start: true,
      });
      ctx.scheduler.tick();
      const task = ctx.taskRepo.get('rev-proj/feat-codex')!;
      ctx.taskRepo.update(task.id, { status: 'review' });

      // Start a brain session with Codex
      const sessionId = 'brain:rev-proj';
      ctx.chatSessionRepo.insert({
        id: sessionId,
        title: 'Brain Rev Proj',
        mode: 'safe',
        model: 'gpt-5.6-luna',
        profileName: 'codex-worker',
        kind: 'brain',
        projectId: 'rev-proj',
      });

      const donePromise = new Promise<void>((resolve) => {
        ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
          if ((payload as { sessionId?: string })?.sessionId === sessionId) resolve();
        });
        ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => {
          if ((payload as { sessionId?: string })?.sessionId === sessionId) resolve();
        });
      });

      // Submit user turn asking to review task
      await ctx.chatService.sendMessage(sessionId, `Please hub_review ${task.id}`);

      // Wait for turn completion
      await donePromise;

      // 1. Verify per-session config.toml exists with mode 0600
      const sessionDir = path.join(tmpDir, 'sessions', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
      const configTomlPath = path.join(sessionDir, 'config.toml');
      expect(fs.existsSync(configTomlPath)).toBe(true);
      const stat = fs.statSync(configTomlPath);
      expect(stat.mode & 0o777).toBe(0o600);
      const tomlContent = fs.readFileSync(configTomlPath, 'utf8');
      expect(tomlContent).toContain('[mcp_servers.agenthub]');
      expect(tomlContent).toContain('AGENTHUB_CHAT_SESSION_ID');

      // 2. Verify messages recorded
      const messages = ctx.chatMessageRepo.getBySession(sessionId);
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const assistantMsg = messages.find((m) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toContain('thành công');
      const meta = JSON.parse(assistantMsg!.meta || '{}');
      expect(meta.engine).toBe('codex');

      // 3. Verify session token usage updated
      const updatedSession = ctx.chatSessionRepo.get(sessionId)!;
      expect(updatedSession.inputTokens).toBeGreaterThan(0);
      expect(updatedSession.outputTokens).toBeGreaterThan(0);
    });
  });
});
