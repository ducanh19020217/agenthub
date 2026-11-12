import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkNode,
  checkGit,
  checkEngines,
  checkDaemon,
  checkSystemd,
  checkMcp,
  checkProfiles,
  checkPermissions,
  runDoctor,
  formatDoctorText,
  formatDoctorJson,
} from '../src/doctor.js';
import { cmdDoctor } from '../src/cli-main.js';
import { loadConfig } from '../src/config.js';
import { findAgyBin } from '../src/agy.js';

describe('Doctor checks', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-doctor-test-'));
    process.env.AGENTHUB_HOME = path.join(tmpHome, '.agenthub');
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpHome, '.agy-homes');
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    fs.mkdirSync(process.env.AGENTHUB_HOME, { recursive: true, mode: 0o700 });
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
  });

  describe('checkNode', () => {
    it('returns ok when Node >= 22', async () => {
      const res = await checkNode({
        version: 'v22.21.1',
        execPath: '/usr/local/bin/node',
      });
      expect(res.status).toBe('ok');
      expect(res.message).toContain('v22.21.1');
      expect(res.message).toContain('/usr/local/bin/node');
    });

    it('returns error with suggestion when Node < 22', async () => {
      const res = await checkNode({
        version: 'v18.19.0',
        execPath: '/usr/bin/node',
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('yêu cầu phiên bản ≥ 22');
      expect(res.suggestion).toContain('nvm use 22');
    });
  });

  describe('checkGit', () => {
    it('returns ok when git is available and reports version', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: 0,
        stdout: 'git version 2.25.1\n',
        stderr: '',
      });
      const res = await checkGit({ exec: mockExec });
      expect(res.status).toBe('ok');
      expect(res.message).toBe('git version 2.25.1');
    });

    it('returns error when git executable is not found', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('spawnSync git ENOENT'),
      });
      const res = await checkGit({ exec: mockExec });
      expect(res.status).toBe('error');
      expect(res.suggestion).toContain('Cài đặt git');
    });

    it('returns error when git exits with non-zero code', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'fatal: error',
      });
      const res = await checkGit({ exec: mockExec });
      expect(res.status).toBe('error');
      expect(res.message).toContain('mã thoát 1');
    });
  });

  describe('checkEngines', () => {
    it('finds agy from a service PATH or official installer location', () => {
      const seen = new Set(['/tmp/bin/agy', '/tmp/home/.local/bin/agy']);
      expect(findAgyBin('/tmp/home', (candidate) => seen.has(candidate), {
        PATH: '/tmp/bin',
      })).toBe('/tmp/bin/agy');
      expect(findAgyBin('/tmp/home', (candidate) => candidate === '/tmp/home/.local/bin/agy', {
        PATH: '',
      })).toBe('/tmp/home/.local/bin/agy');
    });

    it('returns ok when both agy and codex are found', async () => {
      const res = await checkEngines({
        agyPath: '/home/user/.gemini/bin/agy',
        codexPath: '/home/user/.vscode/extensions/openai.chatgpt-1.0/bin/linux-x86_64/codex',
      });
      expect(res.status).toBe('ok');
      expect(res.message).toContain('/home/user/.gemini/bin/agy');
      expect(res.message).toContain('Codex CLI');
    });

    it('returns error when agy is missing', async () => {
      const res = await checkEngines({
        agyPath: null,
        codexPath: '/path/to/codex',
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('Không tìm thấy agy');
      expect(res.suggestion).toContain('~/.gemini/bin/agy');
    });

    it('returns error when codex is missing', async () => {
      const res = await checkEngines({
        agyPath: '/path/to/agy',
        codexPath: null,
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('không tìm thấy Codex CLI');
      expect(res.suggestion).toContain('/setup');
    });

    it('returns error when both agy and codex are missing', async () => {
      const res = await checkEngines({
        agyPath: null,
        codexPath: null,
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('Không tìm thấy cả agy (~/.gemini/bin/agy) lẫn Codex CLI');
      expect(res.suggestion).toContain('Antigravity CLI');
      expect(res.suggestion).toContain('Codex CLI');
    });
  });

  describe('checkDaemon', () => {
    it('returns error when daemon is not reachable on /health', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await checkDaemon({
        port: 4800,
        tokenPath: '/fake/token',
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('Không kết nối được daemon');
      expect(res.suggestion).toContain('agenthub daemon');
    });

    it('returns error when /health returns non-200', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 500,
      });
      const res = await checkDaemon({
        port: 4800,
        tokenPath: '/fake/token',
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('GET /health trả về HTTP 500');
    });

    it('returns error when /health is ok but token cannot be read', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
      });
      const res = await checkDaemon({
        port: 4800,
        tokenPath: '/nonexistent/token',
        fetchFn: mockFetch as unknown as typeof fetch,
        readToken: () => null,
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('không đọc được token');
    });

    it('returns error when token exists but /api/status returns 401', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ status: 200 }) // GET /health
        .mockResolvedValueOnce({ status: 401 }); // GET /api/status

      const res = await checkDaemon({
        port: 4800,
        tokenPath: '/fake/token',
        fetchFn: mockFetch as unknown as typeof fetch,
        readToken: () => 'fake-token-value',
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('GET /api/status trả về HTTP 401');
      expect(res.suggestion).toContain('Token tại /fake/token không hợp lệ');
    });

    it('returns ok when /health ok, token readable, and /api/status returns 200', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ status: 200 }) // GET /health
        .mockResolvedValueOnce({ status: 200 }); // GET /api/status

      const res = await checkDaemon({
        port: 4800,
        tokenPath: '/fake/token',
        fetchFn: mockFetch as unknown as typeof fetch,
        readToken: () => 'valid-token',
      });
      expect(res.status).toBe('ok');
      expect(res.message).toContain('Daemon đang chạy');
      expect(res.message).toContain('/api/status trả 200');
    });
  });

  describe('checkSystemd', () => {
    it('returns skip when systemctl is not found', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('ENOENT'),
      });
      const res = await checkSystemd({ exec: mockExec });
      expect(res.status).toBe('skip');
      if (process.platform === 'darwin') {
        expect(res.message).toContain('LaunchAgent');
      } else {
        expect(res.message).toContain('bỏ qua');
      }
    });

    it('returns skip when systemd user bus is unavailable', async () => {
      const mockExec = vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: 'systemd 245\n', stderr: '' }) // systemctl --version
        .mockReturnValueOnce({
          status: 1,
          stdout: '',
          stderr: 'Failed to connect to bus: No such file or directory\n',
        }); // systemctl --user is-active
      const res = await checkSystemd({ exec: mockExec });
      expect(res.status).toBe('skip');
      if (process.platform === 'darwin') {
        expect(res.message).toContain('LaunchAgent');
      } else {
        expect(res.message).toContain('Không có systemd user bus (bỏ qua)');
      }
    });

    it('returns ok when service is active', async () => {
      const mockExec = vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: 'systemd 245\n', stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: 'active\n', stderr: '' });
      const res = await checkSystemd({ exec: mockExec });
      if (process.platform === 'darwin') {
        expect(res.status).toBe('skip');
        expect(res.message).toContain('LaunchAgent');
      } else {
        expect(res.status).toBe('ok');
        expect(res.message).toContain('đang hoạt động (active)');
      }
    });

    it('returns error with suggestion when service is inactive', async () => {
      const mockExec = vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: 'systemd 245\n', stderr: '' })
        .mockReturnValueOnce({ status: 3, stdout: 'inactive\n', stderr: '' });
      const res = await checkSystemd({ exec: mockExec });
      if (process.platform === 'darwin') {
        expect(res.status).toBe('skip');
        expect(res.message).toContain('LaunchAgent');
      } else {
        expect(res.status).toBe('error');
        expect(res.message).toContain('không hoạt động (inactive)');
        expect(res.suggestion).toContain('agenthub install-service');
      }
    });
  });

  describe('checkMcp', () => {
    it('returns skip when claude command is not found', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: null,
        stdout: '',
        stderr: '',
        error: new Error('spawnSync claude ENOENT'),
      });
      const res = await checkMcp({ exec: mockExec });
      expect(res.status).toBe('skip');
      expect(res.message).toContain('Không có lệnh claude (bỏ qua)');
    });

    it('returns skip when exit code is 127', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: 127,
        stdout: '',
        stderr: 'claude: command not found',
      });
      const res = await checkMcp({ exec: mockExec });
      expect(res.status).toBe('skip');
      expect(res.message).toContain('Không có lệnh claude (bỏ qua)');
    });

    it('returns error when claude command times out after 10s', async () => {
      const err = new Error('timed out') as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      const mockExec = vi.fn().mockReturnValue({
        status: null,
        stdout: '',
        stderr: '',
        error: err,
      });
      const res = await checkMcp({ exec: mockExec });
      expect(res.status).toBe('error');
      expect(res.message).toContain('timeout 10 giây');
    });

    it('returns ok when output contains agenthub', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: 0,
        stdout: 'Checking MCP servers...\n- agenthub: stdio [running]\n',
        stderr: '',
      });
      const res = await checkMcp({ exec: mockExec });
      expect(res.status).toBe('ok');
      expect(res.message).toContain('Đã tìm thấy agenthub trong cấu hình Claude MCP');
    });

    it('returns error with suggestion when agenthub is not in mcp list', async () => {
      const mockExec = vi.fn().mockReturnValue({
        status: 0,
        stdout: 'No MCP servers configured.\n',
        stderr: '',
      });
      const res = await checkMcp({ exec: mockExec });
      expect(res.status).toBe('error');
      expect(res.message).toContain('Chưa cấu hình agenthub trong Claude MCP');
      expect(res.suggestion).toContain('agenthub mcp-install');
    });
  });

  describe('checkProfiles', () => {
    it('returns error when 0 profiles are found', async () => {
      const res = await checkProfiles({
        getProfileData: () => ({
          profiles: [],
          duplicateEmails: new Map(),
          activeQuotaMarks: [],
        }),
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('Chưa tìm thấy hồ sơ nào');
      expect(res.suggestion).toContain('agenthub profile login');
    });

    it('returns error with suggestion when an agy profile has no email (unauthenticated)', async () => {
      const res = await checkProfiles({
        getProfileData: () => ({
          profiles: [
            { name: 'chinh', engine: 'agy', kind: 'keyring', email: 'chinh@example.com', enabled: 1 },
            { name: 'g1', engine: 'agy', kind: 'isolated', email: null, enabled: 1 },
          ],
          duplicateEmails: new Map(),
          activeQuotaMarks: [],
        }),
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('có 1 hồ sơ chưa đăng nhập (g1)');
      expect(res.suggestion).toContain('agenthub profile login');
    });

    it('returns ok with details when all profiles are logged in', async () => {
      const duplicateEmails = new Map<string, string[]>();
      duplicateEmails.set('dup@example.com', ['chinh', 'g1']);

      const res = await checkProfiles({
        getProfileData: () => ({
          profiles: [
            { name: 'chinh', engine: 'agy', kind: 'keyring', email: 'dup@example.com', enabled: 1 },
            { name: 'g1', engine: 'agy', kind: 'isolated', email: 'dup@example.com', enabled: 1 },
            { name: 'codex', engine: 'codex', kind: 'codex', email: null, enabled: 1 },
          ],
          duplicateEmails,
          activeQuotaMarks: [
            { profileName: 'chinh', family: 'claude', until: Math.floor(Date.now() / 1000) + 3600 },
          ],
        }),
      });
      expect(res.status).toBe('ok');
      expect(res.message).toContain('3 hồ sơ (tất cả đã đăng nhập)');
      expect(res.message).toContain('1 nhóm trùng email');
      expect(res.message).toContain('1 quota mark còn hiệu lực');
      expect(res.suggestion).toContain('dup@example.com: chinh, g1');
    });
  });

  describe('checkPermissions', () => {
    it('returns error when hub directory does not exist', async () => {
      const res = await checkPermissions({
        hubHome: '/nonexistent/hub',
        tokenPath: '/nonexistent/hub/token',
        existsSync: () => false,
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('/nonexistent/hub không tồn tại');
      expect(res.suggestion).toContain('mkdir -m 700');
    });

    it('returns error when hub directory has wrong permissions (e.g. 775)', async () => {
      const res = await checkPermissions({
        hubHome: '/fake/hub',
        tokenPath: '/fake/hub/token',
        existsSync: () => true,
        statSync: (p: string) => {
          if (p === '/fake/hub') {
            return { mode: 0o775, isDirectory: () => true, isFile: () => false };
          }
          return { mode: 0o600, isDirectory: () => false, isFile: () => true };
        },
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('Thư mục /fake/hub có quyền 775 (yêu cầu 700)');
      expect(res.suggestion).toContain('chmod 700 /fake/hub');
    });

    it('returns error when token file does not exist', async () => {
      const res = await checkPermissions({
        hubHome: '/fake/hub',
        tokenPath: '/fake/hub/token',
        existsSync: (p: string) => p === '/fake/hub',
        statSync: () => ({ mode: 0o700, isDirectory: () => true, isFile: () => false }),
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('File token /fake/hub/token không tồn tại');
      expect(res.suggestion).toContain('chmod 600 /fake/hub/token');
    });

    it('returns error when token file has wrong permissions (e.g. 644)', async () => {
      const res = await checkPermissions({
        hubHome: '/fake/hub',
        tokenPath: '/fake/hub/token',
        existsSync: () => true,
        statSync: (p: string) => {
          if (p === '/fake/hub') {
            return { mode: 0o700, isDirectory: () => true, isFile: () => false };
          }
          return { mode: 0o644, isDirectory: () => false, isFile: () => true };
        },
      });
      expect(res.status).toBe('error');
      expect(res.message).toContain('File token /fake/hub/token có quyền 644 (yêu cầu 600)');
      expect(res.suggestion).toContain('chmod 600 /fake/hub/token');
    });

    it('returns ok when hub is 700 and token is 600', async () => {
      const res = await checkPermissions({
        hubHome: '/fake/hub',
        tokenPath: '/fake/hub/token',
        existsSync: () => true,
        statSync: (p: string) => {
          if (p === '/fake/hub') {
            return { mode: 0o700, isDirectory: () => true, isFile: () => false };
          }
          return { mode: 0o600, isDirectory: () => false, isFile: () => true };
        },
      });
      expect(res.status).toBe('ok');
      expect(res.message).toContain('đúng quyền bảo mật');
    });
  });

  describe('runDoctor orchestrator and formatters', () => {
    it('runs all checks and calculates summary accurately', async () => {
      const report = await runDoctor({
        node: { version: 'v22.2.0', execPath: '/bin/node' },
        git: { exec: () => ({ status: 0, stdout: 'git version 2.25.1\n', stderr: '' }) },
        engines: { agyPath: '/bin/agy', codexPath: '/bin/codex' },
        daemon: {
          port: 4800,
          tokenPath: '/fake/token',
          readToken: () => 'token',
          fetchFn: vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch,
        },
        systemd: {
          exec: vi.fn()
            .mockReturnValueOnce({ status: 0, stdout: 'systemd 245\n', stderr: '' })
            .mockReturnValueOnce({ status: 0, stdout: 'active\n', stderr: '' }),
        },
        mcp: {
          exec: () => ({ status: 0, stdout: 'agenthub running\n', stderr: '' }),
        },
        profiles: {
          getProfileData: () => ({
            profiles: [{ name: 'chinh', engine: 'agy', kind: 'keyring', email: 'chinh@example.com', enabled: 1 }],
            duplicateEmails: new Map(),
            activeQuotaMarks: [],
          }),
        },
        permissions: {
          hubHome: '/fake/hub',
          tokenPath: '/fake/hub/token',
          existsSync: () => true,
          statSync: (p: string) => ({
            mode: p === '/fake/hub' ? 0o700 : 0o600,
            isDirectory: () => p === '/fake/hub',
            isFile: () => p !== '/fake/hub',
          }),
        },
      });

      const isDarwin = process.platform === 'darwin';
      const expectedPassed = isDarwin ? 9 : 10;
      const expectedSkipped = isDarwin ? 1 : 0;

      expect(report.ok).toBe(true);
      expect(report.summary.total).toBe(10);
      expect(report.summary.passed).toBe(expectedPassed);
      expect(report.summary.skipped).toBe(expectedSkipped);
      expect(report.summary.failed).toBe(0);

      const text = formatDoctorText(report);
      expect(text).toContain('=== AgentHub Doctor ===');
      expect(text).toContain(`Tất cả ${expectedPassed}/10 mục kiểm tra đều đạt!`);

      const json = formatDoctorJson(report);
      const parsed = JSON.parse(json);
      expect(parsed.ok).toBe(true);
      expect(parsed.summary.passed).toBe(expectedPassed);
      expect(parsed.checks.length).toBe(10);
    });

    it('formats error suggestions in text output when issues exist', async () => {
      const report = await runDoctor({
        node: { version: 'v18.0.0', execPath: '/bin/node' },
        git: { exec: () => ({ status: 1, stdout: '', stderr: 'error' }) },
        engines: { agyPath: null, codexPath: null },
        daemon: { fetchFn: vi.fn().mockRejectedValue(new Error('fail')) as unknown as typeof fetch },
        systemd: { exec: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }) },
        mcp: { exec: () => ({ status: 0, stdout: 'none\n', stderr: '' }) },
        profiles: {
          getProfileData: () => ({
            profiles: [],
            duplicateEmails: new Map(),
            activeQuotaMarks: [],
          }),
        },
        permissions: { existsSync: () => false },
      });

      expect(report.ok).toBe(false);
      expect(report.summary.failed).toBeGreaterThan(0);

      const text = formatDoctorText(report);
      expect(text).toContain('✗');
      expect(text).toContain('↳ Gợi ý:');
      expect(text).toContain('mục lỗi');
    });
  });

  describe('cmdDoctor CLI', () => {
    it('executes cmdDoctor in text mode and returns report', async () => {
      const config = loadConfig(path.join(tmpHome, '.agenthub'));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const report = await cmdDoctor(config, [], {
        node: { version: 'v22.2.0', execPath: '/bin/node' },
        git: { exec: () => ({ status: 0, stdout: 'git version 2.25.1\n', stderr: '' }) },
        engines: { agyPath: '/bin/agy', codexPath: '/bin/codex' },
        daemon: {
          port: 4800,
          tokenPath: '/fake/token',
          readToken: () => 'token',
          fetchFn: vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch,
        },
        systemd: {
          exec: vi.fn()
            .mockReturnValueOnce({ status: 0, stdout: 'systemd 245\n', stderr: '' })
            .mockReturnValueOnce({ status: 0, stdout: 'active\n', stderr: '' }),
        },
        mcp: {
          exec: () => ({ status: 0, stdout: 'agenthub running\n', stderr: '' }),
        },
        profiles: {
          getProfileData: () => ({
            profiles: [{ name: 'chinh', engine: 'agy', kind: 'keyring', email: 'chinh@example.com', enabled: 1 }],
            duplicateEmails: new Map(),
            activeQuotaMarks: [],
          }),
        },
        permissions: {
          hubHome: '/fake/hub',
          tokenPath: '/fake/hub/token',
          existsSync: () => true,
          statSync: (p: string) => ({
            mode: p === '/fake/hub' ? 0o700 : 0o600,
            isDirectory: () => p === '/fake/hub',
            isFile: () => p !== '/fake/hub',
          }),
        },
      });

      expect(report.ok).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('=== AgentHub Doctor ===');
      consoleSpy.mockRestore();
    });

    it('executes cmdDoctor with --json flag and prints valid JSON', async () => {
      const config = loadConfig(path.join(tmpHome, '.agenthub'));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const report = await cmdDoctor(config, ['--json'], {
        node: { version: 'v22.2.0', execPath: '/bin/node' },
        git: { exec: () => ({ status: 0, stdout: 'git version 2.25.1\n', stderr: '' }) },
        engines: { agyPath: '/bin/agy', codexPath: '/bin/codex' },
        daemon: {
          port: 4800,
          tokenPath: '/fake/token',
          readToken: () => 'token',
          fetchFn: vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch,
        },
        systemd: {
          exec: vi.fn()
            .mockReturnValueOnce({ status: 0, stdout: 'systemd 245\n', stderr: '' })
            .mockReturnValueOnce({ status: 0, stdout: 'active\n', stderr: '' }),
        },
        mcp: {
          exec: () => ({ status: 0, stdout: 'agenthub running\n', stderr: '' }),
        },
        profiles: {
          getProfileData: () => ({
            profiles: [{ name: 'chinh', engine: 'agy', kind: 'keyring', email: 'chinh@example.com', enabled: 1 }],
            duplicateEmails: new Map(),
            activeQuotaMarks: [],
          }),
        },
        permissions: {
          hubHome: '/fake/hub',
          tokenPath: '/fake/hub/token',
          existsSync: () => true,
          statSync: (p: string) => ({
            mode: p === '/fake/hub' ? 0o700 : 0o600,
            isDirectory: () => p === '/fake/hub',
            isFile: () => p !== '/fake/hub',
          }),
        },
      });

      expect(report.ok).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      const jsonOutput = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(jsonOutput);
      expect(parsed.ok).toBe(true);
      const isDarwin = process.platform === 'darwin';
      expect(parsed.summary.passed).toBe(isDarwin ? 9 : 10);
      consoleSpy.mockRestore();
    });
  });
});
