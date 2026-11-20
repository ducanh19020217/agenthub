import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openDatabase, ProjectRow, TaskRow } from '../src/db/index.js';
import { CheckRunner, getCheckResults } from '../src/checks.js';
import {
  cleanPostDoneEnv,
  listPostDoneArtifacts,
  getPostDoneArtifacts,
  ProjectPostDoneQueue,
} from '../src/post-done.js';

describe('postDone hook and checks integration', () => {
  it('cleans environment and removes worker shims and hub secrets', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'post-done-env-test-'));
    const hubHome = path.join(tmp, '.agenthub');
    const workerShimDir = path.join(hubHome, 'shims', 'worker');
    const serviceShimDir = path.join(hubHome, 'shims', 'service');
    const systemBin = '/usr/bin';
    fs.mkdirSync(workerShimDir, { recursive: true });
    fs.mkdirSync(serviceShimDir, { recursive: true });

    const daemonEnv: NodeJS.ProcessEnv = {
      PATH: [workerShimDir, serviceShimDir, systemBin].join(path.delimiter),
      HOME: '/home/user',
      USER: 'testuser',
      AGENTHUB_HOME: hubHome,
      AGENTHUB_PORT: '7700',
      AGENTHUB_AGY_CLIENT_SECRET: 'secret-val',
      OPENPROJECT_API_KEY: 'secret-op-key',
      GITEA_TOKEN: 'secret-token',
      SECRET_PASSWORD: 'password123',
    };

    const extra = {
      AGENTHUB_TASK_ID: 'proj/t1',
      AGENTHUB_PROJECT: 'proj',
      AGENTHUB_BASE_REF: 'main',
      AGENTHUB_BRANCH: 'agenthub/t1',
      AGENTHUB_ARTIFACTS_DIR: '/tmp/artifacts',
    };

    const clean = cleanPostDoneEnv(daemonEnv, hubHome, extra);

    // Shims removed
    expect(clean.PATH).not.toContain(workerShimDir);
    expect(clean.PATH).not.toContain(serviceShimDir);
    expect(clean.PATH).toContain(systemBin);

    // Required AGENTHUB_* vars set
    expect(clean.AGENTHUB_TASK_ID).toBe('proj/t1');
    expect(clean.AGENTHUB_PROJECT).toBe('proj');
    expect(clean.AGENTHUB_BASE_REF).toBe('main');
    expect(clean.AGENTHUB_BRANCH).toBe('agenthub/t1');
    expect(clean.AGENTHUB_ARTIFACTS_DIR).toBe('/tmp/artifacts');

    // Secrets stripped
    expect(clean.AGENTHUB_AGY_CLIENT_SECRET).toBeUndefined();
    expect(clean.AGENTHUB_PORT).toBeUndefined();
    expect(clean.OPENPROJECT_API_KEY).toBeUndefined();
    expect(clean.GITEA_TOKEN).toBeUndefined();
    expect(clean.SECRET_PASSWORD).toBeUndefined();

    // Safe daemon vars preserved
    expect(clean.HOME).toBe('/home/user');
    expect(clean.USER).toBe('testuser');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('scans artifacts with supported extensions recursively', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'post-done-art-test-'));
    const artDir = path.join(tmp, 'artifacts');
    const subDir = path.join(artDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });

    fs.writeFileSync(path.join(artDir, 'frame1.PNG'), 'png');
    fs.writeFileSync(path.join(artDir, 'image.jpg'), 'jpg');
    fs.writeFileSync(path.join(subDir, 'video.mp4'), 'mp4');
    fs.writeFileSync(path.join(subDir, 'meta.json'), '{}');
    fs.writeFileSync(path.join(artDir, 'notes.txt'), 'text');
    fs.writeFileSync(path.join(artDir, 'ignored.bin'), 'bin');
    fs.writeFileSync(path.join(artDir, 'ignored.js'), 'code');

    const list = listPostDoneArtifacts(tmp, 'artifacts');
    expect(list).toEqual([
      path.join(artDir, 'frame1.PNG'),
      path.join(artDir, 'image.jpg'),
      path.join(artDir, 'notes.txt'),
      path.join(subDir, 'meta.json'),
      path.join(subDir, 'video.mp4'),
    ]);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serializes executions for the same project in a queue', async () => {
    const queue = new ProjectPostDoneQueue();
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const runTask = (proj: string, id: string, delayMs: number) =>
      queue.run(proj, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(`start-${id}`);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(`end-${id}`);
        concurrent--;
        return id;
      });

    await Promise.all([
      runTask('proj1', 't1', 50),
      runTask('proj1', 't2', 20),
      runTask('proj2', 't3', 10),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2); // proj1 and proj2 can run concurrently
    // For proj1, t1 must finish before t2 starts
    const t1EndIndex = order.indexOf('end-t1');
    const t2StartIndex = order.indexOf('start-t2');
    expect(t1EndIndex).toBeLessThan(t2StartIndex);
  });

  it('executes postDone check, writes logs, records artifacts and results in CheckRunner', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'post-done-check-test-'));
    const repo = path.join(tmp, 'repo');
    const hubHome = path.join(tmp, '.agenthub');
    process.env.AGENTHUB_HOME = hubHome;
    fs.mkdirSync(repo, { recursive: true });

    // Initialize git repo
    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: init'], { cwd: repo });

    // Create a dummy post-done script
    const scriptPath = path.join(repo, 'render.js');
    fs.writeFileSync(
      scriptPath,
      `
const fs = require('fs');
const path = require('path');
const artDir = process.env.AGENTHUB_ARTIFACTS_DIR;
fs.mkdirSync(artDir, { recursive: true });
fs.writeFileSync(path.join(artDir, 'frame_001.png'), 'fake-png');
fs.writeFileSync(path.join(artDir, 'summary.json'), JSON.stringify({ rendered: true }));
console.log('Rendering video frame 1... DONE');
console.log('AGENTHUB_TASK_ID=' + process.env.AGENTHUB_TASK_ID);
console.log('AGENTHUB_PROJECT=' + process.env.AGENTHUB_PROJECT);
`,
    );
    execFileSync('git', ['add', 'render.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: render script'], { cwd: repo });

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const project: ProjectRow = {
      id: 'p1',
      name: 'P1',
      path: repo,
      defaultBranch: 'main',
      maxParallel: 1,
      settings: JSON.stringify({
        postDone: {
          enabled: true,
          cmd: ['node', 'render.js'],
          timeoutSec: 30,
          artifactsDir: '.agenthub/post-done',
        },
      }),
    };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel, settings) VALUES (?, ?, ?, ?, ?, ?)').run(
      project.id, project.name, project.path, project.defaultBranch, project.maxParallel, project.settings,
    );

    const task: TaskRow = {
      id: 'p1/t1',
      projectId: 'p1',
      slug: 't1',
      title: 'T1',
      body: '',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: repo,
      status: 'checking',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '',
      updatedAt: '',
      checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run(
      task.id, task.projectId, task.slug, task.title, task.status,
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      'run-1', task.id, 'agy', 'model', 'p1', new Date().toISOString(),
    );

    const runner = new CheckRunner(db);
    const result = await runner.run(task, project, 'run-1');

    expect(result.passed).toBe(true);
    const postDoneCheck = result.results.find((c) => c.name === 'post-done');
    expect(postDoneCheck).toBeDefined();
    expect(postDoneCheck?.ok).toBe(true);
    expect(postDoneCheck?.exitCode).toBe(0);
    expect(postDoneCheck?.outputTail).toContain('Rendering video frame 1... DONE');
    expect(postDoneCheck?.outputTail).toContain('AGENTHUB_TASK_ID=p1/t1');

    // Artifacts check
    const artifacts = getPostDoneArtifacts(task, project);
    expect(artifacts).toEqual([
      path.join(repo, '.agenthub', 'post-done', 'frame_001.png'),
      path.join(repo, '.agenthub', 'post-done', 'summary.json'),
    ]);

    // Log check
    const logFile = path.join(hubHome, 'logs', 'p1_t1', 'post-done.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, 'utf8');
    expect(logContent).toContain('Rendering video frame 1... DONE');

    // Database check_results check
    const savedChecks = getCheckResults(db, task.id);
    expect(savedChecks.some((c) => c.name === 'post-done' && c.ok)).toBe(true);

    db.close();
    delete process.env.AGENTHUB_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails postDone check when script exits with error or times out', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'post-done-fail-test-'));
    const repo = path.join(tmp, 'repo');
    const hubHome = path.join(tmp, '.agenthub');
    process.env.AGENTHUB_HOME = hubHome;
    fs.mkdirSync(repo, { recursive: true });

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: init'], { cwd: repo });

    const failScript = path.join(repo, 'fail.js');
    fs.writeFileSync(failScript, `console.error("Docker render crashed"); process.exit(42);`);
    execFileSync('git', ['add', 'fail.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: fail script'], { cwd: repo });

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const project: ProjectRow = {
      id: 'p1',
      name: 'P1',
      path: repo,
      defaultBranch: 'main',
      maxParallel: 1,
      settings: JSON.stringify({
        postDone: {
          enabled: true,
          cmd: ['node', 'fail.js'],
          timeoutSec: 30,
        },
      }),
    };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel, settings) VALUES (?, ?, ?, ?, ?, ?)').run(
      project.id, project.name, project.path, project.defaultBranch, project.maxParallel, project.settings,
    );

    const task: TaskRow = {
      id: 'p1/t2',
      projectId: 'p1',
      slug: 't2',
      title: 'T2',
      body: '',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: repo,
      status: 'checking',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '',
      updatedAt: '',
      checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run(
      task.id, task.projectId, task.slug, task.title, task.status,
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      'run-2', task.id, 'agy', 'model', 'p1', new Date().toISOString(),
    );

    const runner = new CheckRunner(db);
    const result = await runner.run(task, project, 'run-2');

    expect(result.passed).toBe(false);
    expect(result.failed).toContain('post-done');
    const postDoneCheck = result.results.find((c) => c.name === 'post-done');
    expect(postDoneCheck?.ok).toBe(false);
    expect(postDoneCheck?.exitCode).toBe(42);
    expect(postDoneCheck?.outputTail).toContain('Docker render crashed');

    db.close();
    delete process.env.AGENTHUB_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('kills process group on timeout', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'post-done-timeout-test-'));
    const repo = path.join(tmp, 'repo');
    const hubHome = path.join(tmp, '.agenthub');
    process.env.AGENTHUB_HOME = hubHome;
    fs.mkdirSync(repo, { recursive: true });

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: init'], { cwd: repo });

    const timeoutScript = path.join(repo, 'timeout.js');
    fs.writeFileSync(timeoutScript, `
console.log('Sleeping...');
setTimeout(() => {
  console.log('Should not finish');
}, 60000);
`);
    execFileSync('git', ['add', 'timeout.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: timeout script'], { cwd: repo });

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const project: ProjectRow = {
      id: 'p1',
      name: 'P1',
      path: repo,
      defaultBranch: 'main',
      maxParallel: 1,
      settings: JSON.stringify({
        postDone: {
          enabled: true,
          cmd: ['node', 'timeout.js'],
          timeoutSec: 1,
        },
      }),
    };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel, settings) VALUES (?, ?, ?, ?, ?, ?)').run(
      project.id, project.name, project.path, project.defaultBranch, project.maxParallel, project.settings,
    );

    const task: TaskRow = {
      id: 'p1/t3',
      projectId: 'p1',
      slug: 't3',
      title: 'T3',
      body: '',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: repo,
      status: 'checking',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '',
      updatedAt: '',
      checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run(
      task.id, task.projectId, task.slug, task.title, task.status,
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      'run-3', task.id, 'agy', 'model', 'p1', new Date().toISOString(),
    );

    const runner = new CheckRunner(db);
    const result = await runner.run(task, project, 'run-3');

    expect(result.passed).toBe(false);
    expect(result.failed).toContain('post-done');
    const postDoneCheck = result.results.find((c) => c.name === 'post-done');
    expect(postDoneCheck?.ok).toBe(false);
    expect(postDoneCheck?.outputTail).toContain('Timeout sau 1s');

    db.close();
    delete process.env.AGENTHUB_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ensures artifacts in artifactsDir do not trigger uncommitted check', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'post-done-uncommitted-test-'));
    const repo = path.join(tmp, 'repo');
    const hubHome = path.join(tmp, '.agenthub');
    process.env.AGENTHUB_HOME = hubHome;
    fs.mkdirSync(repo, { recursive: true });

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');
    execFileSync('git', ['add', 'file.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: init'], { cwd: repo });

    // Custom artifacts dir outside .agenthub/
    const customArtifacts = path.join(repo, 'custom-artifacts');
    fs.mkdirSync(customArtifacts, { recursive: true });
    fs.writeFileSync(path.join(customArtifacts, 'frame.png'), 'png-bytes');
    fs.writeFileSync(path.join(customArtifacts, 'test.mp4'), 'mp4-bytes');

    const scriptPath = path.join(repo, 'dummy.js');
    fs.writeFileSync(scriptPath, `console.log('done');`);
    execFileSync('git', ['add', 'dummy.js'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feat: dummy script'], { cwd: repo });

    const db = openDatabase(path.join(tmp, 'hub.db'));
    const project: ProjectRow = {
      id: 'p1',
      name: 'P1',
      path: repo,
      defaultBranch: 'main',
      maxParallel: 1,
      settings: JSON.stringify({
        postDone: {
          enabled: true,
          cmd: ['node', 'dummy.js'],
          timeoutSec: 30,
          artifactsDir: 'custom-artifacts',
        },
      }),
    };
    db.prepare('INSERT INTO projects (id, name, path, defaultBranch, maxParallel, settings) VALUES (?, ?, ?, ?, ?, ?)').run(
      project.id, project.name, project.path, project.defaultBranch, project.maxParallel, project.settings,
    );

    const task: TaskRow = {
      id: 'p1/t4',
      projectId: 'p1',
      slug: 't4',
      title: 'T4',
      body: '',
      level: 'easy',
      modelChain: null,
      baseRef: 'main',
      branch: 'main',
      worktreePath: repo,
      status: 'checking',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '',
      updatedAt: '',
      checkFixAttempts: 0,
    };
    db.prepare('INSERT INTO tasks (id, projectId, slug, title, status) VALUES (?, ?, ?, ?, ?)').run(
      task.id, task.projectId, task.slug, task.title, task.status,
    );
    db.prepare('INSERT INTO runs (id, taskId, engine, model, profileName, startedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      'run-4', task.id, 'agy', 'model', 'p1', new Date().toISOString(),
    );

    const runner = new CheckRunner(db);
    const result = await runner.run(task, project, 'run-4');

    expect(result.passed).toBe(true);
    expect(result.failed).toEqual([]);
    const uncommittedCheck = result.results.find((c) => c.name === 'uncommitted');
    expect(uncommittedCheck?.ok).toBe(true);

    db.close();
    delete process.env.AGENTHUB_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
