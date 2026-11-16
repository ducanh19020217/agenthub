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
    expect(flashHigh?.warning).toBe('Chưa xác minh qua tài khoản');
    expect(result.suggestions).not.toContain('gemini-3.8-flash-high');
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
    expect(fallbackItem?.warning).toContain('Model đang được cấu hình');
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
    profileRepo.upsert({
      name: 'codex-undiscovered',
      engine: 'codex',
      kind: 'isolated',
      home: '/tmp/dummy-codex',
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
    expect(Scheduler.prototype.profileHasModel.call(scheduler as any, 'claude-discovered', 'claude:sonnet')).toBe(false);
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
