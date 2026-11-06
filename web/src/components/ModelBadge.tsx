import React from 'react';
import { AgentIcon } from './AgentIcon';

export interface ModelBadgeProps {
  model?: string | null;
  engine?: string | null;
  profileName?: string | null;
  className?: string;
  showIcon?: boolean;
}

export function formatModelName(model?: string | null, engine?: string | null): string {
  if (!model && !engine) return '';
  if (!model && engine) {
    const norm = engine.toLowerCase();
    if (norm === 'agy' || norm === 'gemini') return 'Gemini';
    if (norm === 'codex') return 'Codex';
    if (norm === 'claude') return 'Claude';
    return engine;
  }

  const m = model!;
  if (m === 'gemini-3.8-flash-high') return 'Gemini Flash · high';
  if (m === 'gemini-3.8-flash-medium') return 'Gemini Flash · medium';
  if (m === 'gemini-3.8-flash-low') return 'Gemini Flash · low';
  if (m === 'codex:gpt-5.6-luna' || m === 'gpt-5.6-luna') return 'Codex Luna';
  if (m === 'claude') return 'Claude';
  if (m === 'codex') return 'Codex';
  if (m === 'gemini' || m === 'agy') return 'Gemini';

  // General regex for other gemini flash variants if present
  const flashMatch = m.match(/^gemini(?:-\d+\.\d+)?-flash-(high|medium|low)$/);
  if (flashMatch) {
    return `Gemini Flash · ${flashMatch[1]}`;
  }

  return m;
}

export function getModelEngineKey(model?: string | null, engine?: string | null): 'gemini' | 'codex' | 'claude' | 'other' {
  const normEngine = (engine || '').toLowerCase();
  const normModel = (model || '').toLowerCase();

  if (normEngine === 'codex' || normEngine === 'openai' || normModel.startsWith('codex') || normModel.startsWith('gpt')) {
    return 'codex';
  }
  if (
    normModel.startsWith('gemini') ||
    ((normEngine === 'agy' || normEngine === 'gemini' || normEngine === 'antigravity') &&
      !normModel.startsWith('claude') &&
      !normModel.startsWith('gpt'))
  ) {
    return 'gemini';
  }
  if (normModel.startsWith('claude') || normEngine === 'claude' || normEngine === 'anthropic') {
    return 'claude';
  }
  return 'other';
}

export function getEngineLabel(model?: string | null, engine?: string | null): string {
  const key = getModelEngineKey(model, engine);
  if (key === 'gemini') return 'Gemini';
  if (key === 'codex') return 'Codex';
  if (key === 'claude') return 'Claude';
  if (engine) return engine;
  return '';
}

export function getBadgeTitle(model?: string | null, engine?: string | null, profileName?: string | null): string {
  const engineLabel = getEngineLabel(model, engine);
  const cleanProfile = profileName?.trim() || null;
  const cleanModel = model?.trim() || null;

  const parts = [engineLabel, cleanProfile, cleanModel].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(' / ');
  }
  return cleanModel || engine || '';
}

export const ModelBadge: React.FC<ModelBadgeProps> = ({
  model,
  engine,
  profileName,
  className = '',
  showIcon = true,
}) => {
  const displayText = formatModelName(model, engine);
  if (!displayText) return null;

  const engineKey = getModelEngineKey(model, engine);
  const fullTitle = getBadgeTitle(model, engine, profileName);
  const cleanProfile = profileName?.trim() || null;

  const badgeClass =
    engineKey === 'gemini'
      ? 'badge-model-gemini'
      : engineKey === 'codex'
      ? 'badge-model-codex'
      : engineKey === 'claude'
      ? 'badge-model-claude'
      : 'badge-model-other';

  return (
    <span
      data-testid="model-badge"
      title={fullTitle}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono whitespace-nowrap select-none font-medium ${badgeClass} ${className}`}
    >
      {showIcon && <AgentIcon provider={engineKey} className="w-3.5 h-3.5 shrink-0 inline-block" />}
      {cleanProfile && (
        <>
          <span className="font-semibold text-[var(--t-text-1)]" data-testid="model-badge-profile">
            {cleanProfile}
          </span>
          <span className="opacity-50">·</span>
        </>
      )}
      <span data-testid="model-badge-name">{displayText}</span>
    </span>
  );
};

export const AgentModelBadge = ModelBadge;
export type AgentModelBadgeProps = ModelBadgeProps;
