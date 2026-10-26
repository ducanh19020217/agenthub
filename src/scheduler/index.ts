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
} from '../db/index.js';
import { projectSettings } from '../projects/settings.js';
import { renderCommitTemplate, renderTaskBranch } from '../commit-convention.js';
import { isProjectWorktreeRootAccessible, projectWorktreeRoot, projectWorktreeRoots } from '../projects/paths.js';
import { Engine, AgyEngine, CodexEngine } from '../engines/index.js';
import { getModelFamily, getModelEngine, isKnownModel, QuotaService } from '../quota/index.js';
import { DependencyContext, isDeletableWorktreePath, WorktreeService } from '../worktrees/index.js';
import { ensureWorktreeNodeModules, nodeModulesCacheSummary, pruneNodeModulesCache } from '../cache.js';
import { AgentHubConfig } from '../config.js';
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
import { buildReviewerPrompt, parseReviewerOutput, ReviewerVerdict } from '../reviewer.js';
import { CLAUDE_REVIEW_ENGINE_KEY } from '../engines/claude-review.js';
import { parseReviewChain, reviewerModel, type ReviewChainStep } from '../review-chain.js';
import { isOrphanProcess, listAllWorktreeProcesses, reap, reapSyncForWorktree } from '../reaper.js';
import { LoadGuard, LoadSnapshot } from '../load.js';
import { measureProcessTree } from '../process-tree.js';
import { ReferenceSnapshot, takeReferenceSnapshots, detectReferenceModifications, ReferenceModification } from '../references.js';
import { normalizeReviewerModel, reviewerSettingsFromLegacy, type ReviewerOrderItem, type ReviewerFallback } from '../reviewer-config.js';
import { cleanupTaskRunArtifacts } from '../temp-cleanup.js';

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
  pauseReason?: 'manual' | 'load' | 'focus' | null;
  pausedAt?: number | null;
  referenceSnapshots?: ReferenceSnapshot[];
}

interface StartingTask {
  projectId: string;
  profileName: string;
}

type ReviewerActor = 'codex-reviewer' | 'claude-reviewer';

/** Automated reviewers whose verdicts drive gates, round limits and auto-merge. */
function isAutoReviewer(by: string | undefined): by is ReviewerActor {
  return by === 'codex-reviewer' || by === 'claude-reviewer';
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

const STALL_NOTE = 'Lượt trước bị kẹt khi chờ tác vụ nền. Chạy lệnh trực tiếp với timeout.';

export interface SchedulerOptions {
  diskSpace?: (path: string) => DiskSpace;
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
  private skipSchedulingOnce = false;
  private diskLow = false;
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
    this.runMetricsRepo = runMetricsRepo;
    this.knowledgeRepo = knowledgeRepo;
    if (db) {
      this.checkRunner = new CheckRunner(db);
      this.taskNoteRepo = new TaskNoteRepo(db);
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
    this.eventBus.on('task.done', (taskId) => this.onTaskDoneOrCancelled(taskId));
    this.eventBus.on('task.cancelled', (taskId) => this.onTaskDoneOrCancelled(taskId));
    this.eventBus.on('task.queued', (taskId) => this.invalidateChecks(taskId));
  }

  getCheckResults(taskId: string) { return this.db ? getCheckResults(this.db, taskId) : []; }
  getDatabase(): Database.Database | undefined { return this.db; }

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

  getRestartSnapshot(projectId?: string): { checks: number; editing: number } {
    const editing = projectId
      ? [...this.running.values()].filter((running) => running.projectId === projectId).length
      : this.running.size;
    return { checks: this.checkingActive.size, editing };
  }

  getEventBus(): EventBus {
    return this.eventBus;
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

  pauseTask(taskId: string, reason: 'manual' | 'load' | 'focus' = 'manual'): boolean {
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
    this.recoverOnStartup();
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
      this.killTask(taskId, 'cancelled');
    }
  }

  /** Persist a resumable state before the service manager terminates the daemon. */
  shutdownForUser(): { queued: number; reviewers: number; childPids: number[] } {
    const childPids: number[] = [];
    let queued = 0;
    for (const rt of [...this.running.values()]) {
      if (rt.pid) childPids.push(rt.pid);
      this.killProcessGroup(rt.pid, 'SIGTERM');
      this.running.delete(rt.taskId);
      if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
      this.locks.invalidate(rt.profileName);
      this.runRepo.finish(rt.runId, 'crashed', undefined, 'user_stop');
      this.taskRepo.update(rt.taskId, { status: 'queued', resume: 1 });
      this.eventBus.emit('task.queued', rt.taskId, { reason: 'user_stop', note: 'dừng bởi người dùng' });
      queued++;
    }

    for (const entry of [...this.checkingActive.values(), ...this.checkingQueue]) {
      const task = this.taskRepo.get(entry.taskId);
      if (task && (task.status === 'checking' || task.status === 'running')) {
        this.taskRepo.update(entry.taskId, { status: 'queued', resume: 1 });
        this.eventBus.emit('task.queued', entry.taskId, { reason: 'user_stop', note: 'dừng bởi người dùng' });
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
      this.runRepo.finish(active.runId, 'crashed', undefined, 'user_stop');
      this.reviewerRuns.delete(active.taskId);
      reviewers++;
    }
    this.eventBus.emit('daemon.shutdown_requested', undefined, { queued, reviewers, note: 'dừng bởi người dùng' });
    return { queued, reviewers, childPids };
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
    for (const task of this.taskRepo.getByStatus('checking')) {
      if (!this.projectRepo.get(task.projectId)) continue;
      const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
      if (!lastWorker || lastWorker.outcome !== 'done') continue;
      void this.runChecksForTask(task.id, lastWorker.id).catch((error) => {
        if (!this.stopped) console.error(`[scheduler] re-check after restart failed for ${task.id}:`, error);
      });
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
        }
        continue;
      }
      if (!this.isProcessAlive(run.pid, run.pidStart)) {
        const task = this.taskRepo.get(run.taskId);
        if (!task || !this.projectRepo.get(task.projectId)) continue;
        if (this.recoverFinishedWork(run)) continue;
        this.runRepo.finish(run.id, 'crashed');
        // Terminal tasks must remain terminal even when an old worker row is
        // found during daemon recovery.
        if (task.status === 'done' || task.status === 'cancelled') continue;
        this.taskRepo.update(run.taskId, { status: 'queued', resume: 1 });
        this.eventBus.emit('run.crashed', run.taskId, { runId: run.id });
        this.eventBus.emit('task.queued', run.taskId);
        continue;
      }

      const task = this.taskRepo.get(run.taskId);
      const engine = this.engines.get(run.engine);
      if (!task || !engine || !run.pid) continue;

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
      });
    }

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
    // A checking task is not enough evidence to start checks. The only valid
    // caller supplies the exact worker run that just finished and was marked
    // done by recoverFinishedWork(). This prevents stale checking rows from
    // being re-checked after a restart.
    if (!taskId || !runId) return;
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
  }

  async runChecksForTask(taskId: string, runId: string, reuseSavedResults = false): Promise<void> {
    if (this.stopped) return;
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
    if (this.config.load.enabled) {
      if (this.loadGuard.isAutoPauseTriggered()) {
        const maxAutoPaused = this.config.load.maxAutoPaused ?? 2;
        const autoPausedCount = Array.from(this.running.values()).filter((rt) => rt.paused && rt.pauseReason === 'load').length;
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
          .filter((rt) => rt.paused && rt.pauseReason === 'load')
          .sort((a, b) => (a.pausedAt || 0) - (b.pausedAt || 0));

        if (autoPaused.length > 0) {
          const nextToResume = autoPaused[0];
          this.resumeTask(nextToResume.taskId);
          this.eventBus.emit('load.task_resumed', nextToResume.taskId, { reason: 'recovered' });
        }
      }
    }
    // 0. Check disk space: if sufficient, resume any tasks waiting for disk
    const disks = this.getMonitoredDisks();
    const blockedDisk = disks.find((disk) => disk.low);
    if (blockedDisk) {
      this.markDiskLow(blockedDisk);
      const dockerDisk = disks.find((disk) => disk.label === 'Docker' && disk.low);
      if (dockerDisk && this.running.size > 0) this.markDockerDiskLow(dockerDisk);
    } else {
      const diskSpace = disks.find((disk) => disk.source === 'worktrees')!;
      this.dockerDiskLow = false;
      const recovered = diskSpace.freeGB >= diskSpace.minFreeGB + 1;
      if (this.diskLow && recovered) {
        this.diskLow = false;
        this.eventBus.emit('disk.ok', undefined, {
          freeGB: diskSpace.freeGB,
          minFreeGB: this.config.disk.minFreeGB,
        });
      }
      if (this.tasksWaitingForDisk.size > 0) {
        for (const taskId of [...this.tasksWaitingForDisk]) {
          const task = this.taskRepo.get(taskId);
          if (task && this.projectRepo.get(task.projectId) && (task.status === 'waiting_quota' || (task.status as string) === 'waiting_disk')) {
            this.taskRepo.updateStatus(taskId, 'queued');
            this.eventBus.emit('task.queued', taskId, { reason: 'disk_ready' });
          }
        }
        this.tasksWaitingForDisk.clear();
      }
      const diskWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'disk');
      for (const t of diskWaiters) {
        if (!this.projectRepo.get(t.projectId)) continue;
        this.taskRepo.updateStatus(t.id, 'queued');
        this.eventBus.emit('task.queued', t.id, { reason: 'disk_ready' });
      }
      if (this.recheckWaitingOnDiskOk) {
        // tasksWaitingForDisk chỉ nằm trong bộ nhớ: sau khi daemon restart, task đã vào
        // waiting_quota vì đĩa sẽ kẹt mãi. Đánh thức lại một lần; task thật sự hết quota
        // sẽ được dispatch đưa về waiting_quota như cũ.
        this.recheckWaitingOnDiskOk = false;
        this.wakeWaitingQuotaTasks('startup_recheck');
      }
    }

    // 0b. Resume parallel waiters if project slot is available
    const parallelWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'parallel' || t.waitReason === 'department_parallel');
    for (const task of parallelWaiters) {
      const project = this.projectRepo.get(task.projectId);
      if (!project) continue;
      if (this.hasParallelCapacity(project)) {
        this.taskRepo.updateStatus(task.id, 'queued');
        this.eventBus.emit('task.queued', task.id, { reason: 'parallel_available' });
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

    // 2. Check running tasks for completion
    void this.checkRunningTasks().catch(() => {});

    // 3. Start new tasks if possible
    // 3. Reviews first: a slot freed by a worker should finish reviewed work before starting new work,
    // otherwise busy Codex accounts starve the review queue.
    this.scheduleReviews();

    // 3b. Prune expired worktrees before dispatching tasks. When disk is low,
    // this gives cleanup a chance to free space before queued work is parked.
    this.cleanExpiredWorktrees();

    // 3c. Start new tasks if possible
    this.scheduleNewTasks();

    // 4. Scan worktrees and reap orphaned worker processes periodically.
    if (Date.now() - this.lastOrphanScan >= 6 * 60 * 60 * 1000) {
      this.lastOrphanScan = Date.now();
      this.scanOrphanWorktrees();
      this.reapOrphans();
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
      if (reason !== 'startup_recheck' && task.waitReason === 'disk') {
        if (this.getMonitoredDisks().some((disk) => disk.low)) continue;
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
    this.eventBus.emit('run.stalled', taskId, { runId: rt.runId });

    const stalledCount = this.runRepo.getByTask(taskId).filter((run) => run.reason === 'stalled').length;
    if (stalledCount <= 2) {
      const task = this.taskRepo.get(taskId);
      if (!task) return;
      const body = `${task.body || task.title}\n\n${STALL_NOTE}`;
      this.taskRepo.update(taskId, { status: 'queued', resume: 1, body });
      this.eventBus.emit('task.queued', taskId, { reason: 'stalled_retry', note: STALL_NOTE });
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
      this.eventBus.emit('task.checking', taskId);
      await this.runChecksForTask(taskId, rt.runId);
    } else if (marker === 'blocked') {
      this.runRepo.finish(rt.runId, 'blocked');
      this.taskRepo.update(taskId, { status: 'blocked', transientRetries: 0, notBefore: null });
      this.eventBus.emit('task.blocked', taskId);
    } else if (this.hasCommitAfter(currentTask, rt.startTime)) {
      this.runRepo.finish(rt.runId, 'crashed', undefined, 'resume_after_progress');
      this.taskRepo.update(taskId, { status: 'queued', resume: 1 });
      this.eventBus.emit('task.queued', taskId, { reason: 'resume_after_progress' });
    } else {
      const exitCode = rt.exitCode ?? rt.child?.exitCode ?? null;
      const isLockBusy = durationMs < 3000 && fullLog.trim() === '' && Boolean(rt.lockFile) && exitCode === 1;

      if (isLockBusy) {
        this.runRepo.finish(rt.runId, 'crashed', undefined, 'lock_busy');
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

          // Try to find another profile/model
          const attempt = (task.attempt || 0) + 1;
          this.taskRepo.update(taskId, { status: 'queued', attempt, resume: 1, transientRetries: 0, notBefore: null });
          this.eventBus.emit('task.queued', taskId, { reason: 'quota_retry' });
        } else if (rt.engine.detectAuthError(logTail).expired) {
          this.runRepo.finish(rt.runId, 'crashed', undefined, 'auth');
          this.markProfileAuthExpired(rt.profileName);

          this.taskRepo.update(taskId, { status: 'queued', attempt: task.attempt, resume: 1, transientRetries: 0, notBefore: null });
          this.eventBus.emit('task.queued', taskId, { reason: 'auth_retry', profile: rt.profileName });
        } else {
          // Check for transient errors
          if (rt.engine.detectTransientError(logTail) && task.transientRetries < 3) {
            const delays = [60000, 120000, 180000];
            const delay = delays[task.transientRetries] || 180000;
            this.runRepo.finish(rt.runId, 'crashed');
            this.taskRepo.update(taskId, {
              status: 'queued',
              notBefore: Math.floor(Date.now() / 1000) + Math.ceil(delay / 1000),
              transientRetries: task.transientRetries + 1,
            });
            this.eventBus.emit('task.queued', taskId, { reason: 'transient_retry', delay });
          } else {
            // Failed
            this.runRepo.finish(rt.runId, 'crashed');
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
      if (task.waitReason === 'focus') this.taskRepo.update(task.id, { status: 'queued', waitReason: null });
      schedulableTasks.push(task);
    }

    const fairUsage = new Map<string, number>();
    for (const running of [...this.running.values(), ...this.starting.values()]) {
      const departmentId = this.projectRepo.get(running.projectId)?.departmentId || 'chung';
      fairUsage.set(departmentId, (fairUsage.get(departmentId) || 0) + 1);
    }
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
      if (task.notBefore != null && task.notBefore > Math.floor(Date.now() / 1000)) continue;
      // Check dependencies
      if (!this.areDependenciesMet(task)) continue;

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
        this.markQueuedWaiting(task, departmentLimited ? 'department_parallel' : 'parallel');
        continue;
      }

      // Find a suitable (model, profile) pair
      const pair = this.findModelProfilePair(task);
      if (pair) {
        const disk = this.getBlockingDisk();
        if (disk) {
          this.tasksWaitingForDisk.add(task.id);
          this.taskRepo.updateStatus(task.id, 'waiting_quota', 'disk');
          this.eventBus.emit('task.waiting_quota', task.id, { reason: 'disk', label: disk.label, freeGB: disk.freeGB, minFreeGB: disk.minFreeGB, message: this.diskWaitMessage(disk) });
          this.markDiskLow(disk);
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
  }

  private scheduleReviews(): void {
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
      if (chain.length > 0 && (!step || step.mode !== 'gate')) {
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
      const model = reviewerModel(step || { reviewer: this.config.reviewer?.model || 'codex:gpt-5.6-luna', mode: 'gate' }) || this.config.reviewer?.model || 'codex:gpt-5.6-luna';
      const lastWorker = this.runRepo.getByTask(task.id).filter((run) => run.kind === 'worker').at(-1);
      // Same model as the worker: still review, but from another Codex account in a fresh session.
      const picked = chain.length > 0
        ? this.pickChainReviewer(task, step, model, lastWorker?.profileName)
        : this.pickReviewer(task, lastWorker?.model === model ? lastWorker.profileName : undefined);
      if ('wait' in picked) continue;
      this.startReview(task, picked.profile.name, picked.engine, picked.model, picked.engine.id === 'claude' ? 'claude-reviewer' : 'codex-reviewer');
    }
  }

  /** Pick the first reviewer that can run, applying project overrides and fallback policy. */
  private pickReviewer(task: TaskRow, avoidProfile?: string): ReviewerPick {
    const project = this.projectRepo.get(task.projectId);
    const settings = projectSettings(project);
    const legacy = reviewerSettingsFromLegacy(this.config.reviewer as unknown as Record<string, unknown>);
    const order: ReviewerOrderItem[] = settings.review?.order ?? legacy.order;
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
        if (index > 0) {
          const key = `${task.id}:${index}`;
          if (!this.reviewerFallbackNotified.has(key)) {
            this.reviewerFallbackNotified.add(key);
            this.eventBus.emit('review.fallback', task.id, { from: order[index - 1].engine, to: item.engine, reason: 'available', profile: free[0].name });
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
      if (index < order.length - 1) {
        const key = `${task.id}:${index + 1}`;
        if (!this.reviewerFallbackNotified.has(key)) {
          this.reviewerFallbackNotified.add(key);
          this.eventBus.emit('review.fallback', task.id, { from: item.engine, to: order[index + 1].engine, reason: unavailable ? 'unavailable' : busy ? 'busy' : 'error' });
        }
      }
    }
    return { wait: true };
  }

  private pickChainReviewer(task: TaskRow, step: ReviewChainStep | undefined, model: string, avoidProfile?: string): ReviewerPick {
    if (step?.reviewer === 'claude') {
      if (!this.claudeBudgetAvailable(task)) {
        this.emitReviewWaiting(task, 'claude_budget');
        return { wait: true };
      }
      const engine = this.engines.get(CLAUDE_REVIEW_ENGINE_KEY);
      if (!engine) {
        this.emitReviewWaiting(task, 'no_reviewer_profile');
        return { wait: true };
      }
      const profiles = this.availableChainProfiles('claude', undefined);
      const profile = profiles.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      if (!profile) this.emitReviewWaiting(task, 'no_reviewer_profile');
      return profile ? { engine, model, profile } : { wait: true };
    }

    const engine = this.engines.get('codex');
    if (!engine) {
      this.emitReviewWaiting(task, 'no_reviewer_profile');
      return { wait: true };
    }
    const eligibleCodexProfiles = this.availableChainProfiles('codex', undefined, false);
    const codexProfiles = this.availableChainProfiles('codex', undefined);
    const nonWorkerProfiles = codexProfiles.filter((profile) => profile.name !== avoidProfile);
    const eligibleNonWorkerProfiles = eligibleCodexProfiles.filter((profile) => profile.name !== avoidProfile);
    const errorCount = this.reviewerErrorCounts.get(task.id) || 0;
    const settings = this.reviewerSettingsForTask(task);
    const waitedMs = Date.now() - parseDbTime(task.updatedAt);
    const claudeBudgetUnavailable = this.config.reviewer?.claudeFallback !== false && !this.claudeBudgetAvailable(task);
    const workerOnly = Boolean(avoidProfile) && eligibleCodexProfiles.length > 0 && eligibleCodexProfiles.every((profile) => profile.name === avoidProfile);
    const shouldFallback = (workerOnly || eligibleCodexProfiles.length === 0)
      ? settings.fallback.onUnavailable
      : errorCount >= 2 && settings.fallback.onError;

    if (shouldFallback) {
      const fallback = this.pickChainClaudeFallback(task, settings);
      if (fallback) return fallback;
      if (claudeBudgetUnavailable) this.emitReviewWaiting(task, 'claude_budget');
      else if (workerOnly) this.emitReviewWaiting(task, 'only_worker_profile');
      else if (!eligibleCodexProfiles.length) this.emitReviewWaiting(task, 'no_reviewer_profile');
      else if (errorCount >= 2) this.emitReviewWaiting(task, 'no_reviewer_profile');
    }

    // The fallback attempt above is deliberately best-effort. If it is disabled, over budget,
    // or has no usable Claude profile, the only free Codex profile is still a valid fresh session.
    const selected = nonWorkerProfiles[0] || (workerOnly ? codexProfiles[0] : undefined);
    if (selected && !(errorCount >= 2 && settings.fallback.onError)) {
      return { engine, model, profile: selected };
    }

    const busy = eligibleNonWorkerProfiles.length > 0 && nonWorkerProfiles.length === 0;
    if (busy && waitedMs >= settings.fallback.onBusyAfterMin * 60_000 && settings.fallback.onBusyAfterMin >= 0) {
      const fallback = this.pickChainClaudeFallback(task, settings);
      if (fallback) return fallback;
    }
    if (claudeBudgetUnavailable) this.emitReviewWaiting(task, 'claude_budget');
    else if (workerOnly) this.emitReviewWaiting(task, 'only_worker_profile');
    else if (!eligibleCodexProfiles.length) this.emitReviewWaiting(task, 'no_reviewer_profile');
    else if (errorCount >= 2 || busy) this.emitReviewWaiting(task, 'no_reviewer_profile');
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

  private pickChainClaudeFallback(task: TaskRow, settings: { order: ReviewerOrderItem[]; fallback: ReviewerFallback }): ReviewerPick | null {
    if (this.config.reviewer?.claudeFallback === false) return null;
    const item = settings.order.find((candidate) => candidate.engine === 'claude') || {
      engine: 'claude' as const,
      model: this.config.reviewer?.claudeModel || 'sonnet',
      profiles: this.config.reviewer?.claudeProfiles || [],
    };
    if (!this.claudeBudgetAvailable(task)) {
      this.emitReviewWaiting(task, 'claude_budget');
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
    if (!this.reviewerFallbackNotified.has(key)) {
      this.reviewerFallbackNotified.add(key);
      this.eventBus.emit('review.fallback', task.id, { from: 'codex', to: 'claude', reason: 'unavailable', profile: profile.name });
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

  private reviewMaxRoundsForTask(task: TaskRow): number {
    const project = this.projectRepo.get(task.projectId);
    if (project?.review) {
      try {
        const value = JSON.parse(project.review) as { maxRounds?: unknown };
        return typeof value.maxRounds === 'number' && value.maxRounds > 0 ? value.maxRounds : 2;
      } catch {
        return 2;
      }
    }
    return this.config.reviewer?.maxChangesRequested || 2;
  }

  private advanceReviewStep(task: TaskRow, chain: ReviewChainStep[], reason: string): void {
    const nextStep = (task.reviewStep ?? 0) + 1;
    this.taskRepo.update(task.id, { reviewStep: nextStep, reviewerChangesRequested: 0 });
    if (nextStep >= chain.length || chain[nextStep]?.mode === 'final') {
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
    return Number.isFinite(waitedMs) && waitedMs >= (this.config.reviewer?.claudeFallbackAfterMin ?? 10) * 60_000;
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
    this.eventBus.emit('review.fallback', task.id, { from: 'reviewer', to: arbiter.engine, reason: 'arbiter', profile: profile.name });
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
      const claude = this.engines.get(CLAUDE_REVIEW_ENGINE_KEY);
      if (!claude || !task.worktreePath || !this.claudeBudgetAvailable(task)) return;
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
      this.eventBus.emit('review.fallback', task.id, { from: 'codex', to: 'claude', profile: profile.name, reason: 'arbiter_unavailable' });
      this.startReview(task, profile.name, claude, `claude:${this.config.reviewer?.claudeModel || 'sonnet'}`, 'claude-reviewer');
      return;
    }

    const codex = this.engines.get('codex');
    if (!codex || !task.worktreePath) return;
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
    this.eventBus.emit('review.fallback', task.id, { from: 'claude', to: 'codex', profile: profile.name, reason: 'arbiter_unavailable' });
    this.startReview(task, profile.name, codex, this.config.reviewer?.model || 'codex:gpt-5.6-luna', 'codex-reviewer');
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
    if (!chain.some((step) => step.mode === 'gate' && step.reviewer.startsWith('codex:'))) return false;
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
      child = engine.spawn({
        profile,
        model: reviewerModel,
        cwd: task.worktreePath,
        prompt: buildReviewerPrompt(task.body || task.title, task.worktreePath, checks, project ? projectSettings(project).reviewChecklist : [], project?.path),
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
    this.eventBus.emit('review.started', task.id, { actor: reviewerActor, model: reviewerModel, profile: profileName, runId });
    child.once('error', () => {
      if (!this.stopped) this.finishReview(task.id, runId, profileName, 'error', null);
    });
    child.once('exit', (code) => {
      if (this.stopped) return;
      const run = this.reviewerRuns.get(task.id);
      const exitTimeout = setTimeout(() => this.finishReview(task.id, runId, profileName, 'exit', code), 10);
      if (run) run.exitTimeout = exitTimeout;
    });
  }

  private finishReview(taskId: string, runId: string, profileName: string, reason: 'exit' | 'timeout' | 'error', exitCode: number | null = 0): void {
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
    // The Claude CLI prints its limit notice on stdout, which lands in the output file, not the log.
    const quota = active.engine.detectQuota(`${logOutput}\n${output}`).exhausted;
    const duration = Date.now() - active.startedAt;
    const isLockBusy = duration < 3000 && logOutput.trim() === '' && Boolean(active.lockFile) && exitCode === 1;
    if (isLockBusy) {
      this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_LOCK_BACKOFF_MS);
      this.runRepo.finish(runId, 'crashed', undefined, 'lock_busy');
      this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: 'lock_busy' });
      return;
    }
    if (reason === 'timeout' || reason === 'error' || exitCode !== 0 || quota) {
      if (!quota) this.reviewerErrorCounts.set(taskId, (this.reviewerErrorCounts.get(taskId) || 0) + 1);
      this.reviewerBackoffUntil.set(profileName, Date.now() + REVIEWER_CRASH_BACKOFF_MS);
      this.runRepo.finish(runId, quota ? 'quota' : reason === 'timeout' ? 'timeout' : 'crashed');
      if (quota) this.quotaService.mark(profileName, active.actor === 'claude-reviewer' ? 'claude' : 'codex', this.config.reviewer?.failoverSec || 5 * 60 * 60, `${active.actor} quota`);
      this.eventBus.emit('review.waiting', taskId, { actor: active.actor, reason: quota ? 'quota' : reason === 'timeout' ? 'timeout' : 'crash' });
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
    this.runRepo.finish(runId, 'done');
    this.reviewerErrorCounts.delete(taskId);
    this.reviewTask(taskId, result.verdict, result.feedback, active.actor);
    this.eventBus.emit('review.completed', taskId, { actor: active.actor, verdict: result.verdict, model: run?.model || this.config.reviewer?.model || 'codex:gpt-5.6-luna', runId });
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

  private escalateReview(taskId: string, reason: string, feedback: string): void {
    const task = this.taskRepo.get(taskId);
    if (!task || task.reviewerEscalated) return;
    this.taskRepo.update(taskId, {
      status: 'review',
      reviewerEscalated: 1,
      reviewerEscalatedAt: new Date().toISOString(),
      reviewerEscalationReason: reason,
    });
    this.eventBus.emit('review.escalated', taskId, { actor: 'codex-reviewer', reason, feedback, title: task.title });
  }

  private areDependenciesMet(task: TaskRow): boolean {
    const deps: string[] = JSON.parse(task.dependsOn);
    for (const depId of deps) {
      const dep = this.taskRepo.get(depId);
      if (!dep || dep.status !== 'done') return false;
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

  /** Task chờ slot/tài khoản vẫn ở `queued`; chỉ ghi DB và phát sự kiện khi lý do chờ đổi. */
  private markQueuedWaiting(task: TaskRow, reason: 'parallel' | 'department_parallel' | 'profile_busy'): void {
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
    const disk = this.getBlockingDisk();
    if (disk) {
      this.tasksWaitingForDisk.add(task.id);
      this.taskRepo.updateStatus(task.id, 'waiting_quota', 'disk');
      this.eventBus.emit('task.waiting_quota', task.id, { reason: 'disk', label: disk.label, freeGB: disk.freeGB, minFreeGB: disk.minFreeGB, message: this.diskWaitMessage(disk) });
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
    const branchExample = renderTaskBranch(project, task);
    prompt += `\n\n## Quy ước commit\n- Nhánh task: \`${branchExample}\`\n- Commit message mẫu: \`${renderCommitTemplate(convention.commitTemplate, { type: 'feat', scope: 'scope', ref: task.externalRef || 'REF-123', summary: 'summary' })}\`\n- Merge message mẫu: \`${renderCommitTemplate(convention.mergeMessageTemplate, { branch: branchExample, target: task.baseRef || project.defaultBranch })}\``;
    if (convention.commitTemplate.includes('{ref}') && task.externalRef) prompt += `\n- External ref bắt buộc: \`${task.externalRef}\``;
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
    });

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

      this.eventBus.emit('task.running', task.id, { runId, model, profile: profileName });

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
   * Cancel a running task
   */
  cancelTask(taskId: string): void {
    const rt = this.running.get(taskId);
    if (rt) {
      this.killTask(taskId, 'cancelled');
    } else {
      this.taskRepo.updateStatus(taskId, 'cancelled');
      this.eventBus.emit('task.cancelled', taskId);
    }
  }

  /**
   * Review a task
   */
  reviewTask(taskId: string, verdict: 'approved' | 'changes_requested', feedback?: string, by?: string): void {
    const task = this.taskRepo.get(taskId);
    if (!task || task.status !== 'review') return;
    this.reviewNotified.delete(taskId);
    const chain = this.reviewChainForTask(task);
    const step = chain[task.reviewStep ?? 0];

    if (verdict === 'approved') {
      if (isAutoReviewer(by) && (!feedback || feedback.trim() === '')) return;
      if (isAutoReviewer(by) && this.reviewRepo) this.reviewRepo.insert({ id: crypto.randomUUID(), taskId, verdict, feedback: feedback || null, actor: by });
      if ((isAutoReviewer(by) || by === 'claude-review') && step?.mode === 'gate') {
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
      if (isAutoReviewer(by) && this.reviewRepo) this.reviewRepo.insert({ id: crypto.randomUUID(), taskId, verdict, feedback, actor: by });
      if (((isAutoReviewer(by) || by === 'claude-review') && step?.mode === 'gate') || (isAutoReviewer(by) && chain.length === 0)) {
        const count = (task.reviewerChangesRequested || 0) + 1;
        const max = this.reviewMaxRoundsForTask(task);
        if (count > max) {
          this.escalateReview(taskId, 'reviewer_changes_limit', feedback);
          return;
        }
        this.taskRepo.update(taskId, { reviewerChangesRequested: count });
      } else {
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
      reviewerChangesRequested: 0,
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
      this.taskRepo.updateStatus(taskId, 'cancelled');
      this.eventBus.emit('task.cancelled', taskId);
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

  private getMonitoredDisks(): MonitoredDisk[] {
    const roots = [this.config.worktreesDir, ...this.projectRepo.getAll().flatMap((project) => projectWorktreeRoots(project, this.config.hubHome, this.config.worktreesDir))];
    return getMonitoredDisks(roots, this.config.disk.minFreeGB, this.config.disk.extraPaths, process.env.NODE_ENV !== 'test', this.diskReader);
  }

  private getBlockingDisk(): MonitoredDisk | undefined {
    return this.getMonitoredDisks().find((disk) => disk.low);
  }

  private diskWaitMessage(disk: MonitoredDisk): string {
    return `Chờ ${disk.label} (còn ${disk.freeGB} GB / cần ${disk.minFreeGB} GB)`;
  }

  private markDiskLow(disk: MonitoredDisk): void {
    if (this.diskLow) return;
    this.diskLow = true;
    pruneNodeModulesCache(this.config.cacheDir, { maxEntries: this.config.cacheMaxEntries, maxBytes: this.config.cacheMaxGB * 1024 ** 3 });
    const cache = nodeModulesCacheSummary(this.config.cacheDir);
    this.eventBus.emit('disk.low', undefined, {
      label: disk.label,
      freeGB: disk.freeGB,
      minFreeGB: disk.minFreeGB,
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

    const completedTasks = this.taskRepo.getAll().filter((task) => task.status === 'done' || task.status === 'cancelled');
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
        if (task && task.status !== 'done' && task.status !== 'cancelled') continue;
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
}
