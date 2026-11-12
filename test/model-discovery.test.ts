import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseAgyModelsOutput,
  parseCodexModelsData,
  parseClaudeModelCatalog,
  discoverAgyModels,
  discoverCodexModels,
  discoverClaudeModels,
  ModelDiscoveryService,
  DEFAULT_AGY_DISCOVERED_MODELS,
  DEFAULT_CODEX_DISCOVERED_MODELS,
  DEFAULT_CLAUDE_DISCOVERED_MODELS,
} from '../src/models/index.js';
import { openDatabase, ProfileModelRepo, ProfileRepo, ProfileRow } from '../src/db/index.js';

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
});
