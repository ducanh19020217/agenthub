import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertWorkerMayControlHub, workerEnvironment, WORKER_SERVICE_MESSAGE } from '../src/worker-guard.js';
import { makeTestTempDir } from './temp.js';

describe('worker service guard', () => {
  it('blocks hub service control but forwards unrelated systemctl commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-worker-guard-'));
    const bin = path.join(root, 'bin');
    const hub = path.join(root, 'hub');
    fs.mkdirSync(bin);
    const real = path.join(bin, 'systemctl');
    fs.writeFileSync(real, '#!/bin/sh\nprintf "real:%s\\n" "$*"\n', { mode: 0o700 });
    const env = workerEnvironment(hub, { PATH: bin, HOME: os.userInfo().homedir });
    const shim = path.join(hub, 'shims', 'service', 'systemctl');
    expect(() => execFileSync(shim, ['--user', 'stop', 'agenthub'], { env, encoding: 'utf8', stdio: 'pipe' })).toThrow(WORKER_SERVICE_MESSAGE);
    expect(execFileSync(shim, ['--user', 'status', 'foo'], { env, encoding: 'utf8' })).toContain('real:--user status foo');
    expect(() => execFileSync(shim, ['--user', 'daemon-reload', path.join(os.userInfo().homedir, '.config/systemd/user/agenthub.service'), 'agenthub'], { env, encoding: 'utf8', stdio: 'pipe' })).toThrow(WORKER_SERVICE_MESSAGE);
    expect(() => execFileSync('systemctl', ['--user', 'stop', 'agenthub'], { env, encoding: 'utf8', stdio: 'pipe' })).toThrow(WORKER_SERVICE_MESSAGE);
    expect(execFileSync('systemctl', ['--user', 'status', 'foo'], { env, encoding: 'utf8' })).toContain('real:--user status foo');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sets worker environment and refuses service commands for the real hub', () => {
    const previousWorker = process.env.AGENTHUB_WORKER;
    const previousHome = process.env.AGENTHUB_HOME;
    process.env.AGENTHUB_WORKER = '1';
    delete process.env.AGENTHUB_HOME;
    expect(() => assertWorkerMayControlHub('install-service')).toThrow(WORKER_SERVICE_MESSAGE);
    const tmp = makeTestTempDir('agenthub-worker-env-');
    try {
      const env = workerEnvironment(tmp, {});
      expect(env.AGENTHUB_WORKER).toBe('1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (previousWorker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previousWorker;
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
  });

  it('disables git hooks when gitHooks=skip and leaves them active when run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-hooks-test-'));
    const hub = path.join(root, 'hub');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');

    // Add a failing pre-commit hook
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommit = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(preCommit, '#!/bin/sh\necho "hook failed" >&2\nexit 1\n', { mode: 0o755 });

    const gitAuthorEnv = {
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };

    execFileSync('git', ['add', '.'], { cwd: repo });

    // 1. With project with default / gitHooks='run': commit should fail because hook exits 1
    const runEnv = workerEnvironment(hub, { ...process.env, ...gitAuthorEnv }, {
      project: { settings: JSON.stringify({ worktree: { gitHooks: 'run' } }) },
    });
    expect(() => execFileSync('git', ['commit', '-m', 'test-run'], { cwd: repo, env: runEnv, encoding: 'utf8', stdio: 'pipe' })).toThrow();

    // 2. With project with gitHooks='skip': commit succeeds because hooks are disabled
    const skipEnv = workerEnvironment(hub, { ...process.env, ...gitAuthorEnv }, {
      project: { settings: JSON.stringify({ worktree: { gitHooks: 'skip' } }) },
    });
    expect(skipEnv.HUSKY).toBe('0');
    expect(skipEnv.GIT_CONFIG_COUNT).toBe('1');
    expect(skipEnv.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(skipEnv.GIT_CONFIG_VALUE_0).toBe(path.join(hub, 'empty-hooks'));
    expect(fs.existsSync(path.join(hub, 'empty-hooks'))).toBe(true);

    expect(() => execFileSync('git', ['commit', '-m', 'test-skip'], { cwd: repo, env: skipEnv, encoding: 'utf8' })).not.toThrow();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('blocks network and container commands with informative message and exit 1', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-blocked-cmds-'));
    const hub = path.join(root, 'hub');
    const env = workerEnvironment(hub, { PATH: process.env.PATH });

    for (const cmd of ['ssh', 'scp', 'sftp', 'docker', 'docker-compose', 'podman']) {
      const shimPath = path.join(hub, 'shims', 'worker', cmd);
      expect(fs.existsSync(shimPath)).toBe(true);

      // Calling through shim directly
      expect(() => execFileSync(shimPath, ['some-arg'], { env, encoding: 'utf8', stdio: 'pipe' }))
        .toThrow(`AgentHub: worker không được chạy lệnh '${cmd}'`);

      // Calling by command name with PATH set to worker env
      expect(() => execFileSync(cmd, ['test'], { env, encoding: 'utf8', stdio: 'pipe' }))
        .toThrow(`AgentHub: worker không được chạy lệnh '${cmd}'`);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('git wrapper blocks git push and git remote set-url while allowing safe commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-wrapper-'));
    const hub = path.join(root, 'hub');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);

    execFileSync('git', ['init', '--template='], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'content');

    const env = workerEnvironment(hub, {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    });

    const gitShim = path.join(hub, 'shims', 'worker', 'git');
    expect(fs.existsSync(gitShim)).toBe(true);

    // 1. git push is blocked
    expect(() => execFileSync(gitShim, ['push', 'origin', 'main'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git push'");

    expect(() => execFileSync('git', ['-C', repo, 'push'], { env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git push'");

    expect(() => execFileSync('git', ['--no-pager', 'push'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git push'");

    // 2. git remote set-url is blocked
    expect(() => execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.com/repo.git'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git remote set-url'");

    expect(() => execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://example.com/repo.git'], { env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git remote set-url'");

    // 3. safe git commands run normally
    // git status
    const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: repo, env, encoding: 'utf8' });
    expect(statusOut).toContain('?? a.txt');

    // git add
    execFileSync('git', ['add', '.'], { cwd: repo, env });

    // git commit with message containing "push" (should NOT be blocked)
    execFileSync('git', ['commit', '-m', 'feat: push notification support'], { cwd: repo, env });

    // git log
    const logOut = execFileSync('git', ['log', '-1', '--oneline'], { cwd: repo, env, encoding: 'utf8' });
    expect(logOut).toContain('push notification support');

    // git remote add (should NOT be blocked)
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/test.git'], { cwd: repo, env });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('enforces brain policy shims independently of Codex approvals', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-guard-'));
    const hub = path.join(root, 'hub');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '--template='], { cwd: repo });
    const standard = workerEnvironment(hub, { ...process.env }, { cwd: repo, brainPolicy: 'standard' });

    for (const command of ['rm', 'systemctl', 'sudo']) {
      expect(() => execFileSync(command, ['-rf', path.join(repo, 'missing')], { cwd: repo, env: standard, stdio: 'pipe' }))
        .toThrow(`AgentHub: brain policy chặn lệnh '${command}'`);
    }
    expect(() => execFileSync('git', ['commit', '-m', 'blocked'], { cwd: repo, env: standard, stdio: 'pipe' }))
      .toThrow('AgentHub: brain standard policy chặn git commit');
    expect(execFileSync('git', ['status', '--short'], { cwd: repo, env: standard, encoding: 'utf8' })).toBe('');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('allows dependency installation only for brain workers configured with install=worker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-install-'));
    const bin = path.join(root, 'bin');
    const repo = path.join(root, 'repo');
    const hub = path.join(root, 'hub');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(repo);
    for (const name of ['npm', 'timeout']) {
      fs.writeFileSync(path.join(bin, name), name === 'npm'
        ? '#!/bin/sh\nprintf "npm:%s\\n" "$*"\n'
        : '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
    }

    const worker = workerEnvironment(hub, { PATH: bin }, {
      cwd: repo,
      project: { settings: JSON.stringify({ worktree: { install: 'worker' } }) },
      brainPolicy: 'standard',
    });
    expect(execFileSync('timeout', ['900', 'npm', 'ci'], { cwd: repo, env: worker, encoding: 'utf8' })).toContain('npm:ci');
    expect(execFileSync('sh', ['-c', 'timeout 900 npm ci'], { cwd: repo, env: worker, encoding: 'utf8' })).toContain('npm:ci');
    expect(execFileSync('timeout', ['900', 'npm', 'install'], { cwd: repo, env: worker, encoding: 'utf8' })).toContain('npm:install');
    for (const command of [['ci'], ['install']]) {
      expect(() => execFileSync('npm', command, { cwd: repo, env: worker, stdio: 'pipe' }))
        .toThrow('brain policy chặn tham số lệnh');
    }
    expect(() => execFileSync('timeout', ['901', 'npm', 'ci'], { cwd: repo, env: worker, stdio: 'pipe' })).toThrow('brain policy chặn tham số timeout');

    const autoHub = path.join(root, 'auto-hub');
    const auto = workerEnvironment(autoHub, { PATH: bin }, { cwd: repo, brainPolicy: 'standard' });
    expect(() => execFileSync('npm', ['ci'], { cwd: repo, env: auto, stdio: 'pipe' })).toThrow('brain policy chặn tham số lệnh');
    expect(() => execFileSync('timeout', ['900', 'npm', 'ci'], { cwd: repo, env: auto, stdio: 'pipe' })).toThrow('brain policy chặn lệnh');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves read-command symlinks before allowing access', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-read-links-'));
    const hub = path.join(root, 'hub');
    const repo = path.join(root, 'repo');
    const outside = path.join(root, 'outside');
    const secret = path.join(repo, 'secrets');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    fs.mkdirSync(secret);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside\n');
    fs.mkdirSync(path.join(outside, 'nested'));
    fs.writeFileSync(path.join(outside, 'nested', 'token.txt'), 'outside-secret\n');
    fs.writeFileSync(path.join(secret, 'auth.json'), '{"token":"do-not-read"}\n');
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(repo, 'outside-link'));
    fs.symlinkSync(path.join(secret, 'auth.json'), path.join(repo, 'secret-link'));
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(repo, '-secret-link'));
    fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(repo, '1secret-link'));
    fs.symlinkSync(path.join(outside, 'nested'), path.join(repo, 'outside-dir-link'));

    const env = workerEnvironment(hub, { ...process.env }, { cwd: repo, brainPolicy: 'standard' });
    expect(() => execFileSync('cat', ['outside-link'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow('AgentHub: brain policy chặn đọc ngoài project/worktree');
    expect(() => execFileSync('cat', ['secret-link'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow('AgentHub: brain policy chặn đọc secret hoặc .git');
    expect(() => execFileSync('cat', ['--', '-secret-link'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow('AgentHub: brain policy chặn đọc ngoài project/worktree');
    expect(() => execFileSync('cat', ['1secret-link'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow('AgentHub: brain policy chặn đọc ngoài project/worktree');
    for (const args of [
      ['grep', '--file=' + path.join(outside, 'outside.txt'), 'outside', 'package.json'],
      ['grep', '-f', path.join(outside, 'outside.txt'), 'outside', 'package.json'],
      ['grep', '-R', 'outside-secret', 'outside-dir-link'],
    ]) {
      expect(() => execFileSync(args[0], args.slice(1), { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
        .toThrow('AgentHub: brain policy chặn grep đệ quy hoặc đọc pattern từ file');
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('can disable worker command guards for hub git operations while keeping service shims', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hub-env-'));
    const hub = path.join(root, 'hub');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "real:%s\\n" "$*"\n', { mode: 0o700 });

    const bareRepo = path.join(root, 'bare.git');
    fs.mkdirSync(bareRepo, { recursive: true });
    execFileSync('git', ['init', '--bare', bareRepo]);

    const workRepo = path.join(root, 'work');
    fs.mkdirSync(workRepo, { recursive: true });
    execFileSync('git', ['init', '--template='], { cwd: workRepo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: workRepo });
    fs.writeFileSync(path.join(workRepo, 'file.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: workRepo });

    const gitAuthorEnv = {
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: workRepo, env: { ...process.env, ...gitAuthorEnv } });
    execFileSync('git', ['remote', 'add', 'origin', bareRepo], { cwd: workRepo });

    // 1. Call workerEnvironment(hub) (worker) FIRST
    const workerEnv = workerEnvironment(hub, { ...process.env, ...gitAuthorEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}` });

    // 2. Call workerEnvironment(hub, ..., { guards: false }) on the SAME hub
    const hubEnv = workerEnvironment(hub, { ...process.env, ...gitAuthorEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, { guards: false });

    // Hub env has service shims first, but NOT worker shims
    expect(hubEnv.PATH?.split(path.delimiter)[0]).toBe(path.join(hub, 'shims', 'service'));
    expect(hubEnv.PATH?.split(path.delimiter)).not.toContain(path.join(hub, 'shims', 'worker'));

    // Worker env has service shims then worker shims
    expect(workerEnv.PATH?.split(path.delimiter)[0]).toBe(path.join(hub, 'shims', 'service'));
    expect(workerEnv.PATH?.split(path.delimiter)[1]).toBe(path.join(hub, 'shims', 'worker'));

    // 3. git push with workerEnv is blocked
    expect(() => execFileSync('git', ['push', bareRepo, 'main'], { cwd: workRepo, env: workerEnv, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git push'");

    // 4. git push with hubEnv succeeds
    expect(() => execFileSync('git', ['push', bareRepo, 'main'], { cwd: workRepo, env: hubEnv, encoding: 'utf8' }))
      .not.toThrow();

    // 5. systemctl stop agenthub is blocked in BOTH workerEnv and hubEnv
    expect(() => execFileSync('systemctl', ['stop', 'agenthub'], { env: workerEnv, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(WORKER_SERVICE_MESSAGE);
    expect(() => execFileSync('systemctl', ['stop', 'agenthub'], { env: hubEnv, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(WORKER_SERVICE_MESSAGE);

    // systemctl status agenthub is forwarded in both
    expect(execFileSync('systemctl', ['status', 'agenthub'], { env: workerEnv, encoding: 'utf8' })).toContain('real:status agenthub');
    expect(execFileSync('systemctl', ['status', 'agenthub'], { env: hubEnv, encoding: 'utf8' })).toContain('real:status agenthub');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cleans up legacy shims at <hubHome>/shims root if present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-legacy-shims-'));
    const hub = path.join(root, 'hub');
    const oldShimsDir = path.join(hub, 'shims');
    fs.mkdirSync(oldShimsDir, { recursive: true });

    // Place legacy shim files in root shims dir
    const legacyGit = path.join(oldShimsDir, 'git');
    const legacySsh = path.join(oldShimsDir, 'ssh');
    const legacySystemctl = path.join(oldShimsDir, 'systemctl');
    const unrelatedFile = path.join(oldShimsDir, 'unrelated.txt');
    fs.writeFileSync(legacyGit, '#!/bin/sh\n', { mode: 0o700 });
    fs.writeFileSync(legacySsh, '#!/bin/sh\n', { mode: 0o700 });
    fs.writeFileSync(legacySystemctl, '#!/bin/sh\n', { mode: 0o700 });
    fs.writeFileSync(unrelatedFile, 'keep me');

    // Calling workerEnvironment should remove legacy shims but keep unrelated files
    workerEnvironment(hub, { PATH: process.env.PATH });

    expect(fs.existsSync(legacyGit)).toBe(false);
    expect(fs.existsSync(legacySsh)).toBe(false);
    expect(fs.existsSync(legacySystemctl)).toBe(false);
    expect(fs.existsSync(unrelatedFile)).toBe(true);

    // And new shims exist in subdirectories
    expect(fs.existsSync(path.join(hub, 'shims', 'service', 'systemctl'))).toBe(true);
    expect(fs.existsSync(path.join(hub, 'shims', 'worker', 'git'))).toBe(true);
    expect(fs.existsSync(path.join(hub, 'shims', 'worker', 'ssh'))).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps unrelated tool shims in PATH while removing only hub shims', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-path-shims-'));
    const hub = path.join(root, 'hub');
    const asdfShims = path.join(root, '.asdf', 'shims');
    const fakebin = path.join(asdfShims, 'fakebin');
    const legacyShims = path.join(hub, 'shims');
    fs.mkdirSync(asdfShims, { recursive: true });
    fs.mkdirSync(legacyShims, { recursive: true });
    fs.writeFileSync(fakebin, '#!/bin/sh\nprintf "fakebin-ran\\n"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(legacyShims, 'old-tool'), '#!/bin/sh\n', { mode: 0o700 });

    for (const guards of [true, false]) {
      const env = workerEnvironment(hub, {
        PATH: [legacyShims, asdfShims].join(path.delimiter),
      }, { guards });
      const entries = env.PATH?.split(path.delimiter) ?? [];
      expect(entries).toContain(asdfShims);
      expect(entries).not.toContain(legacyShims);
      expect(execFileSync('fakebin', [], { env, encoding: 'utf8' })).toBe('fakebin-ran\n');
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exposes AGENTHUB_REF_<NAME> environment variables for project references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ref-env-'));
    const hub = path.join(root, 'hub');

    const env = workerEnvironment(hub, {}, {
      project: {
        settings: JSON.stringify({
          references: [
            { name: 'glossary', path: '/docs/glossary.md', inject: true },
            { name: 'shared_lib', path: '/libs/shared', inject: false },
            { name: 'api-spec', path: '/specs/api.json', inject: false },
          ],
        }),
      },
    });

    expect(env.AGENTHUB_REF_GLOSSARY).toBe('/docs/glossary.md');
    expect(env.AGENTHUB_REF_SHARED_LIB).toBe('/libs/shared');
    expect(env.AGENTHUB_REF_API_SPEC).toBe('/specs/api.json');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('adds the AgentHub git identity only when the repository has none', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-worker-identity-'));
    const repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(home);
    execFileSync('git', ['init', '--template='], { cwd: repo });

    const cleanEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null' };
    delete cleanEnv.GIT_AUTHOR_NAME;
    delete cleanEnv.GIT_AUTHOR_EMAIL;
    delete cleanEnv.GIT_COMMITTER_NAME;
    delete cleanEnv.GIT_COMMITTER_EMAIL;
    const fallback = workerEnvironment(path.join(root, 'hub'), cleanEnv, { cwd: repo });
    expect(fallback.GIT_AUTHOR_NAME).toBe('AgentHub');
    expect(fallback.GIT_AUTHOR_EMAIL).toBe('agenthub@localhost');
    expect(fallback.GIT_COMMITTER_NAME).toBe('AgentHub');
    expect(fallback.GIT_COMMITTER_EMAIL).toBe('agenthub@localhost');

    const explicit = workerEnvironment(path.join(root, 'hub-explicit'), {
      ...cleanEnv,
      GIT_AUTHOR_NAME: 'Existing Author',
    }, { cwd: repo });
    expect(explicit.GIT_AUTHOR_NAME).toBe('Existing Author');
    expect(explicit.GIT_AUTHOR_EMAIL).toBe('agenthub@localhost');
    expect(explicit.GIT_COMMITTER_NAME).toBe('AgentHub');
    expect(explicit.GIT_COMMITTER_EMAIL).toBe('agenthub@localhost');

    execFileSync('git', ['config', 'user.name', 'Configured User'], { cwd: repo, env: cleanEnv });
    execFileSync('git', ['config', 'user.email', 'configured@example.com'], { cwd: repo, env: cleanEnv });
    const configured = workerEnvironment(path.join(root, 'hub-configured'), cleanEnv, { cwd: repo });
    expect(configured.GIT_AUTHOR_NAME).toBeUndefined();
    expect(configured.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(configured.GIT_COMMITTER_NAME).toBeUndefined();
    expect(configured.GIT_COMMITTER_EMAIL).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
