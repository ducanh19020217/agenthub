import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveCockpitDir,
  scanCockpit,
  readCockpitAgyAccount,
  readCockpitCodexAccount,
  readCockpitClaudeAccount,
} from '../src/profiles/cockpit.js';
import type { ProfileRow } from '../src/db/index.js';

describe('Cockpit Storage Scanner (src/profiles/cockpit.ts)', () => {
  let tmpDir: string;
  let cockpitDir: string;
  const originalEnv = process.env.COCKPIT_TOOLS_DATA_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cockpit-scan-test-'));
    cockpitDir = path.join(tmpDir, '.cockpit_tools');
    fs.mkdirSync(cockpitDir, { recursive: true });
    delete process.env.COCKPIT_TOOLS_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.COCKPIT_TOOLS_DATA_DIR = originalEnv;
    } else {
      delete process.env.COCKPIT_TOOLS_DATA_DIR;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('resolveCockpitDir resolves in correct priority order', () => {
    // 1. Explicit argument overrides all
    expect(resolveCockpitDir('/custom/dir')).toBe(path.resolve('/custom/dir'));

    // 2. Environment variable overrides default
    process.env.COCKPIT_TOOLS_DATA_DIR = '/env/cockpit/dir';
    expect(resolveCockpitDir()).toBe(path.resolve('/env/cockpit/dir'));
    delete process.env.COCKPIT_TOOLS_DATA_DIR;

    // 3. Current default ~/.cockpit_tools
    const resolved = resolveCockpitDir();
    expect(resolved).toContain('.cockpit_tools');
  });

  it('scanCockpit returns 3 groups with metadata only, and never returns tokens', () => {
    // 1. Setup Antigravity
    const agyAccountsDir = path.join(cockpitDir, 'accounts');
    fs.mkdirSync(agyAccountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(cockpitDir, 'accounts.json'),
      JSON.stringify({
        version: '2.0',
        accounts: [{ id: 'agy-1', email: 'agy1@example.com' }],
      }),
    );
    fs.writeFileSync(
      path.join(agyAccountsDir, 'agy-1.json'),
      JSON.stringify({
        id: 'agy-1',
        email: 'agy1@example.com',
        disabled: false,
        token: {
          access_token: 'secret_agy_access_token_12345',
          refresh_token: 'secret_agy_refresh_token_67890',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }),
    );

    // 2. Setup Codex
    const codexAccountsDir = path.join(cockpitDir, 'codex_accounts');
    fs.mkdirSync(codexAccountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(cockpitDir, 'codex_accounts.json'),
      JSON.stringify({
        version: '1.0',
        accounts: [{ id: 'codex-1', email: 'codex1@example.com' }],
      }),
    );
    fs.writeFileSync(
      path.join(codexAccountsDir, 'codex-1.json'),
      JSON.stringify({
        id: 'codex-1',
        email: 'codex1@example.com',
        auth_mode: 'oauth',
        account_id: 'acc-123',
        plan_type: 'plus',
        tokens: {
          id_token: 'secret_codex_id_token_abc',
          access_token: 'secret_codex_access_token_def',
          refresh_token: 'secret_codex_refresh_token_ghi',
        },
      }),
    );

    // 3. Setup Claude
    const claudeAccountsDir = path.join(cockpitDir, 'claude_accounts');
    fs.mkdirSync(claudeAccountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(cockpitDir, 'claude_accounts.json'),
      JSON.stringify({
        version: '1.0',
        accounts: [{ id: 'claude-1', email: 'claude1@example.com' }],
      }),
    );
    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-1.json'),
      JSON.stringify({
        id: 'claude-1',
        email: 'claude1@example.com',
        auth_mode: 'oauth',
        claude_credentials_raw: {
          claudeAiOauth: {
            accessToken: 'secret_claude_access_token_jkl',
            refreshToken: 'secret_claude_refresh_token_mno',
            subscriptionType: 'Pro',
          },
        },
      }),
    );

    const existingProfiles: ProfileRow[] = [
      {
        name: 'agy_existing',
        engine: 'agy',
        kind: 'isolated',
        home: '/home/test',
        email: 'agy1@example.com',
        enabled: 1,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const result = scanCockpit(cockpitDir, existingProfiles);
    expect(result.exists).toBe(true);
    expect(result.schemaVersion).toContain('accounts:2.0');
    expect(result.items.length).toBe(3);

    // Verify groups
    const agyItem = result.items.find((i) => i.source === 'antigravity');
    const codexItem = result.items.find((i) => i.source === 'codex');
    const claudeItem = result.items.find((i) => i.source === 'claude');

    expect(agyItem).toBeDefined();
    expect(codexItem).toBeDefined();
    expect(claudeItem).toBeDefined();

    // Verify Antigravity
    expect(agyItem?.cockpitId).toBe('agy-1');
    expect(agyItem?.email).toBe('agy1@example.com');
    expect(agyItem?.importable).toBe(true);
    expect(agyItem?.hubStatus).toBe('exists');

    // Verify Codex
    expect(codexItem?.cockpitId).toBe('codex-1');
    expect(codexItem?.email).toBe('codex1@example.com');
    expect(codexItem?.importable).toBe(true);
    expect(codexItem?.hubStatus).toBe('new');

    // Verify Claude
    expect(claudeItem?.cockpitId).toBe('claude-1');
    expect(claudeItem?.email).toBe('claude1@example.com');
    expect(claudeItem?.importable).toBe(true);
    expect(claudeItem?.hubStatus).toBe('new');

    // Strict assertion: stringified result MUST NOT contain any secret tokens
    const jsonStr = JSON.stringify(result);
    expect(jsonStr).not.toContain('secret_agy');
    expect(jsonStr).not.toContain('secret_codex');
    expect(jsonStr).not.toContain('secret_claude');
    expect(jsonStr).not.toContain('refresh_token');
    expect(jsonStr).not.toContain('access_token');
    expect(jsonStr).not.toContain('id_token');
  });

  it('skips desktop_oauth, api_key, ChatGPT plan, and legacy encrypted envelope with reasons', () => {
    const agyAccountsDir = path.join(cockpitDir, 'accounts');
    const codexAccountsDir = path.join(cockpitDir, 'codex_accounts');
    const claudeAccountsDir = path.join(cockpitDir, 'claude_accounts');
    fs.mkdirSync(agyAccountsDir, { recursive: true });
    fs.mkdirSync(codexAccountsDir, { recursive: true });
    fs.mkdirSync(claudeAccountsDir, { recursive: true });

    // 1. Antigravity legacy encrypted envelope
    fs.writeFileSync(
      path.join(agyAccountsDir, 'legacy-enc.json'),
      JSON.stringify({
        id: 'legacy-enc',
        email: 'legacy@example.com',
        token: {
          version: 1,
          algorithm: 'AES-256-GCM',
          ciphertext: 'encrypted_data_here',
          nonce: 'nonce123',
        },
      }),
    );

    // 2. Codex api_key
    fs.writeFileSync(
      path.join(codexAccountsDir, 'codex-apikey.json'),
      JSON.stringify({
        id: 'codex-apikey',
        email: 'apikey@example.com',
        auth_mode: 'apikey',
        openai_api_key: 'sk-123',
      }),
    );

    // 3. Codex ChatGPT plan nội bộ
    fs.writeFileSync(
      path.join(codexAccountsDir, 'chatgpt_plan_123.json'),
      JSON.stringify({
        id: 'chatgpt_plan_123',
        email: 'chatgpt@example.com',
        auth_mode: 'oauth',
        api_provider_id: 'cockpit_chatgpt_plan',
      }),
    );

    // 4. Claude desktop_oauth
    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-desktop.json'),
      JSON.stringify({
        id: 'claude-desktop',
        email: 'desktop@example.com',
        auth_mode: 'desktop_oauth',
      }),
    );

    // 5. Claude api_key
    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-key.json'),
      JSON.stringify({
        id: 'claude-key',
        email: 'claudekey@example.com',
        auth_mode: 'api_key',
      }),
    );

    const result = scanCockpit(cockpitDir, []);
    const encItem = result.items.find((i) => i.cockpitId === 'legacy-enc');
    expect(encItem?.importable).toBe(false);
    expect(encItem?.skipReason).toContain('Token mã hoá kiểu cũ');

    const apiKeyItem = result.items.find((i) => i.cockpitId === 'codex-apikey');
    expect(apiKeyItem?.importable).toBe(false);
    expect(apiKeyItem?.skipReason).toContain('Bỏ qua tài khoản API key');

    const chatgptPlanItem = result.items.find((i) => i.cockpitId === 'chatgpt_plan_123');
    expect(chatgptPlanItem?.importable).toBe(false);
    expect(chatgptPlanItem?.skipReason).toContain('Bỏ qua tài khoản ChatGPT plan nội bộ');

    const desktopOAuthItem = result.items.find((i) => i.cockpitId === 'claude-desktop');
    expect(desktopOAuthItem?.importable).toBe(false);
    expect(desktopOAuthItem?.skipReason).toContain('Bỏ qua tài khoản desktop_oauth');

    const claudeApiKeyItem = result.items.find((i) => i.cockpitId === 'claude-key');
    expect(claudeApiKeyItem?.importable).toBe(false);
    expect(claudeApiKeyItem?.skipReason).toContain('Bỏ qua tài khoản API key');
  });

  it('reads email, name and plan from the plaintext index when detail files use the current AES-GCM envelope', () => {
    const envelope = (kind: string) => JSON.stringify({
      version: 1, kind, algorithm: 'aes-256-gcm', key_id: 'k1', nonce: 'bm9uY2Vub25jZTEy', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
    });
    fs.mkdirSync(path.join(cockpitDir, 'accounts'), { recursive: true });
    fs.mkdirSync(path.join(cockpitDir, 'codex_accounts'), { recursive: true });
    fs.mkdirSync(path.join(cockpitDir, 'claude_accounts'), { recursive: true });
    fs.writeFileSync(path.join(cockpitDir, 'accounts.json'), JSON.stringify({
      version: '2', accounts: [{ id: 'antigravity_abc', email: 'Gem@Example.com', name: 'Gem One', created_at: 1, last_used: 1 }],
    }));
    fs.writeFileSync(path.join(cockpitDir, 'codex_accounts.json'), JSON.stringify({
      version: '1', accounts: [{ id: 'codex_def', email: 'cx@example.com', plan_type: 'plus', created_at: 1, last_used: 1 }],
    }));
    fs.writeFileSync(path.join(cockpitDir, 'claude_accounts.json'), JSON.stringify({
      version: '1', accounts: [{ id: 'claude_ghi', email: 'cl@example.com', plan_type: 'max', created_at: 1, last_used: 1 }],
    }));
    fs.writeFileSync(path.join(cockpitDir, 'accounts', 'antigravity_abc.json'), envelope('antigravity'));
    fs.writeFileSync(path.join(cockpitDir, 'codex_accounts', 'codex_def.json'), envelope('codex'));
    fs.writeFileSync(path.join(cockpitDir, 'claude_accounts', 'claude_ghi.json'), envelope('claude'));

    const result = scanCockpit(cockpitDir, []);
    const agy = result.items.find((i) => i.cockpitId === 'antigravity_abc');
    const codex = result.items.find((i) => i.cockpitId === 'codex_def');
    const claude = result.items.find((i) => i.cockpitId === 'claude_ghi');

    expect(agy).toMatchObject({ email: 'gem@example.com', name: 'Gem One', importable: false });
    expect(codex).toMatchObject({ email: 'cx@example.com', planType: 'plus', importable: false });
    expect(claude).toMatchObject({ email: 'cl@example.com', planType: 'max', importable: false });
    for (const item of [agy, codex, claude]) {
      expect(item?.skipReason).toContain('Cockpit đang mã hoá');
      expect(item?.skipReason).not.toContain('kiểu cũ');
    }
    expect(JSON.stringify(result)).not.toContain('ZmFrZS1jaXBoZXJ0ZXh0');
  });

  it('handles corrupt JSON in an account file gracefully without failing other accounts', () => {
    const agyAccountsDir = path.join(cockpitDir, 'accounts');
    fs.mkdirSync(agyAccountsDir, { recursive: true });

    // Valid account
    fs.writeFileSync(
      path.join(agyAccountsDir, 'valid.json'),
      JSON.stringify({
        id: 'valid',
        email: 'valid@example.com',
        token: { refresh_token: 'rt-123' },
      }),
    );

    // Corrupted file (invalid JSON syntax)
    fs.writeFileSync(path.join(agyAccountsDir, 'broken.json'), '{ invalid json ...');

    const result = scanCockpit(cockpitDir, []);
    expect(result.items.length).toBe(2);

    const validItem = result.items.find((i) => i.cockpitId === 'valid');
    expect(validItem?.importable).toBe(true);

    const brokenItem = result.items.find((i) => i.cockpitId === 'broken');
    expect(brokenItem?.importable).toBe(false);
    expect(brokenItem?.skipReason).toContain('File JSON hỏng');
  });

  it('detects hubStatus conflict when cockpitId matches existing profile with different email', () => {
    const claudeAccountsDir = path.join(cockpitDir, 'claude_accounts');
    fs.mkdirSync(claudeAccountsDir, { recursive: true });

    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-bound.json'),
      JSON.stringify({
        id: 'claude-bound',
        email: 'newemail@example.com',
        auth_mode: 'oauth',
        claude_credentials_raw: {
          claudeAiOauth: { accessToken: 'token-123' },
        },
      }),
    );

    const existingProfiles: ProfileRow[] = [
      {
        name: 'claude_old',
        engine: 'claude',
        kind: 'isolated',
        home: '/home/claude',
        email: 'oldemail@example.com',
        enabled: 1,
        source: 'cockpit',
        cockpitId: 'claude-bound',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const result = scanCockpit(cockpitDir, existingProfiles);
    const item = result.items.find((i) => i.cockpitId === 'claude-bound');
    expect(item?.hubStatus).toBe('conflict');
  });

  it('server-only read helpers retrieve account details correctly', () => {
    const agyAccountsDir = path.join(cockpitDir, 'accounts');
    const codexAccountsDir = path.join(cockpitDir, 'codex_accounts');
    const claudeAccountsDir = path.join(cockpitDir, 'claude_accounts');
    fs.mkdirSync(agyAccountsDir, { recursive: true });
    fs.mkdirSync(codexAccountsDir, { recursive: true });
    fs.mkdirSync(claudeAccountsDir, { recursive: true });

    fs.writeFileSync(
      path.join(agyAccountsDir, 'agy-read.json'),
      JSON.stringify({
        id: 'agy-read',
        email: 'agy@read.test',
        token: { refresh_token: 'rt-agy-test' },
      }),
    );
    const agyData = readCockpitAgyAccount(cockpitDir, 'agy-read');
    expect(agyData.email).toBe('agy@read.test');
    expect(agyData.refreshToken).toBe('rt-agy-test');

    fs.writeFileSync(
      path.join(codexAccountsDir, 'codex-read.json'),
      JSON.stringify({
        id: 'codex-read',
        email: 'codex@read.test',
        auth_mode: 'oauth',
        account_id: 'acc-codex',
        plan_type: 'plus',
        tokens: { id_token: 'id-t', access_token: 'acc-t', refresh_token: 'ref-t' },
      }),
    );
    const codexData = readCockpitCodexAccount(cockpitDir, 'codex-read');
    expect(codexData.email).toBe('codex@read.test');
    expect(codexData.tokens.access_token).toBe('acc-t');
    expect(codexData.accountId).toBe('acc-codex');

    fs.writeFileSync(
      path.join(claudeAccountsDir, 'claude-read.json'),
      JSON.stringify({
        id: 'claude-read',
        email: 'claude@read.test',
        auth_mode: 'oauth',
        organization_name: 'Org Test',
        plan_type: 'pro',
        claude_credentials_raw: {
          claudeAiOauth: { accessToken: 'cl-acc', refreshToken: 'cl-ref', subscriptionType: 'Pro' },
        },
      }),
    );
    const claudeData = readCockpitClaudeAccount(cockpitDir, 'claude-read');
    expect(claudeData.email).toBe('claude@read.test');
    expect(claudeData.claudeAiOauth.accessToken).toBe('cl-acc');
    expect(claudeData.organizationName).toBe('Org Test');
  });
});
