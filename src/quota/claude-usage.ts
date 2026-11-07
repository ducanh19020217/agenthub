import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';

export interface ClaudeUsageWindow {
  /** quota_usage group: 'Claude' for all models, or e.g. 'Claude (Opus)' for a per-model weekly limit. */
  group: string;
  window: '5h' | 'week';
  usedPercent: number;
  resetAt: number;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Normalise terminal output: cursor-forward becomes spaces, other escapes are dropped. */
export function cleanTerminalOutput(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex -- terminal escape sequences
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Number(n || 1)))
    // eslint-disable-next-line no-control-regex -- terminal escape sequences
    .replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[=>()78][A-Z0-9]?/g, '')
    .replace(/\r/g, '');
}

/** UTC offset (minutes) of a time zone at a given instant. */
function tzOffsetMinutes(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Parse "6:50pm" (next occurrence) or "Oct 21, 5am" / "Oct 21 at 5:30am" in `timeZone`.
 * Returns epoch seconds, or 0 when the text is not understood.
 */
export function parseResetTime(text: string, timeZone: string, now = new Date()): number {
  const m = text.trim().match(/^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return 0;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  const minute = Number(m[4] || 0);
  const offset = tzOffsetMinutes(timeZone, now);
  // Wall-clock "now" in the target zone.
  const local = new Date(now.getTime() + offset * 60000);
  let year = local.getUTCFullYear();
  let month = local.getUTCMonth();
  let day = local.getUTCDate();
  if (m[1]) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon === undefined) return 0;
    if (mon < month - 6) year += 1; // e.g. "Jan 2" seen in December
    month = mon;
    day = Number(m[2]);
  }
  let epochMs = Date.UTC(year, month, day, hour, minute) - offset * 60000;
  if (!m[1] && epochMs <= now.getTime()) epochMs += 24 * 3600 * 1000; // time only: next occurrence
  return Math.floor(epochMs / 1000);
}

/** Extract the 5-hour session and weekly limits from Claude Code's `/usage` screen. */
export function parseClaudeUsage(raw: string, now = new Date()): ClaudeUsageWindow[] {
  const text = cleanTerminalOutput(raw);
  const result: ClaudeUsageWindow[] = [];
  const re = /Current\s*(session|week(?:\s*\(([^)]*)\))?)[^%]*?(\d{1,3})%\s*used\s*Resets\s*([^(\n]+?)\s*\(([^)]+)\)/g;
  for (const m of text.matchAll(re)) {
    const isSession = m[1] === 'session';
    const scope = (m[2] || '').trim();
    const allModels = !scope || /all models/i.test(scope);
    const group = isSession || allModels ? 'Claude' : `Claude (${scope.replace(/\s*only$/i, '')})`;
    const window = isSession ? '5h' : 'week';
    if (result.some((r) => r.group === group && r.window === window)) continue;
    result.push({ group, window, usedPercent: Math.min(100, Number(m[3])), resetAt: parseResetTime(m[4], m[5], now) });
  }
  return result;
}

export interface ClaudeUsageRunOptions {
  claudeBin: string;
  /** CLAUDE_CONFIG_DIR for isolated profiles; undefined uses the machine's own Claude login. */
  configDir?: string;
  /** Directory to run in (trusted on first run). */
  cwd: string;
  timeoutMs?: number;
}

/** Open Claude Code in a PTY, run `/usage`, and return the raw screen output. */
export function runClaudeUsage(opts: ClaudeUsageRunOptions): Promise<string> {
  fs.mkdirSync(opts.cwd, { recursive: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Do not inherit markers from a parent Claude Code session (e.g. when the hub runs inside one).
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') delete env[key];
  }
  if (opts.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
  return new Promise((resolve) => {
    let out = '';
    let sent = false;
    let trusted = false;
    let continued = 0;
    let done = false;
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    const proc = pty.spawn(opts.claudeBin, [], { name: 'xterm-256color', cols: 120, rows: 50, cwd: path.resolve(opts.cwd), env });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (promptTimer) clearTimeout(promptTimer);
      try { proc.write('\x1b'); } catch { /* exited */ }
      setTimeout(() => { try { proc.kill(); } catch { /* exited */ } }, 200);
      resolve(out);
    };
    const sendUsage = () => {
      if (sent || done) return;
      sent = true;
      out = '';
      proc.write('/usage');
      setTimeout(() => { try { proc.write('\r'); } catch { /* exited */ } }, 800);
    };
    const waitForPrompt = () => {
      if (sent || done) return;
      // Claude Code renders its input prompt as a standalone ❯ (or > in
      // plain terminals). Waiting for it avoids sending /usage while the
      // CLI is still loading under a slow systemd environment.
      const text = cleanTerminalOutput(out);
      if (/(?:^|\n)\s*[❯>]\s*$/.test(text)) {
        sendUsage();
        return;
      }
      promptTimer = setTimeout(waitForPrompt, 250);
    };
    proc.onData((data) => {
      out += data;
      const text = cleanTerminalOutput(out);
      if (!sent && !trusted && /trust\s*this\s*folder/i.test(text)) {
        // Default choice is "No, exit": move down to "Yes, I trust this folder".
        // The dialog ignores keys sent the instant it renders, so wait before answering.
        trusted = true;
        setTimeout(() => { try { proc.write('\x1b[B'); } catch { /* exited */ } }, 1500);
        setTimeout(() => { try { proc.write('\r'); } catch { /* exited */ } }, 2700);
        return;
      }
      // Newer CLI versions start with onboarding screens (theme picker, "Security notes") that wait
      // for Enter before the prompt appears. Count occurrences so each new screen is answered once.
      const continues = (text.match(/Syntax\s*theme:|Press\s*Enter\s*to\s*continue/gi) || []).length;
      if (!sent && continues > continued) {
        continued = continues;
        setTimeout(() => { try { proc.write('\r'); } catch { /* exited */ } }, 1500);
        return;
      }
      if (sent && /Current\s*(?:session|week)[\s\S]*?%\s*used[\s\S]*?Resets[^\n]*\)/i.test(text)) {
        setTimeout(finish, 300);
      }
    });
    proc.onExit(() => finish());
    // Keep a generous fallback for CLI versions that do not render a clean
    // standalone prompt, while preferring the readiness signal above.
    const sendTimer = setTimeout(sendUsage, 20_000);
    promptTimer = setTimeout(waitForPrompt, 250);
    const timer = setTimeout(finish, opts.timeoutMs ?? 45000);
  });
}
