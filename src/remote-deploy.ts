import fs from 'node:fs';
import path from 'node:path';
import { AgentHubConfig } from './config.js';
import { ProjectRepo } from './db/index.js';
import { EventBus } from './scheduler/index.js';
import { projectSettings } from './projects/settings.js';
import { runInProcessGroup } from './priority.js';

export interface RemoteDeployStatus {
  projectId: string;
  status: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'health_timeout' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  trigger?: 'manual' | 'after-gitea-sync';
  commit?: string;
  error?: string;
  logPath?: string;
  durationMs?: number;
  queued?: boolean;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutput?: number }
) => Promise<{ code: number | null; output: string; timedOut?: boolean }>;

export interface RemoteDeployServiceOptions {
  pollIntervalMs?: number;
  processRunner?: ProcessRunner;
  fetchFn?: typeof fetch;
}

export function getRemoteDeploySecretPath(hubHome: string, projectId: string): string {
  return path.join(hubHome, 'secrets', `deploy-${projectId}.env`);
}

export function loadRemoteDeploySecrets(hubHome: string, projectId: string): Record<string, string> {
  const filePath = getRemoteDeploySecretPath(hubHome, projectId);
  if (!fs.existsSync(filePath)) return {};
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort chmod
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1);
      if (key) env[key] = val;
    }
  }
  return env;
}

export function saveRemoteDeploySecrets(hubHome: string, projectId: string, envMap: Record<string, string>): string[] {
  const secretDir = path.join(hubHome, 'secrets');
  fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(secretDir, 0o700);
  } catch {
    // best effort
  }

  const filePath = getRemoteDeploySecretPath(hubHome, projectId);
  const keys = Object.keys(envMap).sort();
  const lines: string[] = [];
  for (const key of keys) {
    const val = envMap[key];
    lines.push(`${key}=${val}`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), { mode: 0o600, encoding: 'utf8' });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }

  return keys;
}

export function redactSecrets(text: string, secrets: string[]): string {
  if (!text) return text;
  let redacted = text;
  const nonTrivial = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  nonTrivial.sort((a, b) => b.length - a.length);

  for (const secret of nonTrivial) {
    redacted = redacted.replaceAll(secret, '***');
  }
  return redacted;
}

export class RemoteDeployService {
  private running = new Set<string>();
  private queued = new Map<string, { trigger: 'manual' | 'after-gitea-sync'; commit?: string }>();
  private latest = new Map<string, RemoteDeployStatus>();
  private pollIntervalMs: number;
  private processRunner: ProcessRunner;
  private fetchFn: typeof fetch;
  private giteaSyncHandler?: (taskId: string | undefined, payload: unknown) => void;

  constructor(
    private config: AgentHubConfig,
    private projectRepo: ProjectRepo,
    private eventBus: EventBus,
    options?: RemoteDeployServiceOptions,
  ) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 15_000;
    this.processRunner = options?.processRunner ?? (async (command, args, opts) => {
      const result = await runInProcessGroup(command, args, opts);
      return { code: result.code ?? 1, output: result.output, timedOut: result.timedOut };
    });
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
  }

  start(): void {
    if (this.giteaSyncHandler) return;
    this.giteaSyncHandler = (_taskId, payload) => {
      const data = (payload && typeof payload === 'object' ? payload : {}) as {
        projectId?: string;
        prNumber?: number;
        prUrl?: string;
        merged?: boolean;
        pushedCommit?: string;
      };
      if (data.projectId && data.merged === true) {
        this.handleGiteaSync(data.projectId, data.pushedCommit);
      }
    };
    this.eventBus.on('gitea.sync.succeeded', this.giteaSyncHandler);
  }

  stop(): void {
    if (this.giteaSyncHandler) {
      this.eventBus.off('gitea.sync.succeeded', this.giteaSyncHandler);
      this.giteaSyncHandler = undefined;
    }
  }

  handleGiteaSync(projectId: string, commit?: string): void {
    const project = this.projectRepo.get(projectId);
    if (!project) return;
    const settings = projectSettings(project).remoteDeploy;
    if (settings?.enabled && settings.trigger === 'after-gitea-sync') {
      this.trigger(projectId, { trigger: 'after-gitea-sync', commit });
    }
  }

  trigger(projectId: string, options?: { trigger?: 'manual' | 'after-gitea-sync'; commit?: string }): RemoteDeployStatus {
    const project = this.projectRepo.get(projectId);
    if (!project) {
      return { projectId, status: 'skipped', error: `Project "${projectId}" không tồn tại` };
    }
    const settings = projectSettings(project).remoteDeploy;
    if (!settings?.enabled) {
      return { projectId, status: 'skipped', error: `Remote deploy chưa bật cho project "${projectId}"` };
    }

    const trigger = options?.trigger ?? 'manual';
    const commit = options?.commit;

    if (this.running.has(projectId)) {
      this.queued.set(projectId, { trigger, commit });
      const current = this.latest.get(projectId);
      if (current) current.queued = true;
      return { projectId, status: 'queued', trigger, commit };
    }

    this.running.add(projectId);
    const status: RemoteDeployStatus = {
      projectId,
      status: 'running',
      startedAt: new Date().toISOString(),
      trigger,
      commit,
    };
    this.latest.set(projectId, status);

    void this.executeDeploy(projectId, trigger, commit);
    return status;
  }

  getStatus(projectId: string): RemoteDeployStatus | undefined {
    const status = this.latest.get(projectId);
    if (status) {
      return { ...status, queued: this.queued.has(projectId) };
    }
    return undefined;
  }

  getAllStatus(): RemoteDeployStatus[] {
    return [...this.latest.values()].map((s) => ({ ...s, queued: this.queued.has(s.projectId) }));
  }

  saveSecrets(projectId: string, envMap: Record<string, string>): string[] {
    return saveRemoteDeploySecrets(this.config.hubHome, projectId, envMap);
  }

  private async executeDeploy(projectId: string, trigger: 'manual' | 'after-gitea-sync', commit?: string): Promise<void> {
    const project = this.projectRepo.get(projectId);
    if (!project) {
      this.running.delete(projectId);
      return;
    }

    const settings = projectSettings(project).remoteDeploy;
    const timestamp = Date.now();
    const logDir = path.join(this.config.hubHome, 'logs', 'remote-deploy');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${projectId}-${timestamp}.log`);

    const secrets = loadRemoteDeploySecrets(this.config.hubHome, projectId);
    const secretValues = Object.values(secrets);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...secrets };

    const appendLog = (text: string) => {
      const redacted = redactSecrets(text, secretValues);
      try {
        fs.appendFileSync(logPath, redacted + '\n', 'utf8');
      } catch {
        // best effort
      }
    };

    const status: RemoteDeployStatus = {
      projectId,
      status: 'running',
      startedAt: new Date().toISOString(),
      trigger,
      commit,
      logPath,
    };
    this.latest.set(projectId, status);
    this.eventBus.emit('remote_deploy.started', undefined, { projectId, trigger, commit, logPath });

    appendLog(`[${new Date().toISOString()}] Remote deploy started for project "${projectId}" (trigger: ${trigger})`);
    if (commit) {
      appendLog(`[${new Date().toISOString()}] Commit: ${commit}`);
    }

    const steps = settings.steps || [];
    const timeoutSec = settings.timeoutSec ?? 1800;
    const totalTimeoutMs = timeoutSec * 1000;
    const startTime = Date.now();

    let failed = false;
    let failError = '';

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || step.length === 0) continue;

        const elapsed = Date.now() - startTime;
        const remainingMs = totalTimeoutMs - elapsed;
        if (remainingMs <= 0) {
          failed = true;
          failError = `Deployment timed out after ${timeoutSec}s`;
          appendLog(`[${new Date().toISOString()}] ${failError}`);
          break;
        }

        appendLog(`[${new Date().toISOString()}] Step ${i + 1}/${steps.length}: ${step.join(' ')}`);

        const cmd = step[0];
        const args = step.slice(1);

        try {
          const res = await this.processRunner(cmd, args, {
            cwd: project.path,
            env: childEnv,
            timeoutMs: remainingMs,
          });

          if (res.output) {
            appendLog(res.output.trimEnd());
          }

          if (res.timedOut) {
            failed = true;
            failError = `Step ${i + 1} timed out`;
            appendLog(`[${new Date().toISOString()}] ${failError}`);
            break;
          }

          if (res.code !== 0) {
            failed = true;
            failError = `Step ${i + 1} failed with exit code ${res.code}`;
            appendLog(`[${new Date().toISOString()}] ${failError}`);
            break;
          }
        } catch (err) {
          failed = true;
          failError = `Step ${i + 1} error: ${err instanceof Error ? err.message : String(err)}`;
          appendLog(`[${new Date().toISOString()}] ${failError}`);
          break;
        }
      }

      if (failed) {
        status.status = 'failed';
        status.finishedAt = new Date().toISOString();
        status.error = redactSecrets(failError, secretValues);
        status.durationMs = Date.now() - startTime;
        this.latest.set(projectId, status);
        this.eventBus.emit('remote_deploy.failed', undefined, {
          projectId,
          trigger,
          commit,
          error: status.error,
          logPath,
          durationMs: status.durationMs,
        });
        return;
      }

      // Step execution succeeded, now run health checks if configured
      const healthChecks = settings.healthChecks || [];
      if (healthChecks.length === 0) {
        status.status = 'succeeded';
        status.finishedAt = new Date().toISOString();
        status.durationMs = Date.now() - startTime;
        this.latest.set(projectId, status);
        appendLog(`[${new Date().toISOString()}] Remote deploy succeeded in ${status.durationMs}ms`);
        this.eventBus.emit('remote_deploy.succeeded', undefined, {
          projectId,
          trigger,
          commit,
          logPath,
          durationMs: status.durationMs,
        });
      } else {
        appendLog(`[${new Date().toISOString()}] Starting health checks (${healthChecks.length} checks, waitMinutes: ${settings.waitMinutes})`);
        const waitMs = (settings.waitMinutes ?? 15) * 60_000;
        const pollIntervalMs = this.pollIntervalMs;
        const hcStartTime = Date.now();
        let hcPassed = false;
        let hcTimeout = false;
        let lastHcError = '';

        while (!hcPassed && !hcTimeout) {
          let allChecksOk = true;
          for (const hc of healthChecks) {
            try {
              const res = await this.fetchFn(hc.url);
              const expectBelow = hc.expectStatusBelow ?? 500;
              if (res.status >= expectBelow) {
                allChecksOk = false;
                lastHcError = `Health check ${hc.url} returned status ${res.status} (expected < ${expectBelow})`;
                break;
              }
              if (hc.contains) {
                const body = await res.text();
                if (!body.includes(hc.contains)) {
                  allChecksOk = false;
                  lastHcError = `Health check ${hc.url} body does not contain "${hc.contains}"`;
                  break;
                }
              }
            } catch (err) {
              allChecksOk = false;
              lastHcError = `Health check ${hc.url} fetch failed: ${err instanceof Error ? err.message : String(err)}`;
              break;
            }
          }

          if (allChecksOk) {
            hcPassed = true;
            break;
          }

          const elapsedHc = Date.now() - hcStartTime;
          if (elapsedHc >= waitMs) {
            hcTimeout = true;
            break;
          }

          const sleepMs = Math.min(pollIntervalMs, Math.max(10, waitMs - elapsedHc));
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
        }

        if (hcPassed) {
          status.status = 'succeeded';
          status.finishedAt = new Date().toISOString();
          status.durationMs = Date.now() - startTime;
          this.latest.set(projectId, status);
          appendLog(`[${new Date().toISOString()}] Health checks passed.`);
          appendLog(`[${new Date().toISOString()}] Remote deploy succeeded in ${status.durationMs}ms`);
          this.eventBus.emit('remote_deploy.succeeded', undefined, {
            projectId,
            trigger,
            commit,
            logPath,
            durationMs: status.durationMs,
          });
        } else {
          status.status = 'health_timeout';
          status.finishedAt = new Date().toISOString();
          status.durationMs = Date.now() - startTime;
          status.error = redactSecrets(lastHcError || 'Health checks timed out', secretValues);
          this.latest.set(projectId, status);
          appendLog(`[${new Date().toISOString()}] Health check timed out after ${settings.waitMinutes} minutes. ${status.error}`);
          this.eventBus.emit('remote_deploy.health_timeout', undefined, {
            projectId,
            trigger,
            commit,
            error: status.error,
            logPath,
            durationMs: status.durationMs,
          });
        }
      }
    } finally {
      const queuedRun = this.queued.get(projectId);
      if (queuedRun) {
        this.queued.delete(projectId);
        setImmediate(() => {
          void this.executeDeploy(projectId, queuedRun.trigger, queuedRun.commit);
        });
      } else {
        this.running.delete(projectId);
      }
    }
  }
}
