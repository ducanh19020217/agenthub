import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ProfileRow } from '../db/index.js';
import { applyIsolatedAgyEnv, findAgyBin } from '../agy.js';
import { readCodexAccessToken } from '../quota/codex-api.js';

const execFileAsync = promisify(execFile);

export interface DiscoveredModelItem {
  id: string;
  name: string;
  engine: 'agy' | 'codex' | 'claude';
  verified: boolean;
}

export const DEFAULT_AGY_DISCOVERED_MODELS: DiscoveredModelItem[] = [
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', engine: 'agy', verified: false },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', engine: 'agy', verified: false },
  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', engine: 'agy', verified: false },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', engine: 'agy', verified: false },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', engine: 'agy', verified: false },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', engine: 'agy', verified: false },
];

export const DEFAULT_CODEX_DISCOVERED_MODELS: DiscoveredModelItem[] = [
  { id: 'codex:gpt-5.6-luna', name: 'GPT-5.6-Luna', engine: 'codex', verified: false },
];

export const DEFAULT_CLAUDE_DISCOVERED_MODELS: DiscoveredModelItem[] = [
  { id: 'sonnet', name: 'Claude Sonnet', engine: 'claude', verified: false },
  { id: 'opus', name: 'Claude Opus', engine: 'claude', verified: false },
  { id: 'haiku', name: 'Claude Haiku', engine: 'claude', verified: false },
];

export function getDefaultModelsForEngine(engine: string): DiscoveredModelItem[] {
  if (engine === 'agy') return DEFAULT_AGY_DISCOVERED_MODELS;
  if (engine === 'codex') return DEFAULT_CODEX_DISCOVERED_MODELS;
  if (engine === 'claude') return DEFAULT_CLAUDE_DISCOVERED_MODELS;
  return [];
}

/**
 * Parse output of `agy models`.
 * Output consists of lines: `<id>\t<name>` or `<id>    <name>`,
 * potentially preceded by spinner output like "Fetching available models...".
 */
export function parseAgyModelsOutput(output: string): DiscoveredModelItem[] {
  const result: DiscoveredModelItem[] = [];
  const lines = output.split(/\r?\n/);
  for (const rawLine of lines) {
    // Strip terminal spinner characters and ANSI escapes
    // eslint-disable-next-line no-control-regex -- strips terminal escape sequences
    const line = rawLine.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '').trim();
    if (!line || line.startsWith('Fetching available models')) continue;

    // Line format: <id><whitespace><name>
    const match = line.match(/^([a-zA-Z0-9_.-]+)(?:\s+(.+))?$/);
    if (!match) continue;

    const id = match[1].trim();
    const name = match[2]?.trim() || id;
    result.push({ id, name, engine: 'agy', verified: true });
  }
  return result;
}

export type ExecFileFunction = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export async function discoverAgyModels(
  profile: ProfileRow,
  options?: { agyBin?: string; execFileFn?: ExecFileFunction },
): Promise<DiscoveredModelItem[]> {
  if (process.env.VITEST && !options?.execFileFn) {
    return DEFAULT_AGY_DISCOVERED_MODELS;
  }

  const env: Record<string, string> = {
    ...process.env,
    BROWSER: '/bin/false',
    TERM: 'dumb',
    NO_COLOR: '1',
  } as Record<string, string>;

  if (profile.kind === 'isolated' && profile.home) {
    applyIsolatedAgyEnv(env, profile.home);
  }

  const agyPath = options?.agyBin || findAgyBin() || 'agy';
  const execFn = options?.execFileFn || (execFileAsync as unknown as ExecFileFunction);

  const { stdout } = await execFn(agyPath, ['models'], {
    env,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });

  const parsed = parseAgyModelsOutput(stdout);
  if (parsed.length === 0) {
    throw new Error('No models found in agy output');
  }
  return parsed;
}

/**
 * Parse models from Codex `models_cache.json` or `/backend-api/models` JSON payload.
 */
export function parseCodexModelsData(raw: unknown): DiscoveredModelItem[] {
  const result: DiscoveredModelItem[] = [];
  if (!raw || typeof raw !== 'object') return result;

  const data = raw as Record<string, unknown>;
  const models = Array.isArray(data.models) ? (data.models as Record<string, unknown>[]) : [];

  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const slug = typeof m.slug === 'string' ? m.slug.trim() : '';
    if (!slug) continue;

    // Filter out internal/hidden models (like codex-auto-review, gpt-reserve)
    if (m.visibility === 'hide') continue;

    const id = slug.startsWith('codex:') ? slug : `codex:${slug}`;
    const name = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : slug;
    result.push({ id, name, engine: 'codex', verified: true });
  }

  return result;
}

export async function discoverCodexModels(
  profile: ProfileRow,
  options?: { force?: boolean; fetchApi?: boolean; customHome?: string; fetchFn?: typeof fetch },
): Promise<DiscoveredModelItem[]> {
  const codexDir = options?.customHome || (
    profile.kind === 'isolated' && profile.home
      ? profile.home
      : path.join(profile.home || os.homedir(), '.codex')
  );

  const isForce = Boolean(options?.force || options?.fetchApi);
  const cacheFile = path.join(codexDir, 'models_cache.json');

  // 1. Try reading `models_cache.json` from the profile's codex directory if not forced
  if (!isForce && fs.existsSync(cacheFile)) {
    try {
      const content = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const parsed = parseCodexModelsData(content);
      if (parsed.length > 0) return parsed;
    } catch {
      // cache unreadable or invalid, fall through
    }
  }

  // 2. If no cache or forced API fetch, call ChatGPT/Codex models endpoint
  if (process.env.VITEST && !options?.fetchFn) {
    return DEFAULT_CODEX_DISCOVERED_MODELS;
  }

  const tokenRes = readCodexAccessToken(codexDir);
  if ('skip' in tokenRes) {
    if (fs.existsSync(cacheFile)) {
      try {
        const content = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const parsed = parseCodexModelsData(content);
        if (parsed.length > 0) return parsed;
      } catch {
        // ignore fallback errors
      }
    }
    throw new Error(`Codex credentials unavailable: ${tokenRes.skip}`);
  }

  const doFetch = options?.fetchFn || fetch;
  try {
    const res = await doFetch('https://chatgpt.com/backend-api/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokenRes.accessToken}`,
        Accept: 'application/json',
        ...(tokenRes.accountId ? { 'ChatGPT-Account-Id': tokenRes.accountId } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Codex API request failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    const parsed = parseCodexModelsData(data);
    if (parsed.length === 0) {
      throw new Error('No valid codex models found in API response');
    }
    return parsed;
  } catch (err) {
    if (fs.existsSync(cacheFile)) {
      try {
        const content = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const parsed = parseCodexModelsData(content);
        if (parsed.length > 0) return parsed;
      } catch {
        // ignore fallback errors
      }
    }
    throw err;
  }
}

/**
 * Parse models from Claude model-catalog cache JSON file.
 */
export function parseClaudeModelCatalog(raw: unknown): DiscoveredModelItem[] {
  const result: DiscoveredModelItem[] = [];
  if (!raw || typeof raw !== 'object') return result;

  const data = raw as Record<string, unknown>;
  const catalog = data.catalog && typeof data.catalog === 'object' ? (data.catalog as Record<string, unknown>) : null;
  const config = catalog?.config && typeof catalog.config === 'object' ? (catalog.config as Record<string, unknown>) : null;
  const models = Array.isArray(config?.models) ? (config!.models as Record<string, unknown>[]) : [];

  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id) continue;

    const name = typeof m.name === 'string' && m.name.trim()
      ? m.name.trim()
      : typeof m.short_name === 'string' && m.short_name.trim()
        ? m.short_name.trim()
        : id;

    result.push({ id, name, engine: 'claude', verified: true });
  }

  return result;
}

export async function discoverClaudeModels(
  profile: ProfileRow,
  options?: { customHome?: string },
): Promise<DiscoveredModelItem[]> {
  const baseAliases = (verified: boolean): DiscoveredModelItem[] => [
    { id: 'sonnet', name: 'Claude Sonnet', engine: 'claude', verified },
    { id: 'opus', name: 'Claude Opus', engine: 'claude', verified },
    { id: 'haiku', name: 'Claude Haiku', engine: 'claude', verified },
  ];

  const home = options?.customHome || profile.home || (process.env.VITEST ? undefined : os.homedir());
  if (!home) return baseAliases(false);
  const candidateDirs = profile.kind === 'isolated'
    ? [path.join(home, '.claude', 'cache', 'model-catalog'), path.join(home, 'cache', 'model-catalog')]
    : [path.join(home, '.claude', 'cache', 'model-catalog')];

  let catalogModels: DiscoveredModelItem[] = [];
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      if (files.length === 0) continue;

      // Find the latest file by mtime
      let latestFile = files[0];
      let latestMtime = 0;
      for (const file of files) {
        const stat = fs.statSync(path.join(dir, file));
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestFile = file;
        }
      }

      const content = JSON.parse(fs.readFileSync(path.join(dir, latestFile), 'utf8'));
      const parsed = parseClaudeModelCatalog(content);
      if (parsed.length > 0) {
        catalogModels = parsed;
        break;
      }
    } catch {
      // Continue to next directory or fallback
    }
  }

  // Merge catalog models with base aliases (aliases first, then catalog without duplicate IDs)
  const aliases = baseAliases(catalogModels.length > 0);
  const seenIds = new Set(aliases.map((a) => a.id));
  const merged: DiscoveredModelItem[] = [...aliases];
  for (const m of catalogModels) {
    if (!seenIds.has(m.id)) {
      seenIds.add(m.id);
      merged.push(m);
    }
  }

  return merged;
}
