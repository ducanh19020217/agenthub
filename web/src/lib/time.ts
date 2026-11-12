export type TimeLocale = 'vi' | 'en' | string;

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
/** Parse API timestamps, including legacy SQLite UTC strings without a suffix, ISO strings without timezone (treated as UTC), epoch seconds (< 1e11), numeric strings, and Date instances. */
export function parseApiTime(value: string | number | Date | null | undefined): number {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : NaN;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    return Math.abs(value) < 1e11 ? value * 1000 : value;
  }
  if (!value || typeof value !== 'string') return NaN;
  const trimmed = value.trim();
  if (!trimmed) return NaN;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return NaN;
    return Math.abs(num) < 1e11 ? num * 1000 : num;
  }
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return Date.parse(match ? `${match[1]}T${match[2]}Z` : trimmed);
}

export function formatTimeAgo(value: string | number | Date | null | undefined, now = Date.now(), locale: TimeLocale = 'vi'): string {
  const parsed = parseApiTime(value);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return locale === 'en' ? 'time unknown' : 'chưa rõ thời gian';
  }
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (locale === 'en') {
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
  if (seconds < 60) return `${seconds} giây trước`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

function epochMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e11 ? value : value * 1000;
}

function nowMs(now?: number | Date): number {
  return now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now();
}

function parts(ms: number, locale: TimeLocale, timeZone: string = TIME_ZONE) {
  const date = new Date(ms);
  const formatter = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    day: Number(values.day),
    month: Number(values.month),
    year: Number(values.year),
    hour: values.hour,
    minute: values.minute,
    weekday: date.toLocaleDateString(locale === 'en' ? 'en-US' : 'vi-VN', { timeZone, weekday: 'long' }),
  };
}

function sameDay(a: number, b: number, timeZone: string = TIME_ZONE): boolean {
  return dayKey(a, timeZone) === dayKey(b, timeZone);
}

function tomorrow(target: number, current: number, timeZone: string = TIME_ZONE): boolean {
  return dayKey(target, timeZone) - dayKey(current, timeZone) === 86400000;
}

function yesterday(target: number, current: number, timeZone: string = TIME_ZONE): boolean {
  return dayKey(current, timeZone) - dayKey(target, timeZone) === 86400000;
}

function sameYear(a: number, b: number, timeZone: string = TIME_ZONE): boolean {
  return parts(a, 'vi', timeZone).year === parts(b, 'vi', timeZone).year;
}

function dayKey(ms: number, timeZone: string = TIME_ZONE): number {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
}

function absolute(ms: number, now: number, locale: TimeLocale): string {
  const p = parts(ms, locale);
  const clock = `${p.hour}:${p.minute}`;
  if (sameDay(ms, now)) return locale === 'en' ? `${clock} today` : `${clock} hôm nay`;
  if (tomorrow(ms, now)) return locale === 'en' ? `${clock} tomorrow` : `${clock} ngày mai`;
  return locale === 'en' ? `${p.weekday} ${p.day}/${p.month} ${clock}` : `${p.weekday} ${p.day}/${p.month} ${clock}`;
}

function relative(ms: number, now: number, locale: TimeLocale): string {
  const seconds = Math.max(0, Math.floor((ms - now) / 1000));
  if (seconds < 60) return locale === 'en' ? 'soon' : 'sắp reset';
  const minutes = Math.floor(seconds / 60);
  if (seconds < 86400) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (locale === 'en') return hours ? `in ${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}` : `in ${rest} minute${rest === 1 ? '' : 's'}`;
    return hours ? `còn ${hours} giờ${rest ? ` ${rest} phút` : ''}` : `còn ${rest} phút`;
  }
  const days = Math.ceil(seconds / 86400);
  return locale === 'en' ? `in ${days} day${days === 1 ? '' : 's'}` : `còn ${days} ngày`;
}

const VI_SHORT_WEEKDAY: Record<string, string> = {
  'thứ hai': 'T2',
  'thứ ba': 'T3',
  'thứ tư': 'T4',
  'thứ năm': 'T5',
  'thứ sáu': 'T6',
  'thứ bảy': 'T7',
  'chủ nhật': 'CN',
};

const EN_SHORT_WEEKDAY: Record<string, string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

function shortWeekday(weekday: string, locale: TimeLocale): string {
  const key = weekday.toLowerCase().trim();
  if (locale === 'en') return EN_SHORT_WEEKDAY[key] || weekday.slice(0, 3);
  return VI_SHORT_WEEKDAY[key] || weekday;
}

function relativeCompact(ms: number, now: number, locale: TimeLocale): string {
  const seconds = Math.max(0, Math.floor((ms - now) / 1000));
  if (seconds < 60) return locale === 'en' ? '<1m' : '<1p';
  const minutes = Math.floor(seconds / 60);
  if (seconds < 86400) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours && rest) return `${hours}h${rest}m`;
    if (hours) return `${hours}h`;
    return `${rest}m`;
  }
  const days = Math.ceil(seconds / 86400);
  return `${days}d`;
}

function absoluteCompact(ms: number, now: number, locale: TimeLocale): string {
  const p = parts(ms, locale);
  const clock = `${p.hour}:${p.minute}`;
  if (sameDay(ms, now)) return clock;
  const wd = shortWeekday(p.weekday, locale);
  return `${wd} ${p.day}/${p.month} ${clock}`;
}

export function formatReset(value: number | null | undefined, now?: number | Date, locale: TimeLocale = 'vi'): string {
  const ms = epochMs(value);
  if (ms === null) return locale === 'en' ? 'reset time unknown' : 'chưa rõ thời điểm reset';
  const current = nowMs(now);
  if (ms <= current) return locale === 'en' ? `reset at ${parts(ms, locale).hour}:${parts(ms, locale).minute} · updating data` : `đã reset lúc ${parts(ms, locale).hour}:${parts(ms, locale).minute} · đang cập nhật số liệu`;
  return `${relative(ms, current, locale)} · ${absolute(ms, current, locale)}`;
}

export function formatResetCompact(value: number | null | undefined, now?: number | Date, locale: TimeLocale = 'vi'): string {
  const ms = epochMs(value);
  if (ms === null) return locale === 'en' ? 'unknown' : 'chưa rõ';
  const current = nowMs(now);
  if (ms <= current) {
    const clock = `${parts(ms, locale).hour}:${parts(ms, locale).minute}`;
    return locale === 'en' ? `reset ${clock}` : `đã reset ${clock}`;
  }
  return `${relativeCompact(ms, current, locale)} - ${absoluteCompact(ms, current, locale)}`;
}

export function formatExpiry(value: number | null | undefined, now?: number | Date, locale: TimeLocale = 'vi'): string {
  const formatted = formatReset(value, now, locale);
  if (locale === 'en') return formatted.replace(/^reset time unknown$/, 'expiry time unknown').replace(/^reset at/, 'expired at').replace(/^in /, 'expires in ');
  return formatted.replace(/^chưa rõ thời điểm reset$/, 'chưa rõ thời điểm hết hạn').replace(/^đã reset lúc/, 'đã hết hạn lúc').replace(/^còn /, 'hết hạn sau ');
}

export function formatTimeTitle(value: number | null | undefined, locale: TimeLocale = 'vi', source?: string, observedAt?: string | number | null): string {
  const ms = epochMs(value);
  if (ms === null) return locale === 'en' ? 'Time unknown' : 'Chưa rõ thời điểm';
  const full = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', { timeZone: TIME_ZONE, dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms));
  const observed = observedAt ? new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(typeof observedAt === 'number' ? observedAt : observedAt)) : null;
  return `${full} (${TIME_ZONE})${source ? ` · ${source}` : ''}${observed ? ` · ${locale === 'en' ? 'observed at' : 'theo lúc'} ${observed}` : ''}`;
}

export interface FormatDateTimeOptions {
  seconds?: boolean;
  timeZone?: string;
  fallback?: string;
}

/**
 * Format a timestamp as a localized 24h date-time string.
 * Uses browser/system timezone unless overridden by opts.timeZone.
 * vi: 06/11/2026 00:52:44
 * en: 06/11/2026, 00:52:44
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  locale: TimeLocale = 'vi',
  opts?: FormatDateTimeOptions,
): string {
  const parsed = parseApiTime(value);
  if (!Number.isFinite(parsed)) {
    return opts?.fallback ?? '—';
  }
  const showSeconds = opts?.seconds ?? true;
  const isEn = String(locale).startsWith('en');
  const d = new Date(parsed);

  const formatterOpts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
  };
  if (showSeconds) {
    formatterOpts.second = '2-digit';
  }

  const formatter = new Intl.DateTimeFormat(isEn ? 'en-GB' : 'vi-VN', formatterOpts);
  const parts = Object.fromEntries(
    formatter.formatToParts(d).map(({ type, value }) => [type, value])
  );
  const { day, month, year, hour, minute, second } = parts;
  const timePart = showSeconds ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;

  if (isEn) {
    return `${day}/${month}/${year}, ${timePart}`;
  }
  return `${day}/${month}/${year} ${timePart}`;
}

export interface FormatTimeOptions {
  seconds?: boolean;
  timeZone?: string;
  fallback?: string;
}

/**
 * Format timestamp as a localized 24h clock string (HH:MM:SS or HH:MM).
 */
export function formatTime(
  value: string | number | Date | null | undefined,
  locale: TimeLocale = 'vi',
  opts?: FormatTimeOptions,
): string {
  const parsed = parseApiTime(value);
  if (!Number.isFinite(parsed)) {
    return opts?.fallback ?? '—';
  }
  const showSeconds = opts?.seconds ?? true;
  const isEn = String(locale).startsWith('en');
  const d = new Date(parsed);

  const formatterOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
  };
  if (showSeconds) {
    formatterOpts.second = '2-digit';
  }

  const formatter = new Intl.DateTimeFormat(isEn ? 'en-GB' : 'vi-VN', formatterOpts);
  const parts = Object.fromEntries(
    formatter.formatToParts(d).map(({ type, value }) => [type, value])
  );
  return showSeconds ? `${parts.hour}:${parts.minute}:${parts.second}` : `${parts.hour}:${parts.minute}`;
}

/**
 * Format timestamp as localized date-time without seconds alongside relative time ago.
 * E.g. "06/11/2026 00:52 · 3 giờ trước" or "06/11/2026, 00:52 · 3h ago"
 */
export function formatDateTimeWithAgo(
  value: string | number | Date | null | undefined,
  locale: TimeLocale = 'vi',
  now: number | Date = Date.now(),
  opts?: { timeZone?: string },
): string {
  const parsed = parseApiTime(value);
  if (!Number.isFinite(parsed)) {
    return locale === 'en' ? 'time unknown' : 'chưa rõ thời gian';
  }
  const dateStr = formatDateTime(parsed, locale, { seconds: false, timeZone: opts?.timeZone });
  const agoStr = formatTimeAgo(parsed, nowMs(now), locale);
  return `${dateStr} · ${agoStr}`;
}

/**
 * Format full ISO timestamp for title tooltip attributes.
 * Returns empty string on invalid/missing input.
 */
export function formatIsoTitle(value: string | number | Date | null | undefined): string {
  const parsed = parseApiTime(value);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
}

export interface FormatShortContextualTimeOptions {
  now?: number | Date;
  timeZone?: string;
  fallback?: string;
  mode?: 'auto' | 'clock' | 'ago';
}

/**
 * Format timestamp as a short contextual string.
 * Examples:
 * - < 1 minute ago: "vừa xong" (vi) / "just now" (en)
 * - < 1 hour ago: "5 phút trước" (vi) / "5m ago" (en)
 * - today: "14:32"
 * - yesterday: "hôm qua 14:20" (vi) / "yesterday 14:20" (en)
 * - this year: "12/04 14:20"
 * - older: "12/04/2025"
 */
export function formatShortContextualTime(
  value: string | number | Date | null | undefined,
  locale: TimeLocale = 'vi',
  nowOrOpts?: number | Date | FormatShortContextualTimeOptions,
  opts?: FormatShortContextualTimeOptions,
): string {
  const options: FormatShortContextualTimeOptions =
    typeof nowOrOpts === 'object' && !(nowOrOpts instanceof Date)
      ? nowOrOpts
      : { ...opts, now: typeof nowOrOpts === 'number' || nowOrOpts instanceof Date ? nowOrOpts : opts?.now };

  const parsed = parseApiTime(value);
  const isEn = String(locale).startsWith('en');
  if (!Number.isFinite(parsed)) {
    return options.fallback ?? (isEn ? 'time unknown' : 'chưa rõ thời gian');
  }

  const current = nowMs(options.now);
  const tz = options.timeZone || TIME_ZONE;
  const mode = options.mode || 'auto';

  if (mode === 'ago') {
    return formatTimeAgo(parsed, current, locale);
  }

  const diffSec = Math.max(0, Math.floor((current - parsed) / 1000));
  const p = parts(parsed, locale, tz);
  const clock = `${p.hour}:${p.minute}`;

  if (mode === 'clock') {
    if (sameDay(parsed, current, tz)) return clock;
    if (yesterday(parsed, current, tz)) return isEn ? `yesterday ${clock}` : `hôm qua ${clock}`;
    if (sameYear(parsed, current, tz)) {
      const dd = String(p.day).padStart(2, '0');
      const mm = String(p.month).padStart(2, '0');
      return `${dd}/${mm} ${clock}`;
    }
    const dd = String(p.day).padStart(2, '0');
    const mm = String(p.month).padStart(2, '0');
    return `${dd}/${mm}/${p.year}`;
  }

  // mode === 'auto'
  if (diffSec < 60) {
    return isEn ? 'just now' : 'vừa xong';
  }
  if (diffSec < 3600) {
    const mins = Math.floor(diffSec / 60);
    return isEn ? `${mins}m ago` : `${mins} phút trước`;
  }
  if (sameDay(parsed, current, tz)) {
    return clock;
  }
  if (yesterday(parsed, current, tz)) {
    return isEn ? `yesterday ${clock}` : `hôm qua ${clock}`;
  }
  const dd = String(p.day).padStart(2, '0');
  const mm = String(p.month).padStart(2, '0');
  if (sameYear(parsed, current, tz)) {
    return `${dd}/${mm} ${clock}`;
  }
  return `${dd}/${mm}/${p.year}`;
}

/**
 * Format duration in milliseconds into human-readable duration string.
 * E.g. "12 phút" / "12m", "45s", "1h 5m" / "1h 5p".
 */
export function formatDuration(durationMs: number | null | undefined, locale: TimeLocale = 'vi'): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
    return '—';
  }
  const isEn = String(locale).startsWith('en');
  const totalSec = Math.floor(durationMs / 1000);
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    return isEn ? `${totalMin}m` : `${totalMin} phút`;
  }
  const hours = Math.floor(totalMin / 60);
  const restMin = totalMin % 60;
  if (hours < 24) {
    if (restMin === 0) return `${hours}h`;
    return isEn ? `${hours}h ${restMin}m` : `${hours}h ${restMin}p`;
  }
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  if (restH === 0) return `${days}d`;
  return `${days}d ${restH}h`;
}

/**
 * Contextual label for task status timestamps.
 * E.g. "Hoàn thành 14:32", "Đang chạy từ 10:05", "Đã đẩy git 3 giờ trước".
 */
export function formatStatusTimeLabel(
  status: string,
  value: string | number | Date | null | undefined,
  locale: TimeLocale = 'vi',
  now: number | Date = Date.now(),
  t?: (key: string, params?: Record<string, string | number>) => string,
  estimated?: boolean,
): string {
  const isEn = String(locale).startsWith('en');
  const parsed = parseApiTime(value);
  if (!Number.isFinite(parsed)) {
    return t ? t(`status.${status}`) : status;
  }

  const diffSec = Math.max(0, Math.floor((nowMs(now) - parsed) / 1000));
  const timeStr = status === 'pushed' && diffSec < 86400 && diffSec >= 60
    ? formatTimeAgo(parsed, nowMs(now), locale)
    : formatShortContextualTime(parsed, locale, now);

  const getEstimatedSuffix = () => {
    if (!estimated) return '';
    if (t) {
      const trans = t('statusTime.estimatedSuffix');
      if (trans && trans !== 'statusTime.estimatedSuffix') return trans;
    }
    return isEn ? ' (estimated)' : ' (ước lượng)';
  };

  if (t) {
    const key = `statusTime.${status}`;
    const formatted = t(key, { time: timeStr });
    if (formatted && formatted !== key) {
      return `${formatted}${getEstimatedSuffix()}`;
    }
  }

  let label: string;
  if (isEn) {
    switch (status) {
      case 'running': label = `Running since ${timeStr}`; break;
      case 'checking': label = `Checking since ${timeStr}`; break;
      case 'queued': label = `Queued since ${timeStr}`; break;
      case 'waiting_quota': label = `Waiting for quota since ${timeStr}`; break;
      case 'review': label = `In review since ${timeStr}`; break;
      case 'paused': label = `Paused since ${timeStr}`; break;
      case 'draft': label = `Draft since ${timeStr}`; break;
      case 'done': label = `Completed ${timeStr}`; break;
      case 'pushed': label = `Pushed to git ${timeStr}`; break;
      case 'failed': label = `Failed ${timeStr}`; break;
      case 'blocked': label = `Blocked ${timeStr}`; break;
      case 'cancelled': label = `Cancelled ${timeStr}`; break;
      case 'merged': label = `Merged ${timeStr}`; break;
      case 'changes_requested': label = `Changes requested ${timeStr}`; break;
      case 'auditing': label = `Auditing since ${timeStr}`; break;
      case 'publishing': label = `Publishing since ${timeStr}`; break;
      default: label = `${status} ${timeStr}`; break;
    }
  } else {
    switch (status) {
      case 'running': label = `Đang chạy từ ${timeStr}`; break;
      case 'checking': label = `Đang kiểm tra từ ${timeStr}`; break;
      case 'queued': label = `Chờ chạy từ ${timeStr}`; break;
      case 'waiting_quota': label = `Chờ quota từ ${timeStr}`; break;
      case 'review': label = `Chờ duyệt từ ${timeStr}`; break;
      case 'paused': label = `Tạm dừng từ ${timeStr}`; break;
      case 'draft': label = `Nháp từ ${timeStr}`; break;
      case 'done': label = `Hoàn thành ${timeStr}`; break;
      case 'pushed': label = `Đã đẩy git ${timeStr}`; break;
      case 'failed': label = `Lỗi ${timeStr}`; break;
      case 'blocked': label = `Bị chặn ${timeStr}`; break;
      case 'cancelled': label = `Đã hủy ${timeStr}`; break;
      case 'merged': label = `Đã gộp ${timeStr}`; break;
      case 'changes_requested': label = `Yêu cầu sửa ${timeStr}`; break;
      case 'auditing': label = `Đang audit từ ${timeStr}`; break;
      case 'publishing': label = `Đang đẩy git từ ${timeStr}`; break;
      default: label = `${status} ${timeStr}`; break;
    }
  }

  return `${label}${getEstimatedSuffix()}`;
}

