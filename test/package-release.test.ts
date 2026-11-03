import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { cmdRollback, cmdSetup } from '../src/cli.js';
import { makeTestTempDir } from './temp.js';
import { prepareMacosNativeBinaries } from '../scripts/package-native.mjs';

const installer = path.resolve('scripts/install.sh');
const tempDirs: string[] = [];

function makeTemp(prefix: string) {
  const dir = makeTestTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, { env: { ...process.env, ...env }, encoding: 'utf8' });
}

// Same naming as scripts/package.mjs and install.sh, so the fixture matches the runner (CI also
// runs on linux-arm64 and macos).
const PLATFORM_ARCH = `${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

type ReleaseOptions = {
  checksum?: boolean;
  setupFails?: boolean;
  serviceFails?: boolean;
  brokenNative?: boolean;
};

function makeRelease(base: string, version: string, options: ReleaseOptions | boolean = {}) {
  const normalized = typeof options === 'boolean' ? { checksum: options } : options;
  const releaseDir = path.join(base, 'releases', 'download', `v${version}`);
  const staging = makeTestTempDir('agenthub-release-fixture-');
  fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'agenthub', version }));
  fs.writeFileSync(path.join(staging, 'package-lock.json'), JSON.stringify({
    name: 'agenthub', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'agenthub', version } },
  }));
  fs.writeFileSync(path.join(staging, 'bin/agenthub'), `#!/bin/sh
set -eu
case "${'${1:-}'}" in
  link)
    mkdir -p "${'${AGENTHUB_LINK_DIR:-$HOME/.local/bin}'}"
    printf '%s\n' "${'${0}'}" > "${'${0}'}.target"
    ln -sfn "${'${0}'}.target" "${'${AGENTHUB_LINK_DIR:-$HOME/.local/bin}'}/agenthub"
    ;;
  install-service)
    case "$(uname -s)" in
      Darwin*)
        plist="${'${HOME}'}/Library/LaunchAgents/dev.agenthub.plist"
        mkdir -p "$(dirname "$plist")"
        printf '<plist><dict><key>Label</key><string>dev.agenthub</string></dict></plist>\n' > "$plist"
        "${'${AGENTHUB_LAUNCHCTL:-launchctl}'}" bootstrap "gui/$(id -u)" "$plist"
        ;;
      *)
        mkdir -p "${'${HOME}'}/.config/systemd/user"
        printf 'ExecStart=%s\n' "${'${0}'}" > "${'${HOME}'}/.config/systemd/user/agenthub.service"
        ;;
    esac
    ${normalized.serviceFails ? 'exit 1' : ':'}
    ;;
  setup)
    ${normalized.setupFails ? 'exit 1' : ':'}
    ;;
esac
exit 0
`, { mode: 0o755 });
  // Real release archives ship prebuilt production node_modules, so install needs no compiler.
  fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
  if (normalized.brokenNative) {
    fs.mkdirSync(path.join(staging, 'node_modules/x/build/Release'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'node_modules/x/build/Release/x.node'), 'not a native module');
  }
  fs.mkdirSync(releaseDir, { recursive: true });
  const archiveName = `agenthub-${version}-${PLATFORM_ARCH}.tar.gz`;
  expect(run('tar', ['-czf', path.join(releaseDir, archiveName), '-C', staging, '.']).status).toBe(0);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDir, archiveName))).digest('hex');
  fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS'), `${normalized.checksum !== false ? digest : '0'.repeat(64)}  ${archiveName}\n`);
  fs.rmSync(staging, { recursive: true, force: true });
}

describe('release packaging and installation', () => {
  it('makes macOS node-pty spawn-helper executable without requiring a macOS host', () => {
    const staging = makeTemp('agenthub-package-macos-native-');
    const helper = path.join(staging, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, '#!/bin/sh\n');
    fs.chmodSync(helper, 0o644);

    prepareMacosNativeBinaries(staging, 'darwin');

    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
  });

  it('creates a complete archive without development or local state files', () => {
    const dist = path.resolve('dist');
    const backup = makeTestTempDir('agenthub-dist-backup-');
    if (fs.existsSync(dist)) fs.cpSync(dist, path.join(backup, 'dist'), { recursive: true });
    try {
      const result = run('npm', ['run', 'package']);
      expect(result.status).toBe(0);
      const releaseDir = path.resolve('release');
      const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version as string;
      const expectedName = `agenthub-${version}-${PLATFORM_ARCH}.tar.gz`;
      const checksumEntry = fs.readFileSync(path.join(releaseDir, 'SHA256SUMS'), 'utf8')
        .split('\n').map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === expectedName);
      const archive = checksumEntry?.[1] || expectedName;
      expect(archive).toBeDefined();
      const archivePath = path.join(releaseDir, archive!);
      const listing = run('tar', ['-tzf', archivePath]).stdout.split('\n').filter(Boolean);
      for (const entry of ['dist/', 'dist/web/', 'package.json', 'package-lock.json', 'bin/', 'README.md', 'LICENSE', 'docs/GETTING-STARTED.md', 'scripts/install.sh']) {
        expect(listing).toContain(`./${entry}`);
      }
      expect(listing.some((entry) => /(^|\/)(\.agenthub|\.env)(\/|$)/.test(entry))).toBe(false);
      expect(listing).toContain('./node_modules/');
      const expected = fs.readFileSync(path.join(releaseDir, 'SHA256SUMS'), 'utf8').split(/\s+/)[0];
      const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
      expect(expected).toBe(actual);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
      if (fs.existsSync(path.join(backup, 'dist'))) fs.cpSync(path.join(backup, 'dist'), dist, { recursive: true });
      fs.rmSync(backup, { recursive: true, force: true });
    }
  });

  it('rejects a bad checksum without changing current and keeps two old releases', () => {
    const home = makeTemp('agenthub-release-install-');
    const base = path.join(home, 'fake-release');
    const app = path.join(home, 'app');
    const fakeSystemctl = path.join(home, 'systemctl');
    fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fakeLaunchctl = path.join(home, 'launchctl');
    fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    makeRelease(base, '1.0.0');
    makeRelease(base, '2.0.0', false);
    const env = {
      HOME: home,
      AGENTHUB_DIR: app,
      AGENTHUB_HOME: path.join(home, 'data'),
      AGENTHUB_RELEASE_BASE: base,
      AGENTHUB_SYSTEMCTL: fakeSystemctl,
      AGENTHUB_LAUNCHCTL: fakeLaunchctl,
      AGENTHUB_NO_BROWSER: '1',
    };
    expect(run('/bin/sh', [installer, '--from-release', '1.0.0'], env).status).toBe(0);
    const before = fs.readlinkSync(path.join(app, 'current'));
    const bad = run('/bin/sh', [installer, '--from-release', '2.0.0'], env);
    expect(bad.status).not.toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe(before);

    makeRelease(base, '2.0.0');
    makeRelease(base, '3.0.0');
    expect(run('/bin/sh', [installer, '--from-release', '2.0.0'], env).status).toBe(0);
    expect(run('/bin/sh', [installer, '--from-release', '3.0.0'], env).status).toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('3.0.0');
    expect(fs.existsSync(path.join(app, '1.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '2.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '3.0.0'))).toBe(true);
  });

  it('installs a macOS release through launchctl shims without host Node or git', () => {
    const home = makeTemp('agenthub-release-darwin-shim-');
    const base = path.join(home, 'fake-release');
    const app = path.join(home, 'app');
    const linkDir = path.join(home, 'links');
    const shimBin = path.join(home, 'shim-bin');
    const launchctlLog = path.join(home, 'launchctl.log');
    fs.mkdirSync(shimBin, { recursive: true });
    fs.writeFileSync(path.join(shimBin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac\n', { mode: 0o755 });
    fs.writeFileSync(path.join(shimBin, 'node'), '#!/bin/sh\ncase "$1" in -p) echo 22 ;; *) exit 0 ;; esac\n', { mode: 0o755 });
    const fakeLaunchctl = path.join(shimBin, 'launchctl');
    fs.writeFileSync(fakeLaunchctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${launchctlLog}'\n`, { mode: 0o755 });
    makeRelease(base, '1.0.0');
    const releaseDir = path.join(base, 'releases', 'download', 'v1.0.0');
    const archive = path.join(releaseDir, `agenthub-1.0.0-${PLATFORM_ARCH}.tar.gz`);
    const macArchive = path.join(releaseDir, 'agenthub-1.0.0-macos-arm64.tar.gz');
    if (archive !== macArchive) {
      fs.renameSync(archive, macArchive);
    }
    fs.writeFileSync(releaseDir + '/SHA256SUMS', `${crypto.createHash('sha256').update(fs.readFileSync(macArchive)).digest('hex')}  ${path.basename(macArchive)}\n`);

    const result = run('/bin/sh', [installer, '--from-release', '1.0.0'], {
      HOME: home,
      PATH: `${shimBin}:/usr/bin:/bin`,
      AGENTHUB_DIR: app,
      AGENTHUB_HOME: path.join(home, 'data'),
      AGENTHUB_LINK_DIR: linkDir,
      AGENTHUB_RELEASE_BASE: base,
      AGENTHUB_LAUNCHCTL: fakeLaunchctl,
      AGENTHUB_NO_BROWSER: '1',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'dev.agenthub.plist'))).toBe(true);
    expect(fs.readFileSync(launchctlLog, 'utf8')).toContain('bootstrap gui/');
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.0.0');
  });

  it('rolls back a failed Darwin service update and restores the previous plist', () => {
    const home = makeTemp('agenthub-release-darwin-rollback-');
    const base = path.join(home, 'fake-release');
    const app = path.join(home, 'app');
    const linkDir = path.join(home, 'links');
    const shimBin = path.join(home, 'shim-bin');
    const launchctlLog = path.join(home, 'launchctl.log');
    fs.mkdirSync(shimBin, { recursive: true });
    fs.writeFileSync(path.join(shimBin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac\n', { mode: 0o755 });
    fs.writeFileSync(path.join(shimBin, 'node'), '#!/bin/sh\ncase "$1" in -p) echo 22 ;; *) exit 0 ;; esac\n', { mode: 0o755 });
    const fakeLaunchctl = path.join(shimBin, 'launchctl');
    fs.writeFileSync(fakeLaunchctl, `#!/bin/sh
printf '%s\n' "$*" >> '${launchctlLog}'
` , { mode: 0o755 });
    for (const [version, options] of [['1.0.0', {}], ['2.0.0', { serviceFails: true }]] as const) {
      makeRelease(base, version, options);
      const releaseDir = path.join(base, 'releases', 'download', `v${version}`);
      const archive = path.join(releaseDir, `agenthub-${version}-${PLATFORM_ARCH}.tar.gz`);
      const macArchive = path.join(releaseDir, `agenthub-${version}-macos-arm64.tar.gz`);
      if (archive !== macArchive) {
        fs.renameSync(archive, macArchive);
      }
      fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS'), `${crypto.createHash('sha256').update(fs.readFileSync(macArchive)).digest('hex')}  ${path.basename(macArchive)}\n`);
    }
    const env = {
      HOME: home,
      PATH: `${shimBin}:/usr/bin:/bin`,
      AGENTHUB_DIR: app,
      AGENTHUB_HOME: path.join(home, 'data'),
      AGENTHUB_LINK_DIR: linkDir,
      AGENTHUB_RELEASE_BASE: base,
      AGENTHUB_LAUNCHCTL: fakeLaunchctl,
      AGENTHUB_NO_BROWSER: '1',
    };

    expect(run('/bin/sh', [installer, '--from-release', '1.0.0'], env).status).toBe(0);
    const plist = path.join(home, 'Library', 'LaunchAgents', 'dev.agenthub.plist');
    const oldPlist = fs.readFileSync(plist, 'utf8');
    const failed = run('/bin/sh', [installer, '--from-release', '2.0.0'], env);

    expect(failed.status).not.toBe(0);
    expect(fs.readFileSync(plist, 'utf8')).toBe(oldPlist);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.0.0');
    expect(fs.readFileSync(launchctlLog, 'utf8')).toContain('bootout gui/');
    expect(failed.stderr).toContain('Đã hoàn tác về bản trước');
  });

  it.skipIf(process.platform === 'darwin')('rolls back current, cli link, and service when install-service fails', () => {
    // Skipped on Darwin: install-service installs systemd on Linux and launchctl on Darwin;
    // Darwin service rollback is tested in the previous test case.
    const home = makeTemp('agenthub-release-service-rollback-');
    const base = path.join(home, 'fake-release');
    const app = path.join(home, 'app');
    const linkDir = path.join(home, 'links');
    const systemctlLog = path.join(home, 'systemctl.log');
    const fakeSystemctl = path.join(home, 'systemctl');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh
printf '%s\n' "$*" >> '${systemctlLog}'
`, { mode: 0o755 });
    makeRelease(base, '1.0.0');
    makeRelease(base, '2.0.0', { serviceFails: true });
    const env = {
      HOME: home,
      AGENTHUB_DIR: app,
      AGENTHUB_HOME: path.join(home, 'data'),
      AGENTHUB_LINK_DIR: linkDir,
      AGENTHUB_RELEASE_BASE: base,
      AGENTHUB_SYSTEMCTL: fakeSystemctl,
    };

    expect(run('/bin/sh', [installer, '--from-release', '1.0.0'], env).status).toBe(0);
    const oldLink = fs.readlinkSync(path.join(linkDir, 'agenthub'));
    const oldService = fs.readFileSync(path.join(home, '.config/systemd/user/agenthub.service'), 'utf8');
    const failed = run('/bin/sh', [installer, '--from-release', '2.0.0'], env);

    expect(failed.status).not.toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.0.0');
    expect(fs.readlinkSync(path.join(linkDir, 'agenthub'))).toBe(oldLink);
    expect(fs.readFileSync(path.join(home, '.config/systemd/user/agenthub.service'), 'utf8')).toBe(oldService);
    expect(fs.existsSync(path.join(app, '2.0.0'))).toBe(false);
    expect(fs.readFileSync(systemctlLog, 'utf8')).toContain('--user daemon-reload');
    expect(failed.stderr).toContain('Đã hoàn tác về bản trước');
    expect(failed.stderr).not.toContain('Không có gì bị thay đổi trên máy');
  });

  it('keeps the running release intact when reinstalling the same version fails in setup', () => {
    const home = makeTemp('agenthub-release-same-version-');
    const base = path.join(home, 'fake-release');
    const app = path.join(home, 'app');
    const fakeLaunchctl = path.join(home, 'fake-launchctl');
    fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = {
      HOME: home,
      AGENTHUB_DIR: app,
      AGENTHUB_HOME: path.join(home, 'data'),
      AGENTHUB_RELEASE_BASE: base,
      AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
      AGENTHUB_LAUNCHCTL: fakeLaunchctl,
    };
    makeRelease(base, '1.0.0');
    expect(run('/bin/sh', [installer, '--from-release', '1.0.0'], env).status).toBe(0);
    const before = fs.readFileSync(path.join(app, '1.0.0', 'bin/agenthub'), 'utf8');
    makeRelease(base, '1.0.0', { setupFails: true });

    const failed = run('/bin/sh', [installer, '--from-release', '1.0.0'], env);

    expect(failed.status).not.toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.0.0');
    expect(fs.readFileSync(path.join(app, '1.0.0', 'bin/agenthub'), 'utf8')).toBe(before);
    expect(failed.stderr).toContain('Không có gì bị thay đổi trên máy');
    expect(failed.stderr).not.toContain('Đã hoàn tác về bản trước');
    expect(fs.readdirSync(app).filter((name) => /^\.1\.0\.0\.tmp\./.test(name))).toHaveLength(0);
  });

  it('rejects a broken native file before switching current and identifies the file', () => {
    const home = makeTemp('agenthub-release-native-');
    const base = path.join(home, 'fake-release');
    const app = path.join(home, 'app');
    const fakeLaunchctl = path.join(home, 'fake-launchctl');
    fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = {
      HOME: home,
      AGENTHUB_DIR: app,
      AGENTHUB_HOME: path.join(home, 'data'),
      AGENTHUB_RELEASE_BASE: base,
      AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
      AGENTHUB_LAUNCHCTL: fakeLaunchctl,
    };
    makeRelease(base, '1.0.0');
    makeRelease(base, '2.0.0', { brokenNative: true });
    expect(run('/bin/sh', [installer, '--from-release', '1.0.0'], env).status).toBe(0);

    const failed = run('/bin/sh', [installer, '--from-release', '2.0.0'], env);

    expect(failed.status).not.toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.0.0');
    expect(failed.stderr).toContain('module native không nạp được');
    expect(failed.stderr).toContain('node_modules/x/build/Release/x.node');
    expect(failed.stderr).toContain('Gói release bị thiếu hoặc hỏng file native');
  });

  it.each(['', '../x', '1.0;rm'])('rejects invalid release version %j before creating app paths', (version) => {
    const home = makeTemp('agenthub-release-invalid-');
    const app = path.join(home, 'app');
    const result = run('/bin/sh', [installer, '--from-release', version], { HOME: home, AGENTHUB_DIR: app, AGENTHUB_HOME: path.join(home, 'data') });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(app)).toBe(false);
  });
});

describe('setup in worker mode', () => {
  it('creates the token but does not install a service', async () => {
    const home = makeTemp('agenthub-setup-');
    const previous = { HOME: process.env.HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, AGENTHUB_WORKER: process.env.AGENTHUB_WORKER };
    process.env.HOME = home;
    process.env.AGENTHUB_HOME = path.join(home, 'data');
    process.env.AGENTHUB_WORKER = '1';
    try {
      const config = loadConfig();
      await cmdSetup(config, ['--no-browser']);
      expect(fs.existsSync(path.join(home, 'data', 'token'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'agenthub.service'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('release rollback', () => {
  it('switches current to a requested or previous release and rejects missing history', async () => {
    const home = makeTemp('agenthub-rollback-');
    const app = path.join(home, 'app');
    const fakeSystemctl = path.join(home, 'systemctl');
    fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fakeLaunchctl = path.join(home, 'launchctl');
    fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
      fs.mkdirSync(path.join(app, version), { recursive: true });
      fs.writeFileSync(path.join(app, version, 'package.json'), JSON.stringify({ version }));
    }
    fs.symlinkSync('3.0.0', path.join(app, 'current'));
    const previous = {
      HOME: process.env.HOME,
      AGENTHUB_SYSTEMCTL: process.env.AGENTHUB_SYSTEMCTL,
      AGENTHUB_LAUNCHCTL: process.env.AGENTHUB_LAUNCHCTL,
    };
    process.env.HOME = home;
    process.env.AGENTHUB_SYSTEMCTL = fakeSystemctl;
    process.env.AGENTHUB_LAUNCHCTL = fakeLaunchctl;
    try {
      await cmdRollback(['1.0.0'], path.join(app, '3.0.0'));
      expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.0.0');
      fs.unlinkSync(path.join(app, 'current'));
      fs.symlinkSync('3.0.0', path.join(app, 'current'));
      await cmdRollback([], path.join(app, '3.0.0'));
      expect(fs.readlinkSync(path.join(app, 'current'))).toBe('2.0.0');
    } finally {
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.AGENTHUB_SYSTEMCTL === undefined) delete process.env.AGENTHUB_SYSTEMCTL;
      else process.env.AGENTHUB_SYSTEMCTL = previous.AGENTHUB_SYSTEMCTL;
      if (previous.AGENTHUB_LAUNCHCTL === undefined) delete process.env.AGENTHUB_LAUNCHCTL;
      else process.env.AGENTHUB_LAUNCHCTL = previous.AGENTHUB_LAUNCHCTL;
    }

    const onlyCurrent = makeTemp('agenthub-rollback-empty-');
    fs.mkdirSync(path.join(onlyCurrent, '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(onlyCurrent, '1.0.0', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    fs.symlinkSync('1.0.0', path.join(onlyCurrent, 'current'));
    await expect(cmdRollback([], path.join(onlyCurrent, '1.0.0'))).rejects.toThrow('Không có bản release cũ');
    expect(fs.readlinkSync(path.join(onlyCurrent, 'current'))).toBe('1.0.0');
  });
});
