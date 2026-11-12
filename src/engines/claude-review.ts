import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lastNLines, type AuthDetection, type Engine, type QuotaDetection, type SpawnOpts, parseResetTime } from './index.js';
import { lowPriority } from '../priority.js';
import { lockCommand } from '../profiles/locks.js';
import { findClaudeBin } from '../chat/claude.js';
import { isClaudeAuthError } from '../profiles/auth.js';

/** Key of the Claude reviewer in the scheduler's engine map (kept apart from worker engines). */
export const CLAUDE_REVIEW_ENGINE_KEY = 'claude-review';

/** Tools a Claude reviewer may use: read the worktree and inspect git history, never write. */
export const CLAUDE_REVIEW_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git status:*),Bash(git show:*)';

/**
 * Read-only reviewer on the Claude CLI, used when every Codex account is unavailable.
 * Writes the final answer (the reviewer JSON verdict) to outputPath and diagnostics to logPath.
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
      '--output-format', 'text',
      '--permission-mode', 'default',
      '--allowedTools', CLAUDE_REVIEW_TOOLS,
      ...(model ? ['--model', model] : []),
    ];
    fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
    const logFd = fs.openSync(opts.logPath, 'a');
    const outFd = opts.outputPath ? fs.openSync(opts.outputPath, 'w') : logFd;
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ENABLE_TOOL_SEARCH: 'false', ...(opts.env || {}) };
    if (opts.profile.kind === 'isolated' && opts.profile.home) env.CLAUDE_CONFIG_DIR = opts.profile.home;

    const [exe, exeArgs] = lowPriority(claudeBin, args);
    const [executable, command] = opts.lockFile ? lockCommand(opts.lockFile, [exe, ...exeArgs]) : [exe, exeArgs];
    const child = spawn(executable, command, { cwd: opts.cwd, env, detached: true, stdio: ['pipe', outFd, logFd] });
    const closeFds = () => {
      for (const fd of new Set([logFd, outFd])) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
    };
    child.on('spawn', closeFds);
    child.on('error', closeFds);
    // The prompt goes through stdin so task text can never be parsed as CLI flags.
    child.stdin?.on('error', () => { /* child exited before reading */ });
    child.stdin?.end(opts.prompt);
    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    const tail = lastNLines(logTail, 8);
    if (/usage limit|limit reached|rate limit|hit your (session|usage|weekly|daily) limit|\b429\b/i.test(tail)) {
      return { exhausted: true, resetSeconds: parseResetTime(tail) };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 8);
    return { expired: isClaudeAuthError(tail) };
  }

  detectTransientError(logTail: string): boolean {
    return /overloaded|ECONNRESET|ETIMEDOUT|socket hang up|\b5\d\d\b/i.test(lastNLines(logTail, 8));
  }
}
