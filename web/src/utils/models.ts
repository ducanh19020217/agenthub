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
  runVerified?: boolean;
  unavailable?: boolean;
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
    filtered = filtered.filter((m) => m.available && !m.unavailable);
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
    if (m.unavailable) {
      const unavailableLabel = t?.('models.unavailableAccountWarning');
      label = `${baseName} (⚠️ ${unavailableLabel && unavailableLabel !== 'models.unavailableAccountWarning'
        ? unavailableLabel
        : t?.('models.unavailableWarning') || 'Not usable with this account'})`;
    } else if (m.profiles && m.profiles.length > 0) {
      const countStr = t
        ? t('models.accountCount', { count: m.profiles.length })
        : `${m.profiles.length} account(s)`;
      label = `${baseName} (${countStr})`;
    } else if (!m.available) {
      label = `${baseName} (⚠️ ${t ? t('models.unavailableWarning') : 'Unavailable'})`;
    }
    if (m.available && m.runVerified === false) {
      const unverifiedLabel = t?.('models.unverifiedRunWarning');
      label = `${label} (⚠️ ${unverifiedLabel && unverifiedLabel !== 'models.unverifiedRunWarning'
        ? unverifiedLabel
        : 'Not verified to run'})`;
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
      runVerified: m.runVerified,
      unavailable: m.unavailable,
    };
  });
}

export function validateModelSyntax(
  model: string,
  t?: (key: string) => string,
): string | null {
  if (!model || /^\s*$/.test(model)) {
    return t ? t('settings.emptyChainWarning') : 'Model cannot be empty';
  }
  if (/\s/.test(model)) {
    return t
      ? t('settings.invalidModelSyntax')
      : 'Model cannot contain whitespace';
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
    const isKnown =
      (knownModels && (new Set(knownModels).has(trimmed) || new Set(knownModels).has(codexModel))) ||
      DEFAULT_CODEX_MODELS.includes(codexModel) ||
      (codexModel.startsWith('gpt-') && codexModel.length > 4);
    if (!isKnown) {
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
  _engine?: 'codex' | 'claude' | string,
  t?: (key: string) => string,
  _knownModels?: Iterable<string>,
): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return t ? t('settings.emptyChainWarning') : 'Reviewer model cannot be empty';
  }
  if (/\s/.test(trimmed)) {
    return t ? t('settings.invalidModelSyntax') : 'Model cannot contain whitespace';
  }
  if (trimmed === 'codex:' || trimmed === 'claude:') {
    return t ? t('settings.invalidModelSyntax') : 'Model cannot be empty';
  }
  return null;
}
