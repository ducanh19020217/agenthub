import type { ReviewChainStep } from './review-chain.js';
import type { AgentHubConfig } from './config.js';
import type { ProjectRow, DepartmentRow } from './db/index.js';
import { projectSettings } from './projects/settings.js';
import { detectProjectPreset } from './presets.js';
import { normalizeReviewerModel } from './reviewer-config.js';
import { HttpError } from './services/index.js';

export type ConfigSource = 'global' | 'department' | 'project';

export interface EffectiveValue<T> {
  value: T;
  source: ConfigSource;
}

export interface EffectiveConfigResponse {
  brain: {
    mode: EffectiveValue<string>;
    permissions: EffectiveValue<string>;
    engine: EffectiveValue<string>;
    model: EffectiveValue<string>;
    budgets: {
      maxTurnsPerHour: EffectiveValue<number>;
      dailyTokenBudget: EffectiveValue<number>;
    };
  };
  review: {
    chain: EffectiveValue<ReviewChainStep[]>;
    maxRounds: EffectiveValue<number>;
    autoMerge: EffectiveValue<boolean>;
    checks: EffectiveValue<Array<{ name: string; cmd: string[]; timeoutSec?: number }>>;
  };
  autoMergeReadiness: {
    ready: boolean;
    missing: string[];
  };
  preset: string;
}

export interface ServiceForEffectiveConfig {
  config: AgentHubConfig;
  projectRepo: { get(id: string): ProjectRow | undefined };
  departmentRepo?: { get(id: string): DepartmentRow | undefined };
}

export function computeEffectiveConfig(service: ServiceForEffectiveConfig, projectId: string): EffectiveConfigResponse {
  const project = service.projectRepo.get(projectId);
  if (!project) {
    throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
  }

  const settings = projectSettings(project);
  const department = project.departmentId ? service.departmentRepo?.get(project.departmentId) : undefined;
  const globalConfig = service.config;

  // 1. Brain Mode
  let mode: EffectiveValue<string>;
  if (settings.brain.mode !== 'inherit') {
    mode = { value: settings.brain.mode, source: 'project' };
  } else if (department?.brainMode && department.brainMode !== 'inherit') {
    mode = { value: department.brainMode, source: 'department' };
  } else {
    mode = { value: globalConfig.brain.mode, source: 'global' };
  }

  // 2. Brain Permissions
  let permissions: EffectiveValue<string>;
  if (settings.brain.permissions !== 'inherit') {
    permissions = { value: settings.brain.permissions, source: 'project' };
  } else if (department?.brainPermissions && department.brainPermissions !== 'inherit') {
    permissions = { value: department.brainPermissions, source: 'department' };
  } else {
    permissions = { value: globalConfig.brain.permissions, source: 'global' };
  }

  // 3. Brain Engine
  let engine: EffectiveValue<string>;
  if (settings.brain.engine !== 'inherit') {
    engine = { value: settings.brain.engine, source: 'project' };
  } else if (department?.brainEngine && department.brainEngine !== 'inherit') {
    engine = { value: department.brainEngine, source: 'department' };
  } else {
    engine = { value: globalConfig.brain.engine || 'claude', source: 'global' };
  }

  // 4. Brain Model
  let model: EffectiveValue<string>;
  if (settings.brain.model) {
    model = { value: settings.brain.model, source: 'project' };
  } else if (department?.brainModel && department.brainModel !== 'inherit') {
    model = { value: department.brainModel, source: 'department' };
  } else {
    const defaultModel = engine.value === 'codex'
      ? (globalConfig.brain.codexModel || 'gpt-5.6-luna')
      : (globalConfig.brain.model || 'sonnet');
    model = { value: defaultModel, source: 'global' };
  }

  // 5. Budgets
  let maxTurnsPerHour: EffectiveValue<number>;
  if (settings.brain.maxTurnsPerHour !== undefined && settings.brain.maxTurnsPerHour > 0) {
    maxTurnsPerHour = { value: settings.brain.maxTurnsPerHour, source: 'project' };
  } else if (department?.brainMaxTurnsPerHour && department.brainMaxTurnsPerHour > 0) {
    maxTurnsPerHour = { value: department.brainMaxTurnsPerHour, source: 'department' };
  } else {
    maxTurnsPerHour = { value: globalConfig.brain.maxTurnsPerHour || 20, source: 'global' };
  }

  let dailyTokenBudget: EffectiveValue<number>;
  if (settings.brain.dailyTokenBudget !== undefined && settings.brain.dailyTokenBudget > 0) {
    dailyTokenBudget = { value: settings.brain.dailyTokenBudget, source: 'project' };
  } else if (department?.brainDailyTokenBudget && department.brainDailyTokenBudget > 0) {
    dailyTokenBudget = { value: department.brainDailyTokenBudget, source: 'department' };
  } else {
    dailyTokenBudget = { value: globalConfig.brain.dailyTokenBudget || 0, source: 'global' };
  }

  // 6. Review Chain
  let chain: ReviewChainStep[] = [];
  let chainSource: ConfigSource = 'global';
  if (project.review) {
    try {
      const parsed = JSON.parse(project.review) as { chain?: ReviewChainStep[] };
      if (Array.isArray(parsed.chain)) {
        chain = parsed.chain;
        chainSource = 'project';
      }
    } catch { /* ignore */ }
  }
  if (chainSource === 'global' && project.reviewChain) {
    try {
      const parsed = JSON.parse(project.reviewChain);
      if (Array.isArray(parsed)) {
        chain = parsed;
        chainSource = 'project';
      }
    } catch { /* ignore */ }
  }
  if (chainSource === 'global' && globalConfig.reviewer?.order && globalConfig.reviewer.order.length > 0) {
    const order = globalConfig.reviewer.order;
    chain = order.map((item, idx) => ({
      reviewer: normalizeReviewerModel(item.engine, item.model),
      mode: idx === order.length - 1 ? 'final' : 'gate',
    }));
  }

  // 7. Review Max Rounds
  let maxRounds = globalConfig.reviewer?.maxChangesRequested || 2;
  let maxRoundsSource: ConfigSource = 'global';
  if (project.review) {
    try {
      const parsed = JSON.parse(project.review) as { maxRounds?: number };
      if (typeof parsed.maxRounds === 'number' && parsed.maxRounds > 0) {
        maxRounds = parsed.maxRounds;
        maxRoundsSource = 'project';
      }
    } catch { /* ignore */ }
  }

  // 8. Auto Merge
  const autoMergeValue = Boolean(settings.review.autoMerge || settings.integration.autoMerge);

  // 9. Checks
  let checks: Array<{ name: string; cmd: string[]; timeoutSec?: number }> = [];
  if (project.checks) {
    try { checks = JSON.parse(project.checks); } catch { checks = []; }
  }

  // 10. AutoMerge Readiness
  const hasAutoMerge = autoMergeValue;
  const hasChecks = checks.length > 0;
  const hasChain = chain.length > 0;
  const lastStepAuto = hasChain && chain[chain.length - 1].reviewer.startsWith('codex:');

  const missing: string[] = [];
  if (!hasAutoMerge) missing.push('Chưa bật auto-merge (settings.review.autoMerge)');
  if (!hasChecks) missing.push('Chưa cấu hình check nào (cần ít nhất một check)');
  if (!hasChain) {
    missing.push('Review chain không được rỗng');
  } else if (!lastStepAuto) {
    missing.push('Review chain phải kết thúc bằng reviewer tự động (Codex)');
  }

  const ready = hasAutoMerge && hasChecks && hasChain && lastStepAuto;

  const preset = detectProjectPreset(project, globalConfig, department);

  return {
    brain: {
      mode,
      permissions,
      engine,
      model,
      budgets: {
        maxTurnsPerHour,
        dailyTokenBudget,
      },
    },
    review: {
      chain: { value: chain, source: chainSource },
      maxRounds: { value: maxRounds, source: maxRoundsSource },
      autoMerge: { value: autoMergeValue, source: 'project' },
      checks: { value: checks, source: 'project' },
    },
    autoMergeReadiness: {
      ready,
      missing,
    },
    preset,
  };
}
