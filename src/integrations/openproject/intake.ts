import path from 'node:path';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { projectSettings } from '../../projects/settings.js';
import type { ProjectRepo, ProjectRow, TaskRepo, TrackerItemRepo, TrackerItemRow } from '../../db/index.js';
import { OpenProjectClient, type OpenProjectActivity, type OpenProjectWorkPackage } from './client.js';
import { readOpenProjectKey } from './secrets.js';
import { writeTicketDirectory } from './ticket.js';

const OPEN_TASK_STATUSES = new Set(['draft', 'queued', 'running', 'checking', 'review', 'waiting_quota', 'paused']);

export interface IntakeTaskService {
  createTask(raw: unknown): { id: string };
}

export interface OpenProjectIntakeServiceOptions {
  config: AgentHubConfig;
  projectRepo: ProjectRepo;
  taskRepo: TaskRepo;
  trackerRepo: TrackerItemRepo;
  taskService: IntakeTaskService;
  eventBus: { emit(type: string, taskId?: string, payload?: unknown): boolean };
  fetchFn?: typeof fetch;
  now?: () => number;
  timerMs?: number;
}

function statusId(workPackage: OpenProjectWorkPackage): number | null {
  const href = workPackage._links?.status?.href || '';
  const value = Number(href.split('/').at(-1));
  return Number.isInteger(value) ? value : null;
}

function displayId(workPackage: OpenProjectWorkPackage): string {
  return workPackage.displayId || String(workPackage.id);
}

function ticketNumber(value: string): number | null {
  const match = value.match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function slugPart(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return result || 'ticket';
}

function taskIds(row: TrackerItemRow | undefined): string[] {
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.task_ids);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function isComment(activity: OpenProjectActivity): boolean {
  return Boolean(activity.comment?.raw);
}

export class OpenProjectIntakeService {
  private readonly config: AgentHubConfig;
  private readonly projectRepo: ProjectRepo;
  private readonly taskRepo: TaskRepo;
  private readonly trackerRepo: TrackerItemRepo;
  private readonly taskService: IntakeTaskService;
  private readonly eventBus: OpenProjectIntakeServiceOptions['eventBus'];
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timerMs: number;
  private timer?: NodeJS.Timeout;
  private started = false;
  private nextPoll = new Map<string, number>();
  private failures = new Map<string, number>();
  private initializedSources = new Set<string>();

  constructor(options: OpenProjectIntakeServiceOptions) {
    this.config = options.config;
    this.projectRepo = options.projectRepo;
    this.taskRepo = options.taskRepo;
    this.trackerRepo = options.trackerRepo;
    this.taskService = options.taskService;
    this.eventBus = options.eventBus;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.timerMs = options.timerMs || 1000;
  }

  start(): void {
    if (this.started) return;
    if (!this.config.integrations.openproject.sources.some((source) => this.attached(source.id))) return;
    this.started = true;
    this.pollDue().catch(() => undefined);
    this.timer = setInterval(() => this.pollDue().catch(() => undefined), this.timerMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sync(sourceId: string): Promise<{ imported: number; comments: number }> {
    const source = this.config.integrations.openproject.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error(`Nguồn OpenProject không tồn tại: ${sourceId}`);
    return this.pollSource(source);
  }

  private attached(sourceId: string): { primary: ProjectRow; count: number } | null {
    const projects = this.projectRepo.getAll().filter((project) => {
      const settings = projectSettings(project);
      return settings.openproject.enabled && settings.openproject.sourceId === sourceId;
    });
    const primary = projects.find((project) => projectSettings(project).openproject.role === 'primary');
    return primary ? { primary, count: projects.length } : null;
  }

  private async pollDue(): Promise<void> {
    const now = this.now();
    for (const source of this.config.integrations.openproject.sources) {
      if (!this.attached(source.id)) continue;
      if ((this.nextPoll.get(source.id) || 0) > now) continue;
      try {
        await this.pollSource(source);
        this.failures.delete(source.id);
        this.nextPoll.set(source.id, now + source.pollIntervalSec * 1000);
      } catch (error) {
        const failure = (this.failures.get(source.id) || 0) + 1;
        this.failures.set(source.id, failure);
        const delay = Math.min(source.pollIntervalSec * 1000 * (2 ** failure), 1800 * 1000);
        this.nextPoll.set(source.id, now + delay);
        this.eventBus.emit('tracker.poll_failed', undefined, { sourceId: source.id, error: error instanceof Error ? error.message : String(error), retryInSec: Math.round(delay / 1000) });
      }
    }
  }

  private async pollSource(source: OpenProjectSource): Promise<{ imported: number; comments: number }> {
    const key = readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) throw new Error('Nguồn OpenProject chưa có API key');
    const attached = this.attached(source.id);
    if (!attached) return { imported: 0, comments: 0 };
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    const watched = await client.listWatched(source.watchStatusIds);
    const me = await client.me();
    const firstPoll = !this.initializedSources.has(source.id) && this.trackerRepo.list(source.id).length === 0;
    let imported = 0;
    let comments = 0;
    for (const listed of watched) {
      const wp = await client.getWorkPackage(listed.id);
      const activities = await client.listActivities(wp.id);
      const previous = this.trackerRepo.get(source.id, wp.id);
      const currentStatus = statusId(wp);
      const lastComment = activities.reduce((max, item) => Math.max(max, item.id || 0), 0) || null;
      if (!previous && firstPoll) {
        this.trackerRepo.upsert({ source_id: source.id, wp_id: wp.id, display_id: displayId(wp), status_id: currentStatus, updated_at: wp.updatedAt || new Date(this.now()).toISOString(), last_comment_id: lastComment, task_ids: '[]', writeback: '{}' });
        continue;
      }

      if (!previous) {
        const seed: TrackerItemRow = {
          source_id: source.id,
          wp_id: wp.id,
          display_id: displayId(wp),
          status_id: null,
          updated_at: '',
          last_comment_id: null,
          task_ids: '[]',
          writeback: '{}',
          created_at: new Date(this.now()).toISOString(),
        };
        const importedResult = await this.handleTicket(source, attached.primary, client, wp, activities, seed, 'new');
        imported += importedResult.imported;
        comments += importedResult.comments;
        this.trackerRepo.upsert({ ...importedResult.row, status_id: currentStatus, updated_at: wp.updatedAt || new Date(this.now()).toISOString(), last_comment_id: lastComment });
        continue;
      }

      const reopened = currentStatus !== previous.status_id && currentStatus !== null && source.reopenedStatusIds.includes(currentStatus);
      const changed = wp.updatedAt !== previous.updated_at;
      const freshComments: OpenProjectActivity[] = [];
      if (changed) {
        for (const activity of activities) {
          if (!isComment(activity) || (previous.last_comment_id !== null && activity.id <= previous.last_comment_id)) continue;
          const author = activity._links?.user?.href ? await client.getUserName(activity._links.user.href) : '';
          if (author && author === me.name) continue;
          freshComments.push(activity);
        }
      }

      let row = previous;
      const hasTasks = taskIds(previous).length > 0;
      const isNew = !hasTasks && !changed;
      if (reopened || (changed && freshComments.length > 0) || isNew) {
        const event = reopened ? 'reopened' : isNew ? 'new' : 'comment';
        const importedResult = await this.handleTicket(source, attached.primary, client, wp, activities, row, event);
        imported += importedResult.imported;
        comments += importedResult.comments;
        row = importedResult.row;
      }
      this.trackerRepo.upsert({ ...row, display_id: displayId(wp), status_id: currentStatus, updated_at: wp.updatedAt || row.updated_at, last_comment_id: lastComment, task_ids: row.task_ids });
    }
    this.initializedSources.add(source.id);
    return { imported, comments };
  }

  private async handleTicket(source: OpenProjectSource, primary: ProjectRow, client: OpenProjectClient, wp: OpenProjectWorkPackage, activities: OpenProjectActivity[], previous: TrackerItemRow, event: 'new' | 'reopened' | 'comment'): Promise<{ row: TrackerItemRow; imported: number; comments: number }> {
    const ids = taskIds(previous);
    const openTasks = ids.map((id) => this.taskRepo.get(id)).filter((task): task is NonNullable<ReturnType<TaskRepo['get']>> => Boolean(task && OPEN_TASK_STATUSES.has(task.status)));
    const isNewTaskEvent = event === 'new' || event === 'reopened';
    const number = ticketNumber(displayId(wp));
    let imported = 0;
    let comments = 0;
    const dir = path.join(this.config.hubHome, 'tracker', source.id, String(wp.id));
    if (isNewTaskEvent && number !== null && number >= source.minTicketNumber && openTasks.length === 0) {
      await writeTicketDirectory(client, wp, activities, dir, source.url);
      const base = `op-${slugPart(displayId(wp))}`;
      let slug = base;
      let revision = 1;
      while (this.taskRepo.get(`${primary.id}/${slug}`)) slug = `${base}-r${++revision}`;
      const title = `[${displayId(wp)}] ${wp.subject || ''}`.trim();
      const body = `Ticket: [${displayId(wp)}] ${wp.subject || ''} — ${source.url.replace(/\/+$/, '')}/work_packages/${wp.id}\nTrạng thái: ${wp.status?.title || wp._links?.status?.title || statusId(wp) || ''} · Ưu tiên: ${wp.priority?.title || wp._links?.priority?.title || ''} · Người tạo: ${wp.author?.title || wp._links?.author?.title || ''}\n\nĐọc toàn bộ \`.agenthub/context/ticket/ticket.md\` (mô tả + lịch sử comment) và ảnh trong\n\`.agenthub/context/ticket/images/\`. Với ticket Reopened, comment mới nhất của tester là yêu cầu chính.\nNếu có comment [Cần duyệt] và sau đó có quyết định, làm đúng theo quyết định đó.\n\nYêu cầu: tìm nguyên nhân gốc, sửa tối thiểu, chạy build/test của repo, commit với message\n\`fix(${displayId(wp)}): <tóm tắt>\`.\n\n- Xong: .agenthub/DONE có mục ## Comment cho tester, viết bằng ngôn ngữ của người dùng cuối, không có tên file hay tên hàm.\n- Cần người quyết định: .agenthub/BLOCKED có mục ## Cần quyết định, liệt kê các phương án có đánh số.\n- Cần sửa repo khác: DONE có mục ## Cần sửa ở project <projectId> kèm mô tả.\n`;
      const task = this.taskService.createTask({ project: primary.id, slug, title, body, level: 'easy', externalRef: displayId(wp), start: source.autoStart });
      ids.push(task.id);
      imported = 1;
      this.eventBus.emit('tracker.ticket_imported', task.id, { sourceId: source.id, wpId: wp.id, displayId: displayId(wp) });
    } else if (openTasks.length > 0) {
      await writeTicketDirectory(client, wp, activities, dir, source.url);
      if (event === 'comment') {
        comments = 1;
        this.eventBus.emit('tracker.comment', openTasks[0].id, { sourceId: source.id, wpId: wp.id, displayId: displayId(wp), comment: activities.at(-1)?.comment?.raw || '' });
      }
    }
    return { row: { ...previous, task_ids: JSON.stringify(ids) }, imported, comments };
  }
}
