import { EventItem } from './types/api';
import { getActiveLocale } from './utils/apiError';
import { formatEventType } from './utils/events';

const IMPORTANT = new Set(['brain.notify', 'task.review_ready', 'task.failed', 'task.blocked', 'review.escalated', 'disk.low', 'disk.docker_low', 'quota.exhausted', 'ci.failed', 'task.pause_reminder']);
const DESKTOP_EVENTS = new Set([
  ...IMPORTANT,
  'batch.created', 'task.paused', 'load.task_paused', 'load.high', 'task.resumed', 'task.pause_reminder',
  'load.task_resumed', 'disk.ok', 'claude.fallback_changed', 'claude.auto_resumed',
  'profile.auth_expired', 'ci.passed',
]);
const WINDOW_MS = 30 * 60 * 1000;
const DISK_WINDOW_MS = 60 * 60 * 1000;
const LOAD_WINDOW_MS = 15 * 60 * 1000;

export interface BrowserNotificationOptions {
  quietHours?: { enabled?: boolean; start?: string; end?: string };
  brainMode?: 'manual' | 'auto' | 'trusted' | 'full';
}

export interface BrowserQuotaProfile {
  name?: string;
  engine?: string;
  enabled?: boolean | number;
  authState?: string | null;
  quotaMarks?: Array<{ family?: string; until?: number }>;
}

export interface RunnableCapacityEntry {
  profileName: string;
  engine: string;
  family: string;
  model: string;
}

export const KNOWN_RUNNABLE_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
  'codex:gpt-5.6-luna',
];

export function getModelFamily(model: string): string {
  if (model.startsWith('codex:')) return 'codex';
  const idx = model.indexOf('-');
  return idx > 0 ? model.substring(0, idx) : model;
}

export function getModelEngine(model: string): 'agy' | 'codex' {
  return model.startsWith('codex:') ? 'codex' : 'agy';
}

function normalizeQuotaFamily(family: unknown): string | undefined {
  if (typeof family !== 'string' || !family) return undefined;
  if (family.startsWith('codex')) return 'codex';
  if (family.startsWith('gemini')) return 'gemini';
  if (family.startsWith('claude')) return 'claude';
  if (family.startsWith('gpt')) return 'gpt';
  return family;
}

export function runnableCapacity(
  profiles: BrowserQuotaProfile[] = [],
  models: string[] = KNOWN_RUNNABLE_MODELS,
  now = Math.floor(Date.now() / 1000),
): RunnableCapacityEntry[] {
  const eligible = profiles.filter(
    (profile) => profile.enabled !== false && profile.enabled !== 0 && (!profile.authState || profile.authState === 'ok'),
  );
  return models.flatMap((model) => {
    const rawFamily = getModelFamily(model);
    const family = normalizeQuotaFamily(rawFamily) || rawFamily;
    const engine = getModelEngine(model);
    return eligible
      .filter((profile) => (profile.engine || 'agy') === engine && !profile.quotaMarks?.some((mark) => {
        const markFamily = normalizeQuotaFamily(mark.family);
        return markFamily === family && typeof mark.until === 'number' && mark.until > now;
      }))
      .map((profile) => ({
        profileName: profile.name || '',
        engine,
        family,
        model,
      }));
  });
}

export function isQuotaExhausted(
  event: EventItem,
  profiles: BrowserQuotaProfile[] = [],
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (profiles.length > 0) {
    return runnableCapacity(profiles, undefined, now).length === 0;
  }
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  return Boolean(payload.allExhausted === true);
}

export function isEngineWideQuotaExhausted(
  event: EventItem,
  profiles: BrowserQuotaProfile[] = [],
): boolean {
  return isQuotaExhausted(event, profiles);
}

export function browserNotificationBody(event: EventItem, locale: 'vi' | 'en' = 'vi'): string {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const appName = 'AgentHub';
  const isEn = locale === 'en';

  if (event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high') {
    return isEn
      ? `${appName}: Task paused or high load; check dashboard for details`
      : `${appName}: Đã tạm dừng task hoặc gặp tải cao; xem dashboard để biết chi tiết`;
  }
  if (event.type === 'task.pause_reminder') {
    const min = typeof payload.pausedMin === 'number' ? payload.pausedMin : 30;
    return isEn
      ? `${appName}: Task paused for ${min}m; check dashboard to resume`
      : `${appName}: Task đã tạm dừng ${min} phút; vào dashboard để tiếp tục`;
  }
  if (event.type === 'disk.low') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : (payload.freeGB ?? '?');
    const minFreeGB = typeof payload.minFreeGB === 'number' ? payload.minFreeGB : 3;
    const cacheDir = typeof payload.cacheDir === 'string'
      ? (isEn ? ` Cache node_modules: ${payload.cacheDir}.` : ` Cache node_modules: ${payload.cacheDir}.`)
      : '';
    const largest = typeof payload.largestCacheEntry === 'string'
      ? (isEn
        ? ` Largest: ${payload.largestCacheEntry}${typeof payload.largestCacheEntryBytes === 'number' ? ` (${(payload.largestCacheEntryBytes / 1024 ** 3).toFixed(2)} GB)` : ''}.`
        : ` Bản lớn nhất: ${payload.largestCacheEntry}${typeof payload.largestCacheEntryBytes === 'number' ? ` (${(payload.largestCacheEntryBytes / 1024 ** 3).toFixed(2)} GB)` : ''}.`)
      : '';
    return isEn
      ? `Disk space low: ${freeGB} GB (< ${minFreeGB} GB): pausing task launches${cacheDir}${largest}`
      : `Ổ đĩa còn ${freeGB} GB (< ${minFreeGB} GB): tạm dừng khởi chạy task${cacheDir}${largest}`;
  }
  if (event.type === 'disk.ok') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : (payload.freeGB ?? '?');
    return isEn
      ? `Disk space recovered (${freeGB} GB): resuming tasks`
      : `Ổ đĩa đã đủ chỗ (${freeGB} GB): tiếp tục chạy task`;
  }
  if (event.type === 'disk.docker_low') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : (payload.freeGB ?? '?');
    const minFreeGB = typeof payload.minFreeGB === 'number' ? payload.minFreeGB : 5;
    return isEn
      ? `Docker disk space low: ${freeGB} GB (< ${minFreeGB} GB): skipping docker build/pull/compose up`
      : `Ổ đĩa Docker còn ${freeGB} GB (< ${minFreeGB} GB): không chạy docker build/pull/compose up`;
  }
  if (event.type === 'quota.exhausted') {
    return isEn
      ? `${appName}: All accounts have exhausted quota`
      : `${appName}: Mọi tài khoản đều đã hết quota`;
  }
  if (event.type === 'task.failed') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return isEn ? `${appName}: ${title} failed` : `${appName}: ${title} thất bại`;
  }
  if (event.type === 'task.blocked') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return isEn ? `${appName}: ${title} blocked` : `${appName}: ${title} bị chặn`;
  }
  if (event.type === 'task.review_ready') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    let msg = isEn ? `${appName}: ${title} waiting for review` : `${appName}: ${title} chờ review`;
    if ('checksPassed' in payload) {
      msg += ` (${payload.checksPassed ? '✓' : '✗'} checks)`;
    }
    return msg;
  }
  if (event.type === 'review.escalated') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return isEn ? `Approval required: ${title}` : `Cần người duyệt: ${title}`;
  }
  if (event.type === 'brain.notify') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (payload.level === 'incident') return isEn ? `🚨 Incident ${appName}: ${text}` : `🚨 Sự cố ${appName}: ${text}`;
    if (payload.level === 'decision') return isEn ? `📌 Decision needed: ${text}` : `📌 Cần quyết định: ${text}`;
    return `ℹ️ ${appName}: ${text}`;
  }
  if (event.type === 'batch.created') {
    const count = typeof payload.taskCount === 'number' ? payload.taskCount : 0;
    const who = typeof payload.createdBy === 'string' && payload.createdBy ? payload.createdBy : 'Claude';
    const label = who.toLowerCase() === 'claude' ? 'Claude' : who;
    return isEn
      ? `${label} proposed ${count} task(s), awaiting your review`
      : `${label} đề xuất ${count} task, chờ bạn duyệt`;
  }
  if (event.type === 'task.resumed' || event.type === 'load.task_resumed') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return isEn ? `Resumed task ${title}` : `Tiếp tục task ${title}`;
  }
  if (event.type === 'claude.fallback_changed') {
    const step = payload.step && typeof payload.step === 'object' ? payload.step as Record<string, unknown> : null;
    const label = isEn
      ? (step?.type === 'model' ? `model ${String(step.model)}`
        : step?.type === 'profile' ? `profile ${String(step.profile || 'other')}`
        : step?.type === 'apiKey' ? 'API key'
        : step?.type === 'engine' ? `engine ${String(step.engine)}`
        : step?.type === 'wait' ? 'waiting for reset' : 'primary configuration')
      : (step?.type === 'model' ? `model ${String(step.model)}`
        : step?.type === 'profile' ? `tài khoản ${String(step.profile || 'khác')}`
        : step?.type === 'apiKey' ? 'API key'
        : step?.type === 'engine' ? `engine ${String(step.engine)}`
        : step?.type === 'wait' ? 'chờ reset' : 'cấu hình chính');
    return isEn ? `Claude fallback: currently using ${label}` : `Claude fallback: đang dùng ${label}`;
  }
  if (event.type === 'claude.auto_resumed') {
    if (payload.started === true) {
      return isEn
        ? 'Claude automatically resumed session after limit reset'
        : 'Claude đã tự tiếp tục phiên sau khi hết giới hạn';
    }
    return isEn
      ? 'Claude attempted auto-resume but session encountered an error'
      : 'Claude tự tiếp tục nhưng phiên đã lỗi';
  }
  if (event.type === 'profile.auth_expired') {
    const name = typeof payload.name === 'string' ? payload.name : (isEn ? 'profile' : 'tài khoản');
    return isEn ? `Profile ${name} requires re-authentication` : `Hồ sơ ${name} cần đăng nhập lại`;
  }
  if (event.type === 'ci.failed') {
    const projId = (typeof payload.projectId === 'string' ? payload.projectId : event.taskId) || (isEn ? 'project' : 'dự án');
    const workflow = (typeof payload.workflow === 'string' ? payload.workflow : '') || 'CI';
    const sha = typeof payload.sha === 'string' ? payload.sha.slice(0, 7) : '';
    const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<{ name?: string }>) : [];
    const failedJobNames = jobs.map((j) => j.name).filter(Boolean);
    const jobDetails = failedJobNames.length > 0 ? ` (${failedJobNames.join(', ')})` : '';
    return isEn
      ? `CI failed [${projId}]: ${workflow}${sha ? ` @ ${sha}` : ''}${jobDetails}`
      : `CI thất bại [${projId}]: ${workflow}${sha ? ` @ ${sha}` : ''}${jobDetails}`;
  }
  if (event.type === 'ci.passed') {
    const projId = (typeof payload.projectId === 'string' ? payload.projectId : event.taskId) || (isEn ? 'project' : 'dự án');
    const workflow = (typeof payload.workflow === 'string' ? payload.workflow : '') || 'CI';
    const sha = typeof payload.sha === 'string' ? payload.sha.slice(0, 7) : '';
    return isEn
      ? `CI passed: [${projId}] ${workflow}${sha ? ` @ ${sha}` : ''}`
      : `CI đã xanh: [${projId}] ${workflow}${sha ? ` @ ${sha}` : ''}`;
  }
  return isEn ? `${appName} has an update requiring attention` : `${appName} có cập nhật cần chú ý`;
}

export function shouldNotifyBrowserEvent(
  event: EventItem,
  level: 'all' | 'important' | 'critical' | 'off' = 'important',
  profiles: BrowserQuotaProfile[] = [],
  options: BrowserNotificationOptions = {},
): boolean {
  if (level === 'off' || !DESKTOP_EVENTS.has(event.type)) return false;
  if (level === 'important' && !IMPORTANT.has(event.type)) return false;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  if (options.brainMode === 'auto' && !new Set([
    'brain.notify', 'disk.low', 'disk.docker_low', 'quota.exhausted', 'ci.failed',
  ]).has(event.type)) return false;
  if (isBrowserQuietHours(options.quietHours, event.ts) && event.type !== 'disk.low' && event.type !== 'disk.docker_low' && event.type !== 'quota.exhausted') return false;
  if (event.type === 'quota.exhausted') {
    return isEngineWideQuotaExhausted(event, profiles);
  }
  // The scheduler emits disk.ok only after the hysteresis margin is crossed.
  // Keep this guard here too because SSE can be replayed or produced by an
  // older scheduler, and such an event must not wake the browser.
  if (event.type === 'disk.low' || event.type === 'disk.ok') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : NaN;
    const minFreeGB = typeof payload.minFreeGB === 'number' ? payload.minFreeGB : NaN;
    const valid = event.type === 'disk.low' ? freeGB < minFreeGB : freeGB >= minFreeGB + 1;
    if (!Number.isFinite(freeGB) || !Number.isFinite(minFreeGB) || !valid) return false;
  }
  if (level !== 'critical') return true;
  return event.type === 'task.failed' || event.type === 'disk.docker_low' || (event.type === 'quota.exhausted' && isEngineWideQuotaExhausted(event, profiles));
}

export function notifyBrowserEvent(
  event: EventItem,
  level: 'all' | 'important' | 'critical' | 'off' = 'important',
  profiles: BrowserQuotaProfile[] = [],
  options: BrowserNotificationOptions = {},
): void {
  if (typeof window === 'undefined' || !shouldNotifyBrowserEvent(event, level, profiles, options) || !('Notification' in window) || Notification.permission !== 'granted') return;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  if (event.type === 'quota.exhausted' && !shouldNotifyBrowserEvent(event, level, profiles, options)) return;

  // State transition guard for disk.ok: only allowed if disk was previously in 'low' state.
  if (event.type === 'disk.ok') {
    const previousLow = Number(localStorage.getItem('agenthub:notification:disk.low') || 0);
    const previousOk = Number(localStorage.getItem('agenthub:notification:disk.ok') || 0);
    if (!previousLow || previousLow < previousOk) return;
  }

  const throttleWindow = event.type === 'disk.low' || event.type === 'disk.ok'
    ? DISK_WINDOW_MS
    : event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high'
    ? LOAD_WINDOW_MS
    : WINDOW_MS;

  const identity = event.type === 'disk.low' || event.type === 'disk.ok'
    ? event.type
    : event.type === 'quota.exhausted'
    ? 'quota:all'
    : event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high'
    ? 'load:summary'
    : `${event.type}:${event.taskId || ''}:${JSON.stringify(payload)}`;

  const key = `agenthub:notification:${identity}`;
  const now = Date.now();
  try {
    const previous = Number(localStorage.getItem(key) || 0);
    if (previous && now - previous < throttleWindow) return;
    localStorage.setItem(key, String(now));
    new Notification(formatEventType(event.type, getActiveLocale()), { body: browserNotificationBody(event, getActiveLocale()) });
  } catch {
    // Browser notification APIs may be unavailable or blocked by policy.
  }
}

function isBrowserQuietHours(
  quietHours: BrowserNotificationOptions['quietHours'],
  timestamp: string,
): boolean {
  if (!quietHours?.enabled || !quietHours.start || !quietHours.end) return false;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;
  const toMinutes = (value: string): number => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const current = date.getHours() * 60 + date.getMinutes();
  const start = toMinutes(quietHours.start);
  const end = toMinutes(quietHours.end);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}
