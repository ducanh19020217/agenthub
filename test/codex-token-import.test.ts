import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { parseCodexTokenItem } from '../src/profiles/codexToken.js';

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

const ID_TOKEN = jwt({ email: 'Coder@Example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-from-jwt', chatgpt_plan_type: 'plus' } });

function exportItem(overrides: Record<string, unknown> = {}) {
  return {
    id_token: ID_TOKEN,
    access_token: 'at-secret',
    refresh_token: 'rt-secret',
    account_id: 'acc-1',
    last_refresh: '2026-10-21T10:00:00Z',
    email: 'coder@example.com',
    type: 'codex',
    expired: '2026-10-31T10:00:00Z',
    ...overrides,
  };
}

describe('Codex token import', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let previousCodexBin: string | undefined;

  async function waitForChecks(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (ctx.service['profileChecks'].size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-import-'));
    previousCodexBin = process.env.AGENTHUB_CODEX_BIN;
    process.env.AGENTHUB_CODEX_BIN = path.resolve(__dirname, 'fixtures', 'fake-codex-login-status.mjs');
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    const config = loadConfig(tmpDir);
    config.agyHomesDir = path.join(tmpDir, 'agy-homes');
    config.multiplePerProvider = true;
    ctx = createContext(config);
  });

  afterEach(async () => {
    await waitForChecks();
    if (previousCodexBin === undefined) delete process.env.AGENTHUB_CODEX_BIN;
    else process.env.AGENTHUB_CODEX_BIN = previousCodexBin;
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes auth.json in Codex CLI format and verifies it with codex', async () => {
    const result = await ctx.service.importTokens({ engine: 'codex', tokens: [exportItem()] });

    expect(result.results[0]).toMatchObject({ name: 'coder', action: 'created', status: 'ok' });
    expect(JSON.stringify(result)).not.toContain('rt-secret');
    const profile = ctx.profileRepo.get('coder')!;
    expect(profile).toMatchObject({ engine: 'codex', kind: 'isolated', email: 'coder@example.com' });

    const authFile = path.join(profile.home!, 'auth.json');
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8'))).toEqual({
      OPENAI_API_KEY: null,
      tokens: { id_token: ID_TOKEN, access_token: 'at-secret', refresh_token: 'rt-secret', account_id: 'acc-1' },
      last_refresh: '2026-10-21T10:00:00Z',
    });
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);

    await waitForChecks();
    expect(ctx.profileRepo.get('coder')?.authState).toBe('ok');
    // Gói lấy từ chatgpt_plan_type trong id_token, trả qua API để UI gắn tag.
    expect(ctx.profileRepo.get('coder')?.plan).toBe('plus');
    expect(ctx.service.listProfiles().find((p) => p.name === 'coder')?.plan).toBe('plus');
  });

  it('updates the codex profile that already has the email instead of creating another', async () => {
    ctx.service.createProfile({ name: 'work', engine: 'codex', accountType: 'team' });
    ctx.profileRepo.upsert({ ...ctx.profileRepo.get('work')!, email: 'coder@example.com' });

    const result = await ctx.service.importTokens({ engine: 'codex', tokens: [exportItem()] }, { verify: false });

    expect(result.results[0]).toMatchObject({ name: 'work', action: 'updated', status: 'ok' });
    expect(ctx.profileRepo.get('coder')).toBeUndefined();
  });

  it('accepts a pasted auth.json and reads email and account id from id_token', () => {
    const parsed = parseCodexTokenItem({ tokens: { id_token: ID_TOKEN, access_token: 'a', refresh_token: 'r' }, last_refresh: 'bad' });
    expect(parsed).toMatchObject({ email: 'coder@example.com', accountId: 'acc-from-jwt' });
  });

  it('rejects entries that are not Codex or miss tokens, without touching agy profiles', async () => {
    ctx.service.createProfile({ name: 'g1', engine: 'agy', accountType: 'team' });
    const result = await ctx.service.importTokens({
      engine: 'codex',
      tokens: [exportItem({ type: 'antigravity' }), exportItem({ access_token: '' }), exportItem({ name: 'g1' })],
    }, { verify: false });

    expect(result.results.map((r) => r.status)).toEqual(['error', 'error', 'error']);
    expect(ctx.profileRepo.get('g1')?.engine).toBe('agy');
  });
});
