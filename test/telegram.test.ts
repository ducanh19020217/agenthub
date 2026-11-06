import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext, closeContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { DeployService } from '../src/deploy.js';
import {
  TelegramBotService,
  readTelegramToken,
  isProjectMergeEnabled,
  redactTelegramToken,
  slugify,
  generateTaskSlug,
  parseTimesheetCommand,
} from '../src/telegram.js';

describe('Telegram timesheet parser', () => {
  it('parses waiting, decimal and pinned hours', () => {
    expect(parseTimesheetCommand('SIE-1 3.5h cho 2.5h co-dinh Cài lại máy')).toEqual({ ticket: 'SIE-1', activeHours: 3.5, waitHours: 2.5, pinned: true, description: 'Cài lại máy' });
    expect(parseTimesheetCommand('new 1h Trao đổi khách')).toMatchObject({ ticket: 'new', activeHours: 1, waitHours: 0, pinned: false, description: 'Trao đổi khách' });
  });

  it('rejects missing descriptions and totals over 24 hours', () => {
    expect(() => parseTimesheetCommand('OP-1 1h')).toThrow();
    expect(() => parseTimesheetCommand('OP-1 20h cho 5h việc quá lâu')).toThrow(/24/);
    expect(() => parseTimesheetCommand('OP-1 0h việc bằng không')).toThrow();
  });

  it('parses a standalone co-dinh flag and preserves ticket case', () => {
    expect(parseTimesheetCommand('sie-42 2h co-dinh Cài đặt máy')).toEqual({
      ticket: 'sie-42', activeHours: 2, waitHours: 0, pinned: true, description: 'Cài đặt máy',
    });
  });
});

interface RecordedFetchCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

const fakeClaudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

describe('Telegram Bot Remote Control (c-telegram-bot)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: Awaited<ReturnType<typeof createServer>>;
  let token: string;
  let fakeEngine: FakeEngine;

  let recordedCalls: RecordedFetchCall[];
  let fakeFetch: typeof fetch;
  let currentTime: number;

  function authHeaders() {
    return {
      host: '127.0.0.1:7795',
      authorization: `Bearer ${token}`,
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-telegram-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    // Create secrets directory and token file
    const secretsDir = path.join(tmpDir, 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    const tokenFile = path.join(secretsDir, 'telegram.token');
    fs.writeFileSync(tokenFile, 'test-bot-token-123456\n', { mode: 0o600 });

    config = loadConfig(tmpDir);
    config.port = 7795;
    config.telegram = {
      enabled: true,
      botTokenFile: tokenFile,
      allowedChatIds: [],
      notify: {
        reviewReady: true,
        failed: true,
        blocked: true,
        quota: true,
        fallback: true,
      },
    };

    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    // Mock fetch for Telegram API
    recordedCalls = [];
    currentTime = 1_700_000_000_000;

    fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      const bodyStr = typeof init?.body === 'string' ? init.body : undefined;
      const bodyObj = bodyStr ? JSON.parse(bodyStr) : undefined;

      recordedCalls.push({
        url: urlStr,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: bodyObj,
      });

      if (urlStr.endsWith('/getUpdates')) {
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (urlStr.endsWith('/createForumTopic')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            message_thread_id: 555,
            name: bodyObj?.name || 'Topic',
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    vi.stubGlobal('fetch', fakeFetch);
    if (ctx.telegramService) {
      (ctx.telegramService as unknown as { fetch: typeof fetch }).fetch = fakeFetch;
    }

    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
    closeContext(ctx);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  function createTestBotService(opts?: { allowedChatIds?: number[]; execStdout?: string; chatService?: typeof ctx.chatService }) {
    config.telegram.allowedChatIds = opts?.allowedChatIds ? [...opts.allowedChatIds] : [];
    return new TelegramBotService({
      config,
      service: ctx.service,
      eventBus: ctx.scheduler.getEventBus(),
      taskRepo: ctx.taskRepo,
      projectRepo: ctx.projectRepo,
      departmentRepo: ctx.departmentRepo,
      quotaMarkRepo: ctx.quotaMarkRepo,
      fetch: fakeFetch,
      now: () => currentTime,
      sleep: async () => {},
      sleepFn: async () => {},
      execFile: async () => ({ stdout: opts?.execStdout || '1 file changed, 10 insertions(+)' }),
      tokenOverride: 'test-bot-token-123456',
      chatService: opts?.chatService,
    });
  }

  describe('1. Token reading and config security', () => {
    it('readTelegramToken reads trimmed token and enforces 0600 mode', () => {
      const p = path.join(tmpDir, 'secrets', 'custom.token');
      fs.writeFileSync(p, '  my-custom-token \n', { mode: 0o644 });

      const tokenValue = readTelegramToken(p);
      expect(tokenValue).toBe('my-custom-token');

      const stat = fs.statSync(p);
      expect((stat.mode & 0o777)).toBe(0o600);
    });

    it('readTelegramToken returns null if file does not exist or empty', () => {
      expect(readTelegramToken(path.join(tmpDir, 'nonexistent.token'))).toBeNull();

      const emptyPath = path.join(tmpDir, 'secrets', 'empty.token');
      fs.writeFileSync(emptyPath, '   \n');
      expect(readTelegramToken(emptyPath)).toBeNull();
    });

    it('isProjectMergeEnabled parses JSON or returns boolean', () => {
      expect(isProjectMergeEnabled(null)).toBe(false);
      expect(isProjectMergeEnabled({ id: 'p', name: 'P', path: '', defaultBranch: 'main', envTemplate: null, maxParallel: 1, checks: null, hooks: null, createdAt: '', merge: '{"enabled":true}' })).toBe(true);
      expect(isProjectMergeEnabled({ id: 'p', name: 'P', path: '', defaultBranch: 'main', envTemplate: null, maxParallel: 1, checks: null, hooks: null, createdAt: '', merge: '{"enabled":false}' })).toBe(false);
      expect(isProjectMergeEnabled({ id: 'p', name: 'P', path: '', defaultBranch: 'main', envTemplate: null, maxParallel: 1, checks: null, hooks: null, createdAt: '', merge: 'invalid-json' })).toBe(false);
    });
  });

  describe('2. Pairing flow and unauthorized chat rejection', () => {
    it('rejects unrecognized chat when no code or wrong code is provided (silent ignore)', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });

      // Unrecognized chat sends random text
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: 'Hello bot',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      // Unrecognized chat sends /start with wrong code
      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: '/start 000000',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
      expect(config.telegram.allowedChatIds).not.toContain(999);
    });

    it('pairs successfully with active 6-digit code and ignores subsequent attempts with same code', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();
      expect(code).toMatch(/^\d{6}$/);

      // Send correct /start <code>
      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          date: 123456,
          chat: { id: 888, type: 'private' },
          text: `/start ${code}`,
        },
      });

      expect(config.telegram.allowedChatIds).toContain(888);
      const sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0].body?.chat_id).toBe(888);
      expect(sendCalls[0].body?.text).toContain('Ghép đôi thành công');

      // Another chat cannot reuse the same consumed code
      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 4,
          date: 123456,
          chat: { id: 777, type: 'private' },
          text: `/start ${code}`,
        },
      });
      expect(config.telegram.allowedChatIds).not.toContain(777);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);
    });

    it('pairing code expires after 10 minutes', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();

      // Fast forward time by 11 minutes
      currentTime += 11 * 60 * 1000;

      await bot.handleUpdate({
        update_id: 5,
        message: {
          message_id: 5,
          date: 123456,
          chat: { id: 888, type: 'private' },
          text: `/start ${code}`,
        },
      });

      expect(config.telegram.allowedChatIds).not.toContain(888);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('cancels the pairing code after five invalid attempts and records a dashboard event', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();
      const pairingFailed = vi.fn();
      ctx.scheduler.getEventBus().on('telegram.pairing_failed', pairingFailed);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await bot.handleUpdate({
          update_id: 20 + attempt,
          message: {
            message_id: 20 + attempt,
            date: 123456,
            chat: { id: 900 + attempt, type: 'private' },
            text: `/start ${code === '000000' ? '000001' : '000000'}`,
          },
        });
      }

      expect(pairingFailed).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          reason: 'too_many_invalid_attempts',
          message: expect.stringContaining('đã bị huỷ'),
        }),
      );

      await bot.handleUpdate({
        update_id: 30,
        message: {
          message_id: 30,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: `/start ${code}`,
        },
      });
      expect(config.telegram.allowedChatIds).not.toContain(999);
    });

    it('limits invalid pairing attempts from one chat to three per ten minutes', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();
      const pairingFailed = vi.fn();
      ctx.scheduler.getEventBus().on('telegram.pairing_failed', pairingFailed);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await bot.handleUpdate({
          update_id: 40 + attempt,
          message: {
            message_id: 40 + attempt,
            date: 123456,
            chat: { id: 901, type: 'private' },
            text: '/start 000000',
          },
        });
      }
      expect(pairingFailed).not.toHaveBeenCalled();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await bot.handleUpdate({
          update_id: 50 + attempt,
          message: {
            message_id: 50 + attempt,
            date: 123456,
            chat: { id: 902 + attempt, type: 'private' },
            text: '/start 000000',
          },
        });
      }
      expect(pairingFailed).toHaveBeenCalledTimes(1);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('does not pair a group chat even with the correct code', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();

      await bot.handleUpdate({
        update_id: 60,
        message: {
          message_id: 60,
          date: 123456,
          chat: { id: -123, type: 'group' },
          text: `/start ${code}`,
        },
      });
      expect(config.telegram.allowedChatIds).not.toContain(-123);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('ignores commands and callback queries from unauthorized chats', async () => {
      const bot = createTestBotService({ allowedChatIds: [12345] });

      // Chat 999 is not in allowedChatIds
      await bot.handleUpdate({
        update_id: 6,
        message: {
          message_id: 6,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: '/status',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      await bot.handleUpdate({
        update_id: 7,
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          message: {
            message_id: 7,
            chat: { id: 999 },
          },
          data: 'cancel:confirm:test-task',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('requires the callback sender to be the paired private chat', async () => {
      const bot = createTestBotService({ allowedChatIds: [12345] });
      await bot.handleUpdate({
        update_id: 8,
        callback_query: {
          id: 'cb-group-user',
          from: { id: 999 },
          message: { message_id: 8, chat: { id: 12345 } },
          data: 'task:retry:missing-task',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });
  });

  describe('7. Telegram token redaction', () => {
    it('redacts tokens from fetch errors before they reach callers', async () => {
      config.telegram.allowedChatIds = [12345];
      expect(redactTelegramToken(new Error('fetch failed https://api.telegram.org/bottest-bot-token-123456/sendMessage'), 'test-bot-token-123456'))
        .toContain('bot<redacted>');
      expect(redactTelegramToken(new Error('https://api.telegram.org/bottest-bot-token-123456/sendMessage'), 'test-bot-token-123456'))
        .toContain('<redacted>');

      fakeFetch = vi.fn(async () => {
        throw new Error('fetch failed: https://api.telegram.org/bottest-bot-token-123456/sendMessage');
      }) as unknown as typeof fetch;
      const failingBot = new TelegramBotService({
        config,
        service: ctx.service,
        eventBus: ctx.scheduler.getEventBus(),
        taskRepo: ctx.taskRepo,
        projectRepo: ctx.projectRepo,
        quotaMarkRepo: ctx.quotaMarkRepo,
        fetch: fakeFetch,
        now: () => currentTime,
        sleep: async () => {},
        tokenOverride: 'test-bot-token-123456',
      });

      await expect(failingBot.handleUpdate({
        update_id: 70,
        message: {
          message_id: 70,
          date: 123456,
          chat: { id: 12345, type: 'private' },
          text: '/help',
        },
      })).rejects.toThrow('<redacted>');
    });
  });

  describe('3. Allowed chat commands', () => {
    let bot: TelegramBotService;
    const CHAT_ID = 12345;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: false }),
      });
      ctx.projectRepo.insert({
        id: 'p2',
        name: 'Project 2',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: true }),
      });

      ctx.taskRepo.insert({
        id: 'p1/task-rev',
        projectId: 'p1',
        slug: 'task-rev',
        title: 'Task chờ review',
        body: 'Yêu cầu 1',
        status: 'review',
        level: 'easy',
        branch: 'task/rev',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'p1/task-fail',
        projectId: 'p1',
        slug: 'task-fail',
        title: 'Task thất bại',
        body: 'Yêu cầu 2',
        status: 'failed',
        level: 'easy',
        branch: 'task/fail',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'p1/task-run',
        projectId: 'p1',
        slug: 'task-run',
        title: 'Task đang chạy',
        body: 'Yêu cầu 3',
        status: 'running',
        level: 'easy',
        branch: 'task/run',
        baseRef: 'main',
      });

      // Two tasks with the same slug across projects to test ambiguity
      ctx.taskRepo.insert({
        id: 'p1/duplicate-slug',
        projectId: 'p1',
        slug: 'duplicate-slug',
        title: 'Task trùng 1',
        body: '',
        status: 'review',
        level: 'easy',
        branch: 'task/d1',
        baseRef: 'main',
      });
      ctx.taskRepo.insert({
        id: 'p2/duplicate-slug',
        projectId: 'p2',
        slug: 'duplicate-slug',
        title: 'Task trùng 2',
        body: '',
        status: 'review',
        level: 'easy',
        branch: 'task/d2',
        baseRef: 'main',
      });

      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
    });

    it('/help lists all available commands', async () => {
      await bot.handleUpdate({
        update_id: 10,
        message: {
          message_id: 10,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/help',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('/status');
      expect(calls[0].body?.text).toContain('/tasks');
      expect(calls[0].body?.text).toContain('/task');
      expect(calls[0].body?.text).toContain('/newtask');
      expect(calls[0].body?.text).toContain('/plan');
      expect(calls[0].body?.text).toContain('/drafts');
      expect(calls[0].body?.text).toContain('&lt;id&gt;');
      expect(calls[0].body?.text).toContain('/approve');
      expect(calls[0].body?.text).toContain('/reject');
      expect(calls[0].body?.text).toContain('/pause');
      expect(calls[0].body?.text).toContain('/resume');
    });

    it('/status returns task overview and scheduler state', async () => {
      await bot.handleUpdate({
        update_id: 11,
        message: {
          message_id: 11,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/status',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = String(calls[0].body?.text);
      expect(text).toContain('Tổng quan trạng thái AgentHub');
      expect(text).toContain('Điều phối');
      expect(text).toContain('Tasks:');
    });

    it('/brain renders transcript session status, request, and last tool', async () => {
      ctx.claudeSessionRepo.upsert({
        sessionId: 'telegram-brain-session', cwd: tmpDir, title: 'Sửa lỗi Telegram',
        lastAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        lastUserRequest: 'Kiểm tra trạng thái bot', lastToolName: 'Bash',
        lastToolSummary: 'Bash: git status --short', lastEventKind: 'assistant_text', fiveHourTokens: 321,
      });

      await bot.handleUpdate({
        update_id: 111,
        message: {
          message_id: 111,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/brain',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = String(calls[0].body?.text);
      expect(text).toContain('Claude · Điều phối');
      expect(text).toContain('chờ bạn trả lời');
      expect(text).toContain('Kiểm tra trạng thái bot');
      expect(text).toContain('Bash: git status --short');
    });

    it('notifies brain waiting only once until the session becomes active again', () => {
      currentTime = Date.now();
      ctx.claudeSessionRepo.upsert({
        sessionId: 'telegram-waiting-once', cwd: tmpDir, title: 'Chờ phản hồi',
        lastAt: new Date(currentTime - 6 * 60_000).toISOString(), lastEventKind: 'assistant_text',
      });
      const handleChatEvent = (bot as unknown as { handleEvent(type: string, taskId?: string, payload?: unknown): void }).handleEvent.bind(bot);

      handleChatEvent('brain.updated');
      handleChatEvent('brain.updated');

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('đang chờ bạn trả lời');
      expect(calls[0].body?.text).toContain('Chờ phản hồi');
    });

    it('does not notify for hub chat / brain sessions that already answered in Telegram', () => {
      currentTime = Date.now();
      ctx.claudeSessionRepo.upsert({
        sessionId: 'hub-chat-waiting', cwd: tmpDir, title: 'Bộ não', isHubChat: 1,
        lastAt: new Date(currentTime - 6 * 60_000).toISOString(), lastEventKind: 'assistant_text',
      });
      const handleChatEvent = (bot as unknown as { handleEvent(type: string, taskId?: string, payload?: unknown): void }).handleEvent.bind(bot);
      handleChatEvent('brain.updated');
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('/tasks lists tasks and filters by status', async () => {
      // List all tasks
      await bot.handleUpdate({
        update_id: 12,
        message: {
          message_id: 12,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/tasks',
        },
      });
      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Danh sách task');
      expect(calls[0].body?.text).toContain('p1/task-rev');

      // Filter by review status
      recordedCalls = [];
      await bot.handleUpdate({
        update_id: 13,
        message: {
          message_id: 13,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/tasks review',
        },
      });
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Danh sách task (review)');
      expect(calls[0].body?.text).toContain('p1/task-rev');
      expect(calls[0].body?.text).not.toContain('p1/task-fail');
    });

    it('/task shows summary, checks, link, and interactive buttons', async () => {
      await bot.handleUpdate({
        update_id: 14,
        message: {
          message_id: 14,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/task task-rev',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = String(calls[0].body?.text);
      expect(text).toContain('Task: p1/task-rev');
      expect(text).toContain('Task chờ review');
      expect(text).toContain('Mở trên Dashboard');

      // Check inline buttons for review task
      const markup = calls[0].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard).toBeDefined();
      expect(markup.inline_keyboard[0][0].text).toContain('Duyệt & merge');
      expect(markup.inline_keyboard[0][1].text).toContain('Trả về');
      expect(markup.inline_keyboard[1][0].text).toContain('diff');
    });

    it('/task handles ambiguous slug warning', async () => {
      await bot.handleUpdate({
        update_id: 15,
        message: {
          message_id: 15,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/task duplicate-slug',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Có nhiều task trùng slug');
      expect(calls[0].body?.text).toContain('p1/duplicate-slug');
      expect(calls[0].body?.text).toContain('p2/duplicate-slug');
    });

    it('/pause and /resume controls scheduler dispatch', async () => {
      expect(ctx.service.isSchedulerPaused()).toBe(false);

      await bot.handleUpdate({
        update_id: 16,
        message: {
          message_id: 16,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/pause',
        },
      });
      expect(ctx.service.isSchedulerPaused()).toBe(true);

      await bot.handleUpdate({
        update_id: 17,
        message: {
          message_id: 17,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/resume',
        },
      });
      expect(ctx.service.isSchedulerPaused()).toBe(false);
    });

    it('/pause <id> and /resume <id> pause and resume specific task', async () => {
      const pauseSpy = vi.spyOn(ctx.service, 'pauseTask').mockReturnValue({ ok: true, paused: true });
      const resumeSpy = vi.spyOn(ctx.service, 'resumeTask').mockReturnValue({ ok: true, paused: false });

      await bot.handleUpdate({
        update_id: 171,
        message: {
          message_id: 171,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/pause p1/task-run',
        },
      });
      expect(pauseSpy).toHaveBeenCalledWith('p1/task-run', 'manual');

      await bot.handleUpdate({
        update_id: 172,
        message: {
          message_id: 172,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/resume p1/task-run',
        },
      });
      expect(resumeSpy).toHaveBeenCalledWith('p1/task-run');
    });

    it('/task shows paused badge and resume button when task is paused', async () => {
      vi.spyOn(ctx.service, 'getTask').mockResolvedValueOnce({
        id: 'p1/task-run',
        projectId: 'p1',
        slug: 'task-run',
        title: 'Task Paused',
        status: 'running',
        level: 'easy',
        paused: true,
        pauseReason: 'load',
        runs: [],
      } as unknown as Awaited<ReturnType<typeof ctx.service.getTask>>);

      await bot.handleUpdate({
        update_id: 173,
        message: {
          message_id: 173,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/task task-run',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const text = String(calls[calls.length - 1].body?.text);
      expect(text).toContain('[Tạm dừng (quá tải)]');
      const markup = calls[calls.length - 1].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard[0][0].callback_data).toBe('task:resume:p1/task-run');
      expect(markup.inline_keyboard[0][0].text).toContain('Tiếp tục');
    });

    it('/cancel sends confirmation prompt with inline buttons', async () => {
      await bot.handleUpdate({
        update_id: 18,
        message: {
          message_id: 18,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/cancel p1/task-run',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Bạn có chắc muốn hủy task');
      const markup = calls[0].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard[0][0].callback_data).toBe('cancel:confirm:p1/task-run');
      expect(markup.inline_keyboard[0][1].callback_data).toBe('cancel:abort:p1/task-run');
    });

    it('/approve approves task and checks project merge config', async () => {
      await bot.handleUpdate({
        update_id: 19,
        message: {
          message_id: 19,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/approve p1/task-rev',
        },
      });

      const task = ctx.taskRepo.get('p1/task-rev');
      expect(task?.status).toBe('done');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã duyệt task p1/task-rev');
    });

    it('/reject with inline feedback rejects task', async () => {
      await bot.handleUpdate({
        update_id: 20,
        message: {
          message_id: 20,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/reject p1/task-rev Cần viết thêm unit test',
        },
      });

      const task = ctx.taskRepo.get('p1/task-rev');
      expect(task?.status).toBe('queued');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã trả về task p1/task-rev với nhận xét');
      expect(calls[0].body?.text).toContain('Cần viết thêm unit test');
    });

    it('/reject without feedback prompts user and waits for input', async () => {
      await bot.handleUpdate({
        update_id: 21,
        message: {
          message_id: 21,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/reject p1/task-rev',
        },
      });

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Vui lòng gửi nhận xét');

      // User replies with feedback
      recordedCalls = [];
      await bot.handleUpdate({
        update_id: 22,
        message: {
          message_id: 22,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Phải sửa lại tên biến',
        },
      });

      const task = ctx.taskRepo.get('p1/task-rev');
      expect(task?.status).toBe('queued');
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã trả về task p1/task-rev với nhận xét');
      expect(calls[0].body?.text).toContain('Phải sửa lại tên biến');
    });

    it('/retry retries failed task', async () => {
      await bot.handleUpdate({
        update_id: 23,
        message: {
          message_id: 23,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/retry p1/task-fail',
        },
      });

      const task = ctx.taskRepo.get('p1/task-fail');
      expect(['queued', 'waiting_quota']).toContain(task?.status);
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã đưa task p1/task-fail vào hàng đợi');
    });

    it('/deploy without arguments lists deploy statuses including pushStatus', async () => {
      const getStatusSpy = vi.spyOn(ctx.service, 'getDeployStatuses').mockReturnValue([
        { projectId: 'p1', status: 'succeeded', pushStatus: 'push lúc 14:00' },
      ]);
      await bot.handleUpdate({
        update_id: 24,
        message: {
          message_id: 24,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/deploy',
        },
      });
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('p1: succeeded (push lúc 14:00)');
      getStatusSpy.mockRestore();
    });

    it('/deploy <project> push invokes pushDeployNow and reports result', async () => {
      const pushSpy = vi.spyOn(ctx.service, 'pushDeployNow').mockResolvedValue({
        projectId: 'p1',
        status: 'succeeded',
        pushStatus: 'push lúc 14:30',
      });
      await bot.handleUpdate({
        update_id: 25,
        message: {
          message_id: 25,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/deploy p1 push',
        },
      });
      expect(pushSpy).toHaveBeenCalledWith('p1');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã đẩy p1 lên remote (push lúc 14:30)');
      pushSpy.mockRestore();
    });

    it('/deploy <project> push reports ❌ when commandRunner fails with code!=0', async () => {
      ctx.projectRepo.update('p1', {
        merge: JSON.stringify({ enabled: true, worktrees: { main: tmpDir } }),
      });
      config.deploy = {
        p1: {
          steps: [],
          timeoutSec: 2,
          restartHub: false,
          push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true },
        },
      };

      const failingRunner = vi.fn(async () => ({ code: 1, output: 'push rejected: failed' }));
      const deployService = new DeployService(
        config,
        ctx.projectRepo,
        ctx.scheduler.getEventBus(),
        0,
        failingRunner,
      );
      (deployService as unknown as { latest: Map<string, unknown> }).latest.set('p1', {
        projectId: 'p1',
        status: 'succeeded',
      });
      ctx.service.deployService = deployService;

      recordedCalls = [];
      await bot.handleUpdate({
        update_id: 26,
        message: {
          message_id: 26,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/deploy p1 push',
        },
      });
      expect(failingRunner).toHaveBeenCalled();
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls.length).toBeGreaterThan(0);
      const text = String(calls[calls.length - 1].body?.text);
      expect(text).toContain('❌');
      expect(text).toContain('Đẩy p1 thất bại');
      expect(text).toContain('exit 1');
      expect(text).not.toContain('✅');
    });
  });

  describe('4. Inline button callbacks', () => {
    let bot: TelegramBotService;
    const CHAT_ID = 12345;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: false }),
      });

      ctx.taskRepo.insert({
        id: 'p1/task-cb-rev',
        projectId: 'p1',
        slug: 'task-cb-rev',
        title: 'Task CB Review',
        body: '',
        status: 'review',
        level: 'easy',
        branch: 'task/cbrev',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'p1/task-cb-run',
        projectId: 'p1',
        slug: 'task-cb-run',
        title: 'Task CB Running',
        body: '',
        status: 'running',
        level: 'easy',
        branch: 'task/cbrun',
        baseRef: 'main',
      });

      bot = createTestBotService({ allowedChatIds: [CHAT_ID], execStdout: '2 files changed, 15 insertions(+)' });
    });

    it('cancel:confirm cancels task', async () => {
      await bot.handleUpdate({
        update_id: 30,
        callback_query: {
          id: 'cb-cancel',
          from: { id: CHAT_ID },
          message: {
            message_id: 30,
            chat: { id: CHAT_ID },
          },
          data: 'cancel:confirm:p1/task-cb-run',
        },
      });

      const task = ctx.taskRepo.get('p1/task-cb-run');
      expect(task?.status).toBe('cancelled');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã hủy task p1/task-cb-run');
    });

    it('review:approve approves task', async () => {
      await bot.handleUpdate({
        update_id: 31,
        callback_query: {
          id: 'cb-approve',
          from: { id: CHAT_ID },
          message: {
            message_id: 31,
            chat: { id: CHAT_ID },
          },
          data: 'review:approve:p1/task-cb-rev',
        },
      });

      const task = ctx.taskRepo.get('p1/task-cb-rev');
      expect(task?.status).toBe('done');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã duyệt task p1/task-cb-rev');
    });

    it('task:diff fetches diff summary', async () => {
      await bot.handleUpdate({
        update_id: 32,
        callback_query: {
          id: 'cb-diff',
          from: { id: CHAT_ID },
          message: {
            message_id: 32,
            chat: { id: CHAT_ID },
          },
          data: 'task:diff:p1/task-cb-rev',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Diff tóm tắt');
      expect(calls[0].body?.text).toContain('2 files changed, 15 insertions(+)');
    });

    it('task:resume resumes paused task', async () => {
      const resumeSpy = vi.spyOn(ctx.service, 'resumeTask').mockReturnValue({ ok: true, paused: false });
      await bot.handleUpdate({
        update_id: 35,
        callback_query: {
          id: 'cb-resume',
          from: { id: CHAT_ID },
          message: {
            message_id: 35,
            chat: { id: CHAT_ID },
          },
          data: 'task:resume:p1/task-cb-run',
        },
      });

      expect(resumeSpy).toHaveBeenCalledWith('p1/task-cb-run');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã tiếp tục task');
    });

    it('triage callback validates ids, enforces the allowed sender, and preserves colons in sourceId', async () => {
      const decideSpy = vi.spyOn(ctx.service, 'decideOpenProjectTicket').mockResolvedValue({ action: 'do', taskIds: ['p1/fix'] });
      await bot.handleUpdate({
        update_id: 36,
        callback_query: {
          id: 'cb-triage-valid', from: { id: CHAT_ID },
          message: { message_id: 36, chat: { id: CHAT_ID } },
          data: 'triage:do:customer:prod:42',
        },
      });
      expect(decideSpy).toHaveBeenCalledWith('customer:prod', 42, 'do');

      await bot.handleUpdate({
        update_id: 37,
        callback_query: {
          id: 'cb-triage-invalid', from: { id: CHAT_ID },
          message: { message_id: 37, chat: { id: CHAT_ID } },
          data: 'triage:do:customer:prod:not-a-number',
        },
      });
      expect(decideSpy).toHaveBeenCalledTimes(1);

      await bot.handleUpdate({
        update_id: 38,
        callback_query: {
          id: 'cb-triage-unauthorized', from: { id: 99999 },
          message: { message_id: 38, chat: { id: CHAT_ID } },
          data: 'triage:do:customer:prod:42',
        },
      });
      expect(decideSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. EventBus notifications and deduplication', () => {
    let bot: TelegramBotService;
    const CHAT_ID = 12345;

    beforeEach(() => {
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
      bot.start();
    });

    afterEach(async () => {
      await bot.stop();
    });

    it('broadcasts review_ready with inline keyboard', async () => {
      ctx.scheduler.getEventBus().emit('task.review_ready', 'p1/task-test', {
        title: 'Tính năng mới',
        checksPassed: true,
      });

      // Flush queue
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Task chờ review');
      expect(calls[0].body?.text).toContain('Tính năng mới');
      expect(calls[0].body?.text).toContain('Checks: ✓ Đạt');

      const markup = calls[0].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard[0][0].callback_data).toBe('review:approve:p1/task-test');
      expect(markup.inline_keyboard[0][1].callback_data).toBe('review:reject_prompt:p1/task-test');
      expect(markup.inline_keyboard[1][0].callback_data).toBe('task:diff:p1/task-test');
    });

    it('broadcasts triage decisions with safe action buttons and hides buttons after auto-dispatch', async () => {
      ctx.scheduler.getEventBus().emit('tracker.triage_ready', undefined, {
        sourceId: 'customer:prod', wpId: 42, displayId: 'OP-42', taskId: 'p1/op-op-42-triage',
        ticketUrl: 'https://op.test/work_packages/42',
        analysis: { conclusion: 'lỗi', size: 'lớn', summary: 'Cần chia việc' }, autoDispatch: false,
      });
      await bot.flushQueue(CHAT_ID);
      let call = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)!;
      const markup = call.body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
      const callbacks = markup.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
      expect(callbacks).toContain('triage:split:customer:prod:42');
      expect(String(call.body?.text)).toContain('Mở ticket');
      expect(String(call.body?.text)).toContain('Mở trên hub');

      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('tracker.triage_ready', undefined, {
        sourceId: 'customer:prod', wpId: 44, displayId: 'OP-44',
        analysis: { conclusion: 'việc thủ công', size: 'vừa', summary: 'Cần thao tác ngoài repo' }, autoDispatch: false,
      });
      await bot.flushQueue(CHAT_ID);
      call = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)!;
      const manualCallbacks = ((call.body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard).flat();
      expect(manualCallbacks[0].text).toContain('Tôi tự làm');
      expect(manualCallbacks.some((button) => button.text.includes('Làm + chia'))).toBe(false);

      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('tracker.triage_ready', undefined, {
        sourceId: 'customer:prod', wpId: 43, displayId: 'OP-43',
        analysis: { conclusion: 'lỗi', size: 'nhỏ', summary: 'Đã giao' }, autoDispatch: true,
      });
      await bot.flushQueue(CHAT_ID);
      call = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)!;
      expect(String(call.body?.text)).toContain('Đã tự giao');
      expect(call.body?.reply_markup).toBeUndefined();
    });

    it('sends a Telegram reply to the triage message as supplemental input', async () => {
      const inputSpy = vi.spyOn(ctx.service, 'submitOpenProjectTriageInput').mockResolvedValue({ taskId: 'p1/op-op-55-triage-r1' });
      ctx.scheduler.getEventBus().emit('tracker.triage_ready', undefined, {
        sourceId: 'customer:prod', wpId: 55, displayId: 'OP-55', taskId: 'p1/op-op-55-triage',
        analysis: { conclusion: 'thiếu thông tin', size: 'nhỏ', summary: 'Cần log' }, autoDispatch: false,
      });
      await bot.flushQueue(CHAT_ID);

      await bot.handleUpdate({
        update_id: 39,
        message: {
          message_id: 39,
          date: 1,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'log từ server khách hàng',
          reply_to_message: { message_id: 101, text: '🔎 [OP-55] Phân tích xong' },
        },
      });
      expect(inputSpy).toHaveBeenCalledWith('customer:prod', 55, 'log từ server khách hàng');
      expect(recordedCalls.some((call) => String(call.body?.text).includes('Đã tạo lượt triage bổ sung'))).toBe(true);
    });

    it('broadcasts task.failed and task.blocked with retry/log buttons', async () => {
      ctx.scheduler.getEventBus().emit('task.failed', 'p1/task-f', { title: 'Bị lỗi compile' });
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Task thất bại');
      expect(calls[0].body?.text).toContain('Bị lỗi compile');

      recordedCalls = [];
      currentTime += 15_000; // pass deduplication window
      ctx.scheduler.getEventBus().emit('task.blocked', 'p1/task-b', { title: 'Thiếu key' });
      await bot.flushQueue(CHAT_ID);

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Task bị chặn');
      expect(calls[0].body?.text).toContain('Thiếu key');
    });

    it('broadcasts task.pause_reminder with resume button', async () => {
      ctx.scheduler.getEventBus().emit('task.pause_reminder', 'p1/task-paused', {
        title: 'Task Đang Tạm Dừng',
        pausedMinutes: 35,
        reason: 'load',
      });
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Nhắc nhở: Tạm dừng (quá tải)');
      expect(calls[0].body?.text).toContain('p1/task-paused');
      expect(calls[0].body?.text).toContain('35 phút');

      const markup = calls[0].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard[0][0].callback_data).toBe('task:resume:p1/task-paused');
      expect(markup.inline_keyboard[0][0].text).toContain('Tiếp tục');
    });

    it('suppresses duplicate event notifications within 10 seconds', async () => {
      ctx.scheduler.getEventBus().emit('task.failed', 'p1/task-dedup', { title: 'Lỗi' });
      ctx.scheduler.getEventBus().emit('task.failed', 'p1/task-dedup', { title: 'Lỗi' });
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
    });

    it('sends an all-quota notification once until the blockage clears', async () => {
      const emit = () => ctx.scheduler.getEventBus().emit('quota.exhausted', undefined, { profile: 'g9', family: 'gemini-pro', allExhausted: true, time: '18:30' });
      emit();
      await bot.flushQueue(CHAT_ID);
      currentTime += 15 * 60_000;
      emit();
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);
      currentTime += 16 * 60_000;
      emit();
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);

      ctx.scheduler.getEventBus().emit('quota.cleared', undefined, { family: 'gemini-pro' });
      emit();
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(2);
    });

    it('broadcasts quota.exhausted and disk alerts', async () => {
      ctx.scheduler.getEventBus().emit('quota.exhausted', undefined, {
        profile: 'g1',
        family: 'gemini-pro',
        allExhausted: true,
        time: '18:30',
      });
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Hết sạch quota ở mọi tài khoản và model');
      expect(calls[0].body?.text).toContain('Hệ thống tạm dừng thực thi task.');

      // Repeated critical event does not send a duplicate broadcast
      recordedCalls = [];
      ctx.scheduler.getEventBus().emit('quota.exhausted', undefined, {
        profile: 'g1',
        family: 'gemini-pro',
        allExhausted: true,
      });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      // Recovery notification when quota is cleared and capacity restored
      ctx.profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
      ctx.quotaMarkRepo.clear('g1', 'gemini');
      ctx.quotaMarkRepo.clear('g1', 'claude');
      ctx.quotaMarkRepo.clear('g1', 'gpt');
      ctx.scheduler.getEventBus().emit('quota.cleared', undefined, { family: 'gemini' });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls.some((c) => c.body?.text?.includes('Có quota trở lại'))).toBe(true);

      recordedCalls = [];
      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { freeGB: 2, minFreeGB: 5 });
      await bot.flushQueue(CHAT_ID);

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Ổ đĩa thấp');
    });

    it('handles disk notifications with notify.disk toggle, waiting tasks list, 60m reminder, and recovery message', async () => {
      config.telegram.notify.fallback = false;
      config.telegram.notify.disk = true;

      ctx.projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: false }),
      });

      ctx.taskRepo.insert({ id: 'p1/t-alpha', projectId: 'p1', slug: 't-alpha', title: 'Task Alpha', status: 'waiting_quota', waitReason: 'disk', level: 'easy' });
      ctx.taskRepo.insert({ id: 'p1/t-beta', projectId: 'p1', slug: 't-beta', title: 'Task Beta', status: 'waiting_quota', waitReason: 'disk', level: 'easy' });

      recordedCalls = [];
      // 1. Sends when notify.fallback = false and notify.disk = true
      ctx.scheduler.getEventBus().emit('disk.low', undefined, {
        label: 'Worktrees',
        path: '/worktrees',
        freeGB: 1.4,
        minFreeGB: 1.5,
        cacheDir: '/cache',
        cacheBytes: 2 * 1024 ** 3,
      });
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = calls[0].body?.text;
      expect(text).toContain('💾 Hết dung lượng: Worktrees (/worktrees) còn 1.4 GB, cần 1.5 GB.');
      expect(text).toContain('2 task đang phải chờ: t-alpha, t-beta.');
      expect(text).toContain('Gợi ý: dọn thùng rác hoặc cache node_modules (/cache, 2.0 GB).');

      // 2. Throttled within 60 minutes
      recordedCalls = [];
      currentTime += 30 * 60_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Worktrees', path: '/worktrees', freeGB: 1.4, minFreeGB: 1.5 });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      // 3. Reminds after 60 minutes
      currentTime += 31 * 60_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Worktrees', path: '/worktrees', freeGB: 1.4, minFreeGB: 1.5 });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);

      // 4. Recovery message sent when prior blocking notification was sent
      recordedCalls = [];
      ctx.scheduler.getEventBus().emit('disk.ok', undefined, { freeGB: 10, minFreeGB: 1.5, resumedCount: 2 });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('✅ Đã đủ dung lượng, 2 task tiếp tục chạy');

      // 4b. Recovery with resumedCount = 0 resets state without sending recovery message
      recordedCalls = [];
      currentTime += 65 * 60_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Hub Home', path: '/home/hub', source: 'hub_home', freeGB: 0.5, minFreeGB: 1, isBlocking: true });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);

      recordedCalls = [];
      ctx.scheduler.getEventBus().emit('disk.ok', undefined, { freeGB: 5, minFreeGB: 1, resumedCount: 0 });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      currentTime += 5 * 60_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Hub Home', path: '/home/hub', source: 'hub_home', freeGB: 0.4, minFreeGB: 1, isBlocking: true });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);

      // 5. Does not send disk notifications when notify.disk = false
      config.telegram.notify.disk = false;
      recordedCalls = [];
      currentTime += 65 * 60_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Worktrees', path: '/worktrees', freeGB: 1.4, minFreeGB: 1.5 });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      ctx.scheduler.getEventBus().emit('disk.ok', undefined, { freeGB: 10, minFreeGB: 1.5, resumedCount: 2 });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('broadcasts recovery sequentially when multiple disks recover at different times', async () => {
      config.telegram.notify.disk = true;
      recordedCalls = [];

      // 1. Two separate disk blocking alerts
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Drive A', path: '/drive-a', freeGB: 0.5, minFreeGB: 3, isBlocking: true, tasks: ['t-a'] });
      await bot.flushQueue(CHAT_ID);
      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Drive A');

      recordedCalls = [];
      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Drive B', path: '/drive-b', freeGB: 0.5, minFreeGB: 3, isBlocking: true, tasks: ['t-b'] });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Drive B');

      // 2. Drive A recovers first (1 task resumed, 1 remaining)
      recordedCalls = [];
      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('disk.ok', undefined, { path: '/drive-a', freeGB: 10, minFreeGB: 3, resumedCount: 1, remainingCount: 1, tasks: ['t-a'] });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('✅ Đã đủ dung lượng, 1 task tiếp tục chạy');

      // 3. Drive B recovers afterwards (31m later, 1 task resumed, 0 remaining)
      recordedCalls = [];
      currentTime += 31 * 60_000;
      ctx.scheduler.getEventBus().emit('disk.ok', undefined, { path: '/drive-b', freeGB: 10, minFreeGB: 3, resumedCount: 1, remainingCount: 0, tasks: ['t-b'] });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('✅ Đã đủ dung lượng, 1 task tiếp tục chạy');
    });

    it('broadcasts a new blocking incident after partial recovery without 60m throttle', async () => {
      config.telegram.notify.disk = true;
      recordedCalls = [];

      // 1. Two separate disk blocking alerts
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Drive A', path: '/drive-a', freeGB: 0.5, minFreeGB: 3, isBlocking: true, tasks: ['t-a'] });
      await bot.flushQueue(CHAT_ID);
      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Drive A');

      recordedCalls = [];
      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Drive B', path: '/drive-b', freeGB: 0.5, minFreeGB: 3, isBlocking: true, tasks: ['t-b'] });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Drive B');

      // 2. Drive A recovers first (1 task resumed, 1 remaining)
      recordedCalls = [];
      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('disk.ok', undefined, { path: '/drive-a', freeGB: 10, minFreeGB: 3, resumedCount: 1, remainingCount: 1, tasks: ['t-a'] });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('✅ Đã đủ dung lượng, 1 task tiếp tục chạy');

      // 3. 5 minutes later, Drive A becomes low again (< 60m since first alert)
      recordedCalls = [];
      currentTime += 5 * 60_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Drive A', path: '/drive-a', freeGB: 0.4, minFreeGB: 3, isBlocking: true, tasks: ['t-a'] });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Drive A');

      // 4. Meanwhile Drive B emitting disk.low at 5m remains throttled
      recordedCalls = [];
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { label: 'Drive B', path: '/drive-b', freeGB: 0.5, minFreeGB: 3, isBlocking: true, tasks: ['t-b'] });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(0);
    });

    it('escapes HTML special characters in disk alert messages to prevent Telegram 400 errors', async () => {
      config.telegram.notify.disk = true;

      ctx.projectRepo.insert({
        id: 'p-html',
        name: 'Project HTML',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: false }),
      });

      ctx.taskRepo.insert({
        id: 'p-html/t-html',
        projectId: 'p-html',
        slug: '<t-html>&bad',
        title: 'Task <HTML> & Special',
        status: 'waiting_quota',
        waitReason: 'disk',
        level: 'easy',
      });

      recordedCalls = [];
      ctx.scheduler.getEventBus().emit('disk.low', undefined, {
        label: 'Worktrees <SSD> & Storage',
        path: '/mnt/<data>&storage',
        freeGB: 1.2,
        minFreeGB: 2.0,
        cacheDir: '/var/<cache>&npm',
        cacheBytes: 3 * 1024 ** 3,
      });
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = calls[0].body?.text as string;
      expect(text).toContain('Worktrees &lt;SSD&gt; &amp; Storage');
      expect(text).toContain('(/mnt/&lt;data&gt;&amp;storage)');
      expect(text).toContain('&lt;t-html&gt;&amp;bad');
      expect(text).toContain('(/var/&lt;cache&gt;&amp;npm, 3.0 GB)');
      expect(text).not.toContain('<SSD>');
      expect(text).not.toContain('<data>');
      expect(text).not.toContain('<t-html>');
      expect(text).not.toContain('<cache>');
    });

    it('reproduces 2026-11-03 incident: claude/gpt exhausted on all 4 agy profiles, gemini and codex remain -> no notification', async () => {
      // Setup 4 agy profiles and 1 codex profile
      for (const name of ['g3', 'g4', 'pa-gemini', 'g2']) {
        ctx.profileRepo.upsert({ name, engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
      }
      ctx.profileRepo.upsert({ name: 'codeX1', engine: 'codex', kind: 'codex', home: tmpDir, email: null, enabled: 1 });
      const future = Math.floor(currentTime / 1000) + 3600;
      for (const profile of ['g3', 'g4', 'pa-gemini', 'g2']) {
        ctx.quotaMarkRepo.mark(profile, 'claude', future);
        ctx.quotaMarkRepo.mark(profile, 'gpt', future);
      }
      recordedCalls = [];
      await bot.stop();
      bot.handleEvent('quota.exhausted', undefined, { profile: 'pa-gemini', family: 'claude', engine: 'agy', allExhausted: true });
      bot.handleEvent('quota.exhausted', undefined, { profile: 'pa-gemini', family: 'gpt', engine: 'agy', allExhausted: true });
      bot.handleEvent('claude.quota_exhausted', undefined, { fallbackAvailable: false, profileName: 'pa-gemini' });
      bot.handleEvent('review.fallback', 'p1/task-fb', { title: 'Task fallback review', from: 'codex', to: 'claude' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(0);
    });

    it('silences partial family exhaustion and only broadcasts critical outage when capacity is 0', async () => {
      await bot.stop();
      for (const name of ['p1', 'p2']) {
        ctx.profileRepo.upsert({ name, engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
      }
      ctx.profileRepo.upsert({ name: 'codeX1', engine: 'codex', kind: 'codex', home: tmpDir, email: null, enabled: 1 });
      const future = Math.floor(currentTime / 1000) + 3600;

      for (const profile of ['p1', 'p2']) {
        ctx.quotaMarkRepo.mark(profile, 'claude', future);
        ctx.quotaMarkRepo.mark(profile, 'gpt', future);
      }
      bot.handleEvent('quota.exhausted', undefined, { profile: 'p1', family: 'claude', engine: 'agy' });
      bot.handleEvent('quota.exhausted', undefined, { profile: 'p1', family: 'gpt', engine: 'agy' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(0);

      recordedCalls = [];
      for (const profile of ['p1', 'p2']) {
        for (const family of ['gemini', 'claude', 'gpt']) ctx.quotaMarkRepo.mark(profile, family, future);
      }
      ctx.quotaMarkRepo.mark('codeX1', 'codex', future);
      const outage = { profile: 'p2', family: 'gemini', engine: 'agy' };
      bot.handleEvent('quota.exhausted', undefined, outage);
      bot.handleEvent('quota.exhausted', undefined, outage);
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Hệ thống tạm dừng thực thi task');

      recordedCalls = [];
      for (const profile of ['p1', 'p2']) {
        for (const family of ['gemini', 'claude', 'gpt']) ctx.quotaMarkRepo.clear(profile, family);
      }
      ctx.quotaMarkRepo.clear('codeX1', 'codex');
      bot.handleEvent('quota.cleared', undefined, { family: 'gemini' });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls.some((c) => c.body?.text?.includes('Có quota trở lại'))).toBe(true);
    });

    it('silences claude.quota_exhausted when other models/engines remain available and notifies critical outage when empty', async () => {
      await bot.stop();
      for (const name of ['p1', 'p2']) {
        ctx.profileRepo.upsert({ name, engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
      }
      ctx.profileRepo.upsert({ name: 'codeX1', engine: 'codex', kind: 'codex', home: tmpDir, email: null, enabled: 1 });
      const future = Math.floor(currentTime / 1000) + 3600;

      for (const profile of ['p1', 'p2']) {
        ctx.quotaMarkRepo.mark(profile, 'claude', future);
      }
      recordedCalls = [];
      bot.handleEvent('claude.quota_exhausted', undefined, { fallbackAvailable: false, profileName: 'p1' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(0);

      // Now exhaust all remaining profiles/models:
      for (const profile of ['p1', 'p2']) {
        for (const family of ['gemini', 'gpt']) ctx.quotaMarkRepo.mark(profile, family, future);
      }
      ctx.quotaMarkRepo.mark('codeX1', 'codex', future);

      recordedCalls = [];
      bot.handleEvent('claude.quota_exhausted', undefined, { fallbackAvailable: false, profileName: 'p1' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await bot.flushQueue(CHAT_ID);

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Hết sạch quota ở mọi tài khoản và model');
      expect(calls[0].body?.text).not.toContain('Claude hết quota');
    });

    it('broadcasts task.waiting_quota only for no_department_profile with 30-minute dedupe', async () => {
      // 1. no_department_profile sends broadcast
      ctx.scheduler.getEventBus().emit('task.waiting_quota', 'p1/task-no-dept', {
        reason: 'no_department_profile',
        departmentId: 'chung',
        departmentName: 'Chung',
        message: 'Gán tài khoản cho phòng Chung hoặc bỏ gán',
      });
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Task đang chờ vì thiếu tài khoản');
      expect(calls[0].body?.text).toContain('Phòng: <b>Chung</b>');
      expect(calls[0].body?.text).toContain('Gán tài khoản cho phòng Chung hoặc bỏ gán');

      // 2. other wait reasons (e.g. no_matching_profile) must not broadcast
      recordedCalls = [];
      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('task.waiting_quota', 'p1/task-no-matching', {
        reason: 'no_matching_profile',
      });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      // 3. Deduplication: within 30 minutes, repeated no_department_profile event for same task does not broadcast
      currentTime += 10 * 60_000; // 10 minutes later
      ctx.scheduler.getEventBus().emit('task.waiting_quota', 'p1/task-no-dept', {
        reason: 'no_department_profile',
        departmentId: 'chung',
        departmentName: 'Chung',
        message: 'Gán tài khoản cho phòng Chung hoặc bỏ gán',
      });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      // 4. After 30 minutes (31 minutes later), broadcasts again
      currentTime += 21 * 60_000; // 31 minutes total
      ctx.scheduler.getEventBus().emit('task.waiting_quota', 'p1/task-no-dept', {
        reason: 'no_department_profile',
        departmentId: 'chung',
        departmentName: 'Chung',
        message: 'Gán tài khoản cho phòng Chung hoặc bỏ gán',
      });
      await bot.flushQueue(CHAT_ID);
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Task đang chờ vì thiếu tài khoản');
    });

    it('broadcasts task.waiting_quota with no_department_profile even when brain.mode is auto', async () => {
      config.brain.mode = 'auto';

      // 1. Other wait reasons are suppressed in auto mode
      ctx.scheduler.getEventBus().emit('task.waiting_quota', 'p1/task-no-match-auto', {
        reason: 'no_matching_profile',
      });
      await bot.flushQueue(CHAT_ID);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      // 2. no_department_profile configuration error bypasses auto mode suppression
      ctx.scheduler.getEventBus().emit('task.waiting_quota', 'p1/task-no-dept-auto', {
        reason: 'no_department_profile',
        departmentId: 'chung',
        departmentName: 'Chung',
        message: 'Gán tài khoản cho phòng Chung hoặc bỏ gán',
      });
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Task đang chờ vì thiếu tài khoản');
      expect(calls[0].body?.text).toContain('Phòng: <b>Chung</b>');
    });
  });

  describe('6. Claude chat bridge', () => {
    it('routes ordinary messages to one telegram:<chatId> session and supports /new and /stop', async () => {
      ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
      const bot = createTestBotService({ allowedChatIds: [321], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 1000, message: {
        message_id: 1000, date: 1, chat: { id: 321, type: 'private' }, text: 'Xin chào',
      } });
      await vi.waitFor(() => expect(ctx.chatSessionRepo.get('telegram:321')?.busy).toBe(0), { timeout: 10_000 });
      expect(ctx.chatMessageRepo.getBySession('telegram:321', 10).some((m) => m.content === 'Xin chào')).toBe(true);

      await bot.handleUpdate({ update_id: 1001, message: {
        message_id: 1001, date: 1, chat: { id: 321, type: 'private' }, text: '/new',
      } });
      const sessions = ctx.chatSessionRepo.getAll({ archived: null });
      expect(sessions.filter((session) => session.id.startsWith('telegram:321:'))).toHaveLength(1);

      await bot.handleUpdate({ update_id: 1002, message: {
        message_id: 1002, date: 1, chat: { id: 321, type: 'private' }, text: '/stop',
      } });
      expect(recordedCalls.some((call) => call.body?.text === '⏹ Đã dừng lượt chat hiện tại.')).toBe(true);
    });

    it('queues a message for a busy session and answers it in the same Telegram message afterwards', async () => {
      ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
      const bot = createTestBotService({ allowedChatIds: [321], chatService: ctx.chatService });
      // Start a long turn so the session is busy.
      await bot.handleUpdate({ update_id: 1100, message: {
        message_id: 1100, date: 1, chat: { id: 321, type: 'private' }, text: 'sleep',
      } });
      await vi.waitFor(() => expect(ctx.chatSessionRepo.get('telegram:321')?.busy).toBe(1), { timeout: 5_000 });

      await bot.handleUpdate({ update_id: 1101, message: {
        message_id: 1101, date: 1, chat: { id: 321, type: 'private' }, text: 'Tình hình thế nào?',
      } });
      await vi.waitFor(() => expect(recordedCalls.some((call) => typeof call.body?.text === 'string'
        && (call.body.text as string).includes('xếp hàng (thứ 1)'))).toBe(true));
      const queuedEdit = recordedCalls.find((call) => typeof call.body?.text === 'string' && (call.body.text as string).includes('xếp hàng'));
      const queuedMessageId = queuedEdit?.body?.message_id;
      expect(queuedMessageId).toBeDefined();

      // When the queued turn starts, its reply is attached to that placeholder message.
      const handleChatEvent = (type: string, payload: unknown) => (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void }).handleChatEvent(type, undefined, payload);
      handleChatEvent('chat.message', { sessionId: 'telegram:321', role: 'user', fromQueue: true, content: 'Tình hình thế nào?' });
      const replies = (bot as unknown as { chatReplies: Map<string, { messageId: number }> }).chatReplies;
      expect(replies.get('telegram:321')?.messageId).toBe(queuedMessageId);
      ctx.chatService.cancelSession('telegram:321');
    });

    it('keeps newlines, rate-limits progress edits, and splits long final replies', async () => {
      const bot = createTestBotService({ allowedChatIds: [321], chatService: ctx.chatService });
      const botAny = bot as unknown as { chatProgressText(text: string): string };
      expect(botAny.chatProgressText('a\nb')).toBe('a\nb');

      const editTimes: number[] = [];
      const originalFetch = fakeFetch;
      fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/editMessageText')) editTimes.push(currentTime);
        return originalFetch(input, init);
      }) as unknown as typeof fetch;
      (bot as unknown as { fetchFn: typeof fetch }).fetchFn = fakeFetch;

      (bot as unknown as { chatReplies: Map<string, unknown> }).chatReplies.set('telegram:321', {
        chatId: 321, messageId: 1010, text: '⏳ Đang xử lý…', lastEditAt: currentTime, editing: false,
      });
      const handleChatEvent = (type: string, payload: unknown) => (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void }).handleChatEvent(type, undefined, payload);
      handleChatEvent('chat.delta', { sessionId: 'telegram:321', text: 'x\ny' });
      handleChatEvent('chat.delta', { sessionId: 'telegram:321', text: 'z' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(editTimes.length).toBeLessThanOrEqual(1);

      const longText = 'x'.repeat(8_001);
      const chunks = (bot as unknown as { splitTelegramText(text: string): string[] }).splitTelegramText(longText);
      expect(chunks).toHaveLength(3);
      expect(chunks.every((chunk) => chunk.length).valueOf()).toBe(true);
    });

    it('renders permission buttons and sends the selected decision to ChatService', async () => {
      ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
      const bot = createTestBotService({ allowedChatIds: [321], chatService: ctx.chatService });
      await bot.handleUpdate({ update_id: 1020, message: {
        message_id: 1020, date: 1, chat: { id: 321, type: 'private' }, text: 'permission',
      } });
      const pendingPermission = ctx.chatService.permissionBroker.request({
        sessionId: 'telegram:321', messageId: null, toolName: 'Bash', input: { command: 'git status' },
      });
      const permissionId = ctx.chatPermissionRepo.listPending('telegram:321')[0].id;
      (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void }).handleChatEvent('chat.permission_request', undefined, {
        id: permissionId, sessionId: 'telegram:321', toolName: 'Bash', input: { command: 'git status' },
      });
      await vi.waitFor(() => expect(recordedCalls.some((call) => {
        const keyboard = call.body?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
        return keyboard?.inline_keyboard?.[0]?.some((button) => button.callback_data?.startsWith('permission:'));
      })).toBe(true), { timeout: 5_000 });

      await bot.handleUpdate({ update_id: 1021, callback_query: {
        id: 'callback-1', from: { id: 321 }, message: { message_id: 1, chat: { id: 321 }, text: 'echo x > file & <tag>' }, data: `permission:allow:${permissionId}`,
      } });
      expect(ctx.chatService.permissionBroker.get(permissionId)?.status).toBe('allow');
      const edited = recordedCalls.find((call) => call.url.includes('/editMessageText'));
      expect(edited?.body?.parse_mode).toBe('HTML');
      expect(edited?.body?.text).toContain('echo x &gt; file &amp; &lt;tag&gt;');
      ctx.chatService.stop();
      await pendingPermission;
    });
  });

  describe('7. HTTP API Endpoints for Telegram', () => {
    it('GET /api/telegram/pairing-code returns active code and remaining seconds', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/telegram/pairing-code',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.code).toMatch(/^\d{6}$/);
      expect(json.expiresInSec).toBeGreaterThan(0);
      expect(json.enabled).toBe(true);
      expect(Array.isArray(json.allowedChatIds)).toBe(true);

      const code1 = json.code;

      // Repeat GET returns identical unexpired code
      const res2 = await server.inject({
        method: 'GET',
        url: '/api/telegram/pairing-code',
        headers: authHeaders(),
      });
      expect(JSON.parse(res2.body).code).toBe(code1);

      // Refresh generates a new code
      const res3 = await server.inject({
        method: 'POST',
        url: '/api/telegram/pairing-code/refresh',
        headers: authHeaders(),
      });
      expect(res3.statusCode).toBe(200);
      expect(JSON.parse(res3.body).code).toMatch(/^\d{6}$/);
    });

    it('GET /api/telegram/status returns telegram configuration and token presence', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/telegram/status',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.enabled).toBe(true);
      expect(json.hasToken).toBe(true);
      expect(json.notify).toBeDefined();
    });
  });

  describe('8. Slug generation and collision handling', () => {
    it('slugify removes Vietnamese accents, converts to kebab-case, and handles fallback', () => {
      expect(slugify('Tạo task từ Telegram')).toBe('tao-task-tu-telegram');
      expect(slugify('Đăng nhập & xác thực 100%!')).toBe('dang-nhap-xac-thuc-100');
      expect(slugify('???')).toBe('task');
    });

    it('generateTaskSlug appends incremental counter when slug already exists', () => {
      ctx.projectRepo.insert({
        id: 'proj-1',
        name: 'Test Project',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });

      ctx.taskRepo.insert({
        id: 'proj-1/sua-loi-dang-nhap',
        projectId: 'proj-1',
        slug: 'sua-loi-dang-nhap',
        title: 'Sửa lỗi đăng nhập',
        level: 'easy',
        status: 'queued',
      });

      const nextSlug = generateTaskSlug('Sửa lỗi đăng nhập', 'proj-1', ctx.taskRepo);
      expect(nextSlug).toBe('sua-loi-dang-nhap-2');

      ctx.taskRepo.insert({
        id: 'proj-1/sua-loi-dang-nhap-2',
        projectId: 'proj-1',
        slug: 'sua-loi-dang-nhap-2',
        title: 'Sửa lỗi đăng nhập 2',
        level: 'easy',
        status: 'queued',
      });

      const thirdSlug = generateTaskSlug('Sửa lỗi đăng nhập', 'proj-1', ctx.taskRepo);
      expect(thirdSlug).toBe('sua-loi-dang-nhap-3');
    });
  });

  describe('9. /newtask command (wizard and quick format)', () => {
    const CHAT_ID = 555;
    let bot: TelegramBotService;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'proj-shop',
        name: 'E-Commerce Shop',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
    });

    it('completes full step-by-step wizard to create a queued task', async () => {
      // 1. Send /newtask
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask_detail',
        },
      });

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Chọn project cho task mới');
      const projKeyboard = calls[calls.length - 1].body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
      expect(projKeyboard.inline_keyboard[0][0].callback_data).toBe('newtask:proj:proj-shop');

      // 2. Select project
      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: 'cb-proj',
          from: { id: CHAT_ID },
          message: { message_id: 1, chat: { id: CHAT_ID } },
          data: 'newtask:proj:proj-shop',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Vui lòng nhập <b>tiêu đề</b>');

      // 3. Send title
      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 2,
          date: 123457,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Tích hợp cổng VNPay',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Nhập <b>đề bài</b> cho task');

      // 4. Send body message 1
      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 3,
          date: 123458,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Bước 1: Tạo URL thanh toán',
        },
      });

      // 5. Send body message 2
      await bot.handleUpdate({
        update_id: 5,
        message: {
          message_id: 4,
          date: 123459,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Bước 2: Xử lý IPN callback checksum',
        },
      });

      // 6. Send /done
      await bot.handleUpdate({
        update_id: 6,
        message: {
          message_id: 5,
          date: 123460,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/done',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Chọn <b>độ khó</b> cho task');

      // 7. Select level: hard
      await bot.handleUpdate({
        update_id: 7,
        callback_query: {
          id: 'cb-level',
          from: { id: CHAT_ID },
          message: { message_id: 5, chat: { id: CHAT_ID } },
          data: 'newtask:level:hard',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Chọn <b>model</b> cho task');

      // 8. Select default model
      await bot.handleUpdate({
        update_id: 8,
        callback_query: {
          id: 'cb-model',
          from: { id: CHAT_ID },
          message: { message_id: 5, chat: { id: CHAT_ID } },
          data: 'newtask:model:default',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const confirmText = calls[calls.length - 1].body?.text as string;
      expect(confirmText).toContain('Xác nhận tạo task');
      expect(confirmText).toContain('tich-hop-cong-vnpay');
      expect(confirmText).toContain('hard');

      // 9. Confirm: Giao ngay
      await bot.handleUpdate({
        update_id: 9,
        callback_query: {
          id: 'cb-confirm',
          from: { id: CHAT_ID },
          message: { message_id: 5, chat: { id: CHAT_ID } },
          data: 'newtask:confirm:queued',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Đã giao task');

      // Verify task in DB
      const createdTask = ctx.taskRepo.get('proj-shop/tich-hop-cong-vnpay');
      expect(createdTask).toBeDefined();
      expect(['queued', 'waiting_quota']).toContain(createdTask?.status);
      expect(createdTask?.level).toBe('hard');
      expect(createdTask?.title).toBe('Tích hợp cổng VNPay');
      expect(createdTask?.body).toContain('Bước 1: Tạo URL thanh toán');
      expect(createdTask?.body).toContain('Bước 2: Xử lý IPN callback checksum');
    });

    it('creates a draft task via quick one-line format and supports Giao ngay button', async () => {
      await bot.handleUpdate({
        update_id: 20,
        message: {
          message_id: 20,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask proj-shop Đăng xuất tài khoản | Xoá session cookie khi user bấm logout',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Đã tạo nháp task');
      expect(calls[calls.length - 1].body?.text).toContain('proj-shop/dang-xuat-tai-khoan');

      // Task is initially draft in DB
      let task = ctx.taskRepo.get('proj-shop/dang-xuat-tai-khoan');
      expect(task).toBeDefined();
      expect(task?.status).toBe('draft');
      expect(task?.body).toBe('Xoá session cookie khi user bấm logout');

      // User clicks Giao ngay
      await bot.handleUpdate({
        update_id: 21,
        callback_query: {
          id: 'cb-start-draft',
          from: { id: CHAT_ID },
          message: { message_id: 20, chat: { id: CHAT_ID } },
          data: `draft:start:${task!.id}`,
        },
      });

      task = ctx.taskRepo.get('proj-shop/dang-xuat-tai-khoan');
      expect(['queued', 'waiting_quota']).toContain(task?.status);
    });

    it('stores a leading external reference from the short description format', async () => {
      await bot.handleUpdate({
        update_id: 22,
        message: {
          message_id: 22,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask OP#123 Đăng xuất tài khoản',
        },
      });

      const task = ctx.taskRepo.get('proj-shop/dang-xuat-tai-khoan');
      expect(task?.externalRef).toBe('OP#123');
      expect(task?.title).toBe('Đăng xuất tài khoản');
      expect(task?.body).toBe('Đăng xuất tài khoản');
    });

    it('accepts free-form leading external references', async () => {
      await bot.handleUpdate({
        update_id: 23,
        message: {
          message_id: 23,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask ABC-foo Sửa lỗi đăng nhập',
        },
      });

      const task = ctx.taskRepo.get('proj-shop/sua-loi-dang-nhap');
      expect(task?.externalRef).toBe('ABC-foo');
      expect(task?.title).toBe('Sửa lỗi đăng nhập');
    });

    it('accepts structured and Unicode leading external references', async () => {
      await bot.handleUpdate({
        update_id: 24,
        message: {
          message_id: 24,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask ĐỀ-123 Cập nhật thanh toán',
        },
      });

      const vietnameseTask = ctx.taskRepo.get('proj-shop/cap-nhat-thanh-toan');
      expect(vietnameseTask?.externalRef).toBe('ĐỀ-123');
      expect(vietnameseTask?.title).toBe('Cập nhật thanh toán');

      await bot.handleUpdate({
        update_id: 25,
        message: {
          message_id: 25,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask 営業-1 Sửa nội dung bán hàng',
        },
      });

      const japaneseTask = ctx.taskRepo.get('proj-shop/sua-noi-dung-ban-hang');
      expect(japaneseTask?.externalRef).toBe('営業-1');
      expect(japaneseTask?.title).toBe('Sửa nội dung bán hàng');

      await bot.handleUpdate({
        update_id: 26,
        message: {
          message_id: 26,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask PROJ-45 Sửa giao diện thanh toán',
        },
      });

      const projTask = ctx.taskRepo.get('proj-shop/sua-giao-dien-thanh-toan');
      expect(projTask?.externalRef).toBe('PROJ-45');
      expect(projTask?.title).toBe('Sửa giao diện thanh toán');

      await bot.handleUpdate({
        update_id: 27,
        message: {
          message_id: 27,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask #abc Tối ưu hóa truy vấn',
        },
      });

      const markerTask = ctx.taskRepo.get('proj-shop/toi-uu-hoa-truy-van');
      expect(markerTask?.externalRef).toBe('#abc');
      expect(markerTask?.title).toBe('Tối ưu hóa truy vấn');
    });

    it('does not treat normal descriptions or trailing punctuation as external references', async () => {
      // Direct parser checks ensuring externalRef is undefined and text is preserved
      expect(bot['parseLeadingExternalRef']('Lỗi: không đăng nhập')).toEqual({ text: 'Lỗi: không đăng nhập' });
      expect(bot['parseLeadingExternalRef']('Hello, world')).toEqual({ text: 'Hello, world' });
      expect(bot['parseLeadingExternalRef']('1. Sửa login')).toEqual({ text: '1. Sửa login' });
      expect(bot['parseLeadingExternalRef']('Fix Login bug')).toEqual({ text: 'Fix Login bug' });
      expect(bot['parseLeadingExternalRef']('Add Dashboard page')).toEqual({ text: 'Add Dashboard page' });
      expect(bot['parseLeadingExternalRef']('sửa Login bug')).toEqual({ text: 'sửa Login bug' });
      expect(bot['parseLeadingExternalRef']('API timeout khi gọi')).toEqual({ text: 'API timeout khi gọi' });
      expect(bot['parseLeadingExternalRef']('GitHub Actions bị lỗi')).toEqual({ text: 'GitHub Actions bị lỗi' });
      expect(bot['parseLeadingExternalRef']('iPhone crash')).toEqual({ text: 'iPhone crash' });
      expect(bot['parseLeadingExternalRef']('README cần cập nhật')).toEqual({ text: 'README cần cập nhật' });

      // End-to-end task creation via bot
      await bot.handleUpdate({
        update_id: 281,
        message: {
          message_id: 281,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask Lỗi: không đăng nhập',
        },
      });
      const taskPunctuation = ctx.taskRepo.get('proj-shop/loi-khong-dang-nhap');
      expect(taskPunctuation?.externalRef).toBeNull();
      expect(taskPunctuation?.title).toBe('Lỗi: không đăng nhập');

      await bot.handleUpdate({
        update_id: 282,
        message: {
          message_id: 282,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask Hello, world',
        },
      });
      const taskComma = ctx.taskRepo.get('proj-shop/hello-world');
      expect(taskComma?.externalRef).toBeNull();
      expect(taskComma?.title).toBe('Hello, world');

      await bot.handleUpdate({
        update_id: 283,
        message: {
          message_id: 283,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask 1. Sửa login',
        },
      });
      const taskOrdinal = ctx.taskRepo.get('proj-shop/1-sua-login');
      expect(taskOrdinal?.externalRef).toBeNull();
      expect(taskOrdinal?.title).toBe('1. Sửa login');

      await bot.handleUpdate({
        update_id: 284,
        message: {
          message_id: 284,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask Fix Login bug',
        },
      });
      const taskFix = ctx.taskRepo.get('proj-shop/fix-login-bug');
      expect(taskFix?.externalRef).toBeNull();
      expect(taskFix?.title).toBe('Fix Login bug');

      await bot.handleUpdate({
        update_id: 285,
        message: {
          message_id: 285,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask Add Dashboard page',
        },
      });
      const taskAdd = ctx.taskRepo.get('proj-shop/add-dashboard-page');
      expect(taskAdd?.externalRef).toBeNull();
      expect(taskAdd?.title).toBe('Add Dashboard page');

      await bot.handleUpdate({
        update_id: 286,
        message: {
          message_id: 286,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask sửa Login bug',
        },
      });
      const taskSua = ctx.taskRepo.get('proj-shop/sua-login-bug');
      expect(taskSua?.externalRef).toBeNull();
      expect(taskSua?.title).toBe('sửa Login bug');

      await bot.handleUpdate({
        update_id: 287,
        message: {
          message_id: 287,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask API timeout khi gọi',
        },
      });
      const taskApi = ctx.taskRepo.get('proj-shop/api-timeout-khi-goi');
      expect(taskApi?.externalRef).toBeNull();
      expect(taskApi?.title).toBe('API timeout khi gọi');

      await bot.handleUpdate({
        update_id: 288,
        message: {
          message_id: 288,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask GitHub Actions bị lỗi',
        },
      });
      const taskGithub = ctx.taskRepo.get('proj-shop/github-actions-bi-loi');
      expect(taskGithub?.externalRef).toBeNull();
      expect(taskGithub?.title).toBe('GitHub Actions bị lỗi');
    });

    it('allows cancelling wizard via /cancel', async () => {
      await bot.handleUpdate({
        update_id: 30,
        message: {
          message_id: 30,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask',
        },
      });

      await bot.handleUpdate({
        update_id: 31,
        callback_query: {
          id: 'cb-proj',
          from: { id: CHAT_ID },
          message: { message_id: 30, chat: { id: CHAT_ID } },
          data: 'newtask:proj:proj-shop',
        },
      });

      // User types /cancel instead of title
      await bot.handleUpdate({
        update_id: 32,
        message: {
          message_id: 31,
          date: 123457,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/cancel',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Đã hủy thao tác.');
    });

    it('sends a concise description mentioning the project to Claude', async () => {
      const sendMessage = vi.spyOn(ctx.chatService, 'sendMessage').mockImplementation(() => ({
        userMessageId: 'user-message',
        assistantMessageId: 'assistant-message',
      }));
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 50, message: {
        message_id: 50, date: 1, chat: { id: CHAT_ID, type: 'private' },
        text: '/newtask Sửa checkout trong proj-shop',
      } });

      expect(sendMessage).toHaveBeenCalledWith('telegram:555', expect.stringContaining('Sửa checkout trong proj-shop'), { queueIfBusy: true });
      expect(sendMessage.mock.calls[0][1]).toContain('project "proj-shop"');
    });

    it('streams automatic task replies and forwards permission requests to Telegram', async () => {
      vi.spyOn(ctx.chatService, 'sendMessage').mockImplementation(() => ({
        userMessageId: 'user-message',
        assistantMessageId: 'assistant-message',
      }));
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 501, message: {
        message_id: 501, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: '/newtask Sửa checkout trong proj-shop',
      } });
      const handleChatEvent = (type: string, payload: Record<string, unknown>) =>
        (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void })
          .handleChatEvent(type, undefined, { sessionId: 'telegram:555', ...payload });

      handleChatEvent('chat.delta', { text: 'Đã tạo task proj-shop/checkout' });
      handleChatEvent('chat.permission_request', { id: 'permission-1', toolName: 'hub_create_task' });
      handleChatEvent('chat.done', {});
      await vi.waitFor(() => {
        const edits = recordedCalls.filter((call) => call.url.includes('/editMessageText'));
        expect(edits.some((call) => String(call.body?.text).includes('Đã tạo task proj-shop/checkout'))).toBe(true);
      });

      const messages = recordedCalls.filter((call) => call.url.includes('/sendMessage'));
      expect(messages.some((call) => String(call.body?.text).includes('Claude cần quyền'))).toBe(true);
    });

    it('asks for a project when the description is ambiguous, then sends the selected project to Claude', async () => {
      ctx.projectRepo.insert({ id: 'proj-api', name: 'API Service', path: tmpDir, defaultBranch: 'main', maxParallel: 2 });
      const sendMessage = vi.spyOn(ctx.chatService, 'sendMessage').mockImplementation(() => ({
        userMessageId: 'user-message',
        assistantMessageId: 'assistant-message',
      }));
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 51, message: {
        message_id: 51, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: '/newtask Sửa lỗi đăng nhập',
      } });
      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const keyboard = calls[calls.length - 1].body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
      expect(keyboard.inline_keyboard.map((row) => row[0].callback_data)).toContain('newtask:proj:proj-api');

      await bot.handleUpdate({ update_id: 52, callback_query: {
        id: 'cb-ambiguous-project', from: { id: CHAT_ID },
        message: { message_id: 51, chat: { id: CHAT_ID } }, data: 'newtask:proj:proj-api',
      } });
      expect(sendMessage).toHaveBeenCalledWith('telegram:555', expect.stringContaining('project "proj-api"'), { queueIfBusy: true });
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Đang nhờ Claude');
    });

    it('remembers a project selected before the description is entered', async () => {
      const sendMessage = vi.spyOn(ctx.chatService, 'sendMessage').mockImplementation(() => ({
        userMessageId: 'user-message',
        assistantMessageId: 'assistant-message',
      }));
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 54, message: {
        message_id: 54, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: '/newtask',
      } });
      await bot.handleUpdate({ update_id: 55, callback_query: {
        id: 'cb-project-first', from: { id: CHAT_ID },
        message: { message_id: 54, chat: { id: CHAT_ID } }, data: 'newtask:proj:proj-shop',
      } });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text).toContain('gửi một đoạn mô tả');

      await bot.handleUpdate({ update_id: 56, message: {
        message_id: 56, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: 'Cập nhật luồng thanh toán',
      } });
      expect(sendMessage).toHaveBeenCalledWith('telegram:555', expect.stringContaining('project "proj-shop"'), { queueIfBusy: true });
    });

    it('falls back to a word-bounded draft when Claude is unavailable', async () => {
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
      const description = 'Thiết kế một màn hình thanh toán mới với nhiều bước xác thực và hướng dẫn chi tiết cho người dùng';

      await bot.handleUpdate({ update_id: 57, message: {
        message_id: 57, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: `/newtask ${description}`,
      } });

      const draft = ctx.taskRepo.getAll().find((task) => task.projectId === 'proj-shop' && task.status === 'draft');
      expect(draft).toBeDefined();
      expect(draft?.title.length).toBeLessThanOrEqual(60);
      expect(draft?.title.endsWith('…')).toBe(true);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text).toContain('Đã lưu nháp từ mô tả');
    });

    it('creates a fallback draft on chat.error for the submitted automatic task turn', async () => {
      const sendMessage = vi.spyOn(ctx.chatService, 'sendMessage').mockImplementation(() => ({
        userMessageId: 'user-message',
        assistantMessageId: 'assistant-message',
      }));
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 58, message: {
        message_id: 58, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: '/newtask Không thể kết nối thanh toán',
      } });
      (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void }).handleChatEvent(
        'chat.error', undefined, { sessionId: 'telegram:555', message: 'quota' },
      );

      await vi.waitFor(() => expect(ctx.taskRepo.getAll().some((task) => task.status === 'draft')).toBe(true));
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it('does not create a fallback draft for a later chat.error after a successful automatic turn', async () => {
      vi.spyOn(ctx.chatService, 'sendMessage').mockImplementation(() => ({
        userMessageId: 'user-message',
        assistantMessageId: 'assistant-message',
      }));
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 59, message: {
        message_id: 59, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: '/newtask Cập nhật bộ lọc sản phẩm',
      } });
      const handleChatEvent = (type: string) => (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void })
        .handleChatEvent(type, undefined, { sessionId: 'telegram:555' });
      handleChatEvent('chat.done');
      handleChatEvent('chat.error');
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ctx.taskRepo.getAll().filter((task) => task.status === 'draft')).toHaveLength(0);
    });

    it('/newtask_detail still opens the old wizard', async () => {
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });

      await bot.handleUpdate({ update_id: 60, message: {
        message_id: 60, date: 1, chat: { id: CHAT_ID, type: 'private' }, text: '/newtask_detail',
      } });

      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text).toContain('Chọn project cho task mới');
    });
  });

  describe('10. /plan command and batch.created notifications', () => {
    const CHAT_ID = 666;
    let bot: TelegramBotService;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'proj-plan',
        name: 'Planning Project',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });
    });

    it('/plan routes prompt with hub_create_batch instruction to Claude chat session', async () => {
      await bot.handleUpdate({
        update_id: 40,
        message: {
          message_id: 40,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/plan proj-plan Thiết kế tính năng bình luận',
        },
      });

      const messages = ctx.chatMessageRepo.getBySession(`telegram:${CHAT_ID}`, 10);
      const planMsg = messages.find((m) => m.content.includes('hub_create_batch'));
      expect(planMsg).toBeDefined();
      expect(planMsg?.content).toContain('proj-plan');
      expect(planMsg?.content).toContain('Thiết kế tính năng bình luận');

      await vi.waitFor(() => expect(ctx.chatSessionRepo.get(`telegram:${CHAT_ID}`)?.busy).toBe(0), { timeout: 10_000 });
      ctx.chatService.stop();
    });

    it('batch.created event broadcasts summary with dispatch, dashboard, and discard buttons', async () => {
      const batch = ctx.service.createBatch({
        project: 'proj-plan',
        title: 'Đợt nâng cấp bảo mật',
        goal: 'Bảo mật API',
        tasks: [
          { slug: 'task-sec-1', title: 'Thêm rate limit' },
          { slug: 'task-sec-2', title: 'Kiểm tra CSRF', dependsOn: ['task-sec-1'] },
        ],
        createdBy: 'claude',
      });

      bot.handleEvent('batch.created', undefined, {
        batchId: batch.id,
        projectId: batch.projectId,
        title: batch.title,
        taskCount: batch.tasks.length,
        createdBy: 'claude',
      });

      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const batchCall = calls.find((c) => c.body?.text && (c.body.text as string).includes('Đợt nâng cấp bảo mật'));
      expect(batchCall).toBeDefined();
      const text = batchCall?.body?.text as string;
      expect(text).toContain('Đợt nâng cấp bảo mật');
      expect(text).toContain('2 task');
      expect(text).toContain('proj-plan/task-sec-1');
      expect(text).toContain('proj-plan/task-sec-2');
      expect(text).toContain('phụ thuộc: proj-plan/task-sec-1');

      const markup = batchCall?.body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
      expect(markup).toBeDefined();
      expect(markup.inline_keyboard[0][0].text).toContain('Giao cả đợt');
      expect(markup.inline_keyboard[0][0].callback_data).toBe(`batch:dispatch:${batch.id}`);
      expect(markup.inline_keyboard[0][1].text).toContain('Huỷ đợt');
      expect(markup.inline_keyboard[0][1].callback_data).toBe(`batch:discard:${batch.id}`);
      expect(markup.inline_keyboard[1][0].text).toContain('Xem trên dashboard');
      expect(markup.inline_keyboard[1][0].url).toContain(`/plans/${batch.id}`);

      // Test clicking Giao cả đợt
      await bot.handleUpdate({
        update_id: 41,
        callback_query: {
          id: 'cb-batch-dispatch',
          from: { id: CHAT_ID },
          message: { message_id: 100, chat: { id: CHAT_ID } },
          data: `batch:dispatch:${batch.id}`,
        },
      });

      const updatedBatch = ctx.service.getBatch(batch.id);
      expect(updatedBatch.status).toBe('dispatched');
      const t1 = ctx.taskRepo.get('proj-plan/task-sec-1');
      const t2 = ctx.taskRepo.get('proj-plan/task-sec-2');
      expect(['queued', 'waiting_quota']).toContain(t1?.status);
      expect(['queued', 'waiting_quota']).toContain(t2?.status);
    });

    it('batch:discard callback cancels draft tasks and marks batch as discarded', async () => {
      const batch = ctx.service.createBatch({
        project: 'proj-plan',
        title: 'Đợt thử nghiệm huỷ',
        tasks: [{ slug: 'task-disc-1', title: 'Task huỷ' }],
        createdBy: 'claude',
      });

      await bot.handleUpdate({
        update_id: 42,
        callback_query: {
          id: 'cb-batch-discard',
          from: { id: CHAT_ID },
          message: { message_id: 101, chat: { id: CHAT_ID } },
          data: `batch:discard:${batch.id}`,
        },
      });

      const updatedBatch = ctx.service.taskBatchRepo?.get(batch.id);
      expect(updatedBatch?.status).toBe('discarded');
      const t = ctx.taskRepo.get('proj-plan/task-disc-1');
      expect(t?.status).toBe('cancelled');
    });
  });

  describe('11. /drafts command', () => {
    const CHAT_ID = 777;
    let bot: TelegramBotService;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'proj-drafts',
        name: 'Drafts Project',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
    });

    it('reports empty message when no drafts exist', async () => {
      await bot.handleUpdate({
        update_id: 50,
        message: {
          message_id: 50,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/drafts',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Hiện không có task hoặc đợt nháp nào');
    });

    it('lists draft batches and draft tasks with interactive buttons', async () => {
      // Create draft batch
      ctx.service.createBatch({
        project: 'proj-drafts',
        title: 'Đợt nháp 1',
        tasks: [{ slug: 'task-in-batch', title: 'Task in batch' }],
      });

      // Create standalone draft task
      const draftTask = ctx.service.createTask({
        project: 'proj-drafts',
        slug: 'task-standalone',
        title: 'Task standalone',
        start: false,
      });

      await bot.handleUpdate({
        update_id: 51,
        message: {
          message_id: 51,
          date: 123457,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/drafts',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const text = calls[calls.length - 1].body?.text as string;
      expect(text).toContain('Danh sách bản nháp');
      expect(text).toContain('Đợt nháp');
      expect(text).toContain('Đợt nháp 1');
      expect(text).toContain('task-standalone');

      const markup = calls[calls.length - 1].body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
      expect(markup).toBeDefined();

      // Find delete button for draft task and click it
      await bot.handleUpdate({
        update_id: 52,
        callback_query: {
          id: 'cb-del-draft',
          from: { id: CHAT_ID },
          message: { message_id: 51, chat: { id: CHAT_ID } },
          data: `draft:delete:${draftTask.id}`,
        },
      });

      // Verify task deleted from DB
      expect(ctx.taskRepo.get(draftTask.id)).toBeUndefined();
    });
  });
});

describe('Telegram gửi lỗi mạng không làm sập daemon', () => {
  it('sendMessage bị từ chối nhưng không thành unhandled rejection khi gọi kiểu fire-and-forget', async () => {
    const { TelegramBotService } = await import('../src/telegram.js');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const svc = Object.create(TelegramBotService.prototype) as InstanceType<typeof TelegramBotService> & Record<string, unknown>;
    Object.assign(svc, {
      chatQueues: new Map(), chatProcessing: new Map(), chatLastSent: new Map(),
      now: () => Date.now(), sleepFn: async () => {},
      sendDirectMessage: async () => { throw new Error('Telegram sendMessage request failed: fetch failed'); },
    });
    void svc.sendMessage(1, 'hello');
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toHaveLength(0);
  });
});

describe('Brain Notifications & Digest (b-brain-notify)', () => {
  let tmpDir: string;
  let ctx: TestContext;
  let config: ReturnType<typeof loadConfig>;
  let recordedCalls: Array<{ url: string; body?: Record<string, unknown> }>;
  let fakeFetch: typeof fetch;
  const CHAT_ID = 998877;
  let currentTime = 1_000_000;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-notify-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    config = loadConfig(tmpDir);
    config.telegram.enabled = true;
    config.telegram.allowedChatIds = [CHAT_ID];
    config.port = 4321;

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();
    ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
    currentTime = new Date('2026-10-21T10:00:00Z').getTime();

    recordedCalls = [];
    fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      let bodyObj: Record<string, unknown> | undefined;
      if (init?.body && typeof init.body === 'string') {
        try {
          bodyObj = JSON.parse(init.body);
        } catch {
          // ignore
        }
      }
      recordedCalls.push({ url: urlStr, body: bodyObj });

      if (urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { id: 123456, is_bot: true, first_name: 'AgentHubBot', username: 'agenthub_bot' } }));
      }
      if (urlStr.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: recordedCalls.length, chat: { id: CHAT_ID } } }));
      }
      if (urlStr.includes('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 123, chat: { id: CHAT_ID } } }));
      }
      if (urlStr.includes('/answerCallbackQuery')) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    ctx.chatService.stop();
    closeContext(ctx);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  function createBot(brainMode: 'off' | 'suggest' | 'auto' = 'suggest') {
    config.brain.mode = brainMode;
    return new TelegramBotService({
      config,
      service: ctx.service,
      eventBus: ctx.scheduler.getEventBus(),
      taskRepo: ctx.taskRepo,
      projectRepo: ctx.projectRepo,
      departmentRepo: ctx.departmentRepo,
      profileRepo: ctx.profileRepo,
      quotaMarkRepo: ctx.quotaMarkRepo,
      fetch: fakeFetch,
      now: () => currentTime,
      sleep: async () => {},
      sleepFn: async () => {},
      tokenOverride: 'test-token',
      chatService: ctx.chatService,
    });
  }

  it('task.done vẫn báo khi brain.mode = auto, và báo "hết task" khi project không còn task đang chạy', async () => {
    ctx.projectRepo.insert({ id: 'pd', name: 'Dự án D', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    ctx.taskRepo.insert({ id: 'pd/t-1', projectId: 'pd', slug: 't-1', title: 'Việc một', body: '', level: 'easy', status: 'done' });
    ctx.taskRepo.insert({ id: 'pd/t-2', projectId: 'pd', slug: 't-2', title: 'Việc hai', body: '', level: 'easy', status: 'running' });
    const bot = createBot('auto');

    bot.handleEvent('task.done', 'pd/t-1', { by: 'codex', verdict: 'approved' });
    await bot.flushQueue(CHAT_ID);
    let sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].body?.text).toContain('Task hoàn thành');
    expect(sends[0].body?.text).toContain('Việc một');
    expect(sends[0].body?.text).toContain('codex');

    ctx.taskRepo.update('pd/t-2', { status: 'done' });
    bot.handleEvent('task.done', 'pd/t-2', undefined);
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(3);
    expect(sends[1].body?.text).toContain('Việc hai');
    expect(sends[2].body?.text).toContain('Dự án D đã hết task');
    expect(sends[2].body?.text).toContain('2 task đã hoàn thành');

    // Project rỗng rồi lại rỗng: không báo "hết task" lặp lại nếu chưa có task mới chạy
    currentTime += 60_000;
    bot.handleEvent('task.done', 'pd/t-1', { again: true });
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends.filter((c) => String(c.body?.text).includes('đã hết task'))).toHaveLength(1);
  });

  it('task.cancelled và các sự kiện ngắt task vẫn báo trong auto mode, kèm lý do và người hủy', async () => {
    ctx.projectRepo.insert({ id: 'pc', name: 'PC', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    ctx.taskRepo.insert({ id: 'pc/t-1', projectId: 'pc', slug: 't-1', title: 'Việc bị hủy', body: '', level: 'easy', status: 'cancelled' });
    ctx.taskRepo.insert({ id: 'pc/t-2', projectId: 'pc', slug: 't-2', title: 'Việc lặp', body: '', level: 'easy', status: 'running' });
    const bot = createBot('auto');

    bot.handleEvent('task.cancelled', 'pc/t-1', { reason: 'Trùng với T52', by: 'mcp', previousStatus: 'queued' });
    bot.handleEvent('task.looping', 'pc/t-2', { command: 'npm test', count: 5 });
    bot.handleEvent('task.timeout', 'pc/t-2', undefined);
    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(3);
    expect(sends[0].body?.text).toContain('Task bị hủy');
    expect(sends[0].body?.text).toContain('Trùng với T52');
    expect(sends[0].body?.text).toContain('mcp');
    expect(sends[1].body?.text).toContain('lặp lệnh');
    expect(sends[1].body?.text).toContain('npm test');
    expect(sends[2].body?.text).toContain('quá thời gian');

    config.telegram.notify.interrupted = false;
    bot.handleEvent('task.cancelled', 'pc/t-2', { reason: 'x', by: 'y' });
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(3);
  });

  it('tắt notify.taskDone và notify.projectIdle thì task.done bị chặn trong auto mode như trước', async () => {
    ctx.projectRepo.insert({ id: 'pq', name: 'PQ', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    ctx.taskRepo.insert({ id: 'pq/t-1', projectId: 'pq', slug: 't-1', title: 'Xong', body: '', level: 'easy', status: 'done' });
    config.telegram.notify.taskDone = false;
    config.telegram.notify.projectIdle = false;
    const bot = createBot('auto');
    bot.handleEvent('task.done', 'pq/t-1', undefined);
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
  });

  it('1. khi brain.mode = auto: chan cac thong bao tho theo tung task, chi gui hub_notify va su co he thong', async () => {
    const bot = createBot('auto');

    // Emit raw task events: should all be suppressed
    bot.handleEvent('task.review_ready', 'p/t-1', { title: 'T1' });
    bot.handleEvent('task.failed', 'p/t-2', { title: 'T2' });
    bot.handleEvent('task.blocked', 'p/t-3', { title: 'T3' });
    bot.handleEvent('batch.created', undefined, { taskCount: 2 });
    // Single profile quota exhausted when other profiles exist -> suppressed
    ctx.profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    ctx.profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    ctx.quotaMarkRepo.mark('p1', 'gemini', Math.floor(currentTime / 1000) + 3600);
    bot.handleEvent('quota.exhausted', undefined, { profile: 'p1', family: 'gemini' });

    await bot.flushQueue(CHAT_ID);
    let sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(0);

    // Allowed: brain.notify
    bot.handleEvent('brain.notify', undefined, { text: 'Bộ não đã hoàn tất lượt chạy', level: 'info' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body?.text).toContain('Bộ não đã hoàn tất lượt chạy');

    // Allowed: disk.low
    bot.handleEvent('disk.low', undefined, { freeGB: 1, minFreeGB: 3 });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1].body?.text).toContain('Ổ đĩa thấp');

    // Allowed: moi tai khoan het quota
    ctx.quotaMarkRepo.mark('p2', 'gemini', Math.floor(currentTime / 1000) + 3600);
    ctx.quotaMarkRepo.mark('p1', 'claude', Math.floor(currentTime / 1000) + 3600);
    ctx.quotaMarkRepo.mark('p2', 'claude', Math.floor(currentTime / 1000) + 3600);
    ctx.quotaMarkRepo.mark('p1', 'gpt', Math.floor(currentTime / 1000) + 3600);
    ctx.quotaMarkRepo.mark('p2', 'gpt', Math.floor(currentTime / 1000) + 3600);
    bot.handleEvent('quota.exhausted', undefined, { profile: 'p2', family: 'gemini' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(3);
    expect(sendCalls[2].body?.text).toContain('Hết sạch quota ở mọi tài khoản và model');
  });

  it('lọc thông báo thô theo brain mode hiệu lực của từng project', async () => {
    ctx.projectRepo.insert({ id: 'p1', name: 'P1', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1, settings: JSON.stringify({ brain: { mode: 'auto' } }) });
    ctx.projectRepo.insert({ id: 'p2', name: 'P2', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    const bot = createBot('suggest');

    bot.handleEvent('task.review_ready', 'p1/task', { title: 'P1 task' });
    bot.handleEvent('task.review_ready', 'p2/task', { title: 'P2 task' });
    await bot.flushQueue(CHAT_ID);
    let sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].body?.text).toContain('P2 task');

    ctx.projectRepo.update('p2', { settings: JSON.stringify({ brain: { mode: 'suggest' } }) });
    config.brain.mode = 'auto';
    bot.handleEvent('task.failed', 'p1/failed', { title: 'P1 failed' });
    bot.handleEvent('task.failed', 'p2/failed', { title: 'P2 failed' });
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(2);
    expect(sends[1].body?.text).toContain('P2 failed');
  });

  it('silences review.fallback khi còn quota và chỉ thông báo một lần cho mỗi task khi hết sạch ("Codex hết quota, Claude đang duyệt …")', async () => {
    ctx.profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    const bot = createBot('suggest');

    // 1. Khi còn quota (p1 agy runnable): không thông báo Telegram
    bot.handleEvent('review.fallback', 'p1/task-fb', { title: 'Task fallback review', from: 'codex', to: 'claude', profile: 'claude-1' });
    await bot.flushQueue(CHAT_ID);
    let sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(0);

    // 2. Khi runnableCapacity rỗng (hết sạch): thông báo một lần cho task
    const future = Math.floor(currentTime / 1000) + 3600;
    for (const family of ['gemini', 'claude', 'gpt']) ctx.quotaMarkRepo.mark('p1', family, future);
    bot.handleEvent('review.fallback', 'p1/task-fb', { title: 'Task fallback review', from: 'codex', to: 'claude', profile: 'claude-1', allExhausted: true });
    await bot.flushQueue(CHAT_ID);

    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].body?.text).toContain('Codex hết quota, Claude đang duyệt …');
    expect(sends[0].body?.text).toContain('Task fallback review');

    // Subsequent review.fallback event for the same task is deduplicated (not sent again)
    bot.handleEvent('review.fallback', 'p1/task-fb', { title: 'Task fallback review', from: 'codex', to: 'claude', profile: 'claude-1', allExhausted: true });
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);

    // Another task gets its notification when allExhausted
    bot.handleEvent('review.fallback', 'p1/task-fb-2', { title: 'Task 2', from: 'codex', to: 'claude', allExhausted: true });
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(2);
    expect(sends[1].body?.text).toContain('Task 2');
  });

  it('2. gio yen tinh notifications.quietHours: chi gui level incident, tin khac don lai', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    const quietDate = new Date();
    quietDate.setHours(23, 45, 0, 0);
    currentTime = quietDate.getTime(); // inside quiet hours

    const bot = createBot('suggest');

    // Info and normal events are deferred
    bot.handleEvent('brain.notify', undefined, { text: 'Tin thuong', level: 'info' });
    bot.handleEvent('task.review_ready', 'p/t-1', { title: 'Review ready' });
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    expect(bot.getQuietHoursQueue().length).toBeGreaterThanOrEqual(1);

    // Incident event is sent immediately
    bot.handleEvent('brain.notify', undefined, { text: 'Su co nghiem trong', level: 'incident' });
    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].body?.text).toContain('Su co nghiem trong');
  });

  it('3. tin decision luon co nut (Dong y / Khong / Xem dashboard) va phan hoi callback', async () => {
    const bot = createBot('suggest');

    bot.handleEvent('brain.notify', undefined, {
      decisionId: 'dec-123',
      text: 'Bạn có đồng ý merge đợt task này không?',
      level: 'decision',
    });
    await bot.flushQueue(CHAT_ID);

    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);
    const msg = sends[0].body;
    expect(msg?.text).toContain('Bạn có đồng ý merge đợt task này không?');

    const markup = msg?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
    expect(markup).toBeDefined();
    expect(markup.inline_keyboard[0][0].text).toContain('Đồng ý');
    expect(markup.inline_keyboard[0][0].callback_data).toBe('decision:agree:dec-123');
    expect(markup.inline_keyboard[0][1].text).toContain('Không');
    expect(markup.inline_keyboard[0][1].callback_data).toBe('decision:reject:dec-123');
    expect(markup.inline_keyboard[1][0].text).toContain('Xem dashboard');

    const getOrCreateSpy = vi.spyOn(ctx.chatService, 'getOrCreateSession');
    const sendSpy = vi.spyOn(ctx.chatService, 'sendMessage').mockReturnValue({
      userMessageId: 'u-1',
      assistantMessageId: 'a-1',
    });

    // Click Đồng ý
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb-1',
        from: { id: CHAT_ID },
        message: { message_id: 10, chat: { id: CHAT_ID }, text: msg?.text as string },
        data: 'decision:agree:dec-123',
      },
    });

    const edits = recordedCalls.filter((c) => c.url.includes('/editMessageText'));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[0].body?.text).toContain('Đã phản hồi: Đồng ý');

    // getOrCreateSession called with kind: 'brain'
    expect(getOrCreateSpy).toHaveBeenCalledWith('brain', { title: 'Bộ não', kind: 'brain' });

    // Message sent to brain session
    expect(sendSpy).toHaveBeenCalledWith(
      'brain',
      'Người dùng trả lời quyết định dec-123 («Bạn có đồng ý merge đợt task này không?»): Đồng ý',
      { queueIfBusy: true },
    );

    // Tracker marks decision as answered
    const decision = bot.getDecisionTracker().getDecision('dec-123');
    expect(decision?.answered).toBe(true);
    expect(decision?.answer).toBe('agree');

    // Click again: should report expired or already answered
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb-2',
        from: { id: CHAT_ID },
        message: { message_id: 10, chat: { id: CHAT_ID }, text: msg?.text as string },
        data: 'decision:agree:dec-123',
      },
    });
    const ansCalls = recordedCalls.filter((c) => c.url.includes('/answerCallbackQuery'));
    const lastAns = ansCalls.at(-1);
    expect(lastAns?.body?.text).toContain('Quyết định đã hết hạn hoặc đã trả lời');

    // Click non-existent decision
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb-3',
        from: { id: CHAT_ID },
        message: { message_id: 10, chat: { id: CHAT_ID }, text: msg?.text as string },
        data: 'decision:agree:non-existent',
      },
    });
    const lastAnsNonExistent = recordedCalls.filter((c) => c.url.includes('/answerCallbackQuery')).at(-1);
    expect(lastAnsNonExistent?.body?.text).toContain('Quyết định đã hết hạn hoặc đã trả lời');
  });

  it('4. nhac lai tin decision sau 2 gio neu chua tra loi (toi da 2 lan)', async () => {
    const bot = createBot('suggest');

    bot.handleEvent('brain.notify', undefined, {
      decisionId: 'dec-remind',
      text: 'Xác nhận xóa tài khoản cũ?',
      level: 'decision',
    });
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);

    // 1 hour later: no reminder
    currentTime += 1 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);

    // 2 hours later (total 2h from start): Reminder 1 sent
    currentTime += 1 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    let sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(2);
    expect(sends[1].body?.text).toContain('Nhắc lại quyết định (lần 1/2)');

    // Another 2 hours later: Reminder 2 sent
    currentTime += 2 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(3);
    expect(sends[2].body?.text).toContain('Nhắc lại quyết định (lần 2/2)');

    // Another 2 hours later: No reminder 3 (max 2 times)
    currentTime += 2 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(3);
  });

  it('5. lenh /digest hien thi tom tat day du so lieu va quota', async () => {
    const bot = createBot('suggest');

    ctx.projectRepo.insert({
      id: 'p',
      name: 'Project P',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({ id: 'p/done-1', projectId: 'p', slug: 'done-1', title: 'Task xong', status: 'done' });
    ctx.taskRepo.insert({ id: 'p/run-1', projectId: 'p', slug: 'run-1', title: 'Task chay', status: 'running' });
    ctx.taskRepo.insert({ id: 'p/fail-1', projectId: 'p', slug: 'fail-1', title: 'Task loi', status: 'failed' });
    ctx.profileRepo.upsert({ name: 'agy-1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });

    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 20, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/digest' },
    });
    await bot.flushQueue(CHAT_ID);

    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends.length).toBeGreaterThan(0);
    const text = sends.at(-1)?.body?.text as string;
    expect(text).toContain('TÓM TẮT HỆ THỐNG AGENTHUB');
    expect(text).toContain('Hoàn thành: <b>1</b>');
    expect(text).toContain('Đang chạy: <b>1</b>');
    expect(text).toContain('Lỗi: <b>1</b>');
    expect(text).toContain('Quota tài khoản:');
  });

  it('6. checkScheduledDigest phat tin luc 18:00', async () => {
    config.brain.digest = { enabled: true, time: '18:00' };
    const digestDate = new Date();
    digestDate.setHours(18, 0, 0, 0);
    currentTime = digestDate.getTime();

    const bot = createBot('suggest');
    const triggered = await bot.checkScheduledDigest();
    expect(triggered).toBe(true);

    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0].body?.text).toContain('TÓM TẮT HỆ THỐNG AGENTHUB');

    // Running again in the same day doesn't double-trigger
    const secondTrigger = await bot.checkScheduledDigest();
    expect(secondTrigger).toBe(false);
  });

  it('7. checkScheduledDigest van gui khi bo lo dung phut (vi du chay luc 18:05)', async () => {
    config.brain.digest = { enabled: true, time: '18:00' };
    const digestDate = new Date();
    digestDate.setHours(18, 5, 0, 0); // 18:05 instead of exact 18:00
    currentTime = digestDate.getTime();

    const bot = createBot('suggest');
    const triggered = await bot.checkScheduledDigest();
    expect(triggered).toBe(true);

    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0].body?.text).toContain('TÓM TẮT HỆ THỐNG AGENTHUB');

    // Running again in the same day doesn't double-trigger
    const secondTrigger = await bot.checkScheduledDigest();
    expect(secondTrigger).toBe(false);
  });

  it('8. khong gui nhac nho decision trong gio yen tinh', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    const nightDate = new Date();
    nightDate.setHours(23, 0, 0, 0);
    currentTime = nightDate.getTime();

    const bot = createBot('suggest');
    // Pre-record a decision that was created 3 hours ago
    const tracker = bot.getDecisionTracker();
    tracker.recordDecision('dec-night', 'Quyết định đêm', [CHAT_ID], currentTime - 3 * 3600 * 1000);

    // Should be due for reminder, but since it's quiet hours, checkDecisionReminders should suppress
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);

    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(0);
  });

  it('9. decision trong gio yen tinh duoc ghi nhan vao tracker va gui kem nut trong tom tat sang', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    const nightDate = new Date();
    nightDate.setHours(23, 30, 0, 0);
    currentTime = nightDate.getTime();

    const bot = createBot('suggest');
    bot.handleEvent('brain.notify', undefined, {
      decisionId: 'dec-in-night',
      text: 'Xác nhận migrate database?',
      level: 'decision',
    });
    await bot.flushQueue(CHAT_ID);

    // In quiet hours: no message sent immediately
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

    // Decision IS recorded in tracker
    const dec = bot.getDecisionTracker().getDecision('dec-in-night');
    expect(dec).toBeDefined();
    expect(dec?.text).toBe('Xác nhận migrate database?');
    expect(dec?.answered).toBe(false);

    // Advance time to 07:00 (quiet hours ended)
    const morningDate = new Date();
    morningDate.setHours(7, 0, 0, 0);
    currentTime = morningDate.getTime();

    const triggered = await bot.checkMorningSummary();
    expect(triggered).toBe(true);

    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends.length).toBeGreaterThan(0);
    const morningMsg = sends[0].body;
    expect(morningMsg?.text).toContain('TÓM TẮT BUỔI SÁNG AGENTHUB');
    expect(morningMsg?.text).toContain('Xác nhận migrate database?');

    const markup = morningMsg?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
    expect(markup).toBeDefined();
    expect(markup.inline_keyboard[0][0].text).toContain('Đồng ý');
    expect(markup.inline_keyboard[0][0].callback_data).toBe('decision:agree:dec-in-night');
    expect(markup.inline_keyboard[0][1].text).toContain('Không');
    expect(markup.inline_keyboard[0][1].callback_data).toBe('decision:reject:dec-in-night');

    // Queue is cleared after morning summary
    expect(bot.getQuietHoursQueue()).toHaveLength(0);

    // Running again today does not re-send
    const again = await bot.checkMorningSummary();
    expect(again).toBe(false);
  });

  it('10. hang doi quietHoursQueue bi gioi han toi da 200 muc', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    const nightDate = new Date();
    nightDate.setHours(23, 0, 0, 0);
    currentTime = nightDate.getTime();

    const bot = createBot('suggest');
    for (let i = 1; i <= 250; i++) {
      bot.handleEvent('brain.notify', undefined, {
        text: `Thông báo thứ ${i}`,
        level: 'info',
      });
    }

    const queue = bot.getQuietHoursQueue();
    expect(queue.length).toBe(200);
    expect(queue[0].text).toContain('Thông báo thứ 51');
    expect(queue[199].text).toContain('Thông báo thứ 250');
  });

  it('11. restart gia lap (tao service moi voi now = 15:00) khong gui tom tat sang hoac digest', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    config.brain.digest = { enabled: true, time: '18:00' };

    const restartDate = new Date();
    restartDate.setHours(15, 0, 0, 0);
    currentTime = restartDate.getTime();

    // Create a new bot instance at 15:00 (simulating hub restart)
    const bot = createBot('suggest');

    // Add a pending decision created just now
    bot.getDecisionTracker().recordDecision('dec-1', 'Cần quyết định việc X', [CHAT_ID], currentTime);

    const morningTriggered = await bot.checkMorningSummary();
    expect(morningTriggered).toBe(false);

    const digestTriggered = await bot.checkScheduledDigest();
    expect(digestTriggered).toBe(false);

    await bot.periodicCheck();
    await bot.flushQueue(CHAT_ID);

    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(0);
  });

  it('12. restart gia lap (tao service moi voi now = 19:30) khong gui tom tat sang hoac digest', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    config.brain.digest = { enabled: true, time: '18:00' };

    const restartDate = new Date();
    restartDate.setHours(19, 30, 0, 0);
    currentTime = restartDate.getTime();

    // Create a new bot instance at 19:30 (simulating hub restart after 18:00 window)
    const bot = createBot('suggest');

    const morningTriggered = await bot.checkMorningSummary();
    expect(morningTriggered).toBe(false);

    const digestTriggered = await bot.checkScheduledDigest();
    expect(digestTriggered).toBe(false);

    await bot.periodicCheck();
    await bot.flushQueue(CHAT_ID);

    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(0);
  });

  it('13. tom tat sang khong gui khi hang doi rong va khong co decision', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };

    // Set time to 07:15 (inside the 2h window after quietHours.end)
    const morningDate = new Date();
    morningDate.setHours(7, 15, 0, 0);
    currentTime = morningDate.getTime();

    const bot = createBot('suggest');
    // Ensure queue and decisionTracker are empty
    expect(bot.getQuietHoursQueue()).toHaveLength(0);
    expect(bot.getDecisionTracker().getPending()).toHaveLength(0);

    const triggered = await bot.checkMorningSummary();
    expect(triggered).toBe(false);

    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(0);
  });

  it('14. nut khi co nhieu quyet dinh trong tom tat sang hien short text cho ca nut Khong (❌ <short>)', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    const morningDate = new Date();
    morningDate.setHours(7, 0, 0, 0);
    currentTime = morningDate.getTime();

    const bot = createBot('suggest');
    const tracker = bot.getDecisionTracker();
    tracker.recordDecision('dec-1', 'Đồng ý cập nhật cấu hình hệ thống?', [CHAT_ID], currentTime);
    tracker.recordDecision('dec-2', 'Chạy lệnh di chuyển database lớn?', [CHAT_ID], currentTime);

    const summary = bot.buildMorningSummary();
    expect(summary.keyboard).toHaveLength(3); // 2 rows of decisions + 1 row for dashboard
    // Row 1
    expect(summary.keyboard[0][0].text).toBe('✅ Đồng ý cập nhật c...');
    expect(summary.keyboard[0][1].text).toBe('❌ Đồng ý cập nhật c...');
    expect(summary.keyboard[0][1].callback_data).toBe('decision:reject:dec-1');
    // Row 2
    expect(summary.keyboard[1][0].text).toBe('✅ Chạy lệnh di chuy...');
    expect(summary.keyboard[1][1].text).toBe('❌ Chạy lệnh di chuy...');
    expect(summary.keyboard[1][1].callback_data).toBe('decision:reject:dec-2');
  });

  it('15. merge conflict and failure quiet notifications (h-merge-conflict-notify-quiet)', async () => {
    ctx.projectRepo.insert({ id: 'p', name: 'Project P', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    const bot = createBot('suggest');

    // 1. Conflict 1 to 3, hub auto-reassigned: no notifications
    bot.handleEvent('merge.conflict', 'p/task-1', { conflictCount: 1, autoRetried: true, message: 'Xung đột merge ở: file1.ts' });
    bot.handleEvent('merge.conflict', 'p/task-1', { conflictCount: 2, autoRetried: true, message: 'Xung đột merge ở: file1.ts' });
    bot.handleEvent('merge.conflict', 'p/task-1', { conflictCount: 3, autoRetried: true, message: 'Xung đột merge ở: file1.ts' });
    await bot.flushQueue(CHAT_ID);
    let sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(0);

    // 2. Conflict 4: sends exactly one notification
    bot.handleEvent('merge.conflict', 'p/task-1', { conflictCount: 4, autoRetried: false, files: 'file1.ts, file2.ts' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body?.text).toContain('⚠️ p/task-1 xung đột merge lần thứ 4, cần xem: file1.ts, file2.ts');

    // Duplicate conflict 4 or 5 on same task: no duplicate notification ("Mỗi task chỉ gửi một lần")
    bot.handleEvent('merge.conflict', 'p/task-1', { conflictCount: 5, autoRetried: false, files: 'file1.ts, file2.ts' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(1);

    // Contradictory payload (conflictCount > 3 but autoRetried is true) must still notify
    bot.handleEvent('merge.conflict', 'p/task-contradictory', { conflictCount: 4, autoRetried: true, files: 'c.ts' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1].body?.text).toContain('⚠️ p/task-contradictory xung đột merge lần thứ 4, cần xem: c.ts');

    // 3. Cannot auto-reassign (e.g. task cancelled or missing base branch): sends notification
    bot.handleEvent('merge.conflict', 'p/task-cancelled', { conflictCount: 1, autoRetried: false, message: 'Xung đột merge ở: bad.ts' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(3);
    expect(sendCalls[2].body?.text).toContain('⚠️ p/task-cancelled xung đột merge lần thứ 1, cần xem: bad.ts');

    // 4. merge.failed when hub already created fix task: no notification
    bot.handleEvent('merge.failed', 'p/task-postcheck', { autoFixCreated: true, message: 'Checks sau merge thất bại' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(3);

    // 5. merge.failed due to environment error (no fix task created): sends notification
    bot.handleEvent('merge.failed', 'p/task-env', { environment: true, message: 'Thiếu dependency' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(4);
    expect(sendCalls[3].body?.text).toContain('Lỗi môi trường khi tự động gộp: p/task-env');

    // 6. Automatically created draft task with -fix-merge: no notification
    ctx.taskRepo.insert({
      id: 'p/task-postcheck-fix-merge',
      projectId: 'p',
      slug: 'task-postcheck-fix-merge',
      title: 'Fix merge',
      status: 'draft',
      sourceRef: JSON.stringify({ checkName: 'merge' }),
    });
    bot.handleEvent('batch.created', 'p/task-postcheck-fix-merge', { title: 'Fix merge' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(4);

    // 7. Restart persistence: a new TelegramBotService instance does not re-notify already alerted tasks
    const restartedBot = createBot('suggest');
    restartedBot.handleEvent('merge.conflict', 'p/task-1', { conflictCount: 6, autoRetried: false, files: 'file1.ts' });
    await restartedBot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(4);
  });
});

describe('Menu lệnh Telegram', () => {
  it('mọi lệnh trong menu đều có xử lý thật và mô tả hợp lệ', async () => {
    const { TELEGRAM_BOT_COMMANDS } = await import('../src/telegram.js');
    const fsMod = await import('node:fs');
    const src = fsMod.readFileSync(new URL('../src/telegram.ts', import.meta.url), 'utf8');
    for (const { command, description } of TELEGRAM_BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThan(2);
      expect(description.length).toBeLessThanOrEqual(256);
      expect(src).toContain(`case '/${command}'`);
    }
  });
});

describe('Telegram theo dự án (b3-telegram-per-project)', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let config: ReturnType<typeof loadConfig>;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let recordedCalls: Array<{ url: string; body?: Record<string, unknown> }>;
  let fakeFetch: typeof fetch;
  const CHAT_ID = 88888;
  let currentTime = 1_000_000;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-telegram-proj-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    config = loadConfig(tmpDir);
    config.telegram.enabled = true;
    config.telegram.allowedChatIds = [CHAT_ID];
    config.port = 4321;

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();
    ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
    currentTime = new Date('2026-10-21T10:00:00Z').getTime();

    recordedCalls = [];
    fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      let bodyObj: Record<string, unknown> | undefined;
      if (init?.body && typeof init.body === 'string') {
        try {
          bodyObj = JSON.parse(init.body);
        } catch {
          // ignore
        }
      }
      recordedCalls.push({ url: urlStr, body: bodyObj });

      if (urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { id: 123456, is_bot: true, first_name: 'AgentHubBot', username: 'agenthub_bot' } }));
      }
      if (urlStr.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: recordedCalls.length, chat: { id: CHAT_ID } } }));
      }
      if (urlStr.includes('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 123, chat: { id: CHAT_ID } } }));
      }
      if (urlStr.includes('/answerCallbackQuery')) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      if (urlStr.includes('/createForumTopic')) {
        return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 555, name: bodyObj?.name || 'Topic' } }));
      }
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    ctx.chatService.stop();
    closeContext(ctx);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  function createProject(id: string, name: string, brainMode: string = 'inherit', telegramContent: string = 'full') {
    ctx.projectRepo.insert({
      id,
      name,
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
      settings: JSON.stringify({
        brain: { mode: brainMode },
        notifications: { telegramContent },
      }),
    });
  }

  function createProjectBot(brainMode: 'off' | 'suggest' | 'auto' = 'suggest') {
    config.brain.mode = brainMode;
    config.telegram.allowedChatIds = [CHAT_ID];
    return new TelegramBotService({
      config,
      service: ctx.service,
      eventBus: ctx.scheduler.getEventBus(),
      taskRepo: ctx.taskRepo,
      projectRepo: ctx.projectRepo,
      departmentRepo: ctx.departmentRepo,
      profileRepo: ctx.profileRepo,
      quotaMarkRepo: ctx.quotaMarkRepo,
      fetch: fakeFetch,
      now: () => currentTime,
      sleep: async () => {},
      sleepFn: async () => {},
      tokenOverride: 'test-token',
      chatService: ctx.chatService,
      brainSession: true,
    });
  }

  it('1. /use va dinh tuyen phien dung che do cua du an', async () => {
    createProject('p-suggest', 'Project Suggest', 'suggest', 'full');
    createProject('p-external', 'Project External', 'external', 'full');
    createProject('p-off', 'Project Off', 'off', 'full');

    const bot = createProjectBot('suggest');

    // /use without args when no project selected
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/use' },
    });
    await bot.flushQueue(CHAT_ID);
    const lastSend1 = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastSend1?.body?.text).toContain('Chưa chọn dự án nào');
    const keyboard = lastSend1?.body?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(keyboard.inline_keyboard.some((row) => row.some((btn) => btn.callback_data === 'use:select:p-suggest'))).toBe(true);

    // Select project via callback
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: CHAT_ID, first_name: 'Tester', is_bot: false },
        message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000) },
        data: 'use:select:p-suggest',
      },
    });
    await bot.flushQueue(CHAT_ID);
    expect(bot.getSelectedProject(CHAT_ID)).toBe('p-suggest');

    // /use without args now shows selected project
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 2, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/use' },
    });
    await bot.flushQueue(CHAT_ID);
    const lastSend3 = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastSend3?.body?.text).toContain('Project Suggest (p-suggest)');

    // Ordinary chat message routes to brain:p-suggest (kind: 'brain', projectId: 'p-suggest')
    await bot.handleUpdate({
      update_id: 4,
      message: { message_id: 3, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: 'Xin chao' },
    });
    const brainSession = ctx.chatService?.chatSessionRepo.get('brain:p-suggest');
    expect(brainSession).toBeDefined();
    expect(brainSession?.kind).toBe('brain');
    expect(brainSession?.projectId).toBe('p-suggest');

    // Switch to external project via /use p-external
    await bot.handleUpdate({
      update_id: 5,
      message: { message_id: 4, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/use p-external' },
    });
    await bot.flushQueue(CHAT_ID);
    expect(bot.getSelectedProject(CHAT_ID)).toBe('p-external');

    // Ordinary message routes to telegram:chatId:p-external (kind: 'chat', projectId: 'p-external')
    await bot.handleUpdate({
      update_id: 6,
      message: { message_id: 5, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: 'Cau hoi cho external' },
    });
    const externalSession = ctx.chatService?.chatSessionRepo.get(`telegram:${CHAT_ID}:p-external`);
    expect(externalSession).toBeDefined();
    expect(externalSession?.kind).toBe('chat');
    expect(externalSession?.projectId).toBe('p-external');

    // Switch to off project via /use p-off
    await bot.handleUpdate({
      update_id: 7,
      message: { message_id: 6, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/use p-off' },
    });
    await bot.flushQueue(CHAT_ID);
    expect(bot.getSelectedProject(CHAT_ID)).toBe('p-off');

    // Ordinary message routes to telegram:chatId:p-off (kind: 'chat', projectId: 'p-off')
    await bot.handleUpdate({
      update_id: 8,
      message: { message_id: 7, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: 'Cau hoi cho off' },
    });
    const offSession = ctx.chatService?.chatSessionRepo.get(`telegram:${CHAT_ID}:p-off`);
    expect(offSession).toBeDefined();
    expect(offSession?.kind).toBe('chat');
    expect(offSession?.projectId).toBe('p-off');

    // Persistence: new bot restores selected project
    const restoredBot = createProjectBot('suggest');
    expect(restoredBot.getSelectedProject(CHAT_ID)).toBe('p-off');

    // /use none resets project selection and routes to global brain
    await bot.handleUpdate({
      update_id: 9,
      message: { message_id: 8, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/use none' },
    });
    await bot.flushQueue(CHAT_ID);
    expect(bot.getSelectedProject(CHAT_ID)).toBeUndefined();

    await bot.handleUpdate({
      update_id: 10,
      message: { message_id: 9, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: 'Tin he thong' },
    });
    const sysBrainSession = ctx.chatService?.chatSessionRepo.get('brain');
    expect(sysBrainSession).toBeDefined();
    expect(sysBrainSession?.kind).toBe('brain');
  });

  it('2. thong bao project vao topic, thong bao he thong vao General', async () => {
    createProject('p-topic', 'Topic App', 'suggest', 'full');
    config.telegram.projectTopics = { 'p-topic': { chatId: CHAT_ID, threadId: 42 } };
    const bot = createProjectBot('suggest');

    bot.broadcastMessage('project notification', undefined, 'p-topic');
    await bot.flushQueue(CHAT_ID);
    const projectCall = recordedCalls.filter((call) => call.url.includes('/sendMessage')).at(-1);
    expect(projectCall?.body?.message_thread_id).toBe(42);

    bot.broadcastMessage('system notification');
    await bot.flushQueue(CHAT_ID);
    const systemCall = recordedCalls.filter((call) => call.url.includes('/sendMessage')).at(-1);
    expect(systemCall?.body?.message_thread_id).toBeUndefined();
  });

  it('4. chat duoc gan project dinh tuyen ngay va event he thong luon vao General', async () => {
    createProject('p-attached', 'Attached App', 'suggest', 'full');
    config.telegram.projectTopics = { 'p-attached': { chatId: CHAT_ID, threadId: 77 } };
    const bot = createProjectBot('suggest');

    bot.setProjectChat('p-attached', CHAT_ID);
    expect(bot.getSelectedProject(CHAT_ID)).toBe('p-attached');

    bot.handleEvent('task.failed', 'p-attached/task-1');
    await bot.flushQueue(CHAT_ID);
    bot.broadcastMessage('system after project event', undefined);
    await bot.flushQueue(CHAT_ID);
    const systemCall = recordedCalls.filter((call) => call.url.includes('/sendMessage')).at(-1);
    expect(systemCall?.body?.message_thread_id).toBeUndefined();

    bot.handleEvent('quota.exhausted', undefined, { projectId: 'p-attached', profile: 'p1', family: 'gemini' });
    await bot.flushQueue(CHAT_ID);
    const quotaCall = recordedCalls.filter((call) => call.url.includes('/sendMessage')).at(-1);
    expect(quotaCall?.body?.message_thread_id).toBeUndefined();
  });

  it('deploy event co projectId van duoc gui vao General', async () => {
    createProject('p-deploy', 'Deploy App', 'suggest', 'full');
    createProject('p-deploy-other', 'Other Deploy App', 'suggest', 'full');
    config.telegram.projectTopics = { 'p-deploy': { chatId: CHAT_ID, threadId: 88 } };
    const bot = createProjectBot('suggest');

    bot.handleEvent('deploy.failed', undefined, { projectId: 'p-deploy', error: 'build failed' });
    bot.handleEvent('deploy.failed', undefined, { projectId: 'p-deploy-other', error: 'build failed' });
    await bot.flushQueue(CHAT_ID);

    const deployCalls = recordedCalls.filter((call) => call.url.includes('/sendMessage'));
    expect(deployCalls).toHaveLength(2);
    const deployCall = deployCalls.at(-1);
    expect(deployCall?.body?.text).toContain('Triển khai thất bại');
    expect(deployCall?.body?.message_thread_id).toBeUndefined();
  });

  it('3. /newtask dung du an dang chon lam mac dinh', async () => {
    createProject('p-alpha', 'Project Alpha', 'suggest', 'full');
    createProject('p-beta', 'Project Beta', 'suggest', 'full');

    const bot = createProjectBot('suggest');

    // Select p-alpha
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/use p-alpha' },
    });
    await bot.flushQueue(CHAT_ID);

    // /newtask without args prompts with pre-selected project
    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/newtask' },
    });
    await bot.flushQueue(CHAT_ID);
    const sendNewtask = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(sendNewtask?.body?.text).toContain('Project Alpha (p-alpha)');

    // Sending next message uses p-alpha directly without asking for project
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: 'Tạo tính năng thanh toán thẻ' },
    });
    await bot.flushQueue(CHAT_ID);
    // Does not send the "Mô tả chưa nói rõ project" prompt
    const sentTexts = recordedCalls.filter((c) => c.url.includes('/sendMessage')).map((c) => c.body?.text as string);
    expect(sentTexts.some((t) => t && t.includes('Mô tả chưa nói rõ project'))).toBe(false);

    // /newtask <mô tả> directly uses p-alpha without asking
    await bot.handleUpdate({
      update_id: 4,
      message: { message_id: 4, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/newtask Tối ưu hiệu năng truy vấn' },
    });
    await bot.flushQueue(CHAT_ID);
    const sentTexts2 = recordedCalls.filter((c) => c.url.includes('/sendMessage')).map((c) => c.body?.text as string);
    expect(sentTexts2.some((t) => t && t.includes('Mô tả chưa nói rõ project'))).toBe(false);

    // /newtask_detail skips project selection and directly asks for title
    await bot.handleUpdate({
      update_id: 5,
      message: { message_id: 5, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/newtask_detail' },
    });
    await bot.flushQueue(CHAT_ID);
    const lastDetail = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastDetail?.body?.text).toContain('Vui lòng nhập <b>tiêu đề</b>');
    expect(lastDetail?.body?.text).toContain('Project Alpha (p-alpha)');
  });

  it('3. thong bao task/batch co tien to [<ten du an>]', async () => {
    createProject('p-prefix', 'Prefix App', 'suggest', 'full');
    ctx.taskRepo.insert({
      id: 'p-prefix/task-1',
      projectId: 'p-prefix',
      slug: 'task-1',
      title: 'Tích hợp webhook',
      status: 'review',
    });

    const bot = createProjectBot('suggest');

    // 1. task.review_ready
    bot.handleEvent('task.review_ready', 'p-prefix/task-1');
    await bot.flushQueue(CHAT_ID);
    let lastMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastMsg?.body?.text).toContain('[Prefix App] ');
    expect(lastMsg?.body?.text).toContain('Task chờ review');

    currentTime += 15_000;

    // 2. task.failed
    bot.handleEvent('task.failed', 'p-prefix/task-1');
    await bot.flushQueue(CHAT_ID);
    lastMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastMsg?.body?.text).toContain('[Prefix App] ❌ <b>Task thất bại</b>');

    currentTime += 15_000;

    // 3. task.blocked
    bot.handleEvent('task.blocked', 'p-prefix/task-1');
    await bot.flushQueue(CHAT_ID);
    lastMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastMsg?.body?.text).toContain('[Prefix App] ⚠️ <b>Task bị chặn</b>');

    currentTime += 15_000;

    // 4. batch.created
    bot.handleEvent('batch.created', undefined, { projectId: 'p-prefix', title: 'Đợt nâng cấp v2', taskCount: 2 });
    await bot.flushQueue(CHAT_ID);
    lastMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastMsg?.body?.text).toContain('[Prefix App] 📦');

    currentTime += 15_000;

    // 5. brain.notify
    bot.handleEvent('brain.notify', 'p-prefix/task-1', { projectId: 'p-prefix', text: 'Cần xác nhận triển khai', level: 'decision', decisionId: 'dec-1' });
    await bot.flushQueue(CHAT_ID);
    lastMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastMsg?.body?.text).toContain('[Prefix App] 📌');

    currentTime += 15_000;

    // 6. Project name with HTML special chars: A<B & C> -> [A&lt;B &amp; C&gt;]
    createProject('p-html-esc', 'A<B & C>', 'suggest', 'full');
    ctx.taskRepo.insert({
      id: 'p-html-esc/task-esc',
      projectId: 'p-html-esc',
      slug: 'task-esc',
      title: 'Kiểm tra escape HTML',
      status: 'review',
    });
    bot.handleEvent('task.review_ready', 'p-html-esc/task-esc');
    await bot.flushQueue(CHAT_ID);
    lastMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastMsg?.body?.text).toContain('[A&lt;B &amp; C&gt;]');

    currentTime += 15_000;
    bot.handleEvent('review.auto_merge_skipped', 'p-prefix/task-1', {
      reason: 'checks_failed', retried: true,
      checks: [{ name: 'test', ok: false, outputTail: 'npm test\nError: token=telegram-secret' }],
    });
    await bot.flushQueue(CHAT_ID);
    lastMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(lastMsg?.body?.text).toContain('đã được duyệt nhưng chưa tự merge');
    expect(lastMsg?.body?.text).toContain('check <code>test</code> đỏ (đã chạy lại 1 lần)');
    expect(lastMsg?.body?.text).toContain('Error: token=[redacted]');
    expect(lastMsg?.body?.text).not.toContain('telegram-secret');
  });

  it('4. telegramContent = minimal khong lo tieu de trong moi duong gui', async () => {
    createProject('p-min', 'Secured Project', 'suggest', 'minimal');
    ctx.taskRepo.insert({
      id: 'p-min/secret-task',
      projectId: 'p-min',
      slug: 'secret-task',
      title: 'Bí mật kinh doanh: Thay đổi giá cả',
      status: 'review',
    });

    const bot = createProjectBot('suggest');

    // 1. task.review_ready: chỉ "[Dự án] 1 task cần duyệt" + link dashboard, không diff
    bot.handleEvent('task.review_ready', 'p-min/secret-task');
    await bot.flushQueue(CHAT_ID);
    const reviewMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(reviewMsg?.body?.text).toBe('[Secured Project] 1 task cần duyệt');
    expect(reviewMsg?.body?.text).not.toContain('Bí mật kinh doanh');
    const kb = reviewMsg?.body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> };
    expect(kb.inline_keyboard[0][0].text).toContain('Xem dashboard');
    expect(kb.inline_keyboard.some((r) => r.some((b) => b.callback_data?.includes('diff')))).toBe(false);

    currentTime += 15_000;

    // 2. task.failed: không lộ tiêu đề
    bot.handleEvent('task.failed', 'p-min/secret-task');
    await bot.flushQueue(CHAT_ID);
    const failMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(failMsg?.body?.text).toContain('[Secured Project] ❌ <b>Task thất bại</b>');
    expect(failMsg?.body?.text).not.toContain('Bí mật kinh doanh');

    currentTime += 15_000;

    // 3. /task p-min/secret-task trả lời ẩn nội dung
    await bot.handleUpdate({
      update_id: 100,
      message: { message_id: 100, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/task p-min/secret-task' },
    });
    await bot.flushQueue(CHAT_ID);
    const taskCmdMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(taskCmdMsg?.body?.text).toBe('Dự án này ẩn nội dung trên Telegram, xem trên dashboard');

    // 4. /log p-min/secret-task trả lời ẩn nội dung
    await bot.handleUpdate({
      update_id: 101,
      message: { message_id: 101, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/log p-min/secret-task' },
    });
    await bot.flushQueue(CHAT_ID);
    const logCmdMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(logCmdMsg?.body?.text).toBe('Dự án này ẩn nội dung trên Telegram, xem trên dashboard');

    // 5. Callback task:diff và task:log trả lời ẩn nội dung
    await bot.handleUpdate({
      update_id: 102,
      callback_query: {
        id: 'cb-diff',
        from: { id: CHAT_ID, first_name: 'Tester', is_bot: false },
        message: { message_id: 100, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000) },
        data: 'task:diff:p-min/secret-task',
      },
    });
    await bot.flushQueue(CHAT_ID);
    const diffCbMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(diffCbMsg?.body?.text).toBe('Dự án này ẩn nội dung trên Telegram, xem trên dashboard');

    // 6. batch.created: không lộ tiêu đề task
    currentTime += 15_000;
    bot.handleEvent('batch.created', undefined, { projectId: 'p-min', title: 'Kế hoạch tuyệt mật', taskCount: 3 });
    await bot.flushQueue(CHAT_ID);
    const batchMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(batchMsg?.body?.text).toContain('[Secured Project] 📦 <b>Đợt task mới: 3 task</b>');
    expect(batchMsg?.body?.text).not.toContain('Kế hoạch tuyệt mật');

    // 7. /digest: tóm tắt theo từng dự án + một dòng tổng; dự án minimal chỉ hiện số
    currentTime += 15_000;
    await bot.handleUpdate({
      update_id: 103,
      message: { message_id: 103, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/digest' },
    });
    await bot.flushQueue(CHAT_ID);
    const digestMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(digestMsg).toContain('TÓM TẮT HỆ THỐNG AGENTHUB');
    expect(digestMsg).toContain('[Secured Project]');
    expect(digestMsg).toContain('Tổng cộng');
    expect(digestMsg).not.toContain('Bí mật kinh doanh');

    // 8. Trả lời bộ não chuyển tiếp (finish chat reply): chỉ báo "Bộ não đã trả lời, xem dashboard"
    (bot as unknown as { chatReplies: Map<string, unknown> }).chatReplies.set('brain:p-min', {
      chatId: CHAT_ID,
      messageId: 105,
      text: '⏳ Đang xử lý…',
      lastEditAt: currentTime,
      editing: false,
    });
    (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void })
      .handleChatEvent('chat.done', undefined, { sessionId: 'brain:p-min' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const edits = recordedCalls.filter((c) => c.url.includes('/editMessageText'));
    const lastEdit = edits.at(-1)?.body?.text as string;
    expect(lastEdit).toBe('Bộ não đã trả lời, xem dashboard');
    const lastEditMarkup = edits.at(-1)?.body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; url: string }>> };
    expect(lastEditMarkup.inline_keyboard[0][0].text).toContain('Xem dashboard');
  });

  it('5. /brain liet ke bo nao tung du an va /brain mode theo du an hoac toan cuc', async () => {
    createProject('p-one', 'Project 1', 'suggest', 'full');
    createProject('p-two', 'Project 2', 'inherit', 'full');

    const bot = createProjectBot('suggest');

    // /brain shows overview and per-project brain modes
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/brain' },
    });
    await bot.flushQueue(CHAT_ID);
    const brainMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(brainMsg).toContain('Bộ não toàn cục: <b>suggest</b>');
    expect(brainMsg).toContain('Bộ não từng dự án:');
    expect(brainMsg).toContain('<code>p-one</code>: chế độ <b>suggest</b> · trạng thái <b>sẵn sàng</b>');
    expect(brainMsg).toContain('<code>p-two</code>: chế độ <b>suggest (inherit)</b> · trạng thái <b>sẵn sàng</b>');

    // /brain mode <dự án> <mode> changes project settings
    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/brain mode p-two external' },
    });
    await bot.flushQueue(CHAT_ID);
    const modeProjectMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(modeProjectMsg).toContain('Đã chuyển bộ não dự án <b>p-two</b> sang chế độ <b>external</b>');

    const updatedProj = ctx.projectRepo.get('p-two');
    const settings = JSON.parse(updatedProj?.settings || '{}');
    expect(settings.brain.mode).toBe('external');

    // /brain mode <mode> changes global mode
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/brain mode auto' },
    });
    await bot.flushQueue(CHAT_ID);
    const modeGlobalMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(modeGlobalMsg).toContain('Đã chuyển bộ não toàn cục sang chế độ <b>auto</b>');
    expect(config.brain.mode).toBe('auto');

    // /help lists /use and updated /brain
    await bot.handleUpdate({
      update_id: 4,
      message: { message_id: 4, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/help' },
    });
    await bot.flushQueue(CHAT_ID);
    const helpMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(helpMsg).toContain('/use');
    expect(helpMsg).toContain('/brain');
  });

  it('/brain trust changes permission with confirmation and emits event', async () => {
    createProject('p-trust', 'Project Trust', 'suggest', 'standard');
    const bot = createProjectBot('suggest');

    const trustEvents: unknown[] = [];
    ctx.scheduler.getEventBus().on('brain.trust_changed', (_taskId, payload) => trustEvents.push(payload));

    // /brain trust p-trust full without confirm -> does not change
    await bot.handleUpdate({
      update_id: 10,
      message: { message_id: 10, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/brain trust p-trust full' },
    });
    await bot.flushQueue(CHAT_ID);
    const warnCall = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
    expect(warnCall?.body?.text as string).toContain('Toàn quyền');
    const projBefore = ctx.projectRepo.get('p-trust');
    const settingsBefore = JSON.parse(projBefore?.settings || '{}');
    expect(settingsBefore.brain?.permissions ?? 'standard').not.toBe('full');
    expect(trustEvents).toHaveLength(0);

    // /brain trust p-trust full confirm -> changes to full and emits event
    await bot.handleUpdate({
      update_id: 11,
      message: { message_id: 11, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/brain trust p-trust full confirm' },
    });
    await bot.flushQueue(CHAT_ID);
    const confirmMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(confirmMsg).toContain('Đã đổi quyền bộ não dự án <b>p-trust</b> sang <b>full</b>');
    const projAfter = ctx.projectRepo.get('p-trust');
    const settingsAfter = JSON.parse(projAfter?.settings || '{}');
    expect(settingsAfter.brain.permissions).toBe('full');
    expect(trustEvents).toContainEqual(expect.objectContaining({ projectId: 'p-trust', permissions: 'full' }));
  });

  it('6. addAllowedChatId (pairing lai) giu lai projectId va kind cua entry cu', async () => {
    createProject('p-keep', 'Project Keep', 'suggest', 'full');
    const bot = createProjectBot('suggest');

    // User selects project via /use
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/use p-keep' },
    });
    await bot.flushQueue(CHAT_ID);
    expect(bot.getSelectedProject(CHAT_ID)).toBe('p-keep');

    const chatBefore = (config.telegram.chats || []).find((c) => c.id === CHAT_ID);
    expect(chatBefore?.projectId).toBe('p-keep');
    expect(chatBefore?.kind).toBe('chat');

    // Re-pairing: addAllowedChatId with new name/username but no projectId/kind
    bot.addAllowedChatId(CHAT_ID, {
      id: CHAT_ID,
      name: 'Re-paired Tester (@tester)',
      username: 'tester',
    });

    const chatAfter = (config.telegram.chats || []).find((c) => c.id === CHAT_ID);
    expect(chatAfter?.id).toBe(CHAT_ID);
    expect(chatAfter?.name).toBe('Re-paired Tester (@tester)');
    expect(chatAfter?.username).toBe('tester');
    expect(chatAfter?.projectId).toBe('p-keep');
    expect(chatAfter?.kind).toBe('chat');

    // Selected project is preserved in memory and restored on restart
    expect(bot.getSelectedProject(CHAT_ID)).toBe('p-keep');
    const newBot = createProjectBot('suggest');
    expect(newBot.getSelectedProject(CHAT_ID)).toBe('p-keep');
  });

  it('7. /focus bat tat va kiem tra trang thai tap trung project', async () => {
    createProject('p-focus', 'Project Focus', 'suggest', 'full');
    const bot = createProjectBot('suggest');

    // 1. /focus khi chưa bật
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/focus' },
    });
    await bot.flushQueue(CHAT_ID);
    const msg1 = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(msg1).toContain('Chưa bật chế độ tập trung');

    // 2. /focus cho project không tồn tại
    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 2, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/focus p-non-existent' },
    });
    await bot.flushQueue(CHAT_ID);
    const msgErr = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(msgErr).toContain('không tồn tại');

    // 3. /focus p-focus -> bật tập trung
    await bot.handleUpdate({
      update_id: 3,
      message: { message_id: 3, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/focus p-focus' },
    });
    await bot.flushQueue(CHAT_ID);
    const msg2 = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(msg2).toContain('Đã tập trung cho <b>p-focus</b>');
    expect(ctx.service.getFocus().projectId).toBe('p-focus');

    // 4. /focus xem trạng thái khi đang bật
    await bot.handleUpdate({
      update_id: 4,
      message: { message_id: 4, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/focus' },
    });
    await bot.flushQueue(CHAT_ID);
    const msg3 = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(msg3).toContain('Đang tập trung cho <b>p-focus</b>');

    // 5. /focus off -> tắt tập trung
    await bot.handleUpdate({
      update_id: 5,
      message: { message_id: 5, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/focus off' },
    });
    await bot.flushQueue(CHAT_ID);
    const msg4 = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1)?.body?.text as string;
    expect(msg4).toContain('Đã tắt tập trung');
    expect(ctx.service.getFocus().projectId).toBeNull();
  });

  describe('13. Telegram Topics per Department & Group Pairing (d-telegram-topics)', () => {
    const SUPERGROUP_ID = -100987654321;
    const AUTHORIZED_USER_ID = 777111;
    const UNAUTHORIZED_USER_ID = 999888;

    function createDeptBot(opts?: { allowedChatIds?: number[]; topicMode?: 'project' | 'department'; directorEnabled?: boolean }) {
      config.telegram.allowedChatIds = opts?.allowedChatIds ? [...opts.allowedChatIds] : [AUTHORIZED_USER_ID];
      config.telegram.topicMode = opts?.topicMode ?? 'department';
      if (opts?.directorEnabled !== undefined) {
        config.brain.director = {
          enabled: opts.directorEnabled,
          engine: 'claude',
          model: 'sonnet',
          cron: '0 8 * * *',
          timezone: 'Asia/Ho_Chi_Minh',
        };
      }
      return new TelegramBotService({
        config,
        service: ctx.service,
        eventBus: ctx.scheduler.getEventBus(),
        taskRepo: ctx.taskRepo,
        projectRepo: ctx.projectRepo,
        departmentRepo: ctx.departmentRepo,
        profileRepo: ctx.profileRepo,
        quotaMarkRepo: ctx.quotaMarkRepo,
        fetch: fakeFetch,
        now: () => currentTime,
        sleep: async () => {},
        sleepFn: async () => {},
        tokenOverride: 'test-token',
        chatService: ctx.chatService,
        brainSession: true,
      });
    }

    it('1. Group pairing: rejects pairing from unauthorized sender in group chat', async () => {
      const bot = createDeptBot({ allowedChatIds: [AUTHORIZED_USER_ID] });
      const pairData = bot.getPairingCode(true);

      // Unauthorized user in supergroup attempts pairing
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 10,
          date: Math.floor(currentTime / 1000),
          chat: { id: SUPERGROUP_ID, type: 'supergroup', title: 'Tech Team Supergroup' },
          from: { id: UNAUTHORIZED_USER_ID, is_bot: false, first_name: 'Hacker' },
          text: `/pair ${pairData.code}`,
        },
      });
      await bot.flushQueue(SUPERGROUP_ID);

      // Group is NOT added to allowedChatIds
      expect(config.telegram.allowedChatIds).not.toContain(SUPERGROUP_ID);
    });

    it('2. Group pairing: accepts pairing from authorized sender and registers supergroup', async () => {
      const bot = createDeptBot({ allowedChatIds: [AUTHORIZED_USER_ID] });
      const pairData = bot.getPairingCode(true);

      // Authorized user in supergroup pairs the group
      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 20,
          date: Math.floor(currentTime / 1000),
          chat: { id: SUPERGROUP_ID, type: 'supergroup', title: 'Tech Team Supergroup' },
          from: { id: AUTHORIZED_USER_ID, is_bot: false, first_name: 'Admin' },
          text: `/pair ${pairData.code}`,
        },
      });
      await bot.flushQueue(SUPERGROUP_ID);

      // Group IS added to allowedChatIds and chats list with kind 'supergroup'
      expect(config.telegram.allowedChatIds).toContain(SUPERGROUP_ID);
      const chatEntry = config.telegram.chats?.find((c) => c.id === SUPERGROUP_ID);
      expect(chatEntry).toBeDefined();
      expect(chatEntry?.kind).toBe('supergroup');
      const sentMsg = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
      expect(sentMsg?.body?.text).toContain('Ghép đôi nhóm thành công');
    });

    it('3. Department topic creation and setupDepartmentTopics', async () => {
      const bot = createDeptBot({ allowedChatIds: [AUTHORIZED_USER_ID, SUPERGROUP_ID] });

      ctx.departmentRepo.insert({
        id: 'dept-mobile',
        name: 'Phòng Di động',
        priority: 2,
        maxParallel: 3,
        claudeDailyTokenBudget: 0,
        telegramTopicId: null,
      });

      const topic = await bot.createDepartmentTopic('dept-mobile');
      expect(topic.chatId).toBe(SUPERGROUP_ID);
      expect(topic.threadId).toBe(555);

      // Check config and DB
      expect(config.telegram.departmentTopics?.['dept-mobile']?.threadId).toBe(555);
      const row = ctx.departmentRepo.get('dept-mobile');
      expect(row?.telegramTopicId).toBe(555);

      // setupDepartmentTopics creates topics for 'chung' and missing departments
      const created = await bot.setupDepartmentTopics();
      expect(created['chung']).toBeDefined();
      expect(config.telegram.departmentTopics?.['chung']?.threadId).toBeDefined();
    });

    it('4. Message routing in department topics to brain:department:<deptId> and brain:director', async () => {
      ctx.departmentRepo.insert({
        id: 'dept-ai',
        name: 'Phòng AI',
        priority: 3,
        maxParallel: 2,
        claudeDailyTokenBudget: 0,
        telegramTopicId: null,
        brainEngine: 'claude',
        brainModel: 'sonnet',
        brainMode: 'suggest',
        brainPermissions: 'full',
      });

      config.telegram.departmentTopics = {
        'dept-ai': { chatId: SUPERGROUP_ID, threadId: 101 },
        'chung': { chatId: SUPERGROUP_ID, threadId: 102 },
      };

      const bot = createDeptBot({
        allowedChatIds: [SUPERGROUP_ID],
        topicMode: 'department',
        directorEnabled: true,
      });

      // Message in AI department topic (threadId 101)
      await bot.handleUpdate({
        update_id: 30,
        message: {
          message_id: 301,
          date: Math.floor(currentTime / 1000),
          chat: { id: SUPERGROUP_ID, type: 'supergroup', title: 'Company Supergroup' },
          from: { id: AUTHORIZED_USER_ID, is_bot: false },
          message_thread_id: 101,
          text: 'Xin chào phòng AI',
        },
      });

      const aiSession = ctx.chatService?.chatSessionRepo.get('brain:department:dept-ai');
      expect(aiSession).toBeDefined();
      expect(aiSession?.kind).toBe('brain');
      expect(aiSession?.title).toBe('Bộ não · Phòng AI');

      // Message in Chung topic (threadId 102) with director enabled -> routes to brain:director
      await bot.handleUpdate({
        update_id: 31,
        message: {
          message_id: 302,
          date: Math.floor(currentTime / 1000),
          chat: { id: SUPERGROUP_ID, type: 'supergroup', title: 'Company Supergroup' },
          from: { id: AUTHORIZED_USER_ID, is_bot: false },
          message_thread_id: 102,
          text: 'Báo cáo tổng quan hôm nay',
        },
      });

      const dirSession = ctx.chatService?.chatSessionRepo.get('brain:director');
      expect(dirSession).toBeDefined();
      expect(dirSession?.kind).toBe('brain');
      expect(dirSession?.title).toBe('Bộ não Giám đốc');
    });

    it('5. Notification routing in topicMode: department routes task events to department topic with prefix', async () => {
      ctx.departmentRepo.insert({
        id: 'dept-backend',
        name: 'Phòng Backend',
        priority: 1,
        maxParallel: 2,
        claudeDailyTokenBudget: 0,
        telegramTopicId: 201,
      });

      ctx.projectRepo.insert({
        id: 'p-be-api',
        name: 'Backend API Service',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 1,
        departmentId: 'dept-backend',
      });

      ctx.taskRepo.insert({
        id: 'p-be-api/task-login',
        projectId: 'p-be-api',
        slug: 'task-login',
        title: 'Thêm xác thực JWT',
        status: 'review',
      });

      config.telegram.departmentTopics = {
        'dept-backend': { chatId: SUPERGROUP_ID, threadId: 201 },
        'chung': { chatId: SUPERGROUP_ID, threadId: 202 },
      };

      const bot = createDeptBot({
        allowedChatIds: [SUPERGROUP_ID],
        topicMode: 'department',
      });

      // Task notification routes to dept-backend topic (threadId 201) and includes project prefix
      bot.handleEvent('task.review_ready', 'p-be-api/task-login');
      await bot.flushQueue(SUPERGROUP_ID);

      const taskCall = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
      expect(taskCall?.body?.message_thread_id).toBe(201);
      expect(taskCall?.body?.text).toContain('[Backend API Service]');
      expect(taskCall?.body?.text).toContain('Task chờ review');

      currentTime += 15_000;

      // Project without department routes to Chung topic (threadId 202)
      ctx.projectRepo.insert({
        id: 'p-orphan',
        name: 'Orphan Project',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 1,
      });
      ctx.taskRepo.insert({
        id: 'p-orphan/task-doc',
        projectId: 'p-orphan',
        slug: 'task-doc',
        title: 'Cập nhật tài liệu',
        status: 'failed',
      });

      bot.handleEvent('task.failed', 'p-orphan/task-doc');
      await bot.flushQueue(SUPERGROUP_ID);

      const orphanCall = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
      expect(orphanCall?.body?.message_thread_id).toBe(202);
      expect(orphanCall?.body?.text).toContain('[Orphan Project]');

      currentTime += 15_000;

      // System notification routes to Chung topic
      bot.broadcastMessage('Hệ thống khởi động hoàn tất', undefined);
      await bot.flushQueue(SUPERGROUP_ID);

      const sysCall = recordedCalls.filter((c) => c.url.includes('/sendMessage')).at(-1);
      expect(sysCall?.body?.message_thread_id).toBe(202);
      expect(sysCall?.body?.text).toContain('Hệ thống khởi động hoàn tất');
    });

    it('6. /topics command supports setup in department mode', async () => {
      config.telegram.departmentTopics = {
        'chung': { chatId: SUPERGROUP_ID, threadId: 301 },
      };

      const bot = createDeptBot({
        allowedChatIds: [SUPERGROUP_ID],
        topicMode: 'project',
      });

      // /topics setup department
      await bot.handleUpdate({
        update_id: 41,
        message: {
          message_id: 402,
          date: Math.floor(currentTime / 1000),
          chat: { id: SUPERGROUP_ID, type: 'supergroup', title: 'Team Group' },
          from: { id: AUTHORIZED_USER_ID, is_bot: false },
          text: '/topics setup department',
        },
      });
      await bot.flushQueue(SUPERGROUP_ID);

      const setupCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const lastSetupCall = setupCalls.at(-1);
      expect(lastSetupCall?.body?.text).toContain('Đã đồng bộ');
      expect(lastSetupCall?.body?.text).toContain('topic phòng ban');
      expect(config.telegram.topicMode).toBe('department');
    });

    it('7. HTTP API endpoints for department topics and setup', async () => {
      config.telegram.allowedChatIds = [SUPERGROUP_ID];
      config.telegram.chats = [{ id: SUPERGROUP_ID, name: 'Supergroup', kind: 'supergroup' }];

      if (ctx.telegramService) {
        (ctx.telegramService as unknown as { token?: string; fetchFn?: typeof fetch }).token = 'test-token';
        (ctx.telegramService as unknown as { token?: string; fetchFn?: typeof fetch }).fetchFn = fakeFetch;
      }

      server = await createServer(ctx.service, config);
      await server.ready();
      const token = getOrCreateToken(config.tokenPath);
      const testHeaders = {
        host: '127.0.0.1:4321',
        authorization: `Bearer ${token}`,
      };

      // POST /api/telegram/departments/:id/topic
      const deptRes = await server.inject({
        method: 'POST',
        url: '/api/telegram/departments/chung/topic',
        headers: testHeaders,
      });
      expect(deptRes.statusCode).toBe(200);
      const deptJson = JSON.parse(deptRes.body);
      expect(deptJson.chatId).toBe(SUPERGROUP_ID);
      expect(deptJson.threadId).toBe(555);

      // POST /api/telegram/topics/setup with department mode
      const setupRes = await server.inject({
        method: 'POST',
        url: '/api/telegram/topics/setup',
        headers: {
          ...testHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode: 'department' }),
      });
      expect(setupRes.statusCode).toBe(200);
      const setupJson = JSON.parse(setupRes.body);
      expect(setupJson['chung']).toBeDefined();
      expect(setupJson['chung'].threadId).toBe(555);

      // GET /api/telegram/status contains topicMode and departmentTopics
      const statusRes = await server.inject({
        method: 'GET',
        url: '/api/telegram/status',
        headers: testHeaders,
      });
      expect(statusRes.statusCode).toBe(200);
      const statusJson = JSON.parse(statusRes.body);
      expect(statusJson.topicMode).toBe('department');
      expect(statusJson.departmentTopics).toBeDefined();
    });
  });
});
