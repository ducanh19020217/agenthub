import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { PlatformApi, PlatformProcessInfo, ServiceInstallResult, ServiceRestartResult, ServiceUninstallResult } from './types.js';
import { assertServiceWriteAllowed } from './service-safety.js';

function bootTimeMs(): number {
  try { return Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m)?.[1] || 0) * 1000; } catch { return 0; }
}

function listProcesses(): PlatformProcessInfo[] {
  const result: PlatformProcessInfo[] = [];
  try {
    for (const entry of fs.readdirSync('/proc').filter((value) => /^\d+$/.test(value))) {
      const pid = Number(entry);
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const rss = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0) * 1024;
        const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
        const ticks = Number(fields[11] || 0) + Number(fields[12] || 0);
        const ppid = Number(fields[1] || 0);
        let parentName = '';
        try { parentName = fs.readFileSync(`/proc/${ppid}/comm`, 'utf8').trim(); } catch { /* process exited */ }
        result.push({ pid, ppid, parentName, cwd, rss, cpu: uptime > 0 ? (ticks / 100 / uptime) * 100 : 0, startedAt: bootTimeMs() + Number(fields[19] || 0) * 10 });
      } catch { /* process exited between reads */ }
    }
  } catch { /* /proc is unavailable */ }
  return result;
}

function parentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[1]) || null;
  } catch { return null; }
}

function freeMemoryBytes(): number {
  try {
    const line = fs.readFileSync('/proc/meminfo', 'utf8').split('\n').find((entry) => entry.startsWith('MemAvailable:'));
    const kilobytes = line ? Number.parseInt(line.replace(/[^0-9]/g, ''), 10) : Number.NaN;
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : os.freemem();
  } catch { return os.freemem(); }
}

function findBinary(name: string): string | null {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function lowPriority(executable: string, args: string[]): [string, string[]] {
  if (process.env.AGENTHUB_NO_NICE === '1') return [executable, args];
  const nice = findBinary('nice');
  const ionice = findBinary('ionice');
  if (!nice) return [executable, args];
  const inner = ionice ? [ionice, '-c', '2', '-n', '7', executable, ...args] : [executable, ...args];
  return [nice, ['-n', '10', ...inner]];
}

function openBrowser(url: string, openFn?: (file: string, args: string[], callback?: (err: Error | null) => void) => void): void {
  if (openFn) return openFn('xdg-open', [url]);
  execFile('xdg-open', [url], () => {});
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : shellQuote(value);
}

function systemctlCommand(...args: string[]): string {
  return [shellWord(process.env.AGENTHUB_SYSTEMCTL || 'systemctl'), ...args.map(shellWord)].join(' ');
}

export function extractCustomEnvironments(existingContent: string): string[] {
  const lines = existingContent.split(/\r?\n/);
  const custom: string[] = [];
  const managedKeys = new Set(['PATH', 'MALLOC_ARENA_MAX', 'MALLOC_TRIM_THRESHOLD_']);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Environment=')) {
      const val = trimmed.slice('Environment='.length).trim();
      const eqIdx = val.indexOf('=');
      const key = eqIdx >= 0 ? val.slice(0, eqIdx).trim() : val;
      if (!managedKeys.has(key)) {
        custom.push(trimmed);
      }
    }
  }
  return custom;
}

function installService(opts: { nodePath: string; cliPath: string; currentPath: string; homeDir: string; print: boolean; exec?: (command: string, options: { stdio: 'inherit' }) => void }): ServiceInstallResult {
  const file = path.join(opts.homeDir, '.config', 'systemd', 'user', 'agenthub.service');
  let customEnvLines: string[] = [];
  if (fs.existsSync(file)) {
    try {
      customEnvLines = extractCustomEnvironments(fs.readFileSync(file, 'utf8'));
    } catch {
      // ignore
    }
  }
  const customEnvBlock = customEnvLines.length > 0 ? `\n${customEnvLines.join('\n')}` : '';
  const content = `[Unit]\nDescription=AgentHub Daemon\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${opts.nodePath} ${opts.cliPath} daemon\nRestart=on-failure\nEnvironment=PATH=${opts.currentPath}\nEnvironment=MALLOC_ARENA_MAX=2\nEnvironment=MALLOC_TRIM_THRESHOLD_=131072${customEnvBlock}\n\n[Install]\nWantedBy=default.target\n`;
  const activate = `${systemctlCommand('--user', 'daemon-reload')} && ${systemctlCommand('--user', 'enable', '--now', 'agenthub')}`;
  if (!opts.print) {
    assertServiceWriteAllowed(file);
    try {
      execFileSync(process.env.AGENTHUB_SYSTEMCTL || 'systemctl', ['--version'], { stdio: 'ignore' });
    } catch {
      return { file, content, activate, skipped: true, message: 'Không có systemd — chạy thủ công: agenthub daemon' };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    try {
      (opts.exec || ((command, options) => execFileSync('sh', ['-c', command], options)))(activate, { stdio: 'inherit' });
    } catch {
      try { fs.unlinkSync(file); } catch { /* ignore cleanup */ }
      return { file, content, activate, skipped: true, message: 'Không có systemd user bus — chạy thủ công: agenthub daemon' };
    }
  }
  return { file, content, activate };
}

function restartService(opts?: { exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceRestartResult {
  const runner = opts?.exec || ((command, options) => execFileSync('sh', ['-c', command], options));
  try {
    runner(systemctlCommand('--user', 'restart', 'agenthub'), { stdio: 'inherit' });
    return { restarted: true, message: 'Đã khởi động lại service systemd agenthub' };
  } catch (err) {
    return { restarted: false, message: `Không thể khởi động lại service systemd: ${(err as Error).message}` };
  }
}

function uninstallService(opts?: { homeDir?: string; exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceUninstallResult {
  const homeDir = opts?.homeDir || os.homedir();
  const file = path.join(homeDir, '.config', 'systemd', 'user', 'agenthub.service');
  assertServiceWriteAllowed(file);
  const runner = opts?.exec || ((command, options) => execFileSync('sh', ['-c', command], options));
  try {
    runner(`${systemctlCommand('--user', 'stop', 'agenthub')} && ${systemctlCommand('--user', 'disable', 'agenthub')}`, { stdio: 'ignore' });
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
  try {
    runner(systemctlCommand('--user', 'daemon-reload'), { stdio: 'ignore' });
  } catch {
    // ignore
  }
  return { uninstalled: true, file, message: 'Đã gỡ systemd user service agenthub' };
}

export const linuxPlatform: PlatformApi = {
  process: { listProcesses, parentPid }, freeMemoryBytes, lowPriority, openBrowser, installService, restartService, uninstallService,
  serviceCheck: (exec, timeoutMs) => {
    const probe = exec('systemctl', ['--version'], { timeout: timeoutMs });
    if (probe.error) return { id: 'systemd', name: 'Service systemd', status: 'skip', message: 'Không có systemd (bỏ qua)', details: { reason: 'systemctl_not_found' } };
    const res = exec('systemctl', ['--user', 'is-active', 'agenthub'], { timeout: timeoutMs });
    if (res.stderr && /Failed to connect to bus|not been booted with systemd/i.test(res.stderr)) return { id: 'systemd', name: 'Service systemd', status: 'skip', message: 'Không có systemd user bus (bỏ qua)', details: { reason: 'user_bus_unavailable', stderr: res.stderr.trim() } };
    const output = (res.stdout || '').trim();
    if (res.status === 0 && output === 'active') return { id: 'systemd', name: 'Service systemd', status: 'ok', message: "Service systemd 'agenthub' đang hoạt động (active)", details: { status: output } };
    return { id: 'systemd', name: 'Service systemd', status: 'error', message: `Service systemd 'agenthub' không hoạt động (${output || 'inactive'})`, suggestion: "Chạy 'agenthub install-service' hoặc 'systemctl --user start agenthub'.", details: { status: output || 'inactive', exitCode: res.status } };
  },
};
