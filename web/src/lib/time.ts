export type TimeLocale = 'vi' | 'en' | string;

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
/** Parse API timestamps, including legacy SQLite UTC strings without a suffix. */
export function parseApiTime(value: string | number): number {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'string') return NaN;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return Date.parse(match ? `${match[1]}T${match[2]}Z` : value);
}

export function formatTimeAgo(value: string | number, now = Date.now(), locale: TimeLocale = 'vi'): string {
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

function parts(ms: number, locale: TimeLocale) {
  const date = new Date(ms);
  const formatter = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const values = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return { day: Number(values.day), month: Number(values.month), hour: values.hour, minute: values.minute, weekday: date.toLocaleDateString(locale === 'en' ? 'en-US' : 'vi-VN', { timeZone: TIME_ZONE, weekday: 'long' }) };
}

function sameDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b);
}

function tomorrow(target: number, current: number): boolean {
  return dayKey(target) - dayKey(current) === 86400000;
}

function dayKey(ms: number): number {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
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
