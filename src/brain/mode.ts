import type { BrainConfig } from '../config.js';
import { projectSettings, type ProjectSettings } from '../projects/settings.js';

export type EffectiveBrainMode = 'off' | 'suggest' | 'auto' | 'external';
export type BrainPermission = 'standard' | 'trusted' | 'full';

export function effectiveBrainPermission(
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'permissions'>,
  department?: { brainPermissions?: string } | null,
): BrainPermission {
  const permission = projectSettings(project).brain.permissions;
  if (permission !== 'inherit') return permission;
  if (department?.brainPermissions && department.brainPermissions !== 'inherit') {
    return department.brainPermissions as BrainPermission;
  }
  return global.permissions;
}

/** Resolve a project's brain mode without ever parsing projects.settings at call sites. */
export function effectiveBrainMode(
  projectId: string | null,
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'mode'>,
  department?: { brainMode?: string } | null,
): EffectiveBrainMode {
  if (projectId === null) return global.mode;
  const mode = projectSettings(project).brain.mode;
  if (mode !== 'inherit') return mode;
  if (department?.brainMode && department.brainMode !== 'inherit') {
    return department.brainMode as EffectiveBrainMode;
  }
  return global.mode;
}

export function effectiveBrainModeFromSettings(
  settings: ProjectSettings,
  global: Pick<BrainConfig, 'mode'>,
  department?: { brainMode?: string } | null,
): EffectiveBrainMode {
  if (settings.brain.mode !== 'inherit') return settings.brain.mode;
  if (department?.brainMode && department.brainMode !== 'inherit') {
    return department.brainMode as EffectiveBrainMode;
  }
  return global.mode;
}
