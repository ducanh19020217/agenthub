import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { buildBrainPrompt, buildClaudeArgs, buildHubSnapshot, checkClaudePartialSupport, checkClaudeStreamJsonSupport, clearPartialSupportCache, ensureChatMcpConfig, findClaudeBin, readHubSnapshotFiles } from '../src/chat/claude.js';
import { parseStreamJsonLine, formatToolSummary, StreamChunkParser } from '../src/chat/parse.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeClaudeLog: string;
const fakeClaudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

function authHeaders() {
  return {
    host: '127.0.0.1:7792',
    authorization: `Bearer ${token}`,
  };
}

describe('AgentHub Chat Backend API (t-chat-api)', () => {
  it('builds a bounded hub snapshot without exposing full email and appends it to Claude args', () => {
    const snapshot = buildHubSnapshot({
      projects: [{ id: 'p', name: 'Demo', path: '/tmp/demo', defaultBranch: 'main' }],
      tasks: [{ id: 'p/t', projectId: 'p', title: 'Running task', status: 'running' }],
      runs: [{ taskId: 'p/t', model: 'gemini-3.8-flash-high', outcome: null }],
      profiles: [{ name: 'g1', engine: 'agy', email: 'ducanh@example.com', authState: 'ok' }],
      quotaUsage: [{ profileName: 'g1', grp: 'gemini', window: '5h', remainingPct: 72 }],
      quotaMarks: [],
      currentProject: { id: 'p', path: '/tmp/demo' },
      memory: '## Durable context\nDo not expose secrets.',
      planHeadings: ['## Architecture'],
      gitLog: ['abc1234 recent commit'],
      capturedAt: '2026-10-16T00:00:00.000Z',
    });
    expect(snapshot).toContain('g1 · agy · du***@example.com');
    expect(snapshot).not.toContain('ducanh@example.com');
    expect(snapshot).toContain('p/t Running task (running, gemini-3.8-flash-high)');
    expect(snapshot.length).toBeLessThanOrEqual(9000);
    const args = buildClaudeArgs({ mcpConfigPath: '/tmp/mcp.json', hubSnapshot: snapshot });
    expect(args).toContain(buildBrainPrompt());
    expect(args).toContain(snapshot);
  });

  it('does not include disabled profiles in the brain snapshot', () => {
    const snapshot = buildHubSnapshot({
      projects: [], tasks: [], profiles: [
        { name: 'active', engine: 'agy', email: null, enabled: 1 },
        { name: 'disabled', engine: 'agy', email: null, enabled: 0 },
      ], quotaUsage: [], quotaMarks: [], capturedAt: '2026-10-16T00:00:00.000Z',
    });
    expect(snapshot).toContain('active');
    expect(snapshot).not.toContain('disabled');
  });

  it('sends only changed hub snapshot lines after the first snapshot', () => {
    ctx.chatSessionRepo.insert({ id: 'brain-delta', title: 'Brain', kind: 'brain' });
    const session = ctx.chatSessionRepo.get('brain-delta')!;
    const chatWithSnapshot = ctx.chatService as unknown as { hubSnapshot: (session: typeof session, refresh?: boolean) => string };
    const first = chatWithSnapshot.hubSnapshot(session);
    ctx.scheduler.getEventBus().emit('task.failed', 'p/new');
    const delta = chatWithSnapshot.hubSnapshot(session, true);
    expect(first).toContain('ẢNH CHỤP HUB');
    expect(delta).toContain('ẢNH CHỤP HUB — PHẦN THAY ĐỔI');
    expect(delta).toContain('task.failed p/new');
    expect(delta).not.toContain('Projects:\n');
  });

  it('builds a private MCP config scoped to the chat session', () => {
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-'));
    try {
      const configPath = ensureChatMcpConfig(hubHome, 'session/one', 7792, 12);
      expect(path.basename(configPath)).toBe('chat-mcp-session_one.json');
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { mcpServers: { agenthub: { env: Record<string, string> } } };
      expect(config.mcpServers.agenthub.env).toEqual({
        AGENTHUB_CHAT_SESSION_ID: 'session/one',
        AGENTHUB_PORT: '7792',
        AGENTHUB_PERMISSION_TIMEOUT_SEC: '12',
      });
    } finally {
      fs.rmSync(hubHome, { recursive: true, force: true });
    }
  });

  it('prefers configured Claude binary and otherwise safely falls back to PATH', () => {
    expect(findClaudeBin('/does/not/exist')).not.toBe('/does/not/exist');
  });

  it('encodes project path by replacing all non-alphanumeric chars with hyphens when reading memory', () => {
    const checkedPaths: string[] = [];
    const mockFs = {
      existsSync(p: string) {
        checkedPaths.push(p);
        return p.endsWith('MEMORY.md');
      },
      readFileSync(p: string) {
        if (p.endsWith('MEMORY.md')) return 'Project memory notes';
        return '';
      },
    };

    const home = '/fake/home';
    const projectPath = '/media/disk/Projects/sample-app';
    const result = readHubSnapshotFiles(projectPath, home, mockFs);

    const expectedMemoryPath = path.join(home, '.claude', 'projects', '-media-disk-Projects-sample-app', 'memory', 'MEMORY.md');
    expect(checkedPaths).toContain(expectedMemoryPath);
    expect(result.memory).toBe('Project memory notes');
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-chat-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    fakeClaudeLog = path.join(tmpDir, 'fake-claude.log');
    process.env.FAKE_CLAUDE_LOG = fakeClaudeLog;

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    process.env.AGENTHUB_CLAUDE_BIN = fakeClaudeBin;

    const webDir = path.join(tmpDir, 'web');
    fs.mkdirSync(webDir, { recursive: true });
    process.env.AGENTHUB_WEB_DIR = webDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 7792;
    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx.chatService.stop();
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_LOG;
    delete process.env.FAKE_CLAUDE_STREAM_JSON;
    clearPartialSupportCache();
    delete process.env.FAKE_QUOTA_ONCE_FILE;
  });

  it('unit test: parse.ts handles all stream-json line types and ignores invalid lines', () => {
    // 1. init
    const initLines = parseStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-init' }));
    expect(initLines).toEqual([{ type: 'init', sessionId: 'sess-init' }]);

    // 2. assistant text
    const textLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
    );
    expect(textLines).toEqual([{ type: 'assistant_text', text: 'Hello' }]);

    // 3. assistant tool_use
    const toolLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Read',
              input: { file_path: 'docs/PLAN.md' },
            },
          ],
        },
      }),
    );
    expect(toolLines).toEqual([
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Read',
        input: { file_path: 'docs/PLAN.md' },
        summary: 'Read docs/PLAN.md',
      },
    ]);

    // 4. stream_event partial
    const streamLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial ' },
        },
      }),
    );
    expect(streamLines).toEqual([{ type: 'text_delta', text: 'partial ' }]);

    // 5. result
    const resultLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-123',
        total_cost_usd: 0.05,
        duration_ms: 1234,
        num_turns: 3,
        is_error: false,
        result: 'Done text',
      }),
    );
    expect(resultLines).toEqual([
      {
        type: 'result',
        sessionId: 'sess-123',
        costUsd: 0.05,
        durationMs: 1234,
        numTurns: 3,
        isError: false,
        result: 'Done text',
      },
    ]);

    // 2b. assistant with usage and prompt caching
    const assistantWithUsage = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Cached answer' }],
          usage: {
            input_tokens: 20,
            output_tokens: 15,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
          },
        },
      }),
    );
    expect(assistantWithUsage).toEqual([
      {
        type: 'assistant_text',
        text: 'Cached answer',
        usage: {
          inputTokens: 20,
          outputTokens: 15,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 100,
          contextTokens: 420,
        },
      },
    ]);

    // 5b. result with usage
    const resultWithUsage = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-usage',
        is_error: false,
        usage: {
          input_tokens: 150,
          output_tokens: 35,
        },
      }),
    );
    expect(resultWithUsage).toEqual([
      {
        type: 'result',
        sessionId: 'sess-usage',
        isError: false,
        usage: {
          inputTokens: 150,
          outputTokens: 35,
        },
      },
    ]);

    // 5c. result with cache fields sums 3 types of input tokens
    const resultWithCache = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-cache',
        is_error: false,
        usage: {
          input_tokens: 50,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 150,
          output_tokens: 30,
        },
      }),
    );
    expect(resultWithCache).toEqual([
      {
        type: 'result',
        sessionId: 'sess-cache',
        isError: false,
        usage: {
          inputTokens: 600, // 50 + 400 + 150
          outputTokens: 30,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 150,
        },
      },
    ]);

    // 6. corrupt lines and empty lines
    expect(parseStreamJsonLine('')).toEqual([]);
    expect(parseStreamJsonLine('   ')).toEqual([]);
    expect(parseStreamJsonLine('not a json line')).toEqual([]);
    expect(parseStreamJsonLine('{"invalid": "schema"}')).toEqual([]);

    // 7. formatToolSummary
    expect(formatToolSummary('hub_status')).toBe('hub_status');
    expect(formatToolSummary('Bash', { command: 'git status' })).toBe('Bash git status');
    expect(formatToolSummary('Grep', { pattern: 'hub_' })).toBe('Grep hub_');
    expect(formatToolSummary('Read', { file_path: 'docs/PLAN.md' })).toBe('Read docs/PLAN.md');
    expect(formatToolSummary('LS', { path: 'src/' })).toBe('LS src/');

    // 8. StreamChunkParser chunk buffering
    const chunkParser = new StreamChunkParser();
    const part1 = '{"type":"system","subtype":"init",';
    const part2 = '"session_id":"s1"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n';
    const ev1 = chunkParser.feed(part1);
    expect(ev1).toEqual([]);
    const ev2 = chunkParser.feed(part2);
    expect(ev2).toHaveLength(2);
    expect(ev2[0]).toEqual({ type: 'init', sessionId: 's1' });
    expect(ev2[1]).toEqual({ type: 'assistant_text', text: 'A' });
  });

  it('manages sessions: CRUD and rejects full mode when config is disabled', async () => {
    // 1. Initial sessions list is empty
    const listRes1 = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    expect(listRes1.statusCode).toBe(200);
    expect(JSON.parse(listRes1.body)).toEqual([]);

    // A client must not be able to impersonate an internal brain session.
    const forgedBrainRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'full', kind: 'brain' },
    });
    expect(forgedBrainRes.statusCode).toBe(403);

    // 2. POST /api/chat/sessions with mode 'full' -> 403 Forbidden
    const fullRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'full' },
    });
    expect(fullRes.statusCode).toBe(403);

    // 3. Enable full mode via PUT /api/config
    const putCfgRes = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: authHeaders(),
      payload: {
        chat: { allowFullMode: true },
      },
    });
    expect(putCfgRes.statusCode).toBe(200);

    // 4. POST /api/chat/sessions with mode 'full' now succeeds
    const fullRes2 = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'full', title: 'Phiên full mode' },
    });
    expect(fullRes2.statusCode).toBe(201);
    const fullSession = JSON.parse(fullRes2.body);
    expect(fullSession.mode).toBe('full');
    expect(fullSession.title).toBe('Phiên full mode');

    // 5. POST default safe mode session
    const safeRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Phiên safe mode' },
    });
    expect(safeRes.statusCode).toBe(201);
    const safeSession = JSON.parse(safeRes.body);
    expect(safeSession.mode).toBe('safe');
    expect(safeSession.title).toBe('Phiên safe mode');

    // 6. PATCH /api/chat/sessions/:id
    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${safeSession.id}`,
      headers: authHeaders(),
      payload: { title: 'Tiêu đề mới' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).title).toBe('Tiêu đề mới');

    // 7. DELETE /api/chat/sessions/:id
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${fullSession.id}`,
      headers: authHeaders(),
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).ok).toBe(true);
  });

  it('uses an existing legacy Claude system profile when no profile is configured', async () => {
    ctx.profileRepo.upsert({
      name: 'claude-may',
      engine: 'claude',
      kind: 'system',
      home: os.homedir(),
      email: null,
      enabled: 1,
    });
    config.chat.claudeProfileExplicit = false;
    config.brain.claudeProfileExplicit = false;

    const response = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Legacy Claude' },
    });

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).profileName).toBe('claude-may');
  });

  it('full streaming flow: POST message -> chat.delta -> chat.done, saves claudeSessionId and uses --resume', async () => {
    // 1. Create a session
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Trò chuyện chính' },
    });
    expect(createRes.statusCode).toBe(201);
    const session = JSON.parse(createRes.body);

    // Setup event listeners on eventBus to capture chat events
    const deltas: Array<{ sessionId: string; messageId: string; text: string }> = [];
    let doneEvent: Record<string, unknown> | null = null;

    ctx.scheduler.getEventBus().on('chat.delta', (_taskId, payload) => {
      deltas.push(payload as { sessionId: string; messageId: string; text: string });
    });
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      doneEvent = payload as Record<string, unknown>;
    });

    // 2. Send message
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Xin chào Claude!' },
    });
    expect(sendRes.statusCode).toBe(202);
    const { userMessageId, assistantMessageId } = JSON.parse(sendRes.body);
    expect(userMessageId).toBeDefined();
    expect(assistantMessageId).toBeDefined();

    // Wait until doneEvent is received and session is idle (max 10s)
    await vi.waitFor(() => {
      expect(doneEvent).not.toBeNull();
      const updatedSession = ctx.chatSessionRepo.get(session.id);
      expect(updatedSession?.claudeSessionId).toBe('sess-default-123');
      expect(updatedSession?.busy).toBe(0);
    }, { timeout: 10_000 });
    expect(doneEvent?.sessionId).toBe(session.id);
    expect(doneEvent?.messageId).toBe(assistantMessageId);
    expect(deltas.length).toBeGreaterThan(0);

    // 3. Verify messages list
    const msgRes = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
    });
    expect(msgRes.statusCode).toBe(200);
    const { messages, hasMore } = JSON.parse(msgRes.body);
    expect(hasMore).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Xin chào Claude!');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Xin chào, tôi là Claude!');

    // 4. Verify GET /api/chat/sessions returns lastMessage
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const sessionsList = JSON.parse(listRes.body);
    expect(sessionsList[0].lastMessage).toBeDefined();
    expect(sessionsList[0].lastMessage.content).toBe('Xin chào, tôi là Claude!');

    // 5. Send second turn: verify --resume is passed in argv
    let secondDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      secondDone = true;
    });

    const sendRes2 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Câu hỏi thứ 2' },
    });
    expect(sendRes2.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(secondDone).toBe(true);
      const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
      expect(logLines.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 10_000 });

    // Verify fake-claude log contains --resume
    const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
    expect(logLines.length).toBeGreaterThanOrEqual(2);
    const secondTurnInvocation = JSON.parse(logLines[logLines.length - 1]);
    expect(secondTurnInvocation.argv).toContain('--resume');
    expect(secondTurnInvocation.argv).toContain('sess-default-123');
  });

  it('validates argv for safe and full modes and BRAIN_PROMPT', async () => {
    // Safe mode session
    const safeRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'safe' },
    });
    const safeSession = JSON.parse(safeRes.body);

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${safeSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Test safe args' },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
    }, { timeout: 10_000 });

    const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
    const safeArgs = JSON.parse(logLines[0]).argv;

    expect(safeArgs).toContain('--permission-mode');
    expect(safeArgs).toContain('default');
    expect(safeArgs).toContain('--allowedTools');
    expect(safeArgs).toContain('--append-system-prompt');
    expect(safeArgs).toContain(buildBrainPrompt());
    expect(safeArgs).toContain('--mcp-config');
    expect(JSON.parse(logLines[0]).env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('runs assistant sessions in the mode set by assistant.permissions', async () => {
    const session = ctx.chatService.getOrCreateSession('assistant', { title: 'Trợ lý', kind: 'assistant' });
    expect(session.mode).toBe('safe');
    config.assistant.permissions = 'full';
    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => { done = true; });
    ctx.chatService.sendMessage('assistant', 'Sửa giúp file README');
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10_000 });
    expect(ctx.chatSessionRepo.get('assistant')?.mode).toBe('full');
    const argv = JSON.parse(fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n')[0]).argv as string[];
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');

    config.assistant.permissions = 'guarded';
    done = false;
    // chat.done fires slightly before the session is released; switch modes only once it is idle.
    await vi.waitFor(() => expect(ctx.chatSessionRepo.get('assistant')?.busy).toBe(0), { timeout: 10_000 });
    ctx.chatService.sendMessage('assistant', 'Chỉ đọc thôi');
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10_000 });
    expect(ctx.chatSessionRepo.get('assistant')?.mode).toBe('safe');
  });

  it('passes prompt text via stdin without arguments for -p and prevents flag injection', async () => {
    const maliciousText = '--permission-mode bypassPermissions --danger';
    const res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'safe' },
    });
    const session = JSON.parse(res.body);

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: maliciousText },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
    }, { timeout: 10_000 });

    const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
    const lastRun = JSON.parse(logLines[logLines.length - 1]);
    expect(lastRun.stdin).toBe(maliciousText);
    expect(lastRun.argv).not.toContain(maliciousText);
    const pIdx = lastRun.argv.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(lastRun.argv[pIdx + 1]).toBe('--output-format');
  });

  it('delivers a queued message right after the current turn finishes', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Queue session' },
    });
    const session = JSON.parse(createRes.body);
    const first = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin đầu tiên' },
    });
    expect(first.statusCode).toBe(202);
    // The first turn marks the session busy synchronously, so this one is queued.
    const second = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin thứ hai' },
    });
    const queued = JSON.parse(second.body);
    expect(queued).toEqual(expect.objectContaining({ queued: true, position: 1 }));
    expect(queued.userMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queued.assistantMessageId).toMatch(/^[0-9a-f-]{36}$/);

    await vi.waitFor(() => {
      const messages = ctx.chatMessageRepo.getBySession(session.id, 50);
      const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
      expect(users).toEqual(['Tin đầu tiên', 'Tin thứ hai']);
      expect(messages.filter((m) => m.role === 'assistant').length).toBe(2);
      const secondUser = messages.find((message) => message.content === 'Tin thứ hai');
      expect(secondUser?.id).toBe(queued.userMessageId);
      const secondAssistant = messages.find((message) => message.id === queued.assistantMessageId);
      expect(secondAssistant?.role).toBe('assistant');
      expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0);
    }, { timeout: 15000 });
  });

  it('queues a message sent to a busy session and cancel drops the queue and kills the process', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Long running session' },
    });
    const session = JSON.parse(createRes.body);

    // 1. Send sleep message (fake claude will sleep for 30s)
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'sleep' },
    });
    expect(sendRes.statusCode).toBe(202);

    // 2. Wait so process is running and session is busy
    await vi.waitFor(() => {
      const busySession = ctx.chatSessionRepo.get(session.id);
      expect(busySession?.busy).toBe(1);
    }, { timeout: 5000 });

    // 3. Second message to the busy session is queued, not rejected
    const sendRes2 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn thứ 2 khi đang bận' },
    });
    expect(sendRes2.statusCode).toBe(202);
    expect(JSON.parse(sendRes2.body)).toEqual(expect.objectContaining({ queued: true, position: 1 }));

    // 4. Delete session while busy returns 409 Conflict
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
    });
    expect(delRes.statusCode).toBe(409);

    // 5. Cancel session
    const cancelRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/cancel`,
      headers: authHeaders(),
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(JSON.parse(cancelRes.body).ok).toBe(true);

    // 6. Verify session busy is reset to 0
    await vi.waitFor(() => {
      const cancelledSession = ctx.chatSessionRepo.get(session.id);
      expect(cancelledSession?.busy).toBe(0);
    }, { timeout: 5000 });

    // 7. Now sending message succeeds
    let normalDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      normalDone = true;
    });

    const sendRes3 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn sau khi hủy' },
    });
    expect(sendRes3.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(normalDone).toBe(true);
    }, { timeout: 10_000 });
  });

  it('handles tool_use blocks, emits chat.tool, and stores role tool message', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    let toolEvent: Record<string, unknown> | null = null;
    let doneEvent: Record<string, unknown> | null = null;

    ctx.scheduler.getEventBus().on('chat.tool', (_taskId, payload) => {
      toolEvent = payload as Record<string, unknown>;
    });
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      doneEvent = payload as Record<string, unknown>;
    });

    // Send prompt with 'tool' to trigger mock tool_use
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Please use a tool' },
    });
    expect(sendRes.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(doneEvent).not.toBeNull();
    }, { timeout: 10_000 });
    expect(toolEvent).not.toBeNull();
    expect(toolEvent?.name).toBe('Read');
    expect(toolEvent?.summary).toBe('Read docs/PLAN.md');
    expect(toolEvent?.status).toBe('done');
    expect(toolEvent?.input).toEqual({ file_path: 'docs/PLAN.md' });
    expect(toolEvent?.output).toBe('PLAN output from fake Claude');
    expect(typeof toolEvent?.durationMs).toBe('number');

    // Verify messages in DB
    const msgRes = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
    });
    const { messages } = JSON.parse(msgRes.body);
    const toolMsg = messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe('Read docs/PLAN.md');
    expect(toolMsg.meta.status).toBe('done');
    expect(toolMsg.meta.output).toBe('PLAN output from fake Claude');
  });

  it('handles corrupt stdout lines gracefully', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    let doneEvent: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      doneEvent = payload as Record<string, unknown>;
    });

    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'test corrupt output' },
    });
    expect(sendRes.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(doneEvent).not.toBeNull();
    }, { timeout: 10_000 });
  });

  it('bounds tool input/output and omits secret file output', async () => {
    const createSession = async () => {
      const response = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
      return JSON.parse(response.body) as { id: string };
    };

    const largeSession = await createSession();
    let largeDone = false;
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      if ((payload as Record<string, unknown>).sessionId === largeSession.id) largeDone = true;
    });
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${largeSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'tool-large' },
    });
    await vi.waitFor(() => expect(largeDone).toBe(true), { timeout: 10_000 });
    const largeMessages = JSON.parse((await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${largeSession.id}/messages`,
      headers: authHeaders(),
    })).body).messages;
    const largeTool = largeMessages.find((message: { role: string }) => message.role === 'tool');
    expect(JSON.stringify(largeTool.meta.input).length).toBeLessThanOrEqual(4096);
    expect(largeTool.meta.output.length).toBeLessThanOrEqual(4098);
    expect(largeTool.meta.diff).toContain('- old');
    expect(largeTool.meta.diff).toContain('+ new');

    const secretSession = await createSession();
    let secretDone = false;
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      if ((payload as Record<string, unknown>).sessionId === secretSession.id) secretDone = true;
    });
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${secretSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'tool-secret' },
    });
    await vi.waitFor(() => expect(secretDone).toBe(true), { timeout: 10_000 });
    const secretMessages = JSON.parse((await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${secretSession.id}/messages`,
      headers: authHeaders(),
    })).body).messages;
    const secretTool = secretMessages.find((message: { role: string }) => message.role === 'tool');
    expect(secretTool.meta.output).toBeUndefined();
    expect(JSON.stringify(secretTool)).not.toContain('SECRET_TOKEN_VALUE');

    const secretInputSession = await createSession();
    let secretInputDone = false;
    const secretInputEvents: unknown[] = [];
    ctx.scheduler.getEventBus().on('chat.tool', (_taskId, payload) => {
      if ((payload as Record<string, unknown>).sessionId === secretInputSession.id) secretInputEvents.push(payload);
    });
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      if ((payload as Record<string, unknown>).sessionId === secretInputSession.id) secretInputDone = true;
    });
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${secretInputSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'tool-secret-input' },
    });
    await vi.waitFor(() => expect(secretInputDone).toBe(true), { timeout: 10_000 });
    const secretInputMessages = JSON.parse((await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${secretInputSession.id}/messages`,
      headers: authHeaders(),
    })).body).messages;
    const secretToolJson = JSON.stringify(secretInputMessages.filter((message: { role: string }) => message.role === 'tool'));
    expect(secretToolJson).not.toContain('SECRET_WRITE_VALUE');
    expect(secretToolJson).not.toContain('SECRET_BASH_VALUE');
    expect(secretToolJson).not.toContain('SECRET_ENV_VALUE');
    expect(secretToolJson).toContain('[đã ẩn]');
    expect(JSON.stringify(secretInputEvents)).not.toContain('SECRET_WRITE_VALUE');
    expect(JSON.stringify(secretInputEvents)).not.toContain('SECRET_BASH_VALUE');
    expect(JSON.stringify(secretInputEvents)).not.toContain('SECRET_ENV_VALUE');

    const tokenizerSession = await createSession();
    let tokenizerDone = false;
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      if ((payload as Record<string, unknown>).sessionId === tokenizerSession.id) tokenizerDone = true;
    });
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${tokenizerSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'tool-tokenizer' },
    });
    await vi.waitFor(() => expect(tokenizerDone).toBe(true), { timeout: 10_000 });
    const tokenizerMessages = JSON.parse((await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${tokenizerSession.id}/messages`,
      headers: authHeaders(),
    })).body).messages;
    expect(tokenizerMessages.find((message: { role: string }) => message.role === 'tool').meta.output).toBe('NORMAL_TOKENIZER_OUTPUT');
  });

  it('keeps multiple tool steps separate from the streaming assistant message', async () => {
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body) as { id: string };
    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      if ((payload as Record<string, unknown>).sessionId === session.id) done = true;
    });
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'tool-multi' },
    });
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10_000 });
    const messages = JSON.parse((await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
    })).body).messages;
    const tools = messages.filter((message: { role: string }) => message.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((message: { id: string }) => message.id)).size).toBe(2);
    expect(tools.map((message: { meta: { status: string } }) => message.meta.status)).toEqual(['done', 'done']);
    expect(messages.find((message: { role: string }) => message.role === 'assistant').content).toContain('Assistant text after tools.');
  });

  it('handles error result from claude and emits chat.error', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    let errorEvent: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => {
      errorEvent = payload as Record<string, unknown>;
    });

    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'test error output' },
    });
    expect(sendRes.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(errorEvent).not.toBeNull();
    }, { timeout: 10_000 });
    expect(errorEvent?.message).toBe('Rate limit exceeded');
  });

  it('reports a crashed Claude process instead of leaving the spinner running', async () => {
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body);
    const errors: unknown[] = [];
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => errors.push(payload));
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'crash' } });
    await vi.waitFor(() => expect(errors.length).toBe(1), { timeout: 5000 });
    expect(ctx.chatSessionRepo.get(session.id)?.state).toBe('error');
    expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0);
  });

  it('watchdogs a Claude process that produces no output', async () => {
    config.chat.idleTimeoutSec = 1;
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body);
    let error: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => { error = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'idle' } });
    await vi.waitFor(() => expect(error).not.toBeNull(), { timeout: 5000 });
    expect(error?.message).toContain('không có output');
  });

  it('publishes waiting_permission and supports stopping a safe-mode turn', async () => {
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { mode: 'safe' } });
    const session = JSON.parse(createRes.body);
    let permission: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.permission', (_taskId, payload) => { permission = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'permission' } });
    await vi.waitFor(() => expect(permission).not.toBeNull(), { timeout: 5000 });
    expect(ctx.chatSessionRepo.get(session.id)?.state).toBe('waiting_permission');
    const stop = await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/stop`, headers: authHeaders() });
    expect(stop.statusCode).toBe(200);
    await vi.waitFor(() => expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0), { timeout: 5000 });
  });

  it('does not fire the idle watchdog while waiting for permission', async () => {
    config.chat.idleTimeoutSec = 1;
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { mode: 'safe' } });
    const session = JSON.parse(createRes.body);
    const errors: unknown[] = [];
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => errors.push(payload));
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'permission' } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(errors).toHaveLength(0);
    expect(ctx.chatSessionRepo.get(session.id)?.state).toBe('waiting_permission');
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/stop`, headers: authHeaders() });
  });

  it('does not fire the idle watchdog while a tool result is pending', async () => {
    config.chat.idleTimeoutSec = 1;
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body);
    const errors: unknown[] = [];
    let toolSeen = false;
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => errors.push(payload));
    ctx.scheduler.getEventBus().on('chat.tool', () => { toolSeen = true; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'tool-wait' } });
    await vi.waitFor(() => expect(toolSeen).toBe(true), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(errors).toHaveLength(0);
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/stop`, headers: authHeaders() });
  });

  it('handles usage-limit errors and starts a new session when resume is invalid', async () => {
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body);
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'hello' } });
    await vi.waitFor(() => {
      const s = ctx.chatSessionRepo.get(session.id);
      expect(s?.claudeSessionId).toBe('sess-default-123');
      expect(s?.busy).toBe(0);
    }, { timeout: 15000 });
    let error: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => { error = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'resume-fail' } });
    await vi.waitFor(() => {
      expect(error).not.toBeNull();
      expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0);
    }, { timeout: 15000 });
    expect(ctx.chatSessionRepo.get(session.id)?.claudeSessionId).toBeNull();
    const messages = ctx.chatMessageRepo.getBySession(session.id);
    expect(messages.some((message) => message.content === 'Đã mở phiên mới, ngữ cảnh cũ không còn')).toBe(true);

    let quotaError: Record<string, unknown> | null = null;
    const quotaRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const quotaSession = JSON.parse(quotaRes.body);
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => { quotaError = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${quotaSession.id}/messages`, headers: authHeaders(), payload: { text: 'quota' } });
    await vi.waitFor(() => {
      expect(quotaError).not.toBeNull();
      expect(ctx.chatSessionRepo.get(quotaSession.id)?.busy).toBe(0);
    }, { timeout: 15000 });
    expect(quotaError?.message).toContain('Usage limit');
  }, 60000);

  it('persists a Claude limit retry and can send it immediately after the limit clears', async () => {
    const marker = path.join(tmpDir, 'quota-once');
    process.env.FAKE_QUOTA_ONCE_FILE = marker;
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body) as { id: string };
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'quota-once' } });
    await vi.waitFor(() => expect(ctx.chatSessionRepo.get(session.id)?.state).toBe('waiting_limit'), { timeout: 15000 });
    const pending = ctx.chatRetryRepo.getPending().find((retry) => retry.sessionId === session.id);
    expect(pending).toMatchObject({ sessionId: session.id, status: 'pending' });
    expect((await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/limit-retry/now`, headers: authHeaders() })).statusCode).toBe(200);
    await vi.waitFor(() => expect(ctx.chatSessionRepo.get(session.id)?.state).toBe('idle'), { timeout: 15000 });
    expect(ctx.chatRetryRepo.getPending()).toHaveLength(0);
    expect(ctx.chatRetryRepo.get(pending!.messageId)?.status).toBe('sent');
    expect(ctx.chatMessageRepo.getBySession(session.id).some((message) => message.role === 'assistant')).toBe(true);
  }, 60000);

  it('validates text bounds: rejects empty or > 20000 characters (400)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    // Empty text
    const emptyRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: '' },
    });
    expect(emptyRes.statusCode).toBe(400);

    // Text > 20000 chars
    const bigText = 'a'.repeat(20001);
    const bigRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: bigText },
    });
    expect(bigRes.statusCode).toBe(400);
  });

  it('daemon restart resets busy=0 for all sessions', async () => {
    // 1. Insert a session with busy=1 in DB
    ctx.chatSessionRepo.insert({
      id: 'sess-stuck',
      title: 'Stuck session',
      busy: 1,
    });
    expect(ctx.chatSessionRepo.get('sess-stuck')?.busy).toBe(1);

    // 2. Re-create context (simulating daemon restart)
    const ctx2 = createContext(config);
    expect(ctx2.chatSessionRepo.get('sess-stuck')?.busy).toBe(0);
    ctx2.db.close();
  });

  it('enforces maxConcurrent=2 and queues the third session until a slot is free', async () => {
    const r1 = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { title: 'S1' } });
    const s1 = JSON.parse(r1.body);
    const r2 = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { title: 'S2' } });
    const s2 = JSON.parse(r2.body);
    const r3 = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { title: 'S3' } });
    const s3 = JSON.parse(r3.body);

    // Start 2 turns that sleep (fills 2 concurrent slots)
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${s1.id}/messages`, headers: authHeaders(), payload: { text: 'sleep 1' } });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${s2.id}/messages`, headers: authHeaders(), payload: { text: 'sleep 2' } });

    // Wait for both turns to start and mark sessions busy
    await vi.waitFor(() => {
      expect(ctx.chatSessionRepo.get(s1.id)?.busy).toBe(1);
      expect(ctx.chatSessionRepo.get(s2.id)?.busy).toBe(1);
    }, { timeout: 5000 });

    // Send 3rd message
    let s3Done = false;
    ctx.scheduler.getEventBus().on('chat.done', (_tid, payload) => {
      const p = payload as { sessionId?: string };
      if (p.sessionId === s3.id) {
        s3Done = true;
      }
    });

    const res3 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${s3.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Turn for S3' },
    });
    expect(res3.statusCode).toBe(202);

    // Verify S3 is marked busy and in queue
    const s3Row = ctx.chatSessionRepo.get(s3.id);
    expect(s3Row?.busy).toBe(1);

    // Cancel S1 to free up a slot
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${s1.id}/cancel`,
      headers: authHeaders(),
    });

    // Now S3 should execute and finish
    await vi.waitFor(() => {
      expect(s3Done).toBe(true);
    }, { timeout: 10_000 });

    // Clean up S2
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${s2.id}/cancel`,
      headers: authHeaders(),
    });
  });

  it('paginates chat sessions through the HTTP API with a stable cursor and server-side search', async () => {
    for (const [id, title] of [['page-a', 'Alpha'], ['page-b', 'Beta'], ['page-c', 'Alpha 100%']]) {
      ctx.chatSessionRepo.insert({ id, title, busy: 0 });
    }

    const first = await server.inject({ method: 'GET', url: '/api/chat/sessions?limit=2', headers: authHeaders() });
    expect(first.statusCode).toBe(200);
    const firstPage = JSON.parse(first.body) as { items: Array<{ id: string }>; total: number; nextCursor: string | null };
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(3);
    expect(firstPage.nextCursor).toBeTruthy();

    const second = await server.inject({ method: 'GET', url: `/api/chat/sessions?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`, headers: authHeaders() });
    const secondPage = JSON.parse(second.body) as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(3);

    const search = await server.inject({ method: 'GET', url: '/api/chat/sessions?limit=20&search=100%25', headers: authHeaders() });
    expect(JSON.parse(search.body).items.map((item: { id: string }) => item.id)).toEqual(['page-c']);
  });

  it('supports cursor pagination for messages with default limit 50 and hasMore flag', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Pagination Test' },
    });
    const session = JSON.parse(sRes.body);

    // Insert 60 messages directly via repo to test pagination
    for (let i = 1; i <= 60; i++) {
      const msgId = `msg-${String(i).padStart(3, '0')}`;
      ctx.chatMessageRepo.insert({
        id: msgId,
        sessionId: session.id,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Tin nhắn số ${i}`,
      });
    }

    // 1. Default request (no before, default limit = 50)
    // Should return 50 newest messages (messages 11 to 60) and hasMore = true
    const p1Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
    });
    expect(p1Res.statusCode).toBe(200);
    const p1 = JSON.parse(p1Res.body);
    expect(p1.hasMore).toBe(true);
    expect(p1.messages).toHaveLength(50);
    expect(p1.messages[0].id).toBe('msg-011');
    expect(p1.messages[49].id).toBe('msg-060');

    // 2. Fetch older messages with before = msg-011 and default limit 50
    // Should return remaining 10 messages (messages 1 to 10) and hasMore = false
    const p2Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages?before=msg-011`,
      headers: authHeaders(),
    });
    expect(p2Res.statusCode).toBe(200);
    const p2 = JSON.parse(p2Res.body);
    expect(p2.hasMore).toBe(false);
    expect(p2.messages).toHaveLength(10);
    expect(p2.messages[0].id).toBe('msg-001');
    expect(p2.messages[9].id).toBe('msg-010');

    // 3. Custom limit: ?limit=5
    const p3Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages?limit=5`,
      headers: authHeaders(),
    });
    expect(p3Res.statusCode).toBe(200);
    const p3 = JSON.parse(p3Res.body);
    expect(p3.hasMore).toBe(true);
    expect(p3.messages).toHaveLength(5);
    expect(p3.messages[0].id).toBe('msg-056');
    expect(p3.messages[4].id).toBe('msg-060');

    // 4. Invalid before messageId
    const p4Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages?before=non-existent-id`,
      headers: authHeaders(),
    });
    expect(p4Res.statusCode).toBe(200);
    const p4 = JSON.parse(p4Res.body);
    expect(p4.hasMore).toBe(false);
    expect(p4.messages).toHaveLength(0);
  });

  it('searches sessions by title and message content with pinned priority', async () => {
    // Create 3 sessions
    const s1Res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Docker containerization guide' },
    });
    const s1 = JSON.parse(s1Res.body);

    const s2Res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'General discussion' },
    });
    const s2 = JSON.parse(s2Res.body);

    const s3Res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Kubernetes orchestration' },
    });
    const s3 = JSON.parse(s3Res.body);

    // Add message with unique keyword to s2
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: s2.id,
      role: 'user',
      content: 'Tối ưu hóa thuật toán Dijkstra',
    });

    // 1. Search by title
    const searchTitleRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=Docker',
      headers: authHeaders(),
    });
    expect(searchTitleRes.statusCode).toBe(200);
    const titleMatches = JSON.parse(searchTitleRes.body);
    expect(titleMatches.some((s: { id: string }) => s.id === s1.id)).toBe(true);
    expect(titleMatches.some((s: { id: string }) => s.id === s2.id)).toBe(false);
    expect(titleMatches.some((s: { id: string }) => s.id === s3.id)).toBe(false);

    // 2. Search by message content
    const searchContentRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=Dijkstra',
      headers: authHeaders(),
    });
    expect(searchContentRes.statusCode).toBe(200);
    const contentMatches = JSON.parse(searchContentRes.body);
    expect(contentMatches.some((s: { id: string }) => s.id === s2.id)).toBe(true);
    expect(contentMatches.some((s: { id: string }) => s.id === s1.id)).toBe(false);

    // 3. Search with no matches
    const noMatchRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=khong_the_tim_thay_9999',
      headers: authHeaders(),
    });
    expect(noMatchRes.statusCode).toBe(200);
    expect(JSON.parse(noMatchRes.body)).toHaveLength(0);

    // 4. Pin s2 and verify pinned priority
    await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${s2.id}`,
      headers: authHeaders(),
      payload: { pinned: true },
    });

    const allSessionsRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const allSessions = JSON.parse(allSessionsRes.body);
    expect(allSessions[0].id).toBe(s2.id);
    expect(allSessions[0].pinned).toBe(1);

    // 5. Escaping special LIKE characters: %, _, \
    const sPctRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Success rate 100% completed' },
    });
    const sPct = JSON.parse(sPctRes.body);

    const sUnderRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'variable_name_convention' },
    });
    const sUnder = JSON.parse(sUnderRes.body);

    const sSlashRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'c:\\windows\\system32' },
    });
    const sSlash = JSON.parse(sSlashRes.body);

    // Searching for '%' should only match the literal '%', not all sessions
    const searchPctRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=%',
      headers: authHeaders(),
    });
    const pctMatches = JSON.parse(searchPctRes.body);
    expect(pctMatches.some((s: { id: string }) => s.id === sPct.id)).toBe(true);
    expect(pctMatches.some((s: { id: string }) => s.id === s1.id)).toBe(false);

    // Searching for '_' should only match the literal '_', not all sessions with single chars
    const searchUnderRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=_name_',
      headers: authHeaders(),
    });
    const underMatches = JSON.parse(searchUnderRes.body);
    expect(underMatches.some((s: { id: string }) => s.id === sUnder.id)).toBe(true);
    expect(underMatches.some((s: { id: string }) => s.id === s1.id)).toBe(false);

    // Searching for '\' should match literal '\'
    const searchSlashRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=\\windows\\',
      headers: authHeaders(),
    });
    const slashMatches = JSON.parse(searchSlashRes.body);
    expect(slashMatches.some((s: { id: string }) => s.id === sSlash.id)).toBe(true);

    // 6. Archived sessions are hidden by default, shown with ?archived=1
    await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${s1.id}`,
      headers: authHeaders(),
      payload: { archived: true },
    });

    const searchHiddenRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=Docker',
      headers: authHeaders(),
    });
    expect(JSON.parse(searchHiddenRes.body)).toHaveLength(0);

    const searchArchivedRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=Docker&archived=1',
      headers: authHeaders(),
    });
    const archivedMatches = JSON.parse(searchArchivedRes.body);
    expect(archivedMatches.some((s: { id: string }) => s.id === s1.id)).toBe(true);

    const allUnarchivedRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    expect(JSON.parse(allUnarchivedRes.body).some((s: { id: string }) => s.id === s1.id)).toBe(false);

    const allArchivedRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?archived=1',
      headers: authHeaders(),
    });
    expect(JSON.parse(allArchivedRes.body).some((s: { id: string }) => s.id === s1.id)).toBe(true);
  });

  it('exports session to Markdown format', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Phiên export mẫu' },
    });
    const session = JSON.parse(sRes.body);

    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'user',
      content: 'Chào Claude, hãy viết test.',
    });
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'tool',
      content: 'Read src/chat/service.ts',
      meta: JSON.stringify({ name: 'Read', input: { path: 'src/chat/service.ts' } }),
    });
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'assistant',
      content: 'Đây là các bài test hoàn chỉnh.',
    });

    // 1. Export existing session
    const expRes = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/export`,
      headers: authHeaders(),
    });
    expect(expRes.statusCode).toBe(200);
    expect(expRes.headers['content-type']).toContain('text/markdown');
    const md = expRes.body;
    expect(md).toContain('# Phiên export mẫu');
    expect(md).toContain(`- **ID:** \`${session.id}\``);
    expect(md).toContain('### User');
    expect(md).toContain('Chào Claude, hãy viết test.');
    expect(md).toContain('### Tool: Read');
    expect(md).toContain('Read src/chat/service.ts');
    expect(md).toContain('### Assistant');
    expect(md).toContain('Đây là các bài test hoàn chỉnh.');

    // 2. Export non-existent session -> 404
    const notFoundRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions/non-existent-session-id/export',
      headers: authHeaders(),
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('accumulates tokens from stream-json result.usage into session and sets contextTokens', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Token accumulation session' },
    });
    const session = JSON.parse(sRes.body);

    let firstDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      firstDone = true;
    });

    // Turn 1: request with usage:150:40
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Turn 1 usage:150:40' },
    });

    await vi.waitFor(() => {
      expect(firstDone).toBe(true);
      expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0);
    }, { timeout: 10_000 });

    let sessRow = ctx.chatSessionRepo.get(session.id);
    expect(sessRow?.inputTokens).toBe(150);
    expect(sessRow?.outputTokens).toBe(40);
    expect(sessRow?.contextTokens).toBe(150);

    // Turn 2: request with usage:220:60
    let secondDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      secondDone = true;
    });

    const res2 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Turn 2 usage:220:60' },
    });
    expect(res2.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(secondDone).toBe(true);
    }, { timeout: 10_000 });

    sessRow = ctx.chatSessionRepo.get(session.id);
    // Accumulated: 150 + 220 = 370 input, 40 + 60 = 100 output
    expect(sessRow?.inputTokens).toBe(370);
    expect(sessRow?.outputTokens).toBe(100);
    // contextTokens should be the input tokens of the latest turn (220)
    expect(sessRow?.contextTokens).toBe(220);
  });

  it('accumulates tokens with prompt caching: contextTokens is from the final assistant message (including cache_read and cache_creation), while inputTokens is total input from result.usage', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Prompt cache session' },
    });
    const session = JSON.parse(sRes.body);

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    // Send a message with tool execution where fake-claude emits multiple assistant messages with cache usage
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Please use a tool with caching' },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
    }, { timeout: 10_000 });

    const sessRow = ctx.chatSessionRepo.get(session.id);
    // In fake-claude tool branch:
    // Assistant 1 (tool): input 100, cache_read 500, cache_creation 200 (context = 800)
    // Assistant 2 (final assistant in turn): input 120, cache_read 700, cache_creation 100 (context = 920)
    // Result: input 220, cache_read 1200, cache_creation 300 (total input = 1720), output 50
    expect(sessRow?.contextTokens).toBe(920); // 120 + 700 + 100 from FINAL assistant event
    expect(sessRow?.inputTokens).toBe(1720); // 220 + 1200 + 300 from result.usage
    expect(sessRow?.outputTokens).toBe(50);
  });

  it('creates database index on chat_messages(sessionId, createdAt) for pagination query', () => {
    const indices = ctx.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_messages'")
      .all() as Array<{ name: string; sql: string }>;
    const createdIndex = indices.find((idx) => idx.name === 'idx_chat_messages_session_created');
    expect(createdIndex).toBeDefined();
    expect(createdIndex?.sql).toContain('sessionId');
    expect(createdIndex?.sql).toContain('createdAt');
  });

  it('automatically sets session title from first user message up to 60 characters', async () => {
    // 1. Session created without title
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: {},
    });
    const session = JSON.parse(sRes.body);

    const longMessage = 'Xây dựng một hệ thống phân tán chịu lỗi cao với kiến trúc vi dịch vụ và message queue Apache Kafka';
    // longMessage is 100 chars, first 60 chars:
    const expectedTitle = longMessage.slice(0, 60);

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: longMessage },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
      expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0);
    }, { timeout: 10_000 });

    const sessRow = ctx.chatSessionRepo.get(session.id);
    expect(sessRow?.title).toBe(expectedTitle);
    expect(sessRow?.title?.length).toBe(60);

    // 2. Second message should NOT overwrite the auto-generated title
    let secondDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      secondDone = true;
    });

    const res2 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn thứ 2 ngắn gọn' },
    });
    expect(res2.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(secondDone).toBe(true);
    }, { timeout: 10_000 });

    const sessRow2 = ctx.chatSessionRepo.get(session.id);
    expect(sessRow2?.title).toBe(expectedTitle);

    // 3. Session created with explicit title should NOT be overwritten
    const explicitRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Tiêu đề cố định không đổi' },
    });
    const explicitSession = JSON.parse(explicitRes.body);

    let explicitDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      explicitDone = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${explicitSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn đầu tiên của phiên có tiêu đề sẵn' },
    });

    await vi.waitFor(() => {
      expect(explicitDone).toBe(true);
    }, { timeout: 10_000 });

    const explicitRow = ctx.chatSessionRepo.get(explicitSession.id);
    expect(explicitRow?.title).toBe('Tiêu đề cố định không đổi');
  });

  it('supports PATCH for title, pinned, and archived, and DELETE cleans up session and messages', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Initial Title' },
    });
    const session = JSON.parse(sRes.body);

    // 1. PATCH title, pinned, archived
    const patchRes1 = await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
      payload: { title: 'Updated Title', pinned: true, archived: true },
    });
    expect(patchRes1.statusCode).toBe(200);
    const patched1 = JSON.parse(patchRes1.body);
    expect(patched1.title).toBe('Updated Title');
    expect(patched1.pinned).toBe(1);
    expect(patched1.archived).toBe(1);

    // 2. PATCH unpin and unarchive
    const patchRes2 = await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
      payload: { pinned: false, archived: false },
    });
    expect(patchRes2.statusCode).toBe(200);
    const patched2 = JSON.parse(patchRes2.body);
    expect(patched2.pinned).toBe(0);
    expect(patched2.archived).toBe(0);

    // 3. DELETE removes session and messages
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'user',
      content: 'Will be deleted',
    });

    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).ok).toBe(true);

    expect(ctx.chatSessionRepo.get(session.id)).toBeUndefined();
    expect(ctx.chatMessageRepo.getBySession(session.id)).toHaveLength(0);
  });

  it('POST /api/chat/sessions/:id/compact sends /compact, updates contextTokens, and inserts system message', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Test Compact' },
    });
    const session = JSON.parse(sRes.body);
    ctx.chatSessionRepo.addUsage(session.id, { inputTokens: 0, outputTokens: 0, contextTokens: 50000 });

    const res = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/compact`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.contextTokens).toBe(15000);

    const updated = ctx.chatSessionRepo.get(session.id);
    expect(updated?.contextTokens).toBe(15000);
    expect(updated?.busy).toBe(0);

    const messages = ctx.chatMessageRepo.getBySession(session.id);
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toBe('Đã nén ngữ cảnh');

    // 404 on unknown session
    const notFoundRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions/unknown-sess-123/compact',
      headers: authHeaders(),
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('POST /api/chat/sessions/:id/fork-summary requests summary and creates a new session with summary as first message', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Dự án Alpha' },
    });
    const session = JSON.parse(sRes.body);

    const res = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/fork-summary`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBeDefined();
    expect(body.sessionId).toBe(body.id);

    const forkedSession = ctx.chatSessionRepo.get(body.id);
    expect(forkedSession).toBeDefined();
    expect(forkedSession?.title).toBe('Dự án Alpha (tóm tắt)');

    const messages = ctx.chatMessageRepo.getBySession(body.id);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('Đây là bản tóm tắt nội dung phiên trước.');

    // 404 on unknown session
    const notFoundRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions/unknown-sess-123/fork-summary',
      headers: authHeaders(),
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('supports compact and fork-summary via persistent stream-json process and emits chat.compacted event', async () => {
    process.env.FAKE_CLAUDE_STREAM_JSON = '1';
    clearPartialSupportCache();

    let compactedEvent: { sessionId?: string; contextTokens?: number } | null = null;
    ctx.scheduler.getEventBus().on('chat.compacted', (_tid, payload) => {
      compactedEvent = payload as { sessionId?: string; contextTokens?: number };
    });

    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Stream Session' },
    });
    const session = JSON.parse(sRes.body);

    // Compact
    const cRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/compact`,
      headers: authHeaders(),
    });
    expect(cRes.statusCode).toBe(200);
    expect(JSON.parse(cRes.body).ok).toBe(true);

    await vi.waitFor(() => {
      expect(compactedEvent).toBeDefined();
      expect(compactedEvent?.sessionId).toBe(session.id);
      expect(compactedEvent?.contextTokens).toBe(15000);
    });

    // Fork summary
    const fRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/fork-summary`,
      headers: authHeaders(),
    });
    expect(fRes.statusCode).toBe(201);
    const forked = JSON.parse(fRes.body);
    expect(forked.id).toBeDefined();
    expect(ctx.chatSessionRepo.get(forked.id)?.title).toBe('Stream Session (tóm tắt)');
  });

  it('auto-compacts when contextTokens exceeds (autoCompactPercent / 100) * 200_000 threshold', async () => {
    let compacted = false;
    ctx.scheduler.getEventBus().on('chat.compacted', () => {
      compacted = true;
    });

    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Auto Compact Session' },
    });
    const session = JSON.parse(sRes.body);

    // Send high-context prompt that generates 180,000 tokens (threshold is 85% of 200,000 = 170,000)
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'high-context load' },
    });

    await vi.waitFor(() => {
      expect(compacted).toBe(true);
      const messages = ctx.chatMessageRepo.getBySession(session.id);
      const systemMsg = messages.find((m) => m.role === 'system');
      expect(systemMsg).toBeDefined();
      expect(systemMsg?.content).toBe('Đã nén ngữ cảnh');
    }, { timeout: 10_000 });
  });

  it('respects autoCompactPercent=0 to disable auto-compacting', async () => {
    ctx.service.updateConfig({ chat: { autoCompactPercent: 0 } });

    let compacted = false;
    ctx.scheduler.getEventBus().on('chat.compacted', () => {
      compacted = true;
    });

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Disabled Auto Compact' },
    });
    const session = JSON.parse(sRes.body);

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'high-context load' },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
    }, { timeout: 10_000 });

    await new Promise((r) => setTimeout(r, 200));
    expect(compacted).toBe(false);
    const messages = ctx.chatMessageRepo.getBySession(session.id);
    expect(messages.find((m) => m.role === 'system')).toBeUndefined();
  });

  it('checkClaudePartialSupport and checkClaudeStreamJsonSupport use execFileSync without shell interpolation', () => {
    clearPartialSupportCache();
    // fakeClaudeBin returns --include-partial-messages on --help
    expect(checkClaudePartialSupport(fakeClaudeBin)).toBe(true);

    // Without FAKE_CLAUDE_STREAM_JSON=1, stream-json is not supported
    clearPartialSupportCache();
    delete process.env.FAKE_CLAUDE_STREAM_JSON;
    expect(checkClaudeStreamJsonSupport(fakeClaudeBin)).toBe(false);

    // With FAKE_CLAUDE_STREAM_JSON=1, stream-json is supported
    clearPartialSupportCache();
    process.env.FAKE_CLAUDE_STREAM_JSON = '1';
    expect(checkClaudeStreamJsonSupport(fakeClaudeBin)).toBe(true);

    // Returns false for non-existent binary without throwing
    expect(checkClaudePartialSupport('/nonexistent/path/to/claude')).toBe(false);
    expect(checkClaudeStreamJsonSupport('/nonexistent/path/to/claude')).toBe(false);

    // Shell metacharacters are safely treated as a binary path (execFileSync) and not executed by a shell
    const canaryFile = path.join(tmpDir, 'injection-canary.txt');
    const maliciousBin = `${fakeClaudeBin}; touch "${canaryFile}"`;
    expect(checkClaudePartialSupport(maliciousBin)).toBe(false);
    expect(checkClaudeStreamJsonSupport(maliciousBin)).toBe(false);
    expect(fs.existsSync(canaryFile)).toBe(false);
  });
});
