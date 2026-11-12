import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDateTimeWithAgo,
  formatDuration,
  formatIsoTitle,
  formatReset,
  formatResetCompact,
  formatShortContextualTime,
  formatStatusTimeLabel,
  formatTime,
  formatTimeAgo,
  parseApiTime,
} from '../lib/time';

describe('API time helpers', () => {
  it('treats legacy SQLite timestamps as UTC', () => {
    expect(parseApiTime('2026-10-15 08:20:00')).toBe(Date.parse('2026-10-15T08:20:00Z'));
  });

  it('parses various input types in parseApiTime', () => {
    const expectedUtc = Date.parse('2026-11-06T17:52:44.000Z');

    // SQLite string without Z
    expect(parseApiTime('2026-11-06 17:52:44')).toBe(expectedUtc);

    // ISO string without Z (treated as UTC)
    expect(parseApiTime('2026-11-06T17:52:44')).toBe(expectedUtc);

    // ISO string with Z
    expect(parseApiTime('2026-11-06T17:52:44Z')).toBe(expectedUtc);
    expect(parseApiTime('2026-11-06T17:52:44.000Z')).toBe(expectedUtc);

    // ISO string with offset
    expect(parseApiTime('2026-11-07T00:52:44+07:00')).toBe(expectedUtc);

    // Epoch ms
    expect(parseApiTime(expectedUtc)).toBe(expectedUtc);

    // Epoch seconds (< 1e11)
    const epochSec = Math.floor(expectedUtc / 1000);
    expect(parseApiTime(epochSec)).toBe(epochSec * 1000);

    // Numeric strings
    expect(parseApiTime(String(epochSec))).toBe(epochSec * 1000);
    expect(parseApiTime(String(expectedUtc))).toBe(expectedUtc);

    // Date object
    expect(parseApiTime(new Date(expectedUtc))).toBe(expectedUtc);

    // Invalid / empty / null / undefined values
    expect(parseApiTime('invalid-date')).toBeNaN();
    expect(parseApiTime('')).toBeNaN();
    expect(parseApiTime('   ')).toBeNaN();
    expect(parseApiTime(null)).toBeNaN();
    expect(parseApiTime(undefined)).toBeNaN();
    expect(parseApiTime(NaN)).toBeNaN();
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

  describe('formatDateTime', () => {
    it('proves SQLite 2026-11-06 17:52:44 displays correctly as 07/11/2026 00:52:44 in Asia/Ho_Chi_Minh without day shift', () => {
      const sqliteTime = '2026-11-06 17:52:44';
      expect(formatDateTime(sqliteTime, 'vi', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026 00:52:44');
      expect(formatDateTime(sqliteTime, 'en', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026, 00:52:44');
    });

    it('formats ISO, offset, and epoch values for both vi and en locales', () => {
      // ISO with Z
      expect(formatDateTime('2026-11-06T17:52:44Z', 'vi', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026 00:52:44');
      expect(formatDateTime('2026-11-06T17:52:44.000Z', 'en', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026, 00:52:44');

      // ISO with offset (+07:00)
      expect(formatDateTime('2026-11-06T17:52:44+07:00', 'vi', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('06/11/2026 17:52:44');

      // Epoch ms and seconds
      const ms = Date.parse('2026-11-06T17:52:44Z');
      expect(formatDateTime(ms, 'vi', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026 00:52:44');
      expect(formatDateTime(Math.floor(ms / 1000), 'vi', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026 00:52:44');
    });

    it('supports seconds: false option', () => {
      const sqliteTime = '2026-11-06 17:52:44';
      expect(formatDateTime(sqliteTime, 'vi', { seconds: false, timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026 00:52');
      expect(formatDateTime(sqliteTime, 'en', { seconds: false, timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026, 00:52');
    });

    it('handles invalid and empty inputs gracefully without throwing', () => {
      expect(formatDateTime('invalid', 'vi')).toBe('—');
      expect(formatDateTime('', 'en')).toBe('—');
      expect(formatDateTime(null, 'vi')).toBe('—');
      expect(formatDateTime(undefined, 'vi')).toBe('—');
      expect(formatDateTime(NaN, 'vi')).toBe('—');
      expect(formatDateTime('invalid', 'vi', { fallback: 'chưa rõ thời gian' })).toBe('chưa rõ thời gian');
      expect(formatDateTime('invalid', 'en', { fallback: 'time unknown' })).toBe('time unknown');
    });
  });

  describe('formatTime', () => {
    it('formats 24h clock with seconds and without seconds', () => {
      const sqliteTime = '2026-11-06 17:52:44';
      expect(formatTime(sqliteTime, 'vi', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('00:52:44');
      expect(formatTime(sqliteTime, 'vi', { seconds: false, timeZone: 'Asia/Ho_Chi_Minh' })).toBe('00:52');
      expect(formatTime(sqliteTime, 'en', { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('00:52:44');
    });

    it('returns fallback for invalid inputs', () => {
      expect(formatTime('invalid', 'vi')).toBe('—');
      expect(formatTime('', 'vi', { fallback: '--:--' })).toBe('--:--');
    });
  });

  describe('formatDateTimeWithAgo', () => {
    it('formats date time and relative time combined', () => {
      const sqliteTime = '2026-11-06 17:52:44';
      // 3 hours later in UTC = 2026-11-06T20:52:44Z
      const now = Date.parse('2026-11-06T20:52:44Z');
      expect(formatDateTimeWithAgo(sqliteTime, 'vi', now, { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026 00:52 · 3 giờ trước');
      expect(formatDateTimeWithAgo(sqliteTime, 'en', now, { timeZone: 'Asia/Ho_Chi_Minh' })).toBe('07/11/2026, 00:52 · 3h ago');
    });

    it('handles invalid inputs with localized fallback', () => {
      expect(formatDateTimeWithAgo('invalid', 'vi')).toBe('chưa rõ thời gian');
      expect(formatDateTimeWithAgo('invalid', 'en')).toBe('time unknown');
      expect(formatDateTimeWithAgo(null, 'vi')).toBe('chưa rõ thời gian');
    });
  });

  describe('formatIsoTitle', () => {
    it('returns complete ISO string for title attributes', () => {
      expect(formatIsoTitle('2026-11-06 17:52:44')).toBe('2026-11-06T17:52:44.000Z');
      expect(formatIsoTitle('2026-11-06T17:52:44Z')).toBe('2026-11-06T17:52:44.000Z');
      expect(formatIsoTitle(1793987564000)).toBe('2026-11-06T17:52:44.000Z');
    });

    it('returns empty string for invalid inputs', () => {
      expect(formatIsoTitle('invalid')).toBe('');
      expect(formatIsoTitle('')).toBe('');
      expect(formatIsoTitle(null)).toBe('');
      expect(formatIsoTitle(undefined)).toBe('');
      expect(formatIsoTitle(NaN)).toBe('');
    });
  });

  describe('formatShortContextualTime', () => {
    // 2026-11-12 14:32:00 VN (+07:00) = 2026-11-12 07:32:00 UTC
    const now = Date.parse('2026-11-12T07:32:00Z');

    it('formats times less than a minute ago as "vừa xong" / "just now"', () => {
      const recent = now - 20 * 1000;
      expect(formatShortContextualTime(recent, 'vi', now)).toBe('vừa xong');
      expect(formatShortContextualTime(recent, 'en', now)).toBe('just now');
    });

    it('formats times less than an hour ago as "X phút trước" / "Xm ago"', () => {
      const fiveMins = now - 5 * 60 * 1000;
      expect(formatShortContextualTime(fiveMins, 'vi', now)).toBe('5 phút trước');
      expect(formatShortContextualTime(fiveMins, 'en', now)).toBe('5m ago');
    });

    it('formats times earlier today as clock time HH:mm in Asia/Ho_Chi_Minh', () => {
      // 10:05:00 VN = 03:05:00 UTC
      const tenAm = Date.parse('2026-11-12T03:05:00Z');
      expect(formatShortContextualTime(tenAm, 'vi', now)).toBe('10:05');
      expect(formatShortContextualTime(tenAm, 'en', now)).toBe('10:05');
    });

    it('formats times yesterday as "hôm qua HH:mm" / "yesterday HH:mm"', () => {
      // 2026-11-11 14:20:00 VN = 07:20:00 UTC
      const yesterdayTime = Date.parse('2026-11-11T07:20:00Z');
      expect(formatShortContextualTime(yesterdayTime, 'vi', now)).toBe('hôm qua 14:20');
      expect(formatShortContextualTime(yesterdayTime, 'en', now)).toBe('yesterday 14:20');
    });

    it('handles invalid timestamps gracefully with localized fallback', () => {
      expect(formatShortContextualTime('invalid', 'vi')).toBe('chưa rõ thời gian');
      expect(formatShortContextualTime('invalid', 'en')).toBe('time unknown');
      expect(formatShortContextualTime(null, 'vi')).toBe('chưa rõ thời gian');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds, minutes, hours and days', () => {
      expect(formatDuration(45 * 1000, 'vi')).toBe('45s');
      expect(formatDuration(45 * 1000, 'en')).toBe('45s');

      expect(formatDuration(12 * 60 * 1000, 'vi')).toBe('12 phút');
      expect(formatDuration(12 * 60 * 1000, 'en')).toBe('12m');

      expect(formatDuration((2 * 60 + 15) * 60 * 1000, 'vi')).toBe('2h 15p');
      expect(formatDuration((2 * 60 + 15) * 60 * 1000, 'en')).toBe('2h 15m');

      expect(formatDuration(3 * 3600 * 1000, 'vi')).toBe('3h');
      expect(formatDuration(3 * 3600 * 1000, 'en')).toBe('3h');

      expect(formatDuration(26 * 3600 * 1000, 'vi')).toBe('1d 2h');
      expect(formatDuration(48 * 3600 * 1000, 'en')).toBe('2d');
    });

    it('handles invalid or negative durations', () => {
      expect(formatDuration(null, 'vi')).toBe('—');
      expect(formatDuration(-100, 'vi')).toBe('—');
      expect(formatDuration(NaN, 'vi')).toBe('—');
    });
  });

  describe('formatStatusTimeLabel', () => {
    // 2026-11-12 14:32:00 VN = 07:32:00 UTC
    const now = Date.parse('2026-11-12T07:32:00Z');

    it('formats running status with "từ" / "since"', () => {
      // 10:05 VN
      const tenAm = Date.parse('2026-11-12T03:05:00Z');
      expect(formatStatusTimeLabel('running', tenAm, 'vi', now)).toBe('Đang chạy từ 10:05');
      expect(formatStatusTimeLabel('running', tenAm, 'en', now)).toBe('Running since 10:05');
    });

    it('formats done status with contextual time', () => {
      // 14:32 VN
      const doneAt = Date.parse('2026-11-12T07:32:00Z');
      expect(formatStatusTimeLabel('done', doneAt, 'vi', now)).toBe('Hoàn thành vừa xong');
      expect(formatStatusTimeLabel('done', doneAt, 'en', now)).toBe('Completed just now');

      // 10:05 VN earlier today (clock mode)
      const tenAm = Date.parse('2026-11-12T03:05:00Z');
      expect(formatStatusTimeLabel('done', tenAm, 'vi', now)).toBe('Hoàn thành 10:05');
      expect(formatStatusTimeLabel('done', tenAm, 'en', now)).toBe('Completed 10:05');
    });

    it('formats pushed status with relative time ago when pushed 3 hours ago', () => {
      const threeHoursAgo = now - 3 * 3600 * 1000;
      expect(formatStatusTimeLabel('pushed', threeHoursAgo, 'vi', now)).toBe('Đã đẩy git 3 giờ trước');
      expect(formatStatusTimeLabel('pushed', threeHoursAgo, 'en', now)).toBe('Pushed to git 3h ago');
    });

    it('supports custom translation function t if provided', () => {
      const tenAm = Date.parse('2026-11-12T03:05:00Z');
      const mockT = (key: string, params?: Record<string, string | number>) => {
        if (key === 'statusTime.running') return `Custom Running ${params?.time}`;
        return key;
      };
      expect(formatStatusTimeLabel('running', tenAm, 'en', now, mockT)).toBe('Custom Running 10:05');
    });

    it('falls back when value is null or invalid', () => {
      expect(formatStatusTimeLabel('running', null, 'vi')).toBe('running');
    });

    it('appends localized estimated suffix when estimated is true', () => {
      const tenAm = Date.parse('2026-11-12T03:05:00Z');
      expect(formatStatusTimeLabel('done', tenAm, 'vi', now, undefined, true)).toBe('Hoàn thành 10:05 (ước lượng)');
      expect(formatStatusTimeLabel('done', tenAm, 'en', now, undefined, true)).toBe('Completed 10:05 (estimated)');

      expect(formatStatusTimeLabel('running', tenAm, 'vi', now, undefined, true)).toBe('Đang chạy từ 10:05 (ước lượng)');
      expect(formatStatusTimeLabel('running', tenAm, 'en', now, undefined, true)).toBe('Running since 10:05 (estimated)');
    });
  });
});
