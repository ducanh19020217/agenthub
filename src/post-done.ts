import fs from 'node:fs';
import path from 'node:path';
import type { ProjectRow, TaskRow } from './db/index.js';
import { projectSettings } from './projects/settings.js';
import { projectWorktreeRoot } from './projects/paths.js';
import { isHubShimPath } from './worker-guard.js';
import { runInProcessGroup } from './priority.js';
import type { CheckResult } from './checks.js';

export const POST_DONE_ARTIFACT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.mp4', '.json', '.txt']);

/**
 * Queue to limit concurrency to at most 1 postDone per project at any time.
 */
export class ProjectPostDoneQueue {
  private queues = new Map<string, Promise<unknown>>();

  async run<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) || Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((r) => { release = r; });
    this.queues.set(projectId, prev.then(() => current, () => current));

    try {
      await prev;
      return await fn();
    } finally {
      release!();
      if (this.queues.get(projectId) === current) {
        this.queues.delete(projectId);
      }
    }
  }
}

export const postDoneQueue = new ProjectPostDoneQueue();

/**
 * Filter daemon environment:
 * - CWD is task worktree
 * - PATH does not contain worker/service shims (using isHubShimPath)
 * - Hub tokens and secret variables are stripped
 * - Explicit required AGENTHUB_* variables are set
 */
export function cleanPostDoneEnv(
  daemonEnv: NodeJS.ProcessEnv,
  hubHome: string,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const cleanPath = (daemonEnv.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => !isHubShimPath(hubHome, dir))
    .join(path.delimiter);

  for (const [key, value] of Object.entries(daemonEnv)) {
    if (value === undefined) continue;
    // Strip credentials, tokens, passwords, secrets, keys, auth, keyrings
    if (/TOKEN|SECRET|PASSWORD|AUTH|KEYRING|KEY/i.test(key)) continue;
    // Strip internal agenthub daemon variables
    if (key.startsWith('AGENTHUB_')) continue;
    env[key] = value;
  }

  env.PATH = cleanPath;
  for (const [k, v] of Object.entries(extraEnv)) {
    env[k] = v;
  }
  return env;
}

/**
 * Recursively list artifacts matching (.png, .jpg, .jpeg, .mp4, .json, .txt) in artifactsDir.
 * Returns absolute paths sorted alphabetically.
 */
export function listPostDoneArtifacts(repo: string, artifactsRelDir: string): string[] {
  const absDir = path.resolve(repo, artifactsRelDir);
  if (!fs.existsSync(absDir)) return [];
  const files: string[] = [];

  function scan(currentDir: string) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (POST_DONE_ARTIFACT_EXTS.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  scan(absDir);
  return files.sort();
}

/**
 * Get artifacts for a task given its project settings.
 */
export function getPostDoneArtifacts(task: TaskRow, project?: ProjectRow | null): string[] {
  if (!project) return [];
  const settings = projectSettings(project).postDone;
  if (!settings.enabled) return [];
  const repo = task.worktreePath || project.path;
  if (!repo || !fs.existsSync(repo)) return [];
  return listPostDoneArtifacts(repo, settings.artifactsDir);
}

/**
 * Determine task log directory, honoring project worktree logsInRoot setting.
 */
export function getTaskLogDir(task: TaskRow, project: ProjectRow, hubHome: string): string {
  if (projectSettings(project).worktree.logsInRoot === true) {
    return path.join(projectWorktreeRoot(project, hubHome), '.logs', task.id.replace('/', '_'));
  }
  return path.join(hubHome, 'logs', task.id.replace('/', '_'));
}

/**
 * Execute postDone hook for a task.
 */
export async function runPostDone(
  task: TaskRow,
  project: ProjectRow,
  hubHome: string,
): Promise<{ checkResult: CheckResult; artifacts: string[] }> {
  const settings = projectSettings(project).postDone;
  const repo = task.worktreePath || project.path;
  const artifactsDirAbs = path.resolve(repo, settings.artifactsDir);
  fs.mkdirSync(artifactsDirAbs, { recursive: true });

  const logDir = getTaskLogDir(task, project, hubHome);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'post-done.log');

  if (!settings.cmd || settings.cmd.length === 0) {
    const output = 'postDone được bật nhưng chưa cấu hình lệnh (cmd rỗng)';
    fs.writeFileSync(logPath, output + '\n', 'utf8');
    return {
      checkResult: {
        name: 'post-done',
        ok: false,
        exitCode: 1,
        durationMs: 0,
        outputTail: output,
      },
      artifacts: [],
    };
  }

  const extraEnv = {
    AGENTHUB_TASK_ID: task.id,
    AGENTHUB_PROJECT: project.id,
    AGENTHUB_BASE_REF: task.baseRef || project.defaultBranch || 'main',
    AGENTHUB_BRANCH: task.branch || 'HEAD',
    AGENTHUB_ARTIFACTS_DIR: artifactsDirAbs,
  };
  const env = cleanPostDoneEnv(process.env, hubHome, extraEnv);

  const rawCmd = settings.cmd[0];
  const command = (rawCmd.includes('/') || rawCmd.includes('\\'))
    ? path.resolve(repo, rawCmd)
    : rawCmd;
  const args = settings.cmd.slice(1);
  const timeoutSec = settings.timeoutSec || 1800;
  const timeoutMs = timeoutSec * 1000;
  const started = Date.now();

  const r = await postDoneQueue.run(project.id, async () => {
    return runInProcessGroup(command, args, {
      cwd: repo,
      env,
      timeoutMs,
      maxOutput: 8 * 1024,
      logPath,
    });
  });

  const durationMs = Date.now() - started;
  const ok = r.code === 0 && !r.timedOut;
  const MAX_OUTPUT = 8 * 1024;
  const tailOutput = r.output.length > MAX_OUTPUT ? r.output.slice(-MAX_OUTPUT) : r.output;
  const outputTail = `${tailOutput}${r.timedOut ? `\nTimeout sau ${timeoutSec}s` : ''}` || (ok ? 'OK' : 'FAIL');

  const artifacts = listPostDoneArtifacts(repo, settings.artifactsDir);

  return {
    checkResult: {
      name: 'post-done',
      ok,
      exitCode: r.timedOut ? 124 : r.code,
      durationMs,
      outputTail,
    },
    artifacts,
  };
}
