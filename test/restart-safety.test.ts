import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
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
    expect(JSON.parse(now.body).killWorkers).toBe(false);

    const nowKill = await server.inject({ method: 'POST', url: '/api/system/restart', headers: headers(), payload: { mode: 'now', killWorkers: true } });
    expect(nowKill.statusCode).toBe(200);
    expect(JSON.parse(nowKill.body).mode).toBe('now');
    expect(JSON.parse(nowKill.body).killWorkers).toBe(true);
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
    const forceKill = runFile('bash', [script, '--restart', '--force', '--kill-workers'], { cwd: process.cwd(), env, encoding: 'utf8' });
    const stop = runFile('bash', [path.join(process.cwd(), 'scripts', 'stop-prod.sh')], { cwd: process.cwd(), env, encoding: 'utf8' });
    const output = fs.readFileSync(calls, 'utf8');
    expect(output).toContain('"mode":"when-idle"');
    expect(output).toContain('"mode":"now","killWorkers":false');
    expect(output).toContain('"mode":"now","killWorkers":true');
    expect(idle).toContain('Sẽ khởi động lại khi 1 task chạy xong');
    expect(force).toContain('handoff: worker tiếp tục chạy');
    expect(forceKill).toContain('worker đang chạy sẽ bị dừng');
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

  it('does not adopt a reused PID from an unrelated process and marks task blocked', async () => {
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
    expect(task.status).toBe('blocked');
    expect(task.blockedReport).toContain('không khớp danh tính');

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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    process.env.FAKE_MODE = 'sleep-loop';
    delete process.env.STOP_SLEEP;

    taskRepo.insert({ id: 'p/t4', projectId: 'p', slug: 't4', title: 'T4', status: 'queued', level: 'easy' });

    // Start daemon A to spawn real worker with real profile lock
    const daemonA = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemonA);
    await vi.waitFor(() => {
      expect(daemonA.ctx.scheduler.getRunning().has('p/t4')).toBe(true);
    }, { timeout: 10_000 });

    const rt = daemonA.ctx.scheduler.getRunning().get('p/t4')!;
    const workerPid = rt.pid;
    expect(workerPid).toBeGreaterThan(0);
    expect(process.kill(workerPid, 0)).toBe(true);

    // Hand off worker on daemon A (handoff = 1, real pidStart, real worktree)
    daemonA.ctx.scheduler.shutdownForUser('hub_handoff');
    await daemonA.shutdown(true);
    activeDaemons = activeDaemons.filter((d) => d !== daemonA);

    // Verify worker is alive and has real handoff record in DB
    expect(process.kill(workerPid, 0)).toBe(true);
    const runInDb = runRepo.getByTask('p/t4')[0];
    expect(runInDb.handoff).toBe(1);
    expect(runInDb.pidStart).toBeTruthy();
    expect(runInDb.lockFile).toBeTruthy();

    // Start daemon B - adopts real handoff worker without legacy exception
    const daemonB = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemonB);

    expect(daemonB.ctx.scheduler.getRunning().has('p/t4')).toBe(true);
    expect(daemonB.ctx.scheduler.getRunning().get('p/t4')!.adopted).toBe(true);

    // Queue another task on profile p1
    taskRepo.insert({ id: 'p/t5', projectId: 'p', slug: 't5', title: 'T5', status: 'queued', level: 'easy' });
    daemonB.ctx.scheduler.tick();

    // p/t5 should not run because p1 lock slot is held by adopted run
    expect(daemonB.ctx.scheduler.getRunning().has('p/t5')).toBe(false);

    // p/t4 should not have duplicate runs
    const runsForT4 = runRepo.getByTask('p/t4').filter((r) => r.outcome === null);
    expect(runsForT4).toHaveLength(1);

    await daemonB.shutdown(false);
    activeDaemons = activeDaemons.filter((d) => d !== daemonB);
    exitSpy.mockRestore();
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

  it('SIGTERM with shutdown_requested marker is treated as user stop, killing worker processes', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    process.env.FAKE_MODE = 'sleep-loop';
    delete process.env.STOP_SLEEP;

    taskRepo.insert({ id: 'p/tstopflag', projectId: 'p', slug: 'tstopflag', title: 'TStopFlag', status: 'queued', level: 'easy' });

    const daemon = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemon);
    await vi.waitFor(() => {
      expect(daemon.ctx.scheduler.getRunning().has('p/tstopflag')).toBe(true);
    }, { timeout: 10_000 });

    const rt = daemon.ctx.scheduler.getRunning().get('p/tstopflag')!;
    const workerPid = rt.pid;
    expect(workerPid).toBeGreaterThan(0);
    expect(process.kill(workerPid, 0)).toBe(true);

    // Place the shutdown marker file (as scripts/stop-prod.sh does)
    fs.writeFileSync(path.join(config.hubHome, 'shutdown_requested'), '');

    // Emit SIGTERM (simulating systemctl --user stop agenthub)
    process.emit('SIGTERM');

    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(workerPid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5000 });

    const run = runRepo.getByTask('p/tstopflag')[0];
    expect(run.outcome).toBe('crashed');
    expect(run.reason).toBe('user_stop');

    activeDaemons = activeDaemons.filter((d) => d !== daemon);
    exitSpy.mockRestore();
  });

  it('SIGTERM with stale shutdown_requested marker is treated as handoff (preserves worker)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    process.env.FAKE_MODE = 'sleep-loop';
    delete process.env.STOP_SLEEP;

    const flagPath = path.join(config.hubHome, 'shutdown_requested');
    // Pre-create marker before daemon starts; startDaemon must clean it up
    fs.writeFileSync(flagPath, 'stale-before-boot');

    taskRepo.insert({ id: 'p/tstaleflag', projectId: 'p', slug: 'tstaleflag', title: 'TStaleFlag', status: 'queued', level: 'easy' });

    const daemon = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemon);

    // Marker was cleared on daemon startup
    expect(fs.existsSync(flagPath)).toBe(false);

    await vi.waitFor(() => {
      expect(daemon.ctx.scheduler.getRunning().has('p/tstaleflag')).toBe(true);
    }, { timeout: 10_000 });

    const rt = daemon.ctx.scheduler.getRunning().get('p/tstaleflag')!;
    const workerPid = rt.pid;
    expect(workerPid).toBeGreaterThan(0);
    expect(process.kill(workerPid, 0)).toBe(true);

    // Create a marker that has a stale mtime (>30s old)
    fs.writeFileSync(flagPath, 'stale-marker');
    const pastTimeSec = (Date.now() - 60_000) / 1000;
    fs.utimesSync(flagPath, pastTimeSec, pastTimeSec);

    // Emit SIGTERM (simulating systemctl --user restart agenthub or service restart)
    process.emit('SIGTERM');

    // Wait for shutdown to process: worker must REMAIN ALIVE (handoff, not user_stop)
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(process.kill(workerPid, 0)).toBe(true);

    const run = runRepo.getByTask('p/tstaleflag')[0];
    expect(run.handoff).toBe(1);
    expect(run.outcome).toBeNull();

    // Clean up worker process
    try { process.kill(workerPid, 'SIGKILL'); } catch { /* ignore */ }
    activeDaemons = activeDaemons.filter((d) => d !== daemon);
    exitSpy.mockRestore();
  });

  it('SIGTERM via real onTerm handler kills checking process group, new daemon only reruns check without rerunning worker', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    const worktreePath = path.join(tmpDir, 'worktree-check-test');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: worktreePath });
    execFileSync('git', ['checkout', '-b', 'agenthub/tcheck'], { cwd: worktreePath });
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'worker work\n');
    execFileSync('git', ['add', '.'], { cwd: worktreePath });
    execFileSync('git', ['commit', '-m', 'worker commit'], {
      cwd: worktreePath,
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    });
    const workerCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(worktreePath, '.agenthub', 'DONE'), 'Worker finished');

    const slowCheckScript = path.join(tmpDir, 'slow-check.mjs');
    const checkPidFile = path.join(tmpDir, 'check.pid');
    fs.writeFileSync(slowCheckScript, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(checkPidFile)}, String(process.pid));
const interval = setInterval(() => {}, 1000);
process.on('SIGTERM', () => { clearInterval(interval); process.exit(143); });
`);
    projectRepo.update('p', {
      checks: JSON.stringify([{ name: 'slow-check', cmd: ['node', slowCheckScript], timeoutSec: 60 }]),
    });

    taskRepo.insert({
      id: 'p/tcheck',
      projectId: 'p',
      slug: 'tcheck',
      title: 'TCheck',
      status: 'checking',
      worktreePath,
      branch: 'agenthub/tcheck',
    });
    runRepo.insert({
      id: 'run-worker-done',
      taskId: 'p/tcheck',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    runRepo.finish('run-worker-done', 'done');

    const daemonA = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemonA);

    void daemonA.ctx.scheduler.runChecksForTask('p/tcheck', 'run-worker-done');

    await vi.waitFor(() => {
      expect(fs.existsSync(checkPidFile)).toBe(true);
    }, { timeout: 10_000 });
    const checkPid = parseInt(fs.readFileSync(checkPidFile, 'utf8').trim(), 10);
    expect(checkPid).toBeGreaterThan(0);
    expect(process.kill(checkPid, 0)).toBe(true);

    // Call real onTerm listener
    const sigtermListeners = process.listeners('SIGTERM') as Array<() => void>;
    expect(sigtermListeners.length).toBeGreaterThan(0);
    sigtermListeners[sigtermListeners.length - 1]();

    // Verify check process group was killed
    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(checkPid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5000 });

    activeDaemons = activeDaemons.filter((d) => d !== daemonA);

    const taskAfterHandoff = taskRepo.get('p/tcheck')!;
    expect(taskAfterHandoff.status).toBe('checking');

    // Configure passing check for daemon B
    projectRepo.update('p', {
      checks: JSON.stringify([{ name: 'fast-check', cmd: ['node', '-e', 'process.exit(0)'], timeoutSec: 10 }]),
    });

    const daemonB = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemonB);

    await vi.waitFor(() => {
      const currentTask = taskRepo.get('p/tcheck')!;
      expect(['review', 'done']).toContain(currentTask.status);
    }, { timeout: 10_000 });

    const workerRuns = runRepo.getByTask('p/tcheck').filter((r) => r.kind === 'worker');
    expect(workerRuns).toHaveLength(1);
    expect(workerRuns[0].id).toBe('run-worker-done');

    const commitAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
    expect(commitAfter).toBe(workerCommit);

    await daemonB.shutdown(true);
    activeDaemons = activeDaemons.filter((d) => d !== daemonB);
    exitSpy.mockRestore();
  });

  it('Telegram shutdown kills worker processes and process groups', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    process.env.FAKE_MODE = 'sleep-loop';
    delete process.env.STOP_SLEEP;

    config.telegram = { enabled: true, botToken: 'fake-token', allowedChatIds: [123] };
    taskRepo.insert({ id: 'p/ttg', projectId: 'p', slug: 'ttg', title: 'TTG', status: 'queued', level: 'easy' });

    const daemon = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemon);
    await vi.waitFor(() => {
      expect(daemon.ctx.scheduler.getRunning().has('p/ttg')).toBe(true);
    }, { timeout: 10_000 });

    const rt = daemon.ctx.scheduler.getRunning().get('p/ttg')!;
    const workerPid = rt.pid;
    expect(workerPid).toBeGreaterThan(0);
    expect(process.kill(workerPid, 0)).toBe(true);

    // Telegram shutdown callback from allowed chat
    await (daemon.ctx.telegramService as unknown as { handleCallbackQuery: (q: unknown) => Promise<void> }).handleCallbackQuery({
      id: 'cb-shutdown',
      from: { id: 123 },
      message: { message_id: 1, chat: { id: 123 } },
      data: 'hubshutdown:confirm',
    });

    // Wait for worker process to be killed
    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(workerPid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5000 });

    const run = runRepo.getByTask('p/ttg')[0];
    expect(run.outcome).toBe('crashed');
    expect(run.reason).toBe('user_stop');

    const task = taskRepo.get('p/ttg')!;
    expect(task.status).toBe('queued');
    expect(task.resume).toBe(1);

    activeDaemons = activeDaemons.filter((d) => d !== daemon);
    exitSpy.mockRestore();
  });

  it('restart now default preserves worker; killWorkers: true kills worker', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    process.env.FAKE_MODE = 'sleep-loop';
    delete process.env.STOP_SLEEP;

    taskRepo.insert({ id: 'p/tr1', projectId: 'p', slug: 'tr1', title: 'TR1', status: 'queued', level: 'easy' });
    const daemon1 = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemon1);
    await vi.waitFor(() => {
      expect(daemon1.ctx.scheduler.getRunning().has('p/tr1')).toBe(true);
    }, { timeout: 10_000 });
    const rt1 = daemon1.ctx.scheduler.getRunning().get('p/tr1')!;
    const workerPid1 = rt1.pid;
    expect(process.kill(workerPid1, 0)).toBe(true);

    const addr1 = daemon1.fastify.server.address() as AddressInfo | null;
    const port1 = addr1 ? addr1.port : config.port;
    const token1 = getOrCreateToken(config.tokenPath);
    const headers1 = { host: `127.0.0.1:${port1}`, authorization: `Bearer ${token1}` };
    const resDefault = await daemon1.fastify.inject({
      method: 'POST',
      url: '/api/system/restart',
      headers: headers1,
      payload: { mode: 'now' },
    });
    expect(resDefault.statusCode).toBe(200);
    expect(JSON.parse(resDefault.body).killWorkers).toBe(false);

    // Worker must still be alive!
    expect(process.kill(workerPid1, 0)).toBe(true);
    const run1 = runRepo.getByTask('p/tr1')[0];
    expect(run1.handoff).toBe(1);
    expect(run1.outcome).toBeNull();

    await daemon1.shutdown(true);
    activeDaemons = activeDaemons.filter((d) => d !== daemon1);
    try { process.kill(-workerPid1, 'SIGKILL'); } catch { /* ignore */ }

    // Test restart now with killWorkers: true
    taskRepo.insert({ id: 'p/tr2', projectId: 'p', slug: 'tr2', title: 'TR2', status: 'queued', level: 'easy' });
    const daemon2 = await startDaemon(config, new Map<string, Engine>([['agy', fakeEngine]]));
    activeDaemons.push(daemon2);
    await vi.waitFor(() => {
      expect(daemon2.ctx.scheduler.getRunning().has('p/tr2')).toBe(true);
    }, { timeout: 10_000 });
    const rt2 = daemon2.ctx.scheduler.getRunning().get('p/tr2')!;
    const workerPid2 = rt2.pid;
    expect(process.kill(workerPid2, 0)).toBe(true);

    const addr2 = daemon2.fastify.server.address() as AddressInfo | null;
    const port2 = addr2 ? addr2.port : config.port;
    const token2 = getOrCreateToken(config.tokenPath);
    const headers2 = { host: `127.0.0.1:${port2}`, authorization: `Bearer ${token2}` };
    const resKill = await daemon2.fastify.inject({
      method: 'POST',
      url: '/api/system/restart',
      headers: headers2,
      payload: { mode: 'now', killWorkers: true },
    });
    expect(resKill.statusCode).toBe(200);
    expect(JSON.parse(resKill.body).killWorkers).toBe(true);

    // Worker must be killed!
    await vi.waitFor(() => {
      let alive = true;
      try { process.kill(workerPid2, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    }, { timeout: 5000 });

    const run2 = runRepo.getByTask('p/tr2')[0];
    expect(run2.outcome).toBe('crashed');
    expect(run2.reason).toBe('hub_restart');
    expect(taskRepo.get('p/tr2')!.status).toBe('queued');

    await daemon2.shutdown(false);
    activeDaemons = activeDaemons.filter((d) => d !== daemon2);
    exitSpy.mockRestore();
  });
});
