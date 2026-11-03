import type { BrainConfig } from '../config.js';
import { projectSettings } from '../projects/settings.js';

export type BrainEngine = 'claude' | 'codex';

export function effectiveBrainEngine(
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'engine'>,
  department?: { brainEngine?: string } | null,
): BrainEngine {
  const configured = projectSettings(project).brain.engine;
  if (configured !== 'inherit') return configured;
  if (department?.brainEngine && department.brainEngine !== 'inherit') {
    return department.brainEngine as BrainEngine;
  }
  return global.engine || 'claude';
}

export function effectiveBrainCodexProfile(
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'codexProfile'>,
): string | undefined {
  return projectSettings(project).brain.codexProfile || global.codexProfile;
}
