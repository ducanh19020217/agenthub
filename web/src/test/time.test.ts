import { describe, expect, it } from 'vitest';
import { formatReset, formatResetCompact, formatTimeAgo, parseApiTime } from '../lib/time';

describe('API time helpers', () => {
  it('treats legacy SQLite timestamps as UTC', () => {
    expect(parseApiTime('2026-10-15 08:20:00')).toBe(Date.parse('2026-10-15T08:20:00Z'));
  });

  it('formats legacy timestamps as relative time', () => {
    const now = Date.parse('2026-10-15T08:21:00Z');
    expect(formatTimeAgo('2026-10-15 08:20:00', now)).toBe('1 phút trước');
  });

  it('handles invalid timestamps in formatTimeAgo with localized fallback', () => {
    const now = Date.parse('2026-10-15T08:21:00Z');
    expect(formatTimeAgo(NaN, now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo(NaN, now, 'en')).toBe('time unknown');
    expect(formatTimeAgo('invalid date', now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo('invalid date', now, 'en')).toBe('time unknown');
    expect(formatTimeAgo('', now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo('', now, 'en')).toBe('time unknown');
    expect(formatTimeAgo(null as any, now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo(null as any, now, 'en')).toBe('time unknown');
  });

  it('formats reset with an absolute Vietnam time for seconds and milliseconds', () => {
    const now = Date.parse('2026-10-15T01:00:00Z');
    const reset = Date.parse('2026-10-15T03:15:00Z');
    expect(formatReset(Math.floor(reset / 1000), now, 'vi')).toContain('còn 2 giờ 15 phút');
    expect(formatReset(reset, now, 'vi')).toContain('10:15 hôm nay');
  });

  it('handles tomorrow, week resets, expired and missing values', () => {
    const now = Date.parse('2026-10-15T16:00:00Z');
    expect(formatReset(Date.parse('2026-10-15T18:10:00Z'), now, 'vi')).toContain('01:10 ngày mai');
    expect(formatReset(Date.parse('2026-10-19T01:00:00Z'), now, 'vi')).toContain('Thứ Hai');
    expect(formatReset(now - 1000, now, 'vi')).toContain('đã reset lúc');
    expect(formatReset(null, now, 'vi')).toBe('chưa rõ thời điểm reset');
  });

  describe('formatResetCompact', () => {
    it('formats reset today with hours, minutes and time without "hôm nay"', () => {
      // 2026-10-22 15:50:00 VN = 2026-10-22 08:50:00 UTC
      const now = Date.parse('2026-10-22T08:50:00Z');
      // 2026-10-22 20:48:00 VN = 2026-10-22 13:48:00 UTC (sau 4 giờ 58 phút)
      const reset = Date.parse('2026-10-22T13:48:00Z');
      expect(formatResetCompact(reset, now, 'vi')).toBe('4h58m - 20:48');
    });

    it('formats reset on future day with short weekday and date', () => {
      // 2026-10-22 (Thứ Năm) 08:48:00 UTC = 15:48:00 VN
      const now = Date.parse('2026-10-22T08:48:00Z');
      // 2026-10-29 (Thứ Năm tuần sau) 08:48:00 UTC = 15:48:00 VN (sau đúng 7 ngày)
      const reset = Date.parse('2026-10-29T08:48:00Z');
      expect(formatResetCompact(reset, now, 'vi')).toBe('7d - T5 29/10 15:48');

      // 2026-10-26 (Thứ Hai) 16:37:00 UTC = 23:37:00 VN (sau 5 ngày)
      const resetMonday = Date.parse('2026-10-26T16:37:00Z');
      expect(formatResetCompact(resetMonday, now, 'vi')).toBe('5d - T2 26/10 23:37');
    });

    it('formats reset with hour only and minute only', () => {
      const now = Date.parse('2026-10-22T08:00:00Z'); // 15:00 VN
      const resetHour = Date.parse('2026-10-22T12:00:00Z'); // 19:00 VN (sau 4h)
      expect(formatResetCompact(resetHour, now, 'vi')).toBe('4h - 19:00');

      const resetMinute = Date.parse('2026-10-22T08:45:00Z'); // 15:45 VN (sau 45m)
      expect(formatResetCompact(resetMinute, now, 'vi')).toBe('45m - 15:45');
    });

    it('formats english compact reset correctly', () => {
      const now = Date.parse('2026-10-22T08:50:00Z');
      const resetToday = Date.parse('2026-10-22T13:48:00Z');
      expect(formatResetCompact(resetToday, now, 'en')).toBe('4h58m - 20:48');

      const resetFuture = Date.parse('2026-10-29T08:48:00Z');
      expect(formatResetCompact(resetFuture, now, 'en')).toBe('7d - Thu 29/10 15:48');
    });

    it('handles expired and null timestamps', () => {
      const now = Date.parse('2026-10-22T08:50:00Z'); // 15:50 VN
      expect(formatResetCompact(now - 1000, now, 'vi')).toBe('đã reset 15:49');
      expect(formatResetCompact(null, now, 'vi')).toBe('chưa rõ');
    });
  });
});
