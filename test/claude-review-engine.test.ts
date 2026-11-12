import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeReviewEngine, ClaudeReviewStreamFormatter, CLAUDE_REVIEW_TOOLS } from '../src/engines/claude-review.js';
import { parseReviewerOutput } from '../src/reviewer.js';
import type { ProfileRow } from '../src/db/index.js';

describe('ClaudeReviewEngine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-review-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs claude read-only, feeds the prompt on stdin and writes the answer to outputPath', async () => {
    const record = path.join(tmpDir, 'record.json');
    const fakeBin = path.join(tmpDir, 'claude');
    fs.writeFileSync(fakeBin, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input, configDir: process.env.CLAUDE_CONFIG_DIR }));
  process.stdout.write('{"verdict":"approved","feedback":"ok"}');
});
`, { mode: 0o755 });
    const profile = { name: 'claude-1', engine: 'claude', kind: 'isolated', home: path.join(tmpDir, 'home'), email: null, enabled: 1 } as unknown as ProfileRow;
    const outputPath = path.join(tmpDir, 'out.json');
    const child = new ClaudeReviewEngine(fakeBin).spawn({
      profile,
      model: 'claude:sonnet',
      cwd: tmpDir,
      prompt: '--permission-mode bypassPermissions review this',
      logPath: path.join(tmpDir, 'logs', 'run.log'),
      outputPath,
    });
    await new Promise((resolve) => child.once('exit', resolve));

    const seen = JSON.parse(fs.readFileSync(record, 'utf8')) as { argv: string[]; input: string; configDir: string };
    expect(seen.argv[seen.argv.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(seen.argv).toContain('--verbose');
    expect(seen.argv[seen.argv.indexOf('--permission-mode') + 1]).toBe('default');
    expect(seen.argv[seen.argv.indexOf('--allowedTools') + 1]).toBe(CLAUDE_REVIEW_TOOLS);
    expect(seen.argv).toContain('sonnet');
    expect(seen.argv).not.toContain('bypassPermissions');
    expect(seen.input).toBe('--permission-mode bypassPermissions review this');
    expect(seen.configDir).toBe(profile.home);
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('"approved"');
  });

  it('streams JSONL assistant/tool_use/result to human-readable log and writes verdict to outputPath', async () => {
    const fakeBin = path.join(tmpDir, 'claude');
    const events = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Bắt đầu duyệt code.' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git diff main...HEAD' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'diff --git a/file b/file\n+added', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/index.ts' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'console.log("hello");\nline 2', is_error: false }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Mã nguồn đáp ứng mọi yêu cầu.' }] } }),
      JSON.stringify({ type: 'result', is_error: false, duration_ms: 12500, result: JSON.stringify({ verdict: 'approved', feedback: 'Code tốt, đã đối chiếu checklist: không vi phạm.' }) }),
    ].join('\n') + '\n';

    fs.writeFileSync(fakeBin, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(events)});
});
`, { mode: 0o755 });

    const profile = { name: 'claude-stream', engine: 'claude', kind: 'isolated', home: path.join(tmpDir, 'home'), email: null, enabled: 1 } as unknown as ProfileRow;
    const logPath = path.join(tmpDir, 'logs', 'stream.log');
    const outputPath = path.join(tmpDir, 'out.json');

    const child = new ClaudeReviewEngine(fakeBin).spawn({
      profile,
      model: 'claude:sonnet',
      cwd: tmpDir,
      prompt: 'Review please',
      logPath,
      outputPath,
    });
    await new Promise((resolve) => child.once('exit', resolve));

    // Verify logPath contains human-readable lines
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('Bắt đầu duyệt code.');
    expect(logText).toContain('Bash(git diff main...HEAD)');
    expect(logText).toContain('Read src/index.ts');
    expect(logText).toContain('Mã nguồn đáp ứng mọi yêu cầu.');
    expect(logText).toContain('[reviewer] Kết quả duyệt: approved');
    expect(logText).toContain('[reviewer] Hoàn thành sau 13s');
    // Ensure raw JSONL was not dumped directly
    expect(logText).not.toContain('{"type":"assistant"');

    // Verify outputPath contains the result payload and parseReviewerOutput reads it
    const outputText = fs.readFileSync(outputPath, 'utf8');
    const parsed = parseReviewerOutput(outputText);
    expect(parsed).toEqual({
      verdict: 'approved',
      feedback: 'Code tốt, đã đối chiếu checklist: không vi phạm.',
    });
  });

  it('recognises Claude usage limits as quota exhaustion', () => {
    const engine = new ClaudeReviewEngine();
    expect(engine.detectQuota('Claude AI usage limit reached|1792700000').exhausted).toBe(true);
    expect(engine.detectQuota("You've hit your session limit · resets 7:10pm (Asia/Ho_Chi_Minh)").exhausted).toBe(true);
    expect(engine.detectQuota('all good').exhausted).toBe(false);
  });

  it('detects quota exhaustion in result event with is_error and parses reset time', () => {
    const engine = new ClaudeReviewEngine();
    const resultJson = JSON.stringify({
      type: 'result',
      is_error: true,
      result: "You've hit your usage limit. Try again in 2h 30m.",
    });
    const quota = engine.detectQuota(resultJson);
    expect(quota.exhausted).toBe(true);
    // 2h30m = 9000s + 60s buffer = 9060
    expect(quota.resetSeconds).toBe(9060);
  });

  it('detects quota exhaustion with rate_limit_error and 429', () => {
    const engine = new ClaudeReviewEngine();
    const rateLimitJson = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit reached (429)' },
    });
    expect(engine.detectQuota(rateLimitJson).exhausted).toBe(true);
    expect(engine.detectQuota('[stderr] Error: 429 Too Many Requests').exhausted).toBe(true);
    expect(engine.detectQuota('[error] Rate limit reached (429)').exhausted).toBe(true);
  });

  it('detects auth errors in result event and plain stdout', () => {
    const engine = new ClaudeReviewEngine();
    const authJson = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Error: not logged in. Please run claude login.',
    });
    expect(engine.detectAuthError(authJson).expired).toBe(true);
    expect(engine.detectAuthError('[stderr] 401 Unauthorized: Invalid API key').expired).toBe(true);
    expect(engine.detectAuthError('All good, approved').expired).toBe(false);
  });

  it('detects transient errors in result event and plain stdout', () => {
    const engine = new ClaudeReviewEngine();
    const transientJson = JSON.stringify({
      type: 'result',
      is_error: true,
      result: '529 Overloaded: Claude is currently experiencing high traffic.',
    });
    expect(engine.detectTransientError(transientJson)).toBe(true);
    expect(engine.detectTransientError('[stderr] ECONNRESET while connecting to Claude API')).toBe(true);
    expect(engine.detectTransientError('All checks passed')).toBe(false);
  });

  it('negative: assistant prose mentioning rate limit, 429 or 401 does not trigger quota or auth error', () => {
    const engine = new ClaudeReviewEngine();
    const assistantLog = [
      'Bắt đầu duyệt code.',
      'Tôi đang kiểm tra cơ chế xử lý rate limit và trả về 429 khi người dùng gọi API quá nhiều.',
      'Đồng thời kiểm tra hàm verifyToken trả về 401 unauthenticated nếu token không hợp lệ.',
      'Tất cả đã xử lý đúng theo tài liệu.',
    ].join('\n');

    expect(engine.detectQuota(assistantLog).exhausted).toBe(false);
    expect(engine.detectAuthError(assistantLog).expired).toBe(false);

    // Also verify successful verdict JSON is not parsed as quota or auth error
    const approvedVerdict = JSON.stringify({
      verdict: 'approved',
      feedback: 'Code xử lý tốt rate limit, 429 và 401 unauthenticated.',
    });
    expect(engine.detectQuota(approvedVerdict).exhausted).toBe(false);
    expect(engine.detectAuthError(approvedVerdict).expired).toBe(false);
  });

  it('negative: Claude reviewer timeout with last assistant line containing "429 rate limit" is not quota exhaustion', () => {
    const engine = new ClaudeReviewEngine();
    // Assistant prose starting with or containing "429 rate limit"
    const timeoutLog = [
      'Bắt đầu duyệt code.',
      'Read src/index.ts',
      '  → (40 dòng)',
      '429 rate limit handling looks fine',
    ].join('\n');

    expect(engine.detectQuota(timeoutLog).exhausted).toBe(false);
    expect(engine.detectAuthError(timeoutLog).expired).toBe(false);
  });

  it('detects quota exhaustion when result event is_error has limit', () => {
    const engine = new ClaudeReviewEngine();
    const isErrorQuota = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Rate limit reached: You have hit your usage limit. Try again later.',
    });
    expect(engine.detectQuota(isErrorQuota).exhausted).toBe(true);
  });

  it('handles multi-byte UTF-8 split across chunks in ClaudeReviewStreamFormatter', () => {
    const logLines: string[] = [];
    let resultText = '';
    let resultIsError = false;

    const formatter = new ClaudeReviewStreamFormatter(
      (line) => logLines.push(line),
      (res, isErr) => {
        resultText = res;
        resultIsError = isErr;
      },
    );

    // Vietnamese phrase containing 3-byte UTF-8 characters:
    // "Tiến độ duyệt kiểm tra: kết quả rất tốt, hoàn thành đúng hạn."
    // 'ế' is [0xE1, 0xBA, 0xBF]
    // 'ể' is [0xE1, 0xBB, 0x83]
    const assistantJson = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Kiểm tra mã nguồn: tiến độ ổn định, không phát hiện lỗi.' }],
      },
    }) + '\n';

    const resultJson = JSON.stringify({
      type: 'result',
      is_error: false,
      result: JSON.stringify({
        verdict: 'approved',
        feedback: 'Tiến độ và kết quả kiểm tra rất tốt.',
      }),
    }) + '\n';

    const fullPayload = Buffer.from(assistantJson + resultJson, 'utf8');

    // Split at multiple arbitrary points, including in the middle of UTF-8 multi-byte sequences
    // 'tiến' starts around offset 45; split right in the middle of 'ế'
    const splitOffset1 = fullPayload.indexOf(Buffer.from('tiến', 'utf8')) + 2;
    const splitOffset2 = fullPayload.indexOf(Buffer.from('kết quả', 'utf8')) + 2;

    const chunk1 = fullPayload.subarray(0, splitOffset1);
    const chunk2 = fullPayload.subarray(splitOffset1, splitOffset2);
    const chunk3 = fullPayload.subarray(splitOffset2);

    formatter.feed(chunk1);
    formatter.feed(chunk2);
    formatter.feed(chunk3);
    formatter.flush();

    expect(resultIsError).toBe(false);
    expect(resultText).not.toContain('\uFFFD');
    const parsed = JSON.parse(resultText);
    expect(parsed.feedback).toBe('Tiến độ và kết quả kiểm tra rất tốt.');
    expect(logLines).toContain('Kiểm tra mã nguồn: tiến độ ổn định, không phát hiện lỗi.');
    expect(logLines.join('\n')).not.toContain('\uFFFD');
  });

  it('negative: tool summary with line count such as 512 dòng does not trigger transient error', () => {
    const engine = new ClaudeReviewEngine();
    const log = [
      'Read src/index.ts',
      '→ (512 dòng)',
      'Const HTTP_STATUS_500 = 500;',
      'Code looks good.',
    ].join('\n');

    expect(engine.detectTransientError(log)).toBe(false);
  });
});
