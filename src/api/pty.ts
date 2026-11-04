import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import pty from 'node-pty';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';
import { AppService, HttpError } from '../services/index.js';
import { findClaudeBin } from '../chat/claude.js';
import { CodexEngine } from '../engines/index.js';
import { accountKey, isProfileLoggedIn } from '../profiles/index.js';
import { agyInstallHint, applyIsolatedAgyEnv, findAgyBin } from '../agy.js';

const require = createRequire(import.meta.url);

let spawnHelperChecked = false;

/**
 * Cấp quyền thực thi (+x) cho các file binary spawn-helper nếu thiếu bit thực thi.
 */
export function fixSpawnHelperPermissions(candidates: string[]): void {
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const stat = fs.statSync(file);
        if ((stat.mode & 0o111) === 0) {
          fs.chmodSync(file, stat.mode | 0o755);
        }
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Trên macOS, node-pty gọi binary 'spawn-helper' qua posix_spawnp.
 * Các file prebuild từ npm thường thiếu quyền thực thi (+x), dẫn đến lỗi
 * 'posix_spawnp failed' / 503 pty_unavailable.
 *
 * Chỉ chạy một lần trên darwin; hỗ trợ nhận ptyDir hoặc danh sách đường dẫn phục vụ test.
 */
export function ensureSpawnHelperExecutable(target?: string | string[]): void {
  if (Array.isArray(target)) {
    fixSpawnHelperPermissions(target);
    return;
  }
  if (typeof target === 'string') {
    const candidates = [
      path.join(target, 'build', 'Release', 'spawn-helper'),
      path.join(target, 'build', 'Debug', 'spawn-helper'),
      path.join(target, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ];
    fixSpawnHelperPermissions(candidates);
    return;
  }

  if (process.platform !== 'darwin' || spawnHelperChecked) {
    return;
  }
  spawnHelperChecked = true;

  try {
    const ptyPackageJson = require.resolve('node-pty/package.json');
    const ptyDir = path.dirname(ptyPackageJson);
    const candidates = [
      path.join(ptyDir, 'build', 'Release', 'spawn-helper'),
      path.join(ptyDir, 'build', 'Debug', 'spawn-helper'),
      path.join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ];
    fixSpawnHelperPermissions(candidates);
  } catch {
    // ignore
  }
}

interface PtySession {
  id: string;
  profileName: string;
  process: pty.IPty;
  sockets: Set<WebSocket>;
  timer: NodeJS.Timeout;
  recentBuffer: string;
  exited?: boolean;
  loginMenuAnswered?: boolean;
  /** agy đã đăng nhập thì vào thẳng chat; hub phải tự gửi /login để lấy link mới. */
  agyRelogin?: 'waiting_prompt' | 'login_sent';
  exitDisposable?: { dispose: () => void };
}

// eslint-disable-next-line no-control-regex -- strips terminal escape sequences
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

/**
 * Newer agy versions ask for a login method before printing the OAuth link.
 * Return true when the menu is on screen so the hub can pick "Google OAuth".
 */
/** agy đã vào màn hình chat (hồ sơ còn phiên đăng nhập). */
export function isAgyChatPrompt(buffer: string): boolean {
  return /\? for shortcuts/i.test(buffer.replace(ANSI_RE, ''));
}

/** agy đã in link OAuth hoặc ô nhập mã xác thực. */
export function hasAgyLoginLink(buffer: string): boolean {
  return /accounts\.google\.com|authorization code/i.test(buffer.replace(ANSI_RE, ''));
}

export function isAgyLoginMenu(buffer: string): boolean {
  return /Select login method/i.test(buffer.replace(ANSI_RE, '')) && /Google OAuth/i.test(buffer.replace(ANSI_RE, ''));
}

// Lệnh mà agy/claude/codex có thể gọi để tự mở trình duyệt.
const BROWSER_OPENERS = [
  'xdg-open', 'x-www-browser', 'www-browser', 'sensible-browser', 'gio', 'gnome-open', 'kde-open', 'kde-open5',
  'exo-open', 'gvfs-open', 'firefox', 'google-chrome', 'chromium', 'chromium-browser',
];

/**
 * Không cho CLI tự mở tab đăng nhập: wizard trên web đã hiện link để người dùng tự mở.
 * Các lệnh mở trình duyệt được thay bằng script không làm gì (exit 0) đặt đầu PATH,
 * để CLI vẫn coi là mở thành công và tiếp tục chờ mã xác thực.
 * Đặt AGENTHUB_LOGIN_OPEN_BROWSER=1 để bật lại hành vi cũ.
 */
export function applyNoBrowserEnv(env: Record<string, string>, hubHome?: string): void {
  if (process.env.AGENTHUB_LOGIN_OPEN_BROWSER === '1') return;
  const base = hubHome || process.env.AGENTHUB_HOME || path.join(os.tmpdir(), 'agenthub-no-browser');
  const shimDir = path.join(base, 'no-browser-bin');
  try {
    fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
    for (const name of BROWSER_OPENERS) {
      const file = path.join(shimDir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  } catch {
    // Không tạo được shim thì CLI có thể tự mở tab; không được chặn việc đăng nhập.
    return;
  }
  env.BROWSER = path.join(shimDir, 'xdg-open');
  env.PATH = env.PATH ? `${shimDir}${path.delimiter}${env.PATH}` : shimDir;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>(); // sessionId -> PtySession
  private profileToSession = new Map<string, string>(); // profileName -> sessionId
  private emailRefreshTimers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(private service: AppService) {}

  createSession(profileName: string): string {
    this.stopped = false;
    let profile = this.service.profileRepo.get(profileName);
    if (!profile) {
      // Create isolated profile if not yet created
      profile = this.service.createProfile({ name: profileName });
    }

    // Enforce max 1 session per profile
    const existingSessionId = this.profileToSession.get(profileName);
    if (existingSessionId) {
      this.closeSession(existingSessionId);
    }

    const sessionId = crypto.randomUUID();
    const home = profile.home || path.join(this.service.config.agyHomesDir, profile.name);

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (profile.engine === 'claude' && profile.kind !== 'system' && profile.home) {
      env.CLAUDE_CONFIG_DIR = profile.home;
    } else if (profile.kind === 'isolated') {
      applyIsolatedAgyEnv(env, home);
    }
    applyNoBrowserEnv(env, this.service.config.hubHome);

    let args: string[] = [];
    let command: string | null | undefined;
    if (profile.engine === 'claude') {
      command = findClaudeBin(this.service.config.chat.claudeBin) || process.env.AGENTHUB_CLAUDE_BIN;
    } else if (profile.engine === 'codex') {
      // Device-code login works from the dashboard: the CLI prints a URL and a one-time code.
      command = process.env.AGENTHUB_CODEX_BIN || CodexEngine.findCodexPath();
      args = ['login', '--device-auth'];
      if (profile.kind === 'isolated' && profile.home) env.CODEX_HOME = profile.home;
    } else {
      command = findAgyBin(this.service.config.hubHome);
    }
    if (!command) {
      const configured = process.env.AGENTHUB_AGY_BIN?.trim();
      const configuredNote = configured ? ` AGENTHUB_AGY_BIN đang trỏ tới “${configured}” nhưng file không tồn tại.` : '';
      throw new HttpError(404, 'agy_not_found', `Không tìm thấy Antigravity CLI (agy). Daemon không thấy agy trong PATH, ~/.local/bin hoặc ~/.gemini/bin.${configuredNote} Cài bằng: ${agyInstallHint()}`);
    }

    if (process.platform === 'darwin' && !spawnHelperChecked) {
      ensureSpawnHelperExecutable();
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: fs.existsSync(home) ? home : os.homedir(),
        env,
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      if (profile.engine === 'agy' && /ENOENT|execvp|no such file or directory/i.test(detail)) {
        throw new HttpError(404, 'agy_not_found', `Không thể chạy Antigravity CLI (agy). Kiểm tra AGENTHUB_AGY_BIN hoặc PATH của daemon. Cài bằng: ${agyInstallHint()}`);
      }
      throw new HttpError(503, 'pty_unavailable', `Không thể khởi tạo PTY trên ${process.platform}: ${detail}. Kiểm tra binary node-pty/spawn-helper và quyền thực thi.`);
    }

    // Auto-close session after 15 minutes (PLAN 4)
    const timer = setTimeout(() => {
      this.closeSession(sessionId);
    }, 15 * 60 * 1000);

    const session: PtySession = {
      id: sessionId,
      profileName,
      process: ptyProcess,
      sockets: new Set(),
      timer,
      recentBuffer: '',
      agyRelogin: profile.engine === 'agy' ? 'waiting_prompt' : undefined,
    };
    // Gõ lệnh slash rồi mới Enter, để ô gợi ý lệnh của agy kịp lọc đúng lệnh.
    const typeCommand = (command: string) => {
      try { ptyProcess.write(command); } catch { return; }
      setTimeout(() => {
        try { ptyProcess.write('\r'); } catch { /* process may have exited */ }
      }, 200);
    };

    ptyProcess.onData((data: string) => {
      // Keep last 16KB for new connections
      session.recentBuffer = (session.recentBuffer + data).slice(-16384);
      if (profile.engine === 'agy' && !session.loginMenuAnswered && isAgyLoginMenu(session.recentBuffer)) {
        session.loginMenuAnswered = true;
        // Option 1 (Google OAuth) is preselected; Enter confirms it.
        setTimeout(() => {
          try { ptyProcess.write('\r'); } catch { /* process may have exited */ }
        }, 300);
      }
      // Đã có menu/link đăng nhập ngay từ đầu (hồ sơ mới): chat xuất hiện sau đó là do đăng nhập xong.
      if (session.agyRelogin === 'waiting_prompt' && (session.loginMenuAnswered || hasAgyLoginLink(session.recentBuffer))) {
        session.agyRelogin = undefined;
      }
      if (session.agyRelogin === 'waiting_prompt' && isAgyChatPrompt(session.recentBuffer)) {
        session.agyRelogin = 'login_sent';
        setTimeout(() => typeCommand('/login'), 500);
        // Nếu /login không mở được menu hay link (agy đòi đăng xuất trước) thì /logout rồi /login lại.
        setTimeout(() => {
          if (!this.sessions.has(sessionId) || session.loginMenuAnswered || hasAgyLoginLink(session.recentBuffer)) return;
          typeCommand('/logout');
          setTimeout(() => typeCommand('/login'), 2_000);
        }, 6_000);
      }
      for (const socket of session.sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      }
    });

    const exitDisposable = ptyProcess.onExit(() => {
      this.handleProcessExit(sessionId, profileName, home);
    });
    session.exitDisposable = exitDisposable;

    this.sessions.set(sessionId, session);
    this.profileToSession.set(profileName, sessionId);

    if (profile.engine === 'claude') {
      setTimeout(() => {
        try { ptyProcess.write('/login\r'); } catch { /* process may have exited */ }
      }, 250);
    }

    return sessionId;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.emailRefreshTimers) {
      clearTimeout(timer);
    }
    this.emailRefreshTimers.clear();
    for (const sessionId of [...this.sessions.keys()]) {
      const session = this.sessions.get(sessionId);
      session?.exitDisposable?.dispose();
      this.closeSession(sessionId, 1001, 'Going Away');
    }
  }

  getSession(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId);
  }

  private isDatabaseOpen(): boolean {
    const db = this.service.scheduler.getDatabase();
    return db ? db.open : true;
  }

  private scheduleEmailRefresh(profileName: string): void {
    if (this.stopped || !this.isDatabaseOpen()) return;
    try {
      const profile = this.service.profileRepo.get(profileName);
      if (profile && profile.authState === 'not_logged_in' && isProfileLoggedIn(profile)) {
        this.service.profileRepo.updateAuthState(profileName, 'ok', null, null);
      }
      this.service.refreshProfileEmail(profileName);

      const timer = setTimeout(() => {
        this.emailRefreshTimers.delete(timer);
        if (this.stopped || !this.isDatabaseOpen()) return;
        try {
          this.service.refreshProfileEmail(profileName);
          // Đăng nhập agy qua terminal xong thì lấy luôn ảnh Google (DEC-007), không đợi bấm Làm mới.
          if (profile?.engine === 'agy') void this.service.syncAgyAvatarFromToken(profileName).catch(() => null);
        } catch {
          // Database connection may have closed
        }
      }, 2000);
      timer.unref?.();
      this.emailRefreshTimers.add(timer);
    } catch {
      // Database connection may have closed
    }
  }

  closeSession(sessionId: string, closeCode = 1000, closeReason = 'Session closed'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.exitDisposable?.dispose();
    clearTimeout(session.timer);
    try {
      session.process.kill();
    } catch {
      // ignore
    }

    for (const socket of session.sockets) {
      try {
        socket.close(closeCode, closeReason);
      } catch {
        // ignore
      }
    }
    session.sockets.clear();

    const profileName = session.profileName;
    this.sessions.delete(sessionId);
    this.profileToSession.delete(profileName);

    this.scheduleEmailRefresh(profileName);
  }

  private handleProcessExit(sessionId: string, profileName: string, _home: string): void {
    if (this.stopped) return;
    const session = this.sessions.get(sessionId);
    if (session) {
      session.exitDisposable?.dispose();
      clearTimeout(session.timer);
      session.exited = true;
      for (const socket of session.sockets) {
        try {
          socket.close(1000, 'Process exited');
        } catch {
          // ignore
        }
      }
      this.profileToSession.delete(profileName);
      // Keep the last output briefly so a WebSocket that connects just after
      // the process exits can still receive the login result. This is common
      // for short-lived test/fallback CLIs and avoids a session-id race after
      // the POST /login response has already been sent.
      const cleanupTimer = setTimeout(() => {
        if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      }, 10_000);
      cleanupTimer.unref?.();
    }

    if (!this.isDatabaseOpen()) return;

    try {
      this.scheduleEmailRefresh(profileName);

      const profile = this.service.profileRepo.get(profileName);
      const dupes = this.service.coreProfileService.getDuplicateEmails();
      const duplicateWarning = profile ? dupes.has(accountKey(profile) || '') : false;

      this.service.scheduler.getEventBus().emit('profile.updated', undefined, {
        name: profileName,
        email: profile?.email || null,
        duplicateWarning,
      });

      // Move waiting_quota tasks to queued
      this.service.scheduler.wakeWaitingQuotaTasks('profile_login');
    } catch {
      // Database connection may have closed during process exit
    }
  }

  attachSocket(sessionId: string, socket: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      socket.close(1008, 'Session not found');
      return;
    }

    session.sockets.add(socket);

    // Send recent buffer to client
    if (session.recentBuffer.length > 0) {
      socket.send(session.recentBuffer);
    }

    socket.on('message', (raw: Buffer | string) => {
      try {
        const text = raw.toString();
        const parsed = JSON.parse(text);
        if (parsed.type === 'input' && typeof parsed.data === 'string') {
          session.process.write(parsed.data);
        } else if (
          parsed.type === 'resize' &&
          typeof parsed.cols === 'number' &&
          typeof parsed.rows === 'number'
        ) {
          session.process.resize(parsed.cols, parsed.rows);
        } else {
          session.process.write(text);
        }
      } catch {
        session.process.write(raw.toString());
      }
    });

    socket.on('close', () => {
      session.sockets.delete(socket);
      this.scheduleEmailRefresh(session.profileName);
    });

    if (session.exited) {
      // Give the queued recentBuffer message above a chance to flush before
      // closing a socket attached after the PTY process has already exited.
      setTimeout(() => {
        try { socket.close(1000, 'Process exited'); } catch { /* already closed */ }
      }, 0);
    }
  }
}

export function registerPtyRoutes(
  fastify: FastifyInstance,
  service: AppService,
  ptyManager: PtyManager,
): void {
  fastify.addHook('onClose', async () => {
    ptyManager.stop();
  });

  // Start login session
  fastify.post('/api/profiles/:name/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = req.params as { name: string };
    try {
      const sessionId = ptyManager.createSession(name);
      return { sessionId };
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.error, message: err.message });
      }
      return reply.status(500).send({
        error: 'internal_server_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // WebSocket for PTY session
  fastify.get(
    '/api/pty/:sessionId',
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest) => {
      let sessionId = (req.params as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) {
        const rawUrl = req.raw.url || req.url;
        const match = rawUrl?.match(/\/api\/pty\/([^?#/]+)/);
        if (match) sessionId = match[1];
      }
      if (sessionId) {
        ptyManager.attachSocket(sessionId, socket);
      } else {
        socket.close(1008, 'Missing session ID');
      }
    },
  );
}
