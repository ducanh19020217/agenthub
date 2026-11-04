import path from 'node:path';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { projectSettings } from '../../projects/settings.js';
import type { ProjectRepo, ProjectRow, TaskRepo, TrackerItemRepo, TrackerItemRow } from '../../db/index.js';
import { HttpError } from '../../errors.js';
import { OpenProjectClient, type OpenProjectActivity, type OpenProjectWorkPackage } from './client.js';
import { readOpenProjectKey } from './secrets.js';
import { writeTicketDirectory } from './ticket.js';

const OPEN_TASK_STATUSES = new Set(['draft', 'queued', 'running', 'checking', 'review', 'waiting_quota', 'paused']);

export interface OpenProjectSyncResult {
  imported: number;
  comments: number;
  baseline: number;
  watched: number;
}

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

function typeId(workPackage: OpenProjectWorkPackage): number | null {
  const href = workPackage._links?.type?.href || '';
  const value = Number(href.split('/').at(-1));
  return Number.isInteger(value) ? value : null;
}

function splitConfig(source: OpenProjectSource): NonNullable<OpenProjectSource['split']> {
  return source.split || { typeIds: [], keyword: '[chia]', workerMayRequest: true, maxParts: 5, createChildTickets: true };
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

function isBaselineRow(row: TrackerItemRow | undefined): boolean {
  if (!row) return false;
  try {
    const parsed = JSON.parse(row.writeback);
    return Boolean(parsed && typeof parsed === 'object' && parsed.baseline === true);
  } catch {
    return false;
  }
}

function isCreatePendingRow(row: TrackerItemRow | undefined): boolean {
  if (!row) return false;
  try {
    const parsed = JSON.parse(row.writeback);
    return Boolean(parsed && typeof parsed === 'object' && parsed.createPending === true);
  } catch {
    return false;
  }
}

function clearBaseline(writebackJson: string): string {
  try {
    const parsed = JSON.parse(writebackJson);
    if (parsed && typeof parsed === 'object') {
      delete parsed.baseline;
      return JSON.stringify(parsed);
    }
    return '{}';
  } catch {
    return '{}';
  }
}

function decisionOf(row: TrackerItemRow): string | undefined {
  try {
    const parsed = JSON.parse(row.writeback) as { decision?: { action?: string } };
    return parsed.decision?.action;
  } catch { return undefined; }
}

function triageState(row: TrackerItemRow): { decision?: { action?: string }; triage?: unknown } {
  try { return JSON.parse(row.writeback) as { decision?: { action?: string }; triage?: unknown }; } catch { return {}; }
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

  async sync(sourceId: string): Promise<OpenProjectSyncResult> {
    const source = this.config.integrations.openproject.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error(`Nguồn OpenProject không tồn tại: ${sourceId}`);
    return this.pollSource(source);
  }

  private attached(sourceId: string): { primary: ProjectRow; projects: ProjectRow[] } | null {
    const projects = this.projectRepo.getAll().filter((project) => {
      const settings = projectSettings(project);
      return settings.openproject.enabled && settings.openproject.sourceId === sourceId;
    });
    const primary = projects.find((project) => projectSettings(project).openproject.role === 'primary');
    return primary ? { primary, projects } : null;
  }

  private async pollDue(): Promise<void> {
    const now = this.now();
    for (const source of this.config.integrations.openproject.sources) {
      if (!this.attached(source.id)) {
        if ((this.nextPoll.get(source.id) || 0) <= now) {
          console.debug(`[openproject-intake] Nguồn ${source.id} chưa gắn với project nào`);
          this.nextPoll.set(source.id, now + source.pollIntervalSec * 1000);
        }
        continue;
      }
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

  private async pollSource(source: OpenProjectSource): Promise<OpenProjectSyncResult> {
    const key = readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) throw new Error('Nguồn OpenProject chưa có API key');
    const attached = this.attached(source.id);
    if (!attached) {
      throw new HttpError(400, 'bad_request', 'Nguồn chưa được gắn vào project nào (Dự án → Cài đặt → OpenProject → Bật + chọn nguồn, vai trò primary)');
    }
    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    const watched = await client.listWatched(source.watchStatusIds);
    const me = await client.me();
    const firstPoll = !this.initializedSources.has(source.id) && this.trackerRepo.list(source.id).length === 0;
    let imported = 0;
    let comments = 0;
    let baseline = 0;
    for (const listed of watched) {
      const wp = await client.getWorkPackage(listed.id);
      const activities = await client.listActivities(wp.id);
      const previous = this.trackerRepo.get(source.id, wp.id);
      const currentStatus = statusId(wp);
      const lastComment = activities.reduce((max, item) => Math.max(max, item.id || 0), 0) || null;
      if (!previous && firstPoll) {
        this.trackerRepo.upsert({
          source_id: source.id,
          wp_id: wp.id,
          display_id: displayId(wp),
          status_id: currentStatus,
          updated_at: wp.updatedAt || new Date(this.now()).toISOString(),
          last_comment_id: lastComment,
          task_ids: '[]',
          writeback: JSON.stringify({ baseline: true }),
        });
        baseline += 1;
        continue;
      }

      // A task-created ticket is claimed immediately after POST, before its
      // details and ticket directory are fetched. Never import that claim as
      // a second task while the original request is still completing.
      if (previous && isCreatePendingRow(previous)) {
        this.trackerRepo.upsert({ ...previous, display_id: displayId(wp), status_id: currentStatus, updated_at: wp.updatedAt || previous.updated_at, last_comment_id: lastComment });
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
      const isBaseline = isBaselineRow(previous);
      const isNew = !hasTasks && !isBaseline;
      if (reopened || (changed && freshComments.length > 0) || isNew) {
        const event = reopened ? 'reopened' : isNew ? 'new' : 'comment';
        const importedResult = await this.handleTicket(source, attached.primary, client, wp, activities, row, event);
        imported += importedResult.imported;
        comments += importedResult.comments;
        row = importedResult.row;
      }
      this.trackerRepo.upsert({ ...row, display_id: displayId(wp), status_id: currentStatus, updated_at: wp.updatedAt || row.updated_at, last_comment_id: lastComment, task_ids: row.task_ids, writeback: row.writeback });
    }
    this.initializedSources.add(source.id);
    return { imported, comments, baseline, watched: watched.length };
  }

  private async handleTicket(source: OpenProjectSource, primary: ProjectRow, client: OpenProjectClient, wp: OpenProjectWorkPackage, activities: OpenProjectActivity[], previous: TrackerItemRow, event: 'new' | 'reopened' | 'comment'): Promise<{ row: TrackerItemRow; imported: number; comments: number }> {
    const ids = taskIds(previous);
    const openTasks = ids.map((id) => this.taskRepo.get(id)).filter((task): task is NonNullable<ReturnType<TaskRepo['get']>> => Boolean(task && OPEN_TASK_STATUSES.has(task.status)));
    const isNewTaskEvent = event === 'new' || event === 'reopened';
    const decision = decisionOf(previous);
    const number = ticketNumber(displayId(wp));
    let imported = 0;
    let comments = 0;
    const dir = path.join(this.config.hubHome, 'tracker', source.id, String(wp.id));
    const previousState = triageState(previous);
    const canTriageComment = source.triage !== 'off' && event === 'comment' && decision === 'ask';
    if ((isNewTaskEvent || canTriageComment) && number !== null && number >= source.minTicketNumber && openTasks.length === 0) {
      await writeTicketDirectory(client, wp, activities, dir, source.url);
      const triage = source.triage !== 'off';
      const split = splitConfig(source);
      const splitByType = split.typeIds.includes(typeId(wp) || -1);
      const splitByKeyword = Boolean(split.keyword && (wp.subject || '').toLocaleLowerCase().includes(split.keyword.toLocaleLowerCase()));
      const plan = !triage && (splitByType || splitByKeyword);
      const base = `op-${slugPart(displayId(wp))}${triage ? '-triage' : plan ? '-plan' : ''}`;
      let slug = base;
      let revision = 1;
      while (this.taskRepo.get(`${primary.id}/${slug}`)) slug = `${base}-r${++revision}`;
      const title = `[${displayId(wp)}] ${wp.subject || ''}`.trim();
      const body = `Ticket: [${displayId(wp)}] ${wp.subject || ''} — ${source.url.replace(/\/+$/, '')}/work_packages/${wp.id}\nTrạng thái: ${wp.status?.title || wp._links?.status?.title || statusId(wp) || ''} · Ưu tiên: ${wp.priority?.title || wp._links?.priority?.title || ''} · Người tạo: ${wp.author?.title || wp._links?.author?.title || ''}\n\nĐọc toàn bộ \`.agenthub/context/ticket/ticket.md\` (mô tả + lịch sử comment) và ảnh trong\n\`.agenthub/context/ticket/images/\`. Với ticket Reopened, comment mới nhất của tester là yêu cầu chính.\nNếu có comment [Cần duyệt] và sau đó có quyết định, làm đúng theo quyết định đó.\n\nBước đầu: ước lượng phạm vi. Việc vừa sức một task thì làm luôn. Nếu việc quá lớn cho một task (nhiều phần độc lập, nhiều repo), đừng sửa, hãy viết ## Chia việc theo src/protocol.md.\n\nYêu cầu: tìm nguyên nhân gốc, sửa tối thiểu, chạy build/test của repo, commit với message\n\`fix(${displayId(wp)}): <tóm tắt>\`.\n\n- Xong: .agenthub/DONE có mục ## Comment cho tester, viết bằng ngôn ngữ của người dùng cuối, không có tên file hay tên hàm.\n- Cần người quyết định: .agenthub/BLOCKED có mục ## Cần quyết định, liệt kê các phương án có đánh số.\n- Cần sửa repo khác: DONE có mục ## Cần sửa ở project <projectId> kèm mô tả.\n`;
      const projects = (this.attached(source.id)?.projects || [primary]).map((project) => `- ${project.id}: ${project.path} (${projectSettings(project).openproject.role})`).join('\n');
      const taskBody = triage
        ? `Ticket: [${displayId(wp)}] ${wp.subject || ''} — ${source.url.replace(/\/+$/, '')}/work_packages/${wp.id}\n\nTRIAGE: Không sửa code, không commit. Đọc ticket, comment, ảnh và code liên quan của các project:\n${projects}\nKhi xong tạo .agenthub/DONE có mục ## Phân tích đúng định dạng trong src/protocol.md. Nếu có nhiều repo, ghi thêm ### Phần việc theo repo.\n`
        : plan
          ? `${body}\n\nĐây là task lập kế hoạch chia việc. Không sửa code, không commit. Đọc ticket và code liên quan, sau đó ghi .agenthub/DONE có mục ## Chia việc theo định dạng trong src/protocol.md. Tối đa ${split.maxParts} việc con, tối thiểu 2; mỗi việc phải trọn vẹn và kiểm thử độc lập.`
        : body;
      const task = this.taskService.createTask({ project: primary.id, slug, title, body: taskBody, level: plan ? 'hard' : 'easy', modelChain: triage ? source.triageModelChain : undefined, externalRef: displayId(wp), start: triage ? true : source.autoStart });
      ids.push(task.id);
      imported = 1;
      if (triage) {
        const state = previousState as Record<string, unknown>;
        delete state.decision;
        delete state.triage;
        previous.writeback = JSON.stringify(state);
      }
      this.eventBus.emit(triage ? 'tracker.triage_started' : plan ? 'tracker.split_plan_started' : 'tracker.ticket_imported', task.id, { sourceId: source.id, wpId: wp.id, displayId: displayId(wp), triage, plan });
    } else if (openTasks.length > 0) {
      await writeTicketDirectory(client, wp, activities, dir, source.url);
      if (event === 'comment') {
        comments = 1;
        this.eventBus.emit('tracker.comment', openTasks[0].id, { sourceId: source.id, wpId: wp.id, displayId: displayId(wp), comment: activities.at(-1)?.comment?.raw || '' });
      }
    }
    return {
      row: {
        ...previous,
        task_ids: JSON.stringify(ids),
        writeback: imported > 0 ? clearBaseline(previous.writeback) : previous.writeback,
      },
      imported,
      comments,
    };
  }
}
