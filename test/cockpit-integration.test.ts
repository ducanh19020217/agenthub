import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { getOrCreateToken } from '../src/auth.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import type { FastifyInstance } from 'fastify';

describe('Cockpit Tools Backend Integration', () => {
  let tmpDir: string;
  let cockpitDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: FastifyInstance;
  let token: string;
  let originalFetch: typeof globalThis.fetch;
  let previousAgyBin: string | undefined;

  function authHeaders() {
    return {
      host: `127.0.0.1:${config.port}`,
      authorization: `Bearer ${token}`,
    };
  }

  function hashDirectory(dir: string): Record<string, { hash: string; mtimeMs: number }> {
    const result: Record<string, { hash: string; mtimeMs: number }> = {};
    const walk = (current: string) => {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const content = fs.readFileSync(fullPath);
          const stat = fs.statSync(fullPath);
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          result[fullPath] = { hash, mtimeMs: stat.mtimeMs };
        }
      }
    };
    walk(dir);
    return result;
  }

  beforeEach(async () => {
    previousAgyBin = process.env.AGENTHUB_AGY_BIN;
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-usage.mjs');

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cockpit-integ-test-'));
    cockpitDir = path.join(tmpDir, 'cockpit_data');
    fs.mkdirSync(cockpitDir, { recursive: true });

    // Setup Cockpit fixture
    const agyAccountsDir = path.join(cockpitDir, 'accounts');
    const codexAccountsDir = path.join(cockpitDir, 'codex_accounts');
    const claudeAccountsDir = path.join(cockpitDir, 'claude_accounts');
    fs.mkdirSync(agyAccountsDir, { recursive: true });
    fs.mkdirSync(codexAccountsDir, { recursive: true });
    fs.mkdirSync(claudeAccountsDir, { recursive: true });

    // 1. Antigravity fixture
    fs.writeFileSync(
      path.join(cockpitDir, 'accounts.json'),
      JSON.stringify({
        version: '2.0',
        accounts: [
          { id: 'agy-1', email: 'agy.user@gmail.com' },
          { id: 'agy-legacy', email: 'legacy.enc@gmail.com' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(agyAccountsDir, 'agy-1.json'),
      JSON.stringify({
        id: 'agy-1',
        email: 'agy.user@gmail.com',
        disabled: false,
        token: {
          access_token: 'secret_agy_access_token_token123',
          refresh_token: 'secret_agy_refresh_token_refresh123',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }),
    );
    fs.writeFileSync(
      path.join(agyAccountsDir, 'agy-legacy.json'),
      JSON.stringify({
        id: 'agy-legacy',
        email: 'legacy.enc@gmail.com',
        token: {
          ciphertext: 'enc_ciphertext_dummy',
          nonce: 'dummy_nonce',
          algorithm: 'AES-256-GCM',
        },
      }),
    );

    // 2. Codex fixture
    fs.writeFileSync(
      path.join(cockpitDir, 'codex_accounts.json'),
      JSON.stringify({
        version: '1.0',
        accounts: [
          { id: 'codex-1', email: 'codex.user@openai.test' },
          { id: 'codex-key', email: 'codex.key@openai.test' },
          { id: 'chatgpt_plan_demo', email: 'plan.user@openai.test' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(codexAccountsDir, 'codex-1.json'),
      JSON.stringify({
        id: 'codex-1',
        email: 'codex.user@openai.test',
        auth_mode: 'oauth',
        account_id: 'acc-codex-123',
        plan_type: 'plus',
        tokens: {
          id_token: 'dummy.jwt.id_token_secret',
          access_token: 'secret_codex_access_token_456',
          refresh_token: 'secret_codex_refresh_token_789',
        },
      }),
    );
    fs.writeFileSync(
      path.join(codexAccountsDir, 'codex-key.json'),
      JSON.stringify({
        id: 'codex-key',
        email: 'codex.key@openai.test',
        auth_mode: 'apikey',
        openai_api_key: 'sk-secret-codex-api-key',
      }),
    );
    fs.writeFileSync(
      path.join(codexAccountsDir, 'chatgpt_plan_demo.json'),
      JSON.stringify({
        id: 'chatgpt_plan_demo',
        email: 'plan.user@openai.test',
        auth_mode: 'oauth',
        api_provider_id: 'cockpit_chatgpt_plan',
      }),
    );

    // 3. Claude fixture
    fs.writeFileSync(
      path.join(cockpitDir, 'claude_accounts.json'),
      JSON.stringify({
        version: '1.0',
        accounts: [
          { id: 'claude-1', email: 'claude.user@anthropic.test' },
          { id: 'claude-desktop', email: 'desktop.user@anthropic.test' },
          { id: 'claude-key', email: 'key.user@anthropic.test' },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-1.json'),
      JSON.stringify({
        id: 'claude-1',
        email: 'claude.user@anthropic.test',
        auth_mode: 'oauth',
        account_uuid: 'acc-uuid-123',
        organization_uuid: 'org-uuid-456',
        organization_name: 'Test Org',
        plan_type: 'pro',
        claude_credentials_raw: {
          claudeAiOauth: {
            accessToken: 'secret_claude_access_token_oat01',
            refreshToken: 'secret_claude_refresh_token_ort01',
            subscriptionType: 'Pro',
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-desktop.json'),
      JSON.stringify({
        id: 'claude-desktop',
        email: 'desktop.user@anthropic.test',
        auth_mode: 'desktop_oauth',
      }),
    );
    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-key.json'),
      JSON.stringify({
        id: 'claude-key',
        email: 'key.user@anthropic.test',
        auth_mode: 'api_key',
      }),
    );

    // 4. Corrupted file fixture
    fs.writeFileSync(path.join(agyAccountsDir, 'corrupt.json'), '{"id": "corrupt", broken json');

    // Config & Context
    config = loadConfig(tmpDir);
    config.multiplePerProvider = true;
    config.integrations.cockpit = {
      dataDir: cockpitDir,
      autoSync: {
        enabled: false,
        intervalMinutes: 30,
        engines: ['antigravity'],
      },
    };

    token = getOrCreateToken(config.tokenPath);
    ctx = createContext(config);
    server = await createServer(ctx.service, config);
    await server.ready();

    // Mock network fetch for Google and Anthropic OAuth checks
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'google_mock_access_token_123',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'google_mock_refresh_token_123',
          }),
        } as Response;
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            email: 'agy.user@gmail.com',
            picture: 'https://example.com/avatar.png',
          }),
        } as Response;
      }
      if (urlStr.includes('cloudcode-pa.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tier: 'TIER_STANDARD',
          }),
        } as Response;
      }
      if (urlStr.includes('api.anthropic.com/api/oauth/profile')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: {
              email_address: 'claude.user@anthropic.test',
              uuid: 'acc-uuid-123',
              subscription_type: 'Pro',
            },
            organization: {
              uuid: 'org-uuid-456',
              name: 'Test Org',
              billing_type: 'pro',
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response;
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (previousAgyBin === undefined) delete process.env.AGENTHUB_AGY_BIN;
    else process.env.AGENTHUB_AGY_BIN = previousAgyBin;

    await server.close();
    try {
      ctx.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('(a) GET /api/integrations/cockpit/scan returns 3 groups with metadata only, no tokens', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/integrations/cockpit/scan',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exists).toBe(true);
    expect(body.dataDir).toBe(cockpitDir);

    const sources = new Set(body.items.map((i: { source: string }) => i.source));
    expect(sources.has('antigravity')).toBe(true);
    expect(sources.has('codex')).toBe(true);
    expect(sources.has('claude')).toBe(true);

    const rawStr = res.payload;
    expect(rawStr).not.toContain('secret_agy');
    expect(rawStr).not.toContain('secret_codex');
    expect(rawStr).not.toContain('secret_claude');
    expect(rawStr).not.toContain('refresh_token');
    expect(rawStr).not.toContain('access_token');
  });

  it('(b) Antigravity import: imports new account and allows repeat sync update', async () => {
    // 1. First import: creates new profile
    const importRes1 = await ctx.service.importFromCockpit(
      [{ source: 'antigravity', cockpitId: 'agy-1' }],
      { verify: false },
    );
    expect(importRes1.importedCount).toBe(1);
    expect(importRes1.items[0].action).toBe('imported');
    expect(importRes1.items[0].status).toBe('ok');

    const profile = ctx.profileRepo.getAll().find((p) => p.email === 'agy.user@gmail.com');
    expect(profile).toBeDefined();
    expect(profile?.source).toBe('cockpit');
    expect(profile?.cockpitId).toBe('agy-1');

    // 2. Repeat sync: Antigravity allows repeat sync (updates existing profile)
    const importRes2 = await ctx.service.importFromCockpit(
      [{ source: 'antigravity', cockpitId: 'agy-1' }],
      { verify: false },
    );
    expect(importRes2.updatedCount).toBe(1);
    expect(importRes2.items[0].action).toBe('updated');
    expect(importRes2.items[0].status).toBe('ok');
  });

  it('(c) Codex import: imports new account, subsequent sync does NOT overwrite token (token rotation policy)', async () => {
    // 1. First import: imports new account
    const importRes1 = await ctx.service.importFromCockpit(
      [{ source: 'codex', cockpitId: 'codex-1' }],
      { verify: false },
    );
    expect(importRes1.importedCount).toBe(1);
    expect(importRes1.items[0].action).toBe('imported');
    expect(importRes1.items[0].status).toBe('ok');

    const profile = ctx.profileRepo.getAll().find((p) => p.email === 'codex.user@openai.test');
    expect(profile).toBeDefined();
    expect(profile?.source).toBe('cockpit');
    expect(profile?.cockpitId).toBe('codex-1');

    const authFile = path.join(profile!.home!, 'auth.json');
    expect(fs.existsSync(authFile)).toBe(true);

    // Modify auth.json in AgentHub to simulate token rotation by AgentHub
    const authContent = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    authContent.tokens.access_token = 'rotated_access_token_hub';
    fs.writeFileSync(authFile, JSON.stringify(authContent, null, 2));

    // 2. Second import: MUST NOT overwrite token; reports exists / skipped
    const importRes2 = await ctx.service.importFromCockpit(
      [{ source: 'codex', cockpitId: 'codex-1' }],
      { verify: false },
    );
    expect(importRes2.skippedCount).toBe(1);
    expect(importRes2.items[0].action).toBe('skipped');
    expect(importRes2.items[0].message).toContain('chỉ nhập một lần để tránh xoay vòng token');

    // Verify auth.json was NOT overwritten by Cockpit's token
    const authContentAfter = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    expect(authContentAfter.tokens.access_token).toBe('rotated_access_token_hub');
  });

  it('(d) Claude import: creates isolated profile with .credentials.json (mode 0600) and .claude.json, skips second import', async () => {
    // 1. First import
    const importRes = await ctx.service.importFromCockpit(
      [{ source: 'claude', cockpitId: 'claude-1' }],
      { verify: true },
    );
    expect(importRes.importedCount).toBe(1);
    expect(importRes.items[0].action).toBe('imported');
    expect(importRes.items[0].status).toBe('ok');

    const profile = ctx.profileRepo.getAll().find((p) => p.email === 'claude.user@anthropic.test');
    expect(profile).toBeDefined();
    expect(profile?.engine).toBe('claude');
    expect(profile?.source).toBe('cockpit');
    expect(profile?.cockpitId).toBe('claude-1');

    const homeDir = profile!.home!;
    const credsPath = path.join(homeDir, '.credentials.json');
    const claudeJsonPath = path.join(homeDir, '.claude.json');

    // Assert .credentials.json exists with mode 0600
    expect(fs.existsSync(credsPath)).toBe(true);
    const credsStat = fs.statSync(credsPath);
    expect(credsStat.mode & 0o777).toBe(0o600);

    const credsJson = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    expect(credsJson.claudeAiOauth?.accessToken).toBe('secret_claude_access_token_oat01');

    // Assert .claude.json exists with emailAddress and mode 0600
    expect(fs.existsSync(claudeJsonPath)).toBe(true);
    const claudeJsonStat = fs.statSync(claudeJsonPath);
    expect(claudeJsonStat.mode & 0o777).toBe(0o600);

    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(claudeJson.oauthAccount?.emailAddress).toBe('claude.user@anthropic.test');

    // 2. Second import: Claude also skips subsequent sync to prevent token rotation logout
    const secondImport = await ctx.service.importFromCockpit(
      [{ source: 'claude', cockpitId: 'claude-1' }],
      { verify: true },
    );
    expect(secondImport.skippedCount).toBe(1);
    expect(secondImport.items[0].action).toBe('skipped');
    expect(secondImport.items[0].message).toContain('chỉ nhập một lần để tránh xoay vòng token');
  });

  it('(e) skips desktop_oauth, api key, internal ChatGPT plan, and legacy encrypted envelope with reasons', async () => {
    const scan = ctx.service.scanCockpit();
    const items = scan.items;

    const enc = items.find((i) => i.cockpitId === 'agy-legacy');
    expect(enc?.importable).toBe(false);
    expect(enc?.skipReason).toContain('Token mã hoá kiểu cũ');

    const codexKey = items.find((i) => i.cockpitId === 'codex-key');
    expect(codexKey?.importable).toBe(false);
    expect(codexKey?.skipReason).toContain('Bỏ qua tài khoản API key');

    const chatgptPlan = items.find((i) => i.cockpitId === 'chatgpt_plan_demo');
    expect(chatgptPlan?.importable).toBe(false);
    expect(chatgptPlan?.skipReason).toContain('Bỏ qua tài khoản ChatGPT plan nội bộ');

    const desktopOAuth = items.find((i) => i.cockpitId === 'claude-desktop');
    expect(desktopOAuth?.importable).toBe(false);
    expect(desktopOAuth?.skipReason).toContain('Bỏ qua tài khoản desktop_oauth');

    const claudeKey = items.find((i) => i.cockpitId === 'claude-key');
    expect(claudeKey?.importable).toBe(false);
    expect(claudeKey?.skipReason).toContain('Bỏ qua tài khoản API key');
  });

  it('(f) corrupt JSON file only marks that single item as failed', async () => {
    const scan = ctx.service.scanCockpit();
    const corruptItem = scan.items.find((i) => i.cockpitId === 'corrupt');
    expect(corruptItem).toBeDefined();
    expect(corruptItem?.importable).toBe(false);
    expect(corruptItem?.skipReason).toContain('File JSON hỏng');

    // Other items are still fine
    const agy1 = scan.items.find((i) => i.cockpitId === 'agy-1');
    expect(agy1?.importable).toBe(true);
  });

  it('(g) Cockpit directory is strictly read-only: does not write anything to Cockpit files', async () => {
    const beforeState = hashDirectory(cockpitDir);

    // Perform scan and imports
    ctx.service.scanCockpit();
    await ctx.service.importFromCockpit([
      { source: 'antigravity', cockpitId: 'agy-1' },
      { source: 'codex', cockpitId: 'codex-1' },
      { source: 'claude', cockpitId: 'claude-1' },
    ], { verify: false });

    const afterState = hashDirectory(cockpitDir);

    // Verify all file paths, hashes, and mtimes are untouched
    expect(Object.keys(afterState).sort()).toEqual(Object.keys(beforeState).sort());
    for (const [file, before] of Object.entries(beforeState)) {
      const after = afterState[file];
      expect(after.hash).toBe(before.hash);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    }
  });

  it('(h) autoSync only imports new accounts for enabled engines and notifies Telegram', async () => {
    const broadcastMock = vi.fn();
    (ctx.service as unknown as { telegramBotService: unknown }).telegramBotService = {
      broadcastMessage: broadcastMock,
    };

    // Configure autoSync
    ctx.config.integrations.cockpit.autoSync = {
      enabled: true,
      intervalMinutes: 30,
      engines: ['antigravity', 'claude'],
    };

    // Pre-create an existing Antigravity profile with same email to test "only new accounts"
    ctx.profileRepo.upsert({
      name: 'pre_existing_agy',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy_home'),
      email: 'agy.user@gmail.com',
      enabled: 1,
    });

    // Run autoSync
    const importedCount = await ctx.service.runCockpitAutoSync();

    // agy.user@gmail.com already exists, so only claude-1 is new and in engines!
    expect(importedCount).toBe(1);
    expect(broadcastMock).toHaveBeenCalledWith('Đã nhập 1 tài khoản mới từ Cockpit');

    // Running autoSync again imports 0 accounts because all are now existing
    const countSecond = await ctx.service.runCockpitAutoSync();
    expect(countSecond).toBe(0);
  });

  it('(i) events and logs never contain token strings', async () => {
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('profile.imported', (_taskId, payload) => {
      emittedEvents.push({ type: 'profile.imported', payload: payload as Record<string, unknown> });
    });

    await ctx.service.importFromCockpit([
      { source: 'antigravity', cockpitId: 'agy-1' },
      { source: 'codex', cockpitId: 'codex-1' },
      { source: 'claude', cockpitId: 'claude-1' },
    ], { verify: false });

    expect(emittedEvents.length).toBe(3);
    for (const event of emittedEvents) {
      expect(event.payload.source).toBe('cockpit');
      expect(event.payload.email).toBeDefined();
      expect(event.payload.engine).toBeDefined();

      const eventStr = JSON.stringify(event);
      expect(eventStr).not.toContain('secret_agy');
      expect(eventStr).not.toContain('secret_codex');
      expect(eventStr).not.toContain('secret_claude');
      expect(eventStr).not.toContain('access_token');
      expect(eventStr).not.toContain('refresh_token');
      expect(eventStr).not.toContain('id_token');
    }
  });

  it('POST /api/integrations/cockpit/import works via HTTP API', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/integrations/cockpit/import',
      headers: authHeaders(),
      payload: {
        items: [{ source: 'antigravity', cockpitId: 'agy-1' }],
        verify: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.importedCount).toBe(1);
    expect(body.items[0].email).toBe('agy.user@gmail.com');
  });
});
