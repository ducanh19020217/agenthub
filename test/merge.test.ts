import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeTaskIntoBase, MergeError, isEnvironmentFailure } from '../src/merge.js';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(): { root: string; integration: string; branch: string; before: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-merge-'));
  tempDirs.push(root);
  git(root, 'init');
  git(root, 'checkout', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'AgentHub Test');
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', 'agenthub/task');
  git(root, 'checkout', 'agenthub/task');
  git(root, 'worktree', 'add', path.join(root, 'integration'), 'main');
  const branch = 'agenthub/task';
  fs.writeFileSync(path.join(root, 'file.txt'), 'worker\n');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-m', 'worker change');
  const before = git(path.join(root, 'integration'), 'rev-parse', 'HEAD');
  return { root, integration: path.join(root, 'integration'), branch, before };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mergeTaskIntoBase', () => {
  it('merges cleanly and runs configured checks', async () => {
    const f = fixture();
    const result = await mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['node -e "process.exit(0)"'], timeoutSec: 30 }) },
    );
    expect(result.mergeCommit).not.toBe(f.before);
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
    expect(git(f.integration, 'log', '-1', '--pretty=%s')).toContain('Merge branch');
  });

  it('aborts a conflict and leaves the integration worktree clean', async () => {
    const f = fixture();
    git(f.integration, 'checkout', '-b', 'integration-change');
    fs.writeFileSync(path.join(f.integration, 'file.txt'), 'integration\n');
    git(f.integration, 'add', 'file.txt');
    git(f.integration, 'commit', '-m', 'integration change');
    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: [], timeoutSec: 30 }) },
    )).rejects.toMatchObject<Partial<MergeError>>({ statusCode: 409 });
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
    expect(git(f.integration, 'rev-parse', 'HEAD')).not.toBe(f.before);
  });

  it('does not abort merge in progress in a user-declared worktree and returns 409', async () => {
    const f = fixture();
    git(f.integration, 'checkout', '-b', 'conflict-branch');
    fs.writeFileSync(path.join(f.integration, 'file.txt'), 'conflict user\n');
    git(f.integration, 'add', 'file.txt');
    git(f.integration, 'commit', '-m', 'user commit');
    try {
      execFileSync('git', ['merge', '--no-ff', f.branch], { cwd: f.integration, stdio: 'pipe' });
    } catch {
      // expected conflict -> leaves MERGE_HEAD
    }
    expect(git(f.integration, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBeTruthy();

    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'conflict-branch' },
      {
        defaultBranch: 'main',
        settings: JSON.stringify({ integration: { enabled: false } }),
        merge: JSON.stringify({ enabled: true, worktrees: { 'conflict-branch': f.integration }, checks: [] }),
      },
    )).rejects.toMatchObject<Partial<MergeError>>({ statusCode: 409 });

    // Verify MERGE_HEAD was NOT aborted and remains intact for the user
    expect(git(f.integration, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBeTruthy();
  });

  it('aborts dangling MERGE_HEAD from an interrupted merge in a hub-managed integration worktree and proceeds', async () => {
    const f = fixture();
    const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-home-'));
    tempDirs.push(hubHome);

    const project = {
      id: 'test-proj',
      path: f.root,
      defaultBranch: 'main',
      settings: JSON.stringify({ integration: { enabled: true, branch: 'agenthub/integration' } }),
    };

    const { ensureIntegrationWorktree } = await import('../src/projects/integration.js');
    const integrationWorktree = ensureIntegrationWorktree(project, hubHome);

    git(f.root, 'branch', 'other-branch');
    git(f.root, 'checkout', 'other-branch');
    fs.writeFileSync(path.join(f.root, 'conflict.txt'), 'from other\n');
    git(f.root, 'add', 'conflict.txt');
    git(f.root, 'commit', '-m', 'conflict commit');

    fs.writeFileSync(path.join(integrationWorktree, 'conflict.txt'), 'from integration\n');
    git(integrationWorktree, 'add', 'conflict.txt');
    git(integrationWorktree, 'commit', '-m', 'integration conflict commit');

    try {
      execFileSync('git', ['merge', '--no-ff', 'other-branch'], { cwd: integrationWorktree, stdio: 'pipe' });
    } catch {
      // conflict -> leaves MERGE_HEAD
    }
    expect(git(integrationWorktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBeTruthy();

    const result = await mergeTaskIntoBase(
      { slug: 'task', branch: f.branch },
      project,
      { hubHome },
    );

    expect(result.mergeCommit).toBeDefined();
    expect(git(integrationWorktree, 'status', '--porcelain')).toBe('');
  });

  it('rolls back only the merge commit when checks fail', async () => {
    const f = fixture();
    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['node -e "process.exit(1)"'], timeoutSec: 30 }) },
    )).rejects.toMatchObject<Partial<MergeError>>({ statusCode: 422 });
    expect(git(f.integration, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
  });

  it('installs missing node_modules before running merge checks', async () => {
    const f = fixture();
    const pkg = {
      name: 'test-app',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
      dependencies: { foo: '^1.0.0' },
    };
    fs.writeFileSync(path.join(f.integration, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(f.integration, 'package-lock.json'), JSON.stringify({ name: 'test-app', lockfileVersion: 3 }, null, 2));
    git(f.integration, 'add', '.');
    git(f.integration, 'commit', '-m', 'add package.json');
    fs.rmSync(path.join(f.integration, 'node_modules'), { recursive: true, force: true });

    let installCalled = false;
    const fakeExecFn = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (cmd === 'npm' && args[0] === 'ci') {
        installCalled = true;
        const cwd = opts?.cwd || f.integration;
        const binDir = path.join(cwd, 'node_modules', '.bin');
        fs.mkdirSync(binDir, { recursive: true });
        return { stdout: 'installed', stderr: '' };
      }
      const out = execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' });
      return { stdout: String(out), stderr: '' };
    };

    const result = await mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['npm run test'], timeoutSec: 30 }) },
      { execFn: fakeExecFn },
    );
    expect(installCalled).toBe(true);
    expect(result.mergeCommit).toBeDefined();
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
  });

  it('fails with environment_error (503) and rolls back when node_modules is missing and installation is skipped', async () => {
    const f = fixture();
    const pkg = {
      name: 'test-app',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
      dependencies: { foo: '^1.0.0' },
    };
    fs.writeFileSync(path.join(f.integration, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(f.integration, 'package-lock.json'), JSON.stringify({ name: 'test-app', lockfileVersion: 3 }, null, 2));
    git(f.integration, 'add', '.');
    git(f.integration, 'commit', '-m', 'add package.json');
    const before = git(f.integration, 'rev-parse', 'HEAD');
    fs.rmSync(path.join(f.integration, 'node_modules'), { recursive: true, force: true });

    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      {
        defaultBranch: 'main',
        settings: JSON.stringify({ worktree: { install: 'skip' } }),
        merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['npm run test'], timeoutSec: 30 }),
      },
    )).rejects.toMatchObject<Partial<MergeError>>({
      statusCode: 503,
      error: 'environment_error',
      environment: true,
    });
    expect(git(f.integration, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
  });

  it('fails with environment_error (503) and rolls back when check exits with code 127', async () => {
    const f = fixture();
    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['sh -c "exit 127"'], timeoutSec: 30 }) },
    )).rejects.toMatchObject<Partial<MergeError>>({
      statusCode: 503,
      error: 'environment_error',
      environment: true,
    });
    expect(git(f.integration, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
  });

  it('treats check terminated by signal as normal check failure (422) and rolls back', async () => {
    const f = fixture();
    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['sh -c "kill -9 $$"'], timeoutSec: 30 }) },
    )).rejects.toMatchObject<Partial<MergeError>>({
      statusCode: 422,
      error: 'unprocessable_entity',
      environment: false,
    });
    expect(git(f.integration, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
  });

  it('reinstalls dependencies when package-lock.json changes in merge commit', async () => {
    const f = fixture();
    const pkg = { name: 'test-app', version: '1.0.0', dependencies: { foo: '1.0.0' } };
    fs.writeFileSync(path.join(f.integration, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(f.integration, 'package-lock.json'), JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2));
    const nmBin = path.join(f.integration, 'node_modules', '.bin');
    fs.mkdirSync(nmBin, { recursive: true });
    git(f.integration, 'add', 'package.json', 'package-lock.json');
    git(f.integration, 'commit', '-m', 'initial lock');
    const beforeHead = git(f.integration, 'rev-parse', 'HEAD');

    // Make task branch rebase/merge from main
    git(f.root, 'merge', 'main');
    // On task branch, modify package-lock.json
    fs.writeFileSync(path.join(f.root, 'package-lock.json'), JSON.stringify({ name: 'test-app', version: '2.0.0' }, null, 2));
    git(f.root, 'add', 'package-lock.json');
    git(f.root, 'commit', '-m', 'update lock on task');

    let ciCalled = false;
    const fakeExecFn = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      if (cmd === 'npm' && args[0] === 'ci') {
        ciCalled = true;
        const cwd = opts?.cwd || f.integration;
        fs.mkdirSync(path.join(cwd, 'node_modules', '.bin'), { recursive: true });
        return { stdout: 'ok', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const result = await mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['node -e "process.exit(0)"'], timeoutSec: 30 }) },
      { execFn: fakeExecFn },
    );
    expect(ciCalled).toBe(true);
    expect(result.mergeCommit).not.toBe(beforeHead);
  });
});

describe('isEnvironmentFailure', () => {
  it('returns true for exit code 127 regardless of output', () => {
    expect(isEnvironmentFailure({ code: 127, output: '' })).toBe(true);
    expect(isEnvironmentFailure({ code: 127, output: 'anything' })).toBe(true);
  });

  it('returns false when timedOut is true', () => {
    expect(isEnvironmentFailure({ code: 127, output: 'sh: 1: cmd: not found', timedOut: true })).toBe(false);
    expect(isEnvironmentFailure({ code: null, output: 'spawn cmd ENOENT', timedOut: true })).toBe(false);
  });

  it('returns true when output confirms spawn/ENOENT error', () => {
    expect(isEnvironmentFailure({ code: null, output: 'Error: spawn eslint ENOENT' })).toBe(true);
    expect(isEnvironmentFailure({ code: null, output: 'Error: spawn /custom/bin/tsc ENOENT' })).toBe(true);
    expect(isEnvironmentFailure({ code: null, output: 'spawn ENOENT' })).toBe(true);
    expect(isEnvironmentFailure({ code: 1, output: 'Error: spawn eslint ENOENT' })).toBe(true);
  });

  it('returns false when code is null due to signal termination without spawn error', () => {
    // Process terminated by SIGKILL / OOM
    expect(isEnvironmentFailure({ code: null, output: 'Killed' })).toBe(false);
    expect(isEnvironmentFailure({ code: null, output: '' })).toBe(false);
    // Process crashed with SIGSEGV
    expect(isEnvironmentFailure({ code: null, output: 'Segmentation fault (core dumped)' })).toBe(false);
    // Vitest failure interrupted or killed
    expect(isEnvironmentFailure({ code: null, output: 'FAIL test/example.test.ts\nExpected 1 to be 2' })).toBe(false);
  });

  it('returns true when output matches shell command not found patterns', () => {
    expect(isEnvironmentFailure({ code: 1, output: 'sh: 1: eslint: not found' })).toBe(true);
    expect(isEnvironmentFailure({ code: 1, output: 'bash: line 1: tsc: command not found' })).toBe(true);
    expect(isEnvironmentFailure({ code: 1, output: 'zsh: command not found: vitest' })).toBe(true);
    expect(isEnvironmentFailure({ code: 1, output: 'eslint: not found' })).toBe(true);
    expect(isEnvironmentFailure({ code: 1, output: 'tsc: not found' })).toBe(true);
  });

  it('returns true when output indicates missing module', () => {
    expect(isEnvironmentFailure({ code: 1, output: 'npm ERR! code MODULE_NOT_FOUND' })).toBe(true);
    expect(isEnvironmentFailure({ code: 1, output: "Error: Cannot find module '@eslint/js'" })).toBe(true);
  });

  it('returns false for normal test or lint check failures', () => {
    expect(isEnvironmentFailure({ code: 1, output: '1 error and 0 warnings found by eslint' })).toBe(false);
    expect(isEnvironmentFailure({ code: 2, output: 'error TS2322: Type "string" is not assignable to type "number".' })).toBe(false);
    expect(isEnvironmentFailure({ code: 1, output: 'FAIL test/merge.test.ts\nAssertionError: expected true to be false' })).toBe(false);
  });
});
