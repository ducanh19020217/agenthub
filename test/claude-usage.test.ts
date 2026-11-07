import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeUsage, parseResetTime, runClaudeUsage } from '../src/quota/claude-usage.js';

// 2026-10-20 18:00 in Asia/Ho_Chi_Minh (UTC+7)
const NOW = new Date(Date.UTC(2026, 9, 20, 11, 0));

describe('Claude /usage', () => {
  it('đọc phiên 5 giờ và tuần từ màn hình /usage thật', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage.txt'), 'utf8');
    const rows = parseClaudeUsage(raw, NOW);
    expect(rows.map((r) => [r.group, r.window, r.usedPercent])).toEqual([
      ['Claude', '5h', 84],
      ['Claude', 'week', 77],
    ]);
    // 6:50pm today and Oct 21 5am, Ho Chi Minh time
    expect(rows[0].resetAt).toBe(Date.UTC(2026, 9, 20, 11, 50) / 1000);
    expect(rows[1].resetAt).toBe(Date.UTC(2026, 9, 20, 22, 0) / 1000);
  });

  it('giờ đã qua trong ngày thì lấy ngày hôm sau', () => {
    expect(parseResetTime('9am', 'Asia/Ho_Chi_Minh', NOW)).toBe(Date.UTC(2026, 9, 21, 2, 0) / 1000);
  });

  it('nhận giới hạn tuần riêng theo model', () => {
    const raw = 'Current week (all models)  ██ 40%used Resets Oct 21, 5am (UTC)\nCurrent week (Opus only) █ 90%used Resets Oct 22 at 1:30pm (UTC)';
    const rows = parseClaudeUsage(raw, NOW);
    expect(rows.map((r) => [r.group, r.usedPercent])).toEqual([['Claude', 40], ['Claude (Opus)', 90]]);
    expect(rows[1].resetAt).toBe(Date.UTC(2026, 9, 22, 13, 30) / 1000);
  });

  it('vượt qua theme picker, Security notes và trust folder rồi mới gõ /usage', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-usage-'));
    try {
      const raw = await runClaudeUsage({ claudeBin: path.join(__dirname, 'fixtures', 'fake-claude-usage.mjs'), cwd, timeoutMs: 20_000 });
      expect(parseClaudeUsage(raw, NOW).map((r) => [r.window, r.usedPercent])).toEqual([['5h', 84], ['week', 77]]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
