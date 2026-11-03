import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import { DEFAULT_LOAD_CONFIG, LoadConfig } from './load.js';
import type { ExtraDiskPath } from './disk.js';
import { normalizeFallbackSteps, ClaudeFallbackStep } from './chat/failover.js';
import { BrandingConfig, parseBranding } from './branding.js';
import { DEFAULT_REVIEWER_ARBITER, reviewerSettingsFromLegacy, type ReviewerArbiter, type ReviewerFallback, type ReviewerOrderItem } from './reviewer-config.js';

export interface ChatConfig {
  claudeBin?: string;
  disableToolSearch: boolean;
  allowFullMode: boolean;
  maxConcurrent: number;
  idleTimeoutSec: number;
  model: string;
  models: string[];
  permissionTimeoutSec: number;
  claudeProfile?: string;
  claudeProfileExplicit?: boolean;
  autoCompactPercent: number;
}

export interface BrainDigestConfig {
  enabled: boolean;
  time: string;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}

export interface NotificationsConfig {
  desktop: boolean;
  desktopLevel: 'all' | 'important' | 'critical' | 'off';
  quietHours?: QuietHoursConfig;
}

export const DEFAULT_QUIET_HOURS_CONFIG: QuietHoursConfig = {
  enabled: false,
  start: '22:00',
  end: '07:00',
};

export const DEFAULT_BRAIN_DIGEST_CONFIG: BrainDigestConfig = {
  enabled: true,
  time: '18:00',
};

export interface BrainConfig {
  engine?: 'claude' | 'codex';
  fallback: ClaudeFallbackStep[];
  policy: string[];
  claudeProfile: string;
  claudeProfileExplicit?: boolean;
  model: string;
  codexProfile?: string;
  codexModel?: string;
  mode: 'off' | 'suggest' | 'auto';
  permissions: 'standard' | 'trusted' | 'full';
  maxConcurrent: number;
  maxTurnsPerHour: number;
  dailyTokenBudget: number;
  turnTimeoutSec?: number;
  digest: BrainDigestConfig;
  /** Optional cross-department coordinator. Disabled unless explicitly enabled. */
  director?: {
    enabled: boolean;
    engine: 'claude' | 'codex';
    model: string;
    codexProfile?: string;
    permissions: 'standard' | 'trusted' | 'full';
  };
}

export interface AssistantConfig {
  enabled: boolean;
  model: string;
  policy: string[];
  /** guarded: read-only helper (default); full: may edit files and run any command, like a full brain. */
  permissions: 'guarded' | 'full';
}

export interface ClaudeSessionsConfig {
  dir: string;
  maxAgeDays: number;
  activeWithinMin: number;
  include: string[];
  weights: { cacheCreation: number; cacheRead: number };
  autoResume: { enabled: boolean; prompt: string; allowFullMode: boolean };
}

export interface SavingsConfig {
  bucketTokens: {
    gemini: number;
    claude: number;
  };
  claudeFactor: number;
  claudeOverheadPerTask: number;
}

export const DEFAULT_SAVINGS_CONFIG: SavingsConfig = {
  bucketTokens: {
    gemini: 5_000_000,
    claude: 5_000_000,
  },
  claudeFactor: 0.9,
  claudeOverheadPerTask: 40_000,
};

export interface SchedulerLimitsConfig {
  maxRunsPerTask: number;
  maxConsecutiveCrashesPerTask: number;
  maxPausedMin?: number;
}

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimitsConfig = {
  maxRunsPerTask: 15,
  maxConsecutiveCrashesPerTask: 3,
  maxPausedMin: 30,
};

export interface ProfileCoolingConfig {
  /** Number of consecutive crashes across all tasks before cooling activates. */
  threshold: number;
  /** Time window in minutes to count consecutive crashes. */
  windowMin: number;
  /** Duration of cooling period in minutes. */
  coolingMin: number;
}

export type SchedulerConfig = SchedulerLimitsConfig;

export const DEFAULT_PROFILE_COOLING: ProfileCoolingConfig = {
  threshold: 3,
  windowMin: 30,
  coolingMin: 30,
};

export interface StallConfig {
  noCommitMin: number;
  loopThreshold: number;
}

export interface TelegramNotifyConfig {
  reviewReady: boolean;
  failed: boolean;
  blocked: boolean;
  quotaAllExhausted: boolean;
  fallback: boolean;
  brainWaiting?: boolean;
}

export interface TelegramChat {
  id: number;
  name: string;
  username?: string;
  /** Optional: associate this chat entry with a project for /use routing. */
  kind?: 'chat' | 'group' | 'supergroup' | 'channel';
  projectId?: string;
}

export interface TelegramProjectTopic {
  chatId: number;
  threadId: number;
}

export type TelegramDepartmentTopic = TelegramProjectTopic;

export interface TelegramConfig {
  enabled: boolean;
  botTokenFile: string;
  allowedChatIds: number[];
  chats: TelegramChat[];
  topicMode?: 'project' | 'department';
  projectTopics: Record<string, TelegramProjectTopic>;
  departmentTopics?: Record<string, TelegramProjectTopic>;
  notify: TelegramNotifyConfig;
}

export interface DeployPushConfig {
  remote: string;
  from: string;
  to: string;
  ffOnly: boolean;
  minIntervalMin?: number;
}

export interface DeployProjectConfig {
  steps: string[][];
  timeoutSec: number;
  restartHub: boolean;
  restartMaxWaitMin?: number;
  push?: DeployPushConfig;
}

export interface ChecksConfig {
  maxConcurrent: number;
}

export const DEFAULT_TELEGRAM_NOTIFY: TelegramNotifyConfig = {
  reviewReady: true,
  failed: true,
  blocked: true,
  quotaAllExhausted: true,
  fallback: true,
  brainWaiting: true,
};

export const DEFAULT_STALL_CONFIG: StallConfig = {
  noCommitMin: 45,
  loopThreshold: 6,
};

export interface ContextConfig {
  overlapCheckSec: number;
  depsMaxChars: number;
  knowledgeMaxChars: number;
  knowledgeFile?: string;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  overlapCheckSec: 60,
  depsMaxChars: 16000,
  knowledgeMaxChars: 12000,
};

export interface PlanningConfig {
  /** Every task Claude creates starts as a draft that the user must dispatch. */
  requireApproval: boolean;
  /** Plans with at least this many tasks become a draft batch for the user to approve; 0 = never. */
  approvalMinTasks: number;
}

export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  requireApproval: false,
  approvalMinTasks: 0,
};

export type DeepPartialSavingsConfig = {
  bucketTokens?: Partial<SavingsConfig['bucketTokens']>;
  claudeFactor?: number;
  claudeOverheadPerTask?: number;
};

export interface UpdatesConfig {
  check: boolean;
  repo?: string;
}

export interface ToolInstaller {
  package?: string;
  command?: string[];
  versionArgs?: string[];
  docsUrl?: string;
}

export interface ToolsConfig {
  installers: {
    claude: ToolInstaller;
    codex: ToolInstaller;
    agy: ToolInstaller;
  };
}

export type ToolInstallerPatch = Pick<ToolInstaller, 'package' | 'versionArgs' | 'docsUrl'>;

export const DEFAULT_UPDATES_CONFIG: UpdatesConfig = {
  check: true,
  repo: 'ducanh19020217/agenthub',
};

export interface WorkersConfig {
  codexSandbox: 'off' | 'workspace-write';
}

export interface UiConfig {
  tours: Record<string, boolean>;
}

export const DEFAULT_WORKERS_CONFIG: WorkersConfig = {
  codexSandbox: 'off',
};

// --- OpenProject source configuration ---

export const DailyReportConfigSchema = z.object({
  enabled: z.boolean().default(false),
  time: z.string().default('08:00'),
  weekdaysOnly: z.boolean().default(true),
  dir: z.string().min(1).optional(),
  maxItems: z.number().int().positive().default(10),
  telegram: z.boolean().default(false),
});

export type DailyReportConfig = z.infer<typeof DailyReportConfigSchema>;

export const OpenProjectSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  url: z.string().url(),
  project: z.string().min(1),
  pollIntervalSec: z.number().int().positive().default(120),
  watchStatusIds: z.array(z.number().int()).default([]),
  reopenedStatusIds: z.array(z.number().int()).default([]),
  resolvedStatusId: z.number().int().nullable().default(null),
  reviewStatusId: z.number().int().nullable().default(null),
  openStatusIds: z.array(z.number().int()).default([]),
  minTicketNumber: z.number().int().min(0).default(0),
  autoStart: z.boolean().default(true),
  autoResolve: z.boolean().default(true),
  language: z.string().default('vi'),
  dailyReport: DailyReportConfigSchema.optional(),
});

export type OpenProjectSource = z.infer<typeof OpenProjectSourceSchema>;

export const OpenProjectIntegrationSchema = z.object({
  sources: z.array(OpenProjectSourceSchema).default([]),
});

export interface IntegrationsConfig {
  openproject: {
    sources: OpenProjectSource[];
  };
}

export const DEFAULT_INTEGRATIONS_CONFIG: IntegrationsConfig = {
  openproject: { sources: [] },
};

export function parseOpenProjectSources(raw: unknown): OpenProjectSource[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const opRaw = obj.openproject;
  if (!opRaw || typeof opRaw !== 'object') return [];
  const result = OpenProjectIntegrationSchema.safeParse(opRaw);
  return result.success ? result.data.sources : [];
}

export interface AgentHubConfig {
  hubHome: string;
  agyHomesDir: string;
  dbPath: string;
  logsDir: string;
  worktreesDir: string;
  tokenPath: string;
  configFilePath: string;
  port: number;
  host: string;
  allowedHosts: string[];
  defaultModelChains: {
    hard: string[];
    easy: string[];
  };
  defaultTimeout: number;
  focus: {
    projectId: string | null;
    since: string | null;
    pauseRunning: boolean;
  };
  multiplePerProvider: boolean;
  multiplePerProviderConfigured: boolean;
  slotsPerAgyProfile: number;
  slotsPerCodexProfile: number;
  watchdog: {
    stallMinutes: number;
    waitingMinutes: number;
  };
  defaultLogDir: string;
  autoFixOnFail: boolean;
  chat: ChatConfig;
  brain: BrainConfig;
  assistant: AssistantConfig;
  claudeSessions: ClaudeSessionsConfig;
  reviewer: {
    enabled: boolean;
    timeoutSec: number;
    failoverSec: number;
    maxChangesRequested: number;
    claudeProfiles: string[];
    order: ReviewerOrderItem[];
    fallback: ReviewerFallback;
    arbiter: ReviewerArbiter;
  };
  notifications: NotificationsConfig;
  disk: {
    minFreeGB: number;
    extraPaths: ExtraDiskPath[];
  };
  cleanup: {
    nodeModulesOnDone: boolean;
    worktreeOnDoneAfterHours: number;
  };
  cacheDir: string;
  cacheMaxEntries: number;
  cacheMaxGB: number;
  savings: SavingsConfig;
  load: LoadConfig;
  stall: StallConfig;
  context: ContextConfig;
  planning: PlanningConfig;
  telegram: TelegramConfig;
  updates: UpdatesConfig;
  tools: ToolsConfig;
  workers: WorkersConfig;
  ui: UiConfig;
  checks: ChecksConfig;
  branding: BrandingConfig;
  deploy: Record<string, DeployProjectConfig>;
  integrations: IntegrationsConfig;
  scheduler: SchedulerConfig;
  schedulerLimits: SchedulerLimitsConfig;
  profileCooling: ProfileCoolingConfig;
}

type ReviewerConfigPatch = Partial<Omit<AgentHubConfig['reviewer'], 'fallback' | 'arbiter'>> & {
  fallback?: Partial<ReviewerFallback>;
  arbiter?: Partial<ReviewerArbiter>;
};

const DEFAULT_MODEL_CHAINS = {
  hard: ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high'],
  easy: ['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna'],
};

export function saveConfig(
  hubHome: string,
  patch: Partial<{
    modelChainHard: string[];
    modelChainEasy: string[];
    defaultTimeout: number;
    focus?: Partial<AgentHubConfig['focus']>;
    multiplePerProvider?: boolean;
    slotsPerAgyProfile: number;
    slotsPerCodexProfile: number;
    watchdog: { stallMinutes?: number; waitingMinutes?: number };
    port: number;
    autoFixOnFail?: boolean;
    chat: Partial<ChatConfig>;
    brain?: Partial<Omit<BrainConfig, 'digest' | 'director'>> & {
      digest?: Partial<BrainDigestConfig>;
      director?: Partial<BrainConfig['director']>;
    };
    assistant?: Partial<AssistantConfig>;
    reviewer: ReviewerConfigPatch;
    notifications?: Partial<{
      desktop: boolean;
      desktopLevel: NotificationsConfig['desktopLevel'];
      quietHours?: Partial<QuietHoursConfig>;
    }>;
    disk?: { minFreeGB?: number; extraPaths?: ExtraDiskPath[] };
    cleanup?: { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number };
    cacheDir?: string;
    cacheMaxEntries?: number;
    cacheMaxGB?: number;
    savings: DeepPartialSavingsConfig;
    load?: Partial<LoadConfig>;
    stall?: Partial<StallConfig>;
    context?: Partial<ContextConfig>;
    planning?: Partial<PlanningConfig>;
    updates?: Partial<UpdatesConfig>;
    tools?: Partial<{ installers: Partial<Record<'claude' | 'codex' | 'agy', ToolInstallerPatch>> }>;
    telegram?: Partial<{
      enabled?: boolean;
      botTokenFile?: string;
      allowedChatIds?: number[];
      chats?: TelegramChat[];
      topicMode?: 'project' | 'department';
      projectTopics?: Record<string, TelegramProjectTopic>;
      departmentTopics?: Record<string, TelegramProjectTopic>;
      notify?: Partial<TelegramNotifyConfig>;
    }>;
    workers?: Partial<WorkersConfig>;
    scheduler?: Partial<SchedulerConfig>;
    profileCooling?: Partial<ProfileCoolingConfig>;
    ui?: Partial<UiConfig>;
    branding?: Partial<BrandingConfig>;
    integrations?: Partial<{ openproject: { sources: unknown[] } }>;
  }>,
): void {
  const configFilePath = path.join(hubHome, 'config.json');
  const managedToolsDir = path.join(hubHome, 'tools');
  process.env.AGENTHUB_TOOLS_DIR ||= managedToolsDir;
  const managedBinDir = path.join(managedToolsDir, 'node_modules', '.bin');
  if (!(process.env.PATH || '').split(path.delimiter).includes(managedBinDir)) {
    process.env.PATH = `${managedBinDir}${path.delimiter}${process.env.PATH || ''}`;
  }
  let current: Record<string, unknown> = {};
  if (fs.existsSync(configFilePath)) {
    try {
      current = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    } catch {
      // ignore
    }
  }
  const updated = {
    ...current,
    ...patch,
    ...(patch.branding && typeof patch.branding === 'object'
      ? { branding: { ...((current.branding as Record<string, unknown>) || {}), ...patch.branding } }
      : {}),
    ...(patch.chat && typeof patch.chat === 'object'
      ? { chat: { ...((current.chat as Record<string, unknown>) || {}), ...patch.chat } }
      : {}),
    ...(patch.brain && typeof patch.brain === 'object'
      ? {
          brain: {
            ...((current.brain as Record<string, unknown>) || {}),
            ...patch.brain,
            ...(patch.brain.digest && typeof patch.brain.digest === 'object'
              ? {
                  digest: {
                    ...((((current.brain as Record<string, unknown>) || {}).digest as Record<string, unknown>) || {}),
                    ...patch.brain.digest,
                  },
                }
              : {}),
            ...(patch.brain.director && typeof patch.brain.director === 'object'
              ? {
                  director: {
                    ...((((current.brain as Record<string, unknown>) || {}).director as Record<string, unknown>) || {}),
                    ...patch.brain.director,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(patch.assistant && typeof patch.assistant === 'object'
      ? { assistant: { ...((current.assistant as Record<string, unknown>) || {}), ...patch.assistant } }
      : {}),
    ...(patch.notifications && typeof patch.notifications === 'object'
      ? {
          notifications: {
            ...((current.notifications as Record<string, unknown>) || {}),
            ...patch.notifications,
            ...(patch.notifications.quietHours && typeof patch.notifications.quietHours === 'object'
              ? {
                  quietHours: {
                    ...DEFAULT_QUIET_HOURS_CONFIG,
                    ...((((current.notifications as Record<string, unknown>) || {}).quietHours as Record<string, unknown>) || {}),
                    ...patch.notifications.quietHours,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(patch.reviewer && typeof patch.reviewer === 'object'
      ? { reviewer: { ...((current.reviewer as Record<string, unknown>) || {}), ...patch.reviewer } }
      : {}),
    ...(patch.focus && typeof patch.focus === 'object'
      ? { focus: { ...((current.focus as Record<string, unknown>) || {}), ...patch.focus } }
      : {}),
    ...(patch.disk ? { disk: { ...((current.disk as Record<string, unknown>) || {}), ...patch.disk } } : {}),
    ...(patch.cleanup ? { cleanup: { ...((current.cleanup as Record<string, unknown>) || {}), ...patch.cleanup } } : {}),
    ...(patch.load ? { load: { ...((current.load as Record<string, unknown>) || {}), ...patch.load } } : {}),
    ...(patch.stall ? { stall: { ...((current.stall as Record<string, unknown>) || {}), ...patch.stall } } : {}),
    ...(patch.context ? { context: { ...((current.context as Record<string, unknown>) || {}), ...patch.context } } : {}),
    ...(patch.planning && typeof patch.planning === 'object'
      ? { planning: { ...((current.planning as Record<string, unknown>) || {}), ...patch.planning } }
      : {}),
    ...(patch.updates && typeof patch.updates === 'object'
      ? {
          updates: {
            ...((current.updates as Record<string, unknown>) || {}),
            ...patch.updates,
          },
        }
      : {}),
    ...(patch.workers && typeof patch.workers === 'object'
      ? {
          workers: {
            ...((current.workers as Record<string, unknown>) || {}),
            ...patch.workers,
          },
        }
      : {}),
    ...(patch.ui && typeof patch.ui === 'object'
      ? { ui: { ...((current.ui as Record<string, unknown>) || {}), ...patch.ui, ...(patch.ui.tours ? { tours: { ...(((current.ui as Record<string, unknown>)?.tours as Record<string, unknown>) || {}), ...patch.ui.tours } } : {}) } }
      : {}),
    ...(patch.tools ? { tools: { ...((current.tools as Record<string, unknown>) || {}), ...patch.tools, ...(patch.tools.installers ? { installers: { ...(((current.tools as Record<string, unknown>)?.installers as Record<string, unknown>) || {}), ...patch.tools.installers } } : {}) } } : {}),
    ...(patch.telegram && typeof patch.telegram === 'object'
      ? {
          telegram: {
            ...((current.telegram as Record<string, unknown>) || {}),
            ...patch.telegram,
            ...(patch.telegram.notify && typeof patch.telegram.notify === 'object'
              ? {
                  notify: {
                    ...(((current.telegram as Record<string, unknown>)?.notify as Record<string, unknown>) || {}),
                    ...patch.telegram.notify,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(patch.savings
      ? {
          savings: {
            ...((current.savings as Record<string, unknown>) || {}),
            ...patch.savings,
            ...(patch.savings.bucketTokens
              ? {
                  bucketTokens: {
                    ...(((current.savings as Record<string, unknown>)?.bucketTokens as Record<string, unknown>) || {}),
                    ...patch.savings.bucketTokens,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(patch.integrations && typeof patch.integrations === 'object'
      ? {
          integrations: {
            ...((current.integrations as Record<string, unknown>) || {}),
            ...patch.integrations,
          },
        }
      : {}),
  };
  fs.writeFileSync(configFilePath, JSON.stringify(updated, null, 2), 'utf-8');
}

export function updateConfigInMemory(
  config: AgentHubConfig,
  patch: Partial<{
    modelChainHard: string[];
    modelChainEasy: string[];
    defaultTimeout: number;
    focus?: Partial<AgentHubConfig['focus']>;
    multiplePerProvider?: boolean;
    slotsPerAgyProfile: number;
    slotsPerCodexProfile: number;
    watchdog: { stallMinutes?: number; waitingMinutes?: number };
    autoFixOnFail: boolean;
    chat: Partial<ChatConfig>;
    brain?: Partial<Omit<BrainConfig, 'digest' | 'director'>> & {
      digest?: Partial<BrainDigestConfig>;
      director?: Partial<BrainConfig['director']>;
    };
    assistant?: Partial<AssistantConfig>;
    reviewer: ReviewerConfigPatch;
    notifications?: Partial<{
      desktop: boolean;
      desktopLevel: NotificationsConfig['desktopLevel'];
      quietHours?: Partial<QuietHoursConfig>;
    }>;
    disk?: { minFreeGB?: number; extraPaths?: ExtraDiskPath[] };
    cleanup?: { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number };
    cacheDir?: string;
    cacheMaxEntries?: number;
    cacheMaxGB?: number;
    savings: DeepPartialSavingsConfig;
    load?: Partial<LoadConfig>;
    stall?: Partial<StallConfig>;
    context?: Partial<ContextConfig>;
    planning?: Partial<PlanningConfig>;
    updates?: Partial<UpdatesConfig>;
    tools?: Partial<{ installers: Partial<Record<'claude' | 'codex' | 'agy', ToolInstallerPatch>> }>;
    telegram?: Partial<{
      enabled?: boolean;
      botTokenFile?: string;
      allowedChatIds?: number[];
      chats?: TelegramChat[];
      topicMode?: 'project' | 'department';
      projectTopics?: Record<string, TelegramProjectTopic>;
      departmentTopics?: Record<string, TelegramProjectTopic>;
      notify?: Partial<TelegramNotifyConfig>;
    }>;
    workers?: Partial<WorkersConfig>;
    scheduler?: Partial<SchedulerConfig>;
    profileCooling?: Partial<ProfileCoolingConfig>;
    ui?: Partial<UiConfig>;
    branding?: Partial<BrandingConfig>;
    integrations?: Partial<{ openproject: { sources: unknown[] } }>;
  }>,
): void {
  if (patch.modelChainHard) {
    config.defaultModelChains.hard = [...patch.modelChainHard];
  }
  if (patch.modelChainEasy) {
    config.defaultModelChains.easy = [...patch.modelChainEasy];
  }
  if (patch.defaultTimeout !== undefined) {
    config.defaultTimeout = patch.defaultTimeout;
  }
  if (patch.focus) config.focus = { ...config.focus, ...patch.focus };
  if (patch.multiplePerProvider !== undefined) {
    config.multiplePerProvider = patch.multiplePerProvider;
    config.multiplePerProviderConfigured = true;
  }
  if (patch.slotsPerAgyProfile !== undefined) {
    config.slotsPerAgyProfile = patch.slotsPerAgyProfile;
  }
  if (patch.slotsPerCodexProfile !== undefined) {
    config.slotsPerCodexProfile = patch.slotsPerCodexProfile;
  }
  if (patch.watchdog) {
    config.watchdog = { ...config.watchdog, ...patch.watchdog };
  }
  if (patch.autoFixOnFail !== undefined) config.autoFixOnFail = patch.autoFixOnFail;
  if (patch.chat) {
    if (patch.chat.claudeBin !== undefined) {
      config.chat.claudeBin = patch.chat.claudeBin;
    }
    if (patch.chat.disableToolSearch !== undefined) {
      config.chat.disableToolSearch = patch.chat.disableToolSearch;
    }
    if (patch.chat.allowFullMode !== undefined) {
      config.chat.allowFullMode = patch.chat.allowFullMode;
    }
    if (patch.chat.maxConcurrent !== undefined) {
      config.chat.maxConcurrent = patch.chat.maxConcurrent;
    }
    if (patch.chat.idleTimeoutSec !== undefined) config.chat.idleTimeoutSec = patch.chat.idleTimeoutSec;
    if (patch.chat.model !== undefined) config.chat.model = patch.chat.model;
    if (patch.chat.models !== undefined) config.chat.models = [...patch.chat.models];
    if (patch.chat.permissionTimeoutSec !== undefined) config.chat.permissionTimeoutSec = patch.chat.permissionTimeoutSec;
    if (patch.chat.claudeProfile !== undefined) config.chat.claudeProfile = patch.chat.claudeProfile;
    if (patch.chat.autoCompactPercent !== undefined) config.chat.autoCompactPercent = patch.chat.autoCompactPercent;
  }
  if (patch.brain) {
    if (patch.brain.fallback) config.brain.fallback = normalizeFallbackSteps(patch.brain.fallback);
    if (patch.brain.policy) config.brain.policy = [...patch.brain.policy];
    if (patch.brain.claudeProfile !== undefined) config.brain.claudeProfile = patch.brain.claudeProfile;
    if (patch.brain.model !== undefined) config.brain.model = patch.brain.model;
    if (patch.brain.engine !== undefined) config.brain.engine = patch.brain.engine;
    if (patch.brain.codexProfile !== undefined) config.brain.codexProfile = patch.brain.codexProfile;
    if (patch.brain.codexModel !== undefined) config.brain.codexModel = patch.brain.codexModel;
    if (patch.brain.mode !== undefined) config.brain.mode = patch.brain.mode;
    if (patch.brain.permissions !== undefined) config.brain.permissions = patch.brain.permissions;
    if (patch.brain.maxTurnsPerHour !== undefined) config.brain.maxTurnsPerHour = patch.brain.maxTurnsPerHour;
    if (patch.brain.dailyTokenBudget !== undefined) config.brain.dailyTokenBudget = patch.brain.dailyTokenBudget;
    if (patch.brain.turnTimeoutSec !== undefined) config.brain.turnTimeoutSec = patch.brain.turnTimeoutSec;
    if (patch.brain.maxConcurrent !== undefined) config.brain.maxConcurrent = patch.brain.maxConcurrent;
    if (patch.brain.director) {
      config.brain.director = {
        enabled: patch.brain.director.enabled ?? config.brain.director?.enabled ?? false,
        engine: patch.brain.director.engine ?? config.brain.director?.engine ?? 'claude',
        model: patch.brain.director.model ?? config.brain.director?.model ?? 'opus',
        codexProfile: patch.brain.director.codexProfile ?? config.brain.director?.codexProfile,
        permissions: patch.brain.director.permissions ?? config.brain.director?.permissions ?? 'standard',
      };
    }
    if (patch.brain.digest) {
      config.brain.digest = {
        ...config.brain.digest,
        ...patch.brain.digest,
      };
    }
  }
  if (patch.assistant) {
    config.assistant = { ...config.assistant, ...patch.assistant };
  }
  if (patch.reviewer) {
    config.reviewer = {
      ...config.reviewer,
      ...patch.reviewer,
      fallback: { ...config.reviewer.fallback, ...patch.reviewer.fallback },
      arbiter: { ...config.reviewer.arbiter, ...patch.reviewer.arbiter },
    };
  }
  if (patch.notifications) {
    if (!config.notifications) {
      config.notifications = {
        desktop: true,
        desktopLevel: 'important',
      };
    }
    if (patch.notifications.desktop !== undefined) {
      config.notifications.desktop = patch.notifications.desktop;
    }
    if (patch.notifications.desktopLevel !== undefined) {
      config.notifications.desktopLevel = patch.notifications.desktopLevel;
    }
    if (patch.notifications.quietHours) {
      config.notifications.quietHours = {
        enabled: patch.notifications.quietHours.enabled ?? config.notifications.quietHours?.enabled ?? DEFAULT_QUIET_HOURS_CONFIG.enabled,
        start: patch.notifications.quietHours.start ?? config.notifications.quietHours?.start ?? DEFAULT_QUIET_HOURS_CONFIG.start,
        end: patch.notifications.quietHours.end ?? config.notifications.quietHours?.end ?? DEFAULT_QUIET_HOURS_CONFIG.end,
      };
    }
  }
  if (patch.disk?.minFreeGB !== undefined) {
    config.disk.minFreeGB = patch.disk.minFreeGB;
  }
  if (patch.disk?.extraPaths !== undefined) {
    config.disk.extraPaths = [...patch.disk.extraPaths];
  }
  if (patch.cleanup?.nodeModulesOnDone !== undefined) {
    config.cleanup.nodeModulesOnDone = patch.cleanup.nodeModulesOnDone;
  }
  if (patch.cleanup?.worktreeOnDoneAfterHours !== undefined) {
    config.cleanup.worktreeOnDoneAfterHours = patch.cleanup.worktreeOnDoneAfterHours;
  }
  if (patch.cacheDir !== undefined) {
    config.cacheDir = patch.cacheDir;
  }
  if (patch.cacheMaxEntries !== undefined) config.cacheMaxEntries = patch.cacheMaxEntries;
  if (patch.cacheMaxGB !== undefined) config.cacheMaxGB = patch.cacheMaxGB;
  if (patch.savings) {
    if (patch.savings.bucketTokens) {
      config.savings.bucketTokens = {
        ...config.savings.bucketTokens,
        ...patch.savings.bucketTokens,
      };
    }
    if (patch.savings.claudeFactor !== undefined) {
      config.savings.claudeFactor = patch.savings.claudeFactor;
    }
    if (patch.savings.claudeOverheadPerTask !== undefined) {
      config.savings.claudeOverheadPerTask = patch.savings.claudeOverheadPerTask;
    }
  }
  if (patch.load) config.load = { ...config.load, ...patch.load };
  if (patch.stall) config.stall = { ...config.stall, ...patch.stall };
  if (patch.context) {
    if (patch.context.overlapCheckSec !== undefined) {
      config.context.overlapCheckSec = patch.context.overlapCheckSec;
    }
    if (patch.context.depsMaxChars !== undefined) {
      config.context.depsMaxChars = patch.context.depsMaxChars;
    }
    if (patch.context.knowledgeMaxChars !== undefined) {
      config.context.knowledgeMaxChars = patch.context.knowledgeMaxChars;
    }
    if (patch.context.knowledgeFile !== undefined) {
      config.context.knowledgeFile = patch.context.knowledgeFile;
    }
  }
  if (patch.planning) {
    if (patch.planning.requireApproval !== undefined) {
      config.planning.requireApproval = patch.planning.requireApproval;
    }
    if (patch.planning.approvalMinTasks !== undefined) {
      config.planning.approvalMinTasks = Math.max(0, Math.floor(patch.planning.approvalMinTasks));
    }
  }
  if (patch.telegram) {
    config.telegram = {
      ...config.telegram,
      ...patch.telegram,
      allowedChatIds:
        patch.telegram.allowedChatIds !== undefined
          ? [...patch.telegram.allowedChatIds]
          : config.telegram.allowedChatIds,
      chats: patch.telegram.chats !== undefined ? [...patch.telegram.chats] : config.telegram.chats,
      topicMode: patch.telegram.topicMode !== undefined ? patch.telegram.topicMode : config.telegram.topicMode,
      projectTopics: patch.telegram.projectTopics !== undefined ? { ...patch.telegram.projectTopics } : config.telegram.projectTopics,
      departmentTopics: patch.telegram.departmentTopics !== undefined ? { ...patch.telegram.departmentTopics } : config.telegram.departmentTopics,
      notify: {
        ...config.telegram.notify,
        ...(patch.telegram.notify || {}),
      },
    };
  }
  if (patch.updates) {
    config.updates = { ...config.updates, ...patch.updates };
  }
  if (patch.workers) {
    config.workers = {
      ...(config.workers || DEFAULT_WORKERS_CONFIG),
      ...patch.workers,
    };
  }
  if (patch.scheduler) config.scheduler = { ...config.scheduler, ...patch.scheduler };
  if (patch.scheduler) config.schedulerLimits = config.scheduler;
  if (patch.profileCooling) config.profileCooling = { ...config.profileCooling, ...patch.profileCooling };
  if (patch.ui?.tours) config.ui = { ...config.ui, tours: { ...config.ui.tours, ...patch.ui.tours } };
  if (patch.branding) config.branding = parseBranding({ ...config.branding, ...patch.branding });
  if (patch.tools?.installers) {
    for (const [name, value] of Object.entries(patch.tools.installers) as Array<[keyof ToolsConfig['installers'], ToolInstallerPatch | undefined]>) {
      if (!value) continue;
      config.tools.installers[name] = {
        ...config.tools.installers[name],
        ...(value.package !== undefined ? { package: value.package } : {}),
        ...(value.versionArgs !== undefined ? { versionArgs: [...value.versionArgs] } : {}),
        ...(value.docsUrl !== undefined ? { docsUrl: value.docsUrl } : {}),
      };
    }
  }
  if (patch.integrations?.openproject) {
    config.integrations = {
      ...config.integrations,
      openproject: {
        sources: parseOpenProjectSources(patch.integrations),
      },
    };
  }
}

export function loadConfig(overrideHome?: string): AgentHubConfig {
  const hubHome = overrideHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub');

  // Ensure directory exists with proper permissions
  if (!fs.existsSync(hubHome)) {
    fs.mkdirSync(hubHome, { recursive: true, mode: 0o700 });
  }

  const configFilePath = path.join(hubHome, 'config.json');
  const managedToolsDir = path.join(hubHome, 'tools');
  process.env.AGENTHUB_TOOLS_DIR ||= managedToolsDir;
  const managedBinDir = path.join(managedToolsDir, 'node_modules', '.bin');
  if (!(process.env.PATH || '').split(path.delimiter).includes(managedBinDir)) {
    process.env.PATH = `${managedBinDir}${path.delimiter}${process.env.PATH || ''}`;
  }
  let userConfig: Record<string, unknown> = {};
  if (fs.existsSync(configFilePath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    } catch {
      // ignore invalid config
    }
  }

  const logsDir = path.join(hubHome, 'logs');
  const worktreesDir = path.join(hubHome, 'worktrees');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  if (!fs.existsSync(worktreesDir)) fs.mkdirSync(worktreesDir, { recursive: true });

  const testAgyHomesDir = process.env.AGENTHUB_TEST_MODE === '1'
    ? path.join(path.dirname(hubHome), 'agy-homes')
    : undefined;
  const agyHomesDir =
    (userConfig.agyHomesDir as string) ||
    process.env.AGENTHUB_AGY_HOMES ||
    testAgyHomesDir ||
    path.join(os.homedir(), '.agy-homes');

  const defaultLogDir =
    (userConfig.defaultLogDir as string) ||
    process.env.AGENTHUB_DEFAULT_LOG_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');

  const envPort = process.env.AGENTHUB_PORT ? parseInt(process.env.AGENTHUB_PORT, 10) : undefined;
  const port = (envPort && !isNaN(envPort)) ? envPort : ((userConfig.port as number) || 7700);
  const host = process.env.AGENTHUB_HOST || (userConfig.host as string) || '127.0.0.1';
  const allowedHosts = process.env.AGENTHUB_ALLOWED_HOSTS !== undefined
    ? process.env.AGENTHUB_ALLOWED_HOSTS.split(',').map((value) => value.trim()).filter(Boolean)
    : Array.isArray(userConfig.allowedHosts)
      ? userConfig.allowedHosts.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : [];
  const rawFocus = (userConfig.focus && typeof userConfig.focus === 'object' ? userConfig.focus : {}) as Record<string, unknown>;

  const chatRaw = (userConfig.chat as Record<string, unknown>) || {};
  const chat: ChatConfig = {
    claudeBin:
      (chatRaw.claudeBin as string) ||
      (userConfig.claudeBin as string) ||
      process.env.AGENTHUB_CLAUDE_BIN ||
      undefined,
    allowFullMode: chatRaw.allowFullMode === true || userConfig.allowFullMode === true,
    disableToolSearch: chatRaw.disableToolSearch !== false,
    maxConcurrent:
      typeof chatRaw.maxConcurrent === 'number'
        ? chatRaw.maxConcurrent
        : typeof userConfig.maxConcurrent === 'number'
        ? userConfig.maxConcurrent
        : 2,
    idleTimeoutSec: typeof chatRaw.idleTimeoutSec === 'number' ? chatRaw.idleTimeoutSec : 300,
    model: typeof chatRaw.model === 'string' ? chatRaw.model : 'sonnet',
    models: Array.isArray(chatRaw.models) && chatRaw.models.every((model): model is string => typeof model === 'string' && model.trim().length > 0)
      ? [...chatRaw.models]
      : ['opus', 'sonnet', 'haiku'],
    permissionTimeoutSec: typeof chatRaw.permissionTimeoutSec === 'number' ? chatRaw.permissionTimeoutSec : 600,
    claudeProfile: typeof chatRaw.claudeProfile === 'string' ? chatRaw.claudeProfile : 'claude-default',
    claudeProfileExplicit: typeof chatRaw.claudeProfile === 'string' && chatRaw.claudeProfile.trim().length > 0,
    autoCompactPercent: typeof chatRaw.autoCompactPercent === 'number' ? chatRaw.autoCompactPercent : 85,
  };
  const reviewerRaw = (userConfig.reviewer as Record<string, unknown>) || {};
  const brainRaw = (userConfig.brain as Record<string, unknown>) || {};
  const assistantRaw = (userConfig.assistant as Record<string, unknown>) || {};

  const userDisk = (userConfig.disk as { minFreeGB?: number; extraPaths?: unknown } | undefined);
  const userCleanup = (userConfig.cleanup as { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number } | undefined);

  const disk = {
    minFreeGB: typeof userDisk?.minFreeGB === 'number' ? userDisk.minFreeGB : 3,
    extraPaths: Array.isArray(userDisk?.extraPaths)
      ? userDisk.extraPaths.filter((entry): entry is ExtraDiskPath => {
          if (!entry || typeof entry !== 'object') return false;
          const value = entry as Record<string, unknown>;
          return typeof value.path === 'string' && typeof value.minFreeGB === 'number' && typeof value.label === 'string';
        })
      : [],
  };

  const cleanup = {
    nodeModulesOnDone: typeof userCleanup?.nodeModulesOnDone === 'boolean' ? userCleanup.nodeModulesOnDone : true,
    worktreeOnDoneAfterHours: typeof userCleanup?.worktreeOnDoneAfterHours === 'number' ? userCleanup.worktreeOnDoneAfterHours : 24,
  };

  const cacheDir =
    (userConfig.cacheDir as string) ||
    process.env.AGENTHUB_CACHE_DIR ||
    path.join(hubHome, 'cache', 'node_modules');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cacheMaxEntries = typeof userConfig.cacheMaxEntries === 'number' && userConfig.cacheMaxEntries > 0
    ? Math.floor(userConfig.cacheMaxEntries) : 3;
  const cacheMaxGB = typeof userConfig.cacheMaxGB === 'number' && userConfig.cacheMaxGB > 0
    ? userConfig.cacheMaxGB : 3;

  const rawSavings = (userConfig.savings as Record<string, unknown>) || {};
  const rawLoad = (userConfig.load as Record<string, unknown>) || {};
  const rawClaudeSessions = (userConfig.claudeSessions as Record<string, unknown>) || {};
  const rawClaudeWeights = (rawClaudeSessions.weights as Record<string, unknown>) || {};
  const rawClaudeInclude = Array.isArray(rawClaudeSessions.include)
    ? rawClaudeSessions.include.filter((value): value is string => typeof value === 'string')
    : [];
  const rawBucketTokens = (rawSavings.bucketTokens as Record<string, unknown>) || {};
  const savings: SavingsConfig = {
    bucketTokens: {
      gemini: typeof rawBucketTokens.gemini === 'number' ? rawBucketTokens.gemini : DEFAULT_SAVINGS_CONFIG.bucketTokens.gemini,
      claude: typeof rawBucketTokens.claude === 'number' ? rawBucketTokens.claude : DEFAULT_SAVINGS_CONFIG.bucketTokens.claude,
    },
    claudeFactor: typeof rawSavings.claudeFactor === 'number' ? rawSavings.claudeFactor : DEFAULT_SAVINGS_CONFIG.claudeFactor,
    claudeOverheadPerTask: typeof rawSavings.claudeOverheadPerTask === 'number' ? rawSavings.claudeOverheadPerTask : DEFAULT_SAVINGS_CONFIG.claudeOverheadPerTask,
  };

  const rawStall = (userConfig.stall as Record<string, unknown>) || {};
  const stall: StallConfig = {
    noCommitMin: typeof rawStall.noCommitMin === 'number' ? rawStall.noCommitMin : DEFAULT_STALL_CONFIG.noCommitMin,
    loopThreshold: typeof rawStall.loopThreshold === 'number' ? rawStall.loopThreshold : DEFAULT_STALL_CONFIG.loopThreshold,
  };

  const rawContext = (userConfig.context as Record<string, unknown>) || {};
  const context = {
    depsMaxChars: typeof rawContext.depsMaxChars === 'number' && rawContext.depsMaxChars > 0
      ? Math.floor(rawContext.depsMaxChars)
      : 16000,
    knowledgeMaxChars: typeof rawContext.knowledgeMaxChars === 'number' && rawContext.knowledgeMaxChars > 0
      ? Math.floor(rawContext.knowledgeMaxChars)
      : DEFAULT_CONTEXT_CONFIG.knowledgeMaxChars,
    knowledgeFile: typeof rawContext.knowledgeFile === 'string' && rawContext.knowledgeFile.trim()
      ? rawContext.knowledgeFile.trim()
      : undefined,
  };

  const defaultBotTokenFile = path.join(hubHome, 'secrets', 'telegram.token');
  const rawPlanning = (userConfig.planning as Record<string, unknown>) || {};
  const planning: PlanningConfig = {
    requireApproval: rawPlanning.requireApproval === true,
    approvalMinTasks: typeof rawPlanning.approvalMinTasks === 'number' && rawPlanning.approvalMinTasks >= 0
      ? Math.floor(rawPlanning.approvalMinTasks)
      : DEFAULT_PLANNING_CONFIG.approvalMinTasks,
  };
  const rawTelegram = (userConfig.telegram as Record<string, unknown>) || {};
  const rawTelegramNotify = (rawTelegram.notify as Record<string, unknown>) || {};
  const telegram: TelegramConfig = {
    enabled: rawTelegram.enabled === true,
    botTokenFile:
      typeof rawTelegram.botTokenFile === 'string' && rawTelegram.botTokenFile.trim()
        ? rawTelegram.botTokenFile.trim()
        : defaultBotTokenFile,
    allowedChatIds: Array.isArray(rawTelegram.allowedChatIds)
      ? rawTelegram.allowedChatIds.filter((id): id is number => typeof id === 'number')
      : [],
    chats: Array.isArray(rawTelegram.chats)
      ? rawTelegram.chats.filter((chat): chat is TelegramChat =>
          Boolean(chat && typeof chat === 'object' && typeof (chat as TelegramChat).id === 'number' && typeof (chat as TelegramChat).name === 'string'),
        )
      : [],
    topicMode: rawTelegram.topicMode === 'department' ? 'department' : 'project',
    projectTopics: rawTelegram.projectTopics && typeof rawTelegram.projectTopics === 'object'
      ? Object.fromEntries(Object.entries(rawTelegram.projectTopics).filter(([, topic]) => Boolean(
          topic && typeof topic === 'object' && typeof (topic as TelegramProjectTopic).chatId === 'number' && typeof (topic as TelegramProjectTopic).threadId === 'number',
        )).map(([projectId, topic]) => [projectId, { chatId: (topic as TelegramProjectTopic).chatId, threadId: (topic as TelegramProjectTopic).threadId }]))
      : {},
    departmentTopics: rawTelegram.departmentTopics && typeof rawTelegram.departmentTopics === 'object'
      ? Object.fromEntries(Object.entries(rawTelegram.departmentTopics).filter(([, topic]) => Boolean(
          topic && typeof topic === 'object' && typeof (topic as TelegramProjectTopic).chatId === 'number' && typeof (topic as TelegramProjectTopic).threadId === 'number',
        )).map(([deptId, topic]) => [deptId, { chatId: (topic as TelegramProjectTopic).chatId, threadId: (topic as TelegramProjectTopic).threadId }]))
      : {},
    notify: {
      reviewReady: rawTelegramNotify.reviewReady !== false,
      failed: rawTelegramNotify.failed !== false,
      blocked: rawTelegramNotify.blocked !== false,
      quotaAllExhausted: rawTelegramNotify.quotaAllExhausted !== false,
      fallback: rawTelegramNotify.fallback !== false,
      brainWaiting: rawTelegramNotify.brainWaiting !== false,
    },
  };

  const rawUpdates = (userConfig.updates as Record<string, unknown>) || {};
  const updates: UpdatesConfig = {
    check: rawUpdates.check !== false,
    repo: typeof rawUpdates.repo === 'string' && rawUpdates.repo.trim()
      ? rawUpdates.repo.trim()
      : DEFAULT_UPDATES_CONFIG.repo,
  };
  const rawWorkers = (userConfig.workers as Record<string, unknown>) || {};
  const workers: WorkersConfig = {
    codexSandbox: rawWorkers.codexSandbox === 'workspace-write' ? 'workspace-write' : DEFAULT_WORKERS_CONFIG.codexSandbox,
  };
  const rawChecks = (userConfig.checks as Record<string, unknown>) || {};
  const checks: ChecksConfig = {
    maxConcurrent: typeof rawChecks.maxConcurrent === 'number' && rawChecks.maxConcurrent > 0
      ? Math.floor(rawChecks.maxConcurrent)
      : 2,
  };
  const rawTools = (userConfig.tools as Record<string, unknown>) || {};
  const integrationsRaw = userConfig.integrations && typeof userConfig.integrations === 'object'
    ? userConfig.integrations : {};
  const integrationsResult = z.object({ openproject: OpenProjectIntegrationSchema.default({}) }).safeParse(integrationsRaw);
  const integrations: IntegrationsConfig = integrationsResult.success
    ? integrationsResult.data
    : DEFAULT_INTEGRATIONS_CONFIG;
  const rawDeploy = (userConfig.deploy as Record<string, unknown>) || {};
  const rawProjectsConfig = (userConfig.projects as Record<string, unknown>) || {};
  for (const [projectId, rawProject] of Object.entries(rawProjectsConfig)) {
    if (rawProject && typeof rawProject === 'object' && (rawProject as Record<string, unknown>).afterMerge) {
      rawDeploy[projectId] = (rawProject as Record<string, unknown>).afterMerge;
    }
  }
  const deploy: Record<string, DeployProjectConfig> = {};
  for (const [projectId, raw] of Object.entries(rawDeploy)) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as Record<string, unknown>;
    const steps = Array.isArray(value.steps)
      ? value.steps.filter((step): step is string[] => Array.isArray(step) && step.length > 0 && step.every((arg) => typeof arg === 'string'))
      : [];
    if (steps.length === 0) continue;
    const pushRaw = value.push as Record<string, unknown> | undefined;
    const minIntervalMin = typeof pushRaw?.minIntervalMin === 'number' && pushRaw.minIntervalMin >= 0
      ? Math.floor(pushRaw.minIntervalMin)
      : 30;
    const push = pushRaw && typeof pushRaw.remote === 'string' && typeof pushRaw.from === 'string' && typeof pushRaw.to === 'string'
      ? { remote: pushRaw.remote, from: pushRaw.from, to: pushRaw.to, ffOnly: pushRaw.ffOnly !== false, minIntervalMin }
      : undefined;
    deploy[projectId] = {
      steps,
      timeoutSec: typeof value.timeoutSec === 'number' && value.timeoutSec > 0 ? Math.floor(value.timeoutSec) : 900,
      restartHub: value.restartHub === true,
      restartMaxWaitMin: typeof value.restartMaxWaitMin === 'number' && value.restartMaxWaitMin >= 0
        ? Math.floor(value.restartMaxWaitMin)
        : 20,
      ...(push ? { push } : {}),
    };
  }
  const rawInstallers = (rawTools.installers as Record<string, unknown>) || {};
  const installer = (name: string, fallback: ToolInstaller): ToolInstaller => {
    const value = rawInstallers[name];
    return value && typeof value === 'object' ? { ...fallback, ...(value as ToolInstaller) } : fallback;
  };
  const rawUi = (userConfig.ui as Record<string, unknown>) || {};
  const ui: UiConfig = {
    tours: rawUi.tours && typeof rawUi.tours === 'object'
      ? Object.fromEntries(Object.entries(rawUi.tours).filter(([, value]) => typeof value === 'boolean'))
      : {},
  };
  const branding = parseBranding(userConfig.branding);

  return {
    hubHome,
    agyHomesDir,
    dbPath: path.join(hubHome, 'hub.db'),
    logsDir,
    worktreesDir,
    tokenPath: path.join(hubHome, 'token'),
    configFilePath,
    port,
    host,
    allowedHosts,
    defaultModelChains: {
      hard: (userConfig as Record<string, unknown>).modelChainHard as string[] || [...DEFAULT_MODEL_CHAINS.hard],
      easy: (userConfig as Record<string, unknown>).modelChainEasy as string[] || [...DEFAULT_MODEL_CHAINS.easy],
    },
    defaultTimeout: (userConfig.defaultTimeout as number) || 3 * 60 * 60,
    focus: {
      projectId: typeof rawFocus.projectId === 'string' ? rawFocus.projectId : null,
      since: typeof rawFocus.since === 'string' ? rawFocus.since : null,
      pauseRunning: rawFocus.pauseRunning !== false,
    },
    multiplePerProvider: userConfig.multiplePerProvider !== false,
    multiplePerProviderConfigured: Object.prototype.hasOwnProperty.call(userConfig, 'multiplePerProvider'),
    slotsPerAgyProfile: (userConfig.slotsPerAgyProfile as number) || 2,
    slotsPerCodexProfile: (userConfig.slotsPerCodexProfile as number) || 2,
    watchdog: {
      stallMinutes: ((userConfig.watchdog as Record<string, unknown> | undefined)?.stallMinutes as number) || 20,
      waitingMinutes: ((userConfig.watchdog as Record<string, unknown> | undefined)?.waitingMinutes as number) || 15,
    },
    defaultLogDir,
    autoFixOnFail: userConfig.autoFixOnFail === true,
    chat,
    brain: {
      engine: brainRaw.engine === 'codex' ? 'codex' : 'claude',
      fallback: normalizeFallbackSteps(brainRaw.fallback),
      policy: Array.isArray(brainRaw.policy)
        ? brainRaw.policy.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0)
        : [],
      claudeProfile: typeof brainRaw.claudeProfile === 'string' && brainRaw.claudeProfile.trim()
        ? brainRaw.claudeProfile.trim()
        : chat.claudeProfile || 'claude-default',
      claudeProfileExplicit:
        (typeof brainRaw.claudeProfile === 'string' && brainRaw.claudeProfile.trim().length > 0) ||
        chat.claudeProfileExplicit === true,
      model: typeof brainRaw.model === 'string' && brainRaw.model
        ? brainRaw.model
        : (chat.models.includes('opus') ? 'opus' : 'sonnet'),
      codexProfile: typeof brainRaw.codexProfile === 'string' && brainRaw.codexProfile.trim() ? brainRaw.codexProfile.trim() : undefined,
      codexModel: typeof brainRaw.codexModel === 'string' && brainRaw.codexModel.trim() ? brainRaw.codexModel.trim() : undefined,
      mode: brainRaw.mode === 'off' || brainRaw.mode === 'auto' ? brainRaw.mode : 'suggest',
      permissions: brainRaw.permissions === 'trusted' || brainRaw.permissions === 'full' ? brainRaw.permissions : 'standard',
      maxConcurrent: typeof brainRaw.maxConcurrent === 'number' && brainRaw.maxConcurrent > 0
        ? Math.floor(brainRaw.maxConcurrent)
        : 2,
      maxTurnsPerHour: typeof brainRaw.maxTurnsPerHour === 'number' && brainRaw.maxTurnsPerHour > 0
        ? Math.floor(brainRaw.maxTurnsPerHour)
        : 20,
      dailyTokenBudget: typeof brainRaw.dailyTokenBudget === 'number' && brainRaw.dailyTokenBudget >= 0
        ? Math.floor(brainRaw.dailyTokenBudget)
        : 0,
      turnTimeoutSec: typeof brainRaw.turnTimeoutSec === 'number' && brainRaw.turnTimeoutSec > 0
        ? Math.floor(brainRaw.turnTimeoutSec)
        : 20 * 60,
      digest: typeof brainRaw.digest === 'string'
        ? { enabled: true, time: brainRaw.digest }
        : typeof brainRaw.digest === 'object' && brainRaw.digest !== null
        ? {
            enabled: (brainRaw.digest as { enabled?: boolean }).enabled !== false,
            time: typeof (brainRaw.digest as { time?: string }).time === 'string' && (brainRaw.digest as { time: string }).time.trim()
              ? (brainRaw.digest as { time: string }).time.trim()
              : DEFAULT_BRAIN_DIGEST_CONFIG.time,
          }
        : { ...DEFAULT_BRAIN_DIGEST_CONFIG },
      director: {
        enabled: (brainRaw.director as Record<string, unknown> | undefined)?.enabled === true,
        engine: (brainRaw.director as Record<string, unknown> | undefined)?.engine === 'codex' ? 'codex' : 'claude',
        model: typeof (brainRaw.director as Record<string, unknown> | undefined)?.model === 'string'
          ? (brainRaw.director as Record<string, unknown>).model as string : 'opus',
        codexProfile: typeof (brainRaw.director as Record<string, unknown> | undefined)?.codexProfile === 'string'
          ? (brainRaw.director as Record<string, unknown>).codexProfile as string : undefined,
        permissions: (brainRaw.director as Record<string, unknown> | undefined)?.permissions === 'full'
          ? 'full' : (brainRaw.director as Record<string, unknown> | undefined)?.permissions === 'trusted' ? 'trusted' : 'standard',
      },
    },
    assistant: {
      enabled: assistantRaw.enabled !== false,
      model: typeof assistantRaw.model === 'string' && assistantRaw.model.trim() ? assistantRaw.model.trim() : 'sonnet',
      policy: Array.isArray(assistantRaw.policy)
        ? assistantRaw.policy.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0)
        : [],
      permissions: assistantRaw.permissions === 'full' ? 'full' : 'guarded',
    },
    claudeSessions: {
      dir: typeof rawClaudeSessions.dir === 'string' ? rawClaudeSessions.dir : path.join(os.homedir(), '.claude', 'projects'),
      maxAgeDays: typeof rawClaudeSessions.maxAgeDays === 'number' ? rawClaudeSessions.maxAgeDays : 14,
      activeWithinMin: typeof rawClaudeSessions.activeWithinMin === 'number' ? rawClaudeSessions.activeWithinMin : 10,
      include: rawClaudeInclude,
      weights: {
        cacheCreation: typeof rawClaudeWeights.cacheCreation === 'number' ? rawClaudeWeights.cacheCreation : 1.25,
        cacheRead: typeof rawClaudeWeights.cacheRead === 'number' ? rawClaudeWeights.cacheRead : 0.1,
      },
      autoResume: {
        enabled: (rawClaudeSessions.autoResume as Record<string, unknown> | undefined)?.enabled === true,
        prompt: typeof (rawClaudeSessions.autoResume as Record<string, unknown> | undefined)?.prompt === 'string'
          ? (rawClaudeSessions.autoResume as Record<string, unknown>).prompt as string
          : 'Giới hạn 5 giờ đã reset. Tiếp tục công việc đang dở từ chỗ đã dừng; nếu đã xong thì tóm tắt trạng thái.',
        allowFullMode: (rawClaudeSessions.autoResume as Record<string, unknown> | undefined)?.allowFullMode === true,
      },
    },
    reviewer: {
      enabled: reviewerRaw.enabled !== false,
      timeoutSec: typeof reviewerRaw.timeoutSec === 'number' ? reviewerRaw.timeoutSec : 900,
      failoverSec: typeof reviewerRaw.failoverSec === 'number' ? reviewerRaw.failoverSec : 5 * 60 * 60,
      maxChangesRequested: typeof reviewerRaw.maxChangesRequested === 'number' ? reviewerRaw.maxChangesRequested : 2,
      claudeProfiles: Array.isArray(reviewerRaw.claudeProfiles)
        ? reviewerRaw.claudeProfiles.filter((name): name is string => typeof name === 'string' && name.length > 0)
        : [],
      ...(() => {
        const migrated = reviewerSettingsFromLegacy(reviewerRaw);
        return {
          order: migrated.order,
          fallback: migrated.fallback,
          arbiter: (() => {
            const raw = reviewerRaw.arbiter;
            if (!raw || typeof raw !== 'object') return DEFAULT_REVIEWER_ARBITER;
            const value = raw as Record<string, unknown>;
            return {
              engine: value.engine === 'codex' ? 'codex' : 'claude',
              model: typeof value.model === 'string' && value.model ? value.model : DEFAULT_REVIEWER_ARBITER.model,
            };
          })(),
        };
      })(),
    },
    notifications: {
      desktop: typeof (userConfig.notifications as { desktop?: boolean } | undefined)?.desktop === 'boolean'
        ? (userConfig.notifications as { desktop: boolean }).desktop
        : true,
      desktopLevel: (() => {
        const level = (userConfig.notifications as { desktopLevel?: unknown } | undefined)?.desktopLevel;
        return level === 'all' || level === 'critical' || level === 'off' || level === 'important' ? level : 'important';
      })(),
      ...(userConfig.notifications && typeof userConfig.notifications === 'object' && 'quietHours' in userConfig.notifications
        ? {
            quietHours: (() => {
              const raw = (userConfig.notifications as { quietHours?: unknown }).quietHours;
              if (typeof raw === 'string') {
                const parts = raw.split('-');
                if (parts.length === 2) {
                  return { enabled: true, start: parts[0].trim(), end: parts[1].trim() };
                }
              } else if (raw && typeof raw === 'object') {
                const obj = raw as Record<string, unknown>;
                return {
                  enabled: obj.enabled === true,
                  start: typeof obj.start === 'string' && obj.start.trim() ? obj.start.trim() : DEFAULT_QUIET_HOURS_CONFIG.start,
                  end: typeof obj.end === 'string' && obj.end.trim() ? obj.end.trim() : DEFAULT_QUIET_HOURS_CONFIG.end,
                };
              }
              return { ...DEFAULT_QUIET_HOURS_CONFIG };
            })(),
          }
        : {}),
    },
    disk,
    cleanup,
    cacheDir,
    cacheMaxEntries,
    cacheMaxGB,
    savings,
    load: {
      enabled: typeof rawLoad.enabled === 'boolean' ? rawLoad.enabled : DEFAULT_LOAD_CONFIG.enabled,
      high: typeof rawLoad.high === 'number' ? rawLoad.high : DEFAULT_LOAD_CONFIG.high,
      ok: typeof rawLoad.ok === 'number' ? rawLoad.ok : DEFAULT_LOAD_CONFIG.ok,
      pressureHigh: typeof rawLoad.pressureHigh === 'number' ? rawLoad.pressureHigh : DEFAULT_LOAD_CONFIG.pressureHigh,
      pressureIoHigh: typeof rawLoad.pressureIoHigh === 'number' ? rawLoad.pressureIoHigh : DEFAULT_LOAD_CONFIG.pressureIoHigh,
      pressureOk: typeof rawLoad.pressureOk === 'number' ? rawLoad.pressureOk : DEFAULT_LOAD_CONFIG.pressureOk,
      minFreeMemGB: typeof rawLoad.minFreeMemGB === 'number' ? rawLoad.minFreeMemGB : DEFAULT_LOAD_CONFIG.minFreeMemGB,
      recoverAfterSec: typeof rawLoad.recoverAfterSec === 'number' ? rawLoad.recoverAfterSec : DEFAULT_LOAD_CONFIG.recoverAfterSec,
      pausePolicy: rawLoad.pausePolicy === 'rss' || rawLoad.pausePolicy === 'recent' ? rawLoad.pausePolicy : DEFAULT_LOAD_CONFIG.pausePolicy,
      maxAutoPaused: typeof rawLoad.maxAutoPaused === 'number' ? rawLoad.maxAutoPaused : DEFAULT_LOAD_CONFIG.maxAutoPaused,
      autoPauseThresholdSec: typeof rawLoad.autoPauseThresholdSec === 'number' ? rawLoad.autoPauseThresholdSec : DEFAULT_LOAD_CONFIG.autoPauseThresholdSec,
    },
    stall,
    context: {
      overlapCheckSec: typeof rawContext.overlapCheckSec === 'number'
        ? rawContext.overlapCheckSec
        : DEFAULT_CONTEXT_CONFIG.overlapCheckSec,
      depsMaxChars: context.depsMaxChars,
      knowledgeMaxChars: context.knowledgeMaxChars,
      knowledgeFile: context.knowledgeFile,
    },
    planning,
    telegram,
    updates,
    tools: {
      installers: {
        claude: installer('claude', { package: '@anthropic-ai/claude-code', versionArgs: ['--version'] }),
        codex: installer('codex', { package: '@openai/codex', versionArgs: ['--version'] }),
        agy: installer('agy', {
          command: ['sh', '-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'],
          docsUrl: 'https://antigravity.google/',
        }),
      },
    },
    workers,
    ui,
    checks,
    branding,
    deploy,
    integrations,
    scheduler: (() => {
      const raw = (userConfig.scheduler as Record<string, unknown>) || {};
      return {
        maxRunsPerTask: typeof raw.maxRunsPerTask === 'number' && raw.maxRunsPerTask > 0 ? Math.floor(raw.maxRunsPerTask) : DEFAULT_SCHEDULER_LIMITS.maxRunsPerTask,
        maxConsecutiveCrashesPerTask: typeof raw.maxConsecutiveCrashesPerTask === 'number' && raw.maxConsecutiveCrashesPerTask > 0 ? Math.floor(raw.maxConsecutiveCrashesPerTask) : DEFAULT_SCHEDULER_LIMITS.maxConsecutiveCrashesPerTask,
        maxPausedMin: typeof raw.maxPausedMin === 'number' && raw.maxPausedMin > 0 ? Math.floor(raw.maxPausedMin) : DEFAULT_SCHEDULER_LIMITS.maxPausedMin,
      };
    })(),
    schedulerLimits: (() => {
      const raw = (userConfig.scheduler as Record<string, unknown>) || {};
      return {
        maxRunsPerTask: typeof raw.maxRunsPerTask === 'number' && raw.maxRunsPerTask > 0
          ? Math.floor(raw.maxRunsPerTask)
          : DEFAULT_SCHEDULER_LIMITS.maxRunsPerTask,
        maxConsecutiveCrashesPerTask: typeof raw.maxConsecutiveCrashesPerTask === 'number' && raw.maxConsecutiveCrashesPerTask > 0
          ? Math.floor(raw.maxConsecutiveCrashesPerTask)
          : DEFAULT_SCHEDULER_LIMITS.maxConsecutiveCrashesPerTask,
        maxPausedMin: typeof raw.maxPausedMin === 'number' && raw.maxPausedMin > 0
          ? Math.floor(raw.maxPausedMin)
          : DEFAULT_SCHEDULER_LIMITS.maxPausedMin,
      };
    })(),
    profileCooling: (() => {
      const raw = (userConfig.profileCooling as Record<string, unknown>) || {};
      return {
        threshold: typeof raw.threshold === 'number' && raw.threshold > 0
          ? Math.floor(raw.threshold)
          : DEFAULT_PROFILE_COOLING.threshold,
        windowMin: typeof raw.windowMin === 'number' && raw.windowMin > 0
          ? raw.windowMin
          : DEFAULT_PROFILE_COOLING.windowMin,
        coolingMin: typeof raw.coolingMin === 'number' && raw.coolingMin > 0
          ? raw.coolingMin
          : DEFAULT_PROFILE_COOLING.coolingMin,
      };
    })(),
  };
}
