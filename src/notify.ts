import { execFile } from 'node:child_process';
import { AgentHubConfig, updateConfigInMemory } from './config.js';
import { EventBus } from './scheduler/index.js';
import { QuotaMarkRepo, TaskRepo, ProfileRepo, CiRepo } from './db/index.js';
import { toTaskId } from './services/index.js';
import { isQuietHours, isQuotaEventEngineWide, isSystemIncident, getMinutesSinceTime } from './brain/digest.js';
import { effectiveBrainMode } from './brain/mode.js';
import { formatReset } from './time-format.js';
import { NotificationDeduper } from './notification-dedupe.js';
import { QuotaService, QuotaCapacitySnapshot, formatRunnableCapacity } from './quota/index.js';

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
  private quotaInfoNotified = new Set<string>();
  private quotaIncidentActive = false;
  private pendingQuotaInfo = new Map<string, string>();
  private quotaInfoTimer: ReturnType<typeof setTimeout> | undefined;
  private waitingQuotaNotified = false;
  private waitingQuotaCheckTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSentSummary = new Map<string, number>();
  private lastSentDisk = new Map<'low' | 'ok', number>();
  private diskState: 'low' | 'ok' | undefined;
  private readonly eventDeduper: NotificationDeduper;
  private boundHandler: ((type: string, taskId?: string, payload?: unknown) => void) | null = null;
  private quietHoursQueue: Array<{ type: string; taskId?: string; payload?: unknown; timestamp: number }> = [];
  private focusDigest = new Map<string, number>();
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
    if (this.quotaInfoTimer) {
      clearTimeout(this.quotaInfoTimer);
      this.quotaInfoTimer = undefined;
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
      'disk.low', 'disk.docker_low', 'quota.exhausted', 'ci.failed', 'task.waiting_quota',
      'quota.cleared',
    ]).has(type)) return;

    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const notifyConfig = this.config.telegram?.notify;
    const notifyPerModel = notifyConfig
      ? typeof notifyConfig.quotaPerModel === 'boolean' ? notifyConfig.quotaPerModel : (notifyConfig as unknown as { quota?: boolean }).quota === true
      : false;
    const notifyAllExhausted = notifyConfig?.quotaAllExhausted !== false;
    if (type === 'quota.cleared') {
      this.allQuotaNotified.delete('all');
      if (typeof p.family === 'string') this.allQuotaNotified.delete(p.family);
      for (const key of this.lastSent.keys()) {
        if (key.includes('Mọi tài khoản đều đã hết quota') || key.includes('Hết sạch quota')) {
          this.lastSent.delete(key);
        }
      }
      this.quotaInfoNotified.clear();
      const snapshot = this.quotaCapacity();
      if (this.quotaIncidentActive) {
        this.quotaIncidentActive = false;
        if (snapshot && snapshot.runnable.length > 0) this.notify(this.quotaRecoveryMessage(snapshot), 'normal');
      }
    }
    if (type === 'task.waiting_quota' && p.reason === 'quota' && this.taskRepo) {
      this.queueWaitingQuotaCheck(notifyAllExhausted);
      return;
    }
    if ((type === 'quota.cleared' || type === 'task.queued') && this.taskRepo) this.queueWaitingQuotaCheck(notifyAllExhausted);
    if (!this.eventDeduper.shouldSend(type, taskId, payload)) return;

    // 1. In brain auto mode: suppress raw task notifications
    const taskProjectId = taskId?.includes('/') ? taskId.slice(0, taskId.indexOf('/')) : typeof p.projectId === 'string' ? p.projectId : null;
    const focusProjectId = this.config.focus?.projectId;
    if (focusProjectId && taskProjectId && taskProjectId !== focusProjectId && this.isFocusDeferredEvent(type)) {
      this.focusDigest.set(taskProjectId, (this.focusDigest.get(taskProjectId) || 0) + 1);
      return;
    }
    const effectiveMode = effectiveBrainMode(taskProjectId, taskProjectId ? this.projectRepo?.get(taskProjectId) : null, this.config.brain);
    if (effectiveMode === 'auto') {
      const allExhausted =
        type === 'quota.exhausted' &&
        isQuotaEventEngineWide(p, this.profileRepo, this.quotaMarkRepo, this.now());

      const isSystemEvent =
        type === 'brain.notify' ||
        type === 'disk.low' ||
        type === 'disk.docker_low' ||
        type === 'claude.quota_exhausted' ||
        type === 'hub.restart_failed' ||
        type === 'system.error' ||
        type === 'ci.failed' ||
        type === 'ci.passed' ||
        allExhausted ||
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

      case 'task.paused':
      case 'load.task_paused': {
        this.notifyLoadSummary(now, p.reason === 'load' ? 'quá tải hệ thống' : 'yêu cầu tạm dừng');
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

      case 'disk.low': {
        if (!this.shouldSendDisk('low', now)) break;
        this.diskState = 'low';
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 0;
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

      case 'quota.exhausted': {
        const family = typeof p.family === 'string' ? p.family : typeof p.model === 'string' ? p.model : '';
        const quotaKey = family || 'all';
        const snapshot = this.quotaCapacity();
        const isAllExhausted = snapshot ? snapshot.runnable.length === 0 : isQuotaEventEngineWide(p, this.profileRepo, this.quotaMarkRepo, this.now());
        const engineWide = isQuotaEventEngineWide(p, this.profileRepo, this.quotaMarkRepo, this.now());
        if (!isAllExhausted) this.allQuotaNotified.delete(quotaKey);
        if (!isAllExhausted && this.quotaIncidentActive) {
          this.quotaIncidentActive = false;
          this.notify(this.quotaRecoveryMessage(snapshot!), 'normal');
        }
        if (effectiveMode === 'auto') {
          if (isAllExhausted && notifyAllExhausted && !this.quotaIncidentActive) {
            this.allQuotaNotified.add(quotaKey);
            this.quotaIncidentActive = true;
            this.notify(this.quotaIncidentMessage(snapshot), 'critical');
          }
          break;
        }
        if (isAllExhausted) {
          if (!notifyAllExhausted || this.quotaIncidentActive) break;
          this.allQuotaNotified.add(quotaKey);
          this.quotaIncidentActive = true;
          this.notify(this.quotaIncidentMessage(snapshot), 'critical');
          break;
        }
        if (engineWide && !this.quotaInfoNotified.has(`${p.engine || 'agy'}:${family}`)) {
          this.quotaInfoNotified.add(`${p.engine || 'agy'}:${family}`);
          this.queueQuotaInfo(p.engine === 'agy' ? 'Antigravity' : String(p.engine || ''), family);
          break;
        }
        if (!notifyPerModel) break;
        const name = (p.profile || p.worker || p.profileName || 'Hồ sơ') as string;
        const resetTimeStr = this.resolveResetTime(p, name, family);
        const msg = isAllExhausted
          ? 'AgentHub: Mọi tài khoản đều đã hết quota'
          : resetTimeStr
          ? `Hồ sơ ${name} hết quota ${family} tới ${resetTimeStr}`
          : `Hồ sơ ${name} hết quota ${family}`;
        this.notify(msg, isAllExhausted ? 'critical' : 'normal');
        break;
      }

      case 'claude.fallback_changed': {
        const step = p.step && typeof p.step === 'object' ? p.step as Record<string, unknown> : null;
        if (p.fallbackAvailable === true || (step && step.type !== 'wait')) break;
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

  private queueQuotaInfo(engine: string, family: string): void {
    this.pendingQuotaInfo.set(`${engine}:${family}`, family);
    if (this.quotaInfoTimer) return;
    this.quotaInfoTimer = setTimeout(() => {
      this.quotaInfoTimer = undefined;
      const snapshot = this.quotaCapacity();
      const families = [...this.pendingQuotaInfo.values()]
        .map((value) => value === 'gpt' ? 'GPT' : value.charAt(0).toUpperCase() + value.slice(1))
        .sort()
        .join('/');
      this.pendingQuotaInfo.clear();
      const reset = snapshot?.nextReset
        ? ` (reset sớm nhất ${formatReset(snapshot.nextReset.at, this.now())})`
        : '';
      const runnable = snapshot ? formatRunnableCapacity(snapshot) : 'model khác';
      this.notify(`ℹ️ Hết quota ${families} trên mọi tài khoản Antigravity${reset}. Vẫn chạy bằng: ${runnable}`, 'normal');
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

  private resolveResetTime(p: Record<string, unknown>, profile: string, family: string): string {
    if (typeof p.time === 'string') return p.time;
    if (typeof p.untilStr === 'string') return p.untilStr;
    if (typeof p.until === 'string' && p.until.includes(':')) return p.until;

    let epochSec: number | undefined;
    if (typeof p.until === 'number') {
      epochSec = p.until > 1e11 ? Math.floor(p.until / 1000) : p.until;
    } else if (typeof p.resetAt === 'number') {
      epochSec = p.resetAt > 1e11 ? Math.floor(p.resetAt / 1000) : p.resetAt;
    } else if (typeof p.resetSeconds === 'number') {
      epochSec = Math.floor(this.now() / 1000) + p.resetSeconds;
    } else if (typeof p.duration === 'number') {
      epochSec = Math.floor(this.now() / 1000) + p.duration;
    } else if (this.quotaMarkRepo && profile && family) {
      const marks = this.quotaMarkRepo.getActive();
      const mark = marks.find((m) => m.profileName === profile && m.family === family);
      if (mark) epochSec = mark.until;
    }

    if (epochSec !== undefined) {
      return formatReset(epochSec, this.now(), 'vi');
    }

    return '';
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
