import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskRow, ProjectRow } from './db/index.js';
import { projectSettings } from './projects/settings.js';
import { parseRemote } from './integrations/gitea/client.js';
import { HttpError } from './services/index.js';

const execFileAsync = promisify(execFile);

const projectPublishLocks = new Map<string, Promise<unknown>>();

/**
 * Ensures sequential execution of publish workflows per project.
 */
export async function withProjectPublishLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectPublishLocks.get(projectId) || Promise.resolve();
  let resolveCurrent: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  projectPublishLocks.set(projectId, current);
  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    resolveCurrent!();
    if (projectPublishLocks.get(projectId) === current) {
      projectPublishLocks.delete(projectId);
    }
  }
}

/**
 * Filter PATH to exclude worker shims that block git push.
 */
export function cleanGitEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleanPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((entry) => !entry.includes(`${path.sep}shims${path.sep}worker`))
    .join(path.delimiter);
  return {
    ...process.env,
    ...extraEnv,
    PATH: cleanPath,
  };
}

async function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

async function refExists(repo: string, ref: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], { env });
    return true;
  } catch {
    return false;
  }
}

async function gitIdentityArgs(repo: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const read = async (key: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', key], { cwd: repo, env });
      return stdout.trim();
    } catch {
      return '';
    }
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return name && email ? [] : ['-c', 'user.name=AgentHub', '-c', 'user.email=agenthub@localhost'];
}

export function buildGitUrls(
  remoteUrl: string,
  commitSha: string,
  prevSha?: string | null,
): { commitUrl?: string; compareUrl?: string } {
  const parsed = parseRemote(remoteUrl);
  if (!parsed || !parsed.host) return {};
  const { host, owner, repo } = parsed;
  const isGitLab = host.includes('gitlab');
  const commitPath = isGitLab ? `/-/commit/${commitSha}` : `/commit/${commitSha}`;
  const commitUrl = `https://${host}/${owner}/${repo}${commitPath}`;
  let compareUrl: string | undefined;
  if (prevSha && prevSha !== commitSha) {
    const comparePath = isGitLab ? `/-/compare/${prevSha}...${commitSha}` : `/compare/${prevSha}...${commitSha}`;
    compareUrl = `https://${host}/${owner}/${repo}${comparePath}`;
  } else {
    compareUrl = commitUrl;
  }
  return { commitUrl, compareUrl };
}

export interface PublishTaskDeps {
  taskRepo: {
    get(id: string): TaskRow | undefined;
    update(id: string, patch: Partial<TaskRow>): void;
  };
  projectRepo: {
    get(id: string): ProjectRow | undefined;
  };
  eventBus: {
    emit(event: string, ...args: unknown[]): void;
  };
  hubHome: string;
}

export interface PublishSuccessResult {
  ok: true;
  remote: string;
  branch: string;
  commit: string;
  compareUrl?: string;
  pushedIntegrationBranch: boolean;
}

export interface PublishFailedResult {
  ok: false;
  error: string;
  remote: string;
  branch: string;
}

export interface PublishSkippedResult {
  ok: true;
  skipped: true;
  reason: string;
}

export type PublishResult = PublishSuccessResult | PublishFailedResult | PublishSkippedResult;

/**
 * Execute the publish workflow for a completed task.
 */
export async function publishTask(
  taskId: string,
  deps: PublishTaskDeps,
  options?: { manual?: boolean },
): Promise<PublishResult> {
  const initialTask = deps.taskRepo.get(taskId);
  if (!initialTask) {
    throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
  }

  if (initialTask.status !== 'done' && initialTask.status !== 'pushed') {
    throw new HttpError(
      400,
      'bad_request',
      `Task đang ở trạng thái "${initialTask.status}", chỉ có thể publish task "done" hoặc "pushed"`,
    );
  }

  const project = deps.projectRepo.get(initialTask.projectId);
  if (!project) {
    throw new HttpError(404, 'not_found', `Project "${initialTask.projectId}" không tồn tại`);
  }

  const settings = projectSettings(project);
  if (!options?.manual && !settings.publish?.enabled) {
    return { ok: true, skipped: true, reason: 'publish_disabled' };
  }

  return withProjectPublishLock(project.id, async () => {
    const task = deps.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const currentProject = deps.projectRepo.get(task.projectId);
    if (!currentProject) {
      throw new HttpError(404, 'not_found', `Project "${task.projectId}" không tồn tại`);
    }

    const currentSettings = projectSettings(currentProject);
    const remote = currentSettings.publish?.remote || 'origin';
    const targetBranch = currentSettings.publish?.branch || currentProject.defaultBranch || 'main';

    let sourceBranch = task.branch || `agenthub/${task.slug}`;
    if (currentSettings.integration?.enabled) {
      sourceBranch = currentSettings.integration.branch || 'agenthub/integration';
    }

    deps.eventBus.emit('task.publishing', taskId, {
      taskId,
      projectId: currentProject.id,
      remote,
      branch: targetBranch,
    });

    const env = cleanGitEnv();
    const repoPath = currentProject.path;

    if (!repoPath || !fs.existsSync(repoPath)) {
      const errorMsg = `Thư mục repository không tồn tại: ${repoPath}`;
      const failedAt = new Date().toISOString();
      deps.taskRepo.update(taskId, {
        pushResult: JSON.stringify({ error: errorMsg, failedAt, retryable: true }),
      });
      deps.eventBus.emit('task.push_failed', taskId, {
        taskId,
        projectId: currentProject.id,
        error: errorMsg,
        remote,
        branch: targetBranch,
      });
      return { ok: false, error: errorMsg, remote, branch: targetBranch };
    }

    let remoteUrl = '';
    try {
      remoteUrl = await runGit(['-C', repoPath, 'remote', 'get-url', remote], repoPath, env);
    } catch (err) {
      const errorMsg = `Không tìm thấy git remote "${remote}": ${err instanceof Error ? err.message : String(err)}`;
      const failedAt = new Date().toISOString();
      deps.taskRepo.update(taskId, {
        pushResult: JSON.stringify({ error: errorMsg, failedAt, retryable: true }),
      });
      deps.eventBus.emit('task.push_failed', taskId, {
        taskId,
        projectId: currentProject.id,
        error: errorMsg,
        remote,
        branch: targetBranch,
      });
      return { ok: false, error: errorMsg, remote, branch: targetBranch };
    }

    // Prepare temp detached worktree
    const tmpDir = path.join(deps.hubHome, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(
      tmpDir,
      `publish-${currentProject.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );

    let prevRemoteSha: string | null = null;
    try {
      // 1. Fetch remote target branch if remote exists
      try {
        await runGit(['-C', repoPath, 'fetch', remote, targetBranch], repoPath, env);
      } catch {
        // Fallback fetch all from remote
        try {
          await runGit(['-C', repoPath, 'fetch', remote], repoPath, env);
        } catch {
          // Non-fatal if remote has no matching ref or is new/empty
        }
      }

      const remoteRef = `refs/remotes/${remote}/${targetBranch}`;
      if (await refExists(repoPath, remoteRef, env)) {
        prevRemoteSha = await runGit(['-C', repoPath, 'rev-parse', remoteRef], repoPath, env);
      }

      const localRef = `refs/heads/${targetBranch}`;
      const localExists = await refExists(repoPath, localRef, env);
      const remoteExists = Boolean(prevRemoteSha);

      // Determine initial commit-ish to detach from
      let startPoint: string;
      if (localExists) {
        startPoint = targetBranch;
      } else if (remoteExists) {
        startPoint = remoteRef;
      } else {
        startPoint = sourceBranch;
      }

      await runGit(['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, startPoint], repoPath, env);

      // 2. If remote target branch exists and local started from local target, fast-forward / merge remote changes
      if (remoteExists && localExists) {
        try {
          await runGit(['-C', worktreePath, 'merge', '--ff-only', remoteRef], worktreePath, env);
        } catch {
          // If ff not possible, attempt standard merge
          try {
            const identity = await gitIdentityArgs(worktreePath, env);
            await runGit(['-C', worktreePath, ...identity, 'merge', '--no-edit', remoteRef], worktreePath, env);
          } catch (mergeErr) {
            throw new Error(`Xung đột merge với remote ${targetBranch}: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
          }
        }
      }

      // 3. Merge source branch into target branch (if sourceBranch differs or has commits)
      const sourceExists = await refExists(repoPath, `refs/heads/${sourceBranch}`, env);
      if (sourceExists) {
        const isAncestor = await execFileAsync('git', ['-C', worktreePath, 'merge-base', '--is-ancestor', sourceBranch, 'HEAD'], { env })
          .then(() => true)
          .catch(() => false);

        if (!isAncestor) {
          const identity = await gitIdentityArgs(worktreePath, env);
          const mergeMsg = `Merge branch '${sourceBranch}' into ${targetBranch}`;
          try {
            await runGit(['-C', worktreePath, ...identity, 'merge', '--no-ff', sourceBranch, '-m', mergeMsg], worktreePath, env);
          } catch (err) {
            try {
              await runGit(['-C', worktreePath, 'merge', '--abort'], worktreePath, env);
            } catch {
              // ignore
            }
            throw new Error(`Xung đột khi merge ${sourceBranch} vào ${targetBranch}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // 4. Get HEAD commit sha
      const pushedCommit = await runGit(['-C', worktreePath, 'rev-parse', 'HEAD'], worktreePath, env);

      // 5. Push target branch to remote
      await runGit(['-C', worktreePath, 'push', remote, `HEAD:refs/heads/${targetBranch}`], worktreePath, env);

      // 6. Update local branch ref to match pushed commit
      await runGit(['-C', repoPath, 'update-ref', `refs/heads/${targetBranch}`, pushedCommit], repoPath, env);

      // 7. Push integration branch if enabled
      let pushedIntegrationBranch = false;
      if (currentSettings.integration?.enabled && currentSettings.publish?.pushIntegrationBranch !== false) {
        const integrationBranch = currentSettings.integration.branch || 'agenthub/integration';
        if (await refExists(repoPath, `refs/heads/${integrationBranch}`, env)) {
          await runGit(
            ['-C', worktreePath, 'push', remote, `refs/heads/${integrationBranch}:refs/heads/${integrationBranch}`],
            worktreePath,
            env,
          );
          pushedIntegrationBranch = true;
        }
      }

      // 8. Generate URLs and update task
      const { compareUrl } = buildGitUrls(remoteUrl, pushedCommit, prevRemoteSha);
      const pushedAt = new Date().toISOString();
      const pushResultObj = {
        remote,
        branch: targetBranch,
        commit: pushedCommit,
        compareUrl,
        pushedIntegrationBranch,
      };

      deps.taskRepo.update(taskId, {
        status: 'pushed',
        pushedAt,
        pushResult: JSON.stringify(pushResultObj),
      });

      deps.eventBus.emit('task.pushed', taskId, {
        taskId,
        projectId: currentProject.id,
        remote,
        branch: targetBranch,
        commit: pushedCommit,
        compareUrl,
      });

      return {
        ok: true,
        remote,
        branch: targetBranch,
        commit: pushedCommit,
        compareUrl,
        pushedIntegrationBranch,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedAt = new Date().toISOString();
      deps.taskRepo.update(taskId, {
        pushResult: JSON.stringify({ error: errorMsg, failedAt, retryable: true }),
      });
      deps.eventBus.emit('task.push_failed', taskId, {
        taskId,
        projectId: currentProject.id,
        error: errorMsg,
        remote,
        branch: targetBranch,
      });
      return {
        ok: false,
        error: errorMsg,
        remote,
        branch: targetBranch,
      };
    } finally {
      // Clean up temporary worktree
      try {
        await runGit(['-C', repoPath, 'worktree', 'remove', '--force', worktreePath], repoPath, env);
      } catch {
        // ignore
      }
      try {
        await runGit(['-C', repoPath, 'worktree', 'prune'], repoPath, env);
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
  });
}
