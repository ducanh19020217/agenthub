import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readCodexRateLimits } from './codex-usage.js';
import { fetchCodexUsage, readCodexAccessToken } from './codex-api.js';
import { parseClaudeUsage, runClaudeUsage } from './claude-usage.js';
import { promisify } from 'node:util';
import { ProfileRepo, ProfileRow, QuotaMarkRepo, QuotaUsageRepo, QuotaUsageRow } from '../db/index.js';
import { isProfileLoggedIn } from '../profiles/index.js';
import { sameAccount } from '../profiles/account.js';
import { parseAuthState } from '../profiles/auth.js';
import { findAgyBin } from '../agy.js';

const execFileAsync = promisify(execFile);
const GROUP_FAMILIES: Record<string, string[]> = {
  'Gemini Models': ['gemini'],
  'Claude and GPT models': ['claude', 'gpt'],
};

export interface UsageEntry {
  group: string;
  families: string[];
  window: '5h' | 'week';
  remainingPct: number;
  resetAt: number;
}

export interface UsageCheckResult {
  entries: UsageEntry[];
  output: string;
  error?: string;
}

/** A Claude profile is available only when every reported Claude window has quota left. */
export function hasClaudeQuotaAvailable(rows: Array<Pick<QuotaUsageRow, 'grp' | 'remainingPct'>>): boolean {
  const claudeRows = rows.filter((row) => row.grp.startsWith('Claude'));
  return claudeRows.length > 0 && claudeRows.every((row) => row.remainingPct > 0);
}

export function parseUsage(text: string): UsageEntry[] {
  const result: UsageEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.split('\t');
    if (columns.length < 4) continue;
    const group = columns[0].trim();
    const label = columns[1].trim().toLowerCase();
    const remainingPct = Number.parseInt(columns[2].replace('%', '').trim(), 10);
    const resetAt = Date.parse(columns[3].trim());
    const families = GROUP_FAMILIES[group];
    if (!families || !Number.isFinite(remainingPct) || !Number.isFinite(resetAt)) continue;
    const window = label.startsWith('five hour') ? '5h' : label.startsWith('weekly') ? 'week' : null;
    if (!window) continue;
    result.push({ group, families, window, remainingPct: Math.max(0, Math.min(100, remainingPct)), resetAt: Math.floor(resetAt / 1000) });
  }
  return result;
}

export async function fetchUsage(profile: ProfileRow, agyPath = findAgyBin() || 'agy'): Promise<UsageEntry[]> {
  const result = await runUsage(profile, agyPath);
  return result.entries;
}

async function runUsage(profile: ProfileRow, agyPath: string): Promise<UsageCheckResult> {
  const env = { ...process.env, BROWSER: '/bin/false' } as Record<string, string>;
  if (profile.kind === 'isolated' && profile.home) {
    env.HOME = profile.home;
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/agy-no-keyring';
  }
  try {
    const { stdout, stderr } = await execFileAsync(agyPath, ['-p', '/usage'], {
      env,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return { entries: parseUsage(stdout), output: `${stdout}${stderr}` };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string };
    return {
      entries: parseUsage(`${result.stdout || ''}`),
      output: `${result.stdout || ''}${result.stderr || ''}`,
      error: result.message || 'agy usage check failed',
    };
  }
}

export interface UsageEventSink {
  emit(type: string, taskId?: string, payload?: unknown): unknown;
}

export class QuotaUsageService {
  private active = 0;
  private announcedExhausted = new Set<string>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isLoggedIn: (profile: ProfileRow) => boolean;

  constructor(
    private profiles: ProfileRepo,
    private usage: QuotaUsageRepo,
    private marks: QuotaMarkRepo,
    private eventBus?: UsageEventSink,
    private agyPath?: string,
    isLoggedIn?: (profile: ProfileRow) => boolean,
  ) {
    this.isLoggedIn = isLoggedIn || isProfileLoggedIn;
  }

  private claude: { bin: () => string | null; cwd: string } | null = null;
  private claudeInFlight = new Map<string, Promise<QuotaUsageRow[]>>();
  private static CLAUDE_MIN_INTERVAL_SEC = 15 * 60;

  /** Enable Claude `/usage` collection (bin resolver avoids importing chat code here). */
  configureClaude(opts: { bin: () => string | null; cwd: string }): void { this.claude = opts; }
  setEventBus(eventBus: UsageEventSink): void { this.eventBus = eventBus; }

  private quotaLowPct: () => number = () => 0;
  /** Ngưỡng (%) cho sự kiện quota.low; đọc lúc ghi để đổi trong Cài đặt có hiệu lực ngay. */
  setQuotaLowThreshold(getter: () => number): void { this.quotaLowPct = getter; }

  /**
   * Ghi một cửa sổ quota; phát `quota.low` đúng một lần khi nó vừa tụt từ trên xuống dưới ngưỡng.
   * Hết hẳn (0%) đã có quota.exhausted nên không báo thêm.
   */
  private store(row: QuotaUsageRow): void {
    const previous = this.usage.getForProfile(row.profileName).find((u) => u.grp === row.grp && u.window === row.window);
    this.usage.upsert(row);
    const threshold = this.quotaLowPct();
    if (threshold <= 0 || row.remainingPct <= 0 || row.remainingPct > threshold) return;
    if (previous && previous.remainingPct <= threshold) return;
    this.eventBus?.emit('quota.low', undefined, {
      profile: row.profileName,
      group: row.grp,
      window: row.window,
      remainingPct: row.remainingPct,
      resetAt: row.resetAt,
      threshold,
    });
  }

  getForProfile(name: string): QuotaUsageRow[] { return this.usage.getForProfile(name); }
  getAll(): QuotaUsageRow[] { return this.usage.getAll(); }

  async check(profile: ProfileRow): Promise<UsageCheckResult> {
    if (profile.engine !== 'agy') {
      return { entries: [], output: '', error: `Cannot check quota usage for engine ${profile.engine}` };
    }
    const result = await runUsage(profile, this.agyPath || findAgyBin() || 'agy');
    const auth = parseAuthState(result.output, result.entries.length > 0);
    this.profiles.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
    if (result.entries.length > 0) this.saveEntries(profile, result.entries);
    return result;
  }

  start(): void {
    // Drop stale codex rows (older versions stored agy groups); collectAll re-reads Codex logs.
    this.usage.deleteForEngine('codex');
    this.collectAll();
    this.timer = setInterval(() => this.collectAll(), 5 * 60 * 1000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  collectAll(): void {
    for (const profile of this.profiles.getEnabled().filter((p) => p.engine === 'agy' && this.isLoggedIn(p))) {
      this.collect(profile);
    }
    for (const profile of this.profiles.getEnabled().filter((p) => p.engine === 'codex')) {
      this.collectCodex(profile);
    }
    for (const profile of this.profiles.getEnabled().filter((p) => p.engine === 'claude')) {
      void this.collectClaude(profile);
    }
  }

  /**
   * Read the 5-hour and weekly limits from Claude Code's `/usage` screen in a PTY.
   * Periodic calls run at most every 15 minutes per profile; `force` is for the refresh button.
   */
  async collectClaude(profile: ProfileRow, force = false): Promise<QuotaUsageRow[]> {
    if (profile.engine !== 'claude' || !this.claude) return [];
    // A refresh during the periodic run waits for that run instead of returning nothing.
    const running = this.claudeInFlight.get(profile.name);
    if (running) return running;
    const now = Math.floor(Date.now() / 1000);
    const last = Math.max(0, ...this.usage.getForProfile(profile.name).map((u) => u.fetchedAt));
    if (!force && now - last < QuotaUsageService.CLAUDE_MIN_INTERVAL_SEC) return [];
    const bin = this.claude.bin();
    if (!bin) return [];
    const run = this.runClaudeCollection(profile, bin);
    this.claudeInFlight.set(profile.name, run);
    try {
      return await run;
    } finally {
      this.claudeInFlight.delete(profile.name);
    }
  }

  private async runClaudeCollection(profile: ProfileRow, bin: string): Promise<QuotaUsageRow[]> {
    if (!this.claude) return [];
    try {
      const raw = await runClaudeUsage({
        claudeBin: bin,
        configDir: profile.kind === 'isolated' && profile.home ? profile.home : undefined,
        cwd: this.claude.cwd,
      });
      const fetchedAt = Math.floor(Date.now() / 1000);
      const rows: QuotaUsageRow[] = parseClaudeUsage(raw).map((w) => ({
        profileName: profile.name,
        grp: w.group,
        window: w.window,
        remainingPct: Math.max(0, 100 - w.usedPercent),
        resetAt: w.resetAt,
        fetchedAt,
      }));
      const previousRows = this.usage.getForProfile(profile.name);
      const wasAvailable = hasClaudeQuotaAvailable(previousRows);
      for (const row of rows) this.store(row);
      if (previousRows.length > 0 && !wasAvailable && hasClaudeQuotaAvailable(this.usage.getForProfile(profile.name))) {
        this.eventBus?.emit('claude.quota_available', undefined, { profileName: profile.name, observedAt: new Date(fetchedAt * 1000).toISOString(), source: 'claude-usage' });
      }
      return rows;
    } catch {
      return [];
    }
  }

  /** Codex writes its rate limits into session logs; read them instead of spending quota. */
  collectCodex(profile: ProfileRow, now = Math.floor(Date.now() / 1000)): QuotaUsageRow[] {
    if (profile.engine !== 'codex') return [];
    const codexDir = profile.kind === 'isolated' && profile.home
      ? profile.home
      : path.join(profile.home || os.homedir(), '.codex');
    const limits = readCodexRateLimits(codexDir);
    if (!limits) return [];
    const rows: QuotaUsageRow[] = limits.windows.map((w) => ({
      profileName: profile.name,
      grp: 'Codex',
      window: w.window,
      // A window whose reset time has passed starts again from zero usage.
      remainingPct: w.resetAt > 0 && w.resetAt <= now ? 100 : Math.max(0, Math.min(100, Math.round(100 - w.usedPercent))),
      resetAt: w.resetAt,
      fetchedAt: limits.observedAt,
    }));
    // Không để log phiên cũ đè lên số mới hơn (vd. vừa lấy qua API wham/usage).
    const newest = new Map(this.usage.getForProfile(profile.name).filter((u) => u.grp === 'Codex').map((u) => [u.window, u.fetchedAt]));
    for (const row of rows) {
      if ((newest.get(row.window) ?? 0) <= row.fetchedAt) this.store(row);
    }
    return rows;
  }

  /**
   * Quota và gói Codex qua `chatgpt.com/backend-api/wham/usage` (như Cockpit tools), không cần chạy Codex.
   * Chỉ cho hồ sơ isolated (DEC-013). `message` giải thích kết quả, không bao giờ chứa token.
   */
  async collectCodexFromApi(profile: ProfileRow, now = Math.floor(Date.now() / 1000)): Promise<{ rows: QuotaUsageRow[]; plan: string | null; message: string }> {
    if (profile.engine !== 'codex' || profile.kind !== 'isolated' || !profile.home) {
      return { rows: [], plan: null, message: 'Quota Codex của hồ sơ này đọc từ log phiên' };
    }
    const token = readCodexAccessToken(profile.home);
    if ('skip' in token) {
      const reasons: Record<typeof token.skip, string> = {
        no_auth_file: 'Chưa có auth.json, hãy đăng nhập Codex trước',
        unreadable: 'auth.json không đúng định dạng JSON',
        no_access_token: 'auth.json không có access_token',
      };
      return { rows: [], plan: null, message: reasons[token.skip] };
    }
    const result = await fetchCodexUsage(token.accessToken, token.accountId);
    if (result.status !== 200) {
      const message = result.status === 0
        ? 'Không kết nối được tới ChatGPT'
        : result.status === 401
          ? 'ChatGPT báo access token hết hạn (HTTP 401); chạy một task Codex để Codex làm mới token'
          : `ChatGPT trả lỗi HTTP ${result.status}`;
      return { rows: [], plan: null, message };
    }
    const rows: QuotaUsageRow[] = result.windows.map((w) => ({
      profileName: profile.name,
      grp: 'Codex',
      window: w.window,
      remainingPct: w.resetAt > 0 && w.resetAt <= now ? 100 : Math.round(100 - w.usedPercent),
      resetAt: w.resetAt,
      fetchedAt: now,
    }));
    for (const row of rows) this.store(row);
    const parts = [rows.length ? 'Đã cập nhật quota Codex' : 'ChatGPT không trả về hạn mức'];
    if (result.plan) parts.push(`Gói ${result.plan.toUpperCase()}`);
    return { rows, plan: result.plan, message: parts.join(' · ') };
  }

  async collect(profile: ProfileRow): Promise<QuotaUsageRow[]> {
    if (profile.engine !== 'agy' || !this.isLoggedIn(profile)) return [];
    if (this.active >= 2) { this.pending.add(profile.name); return []; }
    this.active++;
    try {
      const result = await runUsage(profile, this.agyPath || findAgyBin() || 'agy');
      const auth = parseAuthState(result.output, result.entries.length > 0);
      this.profiles.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
      const entries = result.entries;
      const fetchedAt = Math.floor(Date.now() / 1000);
      this.saveEntries(profile, entries, fetchedAt);
      return entries.map((e) => ({ profileName: profile.name, grp: e.group, window: e.window, remainingPct: e.remainingPct, resetAt: e.resetAt, fetchedAt }));
    } catch { return []; }
    finally {
      this.active--;
      const next = [...this.pending][0];
      if (next) { this.pending.delete(next); const p = this.profiles.get(next); if (p) void this.collect(p); }
    }
  }

  private saveEntries(profile: ProfileRow, entries: UsageEntry[], fetchedAt = Math.floor(Date.now() / 1000)): void {
    const previousRows = this.usage.getForProfile(profile.name);
    const wasAvailable = hasClaudeQuotaAvailable(previousRows);
    for (const entry of entries) {
      const row: QuotaUsageRow = { profileName: profile.name, grp: entry.group, window: entry.window, remainingPct: entry.remainingPct, resetAt: entry.resetAt, fetchedAt };
      this.store(row);
      if (entry.remainingPct === 0) {
        for (const family of entry.families) {
          const markChanged = this.markForEmail(profile, family, entry.resetAt);
          // Polls keep seeing 0% until reset; announce each exhausted window once.
          const key = `${profile.name}|${family}|${entry.resetAt}`;
          if (!markChanged || this.announcedExhausted.has(key)) continue;
          this.announcedExhausted.add(key);
          this.eventBus?.emit('quota.exhausted', undefined, {
            profile: profile.name,
            family,
            engine: profile.engine,
            allExhausted: this.allProfilesForEngineExhausted(profile, family),
            reason: 'usage',
          });
        }
      }
    }
    const isAvailable = hasClaudeQuotaAvailable(this.usage.getForProfile(profile.name));
    if (profile.engine === 'agy' && previousRows.length > 0 && !wasAvailable && isAvailable) {
      this.eventBus?.emit('claude.quota_available', undefined, { profileName: profile.name, observedAt: new Date(fetchedAt * 1000).toISOString(), source: 'usage' });
    }
  }

  private markForEmail(profile: ProfileRow, family: string, until: number): boolean {
    let changed = false;
    for (const p of this.profiles.getAll().filter((p) => p.name === profile.name || sameAccount(p, profile))) {
      changed = this.marks.mark(p.name, family, until, 'usage') || changed;
    }
    return changed;
  }

  private allProfilesForEngineExhausted(profile: ProfileRow, family: string): boolean {
    const active = this.profiles.getEnabled().filter((candidate) => candidate.engine === profile.engine);
    const now = Math.floor(Date.now() / 1000);
    const marks = this.marks.getActive(now);
    return active.length > 0 && active.every((candidate) => marks.some((mark) => mark.profileName === candidate.name && mark.family === family));
  }

  bestRemaining(profile: ProfileRow, family: string): number | null {
    if (profile.engine !== 'agy') return null;
    const names = profile.email ? this.profiles.getAll().filter((p) => sameAccount(p, profile)).map((p) => p.name) : [profile.name];
    const group = family === 'gemini' ? 'Gemini Models' : family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null;
    if (!group) return null;
    const values = names.flatMap((name) => this.usage.getForProfile(name).filter((u) => u.window === '5h' && u.grp === group).map((u) => u.remainingPct));
    return values.length ? Math.max(...values) : null;
  }
}
