import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentHubConfig, DeployProjectConfig } from './config.js';
import { ProjectRepo, ProjectRow } from './db/index.js';
import { EventBus } from './scheduler/index.js';
import { ensureIntegrationNodeModules, ensureIntegrationWorktree } from './projects/integration.js';
import { ensureWorktreeNodeModules } from './cache.js';
import { projectSettings } from './projects/settings.js';
import { runInProcessGroup } from './priority.js';

export interface DeployStatus {
  projectId: string;
  status: 'queued' | 'running' | 'restarting' | 'succeeded' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  commit?: string;
  error?: string;
  logPath?: string;
  pushStatus?: string;
  lastPushedAt?: string;
  nextPushAt?: string;
}

type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>;
type ProcessRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; output: string; timedOut?: boolean }>;
type RestartRunner = (command: string, args: string[]) => { on?: (event: string, listener: (error: Error) => void) => unknown } | void;

export interface RestartGuard {
  snapshot: () => { checks: number; editing: number };
}

const hubPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function formatTime(isoOrDate: string | Date | number): string {
  const date = typeof isoOrDate === 'string' || typeof isoOrDate === 'number' ? new Date(isoOrDate) : isoOrDate;
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

interface ProjectPushState {
  lastPushedAt?: string;
  nextPushAt?: string;
}

interface PendingDeployState {
  commit?: string;
  dueAt: string;
}

export class DeployService {
  private pending = new Map<string, { commit?: string; dueAt: number; timer?: NodeJS.Timeout }>();
  private latest = new Map<string, DeployStatus>();
  private pushStates = new Map<string, ProjectPushState>();
  private deferredPushes = new Map<string, { dueTime: number; timer?: NodeJS.Timeout }>();
  private lastRestartBlockers = new Map<string, string>();
  private stagedWeb = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private config: AgentHubConfig,
    private projectRepo: ProjectRepo,
    private eventBus: EventBus,
    private debounceMs = 60_000,
    private commandRunner: GitRunner = async (cwd, args) => {
      const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_WORKER: undefined };
      if (env.PATH) env.PATH = env.PATH.split(path.delimiter).filter((entry) => !entry.includes(`${path.sep}shims${path.sep}worker`)).join(path.delimiter);
      const result = await runInProcessGroup('git', args, { cwd, env, timeoutMs: 120_000, maxOutput: 1024 * 1024 });
      return { code: result.code ?? 1, output: result.output };
    },
    private processRunner: ProcessRunner = async (command, args, options) => {
      const result = await runInProcessGroup(command, args, options);
      return { code: result.code ?? 1, output: result.output, timedOut: result.timedOut };
    },
    private restartRunner: RestartRunner = (command, args) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      return child;
    },
    private restartGuard?: RestartGuard,
  ) {}

  start(): void {
    this.restoreRestartState();
    this.restorePushState();
    this.restorePendingState();
    this.eventBus.on('task.merged', (_taskId, payload) => {
      const value = (payload && typeof payload === 'object' ? payload : {}) as { projectId?: string; mergeCommit?: string };
      const taskId = _taskId || '';
      const projectId = value.projectId || taskId.split('/')[0];
      if (projectId) this.schedule(projectId, value.mergeCommit);
    });
  }

  stop(): void {
    this.savePendingState();
    this.savePushState();
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
    for (const entry of this.deferredPushes.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.deferredPushes.clear();
  }

  private getPushStatePath(): string {
    return path.join(this.config.hubHome, 'deploy-push-state.json');
  }

  private getPendingStatePath(): string {
    return path.join(this.config.hubHome, 'deploy-pending-state.json');
  }

  private savePendingState(): void {
    const state: Record<string, PendingDeployState> = {};
    for (const [projectId, entry] of this.pending.entries()) {
      state[projectId] = { commit: entry.commit, dueAt: new Date(entry.dueAt).toISOString() };
    }
    try {
      if (Object.keys(state).length === 0) fs.rmSync(this.getPendingStatePath(), { force: true });
      else fs.writeFileSync(this.getPendingStatePath(), JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      console.error('[deploy] Failed to save pending state', err);
    }
  }

  private restorePendingState(): void {
    const statePath = this.getPendingStatePath();
    try {
      if (!fs.existsSync(statePath)) return;
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, PendingDeployState>;
      fs.rmSync(statePath, { force: true });
      for (const [projectId, entry] of Object.entries(data || {})) {
        const dueAt = new Date(entry.dueAt).getTime();
        if (!Number.isFinite(dueAt) || !this.definition(projectId)) continue;
        this.schedulePending(projectId, dueAt, entry.commit);
        this.latest.set(projectId, { projectId, status: 'queued', commit: entry.commit });
      }
    } catch {
      // Malformed pending state must not prevent daemon startup
    }
  }

  private loadPushState(): void {
    const statePath = this.getPushStatePath();
    try {
      if (!fs.existsSync(statePath)) return;
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, ProjectPushState>;
      if (!data || typeof data !== 'object') return;
      for (const [projectId, state] of Object.entries(data)) {
        if (state && typeof state === 'object') {
          this.pushStates.set(projectId, {
            lastPushedAt: typeof state.lastPushedAt === 'string' ? state.lastPushedAt : undefined,
            nextPushAt: typeof state.nextPushAt === 'string' ? state.nextPushAt : undefined,
          });
        }
      }
    } catch {
      // Malformed push state must not prevent daemon startup
    }
  }

  private savePushState(): void {
    const statePath = this.getPushStatePath();
    try {
      const data: Record<string, ProjectPushState> = {};
      for (const [id, state] of this.pushStates.entries()) {
        if (state.lastPushedAt || state.nextPushAt) {
          data[id] = { lastPushedAt: state.lastPushedAt, nextPushAt: state.nextPushAt };
        }
      }
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[deploy] Failed to save push state', err);
    }
  }

  private restorePushState(): void {
    this.loadPushState();
    for (const [projectId, state] of this.pushStates.entries()) {
      this.syncPushStatusToLatest(projectId);
      if (state.nextPushAt) {
        const dueTime = new Date(state.nextPushAt).getTime();
        this.scheduleDeferredPush(projectId, dueTime);
      }
    }
  }

  private formatPushStatus(pushState: ProjectPushState): string | undefined {
    if (pushState.nextPushAt) {
      return `push đang chờ tới ${formatTime(pushState.nextPushAt)}`;
    }
    if (pushState.lastPushedAt) {
      return `push lúc ${formatTime(pushState.lastPushedAt)}`;
    }
    return undefined;
  }

  private syncPushStatusToLatest(projectId: string): void {
    const pushState = this.pushStates.get(projectId);
    if (!pushState) return;
    const existing = this.latest.get(projectId);
    const pushStatus = this.formatPushStatus(pushState);
    if (existing) {
      existing.lastPushedAt = pushState.lastPushedAt;
      existing.nextPushAt = pushState.nextPushAt;
      if (pushStatus) existing.pushStatus = pushStatus;
    } else if (pushStatus) {
      this.latest.set(projectId, {
        projectId,
        status: 'succeeded',
        pushStatus,
        lastPushedAt: pushState.lastPushedAt,
        nextPushAt: pushState.nextPushAt,
      });
    }
  }

  private scheduleDeferredPush(projectId: string, dueTime: number): void {
    const existing = this.deferredPushes.get(projectId);
    if (existing?.timer) clearTimeout(existing.timer);

    const delay = Math.max(0, dueTime - Date.now());
    const entry: { dueTime: number; timer?: NodeJS.Timeout } = { dueTime };
    entry.timer = setTimeout(() => {
      this.deferredPushes.delete(projectId);
      const state = this.pushStates.get(projectId);
      if (state) state.nextPushAt = undefined;
      this.savePushState();
      this.enqueuePush(projectId);
    }, delay);
    entry.timer.unref();
    this.deferredPushes.set(projectId, entry);

    const state = this.pushStates.get(projectId) || {};
    state.nextPushAt = new Date(dueTime).toISOString();
    this.pushStates.set(projectId, state);
    this.savePushState();
    this.syncPushStatusToLatest(projectId);
  }

  private cancelScheduledPush(projectId: string): void {
    const existing = this.deferredPushes.get(projectId);
    if (existing?.timer) clearTimeout(existing.timer);
    this.deferredPushes.delete(projectId);
    const state = this.pushStates.get(projectId);
    if (state) {
      state.nextPushAt = undefined;
      this.savePushState();
      this.syncPushStatusToLatest(projectId);
    }
  }

  private enqueuePush(projectId: string): void {
    this.queue = this.queue
      .then(() => this.executePush(projectId))
      .then(() => undefined)
      .catch((error) => console.error(`[deploy] ${projectId} deferred push failed`, error));
  }

  async executePush(projectId: string): Promise<DeployStatus> {
    const definition = this.definition(projectId);
    const project = this.projectRepo.get(projectId);
    if (!definition?.push || !project) {
      return { projectId, status: 'skipped', error: 'Không có cấu hình deploy push' };
    }
    const worktree = await this.resolveWorktree(project);
    if (!worktree) {
      return { projectId, status: 'skipped', error: 'Không có worktree đích tích hợp được cấu hình' };
    }
    if (!definition.push.ffOnly) throw new Error('push chỉ hỗ trợ ffOnly');

    const logDir = path.join(this.config.logsDir, 'deploy', projectId);
    const logPath = path.join(logDir, `${Date.now()}-push.log`);
    const write = (line: string) => {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
      } catch { /* best effort */ }
    };

    write(`push started project=${projectId}`);
    const pushed = await this.commandRunner(worktree, ['push', definition.push.remote, `${definition.push.from}:refs/heads/${definition.push.to}`]);
    write(`remote push ${definition.push.remote} ${definition.push.from}:refs/heads/${definition.push.to}\n${pushed.output}`);

    if (pushed.code !== 0) {
      const errorMsg = `git push thất bại (exit ${pushed.code})`;
      write(`push failed: ${errorMsg}`);
      const prev = this.latest.get(projectId) || { projectId, status: 'failed' };
      const status: DeployStatus = {
        ...prev,
        status: 'failed',
        error: errorMsg,
        logPath,
      };
      this.latest.set(projectId, status);
      this.eventBus.emit('deploy.failed', undefined, { projectId, logPath, error: errorMsg, level: 'incident' });
      return status;
    }

    const nowIso = new Date().toISOString();
    this.pushStates.set(projectId, { lastPushedAt: nowIso, nextPushAt: undefined });
    this.savePushState();

    const pushMsg = `push lúc ${formatTime(nowIso)}`;
    write(`push succeeded: ${pushMsg}`);
    const prev = this.latest.get(projectId) || { projectId, status: 'succeeded' };
    const status: DeployStatus = {
      ...prev,
      status: prev.status === 'failed' ? 'succeeded' : prev.status,
      pushStatus: pushMsg,
      lastPushedAt: nowIso,
      nextPushAt: undefined,
      logPath: prev.logPath || logPath,
    };
    this.latest.set(projectId, status);
    this.eventBus.emit('deploy.succeeded', undefined, { projectId, logPath, pushStatus: pushMsg });
    return status;
  }

  async pushNow(projectId: string): Promise<DeployStatus> {
    const definition = this.definition(projectId);
    const project = this.projectRepo.get(projectId);
    if (!definition || !project) return { projectId, status: 'skipped', error: 'Không tìm thấy cấu hình deploy' };
    if (!definition.push) return { projectId, status: 'skipped', error: 'Dự án không cấu hình deploy push' };

    this.cancelScheduledPush(projectId);

    let result: DeployStatus | undefined;
    const previous = this.queue;
    this.queue = previous
      .then(async () => {
        result = await this.executePush(projectId);
      })
      .catch((error) => console.error(`[deploy] ${projectId} pushNow failed`, error));
    await this.queue;
    return result || this.getStatus(projectId) || { projectId, status: 'failed' };
  }

  private restoreRestartState(): void {
    const statePath = path.join(this.config.hubHome, 'deploy-restart.json');
    try {
      if (!fs.existsSync(statePath)) return;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { projectId?: string; commit?: string; logPath?: string };
      if (!state.projectId) return;
      fs.rmSync(statePath, { force: true });
      const status: DeployStatus = { projectId: state.projectId, status: 'succeeded', finishedAt: new Date().toISOString(), commit: state.commit, logPath: state.logPath };
      this.latest.set(state.projectId, status);
      this.eventBus.emit('deploy.succeeded', undefined, { projectId: state.projectId, commit: state.commit, logPath: state.logPath, afterRestart: true });
    } catch {
      // A malformed recovery marker must not prevent the daemon from starting.
    }
  }

  private definition(projectId: string): DeployProjectConfig | undefined {
    return this.config.deploy?.[projectId];
  }

  schedule(projectId: string, commit?: string): void {
    const existing = this.pending.get(projectId);
    const dueAt = Date.now() + this.debounceMs;
    this.schedulePending(projectId, dueAt, commit || existing?.commit);
    this.latest.set(projectId, { projectId, status: 'queued' });
    this.savePendingState();
  }

  private schedulePending(projectId: string, dueAt: number, commit?: string): void {
    if (!this.definition(projectId)) return;
    const existing = this.pending.get(projectId);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: { commit?: string; dueAt: number; timer?: NodeJS.Timeout } = { commit: commit || existing?.commit, dueAt };
    entry.timer = setTimeout(() => {
      this.pending.delete(projectId);
      this.savePendingState();
      this.enqueue(projectId, entry.commit);
    }, Math.max(0, dueAt - Date.now()));
    entry.timer.unref();
    this.pending.set(projectId, entry);
  }

  private enqueue(projectId: string, commit?: string): DeployStatus {
    const queued: DeployStatus = { projectId, status: 'queued', commit };
    this.latest.set(projectId, queued);
    this.queue = this.queue
      .then(() => this.execute(projectId, commit))
      .then(() => undefined)
      .catch((error) => console.error(`[deploy] ${projectId} failed outside execute`, error));
    return queued;
  }

  async run(projectId: string, commit?: string): Promise<DeployStatus> {
    let result: DeployStatus | undefined;
    const previous = this.queue;
    this.queue = previous
      .then(async () => { result = await this.execute(projectId, commit); })
      .catch((error) => console.error(`[deploy] ${projectId} failed outside execute`, error));
    await this.queue;
    return result || { projectId, status: 'skipped' };
  }

  private async execute(projectId: string, commit?: string): Promise<DeployStatus> {
    const definition = this.definition(projectId);
    const project = this.projectRepo.get(projectId);
    if (!definition || !project) return { projectId, status: 'skipped' };
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.config.logsDir, 'deploy', projectId);
    const logPath = path.join(logDir, `${Date.now()}.log`);
    const write = (line: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    const status: DeployStatus = { projectId, status: 'running', startedAt, commit, logPath };
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.latest.set(projectId, status);
      this.eventBus.emit('deploy.started', undefined, { projectId, commit, logPath });
      write(`deploy started project=${projectId} commit=${commit || 'unknown'}`);
      const worktree = await this.resolveWorktree(project);
      if (!worktree) {
        status.status = 'skipped';
        status.finishedAt = new Date().toISOString();
        status.error = 'Không có worktree đích tích hợp được cấu hình';
        write(`deploy skipped: ${status.error}`);
        this.latest.set(projectId, { ...status });
        return status;
      }
      const selfDeploy = definition.restartHub && this.isHubProject(project, worktree);
      for (const [index, argv] of definition.steps.entries()) {
        if (!argv.length) continue;
        write(`step ${index + 1}: ${JSON.stringify(argv)}`);
        const isWebInstall = argv.some((arg) => arg.endsWith('scripts/install-web.mjs'));
        const staging = selfDeploy && isWebInstall
          ? fs.mkdtempSync(path.join(this.config.hubHome, 'web-staging-'))
          : undefined;
        if (staging) this.stagedWeb.set(projectId, staging);
        const result = await this.processRunner(argv[0], argv.slice(1), {
          cwd: worktree,
          env: staging ? { ...process.env, AGENTHUB_WEB_STAGING_DIR: staging } : process.env,
          timeoutMs: definition.timeoutSec * 1000,
        });
        if (result.output) write(result.output.replace(/\n$/, ''));
        if (result.code !== 0 || result.timedOut) throw new Error(`Bước ${index + 1} thất bại${result.timedOut ? ' do timeout' : ` (exit ${result.code})`}`);
      }
      if (definition.push) {
        if (!definition.push.ffOnly) throw new Error('push chỉ hỗ trợ ffOnly');
        const minIntervalMin = definition.push.minIntervalMin ?? 30;
        const minIntervalMs = minIntervalMin * 60_000;
        const pushState = this.pushStates.get(projectId);
        const lastPushedTime = pushState?.lastPushedAt ? new Date(pushState.lastPushedAt).getTime() : 0;
        const now = Date.now();
        const elapsed = lastPushedTime > 0 ? now - lastPushedTime : Infinity;

        if (minIntervalMs <= 0 || elapsed >= minIntervalMs) {
          this.cancelScheduledPush(projectId);
          const pushed = await this.commandRunner(worktree, ['push', definition.push.remote, `${definition.push.from}:refs/heads/${definition.push.to}`]);
          write(`remote push ${definition.push.remote} ${definition.push.from}:refs/heads/${definition.push.to}\n${pushed.output}`);
          if (pushed.code !== 0) throw new Error(`git push thất bại (exit ${pushed.code})`);
          const nowIso = new Date().toISOString();
          this.pushStates.set(projectId, { lastPushedAt: nowIso, nextPushAt: undefined });
          this.savePushState();
          status.lastPushedAt = nowIso;
          status.nextPushAt = undefined;
          status.pushStatus = `push lúc ${formatTime(nowIso)}`;
        } else {
          const dueTime = lastPushedTime + minIntervalMs;
          this.scheduleDeferredPush(projectId, dueTime);
          const dueIso = new Date(dueTime).toISOString();
          status.lastPushedAt = pushState?.lastPushedAt;
          status.nextPushAt = dueIso;
          status.pushStatus = `push đang chờ tới ${formatTime(dueTime)}`;
          write(`remote push deferred: ${status.pushStatus}`);
        }
      }
      status.status = definition.restartHub && this.isHubProject(project, worktree) ? 'restarting' : 'succeeded';
      status.finishedAt = new Date().toISOString();
      write(status.status === 'restarting' ? 'deploy completed; hub is restarting' : 'deploy succeeded');
      if (status.status === 'restarting') {
        this.eventBus.emit('deploy.restarting', undefined, { projectId, commit, logPath });
        await this.restartHub(status);
      } else {
        this.eventBus.emit('deploy.succeeded', undefined, { projectId, commit, logPath });
      }
    } catch (error) {
      status.status = 'failed';
      status.finishedAt = new Date().toISOString();
      status.error = error instanceof Error ? error.message : String(error);
      write(`deploy failed: ${status.error}`);
      this.eventBus.emit('deploy.failed', undefined, { projectId, commit, logPath, error: status.error, level: 'incident' });
    } finally {
      const staging = this.stagedWeb.get(projectId);
      if (staging) {
        this.stagedWeb.delete(projectId);
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
      }
      this.latest.set(projectId, { ...status });
    }
    return status;
  }

  private isHubProject(project: ProjectRow, worktree: string): boolean {
    return isRunningHubCheckout([worktree, project.path], hubPackageRoot);
  }

  private async resolveWorktree(project: ProjectRow): Promise<string | null> {
    const settings = projectSettings(project);
    if (settings.integration.enabled) {
      const worktree = ensureIntegrationWorktree(project, this.config.hubHome);
      if (settings.worktree.install === 'auto') {
        await ensureIntegrationNodeModules(project, this.config.hubHome, {
          cacheDir: this.config.cacheDir,
          cacheMaxEntries: this.config.cacheMaxEntries,
          cacheMaxGB: this.config.cacheMaxGB,
        }).catch((err) => {
          console.warn(`[deploy] Failed to prepare integration worktree node_modules:`, err);
        });
      }
      return worktree;
    }
    if (!project.merge) return null;
    try {
      const merge = JSON.parse(project.merge) as { enabled?: boolean; worktrees?: Record<string, string> };
      if (merge.enabled !== true || !merge.worktrees) return null;
      const target = merge.worktrees[project.defaultBranch];
      if (!target || !path.isAbsolute(target)) return null;
      const worktree = path.resolve(target);
      if (settings.worktree.install === 'auto') {
        await ensureWorktreeNodeModules(worktree, project.path || undefined, this.config.cacheDir).catch((err) => {
          console.warn(`[deploy] Failed to prepare legacy worktree node_modules:`, err);
        });
      }
      return worktree;
    } catch { return null; }
  }

  private async restartHub(status: DeployStatus): Promise<void> {
    const definition = this.definition(status.projectId);
    const maxWaitMs = (definition?.restartMaxWaitMin ?? 20) * 60_000;
    const startedWaiting = Date.now();
    while (this.restartGuard) {
      const blockers = this.restartGuard.snapshot();
      const blocked = blockers.checks > 0 || blockers.editing > 0;
      if (!blocked || Date.now() - startedWaiting >= maxWaitMs) break;
      const waiting = `chờ khởi động lại (đang có ${blockers.checks} lượt kiểm tra, ${blockers.editing} worker)`;
      const current = this.latest.get(status.projectId) || status;
      this.latest.set(status.projectId, { ...current, status: 'restarting', error: waiting });
      const blockerKey = `${blockers.checks}:${blockers.editing}`;
      if (this.lastRestartBlockers.get(status.projectId) !== blockerKey) {
        this.lastRestartBlockers.set(status.projectId, blockerKey);
        this.eventBus.emit('deploy.restart_waiting', undefined, { projectId: status.projectId, checks: blockers.checks, editing: blockers.editing, message: waiting });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, maxWaitMs))));
    }
    this.lastRestartBlockers.delete(status.projectId);
    this.promoteStagedWeb(status.projectId);
    const command = process.platform === 'darwin' ? (process.env.AGENTHUB_LAUNCHCTL || 'launchctl') : (process.env.AGENTHUB_SYSTEMCTL || 'systemctl');
    const args = process.platform === 'darwin' ? ['kickstart', '-k', `gui/${process.getuid?.() ?? os.userInfo().uid}/dev.agenthub`] : ['--user', 'restart', 'agenthub', '--no-block'];
    const statePath = path.join(this.config.hubHome, 'deploy-restart.json');
    fs.writeFileSync(statePath, JSON.stringify({ projectId: status.projectId, commit: status.commit, logPath: status.logPath }));
    let child;
    try {
      child = this.restartRunner(command, args);
    } catch (error) {
      try { fs.rmSync(statePath, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
    child?.on?.('error', (error) => this.failRestart(status, error, statePath));
  }

  private promoteStagedWeb(projectId: string): void {
    const staging = this.stagedWeb.get(projectId);
    if (!staging || !fs.existsSync(staging)) return;
    const target = path.join(this.config.hubHome, 'web');
    const backup = path.join(this.config.hubHome, `web-previous-${process.pid}-${Date.now()}`);
    try {
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(staging, target);
      this.stagedWeb.delete(projectId);
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      try { if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target); } catch { /* best effort rollback */ }
      throw error;
    }
  }

  private failRestart(status: DeployStatus, error: unknown, statePath: string): void {
    try { fs.rmSync(statePath, { force: true }); } catch { /* best effort cleanup */ }
    status.status = 'failed';
    status.finishedAt = new Date().toISOString();
    status.error = error instanceof Error ? error.message : String(error);
    this.latest.set(status.projectId, { ...status });
    this.eventBus.emit('deploy.failed', undefined, {
      projectId: status.projectId,
      commit: status.commit,
      logPath: status.logPath,
      error: status.error,
      level: 'incident',
    });
  }

  getStatus(projectId: string): DeployStatus | null {
    const status = this.latest.get(projectId);
    if (!status) return null;
    const pushState = this.pushStates.get(projectId);
    if (pushState) {
      status.lastPushedAt = pushState.lastPushedAt;
      status.nextPushAt = pushState.nextPushAt;
      const pushStatus = this.formatPushStatus(pushState);
      if (pushStatus) status.pushStatus = pushStatus;
    }
    return status;
  }

  getAllStatus(): DeployStatus[] {
    return [...this.latest.keys()].map((id) => this.getStatus(id)!).filter(Boolean);
  }

  async waitForQueue(): Promise<void> {
    await this.queue;
  }

  rerun(projectId: string): DeployStatus {
    if (!this.definition(projectId) || !this.projectRepo.get(projectId)) return { projectId, status: 'skipped' };
    return this.enqueue(projectId);
  }
}

/**
 * True when one of the deployed directories is the checkout the hub is running from. The hub usually
 * runs from the integration worktree it deploys into, not from project.path (the main checkout), so
 * both are checked.
 */
export function isRunningHubCheckout(dirs: Array<string | null | undefined>, hubRoot: string): boolean {
  let root: string;
  try { root = fs.realpathSync(hubRoot); } catch { return false; }
  return dirs.some((dir) => {
    if (!dir) return false;
    try { return fs.realpathSync(dir) === root; } catch { return false; }
  });
}
