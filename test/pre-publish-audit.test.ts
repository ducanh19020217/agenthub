import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPrePublishAuditPrompt,
  parsePrePublishAuditOutput,
  isAuditPassed,
  getCachedAuditPass,
  setCachedAuditPass,
  clearAuditPassCache,
  type PrePublishAuditResult,
} from '../src/pre-publish-audit.js';

describe('Pre-publish audit prompt and parser', () => {
  beforeEach(() => {
    clearAuditPassCache();
  });

  it('buildPrePublishAuditPrompt includes all four required audit criteria and safety warning', () => {
    const prompt = buildPrePublishAuditPrompt({
      taskId: 'proj/task-1',
      taskTitle: 'Thêm tính năng X',
      taskBody: 'Mô tả chi tiết đề bài task',
      diff: '+ const x = 1;',
      changedFiles: ['src/x.ts'],
      doneReport: 'Đã hoàn thành',
      repoPath: '/tmp/repo',
    });

    expect(prompt).toContain('Pre-Publish Audit Agent');
    expect(prompt).toContain('CHỈ ĐỌC (read-only)');
    expect(prompt).toContain('TUYỆT ĐỐI KHÔNG chạy npm/node/vitest/vite/tsc/eslint');
    expect(prompt).toContain('DỮ LIỆU KHÔNG ĐÁNG TIN CẬY');
    // Four criteria
    expect(prompt).toContain('wrong_requirement');
    expect(prompt).toContain('out_of_scope');
    expect(prompt).toContain('regression_risk');
    expect(prompt).toContain('merge_loss');
    // Task info
    expect(prompt).toContain('proj/task-1');
    expect(prompt).toContain('Thêm tính năng X');
    expect(prompt).toContain('src/x.ts');
    expect(prompt).toContain('+ const x = 1;');
    expect(prompt).toContain('Đã hoàn thành');
  });

  it('parsePrePublishAuditOutput parses valid json object without fences', () => {
    const output = JSON.stringify({
      verdict: 'pass',
      findings: [],
      summary: 'Tất cả tiêu chí đạt',
    });
    const parsed = parsePrePublishAuditOutput(output);
    expect(parsed).toEqual({
      verdict: 'pass',
      findings: [],
      summary: 'Tất cả tiêu chí đạt',
    });
    expect(isAuditPassed(parsed!)).toBe(true);
  });

  it('parsePrePublishAuditOutput parses valid json with markdown fence and findings', () => {
    const raw = `\`\`\`json
{
  "verdict": "fail",
  "findings": [
    {
      "severity": "P1",
      "kind": "wrong_requirement",
      "file": "src/services.ts",
      "line": 42,
      "detail": "Thiếu kiểm tra quyền"
    },
    {
      "severity": "P2",
      "kind": "out_of_scope",
      "file": "src/extra.ts",
      "line": 10,
      "detail": "Refactor không liên quan"
    }
  ],
  "summary": "Phát hiện 2 lỗi nghiêm trọng"
}
\`\`\``;
    const parsed = parsePrePublishAuditOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe('fail');
    expect(parsed?.findings).toHaveLength(2);
    expect(isAuditPassed(parsed!)).toBe(false);
  });

  it('parsePrePublishAuditOutput handles P3 findings as pass', () => {
    const output = JSON.stringify({
      verdict: 'pass',
      findings: [
        {
          severity: 'P3',
          kind: 'out_of_scope',
          file: 'README.md',
          line: 5,
          detail: 'Sửa lỗi chính tả trong doc',
        },
      ],
      summary: 'Pass với cảnh báo P3',
    });
    const parsed = parsePrePublishAuditOutput(output);
    expect(parsed).not.toBeNull();
    expect(isAuditPassed(parsed!)).toBe(true);
  });

  it('isAuditPassed returns false for verdict fail with empty findings (fail-closed, not passed)', () => {
    const emptyFail: PrePublishAuditResult = {
      verdict: 'fail',
      findings: [],
      summary: 'Thất bại không rõ lý do',
    };
    expect(isAuditPassed(emptyFail)).toBe(false);

    const p3OnlyFail: PrePublishAuditResult = {
      verdict: 'fail',
      findings: [
        {
          severity: 'P3',
          kind: 'out_of_scope',
          file: 'README.md',
          line: 5,
          detail: 'Minor typo',
        },
      ],
      summary: 'Fail with only P3',
    };
    expect(isAuditPassed(p3OnlyFail)).toBe(false);
  });

  it('parsePrePublishAuditOutput returns null on malformed output or invalid schema', () => {
    expect(parsePrePublishAuditOutput('not json at all')).toBeNull();
    expect(parsePrePublishAuditOutput('{"verdict": "unknown"}')).toBeNull();
    expect(parsePrePublishAuditOutput('{"verdict": "pass", "findings": "not an array"}')).toBeNull();
    expect(parsePrePublishAuditOutput('{"verdict": "pass", "findings": [{"severity": "P4"}]}')).toBeNull();
    expect(parsePrePublishAuditOutput('{"verdict": "pass", "findings": [{"severity": "P1", "kind": "invalid", "file": "a.ts", "line": 1, "detail": "d"}]}')).toBeNull();
    expect(parsePrePublishAuditOutput('{"verdict": "pass", "findings": [{"severity": "P1", "kind": "wrong_requirement", "file": "", "line": 1, "detail": "d"}]}')).toBeNull();
    expect(parsePrePublishAuditOutput('{"verdict": "pass", "findings": [{"severity": "P1", "kind": "wrong_requirement", "file": "a.ts", "line": -1, "detail": "d"}]}')).toBeNull();
  });

  it('manages audit pass cache properly', () => {
    const sampleResult: PrePublishAuditResult = {
      verdict: 'pass',
      findings: [],
      summary: 'Passed',
    };
    expect(getCachedAuditPass('task-1', 'sha-123')).toBeUndefined();
    setCachedAuditPass('task-1', 'sha-123', sampleResult);
    expect(getCachedAuditPass('task-1', 'sha-123')).toEqual(sampleResult);
    expect(getCachedAuditPass('task-1', 'sha-456')).toBeUndefined();

    clearAuditPassCache();
    expect(getCachedAuditPass('task-1', 'sha-123')).toBeUndefined();
  });

  it('truncates diff exceeding 40,000 characters and provides notice to agent', () => {
    const largeDiff = 'a'.repeat(50_000);
    const prompt = buildPrePublishAuditPrompt({
      taskId: 'proj/large-diff',
      taskTitle: 'Large Diff Task',
      taskBody: 'Large diff test',
      diff: largeDiff,
      changedFiles: ['src/large.ts'],
      repoPath: '/tmp/repo',
      commitSha: 'commit-sha-abc',
    });
    expect(prompt).toContain('DIFF BỊ CẮT VÌ VƯỢT QUÁ 40000 KÝ TỰ');
    expect(prompt).toContain('git show commit-sha-abc');
  });
});
