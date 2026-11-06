import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext, closeContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';

// Không bao giờ chạy Claude thật: `claude mcp add` sẽ sửa cấu hình MCP thật của người dùng.
describe('POST /api/setup/mcp', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let server: Awaited<ReturnType<typeof createServer>>;
  let token: string;
  let argsFile: string;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-install-'));
    process.env.AGENTHUB_HOME = tmpDir;
    argsFile = path.join(tmpDir, 'args.txt');
    // Claude giả nằm ngoài PATH, giống Claude cài trong một bản Node khác (nvm).
    const fakeClaude = path.join(tmpDir, 'other-node', 'bin', 'claude');
    fs.mkdirSync(path.dirname(fakeClaude), { recursive: true });
    fs.writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho "Added stdio MCP server agenthub"\n`, { mode: 0o755 });
    config = loadConfig(tmpDir);
    config.chat.claudeBin = fakeClaude;
    token = getOrCreateToken(config.tokenPath);
    ctx = createContext(config);
    server = await createServer(ctx.service, config, ctx.chatService);
    await server.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    closeContext(ctx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const post = () => server.inject({
    method: 'POST',
    url: '/api/setup/mcp',
    headers: { Authorization: `Bearer ${token}`, Host: '127.0.0.1:7700' },
  });

  it('registers AgentHub using the absolute Claude path even when claude is not on PATH', async () => {
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => /dist[/\\]cli\.js$/.test(String(file)) || existsSync(file));
    const res = await post();

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args.slice(0, 6)).toEqual(['mcp', 'add', '--scope', 'user', 'agenthub', '--']);
    expect(args[6]).toBe(process.execPath);
    expect(args[7]).toMatch(/dist[/\\]cli\.js$/);
    expect(args[8]).toBe('mcp');
  });

  it('refuses to register a CLI build that does not exist', async () => {
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => !/dist[/\\]cli\.js$/.test(String(file)) && existsSync(file));
    const res = await post();

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'mcp_cli_missing' });
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it('explains when Claude Code cannot be found', async () => {
    config.chat.claudeBin = path.join(tmpDir, 'missing-claude');
    const previous = { bin: process.env.AGENTHUB_CLAUDE_BIN, path: process.env.PATH, home: process.env.HOME };
    process.env.PATH = path.join(tmpDir, 'empty-bin');
    process.env.HOME = tmpDir;
    delete process.env.AGENTHUB_CLAUDE_BIN;
    try {
      const res = await post();
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'claude_not_found' });
    } finally {
      process.env.PATH = previous.path;
      process.env.HOME = previous.home;
      if (previous.bin !== undefined) process.env.AGENTHUB_CLAUDE_BIN = previous.bin;
    }
  });
});
