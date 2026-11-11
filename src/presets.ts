import { z } from 'zod';
import type { ReviewChainStep } from './review-chain.js';
import type { AgentHubConfig } from './config.js';
import type { ProjectRow, DepartmentRow } from './db/index.js';
import { projectSettings } from './projects/settings.js';
import { inspectProject } from './projects/inspect.js';
import { HttpError } from './services/index.js';

export type PresetLevel = 'safe' | 'balanced' | 'auto';

export interface PresetDetails {
  id: PresetLevel;
  name: { vi: string; en: string };
  description: { vi: string; en: string };
  config: {
    brain: {
      mode: 'suggest' | 'auto';
      permissions: 'standard' | 'trusted';
    };
    review: {
      chainDescription: { vi: string; en: string };
      maxRounds: number;
      autoMerge: boolean;
    };
    autoFixOnFail: boolean;
    planning: {
      requireApproval: boolean;
      approvalMinTasks: number;
    };
    publish: {
      enabled: boolean;
      audit?: {
        enabled: boolean;
        maxFixRounds: number;
      };
    };
  };
}

export const PRESET_DEFINITIONS: Record<PresetLevel, PresetDetails> = {
  safe: {
    id: 'safe',
    name: {
      vi: 'An toàn',
      en: 'Safe',
    },
    description: {
      vi: 'Bộ não gợi ý, quyền standard, người dùng duyệt mọi task và kế hoạch, không tự động merge.',
      en: 'Suggest mode, standard permissions, manual review of tasks and plans, no auto-merge.',
    },
    config: {
      brain: {
        mode: 'suggest',
        permissions: 'standard',
      },
      review: {
        chainDescription: {
          vi: 'Rỗng (người duyệt)',
          en: 'Empty (manual review)',
        },
        maxRounds: 2,
        autoMerge: false,
      },
      autoFixOnFail: false,
      planning: {
        requireApproval: true,
        approvalMinTasks: 0,
      },
      publish: {
        enabled: true,
        audit: { enabled: true, maxFixRounds: 2 },
      },
    },
  },
  balanced: {
    id: 'balanced',
    name: {
      vi: 'Cân bằng',
      en: 'Balanced',
    },
    description: {
      vi: 'Bộ não tự động, quyền trusted, duyệt 2 bước (Codex gate, Claude final), tự sửa khi check fail, kế hoạch từ 5 task cần duyệt.',
      en: 'Auto mode, trusted permissions, 2-step review (Codex gate, Claude final), auto-fix on failure, approval required for 5+ tasks.',
    },
    config: {
      brain: {
        mode: 'auto',
        permissions: 'trusted',
      },
      review: {
        chainDescription: {
          vi: '[Codex gate, Claude final]',
          en: '[Codex gate, Claude final]',
        },
        maxRounds: 2,
        autoMerge: false,
      },
      autoFixOnFail: true,
      planning: {
        requireApproval: false,
        approvalMinTasks: 5,
      },
      publish: {
        enabled: true,
        audit: { enabled: true, maxFixRounds: 2 },
      },
    },
  },
  auto: {
    id: 'auto',
    name: {
      vi: 'Tự động hoá',
      en: 'Automated',
    },
    description: {
      vi: 'Tự động hoá tối đa: Codex review và tự merge khi check pass, tự sửa lỗi, không cần duyệt kế hoạch. Yêu cầu ít nhất một check.',
      en: 'Maximum automation: Codex review and auto-merge on pass, auto-fix, no plan approval. Requires at least one check.',
    },
    config: {
      brain: {
        mode: 'auto',
        permissions: 'trusted',
      },
      review: {
        chainDescription: {
          vi: '[Codex final], tối đa 3 vòng',
          en: '[Codex final], max 3 rounds',
        },
        maxRounds: 3,
        autoMerge: true,
      },
      autoFixOnFail: true,
      planning: {
        requireApproval: false,
        approvalMinTasks: 0,
      },
      publish: {
        enabled: true,
        audit: { enabled: true, maxFixRounds: 2 },
      },
    },
  },
};

export function getPresetChain(preset: PresetLevel, codexModel = 'gpt-5.6-luna'): ReviewChainStep[] {
  const model = codexModel.startsWith('codex:') ? codexModel : `codex:${codexModel}`;
  switch (preset) {
    case 'safe':
      return [];
    case 'balanced':
      return [
        { reviewer: model, mode: 'gate' },
        { reviewer: 'claude', mode: 'final' },
      ];
    case 'auto':
      return [
        { reviewer: model, mode: 'final' },
      ];
  }
}

export function detectPresetMatch(
  config: {
    brainMode?: string;
    brainPermissions?: string;
    reviewChain?: ReviewChainStep[];
    autoMerge?: boolean;
    autoFixOnFail?: boolean;
    planning?: { requireApproval?: boolean; approvalMinTasks?: number };
    publish?: { enabled?: boolean } | boolean;
  },
  preset: PresetLevel,
): boolean {
  const def = PRESET_DEFINITIONS[preset];
  if (config.brainMode !== def.config.brain.mode) return false;
  if (config.brainPermissions !== def.config.brain.permissions) return false;
  if (Boolean(config.autoMerge) !== def.config.review.autoMerge) return false;
  if (Boolean(config.autoFixOnFail) !== def.config.autoFixOnFail) return false;

  const reqApproval = Boolean(config.planning?.requireApproval);
  const approvalMin = config.planning?.approvalMinTasks ?? 0;
  if (reqApproval !== def.config.planning.requireApproval) return false;
  if (approvalMin !== def.config.planning.approvalMinTasks) return false;

  if (config.publish !== undefined) {
    const pubEnabled = typeof config.publish === 'boolean' ? config.publish : Boolean(config.publish?.enabled);
    if (pubEnabled !== def.config.publish.enabled) return false;
  }

  const chain = config.reviewChain || [];
  if (preset === 'safe') {
    if (chain.length !== 0) return false;
  } else if (preset === 'balanced') {
    if (chain.length !== 2) return false;
    if (!chain[0].reviewer.startsWith('codex:') || chain[0].mode !== 'gate') return false;
    if (chain[1].reviewer !== 'claude' || chain[1].mode !== 'final') return false;
  } else if (preset === 'auto') {
    if (chain.length !== 1) return false;
    if (!chain[0].reviewer.startsWith('codex:') || chain[0].mode !== 'final') return false;
  }
  return true;
}

export type GlobalPresetField =
  | 'brain.mode'
  | 'brain.permissions'
  | 'autoFixOnFail'
  | 'planning.requireApproval'
  | 'planning.approvalMinTasks'
  | 'reviewer.maxChangesRequested'
  | 'reviewer.order';

export interface GlobalPresetStatus {
  /** Preset the global config matches exactly, or 'custom'. */
  preset: PresetLevel | 'custom';
  /**
   * Preset the config was derived from: the last one applied globally if
   * known, else the closest one. Equals `preset` when not custom.
   */
  basePreset: PresetLevel;
  /** True when `basePreset` is the last preset applied, not just a best guess. */
  baseFromHistory: boolean;
  /** Fields where the config diverges from `basePreset` (empty when not custom). */
  mismatches: GlobalPresetField[];
}

/**
 * Fields of the global config that differ from a preset. Mirrors what
 * applyPreset(scope=global) writes; reviewer models are not compared so a
 * different Codex/Claude model still counts as the same preset.
 */
export function globalPresetMismatches(config: AgentHubConfig, level: PresetLevel): GlobalPresetField[] {
  const engines = (config.reviewer?.order || []).map((item) => item.engine);
  const expectedEngines: Record<PresetLevel, string[]> = {
    safe: [],
    balanced: ['codex', 'claude'],
    auto: ['codex'],
  };
  const def = PRESET_DEFINITIONS[level].config;
  const mismatches: GlobalPresetField[] = [];
  if (config.brain.mode !== def.brain.mode) mismatches.push('brain.mode');
  if (config.brain.permissions !== def.brain.permissions) mismatches.push('brain.permissions');
  if (Boolean(config.autoFixOnFail) !== def.autoFixOnFail) mismatches.push('autoFixOnFail');
  if (Boolean(config.planning?.requireApproval) !== def.planning.requireApproval) mismatches.push('planning.requireApproval');
  if ((config.planning?.approvalMinTasks ?? 0) !== def.planning.approvalMinTasks) mismatches.push('planning.approvalMinTasks');
  if ((config.reviewer?.maxChangesRequested ?? 2) !== def.review.maxRounds) mismatches.push('reviewer.maxChangesRequested');
  if (engines.join(',') !== expectedEngines[level].join(',')) mismatches.push('reviewer.order');
  return mismatches;
}

/**
 * Which preset the global config currently matches, or 'custom'.
 */
export function detectGlobalPreset(config: AgentHubConfig): PresetLevel | 'custom' {
  for (const level of ['safe', 'balanced', 'auto'] as const) {
    if (globalPresetMismatches(config, level).length === 0) return level;
  }
  return 'custom';
}

/**
 * Current preset plus, when the config was hand-edited, which preset it came
 * from and which fields were changed, so the UI can show "custom (based on
 * balanced, differs in autoFixOnFail)" instead of a bare "custom".
 */
export function describeGlobalPreset(config: AgentHubConfig): GlobalPresetStatus {
  const preset = detectGlobalPreset(config);
  if (preset !== 'custom') {
    return { preset, basePreset: preset, baseFromHistory: true, mismatches: [] };
  }
  const lastApplied = config.defaultProjectPreset;
  if (lastApplied) {
    return {
      preset,
      basePreset: lastApplied,
      baseFromHistory: true,
      mismatches: globalPresetMismatches(config, lastApplied),
    };
  }
  let best: { level: PresetLevel; mismatches: GlobalPresetField[] } | null = null;
  for (const level of ['safe', 'balanced', 'auto'] as const) {
    const mismatches = globalPresetMismatches(config, level);
    if (!best || mismatches.length < best.mismatches.length) best = { level, mismatches };
  }
  return { preset, basePreset: best!.level, baseFromHistory: false, mismatches: best!.mismatches };
}

export function detectProjectPreset(
  project: ProjectRow,
  globalConfig: AgentHubConfig,
  department?: DepartmentRow,
): PresetLevel | 'custom' {
  const settings = projectSettings(project);
  let chain: ReviewChainStep[] = [];
  if (project.review) {
    try { chain = (JSON.parse(project.review) as { chain?: ReviewChainStep[] }).chain || []; } catch { /* ignore */ }
  } else if (project.reviewChain) {
    try { chain = JSON.parse(project.reviewChain); } catch { /* ignore */ }
  }

  const effectiveConfig = {
    brainMode: settings.brain.mode !== 'inherit'
      ? settings.brain.mode
      : (department?.brainMode && department.brainMode !== 'inherit' ? department.brainMode : globalConfig.brain.mode),
    brainPermissions: settings.brain.permissions !== 'inherit'
      ? settings.brain.permissions
      : (department?.brainPermissions && department.brainPermissions !== 'inherit' ? department.brainPermissions : globalConfig.brain.permissions),
    reviewChain: chain,
    autoMerge: settings.review.autoMerge || settings.integration.autoMerge,
    autoFixOnFail: settings.autoFixOnFail ?? globalConfig.autoFixOnFail,
    planning: settings.planning ?? globalConfig.planning,
    publish: settings.publish.enabled,
  };

  if (settings.preset && (settings.preset === 'safe' || settings.preset === 'balanced' || settings.preset === 'auto')) {
    if (detectPresetMatch(effectiveConfig, settings.preset)) {
      return settings.preset;
    }
    return 'custom';
  }

  for (const level of ['safe', 'balanced', 'auto'] as const) {
    if (detectPresetMatch(effectiveConfig, level)) {
      return level;
    }
  }
  return 'custom';
}

export const ApplyPresetInputSchema = z.object({
  scope: z.string().min(1).regex(/^(global|department:[a-zA-Z0-9_-]+|project:[a-zA-Z0-9_-]+)$/, {
    message: 'scope phải là "global", "department:<id>", hoặc "project:<id>"',
  }),
  preset: z.enum(['safe', 'balanced', 'auto']),
  dryRun: z.boolean().optional().default(false),
});

export type ApplyPresetInput = z.infer<typeof ApplyPresetInputSchema>;

export interface ApplyPresetResult {
  preset: PresetLevel;
  scope: string;
  applied: boolean;
  diff: {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  warnings?: string[];
  suggestedChecks?: Array<{ name: string; cmd: string[]; reason?: string }>;
}

export interface ServiceForPresets {
  config: AgentHubConfig;
  updateConfig(patch: unknown): unknown;
  getDepartment(id: string): DepartmentRow | undefined;
  updateDepartment(id: string, raw: unknown): unknown;
  getProject(id: string): ProjectRow;
  updateProject(id: string, raw: unknown): unknown;
  departmentRepo?: { get(id: string): DepartmentRow | undefined };
  projectRepo: { get(id: string): ProjectRow | undefined; getAll?: () => ProjectRow[] };
}

/** True when an approved task of this project has somewhere to be merged. */
export function projectHasMergeTarget(project: ProjectRow): boolean {
  if (projectSettings(project).integration.enabled) return true;
  if (!project.merge) return false;
  try {
    const merge = JSON.parse(project.merge) as { enabled?: boolean; worktrees?: Record<string, unknown> };
    return merge.enabled === true && typeof merge.worktrees?.[project.defaultBranch] === 'string';
  } catch {
    return false;
  }
}

/**
 * Patch that puts one project on a preset without touching its brain overrides (used for global,
 * department and new projects). A preset that auto-merges also turns on the integration branch when
 * the project has no merge target, otherwise every auto-merge would fail for want of a target.
 */
export function presetProjectPatch(project: ProjectRow, preset: PresetLevel, codexModel: string) {
  const def = PRESET_DEFINITIONS[preset];
  const cleanCodexModel = codexModel.startsWith('codex:') ? codexModel.slice('codex:'.length) : codexModel;
  const chain = getPresetChain(preset, cleanCodexModel);
  const enableIntegration = def.config.review.autoMerge && !projectHasMergeTarget(project);
  const current = projectSettings(project).integration;
  return {
    settings: {
      preset,
      autoFixOnFail: def.config.autoFixOnFail,
      planning: def.config.planning,
      review: { autoMerge: def.config.review.autoMerge },
      integration: enableIntegration
        ? { enabled: true, branch: current.branch || 'agenthub/integration', autoMerge: true }
        : { autoMerge: def.config.review.autoMerge },
      publish: {
        enabled: def.config.publish.enabled,
        audit: def.config.publish.audit || { enabled: true, maxFixRounds: 2 },
      },
    },
    review: { chain, maxRounds: def.config.review.maxRounds },
    reviewChain: chain,
  };
}

export function applyPreset(service: ServiceForPresets, input: ApplyPresetInput): ApplyPresetResult {
  const { scope, preset, dryRun } = input;
  const def = PRESET_DEFINITIONS[preset];
  const codexModel = service.config.brain.codexModel || 'gpt-5.6-luna';
  const cleanCodexModel = codexModel.startsWith('codex:') ? codexModel.slice('codex:'.length) : codexModel;
  const chain = getPresetChain(preset, cleanCodexModel);

  if (scope === 'global') {
    const currentReviewer = service.config.reviewer;
    const before: Record<string, unknown> = {
      'brain.mode': service.config.brain.mode,
      'brain.permissions': service.config.brain.permissions,
      'review.autoMerge': service.config.reviewer.order.length > 0,
      'autoFixOnFail': service.config.autoFixOnFail,
      'planning': { ...service.config.planning },
      'reviewer.maxChangesRequested': currentReviewer?.maxChangesRequested ?? 2,
      'reviewer.order': currentReviewer?.order ? [...currentReviewer.order] : [],
    };

    const order = preset === 'safe'
      ? []
      : (preset === 'balanced'
        ? [
            { engine: 'codex' as const, model: cleanCodexModel, profiles: [] },
            { engine: 'claude' as const, model: 'sonnet', profiles: [] },
          ]
        : [{ engine: 'codex' as const, model: cleanCodexModel, profiles: [] }]);

    const after: Record<string, unknown> = {
      'brain.mode': def.config.brain.mode,
      'brain.permissions': def.config.brain.permissions,
      'review.autoMerge': def.config.review.autoMerge,
      'autoFixOnFail': def.config.autoFixOnFail,
      'planning': { ...def.config.planning },
      'reviewer.maxChangesRequested': def.config.review.maxRounds,
      'reviewer.order': order,
    };

    if (!dryRun) {
      service.updateConfig({
        brain: {
          mode: def.config.brain.mode,
          permissions: def.config.brain.permissions,
        },
        autoFixOnFail: def.config.autoFixOnFail,
        planning: def.config.planning,
        reviewer: {
          maxChangesRequested: def.config.review.maxRounds,
          order,
        },
        // Projects registered later start on the same preset.
        defaultProjectPreset: preset,
      });
      for (const project of service.projectRepo.getAll?.() || []) {
        service.updateProject(project.id, presetProjectPatch(project, preset, codexModel));
      }
    }

    return {
      preset,
      scope,
      applied: !dryRun,
      diff: { before, after },
    };
  }

  if (scope.startsWith('department:')) {
    const departmentId = scope.slice('department:'.length);
    const department = service.departmentRepo?.get(departmentId);
    if (!department) {
      throw new HttpError(404, 'not_found', `Phòng ban "${departmentId}" không tồn tại`);
    }

    const before: Record<string, unknown> = {
      brainMode: department.brainMode || 'inherit',
      brainPermissions: department.brainPermissions || 'inherit',
      review: 'các project thuộc phòng ban',
    };

    const after: Record<string, unknown> = {
      brainMode: def.config.brain.mode,
      brainPermissions: def.config.brain.permissions,
      review: { chain, maxRounds: def.config.review.maxRounds, autoMerge: def.config.review.autoMerge },
    };

    if (!dryRun) {
      service.updateDepartment(departmentId, {
        brainMode: after.brainMode,
        brainPermissions: after.brainPermissions,
      });
      for (const project of service.projectRepo.getAll?.().filter((item) => item.departmentId === departmentId) || []) {
        service.updateProject(project.id, presetProjectPatch(project, preset, codexModel));
      }
    }

    return {
      preset,
      scope,
      applied: !dryRun,
      diff: { before, after },
    };
  }

  if (scope.startsWith('project:')) {
    const projectId = scope.slice('project:'.length);
    const project = service.projectRepo.get(projectId);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    }

    const settings = projectSettings(project);
    let currentReview: { chain: ReviewChainStep[]; maxRounds?: number } = { chain: [], maxRounds: 2 };
    if (project.review) {
      try { currentReview = JSON.parse(project.review); } catch { /* ignore */ }
    } else if (project.reviewChain) {
      try { currentReview = { chain: JSON.parse(project.reviewChain), maxRounds: 2 }; } catch { /* ignore */ }
    }

    const before: Record<string, unknown> = {
      'settings.brain.mode': settings.brain.mode,
      'settings.brain.permissions': settings.brain.permissions,
      'settings.review.autoMerge': settings.review.autoMerge,
      'settings.integration.autoMerge': settings.integration.autoMerge,
      'settings.autoFixOnFail': settings.autoFixOnFail,
      'settings.planning': settings.planning,
      'settings.publish.enabled': settings.publish.enabled,
      'settings.preset': settings.preset,
      'review.chain': currentReview.chain,
      'review.maxRounds': currentReview.maxRounds ?? 2,
    };

    const after: Record<string, unknown> = {
      'settings.brain.mode': def.config.brain.mode,
      'settings.brain.permissions': def.config.brain.permissions,
      'settings.review.autoMerge': def.config.review.autoMerge,
      'settings.integration.autoMerge': def.config.review.autoMerge,
      'settings.autoFixOnFail': def.config.autoFixOnFail,
      'settings.planning': def.config.planning,
      'settings.publish.enabled': def.config.publish.enabled,
      'settings.preset': preset,
      'review.chain': chain,
      'review.maxRounds': def.config.review.maxRounds,
    };

    let warnings: string[] | undefined;
    let suggestedChecks: Array<{ name: string; cmd: string[]; reason?: string }> | undefined;

    let checks: Array<{ name: string; cmd: string[]; timeoutSec?: number }> = [];
    if (project.checks) {
      try { checks = JSON.parse(project.checks); } catch { checks = []; }
    }

    if (preset === 'auto' && checks.length === 0) {
      warnings = ['Project chưa có check nào. Auto-merge yêu cầu ít nhất một check để đảm bảo an toàn.'];
      try {
        const inspection = inspectProject(project.path);
        suggestedChecks = inspection.suggestedSettings.checks;
      } catch {
        suggestedChecks = [
          { name: 'lint', cmd: ['npm', 'run', 'lint'], reason: 'Gợi ý mặc định' },
          { name: 'typecheck', cmd: ['npm', 'run', 'typecheck'], reason: 'Gợi ý mặc định' },
          { name: 'test', cmd: ['npm', 'test'], reason: 'Gợi ý mặc định' },
        ];
      }
    }

    if (!dryRun) {
      service.updateProject(projectId, {
        settings: {
          preset,
          autoFixOnFail: def.config.autoFixOnFail,
          planning: def.config.planning,
          brain: {
            mode: def.config.brain.mode,
            permissions: def.config.brain.permissions,
          },
          review: {
            autoMerge: def.config.review.autoMerge,
          },
          integration: presetProjectPatch(project, preset, codexModel).settings.integration,
          publish: {
            enabled: def.config.publish.enabled,
            audit: def.config.publish.audit || { enabled: true, maxFixRounds: 2 },
          },
        },
        review: {
          chain,
          maxRounds: def.config.review.maxRounds,
        },
        reviewChain: chain,
      });
    }

    return {
      preset,
      scope,
      applied: !dryRun,
      diff: { before, after },
      warnings,
      suggestedChecks,
    };
  }

  throw new HttpError(400, 'bad_request', `Scope "${scope}" không hợp lệ`);
}
