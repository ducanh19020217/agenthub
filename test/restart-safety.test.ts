import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext, startDaemon } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { Scheduler } from '../src/scheduler/index.js';
import { openDatabase, ProjectRepo, ProfileRepo, QuotaMarkRepo, TaskRepo, RunRepo, EventRepo } from '../src/db/index.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { linuxPlatform } from '../src/platform/linux.js';
import { darwinPlatform } from '../src/platform/darwin.js';

import { execFileSync as runFile } from 'node:child_process';

function initRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--template='], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], {
    cwd: repoPath,
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  });
}

describe('safe restart API', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;
  let server: Awaited<ReturnType<typeof createServer>>;
  let token: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-restart-api-'));
    const homes = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(homes, { recursive: true });
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = homes;
    const config = loadConfig(tmpDir);
    config.port = 7798;
    token = getOrCreateToken(config.tokenPath);
    const fake = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    ctx = createContext(config, new Map<string, Engine>([['agy', fake]]));
    ctx.scheduler.stop();
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  const headers = () => ({ host: '127.0.0.1:7798', authorization: `Bearer ${token}` });

  it('starts a when-idle drain, exposes it, and DELETE resumes dispatch', async () => {
    const requested = await server.inject({
      method: 'POST', url: '/api/system/restart', headers: headers(), payload: { mode: 'when-idle', timeoutMinutes: 5, reason: 'test' },
    });
    expect(requested.statusCode).toBe(200);
    expect(JSON.parse(requested.body)).toMatchObject({ draining: true, reason: 'test' });

    const current = await server.inject({ method: 'GET', url: '/api/system/restart', headers: headers() });
    expect(JSON.parse(current.body).draining).toBe(true);

    const cancelled = await server.inject({ method: 'DELETE', url: '/api/system/restart', headers: headers() });
    expect(JSON.parse(cancelled.body)).toMatchObject({ draining: false, waitingFor: [] });
    expect(ctx.eventRepo.getRecent(20).some((event) => event.type === 'hub.restart_cancelled')).toBe(true);
  });

  it('rejects invalid mode and accepts explicit now without a real service restart', async () => {
    const bad = await server.inject({ method: 'POST', url: '/api/system/restart', headers: headers(), payload: { mode: 'later' } });
    expect(bad.statusCode).toBe(400);
    const now = await server.inject({ method: 'POST', url: '/api/system/restart', headers: headers(), payload: { mode: 'now' } });
    expect(now.statusCode).toBe(200);
    expect(JSON.parse(now.body).mode).toBe('now');
  });
});

describe('safe restart scheduler termination', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let db: ReturnType<typeof openDatabase>;
  let scheduler: Scheduler;
  let taskRepo: TaskRepo;
  let runRepo: RunRepo;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-restart-scheduler-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    config = loadConfig(tmpDir);
    db = openDatabase(config.dbPath);
    const projects = new ProjectRepo(db);
    taskRepo = new TaskRepo(db);
    runRepo = new RunRepo(db);
    const profiles = new ProfileRepo(db);
    const quotas = new QuotaMarkRepo(db);
    const events = new EventRepo(db);
    const repo = path.join(tmpDir, 'repo');
    initRepo(repo);
    projects.insert({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', maxParallel: 1 });
    profiles.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: path.join(tmpDir, 'agy-homes', 'p1'), email: 'p1@example.com', enabled: 1 });
    scheduler = new Scheduler(config, taskRepo, runRepo, events, projects, profiles, quotas, new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]), undefined, undefined, undefined, db);
    scheduler.stop();
    process.env.FAKE_MODE = 'sleep-loop';
  });

  afterEach(() => {
    process.env.STOP_SLEEP = '1';
    scheduler.shutdownForUser('hub_restart');
    scheduler.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.FAKE_MODE;
    delete process.env.STOP_SLEEP;
  });

  it('does not dispatch queued work while an active run drains, then calls restart once', async () => {
    taskRepo.insert({ id: 'p/active', projectId: 'p', slug: 'active', title: 'active', status: 'queued', level: 'easy' });
    taskRepo.insert({ id: 'p/waiting', projectId: 'p', slug: 'waiting', title: 'waiting', status: 'queued', level: 'easy' });
    scheduler.tick();
    for (let i = 0; i < 30 && scheduler.getRunning().size === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.getRunning().size).toBe(1);
    const onReady = vi.fn();
    scheduler.beginRestartDrain(5, 'test', onReady);
    scheduler.tick();
    expect(scheduler.getRunning().size).toBe(1);
    expect(taskRepo.get('p/waiting')?.waitReason).toBe('restart');
    expect(onReady).not.toHaveBeenCalled();
    // Model the worker's normal exit after the drain has kept it alive. The
    // process was never killed by the drain itself.
    (scheduler as unknown as { running: Map<string, unknown> }).running.clear();
    scheduler.tick();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('records hub_restart and appends an explanation when now kills a worker', async () => {
    taskRepo.insert({ id: 'p/active', projectId: 'p', slug: 'active', title: 'active', status: 'queued', level: 'easy' });
    scheduler.tick();
    for (let i = 0; i < 30 && scheduler.getRunning().size === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const run = runRepo.getByTask('p/active')[0];
    expect(run?.logPath).toBeTruthy();
    fs.writeFileSync(run!.logPath!, 'worker output\n');
    scheduler.shutdownForUser('hub_restart');
    const finished = runRepo.get(run!.id);
    expect(finished?.outcome).toBe('crashed');
    expect(finished?.reason).toBe('hub_restart');
    expect(fs.readFileSync(run!.logPath!, 'utf8')).toContain('[agenthub] Run bị dừng vì hub khởi động lại lúc');
  });
});

describe('production restart scripts', () => {
  it('requests when-idle by default and now only with --force', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-restart-script-'));
    const bin = path.join(tmpDir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const calls = path.join(tmpDir, 'calls');
    const curl = path.join(bin, 'curl');
    fs.writeFileSync(curl, `#!/bin/sh
echo "$*" >> "$RESTART_CALLS"
case "$*" in
  *"-X POST"*) printf '{"draining":true,"waitingFor":[{"taskId":"p/t","kind":"run","startedAt":0}]}' ;;
  *) printf '{"ok":true}' ;;
esac
`);
    fs.chmodSync(curl, 0o755);
    const tokenHome = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(tokenHome, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(tokenHome, '.agenthub', 'token'), 'test-token');
    const env = { ...process.env, HOME: tokenHome, PATH: `${bin}:${process.env.PATH}`, RESTART_CALLS: calls };
    const script = path.join(process.cwd(), 'scripts', 'run-prod.sh');
    const idle = runFile('bash', [script, '--restart'], { cwd: process.cwd(), env, encoding: 'utf8' });
    const force = runFile('bash', [script, '--restart', '--force'], { cwd: process.cwd(), env, encoding: 'utf8' });
    const stop = runFile('bash', [path.join(process.cwd(), 'scripts', 'stop-prod.sh')], { cwd: process.cwd(), env, encoding: 'utf8' });
    const output = fs.readFileSync(calls, 'utf8');
    expect(output).toContain('"mode":"when-idle"');
    expect(output).toContain('"mode":"now"');
    expect(idle).toContain('Sẽ khởi động lại khi 1 task chạy xong');
    expect(force).toContain('worker đang chạy sẽ bị dừng');
    expect(stop).toContain('Sẽ dừng an toàn sau khi 1 task chạy xong');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('worker survival across daemon restart (handoff & adoption)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let db: ReturnType<typeof openDatabase>;
  let projectRepo: ProjectRepo;
  let taskRepo: TaskRepo;
  let runRepo: RunRepo;
  let profileRepo: ProfileRepo;
  let quotaMarkRepo: QuotaMarkRepo;
  let eventRepo: EventRepo;
  let fakeEngine: FakeEngine;
  let activeSchedulers: Scheduler[];
  let activeDaemons: Array<{ shutdown: (preserve?: boolean) => Promise<void> }>;

  beforeEach(() => {
    activeSchedulers = [];
    activeDaemons = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-restart-survive-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    config = loadConfig(tmpDir);
    config.port = 0;
    db = openDatabase(config.dbPath);
    projectRepo = new ProjectRepo(db);
    taskRepo = new TaskRepo(db);
    runRepo = new RunRepo(db);
    profileRepo = new ProfileRepo(db);
    quotaMarkRepo = new QuotaMarkRepo(db);
    eventRepo = new EventRepo(db);
    const repo = path.join(tmpDir, 'repo');
    initRepo(repo);
    projectRepo.insert({ id: 'p', name: 'P', path: repo, defaultBranch: 'main', maxParallel: 1 });
    profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: path.join(tmpDir, 'agy-homes', 'p1'), email: 'p1@example.com', enabled: 1 });
    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
  });

  afterEach(async () => {
    process.env.STOP_SLEEP = '1';
    for (const s of activeSchedulers) s.stop();
    activeSchedulers = [];
    for (const d of activeDaemons) {
      try { await d.shutdown(true); } catch { /* ignore */ }
    }
    activeDaemons = [];
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.FAKE_MODE;
    delete process.env.STOP_SLEEP;
  });

  it('generates systemd unit with KillMode=process and TimeoutStopSec=20, and launchd plist with AbandonProcessGroup', () => {
    const linuxUnit = linuxPlatform.installService({
      nodePath: '/usr/local/bin/node',
      cliPath: '/usr/local/bin/agenthub',
      currentPath: '/usr/local/bin',
      homeDir: '/home/test',
      print: true,
    });
    expect(linuxUnit.content).toContain('KillMode=process');
    expect(linuxUnit.content).toContain('TimeoutStopSec=20');

    const darwinPlist = darwinPlatform.installService({
      nodePath: '/usr/local/bin/node',
      cliPath: '/usr/local/bin/agenthub',
      currentPath: '/usr/local/bin',
      homeDir: '/Users/test',
      print: true,
    });
    expect(darwinPlist.content).toContain('<key>AbandonProcessGroup</key><true/>');
  });

  it('daemon A spawns fake worker, SIGTERM hands off without killing it, daemon B adopts it and advances upon DONE', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    process.env.FAKE_MODE = 'sleep-done';
    delete process.env.STOP_SLEEP;

    taskRepo.insert({ id: 'p/t1', projectId: 'p', slug: 't1', title: 'T1', status: 'queued', level: 'easy' });

    // Start daemon A
    const daemonA = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemonA);
    await vi.waitFor(() => {
      expect(daemonA.ctx.scheduler.getRunning().has('p/t1')).toBe(true);
    }, { timeout: 10_000 });

    const runningTask = daemonA.ctx.scheduler.getRunning().get('p/t1')!;
    const workerPid = runningTask.pid;
    expect(workerPid).toBeGreaterThan(0);
    expect(process.kill(workerPid, 0)).toBe(true);

    // Trigger SIGTERM handoff on daemon A: simulates systemd stopping daemon
    daemonA.ctx.scheduler.shutdownForUser('hub_handoff');
    await daemonA.shutdown(true);
    activeDaemons = activeDaemons.filter((d) => d !== daemonA);

    // Worker process MUST still be alive!
    expect(process.kill(workerPid, 0)).toBe(true);
    const runInDb = runRepo.getByTask('p/t1')[0];
    expect(runInDb.handoff).toBe(1);
    expect(runInDb.outcome).toBeNull();

    // Start daemon B with the same db and config
    const daemonB = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemonB);
    expect(daemonB.ctx.scheduler.getRunning().has('p/t1')).toBe(true);
    const adoptedRun = daemonB.ctx.scheduler.getRunning().get('p/t1')!;
    expect(adoptedRun.adopted).toBe(true);
    expect(daemonB.ctx.eventRepo.getRecent(10).some((e) => e.type === 'run.adopted' && e.taskId === 'p/t1')).toBe(true);

    // Trigger worker completion: write TRIGGER_DONE to worktree
    const task = taskRepo.get('p/t1')!;
    fs.writeFileSync(path.join(task.worktreePath!, '.agenthub', 'TRIGGER_DONE'), 'go');

    // Wait for worker process to end and daemon B to advance task to checking or review
    await vi.waitFor(() => {
      const currentTask = taskRepo.get('p/t1')!;
      expect(['checking', 'review', 'done']).toContain(currentTask.status);
    }, { timeout: 15_000 });

    const finishedRun = runRepo.get(runInDb.id)!;
    expect(finishedRun.outcome).toBe('done');

    await daemonB.shutdown(true);
    activeDaemons = activeDaemons.filter((d) => d !== daemonB);
    exitSpy.mockRestore();
  });

  it('does not adopt a reused PID from an unrelated process and returns task to queue', async () => {
    taskRepo.insert({ id: 'p/t2', projectId: 'p', slug: 't2', title: 'T2', status: 'running', worktreePath: path.join(tmpDir, 'repo') });
    runRepo.insert({
      id: 'run-reused',
      taskId: 'p/t2',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      pid: process.pid,
      pidStart: null,
    });
    db.prepare("UPDATE runs SET handoff = 1 WHERE id = 'run-reused'").run();

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, undefined, db,
    );
    activeSchedulers.push(scheduler);
    scheduler.start();

    // The unrelated PID must NOT be adopted
    expect(scheduler.getRunning().has('p/t2')).toBe(false);
    const run = runRepo.get('run-reused')!;
    expect(run.outcome).toBe('crashed');
    expect(run.reason).toBe('pid_reused_during_handoff');

    const task = taskRepo.get('p/t2')!;
    expect(task.status).toBe('queued');
    expect(task.resume).toBe(1);

    scheduler.stop();
  });

  it('worker died during transfer with DONE marker in worktree advances straight to checking', async () => {
    const worktreePath = path.join(tmpDir, 'worktree-c');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'All done during handoff');

    taskRepo.insert({ id: 'p/t3', projectId: 'p', slug: 't3', title: 'T3', status: 'running', worktreePath });
    runRepo.insert({
      id: 'run-dead-done',
      taskId: 'p/t3',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      pid: 9999999, // dead PID
      startedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    db.prepare("UPDATE runs SET handoff = 1 WHERE id = 'run-dead-done'").run();

    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, undefined, db,
    );
    activeSchedulers.push(scheduler);
    scheduler.start();

    // Run outcome is marked done and task goes directly to checking
    expect(scheduler.getRunning().has('p/t3')).toBe(false);
    const run = runRepo.get('run-dead-done')!;
    expect(run.outcome).toBe('done');

    const task = taskRepo.get('p/t3')!;
    expect(task.status).toBe('checking');

    scheduler.stop();
  });

  it('holds profile lock for adopted run and avoids duplicate dispatch', async () => {
    taskRepo.insert({ id: 'p/t4', projectId: 'p', slug: 't4', title: 'T4', status: 'running', worktreePath: path.join(tmpDir, 'repo') });
    runRepo.insert({
      id: 'run-lock',
      taskId: 'p/t4',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      pid: process.pid,
      pidStart: null,
    });
    db.prepare("UPDATE runs SET lockFile = 'p1.lock' WHERE id = 'run-lock'").run();

    // Use legacyRun exception (run.handoff = 0 and pidStart = null) so adoption accepts process.pid
    const scheduler = new Scheduler(
      config, taskRepo, runRepo, eventRepo, projectRepo, profileRepo, quotaMarkRepo,
      new Map<string, Engine>([['agy', fakeEngine]]), undefined, undefined, undefined, db,
    );
    activeSchedulers.push(scheduler);
    scheduler.start();

    expect(scheduler.getRunning().has('p/t4')).toBe(true);

    // Queue another task on profile p1
    taskRepo.insert({ id: 'p/t5', projectId: 'p', slug: 't5', title: 'T5', status: 'queued', level: 'easy' });
    scheduler.tick();

    // p/t5 should not run because p1 lock slot is held by adopted run
    expect(scheduler.getRunning().has('p/t5')).toBe(false);

    // p/t4 should not have duplicate runs
    const runsForT4 = runRepo.getByTask('p/t4').filter((r) => r.outcome === null);
    expect(runsForT4).toHaveLength(1);

    scheduler.stop();
  });

  it('user shutdown kills worker processes', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    process.env.FAKE_MODE = 'sleep-loop';
    delete process.env.STOP_SLEEP;

    taskRepo.insert({ id: 'p/tkill', projectId: 'p', slug: 'tkill', title: 'TKill', status: 'queued', level: 'easy' });

    const daemon = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemon);
    await vi.waitFor(() => {
      expect(daemon.ctx.scheduler.getRunning().has('p/tkill')).toBe(true);
    }, { timeout: 10_000 });

    const rt = daemon.ctx.scheduler.getRunning().get('p/tkill')!;
    const workerPid = rt.pid;
    expect(workerPid).toBeGreaterThan(0);
    expect(process.kill(workerPid, 0)).toBe(true);

    // User shutdown: shutdownForUser default reason is user_stop, followed by shutdown(false)
    daemon.ctx.service.shutdownForUser();
    await daemon.shutdown(false);
    activeDaemons = activeDaemons.filter((d) => d !== daemon);

    // Worker must be killed!
    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(workerPid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5000 });

    const run = runRepo.getByTask('p/tkill')[0];
    expect(run.outcome).toBe('crashed');
    expect(run.reason).toBe('user_stop');

    exitSpy.mockRestore();
  });
});
