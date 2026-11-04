import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HttpError } from '../errors.js';
import { projectSettings } from './settings.js';
import { isProjectWorktreeRootAccessible, projectWorktreeRoot } from './paths.js';
import { ensureWorktreeNodeModules, type NodeModulesCachePolicy, type EnsureNodeModulesOptions } from '../cache.js';

export interface IntegrationStatus {
  path: string;
  branch: string;
  exists: boolean;
  currentBranch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface ProjectLike {
  id: string;
  path?: string | null;
  defaultBranch: string;
  settings?: string | null;
}

/**
 * Validate integration branch name format and ensure it does not collide with main/master defaultBranch.
 */
export function validateIntegrationBranch(branch: string, defaultBranch: string): void {
  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new HttpError(400, 'bad_request', `Tên nhánh tích hợp không hợp lệ: "${branch}"`);
  }

  if ((defaultBranch === 'main' || defaultBranch === 'master') && branch === defaultBranch) {
    throw new HttpError(
      400,
      'bad_request',
      `Tên nhánh tích hợp không được trùng với defaultBranch (${defaultBranch}) khi defaultBranch là main/master`,
    );
  }
}

/**
 * Path to the integration worktree for a project.
 */
export function getIntegrationPath(project: ProjectLike, hubHome: string): string;
export function getIntegrationPath(hubHome: string, projectId: string): string;
export function getIntegrationPath(projectOrHubHome: ProjectLike | string, hubHomeOrProjectId: string): string {
  if (typeof projectOrHubHome === 'string') return path.join(projectOrHubHome, 'integration', hubHomeOrProjectId);
  if (!projectSettings(projectOrHubHome).worktree.root) {
    return path.join(hubHomeOrProjectId, 'integration', projectOrHubHome.id);
  }
  return path.join(projectWorktreeRoot({ id: projectOrHubHome.id, path: projectOrHubHome.path || hubHomeOrProjectId, settings: projectOrHubHome.settings }, hubHomeOrProjectId), '.integration');
}

export function addExcludeRules(worktreePath: string): void {
  try {
    const excludePaths: string[] = [];

    try {
      const gitPath = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (gitPath) {
        excludePaths.push(path.isAbsolute(gitPath) ? gitPath : path.join(worktreePath, gitPath));
      }
    } catch {
      // ignore
    }

    try {
      const commonDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      const resolvedCommonDir = path.isAbsolute(commonDir) ? commonDir : path.join(worktreePath, commonDir);
      excludePaths.push(path.join(resolvedCommonDir, 'info', 'exclude'));
    } catch {
      // ignore
    }

    try {
      const gitDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      excludePaths.push(path.join(resolvedGitDir, 'info', 'exclude'));
    } catch {
      // ignore
    }

    for (const excludePath of new Set(excludePaths)) {
      const infoDir = path.dirname(excludePath);
      if (!fs.existsSync(infoDir)) {
        fs.mkdirSync(infoDir, { recursive: true });
      }
      let content = '';
      if (fs.existsSync(excludePath)) {
        content = fs.readFileSync(excludePath, 'utf-8');
      }
      const lines = content.split('\n').map((l) => l.trim());
      let toAppend = '';
      if (!lines.includes('.agenthub/')) toAppend += '\n.agenthub/\n';
      if (!lines.includes('node_modules')) toAppend += 'node_modules\n';
      if (toAppend) fs.appendFileSync(excludePath, toAppend);
    }
  } catch {
    // non-critical
  }
}

function integrationRoot(hubHome: string): string {
  return path.resolve(hubHome, 'integration');
}

function isSafeIntegrationPath(worktreePath: string, hubHome: string, project?: { id: string; path?: string | null; settings?: string | null }): boolean {
  try {
    const root = fs.realpathSync(project && projectSettings(project).worktree.root
      ? projectWorktreeRoot({ id: project.id, path: project.path || hubHome, settings: project.settings }, hubHome)
      : integrationRoot(hubHome));
    const resolved = fs.realpathSync(worktreePath);
    const relative = path.relative(root, resolved);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function currentBranch(worktreePath: string): string | null {
  try {
    return execFileSync('git', ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function isDirty(worktreePath: string): boolean {
  const status = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return status.trim().length > 0;
}

function branchWorktreePath(repoPath: string, branch: string): string | null {
  try {
    const listing = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const entries = listing.split(/\n\n+/);
    for (const entry of entries) {
      if (entry.split('\n').some((line) => line === `branch refs/heads/${branch}`)) {
        return entry.split('\n')[0]?.replace(/^worktree /, '') || null;
      }
    }
  } catch {
    // The caller will report the original git error if the worktree list is unavailable.
  }
  return null;
}

function throwBranchCheckoutError(repoPath: string, branch: string, error: unknown): never {
  const checkedOutAt = branchWorktreePath(repoPath, branch);
  if (checkedOutAt) {
    throw new HttpError(409, 'conflict', `Nhánh ${branch} đang được checkout tại ${checkedOutAt}; chọn tên nhánh tích hợp khác`);
  }
  throw error;
}

/**
 * Ensure the hub-managed integration worktree exists at <hubHome>/integration/<projectId>.
 * Reuses existing worktree if present. If branch does not exist, creates it from baseRef with -b.
 * Never checks out branches in the user's working directory.
 */
export function ensureIntegrationWorktree(project: ProjectLike, hubHome: string): string {
  if (!project.path || !fs.existsSync(project.path)) {
    throw new HttpError(400, 'bad_request', `Thư mục repo không tồn tại: ${project.path}`);
  }

  const settings = projectSettings(project);
  if (settings.worktree.root && !isProjectWorktreeRootAccessible({
    id: project.id,
    path: project.path || hubHome,
    settings: project.settings,
  })) {
    throw new HttpError(503, 'unavailable', `Worktree root không truy cập được: ${settings.worktree.root}`);
  }
  const branch = settings.integration.branch || 'agenthub/integration';
  const baseRef = settings.integration.baseRef || project.defaultBranch;

  validateIntegrationBranch(branch, project.defaultBranch);

  const integrationPath = getIntegrationPath(project, hubHome);

  if (fs.existsSync(integrationPath)) {
    let inside = '';
    try {
      inside = execFileSync('git', ['-C', integrationPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new HttpError(503, 'unavailable', `Worktree tích hợp ${integrationPath} không sử dụng được; kiểm tra quyền truy cập, index.lock hoặc khôi phục repo rồi thử lại`);
    }
    if (inside === 'true') {
      const dirty = isDirty(integrationPath);
      const checkedOutBranch = currentBranch(integrationPath);
      if (checkedOutBranch === branch) return integrationPath;
      if (dirty) {
        throw new HttpError(409, 'conflict', `Worktree tích hợp ${integrationPath} có thay đổi chưa commit; không thể chuyển sang nhánh ${branch}`);
      }
      try {
        if (branchExistsInRepo(project.path, branch)) {
          execFileSync('git', ['-C', integrationPath, 'switch', branch], { stdio: ['pipe', 'pipe', 'pipe'] });
        } else {
          execFileSync('git', ['-C', integrationPath, 'switch', '-c', branch, baseRef], { stdio: ['pipe', 'pipe', 'pipe'] });
        }
      } catch (error) {
        throwBranchCheckoutError(project.path, branch, error);
      }
      addExcludeRules(integrationPath);
      return integrationPath;
    }
    throw new HttpError(503, 'unavailable', `Worktree tích hợp ${integrationPath} không sử dụng được; kiểm tra quyền truy cập, index.lock hoặc khôi phục repo rồi thử lại`);
  }

  const parentDir = path.dirname(integrationPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  try {
    execFileSync('git', ['-C', project.path, 'worktree', 'prune'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    // ignore
  }

  const branchExists = branchExistsInRepo(project.path, branch);

  try {
    if (branchExists) {
      execFileSync('git', ['-C', project.path, 'worktree', 'add', integrationPath, branch], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      execFileSync('git', ['-C', project.path, 'worktree', 'add', '-b', branch, integrationPath, baseRef], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  } catch (error) {
    throwBranchCheckoutError(project.path, branch, error);
  }

  addExcludeRules(integrationPath);
  return integrationPath;
}

/**
 * Ensure node_modules are prepared in the integration worktree according to worktree.install policy.
 */
export async function ensureIntegrationNodeModules(
  project: ProjectLike,
  hubHome: string,
  options?: {
    cacheDir?: string;
    cacheMaxEntries?: number;
    cacheMaxGB?: number;
    cachePolicy?: NodeModulesCachePolicy;
    execFn?: EnsureNodeModulesOptions['execFn'];
  },
): Promise<void> {
  const settings = projectSettings(project);
  if (settings.worktree.install !== 'auto') return;
  const integrationPath = getIntegrationPath(project, hubHome);
  if (!fs.existsSync(integrationPath)) return;
  const hasDependencyLock = (dir: string): boolean =>
    fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'pnpm-lock.yaml'));
  if (
    !hasDependencyLock(integrationPath) &&
    !hasDependencyLock(path.join(integrationPath, 'web')) &&
    !fs.existsSync(path.join(integrationPath, 'package.json'))
  ) {
    return;
  }
  const cachePolicy = options?.cachePolicy || {
    maxEntries: options?.cacheMaxEntries,
    maxBytes: options?.cacheMaxGB !== undefined ? options.cacheMaxGB * 1024 ** 3 : undefined,
  };
  await ensureWorktreeNodeModules(
    integrationPath,
    project.path || undefined,
    options?.cacheDir,
    options?.execFn,
    cachePolicy,
  );
}

function branchExistsInRepo(repoPath: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current integration status: { path, branch, exists, ahead, behind }
 */
export function getIntegrationStatus(project: ProjectLike, hubHome: string): IntegrationStatus {
  const settings = projectSettings(project);
  const branch = settings.integration.branch || 'agenthub/integration';
  const baseRef = settings.integration.baseRef || project.defaultBranch;
  const integrationPath = getIntegrationPath(project, hubHome);

  let exists = false;
  let currentBranchName: string | null = null;
  let dirty = false;
  if (fs.existsSync(integrationPath)) {
    try {
      const inside = execFileSync('git', ['-C', integrationPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      exists = inside === 'true';
      if (exists) {
        currentBranchName = currentBranch(integrationPath);
        try { dirty = isDirty(integrationPath); } catch { dirty = true; }
      }
    } catch {
      exists = false;
    }
  }

  let ahead = 0;
  let behind = 0;

  if (project.path && fs.existsSync(project.path)) {
    try {
      const aheadOut = execFileSync(
        'git',
        ['-C', project.path, 'rev-list', '--count', `${baseRef}..${branch}`],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      ).trim();
      ahead = parseInt(aheadOut, 10) || 0;
    } catch {
      ahead = 0;
    }

    try {
      const behindOut = execFileSync(
        'git',
        ['-C', project.path, 'rev-list', '--count', `${branch}..${baseRef}`],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      ).trim();
      behind = parseInt(behindOut, 10) || 0;
    } catch {
      behind = 0;
    }
  }

  return {
    path: integrationPath,
    branch,
    exists,
    currentBranch: currentBranchName,
    dirty,
    ahead,
    behind,
  };
}

/**
 * Remove integration worktree (without deleting the branch).
 */
export function removeIntegrationWorktree(project: { id: string; path?: string | null; settings?: string | null }, hubHome: string): string | null {
  const integrationPath = getIntegrationPath({ ...project, defaultBranch: '' }, hubHome);
  if (!fs.existsSync(integrationPath)) return null;
  if (!isSafeIntegrationPath(integrationPath, hubHome, project)) {
    return `Không thể gỡ worktree tích hợp ${integrationPath}: đường dẫn không an toàn`;
  }
  if (!project.path || !fs.existsSync(project.path)) {
    return `Không thể gỡ worktree tích hợp ${integrationPath}: repo project không tồn tại`;
  }

  try {
    if (isDirty(integrationPath)) {
      return `Giữ nguyên worktree tích hợp ${integrationPath} vì có thay đổi chưa commit`;
    }
  } catch {
    return `Không thể kiểm tra trạng thái worktree tích hợp ${integrationPath}; giữ nguyên để tránh mất dữ liệu`;
  }

  try {
    execFileSync('git', ['-C', project.path, 'worktree', 'remove', integrationPath], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    execFileSync('git', ['-C', project.path, 'worktree', 'prune'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return `Không thể gỡ worktree tích hợp ${integrationPath}; giữ nguyên để tránh mất dữ liệu`;
  }
  return null;
}
