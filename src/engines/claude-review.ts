import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lastNLines, type AuthDetection, type Engine, type QuotaDetection, type SpawnOpts, parseResetTime } from './index.js';
import { lowPriority } from '../priority.js';
import { lockCommand } from '../profiles/locks.js';
import { findClaudeBin } from '../chat/claude.js';
import { formatToolSummary } from '../chat/parse.js';

/** Key of the Claude reviewer in the scheduler's engine map (kept apart from worker engines). */
export const CLAUDE_REVIEW_ENGINE_KEY = 'claude-review';

/** Tools a Claude reviewer may use: read the worktree and inspect git history, never write. */
export const CLAUDE_REVIEW_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(git show:*)';

/**
 * Format tool calls into concise, human-readable log lines.
 * Examples: `Read path`, `Bash(git diff …)`
 */
export function formatReviewerToolCall(name: string, input?: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return name;
  if (name === 'Bash' && typeof input.command === 'string' && input.command) {
    return `Bash(${input.command})`;
  }
  if ((name === 'Read' || name === 'View') && (typeof input.file_path === 'string' || typeof input.path === 'string')) {
    const p = String(input.file_path || input.path);
    return `Read ${p}`;
  }
  if (name === 'Grep') {
    const pat = input.pattern ? String(input.pattern) : '';
    const p = input.path ? ` in ${input.path}` : '';
    return `Grep ${pat}${p}`.trim();
  }
  if (name === 'Glob') {
    const pat = input.pattern ? String(input.pattern) : '';
    return `Glob ${pat}`.trim();
  }
  return formatToolSummary(name, input);
}

/**
 * Summarize tool results so logs are easy to scan without dumping huge diffs/files.
 */
export function formatReviewerToolResult(output?: string, isError?: boolean): string {
  if (!output || !output.trim()) return isError ? '  → Lỗi (không có dữ liệu)' : '  → (trống)';
  const trimmed = output.trim();
  if (isError) {
    const firstLine = trimmed.split('\n')[0].slice(0, 120);
    return `  → Lỗi: ${firstLine}`;
  }
  const lines = trimmed.split('\n');
  if (lines.length === 1 && lines[0].length <= 80) {
    return `  → ${lines[0]}`;
  }
  return `  → (${lines.length} dòng)`;
}

/**
 * Parses JSONL stream from `claude --output-format stream-json --verbose`,
 * extracts human-readable progress lines for logPath, and extracts the final
 * answer for outputPath.
 */
export class ClaudeReviewStreamFormatter {
  private buffer = '';

  constructor(
    private onLogLine: (line: string) => void,
    private onResult: (resultText: string, isError: boolean) => void,
  ) {}

  feed(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.processLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.processLine(this.buffer);
      this.buffer = '';
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(trimmed);
    } catch {
      // Non-JSON line: write directly to log
      this.onLogLine(trimmed);
      return;
    }

    if (!data || typeof data !== 'object') {
      this.onLogLine(trimmed);
      return;
    }

    // 1. Result event: contains the final reviewer answer
    if (data.type === 'result') {
      const isError = Boolean(data.is_error);
      const resultStr = typeof data.result === 'string'
        ? data.result
        : data.result !== undefined && data.result !== null
          ? JSON.stringify(data.result)
          : '';

      if (resultStr) {
        this.onResult(resultStr, isError);
      }

      if (isError) {
        this.onLogLine(`[error] ${resultStr || String(data.error || 'Reviewer error')}`);
      } else {
        try {
          const parsed = JSON.parse(resultStr);
          if (parsed && typeof parsed === 'object' && parsed.verdict) {
            this.onLogLine(`[reviewer] Kết quả duyệt: ${parsed.verdict}`);
          }
        } catch { /* not json */ }
        const durationSec = typeof data.duration_ms === 'number' ? Math.round(data.duration_ms / 1000) : null;
        if (durationSec !== null) {
          this.onLogLine(`[reviewer] Hoàn thành sau ${durationSec}s`);
        }
      }
      return;
    }

    // 2. Assistant turn: message content (text and tool calls)
    if (data.type === 'assistant' && data.message && typeof data.message === 'object') {
      const msg = data.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            this.onLogLine(b.text.trim());
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
            this.onLogLine(formatReviewerToolCall(b.name, input));
          }
        }
      }
      return;
    }

    // 3. Tool results (user turn)
    if ((data.type === 'user' || data.type === 'tool_result') && data.message && typeof data.message === 'object') {
      const msg = data.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'tool_result') {
            const tr = item as Record<string, unknown>;
            const content = typeof tr.content === 'string'
              ? tr.content
              : tr.content !== undefined && tr.content !== null
                ? JSON.stringify(tr.content)
                : '';
            this.onLogLine(formatReviewerToolResult(content, Boolean(tr.is_error)));
          }
        }
      }
      return;
    }

    // 4. Standalone tool_result event
    if (data.type === 'tool_result') {
      const content = typeof data.content === 'string'
        ? data.content
        : data.output !== undefined && data.output !== null
          ? String(data.output)
          : '';
      this.onLogLine(formatReviewerToolResult(content, Boolean(data.is_error)));
      return;
    }

    // 5. Explicit error events
    if (data.type === 'error' && data.error) {
      const errMsg = typeof data.error === 'string'
        ? data.error
        : (data.error as Record<string, unknown>).message || JSON.stringify(data.error);
      this.onLogLine(`[error] ${errMsg}`);
      return;
    }

    // 6. Direct verdict mock (backward compatibility with test stubs)
    if (typeof data.verdict === 'string') {
      this.onResult(trimmed, false);
      this.onLogLine(`[reviewer] Kết quả duyệt: ${data.verdict}`);
      return;
    }
  }
}

/**
 * Read-only reviewer on the Claude CLI, used when every Codex account is unavailable.
 * Writes the final answer (the reviewer JSON verdict) to outputPath and human-readable progress to logPath.
 */
export class ClaudeReviewEngine implements Engine {
  id = 'claude' as const;

  constructor(private configuredBin?: string) {}

  family(_model: string): string {
    return 'claude';
  }

  spawn(opts: SpawnOpts): ChildProcess {
    // Resolved per run: the service PATH usually lacks `claude`, and the VS Code build path changes on update.
    const claudeBin = findClaudeBin(this.configuredBin);
    if (!claudeBin) throw new Error('Claude CLI not found');
    const model = opts.model.startsWith('claude:') ? opts.model.slice('claude:'.length) : opts.model;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'default',
      '--allowedTools', CLAUDE_REVIEW_TOOLS,
      ...(model ? ['--model', model] : []),
    ];
    fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
    if (opts.outputPath) {
      fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
      fs.writeFileSync(opts.outputPath, '', 'utf8');
    }
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ENABLE_TOOL_SEARCH: 'false', ...(opts.env || {}) };
    if (opts.profile.kind === 'isolated' && opts.profile.home) env.CLAUDE_CONFIG_DIR = opts.profile.home;

    const [exe, exeArgs] = lowPriority(claudeBin, args);
    const [executable, command] = opts.lockFile ? lockCommand(opts.lockFile, [exe, ...exeArgs]) : [exe, exeArgs];
    const child = spawn(executable, command, { cwd: opts.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });

    const formatter = new ClaudeReviewStreamFormatter(
      (line) => {
        try {
          fs.appendFileSync(opts.logPath, line + '\n', 'utf8');
        } catch { /* ignore write error */ }
      },
      (resultText) => {
        if (opts.outputPath) {
          try {
            fs.writeFileSync(opts.outputPath, resultText, 'utf8');
          } catch { /* ignore write error */ }
        }
      },
    );

    child.stdout?.on('data', (chunk) => formatter.feed(chunk));
    child.stdout?.on('end', () => formatter.flush());
    child.stderr?.on('data', (chunk) => {
      try {
        fs.appendFileSync(opts.logPath, chunk.toString('utf-8'), 'utf8');
      } catch { /* ignore */ }
    });
    child.on('error', () => formatter.flush());
    child.on('close', () => formatter.flush());

    // The prompt goes through stdin so task text can never be parsed as CLI flags.
    child.stdin?.on('error', () => { /* child exited before reading */ });
    child.stdin?.end(opts.prompt);
    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    const tail = lastNLines(logTail, 50);
    const isQuota = /usage limit|limit reached|rate limit|rate_limit|insufficient_quota|hit your (?:session|usage|weekly|daily) limit|exhausted.*(?:usage|quota|limit)|(?:usage|quota|limit).*exhausted|\b429\b/i.test(tail);
    if (isQuota) {
      return { exhausted: true, resetSeconds: parseResetTime(tail) };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 50);
    return {
      expired: /not logged in|invalid api key|please run \/login|authentication failed|unauthenticated|\b401\b/i.test(tail),
    };
  }

  detectTransientError(logTail: string): boolean {
    const tail = lastNLines(logTail, 50);
    return /overloaded|ECONNRESET|ETIMEDOUT|socket hang up|\b5\d\d\b/i.test(tail);
  }
}
