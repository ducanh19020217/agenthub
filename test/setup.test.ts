import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { UpdateConfigSchema } from '../src/services/index.js';
import { SetupManager } from '../src/tools/setup.js';

describe('first-run setup', () => {
  it('does not accept installer commands or unsafe npm package names through config API', () => {
    expect(() => UpdateConfigSchema.parse({ tools: { installers: { claude: { command: ['sh', '-c', 'touch /tmp/pwned'] } } } })).not.toThrow();
    const parsed = UpdateConfigSchema.parse({ tools: { installers: { claude: { package: '@scope/tool@latest', versionArgs: ['--version'] } } } });
    expect(parsed.tools?.installers.claude).toEqual({ package: '@scope/tool@latest', versionArgs: ['--version'] });
    expect(() => UpdateConfigSchema.parse({ tools: { installers: { claude: { package: 'file:./evil' } } } })).toThrow();
    expect(() => UpdateConfigSchema.parse({ tools: { installers: { claude: { package: 'evil package' } } } })).toThrow();
  });

  it('installs from the managed prefix and detects the resulting binary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-test-'));
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nwhile [ "$1" != "--prefix" ]; do shift; done\nprefix="$2"\nmkdir -p "$prefix/node_modules/.bin"\nprintf "#!/bin/sh\\necho fake-claude 1.0\\n" > "$prefix/node_modules/.bin/claude"\nchmod +x "$prefix/node_modules/.bin/claude"\n', { mode: 0o755 });
    const nodeBinDir = path.dirname(process.execPath);
    const previous = {
      tools: process.env.AGENTHUB_TOOLS_DIR,
      path: process.env.PATH,
      worker: process.env.AGENTHUB_WORKER,
      claudeBin: process.env.AGENTHUB_CLAUDE_BIN,
    };
    delete process.env.AGENTHUB_TOOLS_DIR;
    delete process.env.AGENTHUB_WORKER;
    delete process.env.AGENTHUB_CLAUDE_BIN;
    process.env.PATH = [fakeBin, nodeBinDir, '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter);
    try {
      const config = loadConfig(home);
      config.tools.installers.claude = { package: 'fake-claude', versionArgs: ['--version'] };
      const events: Array<{ type: string; payload: unknown }> = [];
      const manager = new SetupManager(config, { emit: (type, _taskId, payload) => { events.push({ type, payload }); return true; } });
      await manager.install('claude');
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (events.some((event) => event.type === 'setup.install_done')) return resolve();
          if (Date.now() > deadline) return reject(new Error('setup install timed out'));
          setTimeout(poll, 10);
        };
        poll();
      });
      expect((await manager.status()).find((tool) => tool.id === 'claude')?.installed).toBe(true);
      expect(events.map((event) => event.type)).toContain('setup.install_progress');
      expect(events.map((event) => event.type)).toContain('setup.install_done');
    } finally {
      if (previous.tools === undefined) delete process.env.AGENTHUB_TOOLS_DIR; else process.env.AGENTHUB_TOOLS_DIR = previous.tools;
      if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
      if (previous.worker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previous.worker;
      if (previous.claudeBin === undefined) delete process.env.AGENTHUB_CLAUDE_BIN; else process.env.AGENTHUB_CLAUDE_BIN = previous.claudeBin;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports install_done instead of crashing when the installer cannot be spawned', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-enoent-'));
    const previousWorker = process.env.AGENTHUB_WORKER;
    delete process.env.AGENTHUB_WORKER;
    try {
      const config = loadConfig(home);
      config.tools.installers.codex = { command: [path.join(home, 'missing-installer')], versionArgs: ['--version'] };
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const manager = new SetupManager(config, { emit: (type, _taskId, payload) => { events.push({ type, payload: payload as Record<string, unknown> }); return true; } });
      await manager.install('codex');
      await vi.waitFor(() => expect(events.some((event) => event.type === 'setup.install_done')).toBe(true), { timeout: 5000, interval: 10 });
      const done = events.find((event) => event.type === 'setup.install_done')!;
      expect(done.payload.ok).toBe(false);
      expect(String(done.payload.error)).toContain('ENOENT');
      expect((await manager.status()).find((tool) => tool.id === 'codex')?.installing).toBe(false);
    } finally {
      if (previousWorker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previousWorker;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs the profile refresh callback only after a successful install', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-refresh-'));
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(fakeBin);
    const configured = path.join(home, 'codex');
    const installer = path.join(fakeBin, 'installer');
    fs.writeFileSync(
      installer,
      '#!/bin/sh\n' +
      'if [ "$FAKE_INSTALL_EXIT" = "0" ]; then\n' +
      '  printf "#!/bin/sh\\nexit 0\\n" > "$CODEX_TARGET"\n' +
      '  chmod +x "$CODEX_TARGET"\n' +
      'fi\n' +
      'exit "$FAKE_INSTALL_EXIT"\n',
      { mode: 0o755 },
    );
    const nodeBinDir = path.dirname(process.execPath);
    const previous = {
      exit: process.env.FAKE_INSTALL_EXIT,
      worker: process.env.AGENTHUB_WORKER,
      codexBin: process.env.AGENTHUB_CODEX_BIN,
      codexTarget: process.env.CODEX_TARGET,
      tools: process.env.AGENTHUB_TOOLS_DIR,
      path: process.env.PATH,
    };
    const refreshed: string[] = [];
    try {
      delete process.env.AGENTHUB_WORKER;
      delete process.env.AGENTHUB_TOOLS_DIR;
      process.env.AGENTHUB_CODEX_BIN = configured;
      process.env.CODEX_TARGET = configured;
      process.env.PATH = [fakeBin, nodeBinDir, '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter);

      const config = loadConfig(home);
      config.tools.installers.codex = { command: [installer], versionArgs: ['--version'] };
      const manager = new SetupManager(config, undefined, (tool) => refreshed.push(tool));

      process.env.FAKE_INSTALL_EXIT = '0';
      await manager.install('codex');
      await vi.waitFor(() => expect(refreshed).toEqual(['codex']), { timeout: 10_000, interval: 25 });

      process.env.FAKE_INSTALL_EXIT = '1';
      fs.rmSync(configured, { force: true });
      await manager.install('codex');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(refreshed).toEqual(['codex']);
    } finally {
      if (previous.exit === undefined) delete process.env.FAKE_INSTALL_EXIT; else process.env.FAKE_INSTALL_EXIT = previous.exit;
      if (previous.worker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previous.worker;
      if (previous.codexBin === undefined) delete process.env.AGENTHUB_CODEX_BIN; else process.env.AGENTHUB_CODEX_BIN = previous.codexBin;
      if (previous.codexTarget === undefined) delete process.env.CODEX_TARGET; else process.env.CODEX_TARGET = previous.codexTarget;
      if (previous.tools === undefined) delete process.env.AGENTHUB_TOOLS_DIR; else process.env.AGENTHUB_TOOLS_DIR = previous.tools;
      if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('installs agy with a shim, reports a missing result, and rejects a missing configured binary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-agy-'));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    const installer = path.join(bin, 'agy-installer');
    const noopInstaller = path.join(bin, 'agy-noop-installer');
    const configured = path.join(home, 'agy');
    fs.writeFileSync(installer, `#!/bin/sh\n${process.env.SHELL || '/bin/sh'} -c 'printf "#!/bin/sh\\nexit 0\\n" > "$AGY_TARGET"; chmod +x "$AGY_TARGET"'\n`, { mode: 0o755 });
    fs.writeFileSync(noopInstaller, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const nodeBinDir = path.dirname(process.execPath);
    const old = {
      target: process.env.AGY_TARGET,
      configured: process.env.AGENTHUB_AGY_BIN,
      worker: process.env.AGENTHUB_WORKER,
      tools: process.env.AGENTHUB_TOOLS_DIR,
      path: process.env.PATH,
    };
    interface InstallDonePayload {
      ok: boolean;
      code?: number | null;
      signal?: NodeJS.Signals | null;
      path?: string | null;
      logPath?: string;
      error?: string;
    }
    const waitDone = (events: Array<{ type: string; payload: unknown }>) => new Promise<InstallDonePayload>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        const done = events.find((event) => event.type === 'setup.install_done');
        if (done) return resolve(done.payload as InstallDonePayload);
        if (Date.now() > deadline) return reject(new Error('agy install timed out'));
        setTimeout(poll, 10);
      };
      poll();
    });
    try {
      delete process.env.AGENTHUB_WORKER;
      delete process.env.AGENTHUB_TOOLS_DIR;
      process.env.AGENTHUB_AGY_BIN = configured;
      process.env.AGY_TARGET = configured;
      process.env.PATH = [bin, nodeBinDir, '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter);
      const config = loadConfig(home);
      config.tools.installers.agy = { command: [installer], versionArgs: ['--version'] };
      let events: Array<{ type: string; payload: unknown }> = [];
      let manager = new SetupManager(config, { emit: (type, _task, payload) => { events.push({ type, payload }); return true; } });
      await manager.install('agy');
      expect((await waitDone(events)).ok).toBe(true);

      fs.rmSync(configured);
      process.env.AGENTHUB_AGY_BIN = path.join(home, 'missing-agy');
      events = [];
      config.tools.installers.agy = { command: [noopInstaller], versionArgs: ['--version'] };
      manager = new SetupManager(config, { emit: (type, _task, payload) => { events.push({ type, payload }); return true; } });
      await manager.install('agy');
      const missing = await waitDone(events);
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/chưa tìm thấy/);
    } finally {
      if (old.target === undefined) delete process.env.AGY_TARGET; else process.env.AGY_TARGET = old.target;
      if (old.configured === undefined) delete process.env.AGENTHUB_AGY_BIN; else process.env.AGENTHUB_AGY_BIN = old.configured;
      if (old.worker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = old.worker;
      if (old.tools === undefined) delete process.env.AGENTHUB_TOOLS_DIR; else process.env.AGENTHUB_TOOLS_DIR = old.tools;
      if (old.path === undefined) delete process.env.PATH; else process.env.PATH = old.path;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects unknown tools and worker-mode installs', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-guard-'));
    const config = loadConfig(home);
    const manager = new SetupManager(config);
    await expect(manager.install('shell')).rejects.toThrow('không nằm trong danh mục');
    process.env.AGENTHUB_WORKER = '1';
    try { await expect(manager.install('claude')).rejects.toThrow('worker'); }
    finally { delete process.env.AGENTHUB_WORKER; fs.rmSync(home, { recursive: true, force: true }); }
  });
});
