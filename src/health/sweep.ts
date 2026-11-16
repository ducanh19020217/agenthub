import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HealthSweepConfig } from '../config.js';
import {
  type TaskRepo,
  type RunRepo,
  type ProjectRepo,
  type ReviewRepo,
  type EventRepo,
  type HealthIssueCooldownRepo,
  type TaskRow,
  type RunRow,
} from '../db/index.js';
import { parseDbTime } from '../db/time.js';
import { getCheckResults } from '../checks.js';
import { renderTaskBranch } from '../commit-convention.js';
import type { Scheduler, EventBus } from '../scheduler/index.js';

export type HealthRule =
  | 'checking_orphan'
  | 'review_orphan'
  | 'queued_starved'
  | 'running_no_progress'
  | 'churn'
  | 'failover_churn'
  | 'stale_run';

export interface HealthIssueEvidence {
  workerRuns: number;
  lastReview?: {
    verdict?: string;
    actor?: string;
    createdAt?: string;
  } | null;
  lastFailedCheck?: {
    name: string;
    timeout?: boolean;
    failed?: boolean;
    exitCode?: number | null;
  } | null;
  lastReviewFeedback?: string | null;
  lastProfile?: string | null;
  lastModel?: string | null;
}

export interface HealthIssue {
  rule: HealthRule;
  taskId: string;
  projectId: string;
  status: string;
  sinceMinutes: number;
  evidence: HealthIssueEvidence;
  suggestion: string;
}

export interface HealthSweepResult {
  timestamp: string | null;
  issues: HealthIssue[];
}

export interface HealthSweepServiceOptions {
  db: Database.Database;
  taskRepo: TaskRepo;
  runRepo: RunRepo;
  projectRepo: ProjectRepo;
  reviewRepo: ReviewRepo;
  eventRepo: EventRepo;
  cooldownRepo: HealthIssueCooldownRepo;
  scheduler: Scheduler;
  eventBus: EventBus;
  getConfig: () => HealthSweepConfig;
  now?: () => number;
}

function collectEvidence(
  db: Database.Database,
  taskId: string,
  task: TaskRow | undefined,
  runRepo: RunRepo,
  reviewRepo: ReviewRepo,
): HealthIssueEvidence {
  const workerRuns = runRepo.getByTask(taskId).filter((r) => r.kind === 'worker');
  const workerCount = Math.max(workerRuns.length, task?.runCount || 0);

  const reviews = reviewRepo.getByTask(taskId);
  const lastRev = reviews.at(-1);
  const lastReview = lastRev
    ? {
        verdict: lastRev.verdict,
        actor: lastRev.actor,
        createdAt: lastRev.createdAt,
      }
    : null;
  const lastReviewFeedback = lastRev?.feedback ? lastRev.feedback.slice(0, 1500) : null;

  let lastFailedCheck: HealthIssueEvidence['lastFailedCheck'] = null;
  try {
    const checks = getCheckResults(db, taskId);
    const failed = checks.filter((c) => !c.ok).at(-1);
    if (failed) {
      const isTimeout =
        failed.exitCode === 124 ||
        failed.durationMs >= 300_000 ||
        failed.outputTail?.toLowerCase().includes('timed out') ||
        false;
      lastFailedCheck = {
        name: failed.name,
        timeout: isTimeout,
        failed: true,
        exitCode: failed.exitCode,
      };
    }
  } catch {
    // ignore
  }

  const lastRun = runRepo.getByTask(taskId).at(-1);

  return {
    workerRuns: workerCount,
    lastReview,
    lastFailedCheck,
    lastReviewFeedback,
    lastProfile: lastRun?.profileName || null,
    lastModel: lastRun?.model || null,
  };
}

function shouldEmitWithCooldown(
  cooldownRepo: HealthIssueCooldownRepo,
  taskId: string,
  rule: HealthRule,
  currentStatus: string,
  now: number,
  cooldownMinutes: number,
): boolean {
  const existing = cooldownRepo.get(taskId, rule);
  if (!existing) return true;

  // Nếu trạng thái task thay đổi rồi lại vi phạm: cooldown được bỏ qua / phát lại
  if (existing.taskStatus !== currentStatus) {
    return true;
  }

  // Cùng trạng thái: kiểm tra cooldownMinutes
  const lastAt = parseDbTime(existing.lastEmittedAt);
  const elapsed = Math.max(0, now - lastAt);
  return elapsed >= cooldownMinutes * 60 * 1000;
}

export class HealthSweepService {
  private timer?: NodeJS.Timeout;
  private lastResult: HealthSweepResult = { timestamp: null, issues: [] };
  private isSweepRunning = false;
  private readonly now: () => number;

  constructor(private readonly opts: HealthSweepServiceOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    const intervalMinutes = this.opts.getConfig().intervalMinutes || 10;
    const intervalMs = Math.max(1, intervalMinutes) * 60_000;
    this.timer = setInterval(() => {
      this.runSweep().catch((error) => {
        console.error('[health] periodic sweep failed:', error);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStatus(): HealthSweepResult {
    return this.lastResult;
  }

  async runSweep(overrideNow?: number): Promise<HealthSweepResult> {
    if (this.isSweepRunning) return this.lastResult;
    this.isSweepRunning = true;

    try {
      if (this.opts.scheduler.isDraining() || this.opts.scheduler.isStopped()) {
        return this.lastResult;
      }

      const config = this.opts.getConfig();
      if (config.enabled === false) {
        return this.lastResult;
      }

      const now = overrideNow ?? this.now();
      const rules = config.rules;
      const cooldownMinutes = config.cooldownMinutes || 120;
      const issues: HealthIssue[] = [];

      const {
        db,
        taskRepo,
        runRepo,
        projectRepo,
        reviewRepo,
        eventRepo,
        cooldownRepo,
        scheduler,
        eventBus,
      } = this.opts;

      // Helper to record cooldown and emit issue
      const emitIssue = (
        rule: HealthRule,
        task: TaskRow,
        sinceMinutes: number,
        suggestion: string,
      ) => {
        if (!shouldEmitWithCooldown(cooldownRepo, task.id, rule, task.status, now, cooldownMinutes)) {
          return false;
        }

        cooldownRepo.set(task.id, rule, new Date(now).toISOString(), task.status);
        const evidence = collectEvidence(db, task.id, task, runRepo, reviewRepo);
        const issue: HealthIssue = {
          rule,
          taskId: task.id,
          projectId: task.projectId,
          status: task.status,
          sinceMinutes,
          evidence,
          suggestion,
        };

        eventBus.emit('task.health_issue', issue.taskId, issue);
        issues.push(issue);
        return true;
      };

      // 1. checking_orphan
      // Task checking > checkingOrphanMin, not in checkingActive/checkingQueue, no run running
      const checkingTasks = taskRepo.getByStatus('checking');
      for (const task of checkingTasks) {
        const statusTime = task.statusChangedAt ? parseDbTime(task.statusChangedAt) : parseDbTime(task.updatedAt);
        const sinceMinutes = Math.floor(Math.max(0, now - statusTime) / 60_000);
        if (sinceMinutes >= rules.checkingOrphanMin) {
          if (!scheduler.isChecking(task.id) && !scheduler.isRunning(task.id)) {
            // Self-repair: re-run check
            const lastWorker = runRepo
              .getByTask(task.id)
              .filter((r) => r.kind === 'worker' && r.outcome === 'done')
              .at(-1);
            if (lastWorker) {
              void scheduler
                .runChecksForTask(task.id, lastWorker.id, true)
                .catch((error) => {
                  console.error(`[health] self-repair check failed for ${task.id}:`, error);
                });
            }

            emitIssue(
              'checking_orphan',
              task,
              sinceMinutes,
              'Task kẹt ở trạng thái checking không có process chạy; sweep đã kích hoạt lại check.',
            );
          }
        }
      }

      // 2. review_orphan
      // Task review > reviewOrphanMin, auto review enabled, not waiting manual/gate, not running reviewer, not blocked by quota/backoff
      const reviewTasks = taskRepo.getByStatus('review');
      for (const task of reviewTasks) {
        const statusTime = task.statusChangedAt ? parseDbTime(task.statusChangedAt) : parseDbTime(task.updatedAt);
        const sinceMinutes = Math.floor(Math.max(0, now - statusTime) / 60_000);
        if (sinceMinutes >= rules.reviewOrphanMin) {
          if (!task.worktreePath) continue;
          if (scheduler.isReviewOrphanEligible(task, now)) {
            emitIssue(
              'review_orphan',
              task,
              sinceMinutes,
              'Task kẹt ở review không có reviewer tự động chạy; gợi ý dispatch review thủ công hoặc phân công reviewer.',
            );
          }
        }
      }

      // 3. queued_starved
      // Task queued > queuedStarvedMin, scheduler not paused, no pending deps, no waitReason, no future notBefore, project not paused, slot capacity available
      if (!scheduler.isPaused?.()) {
        const queuedTasks = taskRepo.getByStatus('queued');
        for (const task of queuedTasks) {
          if (scheduler.isPaused?.()) break;
          const statusTime = task.statusChangedAt ? parseDbTime(task.statusChangedAt) : parseDbTime(task.updatedAt);
          const sinceMinutes = Math.floor(Math.max(0, now - statusTime) / 60_000);
          if (sinceMinutes < rules.queuedStarvedMin) continue;
          if (task.waitReason) continue;
          if (task.notBefore != null && task.notBefore > Math.floor(now / 1000)) continue;

          let hasUnfinishedDep = false;
          if (task.dependsOn) {
            try {
              const deps = JSON.parse(task.dependsOn) as string[];
              for (const depId of deps) {
                const dep = taskRepo.get(depId);
                if (!dep || (dep.status !== 'done' && dep.status !== 'pushed')) {
                  hasUnfinishedDep = true;
                  break;
                }
              }
            } catch {
              // ignore JSON error
            }
          }
          if (hasUnfinishedDep) continue;

          const project = projectRepo.get(task.projectId);
          if (!project || project.archivedAt) continue;

          const focus = scheduler.getFocus();
          if (focus.projectId && focus.projectId !== project.id && focus.pauseRunning) continue;

          if (!scheduler.hasParallelCapacity(project)) continue;

          emitIssue(
            'queued_starved',
            task,
            sinceMinutes,
            'Task queued lâu dù có slot trống và không có dependency cản trở; gợi ý kiểm tra quota hoặc ép khởi chạy.',
          );
        }
      }

      // 4. running_no_progress
      // Worker running > runningNoProgressMin, not paused, no new commits and no changed files in worktree
      const runningTasks = taskRepo.getByStatus('running');
      for (const task of runningTasks) {
        const rt = scheduler.getRunningTask(task.id);
        if (!rt) continue;
        if (rt.paused) continue;

        const effectiveStartTime = rt.resumedAt ?? rt.startTime;
        const elapsedMs = Math.max(0, now - effectiveStartTime);
        const runningMinutes = Math.floor(elapsedMs / 60_000);
        if (runningMinutes < rules.runningNoProgressMin) continue;

        const progressWindowMs = rules.runningNoProgressMin * 60_000;
        const progressThreshold = now - progressWindowMs;

        // Check recent commits using watchdog data or actual commit time from git
        let latestCommitTime = effectiveStartTime;
        if (typeof rt.lastCommitAt === 'number') {
          latestCommitTime = rt.lastCommitAt;
        } else if (typeof rt.noCommitMinutes === 'number') {
          latestCommitTime = now - Math.max(0, rt.noCommitMinutes) * 60_000;
        } else if (task.worktreePath && fs.existsSync(task.worktreePath)) {
          try {
            const project = projectRepo.get(task.projectId);
            const baseRef = task.baseRef || project?.defaultBranch || 'main';
            let stdout = '';
            try {
              stdout = execFileSync('git', ['-C', task.worktreePath, 'log', '-1', '--format=%ct', `${baseRef}..HEAD`], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 5000,
              }).trim();
            } catch {
              const branch = task.branch || (project ? renderTaskBranch(project, task) : `agenthub/${task.slug}`);
              try {
                stdout = execFileSync('git', ['-C', task.worktreePath, 'log', '-1', '--format=%ct', `${baseRef}..${branch}`], {
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'ignore'],
                  timeout: 5000,
                }).trim();
              } catch {
                stdout = '';
              }
            }
            if (stdout) {
              const ts = parseInt(stdout, 10) * 1000;
              if (!isNaN(ts) && ts >= effectiveStartTime - 5000) {
                latestCommitTime = ts;
              }
            }
          } catch {
            // fallback to effectiveStartTime
          }
        }

        // Check recent changes in worktree or git index
        let latestWorktreeChange = rt.cachedWorktreeMtime || 0;
        if (task.worktreePath && fs.existsSync(task.worktreePath)) {
          try {
            let gitIndexPath = path.join(task.worktreePath, '.git', 'index');
            const dotGit = path.join(task.worktreePath, '.git');
            if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
              try {
                const gitPath = execFileSync('git', ['-C', task.worktreePath, 'rev-parse', '--git-path', 'index'], {
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'ignore'],
                  timeout: 5000,
                }).trim();
                if (gitPath) {
                  gitIndexPath = path.isAbsolute(gitPath) ? gitPath : path.join(task.worktreePath, gitPath);
                }
              } catch {
                try {
                  const content = fs.readFileSync(dotGit, 'utf8');
                  const match = content.match(/^gitdir:\s*(.+)$/m);
                  if (match) {
                    const gitDir = match[1].trim();
                    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(task.worktreePath, gitDir);
                    gitIndexPath = path.join(resolvedGitDir, 'index');
                  }
                } catch {
                  // ignore
                }
              }
            }
            if (fs.existsSync(gitIndexPath)) {
              const stat = fs.statSync(gitIndexPath);
              if (stat.mtimeMs > latestWorktreeChange) {
                latestWorktreeChange = stat.mtimeMs;
              }
            }
          } catch {
            // ignore stat error
          }
        }

        const latestProgressTime = Math.max(latestWorktreeChange, latestCommitTime);
        if (latestProgressTime >= progressThreshold) continue;

        emitIssue(
          'running_no_progress',
          task,
          runningMinutes,
          'Worker chạy lâu không commit và không đổi file trong worktree; gợi ý cancel hoặc can thiệp.',
        );
      }

      // 5. churn & 6. failover_churn on active tasks
      const activeTasks = taskRepo
        .getAll()
        .filter((t) => ['queued', 'running', 'checking', 'review', 'waiting_quota'].includes(t.status));

      for (const task of activeTasks) {
        const statusTime = task.statusChangedAt ? parseDbTime(task.statusChangedAt) : parseDbTime(task.updatedAt);
        const sinceMinutes = Math.floor(Math.max(0, now - statusTime) / 60_000);

        // 5. churn: worker runs >= churnWorkerRuns OR review.escalated >= churnEscalations
        const workerRuns = runRepo.getByTask(task.id).filter((r) => r.kind === 'worker');
        const workerCount = Math.max(workerRuns.length, task.runCount || 0);

        const taskEvents = eventRepo.getByTask(task.id);
        const escalations = taskEvents.filter((e) => e.type === 'review.escalated').length;

        if (workerCount >= rules.churnWorkerRuns || escalations >= rules.churnEscalations) {
          emitIssue(
            'churn',
            task,
            sinceMinutes,
            `Task trải qua nhiều lượt worker (${workerCount}) hoặc escalate (${escalations}) sửa đi sửa lại; gợi ý can thiệp, tách nhỏ task hoặc đổi model chain.`,
          );
        }

        // 6. failover_churn: task.failover or quota_retry >= failoverChurnCount in failoverChurnWindowMin
        const windowMs = rules.failoverChurnWindowMin * 60_000;
        const cutoff = now - windowMs;
        const failoverEvents = taskEvents.filter((e) => {
          const ts = parseDbTime(e.ts);
          if (ts < cutoff) return false;
          if (e.type === 'task.failover') return true;
          if (e.type === 'task.queued') {
            try {
              const p = e.payload ? (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload) : {};
              return p?.reason === 'quota_retry';
            } catch {
              return false;
            }
          }
          return false;
        });

        if (failoverEvents.length >= rules.failoverChurnCount) {
          emitIssue(
            'failover_churn',
            task,
            sinceMinutes,
            `Task liên tục bị failover/quota_retry (${failoverEvents.length} lần trong ${rules.failoverChurnWindowMin}m); gợi ý đổi model chain hoặc tạm dừng.`,
          );
        }
      }

      // 7. stale_run
      // Run in DB has outcome IS NULL but pid is not alive and not in scheduler.running
      const unendedRuns = db.prepare('SELECT * FROM runs WHERE outcome IS NULL').all() as RunRow[];
      for (const run of unendedRuns) {
        if (scheduler.isRunActive(run.id)) continue;

        const startedAt = parseDbTime(run.startedAt);
        const sinceMinutes = Math.floor(Math.max(0, now - startedAt) / 60_000);

        if (run.pid == null) {
          // Scheduler inserts runs before spawn then updates pid. Ignore newly created runs without PID
          // unless orphaned for >= 10 minutes and task is not running in scheduler.
          const PIDLESS_GRACE_MINUTES = 10;
          if (sinceMinutes < PIDLESS_GRACE_MINUTES) {
            continue;
          }
          if (scheduler.isRunning(run.taskId) || scheduler.isReviewing?.(run.taskId)) {
            continue;
          }
        } else {
          if (scheduler.isProcessAlive(run.pid, run.pidStart)) {
            continue;
          }
        }

        const task = taskRepo.get(run.taskId);
        const projectId = task?.projectId || run.taskId.split('/')[0] || '';
        const currentStatus = task?.status || 'unknown';

        // Self repair: finish run and requeue task if worker
        runRepo.finish(run.id, 'crashed', undefined, 'stale_run_sweep');
        if (run.kind === 'worker') {
          if (task && task.status === 'running') {
            taskRepo.update(task.id, { status: 'queued', resume: 1 });
            eventBus.emit('task.queued', task.id, { reason: 'stale_run_sweep' });
          }
        } else if (task && task.status === 'review') {
          scheduler.triggerTick?.();
        }

        const taskAfterRepair = taskRepo.get(run.taskId);
        const postRepairStatus = taskAfterRepair?.status || currentStatus;

        if (issues.some((i) => i.taskId === run.taskId && i.rule === 'stale_run')) {
          continue;
        }

        if (shouldEmitWithCooldown(cooldownRepo, run.taskId, 'stale_run', currentStatus, now, cooldownMinutes)) {
          cooldownRepo.set(run.taskId, 'stale_run', new Date(now).toISOString(), postRepairStatus);

          const evidence = collectEvidence(db, run.taskId, task, runRepo, reviewRepo);
          const issue: HealthIssue = {
            rule: 'stale_run',
            taskId: run.taskId,
            projectId,
            status: currentStatus,
            sinceMinutes,
            evidence,
            suggestion:
              run.kind === 'worker' && currentStatus === 'running'
                ? 'Run trong DB bị mồ côi (pid không tồn tại và không nằm trong running); sweep đã đánh dấu crashed và requeue task.'
                : run.kind !== 'worker' && currentStatus === 'review'
                  ? 'Run reviewer trong DB bị mồ côi (pid không tồn tại và không nằm trong running); sweep đã đánh dấu crashed và giữ task ở review để scheduler dispatch lại reviewer.'
                  : 'Run trong DB bị mồ côi (pid không tồn tại và không nằm trong running); sweep đã đánh dấu crashed.',
          };

          eventBus.emit('task.health_issue', issue.taskId, issue);
          issues.push(issue);
        }
      }

      this.lastResult = {
        timestamp: new Date(now).toISOString(),
        issues,
      };

      return this.lastResult;
    } finally {
      this.isSweepRunning = false;
    }
  }
}
