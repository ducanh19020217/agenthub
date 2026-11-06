import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentHubConfig, ToolInstaller } from '../config.js';
import { findAgyPath, findCodexPath } from '../doctor.js';
import { findClaudeBin } from '../chat/claude.js';
import { agyInstallHint } from '../agy.js';

const execFileAsync = promisify(execFile);
export type SetupTool = 'claude' | 'codex' | 'agy';
type EventSink = { emit(type: string, taskId?: string, payload?: unknown): boolean };
type InstallSuccessHandler = (tool: SetupTool) => void;

export interface SetupToolStatus {
  id: SetupTool;
  installed: boolean;
  version: string | null;
  path: string | null;
  manual: boolean;
  docsUrl?: string;
  installing: boolean;
}

/** PATH của service macOS (launchd) có thể thiếu npm/node: thêm thư mục của Node đang chạy daemon vào cuối. */
function installPath(): string {
  const nodeDir = path.dirname(process.execPath);
  const current = process.env.PATH || '';
  return current.split(path.delimiter).includes(nodeDir) ? current : [current, nodeDir].filter(Boolean).join(path.delimiter);
}

export class SetupManager {
  private installing = new Set<SetupTool>();
  private readonly versionCache = new Map<SetupTool, { bin: string; version: string | null; checkedAt: number }>();
  private readonly versionChecks = new Map<SetupTool, Promise<string | null>>();
  private static readonly VERSION_CACHE_MS = 10 * 60 * 1000;
  constructor(private config: AgentHubConfig, private events?: EventSink, private onInstallSuccess?: InstallSuccessHandler) {}

  private binary(tool: SetupTool): string | null {
    if (tool === 'claude') return findClaudeBin(this.config.chat.claudeBin);
    if (tool === 'codex') return findCodexPath(this.config.hubHome);
    return findAgyPath(this.config.hubHome);
  }

  private installer(tool: SetupTool): ToolInstaller {
    return this.config.tools.installers[tool];
  }

  async status(): Promise<SetupToolStatus[]> {
    const result: SetupToolStatus[] = [];
    for (const id of ['claude', 'codex', 'agy'] as SetupTool[]) {
      const bin = this.binary(id);
      let version: string | null = null;
      if (bin) {
        const cached = this.versionCache.get(id);
        if (cached && cached.bin === bin && Date.now() - cached.checkedAt < SetupManager.VERSION_CACHE_MS) {
          version = cached.version;
        } else {
          version = await this.checkVersion(id, bin);
        }
      }
      const installer = this.installer(id);
      result.push({ id, installed: Boolean(bin), version, path: bin, manual: id === 'agy' && !installer.command, docsUrl: installer.docsUrl, installing: this.installing.has(id) });
    }
    return result;
  }

  private async checkVersion(id: SetupTool, bin: string): Promise<string | null> {
    const existing = this.versionChecks.get(id);
    if (existing) return existing;
    const check = (async () => {
      let version: string | null = null;
      try {
        const output = await execFileAsync(bin, this.installer(id).versionArgs || ['--version'], { timeout: 10_000 });
        version = `${output.stdout}`.trim().split(/\r?\n/)[0] || null;
      } catch {
        version = null;
      }
      this.versionCache.set(id, { bin, version, checkedAt: Date.now() });
      return version;
    })();
    this.versionChecks.set(id, check);
    try { return await check; } finally { this.versionChecks.delete(id); }
  }

  async install(tool: string): Promise<{ jobId: string }> {
    if (!['claude', 'codex', 'agy'].includes(tool)) throw new Error('Công cụ không nằm trong danh mục cài đặt');
    const id = tool as SetupTool;
    if (process.env.AGENTHUB_WORKER === '1') throw new Error('Không được cài công cụ trong worker');
    if (this.installing.has(id)) throw new Error(`Đang cài ${id}`);
    const installer = this.installer(id);
    if (!installer.package && !installer.command) throw new Error(`${id} chưa có bộ cài tự động; hãy cài thủ công${id === 'agy' ? ` bằng: ${agyInstallHint()}` : ''}`);
    const jobId = `setup-${id}-${Date.now()}`;
    this.installing.add(id);
    const logDir = path.join(this.config.hubHome, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `setup-${id}.log`);
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    const command = installer.command ? installer.command[0] : 'npm';
    const args = installer.command ? installer.command.slice(1) : ['install', '--prefix', path.join(this.config.hubHome, 'tools'), installer.package!];
    const child = spawn(command, args, { cwd: this.config.hubHome, env: { ...process.env, PATH: installPath(), AGENTHUB_TOOLS_DIR: path.join(this.config.hubHome, 'tools') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const emit = (type: string, payload: unknown) => this.events?.emit(type, undefined, { jobId, tool: id, ...((payload && typeof payload === 'object') ? payload : { line: String(payload) }) });
    emit('setup.install_progress', { line: `$ ${command} ${args.join(' ')}` });
    child.stdout.on('data', (chunk: Buffer) => { log.write(chunk); emit('setup.install_progress', { line: chunk.toString() }); });
    child.stderr.on('data', (chunk: Buffer) => { log.write(chunk); emit('setup.install_progress', { line: chunk.toString(), stderr: true }); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
    let finished = false;
    // spawn lỗi (vd. ENOENT khi service launchd không có npm trong PATH) phát 'error' thay vì 'close';
    // không bắt sẽ làm sập daemon và UI chờ install_done mãi.
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); log.write(`${error.message}\n`); log.end(); this.installing.delete(id);
      emit('setup.install_done', { ok: false, code: null, signal: null, path: null, logPath, error: `Không chạy được ${command}: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); log.end(); this.installing.delete(id);
      const installedBin = this.binary(id);
      const ok = code === 0 && Boolean(installedBin);
      if (ok) {
        try {
          this.versionCache.delete(id);
          this.onInstallSuccess?.(id);
        } catch (error) {
          emit('setup.install_refresh_error', { error: error instanceof Error ? error.message : String(error) });
        }
      }
      emit('setup.install_done', {
        ok,
        code,
        signal,
        path: installedBin,
        logPath,
        error: code === 0 && !installedBin
          ? `Đã chạy xong nhưng chưa tìm thấy ${id}. Kiểm tra PATH của service hoặc cấu hình AGENTHUB_AGY_BIN.`
          : undefined,
      });
    });
    return { jobId };
  }

  getSetupState(): { setupCompletedAt?: string; setupSkippedAt?: string } {
    const raw = this.readConfig();
    return { setupCompletedAt: typeof raw.setupCompletedAt === 'string' ? raw.setupCompletedAt : undefined, setupSkippedAt: typeof raw.setupSkippedAt === 'string' ? raw.setupSkippedAt : undefined };
  }

  getLogPath(tool: string): string | null {
    if (!['claude', 'codex', 'agy'].includes(tool)) return null;
    const logPath = path.join(this.config.hubHome, 'logs', `setup-${tool}.log`);
    return fs.existsSync(logPath) ? logPath : null;
  }

  complete(skip = false): { setupCompletedAt?: string; setupSkippedAt?: string } {
    const key = skip ? 'setupSkippedAt' : 'setupCompletedAt';
    const value = new Date().toISOString();
    const raw = this.readConfig();
    delete raw[skip ? 'setupCompletedAt' : 'setupSkippedAt']; raw[key] = value;
    fs.writeFileSync(this.config.configFilePath, JSON.stringify(raw, null, 2));
    return this.getSetupState();
  }

  private readConfig(): Record<string, unknown> {
    if (!fs.existsSync(this.config.configFilePath)) return {};
    try { return JSON.parse(fs.readFileSync(this.config.configFilePath, 'utf8')) as Record<string, unknown>; } catch { return {}; }
  }
}
