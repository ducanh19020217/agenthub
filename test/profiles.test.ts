import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { openDatabase, ProfileRepo, QuotaMarkRepo } from '../src/db/index.js';
import { ProfileService, isProfileLoggedIn } from '../src/profiles/index.js';
import { parseAuthState } from '../src/profiles/auth.js';

let tmpDir: string;
let agyHomesDir: string;
let config: ReturnType<typeof loadConfig>;
let db: ReturnType<typeof openDatabase>;
let profileRepo: ProfileRepo;
let quotaMarkRepo: QuotaMarkRepo;
let profileService: ProfileService;

describe('Profile import from ~/.agy-homes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00+07:00'));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-profile-test-'));
    agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');

    config = loadConfig(tmpDir);
    // Override agyHomesDir
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;

    db = openDatabase(config.dbPath);
    profileRepo = new ProfileRepo(db);
    quotaMarkRepo = new QuotaMarkRepo(db);
    profileService = new ProfileService(config, profileRepo, quotaMarkRepo);
  });

  it('reports quota transitions only for a new mark or a reset extension over ten minutes', () => {
    const now = Math.floor(Date.now() / 1000);
    profileRepo.upsert({ name: 'profile', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });
    expect(quotaMarkRepo.mark('profile', 'claude', now + 3600)).toBe(true);
    for (let i = 1; i < 20; i += 1) {
      expect(quotaMarkRepo.mark('profile', 'claude', now + 3600 + i * 30)).toBe(false);
    }
    expect(quotaMarkRepo.mark('profile', 'claude', now + 3600 + 21 * 60)).toBe(true);
  });

  it('reads Claude oauthAccount metadata and login state without accepting legacy files', () => {
    const home = path.join(config.hubHome, 'claude-homes', 'alice');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      oauthAccount: {
        emailAddress: 'alice@example.com',
        billingType: 'max',
        organizationName: 'Example Org',
        userRateLimitTier: 'tier-2',
      },
    }));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'config.json'), JSON.stringify({ email: 'wrong@example.com' }));

    expect(profileService.readClaudeAccount(home)).toEqual({ email: 'alice@example.com', plan: 'max', planId: 'max' });
    profileRepo.upsert({ name: 'alice', engine: 'claude', kind: 'isolated', home, email: null, enabled: 1 });
    expect(isProfileLoggedIn(profileRepo.get('alice')!)).toBe(true);
  });

  it('considers Claude credentials existence logged in even before oauthAccount metadata', () => {
    const home = path.join(config.hubHome, 'claude-homes', 'credentials');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.credentials.json'), 'do not read this');
    profileRepo.upsert({ name: 'credentials', engine: 'claude', kind: 'isolated', home, email: null, enabled: 1 });
    expect(isProfileLoggedIn(profileRepo.get('credentials')!)).toBe(true);
  });

  it('refuses to delete Claude homes outside the managed root, including symlinks', () => {
    const homesRoot = path.join(config.hubHome, 'claude-homes');
    fs.mkdirSync(homesRoot, { recursive: true });
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const linked = path.join(homesRoot, 'linked');
    fs.symlinkSync(outside, linked);
    profileRepo.upsert({ name: 'linked', engine: 'claude', kind: 'isolated', home: linked, email: null, enabled: 1 });

    expect(() => profileService.deleteProfile('linked')).toThrow(/ngoài claude-homes/);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    expect(profileRepo.get('linked')).toBeTruthy();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
  });

  it('discovers profiles from agy-homes directories', () => {
    // Create fake agy-homes directories
    for (const name of ['g1', 'g2', 'g3']) {
      const profileDir = path.join(agyHomesDir, name);
      fs.mkdirSync(profileDir, { recursive: true });

      // Create a fake log file with email
      const logDir = path.join(profileDir, '.gemini', 'antigravity-cli', 'log');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, '2024-01-01.log'),
        `Starting...\nauthenticated successfully as ${name}@example.com\nDone.`,
      );
    }

    // Skip .state directory
    fs.mkdirSync(path.join(agyHomesDir, '.state'), { recursive: true });

    profileService.registerAll();

    const profiles = profileRepo.getAll();
    const names = profiles.map(p => p.name);

    // Should have agy-default + g1 + g2 + g3 (no .state)
    expect(names).toContain('agy-default');
    expect(names).toContain('g1');
    expect(names).toContain('g2');
    expect(names).toContain('g3');
    expect(names).not.toContain('.state');

    // Check emails were read
    const defaultProfile = profileRepo.get('agy-default')!;
    expect(defaultProfile.email).toBe('fake-default@example.com');
    const g1 = profileRepo.get('g1')!;
    expect(g1.email).toBe('g1@example.com');
    const g2 = profileRepo.get('g2')!;
    expect(g2.email).toBe('g2@example.com');
  });

  it('keeps a deleted keyring profile deleted on the next start and never touches its home', () => {
    profileRepo.upsert({ name: 'chinh', engine: 'agy', kind: 'keyring', home: tmpDir, email: null, enabled: 1 });
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'x');

    profileService.deleteProfile('chinh', true);
    profileService.registerAll();

    expect(profileRepo.get('chinh')?.deletedAt).toBeTruthy();
    expect(profileRepo.getAll().filter((p) => p.kind === 'keyring')).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'keep.txt'))).toBe(true);
  });

  it('does not create the default keyring profile when agy is unavailable', () => {
    const previous = {
      agyBin: process.env.AGENTHUB_AGY_BIN,
      toolsDir: process.env.AGENTHUB_TOOLS_DIR,
      home: process.env.HOME,
    };
    process.env.AGENTHUB_AGY_BIN = path.join(tmpDir, 'missing-agy');
    process.env.AGENTHUB_TOOLS_DIR = path.join(tmpDir, 'missing-tools');
    process.env.HOME = tmpDir;
    try {
      profileService.registerAll();
      expect(profileRepo.getAll()).not.toContainEqual(expect.objectContaining({ kind: 'keyring', engine: 'agy' }));
    } finally {
      if (previous.agyBin === undefined) delete process.env.AGENTHUB_AGY_BIN;
      else process.env.AGENTHUB_AGY_BIN = previous.agyBin;
      if (previous.toolsDir === undefined) delete process.env.AGENTHUB_TOOLS_DIR;
      else process.env.AGENTHUB_TOOLS_DIR = previous.toolsDir;
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
    }
  });

  it('uses claude-default for a newly discovered system Claude profile', () => {
    const claudeBin = path.join(tmpDir, 'claude');
    fs.writeFileSync(claudeBin, '#!/bin/sh\n', { mode: 0o755 });
    const previous = process.env.AGENTHUB_CLAUDE_BIN;
    process.env.AGENTHUB_CLAUDE_BIN = claudeBin;
    try {
      profileService.registerAll();
      expect(profileRepo.get('claude-default')).toEqual(expect.objectContaining({ engine: 'claude', kind: 'system' }));
      expect(profileRepo.get('claude-may')).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.AGENTHUB_CLAUDE_BIN;
      else process.env.AGENTHUB_CLAUDE_BIN = previous;
    }
  });

  it('imports quota marks from .state/*.exhausted', () => {
    // Create profile directory
    const profileDir = path.join(agyHomesDir, 'g1');
    fs.mkdirSync(profileDir, { recursive: true });
    const logDir = path.join(profileDir, '.gemini', 'antigravity-cli', 'log');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'latest.log'), 'authenticated successfully as g1@example.com\n');

    // Create .state with quota marks
    const stateDir = path.join(agyHomesDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Write a mark that's still valid (far in the future)
    const futureEpoch = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(path.join(stateDir, 'g1@claude.exhausted'), String(futureEpoch));

    // Write an expired mark
    const pastEpoch = Math.floor(Date.now() / 1000) - 100;
    fs.writeFileSync(path.join(stateDir, 'g1@gemini.exhausted'), String(pastEpoch));

    profileService.registerAll();

    // Active mark should be imported
    const active = quotaMarkRepo.getActive();
    expect(active.length).toBe(1);
    expect(active[0].profileName).toBe('g1');
    expect(active[0].family).toBe('claude');

    // Expired mark should NOT be imported
    const all = quotaMarkRepo.getAll();
    expect(all.filter(m => m.family === 'gemini').length).toBe(0);
  });

  it('detects duplicate emails', () => {
    // Create two profiles with same email
    for (const name of ['g1', 'g2']) {
      const profileDir = path.join(agyHomesDir, name);
      fs.mkdirSync(profileDir, { recursive: true });
      const logDir = path.join(profileDir, '.gemini', 'antigravity-cli', 'log');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, 'latest.log'), 'authenticated successfully as same@example.com\n');
    }

    profileService.registerAll();

    const dupes = profileService.getDuplicateEmails();
    expect(dupes.size).toBeGreaterThanOrEqual(1);
    const sameEmailProfiles = dupes.get('agy:same@example.com');
    expect(sameEmailProfiles).toBeTruthy();
    expect(sameEmailProfiles!.length).toBeGreaterThanOrEqual(2);
  });

  describe('parseAuthState and extractVerifyUrl', () => {
    it('phân tích output "not eligible" có URL bị xuống dòng ra needs_verification cùng verifyUrl', () => {
      const outputWithWrappedUrl = `
Error: Eligibility check failed: Your current account is not eligible for Antigravity. Verify your account to continue.

Please verify your account in your browser to continue:
https://accounts.google.com/signin/continue?sarp=1&scc=1&
continue=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fv2%2Fauth%3Fredirect_uri%3Dhttp%253A%252F%252Flocalhost%253A4567%26
client_id%3D123456789.apps.googleusercontent.com

Follow instructions to complete account verification.
`;

      const result = parseAuthState(outputWithWrappedUrl, false);
      expect(result.authState).toBe('needs_verification');
      expect(result.authMessage).toBe('Cần xác minh tài khoản');
      expect(result.verifyUrl).toBe(
        'https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fv2%2Fauth%3Fredirect_uri%3Dhttp%253A%252F%252Flocalhost%253A4567%26client_id%3D123456789.apps.googleusercontent.com',
      );
    });

    it('phân tích output có URL bị thụt đầu dòng ở dòng tiếp theo', () => {
      const outputWithIndentedUrl = `
Eligibility check failed: Your account needs verification.
https://accounts.google.com/signin/continue?sarp=1&
  scc=1&continue=test
`;
      const result = parseAuthState(outputWithIndentedUrl, false);
      expect(result.authState).toBe('needs_verification');
      expect(result.verifyUrl).toBe('https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=test');
    });

    it('phân tích output khớp "not logged in" hoặc "authentication" ra not_logged_in', () => {
      const output = 'Error: you are not logged in. Please run agy login to continue.';
      const result = parseAuthState(output, false);
      expect(result.authState).toBe('not_logged_in');
      expect(result.verifyUrl).toBeNull();
    });

    it('đặt ok khi có dữ liệu usage', () => {
      const output = 'Usage limits:\nGemini Models\tfive hour\t95%\t2026-10-15T18:00:00Z';
      const result = parseAuthState(output, true);
      expect(result.authState).toBe('ok');
      expect(result.verifyUrl).toBeNull();
    });

    it('không coi hồ sơ keyring là logged in nếu chưa có email và authState là not_logged_in hoặc null', () => {
      const p1 = { name: 'chinh', engine: 'agy' as const, kind: 'keyring' as const, home: tmpDir, email: null, enabled: 1, authState: 'not_logged_in' as const };
      expect(isProfileLoggedIn(p1)).toBe(false);

      const p2 = { name: 'chinh', engine: 'agy' as const, kind: 'keyring' as const, home: tmpDir, email: null, enabled: 1, authState: null };
      expect(isProfileLoggedIn(p2)).toBe(false);

      const p3 = { name: 'chinh', engine: 'agy' as const, kind: 'keyring' as const, home: tmpDir, email: 'chinh@example.com', enabled: 1, authState: null };
      expect(isProfileLoggedIn(p3)).toBe(true);

      const p4 = { name: 'chinh', engine: 'agy' as const, kind: 'keyring' as const, home: tmpDir, email: null, enabled: 1, authState: 'ok' as const };
      expect(isProfileLoggedIn(p4)).toBe(true);
    });
  });
});
