import { describe, it, expect } from 'vitest';
import { formatRunDuration } from '../src/mcp/index.js';

describe('formatRunDuration', () => {
  it('tính thời lượng từ startedAt ISO và endedAt kiểu SQLite', () => {
    expect(formatRunDuration({ startedAt: '2026-11-12T04:50:25.166Z', endedAt: '2026-11-12 06:50:27', outcome: 'timeout' })).toBe('2h0m');
  });

  it('ưu tiên durationMs khi có', () => {
    expect(formatRunDuration({ durationMs: 90_000 })).toBe('1m');
  });

  it('run đã có outcome nhưng thiếu thời gian thì không báo đang chạy', () => {
    expect(formatRunDuration({ outcome: 'crashed' })).toBe('đã kết thúc');
  });

  it('run chưa kết thúc thì báo đang chạy', () => {
    expect(formatRunDuration({ startedAt: new Date(Date.now() - 5 * 60_000).toISOString() })).toBe('đang chạy 5m');
  });
});
