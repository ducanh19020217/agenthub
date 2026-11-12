import { QuotaMarkRepo, ProfileRepo } from '../db/index.js';
import { sameAccount } from '../profiles/account.js';
import {
  RunnableCapacityEntry,
  QuotaCapacitySnapshot,
  formatRunnableCapacity,
} from './format.js';

export type { RunnableCapacityEntry, QuotaCapacitySnapshot };
export { formatRunnableCapacity };

export class QuotaService {
  constructor(
    private quotaMarkRepo: QuotaMarkRepo,
    private profileRepo: ProfileRepo,
  ) {}

  /**
   * Mark a profile (and same-email profiles) as quota exhausted
   */
  mark(profileName: string, family: string, resetSeconds: number, reason?: string): boolean {
    const until = Math.floor(Date.now() / 1000) + resetSeconds;
    const shouldEmit = this.quotaMarkRepo.mark(profileName, family, until, reason);

    // Propagate to profiles with same email
    const profile = this.profileRepo.get(profileName);
    if (profile?.email) {
      const allProfiles = this.profileRepo.getAll();
      for (const p of allProfiles) {
        if (p.name !== profileName && sameAccount(p, profile)) {
          this.quotaMarkRepo.mark(p.name, family, until, reason);
        }
      }
    }
    return shouldEmit;
  }

  /**
   * Clear a quota mark
   */
  clear(profileName: string, family: string): void {
    this.quotaMarkRepo.clear(profileName, family);

    const profile = this.profileRepo.get(profileName);
    if (profile?.email) {
      for (const other of this.profileRepo.getAll()) {
        if (other.name !== profileName && sameAccount(other, profile)) {
          this.quotaMarkRepo.clear(other.name, family);
        }
      }
    }
  }

  /**
   * Get all active quota marks
   */
  getActive() {
    return this.quotaMarkRepo.getActive();
  }

  /**
   * Check if a profile is exhausted for a given family
   */
  isExhausted(profileName: string, family: string): boolean {
    return this.quotaMarkRepo.isExhausted(profileName, family);
  }

  /** Whether every enabled account for an engine is unavailable for a family. */
  allProfilesForEngineExhausted(engine: string, family: string): boolean {
    const profiles = this.profileRepo.getEnabled().filter((profile) => profile.engine === engine);
    if (profiles.length === 0) return false;
    return profiles.every((profile) => this.quotaMarkRepo.isExhausted(profile.name, family));
  }

  /**
   * Return the quota-bearing profile/model combinations the scheduler can use.
   * This is deliberately independent of a particular quota event: consumers
   * must answer “can anything run?” rather than “is this family exhausted?”.
   */
  runnableCapacity(models: string[] = [...KNOWN_AGY_MODELS, 'codex:gpt-5.6-luna'], now = Math.floor(Date.now() / 1000)): RunnableCapacityEntry[] {
    const profiles = this.profileRepo.getEnabled().filter((profile) => !profile.authState || profile.authState === 'ok');
    const activeMarks = this.quotaMarkRepo.getActive(now);
    return models.flatMap((model) => {
      const family = getModelFamily(model);
      const engine = getModelEngine(model);
      return profiles
        .filter((profile) => profile.engine === engine && !activeMarks.some((mark) => mark.profileName === profile.name && mark.family === family))
        .map((profile) => ({ profileName: profile.name, engine, family, model }));
    });
  }

  /** Central quota state used by notification, digest and status consumers. */
  capacitySnapshot(models?: string[], now = Math.floor(Date.now() / 1000)): QuotaCapacitySnapshot {
    const candidates = models || [...KNOWN_AGY_MODELS, 'codex:gpt-5.6-luna'];
    const runnable = this.runnableCapacity(candidates, now);
    const marks = this.quotaMarkRepo.getActive(now);
    const eligibleProfiles = new Map(
      this.profileRepo.getEnabled()
        .filter((profile) => !profile.authState || profile.authState === 'ok')
        .map((profile) => [profile.name, profile]),
    );
    // A reset is actionable only when that engine/family has no runnable profile.
    // Marks on a family that still has another available account must not hide the
    // earliest reset for the exhausted family being reported.
    const runnableFamilies = new Set(runnable.map((entry) => `${entry.engine}:${entry.family}`));
    const resetCandidates = marks
      .flatMap((mark) => candidates
        .filter((model) => {
          const profile = eligibleProfiles.get(mark.profileName);
          const engine = getModelEngine(model);
          return getModelFamily(model) === mark.family && profile?.engine === engine && !runnableFamilies.has(`${engine}:${mark.family}`);
        })
        .map((model) => ({ profileName: mark.profileName, model, at: mark.until })))
      .sort((a, b) => a.at - b.at)[0];
    const nextResetAt = resetCandidates?.at ?? null;
    return { runnable, nextResetAt, nextReset: resetCandidates };
  }

  /**
   * Get expired marks (for scheduler to re-queue waiting_quota tasks)
   */
  cleanupExpired(): { profileName: string; family: string }[] {
    const all = this.quotaMarkRepo.getAll();
    const now = Math.floor(Date.now() / 1000);
    const expired: { profileName: string; family: string }[] = [];
    for (const m of all) {
      if (m.until <= now) {
        expired.push({ profileName: m.profileName, family: m.family });
        this.quotaMarkRepo.clear(m.profileName, m.family);
      }
    }
    return expired;
  }
}

/**
 * Get model family from a model string.
 * "claude-opus-4-6-thinking" → "claude"
 * "gemini-3.8-flash-high" → "gemini"
 * "codex:gpt-5.6-luna" → "codex"
 * "gpt-oss-120b-medium" → "gpt"
 */
export function getModelFamily(model: string): string {
  if (model.startsWith('codex:')) return 'codex';
  const idx = model.indexOf('-');
  return idx > 0 ? model.substring(0, idx) : model;
}

/**
 * Get the engine id for a model string.
 * Models starting with "codex:" use codex engine, everything else uses agy.
 */
export function getModelEngine(model: string): 'agy' | 'codex' {
  return model.startsWith('codex:') ? 'codex' : 'agy';
}

const KNOWN_AGY_MODELS = new Set([
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]);

/** Task model chains intentionally allow custom strings, but the scheduler
 * must not treat an unknown string as an agy model and wait forever. */
export function isKnownModel(model: string): boolean {
  return model.startsWith('codex:') ? model.length > 6 : KNOWN_AGY_MODELS.has(model);
}
