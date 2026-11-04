import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AgentHubConfig } from '../../config.js';
import type { ProjectRepo, TaskRow, ProjectRow } from '../../db/index.js';
import type { EventBus } from '../../scheduler/index.js';
import { HttpError } from '../../errors.js';
import { projectSettings } from '../../projects/settings.js';
import { getMinutesSinceTime } from '../../brain/digest.js';
import { GiteaClient, parseRemote, type GiteaPullRequest } from './client.js';
import { readGiteaToken, saveGiteaToken, isGiteaTokenConfigured } from './secrets.js';

export interface GiteaSyncResult {
  ok: boolean;
  status: 'started' | 'skipped' | 'succeeded' | 'failed' | 'conflict';
  prNumber?: number;
  url?: string;
  commit?: string;
  reason?: string;
  error?: string;
  conflictingFiles?: string[];
  taskId?: string;
}

export interface GiteaSyncServiceOptions {
  config: AgentHubConfig;
  projectRepo: ProjectRepo;
  eventBus: EventBus;
  service: {
    createTask(input: unknown): TaskRow;
    getProject?(id: string): ProjectRow;
  };
  fetchFn?: typeof globalThis.fetch;
  retryDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class GiteaSyncService {
  private readonly config: AgentHubConfig;
  private readonly projectRepo: ProjectRepo;
  private readonly eventBus: EventBus;
  private readonly service: GiteaSyncServiceOptions['service'];
  private readonly fetchFn?: typeof globalThis.fetch;
  private readonly retryDelayMs?: number;
  private readonly sleepFn?: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private timer?: NodeJS.Timeout;
  private readonly runningProjects = new Set<string>();
  private readonly lastRanScheduled = new Map<string, string>();
  private readonly lastSyncResults = new Map<string, GiteaSyncResult>();

  constructor(opts: GiteaSyncServiceOptions) {
    this.config = opts.config;
    this.projectRepo = opts.projectRepo;
    this.eventBus = opts.eventBus;
    this.service = opts.service;
    this.fetchFn = opts.fetchFn;
    this.retryDelayMs = opts.retryDelayMs;
    this.sleepFn = opts.sleepFn;
    this.now = opts.now || (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkScheduled();
    }, 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private getGitEnv(): NodeJS.ProcessEnv {
    const cleanPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((entry) => !entry.includes(`${path.sep}shims${path.sep}worker`))
      .join(path.delimiter);
    return { ...process.env, PATH: cleanPath };
  }

  getStatus(projectId: string): {
    tokenConfigured: boolean;
    remote: { owner: string; repo: string; host?: string } | null;
  } {
    const tokenConfigured = isGiteaTokenConfigured(this.config.hubHome, projectId);
    let remote: { owner: string; repo: string; host?: string } | null = null;
    const project = this.projectRepo.get(projectId);
    if (project?.path) {
      try {
        const remoteUrl = execFileSync('git', ['-C', project.path, 'remote', 'get-url', 'origin'], {
          encoding: 'utf8',
          env: this.getGitEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        remote = parseRemote(remoteUrl);
      } catch {
        remote = null;
      }
    }
    return { tokenConfigured, remote };
  }

  saveToken(projectId: string, token: string): { configured: boolean } {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new HttpError(400, 'bad_request', 'Token không được để trống');
    }
    saveGiteaToken(this.config.hubHome, projectId, token.trim());
    return { configured: true };
  }

  async checkScheduled(nowMs = this.now()): Promise<void> {
    const d = new Date(nowMs);
    const day = d.getDay(); // 0: Sunday, 6: Saturday
    const isWeekend = day === 0 || day === 6;
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const projects = this.projectRepo.getAll();
    for (const project of projects) {
      try {
        const settings = projectSettings(project);
        const gitea = settings.gitea;
        if (!gitea?.enabled) continue;
        if (gitea.weekdaysOnly && isWeekend) continue;

        const schedule = gitea.schedule || ['12:00', '18:00'];
        for (const timeStr of schedule) {
          const key = `${project.id}:${timeStr}`;
          if (this.lastRanScheduled.get(key) === dateKey) continue;

          const minsSince = getMinutesSinceTime(timeStr, d);
          if (minsSince >= 0 && minsSince <= 60) {
            this.lastRanScheduled.set(key, dateKey);
            void this.syncProject(project.id).catch(() => {
              // error recorded in syncProject
            });
            break;
          }
        }
      } catch {
        // ignore errors in scheduled check loop
      }
    }
  }

  async syncProject(projectId: string): Promise<GiteaSyncResult> {
    if (this.runningProjects.has(projectId)) {
      throw new HttpError(409, 'conflict', `Sync cho project "${projectId}" đang chạy`);
    }

    const project = this.projectRepo.get(projectId);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    }

    const settings = projectSettings(project);
    const gitea = settings.gitea;
    if (!gitea?.enabled) {
      throw new HttpError(400, 'bad_request', `Gitea sync chưa được bật cho project "${projectId}"`);
    }
    if (!gitea.url) {
      throw new HttpError(400, 'bad_request', `Chưa cấu hình URL Gitea cho project "${projectId}"`);
    }
    if (!gitea.sourceBranch || !gitea.targetBranch) {
      throw new HttpError(400, 'bad_request', `Chưa cấu hình sourceBranch hoặc targetBranch cho project "${projectId}"`);
    }

    const token = readGiteaToken(this.config.hubHome, projectId);
    if (!token) {
      throw new HttpError(400, 'bad_request', `Gitea token chưa được cấu hình cho project "${projectId}"`);
    }

    this.runningProjects.add(projectId);
    try {
      const result = await this.executeSync(project, gitea, token);
      this.lastSyncResults.set(projectId, result);
      return result;
    } finally {
      this.runningProjects.delete(projectId);
    }
  }

  private async executeSync(
    project: ProjectRow,
    gitea: NonNullable<ReturnType<typeof projectSettings>['gitea']>,
    token: string,
  ): Promise<GiteaSyncResult> {
    const { id: projectId, path: repoPath } = project;
    const sourceBranch = gitea.sourceBranch!;
    const targetBranch = gitea.targetBranch!;
    const giteaUrl = gitea.url!;

    const cleanPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((entry) => !entry.includes(`${path.sep}shims${path.sep}worker`))
      .join(path.delimiter);

    const gitEnv = {
      ...process.env,
      PATH: cleanPath,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'AgentHub',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'agenthub@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'AgentHub',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'agenthub@localhost',
    };

    this.eventBus.emit('gitea.sync.started', projectId, {
      projectId,
      sourceBranch,
      targetBranch,
    });

    // 1. Get remote and fetch
    let remoteUrl = '';
    try {
      remoteUrl = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        env: gitEnv,
      }).trim();
    } catch (err: unknown) {
      const errorMsg = `Không thể lấy git remote origin: ${err instanceof Error ? err.message : String(err)}`;
      this.eventBus.emit('gitea.sync.failed', projectId, {
        projectId,
        sourceBranch,
        targetBranch,
        error: errorMsg,
      });
      return { ok: false, status: 'failed', error: errorMsg };
    }

    const remote = parseRemote(remoteUrl);
    if (!remote) {
      const errorMsg = `Không thể phân tích git remote URL: ${remoteUrl}`;
      this.eventBus.emit('gitea.sync.failed', projectId, {
        projectId,
        sourceBranch,
        targetBranch,
        error: errorMsg,
      });
      return { ok: false, status: 'failed', error: errorMsg };
    }

    const { owner, repo } = remote;

    try {
      execFileSync('git', ['-C', repoPath, 'fetch', 'origin', sourceBranch, targetBranch], {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
        env: gitEnv,
      });
    } catch {
      // Fallback to fetch origin without explicit refspecs
      try {
        execFileSync('git', ['-C', repoPath, 'fetch', 'origin'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          encoding: 'utf8',
          env: gitEnv,
        });
      } catch (err: unknown) {
        const errorMsg = `Lỗi git fetch origin: ${err instanceof Error ? err.message : String(err)}`;
        this.eventBus.emit('gitea.sync.failed', projectId, {
          projectId,
          sourceBranch,
          targetBranch,
          error: errorMsg,
        });
        return { ok: false, status: 'failed', error: errorMsg };
      }
    }

    // Step 1: Check if there are non-merge commits to sync
    let logOut = '';
    try {
      logOut = execFileSync(
        'git',
        ['-C', repoPath, 'log', '--no-merges', `origin/${targetBranch}..origin/${sourceBranch}`, '--oneline'],
        { encoding: 'utf8', env: gitEnv },
      ).trim();
    } catch (err: unknown) {
      const errorMsg = `Lỗi kiểm tra git log: ${err instanceof Error ? err.message : String(err)}`;
      this.eventBus.emit('gitea.sync.failed', projectId, {
        projectId,
        sourceBranch,
        targetBranch,
        error: errorMsg,
      });
      return { ok: false, status: 'failed', error: errorMsg };
    }

    if (!logOut) {
      this.eventBus.emit('gitea.sync.skipped', projectId, {
        projectId,
        sourceBranch,
        targetBranch,
        reason: 'Không có commit mới cần đồng bộ',
      });
      return { ok: true, status: 'skipped', reason: 'Không có commit mới cần đồng bộ' };
    }

    // Step 2: Create temporary worktree
    const tmpDir = path.join(this.config.hubHome, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(
      tmpDir,
      `gitea-sync-${projectId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );

    try {
      execFileSync(
        'git',
        ['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, `origin/${sourceBranch}`],
        { stdio: ['pipe', 'pipe', 'pipe'], env: gitEnv },
      );
    } catch (err: unknown) {
      const errorMsg = `Lỗi tạo worktree tạm: ${err instanceof Error ? err.message : String(err)}`;
      this.eventBus.emit('gitea.sync.failed', projectId, {
        projectId,
        sourceBranch,
        targetBranch,
        error: errorMsg,
      });
      return { ok: false, status: 'failed', error: errorMsg };
    }

    try {
      // Step 2b: Merge targetBranch into sourceBranch
      let hasConflict = false;
      try {
        execFileSync('git', ['-C', worktreePath, 'merge', '--no-edit', `origin/${targetBranch}`], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: gitEnv,
        });
      } catch {
        hasConflict = true;
      }

      // Step 3: Conflict handling
      if (hasConflict) {
        let unmergedFiles: string[] = [];
        try {
          const unmergedOut = execFileSync(
            'git',
            ['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U'],
            { encoding: 'utf8', env: gitEnv },
          ).trim();
          unmergedFiles = unmergedOut ? unmergedOut.split('\n').map((s) => s.trim()).filter(Boolean) : [];
        } catch {
          // ignore
        }

        const globs = gitea.unionMergeGlobs || [];
        const allMatchUnion =
          unmergedFiles.length > 0 &&
          unmergedFiles.every((file) => globs.some((pattern) => path.matchesGlob(file, pattern)));

        if (allMatchUnion) {
          // Union merge: preserve both sides (ours then theirs)
          for (const file of unmergedFiles) {
            let ours = '';
            let theirs = '';
            try {
              ours = execFileSync('git', ['-C', worktreePath, 'show', `:2:${file}`], {
                encoding: 'utf8',
                env: gitEnv,
              });
            } catch {
              // empty
            }
            try {
              theirs = execFileSync('git', ['-C', worktreePath, 'show', `:3:${file}`], {
                encoding: 'utf8',
                env: gitEnv,
              });
            } catch {
              // empty
            }
            const combined = ours + (ours.endsWith('\n') ? '' : '\n') + theirs;
            fs.writeFileSync(path.join(worktreePath, file), combined, 'utf8');
            execFileSync('git', ['-C', worktreePath, 'add', file], { stdio: ['pipe', 'pipe', 'pipe'], env: gitEnv });
          }

          execFileSync('git', ['-C', worktreePath, 'commit', '--no-edit'], {
            env: gitEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } else {
          // Abort merge and create draft task
          try {
            execFileSync('git', ['-C', worktreePath, 'merge', '--abort'], { stdio: 'ignore', env: gitEnv });
          } catch {
            // ignore
          }

          const title = `Gỡ xung đột ${sourceBranch} ← ${targetBranch}`;
          const slug = `gitea-conflict-${Date.now()}`;
          const body = `Xung đột khi đồng bộ ${sourceBranch} ← ${targetBranch}:\n\n` +
            unmergedFiles.map((f) => `- ${f}`).join('\n');

          const draftTask = this.service.createTask({
            project: projectId,
            slug,
            title,
            body,
            start: false,
          });

          this.eventBus.emit('gitea.sync.conflict', projectId, {
            projectId,
            sourceBranch,
            targetBranch,
            conflictingFiles: unmergedFiles,
            taskId: draftTask.id,
          });

          return {
            ok: false,
            status: 'conflict',
            conflictingFiles: unmergedFiles,
            taskId: draftTask.id,
          };
        }
      }

      // Step 4: Run checks
      if (gitea.checks && gitea.checks.length > 0) {
        for (const checkArgv of gitea.checks) {
          if (!Array.isArray(checkArgv) || checkArgv.length === 0) continue;
          const [cmd, ...args] = checkArgv;
          try {
            execFileSync(cmd, args, {
              cwd: worktreePath,
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 300_000,
            });
          } catch (checkErr: unknown) {
            const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
            const errorMsg = `Check failed: ${checkArgv.join(' ')}: ${checkMsg}`;
            this.eventBus.emit('gitea.sync.failed', projectId, {
              projectId,
              sourceBranch,
              targetBranch,
              error: errorMsg,
            });
            return { ok: false, status: 'failed', error: errorMsg };
          }
        }
      }

      // Step 5: Push source branch if updated (never force push)
      const headSha = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: gitEnv,
      }).trim();
      const originSourceSha = execFileSync(
        'git',
        ['-C', repoPath, 'rev-parse', `origin/${sourceBranch}`],
        { encoding: 'utf8', env: gitEnv },
      ).trim();

      const pushedCommit = headSha;
      if (headSha !== originSourceSha) {
        try {
          execFileSync('git', ['-C', worktreePath, 'push', 'origin', `HEAD:refs/heads/${sourceBranch}`], { // policy: gitea sync push
            stdio: ['pipe', 'pipe', 'pipe'],
            env: gitEnv,
          });
        } catch (err: unknown) {
          const errorMsg = `Lỗi git push origin ${sourceBranch}: ${err instanceof Error ? err.message : String(err)}`;
          this.eventBus.emit('gitea.sync.failed', projectId, {
            projectId,
            sourceBranch,
            targetBranch,
            error: errorMsg,
          });
          return { ok: false, status: 'failed', error: errorMsg };
        }
      }

      // Step 6: Find or create PR, then merge on Gitea
      const client = new GiteaClient({
        baseUrl: giteaUrl,
        token,
        fetchFn: this.fetchFn,
        retryDelayMs: this.retryDelayMs,
        sleepFn: this.sleepFn,
      });

      let pr: GiteaPullRequest | null = null;
      try {
        pr = await client.findOpenPull(owner, repo, sourceBranch, targetBranch);
        if (!pr) {
          pr = await client.createPull(owner, repo, {
            head: sourceBranch,
            base: targetBranch,
            title: `Sync ${sourceBranch} → ${targetBranch}`,
            body: `Automated sync from ${sourceBranch} to ${targetBranch}`,
          });
        }
        await client.mergePull(owner, repo, pr.number);
      } catch (apiErr: unknown) {
        const errorMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
        const prUrl =
          pr?.html_url ||
          (pr?.number ? `${giteaUrl.replace(/\/+$/, '')}/${owner}/${repo}/pulls/${pr.number}` : undefined);
        this.eventBus.emit('gitea.sync.failed', projectId, {
          projectId,
          sourceBranch,
          targetBranch,
          prNumber: pr?.number,
          url: prUrl,
          commit: pushedCommit,
          error: errorMsg,
        });
        return {
          ok: false,
          status: 'failed',
          prNumber: pr?.number,
          url: prUrl,
          commit: pushedCommit,
          error: errorMsg,
        };
      }

      const prUrl = pr.html_url || `${giteaUrl.replace(/\/+$/, '')}/${owner}/${repo}/pulls/${pr.number}`;
      this.eventBus.emit('gitea.sync.succeeded', projectId, {
        projectId,
        sourceBranch,
        targetBranch,
        prNumber: pr.number,
        url: prUrl,
        commit: pushedCommit,
        pushedCommit,
        merged: true,
      });

      return {
        ok: true,
        status: 'succeeded',
        prNumber: pr.number,
        url: prUrl,
        commit: pushedCommit,
      };
    } finally {
      this.cleanupWorktree(worktreePath, repoPath);
    }
  }

  private cleanupWorktree(worktreePath: string, repoPath: string): void {
    const cleanPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((entry) => !entry.includes(`${path.sep}shims${path.sep}worker`))
      .join(path.delimiter);
    const env = { ...process.env, PATH: cleanPath };
    try {
      execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], {
        stdio: 'ignore',
        env,
      });
    } catch {
      // ignore
    }
    try {
      execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'ignore', env });
    } catch {
      // ignore
    }
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
