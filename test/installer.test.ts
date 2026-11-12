import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdUpdate } from '../src/update.js';
import { linuxPlatform } from '../src/platform/linux.js';
import { makeTestTempDir } from './temp.js';

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

describe('safe installer and updater commands', () => {
  it.skipIf(process.platform === 'darwin')(
    'uninstalls only temporary paths and calls the injected systemctl',
    () => {
      const home = makeTemp('agenthub-installer-');
      const bin = path.join(home, 'bin');
      const log = path.join(home, 'systemctl.log');
      const fakeSystemctl = path.join(bin, 'systemctl');
      const app = path.join(home, 'app');
      const data = path.join(home, 'data');
      const linkDir = path.join(home, 'links');
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(app, { recursive: true });
      fs.mkdirSync(data, { recursive: true });
      fs.mkdirSync(linkDir, { recursive: true });
      fs.writeFileSync(path.join(app, 'sentinel'), 'app');
      fs.mkdirSync(path.join(app, '.0.9.0.tmp.123'));
      fs.writeFileSync(path.join(app, '.agenthub-app'), 'version=0.1.0\n');
      expect(spawnSync('git', ['-C', app, 'init'], { encoding: 'utf8' }).status).toBe(0);
      expect(spawnSync('git', ['-C', app, 'config', 'agenthub.installed', 'true'], { encoding: 'utf8' }).status).toBe(0);
      fs.writeFileSync(path.join(data, 'sentinel'), 'data');
      fs.symlinkSync(path.join(app, 'sentinel'), path.join(linkDir, 'agenthub'));
      fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENTHUB_FAKE_LOG"\n');
      fs.chmodSync(fakeSystemctl, 0o755);

      const result = spawnSync('/bin/sh', [installer, '--uninstall'], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          AGENTHUB_DIR: app,
          AGENTHUB_HOME: data,
          AGENTHUB_LINK_DIR: linkDir,
          AGENTHUB_SYSTEMCTL: fakeSystemctl,
          AGENTHUB_FAKE_LOG: log,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(app)).toBe(false);
      expect(fs.existsSync(path.join(app, '.0.9.0.tmp.123'))).toBe(false);
      expect(fs.existsSync(data)).toBe(true);
      expect(fs.existsSync(path.join(linkDir, 'agenthub'))).toBe(false);
      expect(fs.readFileSync(log, 'utf8')).toContain('--user stop agenthub');
      expect(fs.readFileSync(log, 'utf8')).toContain('--user disable agenthub');
      expect(fs.readFileSync(log, 'utf8')).toContain('--user daemon-reload');
    },
  );

  it(
    'uninstalls only temporary paths and calls the injected launchctl on macOS',
    () => {
      const home = makeTemp('agenthub-installer-darwin-');
      const bin = path.join(home, 'bin');
      const log = path.join(home, 'launchctl.log');
      const fakeLaunchctl = path.join(bin, 'launchctl');
      const app = path.join(home, 'app');
      const data = path.join(home, 'data');
      const linkDir = path.join(home, 'links');
      const plistDir = path.join(home, 'Library', 'LaunchAgents');
      const plistFile = path.join(plistDir, 'dev.agenthub.plist');
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(app, { recursive: true });
      fs.mkdirSync(data, { recursive: true });
      fs.mkdirSync(linkDir, { recursive: true });
      fs.mkdirSync(plistDir, { recursive: true });
      fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac\n');
      fs.chmodSync(path.join(bin, 'uname'), 0o755);
      fs.writeFileSync(plistFile, '<plist></plist>');
      fs.writeFileSync(path.join(app, 'sentinel'), 'app');
      fs.writeFileSync(path.join(app, '.agenthub-app'), 'version=0.1.0\n');
      expect(spawnSync('git', ['-C', app, 'init'], { encoding: 'utf8' }).status).toBe(0);
      expect(spawnSync('git', ['-C', app, 'config', 'agenthub.installed', 'true'], { encoding: 'utf8' }).status).toBe(0);
      fs.writeFileSync(path.join(data, 'sentinel'), 'data');
      fs.symlinkSync(path.join(app, 'sentinel'), path.join(linkDir, 'agenthub'));
      fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENTHUB_FAKE_LOG"\n');
      fs.chmodSync(fakeLaunchctl, 0o755);

      const result = spawnSync('/bin/sh', [installer, '--uninstall'], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          AGENTHUB_DIR: app,
          AGENTHUB_HOME: data,
          AGENTHUB_LINK_DIR: linkDir,
          AGENTHUB_LAUNCHCTL: fakeLaunchctl,
          AGENTHUB_FAKE_LOG: log,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(app)).toBe(false);
      expect(fs.existsSync(data)).toBe(true);
      expect(fs.existsSync(path.join(linkDir, 'agenthub'))).toBe(false);
      expect(fs.existsSync(plistFile)).toBe(false);
      expect(fs.readFileSync(log, 'utf8')).toContain('bootout');
    },
  );

  it('supports Darwin dry-run without invoking launchctl or changing files', () => {
    const home = makeTemp('agenthub-installer-darwin-dry-');
    const bin = path.join(home, 'bin');
    const app = path.join(home, 'app');
    const stale = path.join(app, '.0.9.0.tmp.123');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, '.agenthub-app'), 'mode=release\n');
    fs.writeFileSync(path.join(stale, 'sentinel'), 'keep');
    const result = spawnSync('/bin/sh', [installer, '--uninstall', '--dry-run'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_LAUNCHCTL: path.join(home, 'must-not-run'),
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bootout gui/');
    expect(fs.existsSync(path.join(app, '.agenthub-app'))).toBe(true);
    expect(fs.existsSync(path.join(stale, 'sentinel'))).toBe(true);
  });

  it('does not purge marked Darwin data without an interactive confirmation', () => {
    const home = makeTemp('agenthub-installer-darwin-purge-');
    const bin = path.join(home, 'bin');
    const app = path.join(home, 'app');
    const data = path.join(home, 'data');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, '.agenthub-app'), 'version=0.1.0\n');
    fs.writeFileSync(path.join(data, 'hub.db'), 'data');
    const result = spawnSync('/bin/sh', [installer, '--uninstall', '--purge'], {
      env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, AGENTHUB_DIR: app, AGENTHUB_HOME: data },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(data)).toBe(true);
    expect(result.stdout).toContain('Đã huỷ xoá dữ liệu');
  });

  it('does not delete an ordinary git directory without the installer marker', () => {
    const home = makeTemp('agenthub-installer-unmarked-');
    const app = path.join(home, 'repo');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'sentinel'), 'keep');
    expect(spawnSync('git', ['-C', app, 'init'], { encoding: 'utf8' }).status).toBe(0);

    const result = spawnSync('/bin/sh', [installer, '--uninstall'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: '/bin/false',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(app, 'sentinel'))).toBe(true);
    expect(result.stdout).toContain('Bỏ qua xoá thư mục ứng dụng');
  });

  it('refuses to delete HOME even when it has an installer marker', () => {
    const home = makeTemp('agenthub-installer-home-');
    fs.writeFileSync(path.join(home, '.agenthub-app'), 'version=0.1.0\n');
    expect(spawnSync('git', ['-C', home, 'init'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['-C', home, 'config', 'agenthub.installed', 'true'], { encoding: 'utf8' }).status).toBe(0);

    const result = spawnSync('/bin/sh', [installer, '--uninstall'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        AGENTHUB_DIR: home,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: '/bin/false',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.agenthub-app'))).toBe(true);
    expect(result.stdout).toContain('Bỏ qua xoá thư mục ứng dụng');
  });

  it('does not purge a data directory without AgentHub data markers', () => {
    const home = makeTemp('agenthub-installer-purge-');
    const app = path.join(home, 'app');
    const data = path.join(home, 'data');
    const linkDir = path.join(home, 'links');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(data, 'unrelated'), 'keep');
    fs.writeFileSync(path.join(app, '.agenthub-app'), 'version=0.1.0\n');
    expect(spawnSync('git', ['-C', app, 'init'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['-C', app, 'config', 'agenthub.installed', 'true'], { encoding: 'utf8' }).status).toBe(0);

    const result = spawnSync('/bin/sh', [installer, '--uninstall', '--purge'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: data,
        AGENTHUB_LINK_DIR: linkDir,
        AGENTHUB_SYSTEMCTL: '/bin/false',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(data, 'unrelated'))).toBe(true);
    expect(result.stdout).toContain('Bỏ qua purge');
  });

  it('dry-run never invokes the injected service command or changes paths', () => {
    const home = makeTemp('agenthub-installer-dry-');
    const log = path.join(home, 'systemctl.log');
    const app = path.join(home, 'app');
    const stale = path.join(app, '.0.9.0.tmp.123');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'sentinel'), 'keep');
    fs.writeFileSync(path.join(app, '.agenthub-app'), 'mode=release\n');
    const result = spawnSync('/bin/sh', [installer, '--uninstall', '--dry-run'], {
      env: {
        ...process.env,
        HOME: home,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'must-not-run'),
        AGENTHUB_LAUNCHCTL: path.join(home, 'must-not-run'),
        AGENTHUB_FAKE_LOG: log,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[dry-run]');
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(path.join(app, '.agenthub-app'))).toBe(true);
    expect(fs.existsSync(path.join(stale, 'sentinel'))).toBe(true);
  });

  it('update uses the injected systemctl for the restart step', async () => {
    const home = makeTemp('agenthub-update-');
    const projectRoot = path.join(home, 'repo');
    const log = path.join(home, 'systemctl.log');
    const fakeSystemctl = path.join(home, 'systemctl');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    fs.chmodSync(fakeSystemctl, 0o755);
    const calls: string[] = [];

    const result = await cmdUpdate({}, [], {
      projectRoot,
      exec: (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (args[0] === 'tag') return { stdout: 'v1.0.0\n', status: 0 };
        if (args[0] === 'status') return { stdout: '', status: 0 };
        return { stdout: '', status: 0 };
      },
      restartService: () => {
        const previous = process.env.AGENTHUB_SYSTEMCTL;
        process.env.AGENTHUB_SYSTEMCTL = fakeSystemctl;
        try {
          return linuxPlatform.restartService();
        } finally {
          if (previous === undefined) delete process.env.AGENTHUB_SYSTEMCTL;
          else process.env.AGENTHUB_SYSTEMCTL = previous;
        }
      },
      log: () => undefined,
    });

    expect(result.success).toBe(true);
    expect(calls).toContain('git fetch --tags origin');
    expect(fs.readFileSync(log, 'utf8')).toContain('--user restart agenthub');
  });

  it('skips service installation when systemctl is unavailable', () => {
    const home = makeTemp('agenthub-no-systemd-');
    const previous = process.env.AGENTHUB_SYSTEMCTL;
    process.env.AGENTHUB_SYSTEMCTL = path.join(home, 'missing-systemctl');
    try {
      const result = linuxPlatform.installService({
        nodePath: process.execPath,
        cliPath: path.join(home, 'dist', 'cli.js'),
        currentPath: '/tmp/bin',
        homeDir: home,
        print: false,
      });
      expect(result.skipped).toBe(true);
      expect(result.message).toContain('chạy thủ công: agenthub daemon');
      expect(fs.existsSync(result.file)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.AGENTHUB_SYSTEMCTL;
      else process.env.AGENTHUB_SYSTEMCTL = previous;
    }
  });

  it('refuses worker service writes unless explicitly opted in', () => {
    const home = makeTemp('agenthub-worker-service-');
    const systemctl = path.join(home, 'systemctl');
    fs.writeFileSync(systemctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const previous = {
      worker: process.env.AGENTHUB_WORKER,
      allow: process.env.AGENTHUB_ALLOW_SERVICE_WRITE,
      systemctl: process.env.AGENTHUB_SYSTEMCTL,
    };
    process.env.AGENTHUB_WORKER = '1';
    process.env.AGENTHUB_SYSTEMCTL = systemctl;
    delete process.env.AGENTHUB_ALLOW_SERVICE_WRITE;
    try {
      expect(() => linuxPlatform.installService({
        nodePath: process.execPath,
        cliPath: path.join(home, 'dist', 'cli.js'),
        currentPath: '/tmp/bin',
        homeDir: home,
        print: false,
      })).toThrow('worker không được ghi service file thật');
      expect(fs.existsSync(path.join(home, '.config/systemd/user/agenthub.service'))).toBe(false);

      process.env.AGENTHUB_ALLOW_SERVICE_WRITE = '1';
      const result = linuxPlatform.installService({
        nodePath: process.execPath,
        cliPath: path.join(home, 'dist', 'cli.js'),
        currentPath: '/tmp/bin',
        homeDir: home,
        print: false,
      });
      expect(result.skipped).not.toBe(true);
      expect(fs.existsSync(result.file)).toBe(true);
    } finally {
      if (previous.worker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previous.worker;
      if (previous.allow === undefined) delete process.env.AGENTHUB_ALLOW_SERVICE_WRITE; else process.env.AGENTHUB_ALLOW_SERVICE_WRITE = previous.allow;
      if (previous.systemctl === undefined) delete process.env.AGENTHUB_SYSTEMCTL; else process.env.AGENTHUB_SYSTEMCTL = previous.systemctl;
    }
  });

  it('generates systemd unit with malloc arena and trim threshold tuning', () => {
    const home = makeTemp('agenthub-malloc-unit-');
    const result = linuxPlatform.installService({
      nodePath: process.execPath,
      cliPath: path.join(home, 'dist', 'cli.js'),
      currentPath: '/tmp/bin',
      homeDir: home,
      print: true,
    });
    expect(result.content).toContain('Environment=MALLOC_ARENA_MAX=2');
    expect(result.content).toContain('Environment=MALLOC_TRIM_THRESHOLD_=131072');
  });

  it('preserves custom Environment variables from existing systemd unit file on reinstallation', () => {
    const home = makeTemp('agenthub-custom-env-');
    const serviceDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(serviceDir, { recursive: true });
    const serviceFile = path.join(serviceDir, 'agenthub.service');
    fs.writeFileSync(
      serviceFile,
      `[Unit]\nDescription=AgentHub Daemon\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=/old/node /old/cli.js daemon\nRestart=on-failure\nEnvironment=PATH=/old/path\nEnvironment=AGENTHUB_WEB_DIR=/custom/web/dir\nEnvironment=AGENTHUB_CUSTOM_PORT=8888\n\n[Install]\nWantedBy=default.target\n`,
      'utf8',
    );

    const result = linuxPlatform.installService({
      nodePath: process.execPath,
      cliPath: path.join(home, 'dist', 'cli.js'),
      currentPath: '/new/bin',
      homeDir: home,
      print: true,
    });

    expect(result.content).toContain('Environment=PATH=/new/bin');
    expect(result.content).toContain('Environment=MALLOC_ARENA_MAX=2');
    expect(result.content).toContain('Environment=MALLOC_TRIM_THRESHOLD_=131072');
    expect(result.content).toContain('Environment=AGENTHUB_WEB_DIR=/custom/web/dir');
    expect(result.content).toContain('Environment=AGENTHUB_CUSTOM_PORT=8888');
    // Ensure PATH=/old/path is not preserved
    expect(result.content).not.toContain('Environment=PATH=/old/path');
  });

  it('refuses Vitest writes to the real home service file and keeps uninstall untouched', () => {
    const realHome = os.userInfo().homedir;
    const serviceFile = path.join(realHome, '.config', 'systemd', 'user', 'agenthub.service');
    const existedBefore = fs.existsSync(serviceFile);
    const previous = { worker: process.env.AGENTHUB_WORKER, allow: process.env.AGENTHUB_ALLOW_SERVICE_WRITE };
    delete process.env.AGENTHUB_WORKER;
    delete process.env.AGENTHUB_ALLOW_SERVICE_WRITE;
    try {
      expect(() => linuxPlatform.installService({
        nodePath: process.execPath,
        cliPath: '/tmp/agenthub/dist/cli.js',
        currentPath: '/tmp/bin',
        homeDir: realHome,
        print: false,
      })).toThrow('Vitest bị từ chối ghi service file dưới HOME thật');
      expect(() => linuxPlatform.uninstallService({ homeDir: realHome })).toThrow('Vitest bị từ chối ghi service file dưới HOME thật');
      expect(fs.existsSync(serviceFile)).toBe(existedBefore);
    } finally {
      if (previous.worker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previous.worker;
      if (previous.allow === undefined) delete process.env.AGENTHUB_ALLOW_SERVICE_WRITE; else process.env.AGENTHUB_ALLOW_SERVICE_WRITE = previous.allow;
    }
  });

  it('reports a clear error when the release has no archive for the machine architecture', () => {
    const home = makeTemp('agenthub-installer-arch-');
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(fakeBin);
    const fakeUname = path.join(fakeBin, 'uname');
    fs.writeFileSync(fakeUname, '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo riscv64 ;; esac\n');
    fs.chmodSync(fakeUname, 0o755);

    const result = spawnSync('/bin/sh', [installer, '--from-release', '1.2.3'], {
      env: {
        ...process.env,
        HOME: home,
        // Keep node reachable: on CI it lives outside /usr/bin (setup-node tool cache).
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: path.join(home, 'app'),
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_BASE: path.join(home, 'releases'),
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('không có archive AgentHub cho kiến trúc riscv64');
  });

  it('removes stale release staging directories while retaining two old releases', () => {
    const home = makeTemp('agenthub-installer-cleanup-');
    const app = path.join(home, 'app');
    const releaseBase = path.join(home, 'releases', 'releases', 'download', 'v1.2.3');
    const payload = path.join(home, 'payload');
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(path.join(app, '0.9.0'), { recursive: true });
    fs.mkdirSync(path.join(app, '0.8.0'), { recursive: true });
    fs.mkdirSync(path.join(app, '0.7.0'), { recursive: true });
    fs.mkdirSync(path.join(app, '.0.6.0.tmp.123'), { recursive: true });
    fs.mkdirSync(path.join(payload, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'package.json'), '{}');
    fs.writeFileSync(path.join(payload, 'bin', 'agenthub'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(releaseBase, { recursive: true });
    // Match the runner's platform/arch (CI also runs on linux-arm64 and macos, which has no sha256sum).
    const archiveName = `agenthub-1.2.3-${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
    expect(spawnSync('tar', ['-czf', path.join(releaseBase, archiveName), '-C', payload, '.']).status).toBe(0);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseBase, archiveName))).digest('hex');
    fs.writeFileSync(path.join(releaseBase, 'SHA256SUMS'), `${digest}  ${archiveName}\n`);
    fs.mkdirSync(fakeBin);
    const fakeCurl = path.join(fakeBin, 'curl');
    fs.writeFileSync(fakeCurl, '#!/bin/sh\nurl=""; out=""\nwhile [ "$#" -gt 0 ]; do case "$1" in file://*) url="$1" ;; -o) shift; out="$1" ;; esac; shift; done\ncp "${url#file://}" "$out"\n');
    fs.chmodSync(fakeCurl, 0o755);

    const result = spawnSync('/bin/sh', [installer, '--from-release', '1.2.3'], {
      env: {
        ...process.env,
        HOME: home,
        // Keep node reachable: on CI it lives outside /usr/bin (setup-node tool cache).
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_BASE: path.join(home, 'releases'),
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(app, '.0.6.0.tmp.123'))).toBe(false);
    expect(fs.existsSync(path.join(app, '0.7.0'))).toBe(false);
    expect(fs.existsSync(path.join(app, '0.8.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '0.9.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '1.2.3'))).toBe(true);
  });
});

describe('latest release resolution without explicit version', () => {
  const createReleaseFixture = (dir: string, version: string) => {
    const payload = path.join(dir, 'payload-' + version);
    const releaseBase = path.join(dir, 'releases', 'download', `v${version}`);
    fs.mkdirSync(path.join(payload, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: 'agenthub', version }));
    fs.writeFileSync(path.join(payload, 'bin', 'agenthub'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(releaseBase, { recursive: true });
    const archiveName = `agenthub-${version}-${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
    expect(spawnSync('tar', ['-czf', path.join(releaseBase, archiveName), '-C', payload, '.']).status).toBe(0);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseBase, archiveName))).digest('hex');
    fs.writeFileSync(path.join(releaseBase, 'SHA256SUMS'), `${digest}  ${archiveName}\n`);
  };

  const createCurlShim = (fakeBin: string) => {
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeCurl = path.join(fakeBin, 'curl');
    fs.writeFileSync(
      fakeCurl,
      `#!/bin/sh
url=""
out=""
has_w=0
w_format=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -w) shift; has_w=1; w_format="$1" ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done

case "$url" in
  *api.github.com/*/releases/latest)
    case "$CURL_API_LATEST_STATUS" in
      404)
        if [ "$has_w" = "1" ]; then
          printf '{"message":"Not Found"}\\nHTTP_CODE:404\\n'
        else
          printf '{"message":"Not Found"}\\n'
        fi
        exit 0
        ;;
      fail)
        exit 22
        ;;
      *)
        body="\${CURL_API_LATEST_BODY:-{\\"tag_name\\":\\"v1.2.3\\"}}"
        if [ "$has_w" = "1" ]; then
          printf '%s\\nHTTP_CODE:200\\n' "$body"
        else
          printf '%s\\n' "$body"
        fi
        exit 0
        ;;
    esac
    ;;
  *api.github.com/*/releases\\?per_page=1)
    case "$CURL_API_ALL_STATUS" in
      404)
        if [ "$has_w" = "1" ]; then
          printf '{"message":"Not Found"}\\nHTTP_CODE:404\\n'
        else
          printf '{"message":"Not Found"}\\n'
        fi
        exit 0
        ;;
      empty)
        if [ "$has_w" = "1" ]; then
          printf '[]\\nHTTP_CODE:200\\n'
        else
          printf '[]\\n'
        fi
        exit 0
        ;;
      fail)
        exit 22
        ;;
      *)
        body="\${CURL_API_ALL_BODY:-[{\\"tag_name\\":\\"v1.2.3-beta.1\\",\\"prerelease\\":true}]}"
        if [ "$has_w" = "1" ]; then
          printf '%s\\nHTTP_CODE:200\\n' "$body"
        else
          printf '%s\\n' "$body"
        fi
        exit 0
        ;;
    esac
    ;;
  */releases/latest)
    case "$CURL_REDIRECT_MODE" in
      ok)
        code="\${CURL_REDIRECT_CODE:-200}"
        target="\${CURL_REDIRECT_URL:-$url}"
        if [ "$has_w" = "1" ]; then
          case "$w_format" in
            *HTTP_CODE*|*%{http_code}*)
              printf 'HTTP_CODE:%s\nURL:%s\n' "$code" "$target"
              ;;
            *)
              printf '%s' "$target"
              ;;
          esac
        else
          printf '%s' "$target"
        fi
        exit 0
        ;;
      fail)
        code="\${CURL_REDIRECT_CODE:-404}"
        target="\${CURL_REDIRECT_URL:-$url}"
        if [ "$has_w" = "1" ]; then
          case "$w_format" in
            *HTTP_CODE*|*%{http_code}*)
              printf 'HTTP_CODE:%s\nURL:%s\n' "$code" "$target"
              ;;
          esac
        fi
        exit 22
        ;;
      network_error)
        exit 22
        ;;
      *)
        exit 22
        ;;
    esac
    ;;
  */releases/download/*)
    rel_path="\${url#*releases/download/}"
    if [ -n "$CURL_FIXTURE_DIR" ] && [ -f "$CURL_FIXTURE_DIR/releases/download/$rel_path" ]; then
      cp "$CURL_FIXTURE_DIR/releases/download/$rel_path" "$out"
      exit 0
    else
      echo "404 not found: $url" >&2
      exit 22
    fi
    ;;
esac

exit 1
`,
      { mode: 0o755 },
    );
  };

  it('resolves latest version when github redirect targets /releases/tag/v1.2.3', () => {
    const home = makeTemp('agenthub-latest-redirect-');
    const app = path.join(home, 'app');
    const fakeBin = path.join(home, 'bin');
    const installLog = path.join(home, 'install.log');
    createReleaseFixture(home, '1.2.3');
    createCurlShim(fakeBin);

    const result = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'ok',
        CURL_REDIRECT_URL: 'https://github.com/ducanh19020217/agenthub/releases/tag/v1.2.3',
        CURL_FIXTURE_DIR: home,
        INSTALL_LOG: installLog,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.2.3');
    expect(fs.existsSync(path.join(app, '1.2.3'))).toBe(true);
    expect(fs.readFileSync(installLog, 'utf8')).toContain(
      'release resolve: URL https://github.com/ducanh19020217/agenthub/releases/latest redirected to https://github.com/ducanh19020217/agenthub/releases/tag/v1.2.3 (HTTP 200, version 1.2.3)',
    );
  });

  it('falls back to GitHub API when redirect fails and uses tag_name', () => {
    const home = makeTemp('agenthub-latest-api-');
    const app = path.join(home, 'app');
    const fakeBin = path.join(home, 'bin');
    const installLog = path.join(home, 'install.log');
    createReleaseFixture(home, '1.2.3');
    createCurlShim(fakeBin);

    const result = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'fail',
        CURL_REDIRECT_CODE: '404',
        CURL_API_LATEST_STATUS: '200',
        CURL_API_LATEST_BODY: JSON.stringify({ tag_name: 'v1.2.3' }),
        CURL_FIXTURE_DIR: home,
        INSTALL_LOG: installLog,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.2.3');
    expect(fs.existsSync(path.join(app, '1.2.3'))).toBe(true);
    expect(fs.readFileSync(installLog, 'utf8')).toContain(
      'release resolve: URL https://github.com/ducanh19020217/agenthub/releases/latest redirect failed (HTTP 404, effective URL: https://github.com/ducanh19020217/agenthub/releases/latest)',
    );
  });

  it('falls back to pre-release with warning when API latest returns 404', () => {
    const home = makeTemp('agenthub-latest-prerelease-');
    const app = path.join(home, 'app');
    const fakeBin = path.join(home, 'bin');
    createReleaseFixture(home, '1.2.3-beta.1');
    createCurlShim(fakeBin);

    const result = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'fail',
        CURL_API_LATEST_STATUS: '404',
        CURL_API_ALL_STATUS: '200',
        CURL_API_ALL_BODY: JSON.stringify([{ tag_name: 'v1.2.3-beta.1', prerelease: true }]),
        CURL_FIXTURE_DIR: home,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('pre-release');
    expect(result.stderr).toContain('1.2.3-beta.1');
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.2.3-beta.1');
    expect(fs.existsSync(path.join(app, '1.2.3-beta.1'))).toBe(true);
  });

  it('fails with clear error and leaves machine untouched when nothing is retrieved', () => {
    const home = makeTemp('agenthub-latest-empty-');
    const app = path.join(home, 'app');
    const fakeBin = path.join(home, 'bin');
    createCurlShim(fakeBin);

    const result = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'fail',
        CURL_API_LATEST_STATUS: '404',
        CURL_API_ALL_STATUS: 'empty',
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Lỗi: không xác định được phiên bản release mới nhất.');
    expect(result.stderr).toContain('--from-release <version>');
    expect(result.stderr).toContain('https://github.com/ducanh19020217/agenthub/releases/latest');
    expect(result.stderr).toContain('https://api.github.com/repos/ducanh19020217/agenthub/releases/latest');
    expect(result.stderr).toContain('https://api.github.com/repos/ducanh19020217/agenthub/releases?per_page=1');
    expect(fs.existsSync(app)).toBe(false);
  });

  it('rejects invalid tag format from release resolution and suggests --from-release', () => {
    const home = makeTemp('agenthub-latest-invalid-semver-');
    const app = path.join(home, 'app');
    const fakeBin = path.join(home, 'bin');
    createCurlShim(fakeBin);

    const result = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'ok',
        CURL_REDIRECT_URL: 'https://github.com/ducanh19020217/agenthub/releases/tag/invalid-version',
        CURL_API_LATEST_STATUS: '200',
        CURL_API_LATEST_BODY: JSON.stringify({ tag_name: 'invalid-version' }),
        CURL_API_ALL_STATUS: '200',
        CURL_API_ALL_BODY: JSON.stringify([{ tag_name: 'invalid-version' }]),
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Lỗi: không xác định được phiên bản release mới nhất.');
    expect(result.stderr).toContain('--from-release <version>');
    expect(fs.existsSync(app)).toBe(false);
  });

  it('logs actual HTTP code and effective URL on redirect success', () => {
    const home = makeTemp('agenthub-latest-redirect-log-');
    const app = path.join(home, 'app');
    const fakeBin = path.join(home, 'bin');
    const installLog = path.join(home, 'install.log');
    createReleaseFixture(home, '1.2.3');
    createCurlShim(fakeBin);

    const result = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'ok',
        CURL_REDIRECT_CODE: '200',
        CURL_REDIRECT_URL: 'https://github.com/ducanh19020217/agenthub/releases/tag/v1.2.3',
        CURL_FIXTURE_DIR: home,
        INSTALL_LOG: installLog,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const logContent = fs.readFileSync(installLog, 'utf8');
    expect(logContent).toContain(
      'release resolve: URL https://github.com/ducanh19020217/agenthub/releases/latest redirected to https://github.com/ducanh19020217/agenthub/releases/tag/v1.2.3 (HTTP 200, version 1.2.3)',
    );
  });

  it('logs actual HTTP code and effective URL on redirect failure', () => {
    const home = makeTemp('agenthub-latest-redirect-fail-log-');
    const app = path.join(home, 'app');
    const fakeBin = path.join(home, 'bin');
    const installLog = path.join(home, 'install.log');
    createCurlShim(fakeBin);

    // Case 1: HTTP 404 on redirect request
    const result404 = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'fail',
        CURL_REDIRECT_CODE: '404',
        CURL_API_LATEST_STATUS: '404',
        CURL_API_ALL_STATUS: 'empty',
        INSTALL_LOG: installLog,
      },
      encoding: 'utf8',
    });

    expect(result404.status).not.toBe(0);
    let logContent = fs.readFileSync(installLog, 'utf8');
    expect(logContent).toContain(
      'release resolve: URL https://github.com/ducanh19020217/agenthub/releases/latest redirect failed (HTTP 404, effective URL: https://github.com/ducanh19020217/agenthub/releases/latest)',
    );

    // Case 2: Complete network/curl failure without response
    const installLogNet = path.join(home, 'install-net.log');
    const resultNet = spawnSync('/bin/sh', [installer, '--from-release'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_REPO: 'ducanh19020217/agenthub',
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
        CURL_REDIRECT_MODE: 'network_error',
        CURL_API_LATEST_STATUS: '404',
        CURL_API_ALL_STATUS: 'empty',
        INSTALL_LOG: installLogNet,
      },
      encoding: 'utf8',
    });

    expect(resultNet.status).not.toBe(0);
    logContent = fs.readFileSync(installLogNet, 'utf8');
    expect(logContent).toContain(
      'release resolve: URL https://github.com/ducanh19020217/agenthub/releases/latest redirect failed (HTTP unknown, effective URL: none)',
    );
  });
});

