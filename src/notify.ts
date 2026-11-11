import { execFile } from 'node:child_process';
import path from 'node:path';
import { AgentHubConfig, updateConfigInMemory } from './config.js';
import { EventBus } from './scheduler/index.js';
import { QuotaMarkRepo, TaskRepo, ProfileRepo, CiRepo } from './db/index.js';
import { toTaskId } from './services/index.js';
import { isQuietHours, isSystemIncident, getMinutesSinceTime } from './brain/digest.js';
import { effectiveBrainMode } from './brain/mode.js';
import { formatReset } from './time-format.js';
import { quotaLowText } from './quota/alerts.js';
import { NotificationDeduper } from './notification-dedupe.js';
import { QuotaService, QuotaCapacitySnapshot } from './quota/index.js';
import { autoMergeReasonLabel, firstCheckError } from './auto-merge-notify.js';

const WAITING_QUOTA_BATCH_DELAY_MS = 100;

export type NotifyExecFn = (
  file: string,
  args: string[],
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface NotificationServiceOptions {
  eventBus: EventBus;
  config: AgentHubConfig;
  taskRepo?: TaskRepo;
  profileRepo?: ProfileRepo;
  quotaMarkRepo?: QuotaMarkRepo;
  quotaService?: QuotaService;
  projectRepo?: { get(id: string): { settings?: string | null } | undefined };
  ciRepo?: CiRepo;
  exec?: NotifyExecFn;
  now?: () => number;
}

export class NotificationService {
  private eventBus: EventBus;
  private config: AgentHubConfig;
  private taskRepo?: TaskRepo;
  private profileRepo?: ProfileRepo;
  private quotaMarkRepo?: QuotaMarkRepo;
  private quotaService?: QuotaService;
  private projectRepo?: NotificationServiceOptions['projectRepo'];
  private execFn?: NotifyExecFn;
  private now: () => number;
  private lastSent = new Map<string, number>();
  private lastSentCi = new Map<string, number>();
  private allQuotaNotified = new Set<string>();
  private quotaIncidentActive = false;
  private waitingQuotaNotified = false;
  private waitingQuotaCheckTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSentSummary = new Map<string, number>();
  private lastSentDisk = new Map<'low' | 'ok', number>();
  private diskState: 'low' | 'ok' | undefined;
  private diskBlockedNotified = false;
  private lastSentDiskBlocked = 0;
  private lastSentDiskBlockedByPath = new Map<string, number>();
  private readonly eventDeduper: NotificationDeduper;
  private boundHandler: ((type: string, taskId?: string, payload?: unknown) => void) | null = null;
  private quietHoursQueue: Array<{ type: string; taskId?: string; payload?: unknown; timestamp: number }> = [];
  private focusDigest = new Map<string, number>();
  private mergeConflictNotified = new Set<string>();
  private get appName(): string { return this.config.branding?.name || 'AgentHub'; }
  private checkTimer?: NodeJS.Timeout;

  constructor(opts: NotificationServiceOptions) {
    this.eventBus = opts.eventBus;
    this.config = opts.config;
    this.taskRepo = opts.taskRepo;
    this.profileRepo = opts.profileRepo;
    this.quotaMarkRepo = opts.quotaMarkRepo;
    this.quotaService = opts.quotaService || (opts.profileRepo && opts.quotaMarkRepo ? new QuotaService(opts.quotaMarkRepo, opts.profileRepo) : undefined);
    this.projectRepo = opts.projectRepo;
    this.execFn = opts.exec;
    this.now = opts.now || (() => Date.now());
    this.eventDeduper = new NotificationDeduper({ now: this.now });
  }

  private quotaCapacity(): QuotaCapacitySnapshot | null {
    if (!this.quotaService || !this.profileRepo || this.profileRepo.getAll().length === 0) return null;
    return this.quotaService.capacitySnapshot(undefined, Math.floor(this.now() / 1000));
  }

  private isAllQuotaExhausted(payload?: Record<string, unknown>, now = this.now(), defaultWhenNoProfiles = false): boolean {
    const snapshot = this.quotaCapacity();
    const hasProfiles = Boolean(this.profileRepo && this.profileRepo.getAll().length > 0);
    return snapshot
      ? snapshot.runnable.length === 0
      : (hasProfiles && this.quotaMarkRepo
          ? new QuotaService(this.quotaMarkRepo, this.profileRepo!).runnableCapacity(undefined, Math.floor(now / 1000)).length === 0
          : (defaultWhenNoProfiles ? Boolean(payload?.allExhausted !== false) : Boolean(payload?.allExhausted === true)));
  }

  private quotaRecoveryMessage(snapshot: QuotaCapacitySnapshot): string {
    const first = snapshot.runnable[0];
    return first ? `✅ Có quota trở lại: ${first.profileName}/${first.model}` : '✅ Có quota trở lại';
  }

  private quotaIncidentMessage(snapshot: QuotaCapacitySnapshot | null): string {
    const next = snapshot?.nextReset;
    const reset = next ? ` Sớm nhất có lại: ${next.profileName}/${next.model} lúc ${formatReset(next.at, this.now())}.` : '';
    return `🚨 Hết sạch quota ở mọi tài khoản và model — các task đang chờ quota.${reset}`;
  }

  getQuietHoursQueue(): Array<{ type: string; taskId?: string; payload?: unknown; timestamp: number }> {
    return [...this.quietHoursQueue];
  }

  flushQuietHoursQueue(): Array<{ type: string; taskId?: string; payload?: unknown; timestamp: number }> {
    const queue = [...this.quietHoursQueue];
    this.quietHoursQueue = [];
    return queue;
  }

  checkQuietHoursEnd(nowMs = this.now()): boolean {
    const qh = this.config.notifications?.quietHours;
    if (!qh || !qh.enabled) return false;

    const d = new Date(nowMs);
    const inQuiet = isQuietHours(qh, d);
    if (inQuiet) return false;

    if (this.quietHoursQueue.length === 0) return false;

    // Only flush/notify within ~2 hours window after quietHours.end
    const minsSinceEnd = getMinutesSinceTime(qh.end || '07:00', d);
    if (minsSinceEnd < 0 || minsSinceEnd > 120) {
      return false;
    }

    const count = this.quietHoursQueue.length;
    this.quietHoursQueue = [];
    this.notify(`${this.appName}: ${count} thông báo trong đêm`, 'normal');
    return true;
  }

  start(): void {
    if (this.boundHandler) return;
    this.boundHandler = (type: string, taskId?: string, payload?: unknown) => {
      this.handleEvent(type, taskId, payload);
    };
    this.eventBus.on('*', this.boundHandler);
    this.checkTimer = setInterval(() => {
      this.checkQuietHoursEnd();
      this.flushFocusDigest();
    }, 60_000);
    this.checkTimer.unref?.();
  }

  stop(): void {
    if (this.boundHandler) {
      this.eventBus.off('*', this.boundHandler);
      this.boundHandler = null;
    }
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    if (this.waitingQuotaCheckTimer) {
      clearTimeout(this.waitingQuotaCheckTimer);
      this.waitingQuotaCheckTimer = undefined;
    }
  }

  updateConfig(config: AgentHubConfig): void {
    this.config = config;
  }

  handleEvent(type: string, taskId?: string, payload?: unknown): void {
    if (type === 'config.updated') {
      if (payload && typeof payload === 'object') {
        updateConfigInMemory(this.config, payload as Parameters<typeof updateConfigInMemory>[1]);
      }
      return;
    }

    if (!this.config.notifications || this.config.notifications.desktop === false) {
      return;
    }
    // Hand-built integrations from older callers omit desktopLevel; retain their
    // previous behavior while loaded config always supplies the important default.
    const level = this.config.notifications.desktopLevel || 'all';
    if (level === 'off') return;
    if (level === 'important' && !new Set([
      'brain.notify', 'task.review_ready', 'task.failed', 'task.blocked', 'review.escalated',
      'review.auto_merge_skipped',
      'disk.low', 'disk.ok', 'disk.docker_low', 'quota.exhausted', 'claude.quota_exhausted', 'ci.failed', 'task.waiting_quota',
      'quota.cleared', 'remote_deploy.failed', 'remote_deploy.health_timeout',
      'merge.conflict', 'merge.failed',
    ]).has(type)) return;

    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

    if (type === 'merge.conflict') {
      const conflictCount = typeof p.conflictCount === 'number' ? p.conflictCount : undefined;
      const isRoutine = (conflictCount === undefined || conflictCount <= 3) && (
        p.autoRetried === true || (
          p.autoRetried === undefined &&
          (() => {
            if (!taskId || !this.taskRepo) return true;
            const task = this.taskRepo.get(taskId);
            return task && task.status !== 'cancelled';
          })()
        )
      );
      if (isRoutine) return;
    }

    if (type === 'merge.failed') {
      if (p.autoFixCreated === true) return;
      if (taskId && this.taskRepo?.getDerivedFrom(taskId).some((t) =>
        /-fix-merge(?:-\d+)?$/.test(t.slug) && !['done', 'pushed', 'cancelled', 'failed', 'blocked'].includes(t.status)
      )) {
        return;
      }
    }

    if (taskId && /-fix-merge(?:-\d+)?$/.test(taskId)) {
      const task = this.taskRepo?.get(taskId);
      if (!task || task.status === 'draft') return;
    }
    const notifyConfig = this.config.telegram?.notify;
    const notifyAllExhausted = notifyConfig?.quotaAllExhausted !== false;
    if (type === 'quota.cleared') {
      this.allQuotaNotified.delete('all');
      if (typeof p.family === 'string') this.allQuotaNotified.delete(p.family);
      for (const key of this.lastSent.keys()) {
        if (key.includes('Mọi tài khoản đều đã hết quota') || key.includes('Hết sạch quota')) {
          this.lastSent.delete(key);
        }
      }
      const snapshot = this.quotaCapacity();
      if (this.quotaIncidentActive) {
        this.quotaIncidentActive = false;
        if (snapshot && snapshot.runnable.length > 0) {
          this.notify(this.quotaRecoveryMessage(snapshot), 'normal');
        }
      }
    }
    if (type === 'task.waiting_quota' && p.reason === 'quota' && this.taskRepo) {
      this.queueWaitingQuotaCheck(notifyAllExhausted);
      return;
    }
    if ((type === 'quota.cleared' || type === 'task.queued') && this.taskRepo) this.queueWaitingQuotaCheck(notifyAllExhausted);
    if (!this.eventDeduper.shouldSend(type, taskId, payload)) return;

    if (type === 'quota.exhausted' || type === 'claude.quota_exhausted') {
      const snapshot = this.quotaCapacity();
      const isAllExhausted = this.isAllQuotaExhausted(p, this.now());

      const quotaKey = (typeof p.family === 'string' ? p.family : typeof p.model === 'string' ? p.model : '') || 'all';
      if (!isAllExhausted) {
        this.allQuotaNotified.delete(quotaKey);
        if (this.quotaIncidentActive) {
          this.quotaIncidentActive = false;
          if (snapshot && snapshot.runnable.length > 0) {
            this.notify(this.quotaRecoveryMessage(snapshot), 'normal');
          }
        }
        return;
      }
    }

    // 1. In brain auto mode: suppress raw task notifications
    const taskProjectId = taskId?.includes('/') ? taskId.slice(0, taskId.indexOf('/')) : typeof p.projectId === 'string' ? p.projectId : null;
    const focusProjectId = this.config.focus?.projectId;
    if (focusProjectId && taskProjectId && taskProjectId !== focusProjectId && this.isFocusDeferredEvent(type)) {
      this.focusDigest.set(taskProjectId, (this.focusDigest.get(taskProjectId) || 0) + 1);
      return;
    }
    const effectiveMode = effectiveBrainMode(taskProjectId, taskProjectId ? this.projectRepo?.get(taskProjectId) : null, this.config.brain);
    if (effectiveMode === 'auto') {
      const isSystemEvent =
        type === 'brain.notify' ||
        type === 'disk.low' ||
        type === 'disk.docker_low' ||
        type === 'claude.quota_exhausted' ||
        type === 'hub.restart_failed' ||
        type.startsWith('deploy.') ||
        type.startsWith('gitea.sync.') ||
        type === 'system.error' ||
        type === 'ci.failed' ||
        type === 'ci.passed' ||
        type === 'merge.conflict' ||
        type === 'merge.failed' ||
        type === 'task.pushed' ||
        type === 'task.push_failed' ||
        type === 'task.audit_failed' ||
        type.startsWith('remote_deploy.') ||
        type.startsWith('tracker.') ||
        type === 'quota.exhausted' ||
        (type === 'task.waiting_quota' && p.reason === 'no_department_profile');

      if (!isSystemEvent) {
        return;
      }
    }

    // 2. Quiet hours: only send level 'incident'
    const now = this.now();
    this.checkQuietHoursEnd(now);

    if (isQuietHours(this.config.notifications?.quietHours, new Date(now))) {
      const isIncident = isSystemIncident(type, payload, this.profileRepo, this.quotaMarkRepo, now);
      if (!isIncident) {
        if (type === 'merge.conflict') {
          if (!taskId || this.isMergeConflictNotified(taskId)) return;
          this.markMergeConflictNotified(taskId);
        }
        if (this.quietHoursQueue.length >= 200) {
          this.quietHoursQueue.shift();
        }
        this.quietHoursQueue.push({ type, taskId, payload, timestamp: now });
        return;
      }
    }

    switch (type) {
      case 'task.waiting_quota': {
        if (p.reason !== 'no_department_profile') break;
        const department = typeof p.departmentName === 'string' ? p.departmentName : 'phòng ban';
        const message = typeof p.message === 'string' ? p.message : `Gán tài khoản cho ${department} hoặc bỏ gán`;
        this.notify(`${this.appName}: task đang chờ vì phòng ${department} chưa có tài khoản được phép. ${message}`, 'critical');
        break;
      }
      case 'brain.notify': {
        const text = typeof p.text === 'string' ? p.text : '';
        if (!text) break;
        if (p.level === 'incident') {
          this.notify(`🚨 Sự cố ${this.appName}: ${text}`, 'critical');
        } else if (p.level === 'decision') {
          this.notify(`📌 Cần quyết định: ${text}`, 'normal');
        } else {
          this.notify(`ℹ️ ${this.appName}: ${text}`, 'normal');
        }
        break;
      }

      case 'decision.answered': {
        const answer = p.answer as string | undefined;
        const label = answer === 'agree' ? 'Đồng ý' : answer === 'reject' ? 'Không' : 'Phương án khác';
        const customText = typeof p.customAnswer === 'string' && p.customAnswer ? ` — ${p.customAnswer}` : '';
        this.notify(`Đã phản hồi quyết định: ${label}${customText}`, 'normal');
        break;
      }

      case 'batch.created': {
        const count = typeof p.taskCount === 'number' ? p.taskCount : 0;
        const who = typeof p.createdBy === 'string' && p.createdBy ? p.createdBy : 'Claude';
        const label = who.toLowerCase() === 'claude' ? 'Claude' : who;
        this.notify(`${label} đề xuất ${count} task, chờ bạn duyệt`, 'normal');
        break;
      }

      case 'task.review_ready': {
        const title = this.resolveTaskTitle(taskId, p);
        let msg = `${this.appName}: ${title} chờ review`;
        if ('checksPassed' in p) {
          msg += ` (${p.checksPassed ? '✓' : '✗'} checks)`;
        }
        this.notify(msg, 'normal');
        break;
      }

      case 'review.auto_merge_skipped': {
        const title = this.resolveTaskTitle(taskId, p);
        const checks = Array.isArray(p.checks) ? p.checks as Array<{ name?: string; ok?: boolean; outputTail?: string }> : [];
        const failed = checks.find((check) => !check.ok || check.outputTail);
        const detail = firstCheckError(failed?.outputTail) ? `\n${firstCheckError(failed?.outputTail)}` : '';
        const retryText = p.retried === true ? ' (đã chạy lại 1 lần)' : '';
        const reason = p.reason === 'checks_failed'
          ? `check \`${failed?.name || 'test'}\` đỏ${retryText}`
          : autoMergeReasonLabel(p.reason);
        this.notify(`✋ ${title} đã được duyệt nhưng chưa tự merge: ${reason}. Cần duyệt tay.${detail}`, 'critical');
        break;
      }

      case 'task.failed': {
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`${this.appName}: ${title} thất bại`, 'critical');
        break;
      }

      case 'task.blocked': {
        const title = this.resolveTaskTitle(taskId, p);
        const reason = typeof p.message === 'string' ? `: ${p.message}` : typeof p.reason === 'string' ? ` (${p.reason})` : '';
        this.notify(`${this.appName}: ${title} bị chặn${reason}`, 'normal');
        break;
      }

      case 'tracker.ticket_imported': {
        const ref = typeof p.displayId === 'string' ? p.displayId : 'ticket';
        this.notify(`${this.appName}: đã nhập ticket ${ref} thành task`, 'normal');
        break;
      }

      case 'tracker.comment': {
        const ref = typeof p.displayId === 'string' ? p.displayId : 'ticket';
        this.notify(`${this.appName}: ticket ${ref} có comment mới`, 'normal');
        break;
      }

      case 'tracker.poll_failed': {
        const source = typeof p.sourceId === 'string' ? p.sourceId : 'OpenProject';
        this.notify(`${this.appName}: đồng bộ ${source} thất bại`, 'critical');
        break;
      }

      case 'tracker.resolved': {
        this.notify(`${this.appName}: OpenProject ticket đã được resolve`, 'normal');
        break;
      }

      case 'tracker.review_requested': {
        this.notify(`${this.appName}: OpenProject ticket cần quyết định`, 'normal');
        break;
      }

      case 'tracker.triage_ready': {
        const ref = typeof p.displayId === 'string' ? p.displayId : 'ticket';
        const auto = p.autoDispatch === true ? ' (đã tự giao)' : '';
        this.notify(`${this.appName}: OpenProject ticket ${ref} đã phân tích, chờ quyết định${auto}`, 'normal');
        break;
      }

      case 'tracker.triage_invalid': {
        const ref = typeof p.displayId === 'string' ? p.displayId : 'ticket';
        const errors = Array.isArray(p.errors) ? `: ${p.errors.join('; ')}` : '';
        this.notify(`${this.appName}: phân tích OpenProject ${ref} không hợp lệ${errors}`, 'normal');
        break;
      }

      case 'tracker.writeback_failed': {
        const error = typeof p.error === 'string' ? `: ${p.error}` : '';
        this.notify(`${this.appName}: ghi ngược OpenProject thất bại${error}`, 'critical');
        break;
      }

      case 'tracker.timesheet.posted': {
        const rows = Array.isArray(p.entries) ? p.entries as Array<{ displayId?: string; subject?: string; hours?: number; rawHours?: number; estimateHours?: number }> : [];
        const skipped = Array.isArray(p.estimateSkipped) && p.estimateSkipped.length ? `; bỏ qua estimate: ${p.estimateSkipped.map((item: { displayId?: string; reason?: string }) => `[${item.displayId || '?'}] ${item.reason || ''}`).join(', ')}` : '';
        const missing = Array.isArray(p.withoutTicket) && p.withoutTicket.length ? `; chưa có ticket: ${p.withoutTicket.map((item: { taskId?: string; subject?: string }) => `${item.taskId || '?'} ${item.subject || ''}`).join(', ')}` : '';
        const stale = Array.isArray(p.missingFromDate) && p.missingFromDate.length ? `; ticket không còn trong ngày: ${p.missingFromDate.join(', ')}` : '';
        const minimum = p.overMinimum ? '; tổng vượt giờ do mức tối thiểu' : '';
        this.notify(`${this.appName}: đã ghi bảng giờ ${p.sourceId || 'OpenProject'} (${formatHours(p.hours)}h) ${rows.map((row) => `[${row.displayId || '?'}] ${row.subject || ''} — thực tế ${formatHours(row.hours)}h · estimate ${formatHours(row.estimateHours ?? row.rawHours ?? row.hours)}h`).join('; ')}${skipped}${missing}${stale}${minimum}`, 'normal');
        break;
      }
      case 'tracker.timesheet.failed': {
        const posted = Array.isArray(p.entries) ? p.entries as Array<{ displayId?: string; hours?: number }> : [];
        const partial = posted.length ? `; đã ghi được: ${posted.map((row) => `[${row.displayId || '?'}] ${formatHours(row.hours)}h`).join(', ')}` : '';
        const skipped = Array.isArray(p.estimateSkipped) && p.estimateSkipped.length ? `; bỏ qua estimate: ${p.estimateSkipped.map((item: { displayId?: string; reason?: string }) => `[${item.displayId || '?'}] ${item.reason || ''}`).join(', ')}` : '';
        this.notify(`${this.appName}: ghi bảng giờ thất bại${typeof p.error === 'string' ? `: ${p.error}` : ''}${partial}${skipped}`, 'critical');
        break;
      }

      case 'daily_report.created': {
        const source = typeof p.sourceId === 'string' ? p.sourceId : 'OpenProject';
        this.notify(`${this.appName}: đã tạo báo cáo ngày (${source})`, 'normal');
        break;
      }

      case 'daily_report.failed': {
        const source = typeof p.sourceId === 'string' ? p.sourceId : 'OpenProject';
        this.notify(`${this.appName}: tạo báo cáo ngày (${source}) thất bại`, 'critical');
        break;
      }

      case 'gitea.sync.started': {
        const source = typeof p.sourceBranch === 'string' ? p.sourceBranch : '';
        const target = typeof p.targetBranch === 'string' ? p.targetBranch : '';
        this.notify(`${this.appName}: bắt đầu đồng bộ Gitea ${source} → ${target}`, 'normal');
        break;
      }

      case 'gitea.sync.skipped': {
        const reason = typeof p.reason === 'string' ? p.reason : 'Không có commit mới';
        this.notify(`${this.appName}: bỏ qua đồng bộ Gitea: ${reason}`, 'normal');
        break;
      }

      case 'gitea.sync.succeeded': {
        const prNum = typeof p.prNumber === 'number' ? `PR #${p.prNumber}` : 'PR';
        const commit = typeof p.commit === 'string' ? ` (${p.commit.slice(0, 7)})` : '';
        this.notify(`${this.appName}: đồng bộ Gitea thành công: ${prNum}${commit}`, 'normal');
        break;
      }

      case 'gitea.sync.failed': {
        const err = typeof p.error === 'string' ? `: ${p.error}` : '';
        this.notify(`${this.appName}: đồng bộ Gitea thất bại${err}`, 'critical');
        break;
      }

      case 'gitea.sync.conflict': {
        const count = Array.isArray(p.conflictingFiles) ? ` (${p.conflictingFiles.length} file)` : '';
        this.notify(`${this.appName}: xung đột đồng bộ Gitea${count}: đã tạo task gỡ xung đột`, 'critical');
        break;
      }

      case 'task.paused':
      case 'load.task_paused': {
        this.notifyLoadSummary(now, p.reason === 'load' ? 'quá tải hệ thống' : 'yêu cầu tạm dừng');
        break;
      }

      case 'task.pause_reminder': {
        const title = this.resolveTaskTitle(taskId, p);
        const minutes = typeof p.pausedMinutes === 'number' ? p.pausedMinutes : 30;
        this.notify(`Nhắc nhở: Task ${title} đã tạm dừng hơn ${minutes} phút (máy không quá tải)`, 'normal');
        break;
      }

      case 'task.resumed':
      case 'load.task_resumed': {
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`Tiếp tục task ${title}`, 'normal');
        break;
      }

      case 'review.escalated': {
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`Cần người duyệt: ${title}`, 'normal');
        break;
      }

      case 'merge.conflict': {
        if (!taskId) break;
        if (this.isMergeConflictNotified(taskId)) break;
        this.markMergeConflictNotified(taskId);

        const count = typeof p.conflictCount === 'number' ? p.conflictCount : 1;
        const filesText = this.extractConflictFiles(p);
        this.notify(`⚠️ ${taskId} xung đột merge lần thứ ${count}, cần xem: ${filesText}`, 'critical');
        break;
      }

      case 'merge.failed': {
        if (p.autoFixCreated === true) break;
        if (taskId && this.taskRepo?.getDerivedFrom(taskId).some((t) =>
          /-fix-merge(?:-\d+)?$/.test(t.slug) && !['done', 'pushed', 'cancelled', 'failed', 'blocked'].includes(t.status)
        )) {
          break;
        }
        const message = typeof p.message === 'string' ? p.message : 'Lỗi khi merge tự động';
        const taskLabel = taskId || 'Task';
        const title = p.environment ? 'Lỗi môi trường khi tự động gộp' : 'Lỗi tự động gộp';
        this.notify(`${this.appName}: ${title}: ${taskLabel} - ${message}`, 'critical');
        break;
      }

      case 'disk.low': {
        this.diskState = 'low';
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 0;
        const isHubHomeLow = p.source === 'hub_home'
          || p.label === 'Ổ chứa dữ liệu hub (~/.agenthub)'
          || p.label === 'Dữ liệu hub (~/.agenthub)';

        let waitingTasks: Array<{ id: string; slug?: string; title?: string }> = [];
        if (Array.isArray(p.tasks)) {
          waitingTasks = p.tasks.map((item) => typeof item === 'string' ? { id: item, slug: item, title: item } : item as { id: string; slug?: string; title?: string });
        } else if (this.taskRepo) {
          waitingTasks = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'disk');
        }

        const isBlocking = isHubHomeLow || waitingTasks.length > 0 || p.isBlocking === true;

        if (isBlocking) {
          const diskKey = typeof p.path === 'string' && p.path ? path.resolve(p.path) : (typeof p.label === 'string' ? p.label : 'default');
          const lastSent = this.lastSentDiskBlockedByPath.get(diskKey) ?? 0;
          if (lastSent > 0 && now - lastSent < 60 * 60_000) break;
          this.diskBlockedNotified = true;
          this.lastSentDiskBlocked = now;
          this.lastSentDiskBlockedByPath.set(diskKey, now);
          this.lastSentDisk.set('low', now);

          const label = typeof p.label === 'string' && p.label ? p.label : 'Ổ đĩa';
          const pathStr = typeof p.path === 'string' && p.path ? ` (${p.path})` : '';
          const taskNames = waitingTasks.map((t) => t.slug || t.title || t.id).filter(Boolean);
          const taskListStr = taskNames.length > 0 ? ` ${taskNames.length} task đang phải chờ: ${taskNames.join(', ')}.` : '';

          const cacheDir = typeof p.cacheDir === 'string' && p.cacheDir ? p.cacheDir : this.config.cacheDir;
          const cacheBytes = typeof p.cacheBytes === 'number' ? p.cacheBytes : 0;
          const cacheGB = cacheBytes > 0
            ? `${(cacheBytes / (1024 ** 3)).toFixed(1)} GB`
            : typeof p.cacheGB === 'number' ? `${p.cacheGB} GB` : '';
          const cacheSuggestion = cacheDir
            ? ` Gợi ý: dọn thùng rác hoặc cache node_modules (${cacheDir}${cacheGB ? `, ${cacheGB}` : ''}).`
            : ' Gợi ý: dọn thùng rác hoặc cache node_modules.';

          this.notify(`💾 Hết dung lượng: ${label}${pathStr} còn ${freeGB} GB, cần ${minFreeGB} GB.${taskListStr}${cacheSuggestion}`, 'critical');
          break;
        }

        if (!this.shouldSendDisk('low', now)) break;
        const cacheDir = typeof p.cacheDir === 'string' ? ` Cache node_modules: ${p.cacheDir}.` : '';
        const largest = typeof p.largestCacheEntry === 'string'
          ? ` Bản lớn nhất: ${p.largestCacheEntry}${typeof p.largestCacheEntryBytes === 'number' ? ` (${(p.largestCacheEntryBytes / 1024 ** 3).toFixed(2)} GB)` : ''}.`
          : '';
        this.notify(`Ổ đĩa còn ${freeGB} GB (< ${minFreeGB} GB): tạm dừng khởi chạy task${cacheDir}${largest}`, 'normal');
        break;
      }

      case 'disk.ok': {
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 0;
        const resumedCount = typeof p.resumedCount === 'number'
          ? p.resumedCount
          : Array.isArray(p.tasks)
          ? p.tasks.length
          : 0;

        if (this.diskBlockedNotified) {
          this.lastSentDisk.set('ok', now);
          if (resumedCount > 0) {
            this.notify(`✅ Đã đủ dung lượng, ${resumedCount} task tiếp tục chạy`, 'critical');
          }
          if (typeof p.remainingCount === 'number' && p.remainingCount > 0) {
            if (typeof p.path === 'string' && p.path) {
              const resolved = path.resolve(p.path);
              this.lastSentDiskBlockedByPath.delete(resolved);
              for (const key of Array.from(this.lastSentDiskBlockedByPath.keys())) {
                if (key === resolved || key.startsWith(resolved + path.sep) || resolved.startsWith(key + path.sep)) {
                  this.lastSentDiskBlockedByPath.delete(key);
                }
              }
              for (const key of Array.from(this.lastSent.keys())) {
                if (key.includes(p.path) || key.includes(resolved)) {
                  this.lastSent.delete(key);
                }
              }
            }
            if (typeof p.label === 'string' && p.label) {
              this.lastSentDiskBlockedByPath.delete(p.label);
            }
            if (this.lastSentDiskBlockedByPath.size === 0) {
              this.diskBlockedNotified = false;
              this.diskState = 'ok';
            }
          } else {
            this.diskBlockedNotified = false;
            this.lastSentDiskBlockedByPath.clear();
            for (const key of Array.from(this.lastSent.keys())) {
              if (key.includes('💾 Hết dung lượng')) {
                this.lastSent.delete(key);
              }
            }
            this.diskState = 'ok';
          }
          break;
        }

        if (freeGB < minFreeGB + 1 || this.diskState !== 'low') break;
        if (!this.shouldSendDisk('ok', now)) break;
        this.diskState = 'ok';
        this.notify(`Ổ đĩa đã đủ chỗ (${freeGB} GB): tiếp tục chạy task`, 'normal');
        break;
      }

      case 'disk.docker_low': {
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 5;
        this.notify(`Ổ đĩa Docker còn ${freeGB} GB (< ${minFreeGB} GB): không chạy docker build/pull/compose up`, 'critical');
        break;
      }

      case 'quota.exhausted':
      case 'claude.quota_exhausted': {
        const quotaKey = (typeof p.family === 'string' ? p.family : typeof p.model === 'string' ? p.model : '') || 'all';
        const snapshot = this.quotaCapacity();
        if (!notifyAllExhausted || this.quotaIncidentActive) break;
        this.allQuotaNotified.add(quotaKey);
        this.quotaIncidentActive = true;
        this.notify(this.quotaIncidentMessage(snapshot), 'critical');
        break;
      }

      case 'quota.low': {
        this.notify(quotaLowText(p), 'normal');
        break;
      }

      case 'claude.fallback_changed': {
        const step = p.step && typeof p.step === 'object' ? p.step as Record<string, unknown> : null;
        if (p.fallbackAvailable === true || (step && step.type !== 'wait')) break;
        if (!this.isAllQuotaExhausted(p, this.now(), true)) break;
        const label = step?.type === 'model' ? `model ${String(step.model)}`
          : step?.type === 'profile' ? `tài khoản ${String(step.profile || 'khác')}`
          : step?.type === 'apiKey' ? 'API key'
          : step?.type === 'engine' ? `engine ${String(step.engine)}`
          : step?.type === 'wait' ? 'chờ reset' : 'cấu hình chính';
        this.notify(`Claude fallback: đang dùng ${label}`, 'normal');
        break;
      }

      case 'claude.auto_resumed': {
        if (p.started === true) {
          this.notify('Claude đã tự tiếp tục phiên sau khi hết giới hạn', 'normal');
        } else if (p.ok === false) {
          this.notify('Claude tự tiếp tục nhưng phiên đã lỗi', 'critical');
        }
        break;
      }

      case 'profile.auth_expired': {
        const name = typeof p.name === 'string' ? p.name : 'tài khoản';
        this.notify(`Hồ sơ ${name} cần đăng nhập lại`, 'normal');
        break;
      }

      case 'task.overlap': {
        // Overlap details remain in the bulletin/dashboard; they are too noisy for desktop.
        break;
      }

      case 'load.high':
        this.notifyLoadSummary(now, 'tải hệ thống cao');
        break;

      case 'ci.failed': {
        const projId = (typeof p.projectId === 'string' ? p.projectId : taskId) || 'dự án';
        const workflow = (typeof p.workflow === 'string' ? p.workflow : '') || 'CI';
        const sha = typeof p.sha === 'string' ? p.sha.slice(0, 7) : '';
        const throttleKey = `${projId}:${workflow}`;
        const last = this.lastSentCi.get(throttleKey) || 0;
        if (now - last < 3600_000) {
          break;
        }
        this.lastSentCi.set(throttleKey, now);

        const jobs = Array.isArray(p.jobs) ? (p.jobs as Array<{ name?: string }>) : [];
        const failedJobNames = jobs.map((j) => j.name).filter(Boolean);
        const jobDetails = failedJobNames.length > 0 ? ` (${failedJobNames.join(', ')})` : '';
        const msg = `CI thất bại [${projId}]: ${workflow}${sha ? ` @ ${sha}` : ''}${jobDetails}`;
        this.notify(msg, 'warning');
        break;
      }

      case 'ci.passed': {
        if (p.recoveredFromFailure !== true && p.previousConclusion !== 'failure') {
          break;
        }
        const projId = (typeof p.projectId === 'string' ? p.projectId : taskId) || 'dự án';
        const workflow = (typeof p.workflow === 'string' ? p.workflow : '') || 'CI';
        const sha = typeof p.sha === 'string' ? p.sha.slice(0, 7) : '';
        const msg = `CI đã xanh: [${projId}] ${workflow}${sha ? ` @ ${sha}` : ''}`;
        this.notify(msg, 'normal');
        break;
      }

      case 'remote_deploy.started': {
        const proj = typeof p.projectId === 'string' ? p.projectId : 'dự án';
        this.notify(`${this.appName}: Bắt đầu remote deploy cho ${proj}`, 'normal');
        break;
      }

      case 'remote_deploy.succeeded': {
        const proj = typeof p.projectId === 'string' ? p.projectId : 'dự án';
        this.notify(`${this.appName}: Remote deploy thành công cho ${proj}`, 'normal');
        break;
      }

      case 'remote_deploy.failed': {
        const proj = typeof p.projectId === 'string' ? p.projectId : 'dự án';
        const err = typeof p.error === 'string' ? `: ${p.error}` : '';
        this.notify(`${this.appName}: Remote deploy thất bại cho ${proj}${err}`, 'critical');
        break;
      }

      case 'remote_deploy.health_timeout': {
        const proj = typeof p.projectId === 'string' ? p.projectId : 'dự án';
        this.notify(`${this.appName}: Remote deploy hết thời gian chờ health check cho ${proj}`, 'critical');
        break;
      }

      case 'task.pushed': {
        const branchStr = typeof p.branch === 'string' ? ` vào ${p.branch}` : '';
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`🚀 Đã đẩy lên git${branchStr}: ${title}`, 'normal');
        break;
      }

      case 'task.push_failed': {
        const err = typeof p.error === 'string' ? `: ${p.error}` : '';
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`❌ Đẩy git thất bại: ${title}${err}`, 'critical');
        break;
      }

      case 'task.audit_failed': {
        const title = this.resolveTaskTitle(taskId, p);
        const count = Array.isArray(p.findings) ? ` (${p.findings.length} vấn đề)` : '';
        const reason = p.exceededMaxRounds ? ' - Vượt quá số vòng sửa cho phép, chờ người xử lý' : '';
        this.notify(`⚠️ Audit trước khi publish thất bại: ${title}${count}${reason}`, 'critical');
        break;
      }
    }
  }

  private isFocusDeferredEvent(type: string): boolean {
    return type.startsWith('task.') || type.startsWith('assistant.') || type.startsWith('brain.');
  }

  private flushFocusDigest(): void {
    if (this.focusDigest.size === 0) return;
    const parts = [...this.focusDigest.entries()].map(([project, count]) => `${project}: ${count}`);
    this.focusDigest.clear();
    this.notify(`${this.appName}: ${parts.join(', ')} thông báo từ project khác trong lúc đang tập trung`, 'normal');
  }

  private queueWaitingQuotaCheck(notifyAllExhausted: boolean): void {
    if (this.waitingQuotaCheckTimer || !this.taskRepo) return;
    this.waitingQuotaCheckTimer = setTimeout(() => {
      this.waitingQuotaCheckTimer = undefined;
      const waiting = this.taskRepo?.getByStatus('waiting_quota').filter((task) => task.waitReason === 'quota') || [];
      if (waiting.length === 0) {
        this.waitingQuotaNotified = false;
        return;
      }
      if (!notifyAllExhausted || this.waitingQuotaNotified) return;
      this.waitingQuotaNotified = true;
      const active = this.quotaMarkRepo?.getActive(Math.floor(this.now() / 1000)) || [];
      const until = active.length > 0 ? Math.min(...active.map((mark) => mark.until)) : 0;
      const time = until ? new Date(until * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'sớm';
      this.notify(`${waiting.length} task đang chờ quota, sớm nhất mở lại lúc ${time}`, 'warning');
    }, WAITING_QUOTA_BATCH_DELAY_MS);
  }



  private resolveTaskTitle(taskId?: string, payload?: Record<string, unknown>): string {
    if (payload?.title && typeof payload.title === 'string') {
      return payload.title;
    }
    if (taskId) {
      const task = this.taskRepo?.get(taskId) || this.taskRepo?.get(toTaskId(taskId));
      if (task?.title) return task.title;
      return taskId;
    }
    return 'Task';
  }

  private extractConflictFiles(p: Record<string, unknown>): string {
    if (typeof p.files === 'string' && p.files.trim()) return p.files.trim();
    if (Array.isArray(p.files) && p.files.length > 0) return p.files.join(', ');
    if (typeof p.message === 'string') {
      const match = p.message.match(/Xung đột merge ở:\s*(.+)/i);
      if (match && match[1].trim()) return match[1].trim();
      return p.message.trim();
    }
    return '(không rõ file)';
  }

  private isMergeConflictNotified(taskId: string): boolean {
    if (this.mergeConflictNotified.has(taskId)) return true;
    if (this.taskRepo?.isNotificationSent('desktop', 'merge.conflict', taskId)) {
      this.mergeConflictNotified.add(taskId);
      return true;
    }
    return false;
  }

  private markMergeConflictNotified(taskId: string): void {
    this.mergeConflictNotified.add(taskId);
    this.taskRepo?.markNotificationSent('desktop', 'merge.conflict', taskId);
  }
  private notify(message: string, urgency: 'normal' | 'warning' | 'critical' = 'normal'): void {
    const level = this.config.notifications?.desktopLevel || 'all';
    if (level === 'off') return;
    if (level === 'critical' && urgency !== 'critical') return;
    const key = `${urgency}:${message}`;
    const now = this.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < 30 * 60 * 1000) {
      return;
    }
    this.lastSent.set(key, now);

    // notify-send supports low, normal, and critical (not warning). Keep the
    // service's warning classification while explicitly using normal urgency.
    const args = urgency === 'critical'
      ? ['-u', 'critical', '-t', '10000', '-a', this.appName, message]
      : urgency === 'warning'
      ? ['-u', 'normal', '-t', '10000', '-a', this.appName, message]
      : ['-t', '10000', '-a', this.appName, message];

    try {
      if (this.execFn) {
        const res = this.execFn('notify-send', args, () => {});
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          (res as Promise<unknown>).catch(() => {});
        }
      } else {
        execFile('notify-send', args, () => {});
      }
    } catch {
      // Ignore if notify-send is missing or fails
    }
  }

  private notifyLoadSummary(now: number, reason: string): void {
    const last = this.lastSentSummary.get('load') || 0;
    if (now - last < 15 * 60_000) return;
    this.lastSentSummary.set('load', now);
    this.notify(`AgentHub: Đã tạm dừng/gặp ${reason}; xem dashboard để biết chi tiết`, 'normal');
  }

  private shouldSendDisk(state: 'low' | 'ok', now: number): boolean {
    const last = this.lastSentDisk.get(state);
    if (last !== undefined && now - last < 60 * 60_000) return false;
    this.lastSentDisk.set(state, now);
    return true;
  }
}

function formatHours(h: unknown): string {
  const num = typeof h === 'number' ? h : Number(h || 0);
  if (Number.isNaN(num)) return '0';
  const rounded = Math.round(num * 100) / 100;
  return String(rounded).replace('.', ',');
}
