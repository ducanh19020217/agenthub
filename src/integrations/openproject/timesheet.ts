import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { projectSettings } from '../../projects/settings.js';
import type { EventRepo, ProjectRepo, RunRepo, TaskRepo, TimesheetEntryRepo, TaskRow } from '../../db/index.js';
import { OpenProjectClient, type OpenProjectWorkPackage } from './client.js';
import { readOpenProjectKey } from './secrets.js';
import { formatYYYYMMDD } from './daily-report.js';

const execFileAsync = promisify(execFile);
export interface TimesheetTicket { wpId: number; displayId: string; subject: string; hours: number; comment: string; run: number; wait: number; chat: number; level: number; weight: number; }
export interface TimesheetPreview { sourceId: string; date: string; hours: number; entries: TimesheetTicket[]; withoutTicket: Array<{ taskId: string; subject: string }>; overMinimum: boolean; }

function dateBounds(date: string): { start: string; end: string } { return { start: `${date} 00:00:00`, end: `${date} 23:59:59` }; }
function dayMs(date: string): { start: number; end: number } { const start = new Date(`${date}T00:00:00`).getTime(); return { start, end: start + 86400000 }; }
function isoDuration(hours: number): string { const minutes = Math.round(hours * 60); return `PT${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}H` : ''}${minutes % 60 ? `${minutes % 60}M` : ''}`; }
function subjectFromCommits(commits: string[]): string { return (commits[0] || 'Cập nhật công việc').replace(/\s+/g, ' ').trim().slice(0, 255); }
function taskLevel(task: TaskRow): number { return task.level === 'hard' ? 1.5 : 1; }

export function allocateTimesheetHours(weights: Array<{ weight: number }>, total: number, min: number, step: number): number[] {
  if (!weights.length) return [];
  const units = Math.round(total / step);
  const minUnits = Math.ceil(min / step - 1e-9);
  const values = weights.map((item) => Math.max(minUnits, Math.round((total * (item.weight || 1) / weights.reduce((sum, x) => sum + (x.weight || 1), 0)) / step)));
  if (values.reduce((a, b) => a + b, 0) < units) {
    const remaining = units - values.reduce((a, b) => a + b, 0);
    const max = Math.max(...weights.map((item) => item.weight));
    const index = weights.findIndex((item) => item.weight === max);
    values[index] += remaining;
  } else if (values.reduce((a, b) => a + b, 0) > units && units >= minUnits * values.length) {
    let excess = values.reduce((a, b) => a + b, 0) - units;
    const order = weights.map((item, index) => ({ index, weight: item.weight })).sort((a, b) => a.weight - b.weight);
    for (const item of order) { const take = Math.min(excess, values[item.index] - minUnits); values[item.index] -= take; excess -= take; if (!excess) break; }
  }
  return values.map((value) => value * step);
}

export interface TimesheetServiceOptions { config: AgentHubConfig; projectRepo: ProjectRepo; taskRepo: TaskRepo; runRepo: RunRepo; eventRepo: EventRepo; entryRepo: TimesheetEntryRepo; eventBus: { emit(type: string, taskId?: string, payload?: unknown): boolean }; fetchFn?: typeof fetch; now?: () => number; timerMs?: number; }

export class OpenProjectTimesheetService {
  private timer?: NodeJS.Timeout;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timerMs: number;
  private lastRun = new Map<string, string>();
  constructor(private readonly options: TimesheetServiceOptions) { this.fetchFn = options.fetchFn || globalThis.fetch; this.now = options.now || (() => Date.now()); this.timerMs = options.timerMs || 60_000; }
  start(): void { if (this.timer) return; this.checkScheduled().catch(() => undefined); this.timer = setInterval(() => this.checkScheduled().catch(() => undefined), this.timerMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private source(id: string): OpenProjectSource { const source = this.options.config.integrations.openproject.sources.find((item) => item.id === id); if (!source) throw new Error('Nguồn OpenProject không tồn tại'); return source; }
  async checkScheduled(): Promise<void> { const date = new Date(this.now()); const key = formatYYYYMMDD(date); if (date.getDay() === 0 || date.getDay() === 6) return; for (const source of this.options.config.integrations.openproject.sources) { const cfg = source.timesheet; if (!cfg?.enabled || (cfg.weekdaysOnly !== false && (date.getDay() === 0 || date.getDay() === 6)) || this.lastRun.get(source.id) === key) continue; const [h, m] = cfg.time.split(':').map(Number); if (date.getHours() !== h || Math.abs(date.getMinutes() - m) > 1) continue; this.lastRun.set(source.id, key); try { await this.run(source.id, key); } catch { /* event emitted by run */ } } }
  async preview(sourceId: string, date = formatYYYYMMDD(new Date(this.now())), hoursOverride?: number): Promise<TimesheetPreview> {
    const source = this.source(sourceId); const cfg = source.timesheet; if (!cfg?.enabled || cfg.activityId == null) return { sourceId, date, hours: hoursOverride ?? cfg?.hours ?? 8, entries: [], withoutTicket: [], overMinimum: false };
    const weekday = new Date(`${date}T12:00:00`).getDay(); if (cfg.weekdaysOnly !== false && (weekday === 0 || weekday === 6)) return { sourceId, date, hours: hoursOverride ?? cfg.hours, entries: [], withoutTicket: [], overMinimum: false };
    const key = readOpenProjectKey(this.options.config.hubHome, sourceId); if (!key) throw new Error('Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    const projects = this.options.projectRepo.getAll().filter((project) => { try { return projectSettings(project).openproject?.enabled && projectSettings(project).openproject?.sourceId === sourceId; } catch { return false; } });
    const projectIds = new Set(projects.map((p) => p.id)); const tasks = this.options.taskRepo.getAll().filter((task) => projectIds.has(task.projectId)); const day = dayMs(date); const tickets = new Map<number, TimesheetTicket>(); const withoutTicket: Array<{ taskId: string; subject: string }> = [];
    for (const task of tasks) {
      const project = projects.find((p) => p.id === task.projectId); if (!project) continue;
      const commits = await this.commits(project.path, task.branch || project.defaultBranch, date); if (!commits.length) continue;
      let wp: OpenProjectWorkPackage | undefined; if (task.externalRef) wp = await client.findWorkPackage(task.externalRef); if (!wp) { withoutTicket.push({ taskId: task.id, subject: subjectFromCommits(commits) }); continue; }
      const runs = this.options.runRepo.getByTask(task.id).filter((run) => { const start = new Date(run.startedAt).getTime(); return start >= day.start && start < day.end; });
      const runMinutes = runs.reduce((sum, run) => sum + Math.max(0, (new Date(run.endedAt || new Date(day.end).toISOString()).getTime() - new Date(run.startedAt).getTime()) / 60000), 0);
      const events = this.options.eventRepo.getByTask(task.id).filter((event) => { const ts = new Date(event.ts).getTime(); return ts >= day.start && ts < day.end; });
      const chat = events.filter((event) => /review|comment|decision|blocked|question|changes_requested/i.test(event.type)).length * 10;
      const wait = Math.min(runMinutes, events.filter((event) => /check|review|merge|wait/i.test(event.type)).length * 10);
      const current = tickets.get(wp.id) || { wpId: wp.id, displayId: wp.displayId || String(wp.id), subject: wp.subject || '', hours: 0, comment: subjectFromCommits(commits), run: 0, wait: 0, chat: 0, level: taskLevel(task), weight: 0 };
      current.run += runMinutes; current.wait += wait; current.chat += chat; current.level = Math.max(current.level, taskLevel(task)); current.weight = (current.run + 0.5 * current.wait + current.chat / 60) * current.level; current.comment = subjectFromCommits([current.comment, ...commits]); tickets.set(wp.id, current);
    }
    const entries = [...tickets.values()]; const allocated = allocateTimesheetHours(entries, hoursOverride ?? cfg.hours, cfg.minEntryHours, cfg.roundTo); entries.forEach((entry, index) => { entry.hours = allocated[index]; });
    return { sourceId, date, hours: hoursOverride ?? cfg.hours, entries, withoutTicket, overMinimum: entries.length * cfg.minEntryHours > (hoursOverride ?? cfg.hours) };
  }
  private async commits(cwd: string, branch: string, date: string): Promise<string[]> { const { start, end } = dateBounds(date); try { const result = await execFileAsync('git', ['-C', cwd, 'log', branch, '--committer-date-order', `--since=${start}`, `--until=${end}`, '--format=%s']); return result.stdout.split('\n').map((x) => x.trim()).filter(Boolean); } catch { return []; } }
  async run(sourceId: string, date = formatYYYYMMDD(new Date(this.now())), hoursOverride?: number): Promise<TimesheetPreview> { const source = this.source(sourceId); const cfg = source.timesheet; const preview = await this.preview(sourceId, date, hoursOverride); if (!cfg?.enabled || cfg.activityId == null) return preview; const key = readOpenProjectKey(this.options.config.hubHome, sourceId); if (!key) throw new Error('Nguồn chưa có API key'); const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn }); try { for (const entry of preview.entries) { const input = { hours: isoDuration(entry.hours), spentOn: date, comment: entry.comment, workPackageId: entry.wpId, activityId: cfg.activityId }; const stored = this.options.entryRepo.get(sourceId, date, entry.wpId); const result = stored ? await client.updateTimeEntry(stored.entry_id, input) : await client.createTimeEntry(input); this.options.entryRepo.upsert({ source_id: sourceId, spent_on: date, wp_id: entry.wpId, entry_id: result.id, hours: entry.hours }); } this.options.eventBus.emit('tracker.timesheet.posted', undefined, { sourceId, date, hours: preview.hours, entries: preview.entries, withoutTicket: preview.withoutTicket, overMinimum: preview.overMinimum }); return preview; } catch (error) { this.options.eventBus.emit('tracker.timesheet.failed', undefined, { sourceId, date, error: error instanceof Error ? error.message : String(error) }); throw error; } }
}
