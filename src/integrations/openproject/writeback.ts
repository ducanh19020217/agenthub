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
};

export interface OpenProjectWritebackServiceOptions {
  config: AgentHubConfig;
  projectRepo: ProjectRepo;
  taskRepo: TaskRepo;
  trackerRepo: TrackerItemRepo;
  taskService: { createTask(raw: unknown): { id: string } };
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

function sourceFor(config: AgentHubConfig, sourceId: string): OpenProjectSource | undefined {
  return config.integrations.openproject.sources.find((source) => source.id === sourceId);
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
  private readonly eventBus: OpenProjectWritebackServiceOptions['eventBus'];
  private readonly fetchFn: typeof fetch;
  private readonly git: GitRunner;
  private readonly timerMs: number;
  private readonly now: () => number;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly bound = (type: string, taskId?: string, payload?: unknown) => {
    if (type === 'task.done' || type === 'task.merged' || type === 'task.blocked') void this.handleTaskEvent(type, taskId, payload);
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
    const matches = this.trackerRepo.listAll().filter((row) => row.display_id === task.externalRef && parseIds(row).includes(taskId));
    for (const row of matches) await this.enqueue(row, async () => {
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
        level: triage.size === 'lớn' || triage.size === 'lớn (cần chia)' || action === 'split' ? 'hard' : 'easy', externalRef: row.display_id,
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
    const tasks = ids.map((id) => this.taskRepo.get(id)).filter((task): task is TaskRow => task !== undefined && !isTriageTaskSlug(task.slug));
    for (const task of tasks) {
      if (task.doneReport && !state.linked?.[task.projectId]) await this.createLinkedTasks(this.latest(row), task);
    }
    row = this.latest(row);
    const currentState = parseState(row);
    if (tasks.length === 0 || !tasks.every((task) => currentState.merged?.[task.id])) return;
    const comments = tasks.map((task) => {
      const comment = section(task.doneReport, '## Comment cho tester');
      const analysis = parseState(row).triage?.analysis;
      return comment ? `${comment}${analysis?.manualAlongside ? `\n\nCần thao tác thủ công kèm theo: ${analysis.manualAlongside}` : ''}` : null;
    }).filter(Boolean) as string[];
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
        await client.addComment(row.wp_id, `**[AgentHub] Đã sửa**\n${comments.map((text, i) => `### ${tasks[i].id}\n${text}`).join('\n\n')}`);
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
