import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDatabase, ProjectRow, TaskRow } from '../src/db/index.js';
import { CheckRunner, detectChecks, getCheckResults } from '../src/checks.js';
import { WorktreeService } from '../src/worktrees/index.js';
import { loadConfig } from '../src/config.js';

describe('checks and worktree excludes', () => {
  it('filters heavy checks only when auto-detected and does not reuse stale results on a fresh run', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-heavy-test-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { lint: 'echo lint', 'package-release': 'echo release' } }));
    expect(detectChecks(tmp).map((check) => check.name)).toEqual(['lint']);
    const db = openDatabase(path.join(tmp, 'hub.db'));
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel) VALUES (?, ?, ?, ?, ?)').run('p1', 'P1', tmp, 'main', 1);
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run('p1/t1', 'p1', 't1', 'T1', 'review');
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run('run-1', 'p1/t1', 'agy', 'model', 'p1');
    db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('p1/t1', 'run-1', 'lint', 0, 1, 1, 'stale');
    const runner = new CheckRunner(db);
    const project = { id: 'p1', name: 'P1', path: tmp, defaultBranch: 'main', maxParallel: 1,
      checks: JSON.stringify([{ name: 'package-release', cmd: [process.execPath, '-e', 'process.exit(0)'] }]) } as ProjectRow;
    const task = { id: 'p1/t1', projectId: 'p1', slug: 't1', title: 'T1', body: '', level: 'easy', modelChain: null,
      baseRef: 'main', branch: 'main', worktreePath: tmp, status: 'review', dependsOn: '[]', attempt: 0, resume: 0,
      createdAt: '', updatedAt: '', checkFixAttempts: 0 } as TaskRow;
    const result = await runner.run(task, project, 'run-1');
    expect(result.results.map((check) => check.name)).toContain('package-release');
    expect(result.results.find((check) => check.name === 'package-release')?.ok).toBe(true);
    expect(result.results.find((check) => check.name === 'lint')).toBeUndefined();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns only the latest autocheck run', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-latest-test-'));
    const db = openDatabase(path.join(tmp, 'hub.db'));
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel) VALUES (?, ?, ?, ?, ?)').run('p1', 'P1', tmp, 'main', 1);
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run('p1/t1', 'p1', 't1', 'T1', 'review');
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old-run', 'p1/t1', 'agy', 'model', 'p1', '2026-10-15 10:00:00');
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('new-run', 'p1/t1', 'agy', 'model', 'p1', '2026-10-15 11:00:00');
    const insert = db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('p1/t1', 'old-run', 'test', 0, 1, 10, 'old failure');
    insert.run('p1/t1', 'new-run', 'test', 1, 0, 10, 'new pass');
    expect(getCheckResults(db, 'p1/t1')).toMatchObject([{ runId: 'new-run', ok: true, outputTail: 'new pass' }]);
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run('p1/t2', 'p1', 't2', 'T2', 'review');
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old-run-2', 'p1/t2', 'agy', 'model', 'p1', '2026-10-15 10:00:00');
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('new-run-2', 'p1/t2', 'agy', 'model', 'p1', '2026-10-15 11:00:00');
    insert.run('p1/t2', 'old-run-2', 'test', 1, 0, 10, 'old pass');
    insert.run('p1/t2', 'new-run-2', 'test', 0, 1, 10, 'new failure');
    expect(getCheckResults(db, 'p1/t2')).toMatchObject([{ runId: 'new-run-2', ok: false, outputTail: 'new failure' }]);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs checks and records execution order with seq 1..3 and startedAt, getCheckResults returns in order', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-seq-test-'));
    const db = openDatabase(path.join(tmp, 'hub.db'));
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel) VALUES (?, ?, ?, ?, ?)').run('p1', 'P1', tmp, 'main', 1);
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run('p1/t1', 'p1', 't1', 'T1', 'review');
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-seq', 'p1/t1', 'agy', 'model', 'p1', '2026-10-15 12:00:00');

    const project = {
      id: 'p1',
      name: 'P1',
      path: tmp,
      defaultBranch: 'main',
      maxParallel: 1,
      checks: JSON.stringify([
        { name: 'mock-first', cmd: [process.execPath, '-e', 'process.exit(0)'] },
        { name: 'mock-second', cmd: [process.execPath, '-e', 'process.exit(0)'] },
        { name: 'mock-third', cmd: [process.execPath, '-e', 'process.exit(1)'] },
      ]),
    } as ProjectRow;

    const task = {
      id: 'p1/t1',
      projectId: 'p1',
      slug: 't1',
      title: 'T1',
      body: '',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: tmp,
      status: 'review',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '',
      updatedAt: '',
      checkFixAttempts: 0,
    } as TaskRow;

    const runner = new CheckRunner(db);
    const runResult = await runner.run(task, project, 'run-seq');

    expect(runResult.results.slice(0, 3)).toMatchObject([
      { name: 'mock-first', seq: 1, ok: true },
      { name: 'mock-second', seq: 2, ok: true },
      { name: 'mock-third', seq: 3, ok: false },
    ]);
    expect(runResult.results[0].startedAt).toBeTruthy();

    const retrieved = getCheckResults(db, 'p1/t1');
    const firstThree = retrieved.filter((r) => ['mock-first', 'mock-second', 'mock-third'].includes(r.name));
    expect(firstThree.map((r) => ({ name: r.name, seq: r.seq, ok: r.ok }))).toEqual([
      { name: 'mock-first', seq: 1, ok: true },
      { name: 'mock-second', seq: 2, ok: true },
      { name: 'mock-third', seq: 3, ok: false },
    ]);
    expect(firstThree[0].runStartedAt).toBe('2026-10-15 12:00:00');
    expect(firstThree[0].startedAt).toBeTruthy();

    // Verify fallback to rowid for legacy records without seq
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run('run-legacy', 'p1/t1', 'agy', 'model', 'p1', '2026-10-15 13:00:00');
    const legacyInsert = db.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    legacyInsert.run('p1/t1', 'run-legacy', 'check-a', 1, 0, 10, 'ok', null);
    legacyInsert.run('p1/t1', 'run-legacy', 'check-b', 1, 0, 10, 'ok', null);
    legacyInsert.run('p1/t1', 'run-legacy', 'check-c', 0, 1, 10, 'fail', null);

    const legacyResults = getCheckResults(db, 'p1/t1');
    expect(legacyResults.map((r) => r.name)).toEqual(['check-a', 'check-b', 'check-c']);
    expect(legacyResults[0].seq).toBeUndefined();

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uncommitted check ignores untracked symlinks and .agenthub files', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-test-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    // Initialize git repo
    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial content');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    // Create target dir for symlink
    const targetDir = path.join(tmp, 'target_modules');
    fs.mkdirSync(targetDir, { recursive: true });

    // Create symlink node_modules
    fs.symlinkSync(targetDir, path.join(repo, 'node_modules'));

    // Create .agenthub/DONE
    fs.mkdirSync(path.join(repo, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agenthub', 'DONE'), 'all done');

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const runner = new CheckRunner(db);

    const project: ProjectRow = {
      id: 'p1',
      name: 'P1',
      path: repo,
      defaultBranch: 'main',
      maxParallel: 1,
    };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel) VALUES (?, ?, ?, ?, ?)').run(
      project.id, project.name, project.path, project.defaultBranch, project.maxParallel,
    );

    const task: TaskRow = {
      id: 'p1/t1',
      projectId: 'p1',
      slug: 't1',
      title: 'T1',
      body: 'body',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: repo,
      status: 'running',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
      checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, body, level, baseRef, branch, worktreePath, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.projectId, task.slug, task.title, task.body, task.level, task.baseRef, task.branch, task.worktreePath, task.status,
    );

    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run(
      'run-1', task.id, 'agy', 'gemini-3.8-flash-high', 'chinh',
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run(
      'run-2', task.id, 'agy', 'gemini-3.8-flash-high', 'chinh',
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run(
      'run-3', task.id, 'agy', 'gemini-3.8-flash-high', 'chinh',
    );

    // 1. With symlink and .agenthub only -> checks should pass
    const res1 = await runner.run(task, project, 'run-1');
    const uncommitted1 = res1.results.find((r) => r.name === 'uncommitted');
    expect(uncommitted1).toBeDefined();
    expect(uncommitted1?.ok).toBe(true);

    // 2. Modify tracked file -> uncommitted should fail
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'modified content');
    const res2 = await runner.run(task, project, 'run-2');
    const uncommitted2 = res2.results.find((r) => r.name === 'uncommitted');
    expect(uncommitted2?.ok).toBe(false);

    // Revert tracked file
    execFileSync('git', ['checkout', 'tracked.txt'], { cwd: repo });

    // 3. Add an untracked regular file -> uncommitted should fail
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'untracked regular file');
    const res3 = await runner.run(task, project, 'run-3');
    const uncommitted3 = res3.results.find((r) => r.name === 'uncommitted');
    expect(uncommitted3?.ok).toBe(false);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails the agenthub-files check when a branch diff contains a committed .agenthub file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-files-check-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: repo });
    fs.mkdirSync(path.join(repo, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.agenthub', 'x'), 'must not be committed\n');
    execFileSync('git', ['add', '-f', '.agenthub/x'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'bad marker commit'], { cwd: repo });

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const project: ProjectRow = { id: 'p1', name: 'P1', path: repo, defaultBranch: 'main', maxParallel: 1 };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel) VALUES (?, ?, ?, ?, ?)').run('p1', 'P1', repo, 'main', 1);
    const task: TaskRow = {
      id: 'p1/t1', projectId: 'p1', slug: 't1', title: 'T1', body: '', level: 'easy', modelChain: null,
      baseRef: 'main', branch: 'feature', worktreePath: repo, status: 'running', dependsOn: '[]', attempt: 0,
      resume: 0, createdAt: '', updatedAt: '', checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status, baseRef, branch, worktreePath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, task.projectId, task.slug, task.title, task.status, task.baseRef, task.branch, task.worktreePath);
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run('run-1', task.id, 'agy', 'model', 'profile');

    const result = await new CheckRunner(db).run(task, project, 'run-1');
    const check = result.results.find((item) => item.name === 'agenthub-files');
    expect(check?.ok).toBe(false);
    expect(check?.outputTail).toContain('.agenthub/x');
    expect(check?.outputTail).toContain('Không được commit');
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds node_modules without slash to .git/info/exclude when creating worktree', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-exclude-test-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });

    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial content');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    const config = loadConfig(tmp);
    config.worktreesDir = path.join(tmp, 'worktrees');
    const service = new WorktreeService(config);

    const wtPath = service.create({
      projectPath: repo,
      projectId: 'p1',
      slug: 't1',
      branch: 'agenthub/t1',
      baseRef: 'main',
    });

    // Check exclude file in worktree gitdir or git-path
    const gitPath = execFileSync('git', ['-C', wtPath, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf-8',
    }).trim();
    const resolvedPath = path.isAbsolute(gitPath) ? gitPath : path.join(wtPath, gitPath);

    expect(fs.existsSync(resolvedPath)).toBe(true);
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).toContain('node_modules');
    expect(lines).toContain('.agenthub/');

    service.remove(repo, wtPath);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('conflict-markers check only reports markers at beginning of line', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-test-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });

    fs.writeFileSync(path.join(repo, 'initial.txt'), 'hello\n');
    execFileSync('git', ['add', 'initial.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const runner = new CheckRunner(db);

    const project: ProjectRow = {
      id: 'p1',
      name: 'P1',
      path: repo,
      defaultBranch: 'main',
      maxParallel: 1,
    };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel) VALUES (?, ?, ?, ?, ?)').run(
      project.id, project.name, project.path, project.defaultBranch, project.maxParallel,
    );

    const task: TaskRow = {
      id: 'p1/t1',
      projectId: 'p1',
      slug: 't1',
      title: 'T1',
      body: 'body',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: repo,
      status: 'running',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
      checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, body, level, baseRef, branch, worktreePath, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.projectId, task.slug, task.title, task.body, task.level, task.baseRef, task.branch, task.worktreePath, task.status,
    );

    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run(
      'run-1', task.id, 'agy', 'gemini-3.8-flash-high', 'chinh',
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run(
      'run-2', task.id, 'agy', 'gemini-3.8-flash-high', 'chinh',
    );

    // 1. File with '<<<<<<<' in the middle of a line -> conflict-markers should pass
    fs.writeFileSync(path.join(repo, 'mid.txt'), "const str = '<<<<<<<';\n");
    const res1 = await runner.run(task, project, 'run-1');
    const cm1 = res1.results.find((r) => r.name === 'conflict-markers');
    expect(cm1).toBeDefined();
    expect(cm1?.ok).toBe(true);

    // 2. File with '<<<<<<< HEAD' at the beginning of a line -> conflict-markers should fail
    fs.writeFileSync(path.join(repo, 'conflict.txt'), '<<<<<<< HEAD\nsome conflict\n=======\nother\n>>>>>>> branch\n');
    const res2 = await runner.run(task, project, 'run-2');
    const cm2 = res2.results.find((r) => r.name === 'conflict-markers');
    expect(cm2).toBeDefined();
    expect(cm2?.ok).toBe(false);
    expect(cm2?.outputTail).toContain('conflict.txt');
    expect(cm2?.outputTail).not.toContain('mid.txt');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uncommitted check ignores real node_modules directories, subproject node_modules, and git-ignored paths', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uncommitted-test-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });

    fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'web', 'package.json'), '{}');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'sub', 'package.json'), '{}');
    execFileSync('git', ['add', '.gitignore', 'tracked.txt', 'web/package.json', 'sub/package.json'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo });

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const runner = new CheckRunner(db);

    const project: ProjectRow = {
      id: 'p1',
      name: 'P1',
      path: repo,
      defaultBranch: 'main',
      maxParallel: 1,
    };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel) VALUES (?, ?, ?, ?, ?)').run(
      project.id, project.name, project.path, project.defaultBranch, project.maxParallel,
    );

    const task: TaskRow = {
      id: 'p1/t1',
      projectId: 'p1',
      slug: 't1',
      title: 'T1',
      body: 'body',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: repo,
      status: 'running',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15',
      updatedAt: '2026-10-15',
      checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, body, level, baseRef, branch, worktreePath, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      task.id, task.projectId, task.slug, task.title, task.body, task.level, task.baseRef, task.branch, task.worktreePath, task.status,
    );

    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run(
      'run-1', task.id, 'agy', 'gemini-3.8-flash-high', 'chinh',
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run(
      'run-2', task.id, 'agy', 'gemini-3.8-flash-high', 'chinh',
    );

    // 1. Real directories for node_modules and web/node_modules
    fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = {};');
    fs.mkdirSync(path.join(repo, 'web', 'node_modules', 'webdep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'web', 'node_modules', 'webdep', 'index.js'), 'module.exports = {};');

    // Symlink node_modules in a subfolder
    const targetDir = path.join(tmp, 'target_modules');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.symlinkSync(targetDir, path.join(repo, 'sub', 'node_modules'));

    // Git-ignored paths
    fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'console.log();');
    fs.writeFileSync(path.join(repo, 'debug.log'), 'debug info');

    // Uncommitted check should pass
    const res1 = await runner.run(task, project, 'run-1');
    const uncommitted1 = res1.results.find((r) => r.name === 'uncommitted');
    expect(uncommitted1).toBeDefined();
    expect(uncommitted1?.ok).toBe(true);

    // 2. Untracked, non-ignored regular file -> uncommitted should fail
    fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'needs commit');
    const res2 = await runner.run(task, project, 'run-2');
    const uncommitted2 = res2.results.find((r) => r.name === 'uncommitted');
    expect(uncommitted2).toBeDefined();
    expect(uncommitted2?.ok).toBe(false);
    expect(uncommitted2?.outputTail).toContain('uncommitted.txt');

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
