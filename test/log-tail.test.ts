import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readLogTail } from '../src/utils/log-tail.js';

describe('readLogTail helper', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-logtail-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('returns empty string for non-existent file or null/undefined', () => {
    expect(readLogTail(null)).toBe('');
    expect(readLogTail(undefined)).toBe('');
    expect(readLogTail(path.join(tmpDir, 'non-existent.log'))).toBe('');
  });

  it('handles empty file (0 bytes)', () => {
    const file = path.join(tmpDir, 'empty.log');
    fs.writeFileSync(file, '');
    expect(readLogTail(file)).toBe('');
    expect(readLogTail(file, { lines: 10 })).toBe('');
    expect(readLogTail(file, 512)).toBe('');
  });

  it('handles file smaller than maxBytes or requested lines', () => {
    const file = path.join(tmpDir, 'small.log');
    const content = 'line 1\nline 2\nline 3\n';
    fs.writeFileSync(file, content);

    expect(readLogTail(file)).toBe(content);
    expect(readLogTail(file, { maxBytes: 1024 })).toBe(content);
    expect(readLogTail(file, { lines: 10 })).toBe(content);
  });

  it('correctly reads last N lines when requested', () => {
    const file = path.join(tmpDir, 'lines.log');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(file, lines.join('\n'));

    expect(readLogTail(file, { lines: 3 })).toBe('line 98\nline 99\nline 100');
    expect(readLogTail(file, { lines: 1 })).toBe('line 100');
  });

  it('handles multi-byte UTF-8 boundaries cleanly without replacement characters', () => {
    const file = path.join(tmpDir, 'utf8.log');
    // Multi-byte characters:
    // Vietnamese: "Tiếng Việt có dấu: ă, â, đ, ê, ô, ơ, ư"
    // Emoji (4-byte): "🚀 🌟 🤖"
    // Let's create a string where multi-byte characters repeat
    const phrase = 'Dòng ghi chú: hoàn thành nhiệm vụ 🚀 với đánh giá xuất sắc 🌟!\n';
    // Repeat phrase enough to be around 2KB
    const content = phrase.repeat(30);
    fs.writeFileSync(file, content, 'utf8');

    // Test with various small byte limits that intentionally cut across multi-byte boundaries
    for (let bytes = 10; bytes <= 200; bytes += 7) {
      const tail = readLogTail(file, { maxBytes: bytes });
      // The result should not contain the replacement character '\uFFFD'
      expect(tail).not.toContain('\uFFFD');
      // The tail should be a suffix of content (ignoring any trimmed partial leading char)
      expect(content.endsWith(tail)).toBe(true);
    }
  });

  it('handles very long lines exceeding chunk size', () => {
    const file = path.join(tmpDir, 'long-line.log');
    // A single line of 150KB
    const longChunk = 'A'.repeat(150 * 1024);
    const content = `first line\n${longChunk}\nlast line`;
    fs.writeFileSync(file, content, 'utf8');

    const tailLines = readLogTail(file, { lines: 1 });
    expect(tailLines).toBe('last line');

    const tail2Lines = readLogTail(file, { lines: 2, maxBytes: 256 * 1024 });
    expect(tail2Lines.endsWith('\nlast line')).toBe(true);
  });

  it('supports legacy tailKB numeric argument', () => {
    const file = path.join(tmpDir, 'legacy.log');
    const content = 'A'.repeat(5000);
    fs.writeFileSync(file, content);

    // tailKB = 1 (1024 bytes)
    const result = readLogTail(file, 1);
    expect(result.length).toBe(1024);
    expect(result).toBe('A'.repeat(1024));
  });
});
