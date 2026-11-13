import type Database from 'better-sqlite3';
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

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      void this.runSweep();
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
              try {
                void scheduler.runChecksForTask(task.id, lastWorker.id, true);
              } catch {
                // best effort self-repair
              }
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
          if (scheduler.isReviewOrphanEligible(task)) {
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
      // Task queued > queuedStarvedMin, no pending deps, no waitReason, no future notBefore, project not paused, slot capacity available
      const queuedTasks = taskRepo.getByStatus('queued');
      for (const task of queuedTasks) {
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

      // 4. running_no_progress
      // Worker running > runningNoProgressMin, no new commits and no changed files in worktree
      const runningTasks = taskRepo.getByStatus('running');
      for (const task of runningTasks) {
        const rt = scheduler.getRunningTask(task.id);
        if (!rt) continue;

        const elapsedMs = Math.max(0, now - rt.startTime);
        const runningMinutes = Math.floor(elapsedMs / 60_000);
        if (runningMinutes < rules.runningNoProgressMin) continue;

        const noCommitMinutes = rt.noCommitMinutes ?? runningMinutes;
        if (noCommitMinutes < rules.runningNoProgressMin) continue;

        let worktreeChanged = false;
        if (rt.cachedWorktreeMtime > rt.startTime) {
          worktreeChanged = true;
        } else if (task.worktreePath && fs.existsSync(task.worktreePath)) {
          try {
            const gitIndex = path.join(task.worktreePath, '.git', 'index');
            if (fs.existsSync(gitIndex)) {
              const stat = fs.statSync(gitIndex);
              if (stat.mtimeMs > rt.startTime) {
                worktreeChanged = true;
              }
            }
          } catch {
            // ignore stat error
          }
        }
        if (worktreeChanged) continue;

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
            const p = e.payload ? (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload) : {};
            return p?.reason === 'quota_retry';
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
        if (isPidAlive(run.pid)) continue;

        const task = taskRepo.get(run.taskId);
        const projectId = task?.projectId || run.taskId.split('/')[0] || '';
        const currentStatus = task?.status || 'unknown';

        const startedAt = parseDbTime(run.startedAt);
        const sinceMinutes = Math.floor(Math.max(0, now - startedAt) / 60_000);

        if (shouldEmitWithCooldown(cooldownRepo, run.taskId, 'stale_run', currentStatus, now, cooldownMinutes)) {
          cooldownRepo.set(run.taskId, 'stale_run', new Date(now).toISOString(), currentStatus);

          // Self repair: finish run and requeue task
          runRepo.finish(run.id, 'crashed', undefined, 'stale_run_sweep');
          if (task && !['done', 'pushed', 'cancelled'].includes(task.status)) {
            taskRepo.update(task.id, { status: 'queued', resume: 1 });
            eventBus.emit('task.queued', task.id, { reason: 'stale_run_sweep' });
          }

          const evidence = collectEvidence(db, run.taskId, task, runRepo, reviewRepo);
          const issue: HealthIssue = {
            rule: 'stale_run',
            taskId: run.taskId,
            projectId,
            status: currentStatus,
            sinceMinutes,
            evidence,
            suggestion: 'Run trong DB bị mồ côi (pid không tồn tại và không nằm trong running); sweep đã đánh dấu crashed và requeue task.',
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
