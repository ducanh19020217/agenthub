import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import type { EventBus } from '../../scheduler/index.js';
import { projectSettings } from '../../projects/settings.js';
import type { ProjectRepo, ProjectRow, TaskRepo, TaskRow, TrackerItemRepo, TrackerItemRow } from '../../db/index.js';
import { OpenProjectClient, OpenProjectError } from './client.js';
import { readOpenProjectKey } from './secrets.js';
import { analysisMarkdown, isTriageTaskSlug, parseTriageAnalysis, shouldAutoDispatch, type TriageAnalysis } from './triage.js';
import { parseSplitPlan, splitSection, type SplitPlan } from './split.js';

/** Stable hand-off point for the split workflow used by f-op-split. */
export function startSplit(analysis: TriageAnalysis, projectId: string, note?: string): string {
  return `${note ? `## Chỉ đạo người dùng (ưu tiên cao nhất)\n${note}\n\n` : ''}## Phân tích triage\n\n${analysisMarkdown(analysis)}\n\n## Phần việc của repo ${projectId}\n${analysis.perRepo || analysis.proposal}\n\nSửa theo đề xuất và ghi ## Comment cho tester trong DONE.${analysis.manualAlongside ? `\n\n## Việc thủ công kèm theo\n${analysis.manualAlongside}` : ''}`;
}

type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>;
type WritebackState = {
  linked?: Record<string, string>;
  merged?: Record<string, string>;
  reviewRequested?: Record<string, string>;
  commented?: boolean;
  resolved?: boolean;
  pushWarning?: boolean;
  failed?: string;
  triage?: { taskId: string; analysis: TriageAnalysis; readyAt: string };
  decision?: { action: 'do' | 'split' | 'ask' | 'skip' | 'manual'; by: string; at: string; note?: string };
  split?: {
    planTaskId?: string;
    children?: string[];
    childTickets?: Record<string, { id: number; displayId: string; url: string }>;
    plan?: SplitPlan;
    planCommented?: boolean;
    planDiscarded?: boolean;
  };
};

export interface OpenProjectWritebackServiceOptions {
  config: AgentHubConfig;
  projectRepo: ProjectRepo;
  taskRepo: TaskRepo;
  trackerRepo: TrackerItemRepo;
  taskService: { createTask(raw: unknown): { id: string } };
  batchService?: { createBatch(raw: unknown): { id: string; tasks: TaskRow[] }; dispatchBatch?: (id: string) => unknown };
  taskBatchRepo?: { get(id: string): { goal: string | null; status: string } | undefined };
  reviewRepo?: { getByTask(taskId: string): Array<{ actor?: string | null; verdict: string; feedback?: string | null }> };
  eventBus: Pick<EventBus, 'on' | 'off' | 'emit'>;
  fetchFn?: typeof fetch;
  git?: GitRunner;
  timerMs?: number;
  now?: () => number;
}

function parseIds(row: TrackerItemRow): string[] {
  try {
    const ids = JSON.parse(row.task_ids);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

function parseState(row: TrackerItemRow): WritebackState {
  try { return JSON.parse(row.writeback) as WritebackState; } catch { return {}; }
}

function section(content: string | null | undefined, heading: string): string | null {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase().startsWith(heading.toLowerCase()));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim() || null;
}

export function extractBugSection(content: string | null | undefined, heading: string): string | null {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const cleanHeading = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => {
    const trimmed = line.trim().toLowerCase();
    return (
      trimmed === cleanHeading ||
      trimmed === `### ${cleanHeading}` ||
      trimmed === `## ${cleanHeading}` ||
      trimmed.startsWith(`### ${cleanHeading}`) ||
      trimmed.startsWith(`## ${cleanHeading}`) ||
      trimmed.startsWith(`${cleanHeading}:`) ||
      trimmed.startsWith(`- **${cleanHeading}**:`) ||
      trimmed.startsWith(`**${cleanHeading}**:`)
    );
  });
  if (start < 0) return null;
  const startLine = lines[start].trim();
  const isInline = startLine.includes(':') && !startLine.startsWith('#');
  if (isInline) {
    const inlineContent = startLine.substring(startLine.indexOf(':') + 1).trim();
    const extraLines: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(#{1,6}\s|[-*]\s|\*\*)/.test(line.trim())) break;
      extraLines.push(line);
    }
    return [inlineContent, ...extraLines].join('\n').trim() || null;
  }
  const levelMatch = startLine.match(/^(#+)/);
  const level = levelMatch ? levelMatch[1].length : 3;
  const stopRegex = new RegExp(`^#{1,${level}}\\s`);
  const end = lines.findIndex((line, index) => index > start && stopRegex.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim() || null;
}

export function extractBugReport(content: string | null | undefined): string | null {
  if (!content) return null;
  const loi = extractBugSection(content, 'lỗi');
  const nguyenNhan = extractBugSection(content, 'nguyên nhân');
  const cachSua = extractBugSection(content, 'cách sửa');
  const kiemTra = extractBugSection(content, 'kiểm tra');

  if (!loi && !nguyenNhan && !cachSua && !kiemTra) return null;

  const parts: string[] = [];
  if (loi) parts.push(`#### Lỗi\n${loi}`);
  if (nguyenNhan) parts.push(`#### Nguyên nhân\n${nguyenNhan}`);
  if (cachSua) parts.push(`#### Cách sửa\n${cachSua}`);
  if (kiemTra) parts.push(`#### Kiểm tra\n${kiemTra}`);
  return parts.join('\n\n');
}

function sourceFor(config: AgentHubConfig, sourceId: string): OpenProjectSource | undefined {
  return config.integrations.openproject.sources.find((source) => source.id === sourceId);
}

function splitConfig(source: OpenProjectSource): NonNullable<OpenProjectSource['split']> {
  return source.split || { typeIds: [], keyword: '[chia]', workerMayRequest: true, maxParts: 5, createChildTickets: true };
}

function defaultGit(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => execFile('git', args, { cwd, timeout: 120_000 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : 1) : 0, output: `${stdout || ''}${stderr || ''}` });
  }));
}

export class OpenProjectWritebackService {
  private readonly config: AgentHubConfig;
  private readonly projectRepo: ProjectRepo;
  private readonly taskRepo: TaskRepo;
  private readonly trackerRepo: TrackerItemRepo;
  private readonly taskService: OpenProjectWritebackServiceOptions['taskService'];
  private readonly batchService: OpenProjectWritebackServiceOptions['batchService'];
  private readonly taskBatchRepo: OpenProjectWritebackServiceOptions['taskBatchRepo'];
  private readonly reviewRepo: OpenProjectWritebackServiceOptions['reviewRepo'];
  private readonly eventBus: OpenProjectWritebackServiceOptions['eventBus'];
  private readonly fetchFn: typeof fetch;
  private readonly git: GitRunner;
  private readonly timerMs: number;
  private readonly now: () => number;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly bound = (type: string, taskId?: string, payload?: unknown) => {
    if (type === 'task.running' || type === 'task.done' || type === 'task.pushed' || type === 'task.merged' || type === 'task.blocked') void this.handleTaskEvent(type, taskId, payload);
    if (type === 'batch.dispatched') void this.handleBatchDispatched(payload);
    if (type === 'batch.discarded') void this.handleBatchDiscarded(payload);
    if (type === 'deploy.succeeded' || type === 'gitea.sync.succeeded') void this.handlePushEvent(type, payload);
  };
  private started = false;
  private warnedNoPush = new Set<string>();

  constructor(options: OpenProjectWritebackServiceOptions) {
    this.config = options.config;
    this.projectRepo = options.projectRepo;
    this.taskRepo = options.taskRepo;
    this.trackerRepo = options.trackerRepo;
    this.taskService = options.taskService;
    this.batchService = options.batchService;
    this.taskBatchRepo = options.taskBatchRepo;
    this.reviewRepo = options.reviewRepo;
    this.eventBus = options.eventBus;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.git = options.git || defaultGit;
    this.timerMs = options.timerMs || 60_000;
    this.now = options.now || (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.eventBus.on('*', this.bound);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.eventBus.off('*', this.bound);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.retryAttempts.clear();
    this.queues.clear();
  }

  private async handleTaskEvent(type: string, taskId?: string, payload?: unknown): Promise<void> {
    if (!taskId) return;
    const task = this.taskRepo.get(taskId);
    if (!task?.externalRef) return;
    const matches = this.trackerRepo.listAll().filter((row) => parseIds(row).includes(taskId) || row.display_id === task.externalRef);
    for (const row of matches) await this.enqueue(row, async () => {
      const source = sourceFor(this.config, row.source_id);
      if (type === 'task.running') {
        if (source?.inProgressStatusId !== null && source?.inProgressStatusId !== undefined) {
          const key = readOpenProjectKey(this.config.hubHome, row.source_id);
          if (!key) return;
          try {
            await new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn }).setStatus(row.wp_id, source.inProgressStatusId);
          } catch (error) { await this.handleError(row, error, 'start writeback'); }
        }
        return;
      }
      const isPlanTask = task.slug.endsWith('-plan');
      const report = type === 'task.done' ? task.doneReport : task.blockedReport;
      const hasSplit = Boolean(splitSection(report));
      const workerMayRequest = source ? splitConfig(source).workerMayRequest !== false : true;
      if ((type === 'task.done' || type === 'task.blocked') && (isPlanTask || (workerMayRequest && hasSplit))) {
        await this.handleSplitPlanDone(this.latest(row), task, report || '', type === 'task.blocked' ? 'blocked' : 'done');
        return;
      }
      if (type === 'task.done' && isTriageTaskSlug(task.slug)) {
        await this.handleTriageDone(this.latest(row), task);
        return;
      }
      if (type === 'task.done') await this.createLinkedTasks(this.latest(row), task);
      if (type === 'task.merged') {
        const merge = payload && typeof payload === 'object' ? payload as { mergeCommit?: string } : {};
        await this.markMerged(this.latest(row), taskId, merge.mergeCommit);
      }
      if (type === 'task.blocked') await this.requestReview(this.latest(row), task);
      await this.process(this.latest(row));
    });
  }

  private async handleSplitPlanDone(row: TrackerItemRow, task: TaskRow, report: string, sourceKind: 'done' | 'blocked' = 'done'): Promise<void> {
    const source = sourceFor(this.config, row.source_id);
    if (!source || !this.batchService) return;
    const parsed = parseSplitPlan(report, splitConfig(source).maxParts, task.projectId, sourceKind);
    if (!parsed.plan) {
      const feedback = parsed.errors.join('\n');
      const newBody = `${task.body || ''}\n\n## Feedback review\n\n${feedback}`;
      this.taskRepo.update(task.id, {
        body: newBody,
        status: 'queued',
        resume: 1,
        reviewStep: 0,
      });
      this.eventBus.emit('tracker.split_invalid', task.id, { sourceId: row.source_id, displayId: row.display_id, errors: parsed.errors });
      return;
    }
    if (parsed.plan.parts.length === 1) {
      const single = parsed.plan.parts[0];
      const newBody = `Ticket: [${row.display_id}]\n\nKế hoạch chỉ có 1 phần, thực hiện như task thường:\n${single.description || single.title}\n\nYêu cầu: sửa code, chạy test, commit theo quy ước và ghi DONE kèm ## Comment cho tester.`;
      this.taskRepo.update(task.id, {
        body: newBody,
        status: 'queued',
        resume: 1,
        reviewStep: 0,
      });
      this.eventBus.emit('tracker.split_single_task', task.id, { sourceId: row.source_id, displayId: row.display_id });
      return;
    }
    const current = parseState(row);
    if (current.split?.children?.length) return;
    const prefix = `op-${row.display_id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const reviews = this.reviewRepo?.getByTask(task.id) || [];
    const reviewSummary = reviews.map((r, i) => `Vòng ${i + 1} (${r.actor || 'reviewer'}, ${r.verdict}): ${r.feedback || ''}`).join('\n\n');
    const batch = this.batchService.createBatch({
      project: task.projectId,
      title: `[${row.display_id}] ${task.title}`,
      goal: JSON.stringify({
        kind: 'openproject-split',
        sourceId: row.source_id,
        wpId: row.wp_id,
        displayId: row.display_id,
        plan: parsed.plan,
        planTaskId: task.id,
        reviewSummary: reviewSummary || undefined,
        ticketUrl: `${source.url.replace(/\/+$/, '')}/work_packages/${row.wp_id}`,
      }),
      createdBy: 'openproject-split',
      dispatch: false,
      tasks: parsed.plan.parts.map((part) => {
        const partProject = this.projectRepo.get(part.project) ? part.project : task.projectId;
        return {
          project: partProject,
          slug: `${prefix}-${part.index}`,
          title: `[${row.display_id}] ${part.title}`,
          level: part.level,
          dependsOn: part.dependsOn.map((dep) => {
            const depPart = parsed.plan?.parts.find((p) => p.index === dep);
            const depProject = depPart && this.projectRepo.get(depPart.project) ? depPart.project : task.projectId;
            return `${depProject}/${prefix}-${dep}`;
          }),
          body: `Ticket cha: [${row.display_id}]\n\n${part.description}\n\nĐọc context ticket cha trong .agenthub/context/ticket/. Khi xong ghi ## Comment cho tester trong DONE; khi bị chặn ghi ## Cần quyết định trong BLOCKED.`,
        };
      }),
    });
    const children = batch.tasks.map((item) => item.id);
    for (const child of children) this.taskRepo.update(child, { externalRef: row.display_id });
    current.split = { planTaskId: task.id, children, plan: parsed.plan };
    this.save(row, current, [...new Set([...parseIds(row), ...children])]);
    this.eventBus.emit('tracker.split_planned', task.id, { sourceId: row.source_id, displayId: row.display_id, batchId: batch.id, taskIds: children });
    if (source.autoStart) this.batchService.dispatchBatch?.(batch.id);
  }

  private async handleBatchDispatched(payload: unknown): Promise<void> {
    const batchId = payload && typeof payload === 'object' && typeof (payload as { batchId?: unknown }).batchId === 'string'
      ? (payload as { batchId: string }).batchId : undefined;
    if (!batchId || !this.taskBatchRepo) return;
    const batch = this.taskBatchRepo.get(batchId);
    if (!batch?.goal) return;
    let meta: { kind?: string; sourceId: string; wpId: number; displayId: string; plan?: SplitPlan; planTaskId?: string };
    try { meta = JSON.parse(batch.goal); } catch { return; }
    if (meta.kind !== 'openproject-split' || !meta.plan) return;
    const source = sourceFor(this.config, meta.sourceId);
    const key = source && readOpenProjectKey(this.config.hubHome, source.id);
    const parent = source && this.trackerRepo.get(meta.sourceId, meta.wpId);
    if (!source || !key || !parent) return;
    const state = parseState(parent);
    const splitConf = splitConfig(source);

    if (!splitConf.createChildTickets) {
      if (!state.split?.planCommented) {
        const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
        await client.addComment(meta.wpId, `**[AgentHub] Kế hoạch**\n${meta.plan.parts.map((part) => `- ${part.title}`).join('\n')}`);
        state.split = { ...(state.split || {}), planTaskId: meta.planTaskId, plan: meta.plan, planCommented: true };
        this.save(parent, state);
      }
      return;
    }

    const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
    const childTickets: Record<string, { id: number; displayId: string; url: string }> = {
      ...(state.split?.childTickets || {}),
    };
    const parentTasks = parseIds(parent).map((id) => this.taskRepo.get(id)).filter((item): item is TaskRow => Boolean(item));
    try {
      for (const part of meta.plan.parts) {
        const task = parentTasks.find((item) => item.slug.endsWith(`-${part.index}`));
        if (!task) continue;
        if (childTickets[task.id]) continue;

        const created = await client.createWorkPackage({
          subject: `[${meta.displayId}] ${part.title}`,
          descriptionMarkdown: part.description,
          typeId: source.createTypeId ?? undefined,
          parentId: meta.wpId,
          assigneeMe: true,
          statusId: source.createStatusId ?? undefined,
        });
        childTickets[task.id] = created;
        this.taskRepo.update(task.id, { externalRef: created.displayId });
        this.trackerRepo.upsert({
          source_id: source.id,
          wp_id: created.id,
          display_id: created.displayId,
          status_id: null,
          updated_at: new Date(this.now()).toISOString(),
          last_comment_id: null,
          task_ids: JSON.stringify([task.id]),
          writeback: '{}',
        });
        state.split = {
          ...(state.split || {}),
          planTaskId: meta.planTaskId,
          plan: meta.plan,
          childTickets,
          children: Object.keys(childTickets),
        };
        this.save(parent, state);
      }
      if (!state.split?.planCommented) {
        const links = Object.values(childTickets).map((ticket) => `- [${ticket.displayId}](${ticket.url})`).join('\n');
        await client.addComment(
          meta.wpId,
          `**[AgentHub] Kế hoạch**\n${meta.plan.parts.map((part) => `- ${part.title}`).join('\n')}${links ? `\n\nTicket con:\n${links}` : ''}`
        );
        state.split = { ...(state.split || {}), planCommented: true };
        this.save(parent, state);
      }
    } catch (error) {
      await this.handleError(parent, error, 'split child ticket creation');
    }
  }

  private async handleBatchDiscarded(payload: unknown): Promise<void> {
    const batchId = payload && typeof payload === 'object' && typeof (payload as { batchId?: unknown }).batchId === 'string'
      ? (payload as { batchId: string }).batchId : undefined;
    if (!batchId || !this.taskBatchRepo) return;
    const batch = this.taskBatchRepo.get(batchId);
    if (!batch?.goal) return;
    let meta: { kind?: string; sourceId: string; wpId: number; displayId: string };
    try { meta = JSON.parse(batch.goal); } catch { return; }
    if (meta.kind !== 'openproject-split') return;
    const source = sourceFor(this.config, meta.sourceId);
    const key = source && readOpenProjectKey(this.config.hubHome, source.id);
    const parent = source && this.trackerRepo.get(meta.sourceId, meta.wpId);
    if (!source || !key || !parent) return;
    const state = parseState(parent);
    if (state.split?.planCommented) {
      try {
        const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
        await client.addComment(meta.wpId, '**[AgentHub] Huỷ kế hoạch**');
        state.split.planCommented = false;
        state.split.planDiscarded = true;
        this.save(parent, state);
        this.eventBus.emit('tracker.split_discarded', undefined, { sourceId: meta.sourceId, displayId: meta.displayId });
      } catch (error) {
        await this.handleError(parent, error, 'split plan discard comment');
      }
    }
  }

  private async handleTriageDone(row: TrackerItemRow, task: TaskRow): Promise<void> {
    const parsed = parseTriageAnalysis(task.doneReport || '');
    if (!parsed.analysis) {
      this.trackerRepo.upsert({ ...row, writeback: JSON.stringify({ ...parseState(row), triageInvalid: parsed.errors }) });
      this.eventBus.emit('tracker.triage_invalid', task.id, { sourceId: row.source_id, displayId: row.display_id, errors: parsed.errors });
      return;
    }
    const state = parseState(row);
    state.triage = { taskId: task.id, analysis: parsed.analysis, readyAt: new Date(this.now()).toISOString() };
    this.save(row, state);
    const autoDispatch = sourceFor(this.config, row.source_id)?.triage === 'auto' && shouldAutoDispatch(parsed.analysis);
    this.eventBus.emit('tracker.triage_ready', task.id, {
      sourceId: row.source_id, wpId: row.wp_id, displayId: row.display_id, taskId: task.id,
      ticketUrl: `${sourceFor(this.config, row.source_id)?.url.replace(/\/+$/, '') || ''}/work_packages/${row.wp_id}`,
      analysis: parsed.analysis, auto: sourceFor(this.config, row.source_id)?.triage === 'auto', autoDispatch,
    });
    if (autoDispatch) await this.decideNow(this.latest(row), 'do', undefined, 'auto');
  }

  async decide(row: TrackerItemRow, action: 'do' | 'split' | 'ask' | 'skip' | 'manual', note?: string, by = 'user'): Promise<{ action: string; taskIds: string[] }> {
    return this.enqueue(row, async () => { await this.decideNow(this.latest(row), action, note, by); }).then(() => {
      const latest = this.latest(row);
      const state = parseState(latest);
      return { action: state.decision?.action || action, taskIds: parseIds(latest) };
    });
  }

  async submitTriageInput(row: TrackerItemRow, content: string): Promise<{ taskId: string }> {
    let createdTaskId = '';
    return this.enqueue(row, async () => {
      const current = this.latest(row);
      const state = parseState(current);
      if (state.decision?.action !== 'ask') throw new Error('Ticket chưa ở trạng thái chờ thông tin tester');
      const source = sourceFor(this.config, current.source_id);
      const primary = source && this.projectRepo.getAll().find((project) => {
        const settings = projectSettings(project).openproject;
        return settings.enabled && settings.role === 'primary' && settings.sourceId === current.source_id;
      });
      if (!source || !primary) throw new Error('Không tìm thấy project primary của nguồn OpenProject');
      const dir = path.join(this.config.hubHome, 'tracker', current.source_id, String(current.wp_id));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const n = fs.readdirSync(dir).filter((name) => /^user-input-\d+\.md$/.test(name)).length + 1;
      fs.writeFileSync(path.join(dir, `user-input-${n}.md`), content, { mode: 0o600 });
      const base = `op-${current.display_id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-triage-r${n}`;
      const task = this.taskService.createTask({ project: primary.id, slug: base, title: `[${current.display_id}] Phân tích bổ sung`, level: 'easy', modelChain: source.triageModelChain, externalRef: current.display_id, start: true, body: `Đọc lại ticket và file .agenthub/context/ticket/user-input-${n}.md. Không sửa code, không commit. Ghi DONE có ## Phân tích đúng định dạng.` });
      createdTaskId = task.id;
      delete state.decision;
      state.triage = undefined;
      this.save(current, state, [...new Set([...parseIds(current), task.id])]);
      this.eventBus.emit('tracker.triage_started', task.id, { sourceId: current.source_id, wpId: current.wp_id, displayId: current.display_id, revision: n });
    }).then(() => ({ taskId: createdTaskId }));
  }

  private async decideNow(row: TrackerItemRow, action: 'do' | 'split' | 'ask' | 'skip' | 'manual', note?: string, by = 'user'): Promise<{ action: string; taskIds: string[] }> {
    row = this.latest(row);
    const state = parseState(row);
    if (state.decision) return { action: state.decision.action, taskIds: parseIds(row) };
    const source = sourceFor(this.config, row.source_id);
    const triage = state.triage?.analysis;
    if (!source || !triage) throw new Error('Ticket chưa có phân tích triage hợp lệ');
    const at = new Date(this.now()).toISOString();
    const decision = { action, by, at, note } as WritebackState['decision'];
    if (action === 'ask') {
      const key = readOpenProjectKey(this.config.hubHome, source.id);
      if (!key) throw new Error('Nguồn OpenProject chưa có API key');
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
      await client.addComment(row.wp_id, `**[AgentHub] Cần thêm thông tin**\n${triage.questions}${note ? `\n\n${note}` : ''}`);
      if (source.feedbackStatusId !== null) await client.setStatus(row.wp_id, source.feedbackStatusId);
      state.decision = decision;
      this.save(row, state);
      return { action, taskIds: parseIds(row) };
    }
    if (action === 'skip' || action === 'manual') {
      if (note && action === 'skip') {
        const key = readOpenProjectKey(this.config.hubHome, source.id);
        if (key) await new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn }).addComment(row.wp_id, `**[AgentHub] Không xử lý**: ${note}`);
      }
      state.decision = decision;
      this.save(row, state);
      return { action, taskIds: parseIds(row) };
    }
    if (action === 'split') {
      const primary = this.projectRepo.getAll().find((project) => {
        const settings = projectSettings(project).openproject;
        return settings.enabled && settings.role === 'primary' && settings.sourceId === row.source_id;
      });
      if (!primary) throw new Error('Không tìm thấy project primary của nguồn OpenProject');
      const base = `op-${row.display_id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-plan`;
      let slug = base;
      let n = 1;
      while (this.taskRepo.get(`${primary.id}/${slug}`)) slug = `${base}-r${++n}`;
      const planTask = this.taskService.createTask({
        project: primary.id, slug, title: `[${row.display_id}] Lập kế hoạch chia việc`, level: 'hard',
        externalRef: row.display_id, start: source.autoStart,
        body: `Ticket: [${row.display_id}]\n\nKhông sửa code, không commit. Dùng toàn bộ phân tích triage dưới đây làm context và ghi DONE có ## Chia việc theo src/protocol.md. Tối đa ${splitConfig(source).maxParts} phần, tối thiểu 2.\n\n${startSplit(triage, primary.id, note)}`,
      });
      state.decision = decision;
      state.split = { planTaskId: planTask.id };
      this.save(row, state, [...new Set([...parseIds(row), planTask.id])]);
      this.eventBus.emit('tracker.split_plan_started', planTask.id, { sourceId: row.source_id, displayId: row.display_id, taskId: planTask.id });
      return { action, taskIds: [planTask.id] };
    }
    const projects = this.projectRepo.getAll().filter((project) => {
      const settings = projectSettings(project).openproject;
      return settings.enabled && settings.sourceId === row.source_id;
    });
    const primary = projects.find((project) => projectSettings(project).openproject.role === 'primary');
    if (!primary) throw new Error('Không tìm thấy project primary của nguồn OpenProject');
    const base = `op-${row.display_id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const multiRepo = projects.length > 1;
    const taskIds: string[] = [];
    let providerTaskId: string | undefined;
    for (const project of projects) {
      const suffix = multiRepo ? `-${project.id}` : '';
      const baseSlug = `${base}${suffix}`;
      let slug = baseSlug;
      let n = 1;
      while (this.taskRepo.get(`${project.id}/${slug}`)) slug = `${baseSlug}-${++n}`;
      const dependsOn = providerTaskId && /api|hợp đồng|contract/i.test(triage.perRepo || '') ? [providerTaskId] : undefined;
      const task = this.taskService.createTask({
        project: project.id, slug, title: `[${row.display_id}] ${triage.summary.slice(0, 100)}`,
        body: startSplit(triage, project.id, note),
        level: triage.size === 'lớn' || triage.size === 'lớn (cần chia)' ? 'hard' : 'easy', externalRef: row.display_id,
        dependsOn, start: source.autoStart,
      });
      taskIds.push(task.id);
      if (/api|hợp đồng|contract/i.test(triage.perRepo || '') && project.id === primary.id) providerTaskId = task.id;
    }
    state.decision = decision;
    this.save(row, state, [...new Set([...parseIds(row), ...taskIds])]);
    this.eventBus.emit('tracker.triage_decided', taskIds[0], { sourceId: row.source_id, displayId: row.display_id, action, taskIds });
    return { action, taskIds };
  }

  private async handlePushEvent(type: string, payload: unknown): Promise<void> {
    const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (type === 'gitea.sync.succeeded' && p.merged !== true) return;
    const projectId = typeof p.projectId === 'string' ? p.projectId : undefined;
    if (!projectId) return;
    for (const row of this.trackerRepo.listAll()) await this.enqueue(row, () => this.process(this.latest(row), projectId));
  }

  private latest(row: TrackerItemRow): TrackerItemRow {
    return this.trackerRepo.get(row.source_id, row.wp_id) || row;
  }

  private enqueue(row: TrackerItemRow, work: () => Promise<void>): Promise<void> {
    const key = `${row.source_id}:${row.wp_id}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work).catch((error) => {
      console.error(`[openproject-writeback] ${key}: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }));
    return next;
  }

  private async markMerged(row: TrackerItemRow, taskId: string, commit?: string): Promise<void> {
    row = this.latest(row);
    const state = parseState(row);
    state.merged = { ...(state.merged || {}), [taskId]: commit || 'merged' };
    if (state.reviewRequested) {
      delete state.reviewRequested[taskId];
      if (Object.keys(state.reviewRequested).length === 0) delete state.reviewRequested;
    }
    this.save(row, state);
  }

  private save(row: TrackerItemRow, state: WritebackState, taskIds = parseIds(row)): void {
    this.trackerRepo.upsert({ ...row, task_ids: JSON.stringify(taskIds), writeback: JSON.stringify(state) });
  }

  private async createLinkedTasks(row: TrackerItemRow, task: TaskRow): Promise<void> {
    const content = section(task.doneReport, `## Cần sửa ở project`);
    if (!content) return;
    const match = (task.doneReport || '').match(/^## Cần sửa ở project\s+([^\s]+)\s*$/mi);
    const projectId = match?.[1];
    if (!projectId) return;
    const target = this.projectRepo.get(projectId);
    const source = sourceFor(this.config, row.source_id);
    const settings = target ? projectSettings(target) : undefined;
    const state = parseState(row);
    if (state.linked?.[projectId]) return;
    if (!target || !settings?.openproject.enabled || settings.openproject.sourceId !== row.source_id || !source) {
      this.eventBus.emit('tracker.writeback_failed', undefined, { sourceId: row.source_id, displayId: row.display_id, error: `Project liên kết không hợp lệ: ${projectId}`, permanent: true });
      return;
    }
    try {
      const subject = `[${row.display_id}] Cần sửa ở ${projectId}`;
      const body = `Ticket liên kết: [${row.display_id}]\n\n${content}`;
      const slugBase = `op-${row.display_id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.replace(/-+$/g, '');
      let slug = slugBase || 'op-linked';
      let n = 1;
      while (this.taskRepo.get(`${projectId}/${slug}`)) slug = `${slugBase}-${++n}`;
      const linked = this.taskService.createTask({ project: projectId, slug, title: subject, body, level: 'easy', externalRef: task.externalRef, dependsOn: [task.id], start: false });
      state.linked = { ...(state.linked || {}), [projectId]: linked.id };
      this.save(row, state, [...new Set([...parseIds(row), linked.id])]);
    } catch (error) {
      await this.handleError(row, error, 'linked task creation');
    }
  }

  private async requestReview(row: TrackerItemRow, task: TaskRow): Promise<void> {
    row = this.latest(row);
    const state = parseState(row);
    if (state.split?.children?.includes(task.id)) return;
    const content = section(task.blockedReport, '## Cần quyết định');
    if (!content) return;
    if (state.reviewRequested?.[task.id] === content) return;
    const source = sourceFor(this.config, row.source_id);
    const key = source && readOpenProjectKey(this.config.hubHome, source.id);
    if (!source || !key) return;
    try {
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
      await client.addComment(row.wp_id, `**[Cần duyệt]**\n${content}`);
      if (source.reviewStatusId !== null) await client.setStatus(row.wp_id, source.reviewStatusId);
      state.reviewRequested = { ...(state.reviewRequested || {}), [task.id]: content };
      this.save(row, state);
      this.eventBus.emit('tracker.review_requested', task.id, { sourceId: row.source_id, displayId: row.display_id });
    } catch (error) { await this.handleError(row, error, 'review request'); }
  }

  private hasPush(projectId: string): { remote: string; ref: string } | null {
    const deploy = this.config.deploy?.[projectId]?.push;
    if (deploy) return { remote: deploy.remote, ref: deploy.to };
    const project = this.projectRepo.get(projectId);
    const gitea = project ? projectSettings(project).gitea : undefined;
    return gitea?.enabled && gitea.targetBranch ? { remote: 'origin', ref: gitea.targetBranch } : null;
  }

  private async pushed(project: ProjectRow, commit: string, push: { remote: string; ref: string }): Promise<boolean> {
    const fetched = await this.git(project.path, ['fetch', push.remote]);
    if (fetched.code !== 0) throw new Error(`fetch failed: ${fetched.output}`);
    const result = await this.git(project.path, ['merge-base', '--is-ancestor', commit, `refs/remotes/${push.remote}/${push.ref}`]);
    return result.code === 0;
  }

  private async process(row: TrackerItemRow, changedProjectId?: string): Promise<void> {
    row = this.latest(row);
    const source = sourceFor(this.config, row.source_id);
    const ids = parseIds(row);
    const state = parseState(row);
    if (!source || state.resolved) return;
    if (changedProjectId && !ids.some((id) => id.startsWith(`${changedProjectId}/`))) return;
    const effectiveIds = state.split?.children?.length ? state.split.children : ids;
    const tasks = effectiveIds.map((id) => this.taskRepo.get(id)).filter((task): task is TaskRow => task !== undefined && !isTriageTaskSlug(task.slug) && !task.slug.endsWith('-plan'));
    for (const task of tasks) {
      if (task.doneReport && !state.linked?.[task.projectId]) await this.createLinkedTasks(this.latest(row), task);
    }
    row = this.latest(row);
    const currentState = parseState(row);
    if (tasks.length === 0 || !tasks.every((task) => currentState.merged?.[task.id])) return;
    const comments = tasks.map((task) => {
      const comment = section(task.doneReport, '## Comment cho tester');
      const bugReport = extractBugReport(task.doneReport);
      const text = bugReport
        ? (comment ? `${bugReport}\n\n${comment}` : bugReport)
        : comment;
      const analysis = parseState(row).triage?.analysis;
      return {
        task,
        text: text ? `${text}${analysis?.manualAlongside ? `\n\nCần thao tác thủ công kèm theo: ${analysis.manualAlongside}` : ''}` : null,
      };
    }).filter((item): item is { task: TaskRow; text: string } => Boolean(item.text));
    const push = tasks.map((task) => this.hasPush(task.projectId));
    for (let i = 0; i < tasks.length; i++) {
      if (!push[i]) {
        if (!currentState.pushWarning) { console.warn(`[openproject-writeback] ${row.display_id}: project không cấu hình push`); currentState.pushWarning = true; this.save(row, currentState); }
        continue;
      }
      const project = this.projectRepo.get(tasks[i].projectId);
      const commit = currentState.merged?.[tasks[i].id];
      if (!project || !commit || commit === 'merged' || !(await this.pushed(project, commit, push[i]!))) return;
    }
    const key = readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) return this.retry(row, new Error('Nguồn OpenProject chưa có API key'));
    try {
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
      if (!currentState.commented) {
        const commentList = comments.map(({ task: childTask, text }) => {
          const childTicket = currentState.split?.childTickets?.[childTask.id];
          const heading = childTicket ? `[${childTicket.displayId}] ${childTask.title}` : (childTask.title || childTask.id);
          return `### ${heading}\n${text}`;
        }).join('\n\n');
        await client.addComment(row.wp_id, `**[AgentHub] Đã sửa**\n${commentList}`);
        currentState.commented = true;
      }
      if (source.autoResolve && source.resolvedStatusId !== null && !currentState.resolved) {
        await client.setStatus(row.wp_id, source.resolvedStatusId);
        currentState.resolved = true;
        this.eventBus.emit('tracker.resolved', tasks[0].id, { sourceId: row.source_id, displayId: row.display_id });
      }
      this.save(this.latest(row), currentState);
    } catch (error) { await this.handleError(row, error, 'resolve writeback'); }
  }

  private retry(row: TrackerItemRow, error: unknown): void {
    const key = `${row.source_id}:${row.wp_id}`;
    if (this.retryTimers.has(key)) return;
    const attempt = this.retryAttempts.get(key) || 0;
    this.retryAttempts.set(key, attempt + 1);
    const delay = Math.min(this.timerMs * (2 ** attempt), 30 * 60_000);
    const timer = setTimeout(() => {
      this.retryTimers.delete(key);
      void this.enqueue(row, () => this.process(this.latest(row)));
    }, delay);
    timer.unref?.();
    this.retryTimers.set(key, timer);
    console.warn(`[openproject-writeback] retry ${key} in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async handleError(row: TrackerItemRow, error: unknown, operation: string): Promise<void> {
    if (error instanceof OpenProjectError && error.status >= 500 || !(error instanceof OpenProjectError)) return this.retry(row, error);
    const state = parseState(row);
    state.failed = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    this.save(row, state);
    this.eventBus.emit('tracker.writeback_failed', undefined, { sourceId: row.source_id, displayId: row.display_id, error: state.failed });
  }
}
