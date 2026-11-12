import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const PERF_GROUPS = ['hub daemon', 'worker', 'test/vitest', 'checks', 'agy', 'codex', 'claude', 'Chrome', 'VS Code', 'docker', 'other'] as const;
export type PerfGroup = typeof PERF_GROUPS[number];
export interface PerfProcess { pid: number; group: PerfGroup; rssBytes: number; cpuPercent: number; command: string; }
export interface PerfSample { at: string; cpuCount: number; processes: PerfProcess[]; groups: Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }>; }
type ProcessState = { ticks: number; uptime: number };

const commandName = (command: string): string => path.basename(command.trim().split(/\s+/, 1)[0] || '').toLowerCase();
export function classify(command: string): PerfGroup {
  const value = command.trim().toLowerCase();
  const name = commandName(value);
  if ((name === 'node' || name === 'cli.js' || name === 'agenthub') && /(?:dist\/)?cli\.js\s+daemon|agenthub\s+daemon/.test(value)) return 'hub daemon';
  if (['vitest', 'jest'].includes(name) || (name === 'npm' && /(?:^|\s)test(?:\s|$)/.test(value))) return 'test/vitest';
  if (['check', 'checks', 'agenthub-check'].includes(name)) return 'checks';
  if (name === 'agy') return 'agy';
  if (name === 'codex') return 'codex';
  if (name === 'claude') return 'claude';
  if (['chrome', 'chrome.exe', 'chromium', 'chromium-browser'].includes(name)) return 'Chrome';
  if (['code', 'code-insiders'].includes(name) || /(?:visual studio code|\/vscode\/|\/code(?:-insiders)?(?:\s|$))/.test(value)) return 'VS Code';
  if (name === 'docker' || name === 'dockerd') return 'docker';
  if (/worktrees|fake-agent(?:\.m?js)?(?:\s|$)/.test(value)) return 'worker';
  return 'other';
}

let cachedPageSize: number | undefined;
let cachedClockTicks: number | undefined;
function systemValue(name: string, fallback: number): number {
  try { const value = Number(execFileSync('getconf', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); return Number.isFinite(value) && value > 0 ? value : fallback; } catch { return fallback; }
}
function pageSize(): number { return cachedPageSize ??= systemValue('PAGESIZE', 4096); }
function clockTicks(): number { return cachedClockTicks ??= systemValue('CLK_TCK', 100); }
function emptyGroups(): Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }> {
  return Object.fromEntries(PERF_GROUPS.map((group) => [group, { cpuPercent: 0, rssBytes: 0, processes: 0 }])) as Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }>;
}

function readLinuxProcesses(procRoot: string, previous: Map<number, ProcessState>, uptime: number): PerfProcess[] {
  const result: PerfProcess[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(procRoot, { withFileTypes: true }); } catch { return result; }
  const hz = clockTicks();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const dir = path.join(procRoot, entry.name);
    try {
      const stat = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      const ticks = Number(fields[11] || 0) + Number(fields[12] || 0);
      const pid = Number(entry.name);
      const prior = previous.get(pid);
      previous.set(pid, { ticks, uptime });
      const elapsed = prior ? Math.max(0.01, uptime - prior.uptime) : 0;
      const cpuPercent = prior ? Math.max(0, ((ticks - prior.ticks) / hz / elapsed) * 100) : 0;
      const rssPages = Number(fields[21] || 0);
      const command = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').replaceAll('\0', ' ').trim() || stat.slice(stat.indexOf('(') + 1, close);
      result.push({ pid, group: classify(command), rssBytes: rssPages * pageSize(), cpuPercent, command: command.slice(0, 120) });
    } catch { /* process exited between directory and reads */ }
  }
  return result;
}

export function createPerfSampler(procRoot = '/proc'): () => PerfSample {
  const previous = new Map<number, ProcessState>();
  return () => {
    let uptime = 0;
    try { uptime = Number(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').split(/\s+/)[0]); } catch { /* unavailable */ }
    const processes = process.platform === 'linux' ? readLinuxProcesses(procRoot, previous, uptime) : [];
    const groups = emptyGroups();
    for (const process of processes) { const group = groups[process.group]; group.cpuPercent += process.cpuPercent; group.rssBytes += process.rssBytes; group.processes += 1; }
    return { at: new Date().toISOString(), cpuCount: os.cpus().length, processes, groups };
  };
}
export function samplePerf(procRoot = '/proc'): PerfSample { return createPerfSampler(procRoot)(); }

export interface EventLoopStats {
  /** p50 delay in milliseconds */
  p50Ms: number;
  /** p99 delay in milliseconds */
  p99Ms: number;
  /** max delay in milliseconds */
  maxMs: number;
  /** mean delay in milliseconds */
  meanMs: number;
}

/** Singleton handle for the event-loop delay histogram (1-second resolution). */
let _elMonitor: ReturnType<typeof monitorEventLoopDelay> | undefined;

function getOrCreateELMonitor(): ReturnType<typeof monitorEventLoopDelay> {
  if (!_elMonitor) {
    _elMonitor = monitorEventLoopDelay({ resolution: 20 });
    _elMonitor.enable();
  }
  return _elMonitor;
}

/** Read and reset the current event-loop delay histogram window. */
export function sampleEventLoopStats(): EventLoopStats {
  const h = getOrCreateELMonitor();
  const p50Ms = h.percentile(50) / 1e6;
  const p99Ms = h.percentile(99) / 1e6;
  const maxMs = h.max / 1e6;
  const meanMs = h.mean / 1e6;
  h.reset();
  return { p50Ms, p99Ms, maxMs, meanMs };
}

export class PerfCollector {
  private samples: PerfSample[] = [];
  private timer?: NodeJS.Timeout;
  private elTimer?: NodeJS.Timeout;
  private readonly sampler: () => PerfSample;
  private _latestEL?: EventLoopStats;

  constructor(private readonly maxSamples = 120, sampler?: () => PerfSample) { this.sampler = sampler || createPerfSampler(); }
  sample(): PerfSample { const value = this.sampler(); this.samples.push(value); if (this.samples.length > this.maxSamples) this.samples.shift(); return value; }

  /** Start CPU-usage sampling and event-loop delay monitoring. */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref?.();

    // Event-loop delay: check every 60 s, warn if max > 500 ms or p99 > 200 ms
    getOrCreateELMonitor(); // ensure monitor is running
    this.elTimer = setInterval(() => {
      const stats = sampleEventLoopStats();
      this._latestEL = stats;
      if (stats.maxMs > 500 || stats.p99Ms > 200) {
        console.warn(
          `[perf] event-loop delay high: max=${stats.maxMs.toFixed(0)}ms p99=${stats.p99Ms.toFixed(0)}ms mean=${stats.meanMs.toFixed(0)}ms`,
        );
      }
    }, 60_000);
    this.elTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.elTimer) clearInterval(this.elTimer);
    this.elTimer = undefined;
  }
  getSamples(): PerfSample[] { const latest = this.samples.length - 1; return this.samples.map((sample, index) => ({ ...sample, processes: index === latest ? sample.processes.slice().sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 10) : [], groups: { ...sample.groups } })); }
  latest(): PerfSample { return this.getSamples().at(-1) || this.sample(); }

  /** Latest event-loop delay stats from the last 60-second window (may be undefined before first tick). */
  getEventLoopStats(): EventLoopStats | undefined { return this._latestEL; }
}

export function formatPerfTable(samples: PerfSample[]): string {
  const latest = samples[samples.length - 1];
  if (!latest) return 'Không có dữ liệu hiệu năng';
  const rows = PERF_GROUPS.map((group) => { const v = latest.groups[group]; return `${group}\t${v.processes}\t${v.cpuPercent.toFixed(1)}%\t${(v.rssBytes / 1024 ** 3).toFixed(2)} GB`; });
  return ['Nhóm\tProcess\tCPU\tRSS', ...rows].join('\n');
}
