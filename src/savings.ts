import { sameAccount } from './profiles/account.js';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentHubConfig } from './config.js';
import {
  TaskRepo,
  RunRepo,
  RunMetricsRepo,
  ReviewRepo,
  ProfileRepo,
  ProjectRepo,
  RunRow,
  RunMetricsRow,
} from './db/index.js';
import { ClaudeSessionRepo } from './claude-sessions/repo.js';
import { getModelFamily } from './quota/index.js';
import { decodeCursor, encodeCursor } from './pagination.js';

const execFileAsync = promisify(execFile);

export interface CodexTokenParseResult {
  tokens: number | null;
}

/**
 * Parses Codex tokens from log content.
 * Looks for "tokens used" at the end of the log, followed by the token number on the next line
 * or on the same line. Handles thousand separators '.' and ','.
 * Examples: 117.250 -> 117250, 117,250 -> 117250, 117250 -> 117250.
 */
export function parseCodexTokens(logContent: string): number | null {
  if (!logContent) return null;
  const lines = logContent.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/tokens\s+used/i.test(line)) {
      // Check if number is on the same line (e.g. "Tokens used: 117.250")
      const sameLineMatch = line.match(/tokens\s+used[:\s]+([0-9.,]+)/i);
      if (sameLineMatch && sameLineMatch[1]) {
        const cleaned = sameLineMatch[1].replace(/[.,]/g, '');
        const num = parseInt(cleaned, 10);
        if (!isNaN(num) && num > 0) return num;
      }

      // Check next non-empty lines
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const nextLine = lines[j].trim();
        if (!nextLine) continue;
        const match = nextLine.match(/^([0-9.,]+)/);
        if (match && match[1]) {
          const cleaned = match[1].replace(/[.,]/g, '');
          const num = parseInt(cleaned, 10);
          if (!isNaN(num)) return num;
        }
        break; // Stop at first non-empty line
      }
    }
  }

  return null;
}

/**
 * Parses git diff --shortstat output into structured metrics.
 * Example output: " 3 files changed, 14 insertions(+), 2 deletions(-)"
 */
export function parseShortstat(output: string): {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
} {
  if (!output) return { filesChanged: 0, linesAdded: 0, linesDeleted: 0 };
  const filesMatch = output.match(/(\d+)\s+files?\s+changed/i);
  const insertionsMatch = output.match(/(\d+)\s+insertions?\s*\(\+\)/i);
  const deletionsMatch = output.match(/(\d+)\s+deletions?\s*\(-\)/i);

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
    linesDeleted: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
  };
}

/**
 * Measures line changes between baseRef and branch in the project root git repository.
 * Returns null if the branch does not exist or if git diff fails, so caller can preserve existing metrics.
 */
export async function measureTaskLines(
  projectPath: string,
  baseRef: string,
  branch: string,
): Promise<{ filesChanged: number; linesAdded: number; linesDeleted: number } | null> {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return null;
  }

  // Check if branch exists
  let branchFound = false;
  try {
    const branchRef = branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
    await execFileAsync('git', ['-C', projectPath, 'rev-parse', '--verify', '--quiet', branchRef], { timeout: 5000 });
    branchFound = true;
  } catch {
    try {
      await execFileAsync('git', ['-C', projectPath, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { timeout: 5000 });
      branchFound = true;
    } catch {
      branchFound = false;
    }
  }

  if (!branchFound) {
    return null;
  }

  // Execute git diff --shortstat
  let stdout = '';
  try {
    const res = await execFileAsync(
      'git',
      ['-C', projectPath, 'diff', '--shortstat', `${baseRef}...${branch}`],
      { timeout: 15_000 },
    );
    stdout = res.stdout;
  } catch {
    try {
      const res = await execFileAsync(
        'git',
        ['-C', projectPath, 'diff', '--shortstat', `origin/${baseRef}...${branch}`],
        { timeout: 15_000 },
      );
      stdout = res.stdout;
    } catch {
      return null;
    }
  }

  return parseShortstat(stdout);
}

/**
 * Recalculates lines added/deleted for a task using the project git repository.
 * If the branch no longer exists, preserves existing numbers and returns null.
 */
export async function recalculateTaskLines(
  taskRepo: TaskRepo,
  projectRepo: ProjectRepo,
  runRepo: RunRepo,
  runMetricsRepo: RunMetricsRepo,
  taskId: string,
): Promise<{ filesChanged: number; linesAdded: number; linesDeleted: number } | null> {
  const task = taskRepo.get(taskId);
  if (!task) return null;

  // Archived projects retain task history and git statistics.
  const project = projectRepo.getIncludingArchived(task.projectId);
  if (!project || !project.path) return null;

  const baseRef = task.baseRef || project.defaultBranch || 'main';
  const branch = task.branch || `agenthub/${task.slug}`;

  const stats = await measureTaskLines(project.path, baseRef, branch);
  if (stats === null) {
    return null;
  }

  try {
    const runs = runRepo.getByTask(taskId);
    const targetRun = runs[runs.length - 1];
    if (targetRun) {
      const existing = runMetricsRepo.get(targetRun.id);
      if (existing) {
        runMetricsRepo.updateLines(targetRun.id, stats.linesAdded, stats.linesDeleted, stats.filesChanged);
      } else {
        runMetricsRepo.upsert({
          runId: targetRun.id,
          taskId: task.id,
          engine: targetRun.engine,
          model: targetRun.model,
          profileName: targetRun.profileName,
          tokensUsed: null,
          usageBefore: null,
          usageAfter: null,
          linesAdded: stats.linesAdded,
          linesDeleted: stats.linesDeleted,
          filesChanged: stats.filesChanged,
          durationMs: null,
        });
      }
      runMetricsRepo.clearOtherRunsLines(taskId, targetRun.id);
    }
  } catch (error) {
    console.warn('[savings] recalculateTaskLines failed:', error);
    return null;
  }

  return stats;
}

/**
 * Calculates estimated tokens for agy based on quota percentage drop and bucket tokens.
 * Formula: (usageBefore - usageAfter)% * bucketTokens / concurrentRunsCount
 * If difference <= 0 or concurrent runs > 1, marked as estimated: true.
 */
export function calculateAgyTokens(opts: {
  usageBefore: number | null;
  usageAfter: number | null;
  bucketTokens: number;
  concurrentRunsCount?: number;
  concurrentRuns?: number;
}): { tokens: number; estimated: boolean } {
  const concurrent = Math.max(1, opts.concurrentRunsCount || opts.concurrentRuns || 1);
  if (opts.usageBefore == null || opts.usageAfter == null) {
    return { tokens: 0, estimated: true };
  }

  const diff = opts.usageBefore - opts.usageAfter;
  if (diff <= 0) {
    return { tokens: 0, estimated: true };
  }

  const rawTokens = (diff / 100) * opts.bucketTokens;
  const tokens = Math.round(rawTokens / concurrent);
  const estimated = concurrent > 1;
  return { tokens, estimated };
}

/**
 * Calculates ratio of savings = saved / (saved + cost).
 * Returns 0 if total is 0.
 */
export function calculateSavingsRatio(claudeSavedTokens: number, claudeCostTokens: number): number {
  const total = claudeSavedTokens + claudeCostTokens;
  if (total <= 0) return 0;
  return claudeSavedTokens / total;
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
  profileName?: string | null;
}

export interface SavingsDailyItem {
  date: string;
  geminiTokens: number;
  codexTokens: number;
  totalTokens: number;
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

export interface SavingsReport {
  summary: SavingsSummary;
  byEngine: Record<string, { tokens: number; taskCount: number }>;
  byModel: Record<string, { tokens: number; taskCount: number }>;
  byDay: SavingsDailyItem[];
  tasks: SavingsTaskItem[];
  tasksTotal: number;
  tasksNextCursor: string | null;
}

export class SavingsService {
  constructor(
    private config: AgentHubConfig,
    private taskRepo: TaskRepo,
    private runRepo: RunRepo,
    private runMetricsRepo: RunMetricsRepo,
    private reviewRepo: ReviewRepo,
    private profileRepo: ProfileRepo,
    private projectRepo: ProjectRepo,
    private claudeSessionRepo?: ClaudeSessionRepo,
  ) {}

  /**
   * Calculates the number of overlapping concurrent runs on the same account (same profile or same email).
   */
  getConcurrentRunsCount(targetRun: RunRow, allRuns?: RunRow[]): number {
    // Runs on profiles that share the same provider account (engine + email) compete for quota.
    const targetProfile = this.profileRepo.get(targetRun.profileName);
    const sameAccountProfiles = new Set<string>([targetRun.profileName]);
    if (targetProfile) {
      for (const p of this.profileRepo.getAll()) {
        if (sameAccount(p, targetProfile)) sameAccountProfiles.add(p.name);
      }
    }

    const tStart = targetRun.startedAt ? Date.parse(targetRun.startedAt) : 0;
    const tEnd = targetRun.endedAt ? Date.parse(targetRun.endedAt) : Date.now();
    if (!tStart) return 1;

    // Callers computing many runs pass the run list once; loading it per run was O(runs x tasks).
    const runs = allRuns ?? this.taskRepo.getAll().flatMap((t) => this.runRepo.getByTask(t.id));
    let concurrent = 1;
    for (const r of runs) {
      if (r.id === targetRun.id) continue;
      if (!sameAccountProfiles.has(r.profileName)) continue;
      const rStart = r.startedAt ? Date.parse(r.startedAt) : 0;
      const rEnd = r.endedAt ? Date.parse(r.endedAt) : Date.now();
      if (!rStart) continue;
      // Overlap condition: rStart <= tEnd && tStart <= rEnd
      if (rStart <= tEnd && tStart <= rEnd) concurrent++;
    }
    return concurrent;
  }


  /**
   * Generates the savings report, optionally filtered by project and date.
   */
  getSavings(query?: { project?: string; since?: string; limit?: string | number; offset?: string | number; cursor?: string }): SavingsReport {
    // Load each history table once. The savings endpoint is a dashboard hot path and
    // repeatedly querying runs/metrics/reviews per task becomes quadratic at scale.
    const allTasks = this.taskRepo.getAll();
    const allRunsForConcurrency = this.runRepo.getAll();
    const runsByTask = new Map<string, RunRow[]>();
    for (const run of allRunsForConcurrency) {
      const runs = runsByTask.get(run.taskId) || [];
      runs.push(run);
      runsByTask.set(run.taskId, runs);
    }
    const metricsByTask = new Map<string, RunMetricsRow[]>();
    for (const metric of this.runMetricsRepo.getAll()) {
      const metrics = metricsByTask.get(metric.taskId) || [];
      metrics.push(metric);
      metricsByTask.set(metric.taskId, metrics);
    }
    const reviewsByTask = new Map<string, ReturnType<ReviewRepo['getAll']>>();
    for (const review of this.reviewRepo.getAll()) {
      const reviews = reviewsByTask.get(review.taskId) || [];
      reviews.push(review);
      reviewsByTask.set(review.taskId, reviews);
    }
    let tasks = allTasks;
    if (query?.project) {
      tasks = tasks.filter((t) => t.projectId === query.project);
    }

    const sinceEpoch = query?.since ? Date.parse(query.since) : NaN;
    if (!isNaN(sinceEpoch)) {
      tasks = tasks.filter((t) => {
        const tDate = Date.parse(t.updatedAt || t.createdAt);
        return !isNaN(tDate) && tDate >= sinceEpoch;
      });
    }

    const bucketTokensGemini =
      this.config.savings?.bucketTokens?.gemini ?? 5_000_000;
    const bucketTokensClaude =
      this.config.savings?.bucketTokens?.claude ?? 5_000_000;
    const claudeFactor = this.config.savings?.claudeFactor ?? 0.9;
    const claudeOverheadPerTask =
      this.config.savings?.claudeOverheadPerTask ?? 40_000;

    const taskItems: SavingsTaskItem[] = [];
    let totalWorkerTokens = 0;
    let claudeSavedTokens = 0;
    let claudeCostTokens = 0;
    let totalLinesAdded = 0;
    let totalLinesDeleted = 0;
    let tasksApprovedCount = 0;
    let totalReviewRoundsForDoneTasks = 0;

    const byEngine: Record<string, { tokens: number; taskCount: number }> = {
      agy: { tokens: 0, taskCount: 0 },
      codex: { tokens: 0, taskCount: 0 },
    };
    const byModel: Record<string, { tokens: number; taskCount: number }> = {};
    const byDayMap: Map<string, { geminiTokens: number; codexTokens: number }> = new Map();

    for (const task of tasks) {
      const runs = runsByTask.get(task.id) || [];
      const metricsList = metricsByTask.get(task.id) || [];
      const reviews = reviewsByTask.get(task.id) || [];
      const reviewRounds = reviews.filter((r) => r.verdict === 'changes_requested').length;

      let taskTokens = 0;
      let taskEstimated = false;
      let taskLinesAdded = 0;
      let taskLinesDeleted = 0;
      let taskFilesChanged = 0;
      let taskDurationMs = 0;
      let lastModel = '';
      let lastEngine = '';
      let lastProfile: string | null = null;
      let completedAt: string | null = null;
      const measured = this.claudeSessionRepo?.taskCost(task.id);

      for (const run of runs) {
        lastModel = run.model || lastModel;
        lastEngine = run.engine || lastEngine;
        lastProfile = run.profileName || lastProfile;
        if (run.outcome === 'done' && run.endedAt) {
          completedAt = run.endedAt;
        }

        const metrics = metricsList.find((m) => m.runId === run.id);
        const engine = run.engine || (metrics?.engine ?? 'agy');
        const model = run.model || (metrics?.model ?? '');

        let runTokens = 0;
        let isEstimated = false;

        if (engine === 'codex') {
          if (metrics?.tokensUsed != null) {
            runTokens = metrics.tokensUsed;
            isEstimated = false;
          } else {
            runTokens = 0;
            isEstimated = true;
          }
        } else {
          // agy
          const family = getModelFamily(model);
          const bucketTokens =
            family === 'gemini' ? bucketTokensGemini : bucketTokensClaude;
          const concurrent = this.getConcurrentRunsCount(run, allRunsForConcurrency);
          const agyCalc = calculateAgyTokens({
            usageBefore: metrics?.usageBefore ?? null,
            usageAfter: metrics?.usageAfter ?? null,
            bucketTokens,
            concurrentRunsCount: concurrent,
          });
          runTokens = agyCalc.tokens;
          isEstimated = agyCalc.estimated;
        }

        taskTokens += runTokens;
        if (isEstimated) taskEstimated = true;

        if (metrics) {
          taskLinesAdded += metrics.linesAdded || 0;
          taskLinesDeleted += metrics.linesDeleted || 0;
          taskFilesChanged += metrics.filesChanged || 0;
          taskDurationMs += metrics.durationMs || 0;
        } else if (run.startedAt && run.endedAt) {
          taskDurationMs += Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
        }

        // Daily grouping
        const dateStr = (run.endedAt || run.startedAt || task.createdAt).slice(0, 10);
        if (dateStr) {
          if (!byDayMap.has(dateStr)) {
            byDayMap.set(dateStr, { geminiTokens: 0, codexTokens: 0 });
          }
          const dayEntry = byDayMap.get(dateStr)!;
          if (engine === 'codex') {
            dayEntry.codexTokens += runTokens;
          } else {
            dayEntry.geminiTokens += runTokens;
          }
        }
      }

      totalLinesAdded += taskLinesAdded;
      totalLinesDeleted += taskLinesDeleted;

      // Update engine and model stats
      if (lastEngine) {
        if (!byEngine[lastEngine]) {
          byEngine[lastEngine] = { tokens: 0, taskCount: 0 };
        }
        byEngine[lastEngine].tokens += taskTokens;
        byEngine[lastEngine].taskCount += 1;
      }
      if (lastModel) {
        if (!byModel[lastModel]) {
          byModel[lastModel] = { tokens: 0, taskCount: 0 };
        }
        byModel[lastModel].tokens += taskTokens;
        byModel[lastModel].taskCount += 1;
      }

      totalWorkerTokens += taskTokens;

      // Only done tasks contribute to savings & cost
      if (task.status === 'done' || task.status === 'pushed') {
        tasksApprovedCount += 1;
        totalReviewRoundsForDoneTasks += reviewRounds;
        claudeSavedTokens += Math.round(taskTokens * claudeFactor);
        const taskClaudeCost = measured && measured.effectiveTokens > 0
          ? measured.effectiveTokens
          : claudeOverheadPerTask * (1 + reviewRounds);
        claudeCostTokens += taskClaudeCost;
      }


      taskItems.push({
        taskId: task.id,
        slug: task.slug,
        title: task.title,
        projectId: task.projectId,
        status: task.status,
        model: lastModel || (task.level === 'hard' ? 'gemini-3.8-flash-high' : 'gemini-3.8-flash-medium'),
        engine: lastEngine || 'agy',
        profileName: lastProfile,
        linesAdded: taskLinesAdded,
        linesDeleted: taskLinesDeleted,
        filesChanged: taskFilesChanged,
        tokens: taskTokens,
        estimated: taskEstimated,
        reviewRounds,
        durationMs: taskDurationMs,
        completedAt,
        claudeCostSource: measured && measured.effectiveTokens > 0 ? 'measured' : 'estimated',
        claudeEffectiveTokens: measured?.effectiveTokens || 0,
      });
    }

    const general = this.claudeSessionRepo?.taskCost('_general');
    if (general && general.effectiveTokens > 0) claudeCostTokens += general.effectiveTokens;

    const savingsRatio = calculateSavingsRatio(claudeSavedTokens, claudeCostTokens);
    const avgReviewRounds =
      tasksApprovedCount > 0
        ? totalReviewRoundsForDoneTasks / tasksApprovedCount
        : 0;

    // Convert daily map to sorted array
    const byDay: SavingsDailyItem[] = Array.from(byDayMap.entries())
      .map(([date, counts]) => ({
        date,
        geminiTokens: counts.geminiTokens,
        codexTokens: counts.codexTokens,
        totalTokens: counts.geminiTokens + counts.codexTokens,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Keep offset pages stable while new runs/tasks are written.
    taskItems.sort((left, right) => left.taskId.localeCompare(right.taskId));
    const cursor = decodeCursor(query?.cursor);
    if (query?.cursor && !cursor) throw new Error('Invalid pagination cursor');
    const cursorIndex = cursor ? taskItems.findIndex((task) => task.taskId === cursor.id) + 1 : -1;
    const requestedLimit = query?.limit === undefined ? taskItems.length : Math.max(1, Math.min(100, Number(query.limit) || 20));
    const requestedOffset = cursorIndex > 0 ? cursorIndex : Math.max(0, Number(query?.offset) || 0);
    const pageItems = taskItems.slice(requestedOffset, requestedOffset + requestedLimit);
    return {
      summary: {
        totalWorkerTokens,
        claudeSavedTokens,
        claudeCostTokens,
        savingsRatio,
        totalLinesAdded,
        totalLinesDeleted,
        totalLinesChanged: totalLinesAdded + totalLinesDeleted,
        tasksApprovedCount,
        avgReviewRounds,
      },
      byEngine,
      byModel,
      byDay,
      tasks: pageItems,
      tasksTotal: taskItems.length,
      tasksNextCursor: requestedOffset + requestedLimit < taskItems.length && pageItems.length > 0
        ? encodeCursor('', pageItems[pageItems.length - 1].taskId)
        : null,
    };
  }

  async recalculateTaskLines(taskId: string): Promise<{ filesChanged: number; linesAdded: number; linesDeleted: number } | null> {
    return recalculateTaskLines(
      this.taskRepo,
      this.projectRepo,
      this.runRepo,
      this.runMetricsRepo,
      taskId,
    );
  }

  async backfillLines(projectId?: string): Promise<{
    updated: { taskId: string; linesAdded: number; linesDeleted: number; filesChanged: number }[];
    skipped: { taskId: string; reason: string }[];
  }> {
    let tasks = this.taskRepo.getAll();
    if (projectId) {
      tasks = tasks.filter((t) => t.projectId === projectId);
    }

    const updated: { taskId: string; linesAdded: number; linesDeleted: number; filesChanged: number }[] = [];
    const skipped: { taskId: string; reason: string }[] = [];

    for (const task of tasks) {
      const stats = await this.recalculateTaskLines(task.id);
      if (stats !== null) {
        updated.push({ taskId: task.id, ...stats });
      } else {
        skipped.push({ taskId: task.id, reason: 'branch_not_found_or_no_project' });
      }
    }

    return { updated, skipped };
  }
}
