import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileRow } from '../db/index.js';
import { LIMITED_TEST_ENV, lowPriority } from '../priority.js';
import { workerEnvironment } from '../worker-guard.js';
import { lockCommand } from '../profiles/locks.js';
import { applyIsolatedAgyEnv, findAgyBin } from '../agy.js';

export interface SpawnOpts {
  profile: ProfileRow;
  model: string;
  cwd: string;
  prompt: string;
  logPath: string;
  effort?: string;
  lockFile?: string;
  outputPath?: string;
  readOnly?: boolean;
  env?: Record<string, string>;
  hubHome?: string;
  gitHooks?: 'run' | 'skip';
  project?: { settings?: string | null };
  codexSandbox?: 'off' | 'workspace-write';
  /** Approval policy for interactive brain runs. Full bypasses approvals; safe modes do not. */
  codexApproval?: 'never' | 'on-request' | 'untrusted';
  workerCount?: number;
  streamOutput?: boolean;
  mcpConfigPath?: string;
  brainPolicy?: 'standard' | 'trusted';
}

export interface QuotaDetection {
  exhausted: boolean;
  resetSeconds?: number;
}

export interface AuthDetection {
  expired: boolean;
}

export interface Engine {
  id: 'agy' | 'codex' | 'claude';
  family(model: string): string;
  spawn(opts: SpawnOpts): ChildProcess;
  detectQuota(logTail: string): QuotaDetection;
  detectAuthError(logTail: string): AuthDetection;
  detectTransientError(logTail: string): boolean;
}

/**
 * Parse reset time strings like "Resets in 4h54m26s" or "try again in 2h 3m"
 * Returns seconds, or default 18000 (5h) if unparsable.
 * Adds 60s buffer per PLAN 3.3.
 */
export function parseResetTime(text: string): number {
  // Try pattern: NhNmNs or N h N m N s (with optional spaces)
  const patterns = [
    /(\d+)\s*h\s*(\d+)\s*m\s*(\d+)\s*s/i,
    /(\d+)\s*h\s*(\d+)\s*m/i,
    /(\d+)\s*m\s*(\d+)\s*s/i,
    /(\d+)\s*h/i,
    /(\d+)\s*m/i,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      let seconds = 0;
      const full = m[0];
      const hm = full.match(/(\d+)\s*h/i);
      const mm = full.match(/(\d+)\s*m/i);
      const sm = full.match(/(\d+)\s*s/i);
      if (hm) seconds += parseInt(hm[1], 10) * 3600;
      if (mm) seconds += parseInt(mm[1], 10) * 60;
      if (sm) seconds += parseInt(sm[1], 10);
      if (seconds > 0) return seconds + 60; // add 60s buffer
    }
  }

  return 18000; // default 5 hours
}

/**
 * Get the last N lines from a string
 */
export function lastNLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}


// Transient error regex per PLAN 2.1
const TRANSIENT_ERROR_RE =
  /UNAVAILABLE \(code 503\)|code 50[0-4]|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|service is currently unavailable|Eligibility check failed|model is at capacity|overloaded|TLS handshake timeout|network issue connecting|"retryable":true/i;

export class AgyEngine implements Engine {
  id = 'agy' as const;

  private agyPath: string | null;
  private streamOutput: boolean;

  constructor(agyPath?: string, customHome?: string, streamOutput = true) {
    this.agyPath = agyPath || findAgyBin(customHome);
    this.streamOutput = streamOutput;
  }

  family(model: string): string {
    // codex:model → codex
    if (model.startsWith('codex:')) return 'codex';
    // Otherwise first part before '-'
    const idx = model.indexOf('-');
    return idx > 0 ? model.substring(0, idx) : model;
  }

  spawn(opts: SpawnOpts): ChildProcess {
    const args = [
      '-p',
      opts.prompt,
      '--model',
      opts.model,
      '--dangerously-skip-permissions',
      '--print-timeout',
      '0',
    ];

    // Add stream-json output format when explicitly requested or configured.
    // This causes agy to emit NDJSON progress events to stdout (→ logFile),
    // so the log file is non-empty during long runs.
    const streamOutput = opts.streamOutput ?? this.streamOutput;
    if (streamOutput) {
      args.push('--output-format', 'stream-json');
    }

    const env: Record<string, string> = { ...process.env as Record<string, string>, BROWSER: '/bin/false' };

    // Set up environment based on profile kind
    if (opts.profile.kind === 'isolated' && opts.profile.home) {
      applyIsolatedAgyEnv(env, opts.profile.home);
    }

    if (opts.env) {
      Object.assign(env, opts.env);
    }

    // Ensure log directory exists
    const logDir = path.dirname(opts.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFd = fs.openSync(opts.logPath, 'a');

    if (opts.lockFile) {
      try { fs.mkdirSync(path.dirname(opts.lockFile), { recursive: true }); } catch { /* ignore */ }
    }

    Object.assign(env, LIMITED_TEST_ENV);
    Object.assign(
      env,
      workerEnvironment(
        opts.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
        env,
        { gitHooks: opts.gitHooks, project: opts.project, cwd: opts.cwd, workerCount: opts.workerCount },
      ),
    );
    if (!this.agyPath) {
      const message = 'Không tìm thấy Antigravity CLI (agy). Kiểm tra PATH của daemon hoặc AGENTHUB_AGY_BIN; cài bằng: curl -fsSL https://antigravity.google/cli/install.sh | bash';
      fs.writeSync(logFd, `${message}\n`);
      const missing = spawn(process.execPath, ['-e', `console.error(${JSON.stringify(message)}); process.exit(127)`], {
        cwd: opts.cwd,
        env,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      missing.on('spawn', () => fs.closeSync(logFd));
      missing.on('error', () => { try { fs.closeSync(logFd); } catch { /* ignore */ } });
      return missing;
    }
    const [agyExe, agyArgs] = lowPriority(this.agyPath, args);
    const [executable, command] = opts.lockFile ? lockCommand(opts.lockFile, [agyExe, ...agyArgs]) : [agyExe, agyArgs];
    const child = spawn(executable, command, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    // Close the fd in this process since child inherited it
    child.on('spawn', () => {
      fs.closeSync(logFd);
    });
    child.on('error', () => {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    });

    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    // Only look at last 8 lines per PLAN 3.3
    const tail = lastNLines(logTail, 8);

    // Check for quota exhaustion patterns
    if (
      /RESOURCE_EXHAUSTED.*429/i.test(tail) ||
      /exhausted your quota/i.test(tail)
    ) {
      return {
        exhausted: true,
        resetSeconds: parseResetTime(tail),
      };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 8);
    return {
      expired: /UNAUTHENTICATED|code 401|"error_code"\s*:\s*401|Authentication required|authentication timed out|not signed in/i.test(tail),
    };
  }

  detectTransientError(logTail: string): boolean {
    const tail = lastNLines(logTail, 8);
    return TRANSIENT_ERROR_RE.test(tail);
  }
}

export function findBubblewrap(): string | null {
  const configured = process.env.AGENTHUB_BWRAP_BIN;
  if (configured !== undefined) {
    const trimmed = configured.trim();
    if (!trimmed || trimmed === '0' || trimmed === 'false') return null;
    return fs.existsSync(trimmed) ? trimmed : null;
  }
  const searchPath = process.env.PATH;
  if (searchPath !== undefined) {
    for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, 'bwrap');
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate;
      } catch { /* try the next PATH entry */ }
    }
  }
  for (const candidate of ['/usr/bin/bwrap', '/bin/bwrap']) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate;
    } catch { /* target is missing */ }
  }
  return null;
}

export function canRunBubblewrap(): boolean {
  const bwrap = findBubblewrap();
  if (!bwrap) return false;
  try {
    const res = spawnSync(bwrap, ['--ro-bind', '/', '/', '--', 'true'], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function brainSandboxCommand(
  bwrap: string,
  command: string,
  args: string[],
  cwd: string,
  hubHome: string,
  profileHome: string | null | undefined,
  blockedNames: string[],
  envPath = process.env.PATH || '',
): [string, string[]] {
  const shimRoot = path.join(hubHome, 'shims', 'worker');
  const home = os.homedir();
  const addDirs = (target: string, stopAt?: string) => {
    const dirs: string[] = [];
    let current = path.resolve(target);
    const stop = stopAt ? path.resolve(stopAt) : path.parse(current).root;
    while (current !== stop && current !== path.parse(current).root) {
      dirs.unshift(current);
      current = path.dirname(current);
    }
    for (const dir of dirs) sandboxArgs.push('--dir', dir);
  };
  const sandboxArgs = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    // The daemon database, token and other profiles must not be visible to a
    // brain. Only the selected profile, session files and read-only shims are
    // mounted back below.
    '--bind', cwd, cwd,
    '--dev', '/dev',
    '--proc', '/proc',
    '--share-net',
    '--die-with-parent',
  ];
  // Brain shim scripts use a private interpreter because /bin/sh itself is
  // overlaid with a policy shim below. This keeps the guards executable while
  // still preventing an untrusted `sh -c` from reaching the host shell.
  if (fs.existsSync('/bin/sh')) sandboxArgs.push('--ro-bind', '/bin/sh', '/tmp/agenthub-brain-sh');
  const sessionDir = path.join(hubHome, 'sessions');
  // Apply this after the cwd bind as tests and some
  // deployments keep the hub directory below the project/home tree.
  sandboxArgs.push('--tmpfs', hubHome);

  // Hide common credential stores. A selected CODEX_HOME is restored after
  // these mounts, so isolated profiles continue to work without exposing the
  // user's other accounts.
  const maskedDirs = [
    path.join(home, '.ssh'), path.join(home, '.codex'), path.join(home, '.agy-homes'),
    path.join(home, '.aws'), path.join(home, '.kube'), path.join(home, '.docker'),
    path.join(home, '.config', 'gh'), path.join(home, '.config', 'gcloud'),
  ];
  for (const masked of maskedDirs) {
    if (fs.existsSync(masked) && masked !== hubHome && !isDescendant(masked, hubHome)) {
      try {
        const mount = fs.lstatSync(masked).isSymbolicLink() ? fs.realpathSync(masked) : masked;
        if (fs.statSync(mount).isDirectory()) {
          sandboxArgs.push('--tmpfs', mount);
        }
      } catch {
        // ignore broken symlinks
      }
    }
  }
  for (const maskedFile of [path.join(home, '.npmrc'), path.join(home, '.netrc')]) {
    if (fs.existsSync(maskedFile) && maskedFile !== hubHome && !isDescendant(maskedFile, hubHome)) {
      try {
        const mount = fs.lstatSync(maskedFile).isSymbolicLink() ? fs.realpathSync(maskedFile) : maskedFile;
        if (fs.statSync(mount).isFile()) {
          sandboxArgs.push('--ro-bind', '/dev/null', mount);
        }
      } catch {
        // ignore broken symlinks
      }
    }
  }

  if (fs.existsSync(sessionDir)) {
    addDirs(sessionDir, hubHome);
    sandboxArgs.push('--bind', sessionDir, sessionDir);
  }
  if (fs.existsSync(shimRoot)) {
    addDirs(shimRoot, hubHome);
    sandboxArgs.push('--ro-bind', shimRoot, shimRoot);
  }
  if (profileHome && fs.existsSync(profileHome) && profileHome !== hubHome && !isDescendant(profileHome, hubHome)) {
    addDirs(profileHome, isDescendant(hubHome, profileHome) ? hubHome : path.dirname(profileHome));
    sandboxArgs.push('--bind', profileHome, profileHome);
  }

  // PATH shims do not protect against /bin/rm or `sh -c /bin/rm`. Overlay the
  // policy shims in a private mount namespace so absolute paths hit the same
  // guard without changing the host filesystem.
  for (const name of blockedNames) {
    const shim = path.join(shimRoot, name);
    if (!fs.existsSync(shim)) continue;
    const targets = new Set([
      `/bin/${name}`,
      `/usr/bin/${name}`,
      ...envPath.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name)),
    ]);
    for (const target of targets) {
      if (target.startsWith(`${shimRoot}${path.sep}`)) continue;
      try {
        // bubblewrap cannot replace a symlink with a bind mount. Mount the
        // canonical target instead so `/bin/sh` and similar absolute aliases
        // receive the same policy guard.
        const mountTarget = fs.realpathSync(target);
        if (maskedDirs.some((masked) => isDescendant(masked, mountTarget))) continue;
        if (fs.lstatSync(mountTarget).isFile()) sandboxArgs.push('--ro-bind', shim, mountTarget);
      } catch { /* target is optional on this host */ }
    }
  }

  const gitShim = path.join(shimRoot, 'git');
  if (fs.existsSync(gitShim)) {
    for (const target of ['/bin/git', '/usr/bin/git']) {
      if (fs.existsSync(target)) sandboxArgs.push('--ro-bind', gitShim, target);
    }
  }
  let sandboxCommand = command;
  // Keep the primary JS launcher out of the interpreter shim overlay. This
  // private mount is only the process AgentHub started; child `node` commands
  // still resolve through the policy shim in /bin and /usr/bin.
  if (command === process.execPath && fs.existsSync(command)) {
    const runtime = '/tmp/agenthub-brain-node';
    sandboxArgs.push('--ro-bind', command, runtime);
    sandboxCommand = runtime;
  }
  return [bwrap, [...sandboxArgs, '--', sandboxCommand, ...args]];
}

function isDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class CodexEngine implements Engine {
  id = 'codex' as const;

  private codexPath: string | null;
  private codexSandbox: 'off' | 'workspace-write';

  constructor(codexPath?: string, codexSandbox: 'off' | 'workspace-write' = 'off') {
    this.codexPath = codexPath || null;
    this.codexSandbox = codexSandbox;
  }

  static findCodexPath(): string | null {
    try {
      if (process.env.AGENTHUB_CODEX_BIN && fs.existsSync(process.env.AGENTHUB_CODEX_BIN)) return process.env.AGENTHUB_CODEX_BIN;
      const managed = process.env.AGENTHUB_TOOLS_DIR ? path.join(process.env.AGENTHUB_TOOLS_DIR, 'node_modules', '.bin', 'codex') : null;
      if (managed && fs.existsSync(managed)) return managed;
      const homeDir = os.homedir();
      const base = path.join(homeDir, '.vscode', 'extensions');
      if (!fs.existsSync(base)) return null;
      const entries = fs.readdirSync(base).filter((e) => e.startsWith('openai.chatgpt-'));
      if (entries.length === 0) return null;
      entries.sort();
      const latest = entries[entries.length - 1];
      const targets = process.platform === 'darwin'
        ? ['darwin-arm64', 'darwin-x64', 'macos-arm64', 'macos-x64']
        : process.platform === 'win32' ? ['win32-x64'] : ['linux-x86_64'];
      for (const target of targets) {
        const codexBin = path.join(base, latest, 'bin', target, 'codex');
        if (fs.existsSync(codexBin)) return codexBin;
      }
      return null;
    } catch {
      return null;
    }
  }

  family(_model: string): string {
    return 'codex';
  }

  spawn(opts: SpawnOpts): ChildProcess {
    const codexPath = this.codexPath || CodexEngine.findCodexPath();
    if (!codexPath) {
      throw new Error('Codex CLI not found');
    }

    // Extract model name: "codex:gpt-5.6-luna" → "gpt-5.6-luna"
    let model = opts.model;
    if (model.startsWith('codex:')) {
      model = model.substring(6);
    }

    const args = [
      'exec',
      ...(opts.streamOutput ? ['--json'] : []),
      '--skip-git-repo-check',
      '-m',
      model,
      '-c',
      `model_reasoning_effort=${opts.effort || 'medium'}`,
      '-C',
      opts.cwd,
      opts.prompt,
    ];
    if (opts.mcpConfigPath) {
      // Codex accepts MCP overrides as CLI config values. The JSON file is the
      // same per-session definition used by Claude and keeps the command out
      // of the user's global Codex configuration.
      try {
        const mcp = JSON.parse(fs.readFileSync(opts.mcpConfigPath, 'utf8')) as { mcpServers?: { agenthub?: { command?: string; args?: string[]; env?: Record<string, string> } } };
        const server = mcp.mcpServers?.agenthub;
        if (server?.command) {
          args.splice(-1, 0, '-c', toTomlConfigArg('mcp_servers.agenthub.command', server.command));
          if (server.args?.length) args.splice(-1, 0, '-c', toTomlConfigArg('mcp_servers.agenthub.args', server.args));
          if (server.env) args.splice(-1, 0, '-c', toTomlConfigArg('mcp_servers.agenthub.env', server.env));
        }
      } catch { /* malformed optional MCP config is handled by Codex */ }
    }
    const sandboxMode = opts.codexSandbox ?? this.codexSandbox;
    if (opts.readOnly) {
      args.splice(2, 0, '--sandbox', 'read-only');
    } else if (sandboxMode === 'workspace-write') {
      args.splice(2, 0, '--sandbox', 'workspace-write');
    } else {
      args.splice(2, 0, '--dangerously-bypass-approvals-and-sandbox');
    }
    // Keep Codex behind its approval broker for standard/trusted brain sessions.
    // `never` is only used together with the explicit full-permission bypass.
    if (opts.codexApproval) {
      args.splice(-1, 0, '-c', `approval_policy=${opts.codexApproval}`);
    }
    if (opts.outputPath) args.splice(-1, 0, '--output-last-message', opts.outputPath);

    const logDir = path.dirname(opts.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFd = fs.openSync(opts.logPath, 'a');

    if (opts.lockFile) {
      try { fs.mkdirSync(path.dirname(opts.lockFile), { recursive: true }); } catch { /* ignore */ }
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...LIMITED_TEST_ENV };
    if (opts.profile.engine === 'codex' && opts.profile.home) {
      env.CODEX_HOME = opts.profile.home;
    }
    if (opts.env) {
      Object.assign(env, opts.env);
    }
    // A JS Codex launcher (used by managed installs and tests) needs to pass
    // through the node interpreter shim. The shim only permits this exact
    // entrypoint; arbitrary `node -e`/script invocations remain denied.
    env.AGENTHUB_BRAIN_ENTRYPOINT = codexPath;
    Object.assign(
      env,
      workerEnvironment(
        opts.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
        env,
        { gitHooks: opts.gitHooks, project: opts.project, cwd: opts.cwd, workerCount: opts.workerCount, brainPolicy: opts.brainPolicy, brainInterpreter: opts.brainPolicy ? '/tmp/agenthub-brain-sh' : undefined },
      ),
    );

    // Managed/test launchers can be JavaScript files with a `/usr/bin/env
    // node` shebang. Start those through the node executable explicitly so
    // the brain interpreter shim can identify the approved entrypoint instead
    // of seeing the Codex subcommand as its first argument.
    const isJavaScriptLauncher = /\.(?:c|m)?js$/i.test(codexPath);
    const launchPath = isJavaScriptLauncher ? process.execPath : codexPath;
    const launchArgs = isJavaScriptLauncher ? [codexPath, ...args] : args;
    const [codexExe, codexArgs] = isJavaScriptLauncher && opts.brainPolicy
      ? [launchPath, launchArgs] as [string, string[]]
      : lowPriority(launchPath, launchArgs);
    const locked = opts.lockFile ? lockCommand(opts.lockFile, [codexExe, ...codexArgs]) : [codexExe, codexArgs] as [string, string[]];
    let executable = locked[0];
    let command = locked[1];
    if (opts.brainPolicy) {
      const bwrap = findBubblewrap();
      if (!bwrap) throw new Error('Codex brain policy requires bubblewrap (bwrap)');
      [executable, command] = brainSandboxCommand(
        bwrap,
        executable,
        command,
        opts.cwd,
        opts.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
        opts.profile.home,
        [
          // Keep this list in sync with the brain shims in worker-guard.ts.
          // These tools can mutate files or execute arbitrary code without
          // going through Codex's approval prompt, including when invoked by
          // absolute path or from `sh -c`.
          'rm', 'mv', 'cp', 'install', 'find', 'xargs', 'sed', 'perl', 'python', 'python3', 'ruby', 'node',
          'systemctl', 'launchctl', 'sudo', 'su', 'ssh', 'scp', 'sftp', 'docker', 'docker-compose', 'podman',
          'mkfs', 'dd', 'truncate', 'chown', 'chmod', 'chgrp', 'mount', 'umount', 'tar', 'zip', 'unzip',
          'sh', 'bash', 'zsh', 'dash', 'fish', 'echo', 'printf', 'touch', 'mkdir', 'rmdir', 'ln', 'tee', 'awk', 'gawk',
          'busybox', 'env', 'nohup', 'timeout', 'watch', 'yes', 'sort', 'uniq', 'xargs',
          'ed', 'ex', 'vim', 'vi', 'nvim', 'emacs', 'make', 'cmake', 'gcc', 'clang', 'go', 'java', 'php',
          'cat', 'grep', 'head', 'tail', 'wc', 'ls',
        ],
        env.PATH,
      );
    }
    const child = spawn(executable, command, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: opts.streamOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', logFd, logFd],
    });

    child.on('spawn', () => { try { fs.closeSync(logFd); } catch { /* pipe mode */ } });
    child.on('error', () => {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    });

    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    const tail = lastNLines(logTail, 8);
    if (/usage limit|rate limit|insufficient_quota|\b429\b/i.test(tail)) {
      return {
        exhausted: true,
        resetSeconds: parseResetTime(tail),
      };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 8);
    return {
      expired: /UNAUTHENTICATED|code 401|"error_code"\s*:\s*401|Not logged in|\b401\b/i.test(tail),
    };
  }

  detectTransientError(logTail: string): boolean {
    const tail = lastNLines(logTail, 8);
    return TRANSIENT_ERROR_RE.test(tail);
  }
}

/**
 * Fake engine for testing. Runs `node test/fixtures/fake-agent.mjs`.
 * Behavior controlled via FAKE_MODE env var.
 */
export class FakeEngine implements Engine {
  id = 'agy' as const;
  private scriptPath: string;

  constructor(scriptPath?: string) {
    this.scriptPath =
      scriptPath || path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs');
  }

  family(model: string): string {
    if (model.startsWith('codex:')) return 'codex';
    const idx = model.indexOf('-');
    return idx > 0 ? model.substring(0, idx) : model;
  }

  spawn(opts: SpawnOpts): ChildProcess {
    const logDir = path.dirname(opts.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFd = fs.openSync(opts.logPath, 'a');

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FAKE_CWD: opts.cwd,
      FAKE_PROMPT: opts.prompt,
      FAKE_MODEL: opts.model,
      FAKE_PROFILE: opts.profile.name,
      FAKE_OUTPUT_PATH: opts.outputPath || '',
      ...(opts.env || {}),
    };
    if (opts.hubHome || opts.project) {
      Object.assign(
        env,
        workerEnvironment(
          opts.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
          env,
          { gitHooks: opts.gitHooks, project: opts.project, workerCount: opts.workerCount },
        ),
      );
    }

    const command = process.env.FAKE_MODE === 'reviewer-error' ? '/definitely-missing-agenthub-fixture' : process.execPath;
    const args = command === process.execPath ? [this.scriptPath] : [];

    const useFlock = Boolean(opts.lockFile) && process.env.FAKE_MODE !== 'reviewer-error';
    if (opts.lockFile) {
      try { fs.mkdirSync(path.dirname(opts.lockFile), { recursive: true }); } catch { /* ignore */ }
    }
    const [executable, spawnArgs] = useFlock ? lockCommand(opts.lockFile!, [command, ...args]) : [command, args];

    const child = spawn(executable, spawnArgs, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    child.on('spawn', () => {
      fs.closeSync(logFd);
    });
    child.on('error', () => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    });

    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    const tail = lastNLines(logTail, 8);
    if (
      /RESOURCE_EXHAUSTED.*429/i.test(tail) ||
      /exhausted your quota/i.test(tail) ||
      /usage limit|rate limit|insufficient_quota|\b429\b/i.test(tail)
    ) {
      return {
        exhausted: true,
        resetSeconds: parseResetTime(tail),
      };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 8);
    return {
      expired: /UNAUTHENTICATED|code 401|"error_code"\s*:\s*401|Not logged in|\b401\b/i.test(tail),
    };
  }

  detectTransientError(logTail: string): boolean {
    const tail = lastNLines(logTail, 8);
    return TRANSIENT_ERROR_RE.test(tail);
  }
}

/**
 * Escapes a string for use in TOML basic strings (double quoted).
 * Escapes quotation mark, backslash, control characters (\b, \t, \n, \f, \r, \u00xx), and \u007f-\u009f (DEL and C1 controls).
 */
export function escapeTomlString(str: string): string {
  // eslint-disable-next-line no-control-regex -- control characters (C0, DEL, C1) must be escaped in TOML basic strings
  return str.replace(/[\x00-\x1f\x7f-\x9f"\\]/g, (c) => {
    switch (c) {
      case '"': return '\\"';
      case '\\': return '\\\\';
      case '\b': return '\\b';
      case '\t': return '\\t';
      case '\n': return '\\n';
      case '\f': return '\\f';
      case '\r': return '\\r';
      default: {
        const code = c.charCodeAt(0);
        return `\\u${code.toString(16).padStart(4, '0')}`;
      }
    }
  });
}

/**
 * Formats a key for TOML. Bare keys (letters, numbers, underscores, hyphens) are unquoted;
 * other keys are wrapped in double quotes and escaped.
 */
export function toTomlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return key;
  }
  return `"${escapeTomlString(key)}"`;
}

/**
 * Formats a value for TOML. Strings are escaped and quoted, numbers and booleans are formatted as-is,
 * arrays are bracketed, and objects become inline tables.
 */
export function toTomlValue(val: unknown): string {
  if (typeof val === 'string') {
    return `"${escapeTomlString(val)}"`;
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(toTomlValue).join(', ')}]`;
  }
  if (val && typeof val === 'object') {
    return toTomlInlineTable(val as Record<string, unknown>);
  }
  return `"${escapeTomlString(String(val ?? ''))}"`;
}

/**
 * Formats an object as a TOML inline table: {KEY="VAL", KEY2="VAL2"}.
 */
export function toTomlInlineTable(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).map(([key, value]) => {
    return `${toTomlKey(key)}=${toTomlValue(value)}`;
  });
  return `{${entries.join(', ')}}`;
}

/**
 * Formats a config key-value pair for Codex -c flags.
 */
export function toTomlConfigArg(key: string, val: unknown): string {
  if (typeof val === 'string') {
    return `${key}=${toTomlValue(val)}`;
  }
  if (Array.isArray(val)) {
    return `${key}=${toTomlValue(val)}`;
  }
  if (val && typeof val === 'object') {
    return `${key}=${toTomlInlineTable(val as Record<string, unknown>)}`;
  }
  return `${key}=${toTomlValue(val)}`;
}
