import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProfileRepo, QuotaMarkRepo, ProfileRow } from '../db/index.js';
import { AgentHubConfig, saveConfig } from '../config.js';
import { CodexEngine } from '../engines/index.js';
import { findClaudeBin } from '../chat/claude.js';
import { accountKey } from './account.js';
import { normalizePlan } from './plan.js';
import { findAgyPath } from '../doctor.js';

export { accountKey, sameAccount } from './account.js';
export { exchangeAgyRefreshToken, writeAgyIsolatedToken, fetchAgyGoogleUserInfo, fetchAgyGoogleUserInfoDetailed, readAgyAccessToken, inspectAgyAccessToken, fetchAgyTier, agyTierToPlan, getAgyGoogleClientId, getAgyGoogleClientSecret, GOOGLE_TOKEN_ENDPOINT } from './agyToken.js';

/** Resolve the system Claude profile while keeping existing installations compatible. */
export function resolveClaudeProfile(
  profileRepo: Pick<ProfileRepo, 'getAll'>,
  configuredProfile: string | undefined,
  configuredExplicitly = false,
): string {
  if (configuredExplicitly && configuredProfile) return configuredProfile;
  const existing = profileRepo.getAll().find((profile) => profile.engine === 'claude' && profile.kind === 'system');
  return existing?.name || configuredProfile || 'claude-default';
}

/** Resolve Codex profile: explicitly configured or the logged-in profile with the most remaining quota. */
export function resolveCodexProfile(
  profileRepo: Pick<ProfileRepo, 'getAll'>,
  configuredProfile?: string,
  quotaUsageRepo?: { getForProfile(profileName: string): { remainingPct: number }[] },
  quotaMarkRepo?: { isExhausted(profileName: string, family: string): boolean },
): string | null {
  const allProfiles = profileRepo.getAll().filter((p) => p.engine === 'codex' && Boolean(p.enabled) && isProfileLoggedIn(p));
  if (configuredProfile) {
    const matched = allProfiles.find((p) => p.name === configuredProfile);
    if (matched) return matched.name;
  }
  const unexhausted = allProfiles.filter((p) => !quotaMarkRepo?.isExhausted(p.name, 'codex'));
  const candidates = unexhausted.length > 0 ? unexhausted : allProfiles;
  if (candidates.length === 0) return null;

  const remaining = (name: string): number => {
    if (!quotaUsageRepo) return 100;
    const usage = quotaUsageRepo.getForProfile(name);
    if (!usage || usage.length === 0) return 100;
    return Math.min(...usage.map((u) => u.remainingPct));
  };

  candidates.sort((a, b) => remaining(b.name) - remaining(a.name) || (b.priority ?? 0) - (a.priority ?? 0));
  return candidates[0]?.name || null;
}

// Symlinks to create in isolated HOME per PLAN 2.1
const SYMLINK_TARGETS = [
  '.nvm',
  '.gitconfig',
  '.docker',
  '.npmrc',
  '.npm',
  '.cache',
  '.local',
  '.config',
  '.bashrc',
  '.profile',
  '.bash_profile',
];

export class ProfileService {
  private claudeAccountCache = new Map<string, { mtimeMs: number; account: { email: string | null; plan: string | null; planId: string | null } | null }>();

  constructor(
    private config: AgentHubConfig,
    private profileRepo: ProfileRepo,
    private quotaMarkRepo: QuotaMarkRepo,
  ) {}

  /**
   * Register all profiles on startup:
   * - "agy-default" (keyring, agy engine) when agy is installed
   * - "codex" if Codex CLI found
   * - All subdirectories in ~/.agy-homes/ (except .state)
   */
  registerAll(): void {
    if (!this.config.multiplePerProviderConfigured && this.profileRepo.hasMetaFlag('multiple_per_provider_legacy')) {
      this.config.multiplePerProvider = true;
      this.config.multiplePerProviderConfigured = true;
      // Persist the migration choice so subsequent daemon starts are stable.
      saveConfig(this.config.hubHome, { multiplePerProvider: true });
    }
    // Preserve existing keyring profiles, including the legacy "chinh" name.
    const hasKeyring = this.profileRepo.getAll(true).some((p) => p.kind === 'keyring' && p.engine === 'agy');
    if (!hasKeyring && findAgyPath()) {
      this.profileRepo.upsert({
        name: 'agy-default',
        engine: 'agy',
        kind: 'keyring',
        home: os.homedir(),
        email: this.readEmailFromLog(this.config.defaultLogDir),
        enabled: 1,
      });
    }

    // Register "codex" if found
    const codexPath = CodexEngine.findCodexPath();
    if (codexPath) {
      this.profileRepo.upsert({
        name: 'codex',
        engine: 'codex',
        kind: 'codex',
        home: os.homedir(),
        email: null,
        enabled: 1,
      });
    }

    // The system Claude profile uses the existing ~/.claude account and is
    // only exposed when Claude Code is installed on this machine. Preserve
    // the legacy name when it exists; new installations use the default name.
    if (findClaudeBin(this.config.chat.claudeBin)) {
      const existing = this.profileRepo.getAll().find((p) => p.engine === 'claude' && p.kind === 'system');
      this.profileRepo.upsert({
        name: existing?.name || 'claude-default',
        engine: 'claude',
        kind: 'system',
        home: os.homedir(),
        email: this.readClaudeAccount(os.homedir())?.email || null,
        enabled: 1,
      });
    }

    // Register codex-homes profiles
    const codexHomesDir = path.join(this.config.hubHome, 'codex-homes');
    if (fs.existsSync(codexHomesDir)) {
      const entries = fs.readdirSync(codexHomesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(codexHomesDir, entry.name);
        if (!this.profileRepo.get(entry.name)) {
          this.profileRepo.upsert({
            name: entry.name,
            engine: 'codex',
            kind: 'isolated',
            home: fullPath,
            email: null,
            enabled: 1,
          });
        }
      }
    }

    // Register agy-homes profiles
    const agyHomesDir = this.config.agyHomesDir;
    if (fs.existsSync(agyHomesDir)) {
      const entries = fs.readdirSync(agyHomesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.state') continue;
        const fullPath = path.join(agyHomesDir, entry.name);
        // Check if it's a directory (or symlink to directory)
        let isDir = false;
        try {
          const stat = fs.statSync(fullPath);
          isDir = stat.isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;

        const logDir = path.join(fullPath, '.gemini', 'antigravity-cli', 'log');
        const email = this.readEmailFromLog(logDir);

        this.profileRepo.upsert({
          name: entry.name,
          engine: 'agy',
          kind: 'isolated',
          home: fullPath,
          email,
          enabled: 1,
        });
      }
    }

    // Import quota marks from ~/.agy-homes/.state/*.exhausted
    this.importQuotaMarks();
  }

  /**
   * Read email from agy log files.
   * Look for "authenticated successfully as <email>" pattern.
   */
  readEmailFromLog(logDir: string): string | null {
    if (!fs.existsSync(logDir)) return null;

    try {
      const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
      if (files.length === 0) return null;

      // Sort to get the most recent log file
      files.sort();

      // Search from newest to oldest
      for (let i = files.length - 1; i >= 0; i--) {
        const content = fs.readFileSync(path.join(logDir, files[i]), 'utf-8');
        const match = content.match(/authenticated successfully as (\S+)/i);
        if (match) {
          return match[1];
        }
      }
    } catch {
      // ignore errors reading logs
    }

    return null;
  }

  /**
   * Import quota marks from ~/.agy-homes/.state/*.exhausted
   * File format: <name>@<family>.exhausted, content is epoch timestamp
   */
  importQuotaMarks(): void {
    const stateDir = path.join(this.config.agyHomesDir, '.state');
    if (!fs.existsSync(stateDir)) return;

    try {
      const files = fs.readdirSync(stateDir).filter((f) => f.endsWith('.exhausted'));
      for (const file of files) {
        const basename = file.replace('.exhausted', '');
        const atIndex = basename.lastIndexOf('@');
        if (atIndex <= 0) continue;

        const profileName = basename.substring(0, atIndex);
        const family = basename.substring(atIndex + 1);

        try {
          const content = fs.readFileSync(path.join(stateDir, file), 'utf-8').trim();
          const until = parseInt(content, 10);
          if (isNaN(until)) continue;

          const now = Math.floor(Date.now() / 1000);
          if (until <= now) continue; // expired, skip

          // Legacy state can outlive a removed profile. Do not let that stale
          // file prevent the rest of the profiles from being imported.
          if (!this.profileRepo.get(profileName)) continue;

          this.quotaMarkRepo.mark(profileName, family, until, 'imported from legacy state');
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Create a new isolated agy profile
   */
  createProfile(name: string, engine: 'agy' | 'claude' | 'codex' = 'agy', accountType: ProfileRow['accountType'] = 'personal'): void {
    if (engine === 'claude') {
      const homeDir = path.join(this.config.hubHome, 'claude-homes', name);
      fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
      this.profileRepo.upsert({ name, engine: 'claude', kind: 'isolated', home: homeDir, email: null, enabled: 1, accountType });
      return;
    }
    if (engine === 'codex') {
      const homeDir = path.join(this.config.hubHome, 'codex-homes', name);
      fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
      this.profileRepo.upsert({ name, engine: 'codex', kind: 'isolated', home: homeDir, email: null, enabled: 1, accountType });
      if (!isProfileLoggedIn(this.profileRepo.get(name)!)) {
        this.profileRepo.updateAuthState(name, 'not_logged_in', 'Chưa đăng nhập', null);
      }
      return;
    }
    const homeDir = path.join(this.config.agyHomesDir, name);
    if (!fs.existsSync(homeDir)) {
      fs.mkdirSync(homeDir, { recursive: true });
    }

    // Create symlinks
    const realHome = os.homedir();
    for (const target of SYMLINK_TARGETS) {
      const src = path.join(realHome, target);
      const dest = path.join(homeDir, target);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try {
          fs.symlinkSync(src, dest);
        } catch {
          // ignore symlink errors
        }
      }
    }

    // Symlink .gemini/config
    const geminiConfigSrc = path.join(realHome, '.gemini', 'config');
    const geminiDir = path.join(homeDir, '.gemini');
    if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });
    const geminiConfigDest = path.join(geminiDir, 'config');
    if (fs.existsSync(geminiConfigSrc) && !fs.existsSync(geminiConfigDest)) {
      try {
        fs.symlinkSync(geminiConfigSrc, geminiConfigDest);
      } catch {
        // ignore
      }
    }

    this.profileRepo.upsert({
      name,
      engine: 'agy',
      kind: 'isolated',
      home: homeDir,
      email: null,
      enabled: 1,
      accountType,
    });
    // A new agy home has no OAuth token yet; keep it out of scheduling until login.
    if (!isProfileLoggedIn(this.profileRepo.get(name)!)) {
      this.profileRepo.updateAuthState(name, 'not_logged_in', 'Chưa đăng nhập', null);
    }
  }

  readClaudeAccount(home: string): { email: string | null; plan: string | null; planId: string | null } | null {
    const file = path.join(home, '.claude.json');
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      this.claudeAccountCache.set(file, { mtimeMs, account: null });
      return null;
    }
    const cached = this.claudeAccountCache.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached.account;

    let account: { email: string | null; plan: string | null; planId: string | null } | null = null;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const oauthAccount = value.oauthAccount;
      if (oauthAccount && typeof oauthAccount === 'object') {
        const data = oauthAccount as Record<string, unknown>;
        const email = typeof data.emailAddress === 'string' && data.emailAddress.includes('@') ? data.emailAddress : null;
        const plan = [data.billingType, data.organizationName, data.userRateLimitTier]
          .find((v): v is string => typeof v === 'string' && v.length > 0) || null;
        // Tên tổ chức có thể chứa chữ "pro"…, nên chỉ chuẩn hoá từ các trường về gói.
        const planId = normalizePlan(
          ...[data.userRateLimitTier, data.subscriptionType, data.billingType].map((v) => (typeof v === 'string' ? v : null)),
        );
        account = { email, plan, planId };
      }
    } catch {
      // Ignore malformed or unrelated Claude configuration files.
    }
    this.claudeAccountCache.set(file, { mtimeMs, account });
    return account;
  }

  purgeHomeDirectory(profile: ProfileRow): void {
    if (!profile.home || !fs.existsSync(profile.home)) return;

    let engineRoot: string;
    if (profile.engine === 'claude') {
      engineRoot = path.resolve(this.config.hubHome, 'claude-homes');
    } else if (profile.engine === 'codex') {
      engineRoot = path.resolve(this.config.hubHome, 'codex-homes');
    } else {
      engineRoot = path.resolve(this.config.agyHomesDir);
    }

    let realRoot: string;
    let realHome: string;
    try {
      realRoot = fs.existsSync(engineRoot) ? fs.realpathSync(engineRoot) : engineRoot;
      realHome = fs.realpathSync(profile.home);
    } catch {
      throw new Error(`Từ chối xóa hồ sơ ${profile.name}: không xác định được đường dẫn thật`);
    }

    if (realHome === realRoot) {
      throw new Error(`Từ chối xóa hồ sơ ${profile.name}: thư mục home trùng với thư mục gốc engine`);
    }

    const relative = path.relative(realRoot, realHome);
    if (!relative || relative === '.' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Từ chối xóa hồ sơ ${profile.name}: thư mục nằm ngoài ${path.basename(engineRoot)}`);
    }

    fs.rmSync(profile.home, { recursive: true, force: true });
  }

  deleteProfile(name: string, purgeHome = true): void {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.deletedAt) throw new Error(`Hồ sơ "${name}" không tồn tại`);
    if (profile.kind === 'system') {
      throw new Error('Từ chối xóa: không thể xóa hồ sơ hệ thống');
    }
    // Keyring dùng HOME thật và keyring hệ thống (PLAN 2.1): chỉ xoá mềm, không đụng tới thư mục.
    if (purgeHome && profile.kind !== 'keyring' && profile.home && fs.existsSync(profile.home)) {
      this.purgeHomeDirectory(profile);
    }
    this.profileRepo.softDelete(name);
  }

  /**
   * Mark quota for a profile and all profiles with the same email
   */
  markQuota(profileName: string, family: string, resetSeconds: number, reason?: string): boolean {
    const until = Math.floor(Date.now() / 1000) + resetSeconds;
    const shouldEmit = this.quotaMarkRepo.mark(profileName, family, until, reason);

    // Propagate to profiles with same email
    const profile = this.profileRepo.get(profileName);
    if (profile?.email) {
      const allProfiles = this.profileRepo.getAll();
      for (const p of allProfiles) {
        if (p.name !== profileName && p.email === profile.email) {
          this.quotaMarkRepo.mark(p.name, family, until, reason);
        }
      }
    }
    return shouldEmit;
  }

  /**
   * Detect duplicate emails across profiles
   */
  /**
   * Profiles that share one provider account (same engine and email) share quota.
   * Keys are `engine:email`; the same email on different engines (e.g. Claude and
   * Antigravity) is not a duplicate.
   */
  getDuplicateEmails(): Map<string, string[]> {
    const profiles = this.profileRepo.getAll();
    const emailMap = new Map<string, string[]>();
    for (const p of profiles) {
      const key = accountKey(p);
      if (!key) continue;
      const existing = emailMap.get(key) || [];
      existing.push(p.name);
      emailMap.set(key, existing);
    }
    // Only return those with duplicates
    const result = new Map<string, string[]>();
    for (const [email, names] of emailMap) {
      if (names.length > 1) {
        result.set(email, names);
      }
    }
    return result;
  }

  /**
   * Check if a profile is currently busy (has a running task)
   */
  isProfileBusy(profileName: string, runningRuns: { profileName: string }[]): boolean {
    return runningRuns.some((r) => r.profileName === profileName);
  }

  getAll(): ProfileRow[] {
    return this.profileRepo.getAll();
  }
}

export function isProfileLoggedIn(profile: ProfileRow): boolean {
  if (profile.engine === 'codex') {
    if (profile.kind === 'isolated' && profile.home) {
      return fs.existsSync(path.join(profile.home, 'auth.json'));
    }
    return fs.existsSync(path.join(profile.home || os.homedir(), '.codex', 'auth.json'));
  }
  if (profile.kind === 'keyring') {
    if (profile.authState === 'not_logged_in') return false;
    return Boolean(profile.email) || profile.authState === 'ok';
  }
  if (profile.engine === 'claude') {
    const home = profile.home || os.homedir();
    const accountFile = path.join(home, '.claude.json');
    try {
      const value = JSON.parse(fs.readFileSync(accountFile, 'utf8')) as Record<string, unknown>;
      const oauthAccount = value.oauthAccount;
      if (oauthAccount && typeof oauthAccount === 'object' && typeof (oauthAccount as Record<string, unknown>).emailAddress === 'string') {
        return true;
      }
    } catch { /* fall through to credentials existence check */ }
    const credentialsPath = profile.kind === 'system'
      ? path.join(home, '.claude', '.credentials.json')
      : path.join(home, '.credentials.json');
    return fs.existsSync(credentialsPath);
  }
  return !!profile.home && fs.existsSync(path.join(profile.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
}
