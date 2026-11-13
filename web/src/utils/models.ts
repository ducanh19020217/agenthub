import type { DiscoveredModel } from '../types/api';

export const VALID_AGY_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

export const DEFAULT_VALID_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'codex:gpt-5.6-luna',
  'gpt-oss-120b-medium',
];

export const DEFAULT_CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

export const DEFAULT_CODEX_MODELS = ['gpt-5.6-luna', 'gpt-5.6-turbo'];

export type ModelProvider = 'gemini' | 'claude' | 'codex';

/**
 * Model ids returned by /api/models use the same prefixes as the backend
 * validator. Keep this classification in one place so a provider selector
 * never presents models from another provider.
 */
export function getModelProvider(model: string): ModelProvider | null {
  const trimmed = model.trim();
  if (trimmed.startsWith('codex:')) {
    const raw = trimmed.slice('codex:'.length);
    return raw && !raw.startsWith('gpt-oss-') ? 'codex' : null;
  }
  if (trimmed.startsWith('gpt-') && !trimmed.startsWith('gpt-oss-')) return 'codex';
  if (trimmed.startsWith('gemini-')) return 'gemini';
  if (trimmed.startsWith('claude-') || DEFAULT_CLAUDE_MODELS.includes(trimmed)) return 'claude';
  return null;
}

export function getModelsForProvider(models: string[], provider: ModelProvider): string[] {
  return Array.from(new Set(models.filter((model) => getModelProvider(model) === provider)));
}

export const DEFAULT_COMMON_BRANCHES = ['integration', 'main', 'master', 'develop', 'staging'];

export interface GroupedModelOption {
  value: string;
  label: string;
  group?: string;
  engine?: 'agy' | 'codex' | 'claude';
  profiles?: string[];
  verified?: boolean;
  available?: boolean;
  warning?: string | null;
}

export function formatDiscoveredModelOptions(
  models?: DiscoveredModel[],
  t?: (key: string, params?: Record<string, any>) => string,
  filterEngine?: 'agy' | 'codex' | 'claude' | ('agy' | 'codex' | 'claude')[],
  onlyAvailable = false,
): GroupedModelOption[] {
  if (!models || models.length === 0) return [];

  const allowedEngines = filterEngine
    ? Array.isArray(filterEngine)
      ? filterEngine
      : [filterEngine]
    : null;

  let filtered = allowedEngines
    ? models.filter((m) => allowedEngines.includes(m.engine))
    : models;

  if (onlyAvailable) {
    filtered = filtered.filter((m) => m.available);
  }

  const engineLabels: Record<string, string> = {
    agy: t ? t('models.engineAgy') : 'Antigravity (agy)',
    codex: t ? t('models.engineCodex') : 'Codex',
    claude: t ? t('models.engineClaude') : 'Claude',
  };

  return filtered.map((m) => {
    const group = engineLabels[m.engine] || m.engine;
    const baseName = m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
    let label = baseName;
    if (m.profiles && m.profiles.length > 0) {
      const countStr = t
        ? t('models.accountCount', { count: m.profiles.length })
        : `${m.profiles.length} account(s)`;
      label = `${baseName} (${countStr})`;
    } else if (!m.available) {
      label = `${baseName} (⚠️ ${t ? t('models.unavailableWarning') : 'Unavailable'})`;
    }

    return {
      value: m.id,
      label,
      group,
      engine: m.engine,
      profiles: m.profiles,
      verified: m.verified,
      available: m.available,
      warning: m.warning,
    };
  });
}

export function validateModelSyntax(
  model: string,
  t?: (key: string) => string,
  knownModels?: Iterable<string>,
): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return t ? t('settings.emptyChainWarning') : 'Model cannot be empty';
  }
  if (knownModels && new Set(knownModels).has(trimmed)) {
    return null;
  }
  const isAgy = VALID_AGY_MODELS.includes(trimmed);
  const isCodex =
    trimmed.startsWith('codex:') &&
    validateReviewerModelSyntax(trimmed, 'codex') === null;

  if (!isAgy && !isCodex) {
    return t
      ? t('settings.invalidModelSyntax')
      : 'Each model must be a valid agy id or codex model (codex:gpt-...)';
  }
  return null;
}

export function validateChatModelSyntax(
  model: string,
  t?: (key: string) => string,
  knownModels?: Iterable<string>,
): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }
  if (/\s/.test(trimmed)) {
    return t
      ? t('settings.invalidChatModelSyntax')
      : 'Chat model cannot contain whitespace';
  }
  if (DEFAULT_CLAUDE_MODELS.includes(trimmed)) {
    return null;
  }
  if (knownModels && new Set(knownModels).has(trimmed)) {
    return null;
  }
  return null;
}

export function validateReviewChainReviewerSyntax(
  reviewer: string,
  t?: (key: string) => string,
  knownModels?: Iterable<string>,
): string | null {
  const trimmed = reviewer.trim();
  if (!trimmed) {
    return t ? t('settings.emptyChainWarning') : 'Reviewer cannot be empty';
  }
  if (/\s/.test(trimmed)) {
    return t ? t('settings.invalidModelSyntax') : 'Reviewer cannot contain whitespace';
  }
  if (trimmed === 'claude') {
    return null;
  }
  if (knownModels && new Set(knownModels).has(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('codex:')) {
    const codexModel = trimmed.slice('codex:'.length);
    if (!codexModel) {
      return t
        ? t('settings.invalidReviewChainReviewer')
      : 'Reviewer must be claude or have the codex: prefix';
    }
    const modelError = validateReviewerModelSyntax(codexModel, 'codex', t, knownModels);
    if (modelError) {
      return t
        ? t('settings.invalidReviewChainReviewer')
      : 'Reviewer must be claude or have the codex: prefix';
    }
    return null;
  }
  return t
    ? t('settings.invalidReviewChainReviewer')
      : 'Reviewer must be claude or have the codex: prefix';
}

export function validateBranchSyntax(
  branch: string,
  t?: (key: string) => string,
): string | null {
  const trimmed = branch.trim();
  if (!trimmed) {
    return t ? t('projects.nameRequired') : 'Branch name cannot be empty';
  }
  if (
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('//') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    /[~^:?*[\\ ]/.test(trimmed) ||
    trimmed.endsWith('.lock')
  ) {
    return t
      ? t('settings.invalidBranchSyntax')
      : 'Branch name is invalid or contains special characters';
  }
  return null;
}

export function validateReviewerModelSyntax(
  model: string,
  engine?: 'codex' | 'claude' | string,
  t?: (key: string) => string,
  knownModels?: Iterable<string>,
): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return t ? t('settings.emptyChainWarning') : 'Reviewer model cannot be empty';
  }
  if (/\s/.test(trimmed)) {
    return t ? t('settings.invalidModelSyntax') : 'Model cannot contain whitespace';
  }
  if (knownModels) {
    const knownSet = new Set(knownModels);
    const unprefix = trimmed.replace(/^(codex:|claude:)/, '');
    if (
      knownSet.has(trimmed) ||
      knownSet.has(`codex:${trimmed}`) ||
      knownSet.has(`claude:${trimmed}`) ||
      knownSet.has(unprefix) ||
      knownSet.has(`codex:${unprefix}`) ||
      knownSet.has(`claude:${unprefix}`)
    ) {
      return null;
    }
  }
  if (engine === 'claude') {
    const raw = trimmed.startsWith('claude:') ? trimmed.slice('claude:'.length) : trimmed;
    const isValidClaude =
      DEFAULT_CLAUDE_MODELS.includes(raw) ||
      raw.startsWith('claude-');
    if (!isValidClaude) {
      return t
        ? t('settings.invalidChatModelSyntax')
      : 'Claude model must be sonnet, opus, or haiku';
    }
  }
  if (engine === 'codex') {
    const raw = trimmed.startsWith('codex:') ? trimmed.slice('codex:'.length) : trimmed;
    const isValidCodex =
      DEFAULT_CODEX_MODELS.includes(raw) ||
      (raw.startsWith('gpt-') && raw.length > 4);
    if (!isValidCodex) {
      return t
        ? t('settings.invalidModelSyntax')
      : 'Codex model must have the codex: or gpt- prefix';
    }
  }
  return null;
}
