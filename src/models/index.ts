import { ProfileModelRepo, ProfileRepo, ProfileRow } from '../db/index.js';
import { isProfileLoggedIn } from '../profiles/index.js';
import {
  discoverAgyModels,
  discoverCodexModels,
  discoverClaudeModels,
  getDefaultModelsForEngine,
  DiscoveredModelItem,
  ExecFileFunction,
} from './discovery.js';

export * from './discovery.js';

export interface ModelDiscoveryOptions {
  agyBin?: () => string | null;
  execFileFn?: ExecFileFunction;
  fetchFn?: typeof fetch;
}

export class ModelDiscoveryService {
  private inFlight = new Map<string, Promise<DiscoveredModelItem[]>>();

  constructor(
    private profileRepo: ProfileRepo,
    private profileModelRepo: ProfileModelRepo,
    private options?: ModelDiscoveryOptions,
  ) {}

  /**
   * Discover available models for a single profile.
   * If discovery succeeds, results are saved to the profile_models table.
   * If discovery fails, falls back to the most recent cached models in DB,
   * and finally to default models marked verified: false.
   */
  async discoverForProfile(profile: ProfileRow, force = false): Promise<DiscoveredModelItem[]> {
    // Avoid duplicate concurrent discovery for the same profile
    const running = this.inFlight.get(profile.name);
    if (running) return running;

    const run = this.doDiscoverForProfile(profile, force);
    this.inFlight.set(profile.name, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(profile.name);
    }
  }

  private async doDiscoverForProfile(profile: ProfileRow, force = false): Promise<DiscoveredModelItem[]> {
    // If not logged in, return cached from DB or defaults
    if (!isProfileLoggedIn(profile)) {
      const cached = this.profileModelRepo.getForProfile(profile.name);
      if (cached.length > 0) {
        return cached.map((c) => ({
          id: c.modelId,
          name: c.modelName || c.modelId,
          engine: c.engine as 'agy' | 'codex' | 'claude',
          verified: Boolean(c.verified),
        }));
      }
      return getDefaultModelsForEngine(profile.engine);
    }

    try {
      let items: DiscoveredModelItem[] = [];
      if (profile.engine === 'agy') {
        items = await discoverAgyModels(profile, {
          agyBin: this.options?.agyBin?.() || undefined,
          execFileFn: this.options?.execFileFn,
        });
      } else if (profile.engine === 'codex') {
        items = await discoverCodexModels(profile, {
          fetchApi: force,
          fetchFn: this.options?.fetchFn,
        });
      } else if (profile.engine === 'claude') {
        items = await discoverClaudeModels(profile);
      }

      if (items.length > 0) {
        this.profileModelRepo.setForProfile(
          profile.name,
          items.map((i) => ({
            modelId: i.id,
            modelName: i.name,
            engine: i.engine,
            verified: i.verified,
          })),
        );
        return items;
      }
    } catch {
      // Fallback 1: recent cache in DB
      const cached = this.profileModelRepo.getForProfile(profile.name);
      if (cached.length > 0) {
        return cached.map((c) => ({
          id: c.modelId,
          name: c.modelName || c.modelId,
          engine: c.engine as 'agy' | 'codex' | 'claude',
          verified: Boolean(c.verified),
        }));
      }
    }

    // Fallback 2: engine defaults with verified: false
    return getDefaultModelsForEngine(profile.engine);
  }

  /**
   * Run discovery across all enabled profiles.
   */
  async discoverAll(options?: { force?: boolean }): Promise<void> {
    const enabled = this.profileRepo.getEnabled();
    for (const profile of enabled) {
      try {
        await this.discoverForProfile(profile, options?.force);
      } catch {
        // Individual profile errors must not break discovery of other profiles
      }
    }
  }
}
