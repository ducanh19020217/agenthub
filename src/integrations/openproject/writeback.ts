import { execFile } from 'node:child_process';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import type { EventBus } from '../../scheduler/index.js';
import { projectSettings } from '../../projects/settings.js';
import type { ProjectRepo, ProjectRow, TaskRepo, TaskRow, TrackerItemRepo, TrackerItemRow } from '../../db/index.js';
import { OpenProjectClient, OpenProjectError } from './client.js';
import { readOpenProjectKey } from './secrets.js';

type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>;
type WritebackState = {
  linked?: Record<string, string>;
  merged?: Record<string, string>;
  commented?: boolean;
  resolved?: boolean;
  reviewRequested?: boolean;
  pushWarning?: boolean;
  failed?: string;
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
  }

  private async handleTaskEvent(type: string, taskId?: string, payload?: unknown): Promise<void> {
    if (!taskId) return;
    const task = this.taskRepo.get(taskId);
    if (!task?.externalRef) return;
    const matches = this.trackerRepo.listAll().filter((row) => row.display_id === task.externalRef && parseIds(row).includes(taskId));
    for (const row of matches) {
      if (type === 'task.done') await this.createLinkedTasks(row, task);
      if (type === 'task.merged') {
        const merge = payload && typeof payload === 'object' ? payload as { mergeCommit?: string } : {};
        await this.markMerged(row, taskId, merge.mergeCommit);
      }
      if (type === 'task.blocked') await this.requestReview(row, task);
      await this.process(row);
    }
  }

  private async handlePushEvent(type: string, payload: unknown): Promise<void> {
    const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (type === 'gitea.sync.succeeded' && p.merged !== true) return;
    const projectId = typeof p.projectId === 'string' ? p.projectId : undefined;
    if (!projectId) return;
    for (const row of this.trackerRepo.listAll()) await this.process(row, projectId);
  }

  private async markMerged(row: TrackerItemRow, taskId: string, commit?: string): Promise<void> {
    const state = parseState(row);
    state.merged = { ...(state.merged || {}), [taskId]: commit || 'merged' };
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
      this.eventBus.emit('tracker.writeback_failed', task.id, { sourceId: row.source_id, displayId: row.display_id, error: `Project liên kết không hợp lệ: ${projectId}`, permanent: true });
      return;
    }
    const key = readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) return this.retry(row, new Error('Nguồn OpenProject chưa có API key'));
    try {
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
      const subject = `[${row.display_id}] Cần sửa ở ${projectId}`;
      const body = `Ticket liên kết: [${row.display_id}]\n\n${content}`;
      await client.createWorkPackage({ project: source.project, subject, description: body });
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
    const state = parseState(row);
    if (state.reviewRequested) return;
    const content = section(task.blockedReport, '## Cần quyết định');
    if (!content) return;
    const source = sourceFor(this.config, row.source_id);
    const key = source && readOpenProjectKey(this.config.hubHome, source.id);
    if (!source || !key) return;
    try {
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
      await client.addComment(row.wp_id, `**[Cần duyệt]**\n${content}`);
      if (source.reviewStatusId !== null) await client.setStatus(row.wp_id, source.reviewStatusId);
      state.reviewRequested = true;
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
    const source = sourceFor(this.config, row.source_id);
    const ids = parseIds(row);
    const state = parseState(row);
    if (!source || state.resolved || state.reviewRequested) return;
    if (changedProjectId && !ids.some((id) => id.startsWith(`${changedProjectId}/`))) return;
    const tasks = ids.map((id) => this.taskRepo.get(id)).filter((task): task is TaskRow => Boolean(task));
    if (tasks.length === 0 || !tasks.every((task) => state.merged?.[task.id])) return;
    const comments = tasks.map((task) => section(task.doneReport, '## Comment cho tester')).filter(Boolean) as string[];
    const push = tasks.map((task) => this.hasPush(task.projectId));
    for (let i = 0; i < tasks.length; i++) {
      if (!push[i]) {
        if (!state.pushWarning) { console.warn(`[openproject-writeback] ${row.display_id}: project không cấu hình push`); state.pushWarning = true; this.save(row, state); }
        continue;
      }
      const project = this.projectRepo.get(tasks[i].projectId);
      const commit = state.merged?.[tasks[i].id];
      if (!project || !commit || commit === 'merged' || !(await this.pushed(project, commit, push[i]!))) return;
    }
    const key = readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) return this.retry(row, new Error('Nguồn OpenProject chưa có API key'));
    try {
      const client = new OpenProjectClient({ baseUrl: source.url, project: source.project, apiKey: key, fetch: this.fetchFn });
      if (!state.commented) {
        await client.addComment(row.wp_id, `**[AgentHub] Đã sửa**\n${comments.map((text, i) => `### ${tasks[i].id}\n${text}`).join('\n\n')}`);
        state.commented = true;
      }
      if (source.autoResolve && source.resolvedStatusId !== null && !state.resolved) {
        await client.setStatus(row.wp_id, source.resolvedStatusId);
        state.resolved = true;
        this.eventBus.emit('tracker.resolved', tasks[0].id, { sourceId: row.source_id, displayId: row.display_id });
      }
      this.save(row, state);
    } catch (error) { await this.handleError(row, error, 'resolve writeback'); }
  }

  private retry(row: TrackerItemRow, error: unknown): void {
    const key = `${row.source_id}:${row.wp_id}`;
    if (this.retryTimers.has(key)) return;
    const timer = setTimeout(() => { this.retryTimers.delete(key); void this.process(row); }, this.timerMs);
    timer.unref?.();
    this.retryTimers.set(key, timer);
    console.warn(`[openproject-writeback] retry ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async handleError(row: TrackerItemRow, error: unknown, operation: string): Promise<void> {
    if (error instanceof OpenProjectError && error.status >= 500 || !(error instanceof OpenProjectError)) return this.retry(row, error);
    const state = parseState(row);
    state.failed = `${operation}: ${error instanceof Error ? error.message : String(error)}`;
    this.save(row, state);
    this.eventBus.emit('tracker.writeback_failed', undefined, { sourceId: row.source_id, displayId: row.display_id, error: state.failed });
  }
}
