export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'checking'
  | 'review'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'waiting_quota';

export interface PerfGroup { cpuPercent: number; rssBytes: number; processes: number; }
export interface PerfSample { at: string; cpuCount: number; groups: Record<string, PerfGroup>; }
export interface EventLoopStats { p50Ms: number; p99Ms: number; maxMs: number; meanMs: number; }
export interface PerfReport { samples: PerfSample[]; latest: PerfSample | null; eventLoop?: EventLoopStats | null; }

export type TaskLevel = 'easy' | 'hard';

export type EngineType = 'agy' | 'codex' | 'claude';

export type ProfileKind = 'keyring' | 'isolated' | 'codex' | 'system';
export type ProfileAccountType = 'personal' | 'team' | 'api';

export interface QuotaMark {
  profileName: string;
  family: string;
  until: number; // epoch seconds
  reason?: string;
}
export interface QuotaUsageItem {
  grp: string;
  window: '5h' | 'week';
  remainingPct: number;
  resetAt: number;
  fetchedAt: number;
}

export interface ClaudeLimitedSession {
  sessionId: string;
  title: string | null;
  cwd: string;
  limitResetAt: number;
  autoResumeEnabled: boolean;
}

export interface Profile {
  name: string;
  engine: EngineType;
  kind: ProfileKind;
  accountType?: ProfileAccountType;
  home?: string;
  email?: string | null;
  loggedIn?: boolean;
  enabled: boolean | number;
  createdAt?: string;
  quotaMarks?: QuotaMark[];
  busy?: boolean;
  isBusy?: boolean;
  duplicateWarning?: boolean;
  duplicateEmailWith?: string[];
  usage?: QuotaUsageItem[];
  claudeTokens?: { today: number; week: number };
  limitedSessions?: ClaudeLimitedSession[];
  slotsUsed?: number;
  slotsTotal?: number;
  authState?: 'ok' | 'not_logged_in' | 'needs_verification' | 'error' | null;
  authMessage?: string | null;
  verifyUrl?: string | null;
  claudePlan?: string;
  label?: string | null;
  notes?: string | null;
  priority?: number;
  avatarUrl?: string | null;
  /** Gói tài khoản đã chuẩn hoá: free, plus, pro, team, max_20x… (null khi chưa biết). */
  plan?: string | null;
  crashCount?: number;
  coolingUntil?: number | null;
  /** Chỉ có trong phản hồi của nút Làm mới: kết quả lấy ảnh đại diện. */
  avatarMessage?: string;
  /** Chỉ có trong phản hồi của nút Làm mới cho Codex: kết quả lấy quota/gói qua API. */
  refreshMessage?: string;
  currentTask?: { id?: string; title?: string } | null;
}

export interface ProjectHooks {
  onWorktreeRemoved?: string[];
}

export interface ProjectMerge {
  enabled: boolean;
  worktrees: Record<string, string>;
  checks: string[];
  timeoutSec: number;
}
export interface ReviewChainStep { reviewer: string; mode: 'gate' | 'final'; }
export interface ProjectReview { chain: ReviewChainStep[]; maxRounds: number; }
export interface ReviewerOrderItem { engine: 'codex' | 'claude'; model: string; profiles: string[]; }
export interface ReviewerFallback { onUnavailable: boolean; onBusyAfterMin: number; onError: boolean; }

export interface IntegrationStatus {
  path: string;
  branch: string;
  exists: boolean;
  currentBranch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  envTemplate?: string | null;
  maxParallel: number;
  priority?: number;
  departmentId?: string;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | string | null;
  hooks?: ProjectHooks | string | null;
  merge?: ProjectMerge | string | null;
  review?: ProjectReview | string | null;
  /** Always present in API responses (defaults filled in by the server). */
  settings?: ProjectSettings;
  integrationStatus?: IntegrationStatus | null;
  ciStatus?: CiStatusSummary | null;
  createdAt?: string;
  afterMerge?: { steps: string[][]; timeoutSec: number; restartHub: boolean; push?: { remote: string; from: string; to: string; ffOnly: boolean } } | null;
}

export interface ProjectGitStatus {
  path: string;
  currentBranch: string | null;
  defaultBranch: string;
  dirty: { changed: boolean; files: number };
  remote: string | null;
  localBranches: string[];
  remoteBranches: string[];
  aheadBehind: { ahead: number; behind: number } | null;
}

export interface ProjectInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  currentBranch: string | null;
  branches: string[];
  remoteHost: string | null;
  estimatedSizeBytes: number;
  sizeTruncated: boolean;
  lockfiles: string[];
  monorepo: { detected: boolean; type: string | null };
  gitHooks: { husky: boolean; commitlint: boolean };
  language: string;
  projectFiles: string[];
  guidanceFiles: string[];
  mount: { mountpoint: string | null; temporary: boolean; encrypted: boolean };
  claudeSessions: Array<{ name: string; modifiedAt: string; sizeBytes: number }>;
  claudeSessionPreviews: Array<{ name: string; content: string }>;
  hasClaudeMemory: boolean;
  memoryPreview: string | null;
  suggestedSettings: { skipInstall: boolean; skipGitHooks: boolean; sensitiveProject: boolean; checks: Array<{ name: string; cmd: string[]; reason: string }> };
}

export interface DepartmentProfile {
  departmentId: string;
  profileName: string;
  share: number | null;
}

export interface Department {
  id: string;
  name: string;
  priority: number;
  maxParallel: number;
  claudeDailyTokenBudget: number;
  telegramTopicId: number | null;
  brainEngine?: 'inherit' | 'claude' | 'codex';
  brainModel?: string;
  brainCodexProfile?: string | null;
  brainMode?: 'inherit' | 'off' | 'suggest' | 'auto';
  brainPermissions?: 'inherit' | 'standard' | 'trusted' | 'full';
  brainDailyTokenBudget?: number;
  brainMaxTurnsPerHour?: number;
  createdAt: string;
  projectCount?: number;
  profiles: DepartmentProfile[];
  projects: Array<{ id: string; name: string }>;
}

export interface CiJobAnnotation {
  path?: string;
  start_line?: number;
  end_line?: number;
  annotation_level?: string;
  message: string;
  title?: string;
  raw_details?: string;
}

export interface CiJob {
  id: number;
  name: string;
  status?: string;
  conclusion?: string | null;
  annotations?: CiJobAnnotation[];
}

export interface CiStatusSummary {
  runId: number;
  workflow: string;
  sha: string;
  status: string;
  conclusion?: string | null;
  url?: string | null;
  completedAt?: string | null;
  jobs?: CiJob[];
}

export interface DeployStatus {
  projectId: string;
  status: 'queued' | 'running' | 'restarting' | 'succeeded' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  commit?: string;
  error?: string;
  logPath?: string;
}

/** Mirrors src/projects/settings.ts. */
export interface ProjectSettings {
  preset?: 'safe' | 'balanced' | 'auto' | 'custom' | string;
  autoFixOnFail?: boolean;
  planning?: { requireApproval?: boolean; approvalMinTasks?: number };
  commitConvention?: { branchTemplate: string; commitTemplate: string; defaultRef?: string; commitRegex?: string; mergeMessageTemplate: string };
  brain: {
    engine?: 'inherit' | 'claude' | 'codex';
    codexProfile?: string;
    mode: 'inherit' | 'off' | 'suggest' | 'auto' | 'external';
    permissions?: 'inherit' | 'standard' | 'trusted' | 'full';
    dailyTokenBudget?: number;
    maxTurnsPerHour?: number;
  };
  worktree: { root?: string; logsInRoot?: boolean; install: 'auto' | 'skip' | 'worker'; warmPool?: number; gitHooks: 'run' | 'skip' };
  integration: { enabled: boolean; branch?: string; baseRef?: string; autoMerge?: boolean };
  review?: { autoMerge?: boolean; order?: ReviewerOrderItem[]; fallback?: Partial<ReviewerFallback> };
  ci: { enabled?: boolean; branch?: string };
  references: Array<{ name: string; path: string; inject: boolean }>;
  reviewChecklist?: string[];
  notifications: { telegramContent: 'full' | 'minimal' };
  openproject?: { enabled: boolean; sourceId: string | null; role: 'primary' | 'secondary' };
  gitea?: { enabled: boolean; url?: string; sourceBranch?: string; targetBranch?: string; schedule: string[]; weekdaysOnly: boolean; checks: string[][]; unionMergeGlobs: string[] };
  remoteDeploy?: { enabled: boolean; trigger: 'after-gitea-sync' | 'manual'; steps: string[][]; healthChecks: Array<{ url: string; expectStatusBelow: number; contains?: string }>; waitMinutes: number; timeoutSec?: number };
}

export interface OpenProjectSource {
  id: string; url: string; project: string; keyConfigured?: boolean;
  pollIntervalSec: number; watchStatusIds: number[]; reopenedStatusIds: number[];
  resolvedStatusId: number | null; reviewStatusId: number | null; openStatusIds: number[];
  createTypeId?: number | null; createStatusId?: number | null;
  minTicketNumber: number; autoStart: boolean; autoResolve: boolean; language: string;
  triage?: 'off' | 'approve' | 'auto'; triageModelChain?: string[]; feedbackStatusId?: number | null;
  split?: OpenProjectSplitConfig;
  dailyReport?: { enabled?: boolean; time: string; weekdaysOnly: boolean; dir?: string; maxItems: number; telegram: boolean };
  timesheet?: { enabled: boolean; time: string; weekdaysOnly: boolean; hours: number; activityId: number | null; minEntryHours: number; roundTo: number; writeEstimate: boolean };
}
export interface OpenProjectSplitConfig { typeIds: number[]; keyword: string | null; workerMayRequest: boolean; maxParts: number; createChildTickets: boolean; }
export interface OpenProjectSourceInput extends Omit<OpenProjectSource, 'keyConfigured' | 'split' | 'timesheet'> { split: OpenProjectSplitConfig; timesheet: { enabled: boolean; time: string; weekdaysOnly: boolean; hours: number; activityId: number | null; minEntryHours: number; roundTo: number; writeEstimate: boolean }; key?: string; }
export interface OpenProjectStatusDto {
  id: number;
  name: string;
  isClosed: boolean;
  position: number;
}
export interface OpenProjectTypeDto { id: number; name: string; position: number; }
export interface OpenProjectSyncResult { imported: number; comments: number; baseline: number; watched: number; }
export interface GiteaStatus {
  projectId?: string;
  status?: 'ok' | 'started' | 'skipped' | 'succeeded' | 'failed' | 'conflict' | string;
  running?: boolean;
  step?: 'fetch' | 'worktree' | 'merge' | 'checks' | 'push' | 'pr' | 'merge-pr' | string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  reason?: string;
  url?: string;
  prNumber?: number;
  commit?: string;
  tokenConfigured?: boolean;
  remote?: {
    owner: string;
    repo: string;
    host?: string;
  } | null;
  last?: GiteaStatus;
}
export interface RemoteDeployStatus { projectId: string; status: string; startedAt?: string; finishedAt?: string; error?: string; }

export interface KnowledgeEntry {
  id: number;
  projectId: string;
  taskId: string;
  content: string;
  createdAt: string;
  pinned: number;
}

export interface Run {
  id: string;
  taskId: string;
  engine: string;
  model: string;
  profileName: string;
  pid?: number | null;
  kind?: string | null;
  startedAt: string;
  endedAt?: string | null;
  outcome?: 'done' | 'blocked' | 'quota' | 'crashed' | 'cancelled' | 'timeout' | 'stalled' | null;
  reason?: string | null;
  logPath?: string | null;
  resetAt?: number | null;
}

export interface Review {
  id: string;
  taskId: string;
  verdict: 'approved' | 'changes_requested';
  feedback?: string | null;
  createdAt: string;
  actor?: string;
  model?: string;
}

export type WaitReason =
  | 'disk'
  | 'quota'
  | 'no_department_profile'
  | 'no_matching_profile'
  | 'parallel'
  | 'department_parallel'
  | 'profile_busy'
  | 'project_unavailable'
  | 'focus'
  | 'slot'
  | 'load'
  | 'dependency'
  | null;

export interface BlockingDiskInfo {
  path: string;
  label: string;
  freeGB: number;
  minFreeGB: number;
}

export interface Task {
  id: string; // project~slug or project/slug
  projectId: string;
  slug: string;
  title: string;
  externalRef?: string | null;
  externalUrl?: string | null;
  body?: string;
  level: TaskLevel;
  modelChain?: string | string[] | null;
  baseRef?: string;
  branch?: string;
  worktreePath?: string | null;
  status: TaskStatus;
  waitReason?: WaitReason;
  blockingDisk?: BlockingDiskInfo | null;
  modelWarnings?: string[];
  mergeWarning?: string | null;
  dependsOn: string | string[];
  attempt: number;
  resume: number;
  notBefore?: number | null;
  transientRetries?: number;
  slot?: number | null;
  reviewerChangesRequested?: number;
  reviewerEscalated?: number;
  reviewerEscalatedAt?: string | null;
  reviewerEscalationReason?: string | null;
  autoMergeSkippedReason?: string | null;
  autoMergeSkippedChecks?: Array<{ name?: string; outputTail?: string }>;
  autoMergeSkippedRetried?: boolean;
  reviewStep?: number;
  reviewRound?: number;
  reviewMaxRounds?: number;
  reviewChain?: ReviewChainStep[];
  createdAt: string;
  updatedAt: string;
  reviewer?: 'codex' | 'claude';
  currentRun?: {
    startedAt: string;
    lastOutputAt: string;
    lastActivityAt: string;
    activitySource: 'log' | 'conversation' | 'worktree';
    noCommitMinutes?: number | null;
    isLooping?: boolean;
    loopingCommand?: string | null;
    model?: string;
    profileName?: string;
    paused?: boolean;
    pauseReason?: 'manual' | 'load' | 'brain_load' | 'focus' | null;
    rss?: number;
    cpu?: number;
    /** Number of commits on task branch since base, cached by scheduler (null = not yet checked) */
    newCommitCount?: number | null;
    /** ISO timestamp of the most recent commit on task branch (null = none yet) */
    lastCommitAt?: string | null;
    /** Number of files with uncommitted changes in the worktree (null = not yet checked) */
    changedFileCount?: number | null;
  } | null;
  paused?: boolean;
  pauseReason?: 'manual' | 'load' | 'brain_load' | 'focus' | null;
  checks?: CheckResult[];
  sourceRef?: {
    taskId: string;
    runId?: string | null;
    checkName?: string | null;
    excerptHash: string;
  } | null;
  batchId?: string | null;
  triage?: { sourceId: string; wpId: number; displayId: string; analysis?: { conclusion?: string; size?: string; repo?: string[]; summary?: string; evidence?: string; cause?: string; proposal?: string; risks?: string; questions?: string; manualAssessment?: string; serverChecklist?: string; draftReply?: string; manualAlongside?: string; perRepo?: string }; decision?: { action?: string } | null } | null;
}

export type BatchStatus = 'draft' | 'dispatched' | 'discarded';

export interface TaskBatch {
  id: string;
  projectId: string;
  title: string;
  goal: string | null;
  status: BatchStatus;
  createdBy: string | null;
  createdAt: string;
  tasks?: Task[];
  progress?: {
    total: number;
    done: number;
    running: number;
    failed: number;
    waiting: number;
    pending: number;
  };
}

export interface CreateBatchInput {
  project: string;
  title: string;
  goal?: string;
  tasks: Array<{
    slug: string;
    title: string;
    body?: string;
    level?: TaskLevel;
    modelChain?: string[];
    dependsOn?: string[];
  }>;
  createdBy?: string;
  dispatch?: boolean;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

export interface TaskDetail extends Task {
  mergeAvailable?: boolean;
  mergeUnavailableReason?: string | null;
  reviewChain?: ReviewChainStep[];
  reviewMaxRounds?: number;
  runs: Run[];
  reviews: Review[];
  events?: EventItem[];
  doneContent?: string | null;
  blockedContent?: string | null;
  commits?: string[] | null;
  gitCommits?: string[] | null;
  sourceRef?: {
    taskId: string;
    runId?: string | null;
    checkName?: string | null;
    excerptHash: string;
  } | null;
  derivedTasks?: Task[];
}

export interface EventItem {
  id: number;
  ts: string;
  type: string;
  taskId?: string | null;
  payload?: any;
  summary?: string;
}

export interface RunningWorker {
  taskId: string;
  runId?: string;
  profileName: string;
  model: string;
  engine?: string;
  startedAt: string;
  elapsedMs?: number;
  lastActivityAt?: string;
  activitySource?: 'log' | 'conversation' | 'worktree';
  // Stall & looping detection
  noCommitMinutes?: number | null;
  isLooping?: boolean;
  loopingCommand?: string | null;
  // UI helper fields
  projectId?: string;
  slug?: string;
  title?: string;
  worktreePath?: string | null;
  rss?: number;
  cpu?: number;
  paused?: boolean;
  pauseReason?: 'manual' | 'load' | 'brain_load' | 'focus' | null;
  newCommitCount?: number | null;
  lastCommitAt?: string | null;
  changedFileCount?: number | null;
}

export type BrainActivity =
  | 'planning'
  | 'dispatching'
  | 'reviewing'
  | 'merging'
  | 'deploying'
  | 'waiting'
  | 'idle'
  | 'talking';

export interface BrainStatus {
  activity: BrainActivity;
  detail: string;
  taskId?: string | null;
  updatedAt: string;
  stale: boolean;
  source?: 'manual' | 'transcript';
  sessions?: BrainSession[];
  state?: 'working' | 'waiting' | 'inactive';
  brains?: ProjectBrain[];
  assistants?: AssistantStatus[];
}

export interface ProjectBrain {
  projectId: string | null;
  projectName: string;
  mode: 'inherit' | 'off' | 'suggest' | 'auto' | 'external';
  engine?: 'claude' | 'codex';
  permissions?: 'standard' | 'trusted' | 'full';
  sessionMode?: 'safe' | 'full';
  sessionId: string;
  state: 'idle' | 'running' | 'waiting' | 'error';
  queued: boolean;
  lastTurnAt: string | null;
  tokensToday: number;
  turnsToday?: number;
  inputTokensToday?: number;
  outputTokensToday?: number;
  rotationsToday?: number;
  eventsSkippedToday?: number;
  eventsBatchedToday?: number;
  directives?: Array<{ id: string; text: string; createdAt: string }>;
}

export interface AssistantStatus {
  projectId: string | null;
  projectName: string;
  sessionId: string;
  state: 'idle' | 'running' | 'waiting_permission' | 'waiting_limit' | 'error';
  busy: boolean;
}

export interface BrainSession {
  sessionId: string;
  title: string;
  cwd: string;
  lastActivityAt: string;
  lastUserRequest: string | null;
  lastTool: { name: string; summary: string } | null;
  state: 'working' | 'waiting' | 'inactive';
  tokens5h: number | null;
  link: string;
}

export interface ClaudeQuota {
  status: string | null;
  resetsAt: number | null;
  rateLimitType: string | null;
  observedAt: string | null;
  limited?: boolean;
  profiles?: Array<{ profileName: string; status: string | null; resetsAt: number | null; rateLimitType: string | null; observedAt: string; limited: boolean; source: string }>;
}

export interface TaskNote {
  id: number;
  projectId: string;
  taskId: string;
  kind: 'note' | 'overlap';
  content: string;
  createdAt: string;
}

export interface HubStatus {
  focus?: { projectId: string | null; since: string | null; pauseRunning: boolean };
  tasks: Record<string, number>;
  waitingReasons?: Record<string, number>;
  profiles?: Profile[];
  running: RunningWorker[];
  overlaps?: TaskNote[];
  brain?: BrainStatus;
  disk?: {
    freeGB: number;
    totalGB: number;
    minFreeGB?: number;
  };
  disks?: Array<{
    path: string;
    label: string;
    freeGB: number;
    totalGB: number;
    minFreeGB: number;
    low: boolean;
    source: 'worktrees' | 'extra' | 'hub_home';
  }>;
  worktrees?: {
    count: number;
    bytes: number;
    byStatus: Record<string, { count: number; bytes: number }>;
  };
  load?: {
    load1: number;
    freeMemGB: number;
    overloaded: boolean;
    recoveringSince: number | null;
  };
  telegram?: {
    enabled: boolean;
    allowedChatsCount?: number;
    hasToken?: boolean;
  };
  perf?: {
    eventLoop?: EventLoopStats | null;
  };
  // Backwards compatibility aliases
  tasksByStatus?: Record<TaskStatus, number>;
  runningWorkers?: RunningWorker[];
  recentEvents?: EventItem[];
  tasksByProject?: Record<string, Record<string, number>>;
}

export interface TelegramPairingResponse {
  code: string;
  expiresInSec: number;
  enabled: boolean;
  allowedChatIds: number[];
}

export interface OrphanProcess {
  pid: number;
  cwd: string;
  cpu: number;
  rss: number;
  task: { id: string; title: string; status: string } | null;
  active: boolean;
}

export interface SavingsConfig {
  bucketTokens: {
    gemini: number;
    claude: number;
  };
  claudeFactor: number;
  claudeOverheadPerTask: number;
}

export interface SavingsSummary {
  totalWorkerTokens: number;
  claudeSavedTokens: number;
  claudeCostTokens: number;
  savingsRatio: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  totalLinesChanged: number;
  tasksApprovedCount: number;
  avgReviewRounds: number;
}

export interface SavingsDailyItem {
  date: string;
  geminiTokens: number;
  codexTokens: number;
  totalTokens: number;
}

export interface SavingsTaskItem {
  taskId: string;
  slug: string;
  title: string;
  projectId: string;
  status: string;
  model: string;
  engine: string;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  tokens: number;
  estimated: boolean;
  reviewRounds: number;
  durationMs: number;
  completedAt: string | null;
  claudeCostSource?: 'measured' | 'estimated';
  claudeEffectiveTokens?: number;
}

export interface SavingsReport {
  summary: SavingsSummary;
  byEngine: Record<string, { tokens: number; taskCount: number }>;
  byModel: Record<string, { tokens: number; taskCount: number }>;
  byDay: SavingsDailyItem[];
  tasks: SavingsTaskItem[];
  tasksTotal?: number;
  tasksNextCursor?: string | null;
}

export interface ProfileQuotaInfo {
  gemini5h: number | null;
  geminiWeek: number | null;
  claude5h: number | null;
  claudeWeek: number | null;
}

export interface DayMetric {
  runs: number;
  durationMs: number;
  tokens: number;
  claudeTokens?: number;
}

export interface DailyProfileSummary {
  name: string;
  engine: 'agy' | 'codex' | 'claude';
  enabled: boolean;
  isIdle: boolean;
  idleReason?: string;
  quota: ProfileQuotaInfo;
  quotaUsage: QuotaUsageItem[];
  today: DayMetric;
  totals: DayMetric;
  daily: Record<string, DayMetric>;
}

export interface DailyUsageDayProfile extends DayMetric {
  profileName: string;
  engine: 'agy' | 'codex' | 'claude';
  isIdle: boolean;
  quota: ProfileQuotaInfo;
}

export interface DailyUsageDay {
  date: string;
  isToday: boolean;
  totalRuns: number;
  totalDurationMs: number;
  totalTokens: number;
  claudeTokens?: number;
  profiles: DailyUsageDayProfile[];
}

export interface DailyUsageReport {
  days: number;
  timezone: string;
  dates: string[];
  profiles: DailyProfileSummary[];
  byDay: DailyUsageDay[];
}

export interface SystemConfig {
  /** Preset given to newly registered projects (the one last applied globally). */
  defaultProjectPreset?: 'safe' | 'balanced' | 'auto' | null;
  branding?: { name: string; shortName: string; logo?: string; logoVersion?: number; accentColor?: string; tagline?: string };
  modelChainHard: string[];
  modelChainEasy: string[];
  defaultTimeout: number;
  multiplePerProvider?: boolean;
  planning?: { requireApproval?: boolean; approvalMinTasks?: number };
  slotsPerAgyProfile?: number;
  slotsPerCodexProfile?: number;
  watchdog?: { stallMinutes: number; waitingMinutes: number };
  stall?: { noCommitMin: number; loopThreshold: number };
  savings?: SavingsConfig;
  // Backwards compatibility alias for DEC-001 if needed
  modelChains?: {
    hard: string[];
    easy: string[];
  };
  runTimeoutHours?: number;
  chat?: ChatConfig;
  reviewer?: {
    model?: string;
    enabled?: boolean;
    timeoutSec?: number;
    failoverSec?: number;
    maxChangesRequested?: number;
    claudeFallback?: boolean;
    claudeProfiles?: string[];
    claudeModel?: string;
    claudeFallbackAfterMin?: number;
    order?: ReviewerOrderItem[];
    fallback?: Partial<ReviewerFallback>;
    arbiter?: { engine: 'codex' | 'claude'; model: string };
  };
  brain?: {
    engine?: 'claude' | 'codex';
    /** Hồ sơ Claude mặc định cho brain; rỗng = hồ sơ hệ thống. */
    claudeProfile?: string;
    codexProfile?: string;
    codexModel?: string;
    mode?: 'off' | 'suggest' | 'auto';
    permissions?: 'standard' | 'trusted' | 'full';
    maxConcurrent?: number;
    dailyTokenBudget?: number;
    maxTurnsPerHour?: number;
    digest?: {
      enabled: boolean;
      time: string;
    };
    fallback?: Array<
      | { type: 'profile'; profile?: string }
      | { type: 'model'; model: string }
      | { type: 'apiKey'; dailyCapUSD: number }
      | { type: 'engine'; engine: 'codex' }
      | { type: 'wait' }
    >;
  };
  notifications?: {
    desktop: boolean;
    desktopLevel?: 'all' | 'important' | 'critical' | 'off';
    quietHours?: {
      enabled: boolean;
      start: string;
      end: string;
    };
    quotaLowPct?: number;
  };
  wakeup?: {
    enabled: boolean;
    times: string[];
    profiles?: string[];
    agyModels?: string[];
  };
  load?: {
    enabled: boolean;
    high: number;
    ok: number;
    minFreeMemGB: number;
    recoverAfterSec: number;
  };
  ui?: { tours?: Record<string, boolean> };
}

export interface ModelOptions {
  suggestions: string[];
  configured: string[];
}

export type ChatMode = 'safe' | 'full';

export interface ChatSession {
  id: string;
  projectId?: string | null;
  title: string;
  mode: ChatMode;
  busy: boolean;
  state?: 'idle' | 'running' | 'waiting_permission' | 'waiting_limit' | 'error';
  model?: string;
  profileName?: string | null;
  updatedAt: string;
  lastMessage?: string | null;
  pinned?: boolean | number;
  archived?: boolean | number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  createdAt?: string;
  kind?: 'chat' | 'brain' | 'assistant' | 'setup';
}

export type ChatMessageRole = 'user' | 'assistant' | 'tool' | 'error' | 'system';

export interface ChatMessageMeta {
  name?: string;
  summary?: string;
  input?: unknown;
  output?: string;
  status?: 'running' | 'done' | 'error';
  diff?: string;
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
  error?: string;
  retryText?: string;
}

export interface ChatPermissionRequest {
  id: string;
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'allow' | 'deny' | 'allow_always';
  message?: string | null;
  createdAt: string;
  sessionTitle?: string | null;
  projectName?: string | null;
  permissionLabel?: string;
  canAlwaysAllow?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  meta?: ChatMessageMeta | null;
  createdAt: string;
}

export interface CreateChatSessionInput {
  projectId?: string | null;
  title?: string;
  mode?: ChatMode;
  model?: string;
  profileName?: string | null;
  kind?: 'chat' | 'brain' | 'assistant' | 'setup';
}

export interface UpdateChatSessionInput {
  title?: string;
  pinned?: boolean | number;
  archived?: boolean | number;
  model?: string;
}

export interface SendMessageResponse {
  userMessageId: string;
  assistantMessageId: string;
}

export interface ChatConfig {
  allowFullMode?: boolean;
  disableToolSearch?: boolean;
  claudeBin?: string;
  resolvedClaudeBin?: string | null;
  claudeVersion?: string | null;
  maxConcurrent?: number;
  idleTimeoutSec?: number;
  model?: string;
  models?: string[];
  claudeProfile?: string;
  autoCompactPercent?: number;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  defaultBranch?: string;
  envTemplate?: string | null;
  maxParallel?: number;
  departmentId?: string;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | null;
  hooks?: ProjectHooks | null;
  merge?: ProjectMerge | null;
  review?: ProjectReview | null;
  settings?: ProjectSettings;
}

export interface CreateNewProjectInput {
  name: string;
  path: string;
  defaultBranch?: string;
  maxParallel?: number;
  departmentId?: string;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | null;
  settings?: ProjectSettings;
}

export interface UpdateProjectInput {
  name?: string;
  defaultBranch?: string;
  envTemplate?: string | null;
  maxParallel?: number;
  departmentId?: string;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | null;
  hooks?: ProjectHooks | null;
  merge?: ProjectMerge | null;
  review?: ProjectReview | null;
  settings?: Partial<ProjectSettings>;
  confirm?: boolean;
}

export interface CreateProfileInput {
  name: string;
  engine?: 'agy' | 'codex' | 'claude';
  accountType?: ProfileAccountType;
}

export interface VersionResponse {
  version: string;
  webBuildId?: string;
}

export interface LoginSessionResponse {
  sessionId: string;
}

export interface CheckProfileResponse {
  started?: boolean;
  ok?: boolean;
  message?: string;
  output?: string;
  email?: string | null;
  durationMs?: number;
  model?: string;
  error?: string;
}

export interface CreateTaskInput {
  project: string;
  slug: string;
  title: string;
  externalRef?: string;
  body?: string;
  level: TaskLevel;
  dependsOn?: string[];
  baseRef?: string;
  branch?: string;
  modelChain?: string[];
  start?: boolean;
  createTicket?: { sourceId?: string };
}

export interface CaptureTaskInput {
  sourceTaskId: string;
  runId?: string;
  checkName?: string;
  excerpt: string;
  slug: string;
  title?: string;
  body?: string;
  level: TaskLevel;
  start?: boolean;
}

export interface ReviewTaskInput {
  verdict: 'approved' | 'changes_requested';
  feedback?: string;
  merge?: boolean;
}

export interface RetryTaskInput {
  note?: string;
}

export interface UpdateTaskInput {
  modelChain?: string[];
  dependsOn?: string[];
  level?: TaskLevel;
  title?: string;
  body?: string;
  appendBody?: string;
}

export interface TaskGraphNode {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  status: TaskStatus;
  level: TaskLevel;
  modelChain?: string[];
  currentRun?: {
    model?: string;
    profileName?: string;
  } | null;
  blockedCount: number;
  isCritical: boolean;
  isMaxBlocker: boolean;
}

export interface TaskGraphEdge {
  from: string;
  to: string;
  isCritical: boolean;
}

export interface TaskGraphResponse {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  criticalPath: string[];
  maxBlockingTaskId: string | null;
  maxBlockedCount: number;
}

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
  };
}

export interface ApplyPresetInput {
  scope: string; // 'global' | 'department:<id>' | 'project:<id>'
  preset: PresetLevel;
  dryRun?: boolean;
}

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

export type GlobalPresetField =
  | 'brain.mode'
  | 'brain.permissions'
  | 'autoFixOnFail'
  | 'planning.requireApproval'
  | 'planning.approvalMinTasks'
  | 'reviewer.maxChangesRequested'
  | 'reviewer.order';

export interface GlobalPresetStatus {
  preset: PresetLevel | 'custom';
  /** Preset the config was derived from (last applied, or closest match). */
  basePreset?: PresetLevel;
  /** True when basePreset is the last preset actually applied, not a best guess. */
  baseFromHistory?: boolean;
  /** Fields where the config differs from basePreset. */
  mismatches?: GlobalPresetField[];
}

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
    chain: EffectiveValue<Array<{ reviewer: string; mode: 'gate' | 'final' }>>;
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

