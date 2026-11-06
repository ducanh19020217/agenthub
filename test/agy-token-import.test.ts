import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { exchangeAgyRefreshToken, writeAgyIsolatedToken, readAgyAccessToken, inspectAgyAccessToken, agyTierToPlan } from '../src/profiles/agyToken.js';
import { createContext } from '../src/daemon.js';

describe('Antigravity Token Import from Cockpit', () => {
  let tmpDir: string;
  let agyHomesDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let originalFetch: typeof globalThis.fetch;
  let previousAgyBin: string | undefined;

  /** Chờ các lượt Check tự chạy sau khi nhập token kết thúc (agy giả, không bao giờ agy thật). */
  async function waitForChecks(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (ctx.service['profileChecks'].size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeEach(() => {
    previousAgyBin = process.env.AGENTHUB_AGY_BIN;
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-usage.mjs');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-agy-import-test-'));
    agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.multiplePerProvider = true;

    ctx = createContext(config);
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    await waitForChecks();
    globalThis.fetch = originalFetch;
    if (previousAgyBin === undefined) delete process.env.AGENTHUB_AGY_BIN;
    else process.env.AGENTHUB_AGY_BIN = previousAgyBin;
    try {
      ctx.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('exchangeAgyRefreshToken exchanges valid refresh token for access token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'mock_access_token_xyz',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const res = await exchangeAgyRefreshToken('mock_refresh_token_abc');
    expect(res.accessToken).toBe('mock_access_token_xyz');
    expect(res.tokenType).toBe('Bearer');
    expect(res.refreshToken).toBe('mock_refresh_token_abc');
    expect(typeof res.expiry).toBe('string');
  });

  it('exchangeAgyRefreshToken throws descriptive error on invalid_grant', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Token has been revoked or expired',
      }),
    } as unknown as Response);

    await expect(exchangeAgyRefreshToken('bad_token')).rejects.toThrow(
      /Refresh token không hợp lệ hoặc đã bị thu hồi\/hết hạn/,
    );
  });

  it('writeAgyIsolatedToken creates token file with 0600 permissions and auth log', () => {
    const profileHome = path.join(agyHomesDir, 'test_user');
    fs.mkdirSync(profileHome, { recursive: true });

    writeAgyIsolatedToken(
      profileHome,
      {
        accessToken: 'access_123',
        refreshToken: 'refresh_123',
        tokenType: 'Bearer',
        expiry: '2026-12-31T00:00:00.000Z',
      },
      'test_user@example.com',
    );

    const tokenFile = path.join(profileHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    expect(fs.existsSync(tokenFile)).toBe(true);

    const stat = fs.statSync(tokenFile);
    expect(stat.mode & 0o777).toBe(0o600);

    const logFile = path.join(profileHome, '.gemini', 'antigravity-cli', 'log', 'auth.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, 'utf8');
    expect(logContent).toContain('authenticated successfully as test_user@example.com');
  });

  it('importAgyTokens successfully imports single and array Cockpit tokens into database without leaking secrets', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'live_access_token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const input = [
      {
        email: 'huy1071718@gmail.com',
        refresh_token: '1//mock_refresh_token_huy',
      },
      {
        email: 'second_user@example.com',
        refresh_token: '1//mock_refresh_token_second',
      },
    ];

    const result = await ctx.service.importAgyTokens(input);

    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.failedCount).toBe(0);

    // Ensure secrets are never exposed in result
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('1//mock_refresh_token_huy');
    expect(serialized).not.toContain('live_access_token');

    // Verify profiles in database
    const prof1 = ctx.profileRepo.get('huy1071718');
    expect(prof1).toBeDefined();
    expect(prof1?.email).toBe('huy1071718@gmail.com');
    expect(prof1?.engine).toBe('agy');
    expect(prof1?.authState).toBe('ok');

    const prof2 = ctx.profileRepo.get('second_user');
    expect(prof2).toBeDefined();
    expect(prof2?.email).toBe('second_user@example.com');
    expect(prof2?.authState).toBe('ok');
  });

  it('importAgyTokens updates token for existing profile with the same email without duplicating', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'updated_token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    // First import
    await ctx.service.importAgyTokens({
      email: 'my_account@gmail.com',
      refresh_token: 'token_v1',
    });

    expect(ctx.profileRepo.get('my_account')?.email).toBe('my_account@gmail.com');

    // Second import with new token
    const result2 = await ctx.service.importAgyTokens({
      email: 'my_account@gmail.com',
      refresh_token: 'token_v2',
    });

    expect(result2.successCount).toBe(1);
    expect(result2.results[0].action).toBe('updated');
    expect(result2.results[0].name).toBe('my_account');
  });

  it('importAgyTokens isolates errors per item', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = String(init?.body || '');
      if (body.includes('bad_token')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'good_token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as unknown as Response;
    });

    const result = await ctx.service.importAgyTokens([
      { email: 'bad@example.com', refresh_token: 'bad_token' },
      { email: 'good@example.com', refresh_token: 'good_token' },
    ]);

    expect(result.total).toBe(2);
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(1);

    expect(ctx.profileRepo.get('bad')).toBeUndefined();
    expect(ctx.profileRepo.get('good')).toBeDefined();
  });
  function mockOkFetch() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'ok_token', expires_in: 3600, token_type: 'Bearer' }),
    } as unknown as Response);
  }

  it('importAgyTokens updates the existing agy profile that already has the email, even under another name', async () => {
    mockOkFetch();
    ctx.service.createProfile({ name: 'g1', engine: 'agy', accountType: 'team' });
    ctx.profileRepo.upsert({ ...ctx.profileRepo.get('g1')!, email: 'owner@example.com' });

    const result = await ctx.service.importAgyTokens({ email: 'Owner@Example.com', refresh_token: 'tok' });

    expect(result.results[0]).toMatchObject({ name: 'g1', action: 'updated', status: 'ok' });
    expect(ctx.profileRepo.get('owner')).toBeUndefined();
    expect(ctx.profileRepo.get('g1')?.accountType).toBe('team');
  });

  it('importAgyTokens never writes into a profile of another engine or a keyring profile', async () => {
    mockOkFetch();
    ctx.service.createProfile({ name: 'cx', engine: 'codex', accountType: 'team' });

    const result = await ctx.service.importAgyTokens([{ email: 'a@example.com', refresh_token: 'tok', name: 'cx' }]);

    expect(result.results[0].status).toBe('error');
    expect(ctx.profileRepo.get('cx')?.engine).toBe('codex');
    expect(fs.existsSync(path.join(agyHomesDir, 'cx'))).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('importAgyTokens respects multiplePerProvider instead of silently enabling it', async () => {
    mockOkFetch();
    config.multiplePerProvider = false;

    const result = await ctx.service.importAgyTokens([
      { email: 'p1@example.com', refresh_token: 't1' },
      { email: 'p2@example.com', refresh_token: 't2' },
    ]);

    expect(config.multiplePerProvider).toBe(false);
    expect(result.results[1].status).toBe('error');
    expect(ctx.profileRepo.get('p2')).toBeUndefined();
  });

  it('writeAgyIsolatedToken replaces the auth log so the latest email wins', () => {
    const profileHome = path.join(agyHomesDir, 'swap');
    writeAgyIsolatedToken(profileHome, { refreshToken: 'r1' }, 'old@example.com');
    writeAgyIsolatedToken(profileHome, { refreshToken: 'r2' }, 'new@example.com');
    const log = fs.readFileSync(path.join(profileHome, '.gemini', 'antigravity-cli', 'log', 'auth.log'), 'utf8');
    expect(log).toContain('new@example.com');
    expect(log).not.toContain('old@example.com');
  });
  it('importAgyTokens signs an existing not-logged-in agy profile in by name', async () => {
    mockOkFetch();
    ctx.service.createProfile({ name: 'g5', engine: 'agy', accountType: 'personal' });

    const result = await ctx.service.importAgyTokens({
      tokens: [{ name: 'g5', email: 'g5@example.com', refresh_token: 'tok' }],
      accountType: 'personal',
    });

    expect(result.results[0]).toMatchObject({ name: 'g5', action: 'updated', status: 'ok' });
    expect(ctx.profileRepo.get('g5')).toMatchObject({ email: 'g5@example.com', authState: 'ok' });
    expect(fs.existsSync(path.join(agyHomesDir, 'g5', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))).toBe(true);
  });

  it('importAgyTokens fetches Google user avatar and stores in database', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'mock_access_token_avatar',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        } as unknown as Response;
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sub: '123456789',
            email: 'avatar_user@example.com',
            picture: 'https://lh3.googleusercontent.com/a/mock_avatar_img_123',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const result = await ctx.service.importAgyTokens([
      { email: 'avatar_user@example.com', refresh_token: 'mock_rt_avatar' },
    ]);

    expect(result.success).toBe(true);
    const profile = ctx.profileRepo.get('avatar_user');
    expect(profile).toBeDefined();
    expect(profile?.avatarUrl).toBe('https://lh3.googleusercontent.com/a/mock_avatar_img_123');
  });

  it('importAgyTokens drops the previous avatar when a profile switches to another account', async () => {
    mockOkFetch();
    ctx.service.createProfile({ name: 'g6', engine: 'agy', accountType: 'personal' });
    ctx.profileRepo.upsert({ ...ctx.profileRepo.get('g6')!, email: 'old@example.com' });
    ctx.profileRepo.updateAvatarUrl('g6', 'https://lh3.googleusercontent.com/a/old');

    // mockOkFetch trả về userinfo không có picture
    await ctx.service.importAgyTokens({ tokens: [{ name: 'g6', email: 'new@example.com', refresh_token: 'tok' }] });

    expect(ctx.profileRepo.get('g6')).toMatchObject({ email: 'new@example.com', avatarUrl: null });
  });

  describe('syncAgyAvatarFromToken (DEC-007)', () => {
    const picture = 'https://lh3.googleusercontent.com/a/terminal';
    function setupProfile(expiry: string) {
      ctx.service.createProfile({ name: 'term', engine: 'agy', accountType: 'personal' });
      ctx.profileRepo.upsert({ ...ctx.profileRepo.get('term')!, email: 'term@example.com' });
      writeAgyIsolatedToken(path.join(agyHomesDir, 'term'), { accessToken: 'at', refreshToken: 'rt', expiry });
    }
    function mockUserInfo(email: string) {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ email, picture }),
      } as unknown as Response);
    }

    it('stores the avatar using a still-valid access token without rewriting the token file', async () => {
      setupProfile(new Date(Date.now() + 3_600_000).toISOString());
      const tokenFile = path.join(agyHomesDir, 'term', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
      const before = fs.readFileSync(tokenFile, 'utf8');
      mockUserInfo('term@example.com');

      expect(await ctx.service.syncAgyAvatarFromToken('term')).toMatchObject({ avatarUrl: picture, message: 'Đã cập nhật ảnh đại diện' });
      expect(ctx.profileRepo.get('term')?.avatarUrl).toBe(picture);
      expect(fs.readFileSync(tokenFile, 'utf8')).toBe(before);
      expect(vi.mocked(globalThis.fetch).mock.calls[0][0]).toContain('/oauth2/v3/userinfo');
    });

    it('refreshUsage (nút Làm mới) also picks up the avatar', async () => {
      setupProfile(new Date(Date.now() + 3_600_000).toISOString());
      mockUserInfo('term@example.com');
      vi.spyOn(ctx.service.usageService, 'collect').mockResolvedValue([]);

      const profile = await ctx.service.refreshUsage('term');

      expect(profile?.avatarUrl).toBe(picture);
      expect(profile?.avatarMessage).toBe('Đã cập nhật ảnh đại diện');
    });

    it('explains why no avatar was fetched', async () => {
      setupProfile(new Date(Date.now() + 3_600_000).toISOString());
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 } as unknown as Response);
      expect((await ctx.service.syncAgyAvatarFromToken('term')).message).toMatch(/HTTP 403/);

      fs.rmSync(path.join(agyHomesDir, 'term', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
      expect((await ctx.service.syncAgyAvatarFromToken('term')).message).toMatch(/Chưa có file token/);
    });

    it('does not refresh an expired token', async () => {
      setupProfile(new Date(Date.now() - 1000).toISOString());
      mockUserInfo('term@example.com');

      expect((await ctx.service.syncAgyAvatarFromToken('term')).message).toMatch(/hết hạn/);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(readAgyAccessToken(path.join(agyHomesDir, 'term'))).toBeNull();
    });

    it('ignores the picture when Google reports another email', async () => {
      setupProfile(new Date(Date.now() + 3_600_000).toISOString());
      mockUserInfo('someone-else@example.com');

      expect((await ctx.service.syncAgyAvatarFromToken('term')).message).toMatch(/tài khoản khác/);
      expect(ctx.profileRepo.get('term')?.avatarUrl ?? null).toBeNull();
    });
  });

  it('readAgyAccessToken understands nested camelCase token files written by agy itself', () => {
    const home = path.join(agyHomesDir, 'agy_format');
    const dir = path.join(home, '.gemini', 'antigravity-cli');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'antigravity-oauth-token');

    fs.writeFileSync(file, JSON.stringify({ email: 'x@example.com', token: { accessToken: 'nested_at', expiresAt: Date.now() + 3_600_000 } }));
    expect(readAgyAccessToken(home)).toBe('nested_at');

    fs.writeFileSync(file, JSON.stringify({ credentials: { access_token: 'old_at', expiry_date: Math.floor(Date.now() / 1000) - 10 } }));
    expect(readAgyAccessToken(home)).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ secretBlob: 'abc123', meta: { kind: 'x' } }));
    const result = inspectAgyAccessToken(home);
    expect(result).toEqual({ skip: 'no_access_token', fieldNames: ['secretBlob', 'meta.kind'] });
    expect(JSON.stringify(result)).not.toContain('abc123');
  });

  it('writes the token file in the same structure agy itself uses', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => ({
      ok: true,
      status: 200,
      json: async () => String(url).includes('/token')
        ? { access_token: 'at_1', expires_in: 3599, token_type: 'Bearer', id_token: 'idt_1' }
        : {},
    }) as unknown as Response);

    await ctx.service.importAgyTokens({ email: 'shape@example.com', refresh_token: 'rt_1' });

    const file = path.join(agyHomesDir, 'shape', '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved).toEqual({
      token: { access_token: 'at_1', token_type: 'Bearer', refresh_token: 'rt_1', expiry: expect.any(String), expires_in: 3599 },
      auth_method: 'consumer',
      id_token: 'idt_1',
    });
    expect(Number.isFinite(Date.parse(saved.token.expiry))).toBe(true);
    expect(readAgyAccessToken(path.join(agyHomesDir, 'shape'))).toBe('at_1');
  });

  describe('automatic check with agy after import', () => {
    it('confirms the imported account with agy and stores its quota', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'auto_at', expires_in: 3600, token_type: 'Bearer' }),
      } as unknown as Response);
      const events: unknown[] = [];
      ctx.scheduler.getEventBus().on('profile.check', (_taskId: unknown, payload: unknown) => events.push(payload));

      const result = await ctx.service.importAgyTokens({ email: 'auto@example.com', refresh_token: 'rt' });
      expect(result.results[0].message).toMatch(/đang kiểm tra với agy/);
      await waitForChecks();

      expect(ctx.profileRepo.get('auto')?.authState).toBe('ok');
      expect(ctx.service.usageService.getForProfile('auto').length).toBeGreaterThan(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ name: 'auto', ok: true });
    });

    it('reports not logged in when agy cannot use the token file', async () => {
      ctx.service.createProfile({ name: 'flat', engine: 'agy', accountType: 'team' });
      const dir = path.join(agyHomesDir, 'flat', '.gemini', 'antigravity-cli');
      fs.mkdirSync(dir, { recursive: true });
      // Định dạng phẳng cũ mà agy thật đã từ chối.
      fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), JSON.stringify({ access_token: 'a', refresh_token: 'r' }));

      ctx.service.startProfileCheck('flat');
      await waitForChecks();

      expect(ctx.profileRepo.get('flat')?.authState).toBe('not_logged_in');
    });

    it('skips the agy check when verify is off (CLI)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'cli_at', expires_in: 3600, token_type: 'Bearer' }),
      } as unknown as Response);

      const result = await ctx.service.importAgyTokens({ email: 'cli@example.com', refresh_token: 'rt' }, { verify: false });

      expect(result.results[0].message).not.toMatch(/kiểm tra/);
      expect(ctx.service['profileChecks'].size).toBe(0);
    });
  });

  describe('Google AI plan from loadCodeAssist (like Cockpit tools)', () => {
    function mockGoogle(tier: Record<string, unknown> | number) {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('loadCodeAssist')) {
          if (typeof tier === 'number') return { ok: false, status: tier, json: async () => ({}) } as unknown as Response;
          expect(JSON.parse(String(init?.body))).toMatchObject({ metadata: { ideType: 'ANTIGRAVITY', pluginType: 'GEMINI' }, mode: 'FULL_ELIGIBILITY_CHECK' });
          return { ok: true, status: 200, json: async () => tier } as unknown as Response;
        }
        if (target.includes('userinfo')) {
          return { ok: true, status: 200, json: async () => ({ email: 'tier@example.com', picture: 'https://x/p.png' }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' }) } as unknown as Response;
      });
    }

    it.each([
      ['g1-ultra-tier', 'ultra'],
      ['g1-pro-tier', 'pro'],
      ['free-tier', 'free'],
      ['standard-tier', 'free'],
      ['', null],
    ])('maps tier %s to %s', (tierId, plan) => {
      expect(agyTierToPlan(tierId)).toBe(plan);
    });

    it('prefers paidTier over currentTier when importing a refresh token', async () => {
      mockGoogle({ paidTier: { id: 'g1-pro-tier' }, currentTier: { id: 'free-tier' } });
      await ctx.service.importAgyTokens({ email: 'tier@example.com', refresh_token: 'rt' }, { verify: false });
      expect(ctx.profileRepo.get('tier')?.plan).toBe('pro');
    });

    it('updates the plan on refresh and explains when it cannot be read', async () => {
      ctx.service.createProfile({ name: 'tier', engine: 'agy', accountType: 'personal' });
      ctx.profileRepo.upsert({ ...ctx.profileRepo.get('tier')!, email: 'tier@example.com' });
      writeAgyIsolatedToken(path.join(agyHomesDir, 'tier'), { accessToken: 'at', refreshToken: 'rt', expiry: new Date(Date.now() + 3_600_000).toISOString() });

      mockGoogle({ currentTier: { id: 'g1-ultra-tier' } });
      expect((await ctx.service.syncAgyAvatarFromToken('tier')).message).toMatch(/Gói ULTRA/);
      expect(ctx.profileRepo.get('tier')?.plan).toBe('ultra');

      mockGoogle(403);
      expect((await ctx.service.syncAgyAvatarFromToken('tier')).message).toMatch(/Không đọc được gói \(HTTP 403\)/);
      expect(ctx.profileRepo.get('tier')?.plan).toBe('ultra');
    });
  });
});

