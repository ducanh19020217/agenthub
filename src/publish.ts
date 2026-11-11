import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskRow, ProjectRow, ProfileRow } from './db/index.js';
import type { AgentHubConfig } from './config.js';
import type { Engine } from './engines/index.js';
import { CLAUDE_REVIEW_ENGINE_KEY } from './engines/claude-review.js';
import { projectSettings } from './projects/settings.js';
import { parseRemote } from './integrations/gitea/client.js';
import { HttpError } from './services/index.js';
import {
  buildPrePublishAuditPrompt,
  parsePrePublishAuditOutput,
  isAuditPassed,
  getCachedAuditPass,
  setCachedAuditPass,
  type PrePublishAuditResult,
  type PrePublishAuditFinding,
} from './pre-publish-audit.js';

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
    getByProject?(projectId: string): TaskRow[];
  };
  projectRepo: {
    get(id: string): ProjectRow | undefined;
  };
  eventBus: {
    emit(event: string, ...args: unknown[]): void;
  };
  hubHome: string;
  engines?: Map<string, Engine>;
  profileRepo?: {
    get(name: string): ProfileRow | undefined;
    getEnabled(): ProfileRow[];
  };
  quotaService?: {
    isExhausted(profileName: string, family: string): boolean;
    mark(profileName: string, family: string, durationSec: number, reason: string): void;
  };
  reviewRepo?: {
    insert(review: Record<string, unknown>): void;
    getByTask(taskId: string): Array<{ verdict: string; feedback?: string | null; actor?: string | null }>;
  };
  config?: AgentHubConfig;
  notifyService?: {
    notify(message: string, level?: string): void;
  };
}

export interface PublishSuccessResult {
  ok: true;
  remote: string;
  branch: string;
  commit: string;
  compareUrl?: string;
  pushedIntegrationBranch: boolean;
  auditPassed?: boolean;
  auditSkipped?: boolean;
}

export interface PublishFailedResult {
  ok: false;
  error: string;
  remote: string;
  branch: string;
  auditFailed?: boolean;
  retryable?: boolean;
  findings?: PrePublishAuditFinding[];
}

export interface PublishSkippedResult {
  ok: true;
  skipped: true;
  reason: string;
}

export type PublishResult = PublishSuccessResult | PublishFailedResult | PublishSkippedResult;

/**
 * Checks if a commit is an ancestor of a base ref.
 */
async function isAncestor(repoPath: string, commit: string, base: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', commit, base], { env });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the merge commit that merged a task's branch into the integration or target branch.
 */
export async function findMergeCommitForTask(
  repoPath: string,
  task: TaskRow,
  candidateBranches: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const taskBranch = task.branch || `agenthub/${task.slug}`;
  const branchRef = `refs/heads/${taskBranch}`;
  const hasBranch = await refExists(repoPath, branchRef, env);

  const validRefs: string[] = [];
  for (const b of candidateBranches) {
    if (!b) continue;
    const bRef = `refs/heads/${b}`;
    if (await refExists(repoPath, bRef, env)) {
      if (!validRefs.includes(bRef)) validRefs.push(bRef);
    } else if (await refExists(repoPath, b, env)) {
      if (!validRefs.includes(b)) validRefs.push(b);
    }
  }
  if (validRefs.length === 0 && (await refExists(repoPath, 'HEAD', env))) {
    validRefs.push('HEAD');
  }

  for (const searchRef of validRefs) {
    if (hasBranch) {
      try {
        const tip = await runGit(['-C', repoPath, 'rev-parse', branchRef], repoPath, env);
        const out = await runGit(
          ['-C', repoPath, 'log', '--merges', '--first-parent', '--ancestry-path', `${tip}..${searchRef}`, '--reverse', '--format=%H'],
          repoPath,
          env,
        );
        const firstLine = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
        if (firstLine) return firstLine;
      } catch {
        // ignore
      }
    }

    // Fallback: search merge commits by branch name or slug in commit message
    for (const pattern of [taskBranch, task.slug]) {
      if (!pattern) continue;
      try {
        const out = await runGit(
          ['-C', repoPath, 'log', '--merges', '--first-parent', `--grep=${pattern}`, '--reverse', '--format=%H', searchRef],
          repoPath,
          env,
        );
        const firstLine = out.split('\n').map((l) => l.trim()).filter(Boolean)[0];
        if (firstLine) return firstLine;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

/**
 * Returns number of audit fix rounds already completed by this task.
 */
function getTaskAuditRounds(task: TaskRow, deps: PublishTaskDeps): number {
  if (deps.reviewRepo?.getByTask) {
    try {
      const reviews = deps.reviewRepo.getByTask(task.id);
      const auditReviews = reviews.filter((r) => r.actor === 'audit-prepublish');
      if (auditReviews.length > 0) return auditReviews.length;
    } catch {
      // ignore
    }
  }
  if (task.pushResult) {
    try {
      const pr = JSON.parse(task.pushResult);
      if (typeof pr.auditFixRounds === 'number') return pr.auditFixRounds;
    } catch {
      // ignore
    }
  }
  return 0;
}

/**
 * Extracts diff and changed files for a specific task.
 * Prioritizes merge commit diff (<merge>^1 <merge>) to capture conflict resolution.
 */
export async function getTaskDiff(
  repoPath: string,
  task: TaskRow,
  sourceBranch: string,
  targetBranch: string,
  baseRef: string,
  env: NodeJS.ProcessEnv,
): Promise<{ diff: string; changedFiles: string[]; commitSha: string; branchSha?: string }> {
  let commitSha = '';
  let branchSha: string | undefined;
  let diff = '';
  let changedFiles: string[] = [];

  const taskBranch = task.branch || `agenthub/${task.slug}`;
  const branchExists = await refExists(repoPath, `refs/heads/${taskBranch}`, env);
  if (branchExists) {
    try {
      branchSha = await runGit(['-C', repoPath, 'rev-parse', `refs/heads/${taskBranch}`], repoPath, env);
    } catch {
      // ignore
    }
  }

  // 1. Prioritize merge commit on sourceBranch or targetBranch
  const mergeCommit = await findMergeCommitForTask(repoPath, task, [sourceBranch, targetBranch], env);
  if (mergeCommit) {
    try {
      commitSha = mergeCommit;
      diff = await runGit(['-C', repoPath, 'diff', `${mergeCommit}^1`, mergeCommit], repoPath, env);
      const filesOut = await runGit(['-C', repoPath, 'diff', '--name-only', `${mergeCommit}^1`, mergeCommit], repoPath, env);
      changedFiles = filesOut.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      // ignore
    }
  }

  // 2. If no merge commit or diff empty, and task branch exists, use merge-base..branch
  if (!diff && branchExists) {
    try {
      if (!commitSha && branchSha) {
        commitSha = branchSha;
      }
      let effectiveBase = baseRef;
      if (!(await refExists(repoPath, effectiveBase, env))) {
        effectiveBase = (await refExists(repoPath, `refs/heads/${sourceBranch}`, env))
          ? `refs/heads/${sourceBranch}`
          : (await refExists(repoPath, `refs/heads/${targetBranch}`, env))
            ? `refs/heads/${targetBranch}`
            : 'HEAD';
      }
      const mergeBase = await runGit(['-C', repoPath, 'merge-base', effectiveBase, `refs/heads/${taskBranch}`], repoPath, env);
      diff = await runGit(['-C', repoPath, 'diff', `${mergeBase}..refs/heads/${taskBranch}`], repoPath, env);
      const filesOut = await runGit(['-C', repoPath, 'diff', '--name-only', `${mergeBase}..refs/heads/${taskBranch}`], repoPath, env);
      changedFiles = filesOut.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      // Fallback
    }
  }

  // 3. Fallback for commitSha
  if (!commitSha) {
    commitSha = branchSha || 'HEAD';
    if (commitSha === 'HEAD') {
      try {
        commitSha = await runGit(['-C', repoPath, 'rev-parse', 'HEAD'], repoPath, env);
      } catch {
        commitSha = 'HEAD';
      }
    }
  }

  if (!diff && task.diffStat) {
    diff = task.diffStat;
  }

  return { diff, changedFiles, commitSha, branchSha };
}

/**
 * Identifies tasks merged into sourceBranch or targetBranch but not yet pushed to remote target branch.
 * Uses range remote/target..source to exclude tasks already present in remote/target.
 */
async function findTasksToAudit(
  taskId: string,
  projectId: string,
  sourceBranch: string,
  targetBranch: string,
  remote: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
  deps: PublishTaskDeps,
): Promise<TaskRow[]> {
  const mainTask = deps.taskRepo.get(taskId);
  const allTasks = deps.taskRepo.getByProject
    ? deps.taskRepo.getByProject(projectId)
    : (deps.taskRepo as unknown as { list?: (f: { project: string }) => TaskRow[] }).list?.({ project: projectId }) || (mainTask ? [mainTask] : []);

  const remoteTargetRef = `refs/remotes/${remote}/${targetBranch}`;
  const hasRemoteTarget = await refExists(repoPath, remoteTargetRef, env);
  const sourceRef = `refs/heads/${sourceBranch}`;
  const hasSource = await refExists(repoPath, sourceRef, env);
  const targetRef = `refs/heads/${targetBranch}`;
  const hasTarget = await refExists(repoPath, targetRef, env);

  const doneTasks = allTasks.filter((t) => t.status === 'done');
  const tasksToAudit: TaskRow[] = [];

  for (const t of doneTasks) {
    const tBranch = t.branch || `agenthub/${t.slug}`;
    const branchRef = `refs/heads/${tBranch}`;
    const branchExists = await refExists(repoPath, branchRef, env);
    const mergeCommit = await findMergeCommitForTask(repoPath, t, [sourceBranch, targetBranch], env);

    const taskRef = branchExists ? branchRef : mergeCommit;

    if (!taskRef) {
      if (t.id === taskId) {
        tasksToAudit.push(t);
      }
      continue;
    }

    // Check if task is already pushed to remote target
    const alreadyPushed = hasRemoteTarget
      ? await isAncestor(repoPath, taskRef, remoteTargetRef, env)
      : false;

    if (alreadyPushed) {
      continue;
    }

    let mergedToPushTarget = false;
    if (hasSource && (await isAncestor(repoPath, taskRef, sourceRef, env))) {
      mergedToPushTarget = true;
    } else if (hasTarget && (await isAncestor(repoPath, taskRef, targetRef, env))) {
      mergedToPushTarget = true;
    } else if (branchExists && t.id === taskId) {
      mergedToPushTarget = true;
    }

    if (mergedToPushTarget || t.id === taskId) {
      tasksToAudit.push(t);
    }
  }

  if (tasksToAudit.length === 0 && mainTask && (mainTask.status === 'done' || mainTask.status === 'pushed')) {
    tasksToAudit.push(mainTask);
  }

  return tasksToAudit;
}

/**
 * Runs the read-only pre-publish audit agent using reviewer engine infrastructure.
 */
async function runAuditAgentForTask(
  task: TaskRow,
  project: ProjectRow,
  repoPath: string,
  deps: PublishTaskDeps,
  diff: string,
  changedFiles: string[],
  doneReport: string,
  commitSha?: string,
): Promise<
  | { ok: true; result: PrePublishAuditResult; engineId: string; profileName: string }
  | { ok: false; error: string; retryable: boolean; isQuota?: boolean }
> {
  const currentSettings = projectSettings(project);
  const reviewerOrder = (currentSettings.review?.order && currentSettings.review.order.length > 0)
    ? currentSettings.review.order
    : (deps.config?.reviewer?.order && deps.config.reviewer.order.length > 0)
      ? deps.config.reviewer.order
      : [
          { engine: 'codex', model: 'gpt-5.6-luna', profiles: [] },
          { engine: 'claude', model: 'sonnet', profiles: [] },
        ];

  let chosenEngine: Engine | undefined;
  let chosenProfile: ProfileRow | undefined;
  let chosenModel = 'gpt-5.6-luna';

  const enabledProfiles = deps.profileRepo?.getEnabled() || [];

  for (const item of reviewerOrder) {
    const engineKey = item.engine === 'claude' ? CLAUDE_REVIEW_ENGINE_KEY : 'codex';
    const engine = deps.engines?.get(engineKey) || (item.engine === 'codex' ? deps.engines?.get('codex') : undefined);
    if (!engine) continue;

    const family = item.engine === 'claude' ? 'claude' : 'codex';
    const candidates = enabledProfiles.filter((p) => {
      if (p.engine !== item.engine) return false;
      if (item.profiles && item.profiles.length > 0 && !(item.profiles as readonly string[]).includes(p.name)) return false;
      if (p.authState != null && p.authState !== 'ok') return false;
      if (deps.quotaService?.isExhausted(p.name, family)) return false;
      return true;
    });

    if (candidates.length > 0) {
      chosenEngine = engine;
      chosenProfile = candidates[0];
      chosenModel = item.model || (item.engine === 'claude' ? 'sonnet' : 'gpt-5.6-luna');
      break;
    }
  }

  // Fallback: search any engine in deps.engines that has an enabled profile
  if (!chosenEngine || !chosenProfile) {
    if (deps.engines) {
      for (const [key, engine] of deps.engines.entries()) {
        const engName = key === CLAUDE_REVIEW_ENGINE_KEY ? 'claude' : 'codex';
        const p = enabledProfiles.find(
          (prof) => prof.engine === engName && !deps.quotaService?.isExhausted(prof.name, engName),
        );
        if (p) {
          chosenEngine = engine;
          chosenProfile = p;
          chosenModel = engName === 'claude' ? 'sonnet' : 'gpt-5.6-luna';
          break;
        }
      }
    }
  }

  if (!chosenEngine || !chosenProfile) {
    return {
      ok: false,
      error: 'Không tìm thấy reviewer engine hoặc profile khả dụng để chạy audit',
      retryable: true,
    };
  }

  const prompt = buildPrePublishAuditPrompt({
    taskId: task.id,
    taskTitle: task.title,
    taskBody: task.body || task.title,
    diff,
    changedFiles,
    doneReport,
    repoPath,
    commitSha,
  });

  const tmpDir = path.join(deps.hubHome, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const runId = crypto.randomUUID();
  const logPath = path.join(tmpDir, `audit-${task.id.replace('/', '_')}-${runId}.log`);
  const outputPath = path.join(tmpDir, `audit-${task.id.replace('/', '_')}-${runId}.final.json`);

  let child: ChildProcess;
  try {
    child = chosenEngine.spawn({
      profile: chosenProfile,
      model: chosenModel,
      cwd: repoPath,
      prompt,
      logPath,
      outputPath,
      readOnly: true,
      env: { AGENTHUB_TASK_ID: task.id, AGENTHUB_AUDIT: '1' },
      hubHome: deps.hubHome,
      project,
      workerCount: 1,
    });
  } catch (err) {
    return {
      ok: false,
      error: `Không thể spawn audit process: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  const timeoutSec = (currentSettings.publish?.audit as { timeoutSec?: number })?.timeoutSec ?? 300;
  const timeoutMs = timeoutSec * 1000;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const exitPromise = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once('error', (err) => resolve({ code: null, error: err }));
    child.once('exit', (code) => resolve({ code }));
  });
  const timeoutPromise = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    timeoutTimer = setTimeout(() => {
      const pid = child.pid;
      if (pid) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
          try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        }, 2000).unref();
      }
      resolve({ code: null, error: new Error(`Audit process timeout sau ${timeoutSec} giây`) });
    }, timeoutMs);
  });

  let code: number | null = null;
  let error: Error | undefined;
  try {
    const outcome = await Promise.race([exitPromise, timeoutPromise]);
    code = outcome.code;
    error = outcome.error;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  let logOutput = '';
  let fileOutput = '';
  if (fs.existsSync(logPath)) {
    try { logOutput = fs.readFileSync(logPath, 'utf8'); } catch { /* ignore */ }
  }
  if (fs.existsSync(outputPath)) {
    try { fileOutput = fs.readFileSync(outputPath, 'utf8'); } catch { /* ignore */ }
  }

  try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* ignore */ }
  try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch { /* ignore */ }

  const quota = chosenEngine.detectQuota(`${logOutput}\n${fileOutput}`).exhausted;
  if (quota) {
    deps.quotaService?.mark(
      chosenProfile.name,
      chosenProfile.engine === 'claude' ? 'claude' : 'codex',
      300,
      'Pre-publish audit quota exhausted',
    );
    return {
      ok: false,
      error: 'Hết quota reviewer khi audit trước khi publish',
      retryable: true,
      isQuota: true,
    };
  }

  if (error || code !== 0) {
    return {
      ok: false,
      error: `Audit agent gặp lỗi (exit code: ${code}): ${error?.message || logOutput.slice(-300) || 'Lỗi không xác định'}`,
      retryable: true,
    };
  }

  const parsed = parsePrePublishAuditOutput(fileOutput || logOutput);
  if (!parsed) {
    return {
      ok: false,
      error: 'Output audit không đúng định dạng schema JSON',
      retryable: true,
    };
  }

  return { ok: true, result: parsed, engineId: chosenProfile.engine, profileName: chosenProfile.name };
}

/**
 * Execute the publish workflow for a completed task with pre-publish audit gate.
 */
export async function publishTask(
  taskId: string,
  deps: PublishTaskDeps,
  options?: { manual?: boolean; skipAudit?: boolean },
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
      return { ok: false, error: errorMsg, remote, branch: targetBranch, retryable: true };
    }

    // Fetch remote target branch early so refs/remotes/<remote>/<targetBranch> is fresh
    try {
      await runGit(['-C', repoPath, 'fetch', remote, targetBranch], repoPath, env);
    } catch {
      try {
        await runGit(['-C', repoPath, 'fetch', remote], repoPath, env);
      } catch {
        // Non-fatal if remote has no matching ref or is new/empty
      }
    }

    const remoteRef = `refs/remotes/${remote}/${targetBranch}`;
    let prevRemoteSha: string | null = null;
    if (await refExists(repoPath, remoteRef, env)) {
      prevRemoteSha = await runGit(['-C', repoPath, 'rev-parse', remoteRef], repoPath, env);
    }
    const auditBaseRef = prevRemoteSha
      ? remoteRef
      : ((await refExists(repoPath, `refs/heads/${targetBranch}`, env)) ? `refs/heads/${targetBranch}` : targetBranch);

    // --- Pre-Publish Audit Gate ---
    const isManual = Boolean(options?.manual);
    const isSkipAudit = isManual && Boolean(options?.skipAudit);
    const isAuditConfigEnabled = currentSettings.publish?.audit?.enabled !== false;

    if (isSkipAudit) {
      deps.eventBus.emit('task.audit_skipped', taskId, {
        taskId,
        projectId: currentProject.id,
        manual: true,
      });
    } else if (isAuditConfigEnabled) {
      const tasksToAudit = await findTasksToAudit(
        taskId,
        currentProject.id,
        sourceBranch,
        targetBranch,
        remote,
        repoPath,
        env,
        deps,
      );

      for (const t of tasksToAudit) {
        const { diff, changedFiles, commitSha, branchSha } = await getTaskDiff(
          repoPath,
          t,
          sourceBranch,
          targetBranch,
          auditBaseRef,
          env,
        );

        const cached = getCachedAuditPass(t.id, commitSha) || (branchSha ? getCachedAuditPass(t.id, branchSha) : undefined);
        if (cached) {
          continue;
        }

        let doneReport = t.doneReport || '';
        if (!doneReport && t.worktreePath) {
          try {
            const doneFile = path.join(t.worktreePath, '.agenthub', 'DONE');
            if (fs.existsSync(doneFile)) {
              doneReport = fs.readFileSync(doneFile, 'utf8');
            }
          } catch {
            // ignore read error
          }
        }

        deps.eventBus.emit('task.audit_started', t.id, {
          taskId: t.id,
          projectId: currentProject.id,
        });

        const auditExec = await runAuditAgentForTask(
          t,
          currentProject,
          repoPath,
          deps,
          diff,
          changedFiles,
          doneReport,
          commitSha,
        );

        if (!auditExec.ok) {
          // Fail closed
          const errorMsg = auditExec.error;
          const failedAt = new Date().toISOString();
          deps.taskRepo.update(t.id, {
            pushResult: JSON.stringify({
              error: errorMsg,
              failedAt,
              retryable: true,
              auditFailed: true,
            }),
          });
          if (taskId !== t.id) {
            deps.taskRepo.update(taskId, {
              pushResult: JSON.stringify({
                error: `Audit thất bại ở task ${t.slug}: ${errorMsg}`,
                failedAt,
                retryable: true,
                auditFailed: true,
              }),
            });
          }
          deps.eventBus.emit('task.push_failed', t.id, {
            taskId: t.id,
            projectId: currentProject.id,
            error: errorMsg,
            remote,
            branch: targetBranch,
          });
          return { ok: false, error: errorMsg, remote, branch: targetBranch, auditFailed: true, retryable: true };
        }

        const auditResult = auditExec.result;
        const passed = isAuditPassed(auditResult);

        if (passed) {
          setCachedAuditPass(t.id, commitSha, auditResult);
          if (branchSha && branchSha !== commitSha) {
            setCachedAuditPass(t.id, branchSha, auditResult);
          }
          deps.eventBus.emit('task.audit_passed', t.id, {
            taskId: t.id,
            projectId: currentProject.id,
            findings: auditResult.findings,
            summary: auditResult.summary,
          });
        } else {
          // Task failed audit
          const hasCriticalOrMajor = auditResult.findings.some((f) => f.severity === 'P1' || f.severity === 'P2');
          if (!hasCriticalOrMajor) {
            // Verdict fail without P1/P2 findings -> indeterminate: fail-closed, retryable, no push, DO NOT return task to worker
            const failedAt = new Date().toISOString();
            const errorMsg = `Audit trả về verdict 'fail' nhưng không có lỗi P1/P2: ${auditResult.summary || 'kết quả không xác định'}`;
            deps.taskRepo.update(t.id, {
              pushResult: JSON.stringify({
                state: 'push_failed',
                error: errorMsg,
                failedAt,
                retryable: true,
                auditFailed: true,
                findings: auditResult.findings,
                summary: auditResult.summary,
              }),
            });
            if (taskId !== t.id) {
              deps.taskRepo.update(taskId, {
                pushResult: JSON.stringify({
                  blockedByTask: t.slug,
                  blockedByTaskId: t.id,
                  error: `Bị chặn bởi task ${t.slug}: ${errorMsg}`,
                  failedAt,
                  retryable: true,
                }),
              });
            }
            deps.eventBus.emit('task.push_failed', t.id, {
              taskId: t.id,
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
              auditFailed: true,
              retryable: true,
            };
          }

          // Task failed audit (P1 or P2)
          const maxFixRounds = currentSettings.publish?.audit?.maxFixRounds ?? 2;
          const currentAuditRounds = getTaskAuditRounds(t, deps);

          if (currentAuditRounds >= maxFixRounds) {
            // Exceeded maxFixRounds -> stop, do not return to worker
            // Emit task.audit_failed ONCE with exceededMaxRounds: true
            deps.eventBus.emit('task.audit_failed', t.id, {
              taskId: t.id,
              projectId: currentProject.id,
              exceededMaxRounds: true,
              maxFixRounds,
              findings: auditResult.findings,
              summary: auditResult.summary,
            });

            const failedAt = new Date().toISOString();
            const pushResultObj = {
              auditFailed: true,
              exceededMaxRounds: true,
              maxFixRounds,
              auditFixRounds: currentAuditRounds,
              findings: auditResult.findings,
              summary: auditResult.summary,
              failedAt,
              retryable: false,
              error: `Task ${t.slug} vượt quá số vòng sửa tối đa (${maxFixRounds}) khi audit`,
            };
            deps.taskRepo.update(t.id, {
              pushResult: JSON.stringify(pushResultObj),
            });
            if (taskId !== t.id) {
              deps.taskRepo.update(taskId, {
                pushResult: JSON.stringify({
                  auditFailed: true,
                  error: `Chặn publish do task ${t.slug} vượt quá số vòng sửa audit (${maxFixRounds})`,
                  failedAt,
                  retryable: false,
                }),
              });
            }

            return {
              ok: false,
              error: `Task ${t.slug} vượt quá số vòng sửa tối đa (${maxFixRounds})`,
              remote,
              branch: targetBranch,
              auditFailed: true,
              findings: auditResult.findings,
              retryable: false,
            };
          }

          // Return task to worker
          const nextRound = currentAuditRounds + 1;
          const failedAt = new Date().toISOString();
          const pushResultObj = {
            auditFailed: true,
            auditFixRounds: nextRound,
            findings: auditResult.findings,
            summary: auditResult.summary,
            failedAt,
            retryable: false,
            error: `Audit trước khi publish thất bại: ${auditResult.summary}`,
          };
          deps.taskRepo.update(t.id, {
            pushResult: JSON.stringify(pushResultObj),
          });
          if (taskId !== t.id) {
            deps.taskRepo.update(taskId, {
              pushResult: JSON.stringify({
                auditFailed: true,
                error: `Chặn publish do task ${t.slug} không vượt qua audit`,
                failedAt,
                retryable: false,
              }),
            });
          }

          // Emit task.audit_failed ONCE (without exceededMaxRounds)
          deps.eventBus.emit('task.audit_failed', t.id, {
            taskId: t.id,
            projectId: currentProject.id,
            exceededMaxRounds: false,
            findings: auditResult.findings,
            summary: auditResult.summary,
          });

          const feedback = [
            '### Kết quả Audit trước khi publish thất bại',
            auditResult.summary,
            '\nCác vấn đề phát hiện:',
            ...auditResult.findings.map(
              (f, idx) => `${idx + 1}. [${f.severity}] [${f.kind}] ${f.file}:${f.line} - ${f.detail}`,
            ),
          ].join('\n');

          deps.reviewRepo?.insert({
            id: crypto.randomUUID(),
            taskId: t.id,
            verdict: 'changes_requested',
            feedback,
            actor: 'audit-prepublish',
            engine: auditExec.engineId,
            profileName: auditExec.profileName,
          });

          const newBody = `${t.body || ''}\n\n## Feedback audit trước khi publish\n\n${feedback}`;
          deps.taskRepo.update(t.id, {
            status: 'queued',
            resume: 1,
            reviewStep: 0,
            reviewerChangesRequested: (t.reviewerChangesRequested || 0) + 1,
            body: newBody,
          });

          if (t.worktreePath && fs.existsSync(t.worktreePath)) {
            const doneFile = path.join(t.worktreePath, '.agenthub', 'DONE');
            const blockedFile = path.join(t.worktreePath, '.agenthub', 'BLOCKED');
            try { if (fs.existsSync(doneFile)) fs.unlinkSync(doneFile); } catch { /* ignore */ }
            try { if (fs.existsSync(blockedFile)) fs.unlinkSync(blockedFile); } catch { /* ignore */ }
            const taskMdFile = path.join(t.worktreePath, '.agenthub', 'task.md');
            try { fs.writeFileSync(taskMdFile, newBody, 'utf8'); } catch { /* ignore */ }
          }

          deps.eventBus.emit('task.queued', t.id, {
            reason: 'changes_requested',
            by: 'audit-prepublish',
            verdict: 'changes_requested',
            feedback,
          });

          return {
            ok: false,
            error: 'Audit trước khi publish thất bại',
            remote,
            branch: targetBranch,
            auditFailed: true,
            findings: auditResult.findings,
            retryable: false,
          };
        }
      }
    }

    // Prepare temp detached worktree
    const tmpDir = path.join(deps.hubHome, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(
      tmpDir,
      `publish-${currentProject.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );

    try {
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
        auditPassed: !isSkipAudit && isAuditConfigEnabled,
        auditSkipped: isSkipAudit,
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
        auditPassed: !isSkipAudit && isAuditConfigEnabled,
        auditSkipped: isSkipAudit,
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
