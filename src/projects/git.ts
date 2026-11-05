import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export interface GitProjectStatus {
  path: string;
  currentBranch: string | null;
  defaultBranch: string;
  dirty: { changed: boolean; files: number };
  remote: string | null;
  localBranches: string[];
  remoteBranches: string[];
  aheadBehind: { ahead: number; behind: number } | null;
}

async function git(path: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', path, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

function sanitizeRemote(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `ssh://${value}`);
    url.username = '';
    url.password = '';
    return url.toString().replace(/^ssh:\/\//, '').replace(/\/$/, '');
  } catch {
    return value.replace(/(ssh:\/\/|https?:\/\/)([^/@]+):([^/@]+)@/i, '$1').trim();
  }
}

export async function inspectGitProject(repoPath: string, defaultBranch: string): Promise<GitProjectStatus> {
  try {
    const [current, locals, remotes, dirtyOutput, remoteOutput] = await Promise.all([
      git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
      git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']),
      git(repoPath, ['status', '--porcelain']),
      git(repoPath, ['remote', 'get-url', 'origin']).catch(() => ''),
    ]);
    const localBranches = locals.split('\n').map((item) => item.trim()).filter(Boolean);
    const remoteBranches = remotes.split('\n').map((item) => item.trim()).filter(Boolean)
      .filter((item) => item !== 'origin/HEAD')
      .map((item) => item.replace(/^origin\//, ''));
    let aheadBehind: { ahead: number; behind: number } | null = null;
    if (remoteBranches.includes(defaultBranch)) {
      try {
        const counts = await git(repoPath, ['rev-list', '--left-right', '--count', `${defaultBranch}...origin/${defaultBranch}`]);
        const [ahead, behind] = counts.split(/\s+/).map(Number);
        if (Number.isFinite(ahead) && Number.isFinite(behind)) aheadBehind = { ahead, behind };
      } catch { /* branch may not exist locally yet */ }
    }
    return {
      path: repoPath,
      currentBranch: current,
      defaultBranch,
      dirty: { changed: dirtyOutput.length > 0, files: dirtyOutput ? dirtyOutput.split('\n').filter(Boolean).length : 0 },
      remote: remoteOutput ? sanitizeRemote(remoteOutput) : null,
      localBranches,
      remoteBranches,
      aheadBehind,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Không thể đọc git repository "${repoPath}": ${message}`);
  }
}
