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
  auditFollowUpFindings,
  formatAuditFindings,
  parseAuditFeedbackFindings,
  getCachedAuditPass,
  setCachedAuditPass,
  type PrePublishAuditResult,
  type PrePublishAuditFinding,
} from './pre-publish-audit.js';

const execFileAsync = promisify(execFile);

const activePublishProjects = new Set<string>();
const publishLockReleaseListeners = new Map<string, Array<() => void>>();

export function isProjectPublishing(projectId: string): boolean {
  return activePublishProjects.has(projectId);
}

export function onProjectPublishLockReleased(projectId: string, callback: () => void): () => void {
  let list = publishLockReleaseListeners.get(projectId);
  if (!list) {
    list = [];
    publishLockReleaseListeners.set(projectId, list);
  }
  list.push(callback);
  return () => {
    const arr = publishLockReleaseListeners.get(projectId);
    if (arr) {
      const idx = arr.indexOf(callback);
      if (idx !== -1) arr.splice(idx, 1);
    }
  };
}

const lastProjectPublishError = new Map<string, string>();

export function clearPublishLocks(): void {
  activePublishProjects.clear();
  publishLockReleaseListeners.clear();
  lastProjectPublishError.clear();
}

export function normalizePublishErrorKey(errorMsg: string): string {
  return errorMsg
    .replace(/[0-9a-f]{7,40}/gi, '<sha>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/\b[\w.-]+\/task-[\w.-]+\b/gi, '<task>')
    .replace(/\btask-[\w.-]+\b/gi, '<task>')
    .trim();
}

function emitPushFailed(
  deps: PublishTaskDeps,
  taskId: string,
  projectId: string,
  errorMsg: string,
  remote?: string,
  branch?: string,
  isManual = false,
) {
  const normKey = normalizePublishErrorKey(errorMsg);
  const lastError = lastProjectPublishError.get(projectId);
  const isRepeat = lastError === normKey;
  lastProjectPublishError.set(projectId, normKey);

  const suppressNotification = !isManual && isRepeat;

  deps.eventBus.emit('task.push_failed', taskId, {
    taskId,
    projectId,
    error: errorMsg,
    remote,
    branch,
    suppressNotification,
  });
}

/**
 * Ensures single execution of publish workflow per project without queuing up.
 */
export async function withProjectPublishLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  if (activePublishProjects.has(projectId)) {
    throw new HttpError(409, 'conflict', `Dự án đang trong quá trình publish`);
  }
  activePublishProjects.add(projectId);
  try {
    return await fn();
  } finally {
    activePublishProjects.delete(projectId);
    const listeners = publishLockReleaseListeners.get(projectId);
    if (listeners && listeners.length > 0) {
      publishLockReleaseListeners.delete(projectId);
      for (const cb of listeners) {
        try {
          cb();
        } catch (e) {
          console.error(`[publish] Error in publish lock release listener for project ${projectId}:`, e);
        }
      }
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

/**
 * Like refExists, but only "ref is missing" (exit code 1 from
 * `rev-parse --verify --quiet`) returns false; any other git failure throws so
 * fail-closed callers cannot mistake an error for an absent ref.
 */
async function refExistsStrict(repo: string, ref: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], { env });
    return true;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 1) {
      return false;
    }
    throw err;
  }
}

/**
 * Resolve the commit the pre-publish audit diff is measured from.
 *
 * The base must be the remote state of the branch being published:
 * - `refs/remotes/<remote>/<targetBranch>` itself, or
 * - a SHA that is proven (via `git merge-base --is-ancestor`) to be on that ref.
 *
 * Anything else — another remote branch, the task's own baseRef, a local-only
 * SHA, a missing target remote ref, or a git error while verifying ancestry —
 * fails closed by throwing. There is deliberately no fallback.
 */
async function resolveRemoteAuditBase(
  repoPath: string,
  baseRef: string,
  targetBranch: string,
  remote: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const targetRemoteRef = `refs/remotes/${remote}/${targetBranch}`;
  const fail = (reason: string): never => {
    throw new Error(
      `Failed to resolve remote base commit for audit diff (baseRef: "${baseRef}", targetBranch: "${targetBranch}", remote: "${remote}"): ${reason}. Remote base is required and cannot fall back to another ref or a local snapshot.`,
    );
  };

  if (!(await refExists(repoPath, targetRemoteRef, env))) {
    fail(`remote tracking ref ${targetRemoteRef} does not exist`);
  }

  if (/^[0-9a-f]{40}$/i.test(baseRef)) {
    // isAncestor returns false only for "not an ancestor" (exit 1); real git
    // errors propagate and therefore fail closed.
    if (!(await isAncestor(repoPath, baseRef, targetRemoteRef, env))) {
      fail(`commit ${baseRef} is not on ${targetRemoteRef}`);
    }
    return (await runGit(['-C', repoPath, 'rev-parse', '--verify', `${baseRef}^{commit}`], repoPath, env)).trim();
  }

  // A bare target branch name means "the target branch" and is resolved to its
  // remote tracking ref, never to the local branch.
  const acceptedNames = new Set(['', targetBranch, targetRemoteRef, `${remote}/${targetBranch}`]);
  if (!acceptedNames.has(baseRef)) {
    fail(`baseRef does not point to ${targetRemoteRef}`);
  }
  return (await runGit(['-C', repoPath, 'rev-parse', '--verify', `${targetRemoteRef}^{commit}`], repoPath, env)).trim();
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
    getByTask(taskId: string): Array<{ verdict: string; feedback?: string | null; actor?: string | null; createdAt?: string }>;
  };
  runRepo?: {
    getByTask(taskId: string): Array<{ id: string; outcome?: string | null; startedAt?: string | null; endedAt?: string | null }>;
  };
  config?: AgentHubConfig;
  /**
   * Creates a queued follow-up task for non-blocking (P2) audit findings of a pushed task.
   * Returns the new task id, or null when none was created (e.g. the task is itself a follow-up).
   */
  createFollowUpTask?(task: TaskRow, findings: PrePublishAuditFinding[]): string | null;
  /** Latest stored results of the project checks the hub ran for a task. */
  getCheckResults?(taskId: string): Array<{ name: string; ok: boolean; outputTail?: string }>;
}

export type LocalBranchUpdateStatus = 'updated' | 'skipped_dirty';

export interface PublishSuccessResult {
  ok: true;
  remote: string;
  branch: string;
  commit: string;
  compareUrl?: string;
  pushedIntegrationBranch: boolean;
  auditPassed?: boolean;
  auditSkipped?: boolean;
  findings?: PrePublishAuditFinding[];
  localUpdate?: LocalBranchUpdateStatus;
  auditRange?: string;
}

export interface PublishFailedResult {
  ok: false;
  error: string;
  remote: string;
  branch: string;
  auditFailed?: boolean;
  retryable?: boolean;
  findings?: PrePublishAuditFinding[];
  auditRange?: string;
}

export interface PublishSkippedResult {
  ok: true;
  skipped: true;
  reason: string;
}

export type PublishResult = PublishSuccessResult | PublishFailedResult | PublishSkippedResult;

/**
 * Checks if a commit is an ancestor of a base ref.
 * Returns true if ancestor, false if not an ancestor (exit code 1).
 * Throws on any fatal git error or execution failure (fail closed).
 */
export async function isAncestor(
  repoPath: string,
  commit: string,
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', commit, base], { env });
    return true;
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 1) {
      return false;
    }
    throw err;
  }
}

/**
 * Checks if a commit is in the first-parent lineage of a base ref.
 * Throws on any fatal git error or execution failure (fail closed).
 */
export async function isFirstParentAncestor(
  repoPath: string,
  commit: string,
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const list = await runGit(['-C', repoPath, 'rev-list', '--first-parent', base], repoPath, env);
  const hashes = new Set(list.split('\n').map((h) => h.trim()).filter(Boolean));
  return hashes.has(commit);
}

export interface TaskMergeCandidatesResult {
  forwardMerges: string[];
  rejectedMerges: string[];
}

/**
 * Find merge candidates for a task's branch into the integration or target branch,
 * separating verified forward merges from rejected merges (reverse merges or unverified ancestry).
 */
export async function findMergeCandidatesForTask(
  repoPath: string,
  task: TaskRow,
  candidateBranches: string[],
  env: NodeJS.ProcessEnv,
  failClosed = false,
  requireTaskRef = false,
): Promise<TaskMergeCandidatesResult> {
  const taskBranch = task.branch || `agenthub/${task.slug}`;
  let branchRef = `refs/heads/${taskBranch}`;
  // In fail-closed mode a git error while reading a ref that exists (or while
  // checking whether it exists) must stop discovery, not be treated as "the
  // task branch is gone" and fall through to ancestry/message heuristics.
  const exists = (ref: string) => (failClosed ? refExistsStrict(repoPath, ref, env) : refExists(repoPath, ref, env));
  const readSha = async (ref: string): Promise<string | null> => {
    try {
      return (await runGit(['-C', repoPath, 'rev-parse', '--verify', `${ref}^{commit}`], repoPath, env)).trim() || null;
    } catch (err) {
      if (failClosed) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to verify task branch ref "${ref}" for audit discovery: ${reason}`);
      }
      return null;
    }
  };

  let hasBranch = await exists(branchRef);
  let branchSha: string | null = null;
  if (hasBranch) {
    branchSha = await readSha(branchRef);
    if (!branchSha) hasBranch = false;
  }

  if (!hasBranch) {
    const candidateTaskRefs = [
      `refs/remotes/origin/${taskBranch}`,
      `origin/${taskBranch}`,
      task.sourceRef,
      task.branch,
      taskBranch,
    ].filter(Boolean) as string[];
    for (const refName of candidateTaskRefs) {
      if (await exists(refName)) {
        const sha = await readSha(refName);
        if (sha) {
          branchSha = sha;
          branchRef = refName;
          hasBranch = true;
          break;
        }
      }
    }
  }

  // Without any ref of the task branch there is no way to prove which merge
  // parent carries the task's commits; commit-message / log heuristics are not
  // proof. When the caller needs a verified task source, fail closed.
  if (requireTaskRef && (!hasBranch || !branchSha)) {
    throw new Error(
      `Cannot verify task source for audit discovery: no ref of task branch "${taskBranch}" exists (checked refs/heads, remote tracking refs and sourceRef).`,
    );
  }

  const validRefs: string[] = [];
  for (const b of candidateBranches) {
    if (!b) continue;
    if (b === taskBranch || b === task.branch || b === branchRef) continue;
    if (branchSha && b === branchSha) continue;
    const bRef = `refs/heads/${b}`;
    if (await exists(bRef)) {
      if (bRef !== branchRef && !validRefs.includes(bRef)) {
        if (!branchSha) {
          validRefs.push(bRef);
        } else {
          try {
            const resolved = (await runGit(['-C', repoPath, 'rev-parse', bRef], repoPath, env)).trim();
            if (resolved !== branchSha) validRefs.push(bRef);
          } catch (err) {
            if (failClosed) throw err;
            validRefs.push(bRef);
          }
        }
      }
    } else if (await exists(b)) {
      if (b !== branchRef && !validRefs.includes(b)) {
        if (!branchSha) {
          validRefs.push(b);
        } else {
          try {
            const resolved = (await runGit(['-C', repoPath, 'rev-parse', b], repoPath, env)).trim();
            if (resolved !== branchSha) validRefs.push(b);
          } catch (err) {
            if (failClosed) throw err;
            validRefs.push(b);
          }
        }
      }
    }
  }
  if (validRefs.length === 0 && (await exists('HEAD'))) {
    let headIsTask = false;
    if (branchSha) {
      try {
        const headSha = (await runGit(['-C', repoPath, 'rev-parse', 'HEAD'], repoPath, env)).trim();
        if (headSha === branchSha) headIsTask = true;
      } catch (err) {
        if (failClosed) throw err;
      }
    }
    if (!headIsTask) {
      validRefs.push('HEAD');
    }
  }

  const patterns = [taskBranch, task.slug].filter(Boolean) as string[];
  const reverseRegexes = patterns.map((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`into\\s+['"/]?(refs/heads/)?(agenthub/)?${escaped}(['"/)]|\\s*$)`, 'i');
  });
  const forwardRegexes = patterns.map((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`Merge\\s+(branch\\s+)?['"/]?(refs/heads/)?(agenthub/)?${escaped}(['"/)]|\\s+into|$)`, 'i');
  });

  const forwardMerges: string[] = [];
  const rejectedMerges: string[] = [];
  const seenMerges = new Set<string>();

  const destRefs: string[] = [];
  if (task.baseRef) {
    if (await exists(`refs/heads/${task.baseRef}`)) {
      destRefs.push(`refs/heads/${task.baseRef}`);
    } else if (await exists(task.baseRef)) {
      destRefs.push(task.baseRef);
    }
  }
  for (const b of candidateBranches) {
    if (b && b !== taskBranch && b !== task.branch && b !== branchRef) {
      const isSha = /^[0-9a-f]{40}$/i.test(b);
      if (!isSha) {
        if (await exists(`refs/heads/${b}`)) {
          const refName = `refs/heads/${b}`;
          if (!destRefs.includes(refName)) destRefs.push(refName);
        } else if (await exists(b)) {
          if (!destRefs.includes(b)) destRefs.push(b);
        }
      }
    }
  }

  for (const searchRef of validRefs) {
    try {
      const logOut = await runGit(
        ['-C', repoPath, 'log', '--merges', '--first-parent', '--format=%H\t%P\t%s', searchRef],
        repoPath,
        env,
      );
      const lines = logOut.split('\n').map((l) => l.trim()).filter(Boolean);

      for (const line of lines) {
        const [hash, parents, ...subjectParts] = line.split('\t');
        if (!hash || !parents) continue;
        const subject = subjectParts.join('\t');
        const [p1, p2] = parents.split(/\s+/).filter(Boolean);
        if (!p1 || !p2) continue;

        // 1. Reverse merge check by commit subject:
        if (reverseRegexes.some((re) => re.test(subject))) {
          if (!rejectedMerges.includes(hash)) rejectedMerges.push(hash);
          continue;
        }

        // 2. Structural parent/ancestry check: p1 must NOT be on the task branch
        let isP1OnTask = false;
        let ancestryVerificationFailed = false;
        if (hasBranch && branchSha) {
          try {
            if (p1 === branchSha || (await isAncestor(repoPath, branchRef, p1, env))) {
              isP1OnTask = true;
            } else if (
              (await isAncestor(repoPath, p1, branchRef, env)) &&
              !(await isAncestor(repoPath, p1, p2, env))
            ) {
              isP1OnTask = true;
            }
          } catch (err) {
            if (failClosed) throw err;
            ancestryVerificationFailed = true;
          }
        } else {
          // When task branch does not exist locally, recover structural parent check from commit data:
          // In a reverse merge (target merged into task), p2 is on the destination/target branch first-parent
          // lineage while p1 is on the task branch.
          const targetRefs = destRefs.filter((d) => d !== hash && d !== p1 && d !== p2);
          if (targetRefs.length === 0) {
            ancestryVerificationFailed = true;
          } else {
            try {
              let p2OnDest = false;
              let p1OnDest = false;
              for (const d of targetRefs) {
                if (await isFirstParentAncestor(repoPath, p2, d, env)) {
                  p2OnDest = true;
                }
                if (await isFirstParentAncestor(repoPath, p1, d, env)) {
                  p1OnDest = true;
                }
              }
              if (p2OnDest && !p1OnDest) {
                isP1OnTask = true;
              }
            } catch (err) {
              if (failClosed) throw err;
              ancestryVerificationFailed = true;
            }
          }
        }

        if (ancestryVerificationFailed || isP1OnTask) {
          // Parent 1 is on the task branch or ancestry verification failed -> reject reverse merge / fail closed
          if (!rejectedMerges.includes(hash)) rejectedMerges.push(hash);
          continue;
        }

        // 3. Forward merge check:
        const isMsgForward = forwardRegexes.some((re) => re.test(subject));
        let isP2OnTask = false;
        if (hasBranch && branchSha) {
          try {
            const p2IsAncestorOfP1 = await isAncestor(repoPath, p2, p1, env);
            if (!p2IsAncestorOfP1) {
              isP2OnTask =
                p2 === branchSha ||
                (await isAncestor(repoPath, p2, branchRef, env)) ||
                (await isAncestor(repoPath, branchRef, p2, env));
            }
          } catch (err) {
            if (failClosed) throw err;
            ancestryVerificationFailed = true;
            if (!rejectedMerges.includes(hash)) rejectedMerges.push(hash);
            continue;
          }
        } else {
          // Task branch ref doesn't exist locally: verify ancestry / parent structure from commit data.
          // In a forward merge:
          // 1. p1 must be on destination (targetRefs) first-parent lineage.
          // 2. p2 must NOT be an ancestor of p1 (feature commits).
          // 3. Commits in p1..p2 or commit subject must match the task.
          const targetRefs = destRefs.filter((d) => d !== hash && d !== p1 && d !== p2);
          if (targetRefs.length === 0) {
            ancestryVerificationFailed = true;
            if (!rejectedMerges.includes(hash)) rejectedMerges.push(hash);
            continue;
          }
          try {
            let p1OnDest = false;
            for (const d of targetRefs) {
              if (await isFirstParentAncestor(repoPath, p1, d, env)) {
                p1OnDest = true;
                break;
              }
            }
            const p2IsAncestorOfP1 = await isAncestor(repoPath, p2, p1, env);
            if (p1OnDest && !p2IsAncestorOfP1) {
              const taskLog = await runGit(
                ['-C', repoPath, 'log', '--format=%s%b', `${p1}..${p2}`],
                repoPath,
                env,
              );
              const lowerLog = taskLog.toLowerCase();
              const taskPatterns = patterns.map((p) => p.toLowerCase());
              const matchesTask =
                taskPatterns.some((pat) => lowerLog.includes(pat)) ||
                (task.title ? lowerLog.includes(task.title.toLowerCase()) : false);
              if (matchesTask) {
                isP2OnTask = true;
              }
            }
          } catch (err) {
            if (failClosed) throw err;
            ancestryVerificationFailed = true;
            if (!rejectedMerges.includes(hash)) rejectedMerges.push(hash);
            continue;
          }
        }

        if (ancestryVerificationFailed) {
          if (!rejectedMerges.includes(hash)) rejectedMerges.push(hash);
          continue;
        }

        const isForward = isMsgForward && isP2OnTask;

        if (isForward && !seenMerges.has(hash)) {
          seenMerges.add(hash);
          forwardMerges.push(hash);
        } else if (isMsgForward && !isForward) {
          if (!rejectedMerges.includes(hash)) rejectedMerges.push(hash);
        }
      }
    } catch (err) {
      throw new Error(
        `Failed to inspect merge candidates for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { forwardMerges, rejectedMerges };
}

/**
 * Find the merge commit that merged a task's branch into the integration or target branch.
 */
export async function findForwardMergeCommitsForTask(
  repoPath: string,
  task: TaskRow,
  candidateBranches: string[],
  env: NodeJS.ProcessEnv,
  failClosed = false,
): Promise<string[]> {
  const result = await findMergeCandidatesForTask(repoPath, task, candidateBranches, env, failClosed);
  return result.forwardMerges;
}

/**
 * Find the latest forward merge commit that merged a task's branch into the integration or target branch.
 * Excludes reverse merges.
 */
export async function findMergeCommitForTask(
  repoPath: string,
  task: TaskRow,
  candidateBranches: string[],
  env: NodeJS.ProcessEnv,
  failClosed = false,
): Promise<string | null> {
  const merges = await findForwardMergeCommitsForTask(repoPath, task, candidateBranches, env, failClosed);
  return merges.length > 0 ? merges[0] : null;
}

/**
 * Returns number of audit fix rounds already completed by this task.
 */
/** Findings of earlier audit rounds, oldest first, read back from the stored audit reviews. */
function previousAuditRounds(task: TaskRow, deps: PublishTaskDeps): PrePublishAuditFinding[][] {
  try {
    const reviews = (deps.reviewRepo?.getByTask(task.id) || []).filter((r) => r.actor === 'audit-prepublish');
    return reviews
      .slice()
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map((r) => parseAuditFeedbackFindings(r.feedback))
      .filter((round) => round.length > 0);
  } catch {
    return [];
  }
}

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
  sourceSha?: string | null,
  targetSha?: string | null,
  remote = 'origin',
): Promise<{ diff: string; changedFiles: string[]; commitSha: string; branchSha?: string; auditRange?: string }> {
  let commitSha = '';
  let branchSha: string | undefined;
  let diff = '';
  let changedFiles: string[] = [];
  let auditRange = '';

  const taskBranch = task.branch || `agenthub/${task.slug}`;
  const branchRef = `refs/heads/${taskBranch}`;
  // Audit diff discovery is fail-closed: a git error while checking or reading
  // the task branch must not be mistaken for "branch missing".
  const branchExists = await refExistsStrict(repoPath, branchRef, env);
  let branchShaValue: string | null = null;
  if (branchExists) {
    branchShaValue = (await runGit(['-C', repoPath, 'rev-parse', '--verify', `${branchRef}^{commit}`], repoPath, env)).trim();
  }

  // 1. Prioritize forward merge commit(s) on snapshot of sourceSha/sourceBranch or targetSha/targetBranch
  const candidateBranches: string[] = [];
  for (const b of [sourceSha || sourceBranch, targetSha || targetBranch]) {
    if (
      b &&
      b !== taskBranch &&
      b !== task.branch &&
      b !== branchRef &&
      b !== branchShaValue &&
      !candidateBranches.includes(b)
    ) {
      candidateBranches.push(b);
    }
  }

  const patterns = [taskBranch, task.slug].filter(Boolean) as string[];
  const reverseRegexes = patterns.map((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`into\\s+['"/]?(refs/heads/)?(agenthub/)?${escaped}(['"/)]|\\s*$)`, 'i');
  });

  // The audit diff itself must be provably the task's own commits, so a task
  // branch ref is required here (fail-closed). Listing which tasks to audit
  // (findTasksToAudit) does not require it: an unverifiable task that is
  // picked up there still fails here instead of being silently skipped.
  const { forwardMerges, rejectedMerges } = await findMergeCandidatesForTask(
    repoPath,
    task,
    candidateBranches,
    env,
    true,
    true,
  );

  let usedMergeDiff = false;

  if (forwardMerges.length > 0) {
    const latestMerge = forwardMerges[0];
    commitSha = latestMerge;

    const taskTip = (await runGit(['-C', repoPath, 'rev-parse', `${latestMerge}^2`], repoPath, env)).trim();
    branchSha = taskTip;

    // Base commit:
    // Always use remote base before publish (baseRef / prevRemoteSha / origin/<targetBranch>).
    // Never fall back to earliest merge parent or parent merge.
    // If remote base cannot be resolved, fail closed (throw).
    const baseCommit = await resolveRemoteAuditBase(repoPath, baseRef, targetBranch, remote, env);
    const mb = (await runGit(['-C', repoPath, 'merge-base', baseCommit, taskTip], repoPath, env)).trim();
    if (!mb) throw new Error('Failed to resolve merge-base for audit diff.');

    auditRange = `${mb}..${taskTip}`;
    diff = await runGit(['-C', repoPath, 'diff', auditRange], repoPath, env);
    const filesOut = await runGit(['-C', repoPath, 'diff', '--name-only', auditRange], repoPath, env);
    changedFiles = filesOut.split('\n').map((s) => s.trim()).filter(Boolean);
    usedMergeDiff = true;
  }

  // If candidate merges were rejected (e.g. reverse merges or unverified ancestry) and no forward merge was found, fail closed!
  if (!usedMergeDiff && rejectedMerges.length > 0) {
    throw new Error(
      `Failed to resolve a verified audit diff for task ${task.id}: candidate merge was rejected as a reverse or unverified merge, and no valid forward merge was found.`,
    );
  }

  // 2. If no forward merge commit was found and no merges were rejected, use snapshot commit or branch
  if (!usedMergeDiff) {
    let taskSnapshotCommit: string | null = null;
    // Only when the task branch *is* the source branch does the source snapshot
    // equal the task's content; otherwise it would pull in other tasks' commits.
    if (sourceSha && taskBranch === sourceBranch) {
      taskSnapshotCommit = sourceSha;
    } else if (sourceSha && branchExists) {
      // `git merge-base` exits 1 when there is no common ancestor; anything
      // else is a real error and fails closed instead of falling through to
      // the branch tip.
      let mb = '';
      try {
        mb = (await runGit(['-C', repoPath, 'merge-base', sourceSha, `refs/heads/${taskBranch}`], repoPath, env)).trim();
      } catch (err: unknown) {
        if (!(typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 1)) throw err;
      }
      if (mb && (await isAncestor(repoPath, mb, sourceSha, env))) {
        taskSnapshotCommit = mb;
      }
    } else if (targetSha && branchExists) {
      // `git merge-base` exits 1 when there is no common ancestor; anything
      // else is a real error and fails closed instead of falling through to
      // the branch tip.
      let mb = '';
      try {
        mb = (await runGit(['-C', repoPath, 'merge-base', targetSha, `refs/heads/${taskBranch}`], repoPath, env)).trim();
      } catch (err: unknown) {
        if (!(typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 1)) throw err;
      }
      if (mb && (await isAncestor(repoPath, mb, targetSha, env))) {
        taskSnapshotCommit = mb;
      }
    }

    if (!taskSnapshotCommit && branchExists) {
      taskSnapshotCommit = branchShaValue;
    }

    if (taskSnapshotCommit) {
      if (!commitSha) {
        commitSha = taskSnapshotCommit;
      }
      if (!branchSha) {
        branchSha = taskSnapshotCommit;
      }
      const effectiveBase = await resolveRemoteAuditBase(repoPath, baseRef, targetBranch, remote, env);

      // Verify taskSnapshotCommit does not contain any reverse merges
      const snapshotParents = (
        await runGit(['-C', repoPath, 'rev-parse', `${taskSnapshotCommit}^@`], repoPath, env)
      )
        .split(/\s+/)
        .filter(Boolean);

      let isReverseMerge = false;
      if (snapshotParents.length > 1) {
        const snapshotSubject = (
          await runGit(['-C', repoPath, 'log', '-1', '--format=%s', taskSnapshotCommit], repoPath, env)
        ).trim();
        if (reverseRegexes.some((re) => re.test(snapshotSubject))) {
          isReverseMerge = true;
        }
        if (!isReverseMerge && targetBranch) {
          const targetPattern = new RegExp(`Merge\\s+(branch\\s+)?['"/]?(refs/heads/)?${targetBranch}(['"/)]|\\s+into|$)`, 'i');
          if (targetPattern.test(snapshotSubject)) isReverseMerge = true;
        }
        if (!isReverseMerge && snapshotParents[1]) {
          try {
            if (
              (await isAncestor(repoPath, snapshotParents[1], effectiveBase, env)) ||
              (Boolean(targetSha) && (await isAncestor(repoPath, snapshotParents[1], targetSha!, env)))
            ) {
              isReverseMerge = true;
            }
          } catch {
            isReverseMerge = true;
          }
        }
        if (isReverseMerge) {
          throw new Error(
            `Failed to resolve a verified audit diff for task ${task.id}: task snapshot tip ${taskSnapshotCommit} is a reverse merge and no forward merge was found.`,
          );
        }
      }

      // Check if any reverse merges exist in effectiveBase..taskSnapshotCommit
      try {
        const commitLog = await runGit(
          ['-C', repoPath, 'log', '--merges', '--first-parent', '--format=%H\t%P\t%s', `${effectiveBase}..${taskSnapshotCommit}`],
          repoPath,
          env,
        );
        const mergeLines = commitLog.split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of mergeLines) {
          const [hash, parents, ...subjectParts] = line.split('\t');
          if (!hash || !parents) continue;
          const subject = subjectParts.join('\t');
          const [, p2] = parents.split(/\s+/).filter(Boolean);
          const isSubjectReverse = reverseRegexes.some((re) => re.test(subject));
          let isP2FromBase = false;
          if (p2) {
            try {
              isP2FromBase =
                (await isAncestor(repoPath, p2, effectiveBase, env)) ||
                (Boolean(targetSha) && (await isAncestor(repoPath, p2, targetSha!, env)));
            } catch {
              isP2FromBase = true;
            }
          }
          if (isSubjectReverse || isP2FromBase) {
            throw new Error(
              `Failed to resolve a verified audit diff for task ${task.id}: reverse merge ${hash} detected in task snapshot lineage and no forward merge was found.`,
            );
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Failed to resolve a verified audit diff')) {
          throw err;
        }
        throw new Error(
          `Failed to verify ancestry for task snapshot ${taskSnapshotCommit}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const mergeBase = (await runGit(['-C', repoPath, 'merge-base', effectiveBase, taskSnapshotCommit], repoPath, env)).trim();
      if (!mergeBase) throw new Error('Failed to resolve merge-base for audit diff.');
      auditRange = `${mergeBase}..${taskSnapshotCommit}`;
      diff = await runGit(['-C', repoPath, 'diff', auditRange], repoPath, env);
      const filesOut = await runGit(['-C', repoPath, 'diff', '--name-only', auditRange], repoPath, env);
      changedFiles = filesOut.split('\n').map((s) => s.trim()).filter(Boolean);
    }
  }

  if (!auditRange) {
    throw new Error(`Failed to resolve a verified audit diff for task ${task.id}.`);
  }

  // 3. Fallback for commitSha
  if (!commitSha) {
    commitSha = branchSha || 'HEAD';
    if (commitSha === 'HEAD') {
      try {
        commitSha = (await runGit(['-C', repoPath, 'rev-parse', 'HEAD'], repoPath, env)).trim();
      } catch {
        commitSha = 'HEAD';
      }
    }
  }

  return { diff, changedFiles, commitSha, branchSha, auditRange };
}

function parseTimestamp(raw: string | null | undefined): number {
  if (!raw) return NaN;
  const str = raw.trim();
  if (!str) return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
    return new Date(str.replace(' ', 'T') + 'Z').getTime();
  }
  return new Date(str).getTime();
}

async function getTaskCompletionTime(
  t: TaskRow,
  mergeCommit: string | null | undefined,
  branchRef: string | null | undefined,
  repoPath: string,
  env: NodeJS.ProcessEnv,
  deps: PublishTaskDeps,
): Promise<number | null> {
  if (mergeCommit) {
    try {
      const commitDate = await runGit(['-C', repoPath, 'show', '-s', '--format=%cI', mergeCommit], repoPath, env);
      const ts = parseTimestamp(commitDate);
      if (!isNaN(ts)) return ts;
    } catch {
      // ignore
    }
  }

  if (branchRef && (await refExists(repoPath, branchRef, env))) {
    try {
      const commitDate = await runGit(['-C', repoPath, 'show', '-s', '--format=%cI', branchRef], repoPath, env);
      const ts = parseTimestamp(commitDate);
      if (!isNaN(ts)) return ts;
    } catch {
      // ignore
    }
  }

  const revs = deps.reviewRepo?.getByTask(t.id);
  const approvedRev = revs?.find((r) => r.verdict === 'approved' && r.createdAt);
  if (approvedRev?.createdAt) {
    const ts = parseTimestamp(approvedRev.createdAt);
    if (!isNaN(ts)) return ts;
  }

  if (deps.runRepo) {
    const runs = deps.runRepo.getByTask(t.id);
    const doneRun = runs?.slice().reverse().find((r) => r.outcome === 'done' && (r.endedAt || r.startedAt));
    if (doneRun) {
      const ts = parseTimestamp(doneRun.endedAt || doneRun.startedAt);
      if (!isNaN(ts)) return ts;
    }
  }

  return null;
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
  sourceSha?: string | null,
  targetSha?: string | null,
): Promise<{ tasksToAudit: TaskRow[]; baselineTasks: TaskRow[]; taskMergeCommitMap: Map<string, string | null> }> {
  const mainTask = deps.taskRepo.get(taskId);
  const allTasks = deps.taskRepo.getByProject
    ? deps.taskRepo.getByProject(projectId)
    : (deps.taskRepo as unknown as { list?: (f: { project: string }) => TaskRow[] }).list?.({ project: projectId }) || (mainTask ? [mainTask] : []);

  const remoteTargetRef = `refs/remotes/${remote}/${targetBranch}`;
  const hasRemoteTarget = await refExists(repoPath, remoteTargetRef, env);
  const sourceRef = `refs/heads/${sourceBranch}`;
  const hasSource = Boolean(sourceSha) || (await refExists(repoPath, sourceRef, env));
  const targetRef = `refs/heads/${targetBranch}`;
  const hasTarget = Boolean(targetSha) || (await refExists(repoPath, targetRef, env));

  const doneTasks = allTasks.filter((t) => t.status === 'done');
  const allCandidates: TaskRow[] = [];
  const taskMergeCommitMap = new Map<string, string | null>();

  for (const t of doneTasks) {
    const tBranch = t.branch || `agenthub/${t.slug}`;
    const branchRef = `refs/heads/${tBranch}`;
    const branchExists = await refExists(repoPath, branchRef, env);
    const mergeCommit = await findMergeCommitForTask(repoPath, t, [sourceSha || sourceBranch, targetSha || targetBranch], env, true);
    taskMergeCommitMap.set(t.id, mergeCommit);

    const taskRef = mergeCommit || (t.id === taskId && tBranch === sourceBranch && sourceSha ? sourceSha : null) || (branchExists ? branchRef : null);

    if (!taskRef) {
      if (t.id === taskId) {
        throw new Error(`Failed to verify task ${t.id} is included in the publish snapshot.`);
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
    if (hasSource && (await isAncestor(repoPath, taskRef, sourceSha || sourceRef, env))) {
      mergedToPushTarget = true;
    }
    if (!mergedToPushTarget && hasTarget && (await isAncestor(repoPath, taskRef, targetSha || targetRef, env))) {
      mergedToPushTarget = true;
    }
    if (!mergedToPushTarget && !hasSource && branchExists && t.id === taskId) {
      mergedToPushTarget = true;
    }

    if (mergedToPushTarget) {
      allCandidates.push(t);
    }
  }

  if (!allCandidates.some((t) => t.id === taskId) && mainTask && (mainTask.status === 'done' || mainTask.status === 'pushed')) {
    const taskBranch = mainTask.branch || `agenthub/${mainTask.slug}`;
    const branchRef = `refs/heads/${taskBranch}`;
    const branchExists = await refExists(repoPath, branchRef, env);
    const mergeCommit = await findMergeCommitForTask(repoPath, mainTask, [sourceSha || sourceBranch, targetSha || targetBranch], env, true);
    const taskRef = mergeCommit || (sourceSha && (mainTask.branch === sourceBranch || !mainTask.branch) ? sourceSha : null) || (branchExists ? branchRef : null);

    let include = false;
    if (!taskRef) {
      throw new Error(`Failed to verify task ${mainTask.id} is included in the publish snapshot.`);
    } else if (!hasSource || !sourceSha) {
      include = true;
    } else if (await isAncestor(repoPath, taskRef, sourceSha, env)) {
      include = true;
    } else if (targetSha && (await isAncestor(repoPath, taskRef, targetSha, env))) {
      include = true;
    }
    if (include) {
      allCandidates.push(mainTask);
    }
  }

  const project = deps.projectRepo.get(projectId);
  const settings = project ? projectSettings(project) : null;
  const enabledAt = settings?.publish?.enabledAt;
  const enabledTime = parseTimestamp(enabledAt);
  const isValidEnabledTime = !isNaN(enabledTime) && enabledTime <= Date.now();

  // Separate baseline tasks merged before publish was enabled/migrated
  if (isValidEnabledTime) {
    const tasksToAudit: TaskRow[] = [];
    const baselineTasks: TaskRow[] = [];

    for (const t of allCandidates) {
      const mergeCommit = taskMergeCommitMap.get(t.id);
      const tBranch = t.branch || `agenthub/${t.slug}`;
      const branchRef = `refs/heads/${tBranch}`;
      const mergeTime = await getTaskCompletionTime(t, mergeCommit, branchRef, repoPath, env, deps);

      // Root task being published must never be categorized as baseline (always audit the gated root task).
      // Other tasks without a verifiable merge timestamp safely fall back to audit (fail-closed).
      if (t.id !== taskId && mergeTime !== null && mergeTime < enabledTime) {
        baselineTasks.push(t);
      } else {
        tasksToAudit.push(t);
      }
    }

    return { tasksToAudit, baselineTasks, taskMergeCommitMap };
  }

  return { tasksToAudit: allCandidates, baselineTasks: [], taskMergeCommitMap };
}

/**
 * Runs the read-only pre-publish audit agent using reviewer engine infrastructure.
 */
/** Reviewer profiles tried per audit when earlier ones hit their usage limit. */
const MAX_AUDIT_QUOTA_ATTEMPTS = 4;

async function runAuditAgentForTask(
  task: TaskRow,
  project: ProjectRow,
  repoPath: string,
  deps: PublishTaskDeps,
  diff: string,
  changedFiles: string[],
  doneReport: string,
  commitSha?: string,
  arbiter?: { excludeEngine: string; contested: PrePublishAuditFinding[] },
): Promise<
  | { ok: true; result: PrePublishAuditResult; engineId: string; profileName: string; model: string }
  | { ok: false; error: string; retryable: boolean; isQuota?: boolean; noProfile?: boolean }
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

  // The arbiter must be a different engine than the auditor it second-guesses.
  const auditOrder = arbiter
    ? [
        ...reviewerOrder,
        { engine: 'claude' as const, model: 'sonnet', profiles: [] },
        { engine: 'codex' as const, model: 'gpt-5.6-luna', profiles: [] },
      ].filter((item) => item.engine !== arbiter.excludeEngine)
    : reviewerOrder;

  for (const item of auditOrder) {
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
  if (!arbiter && (!chosenEngine || !chosenProfile)) {
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
      noProfile: true,
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
    previousRounds: previousAuditRounds(task, deps),
    contestedFindings: arbiter?.contested,
    checks: (() => {
      try { return deps.getCheckResults?.(task.id).map((c) => ({ name: c.name, ok: c.ok, outputTail: c.outputTail })); } catch { return undefined; }
    })(),
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

  // Only a failed run can be a quota failure. A successful audit log also contains
  // the files the agent read, and a repository that handles HTTP 429 / "rate limit"
  // itself would otherwise be reported as reviewer quota exhaustion forever.
  const failed = Boolean(error) || code !== 0;
  const quotaDetection = failed ? chosenEngine.detectQuota(`${logOutput}\n${fileOutput}`) : { exhausted: false };
  if (quotaDetection.exhausted) {
    // Block the profile until the reset the provider reported (e.g. "try again at
    // Nov 21st ... 2:54 PM"), so the next attempt does not pick it again in 5 minutes.
    deps.quotaService?.mark(
      chosenProfile.name,
      chosenProfile.engine === 'claude' ? 'claude' : 'codex',
      quotaDetection.resetSeconds && quotaDetection.resetSeconds > 0 ? quotaDetection.resetSeconds : 300,
      'Pre-publish audit quota exhausted',
    );
    return {
      ok: false,
      error: 'Hết quota reviewer khi audit trước khi publish',
      retryable: true,
      isQuota: true,
    };
  }

  if (failed) {
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

  return { ok: true, result: parsed, engineId: chosenProfile.engine, profileName: chosenProfile.name, model: chosenModel };
}

/**
 * Updates the local branch to the pushed commit.
 * If the target branch is currently checked out in repoPath:
 * - If the tracked working tree is clean (ignoring untracked files): updates using `merge --ff-only` so files on disk match the branch.
 * - If the tracked working tree is dirty or ff-only fails: leaves the local branch untouched and returns 'skipped_dirty'.
 * If the target branch is not checked out: updates using `update-ref` directly and returns 'updated'.
 */
export async function updateLocalBranchSafely(
  repoPath: string,
  targetBranch: string,
  pushedCommit: string,
  env: NodeJS.ProcessEnv,
): Promise<LocalBranchUpdateStatus> {
  let currentCheckedOut: string | null = null;
  try {
    const out = await execFileAsync('git', ['-C', repoPath, 'symbolic-ref', '--short', 'HEAD'], { env });
    currentCheckedOut = out.stdout.trim() || null;
  } catch {
    currentCheckedOut = null;
  }

  if (currentCheckedOut === targetBranch) {
    let isDirty = false;
    try {
      const statusOut = await execFileAsync('git', ['-C', repoPath, 'status', '--porcelain', '-uno'], { env });
      if (statusOut.stdout.trim().length > 0) {
        isDirty = true;
      }
    } catch {
      isDirty = true;
    }

    if (isDirty) {
      return 'skipped_dirty';
    }

    try {
      await runGit(['-C', repoPath, 'merge', '--ff-only', pushedCommit], repoPath, env);
      return 'updated';
    } catch {
      return 'skipped_dirty';
    }
  } else {
    const targetRef = `refs/heads/${targetBranch}`;
    const targetExists = await refExists(repoPath, targetRef, env);
    if (targetExists) {
      const alreadyHasPushedCommit = await isAncestor(repoPath, pushedCommit, targetRef, env);
      if (alreadyHasPushedCommit) {
        return 'updated';
      }
      const canFastForward = await isAncestor(repoPath, targetRef, pushedCommit, env);
      if (canFastForward) {
        await runGit(['-C', repoPath, 'update-ref', targetRef, pushedCommit], repoPath, env);
        return 'updated';
      }
      return 'skipped_dirty';
    }
    await runGit(['-C', repoPath, 'update-ref', targetRef, pushedCommit], repoPath, env);
    return 'updated';
  }
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
    const isManual = Boolean(options?.manual);
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
      emitPushFailed(deps, taskId, currentProject.id, errorMsg, remote, targetBranch, isManual);
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
      emitPushFailed(deps, taskId, currentProject.id, errorMsg, remote, targetBranch, isManual);
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

    // Snapshot local target branch SHA before computing tasksToAudit
    const localTargetRef = `refs/heads/${targetBranch}`;
    let targetSha: string | null = null;
    if (await refExists(repoPath, localTargetRef, env)) {
      targetSha = await runGit(['-C', repoPath, 'rev-parse', localTargetRef], repoPath, env);
    }

    // Snapshot source branch SHA before computing tasksToAudit so concurrent merges are not included without audit
    const sourceRef = `refs/heads/${sourceBranch}`;
    let sourceSha: string | null = null;
    if (await refExists(repoPath, sourceRef, env)) {
      sourceSha = await runGit(['-C', repoPath, 'rev-parse', sourceRef], repoPath, env);
    }

    // The audit base must be the remote state of the branch being published.
    // A different remote branch (including the project's default branch) is not
    // a valid substitute when the target branch has no remote tip yet.
    const auditBaseRef = prevRemoteSha || remoteRef;

    // --- Pre-Publish Audit Gate ---
    const isSkipAudit = isManual && Boolean(options?.skipAudit);
    const isAuditConfigEnabled = currentSettings.publish?.audit?.enabled !== false;
    const auditedResults = new Map<string, PrePublishAuditResult>();
    const taskAuditRangeMap = new Map<string, string>();

    // Candidate discovery runs in all publish modes to determine which tasks belong to the push snapshot
    let candidates: Awaited<ReturnType<typeof findTasksToAudit>>;
    try {
      candidates = await findTasksToAudit(
        taskId,
        currentProject.id,
        sourceBranch,
        targetBranch,
        remote,
        repoPath,
        env,
        deps,
        sourceSha,
        targetSha,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedAt = new Date().toISOString();
      deps.taskRepo.update(taskId, {
        pushResult: JSON.stringify({
          state: 'push_failed',
          error: errorMsg,
          failedAt,
          retryable: true,
        }),
      });
      emitPushFailed(deps, taskId, currentProject.id, errorMsg, remote, targetBranch, isManual);
      return { ok: false, error: errorMsg, remote, branch: targetBranch, retryable: true };
    }
    const tasksToAudit = candidates.tasksToAudit;
    const baselineTasks = candidates.baselineTasks;

    const rootInAudit = tasksToAudit.some((t) => t.id === taskId);
    const rootInBaseline = baselineTasks.some((t) => t.id === taskId);
    if (!rootInAudit && !rootInBaseline) {
      const mainTask = deps.taskRepo.get(taskId);
      const tBranch = mainTask?.branch || (mainTask?.slug ? `agenthub/${mainTask.slug}` : null);
      const branchRef = tBranch ? `refs/heads/${tBranch}` : null;
      const branchExists = branchRef ? await refExists(repoPath, branchRef, env) : false;
      const mergeCommit = mainTask ? await findMergeCommitForTask(repoPath, mainTask, [sourceSha || sourceBranch, targetSha || targetBranch], env, true) : null;
      const taskRef = mergeCommit || (branchExists ? branchRef! : null);

      const isAlreadyOnRemote = Boolean(
        prevRemoteSha &&
        taskRef &&
        (await isAncestor(repoPath, taskRef, remoteRef, env))
      );

      if (isAlreadyOnRemote && mainTask) {
        let hasAuditPassed = false;
        try {
          const pr = mainTask.pushResult ? JSON.parse(mainTask.pushResult) : null;
          if (pr?.auditPassed === true) hasAuditPassed = true;
        } catch {
          // ignore parse error
        }

        const hasPrePublishReview = deps.reviewRepo?.getByTask(taskId).some(
          (r) => r.actor === 'audit-prepublish' && r.verdict === 'approved'
        );

        const isBaseline = await (async () => {
          const enabledAt = currentSettings.publish?.enabledAt;
          const enabledTime = parseTimestamp(enabledAt);
          const isValidEnabledTime = !isNaN(enabledTime) && enabledTime <= Date.now();
          if (!isValidEnabledTime) return false;
          const compTime = await getTaskCompletionTime(mainTask, mergeCommit, branchExists ? branchRef : null, repoPath, env, deps);
          return compTime !== null && compTime < enabledTime;
        })();

        if (hasAuditPassed || hasPrePublishReview || isBaseline || isSkipAudit || !isAuditConfigEnabled) {
          const { compareUrl } = buildGitUrls(remoteUrl, prevRemoteSha || '', prevRemoteSha);
          const pushedAt = mainTask.pushedAt || new Date().toISOString();
          const commitSha = prevRemoteSha || '';
          const tPushResultObj = {
            state: 'pushed',
            remote,
            branch: targetBranch,
            commit: commitSha,
            compareUrl,
            pushedIntegrationBranch: false,
            auditPassed: hasAuditPassed || Boolean(hasPrePublishReview) || isBaseline || !isAuditConfigEnabled,
            auditSkipped: isSkipAudit || !isAuditConfigEnabled,
            findings: [],
            localUpdate: 'updated',
          };
          deps.taskRepo.update(taskId, {
            status: 'pushed',
            pushedAt,
            pushResult: JSON.stringify(tPushResultObj),
          });
          deps.eventBus.emit('task.pushed', taskId, {
            taskId,
            projectId: currentProject.id,
            remote,
            branch: targetBranch,
            commit: commitSha,
          });
          return {
            ok: true,
            remote,
            branch: targetBranch,
            commit: commitSha,
            pushedIntegrationBranch: false,
            pushedAt,
          };
        }
      }

      const errorMsg = `Task ${taskId} is not included in the push commit or source snapshot (${sourceSha || sourceBranch})`;
      const failedAt = new Date().toISOString();
      deps.taskRepo.update(taskId, {
        pushResult: JSON.stringify({ state: 'push_failed', error: errorMsg, failedAt, retryable: true }),
      });
      emitPushFailed(deps, taskId, currentProject.id, errorMsg, remote, targetBranch, isManual);
      return {
        ok: false,
        error: errorMsg,
        remote,
        branch: targetBranch,
        retryable: true,
      };
    }

    if (isSkipAudit) {
      deps.eventBus.emit('task.audit_skipped', taskId, {
        taskId,
        projectId: currentProject.id,
        manual: true,
      });
    } else if (isAuditConfigEnabled) {
      const maxTasks = currentSettings.publish?.audit?.maxTasks ?? 10;
      if (tasksToAudit.length > maxTasks) {
        const errorMsg = `Số lượng task cần audit (${tasksToAudit.length}) vượt quá giới hạn tối đa cho phép (${maxTasks}). Vui lòng kiểm tra hoặc điều chỉnh maxTasks.`;
        const failedAt = new Date().toISOString();
        deps.taskRepo.update(taskId, {
          pushResult: JSON.stringify({
            state: 'push_failed',
            error: errorMsg,
            failedAt,
            retryable: false,
            exceededMaxTasks: true,
            tasksCount: tasksToAudit.length,
            maxTasks,
          }),
        });
        emitPushFailed(deps, taskId, currentProject.id, errorMsg, remote, targetBranch, isManual);
        return { ok: false, error: errorMsg, remote, branch: targetBranch, retryable: false };
      }

      for (const t of tasksToAudit) {
        let taskDiffResult: Awaited<ReturnType<typeof getTaskDiff>>;
        try {
          taskDiffResult = await getTaskDiff(
            repoPath,
            t,
            sourceBranch,
            targetBranch,
            auditBaseRef,
            env,
            sourceSha,
            targetSha,
            remote,
          );
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const failedAt = new Date().toISOString();
          deps.taskRepo.update(taskId, {
            pushResult: JSON.stringify({
              state: 'push_failed',
              error: errorMsg,
              failedAt,
              retryable: false,
            }),
          });
          emitPushFailed(deps, taskId, currentProject.id, errorMsg, remote, targetBranch, isManual);
          return { ok: false, error: errorMsg, remote, branch: targetBranch, retryable: false };
        }
        const { diff, changedFiles, commitSha, branchSha, auditRange } = taskDiffResult;
        if (auditRange) {
          taskAuditRangeMap.set(t.id, auditRange);
        }

        const cached = getCachedAuditPass(t.id, commitSha) || (branchSha ? getCachedAuditPass(t.id, branchSha) : undefined);
        if (cached) {
          auditedResults.set(t.id, cached);
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

        const auditStartedAt = new Date().toISOString();
        deps.taskRepo.update(t.id, {
          pushResult: JSON.stringify({
            state: 'auditing',
            startedAt: auditStartedAt,
            ...(auditRange ? { auditRange } : {}),
          }),
        });
        if (taskId !== t.id) {
          deps.taskRepo.update(taskId, {
            pushResult: JSON.stringify({
              state: 'auditing',
              startedAt: auditStartedAt,
              ...(auditRange ? { auditRange } : {}),
            }),
          });
        }

        deps.eventBus.emit('task.auditing', t.id, {
          taskId: t.id,
          projectId: currentProject.id,
          startedAt: auditStartedAt,
          ...(auditRange ? { auditRange } : {}),
        });
        deps.eventBus.emit('task.audit_started', t.id, {
          taskId: t.id,
          projectId: currentProject.id,
          startedAt: auditStartedAt,
          ...(auditRange ? { auditRange } : {}),
        });

        // A quota failure marks that profile exhausted, so the next attempt picks
        // another reviewer profile instead of failing the whole publish.
        let auditExec = await runAuditAgentForTask(
          t,
          currentProject,
          repoPath,
          deps,
          diff,
          changedFiles,
          doneReport,
          commitSha,
        );
        for (let attempt = 1; !auditExec.ok && auditExec.isQuota && attempt < MAX_AUDIT_QUOTA_ATTEMPTS; attempt += 1) {
          const next = await runAuditAgentForTask(
            t,
            currentProject,
            repoPath,
            deps,
            diff,
            changedFiles,
            doneReport,
            commitSha,
          );
          // Every reviewer profile is now exhausted: keep reporting the quota failure.
          if (!next.ok && next.noProfile) break;
          auditExec = next;
        }

        if (!auditExec.ok) {
          // Fail closed
          const errorMsg = auditExec.error;
          const failedAt = new Date().toISOString();
          deps.taskRepo.update(t.id, {
            pushResult: JSON.stringify({
              error: errorMsg,
              failedAt,
              startedAt: auditStartedAt,
              retryable: true,
              auditFailed: true,
              ...(auditRange ? { auditRange } : {}),
            }),
          });
          if (taskId !== t.id) {
            deps.taskRepo.update(taskId, {
              pushResult: JSON.stringify({
                blockedByTask: t.slug,
                blockedByTaskId: t.id,
                error: `Bị chặn bởi task ${t.slug} do audit lỗi: ${errorMsg}`,
                failedAt,
                startedAt: auditStartedAt,
                retryable: true,
              }),
            });
          }
          emitPushFailed(deps, t.id, currentProject.id, errorMsg, remote, targetBranch, isManual);
          return { ok: false, error: errorMsg, remote, branch: targetBranch, auditFailed: true, retryable: true, ...(auditRange ? { auditRange } : {}) };
        }

        const auditResult = auditExec.result;
        const passed = isAuditPassed(auditResult);

        if (passed) {
          auditedResults.set(t.id, auditResult);
          setCachedAuditPass(t.id, commitSha, auditResult);
          if (branchSha && branchSha !== commitSha) {
            setCachedAuditPass(t.id, branchSha, auditResult);
          }
          deps.eventBus.emit('task.audit_passed', t.id, {
            taskId: t.id,
            projectId: currentProject.id,
            findings: auditResult.findings,
            summary: auditResult.summary,
            engine: auditExec.engineId,
            model: auditExec.model,
            startedAt: auditStartedAt,
            finishedAt: new Date().toISOString(),
            ...(auditRange ? { auditRange } : {}),
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
                startedAt: auditStartedAt,
                retryable: true,
                auditFailed: true,
                engine: auditExec.engineId,
                model: auditExec.model,
                findings: auditResult.findings,
                summary: auditResult.summary,
                ...(auditRange ? { auditRange } : {}),
              }),
            });
            if (taskId !== t.id) {
              deps.taskRepo.update(taskId, {
                pushResult: JSON.stringify({
                  blockedByTask: t.slug,
                  blockedByTaskId: t.id,
                  error: `Bị chặn bởi task ${t.slug}: ${errorMsg}`,
                  failedAt,
                  startedAt: auditStartedAt,
                  retryable: true,
                }),
              });
            }
            emitPushFailed(deps, t.id, currentProject.id, errorMsg, remote, targetBranch, isManual);
            return {
              ok: false,
              error: errorMsg,
              remote,
              branch: targetBranch,
              auditFailed: true,
              retryable: true,
              ...(auditRange ? { auditRange } : {}),
            };
          }

          // Task failed audit (P1 or P2)
          const maxFixRounds = currentSettings.publish?.audit?.maxFixRounds ?? 2;
          const currentAuditRounds = getTaskAuditRounds(t, deps);

          // Out of fix rounds: before stopping for a person, let an auditor from another engine
          // re-check exactly the P1 findings still reported. Unless it confirms one, publish.
          if (currentAuditRounds >= maxFixRounds) {
            const contested = auditResult.findings.filter((f) => f.severity === 'P1');
            const arbiterExec = await runAuditAgentForTask(
              t, currentProject, repoPath, deps, diff, changedFiles, doneReport, commitSha,
              { excludeEngine: auditExec.engineId, contested },
            );
            if (arbiterExec.ok) {
              const arbiterPassed = isAuditPassed(arbiterExec.result);
              deps.eventBus.emit('task.audit_arbitrated', t.id, {
                taskId: t.id,
                projectId: currentProject.id,
                verdict: arbiterPassed ? 'pass' : 'fail',
                contested,
                findings: arbiterExec.result.findings,
                summary: arbiterExec.result.summary,
                engine: arbiterExec.engineId,
                model: arbiterExec.model,
                firstEngine: auditExec.engineId,
              });
              if (arbiterPassed) {
                // Keep what the first auditor found as follow-up work, downgraded to P2.
                const merged: PrePublishAuditResult = {
                  verdict: 'pass',
                  summary: arbiterExec.result.summary,
                  findings: [
                    ...arbiterExec.result.findings,
                    ...auditResult.findings
                      .filter((f) => f.severity !== 'P3')
                      .filter((f) => !arbiterExec.result.findings.some((a) => a.file === f.file && a.line === f.line))
                      .map((f) => ({ ...f, severity: 'P2' as const })),
                  ],
                };
                auditedResults.set(t.id, merged);
                setCachedAuditPass(t.id, commitSha, merged);
                if (branchSha && branchSha !== commitSha) setCachedAuditPass(t.id, branchSha, merged);
                deps.eventBus.emit('task.audit_passed', t.id, {
                  taskId: t.id,
                  projectId: currentProject.id,
                  findings: merged.findings,
                  summary: merged.summary,
                  engine: arbiterExec.engineId,
                  model: arbiterExec.model,
                  arbitrated: true,
                  startedAt: auditStartedAt,
                  finishedAt: new Date().toISOString(),
                  ...(auditRange ? { auditRange } : {}),
                });
                continue;
              }
            }
          }

          if (currentAuditRounds >= maxFixRounds) {
            // Exceeded maxFixRounds and the arbiter confirmed a P1 (or no arbiter was available) -> stop
            // Emit task.audit_failed ONCE with exceededMaxRounds: true
            const failedAt = new Date().toISOString();
            deps.eventBus.emit('task.audit_failed', t.id, {
              taskId: t.id,
              projectId: currentProject.id,
              exceededMaxRounds: true,
              maxFixRounds,
              findings: auditResult.findings,
              summary: auditResult.summary,
              engine: auditExec.engineId,
              model: auditExec.model,
              auditFixRounds: currentAuditRounds,
              startedAt: auditStartedAt,
              finishedAt: failedAt,
              ...(auditRange ? { auditRange } : {}),
            });

            const pushResultObj = {
              auditFailed: true,
              exceededMaxRounds: true,
              maxFixRounds,
              auditFixRounds: currentAuditRounds,
              findings: auditResult.findings,
              summary: auditResult.summary,
              engine: auditExec.engineId,
              model: auditExec.model,
              startedAt: auditStartedAt,
              failedAt,
              retryable: false,
              error: `Task ${t.slug} vượt quá số vòng sửa tối đa (${maxFixRounds}) khi audit`,
              ...(auditRange ? { auditRange } : {}),
            };
            deps.taskRepo.update(t.id, {
              pushResult: JSON.stringify(pushResultObj),
            });
            if (taskId !== t.id) {
              deps.taskRepo.update(taskId, {
                pushResult: JSON.stringify({
                  blockedByTask: t.slug,
                  blockedByTaskId: t.id,
                  error: `Chặn publish do task ${t.slug} vượt quá số vòng sửa audit (${maxFixRounds})`,
                  failedAt,
                  startedAt: auditStartedAt,
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
              ...(auditRange ? { auditRange } : {}),
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
            engine: auditExec.engineId,
            model: auditExec.model,
            startedAt: auditStartedAt,
            failedAt,
            retryable: false,
            error: `Audit trước khi publish thất bại: ${auditResult.summary}`,
            ...(auditRange ? { auditRange } : {}),
          };
          deps.taskRepo.update(t.id, {
            pushResult: JSON.stringify(pushResultObj),
          });
          if (taskId !== t.id) {
            deps.taskRepo.update(taskId, {
              pushResult: JSON.stringify({
                blockedByTask: t.slug,
                blockedByTaskId: t.id,
                error: `Bị chặn bởi task ${t.slug} do audit không đạt`,
                failedAt,
                startedAt: auditStartedAt,
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
            engine: auditExec.engineId,
            model: auditExec.model,
            auditFixRounds: nextRound,
            startedAt: auditStartedAt,
            finishedAt: failedAt,
            ...(auditRange ? { auditRange } : {}),
          });

          const blocking = auditResult.findings.filter((f) => f.severity === 'P1');
          const optional = auditResult.findings.filter((f) => f.severity !== 'P1');
          const feedback = [
            '### Kết quả Audit trước khi publish thất bại',
            auditResult.summary,
            '\nBắt buộc sửa (chỉ các mục P1 này chặn publish):',
            ...formatAuditFindings(blocking),
            ...(optional.length > 0
              ? ['\nKhông bắt buộc (không chặn publish; chỉ sửa nếu nhanh và không mở rộng phạm vi):', ...formatAuditFindings(optional)]
              : []),
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
      const localExists = Boolean(targetSha) || (await refExists(repoPath, localRef, env));
      const remoteExists = Boolean(prevRemoteSha);

      // Determine initial commit-ish to detach from
      let startPoint: string;
      if (targetSha) {
        startPoint = targetSha;
      } else if (localExists) {
        startPoint = targetBranch;
      } else if (prevRemoteSha) {
        startPoint = prevRemoteSha;
      } else if (remoteExists) {
        startPoint = remoteRef;
      } else if (sourceSha) {
        startPoint = sourceSha;
      } else {
        startPoint = sourceBranch;
      }

      await runGit(['-C', repoPath, 'worktree', 'add', '--detach', worktreePath, startPoint], repoPath, env);

      // 2. If remote target branch exists and local started from local target, fast-forward / merge remote changes
      if (remoteExists && targetSha) {
        try {
          await runGit(['-C', worktreePath, 'merge', '--ff-only', prevRemoteSha || remoteRef], worktreePath, env);
        } catch {
          // If ff not possible, attempt standard merge
          try {
            const identity = await gitIdentityArgs(worktreePath, env);
            await runGit(['-C', worktreePath, ...identity, 'merge', '--no-edit', prevRemoteSha || remoteRef], worktreePath, env);
          } catch (mergeErr) {
            throw new Error(`Xung đột merge với remote ${targetBranch}: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
          }
        }
      }

      // 3. Merge source branch into target branch (if sourceBranch differs or has commits)
      const sourceExists = Boolean(sourceSha) || (await refExists(repoPath, `refs/heads/${sourceBranch}`, env));
      if (sourceExists) {
        const commitToMerge = sourceSha || sourceBranch;
        const isAncestor = await execFileAsync('git', ['-C', worktreePath, 'merge-base', '--is-ancestor', commitToMerge, 'HEAD'], { env })
          .then(() => true)
          .catch(() => false);

        if (!isAncestor) {
          const identity = await gitIdentityArgs(worktreePath, env);
          const mergeMsg = `Merge branch '${sourceBranch}' into ${targetBranch}`;
          try {
            await runGit(['-C', worktreePath, ...identity, 'merge', '--no-ff', commitToMerge, '-m', mergeMsg], worktreePath, env);
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

      // Update state to pushing before initiating remote git push
      deps.taskRepo.update(taskId, {
        pushResult: JSON.stringify({
          state: 'pushing',
          auditPassed: !isSkipAudit && isAuditConfigEnabled,
          auditSkipped: isSkipAudit,
        }),
      });

      // 5. Push target branch to remote
      await runGit(['-C', worktreePath, 'push', remote, `HEAD:refs/heads/${targetBranch}`], worktreePath, env);

      // 6. Update local branch ref to match pushed commit safely
      const localUpdate = await updateLocalBranchSafely(repoPath, targetBranch, pushedCommit, env);

      // 7. Push integration branch if enabled
      let pushedIntegrationBranch = false;
      if (currentSettings.integration?.enabled && currentSettings.publish?.pushIntegrationBranch !== false) {
        const integrationBranch = currentSettings.integration.branch || 'agenthub/integration';
        if (await refExists(repoPath, `refs/heads/${integrationBranch}`, env)) {
          const pushSource = (integrationBranch === sourceBranch && sourceSha) ? sourceSha : `refs/heads/${integrationBranch}`;
          await runGit(
            ['-C', worktreePath, 'push', remote, `${pushSource}:refs/heads/${integrationBranch}`],
            worktreePath,
            env,
          );
          pushedIntegrationBranch = true;
        }
      }

      // 8. Generate URLs and update tasks
      const { compareUrl } = buildGitUrls(remoteUrl, pushedCommit, prevRemoteSha);
      const pushedAt = new Date().toISOString();
      // Update all tasks included in this pushed range
      for (const t of tasksToAudit) {
        const auditRes = auditedResults.get(t.id);
        const p3Findings = auditRes?.findings?.filter((f) => f.severity !== 'P1') ?? [];
        const followUpFindings = auditFollowUpFindings(auditRes);
        const tAuditRange = taskAuditRangeMap.get(t.id);
        const tPushResultObj = {
          state: 'pushed',
          remote,
          branch: targetBranch,
          commit: pushedCommit,
          compareUrl,
          pushedIntegrationBranch,
          auditPassed: !isSkipAudit && isAuditConfigEnabled,
          auditSkipped: isSkipAudit || !isAuditConfigEnabled,
          findings: p3Findings,
          summary: auditRes?.summary,
          localUpdate,
          ...(tAuditRange ? { auditRange: tAuditRange } : {}),
        };

        deps.taskRepo.update(t.id, {
          status: 'pushed',
          pushedAt,
          pushResult: JSON.stringify(tPushResultObj),
        });

        // P2 findings did not block the publish: hand them to a follow-up task.
        if (followUpFindings.length > 0 && deps.createFollowUpTask) {
          try {
            const followUpId = deps.createFollowUpTask(t, followUpFindings);
            if (followUpId) {
              deps.eventBus.emit('task.audit_followup_created', t.id, {
                taskId: t.id,
                projectId: currentProject.id,
                followUpTaskId: followUpId,
                findings: followUpFindings,
              });
            }
          } catch (err) {
            console.warn(`[publish] could not create audit follow-up for ${t.id}:`, err);
          }
        }

        if (t.id !== taskId) {
          deps.eventBus.emit('task.pushed', t.id, {
            taskId: t.id,
            projectId: currentProject.id,
            remote,
            branch: targetBranch,
            commit: pushedCommit,
            compareUrl,
            localUpdate,
            ...(tAuditRange ? { auditRange: tAuditRange } : {}),
          });
        }
      }

      // Update baseline tasks included in this pushed range (exempt from audit gate)
      for (const t of baselineTasks) {
        const tPushResultObj = {
          state: 'pushed',
          remote,
          branch: targetBranch,
          commit: pushedCommit,
          compareUrl,
          pushedIntegrationBranch,
          auditPassed: false,
          auditSkipped: true,
          baseline: true,
          localUpdate,
        };

        deps.taskRepo.update(t.id, {
          status: 'pushed',
          pushedAt,
          pushResult: JSON.stringify(tPushResultObj),
        });

        if (t.id !== taskId) {
          deps.eventBus.emit('task.pushed', t.id, {
            taskId: t.id,
            projectId: currentProject.id,
            remote,
            branch: targetBranch,
            commit: pushedCommit,
            compareUrl,
            localUpdate,
            baseline: true,
          });
        }
      }

      const rootAuditRes = auditedResults.get(taskId);
      const rootP3Findings = rootAuditRes?.findings?.filter((f) => f.severity === 'P3') ?? [];
      const rootAuditRange = taskAuditRangeMap.get(taskId);

      deps.eventBus.emit('task.pushed', taskId, {
        taskId,
        projectId: currentProject.id,
        remote,
        branch: targetBranch,
        commit: pushedCommit,
        compareUrl,
        localUpdate,
        ...(rootAuditRange ? { auditRange: rootAuditRange } : {}),
        ...(rootInBaseline ? { baseline: true } : {}),
      });

      lastProjectPublishError.delete(currentProject.id);

      return {
        ok: true,
        remote,
        branch: targetBranch,
        commit: pushedCommit,
        compareUrl,
        pushedIntegrationBranch,
        auditPassed: !isSkipAudit && isAuditConfigEnabled,
        auditSkipped: isSkipAudit || !isAuditConfigEnabled,
        findings: rootP3Findings,
        localUpdate,
        ...(rootAuditRange ? { auditRange: rootAuditRange } : {}),
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failedAt = new Date().toISOString();
      const rootAuditRange = taskAuditRangeMap.get(taskId);
      deps.taskRepo.update(taskId, {
        pushResult: JSON.stringify({
          state: 'push_failed',
          error: errorMsg,
          failedAt,
          retryable: true,
          ...(rootAuditRange ? { auditRange: rootAuditRange } : {}),
        }),
      });
      emitPushFailed(deps, taskId, currentProject.id, errorMsg, remote, targetBranch, isManual);
      return {
        ok: false,
        error: errorMsg,
        remote,
        branch: targetBranch,
        ...(rootAuditRange ? { auditRange: rootAuditRange } : {}),
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
