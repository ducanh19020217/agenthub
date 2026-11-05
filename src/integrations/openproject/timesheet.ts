import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { projectSettings } from '../../projects/settings.js';
import type { EventRepo, ProjectRepo, RunRepo, TaskRepo, TimesheetEntryRepo, TimesheetManualEntryRepo, TimesheetDayOverrideRepo, TaskRow } from '../../db/index.js';
import { OpenProjectClient, OpenProjectError, parsePTHours, type OpenProjectWorkPackage } from './client.js';
import { readOpenProjectKey } from './secrets.js';
import { formatYYYYMMDD } from './daily-report.js';

const execFileAsync = promisify(execFile);
export interface TimesheetTicket { wpId: number; displayId: string; subject: string; hours: number; rawHours: number; estimateHours: number; comment: string; run: number; wait: number; chat: number; level: number; weight: number; kind: 'commit' | 'manual' | 'mixed'; pinned: boolean; fixedHours?: number; manualIds?: string[]; }
export interface TimesheetPreview { sourceId: string; date: string; hours: number; entries: TimesheetTicket[]; withoutTicket: Array<{ taskId: string; subject: string }>; missingFromDate: number[]; overMinimum: boolean; fixedHours?: number; fixedOverHours?: boolean; estimateSkipped?: Array<{ wpId: number; displayId: string; reason: string }>; }

function dateBounds(date: string): { start: string; end: string } { return { start: `${date} 00:00:00`, end: `${date} 23:59:59.999` }; }
function dayMs(date: string): { start: number; end: number } { const start = new Date(`${date}T00:00:00`).getTime(); return { start, end: start + 86400000 }; }
function isoDuration(hours: number): string { const minutes = Math.round(hours * 60); return `PT${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}H` : ''}${minutes % 60 ? `${minutes % 60}M` : ''}`; }
function subjectFromCommits(commits: string[], language = 'vi'): string {
  const fallback = language === 'en' ? 'Work update' : 'Cập nhật công việc';
  const subject = (commits[0] || fallback)
    .replace(/^\s*(?:feat|fix|docs|refactor|test|chore|perf|style|build|ci)(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|html)\b/gi, '')
    .replace(/\b[A-Za-z_$][\w$]*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ').trim();
  return (subject || fallback).slice(0, 255);
}
function taskLevel(task: TaskRow): number { return task.level === 'hard' ? 1.5 : 1; }
function roundHours(raw: number, roundTo: number): number { return Math.max(roundTo, Math.round(raw / roundTo) * roundTo); }

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

export interface TimesheetServiceOptions { config: AgentHubConfig; projectRepo: ProjectRepo; taskRepo: TaskRepo; runRepo: RunRepo; eventRepo: EventRepo; entryRepo: TimesheetEntryRepo; manualRepo?: TimesheetManualEntryRepo; dayOverrideRepo?: TimesheetDayOverrideRepo; eventBus: { emit(type: string, taskId?: string, payload?: unknown): boolean }; fetchFn?: typeof fetch; now?: () => number; timerMs?: number; }

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
  private manualRepo(): TimesheetManualEntryRepo { if (!this.options.manualRepo) throw new Error('Timesheet thủ công chưa sẵn sàng'); return this.options.manualRepo; }
  async addManual(input: { sourceId?: string; date: string; ticket?: string; wpId?: number; createTicket?: { subject: string; parent?: string | number }; description: string; activeHours: number; waitHours?: number; level?: 'easy' | 'hard'; pinned?: boolean }): Promise<unknown> {
    if (input.activeHours < 0 || (input.waitHours || 0) < 0 || input.activeHours + (input.waitHours || 0) <= 0 || input.activeHours + (input.waitHours || 0) > 24) throw new Error('Giờ làm/chờ phải không âm, tổng phải lớn hơn 0 và không quá 24 giờ');
    const sourceId = input.sourceId || (this.options.config.integrations.openproject.sources.length === 1 ? this.options.config.integrations.openproject.sources[0].id : undefined); if (!sourceId) throw new Error('Cần sourceId khi có nhiều nguồn OpenProject');
    const source = this.source(sourceId); const key = readOpenProjectKey(this.options.config.hubHome, sourceId); if (!key) throw new Error('Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    let ticket = input.wpId ? await client.findWorkPackage(input.wpId) : input.ticket ? await client.findWorkPackage(input.ticket) : undefined;
    if (input.createTicket) {
      const parentId = input.createTicket.parent ? (await client.findWorkPackage(input.createTicket.parent))?.id : undefined;
      if (input.createTicket.parent && parentId == null) throw new Error('Không tìm thấy ticket cha');
      const created = await client.createWorkPackage({ subject: input.createTicket.subject, descriptionMarkdown: input.description, parentId });
      ticket = { id: created.id, displayId: created.displayId, subject: input.createTicket.subject } as OpenProjectWorkPackage;
    }
    if (!ticket) throw new Error('Không tìm thấy ticket; hãy chọn ticket hoặc Tạo ticket mới');
    return this.manualRepo().insert({ id: crypto.randomUUID(), source_id: sourceId, spent_on: input.date, wp_id: ticket.id, display_id: ticket.displayId || String(ticket.id), description: input.description.trim(), active_hours: input.activeHours, wait_hours: input.waitHours || 0, level: input.level || 'easy', pinned: input.pinned ? 1 : 0 });
  }
  updateManual(id: string, patch: Partial<{ sourceId: string; date: string; description: string; activeHours: number; waitHours: number; level: 'easy' | 'hard'; pinned: boolean }>): unknown {
    const row = this.manualRepo().get(id); if (!row) throw new Error('Mục thủ công không tồn tại');
    const active = patch.activeHours ?? row.active_hours; const wait = patch.waitHours ?? row.wait_hours;
    if (active < 0 || wait < 0 || active + wait <= 0 || active + wait > 24) throw new Error('Giờ làm/chờ phải không âm, tổng phải lớn hơn 0 và không quá 24 giờ');
    return this.manualRepo().update(id, { source_id: patch.sourceId ?? row.source_id, spent_on: patch.date ?? row.spent_on, description: patch.description?.trim() ?? row.description, active_hours: active, wait_hours: wait, level: patch.level ?? row.level, pinned: patch.pinned === undefined ? row.pinned : patch.pinned ? 1 : 0 });
  }
  deleteManual(id: string): { ok: true } { if (!this.manualRepo().get(id)) throw new Error('Mục thủ công không tồn tại'); this.manualRepo().delete(id); return { ok: true }; }
  setDayHours(sourceId: string, date: string, hours: number): { sourceId: string; date: string; hours: number } {
    if (!Number.isFinite(hours) || hours < 8 || Math.abs(hours * 4 - Math.round(hours * 4)) > 1e-8) throw new Error('Tổng giờ phải từ 8 và là bội số 0.25');
    this.source(sourceId); this.options.dayOverrideRepo?.upsert(sourceId, date, hours);
    return { sourceId, date, hours };
  }
  async checkScheduled(): Promise<void> { const now = this.now(); const date = new Date(now); const key = formatYYYYMMDD(date); for (const source of this.options.config.integrations.openproject.sources) { const cfg = source.timesheet; if (!cfg?.enabled || (cfg.weekdaysOnly !== false && (date.getDay() === 0 || date.getDay() === 6)) || this.lastRun.get(source.id) === key) continue; const hasPosted = typeof (this.options.eventRepo as Partial<EventRepo>).hasTimesheetPosted === 'function' && this.options.eventRepo.hasTimesheetPosted(source.id, key); if (hasPosted) { this.lastRun.set(source.id, key); continue; } if ((this.nextAttempt.get(source.id) || 0) > now) continue; const [h, m] = cfg.time.split(':').map(Number); const scheduled = new Date(date); scheduled.setHours(h, m, 0, 0); if (now < scheduled.getTime()) continue; try { await this.run(source.id, key); this.lastRun.set(source.id, key); this.failures.delete(source.id); this.nextAttempt.delete(source.id); } catch { const failure = (this.failures.get(source.id) || 0) + 1; this.failures.set(source.id, failure); const delay = Math.min(source.pollIntervalSec * 1000 * (2 ** failure), 30 * 60 * 1000); this.nextAttempt.set(source.id, now + delay); } } }
  async preview(sourceId: string, date = formatYYYYMMDD(new Date(this.now())), hoursOverride?: number): Promise<TimesheetPreview> {
    const source = this.source(sourceId); const cfg = source.timesheet; const storedHours = this.options.dayOverrideRepo?.get(sourceId, date)?.hours; const dayHours = hoursOverride ?? storedHours ?? cfg?.hours ?? 8; if (!cfg) return { sourceId, date, hours: dayHours, entries: [], withoutTicket: [], missingFromDate: [], overMinimum: false };
    const weekday = new Date(`${date}T12:00:00`).getDay(); if (cfg.weekdaysOnly !== false && (weekday === 0 || weekday === 6)) return { sourceId, date, hours: dayHours, entries: [], withoutTicket: [], missingFromDate: [], overMinimum: false };
    const key = readOpenProjectKey(this.options.config.hubHome, sourceId); if (!key) throw new Error('Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    const projects = this.options.projectRepo.getAll().filter((project) => { try { return projectSettings(project).openproject?.enabled && projectSettings(project).openproject?.sourceId === sourceId; } catch { return false; } });
    const projectIds = new Set(projects.map((p) => p.id)); const tasks = this.options.taskRepo.getAll().filter((task) => projectIds.has(task.projectId)); const day = dayMs(date); const tickets = new Map<number, TimesheetTicket>(); const withoutTicket: Array<{ taskId: string; subject: string }> = [];
    for (const task of tasks) {
      const project = projects.find((p) => p.id === task.projectId); if (!project) continue;
      const commits = await this.commits(project.path, project.defaultBranch, task.branch || project.defaultBranch, date); if (!commits.length) continue;
      let wp: OpenProjectWorkPackage | undefined; if (task.externalRef) wp = await client.findWorkPackage(task.externalRef); if (!wp) { withoutTicket.push({ taskId: task.id, subject: subjectFromCommits(commits, source.language) }); continue; }
      const runs = this.options.runRepo.getByTask(task.id);
      const runMinutes = runs.reduce((sum, run) => { const start = Math.max(day.start, new Date(run.startedAt).getTime()); const end = Math.min(day.end, new Date(run.endedAt || new Date(day.end).toISOString()).getTime()); return sum + Math.max(0, (end - start) / 60000); }, 0);
      const events = this.options.eventRepo.getByTask(task.id).filter((event) => { const ts = new Date(event.ts).getTime(); return ts >= day.start && ts < day.end; });
      const payloadText = events.map((event) => event.payload || '').join(' ');
      const chat = (events.filter((event) => /review|comment|decision|blocked|question|changes_requested|ticket.*(created|comment)|comment.*(created|added)/i.test(event.type)).length + (payloadText.includes('## Cần quyết định') ? 1 : 0)) * 10;
      const waitStarts = events.filter((event) => /checking|review\.waiting|review\.gate_started|merge\.waiting|wait/i.test(event.type)).map((event) => new Date(event.ts).getTime());
      const wait = Math.min(runMinutes, waitStarts.reduce((sum, start, index) => { const end = waitStarts[index + 1] || day.end; return sum + Math.max(0, Math.min(day.end, end) - Math.max(day.start, start)) / 60000; }, 0));
      const level = taskLevel(task); const current = tickets.get(wp.id) || { wpId: wp.id, displayId: wp.displayId || String(wp.id), subject: wp.subject || '', hours: 0, rawHours: 0, estimateHours: 0, comment: subjectFromCommits(commits, source.language), run: 0, wait: 0, chat: 0, level: 0, weight: 0, kind: 'commit' as const, pinned: false };
      current.run += runMinutes; current.wait += wait; current.chat += chat; current.weight += (runMinutes + 0.5 * wait + chat) * level; const base = current.run + 0.5 * current.wait + current.chat; current.level = base ? current.weight / base : level; current.comment = subjectFromCommits([current.comment, ...commits], source.language); tickets.set(wp.id, current);
    }
    const manualRows = this.options.manualRepo?.listForDate(sourceId, date) || [];
    for (const row of manualRows) {
      const wp = await client.findWorkPackage(row.wp_id) || await client.findWorkPackage(row.display_id);
      if (!wp) { withoutTicket.push({ taskId: row.id, subject: row.description }); continue; }
      const current = tickets.get(wp.id) || { wpId: wp.id, displayId: wp.displayId || row.display_id, subject: wp.subject || row.description, hours: 0, rawHours: 0, estimateHours: 0, comment: '', run: 0, wait: 0, chat: 0, level: 0, weight: 0, kind: 'manual' as const, pinned: false, manualIds: [] };
      current.kind = current.kind === 'commit' ? 'mixed' : 'manual'; current.manualIds = [...(current.manualIds || []), row.id];
      current.comment = [current.comment, row.description].filter(Boolean).join(' · ').slice(0, 255);
      const factor = row.level === 'hard' ? 1.5 : 1;
      const raw = (row.active_hours + 0.5 * row.wait_hours) * factor;
      current.rawHours += raw;
      if (row.pinned) current.fixedHours = (current.fixedHours || 0) + row.active_hours + row.wait_hours;
      else current.weight += raw;
      current.pinned = current.pinned || Boolean(row.pinned);
      tickets.set(wp.id, current);
    }
    const entries = [...tickets.values()];
    const fixedHours = entries.reduce((sum, entry) => sum + (entry.fixedHours || 0), 0);
    const flexible = entries.filter((entry) => entry.weight > 0 || entry.run > 0 || entry.wait > 0 || entry.chat > 0);
    const target = Math.max(0, dayHours - fixedHours, flexible.length * cfg.minEntryHours);
    const allocated = allocateTimesheetHours(flexible, target, cfg.minEntryHours, cfg.roundTo);
    let flexibleIndex = 0;
    entries.forEach((entry) => {
      entry.hours = (entry.fixedHours || 0) + (flexible.includes(entry) ? allocated[flexibleIndex++] : 0);
      // rawHours = (run + 0.5*wait + chat) * level in hours, rounded up to roundTo
      const rawMinutes = entry.run + 0.5 * entry.wait + entry.chat;
      if (rawMinutes > 0) entry.rawHours += roundHours((rawMinutes * entry.level) / 60, cfg.roundTo);
      entry.comment = entry.comment.slice(0, 255);
      const pastRaw = this.options.entryRepo.sumRawHours(sourceId, entry.wpId, date);
      entry.estimateHours = roundHours(pastRaw + entry.rawHours, cfg.roundTo);
    });
    const currentWpIds = new Set(entries.map((entry) => entry.wpId)); const missingFromDate = this.options.entryRepo.listForDate(sourceId, date).map((row) => row.wp_id).filter((id) => !currentWpIds.has(id));
    return { sourceId, date, hours: dayHours, entries, withoutTicket, missingFromDate, overMinimum: entries.length * cfg.minEntryHours + fixedHours > dayHours, fixedHours, fixedOverHours: fixedHours >= dayHours };
  }
  private async commits(cwd: string, defaultBranch: string, branch: string, date: string): Promise<string[]> { const { start } = dateBounds(date); try { const range = branch === defaultBranch ? branch : `${defaultBranch}..${branch}`; const result = await execFileAsync('git', ['-C', cwd, 'log', range, `--since=${start}`, `--until=${date} 23:59:59.999`, '--format=%s']); return result.stdout.split('\n').map((x) => x.trim()).filter(Boolean); } catch { return []; } }
  async run(sourceId: string, date = formatYYYYMMDD(new Date(this.now())), hoursOverride?: number): Promise<TimesheetPreview> {
    const source = this.source(sourceId); const cfg = source.timesheet; const preview = await this.preview(sourceId, date, hoursOverride);
    if (!cfg?.enabled || cfg.activityId == null) return preview;
    const key = readOpenProjectKey(this.options.config.hubHome, sourceId); if (!key) throw new Error('Nguồn chưa có API key');
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    const errors: string[] = []; const posted: TimesheetTicket[] = []; const estimateSkipped: Array<{ wpId: number; displayId: string; reason: string }> = [];
    for (const entry of preview.entries) {
      let spentOk = false;
      try {
        const input = { hours: isoDuration(entry.hours), spentOn: date, comment: entry.comment, workPackageId: entry.wpId, activityId: cfg.activityId! };
        const stored = this.options.entryRepo.get(sourceId, date, entry.wpId);
        const result = stored ? await client.updateTimeEntry(stored.entry_id, input) : await client.createTimeEntry(input);
        // Persist raw_hours for this day; keep written_estimate from stored row until we update it below
        this.options.entryRepo.upsert({ source_id: sourceId, spent_on: date, wp_id: entry.wpId, entry_id: result.id, hours: entry.hours, raw_hours: entry.rawHours, written_estimate: stored?.written_estimate ?? null });
        posted.push(entry);
        spentOk = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message.replaceAll(key, '[REDACTED]'));
      }
      // Write estimate — only if spent time succeeded (don't mask time entry errors)
      if (spentOk && cfg.writeEstimate !== false) {
        try {
          const totalEstimate = entry.estimateHours;
          const estimateDuration = isoDuration(totalEstimate);
          // prevWritten: giá trị written_estimate gần nhất hub đã ghi cho WP này (qua mọi ngày)
          const prevWritten = this.options.entryRepo.lastWrittenEstimate(sourceId, entry.wpId);
          try {
            await client.setEstimate(entry.wpId, estimateDuration, { prevWrittenHours: prevWritten });
            // Update written_estimate in DB
            const freshStored = this.options.entryRepo.get(sourceId, date, entry.wpId);
            if (freshStored) {
              this.options.entryRepo.upsert({ ...freshStored, written_estimate: totalEstimate });
            }
          } catch (estError) {
            const estMsg = estError instanceof Error ? estError.message : String(estError);
            if (estMsg.includes('người khác')) {
              estimateSkipped.push({ wpId: entry.wpId, displayId: entry.displayId, reason: 'estimate đã do người khác đặt' });
            } else if (estError instanceof OpenProjectError && estError.status === 422) {
              estimateSkipped.push({ wpId: entry.wpId, displayId: entry.displayId, reason: `OP trả về 422: ${estMsg}` });
            } else {
              estimateSkipped.push({ wpId: entry.wpId, displayId: entry.displayId, reason: estMsg });
            }
          }
        } catch {
          // estimate errors do not block spent time
        }
      }
    }
    if (errors.length) { this.options.eventBus.emit('tracker.timesheet.failed', undefined, { sourceId, date, error: errors.join('; '), posted: posted.length, entries: posted, withoutTicket: preview.withoutTicket, missingFromDate: preview.missingFromDate, estimateSkipped }); throw new Error(errors.join('; ')); }
    this.options.eventBus.emit('tracker.timesheet.posted', undefined, { sourceId, date, hours: preview.hours, entries: preview.entries, withoutTicket: preview.withoutTicket, missingFromDate: preview.missingFromDate, overMinimum: preview.overMinimum, estimateSkipped });
    return { ...preview, estimateSkipped };
  }
}

export { parsePTHours };
