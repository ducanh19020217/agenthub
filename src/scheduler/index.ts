import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { getMonitoredDisks, getDiskSpaceSync, type MonitoredDisk, type DiskSpace } from '../disk.js';
import {
  TaskRepo,
  RunRepo,
  EventRepo,
  ProjectRepo,
  DepartmentRepo,
  ProfileRepo,
  QuotaMarkRepo,
  ReviewRepo,
  RunMetricsRepo,
  TaskRow,
  ProfileRow,
  KnowledgeRepo,
  TaskNoteRepo,
  TrackerItemRepo,
} from '../db/index.js';
import { projectSettings } from '../projects/settings.js';
import { isTriageTaskSlug, parseTriageAnalysis } from '../integrations/openproject/triage.js';
import { renderCommitTemplate, renderTaskBranch, taskCommitRef } from '../commit-convention.js';
import { isProjectWorktreeRootAccessible, projectWorktreeRoot, projectWorktreeRoots } from '../projects/paths.js';
import { Engine, AgyEngine, CodexEngine } from '../engines/index.js';
import { findAgyBin } from '../agy.js';
import { getModelFamily, getModelEngine, isKnownModel, QuotaService } from '../quota/index.js';
import { DependencyContext, isDeletableWorktreePath, WorktreeService } from '../worktrees/index.js';
import { ensureWorktreeNodeModules, nodeModulesCacheSummary, pruneNodeModulesCache } from '../cache.js';
import { AgentHubConfig, DEFAULT_SCHEDULER_LIMITS } from '../config.js';
import { ProfileLockService } from '../profiles/locks.js';
import { sameAccount } from '../profiles/account.js';
import { QuotaUsageService } from '../quota/usage.js';
import { CheckRunner, getCheckResults } from '../checks.js';
import { parseDbTime } from '../db/time.js';
import type Database from 'better-sqlite3';
import { parseCodexTokens, parseShortstat, recalculateTaskLines, measureTaskLines } from '../savings.js';

const execFileAsync = promisify(execFile);
import { ClaudeFailoverState } from '../chat/failover.js';
import { ensureIntegrationNodeModules, ensureIntegrationWorktree } from '../projects/integration.js';
import { buildReviewerPrompt, parseReviewerOutput, ReviewerVerdict, isAutoReviewer, type ReviewerActor } from '../reviewer.js';
import { CLAUDE_REVIEW_ENGINE_KEY } from '../engines/claude-review.js';
import { isAutomatedStep, parseReviewChain, reviewerModel, type ReviewChainStep } from '../review-chain.js';
import { isOrphanProcess, listAllWorktreeProcesses, reap, reapSyncForWorktree } from '../reaper.js';
import { LoadGuard, LoadSnapshot } from '../load.js';
import { measureProcessTree } from '../process-tree.js';
import { ReferenceSnapshot, takeReferenceSnapshots, detectReferenceModifications, ReferenceModification } from '../references.js';
import { normalizeReviewerModel, reviewerSettingsFromLegacy, type ReviewerOrderItem, type ReviewerFallback } from '../reviewer-config.js';
import { cleanupTaskRunArtifacts } from '../temp-cleanup.js';
import { reviewMaxRoundsFor } from '../reviewer-rounds.js';

type ActivitySource = 'log' | 'conversation' | 'worktree';

export function isProjectAccessible(projectPath: string | null | undefined): boolean {
  if (!projectPath) return false;
  try {
    if (!fs.existsSync(projectPath)) return false;
    const gitDir = path.join(projectPath, '.git');
    if (fs.existsSync(gitDir)) return true;
    execFileSync('git', ['-C', projectPath, 'rev-parse', '--git-dir'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export const PROTOCOL_PROMPT_PREFIX = `Đọc \`.agenthub/task.md\` và thực hiện. Đọc thêm AGENTS.md / CLAUDE.md / GEMINI.md của project nếu có. Làm trên nhánh hiện tại, commit nhỏ theo Conventional Commits. KHÔNG dùng subagent / agent con; tự làm tuần tự trong phiên này. Tránh đọc lại file lớn không cần thiết.`;

export const PROTOCOL_PROMPT_SUFFIX = `KHÔNG chạy test/lệnh ở chế độ nền (background) rồi chờ: luôn chạy trực tiếp (foreground) và bọc \`timeout 300\`; test dùng \`--run\`, không watch. KHÔNG sửa file ngoài phạm vi task. Khi xong tạo \`.agenthub/DONE\` (tóm tắt, kết quả lint/test, việc còn thiếu); nếu bị chặn tạo \`.agenthub/BLOCKED\` (lý do). Chỉ tạo marker ở bước cuối.`;

export type NodeModulesPreparationResult =
  | 'prepared'
  | 'success'
  | 'no_lockfile'
  | 'failed'
  | 'skipped'
  | boolean
  | {
      status?: 'prepared' | 'success' | 'no_lockfile' | 'failed' | 'skipped';
      success?: boolean;
      hasLockfile?: boolean;
      error?: unknown;
    };

export function getNodeModulesPromptInstruction(
  settings?: { worktree?: { install?: 'auto' | 'skip' | 'worker' } } | null,
  preparation?: NodeModulesPreparationResult,
): string {
  const installMode = settings?.worktree?.install ?? 'auto';

  if (installMode === 'skip') {
    return '';
  }

  if (installMode === 'worker') {
    return 'Được phép chạy `npm ci`/`npm install` trong thư mục module (bọc `timeout 900`), dọn node_modules/dist khi xong nếu project yêu cầu.';
  }

  let isPrepared = true;
  if (typeof preparation === 'boolean') {
    isPrepared = preparation;
  } else if (typeof preparation === 'string') {
    isPrepared = preparation === 'prepared' || preparation === 'success';
  } else if (preparation && typeof preparation === 'object') {
    if (preparation.status !== undefined) {
      isPrepared = preparation.status === 'prepared' || preparation.status === 'success';
    } else if (preparation.success !== undefined) {
      isPrepared = preparation.success;
    } else if (preparation.hasLockfile === false || preparation.error !== undefined) {
      isPrepared = false;
    }
  }

  if (isPrepared) {
    return '`node_modules` đã được chuẩn bị sẵn, KHÔNG chạy `npm ci`/`npm install` trừ khi bạn sửa `package.json`.';
  }

  return '`node_modules` chưa có, được chạy `npm ci` khi cần test/build.';
}

export function buildProtocolPrompt(
  settings?: { worktree?: { install?: 'auto' | 'skip' | 'worker' } } | null,
  preparation?: NodeModulesPreparationResult,
): string {
  const nodeModulesClause = getNodeModulesPromptInstruction(settings, preparation);
  if (nodeModulesClause) {
    return `${PROTOCOL_PROMPT_PREFIX} ${nodeModulesClause} ${PROTOCOL_PROMPT_SUFFIX}`;
  }
  return `${PROTOCOL_PROMPT_PREFIX} ${PROTOCOL_PROMPT_SUFFIX}`;
}

export const renderProtocolPrompt = buildProtocolPrompt;
export const renderNodeModulesInstruction = getNodeModulesPromptInstruction;

export function buildCommitConventionPrompt(convention: ReturnType<typeof projectSettings>['commitConvention'], branch: string, ref: string, target: string): string {
  const message = renderCommitTemplate(convention.commitTemplate, { type: 'feat', scope: 'scope', ref, summary: 'summary' });
  const merge = renderCommitTemplate(convention.mergeMessageTemplate, { branch, target });
  const refInstruction = convention.commitTemplate.includes('{ref}')
    ? ref ? `\n- Mã ref bắt buộc: \`${ref}\`` : '\n- CẢNH BÁO: chưa có mã ref; hãy gắn ticket cho task hoặc đặt commitConvention.defaultRef trước khi commit.'
    : '';
  return `\n\n## Quy ước commit\n- Nhánh task: \`${branch}\`\n- Commit message mẫu: \`${message}\`\n- Merge message mẫu: \`${merge}\`\n- Thân commit phải có mô tả chi tiết về thay đổi và kết quả kiểm tra.${refInstruction}`;
}

export function isBugTask(
  task: { title?: string; slug?: string; body?: string | null; externalRef?: string | null },
  trackerItem?: { writeback?: string } | null,
): boolean {
  if (trackerItem?.writeback) {
    try {
      const parsed = JSON.parse(trackerItem.writeback);
      if (typeof parsed.isBug === 'boolean') return parsed.isBug;
      if (typeof parsed.typeName === 'string' && /bug|lỗi|defect/i.test(parsed.typeName)) return true;
    } catch {
      // ignore
    }
  }
  if (task.title && /\b(bug|lỗi|defect)\b/i.test(task.title)) return true;
  if (task.slug && (task.slug.startsWith('bug-') || task.slug.includes('-bug-') || task.slug.endsWith('-bug') || task.slug.startsWith('fix-') || task.slug.includes('-fix-') || task.slug.endsWith('-fix'))) return true;
  if (task.body && /Ticket:.*\[.*\]/i.test(task.body) && /loại:\s*(bug|lỗi|defect)/i.test(task.body)) return true;
  return false;
}

export function buildTicketWorkflowPrompt(input: {
  externalRef?: string | null;
  sourceId?: string | null;
  source?: { autoResolve?: boolean; inProgressStatusId?: number | null; resolvedStatusId?: number | null } | null;
  defaultRef?: string | null;
  isBug?: boolean;
}): string {
  if (!input.externalRef && !input.defaultRef && !input.sourceId && !input.source) return '';
  const refText = input.externalRef
    ? `Ticket hiện tại: \`${input.externalRef}\`${input.sourceId ? ` (nguồn ${input.sourceId})` : ''}`
    : `Project đang bật OpenProject nhưng task này chưa gắn ticket. Mã commit mặc định: \`${input.defaultRef || 'chưa đặt defaultRef'}\``;
  const status = input.source?.inProgressStatusId == null ? 'In progress theo cấu hình nguồn' : `In progress (status ${input.source.inProgressStatusId})`;
  const done = input.source?.autoResolve === false ? 'comment kết quả; không tự chuyển Done' : input.source?.resolvedStatusId == null ? 'comment kết quả; trạng thái kết thúc theo cấu hình nguồn' : `comment kết quả rồi chuyển Resolved (status ${input.source.resolvedStatusId})`;
  const lifecycle = input.externalRef
    ? `\n- Khi bắt đầu làm: hub tự chuyển ticket sang ${status}. Khi xong: hub sẽ ${done}.`
    : '';

  const bugTemplate = input.isBug
    ? `\n\n### Mẫu báo cáo DONE cho task sửa bug (bắt buộc đủ 4 mục để hub tự động ghi vào ticket):\n\`\`\`markdown\n### Lỗi\n<mô tả hiện tượng lỗi quan sát được>\n\n### Nguyên nhân\n<nguyên nhân gốc rễ, kèm vị trí file:dòng cụ thể>\n\n### Cách sửa\n<mô tả cách khắc phục, commit hash, hình ảnh nếu có>\n\n### Kiểm tra\n<các bước và kết quả kiểm tra>\n\`\`\``
    : `\n- Task lỗi cần thêm 4 mục: Lỗi / Nguyên nhân (file:dòng) / Cách sửa (commit, image) / Kiểm tra.`;

  return `\n\n## Quy trình ticket\n- ${refText}. Không tạo ticket tổng hợp hoặc ticket trùng; việc cùng chủ đề là ticket con.${lifecycle}\n- Nội dung báo cáo phải có '## Đã làm' và '## Còn lại' (checklist), không chứa secret.${bugTemplate}`;
}

export const PROTOCOL_PROMPT = buildProtocolPrompt({ worktree: { install: 'auto' } }, 'prepared');

export class EventBus extends EventEmitter {
  constructor(private eventRepo: EventRepo) {
    super();
  }

  emit(type: string, taskId?: string, payload?: unknown): boolean {
    this.eventRepo.insert(type, taskId, payload);
    super.emit('*', type, taskId, payload);
    return super.emit(type, taskId, payload);
  }

  emitEphemeral(type: string, taskId?: string, payload?: unknown): boolean {
    super.emit('*', type, taskId, payload);
    return super.emit(type, taskId, payload);
  }
}

interface RunningTask {
  runId: string;
  taskId: string;
  pid: number;
  pidStart: number | null;
  profileName: string;
  model: string;
  engine: Engine;
  startTime: number;
  timeoutMs: number;
  timeoutAt: number;
  retryCount: number;
  projectId: string;
  lastOutputAt: number;
  lastActivityAt: number;
  activitySource: ActivitySource;
  activityCheckedAt: number;
  cachedConversationMtime: number;
  cachedWorktreeMtime: number;
  usageBefore: number | null;
  lockFile?: string;
  lockSlot?: number;
  child?: ChildProcess;
  exitCode?: number | null;
  // Stall & looping detection
  lastCommitCheckAt?: number;
  lastCommitCount?: number;
  lastNoCommitThresholdEmitted?: number;
  noCommitMinutes?: number;
  isLooping?: boolean;
  loopingCommand?: string;
  commandOccurrences?: Array<{ command: string; timestamp: number }>;
  lastLogOffset?: number;
  // Resource metrics & Pause/Resume
  rss?: number;
  cpu?: number;
  lastTicks?: number;
  lastTicksAt?: number;
  paused?: boolean;
  pauseReason?: 'manual' | 'load' | 'brain_load' | 'focus' | null;
  pausedAt?: number | null;
  pauseReminded?: boolean;
  referenceSnapshots?: ReferenceSnapshot[];
  adopted?: boolean;
}

interface StartingTask {
  projectId: string;
  profileName: string;
}


type ReviewSource = 'content' | 'operational';

function isContentReview(by: string | undefined, source: ReviewSource): boolean {
  return source === 'content' && (isAutoReviewer(by) || by === 'claude-review');
}

/** Times an arbiter rejection sends a task back before it is blocked for a person. */
const ARBITER_ROUNDS = 2;
const ARBITER_RETRY_MODEL = 'claude-opus-4-6-thinking';
const REVIEWER_CRASH_BACKOFF_MS = 60_000;
const REVIEWER_LOCK_BACKOFF_MS = 10_000;

export interface ReviewerRun {
  taskId: string;
  runId: string;
  pid: number;
  profileName: string;
  engine: Engine;
  actor: ReviewerActor;
  outputPath: string;
  lockSlot: number;
  lockFile?: string;
  startedAt: number;
  timeout: NodeJS.Timeout;
  exitTimeout?: NodeJS.Timeout;
}

type ReviewerPick = { engine: Engine; model: string; profile: ProfileRow } | { wait: true };

interface QueuedCheck {
  taskId: string;
  runId: string;
  queuedAt: number;
  reuseSavedResults: boolean;
  resolve: () => void;
}

export type RestartActivityKind = 'run' | 'check' | 'review';
export interface RestartWaitingActivity {
  taskId: string;
  kind: RestartActivityKind;
  startedAt: number;
}
export interface RestartState {
  draining: boolean;
  since: number | null;
  reason: string | null;
  timeoutAt: number | null;
  waitingFor: RestartWaitingActivity[];
}

const STALL_NOTE = 'Lượt trước bị kẹt khi chờ tác vụ nền. Chạy lệnh trực tiếp với timeout.';

export interface SchedulerOptions {
  diskSpace?: (path: string) => DiskSpace;
}

export interface CancelInfo {
  /** Lý do hủy do người/hệ thống đưa ra. */
  reason?: string | null;
  /** Nguồn hủy: dashboard, telegram:<user>, mcp:<client>, system:<what>. */
  by?: string | null;
}

export class Scheduler {
  private running: Map<string, RunningTask> = new Map(); // taskId -> RunningTask
  /** Bumped by stop(); a start that began before it must not spawn afterwards. */
  private stopGeneration = 0;
  // Reservations made synchronously before startTask reaches its first await.
  // This closes the dispatch race where several queued tasks are started in one tick.
  private starting: Map<string, StartingTask> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private inTick = false;
  private skipSchedulingOnce = false;
  private diskLow = false;
  private lastDiskLowEmit = 0;
  private diskBlockedEmitted = false;
  private diskIncidents = new Map<string, { lastLowEmit: number; blockedEmitted: boolean }>();
  private dockerDiskLow = false;
  private tasksWaitingForDisk = new Set<string>();
  private unavailableProjects = new Set<string>();
  private tasksWaitingForProject = new Set<string>();
  private eventBus: EventBus;
  private quotaService: QuotaService;
  private worktreeService: WorktreeService;
  private engines: Map<string, Engine> = new Map();
  private locks: ProfileLockService;
  private checkRunner?: CheckRunner;
  private db?: Database.Database;
  private taskNoteRepo?: TaskNoteRepo;
  private trackerRepo?: TrackerItemRepo;
  private runMetricsRepo?: RunMetricsRepo;
  private knowledgeRepo?: KnowledgeRepo;
  private reviewRepo?: ReviewRepo;
  private failoverState?: ClaudeFailoverState;
  private bulletinService?: { updateBulletinForTask: (task: TaskRow) => void };
  private reviewerRuns = new Map<string, ReviewerRun>();
  /** Prevent a broken reviewer profile from being respawned on every scheduler tick. */
  private reviewerBackoffUntil = new Map<string, number>();
  private reviewNotified = new Map<string, string>();
  private reviewWaitingNotified = new Map<string, { reason: string; at: number }>();
  private failoverWasActive = false;
  private reviewerErrorCounts = new Map<string, number>();
  private reviewerFallbackNotified = new Set<string>();
  private lastOrphanScan = 0;
  private lastMergedTasksCheck = 0;
  private autoClosingMerged = false;
  private mergingTasks = new Set<string>();
  private readonly worktreeCleanupRetryAt = new Map<string, number>();
  private readonly worktreeCleanupLogged = new Set<string>();
  private readonly dirtyWorktreeLogged = new Set<string>();
  private recheckWaitingOnDiskOk = true;
  private loadGuard: LoadGuard;
  private lastLoadOverloaded = false;
  private lastLoadHighEventAt: number | null = null;
  private lastLoadHighEventSnapshot: LoadSnapshot | null = null;
  private notifiedSkippedModels = new Set<string>();
  private resourceTimer: ReturnType<typeof setInterval> | null = null;
  private diskReader: (p: string) => DiskSpace = getDiskSpaceSync;
  private usageService?: QuotaUsageService;
  private checkingQueue: QueuedCheck[] = [];
  private checkingActive = new Map<string, QueuedCheck>();
  private checkingPromises = new Map<string, Promise<void>>();
  private checkingRunIds = new Map<string, string>();
  private checkingWorktrees = new Set<string>();
  private restartState: Omit<RestartState, 'waitingFor'> = { draining: false, since: null, reason: null, timeoutAt: null };
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartReady?: () => void;

  constructor(
    private config: AgentHubConfig,
    private taskRepo: TaskRepo,
    private runRepo: RunRepo,
    private eventRepo: EventRepo,
    private projectRepo: ProjectRepo,
    private profileRepo: ProfileRepo,
    private quotaMarkRepo: QuotaMarkRepo,
    engineOverrides?: Map<string, Engine> | SchedulerOptions,
    usageServiceOrOptions?: QuotaUsageService | SchedulerOptions,
    locks?: ProfileLockService,
    db?: Database.Database,
    runMetricsRepo?: RunMetricsRepo,
    knowledgeRepo?: KnowledgeRepo,
    diskReader?: ((p: string) => DiskSpace) | SchedulerOptions,
    private departmentRepo?: DepartmentRepo,
  ) {
    this.eventBus = new EventBus(eventRepo);
    this.quotaService = new QuotaService(quotaMarkRepo, profileRepo);
    this.worktreeService = new WorktreeService(config, this.eventBus);
    this.loadGuard = new LoadGuard(config.load);
    this.locks = locks || new ProfileLockService(path.join(config.agyHomesDir, '.state'), config.slotsPerAgyProfile, config.slotsPerCodexProfile);
    this.db = db;
    // Drain is process-local. A daemon started after an unclean kill must not
    // inherit a stale flag that would stop dispatch forever.
    if (this.db) this.db.prepare("DELETE FROM meta WHERE key = 'restart.drain'").run();
    this.runMetricsRepo = runMetricsRepo;
    this.knowledgeRepo = knowledgeRepo;
    if (db) {
      this.checkRunner = new CheckRunner(db);
      this.taskNoteRepo = new TaskNoteRepo(db);
      this.trackerRepo = new TrackerItemRepo(db);
    }

    if (engineOverrides && !(engineOverrides instanceof Map) && 'diskSpace' in engineOverrides) {
      if (engineOverrides.diskSpace) this.diskReader = engineOverrides.diskSpace;
    } else if (engineOverrides instanceof Map) {
      this.engines = engineOverrides;
    }

    if (usageServiceOrOptions && 'diskSpace' in usageServiceOrOptions && typeof usageServiceOrOptions.diskSpace === 'function') {
      this.diskReader = usageServiceOrOptions.diskSpace;
    } else if (usageServiceOrOptions && 'getForProfile' in usageServiceOrOptions) {
      this.usageService = usageServiceOrOptions as QuotaUsageService;
    }

    if (typeof diskReader === 'function') {
      this.diskReader = diskReader;
    } else if (diskReader && typeof diskReader === 'object' && diskReader.diskSpace) {
      this.diskReader = diskReader.diskSpace;
    }


    if (!engineOverrides || !(engineOverrides instanceof Map)) {
      this.engines.set('agy', new AgyEngine());
      const codexPath = CodexEngine.findCodexPath();
      if (codexPath) {
        this.engines.set('codex', new CodexEngine(codexPath, this.config.workers?.codexSandbox || 'off'));
      }
    }

    this.eventBus.on('profile.created', () => this.wakeWaitingQuotaTasks('profile_created'));
    this.eventBus.on('profile.updated', () => this.wakeWaitingQuotaTasks('profile_updated'));
    this.eventBus.on('department.changed', () => this.wakeWaitingQuotaTasks('department_changed'));
    this.eventBus.on('quota.cleared', () => this.wakeWaitingQuotaTasks('quota_cleared'));
    this.eventBus.on('claude.quota_available', () => this.wakeWaitingQuotaTasks('quota_available'));
    this.eventBus.on('load.ok', () => {
      if (!this.inTick) {
        if (!this.loadGuard.isOverloaded()) {
          const autoPaused = Array.from(this.running.values())
            .filter((rt) => rt.paused && (rt.pauseReason === 'load' || rt.pauseReason === 'brain_load'))
            .sort((a, b) => (a.pausedAt || 0) - (b.pausedAt || 0));
          if (autoPaused.length > 0) {
            const nextToResume = autoPaused[0];
            this.resumeTask(nextToResume.taskId);
            this.eventBus.emit('load.task_resumed', nextToResume.taskId, { reason: 'recovered' });
          }
        }
        if (!this.stopped) {
          this.triggerTick();
        }
      }
    });
    this.eventBus.on('task.done', (taskId) => this.onTaskDoneOrCancelled(taskId));
    this.eventBus.on('task.cancelled', (taskId) => this.onTaskDoneOrCancelled(taskId));
    this.eventBus.on('task.queued', (taskId) => {
      this.invalidateChecks(taskId);
      if (this.restartState.draining) this.markRestartWaiter(taskId);
    });
  }

  getCheckResults(taskId: string) { return this.db ? getCheckResults(this.db, taskId) : []; }
  getDatabase(): Database.Database | undefined { return this.db; }

  private schedulerLimits() {
    return this.config.scheduler || this.config.schedulerLimits;
  }

  private isProfileCooling(profile: ProfileRow, now = Date.now()): boolean {
    if (!profile.coolingUntil) return false;
    if (profile.coolingUntil > now / 1000) return true;
    this.profileRepo.resetCrashes(profile.name);
    return false;
  }

  private blockForRunLimit(task: TaskRow): boolean {
    const limits = this.schedulerLimits();
    const runCount = task.runCount || 0;
    const crashes = task.consecutiveCrashes || 0;
    if (runCount < limits.maxRunsPerTask && crashes < limits.maxConsecutiveCrashesPerTask) return false;
    const message = runCount >= limits.maxRunsPerTask
      ? `vượt giới hạn ${limits.maxRunsPerTask} lượt chạy cho mỗi task`
      : `vượt giới hạn ${limits.maxConsecutiveCrashesPerTask} crash liên tiếp cho mỗi task`;
    this.taskRepo.update(task.id, { status: 'blocked', waitReason: null, notBefore: null });
    this.eventBus.emit('task.blocked', task.id, { reason: 'run_limit', message, runCount, consecutiveCrashes: crashes });
    return true;
  }

  private recordWorkerCrash(taskId: string, rt: RunningTask, reason?: string): boolean {
    this.runRepo.finish(rt.runId, 'crashed', undefined, reason);
    const task = this.taskRepo.get(taskId);
    if (!task) return false;
    const crashes = (task.consecutiveCrashes || 0) + 1;
    this.taskRepo.update(taskId, { consecutiveCrashes: crashes });
    const profile = this.profileRepo.get(rt.profileName);
    if (profile) {
      const now = Date.now();
      if (profile.lastCrashAt && now - profile.lastCrashAt > this.config.profileCooling.windowMin * 60_000) this.profileRepo.resetCrashes(profile.name);
      const inWindow = profile.lastCrashAt != null && now - profile.lastCrashAt <= this.config.profileCooling.windowMin * 60_000;
      const nextCount = inWindow ? (profile.consecutiveCrashes || 0) + 1 : 1;
      const coolingUntil = nextCount >= this.config.profileCooling.threshold
        ? Math.floor((now + this.config.profileCooling.coolingMin * 60_000) / 1000)
        : null;
      this.profileRepo.recordCrash(profile.name, now, coolingUntil);
      if (coolingUntil) this.eventBus.emit('profile.cooling', taskId, { profile: profile.name, until: coolingUntil, reason: 'consecutive_crashes' });
    }
    const limits = this.schedulerLimits();
    if (crashes >= limits.maxConsecutiveCrashesPerTask || (task.runCount || 0) >= limits.maxRunsPerTask) {
      const message = crashes >= limits.maxConsecutiveCrashesPerTask
        ? `vượt giới hạn ${limits.maxConsecutiveCrashesPerTask} crash liên tiếp cho mỗi task`
        : `vượt giới hạn ${limits.maxRunsPerTask} lượt chạy cho mỗi task`;
      this.taskRepo.update(taskId, { status: 'blocked', waitReason: null, notBefore: null });
      this.eventBus.emit('task.blocked', taskId, { reason: 'run_limit', message, runCount: task.runCount || 0, consecutiveCrashes: crashes });
      return true;
    }
    return false;
  }

  private recordWorkerSuccess(profileName: string, taskId: string): void {
    this.profileRepo.resetCrashes(profileName);
    this.taskRepo.update(taskId, { consecutiveCrashes: 0 });
  }

  configureReviewer(reviewRepo: ReviewRepo, failoverState: ClaudeFailoverState): void {
    this.reviewRepo = reviewRepo;
    this.failoverState = failoverState;
  }

  configureBulletinService(bulletinService: { updateBulletinForTask: (task: TaskRow) => void }): void {
    this.bulletinService = bulletinService;
  }

  getReviewerStatus(): { active: boolean; running: string[]; waiting: number } {
    const active = this.failoverState?.snapshot().active === true;
    return { active, running: [...this.reviewerRuns.keys()], waiting: active ? Math.max(0, this.taskRepo.getByStatus('review').length - this.reviewerRuns.size) : 0 };
  }

  getReviewerRun(taskId: string): ReviewerRun | undefined {
    return this.reviewerRuns.get(taskId);
  }

  getReviewerRuns(): Map<string, ReviewerRun> {
    return this.reviewerRuns;
  }

  getRestartSnapshot(projectId?: string): { checks: number; editing: number } {
    const editing = projectId
      ? [...this.running.values()].filter((running) => running.projectId === projectId).length
      : this.running.size;
    return { checks: this.checkingActive.size, editing };
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getEngines(): Map<string, Engine> {
    return this.engines;
  }

  getQuotaService(): QuotaService {
    return this.quotaService;
  }

  refreshEngines(): void {
    if (this.engines.has('codex')) return;
    const codexPath = CodexEngine.findCodexPath();
    if (codexPath) this.engines.set('codex', new CodexEngine(codexPath, this.config.workers?.codexSandbox || 'off'));
  }

  getRunning(): Map<string, RunningTask> {
    for (const runningTask of this.running.values()) this.refreshActivity(runningTask);
    return this.running;
  }

  getRestartState(): RestartState {
    const waitingFor: RestartWaitingActivity[] = [
      ...[...this.running.values()].map((run) => ({ taskId: run.taskId, kind: 'run' as const, startedAt: run.startTime })),
      ...[...this.checkingActive.values()].map((check) => ({ taskId: check.taskId, kind: 'check' as const, startedAt: check.queuedAt })),
      ...[...this.reviewerRuns.values()].map((review) => ({ taskId: review.taskId, kind: 'review' as const, startedAt: review.startedAt })),
    ];
    return { ...this.restartState, waitingFor };
  }

  isDraining(): boolean { return this.restartState.draining; }

  beginRestartDrain(timeoutMinutes = 120, reason?: string, onReady?: () => void): RestartState {
    const now = Date.now();
    const timeoutAt = now + Math.max(1, timeoutMinutes) * 60_000;
    this.restartState = { draining: true, since: this.restartState.since || now, reason: reason?.trim() || null, timeoutAt };
    this.restartReady = onReady;
    this.markQueuedTasksForRestart();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.restartState.draining) return;
      const waitingFor = this.getRestartState().waitingFor;
      this.restartState = { draining: false, since: null, reason: null, timeoutAt: null };
      this.restartReady = undefined;
      this.eventBus.emit('hub.restart_timeout', undefined, { waitingFor });
      this.persistRestartState();
      void this.recoverCheckingTasks();
    }, Math.max(1, timeoutMinutes) * 60_000);
    this.restartTimer.unref?.();
    this.persistRestartState();
    this.eventBus.emit('hub.restart_requested', undefined, { reason: this.restartState.reason, timeoutAt });
    this.eventBus.emit('hub.restart_draining', undefined, { waiting: this.getRestartState().waitingFor.length });
    this.maybeFinishRestartDrain();
    return this.getRestartState();
  }

  cancelRestartDrain(): RestartState {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const wasDraining = this.restartState.draining;
    this.restartState = { draining: false, since: null, reason: null, timeoutAt: null };
    this.restartReady = undefined;
    for (const task of this.taskRepo.getByStatus('queued')) {
      if (task.waitReason === 'restart') this.taskRepo.update(task.id, { status: 'queued', waitReason: null });
    }
    this.persistRestartState();
    if (wasDraining) {
      this.eventBus.emit('hub.restart_cancelled');
      void this.recoverCheckingTasks();
    }
    this.triggerTick();
    return this.getRestartState();
  }

  private persistRestartState(): void {
    if (!this.db) return;
    if (this.restartState.draining) this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('restart.drain', ?)").run(JSON.stringify(this.restartState));
    else this.db.prepare("DELETE FROM meta WHERE key = 'restart.drain'").run();
  }

  private markRestartWaiter(taskId: string): void {
    const task = this.taskRepo.get(taskId);
    if (task?.status === 'queued' && task.waitReason !== 'restart') {
      this.taskRepo.update(taskId, { status: 'queued', waitReason: 'restart' });
    }
  }

  private markQueuedTasksForRestart(): void {
    for (const task of this.taskRepo.getByStatus('queued')) this.markRestartWaiter(task.id);
  }

  private maybeFinishRestartDrain(): void {
    if (!this.restartState.draining || this.getRestartState().waitingFor.length > 0) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.eventBus.emit('hub.restarting', undefined, { reason: this.restartState.reason });
    this.restartReady?.();
  }

  effectiveParallel(project: { maxParallel: number; id?: string; departmentId?: string }): number {
    const department = project.departmentId ? this.departmentRepo?.get(project.departmentId) : undefined;
    const departmentLimit = department?.maxParallel && department.maxParallel > 0 ? department.maxParallel : project.maxParallel;
    const projectLimit = Math.min(project.maxParallel, departmentLimit);
    const focus = this.getFocus();
    const load = this.loadGuard.getStatus();
    if (focus.projectId && project.id === focus.projectId && load.highSince === null) return projectLimit;
    return this.loadGuard.effectiveParallel(projectLimit);
  }

  private parallelUsage(project: { id: string; departmentId?: string }): { project: number; department: number } {
    const active = [...this.running.values(), ...this.starting.values()];
    return {
      project: active.filter((task) => task.projectId === project.id).length,
      department: project.departmentId
        ? active.filter((task) => this.projectRepo.get(task.projectId)?.departmentId === project.departmentId).length
        : 0,
    };
  }

  private hasParallelCapacity(project: { id: string; maxParallel: number; departmentId?: string }): boolean {
    const usage = this.parallelUsage(project);
    if (usage.project >= this.effectiveParallel(project)) return false;
    const department = project.departmentId ? this.departmentRepo?.get(project.departmentId) : undefined;
    return !department || department.maxParallel <= 0 || usage.department < this.loadGuard.effectiveParallel(department.maxParallel);
  }

  private departmentPriority(task: TaskRow): number {
    const project = this.projectRepo.get(task.projectId);
    return project?.departmentId ? this.departmentRepo?.get(project.departmentId)?.priority || 0 : 0;
  }

  /** Priority is also the department's fair-share weight; zero remains eligible. */
  private departmentWeight(task: TaskRow): number {
    return Math.max(1, this.departmentPriority(task));
  }

  private departmentIdForTask(task: TaskRow): string {
    return this.projectRepo.get(task.projectId)?.departmentId || 'chung';
  }

  private departmentProfileAssignments(profileName: string): Array<{ departmentId: string; share: number | null }> {
    if (!this.departmentRepo) return [];
    return this.departmentRepo.getAll().flatMap((department) => this.departmentRepo!.profiles(department.id)
      .filter((assignment) => assignment.profileName === profileName)
      .map((assignment) => ({ departmentId: assignment.departmentId, share: assignment.share })));
  }

  private profileAllowedForDepartment(profileName: string, departmentId: string): boolean {
    const assignments = this.departmentProfileAssignments(profileName);
    return assignments.length === 0 || assignments.some((assignment) => assignment.departmentId === departmentId);
  }

  private profileShare(profileName: string, departmentId: string): number {
    const assignments = this.departmentProfileAssignments(profileName);
    if (assignments.length === 0) return 1;
    const assignment = assignments.find((item) => item.departmentId === departmentId);
    if (!assignment) return 0;
    return Math.max(0.01, assignment.share ?? 1);
  }

  private profileDepartmentLoad(profileName: string, departmentId: string): number {
    const active = [...this.running.values(), ...this.starting.values()];
    return active.filter((task) => {
      if (task.profileName !== profileName) return false;
      return (this.projectRepo.get(task.projectId)?.departmentId || 'chung') === departmentId;
    }).length;
  }

  private claudeBudgetAvailable(task: TaskRow): boolean {
    const project = this.projectRepo.get(task.projectId);
    const department = project?.departmentId ? this.departmentRepo?.get(project.departmentId) : undefined;
    if (!department || department.claudeDailyTokenBudget <= 0 || !this.db) return true;
    return (this.departmentRepo?.claudeUsageToday(department.id) || 0) < department.claudeDailyTokenBudget;
  }

  getLoadStatus(): LoadSnapshot {
    return this.loadGuard.getStatus();
  }

  private paused = false;

  pause(): void {
    this.paused = true;
    this.eventBus.emit('scheduler.paused', undefined, { paused: true });
  }

  resume(): void {
    this.paused = false;
    this.eventBus.emit('scheduler.resumed', undefined, { paused: false });
    this.triggerTick();
  }

  isPaused(): boolean {
    return this.paused;
  }

  pauseTask(taskId: string, reason: 'manual' | 'load' | 'brain_load' | 'focus' = 'manual'): boolean {
    const rt = this.running.get(taskId);
    if (!rt) return false;
    if (rt.paused) return true;

    try {
      process.kill(-rt.pid, 'SIGSTOP');
    } catch {
      try {
        process.kill(rt.pid, 'SIGSTOP');
      } catch {
        // process may have exited
      }
    }

    rt.paused = true;
    rt.pauseReason = reason;
    rt.pausedAt = Date.now();
    rt.pauseReminded = false;

    this.eventBus.emit('task.paused', taskId, { reason, runId: rt.runId });
    return true;
  }

  resumeTask(taskId: string): boolean {
    const rt = this.running.get(taskId);
    if (!rt) return false;
    if (!rt.paused) return true;

    try {
      process.kill(-rt.pid, 'SIGCONT');
    } catch {
      try {
        process.kill(rt.pid, 'SIGCONT');
      } catch {
        // process may have exited
      }
    }

    if (rt.pausedAt) {
      const pausedDuration = Date.now() - rt.pausedAt;
      rt.timeoutAt += pausedDuration;
    }

    rt.paused = false;
    rt.pauseReason = null;
    rt.pausedAt = null;
    rt.pauseReminded = false;
    rt.lastActivityAt = Date.now();
    rt.lastOutputAt = Date.now();
    if (rt.lastCommitCheckAt) {
      rt.lastCommitCheckAt = Date.now();
    }

    this.eventBus.emit('task.resumed', taskId, { runId: rt.runId });
    return true;
  }

  getFocus(): AgentHubConfig['focus'] {
    return this.config.focus || { projectId: null, since: null, pauseRunning: true };
  }

  applyFocus(): { paused: number; resumed: number; waiting: number } {
    const focus = this.getFocus();
    let paused = 0;
    let resumed = 0;
    let waiting = 0;
    for (const rt of this.running.values()) {
      if (!focus.projectId || rt.projectId === focus.projectId) {
        if (rt.paused && rt.pauseReason === 'focus' && this.resumeTask(rt.taskId)) resumed++;
      } else if (focus.pauseRunning) {
        if (!rt.paused && this.pauseTask(rt.taskId, 'focus')) paused++;
      } else if (rt.paused && rt.pauseReason === 'focus' && this.resumeTask(rt.taskId)) {
        resumed++;
      }
    }
    for (const task of this.taskRepo.getByStatus('queued')) {
      if (focus.projectId && task.projectId !== focus.projectId) {
        if (task.waitReason !== 'focus') {
          this.taskRepo.update(task.id, { status: 'queued', waitReason: 'focus' });
          this.eventBus.emit('task.queued', task.id, { reason: 'focus', projectId: focus.projectId });
        }
        waiting++;
      } else if (task.waitReason === 'focus') {
        this.taskRepo.update(task.id, { status: 'queued', waitReason: null });
        this.eventBus.emit('task.queued', task.id, { reason: 'focus_cleared' });
      }
    }
    this.pumpChecks();
    return { paused, resumed, waiting };
  }

  measureTaskResources(rt: RunningTask): void {
    const task = this.taskRepo.get(rt.taskId);
    const prev = rt.lastTicks !== undefined && rt.lastTicksAt !== undefined
      ? { ticks: rt.lastTicks, time: rt.lastTicksAt }
      : undefined;

    const metrics = measureProcessTree(rt.pid, task?.worktreePath, prev);
    rt.rss = metrics.rss;
    rt.cpu = metrics.cpu;
    rt.lastTicks = metrics.totalTicks;
    rt.lastTicksAt = metrics.measuredAt;
  }

  measureAllRunningTaskResources(): void {
    for (const rt of this.running.values()) {
      this.measureTaskResources(rt);
    }
  }

  start(): void {
    this.stopped = false;
    this.lastOrphanScan = 0;
    // Recover crashed runs on startup
    this.adoptRunningRuns();
    this.applyFocus();
    this.skipSchedulingOnce = true;

    // Start the scheduler loop (every 2 seconds)
    this.timer = setInterval(() => this.tick(), 2000);
    // Measure task resources every 15s
    this.measureAllRunningTaskResources();
    this.resourceTimer = setInterval(() => this.measureAllRunningTaskResources(), 15000);
    this.resourceTimer.unref();
    // Also run immediately
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.resourceTimer) {
      clearInterval(this.resourceTimer);
      this.resourceTimer = null;
    }

    // Requirement 4: Khi daemon tắt/khởi động lại: mọi task đang paused phải được SIGCONT trước (không để tiến trình đứng mãi).
    for (const rt of this.running.values()) {
      if (rt.paused) {
        try {
          process.kill(-rt.pid, 'SIGCONT');
        } catch {
          try {
            process.kill(rt.pid, 'SIGCONT');
          } catch {
            // ignore
          }
        }
        rt.paused = false;
        rt.pauseReason = null;
      }
    }

    this.stopped = true;
    this.stopGeneration += 1;
    this.starting.clear();

    for (const run of this.reviewerRuns.values()) {
      clearTimeout(run.timeout);
      if (run.exitTimeout) {
        clearTimeout(run.exitTimeout);
      }
      if (run.lockFile) {
        this.locks.release(run.profileName, run.lockFile);
      }
    }
    this.reviewerRuns.clear();
    this.locks.clearReservations();
    for (const entry of this.checkingQueue.splice(0)) entry.resolve();
    this.checkingPromises.clear();
  }

  cancelAll(): void {
    for (const taskId of [...this.running.keys()]) {
      this.pendingCancel.set(taskId, { reason: 'AgentHub dừng, task đang chạy bị hủy', by: 'system:shutdown' });
      this.killTask(taskId, 'cancelled');
    }
  }

  /** Lý do/người hủy chờ ghi khi run kết thúc với outcome "cancelled". */
  private pendingCancel = new Map<string, CancelInfo>();

  private recordCancel(taskId: string, info?: CancelInfo): CancelInfo {
    const resolved: CancelInfo = {
      reason: info?.reason?.trim() || null,
      by: info?.by?.trim() || null,
    };
    this.taskRepo.update(taskId, { status: 'cancelled', cancelReason: resolved.reason, cancelledBy: resolved.by });
    return resolved;
  }

  private logOffset(logPath: string | null | undefined): number {
    if (!logPath) return 0;
    try { return fs.statSync(logPath).size; } catch { return 0; }
  }

  private getEngineBinaryTokens(engine: Engine): string[] {
    const tokens = new Set<string>();
    const engineWithBin = engine as unknown as { scriptPath?: string; agyPath?: string };
    if (engineWithBin.scriptPath) {
      tokens.add(path.basename(engineWithBin.scriptPath));
      tokens.add(path.basename(engineWithBin.scriptPath, path.extname(engineWithBin.scriptPath)));
    }
    if (engineWithBin.agyPath) {
      tokens.add(path.basename(engineWithBin.agyPath));
      tokens.add(path.basename(engineWithBin.agyPath, path.extname(engineWithBin.agyPath)));
    }
    if (engine.id === 'agy') {
      const configured = process.env.AGENTHUB_AGY_BIN?.trim() || findAgyBin();
      if (configured) {
        tokens.add(path.basename(configured));
        tokens.add(path.basename(configured, path.extname(configured)));
      }
      tokens.add('agy');
    } else if (engine.id === 'codex') {
      const configured = process.env.AGENTHUB_CODEX_BIN?.trim() || CodexEngine.findCodexPath();
      if (configured) {
        tokens.add(path.basename(configured));
        tokens.add(path.basename(configured, path.extname(configured)));
      }
      tokens.add('codex');
    } else {
      tokens.add(engine.id);
    }
    return [...tokens].filter(Boolean);
  }

  private isWorkerProcessForRun(pid: number, task: TaskRow, engine: Engine): boolean {
    if (!task.worktreePath) return false;
    const worktree = path.resolve(task.worktreePath);
    const tokens = this.getEngineBinaryTokens(engine);
    const pattern = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const commandMatches = (command: string): boolean =>
      pattern.length > 0 && new RegExp(`(?:^|[\\s/])(?:${pattern})(?:$|[\\s/])`, 'i').test(command);
    try {
      let realCwd: string;
      let realWorktree: string;
      try {
        realCwd = fs.realpathSync(`/proc/${pid}/cwd`);
        realWorktree = fs.realpathSync(worktree);
      } catch {
        return false;
      }
      if (realCwd !== realWorktree) return false;
      const command = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replaceAll('\0', ' ');
      // The recorded PID may be the flock/nice/ionice wrapper, so match the
      // engine token anywhere in argv rather than assuming a fixed argv[0].
      return commandMatches(command);
    } catch {
      // macOS has no /proc. Use ps for the command and lsof for the cwd so a
      // live but unrelated process cannot be mistaken for the old worker.
      if (process.platform !== 'darwin') return false;
      try {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
        const cwdLine = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
          .split('\n').find((line) => line.startsWith('n'))?.slice(1);
        if (!cwdLine) return false;
        let realCwd: string;
        let realWorktree: string;
        try {
          realCwd = fs.realpathSync(cwdLine);
          realWorktree = fs.realpathSync(worktree);
        } catch {
          return false;
        }
        return Boolean(realCwd === realWorktree && commandMatches(command));
      } catch {
        return false;
      }
    }
  }

  /** Persist a resumable state before the service manager terminates the daemon. */
  shutdownForUser(reason = 'user_stop'): { queued: number; reviewers: number; childPids: number[] } {
    const childPids: number[] = [];
    let queued = 0;
    for (const rt of [...this.running.values()]) {
      if (rt.pid) childPids.push(rt.pid);
      if (reason === 'hub_handoff') {
        // Handoff deliberately leaves the detached worker and its flock alive.
        // The new daemon adopts it and observes completion by polling; there is
        // no ChildProcess handle here, therefore the eventual exit code is unknown.
        this.runRepo.markHandoff(rt.runId, {
          pid: rt.pid,
          pgid: rt.pid,
          logOffset: this.logOffset(this.runRepo.get(rt.runId)?.logPath),
          lockFile: rt.lockFile,
        });
        this.eventBus.emit('run.handoff', rt.taskId, { runId: rt.runId, pid: rt.pid, note: 'Hub khởi động lại, tiếp tục theo dõi worker' });
        continue;
      }
      this.killProcessGroup(rt.pid, 'SIGTERM');
      this.running.delete(rt.taskId);
      if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
      this.locks.invalidate(rt.profileName);
      this.runRepo.finish(rt.runId, 'crashed', undefined, reason);
      if (reason === 'hub_restart') this.appendRestartLog(rt.runId);
      this.taskRepo.update(rt.taskId, { status: 'queued', resume: 1 });
      this.eventBus.emit('task.queued', rt.taskId, { reason, note: reason === 'hub_restart' ? 'hub khởi động lại' : 'dừng bởi người dùng' });
      queued++;
    }

    for (const entry of [...this.checkingActive.values(), ...this.checkingQueue]) {
      const task = this.taskRepo.get(entry.taskId);
      if (task && (task.status === 'checking' || task.status === 'running')) {
        if (reason === 'hub_handoff') {
          // Keep task in 'checking' status so recoverOnStartup re-runs only the check step
          if (task.status !== 'checking') {
            this.taskRepo.update(entry.taskId, { status: 'checking' });
          }
          continue;
        }
        this.taskRepo.update(entry.taskId, { status: 'queued', resume: 1 });
        this.eventBus.emit('task.queued', entry.taskId, { reason, note: reason === 'hub_restart' ? 'hub khởi động lại' : 'dừng bởi người dùng' });
        queued++;
      }
    }
    for (const entry of this.checkingQueue.splice(0)) entry.resolve();
    this.checkingActive.clear();
    this.checkingPromises.clear();
    this.checkingRunIds.clear();

    let reviewers = 0;
    for (const active of [...this.reviewerRuns.values()]) {
      if (active.pid) childPids.push(active.pid);
      this.killProcessGroup(active.pid, 'SIGTERM');
      clearTimeout(active.timeout);
      if (active.exitTimeout) clearTimeout(active.exitTimeout);
      if (active.lockFile) this.locks.release(active.profileName, active.lockFile);
      this.runRepo.finish(active.runId, 'crashed', undefined, reason);
      if (reason === 'hub_restart') this.appendRestartLog(active.runId);
      this.reviewerRuns.delete(active.taskId);
      reviewers++;
    }
    this.eventBus.emit('daemon.shutdown_requested', undefined, { queued, reviewers, reason, note: 'dừng bởi người dùng' });
    return { queued, reviewers, childPids };
  }

  private appendRestartLog(runId: string): void {
    const run = this.runRepo.get(runId);
    if (!run?.logPath) return;
    try { fs.appendFileSync(run.logPath, `\n[agenthub] Run bị dừng vì hub khởi động lại lúc ${new Date().toISOString()}\n`); } catch { /* best effort */ }
  }

  /**
   * On startup: mark any runs that were "running" but whose pid is no longer alive as crashed.
   * Re-queue their tasks.
   */
  private recoverOnStartup(): void {
    // A restart while startTask was preparing the worktree (status already 'running', no run row
    // yet) left tasks 'running' forever with nothing behind them; put them back in the queue.
    const liveRunTasks = new Set(this.runRepo.getRunning().map((run) => run.taskId));
    for (const task of this.taskRepo.getByStatus('running')) {
      if (liveRunTasks.has(task.id) || !this.projectRepo.get(task.projectId)) continue;
      this.taskRepo.update(task.id, { status: 'queued', resume: task.worktreePath ? 1 : 0 });
      this.eventBus.emit('task.queued', task.id, { reason: 'orphaned_start' });
    }

    // Checks interrupted by a restart left tasks 'checking' with nothing running. Re-run them when the
    // task's latest worker run finished cleanly (the only state that could have started checks).
    void this.recoverCheckingTasks();

    // Recover review tasks interrupted by restart.
    // Tasks waiting for manual approval (autoMerge off, or parked at manual gates)
    // must NOT re-emit review_ready or gate notifications on restart.
    for (const task of this.taskRepo.getByStatus('review')) {
      const project = this.projectRepo.get(task.projectId);
      if (!project) continue;
      const chain = this.reviewChainForTask(task);
      const stepIdx = task.reviewStep ?? 0;
      const settings = projectSettings(project);
      const autoMergeEnabled = Boolean(settings.review?.autoMerge || settings.integration?.autoMerge);
      const taskEvents = this.eventRepo.getByTask(task.id);

      const hasMergeOutcome = (): boolean => {
        const lastOutcomeEvent = taskEvents.filter((e) =>
          e.type === 'review.auto_merge_skipped' || e.type === 'merge.failed' || e.type === 'merge.conflict'
        ).at(-1);
        const lastReadyEvent = taskEvents.filter((e) => e.type === 'task.review_ready').at(-1);
        return Boolean(lastOutcomeEvent && (!lastReadyEvent || lastOutcomeEvent.id > lastReadyEvent.id));
      };

      if (chain.length === 0) {
        const lastReview = this.reviewRepo?.getByTask(task.id).at(-1);
        const hasApprovedAutoReview = Boolean(lastReview && isAutoReviewer(lastReview.actor) && lastReview.verdict === 'approved');

        if (hasApprovedAutoReview) {
          this.reviewNotified.set(task.id, 'complete:0');
          if (autoMergeEnabled && !hasMergeOutcome()) {
            const checks = this.getCheckResults(task.id);
            this.emitReviewReadyIfReview(task.id, {
              reviewChainComplete: true,
              checksPassed: checks.length > 0 ? checks.every((c) => c.ok) : true,
            });
          }
        } else {
          if (!autoMergeEnabled || task.reviewerEscalated) {
            this.reviewNotified.set(task.id, 'complete:0');
          }
          // Task đang chờ reviewer: không đánh dấu complete, không gửi thông báo;
          // scheduler tick bình thường sẽ dispatch reviewer.
        }
      } else if (stepIdx >= chain.length) {
        this.reviewNotified.set(task.id, `complete:${stepIdx}`);
        const lastReview = this.reviewRepo?.getByTask(task.id).at(-1);
        const hasApprovedAutoReview = Boolean(lastReview && isAutoReviewer(lastReview.actor) && lastReview.verdict === 'approved');
        if (autoMergeEnabled && hasApprovedAutoReview && !hasMergeOutcome()) {
          const checks = this.getCheckResults(task.id);
          this.emitReviewReadyIfReview(task.id, {
            reviewChainComplete: true,
            checksPassed: checks.length > 0 ? checks.every((c) => c.ok) : true,
          });
        }
      } else {
        const step = chain[stepIdx];
        if (step?.reviewer === 'claude') {
          const alreadyNotifiedGate = taskEvents.some((e) => {
            if (e.type !== 'review.gate_ready') return false;
            try {
              const p = e.payload ? JSON.parse(e.payload) as { reviewStep?: unknown } : {};
              return p.reviewStep === stepIdx;
            } catch {
              return false;
            }
          });
          if (alreadyNotifiedGate) {
            this.reviewNotified.set(task.id, `gate:${stepIdx}`);
          }
        } else if (isAutomatedStep(step)) {
          this.triggerTick();
        }
      }
    }

    const shutdownRuns = this.runRepo.getShutdownRuns();
    for (const run of shutdownRuns) {
      const task = this.taskRepo.get(run.taskId);
      if (task && this.projectRepo.get(task.projectId) && task.status === 'running') {
        this.taskRepo.update(run.taskId, { status: 'queued', resume: 1 });
        this.eventBus.emit('task.queued', run.taskId, { reason: 'daemon_shutdown' });
      }
    }

    const runningRuns = this.runRepo.getRunning();
    for (const run of runningRuns) {
      if (run.kind === 'reviewer') {
        // Reviewer runs are durable for audit/recovery only. Never restore one
        // into the worker map: after a daemon restart it is safer to stop the
        // old read-only process and schedule a fresh review.
        if (run.pid && this.isProcessAlive(run.pid, run.pidStart)) this.killProcessGroup(run.pid);
        this.runRepo.finish(run.id, 'crashed', undefined, 'reviewer interrupted during restart');
        if (this.taskRepo.get(run.taskId)?.status === 'review') {
          this.eventBus.emit('review.failed', run.taskId, { actor: 'codex-reviewer', reason: 'restart_recovery', runId: run.id });
          this.eventBus.emit('review.waiting', run.taskId, { actor: 'codex-reviewer', reason: 'restart_recovery' });
          this.triggerTick();
        }
        continue;
      }
      if (!this.isProcessAlive(run.pid, run.pidStart)) {
        const task = this.taskRepo.get(run.taskId);
        if (!task || !this.projectRepo.get(task.projectId)) continue;
        if (this.recoverFinishedWork(run)) continue;
        this.runRepo.finish(run.id, 'crashed', undefined, 'worker_crashed_during_restart');
        // Terminal tasks must remain terminal even when an old worker row is
        // found during daemon recovery.
        if (task.status === 'done' || task.status === 'pushed' || task.status === 'cancelled') continue;
        this.taskRepo.update(run.taskId, { status: 'queued', resume: 1 });
        this.eventBus.emit('run.crashed', run.taskId, {
          runId: run.id,
          model: run.model,
          engine: run.engine,
          profile: run.profileName,
        });
        this.eventBus.emit('task.queued', run.taskId, { reason: 'worker_crashed_during_restart' });
        continue;
      }

      const task = this.taskRepo.get(run.taskId);
      const engine = this.engines.get(run.engine);
      // Every durable worker row must pass the identity check, including rows
      // from a daemon crash without a handoff marker. The only compatibility
      // exception is an old pre-identity row with no handoff and no pidStart.
      const legacyRun = !run.handoff && run.pidStart == null;
      const processMatchesRun = legacyRun || (run.kind === 'worker' && Boolean(task && engine)
        ? this.isWorkerProcessForRun(run.pid || 0, task!, engine!)
        : false);
      if (!task || !engine || !run.pid || !processMatchesRun) {
        // A PID can be reused between daemon instances. Never adopt a process
        // unless both its worktree cwd and command identify this run's engine.
        // Block the task instead of immediately requeuing into the same worktree
        // so an unknown live process cannot clash with new worker execution.
        if (task && run.pid && run.kind === 'worker') {
          this.runRepo.finish(run.id, 'crashed', undefined, 'pid_reused_during_handoff');
          if (task.status === 'running') {
            const blockedReport = 'Tiến trình worker không khớp danh tính sau khi khởi động lại (PID có thể đã bị tái sử dụng). Cần kiểm tra trước khi tiếp tục.';
            this.taskRepo.update(run.taskId, { status: 'blocked', blockedReport, transientRetries: 0, notBefore: null });
            this.eventBus.emit('task.blocked', run.taskId, { reason: 'pid_reused_during_handoff' });
          }
        }
        continue;
      }

      try {
        process.kill(-run.pid, 'SIGCONT');
      } catch {
        try {
          process.kill(run.pid, 'SIGCONT');
        } catch {
          // ignore
        }
      }

      const startTime = parseDbTime(run.startedAt);
      const timeoutMs = this.config.defaultTimeout * 1000;
      const timeoutAt = Math.max(startTime + timeoutMs, Date.now() + 30 * 60 * 1000);
      if (timeoutAt > startTime + timeoutMs) {
        console.warn(`[scheduler] deferred timeout for recovered run ${run.id} until ${new Date(timeoutAt).toISOString()}`);
        this.eventBus.emit('run.timeout_deferred', run.taskId, { runId: run.id, timeoutAt: new Date(timeoutAt).toISOString() });
      }
      this.running.set(run.taskId, {
        runId: run.id,
        taskId: run.taskId,
        pid: run.pid,
        pidStart: run.pidStart,
        profileName: run.profileName,
        model: run.model,
        engine,
        startTime: Number.isNaN(startTime) ? Date.now() : startTime,
        timeoutMs,
        timeoutAt: Number.isNaN(startTime) ? Date.now() + timeoutMs : timeoutAt,
        retryCount: task.transientRetries,
        projectId: task.projectId,
        lastOutputAt: this.getLogMtime(run.logPath) || startTime,
        lastActivityAt: this.getLogMtime(run.logPath) || startTime,
        activitySource: 'log',
        activityCheckedAt: 0,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
        rss: 0,
        cpu: 0,
        paused: false,
        pauseReason: null,
        pausedAt: null,
        lockFile: run.lockFile || undefined,
        lastLogOffset: run.logOffset || 0,
        adopted: true,
      });
      if (run.lockFile) this.locks.reserve(run.profileName, run.lockFile);
      this.eventBus.emit('run.adopted', run.taskId, { taskId: run.taskId, runId: run.id, pid: run.pid, note: 'Hub khởi động lại, tiếp tục theo dõi worker' });
    }
  }

  /** Adopt live detached workers before the first scheduling tick. */
  private adoptRunningRuns(): void {
    this.recoverOnStartup();
  }

  private markerForRun(task: TaskRow, startedAt: number): 'done' | 'blocked' | null {
    if (!task.worktreePath) return null;
    for (const [name, marker] of [['done', 'DONE'], ['blocked', 'BLOCKED']] as const) {
      try {
        const stat = fs.statSync(path.join(task.worktreePath, '.agenthub', marker));
        if (stat.mtimeMs > startedAt) return name;
      } catch { /* marker absent */ }
    }
    return null;
  }

  private clearWorkerMarkers(worktreePath: string | null | undefined): void {
    if (!worktreePath) return;
    for (const marker of ['DONE', 'BLOCKED']) {
      try {
        fs.unlinkSync(path.join(worktreePath, '.agenthub', marker));
      } catch {
        // Marker is absent or already removed.
      }
    }
  }

  private hasCommitAfter(task: TaskRow, startedAt: number): boolean {
    const project = this.projectRepo.get(task.projectId);
    if (!project) return false;
    try {
      // The worktree HEAD is authoritative here. During restart the branch ref
      // may not be visible from the project checkout yet, while the commit is
      // already present in the worktree the worker was using.
      const output = execFileSync('git', ['log', '-1', '--format=%ct'], {
        cwd: task.worktreePath && fs.existsSync(task.worktreePath) ? task.worktreePath : project.path,
        encoding: 'utf8',
      }).trim();
      return Boolean(output) && Number(output) * 1000 > startedAt;
    } catch {
      return false;
    }
  }

  private recoverFinishedWork(run: { id: string; taskId: string; startedAt: string }): boolean {
    const task = this.taskRepo.get(run.taskId);
    if (!task) return false;
    // Only a worker that was running when its process disappeared may hand its
    // marker to the checker. In particular, never resurrect a queued/checking
    // task from an old marker during daemon recovery.
    const persistedRun = this.runRepo.get(run.id);
    if (task.status !== 'running' || persistedRun?.kind !== 'worker') return false;
    const activeWorkerRuns = this.runRepo
      .getByTask(run.taskId)
      .filter((candidate) => candidate.kind === 'worker' && candidate.outcome === null);
    if (activeWorkerRuns.length !== 1 || activeWorkerRuns[0].id !== run.id) return false;
    const parsedStartedAt = parseDbTime(run.startedAt);
    const startedAt = Number.isNaN(parsedStartedAt) ? 0 : parsedStartedAt;
    const marker = this.markerForRun(task, startedAt);
    if (marker === 'done') {
      this.runRepo.finish(run.id, 'done');
      this.taskRepo.update(run.taskId, { status: 'checking' });
      this.eventBus.emit('task.checking', run.taskId, { reason: 'restart_marker' });
      void this.recoverCheckingTasks(run.taskId, run.id).catch((error) => {
        if (!this.stopped) {
          console.error(`[scheduler] recoverCheckingTasks failed for ${run.taskId}:`, error);
        }
      });
      return true;
    }
    if (marker === 'blocked') {
      this.runRepo.finish(run.id, 'done');
      this.taskRepo.update(run.taskId, { status: 'blocked', transientRetries: 0, notBefore: null });
      this.eventBus.emit('task.blocked', run.taskId, { reason: 'restart_marker' });
      return true;
    }
    if (this.hasCommitAfter(task, startedAt)) {
      this.runRepo.finish(run.id, 'crashed', undefined, 'resume_after_progress');
      this.taskRepo.update(run.taskId, { status: 'queued', resume: 1 });
      this.eventBus.emit('task.queued', run.taskId, { reason: 'resume_after_progress' });
      return true;
    }
    return false;
  }

  async recoverCheckingTasks(taskId?: string, runId?: string): Promise<void> {
    if (this.stopped) return;
    if (this.restartState.draining) return;

    if (taskId && runId) {
      try {
        const task = this.taskRepo.get(taskId);
        const run = this.runRepo.get(runId);
        if (!task || task.status !== 'checking' || run?.taskId !== taskId || run.kind !== 'worker' || run.outcome !== 'done') return;
        await this.runChecksForTask(taskId, runId, true);
      } catch (error) {
        if (!this.stopped) {
          console.error('[scheduler] recoverCheckingTasks failed:', error);
        }
      }
      return;
    }

    const tasks = this.taskRepo.getByStatus('checking');
    const promises: Promise<void>[] = [];
    for (const task of tasks) {
      if (!this.projectRepo.get(task.projectId)) continue;
      if (this.checkingActive.has(task.id) || this.checkingQueue.some((entry) => entry.taskId === task.id)) continue;
      const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
      if (!lastWorker || lastWorker.outcome !== 'done') continue;
      const p = this.runChecksForTask(task.id, lastWorker.id).catch((error) => {
        if (!this.stopped) console.error(`[scheduler] re-check failed for ${task.id}:`, error);
      });
      promises.push(p);
    }
    await Promise.all(promises);
  }

  recoverStuckCheckingTasks(): void {
    if (this.stopped) return;
    if (this.restartState.draining) return;

    const maxCheckingMin = this.config.scheduler?.maxCheckingMin ?? DEFAULT_SCHEDULER_LIMITS.maxCheckingMin ?? 30;
    const thresholdMs = maxCheckingMin * 60_000;
    const now = Date.now();

    for (const task of this.taskRepo.getByStatus('checking')) {
      if (!this.projectRepo.get(task.projectId)) continue;
      if (this.checkingActive.has(task.id) || this.checkingQueue.some((entry) => entry.taskId === task.id)) continue;
      if (this.running.has(task.id) || this.starting.has(task.id)) continue;
      const activeRuns = this.runRepo.getByTask(task.id).filter((r) => r.outcome === null);
      if (activeRuns.length > 0) continue;

      const changedAt = parseDbTime(task.statusChangedAt || task.updatedAt || task.createdAt);
      const waitedMs = Number.isNaN(changedAt) ? 0 : now - changedAt;
      if (waitedMs < thresholdMs) continue;

      const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
      if (!lastWorker || lastWorker.outcome !== 'done') continue;

      const waitedMinutes = Math.floor(waitedMs / 60_000);
      this.eventBus.emit('task.checking_recovered', task.id, {
        runId: lastWorker.id,
        waitedMinutes,
        maxCheckingMin,
        reason: 'stuck_checking',
      });

      void this.runChecksForTask(task.id, lastWorker.id).catch((error) => {
        if (!this.stopped) console.error(`[scheduler] stuck checking recovery failed for ${task.id}:`, error);
      });
    }
  }

  async runChecksForTask(taskId: string, runId: string, reuseSavedResults = false): Promise<void> {
    if (this.stopped) return;
    if (this.restartState.draining) return;
    const task = this.taskRepo.get(taskId);
    if (!task) return;
    // Checks are only admitted for the task state written by the worker
    // completion path. This prevents callers from turning a running/queued
    // task into checking with an arbitrary or stale run id.
    if (task.status !== 'checking') return;
    if (!this.isCurrentCompletedWorker(taskId, runId)) return;
    const currentRunId = this.checkingRunIds.get(taskId);
    const existing = this.checkingPromises.get(taskId);
    if (existing && currentRunId === runId) return existing;
    if (existing && currentRunId !== runId) this.invalidateChecks(taskId);
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.checkingPromises.set(taskId, promise);
    this.checkingRunIds.set(taskId, runId);
    this.checkingQueue.push({ taskId, runId, queuedAt: Date.now(), reuseSavedResults, resolve });
    this.pumpChecks();
    return promise;
  }

  async rerunFailedChecksForTask(taskId: string, runId: string, names: string[]): Promise<{ passed: boolean; failed: string[]; results: import('../checks.js').CheckResult[] }> {
    const task = this.taskRepo.get(taskId);
    const project = task ? this.projectRepo.get(task.projectId) : undefined;
    if (!task || !project || !names.length) return { passed: false, failed: names, results: [] };
    return this.checkRunner!.run(task, project, runId, { onlyNames: names });
  }

  private pumpChecks(): void {
    const limit = Math.max(1, this.config.checks?.maxConcurrent || 2);
    while (!this.stopped && this.checkingActive.size < limit) {
      const index = this.checkingQueue.findIndex((entry) => {
        const task = this.taskRepo.get(entry.taskId);
        const focus = this.getFocus();
        if (focus.projectId && task && task.projectId !== focus.projectId) return false;
        const worktree = task?.worktreePath || `project:${task?.projectId || entry.taskId}`;
        return !this.checkingWorktrees.has(worktree);
      });
      if (index < 0) return;
      const entry = this.checkingQueue.splice(index, 1)[0];
      const entryPromise = this.checkingPromises.get(entry.taskId);
      const task = this.taskRepo.get(entry.taskId);
      const worktree = task?.worktreePath || `project:${task?.projectId || entry.taskId}`;
      this.checkingActive.set(entry.taskId, entry);
      this.checkingWorktrees.add(worktree);
      void this.executeChecksForTask(entry.taskId, entry.runId, entry.reuseSavedResults)
        .catch((error) => {
          if (!this.stopped) console.error(`[scheduler] checks failed for ${entry.taskId}:`, error);
        })
        .finally(() => {
          this.checkingActive.delete(entry.taskId);
          if (this.checkingPromises.get(entry.taskId) === entryPromise) this.checkingPromises.delete(entry.taskId);
          if (this.checkingRunIds.get(entry.taskId) === entry.runId) this.checkingRunIds.delete(entry.taskId);
          this.checkingWorktrees.delete(worktree);
          entry.resolve();
          this.pumpChecks();
        });
    }
  }

  private async executeChecksForTask(taskId: string, runId: string, reuseSavedResults: boolean): Promise<void> {
    if (this.stopped) return;
    const task = this.taskRepo.get(taskId);
    if (!task || task.status !== 'checking' || !this.isCurrentCompletedWorker(taskId, runId)) return;
    if (this.checkingRunIds.get(taskId) !== runId) return;

    if (task.status !== 'checking') {
      this.taskRepo.update(taskId, { status: 'checking' });
      this.eventBus.emit('task.checking', taskId);
    }

    const project = this.projectRepo.get(task.projectId);
    const checks = this.checkRunner && project
      ? await this.checkRunner.run(task, project, runId, { reuseSavedResults })
      : { passed: true, failed: [], results: [] };

    if (this.stopped) return;
    // Check if task status was changed (e.g. cancelled) during checks
    const currentTask = this.taskRepo.get(taskId);
    if (!currentTask || currentTask.status !== 'checking' || this.checkingRunIds.get(taskId) !== runId) return;
    if (this.running.has(taskId)) return;
    const stillActiveWorker = this.runRepo
      .getByTask(taskId)
      .some((candidate) => candidate.id !== runId && candidate.kind === 'worker' && candidate.outcome === null);
    if (stillActiveWorker) return;

    if (!checks.passed && this.config.autoFixOnFail && currentTask.checkFixAttempts < 2) {
      const feedback = checks.results
        .filter((result) => !result.ok)
        .map((result) => `### ${result.name}\n\n${result.outputTail.split('\n').slice(-60).join('\n')}`)
        .join('\n\n');
      const newBody = `${currentTask.body || currentTask.title}\n\n## Feedback tự sửa lần ${currentTask.checkFixAttempts + 1}\n\nCác kiểm tra sau thất bại:\n\n${feedback}`;
      this.taskRepo.update(taskId, {
        status: 'queued',
        resume: 1,
        checkFixAttempts: currentTask.checkFixAttempts + 1,
        body: newBody,
      });
      if (currentTask.worktreePath) {
        this.clearWorkerMarkers(currentTask.worktreePath);
        this.writeTaskFiles(currentTask, newBody, true, feedback);
      }
      this.eventBus.emit('task.queued', taskId, { reason: 'checks_failed_autofix', failed: checks.failed });
    } else {
      if (this.stopped) return;
      if (this.runMetricsRepo) {
        try {
          await recalculateTaskLines(
            this.taskRepo,
            this.projectRepo,
            this.runRepo,
            this.runMetricsRepo,
            taskId,
          );
        } catch (error) {
          if (!this.stopped) {
            console.error(`[scheduler] recalculateTaskLines failed for ${taskId}:`, error);
          }
        }
      }
      if (this.stopped) return;
      if (isTriageTaskSlug(currentTask.slug)) {
        let codeChanged = Boolean(currentTask.diffStat && currentTask.diffStat.trim());
        if (!codeChanged && currentTask.worktreePath && project?.path) {
          try {
            const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: currentTask.worktreePath, timeout: 10_000 });
            const base = currentTask.baseRef || project.defaultBranch || 'main';
            const branch = currentTask.branch || `agenthub/${currentTask.slug}`;
            const diff = await execFileAsync('git', ['diff', '--quiet', `${base}...${branch}`], { cwd: currentTask.worktreePath, timeout: 10_000 }).then(() => '').catch(() => 'changed');
            codeChanged = Boolean(status.stdout.trim() || diff);
          } catch { codeChanged = true; }
        }
        const parsedTriage = parseTriageAnalysis(currentTask.doneReport || '');
        if (codeChanged) {
          const blockedReport = '## Phân tích\n\nTriage không hợp lệ: worker đã tạo thay đổi code. Task triage bị chặn để người dùng kiểm tra.';
          this.taskRepo.update(taskId, { status: 'blocked', blockedReport, transientRetries: 0, notBefore: null });
          this.eventBus.emit('tracker.triage_invalid', taskId, { reason: 'code_changes' });
        } else if (!parsedTriage.analysis) {
          const blockedReport = `## Phân tích\n\nTriage không hợp lệ: ${parsedTriage.errors.join('; ')}. Worker phải bổ sung DONE đúng định dạng.`;
          this.taskRepo.update(taskId, { status: 'blocked', blockedReport, transientRetries: 0, notBefore: null });
          this.eventBus.emit('tracker.triage_invalid', taskId, { reason: 'invalid_report', errors: parsedTriage.errors });
        } else {
          this.taskRepo.update(taskId, { status: 'done', transientRetries: 0, notBefore: null, reviewStep: 0 });
          this.eventBus.emit('task.done', taskId, { triage: true });
        }
        if (!this.stopped) this.triggerTick();
        return;
      }
      this.taskRepo.update(taskId, { status: 'review', transientRetries: 0, notBefore: null, reviewStep: 0 });
      if (this.reviewChainForTask(currentTask).length === 0) {
        this.emitReviewReadyIfReview(taskId, {
          reviewChainComplete: true,
          checksPassed: checks.passed,
          failed: checks.failed,
        });
      } else {
        this.eventBus.emit('review.gate_started', taskId, { step: 0 });
      }
    }
    if (!this.stopped) this.triggerTick();
  }

  /** A check can only follow the latest worker completion, never a caller's stale run id. */
  private isCurrentCompletedWorker(taskId: string, runId: string): boolean {
    const completedRun = this.runRepo.get(runId);
    if (!completedRun || completedRun.taskId !== taskId || completedRun.kind !== 'worker' || completedRun.outcome !== 'done') return false;
    const workerRuns = this.runRepo.getByTask(taskId).filter((candidate) => candidate.kind === 'worker');
    if (workerRuns.at(-1)?.id !== runId) return false;
    if (this.running.has(taskId)) return false;
    return !workerRuns.some((candidate) => candidate.outcome === null);
  }

  private emitReviewReadyIfReview(taskId: string, payload?: unknown): void {
    const task = this.taskRepo.get(taskId);
    if (task?.status === 'review' && !this.running.has(taskId)) {
      this.eventBus.emit('task.review_ready', taskId, payload);
    }
  }

  /**
   * Main scheduler tick
   */
  tick(): void {
    if (this.inTick) return;
    this.inTick = true;
    try {
      this.loadGuard.setConfig(this.config.load);
      const load = this.loadGuard.update();
      const now = Date.now();
      if (load.overloaded !== this.lastLoadOverloaded) {
        this.lastLoadOverloaded = load.overloaded;
        this.eventBus.emit(load.overloaded ? 'load.high' : 'load.ok', undefined, load);
        if (load.overloaded) {
          this.lastLoadHighEventAt = now;
          this.lastLoadHighEventSnapshot = load;
        } else {
          this.lastLoadHighEventAt = null;
          this.lastLoadHighEventSnapshot = null;
        }
      } else if (load.overloaded && this.lastLoadHighEventAt !== null && this.lastLoadHighEventSnapshot !== null
        && now - this.lastLoadHighEventAt >= 30 * 60 * 1000
        && ((load.load1 > this.lastLoadHighEventSnapshot.load1
          && load.load1 >= this.lastLoadHighEventSnapshot.load1 * 1.3)
          || this.lastLoadHighEventSnapshot.freeMemGB - load.freeMemGB > 1)) {
        this.eventBus.emit('load.high', undefined, load);
        this.lastLoadHighEventAt = now;
        this.lastLoadHighEventSnapshot = load;
      }

      // Auto-pause / resume by load guard
      if (this.config.load.enabled && this.loadGuard.isAutoPauseTriggered()) {
        const maxAutoPaused = this.config.load.maxAutoPaused ?? 2;
        const autoPausedCount = Array.from(this.running.values()).filter((rt) => rt.paused && (rt.pauseReason === 'load' || rt.pauseReason === 'brain_load')).length;
        if (autoPausedCount < maxAutoPaused) {
          const candidates = Array.from(this.running.values()).filter((rt) => !rt.paused);
          if (candidates.length > 0) {
            const policy = this.config.load.pausePolicy || 'recent';
            if (policy === 'rss') {
              candidates.sort((a, b) => (b.rss || 0) - (a.rss || 0) || (b.startTime - a.startTime));
            } else {
              candidates.sort((a, b) => b.startTime - a.startTime);
            }
            const victim = candidates[0];
            this.pauseTask(victim.taskId, 'load');
            this.eventBus.emit('load.task_paused', victim.taskId, {
              reason: 'load',
              policy,
              rss: victim.rss,
              startTime: victim.startTime,
            });
          }
        }
      } else if (!this.loadGuard.isOverloaded()) {
        const autoPaused = Array.from(this.running.values())
          .filter((rt) => rt.paused && (rt.pauseReason === 'load' || rt.pauseReason === 'brain_load'))
          .sort((a, b) => (a.pausedAt || 0) - (b.pausedAt || 0));

        if (autoPaused.length > 0) {
          const nextToResume = autoPaused[0];
          this.resumeTask(nextToResume.taskId);
          this.eventBus.emit('load.task_resumed', nextToResume.taskId, { reason: 'recovered' });
        }
      }

      // Safety net: check tasks that have been paused longer than scheduler.maxPausedMin
      if (!this.loadGuard.isOverloaded()) {
        const maxPausedMin = this.config.scheduler?.maxPausedMin ?? DEFAULT_SCHEDULER_LIMITS.maxPausedMin ?? 30;
        const maxPausedMs = maxPausedMin * 60 * 1000;
        for (const rt of this.running.values()) {
          if (!rt.paused || !rt.pausedAt) continue;
          const pausedMs = now - rt.pausedAt;
          if (pausedMs >= maxPausedMs) {
            if (rt.pauseReason === 'load' || rt.pauseReason === 'brain_load') {
              this.resumeTask(rt.taskId);
              this.eventBus.emit('load.task_resumed', rt.taskId, { reason: 'recovered' });
            } else if (!rt.pauseReminded) {
              rt.pauseReminded = true;
              const pausedMinutes = Math.floor(pausedMs / 60000);
              this.eventBus.emit('task.pause_reminder', rt.taskId, {
                pausedMinutes,
                pausedMin: pausedMinutes,
                reason: rt.pauseReason,
              });
            }
          }
        }
      }
    // 0. Check disk space: resume tasks whose blocking disk is now free, and report low disks / recoveries
    const disks = this.getMonitoredDisks();
    const lowDisks = disks.filter((disk) => disk.low);

    const dockerDisk = disks.find((disk) => disk.label === 'Docker' && disk.low);
    if (dockerDisk && this.running.size > 0) {
      this.markDockerDiskLow(dockerDisk);
    } else if (!dockerDisk) {
      this.dockerDiskLow = false;
    }

    // Resume disk waiters individually if their specific blocking disk is now free
    const diskWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'disk');
    const resumedTasks: TaskRow[] = [];
    for (const t of diskWaiters) {
      if (!this.projectRepo.get(t.projectId)) continue;
      if (!this.getBlockingDiskForTask(t)) {
        this.tasksWaitingForDisk.delete(t.id);
        this.taskRepo.updateStatus(t.id, 'queued');
        this.eventBus.emit('task.queued', t.id, { reason: 'disk_ready' });
        resumedTasks.push(t);
      }
    }

    // Collect incident keys for disks that were low and are now recovered
    const recoveredDiskKeys: string[] = [];
    for (const [key] of this.diskIncidents) {
      if (!lowDisks.some((d) => this.getDiskIncidentKey(d.path) === key)) {
        recoveredDiskKeys.push(key);
      }
    }

    const defaultDisk = disks.find((disk) => disk.source === 'worktrees');
    const recovered = defaultDisk ? defaultDisk.freeGB >= defaultDisk.minFreeGB + 1 : true;
    const allDisksOk = lowDisks.length === 0;

    if (allDisksOk && this.diskLow && recovered) {
      this.diskLow = false;
      this.lastDiskLowEmit = 0;
      this.diskBlockedEmitted = false;
      this.diskIncidents.clear();
      const remainingDiskWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'disk').length;
      this.eventBus.emit('disk.ok', undefined, {
        label: defaultDisk?.label ?? 'Worktrees',
        path: defaultDisk?.path ?? this.config.worktreesDir,
        freeGB: defaultDisk?.freeGB ?? 0,
        minFreeGB: this.config.disk.minFreeGB,
        resumedCount: resumedTasks.length,
        remainingCount: remainingDiskWaiters,
        tasks: resumedTasks.map((t) => t.slug || t.title || t.id),
      });
    } else {
      const getTaskDiskKey = (t: TaskRow): string => {
        return this.getDiskIncidentKey(this.getTaskDiskPath(t));
      };

      const affectedKeys = new Set<string>([
        ...recoveredDiskKeys,
        ...resumedTasks.map(getTaskDiskKey),
      ]);

      const remainingDiskWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'disk').length;

      for (const diskKey of affectedKeys) {
        const disk = disks.find((d) => this.getDiskIncidentKey(d.path) === diskKey)
          ?? disks.find((d) => d.path === diskKey);
        const diskPath = disk?.path ?? diskKey;
        const diskLabel = disk?.label ?? 'Worktrees';
        const diskFreeGB = disk?.freeGB ?? defaultDisk?.freeGB ?? 0;
        const diskMinFreeGB = disk?.minFreeGB ?? this.config.disk.minFreeGB;

        const tasksForThisDisk = resumedTasks.filter((t) => {
          const tKey = getTaskDiskKey(t);
          if (disk?.source === 'hub_home') {
            return tKey === diskKey || !affectedKeys.has(tKey);
          }
          return tKey === diskKey;
        });

        this.diskIncidents.delete(diskKey);

        this.eventBus.emit('disk.ok', undefined, {
          label: diskLabel,
          path: diskPath,
          freeGB: diskFreeGB,
          minFreeGB: diskMinFreeGB,
          resumedCount: tasksForThisDisk.length,
          remainingCount: remainingDiskWaiters,
          tasks: tasksForThisDisk.map((t) => t.slug || t.title || t.id),
        });
      }
    }

    if (allDisksOk && this.recheckWaitingOnDiskOk) {
      this.recheckWaitingOnDiskOk = false;
      this.wakeWaitingQuotaTasks('startup_recheck');
    }

    if (lowDisks.length > 0) {
      this.diskLow = true;
      const hasQueuedTasks = this.taskRepo.getByStatus('queued').length > 0;
      const seenDiskKeys = new Set<string>();
      for (const lowDisk of lowDisks) {
        const diskKey = this.getDiskIncidentKey(lowDisk.path);
        if (seenDiskKeys.has(diskKey)) continue;
        seenDiskKeys.add(diskKey);

        const diskWaitersForThisDisk = this.taskRepo.getByStatus('waiting_quota').filter((t) => {
          if (t.waitReason !== 'disk') return false;
          const blocking = this.getBlockingDiskForTask(t);
          if (!blocking) return false;
          if (lowDisk.source === 'hub_home') return blocking.source === 'hub_home';
          return this.getDiskIncidentKey(blocking.path) === diskKey;
        });
        if (lowDisk.source === 'hub_home' || diskWaitersForThisDisk.length > 0 || !hasQueuedTasks) {
          this.markDiskLow(lowDisk);
        }
      }
    }

    // 0b. Resume slot / parallel waiters if project slot is available
    const slotWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'slot' || t.waitReason === 'parallel' || t.waitReason === 'department_parallel');
    for (const task of slotWaiters) {
      const project = this.projectRepo.get(task.projectId);
      if (!project) continue;
      if (this.hasParallelCapacity(project)) {
        this.taskRepo.updateStatus(task.id, 'queued');
        this.eventBus.emit('task.queued', task.id, { reason: 'parallel_available' });
      }
    }

    // 0b2. Resume dependency waiters if dependencies are met
    const dependencyWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'dependency');
    for (const task of dependencyWaiters) {
      if (this.areDependenciesMet(task)) {
        this.taskRepo.updateStatus(task.id, 'queued');
        this.eventBus.emit('task.queued', task.id, { reason: 'dependency_met' });
      }
    }

    // 0b3. Resume load waiters if system is no longer overloaded
    if (!this.loadGuard.isOverloaded()) {
      const loadWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'load');
      for (const task of loadWaiters) {
        const project = this.projectRepo.get(task.projectId);
        if (project && this.hasParallelCapacity(project)) {
          this.taskRepo.updateStatus(task.id, 'queued');
          this.eventBus.emit('task.queued', task.id, { reason: 'load_recovered' });
        }
      }
    }

    // 0c. Resume busy profile waiters if a matching profile became available
    const busyProfileWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'profile_busy');
    for (const task of busyProfileWaiters) {
      if (!this.hasBusyMatchingProfile(task) || Boolean(this.findModelProfilePair(task))) {
        this.taskRepo.updateStatus(task.id, 'queued');
        this.eventBus.emit('task.queued', task.id, { reason: 'profile_available' });
      }
    }

    // 0d. Check unavailable projects and resume project waiters
    const projectWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'project_unavailable');
    for (const task of projectWaiters) {
      this.tasksWaitingForProject.add(task.id);
    }

    const projectsToCheck = new Set<string>([
      ...this.unavailableProjects,
      ...projectWaiters.map((t) => t.projectId),
    ]);

    for (const projectId of projectsToCheck) {
      const project = this.projectRepo.get(projectId);
      if (project && isProjectAccessible(project.path)) {
        if (this.unavailableProjects.has(projectId)) {
          this.unavailableProjects.delete(projectId);
          this.eventBus.emit('project.available', undefined, {
            projectId: project.id,
            path: project.path,
          });
        }
        // Wake up tasks for this project whose worktree (if any) is also accessible
        const tasksForProj = projectWaiters.filter((t) => t.projectId === projectId);
        for (const task of tasksForProj) {
          if (!task.worktreePath || fs.existsSync(task.worktreePath)) {
            this.tasksWaitingForProject.delete(task.id);
            this.taskRepo.updateStatus(task.id, 'queued');
            this.eventBus.emit('task.queued', task.id, { reason: 'project_available' });
          }
        }
      }
    }

    // 1. Check quota expiry → move waiting_quota tasks back to queued
    this.checkQuotaExpiry();

    // 1b. Safety net: recover orphaned checking tasks
    this.recoverStuckCheckingTasks();

    // 2. Check running tasks for completion
    void this.checkRunningTasks().catch(() => {});

    // 3. Start new tasks if possible
    // 3. Reviews first: a slot freed by a worker should finish reviewed work before starting new work,
    // otherwise busy Codex accounts starve the review queue.
    this.scheduleReviews();

    // 3b. Prune expired worktrees before dispatching tasks. When disk is low,
    // this gives cleanup a chance to free space before queued work is parked.
    this.cleanExpiredWorktrees();

    // Auto-close tasks that have already been merged elsewhere (e.g. into integration or default branch)
    const nowMergedCheck = Date.now();
    if (nowMergedCheck - this.lastMergedTasksCheck >= 10 * 60 * 1000) {
      this.lastMergedTasksCheck = nowMergedCheck;
      void this.autoCloseMergedTasks().catch(() => {});
    }

    // 3c. Start new tasks if possible
    this.scheduleNewTasks();

    // 4. Scan worktrees and reap orphaned worker processes periodically.
    if (Date.now() - this.lastOrphanScan >= 6 * 60 * 60 * 1000) {
      this.lastOrphanScan = Date.now();
      this.scanOrphanWorktrees();
      this.reapOrphans();
    }
    } finally {
      this.maybeFinishRestartDrain();
      this.inTick = false;
    }
  }

  /** Reap worker descendants left behind after a worktree is deleted or a task stops. */
  reapOrphans(): void {
    const oldProcessCutoff = Date.now() - 30 * 60 * 1000;
    const roots = [this.config.worktreesDir, ...this.projectRepo.getAll().flatMap((project) => projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir))];
    const processes = listAllWorktreeProcesses({ worktreesDir: roots, protectedPaths: [this.config.hubHome] });
    const activeWorktrees = new Set<string>();
    for (const run of this.running.values()) {
      const task = this.taskRepo.get(run.taskId);
      if (task?.worktreePath) activeWorktrees.add(path.resolve(task.worktreePath));
    }
    for (const run of this.reviewerRuns.values()) {
      const task = this.taskRepo.get(run.taskId);
      if (task?.worktreePath) activeWorktrees.add(path.resolve(task.worktreePath));
    }
    for (const info of processes) {
      const dir = info.cwd.replace(/ \(deleted\)$/, '');
      if (info.cwd.endsWith(' (deleted)')) {
        reapSyncForWorktree(dir, { worktreesDir: roots, protectedPaths: [this.config.hubHome] });
        continue;
      }

      const processCwd = path.resolve(info.cwd);
      const active = [...activeWorktrees].some((worktree) => processCwd === worktree || processCwd.startsWith(worktree + path.sep));
      if (active) continue;
      if (info.startedAt > oldProcessCutoff && !isOrphanProcess(info)) continue;
      reapSyncForWorktree(dir, { worktreesDir: roots, protectedPaths: [this.config.hubHome] });
    }
  }

  /**
   * Force an immediate tick (for event-driven scheduling)
   */
  triggerTick(): void {
    this.tick();
  }

  wakeWaitingQuotaTasks(reason = 'quota_unblocked'): void {
    const waitingTasks = this.taskRepo.getByStatus('waiting_quota');
    for (const task of waitingTasks) {
      if (!this.projectRepo.get(task.projectId)) continue;
      if (reason !== 'startup_recheck') {
        if (task.waitReason === 'disk' && this.getBlockingDiskForTask(task)) continue;
        if (task.waitReason === 'dependency' && !this.areDependenciesMet(task)) continue;
        if (task.waitReason === 'load' && this.loadGuard.isOverloaded()) continue;
      }
      this.taskRepo.updateStatus(task.id, 'queued');
      this.eventBus.emit('task.queued', task.id, { reason });
    }
    if (waitingTasks.length > 0 && !this.stopped) {
      this.triggerTick();
    }
  }

  private checkQuotaExpiry(): void {
    const expired = this.quotaService.cleanupExpired();
    if (expired.length > 0) {
      for (const mark of expired) {
        this.eventBus.emit('quota.cleared', undefined, mark);
      }
      this.wakeWaitingQuotaTasks('quota_expired');
    }
  }

  private async checkRunningTasks(): Promise<void> {
    if (this.running.size === 0) return;
    const now = Date.now();
    const completions: Promise<void>[] = [];
    for (const [taskId, rt] of this.running) {
      // Check if process is still alive
      if (!this.isProcessAlive(rt.pid, rt.pidStart)) {
        // Process has ended, check results
        completions.push(this.handleRunCompletion(taskId, rt).catch((error) => {
          if (!this.stopped) {
            console.error(`[scheduler] handleRunCompletion failed for ${taskId}:`, error);
          }
        }));
        continue;
      }

      if (rt.paused) {
        // Paused tasks: do NOT check timeout, stall, or no-commit watch
        continue;
      }

      // Check timeout
      if (now > rt.timeoutAt) {
        this.killTask(taskId, 'timeout');
        continue;
      }

      if (this.isStalled(rt)) {
        this.handleStall(taskId, rt);
        continue;
      }

      // Check no-commit watch every 5 minutes
      if (!rt.lastCommitCheckAt || now - rt.lastCommitCheckAt >= 5 * 60 * 1000) {
        await this.checkTaskCommits(taskId, rt, now);
        rt.lastCommitCheckAt = now;
      }

      // Check looping detection
      this.checkTaskLooping(taskId, rt, now);
    }
    await Promise.allSettled(completions);
  }

  async checkTaskCommits(taskId: string, runningTask?: RunningTask, now = Date.now(), force = false): Promise<void> {
    const rt = runningTask || this.running.get(taskId);
    if (!rt) return;
    if (!force && rt.lastCommitCheckAt && now - rt.lastCommitCheckAt < 5 * 60 * 1000) {
      return;
    }

    const task = this.taskRepo.get(taskId);
    if (!task) return;
    const project = this.projectRepo.get(task.projectId);
    const baseRef = task.baseRef || project?.defaultBranch || 'main';
    const branch = task.branch || (project ? renderTaskBranch(project, task) : `agenthub/${task.slug}`);

    const repoPath = (task.worktreePath && fs.existsSync(path.join(task.worktreePath, '.git')))
      ? task.worktreePath
      : (project?.path && fs.existsSync(project.path) ? project.path : undefined);

    if (!repoPath) return;

    let timestamps: number[] = [];
    try {
      const { stdout } = await execFileAsync('git', ['log', '--format=%ct', `${baseRef}..${branch}`], {
        cwd: repoPath,
      });
      timestamps = stdout
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => parseInt(s, 10) * 1000)
        .filter((n) => !isNaN(n));
    } catch {
      timestamps = [];
    }

    const commitCount = timestamps.length;
    rt.lastCommitCount = commitCount;

    const lastCommitTime = commitCount > 0 ? timestamps[0] : rt.startTime;
    const elapsedMs = Math.max(0, now - lastCommitTime);
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));

    const thresholdMin = this.config.stall?.noCommitMin ?? 45;
    if (elapsedMinutes > thresholdMin) {
      rt.noCommitMinutes = elapsedMinutes;
      const thresholdTier = Math.floor(elapsedMinutes / thresholdMin);
      if ((rt.lastNoCommitThresholdEmitted || 0) < thresholdTier) {
        rt.lastNoCommitThresholdEmitted = thresholdTier;
        this.eventBus.emit('task.no_commit', taskId, {
          minutes: elapsedMinutes,
          commits: commitCount,
          lastCommitAt: commitCount > 0 ? new Date(timestamps[0]).toISOString() : null,
        });

        if (task.worktreePath && fs.existsSync(task.worktreePath)) {
          const taskMdPath = path.join(task.worktreePath, '.agenthub', 'task.md');
          if (fs.existsSync(taskMdPath)) {
            try {
              const content = fs.readFileSync(taskMdPath, 'utf-8');
              const reminder = 'Hãy commit phần đã xong và thu hẹp phạm vi.';
              if (!content.includes('Hãy commit phần đã xong và thu hẹp phạm vi')) {
                const separator = content.endsWith('\n') ? '\n' : '\n\n';
                fs.writeFileSync(taskMdPath, content + separator + reminder + '\n', 'utf-8');
              }
            } catch {
              // ignore write error
            }
          }
        }
      }
    } else {
      rt.noCommitMinutes = undefined;
      rt.lastNoCommitThresholdEmitted = 0;
    }
  }

  checkTaskLooping(taskId: string, runningTask?: RunningTask, now = Date.now()): void {
    const rt = runningTask || this.running.get(taskId);
    if (!rt) return;

    const run = this.runRepo.get(rt.runId);
    if (!run?.logPath || !fs.existsSync(run.logPath)) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(run.logPath);
    } catch {
      return;
    }

    if (!rt.commandOccurrences) {
      rt.commandOccurrences = [];
    }

    const lastOffset = rt.lastLogOffset || 0;
    if (stat.size < lastOffset) {
      rt.lastLogOffset = 0;
      rt.commandOccurrences = [];
    }

    const currentOffset = rt.lastLogOffset || 0;
    if (stat.size > currentOffset) {
      try {
        const fd = fs.openSync(run.logPath, 'r');
        const bytesToRead = stat.size - currentOffset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, currentOffset);
        fs.closeSync(fd);
        rt.lastLogOffset = stat.size;

        const newChunk = buf.toString('utf-8');
        const lines = newChunk.split('\n');

        for (const rawLine of lines) {
          // eslint-disable-next-line no-control-regex
          const cleanLine = rawLine.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
          if (cleanLine.includes('playwright test') || cleanLine.includes('pnpm test:ui')) {
            const matchTs = cleanLine.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/);
            let lineTime = matchTs ? Date.parse(matchTs[1]) : NaN;
            if (isNaN(lineTime)) {
              lineTime = now;
            }
            const cmd = cleanLine
              .replace(/^\[[^\]]+\]\s*/, '')
              .replace(/^[$>#]\s*/, '')
              .trim();

            if (cmd) {
              rt.commandOccurrences.push({ command: cmd, timestamp: lineTime });
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    const windowMs = 30 * 60 * 1000;
    const cutoff = now - windowMs;
    rt.commandOccurrences = rt.commandOccurrences.filter((entry) => entry.timestamp >= cutoff);

    const counts = new Map<string, number>();
    for (const entry of rt.commandOccurrences) {
      counts.set(entry.command, (counts.get(entry.command) || 0) + 1);
    }

    const threshold = this.config.stall?.loopThreshold ?? 6;
    let loopingCmd: string | undefined;
    let maxCount = 0;

    for (const [cmd, count] of counts.entries()) {
      if (count > threshold && count > maxCount) {
        loopingCmd = cmd;
        maxCount = count;
      }
    }

    if (loopingCmd) {
      rt.loopingCommand = loopingCmd;
      if (!rt.isLooping) {
        rt.isLooping = true;
        this.eventBus.emit('task.looping', taskId, {
          command: loopingCmd,
          count: maxCount,
          runId: rt.runId,
        });
      }
    } else {
      rt.isLooping = false;
      rt.loopingCommand = undefined;
    }
  }

  private isStalled(rt: RunningTask): boolean {
    const run = this.runRepo.get(rt.runId);
    this.refreshActivity(rt, run?.logPath);
    const silentMs = Date.now() - rt.lastActivityAt;
    const stallMs = this.config.watchdog.stallMinutes * 60 * 1000;
    if (silentMs > stallMs) return true;
    if (silentMs <= this.config.watchdog.waitingMinutes * 60 * 1000) return false;
    if (!this.logTail(run?.logPath, 20).includes('waiting up to')) return false;
    const waitingMs = this.config.watchdog.waitingMinutes * 60 * 1000;
    const logSilent = Date.now() - this.getLogMtime(run?.logPath) > waitingMs;
    const conversation = this.getConversationMtime(rt);
    const conversationSilent = conversation === 0 || Date.now() - conversation > waitingMs;
    return logSilent && (rt.engine.id !== 'agy' || conversationSilent);
  }

  private handleStall(taskId: string, rt: RunningTask): void {
    this.killProcessGroup(rt.pid);
    const stalledTask = this.taskRepo.get(taskId);
    if (stalledTask?.worktreePath) {
      const project = this.projectRepo.get(stalledTask.projectId);
      reapSyncForWorktree(stalledTask.worktreePath, { worktreesDir: project ? projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir) : this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
    }
    this.running.delete(taskId);
    if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
    this.locks.invalidate(rt.profileName);
    this.runRepo.finish(rt.runId, 'crashed', undefined, 'stalled');
    this.eventBus.emit('run.stalled', taskId, {
      runId: rt.runId,
      model: rt.model,
      engine: rt.engine.id,
      profile: rt.profileName,
    });

    const stalledCount = this.runRepo.getByTask(taskId).filter((run) => run.reason === 'stalled').length;
    if (stalledCount <= 2) {
      const task = this.taskRepo.get(taskId);
      if (!task) return;
      const body = `${task.body || task.title}\n\n${STALL_NOTE}`;
      this.taskRepo.update(taskId, { status: 'queued', resume: 1, body });
      this.eventBus.emit('task.queued', taskId, {
        reason: 'stalled_retry',
        note: STALL_NOTE,
        model: rt.model,
        engine: rt.engine.id,
        profile: rt.profileName,
      });
    } else {
      this.taskRepo.updateStatus(taskId, 'failed');
      this.eventBus.emit('task.failed', taskId, { reason: 'stalled_limit' });
    }
  }

  private getLogMtime(logPath: string | null | undefined): number {
    if (!logPath) return 0;
    try { return fs.statSync(logPath).mtimeMs; } catch { return 0; }
  }

  private getConversationMtime(rt: RunningTask): number {
    if (rt.engine.id !== 'agy') return 0;
    const profile = this.profileRepo.get(rt.profileName);
    const home = profile?.kind === 'keyring' ? process.env.HOME || '' : profile?.home || '';
    if (!home) return 0;
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    let latest = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.db(?:-wal)?$/.test(entry.name)) continue;
        const mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs;
        if (mtime > rt.startTime && mtime > latest) latest = mtime;
      }
    } catch { /* Conversation directory may not exist yet. */ }
    // A profile may have two slots; without a conversation id, use the newest DB.
    return latest;
  }

  private getWorktreeMtime(worktreePath: string | null | undefined, startedAt: number, cachedMtime = 0): number {
    if (!worktreePath) return cachedMtime;
    const ignored = ['node_modules', '.git/objects', 'dist'];
    let latest = 0;
    let seen = 0;
    const visit = (dir: string, relative = ''): boolean => {
      if (seen >= 5000) return false;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      for (const entry of entries) {
        if (seen >= 5000) return false;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (ignored.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
        const full = path.join(dir, entry.name);
        seen++;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (visit(full, rel)) return true;
          }
          else if (stat.mtimeMs > startedAt && stat.mtimeMs > latest) {
            latest = stat.mtimeMs;
            if (latest > cachedMtime) return true;
          }
        } catch { /* Files can disappear while a worker edits them. */ }
      }
      return false;
    };
    visit(worktreePath);
    return Math.max(latest, cachedMtime);
  }

  private refreshActivity(rt: RunningTask, logPath?: string | null): void {
    const run = logPath === undefined ? this.runRepo.get(rt.runId) : undefined;
    const actualLogPath = logPath === undefined ? run?.logPath : logPath;
    const logMtime = this.getLogMtime(actualLogPath);
    if (logMtime > rt.lastActivityAt) {
      rt.lastActivityAt = logMtime;
      rt.lastOutputAt = logMtime;
      rt.activitySource = 'log';
    }

    const now = Date.now();
    if (now - rt.activityCheckedAt < 30_000) return;

    // Conversation and worktree scans are deliberately cached: a scheduler tick
    // runs every two seconds, while a recursive scan can inspect thousands of files.
    const conversationMtime = this.getConversationMtime(rt);
    rt.cachedConversationMtime = Math.max(rt.cachedConversationMtime, conversationMtime);
    const task = this.taskRepo.get(rt.taskId);
    const worktreePath = task?.worktreePath;
    let worktreeMtime = 0;
    if (worktreePath) {
      try {
        const indexMtime = fs.statSync(path.join(worktreePath, '.git', 'index')).mtimeMs;
        worktreeMtime = Math.max(worktreeMtime, indexMtime > rt.startTime ? indexMtime : 0);
      } catch { /* Worktrees without an index are still checked recursively. */ }
      if (worktreeMtime <= rt.cachedConversationMtime && conversationMtime <= rt.lastActivityAt) {
        worktreeMtime = this.getWorktreeMtime(worktreePath, rt.startTime, rt.cachedWorktreeMtime);
      }
    }
    rt.cachedWorktreeMtime = Math.max(rt.cachedWorktreeMtime, worktreeMtime);
    rt.activityCheckedAt = now;

    const candidates: Array<{ source: ActivitySource; mtime: number }> = [
      { source: 'log', mtime: logMtime },
      { source: 'conversation', mtime: rt.cachedConversationMtime },
      { source: 'worktree', mtime: rt.cachedWorktreeMtime },
    ];
    const activity = candidates.reduce((best, candidate) => candidate.mtime > best.mtime ? candidate : best, { source: 'log' as ActivitySource, mtime: rt.startTime });
    rt.lastActivityAt = activity.mtime || rt.startTime;
    rt.activitySource = activity.source;
    rt.lastOutputAt = rt.lastActivityAt;
  }

  private logTail(logPath: string | null | undefined, lines: number): string {
    if (!logPath || !fs.existsSync(logPath)) return '';
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      return content.split('\n').slice(-lines).join('\n');
    } catch { return ''; }
  }

  private async handleRunCompletion(taskId: string, rt: RunningTask): Promise<void> {
    if (this.running.get(taskId)?.runId === rt.runId) {
      this.running.delete(taskId);
    }
    if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
    try {
      this.locks.invalidate(rt.profileName);
      const completedProfile = this.profileRepo.get(rt.profileName);
      if (completedProfile && this.usageService) {
        try {
          await this.usageService.collect(completedProfile);
        } catch {
          // ignore
        }
      }

      if (this.stopped) return;
      const task = this.taskRepo.get(taskId);
      if (!task) return;

      // Reject stale completions before touching the worktree, markers, or
      // reference state. A worker that finished after retry/cancel/overlap
      // must not be allowed to mutate the task based on its old files.
      const earlyRejection = this.workerCompletionRejection(taskId, rt.runId);
      if (earlyRejection) {
        this.runRepo.finish(rt.runId, 'crashed', undefined, earlyRejection);
        return;
      }

      if (task.worktreePath) {
        const project = this.projectRepo.get(task.projectId);
        await reap(task.worktreePath, { worktreesDir: project ? projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir) : this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
      }

    // Read log tail for quota detection
    const run = this.runRepo.get(rt.runId);
    let logTail = '';
    let fullLog = '';
    if (run?.logPath && fs.existsSync(run.logPath)) {
      try {
        fullLog = fs.readFileSync(run.logPath, 'utf-8');
        const fd = fs.openSync(run.logPath, 'r');
        const stat = fs.fstatSync(fd);
        const size = Math.min(stat.size, 16 * 1024);
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, stat.size - size);
        fs.closeSync(fd);
        logTail = buffer.toString('utf-8');
      } catch {
        // ignore
      }
    }

    // Check worktree markers
    let markers = { done: false, blocked: false, doneContent: '', blockedContent: '' };
    if (task.worktreePath) {
      markers = this.worktreeService.checkMarkers(task.worktreePath) as typeof markers;
    }

    // Measure diff stats for run metrics.
    let diffStats = { linesAdded: 0, linesDeleted: 0, filesChanged: 0 };
    if (markers.done) {
      const project = this.projectRepo.get(task.projectId);
      const baseRef = task.baseRef || project?.defaultBranch || 'main';
      const branch = task.branch || (project ? renderTaskBranch(project, task) : `agenthub/${task.slug}`);
      if (project?.path) {
        const stats = await measureTaskLines(project.path, baseRef, branch);
        if (stats) diffStats = stats;
      }
      if (diffStats.filesChanged === 0 && task.worktreePath && fs.existsSync(task.worktreePath)) {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--shortstat', `${baseRef}...${branch}`], {
            cwd: task.worktreePath,
            timeout: 10_000,
          });
          const parsed = parseShortstat(stdout);
          if (parsed.filesChanged > 0) diffStats = parsed;
        } catch {
          // ignore
        }
      }
    }

    // Get usageAfter
    let usageAfter: number | null = null;
    if (rt.engine.id === 'agy' && this.usageService) {
      const family = getModelFamily(rt.model);
      const grp = family === 'gemini' ? 'Gemini Models' : (family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null);
      if (grp) {
        const usages = this.usageService.getForProfile(rt.profileName);
        const u5h = usages.find((u) => u.window === '5h' && u.grp === grp);
        if (u5h) usageAfter = u5h.remainingPct;
      }
    }

    // Tokens used for codex
    let tokensUsed: number | null = null;
    if (rt.engine.id === 'codex') {
      tokensUsed = parseCodexTokens(fullLog);
    }

    const durationMs = Date.now() - rt.startTime;
    if (this.runMetricsRepo) {
      this.runMetricsRepo.upsert({
        runId: rt.runId,
        taskId,
        engine: rt.engine.id,
        model: rt.model,
        profileName: rt.profileName,
        tokensUsed,
        usageBefore: rt.usageBefore,
        usageAfter,
        linesAdded: diffStats.linesAdded,
        linesDeleted: diffStats.linesDeleted,
        filesChanged: diffStats.filesChanged,
        durationMs,
      });
    }

    // Check if any read-only references were modified
    const referenceRejection = this.workerCompletionRejection(taskId, rt.runId);
    if (referenceRejection) {
      this.runRepo.finish(rt.runId, 'crashed', undefined, referenceRejection);
      return;
    }
    if (rt.referenceSnapshots && rt.referenceSnapshots.length > 0) {
      const modifications = detectReferenceModifications(rt.referenceSnapshots);
      if (modifications.length > 0) {
        await this.handleReferenceModifications(taskId, task, rt, modifications);
        if (!this.stopped) this.triggerTick();
        return;
      }
    }

    const currentTask = this.taskRepo.get(taskId);
    if (!currentTask) {
      this.runRepo.finish(rt.runId, 'crashed', undefined, 'task_missing');
      return;
    }

    // 1. Task status gate: only a task currently in 'running' status can accept completion from a worker run.
    if (currentTask.status !== 'running') {
      this.runRepo.finish(rt.runId, 'crashed', undefined, 'stale_worker');
      return;
    }

    // 2. Overlapping worker gate: rt.runId must be the sole active worker run for this task.
    const runningTask = this.running.get(taskId);
    if (runningTask && runningTask.runId !== rt.runId) {
      this.runRepo.finish(rt.runId, 'crashed', undefined, 'overlapping_worker');
      return;
    }
    const activeWorkerRuns = this.runRepo
      .getByTask(taskId)
      .filter((candidate) => candidate.kind === 'worker' && candidate.outcome === null);
    if (activeWorkerRuns.length !== 1 || activeWorkerRuns[0].id !== rt.runId) {
      this.runRepo.finish(rt.runId, 'crashed', undefined, 'overlapping_worker');
      return;
    }

    // 3. Marker evaluation: only fresh markers created after this run started are accepted.
    const marker = this.markerForRun(currentTask, rt.startTime);
    if (marker === 'done') {
      let diffStat: string | null = null;
      const project = this.projectRepo.get(currentTask.projectId);
      const baseRef = currentTask.baseRef || project?.defaultBranch || 'main';
      const branch = currentTask.branch || `agenthub/${currentTask.slug}`;
      if (project?.path) {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--stat', `${baseRef}...${branch}`], {
            cwd: project.path,
            timeout: 30_000,
          });
          diffStat = stdout.trim() || null;
        } catch {
          // The branch may not be available yet; the context can still include DONE.
        }
      }
      if (!diffStat && currentTask.worktreePath && fs.existsSync(currentTask.worktreePath)) {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--stat', `${baseRef}...${branch}`], {
            cwd: currentTask.worktreePath,
            timeout: 10_000,
          });
          diffStat = stdout.trim() || null;
        } catch {
          // ignore
        }
      }
      this.runRepo.finish(rt.runId, 'done');
      this.taskRepo.update(taskId, {
        status: 'checking',
        doneReport: markers.doneContent || currentTask.doneReport,
        diffStat: diffStat ?? currentTask.diffStat,
      });
      this.recordWorkerSuccess(rt.profileName, taskId);
      this.eventBus.emit('task.checking', taskId);
      await this.runChecksForTask(taskId, rt.runId);
    } else if (marker === 'blocked') {
      this.runRepo.finish(rt.runId, 'blocked');
      this.taskRepo.update(taskId, { status: 'blocked', blockedReport: markers.blockedContent || currentTask.blockedReport, transientRetries: 0, notBefore: null });
      this.eventBus.emit('task.blocked', taskId);
    } else if (this.hasCommitAfter(currentTask, rt.startTime)) {
      if (this.recordWorkerCrash(taskId, rt, 'resume_after_progress')) return;
      this.taskRepo.update(taskId, { status: 'queued', resume: 1 });
      this.eventBus.emit('task.queued', taskId, { reason: 'resume_after_progress' });
    } else {
      const exitCode = rt.exitCode ?? rt.child?.exitCode ?? null;
      const isLockBusy = durationMs < 3000 && fullLog.trim() === '' && Boolean(rt.lockFile) && exitCode === 1;

      if (isLockBusy) {
        if (this.recordWorkerCrash(taskId, rt, 'lock_busy')) return;
        this.taskRepo.update(taskId, {
          status: 'queued',
          notBefore: Math.floor(Date.now() / 1000) + 5,
        });
        this.eventBus.emit('task.queued', taskId, { reason: 'lock_busy' });
      } else {
        // Check for quota exhaustion
        const quotaResult = rt.engine.detectQuota(logTail);
        if (quotaResult.exhausted) {
          const family = getModelFamily(rt.model);
          const resetSeconds = quotaResult.resetSeconds || 18000;
          this.runRepo.finish(rt.runId, 'quota', Math.floor(Date.now() / 1000) + resetSeconds);

          // Mark quota for profile and same-email profiles
          if (this.quotaService.mark(rt.profileName, family, resetSeconds, `quota exhausted on ${rt.model}`)) {
            const profile = this.profileRepo.get(rt.profileName);
            this.eventBus.emit('quota.exhausted', taskId, {
              profile: rt.profileName,
              family,
              engine: profile?.engine,
              allExhausted: profile ? this.quotaService.allProfilesForEngineExhausted(profile.engine, family) : false,
            });
          }

          // Quota failover is a continuation, not a crash/retry attempt. Keep
          // the task's run-limit counter unchanged and reuse its worktree.
          const next = this.findModelProfilePair(task);
          const reason = next
            ? `quota exhausted on ${rt.engine.id}/${rt.model} (${rt.profileName})`
            : `quota exhausted on ${rt.engine.id}/${rt.model} (${rt.profileName}); all models/profiles unavailable`;
          try {
            fs.appendFileSync(run?.logPath || '', `\n[agenthub] Failover: ${rt.profileName}/${rt.model} → ${next ? `${next.profileName}/${next.model}` : 'waiting_quota'}; reason: ${reason}\n`);
          } catch {
            // The run log may have been removed by cleanup; the event remains authoritative.
          }
          this.eventBus.emit('task.failover', taskId, {
            from: { profile: rt.profileName, model: rt.model, engine: rt.engine.id },
            to: next ? { profile: next.profileName, model: next.model, engine: getModelEngine(next.model) } : null,
            model: next?.model || rt.model,
            engine: next ? getModelEngine(next.model) : rt.engine.id,
            profile: next?.profileName || rt.profileName,
            reason,
            runId: rt.runId,
            worktreePath: task.worktreePath,
          });
          this.taskRepo.update(taskId, { status: 'queued', resume: 1, transientRetries: 0, notBefore: null });
          this.eventBus.emit('task.queued', taskId, {
            reason: 'quota_retry',
            failover: next ? 'available' : 'waiting_quota',
            model: rt.model,
            engine: rt.engine.id,
            profile: rt.profileName,
          });
        } else if (rt.engine.detectAuthError(logTail).expired) {
          this.runRepo.finish(rt.runId, 'crashed', undefined, 'auth');
          this.markProfileAuthExpired(rt.profileName);

          this.taskRepo.update(taskId, { status: 'queued', attempt: task.attempt, resume: 1, transientRetries: 0, notBefore: null });
          this.eventBus.emit('task.queued', taskId, {
            reason: 'auth_retry',
            profile: rt.profileName,
            model: rt.model,
            engine: rt.engine.id,
          });
        } else {
          // Check for transient errors
          if (rt.engine.detectTransientError(logTail) && task.transientRetries < 3) {
            const delays = [60000, 120000, 180000];
            const delay = delays[task.transientRetries] || 180000;
            if (this.recordWorkerCrash(taskId, rt)) return;
            this.taskRepo.update(taskId, {
              status: 'queued',
              notBefore: Math.floor(Date.now() / 1000) + Math.ceil(delay / 1000),
              transientRetries: task.transientRetries + 1,
            });
            this.eventBus.emit('task.queued', taskId, {
              reason: 'transient_retry',
              delay,
              model: rt.model,
              engine: rt.engine.id,
              profile: rt.profileName,
            });
          } else {
            // Failed
            if (this.recordWorkerCrash(taskId, rt)) return;
            this.taskRepo.updateStatus(taskId, 'failed');
            this.eventBus.emit('task.failed', taskId);
          }
        }
      }
    }
    if (!this.stopped) this.triggerTick();
    } catch (error) {
      if (!this.stopped) {
        console.error(`[scheduler] handleRunCompletion failed for ${taskId}:`, error);
      }
    }
  }

  /** Return a reason when a worker completion is no longer authoritative. */
  private workerCompletionRejection(taskId: string, runId: string): string | null {
    const task = this.taskRepo.get(taskId);
    const run = this.runRepo.get(runId);
    if (!task || !run || run.taskId !== taskId || run.kind !== 'worker' || run.outcome !== null) return 'stale_worker';
    if (task.status !== 'running') return 'stale_worker';
    const activeWorkerRuns = this.runRepo
      .getByTask(taskId)
      .filter((candidate) => candidate.kind === 'worker' && candidate.outcome === null);
    if (activeWorkerRuns.length !== 1 || activeWorkerRuns[0].id !== runId) return 'overlapping_worker';
    const runningTask = this.running.get(taskId);
    if (runningTask && runningTask.runId !== runId) return 'overlapping_worker';
    return null;
  }

  private async handleReferenceModifications(
    taskId: string,
    task: TaskRow,
    rt: RunningTask,
    modifications: ReferenceModification[],
  ): Promise<void> {
    const lines = [
      '# BỊ CHẶN: Phát hiện sửa đổi tài liệu tham chiếu chỉ đọc (References)',
      '',
      'Worker đã sửa đổi các file trong tài liệu tham chiếu (vốn là CHỈ ĐỌC):',
    ];
    const allFiles: string[] = [];
    for (const mod of modifications) {
      lines.push(`\n## Tham chiếu: ${mod.name} (${mod.path})`);
      for (const f of mod.modifiedFiles) {
        lines.push(`- ${f}`);
        allFiles.push(`${mod.name}:${f}`);
      }
      this.eventBus.emit('reference.modified', taskId, {
        reference: mod.name,
        path: mod.path,
        files: mod.modifiedFiles,
        modifiedFiles: mod.modifiedFiles,
      });
    }

    const blockedMessage = lines.join('\n');

    // Remove DONE marker if present and write BLOCKED marker
    if (task.worktreePath) {
      const donePath = path.join(task.worktreePath, '.agenthub', 'DONE');
      const blockedPath = path.join(task.worktreePath, '.agenthub', 'BLOCKED');
      if (fs.existsSync(donePath)) {
        try { fs.unlinkSync(donePath); } catch { /* ignore */ }
      }
      try {
        fs.writeFileSync(blockedPath, blockedMessage, 'utf-8');
      } catch { /* ignore */ }
    }

    // Insert task note if note repo is configured
    if (this.taskNoteRepo) {
      try {
        this.taskNoteRepo.insert({
          projectId: task.projectId,
          taskId,
          kind: 'note',
          content: `Tài liệu tham chiếu bị sửa đổi: ${allFiles.join(', ')}`,
        });
      } catch { /* ignore */ }
    }

    // Finish run as blocked
    this.runRepo.finish(rt.runId, 'blocked');

    // Update task status to blocked
    this.taskRepo.update(taskId, {
      status: 'blocked',
      transientRetries: 0,
      notBefore: null,
    });

    this.eventBus.emit('task.blocked', taskId, {
      reason: 'reference_modified',
      modifications,
    });
  }

  private scheduleNewTasks(): void {
    if (this.restartState.draining) {
      this.markQueuedTasksForRestart();
      return;
    }
    if (this.paused) {
      return;
    }
    if (this.skipSchedulingOnce) {
      this.skipSchedulingOnce = false;
      return;
    }
    const queuedTasks = this.taskRepo.getByStatus('queued');
    const focus = this.getFocus();
    const schedulableTasks: TaskRow[] = [];

    for (const task of queuedTasks) {
      if (focus.projectId && task.projectId !== focus.projectId) {
        if (task.waitReason !== 'focus') {
          this.taskRepo.update(task.id, { status: 'queued', waitReason: 'focus' });
          this.eventBus.emit('task.queued', task.id, { reason: 'focus', projectId: focus.projectId });
        }
        continue;
      }
      if (task.waitReason === 'focus' || task.waitReason === 'restart') this.taskRepo.update(task.id, { status: 'queued', waitReason: null });
      schedulableTasks.push(task);
    }

    const fairUsage = new Map<string, number>();
    for (const running of [...this.running.values(), ...this.starting.values()]) {
      const departmentId = this.projectRepo.get(running.projectId)?.departmentId || 'chung';
      fairUsage.set(departmentId, (fairUsage.get(departmentId) || 0) + 1);
    }
    const blockedDisksInTick = new Map<string, MonitoredDisk>();
    const remainingTasks = [...schedulableTasks];
    while (remainingTasks.length > 0) {
      remainingTasks.sort((a, b) => {
        const aDept = this.departmentIdForTask(a);
        const bDept = this.departmentIdForTask(b);
        const aScore = (fairUsage.get(aDept) || 0) / this.departmentWeight(a);
        const bScore = (fairUsage.get(bDept) || 0) / this.departmentWeight(b);
        return aScore - bScore
          || this.departmentPriority(b) - this.departmentPriority(a)
          || parseDbTime(a.createdAt) - parseDbTime(b.createdAt);
      });
      const task = remainingTasks.shift()!;
      if (this.blockForRunLimit(task)) continue;
      if (task.notBefore != null && task.notBefore > Math.floor(Date.now() / 1000)) continue;
      // Check dependencies
      if (!this.areDependenciesMet(task)) {
        this.markQueuedWaiting(task, 'dependency');
        continue;
      }

      if (this.getModelChain(task).length === 0) {
        this.taskRepo.updateStatus(task.id, 'failed');
        this.eventBus.emit('task.failed', task.id, {
          reason: 'no_usable_model',
          message: 'Model chain không có model hợp lệ thuộc engine đã biết',
        });
        continue;
      }

      // Check project parallel limit
      const project = this.projectRepo.get(task.projectId);
      if (!project) continue;

      const projectAccessible = isProjectAccessible(project.path);
      const worktreeAccessible = !task.worktreePath || fs.existsSync(task.worktreePath);
      if (!projectAccessible || !worktreeAccessible) {
        this.markTaskWaitingForProject(task, project);
        continue;
      }

      if (!this.hasParallelCapacity(project)) {
        const department = project.departmentId ? this.departmentRepo?.get(project.departmentId) : undefined;
        const usage = this.parallelUsage(project);
        const departmentLimited = Boolean(department && department.maxParallel > 0 && usage.department >= this.loadGuard.effectiveParallel(department.maxParallel));
        const isLoadThrottled = this.loadGuard.isOverloaded() || (usage.project >= this.effectiveParallel(project) && usage.project < project.maxParallel);
        this.markQueuedWaiting(task, isLoadThrottled ? 'load' : (departmentLimited ? 'department_parallel' : 'parallel'));
        continue;
      }

      // Find a suitable (model, profile) pair
      const pair = this.findModelProfilePair(task);
      if (pair) {
        const disk = this.getBlockingDiskForTask(task);
        if (disk) {
          this.tasksWaitingForDisk.add(task.id);
          this.taskRepo.updateStatus(task.id, 'waiting_quota', 'disk');
          this.eventBus.emit('task.waiting_quota', task.id, { reason: 'disk', label: disk.label, path: disk.path, freeGB: disk.freeGB, minFreeGB: disk.minFreeGB, message: this.diskWaitMessage(disk) });
          blockedDisksInTick.set(this.getDiskIncidentKey(disk.path), disk);
          continue;
        }
        const departmentId = this.departmentIdForTask(task);
        fairUsage.set(departmentId, (fairUsage.get(departmentId) || 0) + 1);
        void this.startTask(task, pair.model, pair.profileName)
          .catch((error) => {
            console.error(`[scheduler] failed to start task ${task.id}:`, error);
          })
          .finally(() => {
            // A failed start can happen before the run is inserted or after an
            // unexpected exception. Never leave a stale capacity reservation.
            if (!this.running.has(task.id)) this.starting.delete(task.id);
          });
      } else if (this.hasBusyMatchingProfile(task)) {
        this.markQueuedWaiting(task, 'profile_busy');
        continue;
      } else if (this.allMatchingProfilesNeedLogin(task)) {
        this.taskRepo.updateStatus(task.id, 'failed');
        this.eventBus.emit('task.failed', task.id, { reason: 'auth_expired', message: 'Tất cả hồ sơ phù hợp đều cần đăng nhập lại' });
      } else {
        const reason = this.getProfileWaitReason(task);
        const department = this.departmentRepo?.get(this.departmentIdForTask(task));
        this.taskRepo.updateStatus(task.id, 'waiting_quota', reason);
        this.eventBus.emit('task.waiting_quota', task.id, {
          reason,
          ...(reason === 'no_department_profile' ? {
            departmentId: department?.id || this.departmentIdForTask(task),
            departmentName: department?.name || this.departmentIdForTask(task),
            message: `Gán tài khoản cho phòng ${department?.name || this.departmentIdForTask(task)} hoặc bỏ gán`,
          } : {}),
        });
      }
    }

    if (blockedDisksInTick.size > 0) {
      for (const disk of blockedDisksInTick.values()) {
        this.markDiskLow(disk);
      }
    } else {
      const seenDiskKeys = new Set<string>();
      const lowDisks = this.getMonitoredDisks().filter((d) => d.low);
      for (const lowDisk of lowDisks) {
        const diskKey = this.getDiskIncidentKey(lowDisk.path);
        if (seenDiskKeys.has(diskKey)) continue;
        seenDiskKeys.add(diskKey);
        this.markDiskLow(lowDisk);
      }
    }
  }

  private scheduleReviews(): void {
    if (this.restartState.draining) return;
    const state = this.failoverState;
    if (!this.reviewRepo || this.config.reviewer?.enabled === false) return;
    const snapshot = state?.snapshot() || { active: false, step: undefined };
    if (this.failoverWasActive && !snapshot.active) {
      this.eventBus.emit('claude.failover_cleared', undefined);
    }
    this.failoverWasActive = snapshot.active;
    for (const task of this.taskRepo.getByStatus('review')) {
      const focus = this.getFocus();
      if (focus.projectId && task.projectId !== focus.projectId) continue;
      if (this.reviewerRuns.has(task.id)) continue;
      if (task.reviewerEscalated) {
        const last = this.reviewRepo.getByTask(task.id).at(-1);
        if (last && isAutoReviewer(last.actor) && last.verdict === 'approved') {
          // An automated reviewer (e.g. the Claude arbiter) approved after the escalation: it is resolved.
          this.resetReviewerEscalation(task.id);
          task.reviewerEscalated = 0;
        } else {
          if (this.needsEscalationArbiter(task)) this.startEscalationArbiter(task);
          else this.actOnArbiterRejection(task, last);
          continue;
        }
      }
      const chain = this.reviewChainForTask(task);
      const step = chain[task.reviewStep ?? 0];
      if (chain.length > 0 && (task.reviewStep ?? 0) >= chain.length && this.skippedCodexGate(task, chain)) {
        // Tasks that passed a Codex gate without a Codex review (older builds skipped same-model work) go round again.
        this.taskRepo.update(task.id, { reviewStep: 0 });
        continue;
      }
      if (chain.length > 0 && !isAutomatedStep(step)) {
        if ((task.reviewStep ?? 0) >= chain.length && this.markReviewNotified(task, 'complete')) {
          this.emitReviewReadyIfReview(task.id, { reviewChainComplete: true });
        }
        continue;
      }
      if (chain.length > 0 && step?.reviewer === 'claude') {
        if (this.markReviewNotified(task, 'gate')) {
          this.eventBus.emit('review.gate_ready', task.id, { reviewStep: task.reviewStep ?? 0, reviewer: 'claude' });
        }
        continue;
      }
      if (chain.length === 0 && (!snapshot.active || snapshot.step?.type !== 'engine' || snapshot.step.engine !== 'codex')) continue;
      if (this.getCheckResults(task.id).length === 0) {
        this.escalateReview(task.id, 'missing_autocheck_results', 'Không có kết quả autocheck đã lưu; cần người xác minh trước khi tiếp tục.');
        continue;
      }
      if (!task.worktreePath) continue;
      const defaultReviewer = this.config.reviewer?.order?.[0];
      const model = reviewerModel(step || { reviewer: defaultReviewer ? `${defaultReviewer.engine}:${defaultReviewer.model}` : 'codex:gpt-5.6-luna', mode: 'gate' }) || (defaultReviewer ? `${defaultReviewer.engine}:${defaultReviewer.model}` : 'codex:gpt-5.6-luna');
      const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
      // Same model as the worker: still review, but from another Codex account in a fresh session.
      const isPlan = task.slug.endsWith('-plan');
      const preferDifferentEngine = isPlan ? lastWorker?.engine : undefined;
      const picked = chain.length > 0
        ? this.pickChainReviewer(task, step, model, lastWorker?.profileName)
        : this.pickReviewer(task, lastWorker?.model === model ? lastWorker.profileName : undefined, preferDifferentEngine);
      if ('wait' in picked) continue;
      this.startReview(task, picked.profile.name, picked.engine, picked.model, picked.engine.id === 'claude' ? 'claude-reviewer' : 'codex-reviewer');
    }
  }

  /** Pick the first reviewer that can run, applying project overrides and fallback policy. */
  private pickReviewer(task: TaskRow, avoidProfile?: string, preferDifferentEngine?: string, dryRun = false): ReviewerPick {
    const project = this.projectRepo.get(task.projectId);
    const settings = projectSettings(project);
    const legacy = reviewerSettingsFromLegacy(this.config.reviewer as unknown as Record<string, unknown>);
    let order: ReviewerOrderItem[] = settings.review?.order ?? legacy.order;
    if (preferDifferentEngine && order.length > 1) {
      order = [...order].sort((a, b) => {
        const aDiff = a.engine !== preferDifferentEngine ? 1 : 0;
        const bDiff = b.engine !== preferDifferentEngine ? 1 : 0;
        return bDiff - aDiff;
      });
    }
    const fallback: ReviewerFallback = {
      ...legacy.fallback,
      ...(settings.review?.fallback || {}),
    };
    const waitedMs = Date.now() - parseDbTime(task.updatedAt);
    const errorCount = this.reviewerErrorCounts.get(task.id) || 0;
    for (let index = 0; index < order.length; index += 1) {
      const item = order[index];
      const engineId = item.engine === 'claude' ? CLAUDE_REVIEW_ENGINE_KEY : 'codex';
      const engine = this.engines.get(engineId);
      if (!engine) continue;
      const model = normalizeReviewerModel(item.engine, item.model);
      const candidates = this.profileRepo.getEnabled().filter((profile) => {
        if (profile.engine !== item.engine || (item.profiles.length > 0 && !item.profiles.includes(profile.name))) return false;
        if (profile.authState != null && profile.authState !== 'ok') return false;
        if (this.quotaService.isExhausted(profile.name, item.engine === 'claude' ? 'claude' : 'codex')) return false;
        if (this.reviewerInBackoff(profile.name)) return false;
        return true;
      });
      const free = candidates.filter((profile) => !this.reviewerRunsForProfile(profile.name) && this.locks.findFreeSlotSync(profile) !== null)
        .filter((profile) => !(avoidProfile && profile.name === avoidProfile && candidates.length > 1))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      if (free.length > 0 && !(errorCount >= 2 && fallback.onError && index === 0)) {
        if (index > 0 && !dryRun) {
          const key = `${task.id}:${index}`;
          if (!this.reviewerFallbackNotified.has(key)) {
            this.reviewerFallbackNotified.add(key);
            this.eventBus.emit('review.fallback', task.id, {
              from: order[index - 1].engine,
              to: item.engine,
              engine: item.engine,
              model,
              reason: 'available',
              profile: free[0].name,
            });
          }
        }
        return { engine, model, profile: free[0] };
      }
      const unavailable = candidates.length === 0;
      const busy = candidates.length > 0 && free.length === 0;
      const canFallback = (unavailable && fallback.onUnavailable) ||
        (busy && fallback.onBusyAfterMin > 0 && waitedMs >= fallback.onBusyAfterMin * 60_000) ||
        (errorCount >= 2 && fallback.onError);
      if (!canFallback) return { wait: true };
      if (index < order.length - 1 && !dryRun) {
        const key = `${task.id}:${index + 1}`;
        if (!this.reviewerFallbackNotified.has(key)) {
          this.reviewerFallbackNotified.add(key);
          this.eventBus.emit('review.fallback', task.id, {
            from: item.engine,
            to: order[index + 1].engine,
            engine: order[index + 1].engine,
            model: normalizeReviewerModel(order[index + 1].engine, order[index + 1].model),
            reason: unavailable ? 'unavailable' : busy ? 'busy' : 'error',
          });
        }
      }
    }
    return { wait: true };
  }

  private pickChainReviewer(task: TaskRow, step: ReviewChainStep | undefined, model: string, avoidProfile?: string, dryRun = false): ReviewerPick {
    if (step?.reviewer === 'claude') {
      if (!this.claudeBudgetAvailable(task)) {
        if (!dryRun) this.emitReviewWaiting(task, 'claude_budget');
        return { wait: true };
      }
      const engine = this.engines.get(CLAUDE_REVIEW_ENGINE_KEY);
      if (!engine) {
        if (!dryRun) this.emitReviewWaiting(task, 'no_reviewer_profile');
        return { wait: true };
      }
      const profiles = this.availableChainProfiles('claude', undefined);
      const profile = profiles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      if (!profile && !dryRun) this.emitReviewWaiting(task, 'no_reviewer_profile');
      return profile ? { engine, model, profile } : { wait: true };
    }

    const engine = this.engines.get('codex');
    if (!engine) {
      if (!dryRun) this.emitReviewWaiting(task, 'no_reviewer_profile');
      return { wait: true };
    }
    const eligibleCodexProfiles = this.availableChainProfiles('codex', undefined, false);
    const codexProfiles = this.availableChainProfiles('codex', undefined);
    const nonWorkerProfiles = codexProfiles.filter((profile) => profile.name !== avoidProfile);
    const eligibleNonWorkerProfiles = eligibleCodexProfiles.filter((profile) => profile.name !== avoidProfile);
    const errorCount = this.reviewerErrorCounts.get(task.id) || 0;
    const settings = this.reviewerSettingsForTask(task);
    const waitedMs = Date.now() - parseDbTime(task.updatedAt);
    const claudeBudgetUnavailable = !this.claudeBudgetAvailable(task);
    const workerOnly = Boolean(avoidProfile) && eligibleCodexProfiles.length > 0 && eligibleCodexProfiles.every((profile) => profile.name === avoidProfile);
    const shouldFallback = (workerOnly || eligibleCodexProfiles.length === 0)
      ? settings.fallback.onUnavailable
      : errorCount >= 2 && settings.fallback.onError;

    if (shouldFallback) {
      const fallback = this.pickChainClaudeFallback(task, settings, dryRun);
      if (fallback) return fallback;
      if (!dryRun) {
        if (claudeBudgetUnavailable) this.emitReviewWaiting(task, 'claude_budget');
        else if (workerOnly) this.emitReviewWaiting(task, 'only_worker_profile');
        else if (!eligibleCodexProfiles.length) this.emitReviewWaiting(task, 'no_reviewer_profile');
        else if (errorCount >= 2) this.emitReviewWaiting(task, 'no_reviewer_profile');
      }
    }

    // The fallback attempt above is deliberately best-effort. If it is disabled, over budget,
    // or has no usable Claude profile, the only free Codex profile is still a valid fresh session.
    const selected = nonWorkerProfiles[0] || (workerOnly ? codexProfiles[0] : undefined);
    if (selected && !(errorCount >= 2 && settings.fallback.onError)) {
      return { engine, model, profile: selected };
    }

    const busy = eligibleNonWorkerProfiles.length > 0 && nonWorkerProfiles.length === 0;
    if (busy && waitedMs >= settings.fallback.onBusyAfterMin * 60_000 && settings.fallback.onBusyAfterMin >= 0) {
      const fallback = this.pickChainClaudeFallback(task, settings, dryRun);
      if (fallback) return fallback;
    }
    if (!dryRun) {
      if (claudeBudgetUnavailable) this.emitReviewWaiting(task, 'claude_budget');
      else if (workerOnly) this.emitReviewWaiting(task, 'only_worker_profile');
      else if (!eligibleCodexProfiles.length) this.emitReviewWaiting(task, 'no_reviewer_profile');
      else if (errorCount >= 2 || busy) this.emitReviewWaiting(task, 'no_reviewer_profile');
    }
    return { wait: true };
  }

  private reviewerSettingsForTask(task: TaskRow): { order: ReviewerOrderItem[]; fallback: ReviewerFallback } {
    const project = this.projectRepo.get(task.projectId);
    const settings = projectSettings(project);
    const legacy = reviewerSettingsFromLegacy(this.config.reviewer as unknown as Record<string, unknown>);
    return {
      order: settings.review?.order ?? legacy.order,
      fallback: { ...legacy.fallback, ...(settings.review?.fallback || {}) },
    };
  }

  private availableChainProfiles(engineId: 'codex' | 'claude', preferred: string[] | undefined, freeOnly = true): ProfileRow[] {
    const family = engineId === 'claude' ? 'claude' : 'codex';
    return this.profileRepo.getEnabled().filter((profile) => profile.engine === engineId
      && (!preferred || preferred.length === 0 || preferred.includes(profile.name))
      && (profile.authState == null || profile.authState === 'ok')
      && !this.quotaService.isExhausted(profile.name, family)
      && !this.reviewerInBackoff(profile.name)
      && (!freeOnly || (!this.reviewerRunsForProfile(profile.name) && this.locks.findFreeSlotSync(profile) !== null)));
  }

  private pickChainClaudeFallback(task: TaskRow, settings: { order: ReviewerOrderItem[]; fallback: ReviewerFallback }, dryRun = false): ReviewerPick | null {
    const item = settings.order.find((candidate) => candidate.engine === 'claude') || {
      engine: 'claude' as const,
      model: 'sonnet',
      profiles: this.config.reviewer?.claudeProfiles || [],
    };
    if (!this.claudeBudgetAvailable(task)) {
      if (!dryRun) this.emitReviewWaiting(task, 'claude_budget');
      return null;
    }
    const engine = this.engines.get(CLAUDE_REVIEW_ENGINE_KEY);
    if (!engine) return null;
    const profiles = this.availableChainProfiles('claude', item.profiles)
      .sort((a, b) => (item.profiles.indexOf(a.name) < 0 ? item.profiles.length : item.profiles.indexOf(a.name)) -
        (item.profiles.indexOf(b.name) < 0 ? item.profiles.length : item.profiles.indexOf(b.name)) ||
        (b.priority ?? 0) - (a.priority ?? 0));
    const profile = profiles[0];
    if (!profile) return null;
    const key = `${task.id}:chain:codex:claude`;
    if (!dryRun && !this.reviewerFallbackNotified.has(key)) {
      this.reviewerFallbackNotified.add(key);
      this.eventBus.emit('review.fallback', task.id, {
        from: 'codex',
        to: 'claude',
        engine: 'claude',
        model: normalizeReviewerModel('claude', item.model),
        reason: 'unavailable',
        profile: profile.name,
      });
    }
    return { engine, model: normalizeReviewerModel('claude', item.model), profile };
  }

  private emitReviewWaiting(task: TaskRow, reason: 'no_reviewer_profile' | 'only_worker_profile' | 'claude_budget'): void {
    const now = Date.now();
    const previous = this.reviewWaitingNotified.get(task.id);
    if (previous && previous.reason === reason && now - previous.at < 30 * 60 * 1000) return;
    this.reviewWaitingNotified.set(task.id, { reason, at: now });
    this.eventBus.emit('review.waiting', task.id, { reason });
  }

  private reviewChainForTask(task: TaskRow): ReviewChainStep[] {
    const project = this.projectRepo.get(task.projectId);
    if (!project) return [];
    if (project.review) {
      try {
        const value = JSON.parse(project.review) as { chain?: unknown };
        return parseReviewChain(JSON.stringify(value.chain || []));
      } catch {
        return [];
      }
    }
    return parseReviewChain(project.reviewChain);
  }

  private advanceReviewStep(task: TaskRow, chain: ReviewChainStep[], reason: string): void {
    const nextStep = (task.reviewStep ?? 0) + 1;
    // This counter is task-scoped. Keep it across chain steps so alternating
    // reviewers cannot reset the content-review limit.
    this.taskRepo.update(task.id, { reviewStep: nextStep });
    task.reviewStep = nextStep;
    if (nextStep >= chain.length || !isAutomatedStep(chain[nextStep])) {
      this.markReviewNotified(task, 'complete');
      this.emitReviewReadyIfReview(task.id, { reviewChainComplete: true, reviewStep: nextStep, reason });
    } else {
      this.eventBus.emit('review.gate_completed', task.id, { reviewStep: nextStep, reason });
    }
  }

  /**
   * A task escalated a second time gets a final automated verdict instead of waiting for a person.
   * Claude is preferred; an independent Codex account takes over when Claude is unavailable.
   */
  private needsEscalationArbiter(task: TaskRow): boolean {
    if (task.reviewerEscalationReason !== 'reviewer_changes_limit') return false;
    const escalations = this.eventRepo.getByTask(task.id)
      .filter((event) => event.type === 'review.escalated' && event.payload?.includes('reviewer_changes_limit'));
    if (escalations.length < 2) return false;
    const lastEscalationId = escalations[escalations.length - 1].id;
    if (this.hasAutomatedVerdictAfter(task.id, lastEscalationId)) return false;
    // Keep compatibility with durable review rows written by older daemons that did not
    // emit review.completed. Restrict this fallback to the legacy Claude arbiter actor so
    // a stale pre-escalation Codex review cannot satisfy the current escalation.
    const lastReview = this.reviewRepo?.getByTask(task.id).at(-1);
    return !(lastReview?.actor === 'claude-reviewer' && lastReview.verdict === 'changes_requested');
  }

  /**
   * The arbiter asked for changes on an escalated task. Send it back
   * with that feedback on the strongest model, at most ARBITER_ROUNDS times; then block it and say so.
   */
  private actOnArbiterRejection(task: TaskRow, last: { actor: string; verdict: string; feedback: string | null; createdAt: string } | undefined): void {
    if (!last || !isAutoReviewer(last.actor) || last.verdict !== 'changes_requested') return;
    if (task.reviewerEscalationReason !== 'reviewer_changes_limit') return;
    const escalations = this.eventRepo.getByTask(task.id)
      .filter((event) => event.type === 'review.escalated' && event.payload?.includes('reviewer_changes_limit'));
    const lastEscalationId = escalations.at(-1)?.id;
    if (lastEscalationId == null) return;
    const hasEventVerdict = this.hasAutomatedVerdictAfter(task.id, lastEscalationId, 'changes_requested');
    const legacyReviews = this.reviewRepo?.getByTask(task.id)
      .filter((review) => review.actor === 'claude-reviewer' && review.verdict === 'changes_requested') ?? [];
    if (!hasEventVerdict && legacyReviews.length === 0) return;
    // Count arbiter rejections across every arbiter round (from the second escalation on), so a task
    // that keeps getting re-escalated is still blocked after ARBITER_ROUNDS instead of looping forever.
    const arbiterStartId = escalations[1]?.id ?? lastEscalationId;
    const rejections = this.eventRepo.getByTask(task.id)
      .filter((event) => event.id > arbiterStartId && event.type === 'review.completed' && event.payload?.includes('"verdict":"changes_requested"')).length;
    const totalRejections = rejections || legacyReviews.length;
    if (totalRejections > ARBITER_ROUNDS) {
      this.taskRepo.updateStatus(task.id, 'blocked');
      this.eventBus.emit('task.blocked', task.id, {
        reason: 'review_rounds_exhausted',
        title: task.title,
        message: `Codex và Claude đều chưa duyệt sau ${ARBITER_ROUNDS} vòng giao lại; cần người xem.`,
      });
      return;
    }
    let chain: string[] = [];
    try { chain = task.modelChain ? JSON.parse(task.modelChain) as string[] : []; } catch { chain = []; }
    this.taskRepo.update(task.id, { modelChain: JSON.stringify([ARBITER_RETRY_MODEL, ...chain.filter((model) => model !== ARBITER_RETRY_MODEL)]) });
    this.reviewTask(task.id, 'changes_requested', `${last.feedback || 'Arbiter yêu cầu sửa.'}\n\n(Reviewer đã từ chối nhiều vòng và arbiter cũng yêu cầu sửa; giao lại lần ${totalRejections}/${ARBITER_ROUNDS} với ${ARBITER_RETRY_MODEL}.)`, 'auto-arbiter');
  }

  private hasAutomatedVerdictAfter(taskId: string, eventId: number, verdict?: ReviewerVerdict): boolean {
    return this.eventRepo.getByTask(taskId).some((event) => {
      if (event.id <= eventId || event.type !== 'review.completed' || !event.payload) return false;
      try {
        const payload = JSON.parse(event.payload) as { actor?: string; verdict?: ReviewerVerdict };
        return isAutoReviewer(payload.actor) && (!verdict || payload.verdict === verdict);
      } catch {
        return false;
      }
    });
  }

  private reviewWaitedTooLong(task: TaskRow): boolean {
    const waitedMs = Date.now() - parseDbTime(task.updatedAt);
    return Number.isFinite(waitedMs) && waitedMs >= (this.config.reviewer?.fallback.onBusyAfterMin ?? 10) * 60_000;
  }

  private codexReviewUnavailable(): boolean {
    const codexProfiles = this.profileRepo.getEnabled().filter((p) => p.engine === 'codex');
    return codexProfiles.every((p) => this.quotaService.isExhausted(p.name, 'codex') || (p.authState != null && p.authState !== 'ok'));
  }

  private startClaudeFallbackReview(task: TaskRow): 'started' | 'waiting' | 'unavailable' {
    const arbiter = this.config.reviewer?.arbiter || { engine: 'claude' as const, model: 'opus' };
    if (arbiter.engine === 'claude' && !this.claudeBudgetAvailable(task)) {
      this.eventBus.emit('review.waiting', task.id, { actor: 'claude-reviewer', reason: 'department_claude_budget' });
      return 'waiting';
    }
    const engine = this.engines.get(arbiter.engine === 'claude' ? CLAUDE_REVIEW_ENGINE_KEY : 'codex');
    if (!engine) return 'unavailable';
    const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
    const preferred = arbiter.engine === 'claude' ? (this.config.reviewer?.claudeProfiles ?? []) : [];
    const rank = (name: string) => (preferred.includes(name) ? preferred.indexOf(name) : preferred.length);
    const candidates = this.profileRepo.getEnabled()
      .filter((p) => p.engine === arbiter.engine && (p.authState == null || p.authState === 'ok') &&
        (preferred.length === 0 || preferred.includes(p.name)) &&
        !this.quotaService.isExhausted(p.name, arbiter.engine === 'claude' ? 'claude' : 'codex') &&
        !this.reviewerInBackoff(p.name) &&
        !this.reviewerRunsForProfile(p.name) && this.locks.findFreeSlotSync(p) !== null)
      .sort((a, b) => Number(a.name === lastWorker?.profileName) - Number(b.name === lastWorker?.profileName) ||
        rank(a.name) - rank(b.name) || (b.priority ?? 0) - (a.priority ?? 0));
    const profile = candidates[0];
    if (!profile) return 'unavailable';
    this.eventBus.emit('review.fallback', task.id, {
      from: 'reviewer',
      to: arbiter.engine,
      engine: arbiter.engine,
      model: normalizeReviewerModel(arbiter.engine, arbiter.model),
      reason: 'arbiter',
      profile: profile.name,
    });
    this.startReview(task, profile.name, engine, normalizeReviewerModel(arbiter.engine, arbiter.model), arbiter.engine === 'claude' ? 'claude-reviewer' : 'codex-reviewer');
    return 'started';
  }

  /** Prefer Claude as arbiter, but immediately fall back to an independent Codex account. */
  private startEscalationArbiter(task: TaskRow): void {
    const before = this.reviewerRuns.size;
    // Arbiter selection is independent from the legacy reviewer fallback switch. The configured
    // arbiter must get the first chance even when claudeFallback is disabled.
    const arbiterResult = this.startClaudeFallbackReview(task);
    if (arbiterResult === 'waiting') return;
    if (this.reviewerRuns.size > before) return;

    const arbiterEngine = this.config.reviewer?.arbiter?.engine ?? 'claude';
    if (arbiterEngine === 'codex') {
      const claudeEngine = this.engines.get(CLAUDE_REVIEW_ENGINE_KEY);
      if (!claudeEngine || !task.worktreePath || !this.claudeBudgetAvailable(task)) return;
      const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
      const candidates = this.profileRepo.getEnabled()
        .filter((profile) => profile.engine === 'claude'
          && (profile.authState == null || profile.authState === 'ok')
          && !this.quotaService.isExhausted(profile.name, 'claude')
          && !this.reviewerInBackoff(profile.name)
          && !this.reviewerRunsForProfile(profile.name)
          && this.locks.findFreeSlotSync(profile) !== null)
        .sort((a, b) => Number(a.name === lastWorker?.profileName) - Number(b.name === lastWorker?.profileName) ||
          (b.priority ?? 0) - (a.priority ?? 0));
      const profile = candidates[0];
      if (!profile) return;
      const claudeConfig = this.config.reviewer?.order?.find((item) => item.engine === 'claude');
      const claudeModel = `claude:${claudeConfig?.model || 'sonnet'}`;
      this.eventBus.emit('review.fallback', task.id, {
        from: 'codex',
        to: 'claude',
        engine: 'claude',
        model: claudeModel,
        profile: profile.name,
        reason: 'arbiter_unavailable',
      });
      this.startReview(task, profile.name, claudeEngine, claudeModel, 'claude-reviewer');
      return;
    }

    const codexEngine = this.engines.get('codex');
    if (!codexEngine || !task.worktreePath) return;
    const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
    const candidates = this.profileRepo.getEnabled()
      .filter((profile) => profile.engine === 'codex'
        && !this.quotaService.isExhausted(profile.name, 'codex')
        && !this.reviewerInBackoff(profile.name)
        && !this.reviewerRunsForProfile(profile.name)
        && this.locks.findFreeSlotSync(profile) !== null)
      .sort((a, b) => Number(a.name === lastWorker?.profileName) - Number(b.name === lastWorker?.profileName) ||
        (b.priority ?? 0) - (a.priority ?? 0));
    const profile = candidates[0];
    if (!profile) return;
    const codexConfig = this.config.reviewer?.order?.find((item) => item.engine === 'codex');
    const codexModel = `codex:${codexConfig?.model || 'gpt-5.6-luna'}`;
    this.eventBus.emit('review.fallback', task.id, {
      from: 'claude',
      to: 'codex',
      engine: 'codex',
      model: codexModel,
      profile: profile.name,
      reason: 'arbiter_unavailable',
    });
    this.startReview(task, profile.name, codexEngine, codexModel, 'codex-reviewer');
  }

  private reviewerInBackoff(profileName: string): boolean {
    const until = this.reviewerBackoffUntil.get(profileName) || 0;
    if (until <= Date.now()) {
      this.reviewerBackoffUntil.delete(profileName);
      return false;
    }
    return true;
  }

  private skippedCodexGate(task: TaskRow, chain: ReviewChainStep[]): boolean {
    if (!chain.some((step) => isAutomatedStep(step) && step.reviewer.startsWith('codex:'))) return false;
    const last = this.reviewRepo?.getByTask(task.id).at(-1);
    return !last || !isAutoReviewer(last.actor) || last.verdict !== 'approved';
  }

  /**
   * scheduleReviews runs every tick; without this, a task parked at a non-gate step re-emits its
   * ready event (and a Telegram/desktop notification) on every tick. Returns true once per task+step.
   */
  private markReviewNotified(task: TaskRow, kind: 'complete' | 'gate'): boolean {
    const key = `${kind}:${task.reviewStep ?? 0}`;
    if (this.reviewNotified.get(task.id) === key) return false;
    this.reviewNotified.set(task.id, key);
    return true;
  }

  reviewerRunsForProfile(profileName: string): boolean {
    return [...this.reviewerRuns.values()].some((run) => run.profileName === profileName);
  }

  private taskLogDir(task: TaskRow): string {
    const project = this.projectRepo.get(task.projectId);
    if (project && projectSettings(project).worktree.logsInRoot === true) {
      return path.join(projectWorktreeRoot(project, this.config.hubHome), '.logs', task.id.replace('/', '_'));
    }
    return path.join(this.config.logsDir, task.id.replace('/', '_'));
  }

  private startReview(task: TaskRow, profileName: string, engine: Engine, reviewerModel: string, reviewerActor = 'codex-reviewer'): void {
    const actor: ReviewerActor = engine.id === 'claude' ? 'claude-reviewer' : 'codex-reviewer';
    const profile = this.profileRepo.get(profileName);
    if (!profile || !task.worktreePath || this.reviewerRuns.has(task.id)) return;
    const lockSlot = this.locks.findFreeSlotSync(profile);
    if (lockSlot === null) return;
    const lockFile = this.locks.lockPath(profile, lockSlot);
    this.locks.reserve(profile.name, lockFile);
    const runId = crypto.randomUUID();
    const logDir = this.taskLogDir(task);
    const logPath = path.join(logDir, `${runId}.log`);
    const outputPath = path.join(logDir, `${runId}.final.json`);
    this.runRepo.insert({ id: runId, taskId: task.id, engine: engine.id, model: reviewerModel, profileName, logPath, kind: 'reviewer' });
    let child;
    try {
      const checks = this.getCheckResults(task.id).map((check) => ({
        name: check.name,
        ok: check.ok,
        outputTail: check.outputTail,
        runId: check.runId || 'unknown',
        runStartedAt: check.runStartedAt || 'unknown',
      }));
      const project = this.projectRepo.get(task.projectId);
      const previousReviews = this.reviewRepo?.getByTask(task.id).map((review) => ({
        actor: review.actor,
        verdict: review.verdict as ReviewerVerdict,
        feedback: review.feedback,
        createdAt: review.createdAt,
        engine: review.engine,
        profileName: review.profileName,
      })) || [];
      child = engine.spawn({
        profile,
        model: reviewerModel,
        cwd: task.worktreePath,
        prompt: buildReviewerPrompt(
          task.body || task.title,
          task.worktreePath,
          checks,
          project ? projectSettings(project).reviewChecklist : [],
          project?.path,
          previousReviews,
          task.slug.endsWith('-plan'),
        ),
        logPath,
        outputPath,
        readOnly: true,
        lockFile,
        env: { AGENTHUB_TASK_ID: task.id },
        hubHome: this.config.hubHome,
        project,
        gitHooks: project ? projectSettings(project).worktree.gitHooks : undefined,
        workerCount: 1,
      });
      if (!child.pid) throw new Error('reviewer process has no pid');
      this.runRepo.updatePid(runId, child.pid, this.getProcessStartTime(child.pid));
    } catch (error) {
      this.locks.release(profile.name, lockFile);
      this.runRepo.finish(runId, 'crashed', undefined, String(error));
      this.eventBus.emit('review.failed', task.id, { actor, reason: 'spawn_failed' });
      return;
    }
    const timeout = setTimeout(() => {
      if (!this.reviewerRuns.has(task.id)) return;
      this.killProcessGroup(child.pid!);
      this.finishReview(task.id, runId, profileName, 'timeout');
    }, (this.config.reviewer?.timeoutSec || 900) * 1000);
    this.reviewerRuns.set(task.id, { taskId: task.id, runId, pid: child.pid, profileName, engine, actor, outputPath, lockSlot, lockFile, startedAt: Date.now(), timeout });
    this.locks.invalidate(profileName);
    child.unref();
    const actualEngine = engine.id;
    const runNumber = this.runRepo.getByTask(task.id).length;
    this.eventBus.emit('review.started', task.id, { actor: reviewerActor, model: reviewerModel, profile: profileName, engine: actualEngine, runId, runNumber });
    let finished = false;
    let hasError = false;
    let savedExitCode: number | null = null;
    let savedSignal: NodeJS.Signals | string | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    const doFinish = (reason: 'exit' | 'error', code: number | null, signal: string | null = null) => {
      if (finished) return;
      finished = true;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      const run = this.reviewerRuns.get(task.id);
      if (run && run.runId === runId && run.exitTimeout) {
        clearTimeout(run.exitTimeout);
        delete run.exitTimeout;
      }
      if (!this.stopped) {
        this.finishReview(task.id, runId, profileName, reason, code, signal);
      }
    };

    child.once('error', () => {
      if (finished || this.stopped) return;
      hasError = true;
      if (!safetyTimer) {
        safetyTimer = setTimeout(() => doFinish('error', savedExitCode, savedSignal), 2000);
        const run = this.reviewerRuns.get(task.id);
        if (run && run.runId === runId) run.exitTimeout = safetyTimer;
      }
    });

    child.once('exit', (code, signal) => {
      if (finished || this.stopped) return;
      savedExitCode = code;
      savedSignal = signal;
      if (!safetyTimer) {
        safetyTimer = setTimeout(() => doFinish(hasError ? 'error' : 'exit', savedExitCode, savedSignal), 2000);
        const run = this.reviewerRuns.get(task.id);
        if (run && run.runId === runId) run.exitTimeout = safetyTimer;
      }
    });

    child.once('close', (code, signal) => {
      if (finished || this.stopped) return;
      const finalSignal = signal ?? savedSignal;
      const finalCode = code ?? savedExitCode;
      doFinish(hasError ? 'error' : 'exit', finalCode, finalSignal);
    });
  }

  getNextReviewerProfile(task: TaskRow): string | undefined {
    try {
      const chain = this.reviewChainForTask(task);
      const step = chain[task.reviewStep ?? 0];
      const defaultReviewer = this.config.reviewer?.order?.[0];
      const model = reviewerModel(step || { reviewer: defaultReviewer ? `${defaultReviewer.engine}:${defaultReviewer.model}` : 'codex:gpt-5.6-luna', mode: 'gate' }) || (defaultReviewer ? `${defaultReviewer.engine}:${defaultReviewer.model}` : 'codex:gpt-5.6-luna');
      const lastWorker = this.runRepo.getByTask(task.id).filter((r) => r.kind === 'worker').at(-1);
      const isPlan = task.slug.endsWith('-plan');
      const preferDifferentEngine = isPlan ? lastWorker?.engine : undefined;
      const picked = chain.length > 0
        ? this.pickChainReviewer(task, step, model, lastWorker?.profileName, true)
        : this.pickReviewer(task, lastWorker?.model === model ? lastWorker.profileName : undefined, preferDifferentEngine, true);
      if ('profile' in picked) {
        return picked.profile.name;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private finishReview(taskId: string, runId: string, profileName: string, reason: 'exit' | 'timeout' | 'error', exitCode: number | null = 0, signal: string | null = null): void {
    if (this.stopped) return;
    const active = this.reviewerRuns.get(taskId);
    if (!active || active.runId !== runId) return;
    clearTimeout(active.timeout);
    if (active.exitTimeout) clearTimeout(active.exitTimeout);
    this.reviewerRuns.delete(taskId);
    if (active.lockFile) {
      this.locks.release(profileName, active.lockFile);
    }
    this.locks.invalidate(profileName);
    const run = this.runRepo.get(runId);
    let output = '';
    let logOutput = '';
    if (run?.logPath) {
      try { logOutput = fs.readFileSync(run.logPath, 'utf8'); } catch { logOutput = ''; }
    }
    try { output = fs.readFileSync(active.outputPath, 'utf8'); } catch { output = ''; }
    const duration = Date.now() - active.startedAt;
    const isLockBusy = duration < 3000 && logOutput.trim() === '' && Boolean(active.lockFile) && exitCode === 1;

    const appendFailoverReason = (reasonText: string) => {
      if (run?.logPath) {
        try {
          fs.appendFileSync(run.logPath, `\n[agenthub] ${reasonText}\n`, 'utf8');
        } catch { /* ignore */ }
      }
    };

    if (isLockBusy) {
      this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_LOCK_BACKOFF_MS);
      this.runRepo.finish(runId, 'crashed', undefined, 'lock_busy');
      const task = this.taskRepo.get(taskId);
      const nextReviewer = task ? this.getNextReviewerProfile(task) : undefined;
      appendFailoverReason(nextReviewer ? `reviewer ${profileName} bận khóa, chuyển sang ${nextReviewer}` : `reviewer ${profileName} bận khóa`);
      this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: 'lock_busy' });
      return;
    }

    const combinedLog = `${logOutput}\n${output}`;
    const isClaudeReviewer = active.actor === 'claude-reviewer' || active.engine.id === 'claude';
    const isFailedRun = reason === 'timeout' || reason === 'error' || Boolean(signal) || exitCode === null || exitCode !== 0;

    if (isFailedRun) {
      // Only detect auth error from trusted error sources for Claude reviewer; never for Codex reviewer
      const authExpired = isClaudeReviewer && active.engine.detectAuthError(combinedLog).expired;
      if (authExpired) {
        this.profileRepo.updateAuthState(profileName, 'not_logged_in', 'Phiên đăng nhập hết hạn (401) – cần đăng nhập lại', null);
        this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_CRASH_BACKOFF_MS);
        this.runRepo.finish(runId, 'crashed', undefined, 'auth_error');
        const task = this.taskRepo.get(taskId);
        const nextReviewer = task ? this.getNextReviewerProfile(task) : undefined;
        appendFailoverReason(nextReviewer ? `reviewer ${profileName} lỗi đăng nhập, chuyển sang ${nextReviewer}` : `reviewer ${profileName} lỗi đăng nhập`);
        this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: 'auth_error' });
        return;
      }

      const quota = active.engine.detectQuota(combinedLog).exhausted;
      if (quota) {
        this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_CRASH_BACKOFF_MS);
        this.runRepo.finish(runId, 'quota');
        this.quotaService.mark(profileName, active.actor === 'claude-reviewer' ? 'claude' : 'codex', this.config.reviewer?.failoverSec || 5 * 60 * 60, `${active.actor} quota`);
        const task = this.taskRepo.get(taskId);
        const nextReviewer = task ? this.getNextReviewerProfile(task) : undefined;
        appendFailoverReason(nextReviewer ? `reviewer ${profileName} hết quota, chuyển sang ${nextReviewer}` : `reviewer ${profileName} hết quota`);
        this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: 'quota' });
        return;
      }

      this.reviewerErrorCounts.set(taskId, (this.reviewerErrorCounts.get(taskId) || 0) + 1);
      this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_CRASH_BACKOFF_MS);
      this.runRepo.finish(runId, reason === 'timeout' ? 'timeout' : 'crashed');
      this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: reason === 'timeout' ? 'timeout' : 'crash' });
      return;
    }

    const task = this.taskRepo.get(taskId);
    const checks = this.getCheckResults(taskId);
    if (checks.length === 0) {
      this.runRepo.finish(runId, 'done', undefined, 'reviewer had no persisted autocheck results');
      this.escalateReview(taskId, 'missing_autocheck_results', 'Không có kết quả autocheck đã lưu; cần người xác minh trước khi tiếp tục.');
      return;
    }

    const result = parseReviewerOutput(output);
    if (!result) {
      const authExpired = isClaudeReviewer && active.engine.detectAuthError(combinedLog).expired;
      if (authExpired) {
        this.profileRepo.updateAuthState(profileName, 'not_logged_in', 'Phiên đăng nhập hết hạn (401) – cần đăng nhập lại', null);
        this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_CRASH_BACKOFF_MS);
        this.runRepo.finish(runId, 'crashed', undefined, 'auth_error');
        const nextReviewer = task ? this.getNextReviewerProfile(task) : undefined;
        appendFailoverReason(nextReviewer ? `reviewer ${profileName} lỗi đăng nhập, chuyển sang ${nextReviewer}` : `reviewer ${profileName} lỗi đăng nhập`);
        this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: 'auth_error' });
        return;
      }
      const quota = active.engine.detectQuota(combinedLog).exhausted;
      if (quota) {
        this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_CRASH_BACKOFF_MS);
        this.runRepo.finish(runId, 'quota');
        this.quotaService.mark(profileName, active.actor === 'claude-reviewer' ? 'claude' : 'codex', this.config.reviewer?.failoverSec || 5 * 60 * 60, `${active.actor} quota`);
        const nextReviewer = task ? this.getNextReviewerProfile(task) : undefined;
        appendFailoverReason(nextReviewer ? `reviewer ${profileName} hết quota, chuyển sang ${nextReviewer}` : `reviewer ${profileName} hết quota`);
        this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: 'quota' });
        return;
      }

      this.reviewerErrorCounts.set(taskId, (this.reviewerErrorCounts.get(taskId) || 0) + 1);
      this.runRepo.finish(runId, 'crashed', undefined, 'malformed reviewer output');
      this.eventBus.emit('review.failed', taskId, { actor: active.actor, reason: 'malformed_output' });
      return;
    }
    if (this.isReadOnlyEnvironmentFeedback(result.verdict, result.feedback)) {
      this.runRepo.finish(runId, 'done', undefined, 'reviewer read-only environment error');
      this.escalateReview(taskId, 'reviewer_environment', result.feedback);
      return;
    }
    if (result.verdict === 'approved' && task?.worktreePath) {
      try {
        const status = execFileSync('git', ['-C', task.worktreePath, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
        if (status) {
          this.runRepo.finish(runId, 'crashed', undefined, 'uncommitted changes');
          this.eventBus.emit('review.failed', taskId, { actor: active.actor, reason: 'uncommitted_changes' });
          return;
        }
      } catch {
        this.runRepo.finish(runId, 'crashed', undefined, 'unable to read git status');
        this.eventBus.emit('review.failed', taskId, { actor: active.actor, reason: 'git_unreadable' });
        return;
      }
    }
    const reviewerEngine = run?.engine || active.engine.id;
    const reviewerProfile = run?.profileName || active.profileName;
    this.runRepo.finish(runId, 'done');
    this.reviewerErrorCounts.delete(taskId);
    this.reviewTask(taskId, result.verdict, result.feedback, active.actor, 'content', {
      engine: reviewerEngine,
      profileName: reviewerProfile,
    });
    const defaultReviewer = this.config.reviewer?.order?.[0];
    this.eventBus.emit('review.completed', taskId, {
      actor: active.actor,
      verdict: result.verdict,
      model: run?.model || (defaultReviewer ? `${defaultReviewer.engine}:${defaultReviewer.model}` : 'codex:gpt-5.6-luna'),
      runId,
      engine: reviewerEngine,
      profile: reviewerProfile,
    });
    if (!this.stopped) this.triggerTick();
  }

  private isReadOnlyEnvironmentFeedback(verdict: ReviewerVerdict, feedback: string): boolean {
    if (verdict !== 'changes_requested') return false;
    const environmentError = /(?:EROFS|read[- ]only filesystem|filesystem is read-only|permission denied|EACCES)/i;
    if (!environmentError.test(feedback)) return false;
    const remaining = feedback
      .split(/(?:\r?\n|(?<=[.!?。！？])\s+)/)
      .filter((sentence) => !environmentError.test(sentence))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return remaining.length <= 80;
  }

  private escalateReview(taskId: string, reason: string, feedback: string, actor?: string): void {
    const task = this.taskRepo.get(taskId);
    if (!task || task.reviewerEscalated) return;
    const allChanges = this.reviewRepo?.getByTask(taskId)
      .filter((review) => review.verdict === 'changes_requested' && review.feedback) || [];
    const openSections: string[] = [];
    if (feedback) {
      openSections.push(`[Lỗi vòng hiện tại] ${feedback}`);
    }
    const priorMissed = allChanges.slice(0, -1).filter((r) => r.feedback && /missed-earlier/i.test(r.feedback));
    for (const item of priorMissed) {
      if (item.feedback && item.feedback !== feedback) {
        openSections.push(`[Lỗi bỏ sót ghi nhận từ vòng trước (missed-earlier - ${item.actor || 'reviewer'})] ${item.feedback}`);
      }
    }
    const historyList = allChanges
      .map((review, index) => `${index + 1}. [Lịch sử vòng ${index + 1} - ${review.actor || 'reviewer'}] ${review.feedback}`);
    const openFeedback = [
      ...openSections,
      ...(historyList.length > 0 ? ['Lịch sử các vòng review:', ...historyList] : []),
    ].join('\n\n') || feedback;
    this.taskRepo.update(taskId, {
      status: 'review',
      reviewerEscalated: 1,
      reviewerEscalatedAt: new Date().toISOString(),
      reviewerEscalationReason: reason,
    });
    this.eventBus.emit('review.escalated', taskId, {
      actor: actor || 'codex-reviewer',
      reason,
      feedback: openFeedback,
      openFeedback,
      title: task.title,
    });
  }

  private areDependenciesMet(task: TaskRow): boolean {
    const deps: string[] = JSON.parse(task.dependsOn);
    for (const depId of deps) {
      const dep = this.taskRepo.get(depId);
      if (!dep || (dep.status !== 'done' && dep.status !== 'pushed')) return false;
    }
    return true;
  }

  private getEmailRunningCount(profile: ProfileRow): number {
    const targetEmail = profile.email;
    const sameEmailProfileNames = new Set<string>();
    sameEmailProfileNames.add(profile.name);

    if (targetEmail) {
      for (const p of this.profileRepo.getAll()) {
        if (sameAccount(p, profile)) {
          sameEmailProfileNames.add(p.name);
        }
      }
    }

    const seenRunIds = new Set<string>();
    let count = 0;

    for (const rt of this.running.values()) {
      seenRunIds.add(rt.runId);
      if (sameEmailProfileNames.has(rt.profileName)) {
        count++;
      }
    }

    for (const starting of this.starting.values()) {
      if (sameEmailProfileNames.has(starting.profileName)) {
        count++;
      }
    }

    for (const rr of this.reviewerRuns.values()) {
      seenRunIds.add(rr.runId);
      if (sameEmailProfileNames.has(rr.profileName)) {
        count++;
      }
    }

    for (const run of this.runRepo.getRunning()) {
      if (!seenRunIds.has(run.id)) {
        seenRunIds.add(run.id);
        if (sameEmailProfileNames.has(run.profileName)) {
          count++;
        }
      }
    }

    return count;
  }

  private getQuotaRemainingPct(profile: ProfileRow, family: string): number {
    if (this.usageService) {
      const remaining = this.usageService.bestRemaining(profile, family);
      if (remaining !== null && remaining !== undefined) {
        return remaining;
      }
    }
    if (this.db) {
      if (profile.engine === 'agy') {
        const group = family === 'gemini' ? 'Gemini Models' : (family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null);
        if (group) {
          const names = profile.email
            ? this.profileRepo.getAll().filter((p) => sameAccount(p, profile)).map((p) => p.name)
            : [profile.name];
          if (names.length > 0) {
            const placeholders = names.map(() => '?').join(',');
            try {
              const row = this.db.prepare(
                `SELECT MAX(remainingPct) as best FROM quota_usage WHERE profileName IN (${placeholders}) AND grp = ? AND window = '5h'`
              ).get(...names, group) as { best: number | null } | undefined;
              if (row?.best != null) {
                return row.best;
              }
            } catch {
              // ignore
            }
          }
        }
      }
    }
    return 50;
  }

  /** Task chờ slot/tài khoản/phụ thuộc/tải vẫn ở `queued`; chỉ ghi DB và phát sự kiện khi lý do chờ đổi. */
  private markQueuedWaiting(task: TaskRow, reason: 'parallel' | 'department_parallel' | 'profile_busy' | 'slot' | 'load' | 'dependency'): void {
    if (task.status === 'queued' && task.waitReason === reason) return;
    this.taskRepo.update(task.id, { status: 'queued', waitReason: reason });
    const project = this.projectRepo.get(task.projectId);
    const department = project?.departmentId ? this.departmentRepo?.get(project.departmentId) : undefined;
    this.eventBus.emit('task.queued', task.id, { reason, departmentName: reason === 'department_parallel' ? department?.name : undefined });
  }

  private markTaskWaitingForProject(task: TaskRow, project: { id: string; path: string }): void {
    this.tasksWaitingForProject.add(task.id);
    this.taskRepo.updateStatus(task.id, 'waiting_quota', 'project_unavailable');
    this.eventBus.emit('task.waiting_quota', task.id, {
      reason: 'project_unavailable',
      projectId: project.id,
      path: project.path,
    });
    if (!this.unavailableProjects.has(project.id)) {
      this.unavailableProjects.add(project.id);
      this.eventBus.emit('project.unavailable', undefined, {
        projectId: project.id,
        path: project.path,
      });
    }
  }

  private findModelProfilePair(
    task: TaskRow,
  ): { model: string; profileName: string } | null {
    const chain = this.getModelChain(task);
    const departmentId = this.departmentIdForTask(task);

    for (const model of chain) {
      const family = getModelFamily(model);
      const engineId = getModelEngine(model);

      // Find suitable profiles
      const profiles = this.profileRepo.getEnabled().filter((p) =>
        (!p.authState || p.authState === 'ok') && this.profileAllowedForDepartment(p.name, departmentId));
      const eligibleProfiles = profiles.filter((profile) => {
        if (profile.engine !== engineId) return false;
        if (this.quotaService.isExhausted(profile.name, family)) return false;
        if (this.isProfileBusy(profile.name)) return false;
        if (this.isProfileCooling(profile)) return false;
        if (this.locks.getSlotsSync(profile).busy) return false;
        return true;
      });

      if (eligibleProfiles.length === 0) continue;

      const ranked = eligibleProfiles.map((profile, originalIndex) => ({
        profile,
        originalIndex,
        priority: profile.priority ?? 0,
        emailRuns: this.getEmailRunningCount(profile),
        quotaRemaining: this.getQuotaRemainingPct(profile, family),
        departmentLoad: this.profileDepartmentLoad(profile.name, departmentId) / this.profileShare(profile.name, departmentId),
      }));

      ranked.sort((a, b) => {
        if (a.departmentLoad !== b.departmentLoad) {
          return a.departmentLoad - b.departmentLoad;
        }
        if (a.emailRuns !== b.emailRuns) {
          return a.emailRuns - b.emailRuns;
        }
        if (a.quotaRemaining !== b.quotaRemaining) {
          return b.quotaRemaining - a.quotaRemaining;
        }
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.originalIndex - b.originalIndex;
      });

      return { model, profileName: ranked[0].profile.name };
    }

    return null;
  }

  private hasBusyMatchingProfile(task: TaskRow): boolean {
    const departmentId = this.departmentIdForTask(task);
    for (const model of this.getModelChain(task)) {
      const engineId = getModelEngine(model);
      const family = getModelFamily(model);
      for (const profile of this.profileRepo.getEnabled()) {
        if (profile.authState && profile.authState !== 'ok') continue;
        if (
          profile.engine === engineId &&
          this.profileAllowedForDepartment(profile.name, departmentId) &&
          !this.quotaService.isExhausted(profile.name, family) &&
          (this.isProfileBusy(profile.name) || this.locks.getSlotsSync(profile).busy)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private allMatchingProfilesNeedLogin(task: TaskRow): boolean {
    let matching = 0;
    let unavailable = 0;
    for (const model of this.getModelChain(task)) {
      const engineId = getModelEngine(model);
      for (const profile of this.profileRepo.getEnabled()) {
        if (profile.engine !== engineId) continue;
        if (!this.profileAllowedForDepartment(profile.name, this.departmentIdForTask(task))) continue;
        matching += 1;
        if (profile.authState != null && profile.authState !== 'ok') unavailable += 1;
      }
    }
    return matching > 0 && matching === unavailable;
  }

  private getProfileWaitReason(task: TaskRow): 'no_department_profile' | 'no_matching_profile' | 'quota' {
    const departmentId = this.departmentIdForTask(task);
    const profiles = this.profileRepo.getEnabled();
    const allowed = profiles.filter((profile) => this.profileAllowedForDepartment(profile.name, departmentId));
    if (allowed.length === 0) return 'no_department_profile';
    const hasMatchingEngine = this.getModelChain(task).some((model) => {
      const engine = getModelEngine(model);
      return allowed.some((profile) => profile.engine === engine);
    });
    return hasMatchingEngine ? 'quota' : 'no_matching_profile';
  }

  private markProfileAuthExpired(profileName: string): void {
    const profile = this.profileRepo.get(profileName);
    if (!profile) return;
    const related = profile.email
      ? this.profileRepo.getAll().filter((candidate) => sameAccount(candidate, profile))
      : [profile];
    for (const candidate of related) {
      this.profileRepo.updateAuthState(candidate.name, 'not_logged_in', 'Phiên đăng nhập hết hạn (401) – cần đăng nhập lại', null);
      this.eventBus.emit('profile.auth_expired', undefined, { name: candidate.name, email: candidate.email });
    }
  }

  private getModelChain(task: TaskRow): string[] {
    const chain = task.modelChain
      ? JSON.parse(task.modelChain) as string[]
      : task.level === 'hard'
      ? this.config.defaultModelChains.hard
      : this.config.defaultModelChains.easy;
    return chain.filter((model) => {
      if (isKnownModel(model)) return true;
      const key = `${task.id}:${model}`;
      if (!this.notifiedSkippedModels.has(key)) {
        this.notifiedSkippedModels.add(key);
        this.eventBus.emit('task.model_skipped', task.id, {
          model,
          engine: getModelEngine(model) || null,
          message: `Bỏ qua model không thuộc engine đã cấu hình: ${model}`,
        });
      }
      return false;
    });
  }

  private getDependencyContext(task: TaskRow): DependencyContext[] {
    let dependencyIds: string[];
    try {
      dependencyIds = JSON.parse(task.dependsOn || '[]') as string[];
    } catch {
      dependencyIds = [];
    }

    return dependencyIds.flatMap((dependencyId) => {
      const dependency = this.taskRepo.get(dependencyId);
      if (!dependency) return [];

      const donePath = dependency.worktreePath
        ? path.join(dependency.worktreePath, '.agenthub', 'DONE')
        : null;
      const doneContent = dependency.doneReport ?? (donePath && fs.existsSync(donePath)
        ? fs.readFileSync(donePath, 'utf-8')
        : undefined);
      const reviews = this.reviewRepo?.getByTask(dependency.id) || [];
      const lastReview = reviews[reviews.length - 1];
      const review = lastReview?.verdict === 'approved'
        ? `approved${lastReview.feedback ? ` — ${lastReview.feedback}` : ''}`
        : undefined;

      const isCrossProject = dependency.projectId !== task.projectId;
      const depProject = this.projectRepo.get(dependency.projectId);

      return [{
        id: dependency.id,
        title: dependency.title,
        projectId: dependency.projectId,
        projectName: depProject?.name,
        repoPath: depProject?.path,
        isCrossProject,
        doneContent,
        review,
        diffStat: dependency.diffStat ?? undefined,
      }];
    });
  }

  private writeTaskFiles(task: TaskRow, body: string, resume: boolean, feedback?: string): void {
    if (!task.worktreePath) return;
    const project = this.projectRepo.get(task.projectId);
    const settings = project ? projectSettings(project) : undefined;
    this.worktreeService.writeTaskFile(
      task.worktreePath,
      body,
      resume,
      feedback,
      this.getDependencyContext(task),
      this.config.context?.depsMaxChars,
      this.knowledgeRepo?.getByProject(task.projectId) || [],
      this.config.context?.knowledgeMaxChars,
      settings?.references || [],
      project?.path,
      settings?.reviewChecklist || [],
    );
    const ticketContext = path.join(task.worktreePath, '.agenthub', 'context', 'ticket');
    if (task.externalRef && this.trackerRepo) {
      const item = this.trackerRepo.listAll().find((row) => row.display_id === task.externalRef);
      if (item) {
        const sourceDir = path.join(this.config.hubHome, 'tracker', item.source_id, String(item.wp_id));
        if (fs.existsSync(sourceDir)) {
          fs.rmSync(ticketContext, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(ticketContext), { recursive: true });
          fs.cpSync(sourceDir, ticketContext, { recursive: true });
        }
      }
    }
  }

  private isProfileBusy(profileName: string): boolean {
    const profile = this.profileRepo.get(profileName);
    if (!profile) return true;
    const running = Array.from(this.running.values()).filter((r) => r.profileName === profileName).length;
    const starting = Array.from(this.starting.values()).filter((task) => task.profileName === profileName).length;
    return running + starting >= this.locks.slotsTotal(profile) || this.locks.getSlotsSync(profile).busy;
  }

  private startSkipLogged = new Map<string, string>();

  /** startTask bails out without changing the task in a few cases; say why once, or a queue looks frozen. */
  private logStartSkipped(task: TaskRow, reason: string): void {
    if (this.startSkipLogged.get(task.id) === reason) return;
    this.startSkipLogged.set(task.id, reason);
    console.warn(`[scheduler] ${task.id} not started: ${reason}`);
  }

  async startTask(task: TaskRow, model: string, profileName: string, retryCount = 0): Promise<void> {
    const stopGeneration = this.stopGeneration;
    const disk = this.getBlockingDiskForTask(task);
    if (disk) {
      this.tasksWaitingForDisk.add(task.id);
      this.taskRepo.updateStatus(task.id, 'waiting_quota', 'disk');
      this.eventBus.emit('task.waiting_quota', task.id, { reason: 'disk', label: disk.label, path: disk.path, freeGB: disk.freeGB, minFreeGB: disk.minFreeGB, message: this.diskWaitMessage(disk) });
      this.markDiskLow(disk);
      return;
    }

    const profile = this.profileRepo.get(profileName);
    if (!profile) return this.logStartSkipped(task, `profile ${profileName} missing`);
    const lockSlot = this.locks.findFreeSlotSync(profile);
    if (lockSlot == null) return this.logStartSkipped(task, `no free lock slot on ${profileName}`);
    const lockFile = this.locks.lockPath(profile, lockSlot);
    this.locks.reserve(profile.name, lockFile);

    const project = this.projectRepo.get(task.projectId);
    if (!project) {
      this.locks.release(profile.name, lockFile);
      return;
    }

    const projectAccessible = isProjectAccessible(project.path);
    const worktreeRootAccessible = isProjectWorktreeRootAccessible({
      id: project.id,
      path: project.path,
      settings: project.settings,
    });
    const worktreeAccessible = !task.worktreePath || fs.existsSync(task.worktreePath);
    if (!projectAccessible || !worktreeRootAccessible || !worktreeAccessible) {
      this.locks.release(profile.name, lockFile);
      this.markTaskWaitingForProject(task, project);
      return;
    }

    const engineId = getModelEngine(model);
    const engine = this.engines.get(engineId);
    if (!engine) {
      this.locks.release(profile.name, lockFile);
      return this.logStartSkipped(task, `engine ${engineId} not available`);
    }

    this.starting.set(task.id, { projectId: task.projectId, profileName });

    const settings = projectSettings(project);
    let installResult: NodeModulesPreparationResult = 'prepared';

    // Create worktree if needed
    let worktreePath = task.worktreePath;
    if (!worktreePath) {
      let slot: number;
      try {
        slot = this.worktreeService.allocateSlot(task.projectId, this.taskRepo.getUsedSlots(task.projectId));
      } catch (error) {
        // All slots are occupied; leave the task queued for a later tick.
        this.locks.release(profile.name, lockFile);
        return this.logStartSkipped(task, error instanceof Error ? error.message : String(error));
      }
      const branch = task.branch || renderTaskBranch(project, task);
      if (settings.integration?.enabled) {
        try {
          ensureIntegrationWorktree(project, this.config.hubHome);
          if (settings.worktree.install === 'auto') {
            void ensureIntegrationNodeModules(project, this.config.hubHome, {
              cacheDir: this.config.cacheDir,
              cacheMaxEntries: this.config.cacheMaxEntries,
              cacheMaxGB: this.config.cacheMaxGB,
            }).catch((err) => {
              console.warn(`[scheduler] Failed to prepare integration worktree node_modules:`, err);
            });
          }
        } catch (e) {
          this.locks.release(profile.name, lockFile);
          if (!isProjectAccessible(project.path) || !isProjectWorktreeRootAccessible({ id: project.id, path: project.path, settings: project.settings })) {
            this.markTaskWaitingForProject(task, project);
            return;
          }
          this.taskRepo.updateStatus(task.id, 'failed');
          this.eventBus.emit('task.failed', task.id, { error: String(e) });
          return;
        }
      }
      const baseRef = this.resolveBaseRef(task, project);
      try {
        worktreePath = this.worktreeService.create({
          projectPath: project.path,
          projectId: project.id,
          projectSettings: project.settings,
          slug: task.slug,
          branch,
          baseRef,
        });
      } catch (e) {
        this.locks.release(profile.name, lockFile);
        if (!isProjectAccessible(project.path) || !isProjectWorktreeRootAccessible({ id: project.id, path: project.path, settings: project.settings })) {
          this.markTaskWaitingForProject(task, project);
          return;
        }
        this.taskRepo.updateStatus(task.id, 'failed');
        this.eventBus.emit('task.failed', task.id, { error: String(e) });
        return;
      }

      this.taskRepo.update(task.id, {
        worktreePath,
        branch,
        slot,
        status: 'running',
      });
      task.slot = slot;

      // Dependency installation can take minutes. Keep the task out of the
      // queue while it runs, but never let a cache/native-module failure stop
      // the worker from starting with its own install.
      if (settings.worktree.install === 'auto') {
        const hasDependencyLock = (dir: string): boolean =>
          fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'pnpm-lock.yaml'));
        if (hasDependencyLock(worktreePath) || hasDependencyLock(path.join(worktreePath, 'web'))) {
          try {
            await ensureWorktreeNodeModules(worktreePath, project.path, this.config.cacheDir, undefined, {
              maxEntries: this.config.cacheMaxEntries,
              maxBytes: this.config.cacheMaxGB * 1024 ** 3,
            });
            installResult = 'prepared';
          } catch (error) {
            installResult = 'failed';
            this.eventBus.emit('worktree.install_failed', task.id, {
              error: `Failed to prepare node_modules before worker start: ${String(error)}`,
            });
            if (this.taskNoteRepo) {
              try {
                this.taskNoteRepo.insert({
                  projectId: project.id,
                  taskId: task.id,
                  kind: 'note',
                  content: `Lỗi cài phụ thuộc: ${String(error)}`,
                });
              } catch {
                // ignore
              }
            }
          }
        } else {
          installResult = 'no_lockfile';
        }
      }

      // Generate env file if needed
      if (project.envTemplate) {
        try {
          const tmpl = JSON.parse(project.envTemplate);
          this.worktreeService.generateEnvFile(worktreePath, tmpl, slot, task.slug);
        } catch (e) {
          this.locks.release(profile.name, lockFile);
          this.taskRepo.update(task.id, { status: 'failed' });
          this.eventBus.emit('task.failed', task.id, { error: String(e) });
          return;
        }
      }

    } else {
      if (settings.worktree.install === 'auto') {
        const hasDependencyLock = (dir: string): boolean =>
          fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'pnpm-lock.yaml'));
        if (hasDependencyLock(worktreePath) || hasDependencyLock(path.join(worktreePath, 'web'))) {
          const hasNm = fs.existsSync(path.join(worktreePath, 'node_modules')) || fs.existsSync(path.join(worktreePath, 'web', 'node_modules'));
          installResult = hasNm ? 'prepared' : 'failed';
        } else {
          installResult = 'no_lockfile';
        }
      }
    }

    if (task.slot == null) {
      try {
        const slot = this.worktreeService.allocateSlot(task.projectId, this.taskRepo.getUsedSlots(task.projectId));
        this.taskRepo.update(task.id, { slot });
      } catch {
        this.locks.release(profile.name, lockFile);
        return;
      }
    }

    // Write task.md
    let prompt = buildProtocolPrompt(settings, installResult);
    const convention = projectSettings(project).commitConvention;
    const ref = taskCommitRef(project, task);
    const branchExample = renderTaskBranch(project, task);
    prompt += buildCommitConventionPrompt(convention, branchExample, ref, task.baseRef || project.defaultBranch);
    const openproject = projectSettings(project).openproject;
    const hasOpenProject = Boolean(openproject.enabled || task.externalRef);
    if (hasOpenProject) {
      const ticketSource = this.config.integrations.openproject.sources.find((source) => source.id === openproject.sourceId);
      const trackerItem = this.trackerRepo
        ? (task.externalRef ? this.trackerRepo.listAll().find((row) => row.display_id === task.externalRef) : this.trackerRepo.listForTask(task.id)[0])
        : undefined;
      const isBug = isBugTask(task, trackerItem);
      prompt += buildTicketWorkflowPrompt({
        externalRef: task.externalRef,
        sourceId: ticketSource?.id || openproject.sourceId,
        source: ticketSource,
        defaultRef: convention.defaultRef,
        isBug,
      });
    }
    if (task.resume) {
      prompt += '\n\nTask đã làm dở – kiểm tra git log/status rồi làm tiếp, không làm lại.';
    }

    // A retry reuses the worktree. Remove any marker left by an earlier run
    // before the new worker gets a chance to finish.
    this.clearWorkerMarkers(worktreePath);
    this.writeTaskFiles({ ...task, worktreePath }, task.body || task.title, !!task.resume);

    // Create run record
    const runId = crypto.randomUUID();
    const logDir = this.taskLogDir(task);
    const logPath = path.join(logDir, `${runId}.log`);

    let usageBefore: number | null = null;
    if (engineId === 'agy' && this.usageService) {
      const family = getModelFamily(model);
      const grp = family === 'gemini' ? 'Gemini Models' : (family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null);
      if (grp) {
        const usages = this.usageService.getForProfile(profileName);
        const u5h = usages.find((u) => u.window === '5h' && u.grp === grp);
        if (u5h) usageBefore = u5h.remainingPct;
      }
    }

    // stop() may have run while this start was awaiting (e.g. node_modules setup). Spawning now would
    // leave a detached worker nobody tracks or kills.
    if (this.stopGeneration !== stopGeneration) {
      this.starting.delete(task.id);
      this.locks.release(profile.name, lockFile);
      return;
    }

    this.runRepo.insert({
      id: runId,
      taskId: task.id,
      engine: engineId,
      model,
      profileName,
      logPath,
      lockFile,
    });
    this.taskRepo.update(task.id, { runCount: (task.runCount || 0) + 1, status: 'running' });

    // Spawn the engine
    const referenceSnapshots = takeReferenceSnapshots(projectSettings(project).references);
    try {
      const child = engine.spawn({
        profile,
        model,
        cwd: worktreePath,
        prompt,
        logPath,
        lockFile,
        env: { AGENTHUB_TASK_ID: task.id },
        hubHome: this.config.hubHome,
        project,
        gitHooks: projectSettings(project).worktree.gitHooks,
        codexSandbox: this.config.workers?.codexSandbox || 'off',
        workerCount: project.maxParallel,
      });

      const pid = child.pid!;
      const pidStart = this.getProcessStartTime(pid);
      this.runRepo.updatePid(runId, pid, pidStart);

      // Update task status
      this.taskRepo.update(task.id, { status: 'running' });

      if (this.bulletinService) {
        this.bulletinService.updateBulletinForTask({ ...task, status: 'running', worktreePath });
      }

      // Track the running task
      const rt: RunningTask = {
        runId,
        taskId: task.id,
        pid,
        pidStart,
        profileName,
        model,
        engine,
        child,
        exitCode: child.exitCode ?? null,
        lockFile,
        lockSlot,
        startTime: Date.now(),
        timeoutMs: this.config.defaultTimeout * 1000,
        timeoutAt: Date.now() + this.config.defaultTimeout * 1000,
        retryCount,
        projectId: task.projectId,
        referenceSnapshots,
        lastOutputAt: Date.now(),
        lastActivityAt: Date.now(),
        activitySource: 'log',
        activityCheckedAt: 0,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore,
        lastCommitCheckAt: Date.now(),
        lastCommitCount: 0,
        lastNoCommitThresholdEmitted: 0,
        commandOccurrences: [],
        lastLogOffset: 0,
        rss: 0,
        cpu: 0,
        paused: false,
        pauseReason: null,
        pausedAt: null,
      };
      this.running.set(task.id, rt);
      this.measureTaskResources(rt);
      this.starting.delete(task.id);
      this.locks.invalidate(profileName);

      // Unref so the child doesn't prevent daemon from exiting
      child.unref();

      const runNumber = this.runRepo.getByTask(task.id).length;
      this.eventBus.emit('task.running', task.id, { runId, model, profile: profileName, engine: engine.id, runNumber });

      // Listen for exit
      child.on('exit', (code) => {
        rt.exitCode = code;
        if (this.stopped) return;
        // Trigger immediate check
        setTimeout(() => {
          if (!this.stopped) void this.checkRunningTasks().catch(() => {});
        }, 500);
      });
    } catch (e) {
      this.locks.release(profile.name, lockFile);
      this.runRepo.finish(runId, 'crashed');
      this.taskRepo.updateStatus(task.id, 'failed');
      this.eventBus.emit('task.failed', task.id, { error: String(e) });
    }
  }

  private resolveBaseRef(task: TaskRow, project: { defaultBranch: string; settings?: string | null }): string {
    if (task.baseRef) return task.baseRef;

    // Only inherit branch from the nearest dependency in the SAME project
    let deps: string[] = [];
    try {
      deps = JSON.parse(task.dependsOn || '[]');
    } catch {
      deps = [];
    }
    for (let i = deps.length - 1; i >= 0; i--) {
      const dep = this.taskRepo.get(deps[i]);
      if (dep && dep.projectId === task.projectId && dep.branch) {
        return dep.branch;
      }
    }

    const settings = projectSettings(project);
    if (settings.integration?.enabled) {
      return settings.integration.branch || 'agenthub/integration';
    }

    return project.defaultBranch;
  }

  /**
   * Cancel a running or pending/idle task
   */
  cancelTask(taskId: string, info?: CancelInfo): void {
    const rt = this.running.get(taskId);
    if (rt) {
      this.pendingCancel.set(taskId, info || {});
      this.killTask(taskId, 'cancelled');
    } else {
      const task = this.taskRepo.get(taskId);
      if (task?.status === 'done' || task?.status === 'pushed' || task?.status === 'cancelled') return;

      const reviewerRun = this.reviewerRuns.get(taskId);
      if (reviewerRun) {
        clearTimeout(reviewerRun.timeout);
        if (reviewerRun.exitTimeout) clearTimeout(reviewerRun.exitTimeout);
        if (reviewerRun.pid) {
          try {
            process.kill(-reviewerRun.pid, 'SIGKILL');
          } catch {
            try {
              process.kill(reviewerRun.pid, 'SIGKILL');
            } catch {
              // ignore
            }
          }
        }
        if (reviewerRun.lockFile) {
          this.locks.release(reviewerRun.profileName, reviewerRun.lockFile);
        }
        this.locks.invalidate(reviewerRun.profileName);
        this.reviewerRuns.delete(taskId);
      }
      this.reviewNotified.delete(taskId);
      this.reviewWaitingNotified.delete(taskId);
      this.reviewerFallbackNotified.delete(taskId);
      this.reviewerErrorCounts.delete(taskId);
      this.resetReviewerEscalation(taskId);
      const recorded = this.recordCancel(taskId, info);
      this.eventBus.emit('task.cancelled', taskId, { reason: recorded.reason, by: recorded.by, previousStatus: task?.status ?? null });
    }
  }

  /**
   * Review a task
   */
  reviewTask(
    taskId: string,
    verdict: 'approved' | 'changes_requested',
    feedback?: string,
    by?: string,
    source: ReviewSource = 'content',
    options?: { engine?: string | null; profileName?: string | null },
  ): void {
    const task = this.taskRepo.get(taskId);
    if (!task || task.status !== 'review') return;
    this.reviewNotified.delete(taskId);
    const chain = this.reviewChainForTask(task);
    const step = chain[task.reviewStep ?? 0];

    const fallbackEngine = by === 'claude-reviewer' || by === 'claude-review' ? 'claude' : by === 'codex-reviewer' ? 'codex' : null;
    const reviewEngine = options?.engine ?? fallbackEngine;
    const reviewProfile = options?.profileName ?? null;

    if (verdict === 'approved') {
      if (isAutoReviewer(by) && (!feedback || feedback.trim() === '')) return;
      if ((isAutoReviewer(by) || by === 'claude-review') && this.reviewRepo) {
        this.reviewRepo.insert({
          id: crypto.randomUUID(),
          taskId,
          verdict,
          feedback: feedback || null,
          actor: by || 'reviewer',
          engine: reviewEngine,
          profileName: reviewProfile,
        });
      }
      if ((isAutoReviewer(by) || by === 'claude-review') && isAutomatedStep(step)) {
        this.advanceReviewStep(task, chain, 'approved');
        return;
      }
      if (isAutoReviewer(by) && chain.length === 0) {
        const project = this.projectRepo.get(task.projectId);
        const settings = project ? projectSettings(project) : null;
        const checks = this.getCheckResults(task.id);
        if ((settings?.review.autoMerge || settings?.integration.autoMerge) && checks.length > 0 && checks.every((check) => check.ok)) {
          this.eventBus.emit('task.review_ready', task.id, { reviewChainComplete: true, reason: 'review_approved' });
          return;
        }
      }
      if (!isAutoReviewer(by)) this.resetReviewerEscalation(taskId);
      this.taskRepo.updateStatus(taskId, 'done');
      if (this.runMetricsRepo) {
        recalculateTaskLines(
          this.taskRepo,
          this.projectRepo,
          this.runRepo,
          this.runMetricsRepo,
          taskId,
        ).catch(() => {});
      }
      this.eventBus.emit('task.done', taskId, by ? { by, verdict } : undefined);
    } else {
      if (!feedback || feedback.trim() === '') {
        throw new Error('Feedback is required when requesting changes');
      }
      if ((isAutoReviewer(by) || by === 'claude-review') && this.reviewRepo) {
        this.reviewRepo.insert({
          id: crypto.randomUUID(),
          taskId,
          verdict,
          feedback,
          actor: by || 'reviewer',
          engine: reviewEngine,
          profileName: reviewProfile,
        });
      }
      if (isContentReview(by, source)) {
        const count = (task.reviewerChangesRequested || 0) + 1;
        const max = reviewMaxRoundsFor(this.projectRepo.get(task.projectId), this.config);
        if (count > max) {
          this.escalateReview(taskId, 'reviewer_changes_limit', feedback, by);
          return;
        }
        this.taskRepo.update(taskId, { reviewerChangesRequested: count });
      } else {
        // A non-automated return may be a merge conflict or another operational
        // issue. It must not erase the durable content-review count.
        this.resetReviewerEscalation(taskId);
      }
      // Append feedback to task body
      if (task.worktreePath) {
        const newBody = (task.body || '') + '\n\n## Feedback review\n\n' + feedback;
        this.taskRepo.update(taskId, {
          body: newBody,
          status: 'queued',
          resume: 1,
          reviewStep: 0,
        });

        // Remove markers from the previous worker attempt.
        this.clearWorkerMarkers(task.worktreePath);

        // Re-write task.md with feedback
        this.writeTaskFiles(task, newBody, true, feedback);
      } else {
        this.taskRepo.update(taskId, { status: 'queued', resume: 1 });
      }
      this.eventBus.emit(
        'task.queued',
        taskId,
        by ? { reason: 'changes_requested', by, verdict } : { reason: 'changes_requested' },
      );
    }
  }

  private resetReviewerEscalation(taskId: string): void {
    this.taskRepo.update(taskId, {
      reviewerEscalated: 0,
      reviewerEscalatedAt: null,
      reviewerEscalationReason: null,
    });
  }

  private killTask(taskId: string, outcome: string): void {
    const rt = this.running.get(taskId);
    if (!rt) return;

    this.killProcessGroup(rt.pid);
    const task = this.taskRepo.get(taskId);
    if (task?.worktreePath) {
      const project = this.projectRepo.get(task.projectId);
      reapSyncForWorktree(task.worktreePath, { worktreesDir: project ? projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir) : this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
    }

    this.running.delete(taskId);
    if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
    this.locks.invalidate(rt.profileName);
    this.runRepo.finish(rt.runId, outcome);

    const durationMs = Date.now() - rt.startTime;
    if (this.runMetricsRepo) {
      this.runMetricsRepo.upsert({
        runId: rt.runId,
        taskId,
        engine: rt.engine.id,
        model: rt.model,
        profileName: rt.profileName,
        tokensUsed: null,
        usageBefore: rt.usageBefore,
        usageAfter: null,
        linesAdded: 0,
        linesDeleted: 0,
        filesChanged: 0,
        durationMs,
      });
    }

    if (outcome === 'cancelled') {
      const info = this.pendingCancel.get(taskId);
      this.pendingCancel.delete(taskId);
      const recorded = this.recordCancel(taskId, info);
      this.eventBus.emit('task.cancelled', taskId, { reason: recorded.reason, by: recorded.by, previousStatus: 'running' });
    } else if (outcome === 'timeout') {
      this.taskRepo.updateStatus(taskId, 'failed');
      this.eventBus.emit('task.timeout', taskId);
    }
    if (!this.stopped) this.triggerTick();
  }

  private killProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
    if (pid === process.pid) return;
    try {
      // A paused (SIGSTOP) group cannot act on SIGTERM until it is continued.
      process.kill(-pid, 'SIGCONT');
    } catch {
      try { process.kill(pid, 'SIGCONT'); } catch { /* ignore */ }
    }
    try {
      process.kill(-pid, signal);
    } catch {
      if (this.isProcessAlive(pid)) {
        try { process.kill(pid, signal); } catch { /* already dead */ }
      }
    }
    if (signal === 'SIGTERM') {
      const timer = setTimeout(() => this.killProcessGroup(pid), 10_000);
      timer.unref();
    }
  }

  private getProcessStartTime(pid: number): number | null {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return Number(afterComm[19]) || null;
    } catch {
      return null;
    }
  }

  private isProcessAlive(pid: number | null, expectedStart?: number | null): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      if (expectedStart != null) {
        return this.getProcessStartTime(pid) === expectedStart;
      }
      return true;
    } catch {
      return false;
    }
  }

  getDiskReader(): (p: string) => DiskSpace {
    return this.diskReader;
  }

  private getTaskDiskPath(task: TaskRow): string {
    const project = this.projectRepo.get(task.projectId);
    return project ? projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir) : this.config.worktreesDir;
  }

  private getDiskIncidentKey(diskPath: string): string {
    const resolved = path.resolve(diskPath);
    const worktreesResolved = path.resolve(this.config.worktreesDir);
    if (resolved === worktreesResolved || resolved.startsWith(worktreesResolved + path.sep)) {
      return worktreesResolved;
    }
    return resolved;
  }

  private getHubHomeDisk(): MonitoredDisk {
    const space = this.diskReader(this.config.hubHome);
    const minFreeGB = this.config.disk.hubHomeMinFreeGB ?? 1;
    return {
      path: this.config.hubHome,
      label: 'Ổ chứa dữ liệu hub (~/.agenthub)',
      minFreeGB,
      source: 'hub_home',
      ...space,
      low: space.freeGB < minFreeGB,
    };
  }

  private getMonitoredDisks(): MonitoredDisk[] {
    const roots = [this.config.worktreesDir, ...this.projectRepo.getAll().flatMap((project) => projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir))];
    const disks = getMonitoredDisks(roots, this.config.disk.minFreeGB, this.config.disk.extraPaths, process.env.NODE_ENV !== 'test', this.diskReader);
    return [this.getHubHomeDisk(), ...disks];
  }

  private getBlockingDisk(): MonitoredDisk | undefined {
    return this.getMonitoredDisks().find((disk) => disk.low);
  }

  getBlockingDiskForTask(task: TaskRow): MonitoredDisk | undefined {
    // 1. Hub home check: blocks all tasks if low
    const hubHome = this.getHubHomeDisk();
    if (hubHome.low) return hubHome;

    // 2. Project's own worktree root check
    const project = this.projectRepo.get(task.projectId);
    const projectRoot = project ? projectWorktreeRoot(project, this.config.hubHome, this.config.worktreesDir) : this.config.worktreesDir;
    const projectSpace = this.diskReader(projectRoot);
    const projectMinFreeGB = this.config.disk.minFreeGB;
    if (projectSpace.freeGB < projectMinFreeGB) {
      return {
        path: projectRoot,
        label: 'Worktrees',
        minFreeGB: projectMinFreeGB,
        source: 'worktrees',
        ...projectSpace,
        low: true,
      };
    }

    // 3. Extra paths check (and Docker if included)
    const extraDisks = getMonitoredDisks([], projectMinFreeGB, this.config.disk.extraPaths, process.env.NODE_ENV !== 'test', this.diskReader);
    const blockedExtra = extraDisks.find((disk) => disk.source === 'extra' && disk.low);
    if (blockedExtra) return blockedExtra;

    return undefined;
  }

  private diskWaitMessage(disk: MonitoredDisk): string {
    if (disk.source === 'hub_home') {
      return `Ổ chứa dữ liệu hub (~/.agenthub) sắp đầy (${disk.path}) (còn ${disk.freeGB} GB / cần ${disk.minFreeGB} GB)`;
    }
    return `Chờ ${disk.label} (${disk.path}) (còn ${disk.freeGB} GB / cần ${disk.minFreeGB} GB)`;
  }

  private markDiskLow(disk: MonitoredDisk): void {
    const now = Date.now();
    const diskKey = this.getDiskIncidentKey(disk.path);
    const incident = this.diskIncidents.get(diskKey) || { lastLowEmit: 0, blockedEmitted: false };

    const waitingTasks = this.taskRepo.getByStatus('waiting_quota').filter((t) => {
      if (t.waitReason !== 'disk') return false;
      const blocking = this.getBlockingDiskForTask(t);
      if (!blocking) return false;
      if (disk.source === 'hub_home') return blocking.source === 'hub_home';
      return this.getDiskIncidentKey(blocking.path) === diskKey;
    });
    const isBlocking = disk.source === 'hub_home' || waitingTasks.length > 0;

    if (incident.lastLowEmit > 0) {
      if (isBlocking && !incident.blockedEmitted) {
        // Transition to blocking incident: must emit immediately
      } else if (now - incident.lastLowEmit < 60 * 60_000) {
        return;
      }
    }
    this.diskLow = true;
    incident.lastLowEmit = now;
    if (isBlocking) {
      incident.blockedEmitted = true;
      this.diskBlockedEmitted = true;
    }
    this.diskIncidents.set(diskKey, incident);
    this.lastDiskLowEmit = now;
    pruneNodeModulesCache(this.config.cacheDir, { maxEntries: this.config.cacheMaxEntries, maxBytes: this.config.cacheMaxGB * 1024 ** 3 });
    const cache = nodeModulesCacheSummary(this.config.cacheDir);
    this.eventBus.emit('disk.low', undefined, {
      label: disk.label,
      path: disk.path,
      freeGB: disk.freeGB,
      minFreeGB: disk.minFreeGB,
      source: disk.source,
      isBlocking,
      tasks: waitingTasks.map((t) => t.slug || t.title || t.id),
      cacheDir: cache.path,
      cacheEntries: cache.entries,
      cacheBytes: cache.bytes,
      largestCacheEntry: cache.largest,
      largestCacheEntryBytes: cache.largestBytes,
    });
  }

  private markDockerDiskLow(disk: MonitoredDisk): void {
    if (this.dockerDiskLow) return;
    this.dockerDiskLow = true;
    this.eventBus.emit('disk.docker_low', undefined, {
      label: disk.label,
      path: disk.path,
      freeGB: disk.freeGB,
      totalGB: disk.totalGB,
      minFreeGB: disk.minFreeGB,
    });
    const warning = 'KHÔNG chạy docker build/pull/compose up – ổ Docker sắp đầy';
    for (const running of this.running.values()) {
      const task = this.taskRepo.get(running.taskId);
      if (!task?.worktreePath) continue;
      const taskFile = path.join(task.worktreePath, '.agenthub', 'task.md');
      try {
        const current = fs.readFileSync(taskFile, 'utf8');
        if (!current.includes(warning)) fs.appendFileSync(taskFile, `\n\n⚠️ ${warning}\n`);
      } catch {
        // The task can finish while the warning is being written.
      }
    }
  }

  private onTaskDoneOrCancelled(taskId: string): void {
    this.invalidateChecks(taskId);
    this.reviewNotified.delete(taskId);
    const task = this.taskRepo.get(taskId);
    if (!task) return;
    cleanupTaskRunArtifacts(this.runRepo.getByTask(taskId).map((run) => run.logPath));
    if (this.config.cleanup?.nodeModulesOnDone && task.worktreePath) {
      this.worktreeService.cleanNodeModules(task.worktreePath);
    }
  }

  private invalidateChecks(taskId: string): void {
    const queued = this.checkingQueue.filter((entry) => entry.taskId === taskId);
    this.checkingQueue = this.checkingQueue.filter((entry) => entry.taskId !== taskId);
    for (const entry of queued) entry.resolve();
    // A running check is allowed to finish and release its worktree lock, but
    // its completion is stale and can no longer change task state.
    this.checkingRunIds.delete(taskId);
    this.checkingPromises.delete(taskId);
  }

  private cleanExpiredWorktrees(): void {
    const afterHours = this.config.cleanup?.worktreeOnDoneAfterHours ?? 24;
    const effectiveAfterHours = this.diskLow ? Math.min(afterHours > 0 ? afterHours : 2, 2) : afterHours;
    if (effectiveAfterHours <= 0) return;

    const thresholdMs = effectiveAfterHours * 60 * 60 * 1000;
    const now = Date.now();

    const completedTasks = this.taskRepo.getAll().filter((task) => task.status === 'done' || task.status === 'pushed' || task.status === 'cancelled');
    for (const task of completedTasks) {
      if (!task.worktreePath) continue;

      const updatedAt = parseDbTime(task.updatedAt);
      if (isNaN(updatedAt)) continue;

      if (now - updatedAt >= thresholdMs) {
        const retryAt = this.worktreeCleanupRetryAt.get(task.id) || 0;
        if (now < retryAt) continue;
        const project = this.projectRepo.get(task.projectId);
        let hooks = null;
        if (project?.hooks) {
          try {
            hooks = JSON.parse(project.hooks);
          } catch {
            // ignore
          }
        }
        if (fs.existsSync(task.worktreePath)) {
          let dirty = false;
          try {
            dirty = execFileSync('git', ['-C', task.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
          } catch {
            // A non-git directory is still eligible for a task-owned cleanup.
          }
          if (dirty) {
            if (!this.dirtyWorktreeLogged.has(task.id)) {
              this.dirtyWorktreeLogged.add(task.id);
              console.warn(`[worktree] Keeping ${task.worktreePath}: uncommitted changes for task ${task.id}`);
            }
            continue;
          }
          this.dirtyWorktreeLogged.delete(task.id);
        }

        let removed = !fs.existsSync(task.worktreePath);
        let removalError: unknown;
        try {
          if (!removed) {
            // remove() refuses anything outside worktreesDir or overlapping a project root.
            removed = this.worktreeService.remove(project?.path ?? null, task.worktreePath, {
            slot: task.slot,
            slug: task.slug,
            projectId: task.projectId,
            taskId: task.id,
            hooks,
            }, project ? projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir) : this.config.worktreesDir);
          }
        } catch (error) {
          removed = false;
          removalError = error;
        }

        if (removed && !fs.existsSync(task.worktreePath)) {
          this.worktreeCleanupRetryAt.delete(task.id);
          this.worktreeCleanupLogged.delete(task.id);
          this.taskRepo.update(task.id, { worktreePath: null, slot: null });
          this.eventBus.emit('worktree.cleaned', task.id, { worktreePath: task.worktreePath });
        } else {
          this.worktreeCleanupRetryAt.set(task.id, now + 60 * 60 * 1000);
          if (!this.worktreeCleanupLogged.has(task.id)) {
            this.worktreeCleanupLogged.add(task.id);
            const reason = removalError instanceof Error ? `: ${removalError.message}` : '';
            console.warn(`[worktree] Failed to remove ${task.worktreePath} for task ${task.id}${reason}; will retry later`);
          }
        }
      }
    }
  }

  private scanOrphanWorktrees(): void {
    const root = path.resolve(this.config.worktreesDir);
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    const tasks = this.taskRepo.getAll();
    const referenced = new Set(tasks.filter((task) => task.worktreePath).map((task) => path.resolve(task.worktreePath!)));
    for (const projectDir of projects) {
      if (!projectDir.isDirectory()) continue;
      const project = this.projectRepo.get(projectDir.name);
      if (!project) continue;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(root, projectDir.name), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, projectDir.name, entry.name);
        if (referenced.has(path.resolve(candidate)) || !isDeletableWorktreePath(this.config.worktreesDir, candidate, [this.config.hubHome, project.path])) continue;
        const task = tasks.find((row) => row.projectId === project.id && row.slug === entry.name);
        if (task?.worktreePath) continue;
        if (task && task.status !== 'done' && task.status !== 'pushed' && task.status !== 'cancelled') continue;
        let isGitWorktree = false;
        try {
          const listed = execFileSync('git', ['-C', project.path, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
          isGitWorktree = listed.split(/\n(?=worktree )/).some((block) => block.split('\n')[0] === `worktree ${candidate}`);
        } catch {
          // Keep unknown repositories untouched.
        }
        if (!isGitWorktree) {
          console.warn(`[worktree] Keeping orphan ${candidate}: not a registered git worktree`);
          continue;
        }
        try {
          execFileSync('git', ['-C', project.path, 'worktree', 'remove', candidate], { timeout: 30000 });
          if (!fs.existsSync(candidate)) console.log(`[worktree] Removed orphan ${candidate}`);
        } catch (error) {
          console.warn(`[worktree] Failed to remove orphan ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  setTaskMerging(taskId: string, merging: boolean): void {
    if (merging) {
      this.mergingTasks.add(taskId);
    } else {
      this.mergingTasks.delete(taskId);
    }
  }

  isTaskMerging(taskId: string): boolean {
    return this.mergingTasks.has(taskId);
  }

  /**
   * Auto-closes tasks that have already been merged elsewhere into the project's target branch.
   * Targets blocked, review, or failed tasks that have at least one commit on their branch
   * and whose branch is an ancestor of the target branch (integration if enabled, otherwise defaultBranch).
   */
  async autoCloseMergedTasks(): Promise<number> {
    if (this.autoClosingMerged) return 0;
    this.autoClosingMerged = true;
    this.lastMergedTasksCheck = Date.now();
    let closedCount = 0;

    try {
      const candidates = [
        ...this.taskRepo.getByStatus('blocked'),
        ...this.taskRepo.getByStatus('review'),
        ...this.taskRepo.getByStatus('failed'),
      ];

      for (const task of candidates) {
        if (!task.branch) continue;
        // Do not touch tasks that are actively running, starting, queued, or checking
        if (task.status === 'running' || task.status === 'queued' || task.status === 'checking') continue;
        if (this.running.has(task.id) || this.starting.has(task.id) || this.checkingActive.has(task.id)) continue;

        // Skip tasks that currently have an active reviewer or merge running
        if (this.reviewerRuns.has(task.id) || this.mergingTasks.has(task.id)) continue;

        const now = Date.now();
        // Skip review tasks updated within the last 15 minutes to avoid race conditions with reviews/merges
        if (task.status === 'review') {
          const updatedAtMs = parseDbTime(task.updatedAt || task.createdAt);
          if (Number.isFinite(updatedAtMs) && now - updatedAtMs < 15 * 60 * 1000) {
            continue;
          }
        }

        // Skip failed tasks older than 30 days
        if (task.status === 'failed') {
          const taskTimeMs = parseDbTime(task.updatedAt || task.createdAt);
          if (Number.isFinite(taskTimeMs) && now - taskTimeMs > 30 * 24 * 60 * 60 * 1000) {
            continue;
          }
        }

        const project = this.projectRepo.get(task.projectId);
        if (!project || !fs.existsSync(project.path)) continue;

        const localBranch = task.branch.replace(/^refs\/heads\//, '');
        // 1. Check if branch exists in the project git repo
        try {
          await execFileAsync('git', ['-C', project.path, 'rev-parse', '--verify', `refs/heads/${localBranch}`], {
            timeout: 10_000,
          });
        } catch {
          continue;
        }

        // 2. Target branch: integration branch if enabled, otherwise default branch
        const settings = projectSettings(project);
        const targetBranch = settings.integration?.enabled
          ? (settings.integration.branch || 'agenthub/integration')
          : project.defaultBranch;

        // Check if task.branch is an ancestor of targetBranch (or defaultBranch if integration is enabled)
        let matchedTargetBranch: string | null = null;
        try {
          await execFileAsync('git', ['-C', project.path, 'merge-base', '--is-ancestor', `refs/heads/${localBranch}`, targetBranch], {
            timeout: 15_000,
          });
          matchedTargetBranch = targetBranch;
        } catch {
          if (settings.integration?.enabled && targetBranch !== project.defaultBranch) {
            try {
              await execFileAsync('git', ['-C', project.path, 'merge-base', '--is-ancestor', `refs/heads/${localBranch}`, project.defaultBranch], {
                timeout: 15_000,
              });
              matchedTargetBranch = project.defaultBranch;
            } catch {
              matchedTargetBranch = null;
            }
          }
        }

        if (!matchedTargetBranch) continue;

        // 3. Must have at least 1 commit compared to base lúc tạo.
        // If the branch was merged into matchedTargetBranch, find the merge commit bringing it in
        // and verify that the branch contributed at least 1 commit not present on the trunk prior to merge.
        let hasCommits = false;
        const branchesToCheck = [matchedTargetBranch];
        if (settings.integration?.enabled && matchedTargetBranch !== project.defaultBranch) {
          branchesToCheck.push(project.defaultBranch);
        }

        for (const branchToCheck of branchesToCheck) {
          try {
            const { stdout: mergesStr } = await execFileAsync(
              'git',
              ['-C', project.path, 'rev-list', '--merges', '--ancestry-path', `refs/heads/${localBranch}..${branchToCheck}`],
              { timeout: 15_000, encoding: 'utf8' },
            );

            const merges = mergesStr.trim() ? mergesStr.trim().split('\n').map((m) => m.trim()).filter(Boolean) : [];
            for (const mergeCommit of merges) {
              try {
                const { stdout: countStr } = await execFileAsync(
                  'git',
                  ['-C', project.path, 'rev-list', '--count', `${mergeCommit}^1..refs/heads/${localBranch}`],
                  { timeout: 15_000, encoding: 'utf8' },
                );
                const count = parseInt(countStr.trim(), 10);
                if (Number.isFinite(count) && count > 0) {
                  hasCommits = true;
                  break;
                }
              } catch {
                // ignore and check next merge
              }
            }
            if (hasCommits) break;
          } catch {
            // ignore
          }
        }

        if (!hasCommits) continue;

        // Clean up any reviewer runs/state if task was in review
        const reviewerRun = this.reviewerRuns.get(task.id);
        if (reviewerRun) {
          clearTimeout(reviewerRun.timeout);
          if (reviewerRun.exitTimeout) clearTimeout(reviewerRun.exitTimeout);
          if (reviewerRun.pid) {
            try {
              process.kill(-reviewerRun.pid, 'SIGKILL');
            } catch {
              try {
                process.kill(reviewerRun.pid, 'SIGKILL');
              } catch {
                // ignore
              }
            }
          }
          if (reviewerRun.lockFile) {
            this.locks.release(reviewerRun.profileName, reviewerRun.lockFile);
          }
          this.locks.invalidate(reviewerRun.profileName);
          this.reviewerRuns.delete(task.id);
        }
        this.reviewNotified.delete(task.id);
        this.reviewWaitingNotified.delete(task.id);
        this.reviewerFallbackNotified.delete(task.id);
        this.reviewerErrorCounts.delete(task.id);
        this.resetReviewerEscalation(task.id);

        // Transition to done
        this.taskRepo.updateStatus(task.id, 'done');
        if (this.runMetricsRepo) {
          recalculateTaskLines(
            this.taskRepo,
            this.projectRepo,
            this.runRepo,
            this.runMetricsRepo,
            task.id,
          ).catch(() => {});
        }

        this.eventBus.emit('task.auto_closed', task.id, {
          reason: 'merged_elsewhere',
          branch: task.branch,
          targetBranch: matchedTargetBranch,
        });
        this.eventBus.emit('task.done', task.id, {
          reason: 'merged_elsewhere',
          autoClosed: true,
        });

        closedCount++;
      }
    } finally {
      this.autoClosingMerged = false;
    }

    return closedCount;
  }
}
