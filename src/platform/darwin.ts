import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { PlatformApi, PlatformProcessInfo, ServiceRestartResult, ServiceUninstallResult } from './types.js';
import type { ServiceInstallResult } from './types.js';
import { assertServiceWriteAllowed } from './service-safety.js';

function command(args: string[]): string {
  try {
    return execFileSync(args[0], args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
      return error.stdout;
    }
    return '';
  }
}

const TRACKED_NAMES = /^(?:node|agy|codex|claude|vitest|npm|pnpm)$/i;

function commandName(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] || '';
  return path.basename(first);
}

type ProcessRow = PlatformProcessInfo & { name: string };

function parseProcessRows(output: string): ProcessRow[] {
  return output.split('\n').flatMap((row) => {
    const fields = row.trim().split(/\s+/);
    if (fields.length < 10) return [];
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const rssKb = Number(fields[2]);
    const cpu = Number(fields[3]);
    if (![pid, ppid, rssKb, cpu].every(Number.isFinite)) return [];
    const name = fields.slice(9).join(' ');
    const parsedStart = Date.parse(fields.slice(4, 9).join(' '));
    return [{ pid, ppid, parentName: '', rss: rssKb * 1024, cpu, cwd: '', startedAt: Number.isNaN(parsedStart) ? 0 : parsedStart, name }];
  });
}

function parseCwds(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const parsed = Number(line.slice(1));
      pid = Number.isFinite(parsed) ? parsed : null;
    } else if (line.startsWith('n') && pid !== null) {
      result.set(pid, line.slice(1));
    }
  }
  return result;
}

function listProcesses(): PlatformProcessInfo[] {
  const processes = parseProcessRows(command(['ps', '-axo', 'pid=,ppid=,rss=,%cpu=,lstart=,comm=']));
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const relevant = new Set<number>(processes.filter((processInfo) => TRACKED_NAMES.test(commandName(processInfo.name))).map((processInfo) => processInfo.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (!relevant.has(processInfo.pid) && relevant.has(processInfo.ppid)) {
        relevant.add(processInfo.pid);
        changed = true;
      }
    }
  }

  const relevantPids = [...relevant].sort((left, right) => left - right);
  const cwdOutput = relevantPids.length > 0
    ? command(['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', relevantPids.join(',')])
    : '';
  const cwds = parseCwds(cwdOutput);
  return processes.map(({ name: _name, ...processInfo }) => ({
    ...processInfo,
    parentName: commandName(byPid.get(processInfo.ppid)?.name || '') || byPid.get(processInfo.ppid)?.name || '',
    cwd: cwds.get(processInfo.pid) || '',
  } satisfies PlatformProcessInfo));
}

function parentPid(pid: number): number | null { const row = command(['ps', '-o', 'ppid=', '-p', String(pid)]).trim(); return row ? Number(row) || null : null; }

function measureProcessTree(rootPid: number): { rss: number; cpu: number; totalTicks: number; measuredAt: number; pids: number[]; states: Record<number, string> } {
  const measuredAt = Date.now();
  // Unlike Linux, macOS has no /proc. A single ps snapshot includes PPID, so it
  // is sufficient to construct the complete descendant tree without shelling
  // out once per child (and without depending on pgrep being installed).
  // worktreePath is intentionally ignored: processes reparented to PID 1 cannot
  // be attributed safely without /proc/cwd, so only the root's process tree counts.
  const rows = command(['ps', '-axo', 'pid=,ppid=,rss=,%cpu=,stat=']).split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) return [];
    const [pid, ppid, rssKb, cpu, stat] = fields;
    const parsed = [Number(pid), Number(ppid), Number(rssKb), Number(cpu)];
    if (!parsed.every(Number.isFinite)) return [];
    return [{ pid: parsed[0], ppid: parsed[1], rss: parsed[2] * 1024, cpu: parsed[3], stat }];
  });
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) || []), row.pid]);
  const pids = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) || []) {
      if (!pids.has(child)) { pids.add(child); queue.push(child); }
    }
  }
  const selected = rows.filter((row) => pids.has(row.pid));
  return {
    rss: selected.reduce((sum, row) => sum + row.rss, 0),
    cpu: Math.round(selected.reduce((sum, row) => sum + row.cpu, 0) * 10) / 10,
    // Keep the scheduler's delta field monotonic while the actual CPU value
    // comes directly from macOS's ps percentage.
    totalTicks: Math.round(selected.reduce((sum, row) => sum + row.cpu, 0) * 100),
    measuredAt,
    pids: [...pids],
    states: Object.fromEntries(selected.map((row) => [row.pid, row.stat])),
  };
}
function freeMemoryBytes(): number { return os.freemem(); }
function lowPriority(executable: string, args: string[]): [string, string[]] { return process.env.AGENTHUB_NO_NICE === '1' ? [executable, args] : ['/usr/bin/nice', ['-n', '10', executable, ...args]]; }
function openBrowser(url: string, openFn?: (file: string, args: string[], callback?: (err: Error | null) => void) => void): void { if (openFn) return openFn('open', [url]); execFile('open', [url], () => {}); }
function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function shellWord(value: string): string { return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : shellQuote(value); }
function launchctlCommand(...args: string[]): string { return [shellWord(process.env.AGENTHUB_LAUNCHCTL || 'launchctl'), ...args.map(shellWord)].join(' '); }
function installService(opts: { nodePath: string; cliPath: string; currentPath: string; homeDir: string; print: boolean; exec?: (command: string, options: { stdio: 'inherit' }) => void }): ServiceInstallResult {
  const file = path.join(opts.homeDir, 'Library', 'LaunchAgents', 'dev.agenthub.plist');
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.agenthub</string><key>ProgramArguments</key><array><string>${opts.nodePath}</string><string>${opts.cliPath}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${opts.currentPath}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>AbandonProcessGroup</key><true/></dict></plist>\n`;
  const activate = launchctlCommand('bootstrap', `gui/${process.getuid?.() ?? ''}`, file);
  if (!opts.print) { assertServiceWriteAllowed(file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, 'utf8'); (opts.exec || ((cmd, options) => execFileSync('sh', ['-c', cmd], options)))(activate, { stdio: 'inherit' }); }
  return { file, content, activate };
}

function restartService(opts?: { exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceRestartResult {
  const uid = process.getuid?.() ?? '';
  const runner = opts?.exec || ((cmd, options) => execFileSync('sh', ['-c', cmd], options));
  try {
    runner(launchctlCommand('kickstart', '-k', `gui/${uid}/dev.agenthub`), { stdio: 'inherit' });
    return { restarted: true, message: 'Đã khởi động lại LaunchAgent dev.agenthub' };
  } catch (err) {
    return { restarted: false, message: `Không thể khởi động lại LaunchAgent: ${(err as Error).message}` };
  }
}

function uninstallService(opts?: { homeDir?: string; exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceUninstallResult {
  const homeDir = opts?.homeDir || os.homedir();
  const file = path.join(homeDir, 'Library', 'LaunchAgents', 'dev.agenthub.plist');
  assertServiceWriteAllowed(file);
  const uid = process.getuid?.() ?? '';
  const runner = opts?.exec || ((cmd, options) => execFileSync('sh', ['-c', cmd], options));
  try {
    runner(launchctlCommand('bootout', `gui/${uid}/dev.agenthub`), { stdio: 'ignore' });
  } catch {
    // ignore
  }
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
  return { uninstalled: true, file, message: 'Đã gỡ LaunchAgent dev.agenthub' };
}

export const darwinPlatform: PlatformApi = { process: { listProcesses, parentPid }, measureProcessTree, freeMemoryBytes, lowPriority, openBrowser, installService, restartService, uninstallService, serviceCheck: () => ({ id: 'service', name: 'Service nền tảng', status: 'skip', message: 'macOS dùng LaunchAgent; systemd không được hỗ trợ. Chạy agenthub install-service để tạo ~/Library/LaunchAgents/dev.agenthub.plist.', suggestion: 'LaunchAgent được nạp bằng launchctl bootstrap khi cài đặt.', details: { platform: 'darwin', limited: ['ionice', 'systemd'] } }) };
