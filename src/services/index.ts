import fs from 'node:fs';
import { HttpError } from '../errors.js';
import { DEFAULT_PROJECT_SETTINGS, mergeProjectSettings, ProjectSettingsInputSchema, projectSettings } from '../projects/settings.js';
import { projectWorktreeRoots, validateProjectWorktreeRoot } from '../projects/paths.js';
import { ensureIntegrationNodeModules, ensureIntegrationWorktree, getIntegrationStatus, removeIntegrationWorktree, validateIntegrationBranch } from '../projects/integration.js';
import { resolveProjectFile } from '../projects/paths.js';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { z, ZodError } from 'zod';
import { AgentHubConfig, TelegramChat, TelegramProjectTopic, saveConfig, updateConfigInMemory } from '../config.js';
import {
  ProjectRepo,
  DepartmentRepo,
  ProfileRepo,
  QuotaMarkRepo,
  TaskRepo,
  RunRepo,
  ReviewRepo,
  EventRepo,
  TaskNoteRepo,
  TaskNoteRow,
  ProjectRow,
  ProfileRow,
  TaskRow,
  QuotaMarkRow,
  KnowledgeRepo,
  KnowledgeEntryRow,
  TaskBatchRepo,
  BrainDirectiveRepo,
  TaskBatchRow,
  CiRepo,
} from '../db/index.js';
import type { CiWatchService } from '../ci.js';
import { BulletinService } from '../bulletin.js';
import { ProfileService as CoreProfileService, accountKey, isProfileLoggedIn, exchangeAgyRefreshToken, writeAgyIsolatedToken, fetchAgyGoogleUserInfo, fetchAgyGoogleUserInfoDetailed, inspectAgyAccessToken } from '../profiles/index.js';
import { Scheduler } from '../scheduler/index.js';
import { CodexEngine } from '../engines/index.js';
import { hasClaudeQuotaAvailable, QuotaUsageService } from '../quota/usage.js';
import { QuotaService } from '../quota/index.js';
import { ProfileLockService } from '../profiles/locks.js';
import { CheckRunner } from '../checks.js';
import { BrainService } from '../brain.js';
import { toApiTime } from '../db/time.js';
import { ChatService } from '../chat/service.js';
import type { BrainRunner } from '../brain/runner.js';
import { getDiskSpaceSync, getMonitoredDisks } from '../disk.js';
import { WorktreeService } from '../worktrees/index.js';
import { parseAuthState, parseCodexLoginStatus } from '../profiles/auth.js';
import { SavingsService } from '../savings.js';
import { getDailyUsageReport } from '../daily-usage.js';
import { ClaudeSessionRepo } from '../claude-sessions/repo.js';
import type { ClaudeSessionRow } from '../claude-sessions/repo.js';
import { isClaudeProcessOpen, isClaudeQuotaLimited, ClaudeSessionScanner } from '../claude-sessions/scanner.js';
import type { PageResult } from '../pagination.js';
import { findClaudeBin, getClaudeVersion } from '../chat/claude.js';
import { listAllWorktreeProcesses, reapSyncForWorktree } from '../reaper.js';
import { mergeTaskIntoBase, MergeError } from '../merge.js';
import { computeTaskGraph, filterTasksForGraph, detectCycle, parseDependsOn } from './dag.js';
import { excerptHash, extractFileLocations, toMarkdownCodeBlock, truncateExcerpt } from '../task-capture.js';
import type { TelegramBotService } from '../telegram.js';
import { ReviewChainSchema, parseReviewChain, type ReviewChainStep } from '../review-chain.js';
import { isKnownModel } from '../quota/index.js';
import { isValidReviewerModel, ReviewerArbiterSchema, ReviewerFallbackSchema, ReviewerOrderSchema, reviewerSettingsFromLegacy } from '../reviewer-config.js';
import { SetupManager } from '../tools/setup.js';
import { createNewGitProject, inspectProject, readClaudeSessionExcerpt } from '../projects/inspect.js';
import type { DeployService } from '../deploy.js';
import type { PerfCollector } from '../perf.js';

const execFileAsync = promisify(execFile);
const CODEX_EMAIL_RECHECK_MS = 10 * 60 * 1000;
const ESCALATION_MODEL = 'claude-opus-4-6-thinking';

function worktreeBytes(root: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    try {
      if (entry.isDirectory()) total += worktreeBytes(fullPath);
      else if (entry.isFile()) total += fs.statSync(fullPath).size;
    } catch {
      // Files can disappear while the status snapshot is being collected.
    }
  }
  return total;
}

function apiProject(project: ProjectRow, hubHome?: string, ciRepo?: CiRepo): ProjectRow {
  let merge: unknown = null;
  if (project.merge) {
    try { merge = JSON.parse(project.merge); } catch { merge = null; }
  }
  let reviewChain: unknown = null;
  if (project.reviewChain) {
    try { reviewChain = JSON.parse(project.reviewChain); } catch { reviewChain = null; }
  }
  let review: unknown = null;
  if (project.review) {
    try { review = JSON.parse(project.review); } catch { review = null; }
  } else if (reviewChain) {
    review = { chain: reviewChain, maxRounds: 2 };
  }
  const settings = projectSettings(project);
  const resolvedHubHome = hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub');
  const integrationStatus = settings.integration.enabled ? getIntegrationStatus(project, resolvedHubHome) : null;
  let ciStatus: unknown = null;
  if (ciRepo) {
    const latestRun = ciRepo.getLatest(project.id);
    if (latestRun) {
      let jobs: unknown = [];
      try { jobs = JSON.parse(latestRun.jobs); } catch { jobs = []; }
      ciStatus = {
        runId: latestRun.runId,
        workflow: latestRun.workflow,
        sha: latestRun.sha,
        status: latestRun.status,
        conclusion: latestRun.conclusion,
        url: latestRun.url,
        completedAt: latestRun.completedAt,
        jobs,
      };
    }
  }
  return {
    ...project,
    merge,
    reviewChain,
    review,
    settings,
    integrationStatus,
    ciStatus,
    createdAt: toApiTime(project.createdAt)!,
  } as unknown as ProjectRow;
}

function apiProfile(profile: ProfileRow): ProfileRow {
  return {
    ...profile,
    createdAt: toApiTime(profile.createdAt)!,
    authState: profile.authState ?? null,
    authMessage: profile.authMessage ?? null,
    verifyUrl: profile.verifyUrl ?? null,
    avatarUrl: profile.avatarUrl ?? null,
  };
}

function apiTask(task: TaskRow): TaskRow {
  return {
    ...task,
    waitReason: task.waitReason ?? null,
    createdAt: toApiTime(task.createdAt)!,
    updatedAt: toApiTime(task.updatedAt)!,
  };
}

function hasConfiguredMerge(project: ProjectRow, baseRef: string): boolean {
  const settings = projectSettings(project);
  if (settings.integration.enabled) return true;
  if (!project.merge) return false;
  try {
    const merge = JSON.parse(project.merge) as { enabled?: boolean; worktrees?: Record<string, unknown> };
    return merge.enabled === true
      && !!merge.worktrees
      && typeof merge.worktrees[baseRef] === 'string'
      && path.isAbsolute(merge.worktrees[baseRef]);
  } catch {
    return false;
  }
}

export function apiTaskNote(note: TaskNoteRow): TaskNoteRow {
  return {
    ...note,
    createdAt: toApiTime(note.createdAt) || note.createdAt,
  };
}

export function apiKnowledgeEntry(entry: KnowledgeEntryRow): KnowledgeEntryRow {
  return { ...entry, createdAt: toApiTime(entry.createdAt) || entry.createdAt };
}

export function apiBatch(batch: TaskBatchRow): TaskBatchRow {
  return {
    ...batch,
    createdAt: toApiTime(batch.createdAt) || batch.createdAt,
  };
}

export interface BatchProgress {
  total: number;
  done: number;
  running: number;
  failed: number;
  waiting: number;
  pending: number;
}

function batchProgress(tasks: TaskRow[]): BatchProgress {
  const done = tasks.filter((task) => task.status === 'done').length;
  const running = tasks.filter((task) => ['running', 'checking', 'review'].includes(task.status)).length;
  const failed = tasks.filter((task) => ['failed', 'blocked', 'cancelled'].includes(task.status)).length;
  const waiting = tasks.filter((task) => ['waiting_quota', 'draft'].includes(task.status)).length;
  return { total: tasks.length, done, running, failed, waiting, pending: Math.max(0, tasks.length - done - running - failed - waiting) };
}

export function extractKnowledgeSection(doneContent: string): string | null {
  const heading = /^##\s+Ghi chú cho task sau\s*$/m.exec(doneContent);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const remainder = doneContent.slice(start).replace(/^\r?\n/, '');
  const nextHeading = /^##\s/m.exec(remainder);
  const content = remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
  return content ? content : null;
}

function apiRun<T extends { startedAt: string; endedAt: string | null }>(run: T): T {
  return { ...run, startedAt: toApiTime(run.startedAt)!, endedAt: toApiTime(run.endedAt) };
}

function apiReview<T extends { createdAt: string }>(review: T): T {
  return { ...review, createdAt: toApiTime(review.createdAt)! };
}

export const VALID_AGY_MODELS = new Set([
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]);

export const modelValidator = z.string().trim().min(1, 'Model không được để trống').refine(
  (m) => (m.startsWith('codex:') && isValidReviewerModel('codex', m.slice('codex:'.length))) || VALID_AGY_MODELS.has(m),
  { message: 'Mỗi model phải là id agy hợp lệ hoặc model codex hợp lệ (codex:gpt-...)' },
);

export const reviewerModelValidator = z
  .string()
  .trim()
  .min(1, 'Model của reviewer không được để trống')
  .refine(
    (m) => isValidReviewerModel('codex', m) || isValidReviewerModel('claude', m),
    { message: 'Model của reviewer phải theo cú pháp engine codex hoặc claude hợp lệ' },
  );
const taskModelValidator = z.string().trim().min(1, 'Model không được để trống');

export const ProjectHooksSchema = z.object({
  onWorktreeRemoved: z.array(z.string()).optional(),
});
export type ProjectHooks = z.infer<typeof ProjectHooksSchema>;

export const ProjectHooksInputSchema = z.union([
  ProjectHooksSchema,
  z.string().transform((val, ctx) => {
    if (!val.trim()) return null;
    try {
      const parsed = JSON.parse(val);
      return ProjectHooksSchema.parse(parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid hooks JSON: ${msg}` });
      return z.NEVER;
    }
  }),
]);

export const ProjectMergeSchema = z.object({
  enabled: z.boolean().default(false),
  worktrees: z.record(z.string().min(1), z.string().min(1)).default({}),
  checks: z.array(z.string().min(1)).default([]),
  timeoutSec: z.number().int().positive().default(600),
});
export type ProjectMerge = z.infer<typeof ProjectMergeSchema>;
export const ProjectReviewSchema = z.object({
  chain: ReviewChainSchema.default([]),
  maxRounds: z.number().int().positive().default(2),
});

export const DepartmentInputSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  name: z.string().min(1).max(120),
  priority: z.number().int().default(0),
  maxParallel: z.number().int().nonnegative().default(0),
  claudeDailyTokenBudget: z.number().int().nonnegative().default(0),
  telegramTopicId: z.number().int().positive().nullable().default(null),
  brainEngine: z.enum(['claude', 'codex']).default('claude'),
  brainModel: z.string().min(1).default('sonnet'),
  brainCodexProfile: z.string().min(1).nullable().default(null),
  brainMode: z.enum(['inherit', 'off', 'suggest', 'auto']).default('inherit'),
  brainPermissions: z.enum(['inherit', 'standard', 'trusted', 'full']).default('full'),
  brainDailyTokenBudget: z.number().int().nonnegative().default(0),
  brainMaxTurnsPerHour: z.number().int().positive().default(20),
});

export const CreateProjectSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  name: z.string().min(1),
  path: z.string().min(1),
  defaultBranch: z.string().default('main'),
  envTemplate: z.string().nullable().optional(),
  maxParallel: z.number().int().positive().default(3),
  departmentId: z.string().min(1).default('chung'),
  checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(),
  hooks: ProjectHooksInputSchema.nullable().optional(),
  merge: ProjectMergeSchema.nullable().optional(),
  reviewChain: ReviewChainSchema.nullable().optional(),
  review: ProjectReviewSchema.nullable().optional(),
  settings: ProjectSettingsInputSchema.optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  envTemplate: z.string().nullable().optional(),
  maxParallel: z.number().int().positive().optional(),
  departmentId: z.string().min(1).optional(),
  checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(),
  hooks: ProjectHooksInputSchema.nullable().optional(),
  merge: ProjectMergeSchema.nullable().optional(),
  reviewChain: ReviewChainSchema.nullable().optional(),
  review: ProjectReviewSchema.nullable().optional(),
  settings: ProjectSettingsInputSchema.optional(),
});

export const CreateTaskSchema = z.object({
  project: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1),
  externalRef: z.string().trim().max(200).optional(),
  body: z.string().optional(),
  level: z.enum(['easy', 'hard']).default('easy'),
  dependsOn: z.array(z.string()).optional(),
  baseRef: z.string().optional(),
  branch: z.string().optional(),
  modelChain: z.array(taskModelValidator).optional(),
  sourceRef: z.object({ taskId: z.string(), runId: z.string().nullable().optional(), checkName: z.string().nullable().optional(), excerptHash: z.string() }).optional(),
  start: z.boolean().optional(),
  fromClaude: z.boolean().optional(),
  batchId: z.string().optional(),
  sessionId: z.string().optional(),
  goal: z.string().optional(),
});

export const BatchTaskInputSchema = z.object({
  slug: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1),
  body: z.string().optional(),
  level: z.enum(['easy', 'hard']).default('easy'),
  modelChain: z.array(modelValidator).optional(),
  dependsOn: z.array(z.string()).optional(),
});

export const CreateBatchSchema = z.object({
  project: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().optional(),
  tasks: z.array(BatchTaskInputSchema).min(1),
  createdBy: z.string().optional(),
  dispatch: z.boolean().optional(),
  sessionId: z.string().optional(),
});

export const UpdateBatchSchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().nullable().optional(),
  status: z.enum(['draft', 'dispatched', 'discarded']).optional(),
});

export const CaptureTaskSchema = z.object({
  sourceTaskId: z.string().min(1),
  runId: z.string().min(1).optional(),
  checkName: z.string().min(1).optional(),
  excerpt: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  level: z.enum(['easy', 'hard']).default('easy'),
  start: z.boolean().optional(),
});

export const UpdateTaskSchema = z.object({
  modelChain: z.array(taskModelValidator).nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  level: z.enum(['easy', 'hard']).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  appendBody: z.string().optional(),
});

export const ReviewTaskSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  feedback: z.string().optional(),
  by: z.string().optional(),
  merge: z.boolean().optional().default(false),
}).refine(
  (d) => d.verdict !== 'changes_requested' || (typeof d.feedback === 'string' && d.feedback.trim().length > 0),
  { message: 'Feedback là bắt buộc khi changes_requested' },
);

export const RetryTaskSchema = z.object({
  note: z.string().optional(),
});

export const CreateTaskNoteSchema = z.object({
  content: z.string().min(1, 'Nội dung ghi chú không được để trống'),
  kind: z.enum(['note', 'overlap']).optional().default('note'),
});

export const CreateKnowledgeSchema = z.object({
  content: z.string().min(1, 'Nội dung kiến thức không được để trống'),
  taskId: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
});

export const UpdateKnowledgeSchema = z.object({
  content: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
});

export const CreateProfileSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  engine: z.enum(['agy', 'claude', 'codex']).default('agy'),
  accountType: z.enum(['personal', 'team', 'api']).default('personal'),
});

function providerLabel(engine: 'agy' | 'codex' | 'claude'): string {
  return engine === 'agy' ? 'Gemini' : engine === 'codex' ? 'Codex' : 'Claude';
}

export const RenameProfileSchema = z.object({
  newName: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
});

export const UpdateProfileSchema = z.object({
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  label: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  priority: z.number().int().optional(),
});

export const MarkQuotaSchema = z.object({
  family: z.string().min(1),
  seconds: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export const timeStringValidator = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Định dạng giờ phải là HH:MM (00:00 - 23:59)');

export const UpdateConfigSchema = z.object({
  branding: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    shortName: z.string().trim().min(1).max(12).optional(),
    logo: z.string().trim().max(80).optional(),
    accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    tagline: z.string().trim().max(160).optional(),
  }).optional(),
  modelChainHard: z.array(modelValidator).min(1).optional(),
  modelChainEasy: z.array(modelValidator).min(1).optional(),
  defaultTimeout: z.number().int().positive().optional(),
  context: z.object({
    overlapCheckSec: z.number().positive().optional(),
    depsMaxChars: z.number().int().positive().optional(),
    knowledgeMaxChars: z.number().int().positive().optional(),
    knowledgeFile: z.string().optional(),
  }).optional(),
  slotsPerAgyProfile: z.number().int().positive().optional(),
  slotsPerCodexProfile: z.number().int().positive().optional(),
  multiplePerProvider: z.boolean().optional(),
  planning: z.object({
    requireApproval: z.boolean().optional(),
    approvalMinTasks: z.number().int().min(0).max(100).optional(),
  }).optional(),
  watchdog: z.object({
    stallMinutes: z.number().positive().optional(),
    waitingMinutes: z.number().positive().optional(),
  }).optional(),
  autoFixOnFail: z.boolean().optional(),
  tools: z.object({ installers: z.record(z.object({
    package: z.string().regex(/^(@[a-z0-9-~][a-z0-9._~]*\/[a-z0-9-~][a-z0-9._~]*|[a-z0-9-~][a-z0-9._~]*)(@[\w.^~<>=*-]+)?$/).refine((value) => !value.startsWith('-'), 'Tên package npm không hợp lệ').optional(),
    versionArgs: z.array(z.string()).optional(),
    docsUrl: z.string().url().optional(),
  })) }).optional(),
  chat: z
    .object({
      claudeBin: z.string().optional(),
      disableToolSearch: z.boolean().optional(),
      allowFullMode: z.boolean().optional(),
      maxConcurrent: z.number().int().positive().optional(),
      idleTimeoutSec: z.number().int().positive().optional(),
      permissionTimeoutSec: z.number().int().positive().optional(),
      claudeProfile: z.string().optional(),
      model: z.enum(['', 'opus', 'sonnet', 'haiku']).optional(),
      models: z.array(z.enum(['opus', 'sonnet', 'haiku'])).min(1).optional(),
      autoCompactPercent: z.number().min(0).max(100).optional(),
    })
    .optional(),
  reviewer: z.object({
    enabled: z.boolean().optional(),
    model: reviewerModelValidator.or(z.literal('')).optional(),
    timeoutSec: z.number().int().positive().optional(),
    failoverSec: z.number().int().positive().optional(),
    maxChangesRequested: z.number().int().positive().optional(),
    claudeFallback: z.boolean().optional(),
    claudeProfiles: z.array(z.string().min(1)).max(20).optional(),
    claudeModel: z.enum(['opus', 'sonnet', 'haiku']).optional(),
    claudeFallbackAfterMin: z.number().int().min(1).max(1440).optional(),
    order: ReviewerOrderSchema.optional(),
    fallback: ReviewerFallbackSchema.partial().optional(),
    arbiter: ReviewerArbiterSchema.optional(),
  }).optional(),
  focus: z.object({
    projectId: z.string().min(1).nullable().optional(),
    since: z.string().nullable().optional(),
    pauseRunning: z.boolean().optional(),
  }).optional(),
  brain: z.object({
    engine: z.enum(['claude', 'codex']).optional(),
    fallback: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('profile'), profile: z.string().trim().min(1, 'Tên profile không được để trống').optional() }),
      z.object({ type: z.literal('model'), model: z.string().trim().min(1, 'Tên model không được để trống') }),
      z.object({ type: z.literal('apiKey'), dailyCapUSD: z.number().positive('Hạn mức ngày phải là số dương') }),
      z.object({ type: z.literal('engine'), engine: z.literal('codex') }),
      z.object({ type: z.literal('wait') }),
    ])).max(10).optional(),
    policy: z.array(z.string().min(1)).max(100).optional(),
    claudeProfile: z.string().min(1).optional(),
    codexProfile: z.string().min(1).optional(),
    codexModel: z.string().trim().min(1).optional(),
    model: z.enum(['', 'opus', 'sonnet', 'haiku']).optional(),
    mode: z.enum(['off', 'suggest', 'auto']).optional(),
    permissions: z.enum(['standard', 'trusted', 'full']).optional(),
    maxConcurrent: z.number().int().positive().optional(),
    maxTurnsPerHour: z.number().int().positive().optional(),
    dailyTokenBudget: z.number().int().nonnegative().optional(),
    turnTimeoutSec: z.number().int().positive().optional(),
    digest: z.object({
      enabled: z.boolean().optional(),
      time: timeStringValidator,
    }).partial().optional(),
    director: z.object({
      enabled: z.boolean().optional(),
      engine: z.enum(['claude', 'codex']).optional(),
      model: z.string().trim().min(1).optional(),
      codexProfile: z.string().trim().min(1).optional(),
      permissions: z.enum(['standard', 'trusted', 'full']).optional(),
    }).partial().optional(),
  }).optional(),
  assistant: z.object({
    enabled: z.boolean().optional(),
    model: z.enum(['', 'opus', 'sonnet', 'haiku']).optional(),
    policy: z.array(z.string().min(1)).max(100).optional(),
    permissions: z.enum(['guarded', 'full']).optional(),
  }).optional(),
  notifications: z.object({
    desktop: z.boolean().optional(),
    desktopLevel: z.enum(['all', 'important', 'critical', 'off']).optional(),
    quietHours: z.object({
      enabled: z.boolean().optional(),
      start: timeStringValidator,
      end: timeStringValidator,
    }).partial().optional(),
  }).optional(),
  savings: z
    .object({
      bucketTokens: z
        .object({
          gemini: z.number().positive().optional(),
          claude: z.number().positive().optional(),
        })
        .optional(),
      claudeFactor: z.number().positive().optional(),
      claudeOverheadPerTask: z.number().nonnegative().optional(),
    }).optional(),
  load: z.object({
    enabled: z.boolean().optional(),
    high: z.number().positive().optional(),
    ok: z.number().positive().optional(),
    pressureHigh: z.number().positive().optional(),
    pressureIoHigh: z.number().positive().optional(),
    pressureOk: z.number().positive().optional(),
    minFreeMemGB: z.number().positive().optional(),
    recoverAfterSec: z.number().int().positive().optional(),
    pausePolicy: z.enum(['recent', 'rss']).optional(),
    maxAutoPaused: z.number().int().positive().optional(),
    autoPauseThresholdSec: z.number().int().positive().optional(),
  }).optional(),
  stall: z.object({
    noCommitMin: z.number().positive().optional(),
    loopThreshold: z.number().int().positive().optional(),
  }).optional(),
  disk: z.object({
    minFreeGB: z.number().positive().optional(),
    extraPaths: z.array(z.object({ path: z.string().min(1), minFreeGB: z.number().positive(), label: z.string().min(1) })).optional(),
  }).optional(),
  cleanup: z.object({
    nodeModulesOnDone: z.boolean().optional(),
    worktreeOnDoneAfterHours: z.number().int().nonnegative().optional(),
  }).optional(),
  cacheDir: z.string().optional(),
  cacheMaxEntries: z.number().int().positive().optional(),
  cacheMaxGB: z.number().positive().optional(),
  telegram: z.object({
    enabled: z.boolean().optional(),
    botTokenFile: z.string().optional(),
    allowedChatIds: z.array(z.number()).optional(),
    chats: z.array(z.object({
      id: z.number(),
      name: z.string(),
      username: z.string().optional(),
      kind: z.enum(['chat', 'group', 'supergroup', 'channel']).optional(),
      projectId: z.string().optional(),
    })).optional(),
    topicMode: z.enum(['project', 'department']).optional(),
    projectTopics: z.record(z.object({ chatId: z.number(), threadId: z.number() })).optional(),
    departmentTopics: z.record(z.object({ chatId: z.number(), threadId: z.number() })).optional(),
    notify: z.object({
      reviewReady: z.boolean().optional(),
      failed: z.boolean().optional(),
      blocked: z.boolean().optional(),
      quota: z.boolean().optional(),
      quotaPerModel: z.boolean().optional(),
      quotaAllExhausted: z.boolean().optional(),
      fallback: z.boolean().optional(),
      brainWaiting: z.boolean().optional(),
    }).optional(),
  }).optional(),
  updates: z.object({
    check: z.boolean().optional(),
    repo: z.string().optional(),
  }).optional(),
  workers: z.object({
    codexSandbox: z.enum(['off', 'workspace-write']).optional(),
  }).optional(),
  ui: z.object({
    tours: z.record(z.boolean()).optional(),
  }).optional(),
});

export function toTaskId(idOrParam: string): string {
  return idOrParam.includes('~') ? idOrParam.replace('~', '/') : idOrParam;
}

export function toRouteId(taskId: string): string {
  return taskId.replace('/', '~');
}

export function readLogTail(filePath: string, tailKB = 512): string {
  if (!fs.existsSync(filePath)) return '';
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const maxBytes = Math.min(Math.max(1, tailKB), 512) * 1024;
      const bytesToRead = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
      return buffer.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export async function getGitCommits(
  repoPath: string,
  baseRef: string,
  branch: string,
): Promise<string[]> {
  if (!fs.existsSync(repoPath) || !baseRef || !branch) return [];
  try {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', `${baseRef}..${branch}`], {
      cwd: repoPath,
    });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export { HttpError };

export function formatEventSummary(
  type: string,
  payload: unknown,
  taskId?: string | null,
  activeMarks?: QuotaMarkRow[],
): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const taskLabel = taskId
    ? (taskId.includes('/') ? taskId.split('/')[1] : taskId.includes('~') ? taskId.split('~')[1] : taskId)
    : 'Task';

  switch (type) {
    case 'task.updated':
      return `${taskLabel} đã được cập nhật`;

    case 'task.review_ready':
    case 'task.review':
      return `${taskLabel} chuyển sang chờ review`;

    case 'review.escalated':
      return `${taskLabel} chờ người xử lý escalation reviewer`;

    case 'task.checking':
      return `${taskLabel} đang kiểm tra`;

    case 'task.queued': {
      const reason = p.reason;
      if (reason === 'quota_retry') {
        return `${taskLabel} được đưa vào hàng đợi (thử lại do hết quota)`;
      }
      if (reason === 'transient_retry') {
        return `${taskLabel} được đưa vào hàng đợi (thử lại sau lỗi tạm thời)`;
      }
      if (reason === 'changes_requested') {
        return `${taskLabel} được đưa vào hàng đợi (yêu cầu sửa đổi)`;
      }
      if (reason === 'retry') {
        return `${taskLabel} được đưa vào hàng đợi để thử lại`;
      }
      return `${taskLabel} được đưa vào hàng đợi`;
    }

    case 'task.running':
    case 'task.started': {
      const model = p.model as string | undefined;
      const worker = (p.profile || p.worker) as string | undefined;
      if (model && worker) {
        return `${taskLabel} đang chạy (${model}@${worker})`;
      }
      return `${taskLabel} bắt đầu chạy`;
    }

    case 'task.blocked':
      return `${taskLabel} bị chặn`;

    case 'task.failed':
      return `${taskLabel} thất bại`;

    case 'task.done':
      return `${taskLabel} hoàn thành`;

    case 'task.cancelled':
      return `${taskLabel} đã bị hủy`;

    case 'task.paused':
      return p.reason === 'load'
        ? `${taskLabel} tạm dừng do quá tải`
        : `${taskLabel} đã tạm dừng`;

    case 'task.resumed':
      return `${taskLabel} tiếp tục chạy`;

    case 'load.task_paused':
      return `${taskLabel} tạm dừng do quá tải`;

    case 'load.task_resumed':
      return `${taskLabel} tiếp tục chạy sau khi tải giảm`;

    case 'task.timeout':
      return `${taskLabel} hết thời gian chạy`;

    case 'task.waiting_quota': {
      const reason = p && (p as Record<string, unknown>).reason;
      if (reason === 'disk') {
        return `${taskLabel} chờ dung lượng ổ đĩa`;
      }
      if (reason === 'parallel') {
        return `${taskLabel} chờ slot song song`;
      }
      if (reason === 'profile_busy') {
        return `${taskLabel} chờ tài khoản rảnh`;
      }
      if (reason === 'focus') {
        return `${taskLabel} chờ vì đang tập trung cho project khác`;
      }
      return `${taskLabel} chờ quota khả dụng`;
    }

    case 'disk.low': {
      const free = p && (p as Record<string, unknown>).freeGB !== undefined ? `${(p as Record<string, unknown>).freeGB}GB` : '';
      return free ? `Ổ đĩa gần đầy (còn ${free})` : 'Ổ đĩa gần đầy';
    }

    case 'disk.docker_low': {
      const free = p && (p as Record<string, unknown>).freeGB !== undefined ? `${(p as Record<string, unknown>).freeGB}GB` : '';
      return free ? `Ổ đĩa Docker gần đầy (còn ${free})` : 'Ổ đĩa Docker gần đầy';
    }

    case 'run.crashed':
      return `${taskLabel} bị dừng đột ngột`;

    case 'run.stalled':
      return `${taskLabel} bị kẹt khi chờ tác vụ nền`;

    case 'quota.exhausted':
    case 'quota.marked': {
      const profile = (p.profile || p.worker || 'Hồ sơ') as string;
      const family = (p.family || p.model || '') as string;

      let resetTimeStr = '';
      if (typeof p.time === 'string') {
        resetTimeStr = p.time;
      } else if (typeof p.untilStr === 'string') {
        resetTimeStr = p.untilStr;
      } else if (typeof p.until === 'string' && p.until.includes(':')) {
        resetTimeStr = p.until;
      } else {
        let epochSec: number | undefined;
        if (typeof p.until === 'number') {
          epochSec = p.until > 1e11 ? Math.floor(p.until / 1000) : p.until;
        } else if (typeof p.resetAt === 'number') {
          epochSec = p.resetAt > 1e11 ? Math.floor(p.resetAt / 1000) : p.resetAt;
        } else if (typeof p.resetSeconds === 'number') {
          epochSec = Math.floor(Date.now() / 1000) + p.resetSeconds;
        } else if (typeof p.duration === 'number') {
          epochSec = Math.floor(Date.now() / 1000) + p.duration;
        } else if (activeMarks && profile && family) {
          const mark = activeMarks.find((m) => m.profileName === profile && m.family === family);
          if (mark) {
            epochSec = mark.until;
          }
        }

        if (epochSec !== undefined) {
          const d = new Date(epochSec * 1000);
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          resetTimeStr = `${hh}:${mm}`;
        }
      }

      if (family && resetTimeStr) {
        return `${profile} hết quota ${family} tới ${resetTimeStr}`;
      }
      if (resetTimeStr) {
        return `${profile} hết quota tới ${resetTimeStr}`;
      }
      if (family) {
        return `${profile} hết quota ${family}`;
      }
      return `${profile} hết quota`;
    }

    case 'quota.cleared': {
      const profile = (p.profile || 'Hồ sơ') as string;
      const family = p.family ? ` ${p.family}` : '';
      return `${profile} đã được xóa đánh dấu quota${family}`;
    }

    case 'profile.created': {
      const name = (p.name || '') as string;
      return name ? `Tạo mới hồ sơ ${name}` : 'Tạo mới hồ sơ';
    }

    case 'profile.updated': {
      const name = (p.name || p.profile || '') as string;
      return name ? `Cập nhật hồ sơ ${name}` : 'Cập nhật hồ sơ';
    }

    case 'config.updated':
      return 'Cập nhật cấu hình hệ thống';

    case 'task.overlap': {
      const file = (p.file || p.filename) as string | undefined;
      const other = p.otherTaskId
        ? (String(p.otherTaskId).includes('/') ? String(p.otherTaskId).split('/')[1] : String(p.otherTaskId))
        : undefined;
      if (file && other) {
        return `Cảnh báo trùng file ${file} giữa ${taskLabel} và ${other}`;
      }
      return `${taskLabel} cảnh báo trùng sửa file`;
    }

    case 'task.note': {
      const content = typeof p.content === 'string' ? p.content : '';
      return `${taskLabel} ghi chú: ${content.length > 50 ? content.slice(0, 50) + '...' : content}`;
    }

    case 'review.fallback': {
      const to = p.to || 'claude';
      const from = p.from || 'codex';
      const profile = p.profile ? ` (${p.profile})` : '';
      return `${taskLabel} fallback review từ ${from} sang ${to}${profile}`;
    }

    default:
      if (taskId) {
        return `${taskLabel}: ${type}`;
      }
      return type;
  }
}

export class AppService {
  public deployService?: DeployService;
  public ciRepo?: CiRepo;
  public ciService?: CiWatchService;
  private perfCollector?: PerfCollector;
  private profileChecks = new Set<string>();
  private reviewingTasks = new Set<string>();
  private worktreeUsageCache: { at: number; value: { count: number; bytes: number; byStatus: Record<string, { count: number; bytes: number }> } } | null = null;
  private gitVersion: { value: string | null; checkedAt: number } | null = null;
  private gitVersionCheck?: Promise<string | null>;
  private static readonly SETUP_VERSION_CACHE_MS = 10 * 60 * 1000;
  private failedAutoMerges = new Set<string>();
  constructor(
    public config: AgentHubConfig,
    public projectRepo: ProjectRepo,
    public profileRepo: ProfileRepo,
    public quotaMarkRepo: QuotaMarkRepo,
    public taskRepo: TaskRepo,
    public runRepo: RunRepo,
    public reviewRepo: ReviewRepo,
    public eventRepo: EventRepo,
    public coreProfileService: CoreProfileService,
    public scheduler: Scheduler,
    public usageService: QuotaUsageService,
    public lockService: ProfileLockService,
    public brainService?: BrainService,
    public chatService?: ChatService,
    public savingsService?: SavingsService,
    public claudeSessionRepo?: ClaudeSessionRepo,
    public claudeScanner?: ClaudeSessionScanner,
    public taskNoteRepo?: TaskNoteRepo,
    public bulletinService?: BulletinService,
    public telegramBotService?: TelegramBotService,
    public knowledgeRepo?: KnowledgeRepo,
    public taskBatchRepo?: TaskBatchRepo,
    public setupManager?: SetupManager,
    public brainRunner?: BrainRunner,
    public directiveRepo?: BrainDirectiveRepo,
    public departmentRepo?: DepartmentRepo,
  ) {}

  // --- Departments ---
  listDepartments() {
    if (!this.departmentRepo) throw new HttpError(503, 'unavailable', 'Department service chưa sẵn sàng');
    return this.departmentRepo.getAll().map((department) => ({ ...department, profiles: this.departmentRepo!.profiles(department.id), projects: this.departmentRepo!.projects(department.id) }));
  }

  getDepartment(id: string) {
    const department = this.departmentRepo?.get(id);
    if (!department) throw new HttpError(404, 'not_found', `Department "${id}" không tồn tại`);
    return { ...department, profiles: this.departmentRepo!.profiles(id), projects: this.departmentRepo!.projects(id) };
  }

  createDepartment(raw: unknown) {
    if (!this.departmentRepo) throw new HttpError(503, 'unavailable', 'Department service chưa sẵn sàng');
    const parsed = DepartmentInputSchema.parse(raw);
    const id = parsed.id || parsed.name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id) throw new HttpError(400, 'bad_request', 'Tên phòng ban không hợp lệ');
    if (this.departmentRepo.get(id)) throw new HttpError(409, 'conflict', `Department ID "${id}" đã tồn tại`);
    this.departmentRepo.insert({ id, ...parsed });
    this.scheduler.getEventBus().emit('department.changed', undefined, { departmentId: id, action: 'created' });
    return this.getDepartment(id);
  }

  updateDepartment(id: string, raw: unknown) {
    if (!this.departmentRepo?.get(id)) throw new HttpError(404, 'not_found', `Department "${id}" không tồn tại`);
    const parsed = DepartmentInputSchema.partial().parse(raw);
    this.departmentRepo!.update(id, parsed);
    this.scheduler.getEventBus().emit('department.changed', undefined, { departmentId: id, action: 'updated' });
    return this.getDepartment(id);
  }

  deleteDepartment(id: string) {
    if (!this.departmentRepo?.get(id)) throw new HttpError(404, 'not_found', `Department "${id}" không tồn tại`);
    try { this.departmentRepo.delete(id); } catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Không thể xóa phòng ban'); }
    this.scheduler.getEventBus().emit('department.changed', undefined, { departmentId: id, action: 'deleted' });
    return { ok: true };
  }

  updateDepartmentProfiles(id: string, raw: unknown) {
    if (!this.departmentRepo?.get(id)) throw new HttpError(404, 'not_found', `Department "${id}" không tồn tại`);
    const parsed = z.object({ profiles: z.array(z.object({ profileName: z.string().min(1), share: z.number().min(0).max(1).nullable().optional() })) }).parse(raw);
    for (const profile of parsed.profiles) {
      if (!this.profileRepo.get(profile.profileName)) throw new HttpError(404, 'not_found', `Profile "${profile.profileName}" không tồn tại`);
    }
    this.departmentRepo.setProfiles(id, parsed.profiles);
    this.scheduler.getEventBus().emit('department.changed', undefined, { departmentId: id, action: 'profiles' });
    return this.getDepartment(id);
  }

  setPerfCollector(collector: PerfCollector): void { this.perfCollector = collector; }

  shutdownForUser(): { queued: number; reviewers: number; childPids: number[] } {
    const result = this.scheduler.shutdownForUser();
    const chatPids = this.chatService?.getRunningPids?.() || [];
    this.chatService?.stop();
    this.deployService?.stop();
    this.ciService?.stop();
    void this.telegramBotService?.stop();
    return {
      ...result,
      childPids: [...(result.childPids || []), ...chatPids],
    };
  }
  getPerf() { return { samples: this.perfCollector?.getSamples() || [], latest: this.perfCollector?.latest() || null }; }

  async getSetupStatus() {
    if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng');
    const tools = await this.setupManager.status();
    const profiles = this.listProfiles();
    const gitVersion = await this.getGitVersion();
    let mcpRegistered = false;
    try { mcpRegistered = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8').includes('agenthub'); } catch { /* optional */ }
    return { node: { version: process.versions.node, ok: Number(process.versions.node.split('.')[0]) >= 22 }, git: { version: gitVersion, installed: Boolean(gitVersion) }, tools, profiles, mcpRegistered, serviceRunning: true, ...this.setupManager.getSetupState() };
  }

  private async getGitVersion(): Promise<string | null> {
    if (this.gitVersion && Date.now() - this.gitVersion.checkedAt < AppService.SETUP_VERSION_CACHE_MS) return this.gitVersion.value;
    if (this.gitVersionCheck) return this.gitVersionCheck;
    this.gitVersionCheck = (async () => {
      let value: string | null = null;
      try {
        const output = await execFileAsync('git', ['--version'], { encoding: 'utf8', timeout: 5000 });
        value = output.stdout.trim();
      } catch { /* optional */ }
      this.gitVersion = { value, checkedAt: Date.now() };
      return value;
    })();
    try { return await this.gitVersionCheck; } finally { this.gitVersionCheck = undefined; }
  }
  installSetupTool(tool: string) { if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng'); return this.setupManager.install(tool); }
  getSetupLogPath(tool: string) { if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng'); return this.setupManager.getLogPath(tool); }
  completeSetup(skip = false) { if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng'); return this.setupManager.complete(skip); }

  private decorateClaudeSessions(rows: ClaudeSessionRow[], activeWithinMin?: number) {
    const min = typeof activeWithinMin === 'number' && !Number.isNaN(activeWithinMin) ? activeWithinMin : (this.config.claudeSessions?.activeWithinMin ?? 10);
    const cutoff = Date.now() - min * 60_000;
    return rows.map((session) => {
      const active = (!!session.lastAt && Date.parse(session.lastAt) >= cutoff) || (!!session.cwd && isClaudeProcessOpen(session.cwd));
      const title = session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId);
      return {
        ...session,
        title,
        active,
        topTasks: this.claudeSessionRepo!.topTasks(session.sessionId),
      };
    });
  }
  listClaudeSessions(activeWithinMin?: number) {
    if (!this.claudeSessionRepo) return [];
    return this.decorateClaudeSessions(this.claudeSessionRepo.list(), activeWithinMin);
  }
  pageClaudeSessions(options?: { activeWithinMin?: number; limit?: string | number; offset?: string | number; cursor?: string; sort?: string; order?: string }) {
    if (!this.claudeSessionRepo) return { items: [], total: 0, nextCursor: null };
    const rawLimit = typeof options?.limit === 'number' ? options.limit : Number(options?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20;
    const rawOffset = typeof options?.offset === 'number' ? options.offset : Number(options?.offset);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const sort = options?.sort === 'title' || options?.sort === 'messages' || options?.sort === 'effectiveTokens' ? options.sort : 'lastAt';
    const order = options?.order === 'asc' ? 'asc' : 'desc';
    const page = this.claudeSessionRepo.page(limit, offset, options?.cursor, sort, order);
    return { ...page, items: this.decorateClaudeSessions(page.items, options?.activeWithinMin) };
  }
  getClaudeSession(id: string, activeWithinMin?: number) {
    if (!this.claudeSessionRepo) throw new HttpError(500, 'internal_error', 'Claude session service chưa sẵn sàng');
    const session = this.claudeSessionRepo.get(id);
    if (!session) throw new HttpError(404, 'not_found', `Claude session "${id}" không tồn tại`);
    const db = this.scheduler.getDatabase();
    if (!db) throw new HttpError(500, 'internal_error', 'Database chưa sẵn sàng');
    const min = typeof activeWithinMin === 'number' && !Number.isNaN(activeWithinMin) ? activeWithinMin : (this.config.claudeSessions?.activeWithinMin ?? 10);
    const cutoff = Date.now() - min * 60_000;
    const active = (!!session.lastAt && Date.parse(session.lastAt) >= cutoff) || (!!session.cwd && isClaudeProcessOpen(session.cwd));
    const title = session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId);
    const turns = db.prepare(`SELECT turnId, MIN(ts) ts, SUM(input) input, SUM(output) output, SUM(cacheCreation) cacheCreation, SUM(cacheRead) cacheRead, SUM(effective) effectiveTokens FROM claude_usage WHERE sessionId=? GROUP BY turnId ORDER BY ts`).all(id) as Array<{ turnId: string; ts: string; input: number; output: number; cacheCreation: number; cacheRead: number; effectiveTokens: number }>;
    return { ...session, title, active, turns: turns.map((turn) => ({ ...turn, tasks: db.prepare('SELECT taskId,effectiveTokens FROM claude_task_usage WHERE sessionId=? AND turnId=?').all(id, turn.turnId) })) };
  }
  setClaudeAutoResume(id: string, enabled: boolean) {
    if (!this.claudeSessionRepo) throw new HttpError(500, 'internal_error', 'Claude session service chưa sẵn sàng');
    const session = this.claudeSessionRepo.get(id);
    if (!session) throw new HttpError(404, 'not_found', `Claude session "${id}" không tồn tại`);
    return this.claudeSessionRepo.setAutoResume(id, enabled);
  }
  async rescanClaudeSessions() { await this.claudeScanner?.scan(); return { ok: true }; }
  getClaudeQuota() {
    const quota = this.claudeSessionRepo?.quota() || { status: null, resetsAt: null, rateLimitType: null, observedAt: null };
    const profiles = (this.claudeSessionRepo?.quotaProfiles() || []).map((row) => ({
      profileName: row.profileName, status: row.status, resetsAt: row.resetsAt, rateLimitType: row.rateLimitType,
      observedAt: row.observedAt, limited: isClaudeQuotaLimited(row.status || undefined), source: 'transcript',
    }));
    const usageByProfile = new Map<string, ReturnType<typeof this.usageService.getAll>>();
    for (const row of this.usageService.getAll()) {
      if (!row.grp.startsWith('Claude')) continue;
      const rows = usageByProfile.get(row.profileName) || [];
      rows.push(row);
      usageByProfile.set(row.profileName, rows);
    }
    for (const [profileName, rows] of usageByProfile) {
      const latestUsageAt = Math.max(...rows.map((row) => row.fetchedAt));
      const usageObservedAt = new Date(latestUsageAt * 1000).toISOString();
      const current = profiles.find((item) => item.profileName === profileName);
      if (!current || !current.observedAt || latestUsageAt * 1000 >= Date.parse(current.observedAt)) {
        const available = hasClaudeQuotaAvailable(rows);
        const resetAt = Math.min(...rows.filter((row) => row.grp.startsWith('Claude')).map((row) => row.resetAt));
        const next = { profileName, status: available ? 'allowed' : 'rejected', resetsAt: Number.isFinite(resetAt) ? resetAt : null, rateLimitType: null, observedAt: usageObservedAt, limited: !available, source: '/usage' };
        if (current) Object.assign(current, next);
        else profiles.push(next);
      }
    }
    for (const profile of this.profileRepo.getAll().filter((item) => item.engine === 'claude' && !profiles.some((row) => row.profileName === item.name))) {
      profiles.push({ profileName: profile.name, status: null, resetsAt: null, rateLimitType: null, observedAt: new Date().toISOString(), limited: false, source: 'chưa quan sát' });
    }
    return { ...quota, limited: isClaudeQuotaLimited(quota.status || undefined), profiles };
  }
  getClaudeFailover() { return this.chatService?.getClaudeFailover() || { active: false, until: null, reason: null, activatedAt: null, evidence: null, lastActivityAt: null }; }
  clearClaudeFailover() {
    if (!this.chatService) throw new HttpError(500, 'internal_error', 'ChatService chưa sẵn sàng');
    return this.chatService.clearClaudeFailover();
  }
  getClaudeToday() {
    const db = this.scheduler.getDatabase();
    if (!db) return { effectiveTokens: 0, sessions: 0, tasks: [] as Array<{ taskId: string; effectiveTokens: number }> };
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const sessions = db.prepare('SELECT DISTINCT sessionId FROM claude_usage WHERE ts >= ?').all(since.toISOString()) as Array<{ sessionId: string }>;
    const tasks = db.prepare('SELECT ctu.taskId, SUM(ctu.effectiveTokens) effectiveTokens FROM claude_task_usage ctu JOIN (SELECT DISTINCT sessionId,turnId FROM claude_usage WHERE ts >= ?) cu ON cu.sessionId=ctu.sessionId AND cu.turnId=ctu.turnId GROUP BY ctu.taskId ORDER BY effectiveTokens DESC LIMIT 5').all(since.toISOString()) as Array<{ taskId: string; effectiveTokens: number }>;
    const total = db.prepare('SELECT COALESCE(SUM(effective),0) effectiveTokens FROM claude_usage WHERE ts >= ?').get(since.toISOString()) as { effectiveTokens: number };
    return { effectiveTokens: total.effectiveTokens, sessions: sessions.length, tasks };
  }

  getClaudeTokenTotals() {
    const db = this.scheduler.getDatabase();
    if (!db) return { today: 0, week: 0 };
    const now = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const week = new Date(today); week.setDate(week.getDate() - 6);
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ts >= ? THEN effective ELSE 0 END), 0) AS today,
        COALESCE(SUM(CASE WHEN ts >= ? THEN effective ELSE 0 END), 0) AS week
      FROM claude_usage
    `).get(today.toISOString(), week.toISOString()) as { today: number; week: number };
    return { today: row.today, week: row.week };
  }

  getClaudeProfileLimitedSessions(profile: ProfileRow) {
    if (!this.claudeSessionRepo) return [];
    const db = this.scheduler.getDatabase();
    if (!db) return [];

    const limitedRows = db.prepare(`
      SELECT sessionId, cwd, title, limitResetAt, autoResumeEnabled
      FROM claude_sessions
      WHERE limitResetAt IS NOT NULL
      ORDER BY limitResetAt ASC
    `).all() as Array<{ sessionId: string; cwd: string; title: string | null; limitResetAt: number; autoResumeEnabled: number }>;

    if (limitedRows.length === 0) return [];

    const scanRows = db.prepare('SELECT path FROM claude_scan_state').all() as Array<{ path: string }>;
    const sessionConfigDirs = new Map<string, string>();
    for (const row of scanRows) {
      const sid = path.basename(row.path, '.jsonl');
      const configDir = path.dirname(path.dirname(path.dirname(row.path)));
      sessionConfigDirs.set(sid, path.resolve(configDir));
    }

    const defaultClaudeConfigDir = path.resolve(os.homedir(), '.claude');
    const isSystemProfile = profile.kind === 'system' || !profile.home || path.resolve(profile.home) === path.resolve(os.homedir()) || path.resolve(profile.home) === defaultClaudeConfigDir;
    const profileHome = profile.home ? path.resolve(profile.home) : null;
    const profileClaudeDir = profileHome ? path.join(profileHome, '.claude') : null;

    const matched = limitedRows.filter((row) => {
      const configDir = sessionConfigDirs.get(row.sessionId);
      if (isSystemProfile) {
        return !configDir || configDir === defaultClaudeConfigDir;
      }
      if (!configDir || !profileHome) return false;
      return configDir === profileHome || configDir === profileClaudeDir;
    });

    return matched.map((row) => ({
      sessionId: row.sessionId,
      title: row.title || (row.sessionId.length > 8 ? row.sessionId.slice(0, 8) : row.sessionId),
      cwd: row.cwd,
      limitResetAt: row.limitResetAt,
      autoResumeEnabled: row.autoResumeEnabled === 1,
    }));
  }

  // --- Savings ---
  getSavings(query?: { project?: string; since?: string }) {
    if (!this.savingsService) {
      throw new HttpError(500, 'internal_error', 'SavingsService chưa được khởi tạo');
    }
    return this.savingsService.getSavings(query);
  }

  // --- Daily Usage ---
  getDailyUsage(days = 7) {
    const db = this.scheduler.getDatabase();
    if (!db) {
      throw new HttpError(500, 'internal_error', 'Database chưa sẵn sàng');
    }
    return getDailyUsageReport({
      days,
      db,
      profileRepo: this.profileRepo,
      quotaMarkRepo: this.quotaMarkRepo,
      scheduler: this.scheduler,
      config: this.config,
    });
  }

  // --- Status ---
  getStatus() {
    const tasks = this.taskRepo.getAll();
    const profiles = this.profileRepo.getAll();
    const quotaMarks = this.quotaMarkRepo.getActive();
    const dupes = this.coreProfileService.getDuplicateEmails();
    const runningMap = this.scheduler.getRunning();
    const projects = this.projectRepo.getAll();

    const byStatus: Record<string, number> = {
      running: 0,
      checking: 0,
      review: 0,
      waiting_quota: 0,
      failed: 0,
      queued: 0,
      draft: 0,
      done: 0,
      blocked: 0,
      cancelled: 0,
      focusWaiting: 0,
    };

    const tasksByProject: Record<string, Record<string, number>> = {};
    for (const p of projects) {
      tasksByProject[p.id] = {
        draft: 0,
        queued: 0,
        running: 0,
        checking: 0,
        review: 0,
        done: 0,
        blocked: 0,
        failed: 0,
        cancelled: 0,
        waiting_quota: 0,
      };
    }

    const focusWaitingTaskIds = new Set<string>();
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (t.waitReason === 'focus') focusWaitingTaskIds.add(t.id);
      if (!tasksByProject[t.projectId]) {
        tasksByProject[t.projectId] = {
          draft: 0,
          queued: 0,
          running: 0,
          checking: 0,
          review: 0,
          done: 0,
          blocked: 0,
          failed: 0,
          cancelled: 0,
          waiting_quota: 0,
        };
      }
      tasksByProject[t.projectId][t.status] = (tasksByProject[t.projectId][t.status] || 0) + 1;
    }

    for (const [taskId, runtime] of runningMap.entries()) {
      if (runtime.paused && runtime.pauseReason === 'focus') focusWaitingTaskIds.add(taskId);
    }
    byStatus.focusWaiting = focusWaitingTaskIds.size;

    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    const now = Date.now();
    if (!this.worktreeUsageCache || now - this.worktreeUsageCache.at >= 15_000) {
      const byStatus: Record<string, { count: number; bytes: number }> = {};
      let count = 0;
      let bytes = 0;
      for (const task of tasks) {
        if (!task.worktreePath || !fs.existsSync(task.worktreePath)) continue;
        const size = worktreeBytes(task.worktreePath);
        const current = byStatus[task.status] || { count: 0, bytes: 0 };
        current.count += 1;
        current.bytes += size;
        byStatus[task.status] = current;
        count += 1;
        bytes += size;
      }
      this.worktreeUsageCache = { at: now, value: { count, bytes, byStatus } };
    }

    const runningTasks = Array.from(runningMap.values()).map((r) => {
      const task = taskMap.get(r.taskId) || taskMap.get(toTaskId(r.taskId)) || taskMap.get(r.taskId.replace('/', '~'));
      return {
        taskId: r.taskId,
        runId: r.runId,
        profileName: r.profileName,
        model: r.model,
        engine: r.engine.id,
        startedAt: new Date(r.startTime).toISOString(),
        elapsedMs: Date.now() - r.startTime,
        lastActivityAt: new Date(r.lastActivityAt).toISOString(),
        activitySource: r.activitySource,
        noCommitMinutes: r.noCommitMinutes ?? null,
        isLooping: r.isLooping ?? false,
        loopingCommand: r.loopingCommand ?? null,
        title: task?.title ?? '',
        projectId: task?.projectId ?? (r.projectId || (r.taskId.includes('/') ? r.taskId.split('/')[0] : '')),
        slug: task?.slug ?? (r.taskId.includes('/') ? r.taskId.slice(r.taskId.indexOf('/') + 1) : r.taskId),
        worktreePath: task?.worktreePath ?? null,
        rss: r.rss ?? 0,
        cpu: r.cpu ?? 0,
        paused: Boolean(r.paused),
        pauseReason: r.pauseReason ?? null,
      };
    });

    const profilesStatus = profiles.map((p) => {
      const marks = quotaMarks.filter((m) => m.profileName === p.name);
      const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === p.name);
      const slots = this.lockService.getSlotsSync(p);
      return {
        ...apiProfile(p),
        quotaMarks: marks,
        slotsUsed: Math.max(slots.slotsUsed, isBusy ? 1 : 0),
        slotsTotal: slots.slotsTotal,
        busy: slots.busy || isBusy,
        usage: this.usageService.getForProfile(p.name),
        ...(p.engine === 'claude' ? {
          claudeTokens: this.getClaudeTokenTotals(),
          limitedSessions: this.getClaudeProfileLimitedSessions(p),
        } : {}),
        duplicateWarning: dupes.has(accountKey(p) || ''),
        duplicateEmailWith: (dupes.get(accountKey(p) || '') || []).filter((name) => name !== p.name),
      };
    });

    const recentRows = this.eventRepo.getRecent(30);
    const recentEvents = recentRows.map((e) => {
      let parsedPayload: unknown = null;
      if (e.payload) {
        try {
          parsedPayload = JSON.parse(e.payload);
        } catch {
          parsedPayload = e.payload;
        }
      }
      return {
        id: e.id,
        ts: toApiTime(e.ts)!,
        type: e.type,
        taskId: e.taskId,
        summary: formatEventSummary(e.type, parsedPayload, e.taskId, quotaMarks),
      };
    });

    const diskReader = this.scheduler ? this.scheduler.getDiskReader() : getDiskSpaceSync;
    const disk = diskReader(this.config.worktreesDir);
    const worktreeRoots = [this.config.worktreesDir, ...this.projectRepo.getAll().flatMap((project) => projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir))];
    const disks = getMonitoredDisks(worktreeRoots, this.config.disk.minFreeGB, this.config.disk.extraPaths, process.env.NODE_ENV !== 'test', diskReader);
    const runningTaskIds = runningTasks.map((r) => r.taskId);
    const overlaps = this.taskNoteRepo
      ? this.taskNoteRepo.getActiveOverlaps(runningTaskIds).map(apiTaskNote)
      : [];

    return {
      tasks: byStatus,
      tasksByProject,
      profiles: profilesStatus,
      running: runningTasks,
      overlaps,
      claudeFailover: this.chatService?.getClaudeFailover(),
      codexReviewer: this.scheduler.getReviewerStatus(),
      recentEvents,
      brain: this.brainService?.getStatus(),
      schedulerPaused: this.scheduler.isPaused(),
      focus: this.config.focus,
      disk: {
        freeGB: disk.freeGB,
        totalGB: disk.totalGB,
        minFreeGB: this.config.disk.minFreeGB,
      },
      disks,
      worktrees: this.worktreeUsageCache.value,
      load: this.scheduler.getLoadStatus(),
      telegram: {
        enabled: this.config.telegram?.enabled ?? false,
        allowedChatsCount: this.config.telegram?.allowedChatIds?.length ?? 0,
        hasToken: Boolean(this.telegramBotService?.hasValidToken()),
      },
      tools: this.config.tools,
    };
  }

  getOrphans() {
    const tasks = this.taskRepo.getAll();
    const running = new Set(this.scheduler.getRunning().keys());
    const projects = this.projectRepo.getAll();
    const protectedPaths = [this.config.hubHome, ...projects.map((project) => project.path)];
    const roots = [this.config.worktreesDir, ...projects.flatMap((project) => projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir))];
    const processes = listAllWorktreeProcesses({ worktreesDir: roots, protectedPaths });
    return processes
      .map((process) => {
        const cwd = process.cwd.replace(/ \(deleted\)$/, '');
        const task = tasks.find((candidate) => candidate.worktreePath && (cwd === candidate.worktreePath || cwd.startsWith(candidate.worktreePath + path.sep)));
        return { ...process, task: task ? { id: task.id, title: task.title, status: task.status } : null, active: task ? running.has(task.id) : false };
      })
      .filter((process) => !process.active);
  }

  reapOrphans() {
    const orphans = this.getOrphans();
    const projects = this.projectRepo.getAll();
    const protectedPaths = [this.config.hubHome, ...projects.map((project) => project.path)];
    const roots = [this.config.worktreesDir, ...projects.flatMap((project) => projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir))];
    const reaped: number[] = [];
    for (const orphan of orphans) {
      reaped.push(...reapSyncForWorktree(orphan.cwd.replace(/ \(deleted\)$/, ''), {
        worktreesDir: roots,
        protectedPaths,
      }));
    }
    return { ok: true, reaped: [...new Set(reaped)] };
  }

  // --- Projects ---
  listProjects(includeArchived = false): ProjectRow[] {
    const projects = includeArchived ? this.projectRepo.getAllIncludingArchived() : this.projectRepo.getAll();
    return projects.map((p) => ({ ...apiProject(p, this.config.hubHome, this.ciRepo), afterMerge: this.config.deploy?.[p.id] || null } as ProjectRow));
  }

  inspectProject(raw: unknown) {
    const input = z.object({ path: z.string().min(1) }).parse(raw);
    if (!path.isAbsolute(input.path)) throw new HttpError(400, 'bad_request', 'Đường dẫn phải là đường dẫn tuyệt đối');
    return inspectProject(input.path);
  }

  writeProjectGuidance(id: string, raw: unknown) {
    const input = z.object({ content: z.string().min(1).max(32_000), confirm: z.literal(true) }).parse(raw);
    const project = this.projectRepo.get(id);
    if (!project) throw new HttpError(404, 'not_found', `Project "${id}" không tồn tại`);
    const target = path.join(project.path, 'AGENTS.md');
    if (fs.existsSync(target)) throw new HttpError(409, 'conflict', 'AGENTS.md đã tồn tại trong project');
    fs.writeFileSync(target, input.content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    return { ok: true };
  }

  sanitizeErrorText(raw: unknown): string {
    if (!raw) return 'Đã xảy ra lỗi không xác định';
    let str = typeof raw === 'string' ? raw : (raw instanceof Error ? raw.message : String(raw));
    const lines = str.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('at ')) return false;
      if (/\b(?:node_modules|\w+\.(?:ts|js|mjs|tsx|jsx)):\d+:\d+\b/.test(trimmed)) return false;
      return true;
    });
    str = filtered.join('\n').trim();
    str = str.replace(/^Error:\s*/, '');
    return str || 'Đã xảy ra lỗi không xác định';
  }

  summarizeProjectContext(id: string, raw: unknown): { taskId: string; status: string; summary: string | null } {
    const input = z.object({
      sessions: z.array(z.string().min(1)).min(1),
      selections: z.array(z.object({ session: z.string().min(1), text: z.string().min(1).max(4_000) })).max(100).optional(),
      notes: z.string().optional(),
    }).parse(raw);
    const project = this.projectRepo.get(id);
    if (!project) throw new HttpError(404, 'not_found', `Project "${id}" không tồn tại`);

    const sessionContext = input.sessions.map((session) => {
      const excerpt = readClaudeSessionExcerpt(project.path, session);
      if (excerpt === null) {
        throw new HttpError(400, 'bad_request', `Phiên Claude không hợp lệ hoặc không còn tồn tại: ${session}`);
      }
      return [`### ${session}`, excerpt || 'Phiên không có nội dung văn bản; chỉ dùng các mục người dùng đã chọn bên dưới.'].join('\n');
    });

    const body = [
      'Read the selected previous session files and summarize durable project knowledge.',
      'The session excerpts below are the approved input. Do not access ~/.claude or any other session file directly.',
      '',
      'Selected session excerpts:',
      ...sessionContext,
      ...(input.selections?.length ? ['', 'Selected transcript items:', ...input.selections.map((item) => `- ${item.session}: ${item.text}`)] : []),
      ...(input.notes ? ['', 'Additional notes:', input.notes] : []),
    ].join('\n');

    const taskId = `${project.id}/summarize-previous-context`;
    const existing = this.taskRepo.get(taskId);
    if (existing) {
      if (existing.status === 'done') {
        const summary = existing.doneReport?.trim() || null;
        return { taskId: existing.id, status: existing.status, summary };
      }
      if (existing.status === 'running') {
        return { taskId: existing.id, status: existing.status, summary: null };
      }
      // Re-queue existing task for retry
      this.taskRepo.update(taskId, {
        status: 'queued',
        resume: 1,
        attempt: existing.attempt + 1,
        transientRetries: 0,
        notBefore: null,
        body,
        reviewerChangesRequested: 0,
        reviewerEscalated: 0,
        reviewerEscalatedAt: null,
        reviewerEscalationReason: null,
      });
      if (existing.worktreePath) {
        for (const marker of ['DONE', 'BLOCKED']) {
          try {
            fs.unlinkSync(path.join(existing.worktreePath, '.agenthub', marker));
          } catch {
            // Marker is absent or already removed.
          }
        }
      }
      this.scheduler.getEventBus().emit('task.queued', taskId, { reason: 'retry' });
      this.scheduler.triggerTick();
      const updated = this.taskRepo.get(taskId)!;
      return { taskId: updated.id, status: updated.status, summary: null };
    }

    const task = this.createTask({
      project: project.id,
      slug: 'summarize-previous-context',
      title: 'Review and summarize previous Claude Code context',
      body,
      level: 'easy',
      start: true,
    });
    return { taskId: task.id, status: task.status, summary: null };
  }

  async getProjectContextSummary(projectId: string, taskIdParam: string): Promise<{ taskId: string; status: string; summary: string | null; error?: string; waitReason?: string }> {
    const project = this.projectRepo.get(projectId);
    if (!project) throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    const taskId = toTaskId(taskIdParam);
    const task = this.taskRepo.get(taskId);
    if (!task || task.projectId !== projectId || !task.slug.startsWith('summarize-previous-context')) {
      throw new HttpError(404, 'not_found', 'Task tóm tắt không tồn tại');
    }
    const detail = await this.getTask(taskId);
    const summary = detail.doneContent?.trim() || null;
    let error: string | undefined = undefined;
    if (task.status === 'failed' || task.status === 'blocked') {
      const rawError = detail.blockedContent?.trim() || task.reviewerEscalationReason || 'Task tóm tắt thất bại trong quá trình thực thi.';
      error = this.sanitizeErrorText(rawError);
    } else if (task.status === 'waiting_quota') {
      error = 'Chưa có engine khả dụng hoặc đang hết quota.';
    }
    return {
      taskId,
      status: task.status,
      summary,
      ...(error ? { error } : {}),
      ...(task.waitReason ? { waitReason: task.waitReason } : {}),
    };
  }

  createNewProject(raw: unknown): ProjectRow {
    const input = z.object({
      name: z.string().min(1), path: z.string().min(1), defaultBranch: z.string().min(1).default('main'),
      maxParallel: z.number().int().positive().default(3), checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(), settings: ProjectSettingsInputSchema.optional(),
    }).parse(raw);
    if (!path.isAbsolute(input.path)) throw new HttpError(400, 'bad_request', 'Đường dẫn phải là đường dẫn tuyệt đối');
    try { createNewGitProject(input.path, input.defaultBranch); } catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : String(error)); }
    try {
      return this.createProject({ ...input, path: path.resolve(input.path) });
    } catch (error) {
      try { fs.rmSync(path.resolve(input.path), { recursive: true, force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  getProject(id: string): ProjectRow {
    const proj = this.projectRepo.get(id);
    if (!proj) {
      throw new HttpError(404, 'not_found', `Project "${id}" không tồn tại`);
    }
    return { ...apiProject(proj, this.config.hubHome, this.ciRepo), afterMerge: this.config.deploy?.[proj.id] || null } as ProjectRow;
  }

  getDeployStatus(id: string) {
    this.getProject(id);
    return this.deployService?.getStatus(id) || null;
  }

  getDeployStatuses() {
    return this.deployService?.getAllStatus() || [];
  }

  rerunDeploy(id: string) {
    this.getProject(id);
    if (!this.deployService) throw new HttpError(503, 'unavailable', 'Deploy service chưa sẵn sàng');
    return this.deployService.rerun(id);
  }

  async pushDeployNow(id: string) {
    this.getProject(id);
    if (!this.deployService) throw new HttpError(503, 'unavailable', 'Deploy service chưa sẵn sàng');
    return this.deployService.pushNow(id);
  }

  createProject(raw: unknown): ProjectRow {
    const parseResult = CreateProjectSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new HttpError(400, 'bad_request', parseResult.error.issues[0]?.message || 'Dữ liệu project không hợp lệ');
    }
    const parsed = parseResult.data;
    if (this.departmentRepo && !this.departmentRepo.get(parsed.departmentId)) {
      throw new HttpError(400, 'bad_request', `Department "${parsed.departmentId}" không tồn tại`);
    }
    const id = parsed.id || parsed.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const existing = this.projectRepo.getIncludingArchived(id);
    if (existing && !existing.archivedAt) {
      throw new HttpError(409, 'conflict', `Project ID "${id}" đã tồn tại`);
    }

    if (!path.isAbsolute(parsed.path)) {
      throw new HttpError(400, 'bad_request', `Đường dẫn repo phải là đường dẫn tuyệt đối: ${parsed.path}`);
    }

    const resolvedPath = path.resolve(parsed.path);
    if (!fs.existsSync(resolvedPath)) {
      throw new HttpError(400, 'bad_request', `Thư mục repo không tồn tại: ${resolvedPath}`);
    }

    const effectiveSettings = parsed.settings ? mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, parsed.settings) : DEFAULT_PROJECT_SETTINGS;
    if (effectiveSettings.worktree.root) {
      const worktreeRoot = path.resolve(effectiveSettings.worktree.root);
      const projectStorageRoot = path.join(path.dirname(resolvedPath), '.agenthub-worktrees');
      if (worktreeRoot === projectStorageRoot && !fs.existsSync(worktreeRoot)) {
        try {
          fs.mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
        } catch (error) {
          throw new HttpError(400, 'bad_request', `Không thể tạo thư mục worktree: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try { validateProjectWorktreeRoot(effectiveSettings.worktree.root, resolvedPath, this.config.hubHome); }
      catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : String(error)); }
    }
    if (effectiveSettings.integration.enabled || effectiveSettings.integration.branch) {
      validateIntegrationBranch(effectiveSettings.integration.branch || 'agenthub/integration', parsed.defaultBranch);
    }

    let isGitRepo = false;
    if (fs.existsSync(path.join(resolvedPath, '.git'))) {
      isGitRepo = true;
    } else {
      try {
        const topLevel = execFileSync('git', ['-C', resolvedPath, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (topLevel) {
          isGitRepo = true;
        }
      } catch {
        isGitRepo = false;
      }
    }
    if (!isGitRepo) {
      throw new HttpError(400, 'bad_request', `Thư mục không phải là git repository: ${resolvedPath}`);
    }

    let branchExists = false;
    try {
      execFileSync('git', ['-C', resolvedPath, 'rev-parse', '--verify', parsed.defaultBranch], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      branchExists = true;
    } catch {
      try {
        const headBranch = execFileSync('git', ['-C', resolvedPath, 'symbolic-ref', '--short', 'HEAD'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (headBranch === parsed.defaultBranch) {
          branchExists = true;
        }
      } catch {
        branchExists = false;
      }
    }
    if (!branchExists) {
      throw new HttpError(400, 'bad_request', `Nhánh mặc định "${parsed.defaultBranch}" không tồn tại trong repository`);
    }

    const archived = this.projectRepo.getAllIncludingArchived().find(
      (project) => project.archivedAt && path.resolve(project.path) === resolvedPath,
    );
    if (existing?.archivedAt && !archived) {
      throw new HttpError(409, 'conflict', `Project ID "${id}" đã tồn tại dưới dạng dự án đã ẩn; hãy dùng đúng đường dẫn để khôi phục`);
    }
    if (archived) {
      this.projectRepo.restore(archived.id);
      this.projectRepo.update(archived.id, {
        name: parsed.name,
        defaultBranch: parsed.defaultBranch,
        envTemplate: parsed.envTemplate || null,
        maxParallel: parsed.maxParallel,
        departmentId: parsed.departmentId,
      });
      this.invalidateOutOfScopeClaudeScanStates();
      return this.getProject(archived.id);
    }

    this.projectRepo.insert({
      id,
      name: parsed.name,
      path: resolvedPath,
      defaultBranch: parsed.defaultBranch,
      envTemplate: parsed.envTemplate || null,
      maxParallel: parsed.maxParallel,
      checks: parsed.checks ? JSON.stringify(parsed.checks) : null,
      hooks: parsed.hooks ? JSON.stringify(parsed.hooks) : null,
      merge: parsed.merge ? JSON.stringify(parsed.merge) : null,
      reviewChain: parsed.reviewChain ? JSON.stringify(parsed.reviewChain) : null,
      review: parsed.review ? JSON.stringify(parsed.review) : null,
      settings: parsed.settings ? JSON.stringify(effectiveSettings) : null,
      departmentId: parsed.departmentId,
    });

    if (effectiveSettings.integration.enabled) {
      const projLike = { id, path: resolvedPath, defaultBranch: parsed.defaultBranch, settings: JSON.stringify(effectiveSettings) };
      ensureIntegrationWorktree(projLike, this.config.hubHome);
      if (effectiveSettings.worktree.install === 'auto') {
        void ensureIntegrationNodeModules(projLike, this.config.hubHome, {
          cacheDir: this.config.cacheDir,
          cacheMaxEntries: this.config.cacheMaxEntries,
          cacheMaxGB: this.config.cacheMaxGB,
        }).catch((err) => {
          console.warn(`[projects] Failed to prepare integration node_modules: ${String(err)}`);
        });
      }
    }

    this.invalidateOutOfScopeClaudeScanStates();
    const created = this.getProject(id);
    void this.telegramBotService?.ensureProjectTopic(id);
    return created;
  }

  updateProject(id: string, raw: unknown): ProjectRow {
    this.getProject(id);
    const parseResult = UpdateProjectSchema.safeParse(raw);
    if (!parseResult.success) {
      throw new HttpError(400, 'bad_request', parseResult.error.issues[0]?.message || 'Dữ liệu cập nhật project không hợp lệ');
    }
    const parsed = parseResult.data;
    const current = this.projectRepo.get(id)!;
    if (parsed.departmentId && this.departmentRepo && !this.departmentRepo.get(parsed.departmentId)) {
      throw new HttpError(400, 'bad_request', `Department "${parsed.departmentId}" không tồn tại`);
    }
    const effectiveDefaultBranch = parsed.defaultBranch ?? current.defaultBranch;
    const mergedSettings = parsed.settings === undefined
      ? projectSettings(current)
      : mergeProjectSettings(projectSettings(current), parsed.settings);

    if (mergedSettings.worktree.root) {
      try { validateProjectWorktreeRoot(mergedSettings.worktree.root, current.path, this.config.hubHome); }
      catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : String(error)); }
    }

    if (mergedSettings.integration.enabled || mergedSettings.integration.branch) {
      validateIntegrationBranch(mergedSettings.integration.branch || 'agenthub/integration', effectiveDefaultBranch);
    }

    this.projectRepo.update(id, {
      ...parsed,
      // Partial settings merge over what is stored, so callers can change one switch at a time.
      settings: parsed.settings === undefined ? undefined : JSON.stringify(mergedSettings),
      checks: parsed.checks === undefined ? undefined : parsed.checks ? JSON.stringify(parsed.checks) : null,
      hooks: parsed.hooks === undefined ? undefined : parsed.hooks ? JSON.stringify(parsed.hooks) : null,
      merge: parsed.merge === undefined ? undefined : parsed.merge ? JSON.stringify(parsed.merge) : null,
      reviewChain: parsed.reviewChain === undefined ? undefined : parsed.reviewChain ? JSON.stringify(parsed.reviewChain) : null,
      review: parsed.review === undefined ? undefined : parsed.review ? JSON.stringify(parsed.review) : null,
    });

    if (parsed.departmentId !== undefined && parsed.departmentId !== current.departmentId) {
      this.scheduler.getEventBus().emit('department.changed', undefined, {
        projectId: id,
        fromDepartmentId: current.departmentId,
        departmentId: parsed.departmentId,
        action: 'project_moved',
      });
    }

    if (mergedSettings.integration.enabled) {
      const updatedProject = this.projectRepo.get(id)!;
      ensureIntegrationWorktree(updatedProject, this.config.hubHome);
      if (mergedSettings.worktree.install === 'auto') {
        void ensureIntegrationNodeModules(updatedProject, this.config.hubHome, {
          cacheDir: this.config.cacheDir,
          cacheMaxEntries: this.config.cacheMaxEntries,
          cacheMaxGB: this.config.cacheMaxGB,
        }).catch((err) => {
          console.warn(`[projects] Failed to prepare integration node_modules: ${String(err)}`);
        });
      }
    }

    this.invalidateOutOfScopeClaudeScanStates();
    return this.getProject(id);
  }

  restoreProject(id: string): ProjectRow {
    const project = this.projectRepo.getIncludingArchived(id);
    if (!project) throw new HttpError(404, 'not_found', `Project "${id}" không tồn tại`);
    if (project.archivedAt && this.taskNoteRepo) {
      for (const note of this.taskNoteRepo.getByProject(id)) {
        if (!note.content.startsWith('project_archive_status:')) continue;
        try {
          const saved = JSON.parse(note.content.slice('project_archive_status:'.length)) as { status?: string; waitReason?: string | null };
          if (saved.status) {
            this.taskRepo.update(note.taskId, { status: saved.status, waitReason: saved.waitReason as TaskRow['waitReason'] });
          }
        } catch {
          // Ignore malformed historical notes.
        }
      }
    }
    this.projectRepo.restore(id);
    this.invalidateOutOfScopeClaudeScanStates();
    return this.getProject(id);
  }

  deleteProject(id: string, options?: { purge?: boolean; confirm?: string }): { ok: boolean; archived?: boolean; counts?: Record<string, number>; warnings?: string[] } {
    const proj = this.projectRepo.get(id);
    if (!proj) {
      throw new HttpError(404, 'not_found', `Project "${id}" không tồn tại`);
    }

    const projectTasks = this.taskRepo.getAll().filter((task) => task.projectId === id);
    const runningMap = this.scheduler.getRunning();
    const runningTasks = projectTasks.filter((task) => ['running', 'checking'].includes(task.status));
    for (const running of runningMap.values()) {
      if (running.projectId === id && !runningTasks.some((task) => task.id === running.taskId)) {
        const task = this.taskRepo.get(running.taskId);
        if (task) runningTasks.push({ ...task, status: 'running' });
        else throw new HttpError(409, 'conflict', `Không thể xóa project khi còn task đang chạy: ${running.taskId}`);
      }
    }
    if (runningTasks.length > 0) {
      throw new HttpError(409, 'conflict', `Không thể xóa project khi còn task đang chạy (running/checking): ${runningTasks.map((task) => task.id).join(', ')}`);
    }

    const deleteData = this.projectRepo.getDeleteData(id);
    if (!options?.purge) {
      const tasksToPause = projectTasks.filter((task) =>
        ['draft', 'queued', 'waiting_quota', 'review'].includes(task.status),
      );
      for (const task of tasksToPause) {
        this.taskRepo.update(task.id, { status: 'paused' });
        this.taskNoteRepo?.insert({
          projectId: id,
          taskId: task.id,
          kind: 'note',
          content: `project_archive_status:${JSON.stringify({ status: task.status, waitReason: task.waitReason || null })}`,
        });
        this.scheduler.getEventBus().emit('task.paused', task.id, {
          reason: 'project_archived',
          projectId: id,
        });
      }
      this.projectRepo.archive(id);
      this.brainRunner?.stopProject(id);
      const warning = removeIntegrationWorktree(proj, this.config.hubHome);
      this.invalidateOutOfScopeClaudeScanStates();
      const hasData = Object.values(deleteData.counts).some((count) => count > 0);
      return warning
        ? { ok: true, ...(hasData ? { archived: true, counts: deleteData.counts } : {}), warnings: [warning] }
        : { ok: true, ...(hasData ? { archived: true, counts: deleteData.counts } : {}) };
    }

    if (options.confirm !== id) {
      throw new HttpError(400, 'bad_request', `Xóa vĩnh viễn cần confirm đúng tên định danh: ${id}`);
    }

    const warnings: string[] = [];
    const integrationWarning = removeIntegrationWorktree(proj, this.config.hubHome);
    if (integrationWarning) warnings.push(integrationWarning);
    for (const task of deleteData.tasks) {
      if (!task.worktreePath || !fs.existsSync(task.worktreePath)) continue;
      let dirty = true;
      try {
        dirty = execFileSync('git', ['-C', task.worktreePath, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().length > 0;
      } catch { /* keep dirty=true when status cannot be checked */ }
      if (dirty) {
        warnings.push(`Giữ worktree ${task.worktreePath} vì có thay đổi chưa commit`);
        continue;
      }
      const removed = new WorktreeService(this.config, this.scheduler.getEventBus()).remove(
        proj.path,
        task.worktreePath,
        { projectId: id, taskId: task.id, slug: task.slug },
        projectWorktreeRoots(proj, this.config.hubHome, this.config.worktreesDir),
      );
      if (!removed) warnings.push(`Không thể gỡ worktree ${task.worktreePath}; đã giữ nguyên`);
    }

    const logRoot = path.resolve(this.config.logsDir);
    for (const task of deleteData.tasks) {
      const logPath = path.resolve(logRoot, task.id);
      const relative = path.relative(logRoot, logPath);
      if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && fs.existsSync(logPath)) {
        try { fs.rmSync(logPath, { recursive: true, force: true }); } catch { warnings.push(`Không thể dọn log ${logPath}`); }
      }
    }

    try {
      this.projectRepo.purge(id);
    } catch {
      throw new HttpError(409, 'conflict', 'Không thể xóa dữ liệu dự án vì còn liên kết dữ liệu; không có dữ liệu nào bị xóa');
    }
    this.brainRunner?.stopProject(id);
    this.invalidateOutOfScopeClaudeScanStates();
    return { ok: true, counts: deleteData.counts, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  private invalidateOutOfScopeClaudeScanStates() {
    try { this.scheduler.getDatabase()?.prepare('DELETE FROM claude_scan_state WHERE eligible=0').run(); } catch { /* migration may not exist yet */ }
  }

  private emailCheckCache = new Map<string, number>();

  /**
   * Lấy ảnh Google cho hồ sơ agy đăng nhập qua terminal (ngoại lệ DEC-007); chỉ gọi từ thao tác của người dùng.
   * `message` giải thích kết quả để hiện thông báo, không bao giờ chứa token.
   */
  async syncAgyAvatarFromToken(name: string): Promise<{ avatarUrl: string | null; message: string }> {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.engine !== 'agy') return { avatarUrl: null, message: 'Không phải hồ sơ Antigravity' };
    if (profile.kind !== 'isolated' || !profile.home) {
      return { avatarUrl: profile.avatarUrl ?? null, message: 'Hồ sơ dùng keyring nên không lấy được ảnh đại diện' };
    }
    const token = inspectAgyAccessToken(profile.home);
    if ('skip' in token) {
      const reasons: Record<typeof token.skip, string> = {
        no_token_file: 'Chưa có file token của agy, hãy đăng nhập trước',
        unreadable: 'File token của agy không đúng định dạng JSON',
        no_access_token: 'File token của agy không có access_token',
        expired: 'Access token đã hết hạn; chạy một task hoặc bấm Check để agy làm mới rồi thử lại',
      };
      const fields = token.fieldNames?.length ? ` (các trường: ${token.fieldNames.slice(0, 12).join(', ')})` : '';
      return { avatarUrl: profile.avatarUrl ?? null, message: reasons[token.skip] + fields };
    }
    const { info, status } = await fetchAgyGoogleUserInfoDetailed(token.accessToken);
    if (!info) {
      const message = status === 0
        ? 'Không kết nối được tới Google'
        : status === 401
          ? 'Google báo access token không hợp lệ hoặc đã hết hạn (HTTP 401)'
          : status === 403
            ? 'Token của agy không có quyền đọc ảnh hồ sơ Google (HTTP 403)'
            : `Google trả lỗi HTTP ${status}`;
      return { avatarUrl: profile.avatarUrl ?? null, message };
    }
    if (!info.picture) return { avatarUrl: profile.avatarUrl ?? null, message: 'Google không trả về ảnh đại diện (token thiếu quyền profile hoặc tài khoản chưa đặt ảnh)' };
    if (info.email && profile.email && info.email.toLowerCase() !== profile.email.toLowerCase()) {
      return { avatarUrl: profile.avatarUrl ?? null, message: `Token thuộc tài khoản khác (${info.email}), bỏ qua ảnh` };
    }
    if (info.picture !== profile.avatarUrl) {
      this.profileRepo.updateAvatarUrl(name, info.picture);
      this.scheduler.getEventBus().emit('profile.updated', undefined, { name, avatarUrl: info.picture });
      return { avatarUrl: info.picture, message: 'Đã cập nhật ảnh đại diện' };
    }
    return { avatarUrl: info.picture, message: 'Ảnh đại diện đã là mới nhất' };
  }

  refreshProfileEmail(name: string): string | null {
    let profile: ProfileRow | undefined;
    try {
      profile = this.profileRepo.get(name);
    } catch {
      return null;
    }
    if (!profile) return null;

    if (profile.engine === 'claude') {
      const account = this.coreProfileService.readClaudeAccount(profile.home || os.homedir());
      if (account?.email && account.email !== profile.email) {
        this.profileRepo.upsert({ ...profile, email: account.email });
        this.scheduler.getEventBus().emit('profile.updated', undefined, { name: profile.name, email: account.email });
      }
      return account?.email || profile.email || null;
    }

    const logDir =
      profile.kind === 'keyring'
        ? this.config.defaultLogDir
        : path.join(
            profile.home || path.join(this.config.agyHomesDir, profile.name),
            '.gemini',
            'antigravity-cli',
            'log',
          );

    const email = this.coreProfileService.readEmailFromLog(logDir);
    if (email) {
      if (email !== profile.email) {
        try {
          this.profileRepo.upsert({ ...profile, email });
          // Ảnh đại diện thuộc tài khoản cũ; chỉ lấy lại được khi đăng nhập bằng refresh token.
          if (profile.avatarUrl) this.profileRepo.updateAvatarUrl(profile.name, null);
        } catch {
          return email;
        }
        const dupes = this.coreProfileService.getDuplicateEmails();
        const duplicateWarning = dupes.has(`${profile.engine}:${email}`);
        this.scheduler.getEventBus().emit('profile.updated', undefined, {
          name: profile.name,
          email,
          duplicateWarning,
        });
        this.scheduler.wakeWaitingQuotaTasks('profile_login');
      }
      this.emailCheckCache.set(name, Date.now());
      return email;
    }
    return profile.email || null;
  }

  // --- Profiles ---
  listProfiles() {
    const profiles = this.profileRepo.getAll();
    const now = Date.now();
    for (const p of profiles) {
      if (p.engine === 'claude') {
        const account = this.coreProfileService.readClaudeAccount(p.home || os.homedir());
        if (account?.email && account.email !== p.email) {
          this.profileRepo.upsert({ ...p, email: account.email });
          p.email = account.email;
        }
      }
      if (p.engine === 'agy' && !p.email && this.isProfileLoggedIn(p)) {
        const lastCheck = this.emailCheckCache.get(p.name) || 0;
        if (now - lastCheck > 30_000) {
          this.emailCheckCache.set(p.name, now);
          const email = this.refreshProfileEmail(p.name);
          if (email) {
            p.email = email;
          }
        }
      }
      if (p.engine === 'codex' && !p.email && this.isProfileLoggedIn(p)) {
        // ChatGPT logins often print no email, so a short retry would spawn the CLI on every poll.
        const lastCheck = this.emailCheckCache.get(p.name) || 0;
        if (now - lastCheck > CODEX_EMAIL_RECHECK_MS) {
          this.emailCheckCache.set(p.name, now);
          void this.refreshCodexEmail(p);
        }
      }
    }

    const quotaMarks = this.quotaMarkRepo.getActive();
    const dupes = this.coreProfileService.getDuplicateEmails();
    const runningMap = this.scheduler.getRunning();

    return profiles.map((p) => {
      const claudeAccount = p.engine === 'claude' ? this.coreProfileService.readClaudeAccount(p.home || os.homedir()) : null;
      const marks = quotaMarks.filter((m) => m.profileName === p.name);
      const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === p.name);
      const slots = this.lockService.getSlotsSync(p);
      return {
        ...apiProfile(p),
        loggedIn: this.isProfileLoggedIn(p),
        quotaMarks: marks,
        slotsUsed: Math.max(slots.slotsUsed, isBusy ? 1 : 0),
        slotsTotal: slots.slotsTotal,
        busy: slots.busy || isBusy,
        usage: this.usageService.getForProfile(p.name),
        ...(p.engine === 'claude' ? {
          claudeTokens: this.getClaudeTokenTotals(),
          limitedSessions: this.getClaudeProfileLimitedSessions(p),
        } : {}),
        duplicateWarning: dupes.has(accountKey(p) || ''),
        duplicateEmailWith: (dupes.get(accountKey(p) || '') || []).filter((name) => name !== p.name),
        ...(claudeAccount?.plan ? { claudePlan: claudeAccount.plan } : {}),
      };
    });
  }

  createProfile(raw: unknown): ProfileRow {
    const parsed = CreateProfileSchema.parse(raw);
    if (!this.config.multiplePerProvider && parsed.accountType === 'personal') {
      const existing = this.profileRepo.getAll().find((profile) =>
        profile.engine === parsed.engine &&
        profile.accountType === 'personal' &&
        isProfileLoggedIn(profile),
      );
      if (existing) {
        throw new HttpError(
          409,
          'provider_policy',
          `Đã có tài khoản ${providerLabel(parsed.engine)} cá nhân: ${existing.label || existing.name}. Bật 'Cho phép nhiều tài khoản' trong Cài đặt, hoặc chọn loại Team/API.`,
        );
      }
    }
    if (this.profileRepo.get(parsed.name)) {
      if (!this.profileRepo.isDeleted(parsed.name)) {
        throw new HttpError(409, 'conflict', `Hồ sơ "${parsed.name}" đã tồn tại`);
      }
      // Re-adding a deleted profile brings the same name back.
      this.profileRepo.restore(parsed.name);
    }

    this.coreProfileService.createProfile(parsed.name, parsed.engine, parsed.accountType);
    this.scheduler.getEventBus().emit('profile.created', undefined, { name: parsed.name });
    this.scheduler.wakeWaitingQuotaTasks('profile_created');

    return apiProfile(this.profileRepo.get(parsed.name)!);
  }

  /**
   * verify: chạy Check bằng agy cho từng hồ sơ nhập thành công (kết quả về qua sự kiện profile.check).
   * CLI tắt vì nó đóng DB ngay sau khi nhập.
   */
  async importAgyTokens(raw: unknown, options: { verify?: boolean } = {}): Promise<{
    success: boolean;
    total: number;
    successCount: number;
    failedCount: number;
    results: Array<{
      name: string;
      email: string;
      action: 'created' | 'updated' | 'skipped';
      status: 'ok' | 'error';
      message?: string;
    }>;
  }> {
    let payload: unknown = raw;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        throw new HttpError(400, 'bad_request', 'Dữ liệu không phải là chuỗi JSON hợp lệ');
      }
    }

    const payloadObj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const accountType: 'personal' | 'team' | 'api' =
      typeof payloadObj.accountType === 'string' && ['personal', 'team', 'api'].includes(payloadObj.accountType)
        ? (payloadObj.accountType as 'personal' | 'team' | 'api')
        : 'personal';

    let rawList: unknown[] = [];
    if (Array.isArray(payload)) {
      rawList = payload;
    } else if (Array.isArray(payloadObj.tokens)) {
      rawList = payloadObj.tokens;
    } else if (typeof payloadObj.tokens === 'string') {
      try {
        const parsed = JSON.parse(payloadObj.tokens);
        rawList = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw new HttpError(400, 'bad_request', 'Trường "tokens" không phải là JSON hợp lệ');
      }
    } else if (payloadObj.refresh_token || payloadObj.refreshToken || payloadObj.token) {
      rawList = [payloadObj];
    } else {
      throw new HttpError(
        400,
        'bad_request',
        'Dữ liệu token không hợp lệ (cần mảng JSON hoặc object chứa email và refresh_token)',
      );
    }

    if (rawList.length === 0) {
      throw new HttpError(400, 'bad_request', 'Danh sách token trống');
    }

    const results: Array<{
      name: string;
      email: string;
      action: 'created' | 'updated' | 'skipped';
      status: 'ok' | 'error';
      message?: string;
    }> = [];
    const fail = (name: string, email: string, message: string) =>
      results.push({ name, email, action: 'skipped', status: 'error', message });

    for (const rawItem of rawList) {
      if (!rawItem || typeof rawItem !== 'object') {
        fail('', '', 'Mục dữ liệu không phải là object hợp lệ');
        continue;
      }
      const item = rawItem as Record<string, unknown>;

      const emailRaw = item.email || item.Email || item.mail;
      if (!emailRaw || typeof emailRaw !== 'string' || !emailRaw.includes('@')) {
        fail('', typeof emailRaw === 'string' ? emailRaw : '', 'Địa chỉ email không hợp lệ hoặc thiếu');
        continue;
      }
      const email = emailRaw.trim().toLowerCase();

      const refreshTokenRaw = item.refresh_token || item.refreshToken || item.token;
      if (!refreshTokenRaw || typeof refreshTokenRaw !== 'string' || !refreshTokenRaw.trim()) {
        fail('', email, 'Thiếu refresh_token');
        continue;
      }
      const refreshToken = refreshTokenRaw.trim();

      // Chỉ cập nhật hồ sơ agy isolated; không bao giờ ghi token vào hồ sơ keyring hay engine khác.
      const isAgyIsolated = (p: ProfileRow) => p.engine === 'agy' && p.kind === 'isolated';
      const sameEmail = (p: ProfileRow) => (p.email || '').toLowerCase() === email;
      const customName = String(item.name || item.profile_name || item.profileName || '').trim();
      let targetName = '';
      if (customName) {
        if (!/^[a-zA-Z0-9_-]+$/.test(customName)) {
          fail(customName, email, 'Tên hồ sơ chỉ được chứa chữ, số, "_" và "-"');
          continue;
        }
        const existing = this.profileRepo.get(customName);
        if (existing && !isAgyIsolated(existing)) {
          fail(customName, email, `Hồ sơ "${customName}" đã tồn tại và không phải hồ sơ Antigravity riêng`);
          continue;
        }
        targetName = customName;
      } else {
        const all = this.profileRepo.getAll(true).filter((p) => isAgyIsolated(p) && sameEmail(p));
        const match = all.find((p) => !p.deletedAt) || all[0];
        if (match) {
          targetName = match.name;
        } else {
          const base = email.split('@')[0].replace(/[^a-z0-9_-]/g, '_') || 'agy_account';
          targetName = base;
          for (let idx = 2; this.profileRepo.get(targetName); idx++) targetName = `${base}_${idx}`;
        }
      }

      const existing = this.profileRepo.get(targetName);
      const action: 'created' | 'updated' = existing && !existing.deletedAt ? 'updated' : 'created';

      // Cùng chính sách với createProfile: không tạo thêm hồ sơ cá nhân khi multiplePerProvider tắt.
      if (action === 'created' && !this.config.multiplePerProvider && accountType === 'personal') {
        const personal = this.profileRepo.getAll().find((p) =>
          p.engine === 'agy' && p.accountType === 'personal' && isProfileLoggedIn(p),
        );
        if (personal) {
          fail(
            targetName,
            email,
            `Đã có tài khoản Gemini cá nhân: ${personal.label || personal.name}. Bật 'Cho phép nhiều tài khoản' trong Cài đặt, hoặc chọn loại Team/API.`,
          );
          continue;
        }
      }

      // Xác thực và đổi access_token qua Google OAuth
      let exchanged: Awaited<ReturnType<typeof exchangeAgyRefreshToken>>;
      try {
        exchanged = await exchangeAgyRefreshToken(refreshToken);
      } catch (err: unknown) {
        fail(targetName, email, err instanceof Error ? err.message : String(err));
        continue;
      }

      // Lấy Google user info (bao gồm avatar / picture)
      let avatarUrl: string | null = null;
      try {
        const userInfo = await fetchAgyGoogleUserInfo(exchanged.accessToken);
        if (userInfo?.picture) {
          avatarUrl = userInfo.picture;
        }
      } catch {
        // bỏ qua nếu không lấy được ảnh
      }

      if (action === 'created') {
        if (existing) this.profileRepo.restore(targetName);
        this.coreProfileService.createProfile(targetName, 'agy', accountType);
      }
      const current = this.profileRepo.get(targetName)!;
      writeAgyIsolatedToken(current.home || path.join(this.config.agyHomesDir, targetName), exchanged, email);
      // Giữ ảnh cũ chỉ khi vẫn là cùng tài khoản; đổi tài khoản mà không lấy được ảnh thì xoá ảnh cũ.
      const nextAvatar = avatarUrl ?? (sameEmail(current) ? current.avatarUrl ?? null : null);
      this.profileRepo.upsert({ ...current, email });
      this.profileRepo.updateAvatarUrl(targetName, nextAvatar);
      // Google đã nhận refresh token; agy có dùng được file token hay không thì Check bên dưới xác nhận.
      this.profileRepo.updateAuthState(targetName, 'ok', 'Đã xác thực qua refresh token', null);

      if (action === 'created') {
        this.scheduler.getEventBus().emit('profile.created', undefined, { name: targetName });
      } else {
        this.scheduler.getEventBus().emit('profile.updated', undefined, { name: targetName, email, avatarUrl: nextAvatar });
      }

      results.push({
        name: targetName,
        email,
        action,
        status: 'ok',
        message: `${action === 'updated' ? 'Cập nhật token thành công' : 'Thêm tài khoản thành công'}${options.verify === false ? '' : ' · đang kiểm tra với agy'}`,
      });
    }

    if (options.verify !== false) {
      for (const item of results) {
        if (item.status !== 'ok') continue;
        try {
          this.startProfileCheck(item.name);
        } catch {
          // Đang có lượt kiểm tra khác cho hồ sơ này; kết quả của nó cũng phản ánh token mới.
        }
      }
    }

    return {
      success: results.some((r) => r.status === 'ok'),
      total: rawList.length,
      successCount: results.filter((r) => r.status === 'ok').length,
      failedCount: results.filter((r) => r.status === 'error').length,
      results,
    };
  }

  deleteProfile(name: string, purgeHome = false): { ok: boolean } {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.deletedAt) throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    if (profile.kind === 'system') {
      throw new HttpError(400, 'bad_request', 'Không thể xóa hồ sơ hệ thống');
    }
    // Hồ sơ keyring dùng HOME thật: chỉ ẩn khỏi hub, không bao giờ xoá thư mục (DEC-008).
    if (profile.kind === 'keyring') purgeHome = false;

    const runningMap = this.scheduler.getRunning();
    const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === name);
    const hasReviewer = this.scheduler.reviewerRunsForProfile(name);
    if (isBusy || hasReviewer) {
      throw new HttpError(409, 'conflict', `Không thể xóa hồ sơ "${name}" đang chạy task`);
    }

    try {
      this.coreProfileService.deleteProfile(name, purgeHome);
    } catch (error) {
      throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : String(error));
    }
    this.emailCheckCache.delete(name);
    this.profileChecks.delete(name);
    this.scheduler.getEventBus().emit('profile.deleted', undefined, { name });
    return { ok: true };
  }

  renameProfile(name: string, raw: unknown): ProfileRow {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.deletedAt) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }

    const parsed = RenameProfileSchema.parse(raw);
    const newName = parsed.newName;
    if (newName === name) {
      return apiProfile(profile);
    }

    const existing = this.profileRepo.get(newName);
    if (existing) {
      throw new HttpError(409, 'conflict', `Hồ sơ "${newName}" đã tồn tại`);
    }

    const runningMap = this.scheduler.getRunning();
    const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === name);
    const hasReviewer = this.scheduler.reviewerRunsForProfile(name);
    if (isBusy || hasReviewer) {
      throw new HttpError(409, 'conflict', `Không thể đổi tên hồ sơ "${name}" đang chạy task`);
    }

    let newHome: string | undefined;
    let oldHomeToRollback: string | undefined;

    if (profile.home && fs.existsSync(profile.home)) {
      const managedRoots = [
        path.resolve(this.config.agyHomesDir),
        path.resolve(this.config.hubHome, 'codex-homes'),
        path.resolve(this.config.hubHome, 'claude-homes'),
      ];

      let realHome: string;
      try {
        realHome = fs.realpathSync(profile.home);
      } catch {
        realHome = path.resolve(profile.home);
      }

      const matchedRoot = managedRoots.find((rootPath) => {
        try {
          const realRoot = fs.existsSync(rootPath) ? fs.realpathSync(rootPath) : rootPath;
          if (realHome === realRoot) return false;
          const rel = path.relative(realRoot, realHome);
          return !!rel && rel !== '.' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
        } catch {
          return false;
        }
      });

      if (matchedRoot) {
        const targetDir = path.join(path.dirname(profile.home), newName);
        if (fs.existsSync(targetDir)) {
          throw new HttpError(409, 'conflict', `Thư mục "${targetDir}" đã tồn tại trên đĩa`);
        }
        try {
          fs.renameSync(profile.home, targetDir);
          newHome = targetDir;
          oldHomeToRollback = profile.home;
        } catch (err) {
          throw new HttpError(500, 'internal_error', `Không thể đổi tên thư mục: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    try {
      this.profileRepo.rename(name, newName, newHome);
    } catch (err) {
      if (oldHomeToRollback && newHome) {
        try {
          fs.renameSync(newHome, oldHomeToRollback);
        } catch {
          // ignore rollback failure
        }
      }
      throw err;
    }

    this.emailCheckCache.delete(name);
    this.profileChecks.delete(name);

    this.scheduler.getEventBus().emit('profile.updated', undefined, { name: newName, oldName: name });

    return apiProfile(this.profileRepo.get(newName)!);
  }

  private codexEmailChecks = new Map<string, Promise<string | null>>();

  /** Reads the Codex account email in the background; one check per profile at a time, never blocking the event loop. */
  private refreshCodexEmail(profile: ProfileRow): Promise<string | null> {
    if (profile.engine !== 'codex') return Promise.resolve(null);
    const running = this.codexEmailChecks.get(profile.name);
    if (running) return running;
    const codexPath = process.env.AGENTHUB_CODEX_BIN || CodexEngine.findCodexPath();
    if (!codexPath) return Promise.resolve(null);
    const checkEnv: NodeJS.ProcessEnv = { ...process.env };
    if (profile.kind === 'isolated' && profile.home) {
      checkEnv.CODEX_HOME = profile.home;
    }
    const check = execFileAsync(codexPath, ['login', 'status'], { env: checkEnv, timeout: 5000, encoding: 'utf8' })
      .then(({ stdout, stderr }) => {
        const parsed = parseCodexLoginStatus(`${stdout}${stderr}`);
        if (parsed.email && parsed.email !== profile.email) {
          this.profileRepo.upsert({ ...profile, email: parsed.email });
          return parsed.email;
        }
        return null;
      })
      .catch(() => null)
      .finally(() => this.codexEmailChecks.delete(profile.name));
    this.codexEmailChecks.set(profile.name, check);
    return check;
  }

  startProfileCheck(name: string): { started: true } {
    const profile = this.profileRepo.get(name);
    if (!profile) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }
    if (this.profileChecks.has(name)) {
      throw new HttpError(409, 'conflict', `Hồ sơ "${name}" đang được kiểm tra`);
    }
    this.profileChecks.add(name);
    void this.runProfileCheck(profile).finally(() => this.profileChecks.delete(name));
    return { started: true };
  }

  private async runProfileCheck(profile: ProfileRow): Promise<void> {
    const startedAt = Date.now();
    let ok = false;
    let message = '';
    let output = '';
    let email = profile.email || undefined;

    try {
      if (profile.engine === 'agy') {
        const result = await this.usageService.check(profile);
        output = result.output;
        const auth = parseAuthState(output, result.entries.length > 0);
        this.profileRepo.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
        ok = auth.authState === 'ok';
        if (result.error && /timed out|timeout/i.test(result.error)) {
          message = 'Kiểm tra /usage quá thời gian 60 giây';
        } else if (auth.authState === 'needs_verification') {
          message = 'Cần xác minh tài khoản';
        } else if (auth.authState === 'not_logged_in') {
          message = 'Hồ sơ chưa đăng nhập hoặc xác thực thất bại';
        } else if (!ok) {
          message = result.error || 'Kiểm tra thất bại';
        } else {
          message = 'Kiểm tra thành công';
        }
        const refreshedEmail = this.refreshProfileEmail(profile.name);
        if (refreshedEmail) email = refreshedEmail;
      } else if (profile.engine === 'claude') {
        // Claude profiles: login state comes from the Claude config dir, not from the Codex CLI.
        const account = this.coreProfileService.readClaudeAccount(profile.home || os.homedir());
        if (!isProfileLoggedIn(profile)) {
          message = 'Chưa đăng nhập Claude';
          // Drop an email left by an earlier wrong check (it used to report the Codex/ChatGPT login).
          if (profile.email) {
            this.profileRepo.upsert({ ...profile, email: null });
            email = undefined;
          }
          this.profileRepo.updateAuthState(profile.name, 'not_logged_in', message, null);
        } else {
          ok = true;
          if (account?.email) {
            email = account.email;
            if (account.email !== profile.email) this.profileRepo.upsert({ ...profile, email: account.email });
          }
          this.profileRepo.updateAuthState(profile.name, 'ok', null, null);
          const usage = await this.usageService.collectClaude(profile, true);
          message = account?.plan ? `Đã đăng nhập Claude (${account.plan})` : 'Đã đăng nhập Claude';
          if (usage.length === 0) message += ' · chưa đọc được quota /usage';
        }
      } else {
        const codexPath = process.env.AGENTHUB_CODEX_BIN || CodexEngine.findCodexPath();
        if (!codexPath) {
          message = 'Không tìm thấy Codex CLI';
          this.profileRepo.updateAuthState(profile.name, 'error', message, null);
        } else {
          const checkEnv: NodeJS.ProcessEnv = { ...process.env };
          if (profile.kind === 'isolated' && profile.home) {
            checkEnv.CODEX_HOME = profile.home;
          }
          try {
            const result = await execFileAsync(codexPath, ['login', 'status'], {
              env: checkEnv,
              timeout: 20_000,
            });
            output = `${result.stdout}${result.stderr}`;
            const parsed = parseCodexLoginStatus(output);
            if (parsed.notLoggedIn) {
              ok = false;
              message = 'Chưa đăng nhập';
              this.profileRepo.updateAuthState(profile.name, 'not_logged_in', message, null);
            } else {
              ok = true;
              message = parsed.plan ? `Đã đăng nhập (${parsed.plan})` : 'Đã đăng nhập';
              if (parsed.email) {
                email = parsed.email;
                this.profileRepo.upsert({ ...profile, email: parsed.email });
              }
              this.profileRepo.updateAuthState(profile.name, 'ok', null, null);
            }
          } catch (execErr) {
            const err = execErr as { stdout?: string; stderr?: string; message?: string };
            output = `${err.stdout || ''}${err.stderr || ''}`;
            const parsed = parseCodexLoginStatus(output);
            if (parsed.notLoggedIn) {
              ok = false;
              message = 'Chưa đăng nhập';
              this.profileRepo.updateAuthState(profile.name, 'not_logged_in', message, null);
            } else {
              try {
                const verResult = await execFileAsync(codexPath, ['--version'], { env: checkEnv, timeout: 5000 });
                output = `${verResult.stdout}${verResult.stderr}`;
                ok = true;
                message = output.trim() || 'Codex CLI sẵn sàng';
                this.profileRepo.updateAuthState(profile.name, 'ok', null, null);
              } catch {
                ok = false;
                message = err.message || 'Kiểm tra thất bại';
                this.profileRepo.updateAuthState(profile.name, 'error', message, null);
              }
            }
          }
        }
      }
    } catch (error) {
      const err = error as { message?: string; stdout?: string; stderr?: string };
      output = `${err.stdout || ''}${err.stderr || ''}`;
      const auth = parseAuthState(output, false);
      this.profileRepo.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
      message = /timed out|timeout/i.test(err.message || '')
        ? 'Kiểm tra quá thời gian cho phép'
        : err.message || 'Kiểm tra thất bại';
    }

    const updatedProfile = this.profileRepo.get(profile.name);
    this.scheduler.getEventBus().emit('profile.check', undefined, {
      name: profile.name,
      ok,
      message: message || (ok ? 'Kiểm tra thành công' : 'Kiểm tra thất bại'),
      ...(email ? { email } : {}),
      durationMs: Date.now() - startedAt,
      authState: updatedProfile?.authState ?? null,
      verifyUrl: updatedProfile?.verifyUrl ?? null,
    });
    this.scheduler.getEventBus().emit('profile.updated', undefined, {
      name: profile.name,
      email: updatedProfile?.email ?? null,
      authState: updatedProfile?.authState ?? null,
      authMessage: updatedProfile?.authMessage ?? null,
      verifyUrl: updatedProfile?.verifyUrl ?? null,
    });
  }

  private isProfileLoggedIn(profile: ProfileRow): boolean {
    return isProfileLoggedIn(profile);
  }

  async refreshUsage(name: string) {
    const profile = this.profileRepo.get(name);
    if (!profile) throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    if (profile.engine === 'codex') this.usageService.collectCodex(profile);
    else if (profile.engine === 'claude') await this.usageService.collectClaude(profile, true);
    else await this.usageService.collect(profile);
    this.refreshProfileEmail(profile.name);
    const avatar = profile.engine === 'agy'
      ? await this.syncAgyAvatarFromToken(profile.name).catch(() => ({ avatarUrl: null, message: 'Không lấy được ảnh đại diện' }))
      : null;
    const refreshed = this.listProfiles().find((p) => p.name === name);
    return refreshed && avatar ? { ...refreshed, avatarMessage: avatar.message } : refreshed;
  }

  updateProfile(name: string, raw: unknown): ProfileRow {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.deletedAt) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }

    const parsed = UpdateProfileSchema.parse(raw);
    const updates: Partial<Pick<ProfileRow, 'label' | 'notes' | 'priority' | 'enabled'>> = {};

    let wasDisabled = false;
    let enabledNum: number | undefined;
    if (parsed.enabled !== undefined) {
      enabledNum = typeof parsed.enabled === 'boolean' ? (parsed.enabled ? 1 : 0) : parsed.enabled;
      updates.enabled = enabledNum;
      wasDisabled = profile.enabled === 0;
    }
    if (parsed.label !== undefined) {
      updates.label = parsed.label;
    }
    if (parsed.notes !== undefined) {
      updates.notes = parsed.notes;
    }
    if (parsed.priority !== undefined) {
      updates.priority = parsed.priority;
    }

    this.profileRepo.update(name, updates);

    this.scheduler.getEventBus().emit('profile.updated', undefined, {
      name,
      ...(enabledNum !== undefined ? { enabled: enabledNum } : {}),
      ...(parsed.label !== undefined ? { label: parsed.label } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    });

    // When re-enabling a profile, wake up waiting_quota tasks
    if (wasDisabled && enabledNum === 1) {
      this.scheduler.wakeWaitingQuotaTasks('profile_enabled');
    }

    return apiProfile(this.profileRepo.get(name)!);
  }

  markQuota(name: string, raw: unknown) {
    const profile = this.profileRepo.get(name);
    if (!profile) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }
    const parsed = MarkQuotaSchema.parse(raw);
    const seconds = parsed.seconds || 5 * 3600;
    if (this.coreProfileService.markQuota(name, parsed.family, seconds, parsed.reason)) {
      const engine = profile.engine;
      this.scheduler.getEventBus().emit('quota.exhausted', undefined, {
        profile: name,
        family: parsed.family,
        engine,
        allExhausted: new QuotaService(this.quotaMarkRepo, this.profileRepo)
          .allProfilesForEngineExhausted(engine, parsed.family),
      });
    }
    return { ok: true };
  }

  clearQuota(name: string, family: string) {
    const profile = this.profileRepo.get(name);
    if (!profile) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }
    this.quotaMarkRepo.clear(name, family);
    this.scheduler.getEventBus().emit('quota.cleared', undefined, { profile: name, family });
    this.scheduler.wakeWaitingQuotaTasks('quota_cleared');
    return { ok: true };
  }

  // --- Tasks ---
  private decorateTasks(tasks: TaskRow[]): TaskRow[] {
    const projects = new Map(this.projectRepo.getAll().map((project) => [project.id, project]));
    const running = this.scheduler.getRunning();
    return tasks.map((task) => {
      const run = running.get(task.id);
      const project = projects.get(task.projectId);
      let reviewChain = parseReviewChain(project?.reviewChain);
      if (project?.review) {
        try { reviewChain = parseReviewChain(JSON.stringify((JSON.parse(project.review) as { chain?: unknown }).chain || [])); } catch { /* invalid settings are ignored */ }
      }
      // Keep this lookup scoped to the task. A global recent-event window can
      // forget an older fallback after unrelated events push it out of that window.
      const isFallback = this.eventRepo?.getByTask(task.id).some((event) => event.type === 'review.fallback') ?? false;
      const fallbackEvent = this.eventRepo?.getByTask(task.id).filter((event) => event.type === 'review.fallback').at(-1);
      let fallbackReviewer: 'codex' | 'claude' = 'claude';
      if (fallbackEvent?.payload) {
        try { fallbackReviewer = JSON.parse(fallbackEvent.payload).to === 'codex' ? 'codex' : 'claude'; } catch { /* legacy payload */ }
      }
      const configuredOrder = reviewerSettingsFromLegacy(this.config.reviewer as unknown as Record<string, unknown>).order;
      const projectOrder = project ? projectSettings(project).review?.order : undefined;
      const reviewerRun = this.scheduler?.getReviewerRun?.(task.id);
      const reviewer = reviewerRun
        ? (reviewerRun.engine.id === 'claude' ? 'claude' : 'codex')
        : (isFallback ? fallbackReviewer : (reviewChain[task.reviewStep ?? 0]?.reviewer?.startsWith('claude') ? 'claude' : (projectOrder || configuredOrder)[task.reviewStep ?? 0]?.engine || 'codex'));
      return {
        ...apiTask(task),
        reviewChain,
        reviewer,
        checks: this.scheduler.getCheckResults(task.id),
        paused: Boolean(run?.paused),
        pauseReason: run?.pauseReason ?? null,
        currentRun: run ? {
          startedAt: new Date(run.startTime).toISOString(),
          lastOutputAt: new Date(run.lastOutputAt).toISOString(),
          lastActivityAt: new Date(run.lastActivityAt).toISOString(),
          activitySource: run.activitySource,
          noCommitMinutes: run.noCommitMinutes ?? null,
          isLooping: run.isLooping ?? false,
          loopingCommand: run.loopingCommand ?? null,
          paused: Boolean(run.paused),
          pauseReason: run.pauseReason ?? null,
          rss: run.rss ?? 0,
          cpu: run.cpu ?? 0,
        } : null,
      };
    }) as TaskRow[];
  }

  listTasks(filter?: { project?: string; status?: string }): TaskRow[] {
    return this.decorateTasks(this.taskRepo.list(filter));
  }

  listTasksPage(filter?: { project?: string; status?: string; search?: string; limit?: string | number; cursor?: string; offset?: string | number; sort?: string; order?: string }): PageResult<TaskRow> {
    const page = this.taskRepo.page(filter);
    return { ...page, items: this.decorateTasks(page.items) };
  }

  getTasksGraph(options?: { project?: string; includeDone?: string | boolean }) {
    const tasks = this.listTasks({ project: options?.project });
    const filtered = filterTasksForGraph(tasks, options);
    return computeTaskGraph(filtered);
  }

  async getTask(idParam: string) {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const runs = this.runRepo.getByTask(taskId);
    const reviews = this.reviewRepo.getByTask(taskId);

    let doneContent: string | null = null;
    let blockedContent: string | null = null;

    if (task.doneReport !== null && task.doneReport !== undefined) {
      doneContent = task.doneReport;
    } else if (task.worktreePath && fs.existsSync(task.worktreePath)) {
      const donePath = path.join(task.worktreePath, '.agenthub', 'DONE');
      const blockedPath = path.join(task.worktreePath, '.agenthub', 'BLOCKED');
      if (fs.existsSync(donePath)) {
        try {
          doneContent = fs.readFileSync(donePath, 'utf-8');
        } catch {
          // ignore
        }
      }
      if (fs.existsSync(blockedPath)) {
        try {
          blockedContent = fs.readFileSync(blockedPath, 'utf-8');
        } catch {
          // ignore
        }
      }
    }

    // Task history remains readable after its project is archived.
    const project = this.projectRepo.getIncludingArchived(task.projectId);
    const configuredMerge = project ? hasConfiguredMerge(project, task.baseRef || project.defaultBranch) : false;
    const reviewSettings = project?.review ? (() => {
      try { return JSON.parse(project.review!) as { chain?: unknown; maxRounds?: number }; } catch { return null; }
    })() : null;
    let commits: string[] = [];
    if (project && task.branch) {
      const baseRef = task.baseRef || project.defaultBranch;
      commits = await getGitCommits(project.path, baseRef, task.branch);
    }

    const activeRun = this.scheduler.getRunning().get(taskId);
    let modelWarnings: string[] = [];
    try {
      const chain = task.modelChain ? JSON.parse(task.modelChain) as unknown : [];
      if (Array.isArray(chain)) {
        modelWarnings = chain.filter((model): model is string => typeof model === 'string' && !isKnownModel(model));
      }
    } catch {
      modelWarnings = ['modelChain không phải JSON hợp lệ'];
    }

    const events = (this.eventRepo ? this.eventRepo.getByTask(taskId) : []).map((e) => {
      let parsedPayload: unknown = null;
      if (e.payload) {
        try {
          parsedPayload = JSON.parse(e.payload);
        } catch {
          parsedPayload = e.payload;
        }
      }
      return {
        id: e.id,
        ts: toApiTime(e.ts)!,
        type: e.type,
        taskId: e.taskId,
        payload: parsedPayload,
      };
    });

    const completedReviewEvents = events.filter((event) => event.type === 'review.completed');
    const reviewsWithModels = reviews.map((review) => {
      const event = completedReviewEvents.find((candidate) => {
        if (!candidate.payload || typeof candidate.payload !== 'object') return false;
        const payload = candidate.payload as { actor?: string; verdict?: string; model?: string };
        return payload.actor === review.actor && payload.verdict === review.verdict && typeof payload.model === 'string';
      });
      const model = event && typeof event.payload === 'object' && event.payload
        ? (event.payload as { model?: string }).model
        : undefined;
      return model ? { ...review, model } : review;
    });

    const isFallback = events.some((e) => e.type === 'review.fallback');
    const reviewerRun = this.scheduler?.getReviewerRun?.(taskId);
    const activeReviewChain: ReviewChainStep[] = (Array.isArray(reviewSettings?.chain) ? reviewSettings.chain as ReviewChainStep[] : undefined) || parseReviewChain(project?.reviewChain);
    const fallbackEvent = events.filter((event) => event.type === 'review.fallback').at(-1);
    const fallbackReviewer = fallbackEvent && typeof fallbackEvent.payload === 'object' && fallbackEvent.payload && (fallbackEvent.payload as { to?: string }).to === 'codex' ? 'codex' : 'claude';
    const configuredOrder = reviewerSettingsFromLegacy(this.config.reviewer as unknown as Record<string, unknown>).order;
    const projectOrder = project ? projectSettings(project).review?.order : undefined;
    const reviewer = reviewerRun
      ? (reviewerRun.engine.id === 'claude' ? 'claude' : 'codex')
      : (isFallback ? fallbackReviewer : (reviews.at(-1)?.actor === 'claude-reviewer' ? 'claude' : (activeReviewChain[task.reviewStep ?? 0]?.reviewer?.startsWith('claude') ? 'claude' : (projectOrder || configuredOrder)[task.reviewStep ?? 0]?.engine || 'codex')));

    return {
      ...apiTask(task),
      reviewer,
      events,
      paused: Boolean(activeRun?.paused),
      pauseReason: activeRun?.pauseReason ?? null,
      currentRun: activeRun ? {
        startedAt: new Date(activeRun.startTime).toISOString(),
        lastOutputAt: new Date(activeRun.lastOutputAt).toISOString(),
        lastActivityAt: new Date(activeRun.lastActivityAt).toISOString(),
        activitySource: activeRun.activitySource,
        noCommitMinutes: activeRun.noCommitMinutes ?? null,
        isLooping: activeRun.isLooping ?? false,
        loopingCommand: activeRun.loopingCommand ?? null,
        paused: Boolean(activeRun.paused),
        pauseReason: activeRun.pauseReason ?? null,
        rss: activeRun.rss ?? 0,
        cpu: activeRun.cpu ?? 0,
      } : null,
      runs: runs.map(apiRun),
      reviews: reviewsWithModels.map(apiReview),
      reviewChain: reviewSettings?.chain || parseReviewChain(project?.reviewChain),
      mergeAvailable: configuredMerge,
      mergeUnavailableReason: configuredMerge ? null : 'Project chưa cấu hình merge tự động. Mở Cài đặt dự án → Integration để bật.',
      reviewStep: task.reviewStep ?? 0,
      reviewMaxRounds: reviewSettings?.maxRounds || 2,
      doneContent,
      blockedContent,
      modelWarnings,
      commits,
      worktreePath: task.worktreePath,
      checks: this.scheduler.getCheckResults(taskId),
      sourceRef: task.sourceRef ? JSON.parse(task.sourceRef) : null,
      derivedTasks: this.taskRepo.getDerivedFrom(taskId).map(apiTask),
      claudeCost: (() => { const measured = this.claudeSessionRepo?.taskCost(taskId); return measured ? { measured: measured.effectiveTokens > 0, ...measured } : { measured: false, effectiveTokens: 0, sessions: 0 }; })(),
    };
  }

  createTask(raw: unknown): TaskRow {
    const parsed = CreateTaskSchema.parse(raw);
    const project = this.projectRepo.get(parsed.project);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${parsed.project}" không tồn tại`);
    }

    const taskId = `${parsed.project}/${parsed.slug}`;
    if (this.taskRepo.get(taskId)) {
      throw new HttpError(409, 'conflict', `Task "${taskId}" đã tồn tại`);
    }

    let initialStatus = parsed.start ? 'queued' : 'draft';
    let batchId = parsed.batchId || null;

    if (parsed.fromClaude && parsed.start && !batchId && !this.config.planning?.requireApproval && this.taskBatchRepo) {
      initialStatus = 'queued';
      const sessionId = parsed.sessionId || null;
      const recent = sessionId
        ? this.taskBatchRepo.list(parsed.project, 'dispatched').find((batch) => {
            if (batch.createdBy !== 'claude-auto' || !batch.goal) return false;
            const tasks = this.taskRepo.getByBatch(batch.id);
            return tasks.some((task) => task.creationSessionId === sessionId &&
              Math.abs(Date.parse(task.createdAt.replace(' ', 'T') + 'Z') - Date.now()) <= 30 * 60 * 1000);
          })
        : undefined;
      const goal = parsed.goal?.trim() || parsed.title;
      if (recent) {
        batchId = recent.id;
      } else {
        const newBatchId = `batch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        this.taskBatchRepo.create({
          id: newBatchId,
          projectId: parsed.project,
          title: goal.length > 100 ? `${goal.slice(0, 97)}...` : goal,
          goal,
          status: 'dispatched',
          createdBy: 'claude-auto',
        });
        batchId = newBatchId;
        const payload = { batchId: newBatchId, projectId: parsed.project, title: goal, goal, taskCount: 0, createdBy: 'claude-auto' };
        this.eventRepo.insert('batch.created', undefined, payload);
        this.scheduler.getEventBus().emit('batch.created', undefined, payload);
      }
    }

    if (parsed.fromClaude && this.config.planning?.requireApproval) {
      initialStatus = 'draft';
      if (!batchId && this.taskBatchRepo) {
        const existingDraftBatches = this.taskBatchRepo.list(parsed.project, 'draft')
          .filter((b) => b.createdBy === 'claude');
        if (existingDraftBatches.length > 0) {
          batchId = existingDraftBatches[0].id;
        } else {
          const newBatchId = `batch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          this.taskBatchRepo.create({
            id: newBatchId,
            projectId: parsed.project,
            title: `Kế hoạch đề xuất: ${parsed.title}`,
            goal: `Tạo từ Claude qua hub_create_task`,
            status: 'draft',
            createdBy: 'claude',
          });
          batchId = newBatchId;
          const payload = {
            batchId: newBatchId,
            projectId: parsed.project,
            title: `Kế hoạch đề xuất: ${parsed.title}`,
            taskCount: 1,
            createdBy: 'claude',
          };
          this.eventRepo.insert('batch.created', undefined, payload);
          this.scheduler.getEventBus().emit('batch.created', undefined, payload);
        }
      }
    }

    this.taskRepo.insert({
      id: taskId,
      projectId: parsed.project,
      slug: parsed.slug,
      title: parsed.title,
      externalRef: parsed.externalRef,
      body: parsed.body,
      level: parsed.level,
      modelChain: parsed.modelChain ? JSON.stringify(parsed.modelChain) : undefined,
      baseRef: parsed.baseRef,
      branch: parsed.branch,
      dependsOn: parsed.dependsOn,
      status: initialStatus,
      sourceRef: parsed.sourceRef ? JSON.stringify(parsed.sourceRef) : null,
      batchId,
      creationSessionId: parsed.fromClaude ? parsed.sessionId || null : null,
      creationGoal: parsed.fromClaude ? parsed.goal || null : null,
    });

    if (initialStatus === 'queued') {
      this.scheduler.getEventBus().emit('task.queued', taskId);
      this.scheduler.triggerTick();
    }

    return this.taskRepo.get(taskId)!;
  }

  captureTask(raw: unknown): TaskRow {
    const parsed = CaptureTaskSchema.parse(raw);
    const sourceTaskId = toTaskId(parsed.sourceTaskId);
    const source = this.taskRepo.get(sourceTaskId);
    if (!source) throw new HttpError(404, 'not_found', `Task nguồn "${sourceTaskId}" không tồn tại`);
    const project = this.projectRepo.get(source.projectId);
    if (!project) throw new HttpError(404, 'not_found', `Project "${source.projectId}" không tồn tại`);
    const excerpt = truncateExcerpt(parsed.excerpt);
    const location = extractFileLocations(excerpt)[0];
    const sourceRef = {
      taskId: source.id,
      runId: parsed.runId || null,
      checkName: parsed.checkName || null,
      excerptHash: excerptHash(excerpt),
    };
    const body = parsed.body || [
      `## Lỗi phát sinh từ ${source.id}`,
      '',
      `- Check: ${parsed.checkName || 'log'}`,
      `- Nhánh nguồn: ${source.branch || source.baseRef || project.defaultBranch}`,
      location ? `- Vị trí: ${location.file}:${location.line}` : '- Vị trí: không trích xuất được từ stack trace',
      '',
      toMarkdownCodeBlock(excerpt),
    ].join('\n');
    const baseRef = source.status === 'done' ? (source.baseRef || project.defaultBranch) : (source.branch || source.baseRef || project.defaultBranch);
    return this.createTask({
      project: source.projectId,
      slug: parsed.slug,
      title: parsed.title || `${parsed.checkName || 'Lỗi'}: ${excerpt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 100) || source.title}`,
      body,
      level: parsed.level,
      baseRef,
      sourceRef,
      start: parsed.start,
    });
  }

  updateTask(idParam: string, raw: unknown): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    if (!['draft', 'queued', 'waiting_quota', 'failed'].includes(task.status)) {
      throw new HttpError(
        409,
        'conflict',
        `Chỉ có thể sửa task ở trạng thái draft, queued, waiting_quota hoặc failed (hiện tại: ${task.status})`,
      );
    }

    let parsed: z.infer<typeof UpdateTaskSchema>;
    try {
      parsed = UpdateTaskSchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new HttpError(
          422,
          'unprocessable_entity',
          err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        );
      }
      throw err;
    }

    const updateFields: Parameters<typeof this.taskRepo.update>[1] = {};

    if (parsed.title !== undefined) {
      updateFields.title = parsed.title;
    }

    if (parsed.level !== undefined) {
      updateFields.level = parsed.level;
    }

    if (parsed.modelChain !== undefined) {
      updateFields.modelChain =
        parsed.modelChain && parsed.modelChain.length > 0 ? JSON.stringify(parsed.modelChain) : null;
    }

    let newBody: string | undefined = undefined;
    if (parsed.body !== undefined) {
      newBody = parsed.body;
    }
    if (parsed.appendBody !== undefined) {
      const current = newBody !== undefined ? newBody : (task.body ?? '');
      if (!current) {
        newBody = parsed.appendBody;
      } else if (current.endsWith('\n') || parsed.appendBody.startsWith('\n')) {
        newBody = `${current}${parsed.appendBody}`;
      } else {
        newBody = `${current}\n${parsed.appendBody}`;
      }
    }
    if (newBody !== undefined) {
      updateFields.body = newBody;
    }

    if (parsed.dependsOn !== undefined) {
      const normalizedDeps: string[] = [];
      for (const depId of parsed.dependsOn) {
        let normId = toTaskId(depId);
        let depTask = this.taskRepo.get(normId);
        if (!depTask && !normId.includes('/') && task.projectId) {
          const qualified = `${task.projectId}/${normId}`;
          if (this.taskRepo.get(qualified)) {
            normId = qualified;
            depTask = this.taskRepo.get(qualified);
          }
        }
        if (!depTask) {
          throw new HttpError(422, 'unprocessable_entity', `Task phụ thuộc "${depId}" không tồn tại`);
        }
        normalizedDeps.push(normId);
      }

      // Check for dependency cycles
      const visited = new Set<string>();
      const recStack = new Set<string>();

      const checkCycle = (currId: string): boolean => {
        visited.add(currId);
        recStack.add(currId);

        let nextDeps: string[] = [];
        if (currId === taskId) {
          nextDeps = normalizedDeps;
        } else {
          const t = this.taskRepo.get(currId);
          if (t?.dependsOn) {
            try {
              const p = JSON.parse(t.dependsOn);
              if (Array.isArray(p)) {
                nextDeps = p.map(toTaskId);
              }
            } catch {
              nextDeps = [];
            }
          }
        }

        for (const next of nextDeps) {
          if (!visited.has(next)) {
            if (checkCycle(next)) return true;
          } else if (recStack.has(next)) {
            return true;
          }
        }

        recStack.delete(currId);
        return false;
      };

      if (checkCycle(taskId)) {
        throw new HttpError(422, 'unprocessable_entity', 'Danh sách dependsOn tạo vòng phụ thuộc');
      }

      updateFields.dependsOn = JSON.stringify(normalizedDeps);
    }

    this.taskRepo.update(taskId, updateFields);

    const updatedTask = this.taskRepo.get(taskId)!;

    if (updatedTask.worktreePath) {
      const taskMdPath = path.join(updatedTask.worktreePath, '.agenthub', 'task.md');
      if (fs.existsSync(taskMdPath) && newBody !== undefined) {
        try {
          fs.writeFileSync(taskMdPath, newBody, 'utf-8');
        } catch {
          // ignore
        }
      }
    }

    this.scheduler.getEventBus().emit('task.updated', taskId, {
      id: taskId,
      title: updatedTask.title,
      level: updatedTask.level,
      status: updatedTask.status,
      modelChain: updatedTask.modelChain,
      dependsOn: updatedTask.dependsOn,
    });

    if (updatedTask.status === 'queued') {
      this.scheduler.triggerTick();
    }

    return updatedTask;
  }

  createBatch(raw: unknown): TaskBatchRow & { tasks: TaskRow[]; progress: BatchProgress } {
    const parsed = CreateBatchSchema.parse(raw);
    const project = this.projectRepo.get(parsed.project);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${parsed.project}" không tồn tại`);
    }
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }

    const slugs = new Set<string>();
    for (const t of parsed.tasks) {
      if (slugs.has(t.slug)) {
        throw new HttpError(400, 'bad_request', `Trùng slug "${t.slug}" trong cùng đợt`);
      }
      slugs.add(t.slug);
      const taskId = `${parsed.project}/${t.slug}`;
      if (this.taskRepo.get(taskId)) {
        throw new HttpError(409, 'conflict', `Task "${taskId}" đã tồn tại`);
      }
    }

    const batchId = `batch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const createdBy = parsed.createdBy || 'claude';
    this.taskBatchRepo.create({
      id: batchId,
      projectId: parsed.project,
      title: parsed.title,
      goal: parsed.goal || null,
      status: 'draft',
      createdBy,
    });

    const createdTasks: TaskRow[] = [];
    const taskDepsToPopulate: Array<{ taskId: string; deps: string[] }> = [];

    for (const t of parsed.tasks) {
      const taskId = `${parsed.project}/${t.slug}`;
      const normalizedDeps: string[] = (t.dependsOn || []).map((dep) => {
        if (!dep.includes('/') && !dep.includes('~')) {
          return `${parsed.project}/${dep}`;
        }
        return toTaskId(dep);
      });

      this.taskRepo.insert({
        id: taskId,
        projectId: parsed.project,
        slug: t.slug,
        title: t.title,
        body: t.body,
        level: t.level,
        modelChain: t.modelChain ? JSON.stringify(t.modelChain) : undefined,
        dependsOn: normalizedDeps,
        status: 'draft',
        batchId,
        skipDeps: true,
      });
      taskDepsToPopulate.push({ taskId, deps: normalizedDeps });
      createdTasks.push(apiTask(this.taskRepo.get(taskId)!));
    }

    // Phase 2: populate task_deps now that all tasks exist in DB
    for (const item of taskDepsToPopulate) {
      this.taskRepo.populateDeps(item.taskId, item.deps);
    }

    const payload = {
      batchId,
      projectId: parsed.project,
      title: parsed.title,
      goal: parsed.goal || null,
      taskCount: createdTasks.length,
      createdBy,
    };
    this.eventRepo.insert('batch.created', undefined, payload);
    this.scheduler.getEventBus().emit('batch.created', undefined, payload);

    if (parsed.dispatch) this.dispatchBatch(batchId);

    const batchRow = apiBatch(this.taskBatchRepo.get(batchId)!);
    const tasks = this.taskRepo.getByBatch(batchId).map(apiTask);
    return { ...batchRow, tasks, progress: batchProgress(tasks) };
  }

  getBatch(id: string): TaskBatchRow & { tasks: TaskRow[]; progress: BatchProgress } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(id);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${id}" không tồn tại`);
    }
    const tasks = this.taskRepo.getByBatch(id).map(apiTask);
    return { ...apiBatch(batch), tasks, progress: batchProgress(tasks) };
  }

  listBatches(params?: { project?: string; status?: string }): Array<TaskBatchRow & { progress: BatchProgress }> {
    if (!this.taskBatchRepo) return [];
    return this.taskBatchRepo.list(params?.project, params?.status).map((batch) => ({
      ...apiBatch(batch),
      progress: batchProgress(this.taskRepo.getByBatch(batch.id)),
    }));
  }

  pageBatches(params?: { project?: string; status?: string; limit?: string | number; cursor?: string; offset?: string | number }): PageResult<TaskBatchRow & { progress: BatchProgress }> {
    if (!this.taskBatchRepo) return { items: [], total: 0, nextCursor: null };
    const page = this.taskBatchRepo.page(params);
    return {
      ...page,
      items: page.items.map((batch) => ({
        ...apiBatch(batch),
        progress: batchProgress(this.taskRepo.getByBatch(batch.id)),
      })),
    };
  }

  dispatchBatch(id: string): { ok: boolean; batchId: string; dispatchedCount: number } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(id);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${id}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể giao đợt ở trạng thái draft (hiện tại: ${batch.status})`);
    }
    const tasks = this.taskRepo.getByBatch(id);
    const draftTasks = tasks.filter((t) => t.status === 'draft');
    if (draftTasks.length === 0) {
      throw new HttpError(400, 'bad_request', `Đợt "${id}" không có task nào ở trạng thái draft`);
    }

    const projectTasks = this.taskRepo.getByProject(batch.projectId);
    const cycle = detectCycle(projectTasks);
    if (cycle) {
      throw new HttpError(400, 'cycle_detected', `Phát hiện vòng phụ thuộc: ${cycle.join(' -> ')}`);
    }

    for (const task of draftTasks) {
      this.taskRepo.updateStatus(task.id, 'queued');
      this.eventRepo.insert('task.queued', task.id, { fromBatch: id });
      this.scheduler.getEventBus().emit('task.queued', task.id);
    }

    this.taskBatchRepo.updateStatus(id, 'dispatched');
    const payload = { batchId: id, projectId: batch.projectId, dispatchedCount: draftTasks.length };
    this.eventRepo.insert('batch.dispatched', undefined, payload);
    this.scheduler.getEventBus().emit('batch.dispatched', undefined, payload);
    this.scheduler.triggerTick();

    return { ok: true, batchId: id, dispatchedCount: draftTasks.length };
  }

  discardBatch(id: string): { ok: boolean; batchId: string } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(id);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${id}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể huỷ đợt ở trạng thái draft (hiện tại: ${batch.status})`);
    }
    const tasks = this.taskRepo.getByBatch(id);
    for (const task of tasks) {
      if (task.status === 'draft') {
        this.taskRepo.updateStatus(task.id, 'cancelled');
      }
    }
    this.taskBatchRepo.updateStatus(id, 'discarded');
    const payload = { batchId: id, projectId: batch.projectId };
    this.eventRepo.insert('batch.discarded', undefined, payload);
    this.scheduler.getEventBus().emit('batch.discarded', undefined, payload);

    return { ok: true, batchId: id };
  }

  addTaskToBatch(batchId: string, raw: unknown): TaskRow {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(batchId);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${batchId}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể thêm task vào đợt ở trạng thái draft`);
    }

    const parsed = BatchTaskInputSchema.parse(raw);
    const taskId = `${batch.projectId}/${parsed.slug}`;
    if (this.taskRepo.get(taskId)) {
      throw new HttpError(409, 'conflict', `Task "${taskId}" đã tồn tại`);
    }

    const normalizedDeps: string[] = (parsed.dependsOn || []).map((dep) => {
      if (!dep.includes('/') && !dep.includes('~')) {
        return `${batch.projectId}/${dep}`;
      }
      return toTaskId(dep);
    });

    this.taskRepo.insert({
      id: taskId,
      projectId: batch.projectId,
      slug: parsed.slug,
      title: parsed.title,
      body: parsed.body,
      level: parsed.level,
      modelChain: parsed.modelChain ? JSON.stringify(parsed.modelChain) : undefined,
      dependsOn: normalizedDeps,
      status: 'draft',
      batchId,
    });

    return apiTask(this.taskRepo.get(taskId)!);
  }

  removeTaskFromBatch(batchId: string, idParam: string): { ok: boolean } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(batchId);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${batchId}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể bỏ task khỏi đợt ở trạng thái draft`);
    }

    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.batchId !== batchId) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không thuộc đợt "${batchId}"`);
    }
    if (task.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể bỏ task ở trạng thái draft (hiện tại: ${task.status})`);
    }

    this.taskRepo.delete(taskId);

    const batchTasks = this.taskRepo.getByBatch(batchId);
    for (const otherTask of batchTasks) {
      let deps = parseDependsOn(otherTask.dependsOn);
      if (deps.includes(taskId) || deps.includes(task.slug)) {
        deps = deps.filter((d: string) => d !== taskId && d !== task.slug);
        this.taskRepo.update(otherTask.id, { dependsOn: JSON.stringify(deps) });
      }
    }

    return { ok: true };
  }

  deleteTask(idParam: string): { ok: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể xoá task ở trạng thái draft (hiện tại: ${task.status})`);
    }
    this.taskRepo.delete(taskId);
    return { ok: true };
  }

  startTask(idParam: string): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    this.taskRepo.updateStatus(taskId, 'queued');
    this.scheduler.getEventBus().emit('task.queued', taskId);
    this.scheduler.triggerTick();

    return this.taskRepo.get(taskId)!;
  }

  cancelTask(idParam: string): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    this.scheduler.cancelTask(taskId);
    return this.taskRepo.get(taskId)!;
  }

  pauseTask(idParam: string): { ok: boolean; paused: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    const rt = this.scheduler.getRunning().get(taskId);
    if (!rt) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái running`);
    }
    this.scheduler.pauseTask(taskId, 'manual');
    return { ok: true, paused: true };
  }

  resumeTask(idParam: string): { ok: boolean; paused: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    const rt = this.scheduler.getRunning().get(taskId);
    if (!rt) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái running`);
    }
    this.scheduler.resumeTask(taskId);
    return { ok: true, paused: false };
  }

  async reviewTask(idParam: string, raw: unknown): Promise<TaskRow> {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'review') {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái review (hiện tại: ${task.status})`);
    }

    const parsed = ReviewTaskSchema.parse(raw);
    if (this.reviewingTasks.has(taskId)) {
      throw new HttpError(409, 'conflict', 'Task đang được duyệt');
    }
    this.reviewingTasks.add(taskId);
    try {

    let mergeResult: { mergeCommit: string; checks: string[] } | undefined;
    if (parsed.verdict === 'approved' && parsed.merge) {
      const project = this.projectRepo.get(task.projectId);
      if (!project) throw new HttpError(404, 'not_found', `Project "${task.projectId}" không tồn tại`);
      try {
        mergeResult = await mergeTaskIntoBase(task, project, {
          hubHome: this.config.hubHome,
          cacheDir: this.config.cacheDir,
          cacheMaxEntries: this.config.cacheMaxEntries,
          cacheMaxGB: this.config.cacheMaxGB,
          cachePolicy: {
            maxEntries: this.config.cacheMaxEntries,
            maxBytes: this.config.cacheMaxGB * 1024 ** 3,
          },
        });
      } catch (error) {
        if (error instanceof MergeError) {
          if (!error.configuration && !error.environment) this.createMergeFailureDraft(task, error.message);
          if (error.environment) {
            this.scheduler.getEventBus().emit('merge.failed', taskId, {
              actor: parsed.by || 'review',
              message: error.message,
              environment: true,
            });
            if (this.taskNoteRepo) {
              try {
                this.taskNoteRepo.insert({
                  projectId: task.projectId,
                  taskId: task.id,
                  kind: 'note',
                  content: `Lỗi môi trường khi merge (không phải lỗi worker): ${error.message}`,
                });
              } catch {
                // ignore
              }
            }
          }
          throw new HttpError(error.statusCode, error.error, error.message);
        }
        throw error;
      }
    }

    const reviewId = crypto.randomUUID();
    this.reviewRepo.insert({
      id: reviewId,
      taskId,
      verdict: parsed.verdict,
      feedback: parsed.feedback || null,
      actor: parsed.by || 'claude',
    });

    this.scheduler.reviewTask(taskId, parsed.verdict, parsed.feedback, parsed.by);
    if (parsed.verdict === 'approved' && this.knowledgeRepo) {
      const completed = this.taskRepo.get(taskId);
      const donePath = completed?.worktreePath ? path.join(completed.worktreePath, '.agenthub', 'DONE') : null;
      const doneContent = completed?.doneReport || (donePath && fs.existsSync(donePath) ? fs.readFileSync(donePath, 'utf-8') : '');
      const knowledge = extractKnowledgeSection(doneContent);
      if (knowledge) this.knowledgeRepo.insert({ projectId: task.projectId, taskId, content: knowledge });
    }
    if (mergeResult) {
      this.exportKnowledgeFile(task.projectId);
      this.scheduler.getEventBus().emit('task.merged', taskId, mergeResult);
    }
    return this.taskRepo.get(taskId)!;
    } finally {
      this.reviewingTasks.delete(taskId);
    }
  }

  clearFailedAutoMerge(taskId: string): void {
    this.failedAutoMerges.delete(taskId);
  }

  /**
   * Merges a task whose review chain finished on a Codex approval, when the project opted in with
   * `integration.autoMerge` or `review.autoMerge`. A merged task then self-deploys through the usual task.merged hook.
   */
  async autoMergeReviewedTask(taskId: string): Promise<void> {
    const task = this.taskRepo.get(taskId);
    if (!task || task.status !== 'review') return;
    const project = this.projectRepo.get(task.projectId);
    if (!project) return;
    const settings = projectSettings(project);
    if (!(settings.review.autoMerge || settings.integration.autoMerge)) return;
    const last = this.reviewRepo.getByTask(taskId).at(-1);
    if (!last || (last.actor !== 'codex-reviewer' && last.actor !== 'claude-reviewer') || last.verdict !== 'approved') return;
    const checks = this.scheduler.getCheckResults(taskId);
    if (checks.length === 0 || checks.some((c) => !c.ok)) return;
    if (this.failedAutoMerges.has(taskId)) return;
    // The ready event can arrive twice for one approval; the first call is already merging.
    if (this.reviewingTasks.has(taskId)) {
      // A reviewer approval emits task.review_ready before the outer review API call
      // releases its guard. Retry once on the next event-loop turn after that call ends.
      setImmediate(() => void this.autoMergeReviewedTask(taskId));
      return;
    }
    try {
      await this.reviewTask(toRouteId(taskId), {
        verdict: 'approved',
        merge: true,
        by: 'auto-merge',
        feedback: 'Tự merge sau khi Codex reviewer chấp thuận.',
      });
      this.failedAutoMerges.delete(taskId);
    } catch (error) {
      this.failedAutoMerges.add(taskId);
      const isConflict = (error instanceof HttpError && (error.error === 'conflict' || error.statusCode === 409)) ||
        (error instanceof MergeError && error.error === 'conflict') ||
        (error instanceof Error && /conflict/i.test(error.message));
      const isEnvironment = (error instanceof HttpError && (error.error === 'environment_error' || error.statusCode === 503)) ||
        (error instanceof MergeError && error.environment);
      this.scheduler.getEventBus().emit(isConflict ? 'merge.conflict' : 'merge.failed', taskId, {
        actor: 'auto-merge',
        message: error instanceof Error ? error.message : String(error),
        environment: isEnvironment || undefined,
      });
    }
  }

  /**
   * Brains do not receive reviewer escalations, so without this the task would sit in review
   * forever. Send it back once with the reviewer's feedback on the strongest model; a second
   * escalation stays parked for a person (the review.escalated notification already went out).
   */
  /** Escalations raised before a restart never reach the event handler again; pick them up here. */
  async retryParkedEscalations(): Promise<void> {
    for (const task of this.taskRepo.getByStatus('review')) {
      if (!task.reviewerEscalated) continue;
      const feedback = this.reviewRepo.getByTask(task.id).at(-1)?.feedback ?? undefined;
      await this.retryEscalatedReview(task.id, { reason: task.reviewerEscalationReason, feedback });
    }
  }

  async retryEscalatedReview(taskId: string, payload: { reason?: unknown; feedback?: unknown }): Promise<void> {
    if (payload.reason !== 'reviewer_changes_limit') return;
    const task = this.taskRepo.get(taskId);
    if (!task || task.status !== 'review' || !task.reviewerEscalated) return;
    const escalations = this.eventRepo.getByTask(taskId)
      .filter((event) => event.type === 'review.escalated' && event.payload?.includes('reviewer_changes_limit')).length;
    if (escalations > 1) return;
    let current: string[] = [];
    try { current = task.modelChain ? JSON.parse(task.modelChain) as string[] : []; } catch { current = []; }
    if (current.length === 0) current = task.level === 'easy' ? this.config.defaultModelChains.easy : this.config.defaultModelChains.hard;
    const chain = [ESCALATION_MODEL, ...current.filter((model) => model !== ESCALATION_MODEL)];
    this.taskRepo.update(taskId, { modelChain: JSON.stringify(chain) });
    const feedback = typeof payload.feedback === 'string' && payload.feedback.trim() ? payload.feedback : 'Reviewer yêu cầu sửa nhiều lần.';
    try {
      await this.reviewTask(toRouteId(taskId), {
        verdict: 'changes_requested',
        by: 'auto-escalation',
        feedback: `${feedback}\n\n(Reviewer đã yêu cầu sửa quá số vòng cho phép; giao lại một lần với ${ESCALATION_MODEL}.)`,
      });
    } catch (error) {
      console.error(`[review] auto-escalation retry failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private createMergeFailureDraft(source: TaskRow, output: string): TaskRow | null {
    const existing = this.taskRepo.getDerivedFrom(source.id).find((task) =>
      task.sourceRef
      && !['done', 'cancelled', 'failed', 'blocked'].includes(task.status)
      && (() => {
        try {
          const sourceRef = JSON.parse(task.sourceRef) as { checkName?: unknown };
          return sourceRef.checkName === 'merge';
        } catch {
          return false;
        }
      })(),
    );
    if (existing) return existing;
    const slugBase = `${source.slug}-fix-merge`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
    let slug = slugBase;
    for (let index = 2; this.taskRepo.get(`${source.projectId}/${slug}`); index += 1) slug = `${slugBase}-${index}`;
    try {
      return this.captureTask({
        sourceTaskId: source.id,
        slug,
        checkName: 'merge',
        excerpt: output,
        title: `Sửa lỗi merge: ${source.title}`,
        level: 'easy',
        start: false,
      });
    } catch {
      return null;
    }
  }

  async cleanupOrphanedMergeFixTasks(sourceTaskId?: string): Promise<number> {
    const sources = sourceTaskId
      ? [this.taskRepo.get(sourceTaskId)].filter((task): task is TaskRow => Boolean(task))
      : this.taskRepo.getByStatus('done');
    let cancelled = 0;
    const reason = 'Task gốc đã merge thành công qua đường khác, tự đóng task fix-merge liên quan';

    for (const source of sources) {
      if (source.status !== 'done') continue;
      const project = this.projectRepo.getIncludingArchived(source.projectId);
      if (!project) continue;

      for (const derived of this.taskRepo.getDerivedFrom(source.id)) {
        if (!/-fix-merge(?:-\d+)?$/.test(derived.slug)) continue;
        if (!['draft', 'queued', 'waiting_quota'].includes(derived.status) || derived.attempt > 0) continue;
        let sourceRef: { checkName?: unknown };
        try {
          sourceRef = JSON.parse(derived.sourceRef || '{}') as { checkName?: unknown };
        } catch {
          continue;
        }
        if (sourceRef.checkName !== 'merge') continue;

        const commits = derived.branch
          ? await getGitCommits(project.path, derived.baseRef || project.defaultBranch, derived.branch)
          : [];
        const current = this.taskRepo.get(derived.id);
        if (!current || !['draft', 'queued', 'waiting_quota'].includes(current.status) || current.attempt > 0 || commits.length > 0) continue;

        this.taskRepo.updateStatus(current.id, 'cancelled');
        this.scheduler.getEventBus().emit('task.cancelled', current.id, {
          reason: 'orphaned_merge_fix',
          sourceTaskId: source.id,
          message: reason,
        });
        cancelled += 1;
      }
    }
    return cancelled;
  }

  retryTask(idParam: string, raw: unknown): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể retry task ở trạng thái failed hoặc blocked (hiện tại: ${task.status})`);
    }

    const parsed = RetryTaskSchema.parse(raw || {});
    const newBody = parsed.note ? `${task.body || ''}\n\n## Retry Note\n\n${parsed.note}` : task.body;

    this.taskRepo.update(taskId, {
      status: 'queued',
      resume: 1,
      attempt: task.attempt + 1,
      transientRetries: 0,
      notBefore: null,
      body: newBody,
      reviewerChangesRequested: 0,
      reviewerEscalated: 0,
      reviewerEscalatedAt: null,
      reviewerEscalationReason: null,
    });

    // Retry reuses the existing worktree. Old worker markers must not be
    // mistaken for completion of the new run.
    if (task.worktreePath) {
      for (const marker of ['DONE', 'BLOCKED']) {
        try {
          fs.unlinkSync(path.join(task.worktreePath, '.agenthub', marker));
        } catch {
          // Marker is absent or already removed.
        }
      }
    }

    this.scheduler.getEventBus().emit('task.queued', taskId, { reason: 'retry', note: parsed.note });
    this.scheduler.triggerTick();

    return this.taskRepo.get(taskId)!;
  }

  retryReviewer(idParam: string): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'review' || !task.reviewerEscalated) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái chờ người duyệt`);
    }

    this.taskRepo.update(taskId, {
      reviewerEscalated: 0,
      reviewerEscalatedAt: null,
      reviewerEscalationReason: null,
    });
    this.scheduler.getEventBus().emit('task.review_ready', taskId, { reason: 'reviewer_retry' });
    this.scheduler.triggerTick();
    return this.taskRepo.get(taskId)!;
  }

  deleteWorktree(idParam: string): { ok: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'done' && task.status !== 'cancelled') {
      throw new HttpError(
        409,
        'conflict',
        `Chỉ có thể xóa worktree của task đã done hoặc cancelled (hiện tại: ${task.status})`,
      );
    }

    if (task.worktreePath) {
      const project = this.projectRepo.get(task.projectId);
      let hooks = null;
      if (project?.hooks) {
        try {
          hooks = JSON.parse(project.hooks);
        } catch {
          // ignore invalid json
        }
      }
      // Chỉ xóa đường dẫn nằm hẳn trong worktreesDir và không phải gốc project (sự cố 16/10).
      const removed = new WorktreeService(this.config, this.scheduler.getEventBus()).remove(
        project?.path ?? null,
        task.worktreePath,
        {
          slot: task.slot,
          slug: task.slug,
          projectId: task.projectId,
          taskId: task.id,
          hooks,
        },
        project ? projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir) : this.config.worktreesDir,
      );
      if (!removed) {
        throw new HttpError(
          422,
          'unprocessable_entity',
          `Từ chối xóa ${task.worktreePath}: nằm ngoài ${this.config.worktreesDir} hoặc là thư mục project`,
        );
      }
      this.taskRepo.update(taskId, { worktreePath: null, slot: null });
    }

    return { ok: true };
  }

  getTaskLog(idParam: string, query?: { run?: string; tail?: string | number }): string {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const runs = this.runRepo.getByTask(taskId);
    const runId = query?.run;
    const targetRun = runId ? runs.find((r) => r.id === runId) : runs[runs.length - 1];

    if (!targetRun?.logPath || !fs.existsSync(targetRun.logPath)) {
      return '';
    }

    const tailKB = query?.tail ? parseInt(String(query.tail), 10) : 512;
    return readLogTail(targetRun.logPath, isNaN(tailKB) ? 512 : tailKB);
  }

  async rerunChecks(idParam: string) {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    const project = this.projectRepo.get(task.projectId);
    const run = this.runRepo.getByTask(taskId).at(-1);
    if (!project || !run) throw new HttpError(400, 'bad_request', 'Task chưa có run để lưu kết quả kiểm tra');
    const db = this.scheduler.getDatabase();
    if (!db) throw new HttpError(500, 'internal_server_error', 'Check database chưa sẵn sàng');
    return new CheckRunner(db).run(task, project, run.id);
  }

  // --- Task Notes ---
  createTaskNote(idParam: string, raw: unknown): TaskNoteRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const parsed = CreateTaskNoteSchema.parse(raw);
    if (!this.taskNoteRepo) {
      throw new HttpError(500, 'internal_error', 'TaskNoteRepo chưa được khởi tạo');
    }

    const note = this.taskNoteRepo.insert({
      projectId: task.projectId,
      taskId: task.id,
      kind: parsed.kind,
      content: parsed.content,
    });

    if (this.bulletinService) {
      this.bulletinService.updateBulletinsForProject(task.projectId);
    }

    this.scheduler.getEventBus().emit(
      parsed.kind === 'overlap' ? 'task.overlap' : 'task.note',
      task.id,
      {
        id: note.id,
        content: note.content,
        projectId: task.projectId,
      },
    );

    return apiTaskNote(note);
  }

  getProjectNotes(
    projectId: string,
    query?: { since?: string; runningOnly?: string; taskId?: string },
  ): TaskNoteRow[] {
    const project = this.projectRepo.get(projectId);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    }

    const sinceId = query?.since ? parseInt(query.since, 10) : undefined;
    let notes = this.taskNoteRepo ? this.taskNoteRepo.getByProject(projectId, sinceId) : [];

    if (query?.taskId) {
      const filterTaskId = toTaskId(query.taskId);
      notes = notes.filter((n) => n.taskId === filterTaskId);
    }

    if (query?.runningOnly === 'true' || query?.runningOnly === '1') {
      const runningTaskIds = new Set(this.taskRepo.getByStatus('running').map((t) => t.id));
      notes = notes.filter((n) => runningTaskIds.has(n.taskId));
    }

    return notes.map(apiTaskNote);
  }

  getTaskNotes(idParam: string): TaskNoteRow[] {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const notes = this.taskNoteRepo ? this.taskNoteRepo.getByTask(taskId) : [];
    return notes.map(apiTaskNote);
  }

  pageTaskRuns(idParam: string, options?: { limit?: string | number; cursor?: string; offset?: string | number }) {
    const taskId = toTaskId(idParam);
    if (!this.taskRepo.get(taskId)) throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    return this.runRepo.pageByTask(taskId, options?.limit, options?.cursor, options?.offset);
  }

  pageEvents(options?: { taskId?: string; limit?: string | number; cursor?: string; offset?: string | number }) {
    const page = this.eventRepo.page(options);
    return {
      ...page,
      items: page.items.map((event) => {
        let payload: unknown = null;
        if (event.payload) {
          try {
            payload = JSON.parse(event.payload);
          } catch {
            payload = event.payload;
          }
        }
        return { id: event.id, ts: toApiTime(event.ts)!, type: event.type, taskId: event.taskId, payload };
      }),
    };
  }

  listKnowledge(projectId: string): KnowledgeEntryRow[] {
    if (!this.projectRepo.get(projectId)) throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    return this.knowledgeRepo?.getByProject(projectId).map(apiKnowledgeEntry) || [];
  }

  pageKnowledge(projectId: string, options?: { limit?: string | number; cursor?: string; offset?: string | number }) {
    if (!this.projectRepo.get(projectId)) throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    if (!this.knowledgeRepo) return { items: [], total: 0, nextCursor: null };
    const page = this.knowledgeRepo.pageByProject(projectId, options?.limit, options?.cursor, options?.offset);
    return { ...page, items: page.items.map(apiKnowledgeEntry) };
  }

  pageCiRuns(projectId: string, options?: { limit?: string | number; cursor?: string; offset?: string | number }) {
    if (!this.ciRepo) return { items: [], total: 0, nextCursor: null };
    return this.ciRepo.pageByProject(projectId, options);
  }

  reviewChecklistPreview(projectId: string) {
    const project = this.projectRepo.get(projectId);
    if (!project) throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    return projectSettings(project).reviewChecklist.slice(0, 5).map((entry) => {
      const filePath = resolveProjectFile(project.path, entry);
      if (!filePath) return { path: entry, resolvedPath: null, size: null, truncated: false, content: null, warning: 'Đường dẫn không hợp lệ hoặc nằm ngoài project' };
      try {
        const stat = fs.statSync(filePath);
        const truncated = stat.size > 64 * 1024;
        return { path: entry, resolvedPath: filePath, size: stat.size, truncated, content: truncated ? null : fs.readFileSync(filePath, 'utf8') };
      } catch {
        return { path: entry, resolvedPath: filePath, size: null, truncated: false, content: null, warning: 'Không thể đọc file' };
      }
    });
  }

  addKnowledge(projectId: string, raw: unknown): KnowledgeEntryRow {
    if (!this.projectRepo.get(projectId)) throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    const parsed = CreateKnowledgeSchema.parse(raw);
    const taskId = parsed.taskId ? toTaskId(parsed.taskId) : `manual/${projectId}`;
    if (parsed.taskId && (!this.taskRepo.get(taskId) || this.taskRepo.get(taskId)!.projectId !== projectId)) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không thuộc project`);
    }
    if (!this.knowledgeRepo) throw new HttpError(500, 'internal_error', 'KnowledgeRepo chưa được khởi tạo');
    return apiKnowledgeEntry(this.knowledgeRepo.insert({ projectId, taskId, content: parsed.content, pinned: parsed.pinned }));
  }

  updateKnowledge(projectId: string, id: string, raw: unknown): KnowledgeEntryRow {
    const entryId = Number(id);
    const entry = this.knowledgeRepo?.get(entryId);
    if (!entry || entry.projectId !== projectId) throw new HttpError(404, 'not_found', 'Mục kiến thức không tồn tại');
    const parsed = UpdateKnowledgeSchema.parse(raw);
    const updated = this.knowledgeRepo!.update(entryId, parsed);
    return apiKnowledgeEntry(updated!);
  }

  deleteKnowledge(projectId: string, id: string): { ok: boolean } {
    const entryId = Number(id);
    const entry = this.knowledgeRepo?.get(entryId);
    if (!entry || entry.projectId !== projectId) throw new HttpError(404, 'not_found', 'Mục kiến thức không tồn tại');
    this.knowledgeRepo!.delete(entryId);
    return { ok: true };
  }

  private exportKnowledgeFile(projectId: string): void {
    const target = this.config.context.knowledgeFile;
    const project = this.projectRepo.get(projectId);
    if (!target || !project || !this.knowledgeRepo) return;
    const entries = this.knowledgeRepo.getByProject(projectId);
    const content = ['# Sổ kiến thức dự án', '', ...entries.map((entry) => `- ${entry.content} _(task: ${entry.taskId})`)].join('\n') + '\n';
    const filePath = path.resolve(project.path, target);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  // --- Scheduler control ---
  pauseScheduler(): { ok: boolean; paused: boolean } {
    this.scheduler.pause();
    return { ok: true, paused: true };
  }

  resumeScheduler(): { ok: boolean; paused: boolean } {
    this.scheduler.resume();
    return { ok: true, paused: false };
  }

  isSchedulerPaused(): boolean {
    return this.scheduler.isPaused();
  }

  // --- Telegram ---
  setTelegramBotService(botService: TelegramBotService): void {
    this.telegramBotService = botService;
  }

  getTelegramStatus() {
    return {
      enabled: this.config.telegram.enabled,
      hasToken: Boolean(this.telegramBotService?.hasValidToken()),
      chats: this.config.telegram.chats || [],
      allowedChatIds: this.config.telegram.allowedChatIds,
      topicMode: this.config.telegram.topicMode || 'project',
      notify: this.config.telegram.notify,
      projectTopics: this.config.telegram.projectTopics || {},
      departmentTopics: this.telegramBotService?.getDepartmentTopics() || this.config.telegram.departmentTopics || {},
    };
  }

  async setupTelegramTopics(mode?: 'project' | 'department'): Promise<Record<string, TelegramProjectTopic>> {
    if (!this.telegramBotService) throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    return this.telegramBotService.setupTopics(mode);
  }

  async createTelegramProjectTopic(projectId: string): Promise<TelegramProjectTopic> {
    if (!this.telegramBotService) throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    try { return await this.telegramBotService.createProjectTopic(projectId); } catch (error) {
      throw new HttpError(502, 'telegram_error', error instanceof Error ? error.message : String(error));
    }
  }

  async createTelegramDepartmentTopic(departmentId: string): Promise<TelegramProjectTopic> {
    if (!this.telegramBotService) throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    try { return await this.telegramBotService.createDepartmentTopic(departmentId); } catch (error) {
      throw new HttpError(502, 'telegram_error', error instanceof Error ? error.message : String(error));
    }
  }

  attachTelegramProjectChat(projectId: string, chatId: number): { ok: boolean } {
    if (!this.telegramBotService) throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    try { this.telegramBotService.setProjectChat(projectId, chatId); return { ok: true }; } catch (error) {
      throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : String(error));
    }
  }

  getTelegramPairingCode(refresh = false): { code: string; expiresInSec: number; enabled: boolean; allowedChatIds: number[]; chats: TelegramChat[] } {
    if (!this.telegramBotService) {
      throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    }
    const pairing = this.telegramBotService.getPairingCode(refresh);
    return {
      ...pairing,
      enabled: this.config.telegram?.enabled ?? false,
      allowedChatIds: this.config.telegram?.allowedChatIds ?? [],
      chats: this.config.telegram?.chats ?? [],
    };
  }

  saveTelegramToken(token: string): { hasToken: boolean } {
    const value = token.trim();
    if (!value) throw new HttpError(400, 'bad_request', 'Bot token không được để trống');
    const tokenPath = this.config.telegram.botTokenFile;
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, `${value}\n`, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    this.telegramBotService?.setToken(value);
    return { hasToken: true };
  }

  async testTelegram(): Promise<{ ok: boolean; bot: { id: number; name: string; username?: string } }> {
    if (!this.telegramBotService) throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    try {
      return { ok: true, bot: await this.telegramBotService.testConnection() };
    } catch (error) {
      throw new HttpError(502, 'telegram_error', error instanceof Error ? error.message : 'Không thể kết nối Telegram');
    }
  }

  removeTelegramChat(chatId: number): { ok: boolean } {
    this.config.telegram.allowedChatIds = this.config.telegram.allowedChatIds.filter((id) => id !== chatId);
    this.config.telegram.chats = (this.config.telegram.chats || []).filter((chat) => chat.id !== chatId);
    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
    return { ok: true };
  }

  // --- Config ---
  getConfig() {
    const logoPath = this.config.branding.logo ? path.join(this.config.hubHome, 'branding', this.config.branding.logo) : null;
    let logoVersion: number | undefined;
    if (logoPath) {
      try { logoVersion = fs.statSync(logoPath).mtimeMs; } catch { /* logo may be removed during update */ }
    }
    return {
      branding: { ...this.config.branding, ...(logoVersion !== undefined ? { logoVersion } : {}) },
      modelChainHard: this.config.defaultModelChains.hard,
      modelChainEasy: this.config.defaultModelChains.easy,
      defaultTimeout: this.config.defaultTimeout,
      slotsPerAgyProfile: this.config.slotsPerAgyProfile,
      multiplePerProvider: this.config.multiplePerProvider,
      planning: this.config.planning,
      slotsPerCodexProfile: this.config.slotsPerCodexProfile,
      watchdog: this.config.watchdog,
      autoFixOnFail: this.config.autoFixOnFail,
      chat: {
        claudeBin: this.config.chat.claudeBin,
        resolvedClaudeBin: findClaudeBin(this.config.chat.claudeBin),
        claudeVersion: getClaudeVersion(this.config.chat.claudeBin),
        disableToolSearch: this.config.chat.disableToolSearch,
        allowFullMode: this.config.chat.allowFullMode,
        maxConcurrent: this.config.chat.maxConcurrent,
        idleTimeoutSec: this.config.chat.idleTimeoutSec,
        permissionTimeoutSec: this.config.chat.permissionTimeoutSec,
        model: this.config.chat.model,
        autoCompactPercent: this.config.chat.autoCompactPercent ?? 85,
        models: this.config.chat.models,
        claudeProfile: this.config.chat.claudeProfile,
      },
      brain: {
        engine: this.config.brain.engine || 'claude',
        mode: this.config.brain.mode,
        maxConcurrent: this.config.brain.maxConcurrent,
        digest: this.config.brain.digest,
        fallback: this.config.brain.fallback,
        policy: this.config.brain.policy,
        codexProfile: this.config.brain.codexProfile,
        codexModel: this.config.brain.codexModel,
        turnTimeoutSec: this.config.brain.turnTimeoutSec,
        director: this.config.brain.director,
      },
      assistant: this.config.assistant,
      reviewer: this.config.reviewer,
      focus: this.config.focus,
      notifications: this.config.notifications,
      savings: this.config.savings,
      load: this.config.load,
      stall: this.config.stall,
      disk: this.config.disk,
      cleanup: this.config.cleanup,
      cacheDir: this.config.cacheDir,
      cacheMaxEntries: this.config.cacheMaxEntries,
      cacheMaxGB: this.config.cacheMaxGB,
      context: this.config.context,
      telegram: {
        enabled: this.config.telegram.enabled,
        botTokenFile: this.config.telegram.botTokenFile,
        allowedChatIds: this.config.telegram.allowedChatIds,
        chats: this.config.telegram.chats,
        notify: this.config.telegram.notify,
      },
      updates: this.config.updates,
      workers: this.config.workers,
      ui: this.config.ui,
    };
  }

  getFocus() {
    return this.config.focus;
  }

  setFocus(raw: unknown) {
    const parsed = z.object({ projectId: z.string().min(1).nullable(), pauseRunning: z.boolean().optional() }).parse(raw);
    if (parsed.projectId && !this.projectRepo.get(parsed.projectId)) {
      throw new HttpError(404, 'not_found', `Project "${parsed.projectId}" không tồn tại`);
    }
    const focus = {
      projectId: parsed.projectId,
      since: parsed.projectId ? new Date().toISOString() : null,
      pauseRunning: parsed.pauseRunning ?? this.config.focus.pauseRunning,
    };
    updateConfigInMemory(this.config, { focus });
    saveConfig(this.config.hubHome, { focus });
    const changes = this.scheduler.applyFocus();
    this.scheduler.triggerTick();
    this.scheduler.getEventBus().emit('focus.changed', undefined, { focus, ...changes });
    return { focus, ...changes };
  }

  getModelOptions() {
    const profiles = this.profileRepo.getAll().filter((profile) => Boolean(profile.enabled));
    const suggestions = new Set<string>();
    for (const profile of profiles) {
      if (profile.engine === 'agy') {
        for (const model of VALID_AGY_MODELS) suggestions.add(model);
      } else if (profile.engine === 'codex') {
        suggestions.add('codex:gpt-5.6-luna');
      }
    }
    const configured = [...this.config.defaultModelChains.hard, ...this.config.defaultModelChains.easy, this.config.reviewer.model];
    const configuredModels = [...new Set(configured.filter(Boolean))];
    return { suggestions: [...suggestions].sort(), configured: configuredModels };
  }

  updateConfig(raw: unknown) {
    const parsed = UpdateConfigSchema.parse(raw);

    // Apply in-memory
    updateConfigInMemory(this.config, parsed);
    if (parsed.brain?.fallback) this.chatService?.configureFailoverSteps(this.config.brain.fallback);
    if (parsed.brain?.policy) this.config.brain.policy = [...parsed.brain.policy];

    // Save to config.json
    saveConfig(this.config.hubHome, parsed);
    if (parsed.focus) {
      this.scheduler.applyFocus();
      this.scheduler.triggerTick();
    }

    if (parsed.telegram?.enabled !== undefined && this.telegramBotService) {
      if (parsed.telegram.enabled) {
        this.telegramBotService.start();
      } else {
        void this.telegramBotService.stop();
      }
    }

    this.scheduler.getEventBus().emit('config.updated', undefined, parsed);

    return this.getConfig();
  }

  getClaudeApiKeyStatus() {
    return { configured: this.chatService?.getClaudeApiKeyStatus().configured || false };
  }

  setClaudeApiKey(value: string) {
    if (!this.chatService) throw new HttpError(503, 'unavailable', 'Chat service chưa sẵn sàng');
    this.chatService.setClaudeApiKey(value);
    this.scheduler.getEventBus().emit('config.updated', undefined, { brain: { apiKey: 'configured' } });
    return this.getClaudeApiKeyStatus();
  }
}
