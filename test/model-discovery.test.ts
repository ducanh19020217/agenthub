import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  parseAgyModelsOutput,
  parseCodexModelsData,
  parseClaudeModelCatalog,
  discoverAgyModels,
  discoverCodexModels,
  discoverClaudeModels,
  ModelDiscoveryService,
  DEFAULT_AGY_DISCOVERED_MODELS,
} from '../src/models/index.js';
import { openDatabase, ProfileModelRepo, ProfileRepo, ProfileRow, MIGRATIONS } from '../src/db/index.js';
import { isKnownModel } from '../src/quota/index.js';
import { AppService } from '../src/services/index.js';
import { modelValidator } from '../src/services/index.js';
import { Scheduler } from '../src/scheduler/index.js';
import { ChatService } from '../src/chat/service.js';

describe('Model Discovery Parsers', () => {
  it('parseAgyModelsOutput handles spinner output, tabs and spaces correctly', () => {
    const rawOutput = [
      '⠋ Fetching available models...⠙ Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      'claude-opus-4-6-thinking   Claude Opus 4.6 (Thinking)',
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    ].join('\n');

    const result = parseAgyModelsOutput(rawOutput);
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      id: 'gemini-3.8-flash-high',
      name: 'Gemini 3.8 Flash (High)',
      engine: 'agy',
      verified: true,
    });
    expect(result[1]).toEqual({
      id: 'gemini-3.8-flash-medium',
      name: 'Gemini 3.8 Flash (Medium)',
      engine: 'agy',
      verified: true,
    });
    expect(result[2].id).toBe('claude-sonnet-4-6');
    expect(result[3].id).toBe('claude-opus-4-6-thinking');
    expect(result[4].id).toBe('gpt-oss-120b-medium');
  });

  it('parseCodexModelsData extracts non-hidden models and prefixes codex:', () => {
    const fixture = {
      models: [
        {
          slug: 'gpt-6.1-sol',
          display_name: 'GPT-6.1-Sol',
          visibility: 'list',
          supported_in_api: true,
        },
        {
          slug: 'gpt-reserve',
          display_name: 'GPT-Reserve',
          visibility: 'hide',
          supported_in_api: true,
        },
        {
          slug: 'gpt-5.6-luna',
          display_name: 'GPT-5.6-Luna',
          visibility: 'list',
          supported_in_api: true,
        },
        {
          slug: 'codex-auto-review',
          display_name: 'Codex Auto Review',
          visibility: 'hide',
          supported_in_api: true,
        },
      ],
    };

    const result = parseCodexModelsData(fixture);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'codex:gpt-6.1-sol',
      name: 'GPT-6.1-Sol',
      engine: 'codex',
      verified: true,
    });
    expect(result[1]).toEqual({
      id: 'codex:gpt-5.6-luna',
      name: 'GPT-5.6-Luna',
      engine: 'codex',
      verified: true,
    });
  });

  it('parseClaudeModelCatalog parses catalog.config.models', () => {
    const fixture = {
      catalog: {
        config: {
          models: [
            { id: 'claude-opus-5-5', name: 'Opus 5.5', short_name: 'Opus' },
            { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', short_name: 'Sonnet' },
          ],
        },
      },
    };

    const result = parseClaudeModelCatalog(fixture);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'claude-opus-5-5',
      name: 'Opus 5.5',
      engine: 'claude',
      verified: true,
    });
    expect(result[1]).toEqual({
      id: 'claude-sonnet-5-5',
      name: 'Sonnet 5.5',
      engine: 'claude',
      verified: true,
    });
  });
});

describe('Engine Model Discovery with Fixtures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discoverAgyModels calls agy binary with isolated environment and parses output', async () => {
    const profile: ProfileRow = {
      name: 'isolated-agy',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'agy-home'),
      enabled: 1,
      email: 'test@example.com',
    };

    let calledArgs: string[] = [];
    let calledEnv: Record<string, string> = {};
    const mockExecFile = async (_file: string, args: string[], options: { env: Record<string, string> }) => {
      calledArgs = args;
      calledEnv = options.env;
      return {
        stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6',
        stderr: '',
      };
    };

    const models = await discoverAgyModels(profile, {
      agyBin: '/custom/bin/agy',
      execFileFn: mockExecFile,
    });

    expect(calledArgs).toEqual(['models']);
    expect(calledEnv.HOME).toBe(profile.home);
    expect(calledEnv.TERM).toBe('dumb');
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('gemini-3.8-flash-high');
    expect(models[1].id).toBe('claude-sonnet-4-6');
  });

  it('discoverCodexModels reads from models_cache.json fixture when present', async () => {
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });

    const fixtureContent = {
      fetched_at: '2026-11-12T00:00:00Z',
      models: [
        { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
        { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
      ],
    };
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify(fixtureContent), 'utf8');

    const profile: ProfileRow = {
      name: 'codex-test',
      engine: 'codex',
      kind: 'isolated',
      home: codexHome,
      enabled: 1,
      email: 'codex@example.com',
    };

    const models = await discoverCodexModels(profile);
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(['codex:gpt-6-astra', 'codex:gpt-5.6-luna']);
  });

  it('discoverCodexModels calls models endpoint if models_cache.json is missing and token is present', async () => {
    const codexHome = path.join(tmpDir, 'codex-home-api');
    fs.mkdirSync(codexHome, { recursive: true });

    // Write auth.json
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'acc-123' } }),
      'utf8',
    );

    const profile: ProfileRow = {
      name: 'codex-api-test',
      engine: 'codex',
      kind: 'isolated',
      home: codexHome,
      enabled: 1,
      email: 'codex@example.com',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' },
        ],
      }),
    });

    const models = await discoverCodexModels(profile, { fetchFn: mockFetch as unknown as typeof fetch });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('codex:gpt-6.1-sol');
  });

  it('discoverCodexModels with force=true bypasses models_cache.json and fetches fresh models via API', async () => {
    const codexHome = path.join(tmpDir, 'codex-home-force');
    fs.mkdirSync(codexHome, { recursive: true });

    // Write models_cache.json with stale models
    fs.writeFileSync(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [{ slug: 'gpt-5.6-luna', display_name: 'Stale Model' }],
      }),
      'utf8',
    );

    // Write auth.json
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'acc-123' } }),
      'utf8',
    );

    const profile: ProfileRow = {
      name: 'codex-force-test',
      engine: 'codex',
      kind: 'isolated',
      home: codexHome,
      enabled: 1,
      email: 'codex@example.com',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { slug: 'gpt-6.2-nova', display_name: 'Fresh GPT-6.2 Nova', visibility: 'list' },
        ],
      }),
    });

    const models = await discoverCodexModels(profile, { force: true, fetchFn: mockFetch as unknown as typeof fetch });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('codex:gpt-6.2-nova');
    expect(models[0].name).toBe('Fresh GPT-6.2 Nova');
  });

  it('discoverClaudeModels finds cache/model-catalog JSON and merges with base aliases', async () => {
    const claudeHome = path.join(tmpDir, 'claude-home');
    const catalogDir = path.join(claudeHome, '.claude', 'cache', 'model-catalog');
    fs.mkdirSync(catalogDir, { recursive: true });

    fs.writeFileSync(
      path.join(catalogDir, 'catalog-1.json'),
      JSON.stringify({
        catalog: {
          config: {
            models: [
              { id: 'claude-opus-5-5', name: 'Opus 5.5' },
              { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
            ],
          },
        },
      }),
      'utf8',
    );

    const profile: ProfileRow = {
      name: 'claude-test',
      engine: 'claude',
      kind: 'isolated',
      home: claudeHome,
      enabled: 1,
      email: 'claude@example.com',
    };

    const models = await discoverClaudeModels(profile);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('sonnet');
    expect(ids).toContain('opus');
    expect(ids).toContain('haiku');
    expect(ids).toContain('claude-opus-5-5');
    expect(ids).toContain('claude-sonnet-5-5');
    expect(models.find((m) => m.id === 'sonnet')?.verified).toBe(true);
  });

  it('discoverClaudeModels marks aliases unverified without a model catalog cache', async () => {
    const profile: ProfileRow = {
      name: 'claude-no-cache',
      engine: 'claude',
      kind: 'isolated',
      home: path.join(tmpDir, 'claude-no-cache'),
      enabled: 1,
      email: 'claude@example.com',
    };

    const models = await discoverClaudeModels(profile);
    expect(models.filter((m) => ['sonnet', 'opus', 'haiku'].includes(m.id)).every((m) => !m.verified)).toBe(true);
  });

  it('modelValidator accepts unknown model ids but rejects whitespace', () => {
    expect(modelValidator.safeParse('vendor-model-2026').success).toBe(true);
    expect(modelValidator.safeParse('codex:vendor-model-2026').success).toBe(true);
    expect(modelValidator.safeParse('vendor model').success).toBe(false);
    expect(modelValidator.safeParse(' vendor-model-2026').success).toBe(false);
    expect(modelValidator.safeParse('vendor-model-2026 ').success).toBe(false);
    expect(modelValidator.safeParse('   ').success).toBe(false);
  });
});

describe('ModelDiscoveryService DB Caching & Fallback', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let profileRepo: ProfileRepo;
  let profileModelRepo: ProfileModelRepo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-service-'));
    db = openDatabase(path.join(tmpDir, 'hub.db'));
    profileRepo = new ProfileRepo(db);
    profileModelRepo = new ProfileModelRepo(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves discovered models to profile_models and returns them', async () => {
    const agyHome = path.join(tmpDir, 'agy-h');
    fs.mkdirSync(path.join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(agyHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'dummy');

    profileRepo.upsert({
      name: 'agy-worker',
      engine: 'agy',
      kind: 'isolated',
      home: agyHome,
      email: 'agy@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    const mockExecFile = async () => ({
      stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6',
      stderr: '',
    });

    const service = new ModelDiscoveryService(profileRepo, profileModelRepo, {
      execFileFn: mockExecFile,
    });

    const profile = profileRepo.get('agy-worker')!;
    const models = await service.discoverForProfile(profile);

    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash-high', 'claude-opus-4-6-thinking']);

    // Check DB persistence
    const saved = profileModelRepo.getForProfile('agy-worker');
    expect(saved).toHaveLength(2);
    expect(saved[0].modelId).toBe('claude-opus-4-6-thinking');
    expect(saved[1].modelId).toBe('gemini-3.8-flash-high');
    expect(saved[0].verified).toBe(1);
  });

  it('persists rejected models across discovery refreshes and clears rejection after a successful run', () => {
    profileRepo.upsert({
      name: 'codex-persisted',
      engine: 'codex',
      kind: 'isolated',
      home: '/tmp/codex-persisted',
      email: 'persisted@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    profileModelRepo.markUnavailable('codex-persisted', 'codex:gpt-rejected', 'codex', 'provider_rejected', 100);
    profileModelRepo.setForProfile('codex-persisted', [
      { modelId: 'codex:gpt-rejected', modelName: 'Rejected', engine: 'codex', verified: true },
      { modelId: 'codex:gpt-good', modelName: 'Good', engine: 'codex', verified: true },
    ], 200);

    let rows = profileModelRepo.getForProfile('codex-persisted');
    expect(rows.find((row) => row.modelId === 'codex:gpt-rejected')).toMatchObject({
      unavailableReason: 'provider_rejected',
      unavailableAt: 100,
    });
    expect(rows.find((row) => row.modelId === 'codex:gpt-good')?.verified).toBe(1);

    profileModelRepo.markRunVerified('codex-persisted', 'codex:gpt-rejected', 'codex', 300);
    rows = profileModelRepo.getForProfile('codex-persisted');
    expect(rows.find((row) => row.modelId === 'codex:gpt-rejected')).toMatchObject({
      runVerified: 1,
      unavailableReason: null,
      unavailableAt: null,
    });
  });

  it('exposes rejected and run-verified states in model options', () => {
    const home = path.join(tmpDir, 'codex-options-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-options',
      engine: 'codex',
      kind: 'isolated',
      home,
      email: 'options@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.markUnavailable('codex-options', 'codex:gpt-rejected', 'codex', 'provider_rejected');
    profileModelRepo.setForProfile('codex-options', [
      { modelId: 'codex:gpt-unverified', engine: 'codex', verified: false },
      { modelId: 'codex:gpt-verified', engine: 'codex', verified: false },
    ]);
    profileModelRepo.markRunVerified('codex-options', 'codex:gpt-verified', 'codex');

    const result = AppService.prototype.getModelOptions.call({
      profileRepo,
      profileModelRepo,
      config: { defaultModelChains: { hard: [], easy: [] }, reviewer: { order: [] } },
    } as any);

    expect(result.models.find((model) => model.id === 'codex:gpt-rejected')).toMatchObject({
      unavailable: true,
      available: false,
      warningCode: 'unavailable_for_account',
    });
    expect(result.models.find((model) => model.id === 'codex:gpt-verified')).toMatchObject({
      runVerified: true,
      available: true,
      warningCode: null,
    });
    expect(Scheduler.prototype.profileHasModel.call({ profileRepo, profileModelRepo } as any, 'codex-options', 'codex:gpt-rejected')).toBe(false);
  });

  it('markRunVerified records a run-verified model missing from the catalog of a discovered profile', () => {
    const home = path.join(tmpDir, 'codex-catalog-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-catalog',
      engine: 'codex',
      kind: 'isolated',
      home,
      email: 'catalog@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('codex-catalog', [{ modelId: 'codex:gpt-6', engine: 'codex', verified: true }]);

    // gpt-5.6-luna is not in this account's catalog but a run on it finished done.
    profileModelRepo.markRunVerified('codex-catalog', 'codex:gpt-5.6-luna', 'codex');

    const row = profileModelRepo.getForProfile('codex-catalog').find((r) => r.modelId === 'codex:gpt-5.6-luna');
    expect(row?.runVerified).toBeTruthy();
    const result = AppService.prototype.getModelOptions.call({
      profileRepo,
      profileModelRepo,
      config: { defaultModelChains: { hard: [], easy: [] }, reviewer: { order: [] } },
    } as any);
    expect(result.models.find((m) => m.id === 'codex:gpt-5.6-luna')).toMatchObject({ runVerified: true, available: true });
    expect(Scheduler.prototype.profileHasModel.call({ profileRepo, profileModelRepo } as any, 'codex-catalog', 'codex:gpt-5.6-luna')).toBe(true);
  });

  it('markRunVerified on a profile without discovery records run evidence but keeps the static model fallback', () => {
    const home = path.join(tmpDir, 'codex-no-discovery-home');
    fs.mkdirSync(home, { recursive: true });
    profileRepo.upsert({
      name: 'codex-no-discovery',
      engine: 'codex',
      kind: 'isolated',
      home,
      enabled: 1,
      accountType: 'personal',
    });
    const hasModel = (model: string) => Scheduler.prototype.profileHasModel.call({ profileRepo, profileModelRepo } as any, 'codex-no-discovery', model);
    expect(hasModel('codex:gpt-5.6-luna')).toBe(true);

    profileModelRepo.markRunVerified('codex-no-discovery', 'codex:gpt-5.6-luna', 'codex');

    // The run is recorded ...
    const rows = profileModelRepo.getForProfile('codex-no-discovery');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelId: 'codex:gpt-5.6-luna', runVerified: 1, verified: 0 });
    // ... but a run-evidence row is not a catalog: the profile keeps the static model
    // list. There is no auth.json yet, so the discovered-profile login guard must not
    // apply (this is what used to strand tasks in waiting_quota after a reviewer run).
    expect(hasModel('codex:gpt-5.6-luna')).toBe(true);

    // Once the account is logged in, /api/models reports the run-verified model.
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    const result = AppService.prototype.getModelOptions.call({
      profileRepo,
      profileModelRepo,
      config: { defaultModelChains: { hard: [], easy: [] }, reviewer: { order: [] } },
    } as any);
    expect(result.models.find((m) => m.id === 'codex:gpt-5.6-luna')).toMatchObject({ runVerified: true, available: true });
  });

  it('catalog refresh keeps run-verified models that the catalog no longer lists', () => {
    const home = path.join(tmpDir, 'codex-refresh-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-refresh',
      engine: 'codex',
      kind: 'isolated',
      home,
      email: 'refresh@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('codex-refresh', [
      { modelId: 'codex:gpt-old', engine: 'codex', verified: true },
      { modelId: 'codex:gpt-dropped', engine: 'codex', verified: true },
    ]);
    profileModelRepo.markRunVerified('codex-refresh', 'codex:gpt-old', 'codex');

    profileModelRepo.setForProfile('codex-refresh', [{ modelId: 'codex:gpt-new', engine: 'codex', verified: true }]);

    const ids = profileModelRepo.getForProfile('codex-refresh').map((r) => r.modelId).sort();
    expect(ids).toEqual(['codex:gpt-new', 'codex:gpt-old']);
    expect(profileModelRepo.getForProfile('codex-refresh').find((r) => r.modelId === 'codex:gpt-old')?.runVerified).toBe(1);
  });

  it('keeps a rejection visible when another enabled profile can run the same model', () => {
    for (const name of ['codex-rejected', 'codex-usable']) {
      const home = path.join(tmpDir, name);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'auth.json'), '{}');
      profileRepo.upsert({
        name,
        engine: 'codex',
        kind: 'isolated',
        home,
        email: `${name}@example.com`,
        enabled: 1,
        accountType: 'personal',
      });
    }
    profileModelRepo.markUnavailable('codex-rejected', 'codex:gpt-shared', 'codex', 'provider_rejected');
    profileModelRepo.setForProfile('codex-usable', [
      { modelId: 'codex:gpt-shared', modelName: 'Shared model', engine: 'codex', verified: true },
    ]);

    const result = AppService.prototype.getModelOptions.call({
      profileRepo,
      profileModelRepo,
      config: { defaultModelChains: { hard: [], easy: [] }, reviewer: { order: [] } },
    } as any);
    const shared = result.models.find((model) => model.id === 'codex:gpt-shared');

    expect(shared).toMatchObject({ available: true, unavailable: true });
    expect(shared?.profiles).toEqual(['codex-rejected', 'codex-usable']);
  });

  it('rejects saving a chain when every enabled profile rejects its model', () => {
    profileRepo.upsert({
      name: 'codex-config',
      engine: 'codex',
      kind: 'isolated',
      home: '/tmp/codex-config',
      email: 'config@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.markUnavailable('codex-config', 'codex:gpt-rejected', 'codex', 'provider_rejected');

    expect(() => AppService.prototype.updateConfig.call({ profileRepo, profileModelRepo } as any, {
      modelChainHard: ['codex:gpt-rejected'],
    })).toThrow('bị mọi tài khoản từ chối');
  });

  it('rejects a Claude chain model (prefixed or alias) with HTTP 400 only when every Claude profile rejects it', () => {
    for (const name of ['claude-config-a', 'claude-config-b']) {
      profileRepo.upsert({
        name,
        engine: 'claude',
        kind: 'isolated',
        home: `/tmp/${name}`,
        email: `${name}@example.com`,
        enabled: 1,
        accountType: 'personal',
      });
    }
    profileModelRepo.markUnavailable('claude-config-a', 'sonnet', 'claude', 'provider_rejected');

    const save = (model: string) => AppService.prototype.updateConfig.call(
      { profileRepo, profileModelRepo, config: {}, saveConfig: () => undefined } as any,
      { modelChainHard: [model] },
    );
    const statusOf = (model: string): number | undefined => {
      try {
        save(model);
        return undefined;
      } catch (err) {
        return (err as { statusCode?: number }).statusCode;
      }
    };

    // One Claude profile still accepts it: saving is allowed (no 400).
    expect(statusOf('claude:sonnet')).not.toBe(400);
    expect(statusOf('sonnet')).not.toBe(400);

    profileModelRepo.markUnavailable('claude-config-b', 'sonnet', 'claude', 'provider_rejected');
    for (const model of ['claude:sonnet', 'sonnet']) {
      expect(() => save(model)).toThrow('bị mọi tài khoản từ chối');
      expect(statusOf(model)).toBe(400);
    }
  });

  it('profileModelRepo supports same modelId across different engines for the same profile', () => {
    profileRepo.upsert({
      name: 'multi-engine-prof',
      engine: 'agy',
      kind: 'isolated',
      home: '/tmp/dummy',
      email: 'multi@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    expect(() => {
      profileModelRepo.setForProfile('multi-engine-prof', [
        { modelId: 'claude-3-5-sonnet', modelName: 'Sonnet via agy', engine: 'agy', verified: true },
        { modelId: 'claude-3-5-sonnet', modelName: 'Sonnet via claude', engine: 'claude', verified: true },
      ]);
    }).not.toThrow();

    const saved = profileModelRepo.getForProfile('multi-engine-prof');
    expect(saved).toHaveLength(2);
    expect(saved.map((m) => m.engine).sort()).toEqual(['agy', 'claude']);
  });

  it('migration 77 upgrades database from schema 76 and preserves existing data', () => {
    const legacyDbPath = path.join(tmpDir, 'legacy-schema-76.db');
    const rawDb = new Database(legacyDbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('foreign_keys = ON');
    // Run migrations 0 to 76 (77 migrations total, indexes 0..76)
    for (let i = 0; i < 77; i++) {
      if (i === 73) {
        const cols = (rawDb.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
        if (!cols.includes('runCount')) rawDb.exec('ALTER TABLE tasks ADD COLUMN runCount INTEGER NOT NULL DEFAULT 0');
        if (!cols.includes('consecutiveCrashes')) rawDb.exec('ALTER TABLE tasks ADD COLUMN consecutiveCrashes INTEGER NOT NULL DEFAULT 0');
      }
      rawDb.exec(MIGRATIONS[i]);
    }
    rawDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '76')").run();
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS profile_models (
        profileName TEXT NOT NULL,
        modelId TEXT NOT NULL,
        modelName TEXT,
        engine TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 1,
        fetchedAt INTEGER NOT NULL,
        PRIMARY KEY (profileName, modelId),
        FOREIGN KEY (profileName) REFERENCES profiles(name) ON DELETE CASCADE
      );
    `);
    rawDb.prepare("INSERT INTO profiles (name, engine, kind, home, email, enabled, accountType, createdAt) VALUES ('prof-m76', 'agy', 'isolated', '/tmp/p', 'm76@example.com', 1, 'personal', '2026-01-01')").run();
    rawDb.prepare("INSERT INTO profile_models (profileName, modelId, modelName, engine, verified, fetchedAt) VALUES ('prof-m76', 'shared-model', 'Model 1', 'agy', 1, 1000)").run();
    rawDb.close();

    // Now open via openDatabase (which runs migration 77, bringing version to 78)
    const upgradedDb = openDatabase(legacyDbPath);
    const repo = new ProfileModelRepo(upgradedDb);
    // Should now allow adding same modelId under claude engine
    expect(() => {
      repo.setForProfile('prof-m76', [
        { modelId: 'shared-model', modelName: 'Model 1', engine: 'agy', verified: true },
        { modelId: 'shared-model', modelName: 'Model 1', engine: 'claude', verified: true },
      ]);
    }).not.toThrow();

    const rows = repo.getForProfile('prof-m76');
    expect(rows).toHaveLength(2);
    upgradedDb.close();
  });

  it('falls back to DB cache if discovery command fails', async () => {
    const agyHome = path.join(tmpDir, 'agy-h2');
    fs.mkdirSync(path.join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(agyHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'dummy');

    profileRepo.upsert({
      name: 'agy-cached',
      engine: 'agy',
      kind: 'isolated',
      home: agyHome,
      email: 'cached@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    // Seed previous cached models in DB
    profileModelRepo.setForProfile('agy-cached', [
      { modelId: 'gemini-3.8-flash-low', modelName: 'Gemini 3.8 Flash (Low)', engine: 'agy', verified: true },
    ]);

    // Mock failing execFile
    const mockExecFile = async () => {
      throw new Error('agy command failed');
    };

    const service = new ModelDiscoveryService(profileRepo, profileModelRepo, {
      execFileFn: mockExecFile,
    });

    const profile = profileRepo.get('agy-cached')!;
    const models = await service.discoverForProfile(profile);

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('gemini-3.8-flash-low');
    expect(models[0].verified).toBe(true);
  });

  it('falls back to unverified defaults if discovery fails and no DB cache exists', async () => {
    const agyHome = path.join(tmpDir, 'agy-h3');
    fs.mkdirSync(path.join(agyHome, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(agyHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'dummy');

    profileRepo.upsert({
      name: 'agy-empty',
      engine: 'agy',
      kind: 'isolated',
      home: agyHome,
      email: 'empty@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    // Mock failing execFile
    const mockExecFile = async () => {
      throw new Error('Network error');
    };

    const service = new ModelDiscoveryService(profileRepo, profileModelRepo, {
      execFileFn: mockExecFile,
    });

    const profile = profileRepo.get('agy-empty')!;
    const models = await service.discoverForProfile(profile);

    expect(models).toEqual(DEFAULT_AGY_DISCOVERED_MODELS);
    expect(models.every((m) => m.verified === false)).toBe(true);
  });

  it('getModelOptions unifies models by engine, records profiles, and warns on missing configured models', () => {
    // 1. Add agy profile with models
    profileRepo.upsert({
      name: 'agy-p1',
      engine: 'agy',
      kind: 'keyring',
      email: 'p1@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('agy-p1', [
      { modelId: 'gemini-3.8-flash-high', modelName: 'Gemini 3.8 Flash (High)', engine: 'agy', verified: true },
    ]);

    // 2. Add second agy profile that also has gemini-3.8-flash-high
    profileRepo.upsert({
      name: 'agy-p2',
      engine: 'agy',
      kind: 'keyring',
      email: 'p2@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('agy-p2', [
      { modelId: 'gemini-3.8-flash-high', modelName: 'Gemini 3.8 Flash (High)', engine: 'agy', verified: true },
      { modelId: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', engine: 'agy', verified: true },
    ]);

    // 3. Add codex profile with auth.json
    const codexHome = path.join(tmpDir, 'codex-p1-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-p1',
      engine: 'codex',
      kind: 'isolated',
      home: codexHome,
      email: 'codex1@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('codex-p1', [
      { modelId: 'codex:gpt-6.1-sol', modelName: 'GPT-6.1-Sol', engine: 'codex', verified: true },
    ]);

    // Config with a model not provided by any profile
    const fakeConfig: any = {
      defaultModelChains: {
        hard: ['gemini-3.8-flash-high', 'nonexistent-model'],
        easy: ['claude-sonnet-4-6'],
      },
      reviewer: {
        order: [{ engine: 'codex', model: 'codex:gpt-6.1-sol', profiles: [] }],
      },
    };

    const service = {
      profileRepo,
      profileModelRepo,
      config: fakeConfig,
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    expect(result.suggestions).toContain('gemini-3.8-flash-high');
    expect(result.suggestions).toContain('claude-sonnet-4-6');
    expect(result.suggestions).toContain('codex:gpt-6.1-sol');
    expect(result.suggestions).not.toContain('nonexistent-model');

    const flashHigh = result.models.find((m: any) => m.id === 'gemini-3.8-flash-high');
    expect(flashHigh?.profiles).toEqual(['agy-p1', 'agy-p2']);
    expect(flashHigh?.available).toBe(true);

    const nonexistent = result.models.find((m: any) => m.id === 'nonexistent-model');
    expect(nonexistent?.available).toBe(false);
    expect(nonexistent?.profiles).toHaveLength(0);
    expect(nonexistent?.warning).toBeTruthy();
  });

  it('AppService.getModelOptions marks unverified engine fallback models as unavailable with empty profiles', () => {
    // Enabled profile with NO discovered models in DB (not logged in or discovery error)
    profileRepo.upsert({
      name: 'unverified-agy',
      engine: 'agy',
      kind: 'isolated',
      home: '/home/agy-unverified',
      email: 'unverified@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    const fakeConfig: any = {
      defaultModelChains: { hard: [], easy: [] },
      reviewer: { order: [] },
    };

    const service = {
      profileRepo,
      profileModelRepo,
      config: fakeConfig,
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    // Unverified default models must NOT list unverified-agy in profiles, and must be available: false
    const flashHigh = result.models.find((m) => m.id === 'gemini-3.8-flash-high');
    expect(flashHigh).toBeDefined();
    expect(flashHigh?.profiles).toEqual([]);
    expect(flashHigh?.verified).toBe(false);
    expect(flashHigh?.available).toBe(false);
    expect(flashHigh?.warning).toBe('Not verified by any account');
    expect(flashHigh?.warningCode).toBe('unverified_account');
    expect(result.suggestions).not.toContain('gemini-3.8-flash-high');
  });

  it('getModelOptions preserves provider rejection when another profile exposes the same model', () => {
    profileRepo.upsert({
      name: 'agy-usable',
      engine: 'agy',
      kind: 'keyring',
      email: 'usable@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileRepo.upsert({
      name: 'agy-rejected',
      engine: 'agy',
      kind: 'keyring',
      email: 'rejected@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('agy-usable', [
      { modelId: 'gemini-mixed-model', modelName: 'Gemini Mixed', engine: 'agy', verified: true },
    ]);
    profileModelRepo.markUnavailable('agy-rejected', 'gemini-mixed-model', 'agy', 'provider_rejected', 123);

    const result = AppService.prototype.getModelOptions.call({
      profileRepo,
      profileModelRepo,
      config: { defaultModelChains: { hard: [], easy: [] }, reviewer: { order: [] } },
    } as any);
    const mixed = result.models.find((model) => model.id === 'gemini-mixed-model');

    expect(mixed?.available).toBe(true);
    expect(mixed?.unavailable).toBe(true);
    expect(mixed?.unavailableReason).toBe('provider_rejected');
  });

  it('AppService.getModelOptions includes brain.fallback models and warns if no profile provides them', () => {
    const fakeConfig: any = {
      defaultModelChains: { hard: [], easy: [] },
      reviewer: { order: [] },
      brain: {
        model: 'claude-opus-4-6-thinking',
        fallback: [
          { type: 'model', model: 'custom-brain-fallback-model' },
          { type: 'wait' },
        ],
      },
    };

    const service = {
      profileRepo,
      profileModelRepo,
      config: fakeConfig,
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    expect(result.configured).toContain('custom-brain-fallback-model');
    expect(result.configured).toContain('claude-opus-4-6-thinking');

    const fallbackItem = result.models.find((m) => m.id === 'custom-brain-fallback-model');
    expect(fallbackItem).toBeDefined();
    expect(fallbackItem?.available).toBe(false);
    expect(fallbackItem?.profiles).toEqual([]);
    expect(fallbackItem?.warning).toBe('Configured model is not provided by any account');
    expect(fallbackItem?.warningCode).toBe('configured_no_provider');
  });

  it('isKnownModel checks discovered models and falls back to hardcoded models', () => {
    expect(isKnownModel('gemini-3.8-flash-high')).toBe(true);
    expect(isKnownModel('unknown-model')).toBe(false);

    // With custom discovered models
    const custom = new Set(['my-custom-model', 'gemini-3.8-flash-high']);
    expect(isKnownModel('my-custom-model', custom)).toBe(true);
    expect(isKnownModel('gemini-3.8-flash-high', custom)).toBe(true);
    expect(isKnownModel('claude-opus-4-6-thinking', custom)).toBe(false);
    // When discovered models only contain agy models, codex engine models fall back to defined fallback models
    expect(isKnownModel('codex:gpt-5.6-luna', custom)).toBe(true);
    expect(isKnownModel('codex:non-existent', custom)).toBe(false);
    expect(isKnownModel('codex:', custom)).toBe(false);
  });

  it('Scheduler.getKnownDiscoveredModels merges discovered models with fallback models for undiscovered profiles', () => {
    // agy-1 has discovered models in DB
    profileRepo.upsert({
      name: 'agy-with-disc',
      engine: 'agy',
      kind: 'keyring',
      email: 'disc@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('agy-with-disc', [
      { modelId: 'gemini-custom-model', modelName: 'Gemini Custom', engine: 'agy', verified: true },
    ]);

    // agy-2 has NO discovery recorded yet
    profileRepo.upsert({
      name: 'agy-no-disc',
      engine: 'agy',
      kind: 'keyring',
      email: 'nodisc@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    // Call getKnownDiscoveredModels method from Scheduler
    const known = Scheduler.prototype.getKnownDiscoveredModels.call({
      profileRepo,
      profileModelRepo,
    } as any);

    expect(known.has('gemini-custom-model')).toBe(true);
    expect(known.has('gemini-3.8-flash-high')).toBe(true);
    expect(known.has('claude-opus-4-6-thinking')).toBe(true);
  });

  it('Scheduler.profileHasModel only allows defined fallback models for undiscovered codex profiles', () => {
    const home = path.join(tmpDir, 'codex-undiscovered-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-undiscovered',
      engine: 'codex',
      kind: 'isolated',
      home,
      email: 'codex@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    const scheduler = {
      profileRepo,
      profileModelRepo,
    };

    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'codex-undiscovered', 'codex:gpt-5.6-luna')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'codex-undiscovered', 'gpt-5.6-luna')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'codex-undiscovered', 'codex:model-khong-ton-tai')).toBe(false);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'codex-undiscovered', 'codex:gpt-fake')).toBe(false);
  });

  it('Scheduler.profileHasModel only allows defined fallback models for undiscovered claude profiles', () => {
    profileRepo.upsert({
      name: 'claude-undiscovered',
      engine: 'claude',
      kind: 'keyring',
      email: 'claude@example.com',
      enabled: 1,
      accountType: 'personal',
    });

    const scheduler = {
      profileRepo,
      profileModelRepo,
    };

    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-undiscovered', 'sonnet')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-undiscovered', 'claude:sonnet')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-undiscovered', 'opus')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-undiscovered', 'haiku')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-undiscovered', 'claude-sonnet-4-6')).toBe(false);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-undiscovered', 'claude-fake-model')).toBe(false);
  });

  it('Scheduler.profileHasModel matches prefixed reviewer ids against discovered Claude rows', () => {
    profileRepo.upsert({
      name: 'claude-discovered',
      engine: 'claude',
      kind: 'keyring',
      email: 'claude2@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('claude-discovered', [
      { modelId: 'opus', modelName: 'Claude Opus', engine: 'claude', verified: true },
    ]);

    const scheduler = { profileRepo, profileModelRepo };

    // Reviewer selection passes normalizeReviewerModel('claude', 'opus') === 'claude:opus'
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-discovered', 'claude:opus')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-discovered', 'opus')).toBe(true);
    // Discovery is additive: built-in aliases stay usable, unknown models do not.
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-discovered', 'claude:sonnet')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-discovered', 'claude:claude-fake-model')).toBe(false);
  });

  it('keeps statically known Codex models usable when discovery only lists variant slugs', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-variant-'));
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-variants',
      engine: 'codex',
      kind: 'isolated',
      home: codexHome,
      email: 'variants@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    // Real models_cache.json seen on 2026-11-16: only "-wm" variants, no canonical gpt-5.6-luna.
    profileModelRepo.setForProfile('codex-variants', [
      { modelId: 'codex:gpt-5.6-luna-wm', modelName: 'GPT-5.6 Luna WM', engine: 'codex', verified: true },
      { modelId: 'codex:gpt-6', modelName: 'GPT-6', engine: 'codex', verified: true },
    ]);
    const scheduler = { profileRepo, profileModelRepo };
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'codex-variants', 'codex:gpt-5.6-luna')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'codex-variants', 'codex:gpt-6')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'codex-variants', 'codex:gpt-fake')).toBe(false);
  });

  it('Scheduler.profileHasModel matches unverified Claude aliases when discovery rows have verified: false', () => {
    profileRepo.upsert({
      name: 'claude-unverified-aliases',
      engine: 'claude',
      kind: 'keyring',
      email: 'claude3@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('claude-unverified-aliases', [
      { modelId: 'sonnet', modelName: 'Claude Sonnet', engine: 'claude', verified: false },
      { modelId: 'opus', modelName: 'Claude Opus', engine: 'claude', verified: false },
      { modelId: 'haiku', modelName: 'Claude Haiku', engine: 'claude', verified: false },
      { modelId: 'custom-unverified', modelName: 'Custom Unverified', engine: 'claude', verified: false },
    ]);

    const scheduler = { profileRepo, profileModelRepo };

    // Prefixed and bare Claude aliases match even with verified: false
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-unverified-aliases', 'claude:opus')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-unverified-aliases', 'opus')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-unverified-aliases', 'claude:sonnet')).toBe(true);
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-unverified-aliases', 'haiku')).toBe(true);

    // Unverified non-alias model does NOT match
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-unverified-aliases', 'custom-unverified')).toBe(false);
  });

  it('AppService.getModelOptions treats unverified Claude aliases as available for logged-in Claude profile', () => {
    const claudeHome = path.join(tmpDir, 'claude-unverified-opts');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), '{}');
    profileRepo.upsert({
      name: 'claude-active-prof',
      engine: 'claude',
      kind: 'isolated',
      home: claudeHome,
      email: 'active-claude@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('claude-active-prof', [
      { modelId: 'sonnet', modelName: 'Claude Sonnet', engine: 'claude', verified: false },
      { modelId: 'opus', modelName: 'Claude Opus', engine: 'claude', verified: false },
      { modelId: 'haiku', modelName: 'Claude Haiku', engine: 'claude', verified: false },
    ]);

    const service = {
      profileRepo,
      profileModelRepo,
      config: {
        defaultModelChains: { hard: [], easy: [] },
        reviewer: { order: [] },
      },
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    const sonnet = result.models.find((m: any) => m.id === 'sonnet' && m.engine === 'claude');
    expect(sonnet).toBeDefined();
    expect(sonnet?.available).toBe(true);
    expect(sonnet?.verified).toBe(false);
    expect(sonnet?.profiles).toContain('claude-active-prof');
    expect(result.suggestions).toContain('sonnet');
    expect(result.suggestions).toContain('opus');
    expect(result.suggestions).toContain('haiku');
  });

  it('logged-out profile marks cache unverified and is treated as unavailable across discovery, API, and scheduler', async () => {
    // 1. Profile with authState not_logged_in
    profileRepo.upsert({
      name: 'agy-logged-out',
      engine: 'agy',
      kind: 'keyring',
      email: 'loggedout@example.com',
      enabled: 1,
      accountType: 'personal',
      authState: 'not_logged_in',
    });

    // Previously verified cache in DB
    profileModelRepo.setForProfile('agy-logged-out', [
      { modelId: 'gemini-exclusive-model', modelName: 'Gemini Exclusive', engine: 'agy', verified: true },
    ]);

    // A. ModelDiscoveryService.discoverForProfile returns verified: false and marks cache verified: 0
    const discoveryService = new ModelDiscoveryService(profileRepo, profileModelRepo);
    const discovered = await discoveryService.discoverForProfile(profileRepo.get('agy-logged-out')!);
    expect(discovered.find((m) => m.id === 'gemini-exclusive-model')?.verified).toBe(false);

    const dbCached = profileModelRepo.getForProfile('agy-logged-out');
    expect(dbCached.find((m) => m.modelId === 'gemini-exclusive-model')?.verified).toBe(0);

    // B. AppService.getModelOptions does NOT include logged-out profile or mark model available
    const service = {
      profileRepo,
      profileModelRepo,
      config: {
        defaultModelChains: { hard: [], easy: [] },
        reviewer: { order: [] },
      },
    };
    const options = AppService.prototype.getModelOptions.call(service as any);
    const exclusiveModel = options.models.find((m) => m.id === 'gemini-exclusive-model');
    // Model not provided by any logged-in profile must not be available
    expect(exclusiveModel?.available ?? false).toBe(false);
    expect(exclusiveModel?.profiles ?? []).not.toContain('agy-logged-out');
    expect(options.suggestions).not.toContain('gemini-exclusive-model');

    // C. Scheduler: profileHasModel returns false for logged-out profile
    const scheduler = {
      profileRepo,
      profileModelRepo,
    };
    const hasModel = Scheduler.prototype.profileHasModel.call(scheduler as any, 'agy-logged-out', 'gemini-exclusive-model');
    expect(hasModel).toBe(false);

    // D. Scheduler: getKnownDiscoveredModels does not include models only on logged-out profile
    const known = Scheduler.prototype.getKnownDiscoveredModels.call(scheduler as any);
    expect(known.has('gemini-exclusive-model')).toBe(false);
  });

  it('getModelOptions unifies models by (engine, modelId) without cross-assigning profiles between engines sharing model ID', () => {
    // 1. Add agy profile providing claude-3-5-sonnet
    profileRepo.upsert({
      name: 'agy-sonnet-prof',
      engine: 'agy',
      kind: 'keyring',
      email: 'agy@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('agy-sonnet-prof', [
      { modelId: 'claude-3-5-sonnet', modelName: 'Claude 3.5 Sonnet', engine: 'agy', verified: true },
    ]);

    // 2. Add claude profile providing claude-3-5-sonnet
    const claudeHome = path.join(tmpDir, 'claude-sonnet-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), '{}');
    profileRepo.upsert({
      name: 'claude-sonnet-prof',
      engine: 'claude',
      kind: 'isolated',
      home: claudeHome,
      email: 'claude@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('claude-sonnet-prof', [
      { modelId: 'claude-3-5-sonnet', modelName: 'Claude 3.5 Sonnet', engine: 'claude', verified: true },
    ]);

    const service = {
      profileRepo,
      profileModelRepo,
      config: {
        defaultModelChains: { hard: [], easy: [] },
        reviewer: { order: [] },
      },
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    const sonnetModels = result.models.filter((m) => m.id === 'claude-3-5-sonnet');
    expect(sonnetModels).toHaveLength(2);

    const agyEntry = sonnetModels.find((m) => m.engine === 'agy');
    const claudeEntry = sonnetModels.find((m) => m.engine === 'claude');

    expect(agyEntry).toBeDefined();
    expect(agyEntry?.profiles).toEqual(['agy-sonnet-prof']);
    expect(agyEntry?.available).toBe(true);

    expect(claudeEntry).toBeDefined();
    expect(claudeEntry?.profiles).toEqual(['claude-sonnet-prof']);
    expect(claudeEntry?.available).toBe(true);
  });

  it('getModelOptions unifies models by (engine, id) key so identical id across agy and claude is not merged', () => {
    // Agy profile with "sonnet"
    profileRepo.upsert({
      name: 'agy-same-id',
      engine: 'agy',
      kind: 'keyring',
      email: 'agy-same@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('agy-same-id', [
      { modelId: 'sonnet', modelName: 'Agy Sonnet', engine: 'agy', verified: true },
    ]);

    // Claude profile with "sonnet"
    const claudeHome = path.join(tmpDir, 'claude-same-id-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), '{}');
    profileRepo.upsert({
      name: 'claude-same-id',
      engine: 'claude',
      kind: 'isolated',
      home: claudeHome,
      email: 'claude-same@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('claude-same-id', [
      { modelId: 'sonnet', modelName: 'Claude Sonnet', engine: 'claude', verified: false },
    ]);

    const service = {
      profileRepo,
      profileModelRepo,
      config: {
        defaultModelChains: { hard: [], easy: [] },
        reviewer: { order: [] },
      },
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    const matched = result.models.filter((m: any) => m.id === 'sonnet');
    expect(matched).toHaveLength(2);

    const agyModel = matched.find((m: any) => m.engine === 'agy');
    const claudeModel = matched.find((m: any) => m.engine === 'claude');

    expect(agyModel).toBeDefined();
    expect(agyModel?.profiles).toEqual(['agy-same-id']);

    expect(claudeModel).toBeDefined();
    expect(claudeModel?.profiles).toEqual(['claude-same-id']);
  });

  it('getModelOptions normalizes brain.codexModel into codex: namespace without creating false warning or duplicate', () => {
    const codexHome = path.join(tmpDir, 'codex-brain-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-brain-prof',
      engine: 'codex',
      kind: 'isolated',
      home: codexHome,
      email: 'codex-brain@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('codex-brain-prof', [
      { modelId: 'codex:gpt-5.6-luna', modelName: 'GPT-5.6-Luna', engine: 'codex', verified: true },
    ]);

    const service = {
      profileRepo,
      profileModelRepo,
      config: {
        defaultModelChains: { hard: [], easy: [] },
        reviewer: { order: [] },
        brain: {
          codexModel: 'gpt-5.6-luna', // Configured without codex: prefix
        },
      },
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    expect(result.configured).toContain('codex:gpt-5.6-luna');
    expect(result.configured).not.toContain('gpt-5.6-luna');

    const codexLuna = result.models.find((m) => m.id === 'codex:gpt-5.6-luna');
    expect(codexLuna).toBeDefined();
    expect(codexLuna?.available).toBe(true);
    expect(codexLuna?.warning).toBeNull();
    expect(codexLuna?.profiles).toContain('codex-brain-prof');

    // Should NOT have a duplicate or warning model for 'gpt-5.6-luna'
    const bareLuna = result.models.find((m) => m.id === 'gpt-5.6-luna');
    expect(bareLuna).toBeUndefined();
  });

  it('getModelOptions correctly keys codex models as codex:<id> and matches configured without codex:codex: key or false warning', () => {
    const codexHome = path.join(tmpDir, 'codex-audit-home');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
    profileRepo.upsert({
      name: 'codex-audit-prof',
      engine: 'codex',
      kind: 'isolated',
      home: codexHome,
      email: 'codex-audit@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('codex-audit-prof', [
      { modelId: 'codex:gpt-5.6-luna', modelName: 'GPT-5.6-Luna', engine: 'codex', verified: true },
    ]);

    const service = {
      profileRepo,
      profileModelRepo,
      config: {
        defaultModelChains: { hard: ['codex:gpt-5.6-luna'], easy: ['gpt-5.6-luna'] },
        reviewer: {
          order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna' }],
          arbiter: { engine: 'codex', model: 'codex:gpt-5.6-luna' },
        },
      },
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    expect(result.configured).toContain('codex:gpt-5.6-luna');
    expect(result.configured).not.toContain('gpt-5.6-luna');

    // No model should have codex:codex:
    for (const m of result.models) {
      expect(m.id).not.toContain('codex:codex:');
      expect(m.name).not.toContain('codex:codex:');
    }

    const codexLuna = result.models.find((m) => m.id === 'codex:gpt-5.6-luna');
    expect(codexLuna).toBeDefined();
    expect(codexLuna?.available).toBe(true);
    expect(codexLuna?.configured).toBe(true);
    expect(codexLuna?.warning).toBeNull();
    expect(codexLuna?.profiles).toContain('codex-audit-prof');

    // There should NOT be any false warning entry for gpt-5.6-luna
    const warnings = result.models.filter((m) => m.warning && m.id.includes('gpt-5.6-luna'));
    expect(warnings).toHaveLength(0);
  });

  it('AppService.getModelOptions scans projectRepo and returns models configured only in a project with available:false, configured:true', () => {
    const fakeProjectRepo = {
      getAll: () => [
        {
          id: 'proj-1',
          name: 'Project 1',
          reviewChain: JSON.stringify([{ reviewer: 'codex:project-only-reviewer', mode: 'gate' }]),
          settings: JSON.stringify({
            review: {
              order: [{ engine: 'claude', model: 'project-only-claude-reviewer' }],
            },
            brain: {
              model: 'project-only-brain-model',
            },
          }),
        },
      ],
    };

    const service = {
      profileRepo,
      profileModelRepo,
      projectRepo: fakeProjectRepo,
      config: {
        defaultModelChains: { hard: [], easy: [] },
        reviewer: { order: [] },
      },
    };

    const result = AppService.prototype.getModelOptions.call(service as any);
    expect(result.configured).toContain('codex:project-only-reviewer');
    expect(result.configured).toContain('project-only-claude-reviewer');
    expect(result.configured).toContain('project-only-brain-model');

    const projCodexReviewer = result.models.find((m) => m.id === 'codex:project-only-reviewer');
    expect(projCodexReviewer).toBeDefined();
    expect(projCodexReviewer?.available).toBe(false);
    expect(projCodexReviewer?.configured).toBe(true);
    expect(projCodexReviewer?.warning).toBeTruthy();

    const projClaudeReviewer = result.models.find((m) => m.id === 'project-only-claude-reviewer');
    expect(projClaudeReviewer).toBeDefined();
    expect(projClaudeReviewer?.available).toBe(false);
    expect(projClaudeReviewer?.configured).toBe(true);

    const projBrain = result.models.find((m) => m.id === 'project-only-brain-model');
    expect(projBrain).toBeDefined();
    expect(projBrain?.available).toBe(false);
    expect(projBrain?.configured).toBe(true);
  });

  it('ChatService.validateSessionOptions accepts models discovered in profileModelRepo for active profiles', () => {
    const claudeHome = path.join(tmpDir, 'claude-chat-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, '.credentials.json'), '{}');
    profileRepo.upsert({
      name: 'claude-chat-prof',
      engine: 'claude',
      kind: 'isolated',
      home: claudeHome,
      email: 'chat@example.com',
      enabled: 1,
      accountType: 'personal',
    });
    profileModelRepo.setForProfile('claude-chat-prof', [
      { modelId: 'claude-3-5-sonnet-20241022', modelName: 'Claude 3.5 Sonnet', engine: 'claude', verified: true },
    ]);

    const chatService = {
      config: {
        chat: { model: 'sonnet', models: ['opus', 'sonnet', 'haiku'] },
      },
      profileRepo,
      profileModelRepo,
    };

    // Calling validateSessionOptions with discovered model should succeed
    const validated = (ChatService.prototype as any).validateSessionOptions.call(chatService, {
      model: 'claude-3-5-sonnet-20241022',
    });
    expect(validated.model).toBe('claude-3-5-sonnet-20241022');

    // Calling with custom model should succeed
    const custom = (ChatService.prototype as any).validateSessionOptions.call(chatService, {
      model: 'claude-custom-unverified',
    });
    expect(custom.model).toBe('claude-custom-unverified');

    // Calling with model containing whitespace should throw 400
    expect(() => {
      (ChatService.prototype as any).validateSessionOptions.call(chatService, {
        model: 'invalid model with spaces',
      });
    }).toThrow();
  });
});
