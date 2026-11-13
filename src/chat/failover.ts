import fs from 'node:fs';
import path from 'node:path';

export type ClaudeFallbackStep =
  | { type: 'profile'; profile?: string }
  | { type: 'model'; model: string }
  | { type: 'apiKey'; dailyCapUSD: number }
  | { type: 'engine'; engine: 'codex' }
  | { type: 'wait' };

export interface ClaudeFailoverSnapshot {
  active: boolean;
  until: number | null;
  resetAt: number | null;
  reason: string | null;
  activatedAt: number | null;
  step: ClaudeFallbackStep | null;
  stepIndex: number;
  dailyCostUSD: number;
  dailyCostDate: string | null;
  apiKeyConfigured: boolean;
  evidence?: { file: string; line: number; observedAt: string } | null;
  lastActivityAt?: string | null;
  authProfileName?: string | null;
  authFailover?: boolean;
}

export interface ClaudeFailoverEvidence {
  file: string;
  line: number;
  observedAt: string;
}

type Clock = () => number;

export function normalizeFallbackSteps(value: unknown): ClaudeFallbackStep[] {
  if (!Array.isArray(value)) return [{ type: 'engine', engine: 'codex' }];
  return value.flatMap((raw): ClaudeFallbackStep[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    if (item.type === 'profile') return [{ type: 'profile', ...(typeof item.profile === 'string' ? { profile: item.profile } : {}) }];
    if (item.type === 'model' && typeof item.model === 'string' && item.model.trim()) return [{ type: 'model', model: item.model }];
    if (item.type === 'apiKey' && typeof item.dailyCapUSD === 'number' && item.dailyCapUSD > 0) return [{ type: 'apiKey', dailyCapUSD: item.dailyCapUSD }];
    if (item.type === 'engine' && item.engine === 'codex') return [{ type: 'engine', engine: 'codex' }];
    if (item.type === 'wait') return [{ type: 'wait' }];
    return [];
  });
}

function dateKey(epoch: number): string { return new Date(epoch * 1000).toISOString().slice(0, 10); }

/** Durable failover metadata. It never stores the API key itself. */
export class ClaudeFailoverState {
  private state: ClaudeFailoverSnapshot;
  private readonly now: Clock;
  private steps: ClaudeFallbackStep[];
  private readonly apiKeyPath?: string;

  constructor(private readonly filePath: string, now: Clock = () => Math.floor(Date.now() / 1000), options: { steps?: ClaudeFallbackStep[]; apiKeyPath?: string } = {}) {
    this.now = now;
    this.steps = options.steps || [{ type: 'engine', engine: 'codex' }];
    this.apiKeyPath = options.apiKeyPath;
    this.state = this.emptyState();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ClaudeFailoverSnapshot>;
      this.state = {
        ...this.emptyState(), ...parsed,
        step: typeof parsed.stepIndex === 'number' ? this.steps[parsed.stepIndex] || null : null,
        stepIndex: typeof parsed.stepIndex === 'number' ? parsed.stepIndex : 0,
        dailyCostUSD: typeof parsed.dailyCostUSD === 'number' ? parsed.dailyCostUSD : 0,
        apiKeyConfigured: this.hasApiKey(),
      };
      this.resetDailyIfNeeded();
      if (this.state.active && this.state.until !== null && this.state.until <= this.now()) this.clear();
    } catch { /* missing or invalid state means Claude is available */ }
  }

  private emptyState(): ClaudeFailoverSnapshot {
    return { active: false, until: null, resetAt: null, reason: null, activatedAt: null, step: null, stepIndex: 0, dailyCostUSD: 0, dailyCostDate: dateKey(this.now()), apiKeyConfigured: this.hasApiKey(), evidence: null, lastActivityAt: null, authProfileName: null, authFailover: false };
  }

  private hasApiKey(): boolean {
    if (!this.apiKeyPath) return false;
    try { return fs.statSync(this.apiKeyPath).isFile() && fs.statSync(this.apiKeyPath).size > 0; } catch { return false; }
  }

  private resetDailyIfNeeded(): void {
    const today = dateKey(this.now());
    if (this.state.dailyCostDate !== today) { this.state.dailyCostDate = today; this.state.dailyCostUSD = 0; this.persist(); }
  }

  snapshot(): ClaudeFailoverSnapshot {
    this.resetDailyIfNeeded();
    if (this.state.active && this.state.until !== null && this.state.until <= this.now()) this.clear();
    return { ...this.state, step: this.state.step ? { ...this.state.step } : null, apiKeyConfigured: this.hasApiKey() };
  }

  configureSteps(steps: ClaudeFallbackStep[]): void {
    this.steps = steps;
    if (this.state.active) this.state.step = this.steps[this.state.stepIndex] || null;
    this.persist();
  }

  activate(resetSeconds: number, reason = 'usage_limit', evidence?: ClaudeFailoverEvidence): ClaudeFailoverSnapshot {
    const now = this.now();
    const until = now + Math.max(60, resetSeconds);
    this.state = { ...this.state, active: true, until, resetAt: until, reason, activatedAt: now, stepIndex: 0, step: this.steps[0] || null, evidence: evidence || null, lastActivityAt: null, authProfileName: null, authFailover: false };
    this.persist();
    return this.snapshot();
  }

  activateAuthExpired(profileName?: string | null): ClaudeFailoverSnapshot {
    const now = this.now();
    this.state = { ...this.state, active: true, until: null, resetAt: null, reason: 'claude_auth_expired', authProfileName: profileName || null, authFailover: true, activatedAt: now, stepIndex: 0, step: this.steps[0] || null, evidence: null, lastActivityAt: null };
    this.persist();
    return this.snapshot();
  }

  advance(reason = 'step_failed'): ClaudeFailoverSnapshot {
    this.state.stepIndex += 1;
    this.state.step = this.steps[this.state.stepIndex] || null;
    this.state.reason = reason;
    if (!this.state.step) this.state.active = false;
    this.persist();
    return this.snapshot();
  }

  recordCost(costUsd: number): ClaudeFailoverSnapshot {
    this.resetDailyIfNeeded();
    if (Number.isFinite(costUsd) && costUsd > 0) this.state.dailyCostUSD += costUsd;
    this.persist();
    return this.snapshot();
  }

  getApiKey(): string | null {
    if (!this.apiKeyPath) return null;
    try { return fs.readFileSync(this.apiKeyPath, 'utf8').trim() || null; } catch { return null; }
  }

  setApiKey(value: string): void {
    if (!this.apiKeyPath) throw new Error('API key storage is not configured');
    if (!value.trim()) throw new Error('API key không được để trống');
    fs.mkdirSync(path.dirname(this.apiKeyPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.apiKeyPath, value.trim() + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(this.apiKeyPath, 0o600); } catch { /* best effort */ }
  }

  noteActivity(at: string | Date = new Date()): boolean {
    const activity = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(activity.getTime())) return false;
    this.state.lastActivityAt = activity.toISOString();
    // Auth failover stays active until credentials are actually restored.
    if (this.state.authFailover) { this.persist(); return false; }
    if (!this.state.active || this.state.activatedAt === null || activity.getTime() / 1000 <= this.state.activatedAt) { this.persist(); return false; }
    this.clear();
    return true;
  }

  clear(): void {
    this.state = { ...this.emptyState(), lastActivityAt: this.state.lastActivityAt || null };
    try { fs.unlinkSync(this.filePath); } catch { /* already absent */ }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
  }
}
