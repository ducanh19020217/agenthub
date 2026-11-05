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
export interface TimesheetPreview { sourceId: string; date: string; hours: number; entries: TimesheetTicket[]; withoutTicket: Array<{ taskId: string; subject: string }>; missingFromDate: number[]; overMinimum: boolean; }

function dateBounds(date: string): { start: string; end: string } { return { start: `${date} 00:00:00`, end: `${date} 23:59:59` }; }
function dayMs(date: string): { start: number; end: number } { const start = new Date(`${date}T00:00:00`).getTime(); return { start, end: start + 86400000 }; }
function isoDuration(hours: number): string { const minutes = Math.round(hours * 60); return `PT${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}H` : ''}${minutes % 60 ? `${minutes % 60}M` : ''}`; }
function subjectFromCommits(commits: string[]): string { return (commits[0] || 'Cập nhật công việc').replace(/\s+/g, ' ').trim().slice(0, 255); }
function taskLevel(task: TaskRow): number { return task.level === 'hard' ? 1.5 : 1; }

export function allocateTimesheetHours(weights: Array<{ weight: number }>, total: number, min: number, step: number): number[] {
  if (!weights.length) return [];
  const units = Math.round(total / step);
  const minUnits = Math.ceil(min / step - 1e-9);
  const weightTotal = weights.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  const values = weights.map((item) => Math.max(minUnits, Math.round((total * (weightTotal ? Math.max(0, item.weight) : 1) / (weightTotal || weights.length)) / step)));
  const currentTotal = () => values.reduce((a, b) => a + b, 0);
  if (currentTotal() < units) {
    const remaining = units - currentTotal();
    const max = Math.max(...weights.map((item) => item.weight));
    const index = weights.findIndex((item) => item.weight === max);
    values[index] += remaining;
  } else if (currentTotal() > units) {
    let excess = currentTotal() - units;
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
  private failures = new Map<string, number>();
  private nextAttempt = new Map<string, number>();
  constructor(private readonly options: TimesheetServiceOptions) { this.fetchFn = options.fetchFn || globalThis.fetch; this.now = options.now || (() => Date.now()); this.timerMs = options.timerMs || 60_000; }
  start(): void { if (this.timer) return; this.checkScheduled().catch(() => undefined); this.timer = setInterval(() => this.checkScheduled().catch(() => undefined), this.timerMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private source(id: string): OpenProjectSource { const source = this.options.config.integrations.openproject.sources.find((item) => item.id === id); if (!source) throw new Error('Nguồn OpenProject không tồn tại'); return source; }
  async checkScheduled(): Promise<void> { const date = new Date(this.now()); const key = formatYYYYMMDD(date); if (date.getDay() === 0 || date.getDay() === 6) return; for (const source of this.options.config.integrations.openproject.sources) { const cfg = source.timesheet; if (!cfg?.enabled || (cfg.weekdaysOnly !== false && (date.getDay() === 0 || date.getDay() === 6)) || this.lastRun.get(source.id) === key) continue; if ((this.nextAttempt.get(source.id) || 0) > this.now()) continue; const [h, m] = cfg.time.split(':').map(Number); if (date.getHours() !== h || date.getMinutes() !== m) continue; try { await this.run(source.id, key); this.lastRun.set(source.id, key); this.failures.delete(source.id); this.nextAttempt.delete(source.id); } catch { const failure = (this.failures.get(source.id) || 0) + 1; this.failures.set(source.id, failure); const delay = Math.min(source.pollIntervalSec * 1000 * (2 ** failure), 30 * 60 * 1000); this.nextAttempt.set(source.id, this.now() + delay); } } }
  async preview(sourceId: string, date = formatYYYYMMDD(new Date(this.now())), hoursOverride?: number): Promise<TimesheetPreview> {
    const source = this.source(sourceId); const cfg = source.timesheet; if (!cfg?.enabled || cfg.activityId == null) return { sourceId, date, hours: hoursOverride ?? cfg?.hours ?? 8, entries: [], withoutTicket: [], missingFromDate: [], overMinimum: false };
    const weekday = new Date(`${date}T12:00:00`).getDay(); if (cfg.weekdaysOnly !== false && (weekday === 0 || weekday === 6)) return { sourceId, date, hours: hoursOverride ?? cfg.hours, entries: [], withoutTicket: [], missingFromDate: [], overMinimum: false };
    const key = readOpenProjectKey(this.options.config.hubHome, sourceId); if (!key) throw new Error('Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    const projects = this.options.projectRepo.getAll().filter((project) => { try { return projectSettings(project).openproject?.enabled && projectSettings(project).openproject?.sourceId === sourceId; } catch { return false; } });
    const projectIds = new Set(projects.map((p) => p.id)); const tasks = this.options.taskRepo.getAll().filter((task) => projectIds.has(task.projectId)); const day = dayMs(date); const tickets = new Map<number, TimesheetTicket>(); const withoutTicket: Array<{ taskId: string; subject: string }> = [];
    for (const task of tasks) {
      const project = projects.find((p) => p.id === task.projectId); if (!project) continue;
      const commits = await this.commits(project.path, project.defaultBranch, task.branch || project.defaultBranch, date); if (!commits.length) continue;
      let wp: OpenProjectWorkPackage | undefined; if (task.externalRef) wp = await client.findWorkPackage(task.externalRef); if (!wp) { withoutTicket.push({ taskId: task.id, subject: subjectFromCommits(commits) }); continue; }
      const runs = this.options.runRepo.getByTask(task.id);
      const runMinutes = runs.reduce((sum, run) => { const start = Math.max(day.start, new Date(run.startedAt).getTime()); const end = Math.min(day.end, new Date(run.endedAt || new Date(day.end).toISOString()).getTime()); return sum + Math.max(0, (end - start) / 60000); }, 0);
      const events = this.options.eventRepo.getByTask(task.id).filter((event) => { const ts = new Date(event.ts).getTime(); return ts >= day.start && ts < day.end; });
      const payloadText = events.map((event) => event.payload || '').join(' ');
      const chat = (events.filter((event) => /review|comment|decision|blocked|question|changes_requested/i.test(event.type)).length + (payloadText.includes('## Cần quyết định') ? 1 : 0)) * 10;
      const waitStarts = events.filter((event) => /checking|review\.waiting|review\.gate_started|merge\.waiting|wait/i.test(event.type)).map((event) => new Date(event.ts).getTime());
      const wait = Math.min(runMinutes, waitStarts.reduce((sum, start, index) => { const end = waitStarts[index + 1] || day.end; return sum + Math.max(0, Math.min(day.end, end) - Math.max(day.start, start)) / 60000; }, 0));
      const level = taskLevel(task); const current = tickets.get(wp.id) || { wpId: wp.id, displayId: wp.displayId || String(wp.id), subject: wp.subject || '', hours: 0, comment: subjectFromCommits(commits), run: 0, wait: 0, chat: 0, level, weight: 0 };
      current.run += runMinutes; current.wait += wait; current.chat += chat; current.level = Math.max(current.level, level); current.weight += (runMinutes + 0.5 * wait + chat) * level; current.comment = subjectFromCommits([current.comment, ...commits]); tickets.set(wp.id, current);
    }
    const entries = [...tickets.values()]; const allocated = allocateTimesheetHours(entries, hoursOverride ?? cfg.hours, cfg.minEntryHours, cfg.roundTo); entries.forEach((entry, index) => { entry.hours = allocated[index]; });
    const currentWpIds = new Set(entries.map((entry) => entry.wpId)); const missingFromDate = this.options.entryRepo.listForDate(sourceId, date).map((row) => row.wp_id).filter((id) => !currentWpIds.has(id));
    return { sourceId, date, hours: hoursOverride ?? cfg.hours, entries, withoutTicket, missingFromDate, overMinimum: entries.length * cfg.minEntryHours > (hoursOverride ?? cfg.hours) };
  }
  private async commits(cwd: string, defaultBranch: string, branch: string, date: string): Promise<string[]> { const { start } = dateBounds(date); try { const range = branch === defaultBranch ? branch : `${defaultBranch}..${branch}`; const result = await execFileAsync('git', ['-C', cwd, 'log', range, `--since=${start}`, `--until=${date} 23:59:59.999`, '--format=%s']); return result.stdout.split('\n').map((x) => x.trim()).filter(Boolean); } catch { return []; } }
  async run(sourceId: string, date = formatYYYYMMDD(new Date(this.now())), hoursOverride?: number): Promise<TimesheetPreview> { const source = this.source(sourceId); const cfg = source.timesheet; const preview = await this.preview(sourceId, date, hoursOverride); if (!cfg?.enabled || cfg.activityId == null) return preview; const key = readOpenProjectKey(this.options.config.hubHome, sourceId); if (!key) throw new Error('Nguồn chưa có API key'); const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn }); const errors: string[] = []; for (const entry of preview.entries) { try { const input = { hours: isoDuration(entry.hours), spentOn: date, comment: entry.comment, workPackageId: entry.wpId, activityId: cfg.activityId }; const stored = this.options.entryRepo.get(sourceId, date, entry.wpId); const result = stored ? await client.updateTimeEntry(stored.entry_id, input) : await client.createTimeEntry(input); this.options.entryRepo.upsert({ source_id: sourceId, spent_on: date, wp_id: entry.wpId, entry_id: result.id, hours: entry.hours }); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } } if (errors.length) { this.options.eventBus.emit('tracker.timesheet.failed', undefined, { sourceId, date, error: errors.join('; '), posted: preview.entries.length - errors.length }); throw new Error(errors.join('; ')); } this.options.eventBus.emit('tracker.timesheet.posted', undefined, { sourceId, date, hours: preview.hours, entries: preview.entries, withoutTicket: preview.withoutTicket, missingFromDate: preview.missingFromDate, overMinimum: preview.overMinimum }); return preview; }
}
