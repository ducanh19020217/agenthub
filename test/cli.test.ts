import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  cmdInstallService,
  cmdMcpInstall,
  cmdOpen,
  cmdLink,
  findProjectRoot,
  cmdStop,
  cmdStart,
  cmdStatus,
  cleanRemainingProcesses,
} from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { getOrCreateToken } from '../src/auth.js';

describe('AgentHub CLI and Installation', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-home-'));
    process.env.AGENTHUB_HOME = path.join(tmpHome, '.agenthub');
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpHome, '.agy-homes');
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    process.env.AGENTHUB_LAUNCHCTL = path.join(tmpHome, 'missing-launchctl');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_LAUNCHCTL;
  });

  it('findProjectRoot finds the root package directory', () => {
    const root = findProjectRoot();
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('agenthub');
  });

  it('cmdOpen prints the web dashboard URL with secret token', async () => {
    const config = loadConfig();
    getOrCreateToken(config.tokenPath);

    const url = await cmdOpen(config, ['--no-browser']);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/);
  });

  it('cmdOpen invokes the platform browser command when browser is enabled', async () => {
    const config = loadConfig();
    getOrCreateToken(config.tokenPath);

    let calledCmd = '';
    let calledArgs: string[] = [];
    const mockOpen = (cmd: string, args: string[]) => {
      calledCmd = cmd;
      calledArgs = args;
    };

    const url = await cmdOpen(config, [], mockOpen);
    expect(calledCmd).toBe(process.platform === 'darwin' ? 'open' : 'xdg-open');
    expect(calledArgs).toEqual([url]);

    const cliSource = fs.readFileSync(path.resolve(findProjectRoot(), 'src', 'cli.ts'), 'utf-8');
    expect(cliSource).not.toMatch(/exec\s*\(\s*`(?:xdg-open|open)/);
  });

  it('cmdInstallService --print outputs the platform service content without writing files', async () => {
    const output = await cmdInstallService(['--print']);
    const root = findProjectRoot();
    const expectedCliPath = path.resolve(root, 'dist', 'cli.js');

    if (process.platform === 'darwin') {
      expect(output).toContain('<plist');
      expect(output).toContain('dev.agenthub');
      expect(output).toContain('LaunchAgents');
      return;
    }
    expect(output).toContain('[Unit]');
    expect(output).toContain('Description=AgentHub Daemon');
    expect(output).toContain(`ExecStart=${process.execPath} ${expectedCliPath} daemon`);
    expect(output).toContain('Restart=on-failure');
    expect(output).toContain('Environment=PATH=');
    expect(output).toContain('systemctl --user daemon-reload');
    expect(output).toContain('systemctl --user enable --now agenthub');
  });

  it('cmdMcpInstall --print outputs claude mcp add command', async () => {
    const command = await cmdMcpInstall(['--print']);
    const root = findProjectRoot();
    const expectedCliPath = path.resolve(root, 'dist', 'cli.js');

    // Lệnh dùng đường dẫn tuyệt đối của claude khi tìm thấy (Claude có thể nằm trong Node khác).
    expect(command).toMatch(/(^|\/)claude mcp add /);
    expect(command.endsWith(`mcp add --scope user agenthub -- ${process.execPath} ${expectedCliPath} mcp`)).toBe(true);
  });

  it('bin/agenthub wrapper script exists and is executable', () => {
    const root = findProjectRoot();
    const wrapper = path.join(root, 'bin', 'agenthub');
    expect(fs.existsSync(wrapper)).toBe(true);

    const stat = fs.statSync(wrapper);
    // Check executable bit
    expect((stat.mode & 0o111) !== 0).toBe(true);

    const content = fs.readFileSync(wrapper, 'utf-8');
    expect(content).toContain('nvm use 22');
    expect(content).toContain('CLI_PATH="$ROOT_DIR/dist/cli.js"');
  });

  it('cmdLink creates symlink to wrapper script', async () => {
    // Override homedir temporarily via spy or env
    const originalHomedir = os.homedir;
    try {
      os.homedir = () => tmpHome;
      const targetPath = await cmdLink();

      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);

      const target = fs.readlinkSync(targetPath);
      const root = findProjectRoot();
      expect(target).toBe(path.resolve(root, 'bin', 'agenthub'));
    } finally {
      os.homedir = originalHomedir;
    }
  });

  it('cmdBrain updates brain status directly in DB when daemon is offline', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-brain-'));
    try {
      const config = loadConfig(tmp);
      config.port = 65534;
      const { cmdBrain, BrainRepo } = await import('../src/brain.js');
      const { openDatabase } = await import('../src/db/index.js');

      const result = await cmdBrain(config, [
        'planning',
        'Lập kế hoạch task 2',
        '--task',
        'proj/t-2',
      ]);

      expect(result.activity).toBe('planning');
      expect(result.detail).toBe('Lập kế hoạch task 2');
      expect(result.taskId).toBe('proj/t-2');

      const db = openDatabase(config.dbPath);
      const repo = new BrainRepo(db);
      const row = repo.get();
      db.close();

      expect(row).toBeDefined();
      expect(row?.activity).toBe('planning');
      expect(row?.detail).toBe('Lập kế hoạch task 2');
      expect(row?.taskId).toBe('proj/t-2');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cmdBrain validates arguments and activity enum', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-brain-val-'));
    try {
      const config = loadConfig(tmp);
      const { cmdBrain } = await import('../src/brain.js');

      await expect(cmdBrain(config, [])).rejects.toThrow('Thiếu tham số');
      await expect(cmdBrain(config, ['invalid_act', 'detail'])).rejects.toThrow();
      await expect(cmdBrain(config, ['idle', 'a'.repeat(301)])).rejects.toThrow('300');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'darwin')('cmdStop calls /api/hub/shutdown and stops service via mock systemctl', async () => {
    // Skipped on Darwin: tests Linux systemctl stop semantics; macOS uses launchctl.
    const config = loadConfig(process.env.AGENTHUB_HOME);
    getOrCreateToken(config.tokenPath);

    let shutdownBody: Record<string, unknown> | null = null;
    const testServer = http.createServer((req, res) => {
      if (req.url === '/api/hub/shutdown' && req.method === 'POST') {
        let bodyStr = '';
        req.on('data', (c) => { bodyStr += c; });
        req.on('end', () => {
          shutdownBody = JSON.parse(bodyStr || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, queued: 1, reviewers: 0, daemonPid: 999999, childPids: [] }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const addr = testServer.address() as { port: number };
    config.port = addr.port;

    const fakeLog = path.join(tmpHome, 'systemctl.log');
    const fakeSystemctl = path.join(tmpHome, 'mock-systemctl');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf "%s\\n" "$*" >> "${fakeLog}"\nexit 0\n`, { mode: 0o755 });

    const prevBin = process.env.AGENTHUB_SYSTEMCTL_BIN;
    const prevTimeout = process.env.AGENTHUB_STOP_TIMEOUT_MS;
    process.env.AGENTHUB_SYSTEMCTL_BIN = fakeSystemctl;
    process.env.AGENTHUB_STOP_TIMEOUT_MS = '500';

    try {
      await cmdStop(config, []);

      expect(shutdownBody).toEqual({ disable: false });
      const logContent = fs.readFileSync(fakeLog, 'utf8');
      expect(logContent).toContain('--user stop agenthub');
      expect(logContent).not.toContain('disable');
    } finally {
      if (prevBin !== undefined) process.env.AGENTHUB_SYSTEMCTL_BIN = prevBin;
      else delete process.env.AGENTHUB_SYSTEMCTL_BIN;
      if (prevTimeout !== undefined) process.env.AGENTHUB_STOP_TIMEOUT_MS = prevTimeout;
      else delete process.env.AGENTHUB_STOP_TIMEOUT_MS;
      testServer.close();
    }
  });

  it.skipIf(process.platform === 'darwin')('cmdStop with --disable stops and disables service via mock systemctl', async () => {
    // Skipped on Darwin: tests Linux systemctl disable semantics; macOS uses launchctl.
    const config = loadConfig(process.env.AGENTHUB_HOME);
    getOrCreateToken(config.tokenPath);

    let shutdownBody: Record<string, unknown> | null = null;
    const testServer = http.createServer((req, res) => {
      if (req.url === '/api/hub/shutdown' && req.method === 'POST') {
        let bodyStr = '';
        req.on('data', (c) => { bodyStr += c; });
        req.on('end', () => {
          shutdownBody = JSON.parse(bodyStr || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, queued: 1, reviewers: 0, daemonPid: 999999, childPids: [] }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const addr = testServer.address() as { port: number };
    config.port = addr.port;

    const fakeLog = path.join(tmpHome, 'systemctl-disable.log');
    const fakeSystemctl = path.join(tmpHome, 'mock-systemctl-disable');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf "%s\\n" "$*" >> "${fakeLog}"\nexit 0\n`, { mode: 0o755 });

    const prevBin = process.env.AGENTHUB_SYSTEMCTL_BIN;
    const prevTimeout = process.env.AGENTHUB_STOP_TIMEOUT_MS;
    process.env.AGENTHUB_SYSTEMCTL_BIN = fakeSystemctl;
    process.env.AGENTHUB_STOP_TIMEOUT_MS = '500';

    try {
      await cmdStop(config, ['--disable']);

      expect(shutdownBody).toEqual({ disable: true });
      const logContent = fs.readFileSync(fakeLog, 'utf8');
      expect(logContent).toContain('--user stop agenthub');
      expect(logContent).toContain('--user disable agenthub');
    } finally {
      if (prevBin !== undefined) process.env.AGENTHUB_SYSTEMCTL_BIN = prevBin;
      else delete process.env.AGENTHUB_SYSTEMCTL_BIN;
      if (prevTimeout !== undefined) process.env.AGENTHUB_STOP_TIMEOUT_MS = prevTimeout;
      else delete process.env.AGENTHUB_STOP_TIMEOUT_MS;
      testServer.close();
    }
  });

  it.skipIf(process.platform === 'darwin')('cmdStop refuses to stop an active service when API shutdown fails', async () => {
    // Skipped on Darwin: tests Linux systemctl is-active check; macOS uses launchctl print.
    const config = loadConfig(process.env.AGENTHUB_HOME);
    getOrCreateToken(config.tokenPath);
    const testServer = http.createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable' }));
    });
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    config.port = (testServer.address() as { port: number }).port;

    const fakeLog = path.join(tmpHome, 'systemctl-failed-shutdown.log');
    const fakeSystemctl = path.join(tmpHome, 'mock-systemctl-failed-shutdown');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh
printf "%s\\n" "$*" >> "${fakeLog}"
if [ "$2" = "is-active" ]; then printf 'active\\n'; exit 0; fi
exit 0
`, { mode: 0o755 });
    const prevBin = process.env.AGENTHUB_SYSTEMCTL_BIN;
    process.env.AGENTHUB_SYSTEMCTL_BIN = fakeSystemctl;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(cmdStop(config, [])).rejects.toThrow('Không thể tắt an toàn');
      const logContent = fs.readFileSync(fakeLog, 'utf8');
      expect(logContent).toContain('--user is-active agenthub');
      expect(logContent).not.toContain('--user stop agenthub');
    } finally {
      errorSpy.mockRestore();
      if (prevBin !== undefined) process.env.AGENTHUB_SYSTEMCTL_BIN = prevBin;
      else delete process.env.AGENTHUB_SYSTEMCTL_BIN;
      testServer.close();
    }
  });

  it('cleanRemainingProcesses terminates lingering child processes', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    expect(child.pid).toBeDefined();
    const pid = child.pid!;

    expect(() => process.kill(pid, 0)).not.toThrow();

    await cleanRemainingProcesses(undefined, [pid], undefined, 1500, 100);

    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.skipIf(process.platform === 'darwin')('cmdStart invokes mock systemctl enable --now and waits for /health', async () => {
    // Skipped on Darwin: tests Linux systemctl enable --now semantics; macOS uses launchctl bootstrap.
    const config = loadConfig(process.env.AGENTHUB_HOME);

    const testServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: '1.0.0' }));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const addr = testServer.address() as { port: number };
    config.port = addr.port;

    const fakeLog = path.join(tmpHome, 'systemctl-start.log');
    const fakeSystemctl = path.join(tmpHome, 'mock-systemctl-start');
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf "%s\\n" "$*" >> "${fakeLog}"\nexit 0\n`, { mode: 0o755 });

    const prevBin = process.env.AGENTHUB_SYSTEMCTL_BIN;
    process.env.AGENTHUB_SYSTEMCTL_BIN = fakeSystemctl;

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await cmdStart(config);

      const logContent = fs.readFileSync(fakeLog, 'utf8');
      expect(logContent).toContain('--user enable --now agenthub');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`✓ AgentHub đang chạy: http://127.0.0.1:${config.port}`));
    } finally {
      if (prevBin !== undefined) process.env.AGENTHUB_SYSTEMCTL_BIN = prevBin;
      else delete process.env.AGENTHUB_SYSTEMCTL_BIN;
      testServer.close();
      consoleSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'darwin')('cmdStatus displays service status, enable status, and worker count', async () => {
    // Skipped on Darwin: tests Linux systemctl is-active and is-enabled; macOS checks LaunchAgents plist.
    const config = loadConfig(process.env.AGENTHUB_HOME);

    const fakeSystemctl = path.join(tmpHome, 'mock-systemctl-status');
    fs.writeFileSync(
      fakeSystemctl,
      `#!/bin/sh
if [ "$2" = "is-active" ]; then
  echo "active"
  exit 0
elif [ "$2" = "is-enabled" ]; then
  echo "enabled"
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    const prevBin = process.env.AGENTHUB_SYSTEMCTL_BIN;
    process.env.AGENTHUB_SYSTEMCTL_BIN = fakeSystemctl;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await cmdStatus(config);

      expect(consoleSpy).toHaveBeenCalledWith('Service: đang chạy');
      expect(consoleSpy).toHaveBeenCalledWith('Tự bật khi đăng nhập: có');
      expect(consoleSpy).toHaveBeenCalledWith('Worker đang chạy: 0');
    } finally {
      if (prevBin !== undefined) process.env.AGENTHUB_SYSTEMCTL_BIN = prevBin;
      else delete process.env.AGENTHUB_SYSTEMCTL_BIN;
      consoleSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'darwin')('cmdStatus reports clear message when service is not installed', async () => {
    // Skipped on Darwin: tests Linux systemctl unit not-found behavior; macOS checks plist existence.
    const config = loadConfig(process.env.AGENTHUB_HOME);

    const fakeSystemctl = path.join(tmpHome, 'mock-systemctl-not-installed');
    fs.writeFileSync(
      fakeSystemctl,
      `#!/bin/sh
echo "Unit agenthub.service could not be found." >&2
exit 4
`,
      { mode: 0o755 },
    );

    const prevBin = process.env.AGENTHUB_SYSTEMCTL_BIN;
    process.env.AGENTHUB_SYSTEMCTL_BIN = fakeSystemctl;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await cmdStatus(config);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Service: chưa cài đặt (chạy \'agenthub install-service\' để cài đặt)'),
      );
    } finally {
      if (prevBin !== undefined) process.env.AGENTHUB_SYSTEMCTL_BIN = prevBin;
      else delete process.env.AGENTHUB_SYSTEMCTL_BIN;
      consoleSpy.mockRestore();
    }
  });
});
