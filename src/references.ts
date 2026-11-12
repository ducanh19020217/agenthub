import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface GitReferenceSnapshot {
  kind: 'git';
  name: string;
  path: string;
  head: string | null;
  status: string;
  unavailable?: boolean;
}

export interface DirFileEntry {
  mtimeMs: number;
  size: number;
}

export interface DirReferenceSnapshot {
  kind: 'dir';
  name: string;
  path: string;
  files: Map<string, DirFileEntry>;
}

export interface FileReferenceSnapshot {
  kind: 'file';
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
  sha256?: string;
}

export interface MissingReferenceSnapshot {
  kind: 'missing';
  name: string;
  path: string;
}

export type ReferenceSnapshot =
  | GitReferenceSnapshot
  | DirReferenceSnapshot
  | FileReferenceSnapshot
  | MissingReferenceSnapshot;

export interface ReferenceModification {
  name: string;
  path: string;
  modifiedFiles: string[];
}

const MAX_DIR_FILES = 5000;
const GIT_EXEC_OPTIONS = {
  encoding: 'utf8' as const,
  stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
  timeout: 10_000,
  maxBuffer: 1024 * 1024,
};

function runGit(refPath: string, args: string[]): { value: string | null; timedOut: boolean } {
  try {
    return { value: execFileSync('git', args, { cwd: refPath, ...GIT_EXEC_OPTIONS }).trim(), timedOut: false };
  } catch (error) {
    const timedOut = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    if (timedOut) console.warn(`Reference git command timed out after 10s: ${refPath} git ${args.join(' ')}`);
    return { value: null, timedOut };
  }
}

async function runGitAsync(refPath: string, args: string[]): Promise<{ value: string | null; timedOut: boolean }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: refPath, encoding: 'utf8', timeout: GIT_EXEC_OPTIONS.timeout, maxBuffer: GIT_EXEC_OPTIONS.maxBuffer });
    return { value: stdout.trim(), timedOut: false };
  } catch (error) {
    const timedOut = error instanceof Error && 'code' in error && ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    if (timedOut) console.warn(`Reference git command timed out after 10s: ${refPath} git ${args.join(' ')}`);
    return { value: null, timedOut };
  }
}

function walkDir(dir: string, baseDir = dir, acc = new Map<string, DirFileEntry>()): Map<string, DirFileEntry> {
  if (acc.size >= MAX_DIR_FILES) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (acc.size >= MAX_DIR_FILES) break;
    // Skip common version control or package manager directories in non-git reference walks
    if (entry.name === '.git' || entry.name === 'node_modules') continue;

    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        walkDir(fullPath, baseDir, acc);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        const relPath = path.relative(baseDir, fullPath);
        acc.set(relPath, { mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      // Ignore unreadable files or broken links
    }
  }

  return acc;
}

export function takeReferenceSnapshot(ref: { name: string; path: string }): ReferenceSnapshot {
  if (!fs.existsSync(ref.path)) {
    return {
      kind: 'missing',
      name: ref.name,
      path: ref.path,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(ref.path);
  } catch {
    return {
      kind: 'missing',
      name: ref.name,
      path: ref.path,
    };
  }

  if (stat.isFile()) {
    let sha256: string | undefined;
    try {
      sha256 = crypto.createHash('sha256').update(fs.readFileSync(ref.path)).digest('hex');
    } catch {
      sha256 = undefined;
    }
    return {
      kind: 'file',
      name: ref.name,
      path: ref.path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256,
    };
  }

  // Directory: check if it is a git repository
  const gitDir = path.join(ref.path, '.git');
  if (fs.existsSync(gitDir)) {
    const headResult = runGit(ref.path, ['rev-parse', 'HEAD']);
    const statusResult = runGit(ref.path, ['status', '--porcelain']);

    return {
      kind: 'git',
      name: ref.name,
      path: ref.path,
      head: headResult.value,
      status: statusResult.value ?? '',
      unavailable: headResult.timedOut || statusResult.timedOut,
    };
  }

  // Regular directory
  const files = walkDir(ref.path);
  return {
    kind: 'dir',
    name: ref.name,
    path: ref.path,
    files,
  };
}

/** Async variant: uses execFile for git calls to avoid blocking the event loop. */
export async function takeReferenceSnapshotAsync(ref: { name: string; path: string }): Promise<ReferenceSnapshot> {
  if (!fs.existsSync(ref.path)) {
    return { kind: 'missing', name: ref.name, path: ref.path };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(ref.path);
  } catch {
    return { kind: 'missing', name: ref.name, path: ref.path };
  }

  if (stat.isFile()) {
    let sha256: string | undefined;
    try {
      sha256 = crypto.createHash('sha256').update(fs.readFileSync(ref.path)).digest('hex');
    } catch {
      sha256 = undefined;
    }
    return { kind: 'file', name: ref.name, path: ref.path, mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
  }

  const gitDir = path.join(ref.path, '.git');
  if (fs.existsSync(gitDir)) {
    const [headResult, statusResult] = await Promise.all([
      runGitAsync(ref.path, ['rev-parse', 'HEAD']),
      runGitAsync(ref.path, ['status', '--porcelain']),
    ]);
    return {
      kind: 'git',
      name: ref.name,
      path: ref.path,
      head: headResult.value,
      status: statusResult.value ?? '',
      unavailable: headResult.timedOut || statusResult.timedOut,
    };
  }

  const files = walkDir(ref.path);
  return { kind: 'dir', name: ref.name, path: ref.path, files };
}

export function takeReferenceSnapshots(references: Array<{ name: string; path: string }>): ReferenceSnapshot[] {
  return references.map((ref) => takeReferenceSnapshot(ref));
}

/** Async variant: takes snapshots in parallel (up to all concurrently). */
export async function takeReferenceSnapshotsAsync(references: Array<{ name: string; path: string }>): Promise<ReferenceSnapshot[]> {
  return Promise.all(references.map((ref) => takeReferenceSnapshotAsync(ref)));
}

function parsePorcelainFiles(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const p = l.slice(2).trim();
      return p.includes(' -> ') ? p.split(' -> ')[1] : p;
    });
}

export function detectReferenceModifications(snapshots: ReferenceSnapshot[]): ReferenceModification[] {
  const modifications: ReferenceModification[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.kind === 'missing') {
      if (fs.existsSync(snapshot.path)) {
        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: [snapshot.path],
        });
      }
      continue;
    }

    if (!fs.existsSync(snapshot.path)) {
      modifications.push({
        name: snapshot.name,
        path: snapshot.path,
        modifiedFiles: [path.basename(snapshot.path)],
      });
      continue;
    }

    if (snapshot.kind === 'file') {
      try {
        const stat = fs.statSync(snapshot.path);
        let currentHash: string | undefined;
        try {
          currentHash = crypto.createHash('sha256').update(fs.readFileSync(snapshot.path)).digest('hex');
        } catch {
          currentHash = undefined;
        }
        if (
          stat.size !== snapshot.size ||
          stat.mtimeMs !== snapshot.mtimeMs ||
          (snapshot.sha256 !== undefined && currentHash !== snapshot.sha256)
        ) {
          modifications.push({
            name: snapshot.name,
            path: snapshot.path,
            modifiedFiles: [path.basename(snapshot.path)],
          });
        }
      } catch {
        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: [path.basename(snapshot.path)],
        });
      }
      continue;
    }

    if (snapshot.kind === 'git') {
      if (snapshot.unavailable) continue;
      const headResult = runGit(snapshot.path, ['rev-parse', 'HEAD']);
      const statusResult = runGit(snapshot.path, ['status', '--porcelain']);
      if (headResult.timedOut || statusResult.timedOut) continue;
      const currentHead = headResult.value;
      const currentStatus = statusResult.value ?? '';

      if (currentHead !== snapshot.head || currentStatus !== snapshot.status) {
        const fileSet = new Set<string>();

        // Files from status difference
        for (const f of parsePorcelain(currentStatus)) {
          fileSet.add(f);
        }

        // Files from commit difference if HEAD changed
        if (snapshot.head && currentHead && snapshot.head !== currentHead) {
          try {
            const diffResult = runGit(snapshot.path, ['diff', '--name-only', `${snapshot.head}..${currentHead}`]);
            if (diffResult.timedOut) continue;
            for (const f of (diffResult.value ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) {
              fileSet.add(f);
            }
          } catch {
            fileSet.add(`(HEAD: ${snapshot.head} -> ${currentHead})`);
          }
        }

        if (fileSet.size === 0) {
          fileSet.add('(git repository status changed)');
        }

        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: Array.from(fileSet),
        });
      }
      continue;
    }

    if (snapshot.kind === 'dir') {
      const currentFiles = walkDir(snapshot.path);
      const changed: string[] = [];

      // Check for removed or modified files
      for (const [relPath, entry] of snapshot.files) {
        const currentEntry = currentFiles.get(relPath);
        if (!currentEntry) {
          changed.push(relPath);
        } else if (currentEntry.size !== entry.size || currentEntry.mtimeMs !== entry.mtimeMs) {
          changed.push(relPath);
        }
      }

      // Check for added files
      for (const relPath of currentFiles.keys()) {
        if (!snapshot.files.has(relPath)) {
          changed.push(relPath);
        }
      }

      if (changed.length > 0) {
        modifications.push({
          name: snapshot.name,
          path: snapshot.path,
          modifiedFiles: changed,
        });
      }
    }
  }

  return modifications;
}

function parsePorcelain(porcelain: string): string[] {
  return parsePorcelainFiles(porcelain);
}

/** Async variant: uses execFile for git calls to avoid blocking the event loop. */
export async function detectReferenceModificationsAsync(snapshots: ReferenceSnapshot[]): Promise<ReferenceModification[]> {
  const modifications: ReferenceModification[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.kind === 'missing') {
      if (fs.existsSync(snapshot.path)) {
        modifications.push({ name: snapshot.name, path: snapshot.path, modifiedFiles: [snapshot.path] });
      }
      continue;
    }

    if (!fs.existsSync(snapshot.path)) {
      modifications.push({ name: snapshot.name, path: snapshot.path, modifiedFiles: [path.basename(snapshot.path)] });
      continue;
    }

    if (snapshot.kind === 'file') {
      try {
        const stat = fs.statSync(snapshot.path);
        let currentHash: string | undefined;
        try { currentHash = crypto.createHash('sha256').update(fs.readFileSync(snapshot.path)).digest('hex'); } catch { currentHash = undefined; }
        if (stat.size !== snapshot.size || stat.mtimeMs !== snapshot.mtimeMs || (snapshot.sha256 !== undefined && currentHash !== snapshot.sha256)) {
          modifications.push({ name: snapshot.name, path: snapshot.path, modifiedFiles: [path.basename(snapshot.path)] });
        }
      } catch {
        modifications.push({ name: snapshot.name, path: snapshot.path, modifiedFiles: [path.basename(snapshot.path)] });
      }
      continue;
    }

    if (snapshot.kind === 'git') {
      if (snapshot.unavailable) continue;
      const [headResult, statusResult] = await Promise.all([
        runGitAsync(snapshot.path, ['rev-parse', 'HEAD']),
        runGitAsync(snapshot.path, ['status', '--porcelain']),
      ]);
      if (headResult.timedOut || statusResult.timedOut) continue;
      const currentHead = headResult.value;
      const currentStatus = statusResult.value ?? '';

      if (currentHead !== snapshot.head || currentStatus !== snapshot.status) {
        const fileSet = new Set<string>();
        for (const f of parsePorcelain(currentStatus)) fileSet.add(f);
        if (snapshot.head && currentHead && snapshot.head !== currentHead) {
          const diffResult = await runGitAsync(snapshot.path, ['diff', '--name-only', `${snapshot.head}..${currentHead}`]);
          if (!diffResult.timedOut) {
            for (const f of (diffResult.value ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) fileSet.add(f);
          }
        }
        if (fileSet.size === 0) fileSet.add('(git repository status changed)');
        modifications.push({ name: snapshot.name, path: snapshot.path, modifiedFiles: Array.from(fileSet) });
      }
      continue;
    }

    if (snapshot.kind === 'dir') {
      const currentFiles = walkDir(snapshot.path);
      const changed: string[] = [];
      for (const [relPath, entry] of snapshot.files) {
        const currentEntry = currentFiles.get(relPath);
        if (!currentEntry) changed.push(relPath);
        else if (currentEntry.size !== entry.size || currentEntry.mtimeMs !== entry.mtimeMs) changed.push(relPath);
      }
      for (const relPath of currentFiles.keys()) {
        if (!snapshot.files.has(relPath)) changed.push(relPath);
      }
      if (changed.length > 0) modifications.push({ name: snapshot.name, path: snapshot.path, modifiedFiles: changed });
    }
  }

  return modifications;
}
