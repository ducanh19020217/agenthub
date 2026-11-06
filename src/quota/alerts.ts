import { formatReset } from '../time-format.js';

/** Chuỗi ngắn cho cảnh báo quota.low, dùng chung cho desktop và Telegram. */
export function quotaLowText(p: Record<string, unknown>, now = Date.now()): string {
  const name = String(p.profile || 'Hồ sơ');
  const pct = typeof p.remainingPct === 'number' ? p.remainingPct : '?';
  const window = p.window === 'week' ? 'tuần' : '5 giờ';
  const group = p.group ? ` (${String(p.group)})` : '';
  // Cùng cách hiện thời gian reset với các thông báo quota khác (formatReset của upstream).
  const reset = typeof p.resetAt === 'number' && p.resetAt > 0 ? ` · reset ${formatReset(p.resetAt, now)}` : '';
  return `Hồ sơ ${name} còn ${pct}% quota ${window}${group}${reset}`;
}
