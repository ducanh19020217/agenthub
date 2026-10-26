import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInProcessGroup } from './priority.js';
import { projectSettings } from './projects/settings.js';
import { renderCommitTemplate, renderTaskBranch } from './commit-convention.js';
import { addExcludeRules, ensureIntegrationWorktree } from './projects/integration.js';
import { workerEnvironment } from './worker-guard.js';
import { ensureWorktreeNodeModules, type NodeModulesCachePolicy, type EnsureNodeModulesOptions } from './cache.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 8192;

export interface MergeConfig {
  enabled: boolean;
  worktrees: Record<string, string>;
  checks: string[];
  timeoutSec: number;
}

interface MergeTask {
  slug: string;
  branch: string | null;
  baseRef: string | null;
  externalRef?: string | null;
}

interface MergeProject {
  id?: string;
  path?: string;
  defaultBranch: string;
  merge?: string | null;
  settings?: string | null;
}

export class MergeError extends Error {
  constructor(
    public statusCode: 409 | 422 | 503,
    public error: 'conflict' | 'unprocessable_entity' | 'environment_error',
    message: string,
    public configuration = false,
    public environment = false,
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

export interface MergeOptions {
  hubHome?: string;
  cacheDir?: string;
  cacheMaxEntries?: number;
  cacheMaxGB?: number;
  cachePolicy?: NodeModulesCachePolicy;
  execFn?: EnsureNodeModulesOptions['execFn'];
}

function parseConfig(value: string | null | undefined): MergeConfig {
  if (!value) throw new MergeError(409, 'conflict', 'Project chưa cấu hình merge tự động', true);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new MergeError(409, 'conflict', 'Cấu hình merge không hợp lệ', true); }
  const config = parsed as Partial<MergeConfig>;
  if (config.enabled !== true || !config.worktrees || typeof config.worktrees !== 'object') {
    throw new MergeError(409, 'conflict', 'Merge tự động chưa được bật hoặc chưa có worktree tích hợp', true);
  }
  return {
    enabled: true,
    worktrees: config.worktrees as Record<string, string>,
    checks: Array.isArray(config.checks) ? config.checks.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [],
    timeoutSec: typeof config.timeoutSec === 'number' && config.timeoutSec > 0 ? config.timeoutSec : 600,
  };
}

function tail(value: string): string {
  return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value;
}

function splitCommand(command: string): string[] {
  const result: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(re)) result.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, '$1'));
  return result;
}

function isCommandInPath(cmd: string, envPath: string = process.env.PATH || ''): boolean {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  const dirs = envPath.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function checkWorktreeDependencies(
  worktreeDir: string,
  checks: string[] = [],
): { ok: boolean; reason?: string } {
  const pkgPath = path.join(worktreeDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    for (const cmd of checks) {
      const argv = splitCommand(cmd);
      if (argv.length === 0) continue;
      const bin = argv[0];
      if ((bin === 'npm' || bin === 'pnpm' || bin === 'yarn') && argv[1] === 'run') {
        return {
          ok: false,
          reason: `Lệnh kiểm tra "${cmd}" yêu cầu package.json nhưng không tìm thấy trong worktree`,
        };
      }
      if (!isCommandInPath(bin)) {
        return {
          ok: false,
          reason: `Không tìm thấy lệnh "${bin}" trong PATH`,
        };
      }
    }
    return { ok: true };
  }

  let pkg: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return { ok: false, reason: 'package.json không hợp lệ hoặc không thể đọc' };
  }

  const hasDeps = Boolean(
    (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
    (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) ||
    fs.existsSync(path.join(worktreeDir, 'package-lock.json')) ||
    fs.existsSync(path.join(worktreeDir, 'pnpm-lock.yaml')),
  );

  const nm = path.join(worktreeDir, 'node_modules');
  const binDir = path.join(nm, '.bin');

  if (hasDeps) {
    if (!fs.existsSync(nm)) {
      return {
        ok: false,
        reason: 'Không tìm thấy thư mục node_modules',
      };
    }
    if (!fs.existsSync(binDir)) {
      return {
        ok: false,
        reason: 'Không tìm thấy thư mục node_modules/.bin',
      };
    }
  }

  for (const cmd of checks) {
    const argv = splitCommand(cmd);
    if (argv.length === 0) continue;
    const first = argv[0];

    if ((first === 'npm' || first === 'pnpm' || first === 'yarn') && argv[1] === 'run' && argv[2]) {
      const scriptName = argv[2];
      const scriptCmd = pkg.scripts?.[scriptName];
      if (scriptCmd) {
        const scriptParts = splitCommand(scriptCmd);
        const scriptBin = scriptParts[0];
        const builtins = ['node', 'echo', 'sh', 'bash', 'exit', 'true', 'false', 'export', 'set', 'env', 'cd'];
        if (scriptBin && !builtins.includes(scriptBin)) {
          const inBinDir = fs.existsSync(path.join(binDir, scriptBin));
          const inPath = isCommandInPath(scriptBin);
          if (!inBinDir && !inPath) {
            return {
              ok: false,
              reason: `Không tìm thấy công cụ "${scriptBin}" (dùng trong script "${scriptName}") trong node_modules/.bin hoặc PATH`,
            };
          }
        }
      }
    } else if (['npx', 'pnpm', 'yarn'].includes(first) && argv[1]) {
      const tool = argv[1];
      if (!fs.existsSync(path.join(binDir, tool)) && !isCommandInPath(tool)) {
        return {
          ok: false,
          reason: `Không tìm thấy công cụ "${tool}" trong node_modules/.bin hoặc PATH`,
        };
      }
    } else {
      const builtins = ['node', 'npm', 'pnpm', 'npx', 'yarn', 'git', 'echo', 'sh', 'bash', 'true', 'false'];
      if (!builtins.includes(first) && !fs.existsSync(path.join(binDir, first)) && !isCommandInPath(first)) {
        return {
          ok: false,
          reason: `Không tìm thấy lệnh "${first}" trong PATH hoặc node_modules/.bin`,
        };
      }
    }
  }

  return { ok: true };
}

const ENV_ERROR_PATTERNS = [
  /(?:sh|bash|zsh):\s*(?:\d+:\s*)?\S+:\s*(?:command\s+)?not found/i,
  /\b(?:command not found|MODULE_NOT_FOUND|spawn\b.*?\bENOENT)\b/i,
  /Cannot find module\s+['"][^'"]+['"]/i,
  /\b(?:node|npm|pnpm|npx|yarn|eslint|tsc|vitest|jest|prettier):\s*(?:command\s+)?not found/i,
];

export function isEnvironmentFailure(
  result: { code: number | null; output: string; timedOut?: boolean },
): boolean {
  if (result.timedOut) return false;
  // Exit code 127 is standard POSIX exit code for command not found
  if (result.code === 127) return true;

  // When code is null, runInProcessGroup() may have received a spawn error (ENOENT)
  // or the process was terminated by a signal (e.g. OOM/SIGKILL/SIGSEGV).
  // Signal terminations without command-not-found or spawn/ENOENT output are kept as normal check failures.
  return ENV_ERROR_PATTERNS.some((pattern) => pattern.test(result.output));
}

async function rollbackMerge(repo: string, before: string, mergeCommit: string, env: NodeJS.ProcessEnv): Promise<void> {
  const current = await git(repo, ['rev-parse', 'HEAD']);
  const orig = await git(repo, ['rev-parse', 'ORIG_HEAD']).catch(() => '');
  if (current !== mergeCommit || orig !== before) {
    throw new MergeError(422, 'unprocessable_entity', 'Không an toàn để rollback merge thất bại');
  }
  await execFileAsync('git', ['reset', '--hard', 'ORIG_HEAD'], { cwd: repo, env });
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function mergeTaskIntoBase(
  task: MergeTask,
  project: MergeProject,
  options?: MergeOptions,
): Promise<{ mergeCommit: string; checks: string[] }> {
  const settings = projectSettings(project);
  let repo: string;
  let targetBranch: string;
  let checks: string[] = [];
  let timeoutSec = 600;

  if (settings.integration.enabled) {
    if (!project.id || !project.path) {
      throw new MergeError(409, 'conflict', 'Project thiếu id hoặc path để quản lý worktree tích hợp');
    }
    targetBranch = settings.integration.branch || 'agenthub/integration';
    const hubHome = options?.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub');
    try {
      repo = ensureIntegrationWorktree(
        project as { id: string; path: string; defaultBranch: string; settings?: string | null },
        hubHome,
      );
    } catch (e) {
      throw new MergeError(409, 'conflict', `Không thể chuẩn bị worktree tích hợp: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (project.merge) {
      try {
        const parsed = JSON.parse(project.merge);
        if (Array.isArray(parsed.checks)) {
          checks = parsed.checks.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '');
        }
        if (typeof parsed.timeoutSec === 'number' && parsed.timeoutSec > 0) {
          timeoutSec = parsed.timeoutSec;
        }
      } catch {
        // ignore
      }
    }
  } else {
    const config = parseConfig(project.merge);
    targetBranch = task.baseRef || project.defaultBranch;
    const integrationPath = config.worktrees[targetBranch];
    if (!integrationPath || !path.isAbsolute(integrationPath)) {
      throw new MergeError(409, 'conflict', `Chưa khai báo worktree tích hợp cho baseRef "${targetBranch}"`, true);
    }
    repo = path.resolve(integrationPath);
    checks = config.checks;
    timeoutSec = config.timeoutSec;
  }

  addExcludeRules(repo);

  // Pre-prepare node_modules in repo if worktree.install === 'auto' and node_modules is missing
  if (settings.worktree.install === 'auto') {
    const hasLock = fs.existsSync(path.join(repo, 'package-lock.json')) || fs.existsSync(path.join(repo, 'pnpm-lock.yaml'));
    const hasNm = fs.existsSync(path.join(repo, 'node_modules', '.bin'));
    if (hasLock && !hasNm) {
      try {
        await ensureWorktreeNodeModules(
          repo,
          project.path,
          options?.cacheDir,
          options?.execFn,
          options?.cachePolicy,
        );
      } catch (err) {
        console.warn(`[merge] Initial node_modules preparation failed: ${String(err)}`);
      }
    }
  }

  const branch = task.branch || renderTaskBranch(project, task);
  const status = await git(repo, ['status', '--porcelain']);
  if (status) throw new MergeError(409, 'conflict', 'worktree tích hợp có thay đổi chưa commit');

  const before = await git(repo, ['rev-parse', 'HEAD']);
  const hubHome = options?.hubHome || process.env.AGENTHUB_HOME || path.join(process.env.HOME || process.cwd(), '.agenthub');
  const env = workerEnvironment(hubHome, process.env, { project, cwd: repo, guards: false });
  const identity = await gitIdentityArgs(repo, env);
  try {
    const message = renderCommitTemplate(settings.commitConvention.mergeMessageTemplate, { branch, target: targetBranch });
    await execFileAsync('git', [...identity, 'merge', '--no-ff', branch, '-m', message], { cwd: repo, env });
  } catch {
    let conflicts = '';
    try { conflicts = await git(repo, ['diff', '--name-only', '--diff-filter=U']); } catch { /* keep original error */ }
    try { await execFileAsync('git', ['merge', '--abort'], { cwd: repo, env }); } catch { /* best effort; caller sees conflict */ }
    throw new MergeError(409, 'conflict', conflicts ? `Xung đột merge ở: ${conflicts.split('\n').filter(Boolean).join(', ')}` : 'Merge bị xung đột');
  }

  const mergeCommit = await git(repo, ['rev-parse', 'HEAD']);
  const parents = (await git(repo, ['show', '-s', '--format=%P', mergeCommit])).split(/\s+/).filter(Boolean);
  if (mergeCommit === before || !parents.includes(before) || parents.length < 2) {
    throw new MergeError(422, 'unprocessable_entity', 'Không xác minh được merge commit vừa tạo');
  }

  // Check if lockfiles changed in the merge commit
  const diffOutput = await git(repo, ['diff', '--name-only', before, mergeCommit]);
  const diffFiles = diffOutput.split(/\s+/).filter(Boolean);
  const lockFiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'web/package-lock.json',
    'web/pnpm-lock.yaml',
  ];
  const lockChanged = diffFiles.some((f) => lockFiles.includes(f));
  if (lockChanged && settings.worktree.install === 'auto') {
    try {
      try {
        fs.rmSync(path.join(repo, '.agenthub', 'root-lock.hash'), { force: true });
        fs.rmSync(path.join(repo, '.agenthub', 'web-lock.hash'), { force: true });
      } catch { /* ignore */ }
      await ensureWorktreeNodeModules(
        repo,
        project.path,
        options?.cacheDir,
        options?.execFn,
        options?.cachePolicy,
      );
    } catch (error) {
      await rollbackMerge(repo, before, mergeCommit, env);
      throw new MergeError(
        503,
        'environment_error',
        `Cài đặt lại dependency thất bại sau khi lockfile thay đổi: ${error instanceof Error ? error.message : String(error)}`,
        false,
        true,
      );
    }
  }

  // Pre-check dependencies before running checks
  let depCheck = checkWorktreeDependencies(repo, checks);
  if (!depCheck.ok && settings.worktree.install === 'auto') {
    try {
      await ensureWorktreeNodeModules(
        repo,
        project.path,
        options?.cacheDir,
        options?.execFn,
        options?.cachePolicy,
      );
    } catch {
      // ignore
    }
    depCheck = checkWorktreeDependencies(repo, checks);
  }

  if (!depCheck.ok) {
    await rollbackMerge(repo, before, mergeCommit, env);
    throw new MergeError(
      503,
      'environment_error',
      `Worktree tích hợp thiếu dependency (${depCheck.reason || 'không tìm thấy node_modules/.bin'}). Cần cài đặt dependency trước khi chạy merge-check.`,
      false,
      true,
    );
  }

  // Add node_modules/.bin to PATH for checks
  const nmBin = path.join(repo, 'node_modules', '.bin');
  if (fs.existsSync(nmBin)) {
    env.PATH = `${nmBin}${path.delimiter}${env.PATH || ''}`;
  }

  const failures: string[] = [];
  let hasEnvironmentFailure = false;
  for (const command of checks) {
    const argv = splitCommand(command);
    if (argv.length === 0) continue;
    const result = await runInProcessGroup(argv[0], argv.slice(1), {
      cwd: repo,
      env,
      timeoutMs: timeoutSec * 1000,
    });
    if (result.code !== 0 || result.timedOut) {
      const outputTail = tail(`${result.output}${result.timedOut ? `\nTimeout sau ${timeoutSec}s` : ''}`);
      failures.push(`${command}: ${outputTail}`);
      if (isEnvironmentFailure(result)) {
        hasEnvironmentFailure = true;
      }
    }
  }

  if (failures.length > 0) {
    await rollbackMerge(repo, before, mergeCommit, env);
    if (hasEnvironmentFailure) {
      throw new MergeError(
        503,
        'environment_error',
        `Checks sau merge thất bại do lỗi môi trường (lệnh không tìm thấy hoặc thiếu dependency):\n${failures.join('\n\n')}`,
        false,
        true,
      );
    }
    throw new MergeError(
      422,
      'unprocessable_entity',
      `Checks sau merge thất bại:\n${failures.join('\n\n')}`,
      false,
      false,
    );
  }

  return { mergeCommit, checks };
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
