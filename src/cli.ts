#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, AgentHubConfig } from './config.js';
import { agyInstallHint, applyIsolatedAgyEnv, findAgyBin } from './agy.js';
import { createContext, closeContext, startDaemon } from './daemon.js';
import { runMcpServer } from './mcp/index.js';
import { getOrCreateToken, getTokenPath, readExistingToken } from './auth.js';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AgyEngine } from './engines/index.js';
import { runDoctor, formatDoctorText, formatDoctorJson, DoctorReport } from './doctor.js';
import { cmdBrain } from './brain.js';
import { WorktreeService } from './worktrees/index.js';
import { parseCodexTokens } from './savings.js';
import { getLockFileInfo, hashFile, getCacheNodeModulesDir, areDirectoriesHardLinked, verifyNativeModules } from './cache.js';
import { findClaudeBin } from './chat/claude.js';
import { mcpAddArgs, runMcpInstall } from './tools/mcp-install.js';
import { findProcessesInDir } from './reaper.js';
import { measureProcessTree } from './process-tree.js';
import { getPlatform } from './platform/index.js';
import { cmdVersion, cmdUpdate, cmdUninstallService, compareSemver } from './update.js';
import { PerfCollector, formatPerfTable } from './perf.js';
import { projectWorktreeRoots } from './projects/paths.js';

export { cmdVersion, cmdUpdate, cmdUninstallService, compareSemver };
import { assertWorkerMayControlHub } from './worker-guard.js';
import { SetupManager } from './tools/setup.js';
import { cleanupStaleAgentHubTempDirs, inspectAgentHubTempDirs, AGENTHUB_TEMP_MAX_AGE_MS } from './temp-cleanup.js';

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];

export function findProjectRoot(startDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let curr = startDir;
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(startDir, '..');
}

export type OpenFn = (file: string, args: string[], callback?: (err: Error | null) => void) => void;

export async function cmdOpen(
  config: AgentHubConfig,
  extraArgs: string[] = [],
  openFn?: OpenFn,
): Promise<string> {
  const token = getOrCreateToken(config.tokenPath || getTokenPath());
  const port = config.port;
  const url = `http://127.0.0.1:${port}/#token=${token}`;
  console.log(`AgentHub UI URL:\n${url}`);
  const noBrowser = extraArgs.includes('--no-browser') || process.env.AGENTHUB_NO_BROWSER === '1';
  if (!noBrowser) {
    try {
      // Linux implementation delegates to execFile('xdg-open', [url]); macOS uses open.
      getPlatform().openBrowser(url, openFn);
    } catch {
      // Ignore in headless environments
    }
  }
  return url;
}

export async function cmdInstallService(extraArgs: string[], projectRootOverride?: string): Promise<string> {
  const isPrint = extraArgs.includes('--print');
  const projectRoot = projectRootOverride || findProjectRoot();
  const cliPath = path.resolve(projectRoot, 'dist', 'cli.js');
  const nodePath = process.execPath;
  const currentPath = process.env.PATH || '';

  const result = getPlatform().installService({ nodePath, cliPath, currentPath, homeDir: os.homedir(), print: isPrint });

  if (isPrint) {
    const output = `File: ${result.file}\n\n${result.content}\nCác lệnh kích hoạt:\n  ${result.activate}`;
    console.log(output);
    return output;
  }

  if (result.skipped) {
    console.log(`! ${result.message || 'Không có service nền tảng'}`);
    return result.content;
  }

  console.log(`✓ Đã tạo service file tại ${result.file}`);
  console.log(`✓ Đã bật và khởi chạy service agenthub (${result.activate})`);
  return result.content;
}

function serviceManager(): { bin: string; args: (action: string, disable?: boolean) => string[] } {
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? '';
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.agenthub.plist');
    return {
      bin: process.env.AGENTHUB_LAUNCHCTL || 'launchctl',
      args: (action, disable) => {
        if (action === 'start') {
          return ['bootstrap', `gui/${uid}`, plistPath];
        }
        if (disable) {
          return ['unload', plistPath];
        }
        return ['bootout', `gui/${uid}/dev.agenthub`];
      },
    };
  }
  const bin = process.env.AGENTHUB_SYSTEMCTL_BIN || process.env.AGENTHUB_SYSTEMCTL || 'systemctl';
  return {
    bin,
    args: (action) => {
      if (action === 'start') {
        return ['--user', 'enable', '--now', 'agenthub'];
      }
      return ['--user', 'stop', 'agenthub'];
    },
  };
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getAliveProcesses(
  daemonPid?: number,
  childPids: number[] = [],
  worktreesDir?: string,
): number[] {
  const alive = new Set<number>();

  if (daemonPid && isPidAlive(daemonPid)) {
    alive.add(daemonPid);
  }
  for (const pid of childPids) {
    if (isPidAlive(pid)) {
      alive.add(pid);
    }
  }
  if (worktreesDir && fs.existsSync(worktreesDir)) {
    try {
      const dirPids = findProcessesInDir(worktreesDir);
      for (const pid of dirPids) {
        if (isPidAlive(pid)) alive.add(pid);
      }
    } catch { /* ignore */ }
  }
  if (daemonPid && isPidAlive(daemonPid)) {
    try {
      const tree = measureProcessTree(daemonPid);
      for (const pid of tree.pids) {
        if (isPidAlive(pid)) alive.add(pid);
      }
    } catch { /* ignore */ }
  }

  return Array.from(alive);
}

export async function cleanRemainingProcesses(
  daemonPid?: number,
  childPids: number[] = [],
  worktreesDir?: string,
  timeoutMs = Number(process.env.AGENTHUB_STOP_TIMEOUT_MS) || 30_000,
  pollIntervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let termSent = false;
  let killSent = false;

  while (Date.now() < deadline) {
    const remaining = getAliveProcesses(daemonPid, childPids, worktreesDir);
    if (remaining.length === 0) {
      return;
    }

    const elapsed = Date.now() - (deadline - timeoutMs);

    // After a short wait (1s or immediately if short timeout), send SIGTERM
    if (!termSent && (elapsed >= 1000 || timeoutMs <= 2000)) {
      termSent = true;
      for (const pid of remaining) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* ignore */ }
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
      }
    }

    // When approaching deadline (remaining <= 5s or elapsed >= 1500 for short timeout), send SIGKILL
    if (!killSent && elapsed >= Math.max(1500, timeoutMs - 5000)) {
      killSent = true;
      for (const pid of remaining) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Final sweep: if any processes still alive, send SIGKILL
  const finalRemaining = getAliveProcesses(daemonPid, childPids, worktreesDir);
  for (const pid of finalRemaining) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

async function hubRequest(config: AgentHubConfig, method: string, endpoint: string, body?: unknown): Promise<Response> {
  const token = readExistingToken(config.tokenPath || getTokenPath());
  if (!token) throw new Error('Không tìm thấy token AgentHub; service có thể chưa được cài đặt.');
  return fetch(`http://127.0.0.1:${config.port}${endpoint}`, {
    method,
    headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${config.port}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function cmdStop(config: AgentHubConfig, extraArgs: string[] = []): Promise<void> {
  const disable = extraArgs.includes('--disable');
  let daemonPid: number | undefined;
  let childPids: number[] = [];

  try {
    const response = await hubRequest(config, 'POST', '/api/hub/shutdown', { disable });
    if (!response.ok) throw new Error(`API shutdown trả về HTTP ${response.status}`);
    const result = await response.json() as {
      queued?: number;
      reviewers?: number;
      daemonPid?: number;
      childPids?: number[];
    };
    daemonPid = result.daemonPid;
    if (Array.isArray(result.childPids)) {
      childPids = result.childPids;
    }
    console.log(`✓ Đã lưu trạng thái và tắt AgentHub (${result.queued || 0} task sẽ tiếp tục từ hàng chờ).`);
  } catch (error) {
    console.error(`! Không gọi được daemon: ${error instanceof Error ? error.message : String(error)}`);
    const manager = serviceManager();
    let serviceActive = true;
    try {
      const output = execFileSync(manager.bin, process.platform === 'darwin'
        ? ['print', `gui/${process.getuid?.() ?? ''}/dev.agenthub`]
        : ['--user', 'is-active', 'agenthub'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
      serviceActive = process.platform === 'darwin' ? output.trim().length > 0 : output.trim() === 'active';
    } catch {
      serviceActive = false;
    }
    if (serviceActive) {
      throw new Error('Không thể tắt an toàn: daemon vẫn đang chạy nhưng API shutdown thất bại; task có thể bị cắt ngang.');
    }
    console.log('✓ Daemon đã tắt; tiếp tục dọn service còn sót.');
  }

  const manager = serviceManager();
  try {
    execFileSync(manager.bin, manager.args('stop', disable), { stdio: 'inherit', timeout: 30_000 });
    if (disable) {
      if (process.platform === 'darwin') {
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.agenthub.plist');
        try {
          execFileSync(manager.bin, ['unload', plistPath], { stdio: 'inherit', timeout: 30_000 });
        } catch { /* ignore if already unloaded */ }
      } else {
        execFileSync(manager.bin, ['--user', 'disable', 'agenthub'], { stdio: 'inherit', timeout: 30_000 });
      }
    }
  } catch (error) {
    // Nếu không có systemd hoặc gọi service manager thất bại, thử kill PID khi không có systemd
    if (daemonPid && isPidAlive(daemonPid)) {
      try { process.kill(-daemonPid, 'SIGTERM'); } catch { /* ignore */ }
      try { process.kill(daemonPid, 'SIGTERM'); } catch { /* ignore */ }
    } else {
      throw new Error(`Không thể dừng service (${manager.bin}): ${error instanceof Error ? error.message : String(error)}. Service đã cài chưa?`);
    }
  }

  // Chờ tối đa 30 giây. Còn tiến trình con nào thì SIGTERM, rồi SIGKILL.
  await cleanRemainingProcesses(daemonPid, childPids, config.worktreesDir);

  console.log(`✓ AgentHub đã tắt${disable ? ' và không tự bật khi đăng nhập' : ''}.`);
}

export async function cmdStart(config: AgentHubConfig): Promise<void> {
  const manager = serviceManager();
  try {
    execFileSync(manager.bin, manager.args('start'), { stdio: 'inherit', timeout: 30_000 });
  } catch (error) {
    throw new Error(`Không thể khởi động service (${manager.bin}): ${error instanceof Error ? error.message : String(error)}. Hãy chạy agenthub install-service.`);
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/health`);
      if (response.ok && (await response.json() as { ok?: boolean }).ok) {
        console.log(`✓ AgentHub đang chạy: http://127.0.0.1:${config.port}`);
        return;
      }
    } catch { /* daemon is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('AgentHub đã được bật nhưng /health chưa trả về ok sau 30 giây.');
}

export async function cmdMcpInstall(extraArgs: string[]): Promise<string> {
  const isPrint = extraArgs.includes('--print');
  const projectRoot = findProjectRoot();
  const cliPath = path.resolve(projectRoot, 'dist', 'cli.js');
  const nodePath = process.execPath;
  // Claude có thể nằm trong Node khác (nvm) so với Node đang chạy AgentHub: dùng đường dẫn tuyệt đối.
  const claudeBin = findClaudeBin(process.env.AGENTHUB_CLAUDE_BIN);
  const command = `${claudeBin ?? 'claude'} ${mcpAddArgs(nodePath, cliPath).join(' ')}`;

  if (isPrint) {
    console.log(`Lệnh đăng ký MCP:\n  ${command}`);
    return command;
  }
  if (!claudeBin) {
    throw new Error('Không tìm thấy Claude Code. Hãy cài Claude Code rồi chạy lại `agenthub mcp-install`.');
  }

  const output = await runMcpInstall({ claudeBin, nodePath, cliPath });
  if (output.trim()) console.log(output.trim());
  console.log('✓ Đã đăng ký MCP server với Claude Code');
  return command;
}

export async function cmdLink(): Promise<string> {
  const projectRoot = findProjectRoot();
  const wrapperPath = path.resolve(projectRoot, 'bin', 'agenthub');
  const targetDir = process.env.AGENTHUB_LINK_DIR || path.join(os.homedir(), '.local', 'bin');
  const targetPath = path.join(targetDir, 'agenthub');

  fs.mkdirSync(targetDir, { recursive: true });
  try {
    if (fs.existsSync(targetPath) || fs.lstatSync(targetPath).isSymbolicLink()) {
      fs.unlinkSync(targetPath);
    }
  } catch {
    // ignore
  }

  fs.symlinkSync(wrapperPath, targetPath);
  console.log(`✓ Đã tạo symlink: ${targetPath} -> ${wrapperPath}`);
  return targetPath;
}

export async function cmdDoctor(
  config: AgentHubConfig,
  extraArgs: string[] = [],
  doctorDeps?: Parameters<typeof runDoctor>[0],
): Promise<DoctorReport> {
  const isJson = extraArgs.includes('--json');
  const report = await runDoctor(doctorDeps);
  if (isJson) {
    console.log(formatDoctorJson(report));
  } else {
    console.log(formatDoctorText(report));
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
  return report;
}

export async function cmdPerf(extraArgs: string[] = []): Promise<void> {
  const raw = extraArgs.find((arg) => arg.startsWith('--seconds='))?.slice('--seconds='.length)
    || (extraArgs.includes('--seconds') ? extraArgs[extraArgs.indexOf('--seconds') + 1] : '60');
  const seconds = Math.max(0, Math.min(3600, Number(raw) || 60));
  const collector = new PerfCollector(Math.max(2, Math.ceil(seconds / 30) + 1));
  collector.sample();
  if (seconds > 0) await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
  const samples = collector.getSamples();
  if (extraArgs.includes('--json')) console.log(JSON.stringify({ samples }, null, 2));
  else console.log(formatPerfTable(samples));
}

export async function cmdRollback(extraArgs: string[] = [], projectRootOverride?: string): Promise<string> {
  const currentRoot = projectRootOverride || findProjectRoot();
  const appRoot = path.dirname(currentRoot);
  const currentLink = path.join(appRoot, 'current');
  if (!fs.existsSync(currentLink) || !fs.lstatSync(currentLink).isSymbolicLink()) {
    throw new Error(`Không tìm thấy layout release tại ${appRoot}.`);
  }
  const candidates = fs.readdirSync(appRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && /^\d+\.\d+\.\d+(?:[-+.].*)?$/.test(entry.name))
    .filter((entry) => fs.existsSync(path.join(appRoot, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort((a, b) => compareSemver(b, a));
  const requested = extraArgs[0]?.replace(/^v/, '');
  const target = requested && candidates.includes(requested)
    ? requested
    : candidates.find((version) => version !== path.basename(currentRoot));
  if (!target) throw new Error('Không có bản release cũ để rollback.');
  if (requested && !candidates.includes(requested)) throw new Error(`Không tìm thấy release v${requested}.`);

  fs.unlinkSync(currentLink);
  fs.symlinkSync(target, currentLink);
  await cmdInstallService([], path.join(appRoot, target));
  console.log(`✓ Đã rollback AgentHub về v${target}`);
  return target;
}

export async function cmdSetup(config: AgentHubConfig, extraArgs: string[] = []): Promise<void> {
  console.log('==> Thiết lập AgentHub lần đầu');
  const setup = new SetupManager(config);
  const installArg = extraArgs.find((arg) => arg.startsWith('--install='))?.slice('--install='.length) || (extraArgs.includes('--install') ? extraArgs[extraArgs.indexOf('--install') + 1] : undefined);
  const installRequested = installArg?.split(',').filter(Boolean) || [];
  const yes = extraArgs.includes('--yes');
  for (const tool of await setup.status()) console.log(`  ${tool.installed ? '✓' : '!'} ${tool.id}: ${tool.installed ? `${tool.version || 'đã tìm thấy'} (${tool.path})` : tool.manual ? `cài thủ công — ${tool.docsUrl || 'xem hướng dẫn'}` : 'chưa tìm thấy'}`);
  if (installRequested.length > 0 && !yes) {
    throw new Error('Cần xác nhận cài đặt; dùng `agenthub setup --install=claude,codex --yes`');
  }
  for (const tool of installRequested) {
    const status = (await setup.status()).find((item) => item.id === tool);
    if (status?.installed) { console.log(`✓ ${tool} đã có sẵn`); continue; }
    const { jobId } = await setup.install(tool);
    console.log(`✓ Đã khởi chạy bộ cài ${tool} (${jobId})`);
  }

  const tokenPath = config.tokenPath || getTokenPath();
  getOrCreateToken(tokenPath);
  console.log(`✓ Đã chuẩn bị token tại ${tokenPath}`);
  if (process.env.AGENTHUB_WORKER === '1') {
    console.log('! Bỏ qua cài service trong worker/test mode');
  } else {
    await cmdInstallService([]);
  }
  await cmdOpen(config, extraArgs.includes('--no-browser') ? ['--no-browser'] : []);
  console.log('Tiếp theo: mở trang Profiles để đăng nhập worker, rồi chạy `agenthub mcp-install` để kết nối Claude Code.');
}

export async function cmdCleanTmp(extraArgs: string[] = []): Promise<void> {
  const dryRun = extraArgs.includes('--dry-run');
  const entries = await inspectAgentHubTempDirs();
  const stale = entries.filter((entry) => entry.owned && entry.ageMs >= AGENTHUB_TEMP_MAX_AGE_MS);
  const safe = stale.filter((entry) => !entry.containsGit);
  const skipped = stale.filter((entry) => entry.containsGit);
  const bytes = safe.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  console.log(`Tìm thấy ${entries.length} thư mục agenthub-*; đủ tuổi dọn: ${stale.length}; dung lượng an toàn: ${bytes} bytes.`);
  for (const entry of skipped) console.log(`Bỏ qua repo git: ${entry.path}`);
  if (dryRun) {
    for (const entry of safe) console.log(`Có thể xoá: ${entry.path} (${entry.sizeBytes} bytes)`);
    console.log(`Dry run: sẽ xoá ${safe.length} thư mục, giải phóng ${bytes} bytes.`);
    return;
  }
  const removed = await cleanupStaleAgentHubTempDirs();
  console.log(`Đã xoá ${removed.length} thư mục, giải phóng khoảng ${bytes} bytes.`);
}

async function main() {
  const config = loadConfig();
  if (command === 'install-service' || command === 'uninstall' || command === 'stop' || command === 'start' || command === 'update' || (command === 'daemon' && subcommand === 'stop')) {
    assertWorkerMayControlHub(command === 'daemon' ? 'daemon stop' : command);
  }

  switch (command) {
    case 'daemon':
      await startDaemon(config);
      break;

    case 'mcp':
      await runMcpServer();
      break;

    case 'open':
      await cmdOpen(config, args.slice(1));
      break;

    case 'setup':
      await cmdSetup(config, args.slice(1));
      break;

    case 'rollback':
      await cmdRollback(args.slice(1));
      break;

    case 'update':
      await cmdUpdate(config, args.slice(1));
      break;

    case 'version':
    case '-v':
    case '--version':
      await cmdVersion(config, args.slice(1));
      break;

    case 'install-service':
      await cmdInstallService(args.slice(1));
      break;

    case 'stop':
      await cmdStop(config, args.slice(1));
      break;

    case 'start':
      await cmdStart(config);
      break;

    case 'uninstall-service':
      await cmdUninstallService(args.slice(1));
      break;

    case 'mcp-install':
      await cmdMcpInstall(args.slice(1));
      break;

    case 'link':
      await cmdLink();
      break;

    case 'doctor':
      await cmdDoctor(config, args.slice(1));
      break;

    case 'perf':
      await cmdPerf(args.slice(1));
      break;

    case 'status':
      await cmdStatus(config);
      break;

    case 'config':
      await cmdConfig(config, subcommand, args.slice(2));
      break;

    case 'clean':
      await cmdClean(config, args.slice(1));
      break;

    case 'clean-tmp':
      await cmdCleanTmp(args.slice(1));
      break;

    case 'usage':
      await cmdUsage(config);
      break;

    case 'profile':
      await cmdProfile(config, subcommand, args.slice(2));
      break;

    case 'project':
      await cmdProject(config, subcommand, args.slice(2));
      break;

    case 'task':
      await cmdTask(config, subcommand, args.slice(2));
      break;

    case 'review':
      await cmdReview(config, args.slice(1));
      break;

    case 'brain':
      await cmdBrain(config, args.slice(1));
      break;
    case 'savings':
      await cmdSavings(config, subcommand, args.slice(2));
      break;

    case 'claude-sessions':
      await cmdClaudeSessions(config, args.slice(1));
      break;
    case 'claude-failover':
      await cmdClaudeFailover(config, args.slice(1));
      break;
    case 'note':
      await cmdNote(config, args.slice(1));
      break;
    case 'notes':
      await cmdNotes(config, args.slice(1));
      break;

    default:
      console.log(`AgentHub - Quản lý worker AI

Cách dùng:
  agenthub daemon                     Chạy daemon AgentHub
  agenthub mcp                        Chạy MCP server (stdio transport)
  agenthub open                       Mở giao diện web trong trình duyệt
  agenthub setup [--no-browser]       Thiết lập lần đầu, service và dashboard
  agenthub rollback [version]         Quay lại bản release trước đó
  agenthub update                     Cập nhật AgentHub lên phiên bản mới nhất
  agenthub version [--check]          Xem phiên bản và kiểm tra cập nhật mới
  agenthub install-service [--print]  Cài đặt systemd/LaunchAgent user service
  agenthub uninstall-service          Gỡ bỏ service chạy nền của AgentHub
  agenthub stop [--disable]           Tắt AgentHub và lưu task đang chạy để tiếp tục
  agenthub start                       Bật AgentHub và chờ daemon sẵn sàng
  agenthub mcp-install [--print]      Đăng ký MCP server với Claude Code
  agenthub link                       Tạo symlink vào ~/.local/bin/agenthub
  agenthub doctor [--json]            Kiểm tra môi trường và cấu hình hệ thống
  agenthub perf [--seconds 60] [--json] Đo CPU/RSS theo nhóm tiến trình
  agenthub status                     Xem trạng thái
  agenthub clean [--dry-run] [--dedupe] Dọn hoặc dedupe node_modules của worktree
  agenthub clean-tmp [--dry-run]   Liệt kê/xoá thư mục tạm agenthub an toàn
  agenthub usage                      Xem usage quota các hồ sơ
  agenthub profile list|check|login|add|import-tokens|rename|remove   Quản lý hồ sơ
  agenthub project add <name> <path>  Thêm project
  agenthub task add|list|show|log     Quản lý task
  agenthub review <id> --approve [--merge]  Duyệt task, có thể merge vào base worktree
  agenthub brain <act> "<detail>" [--task id] Cập nhật trạng thái Claude
  agenthub savings import-legacy [dir] Nhập lịch sử token từ log cũ
  agenthub savings backfill-lines [--project x] Tính lại số dòng cho các task có nhánh còn tồn tại
  agenthub claude-sessions --summary  Tóm tắt phiên Claude và chi phí 24 giờ qua
  agenthub claude-failover [status|clear] Xem hoặc tắt failover Claude
  agenthub note "<nội dung>"          Gửi ghi chú từ task đang chạy
  agenthub notes [--since <id>]       Xem ghi chú của các task đang chạy cùng project
`);
  }
}

async function cmdClaudeFailover(config: ReturnType<typeof loadConfig>, extraArgs: string[]): Promise<void> {
  const ctx = createContext(config);
  try {
    const failover = ctx.service.getClaudeFailover();
    if ((extraArgs[0] || 'status') === 'clear') {
      console.log('✓ Đã tắt failover Claude');
      ctx.service.clearClaudeFailover();
      return;
    }
    console.log(`Failover Claude: ${failover.active ? 'ĐANG BẬT' : 'đang tắt'}`);
    if (failover.until) console.log(`Hết hạn: ${new Date(failover.until * 1000).toISOString()}`);
    if (failover.reason) console.log(`Lý do: ${failover.reason}`);
    if (failover.evidence) console.log(`Bằng chứng: ${failover.evidence.file}:${failover.evidence.line} (${failover.evidence.observedAt})`);
    if (failover.lastActivityAt) console.log(`Claude hoạt động cuối: ${failover.lastActivityAt}`);
  } finally {
    ctx.db.close();
  }
}

async function cmdConfig(config: AgentHubConfig, action: string | undefined, values: string[]): Promise<void> {
  if (action !== 'set' || values[0] !== 'branding.name' || !values.slice(1).join(' ').trim()) {
    console.log('Cách dùng: agenthub config set branding.name "Tên hiển thị"');
    return;
  }
  const name = values.slice(1).join(' ').trim();
  if (name.length > 80) throw new Error('Tên thương hiệu tối đa 80 ký tự');
  saveConfig(config.hubHome, { branding: { name } });
  config.branding.name = name;
  console.log(`✓ Đã đổi tên hiển thị thành ${name}`);
}

async function cmdClaudeSessions(config: ReturnType<typeof loadConfig>, extraArgs: string[]): Promise<void> {
  if (!extraArgs.includes('--summary')) return;
  const ctx = createContext(config);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sessions = ctx.db.prepare('SELECT COUNT(*) count FROM claude_sessions').get() as { count: number };
  const total = ctx.db.prepare('SELECT COALESCE(SUM(effective),0) effectiveTokens FROM claude_usage WHERE ts >= ?').get(since) as { effectiveTokens: number };
  const tasks = ctx.db.prepare('SELECT ctu.taskId, SUM(ctu.effectiveTokens) effectiveTokens FROM claude_task_usage ctu JOIN (SELECT DISTINCT sessionId,turnId FROM claude_usage WHERE ts >= ?) cu ON cu.sessionId=ctu.sessionId AND cu.turnId=ctu.turnId GROUP BY ctu.taskId ORDER BY effectiveTokens DESC LIMIT 5').all(since) as Array<{ taskId: string; effectiveTokens: number }>;
  console.log(`Phiên Claude: ${sessions.count}`);
  console.log(`Token hiệu dụng 24 giờ qua: ${Number(total.effectiveTokens).toLocaleString()}`);
  console.log('Task tốn nhiều nhất:');
  for (const task of tasks) console.log(`  ${task.taskId}: ${Math.round(task.effectiveTokens).toLocaleString()}`);
  ctx.db.close();
}

async function cmdUsage(config: ReturnType<typeof loadConfig>) {
  const ctx = createContext(config);
  ctx.profileService.registerAll();
  for (const p of ctx.profileRepo.getAll()) {
    const rows = ctx.usageService.getForProfile(p.name);
    console.log(`${p.name} (${p.engine}): ${rows.length ? rows.map((r) => `${r.grp} ${r.window} ${r.remainingPct}% reset ${new Date(r.resetAt * 1000).toISOString()}`).join(' · ') : '(chưa có dữ liệu)'}`);
  }
  ctx.db.close();
}

export async function cmdStatus(config: ReturnType<typeof loadConfig>) {
  const ctx = createContext(config);
  ctx.profileService.registerAll();

  const profiles = ctx.profileRepo.getAll();
  const tasks = ctx.taskRepo.getAll();
  const quotaMarks = ctx.quotaMarkRepo.getActive();

  const byStatus: Record<string, number> = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }

  console.log('=== AgentHub Status ===\n');
  const manager = serviceManager();
  let serviceRunning = false;
  let serviceEnabled = false;
  let serviceInstalled = true;
  try {
    if (process.platform === 'darwin') {
      const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.agenthub.plist');
      serviceInstalled = fs.existsSync(plist);
      serviceRunning = serviceInstalled && execFileSync(manager.bin, ['print', `gui/${process.getuid?.() ?? ''}/dev.agenthub`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).length > 0;
      serviceEnabled = serviceInstalled;
    } else {
      const serviceFile = path.join(os.homedir(), '.config', 'systemd', 'user', 'agenthub.service');
      const serviceFileExists = fs.existsSync(serviceFile);
      const isCustomBin = Boolean(process.env.AGENTHUB_SYSTEMCTL_BIN || process.env.AGENTHUB_SYSTEMCTL);
      let activeOk = false;
      try {
        const activeOut = execFileSync(manager.bin, ['--user', 'is-active', 'agenthub'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        serviceRunning = activeOut === 'active';
        activeOk = true;
      } catch (err: unknown) {
        serviceRunning = false;
        const msg = String(err);
        if (msg.includes('not-found') || msg.includes('could not be found') || msg.includes('Unit agenthub.service could not be found')) {
          serviceInstalled = false;
        }
      }
      try {
        const enabledOut = execFileSync(manager.bin, ['--user', 'is-enabled', 'agenthub'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        serviceEnabled = enabledOut === 'enabled';
      } catch (err: unknown) {
        serviceEnabled = false;
        const msg = String(err);
        if (msg.includes('not-found') || msg.includes('could not be found') || msg.includes('Unit agenthub.service could not be found') || msg.includes('No such file')) {
          serviceInstalled = false;
        }
      }
      if (!isCustomBin && !serviceFileExists && !serviceRunning && !activeOk) {
        serviceInstalled = false;
      }
    }
  } catch {
    serviceInstalled = false;
  }

  if (!serviceInstalled) {
    console.log('Service: chưa cài đặt (chạy \'agenthub install-service\' để cài đặt)');
    console.log('Tự bật khi đăng nhập: chưa cài đặt');
  } else {
    console.log(`Service: ${serviceRunning ? 'đang chạy' : 'đã tắt'}`);
    console.log(`Tự bật khi đăng nhập: ${serviceEnabled ? 'có' : 'không'}`);
  }
  console.log(`Worker đang chạy: ${tasks.filter((task) => task.status === 'running' || task.status === 'checking').length}`);
  console.log(`Hồ sơ: ${profiles.length}`);
  console.log(`Quota marks đang hoạt động: ${quotaMarks.length}`);
  console.log(`\nTask:`);
  for (const [status, count] of Object.entries(byStatus)) {
    console.log(`  ${status}: ${count}`);
  }
  if (Object.keys(byStatus).length === 0) {
    console.log('  (không có task)');
  }

  ctx.db.close();
}

export async function cmdClean(
  config: ReturnType<typeof loadConfig>,
  extraArgs: string[] = [],
): Promise<{ tasks: number; removed: number; freedBytes: number; deduplicated?: number; savedBytes?: number }> {
  const dryRun = extraArgs.includes('--dry-run');
  const dedupe = extraArgs.includes('--dedupe');
  const ctx = createContext(config);
  const worktrees = new WorktreeService(config);
  let tasks = 0;
  let removed = 0;
  let freedBytes = 0;
  let deduplicated = 0;
  let savedBytes = 0;

  try {
    if (dedupe) {
      const worktreePaths = new Set<string>();
      for (const task of ctx.taskRepo.getAll()) {
        if (task.worktreePath && fs.existsSync(task.worktreePath)) {
          worktreePaths.add(task.worktreePath);
        }
      }
      if (fs.existsSync(config.worktreesDir)) {
        try {
          for (const projId of fs.readdirSync(config.worktreesDir)) {
            const projDir = path.join(config.worktreesDir, projId);
            if (fs.statSync(projDir).isDirectory()) {
              for (const slug of fs.readdirSync(projDir)) {
                const wtDir = path.join(projDir, slug);
                if (fs.existsSync(wtDir) && fs.statSync(wtDir).isDirectory()) {
                  worktreePaths.add(wtDir);
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }
      for (const project of ctx.projectRepo.getAll()) {
        const roots = projectWorktreeRoots(project, config.hubHome, config.worktreesDir);
        for (const root of roots) {
          try {
            if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
            for (const slug of fs.readdirSync(root)) {
              if (slug === '.integration' || slug === '.logs') continue;
              const wtDir = path.join(root, slug);
              if (fs.existsSync(wtDir) && fs.statSync(wtDir).isDirectory()) worktreePaths.add(wtDir);
            }
          } catch {
            // ignore
          }
        }
      }

      for (const wtPath of worktreePaths) {
        tasks++;
        const targetDirs = [wtPath, path.join(wtPath, 'web')];
        for (const dir of targetDirs) {
          const lockInfo = getLockFileInfo(dir);
          const nmDir = path.join(dir, 'node_modules');
          if (!lockInfo || !fs.existsSync(nmDir)) continue;

          const lockHash = hashFile(lockInfo.path);
          const cacheEntryDir = path.join(config.cacheDir, lockHash);
          let cacheNm = getCacheNodeModulesDir(cacheEntryDir);

          // If cache doesn't have it, populate cache from this worktree's node_modules
          if (!cacheNm && !dryRun) {
            fs.mkdirSync(cacheEntryDir, { recursive: true });
            const targetCacheNm = path.join(cacheEntryDir, 'node_modules');
            try {
              execFileSync('cp', ['-al', nmDir, targetCacheNm]);
              cacheNm = targetCacheNm;
            } catch {
              continue;
            }
          }
          if (!cacheNm) continue;

          // Check if already hard-linked
          if (areDirectoriesHardLinked(nmDir, cacheNm)) {
            continue;
          }

          const size = worktrees.getDirectorySize(nmDir);
          if (!dryRun) {
            fs.rmSync(nmDir, { recursive: true, force: true });
            execFileSync('cp', ['-al', cacheNm, nmDir]);

            const isWeb = path.basename(dir) === 'web';
            const wtRoot = isWeb ? path.dirname(dir) : dir;
            const agentHubDir = path.join(wtRoot, '.agenthub');
            fs.mkdirSync(agentHubDir, { recursive: true });
            fs.writeFileSync(path.join(agentHubDir, isWeb ? 'web-lock.hash' : 'root-lock.hash'), lockHash, 'utf8');
            await verifyNativeModules(dir);
          }

          savedBytes += size;
          deduplicated++;
          console.log(`${dir}: ${dryRun ? 'có thể dedupe' : 'đã dedupe'} bằng hard-link từ cache — tiết kiệm ${size} bytes`);
        }
      }

      console.log(`Dedupe: ${deduplicated} thư mục node_modules, tiết kiệm ${savedBytes} bytes (${(savedBytes / (1024 * 1024)).toFixed(1)} MB)${dryRun ? ' (dự kiến)' : ''}`);
      return { tasks, removed: 0, freedBytes: 0, deduplicated, savedBytes };
    }

    for (const task of ctx.taskRepo.getAll()) {
      if (task.status !== 'done' && task.status !== 'cancelled') continue;
      if (!task.worktreePath || !fs.existsSync(task.worktreePath)) continue;
      tasks++;

      const dirs = [
        path.join(task.worktreePath, 'node_modules'),
        path.join(task.worktreePath, 'web', 'node_modules'),
      ];
      const existing = dirs.filter((dir) => fs.existsSync(dir));
      const size = existing.reduce((total, dir) => total + worktrees.getDirectorySize(dir), 0);
      freedBytes += size;
      removed += existing.length;

      if (dryRun) {
        console.log(`${task.id}: ${existing.length ? existing.join(', ') : '(không có node_modules)'} — ${size} bytes`);
      } else {
        const result = worktrees.cleanNodeModules(task.worktreePath);
        console.log(`${task.id}: đã xóa ${result.removed.length} thư mục — giải phóng ${result.freedBytes} bytes`);
      }
    }
  } finally {
    ctx.db.close();
  }

  console.log(`${dryRun ? 'Tổng dự kiến' : 'Tổng'}: ${removed} thư mục, ${freedBytes} bytes${dryRun ? '' : ' đã giải phóng'}`);
  return { tasks, removed, freedBytes };
}

export async function cmdProfile(
  config: ReturnType<typeof loadConfig>,
  sub: string | undefined,
  extraArgs: string[],
) {
  const ctx = createContext(config);
  ctx.profileService.registerAll();

  switch (sub) {
    case 'add': {
      const name = extraArgs[0];
      const engineArg = extraArgs.find((arg) => arg.startsWith('--engine='))?.split('=')[1]
        || (extraArgs.includes('--engine') ? extraArgs[extraArgs.indexOf('--engine') + 1] : 'agy');
      if (!name || (engineArg !== 'agy' && engineArg !== 'claude' && engineArg !== 'codex')) {
        console.error('Cách dùng: agenthub profile add <name> [--engine agy|claude|codex]');
        process.exitCode = 1;
        break;
      }
      if (ctx.profileRepo.get(name)) {
        console.error(`Hồ sơ "${name}" đã tồn tại`);
        process.exitCode = 1;
        break;
      }
      ctx.profileService.createProfile(name, engineArg as 'agy' | 'claude' | 'codex');
      console.log(`✓ Đã tạo hồ sơ ${engineArg}: ${name}`);
      break;
    }
    case 'rename': {
      const oldName = extraArgs[0];
      const newName = extraArgs[1];
      if (!oldName || !newName) {
        console.error('Cách dùng: agenthub profile rename <tên-cũ> <tên-mới>');
        process.exitCode = 1;
        break;
      }
      try {
        ctx.service.renameProfile(oldName, { newName });
        console.log(`✓ Đã đổi tên hồ sơ: ${oldName} → ${newName}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      break;
    }
    case 'remove':
    case 'delete': {
      const name = extraArgs.find((arg) => !arg.startsWith('--'));
      const purgeHome = extraArgs.includes('--purge-home') || extraArgs.includes('--purgeHome=1') || extraArgs.includes('--purge');
      if (!name) {
        console.error('Cách dùng: agenthub profile remove <tên> [--purge-home]');
        process.exitCode = 1;
        break;
      }
      try {
        ctx.service.deleteProfile(name, purgeHome);
        console.log(`✓ Đã xoá hồ sơ: ${name}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      break;
    }
    case 'list': {
      const profiles = ctx.profileRepo.getAll();
      const quotaMarks = ctx.quotaMarkRepo.getActive();
      const dupes = ctx.profileService.getDuplicateEmails();

      console.log('=== Hồ sơ ===\n');
      for (const p of profiles) {
        const marks = quotaMarks.filter((m) => m.profileName === p.name);
        const markStr = marks.length > 0
          ? ` [QUOTA: ${marks.map((m) => `${m.family} until ${new Date(m.until * 1000).toLocaleString()}`).join(', ')}]`
          : '';
        const enabledStr = p.enabled ? '' : ' (tắt)';
        console.log(
          `  ${p.name}: engine=${p.engine}, kind=${p.kind}, email=${p.email || '(chưa có)'}${enabledStr}${markStr}`,
        );
      }

      if (dupes.size > 0) {
        console.log('\n⚠️  Cảnh báo trùng email:');
        for (const [email, names] of dupes) {
          console.log(`  ${email}: ${names.join(', ')}`);
        }
      }
      break;
    }

    case 'check': {
      const name = extraArgs[0];
      const profiles = name ? [ctx.profileRepo.get(name)] : ctx.profileRepo.getAll();
      for (const p of profiles) {
        if (!p) {
          console.error(`Hồ sơ "${name}" không tồn tại`);
          process.exitCode = 1;
          continue;
        }
        if (p.engine !== 'agy') continue;
        console.log(`Checking ${p.name}...`);
        const logPath = path.join(config.logsDir, 'profile-check', `${p.name}-${crypto.randomUUID()}.log`);
        const child = new AgyEngine().spawn({
          profile: p,
          model: 'gemini-3.8-flash-low',
          cwd: process.cwd(),
          prompt: 'OK',
          logPath,
        });
        await new Promise<void>((resolve) => child.once('close', () => resolve()));
        const output = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim() : '';
        const logDir = p.kind === 'keyring'
          ? config.defaultLogDir
          : path.join(p.home || os.homedir(), '.gemini', 'antigravity-cli', 'log');
        const email = ctx.profileService.readEmailFromLog(logDir);
        console.log(`  Email: ${email || '(không tìm thấy)'}`);
        console.log(`  Kết quả: ${output || '(không có output)'}`);
      }
      break;
    }

    case 'login': {
      const name = extraArgs[0];
      if (!name) {
        console.error('Cần chỉ định tên hồ sơ: agenthub profile login <tên>');
        process.exit(1);
      }
      let profile = ctx.profileRepo.get(name);
      if (!profile) {
        // Create new profile
        ctx.profileService.createProfile(name);
        profile = ctx.profileRepo.get(name)!;
      }

      const executable = profile.engine === 'claude'
        ? findClaudeBin(config.chat.claudeBin)
        : findAgyBin(config.hubHome);
      if (!executable) {
        console.error(profile.engine === 'agy'
          ? `Không tìm thấy Antigravity CLI (agy). Cài bằng: ${agyInstallHint()}`
          : `Không tìm thấy lệnh ${profile.engine}`);
        process.exitCode = 1;
        break;
      }
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };

      if (profile.engine === 'claude' && profile.kind !== 'system' && profile.home) {
        env.CLAUDE_CONFIG_DIR = profile.home;
      } else if (profile.kind === 'isolated' && profile.home) {
        applyIsolatedAgyEnv(env, profile.home);
      }

      console.log(`Đăng nhập hồ sơ "${name}"...`);
      console.log('Chọn "Sử dụng tài khoản khác" nếu muốn dùng tài khoản Google khác.');
      console.log('Sau khi đăng nhập xong, gõ /exit hoặc Ctrl+C để thoát.\n');

      const child = spawnSync(executable, [], {
        env,
        stdio: profile.engine === 'claude' ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        input: profile.engine === 'claude' ? '/login\n' : undefined,
      });
      if (profile.engine === 'claude' && child.error) {
        console.error(`Không thể chạy claude: ${child.error.message}`);
        process.exitCode = 1;
      }

      // Re-read email
      const claudeAccount = profile.engine === 'claude'
        ? ctx.profileService.readClaudeAccount(profile.home || os.homedir())
        : null;
      const email = profile.engine === 'claude'
        ? claudeAccount?.email
        : ctx.profileService.readEmailFromLog(path.join(profile.home || os.homedir(), '.gemini', 'antigravity-cli', 'log'));
      if (email) {
        ctx.profileRepo.upsert({ ...profile, email });
        console.log(`\n✓ Đã đăng nhập: ${email}`);
        if (claudeAccount?.plan) console.log(`  Gói: ${claudeAccount.plan}`);
      } else {
        console.log('\n⚠ Không tìm thấy email trong log.');
      }
      break;
    }

    case 'import-tokens': {
      const sourceArg = extraArgs[0];
      const accountTypeArg = extraArgs.find((arg) => arg.startsWith('--account-type='))?.split('=')[1]
        || (extraArgs.includes('--account-type') ? extraArgs[extraArgs.indexOf('--account-type') + 1] : 'personal');
      const engineArg = extraArgs.find((arg) => arg.startsWith('--engine='))?.split('=')[1]
        || (extraArgs.includes('--engine') ? extraArgs[extraArgs.indexOf('--engine') + 1] : 'agy');

      if (!sourceArg) {
        console.error('Cách dùng: agenthub profile import-tokens <đường_dẫn_file_json | chuỗi_json> [--engine agy|codex] [--account-type personal|team|api]');
        process.exitCode = 1;
        break;
      }

      let payloadRaw: unknown;
      if (fs.existsSync(sourceArg)) {
        try {
          payloadRaw = JSON.parse(fs.readFileSync(sourceArg, 'utf8'));
        } catch {
          console.error(`Lỗi: Không thể phân tích cú pháp JSON từ file "${sourceArg}"`);
          process.exitCode = 1;
          break;
        }
      } else {
        try {
          payloadRaw = JSON.parse(sourceArg);
        } catch {
          console.error('Lỗi: Tham số không phải đường dẫn file tồn tại và cũng không phải chuỗi JSON hợp lệ');
          process.exitCode = 1;
          break;
        }
      }

      console.log(engineArg === 'codex' ? 'Đang nhập tài khoản Codex từ token...' : 'Đang kiểm tra và nhập tài khoản Antigravity từ Cockpit token...');
      try {
        const result = await ctx.service.importTokens({
          engine: engineArg,
          tokens: payloadRaw,
          accountType: accountTypeArg,
        }, { verify: false });

        console.log(`\nKết quả xử lý (${result.total} mục):`);
        for (const item of result.results) {
          if (item.status === 'ok') {
            console.log(`  ✓ ${item.name} (${item.email}): ${item.message}`);
          } else {
            console.log(`  ✗ ${item.name || 'n/a'} (${item.email || 'n/a'}): ${item.message}`);
          }
        }
        console.log(`\nTổng kết: ${result.successCount} thành công, ${result.failedCount} thất bại.`);
        if (result.successCount > 0) {
          console.log('Kiểm tra lại với agy: agenthub profile check <tên>');
        }
        if (result.failedCount > 0 && result.successCount === 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        console.error('Lỗi khi nhập tokens:', err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      break;
    }

    default:
      console.log('Cách dùng: agenthub profile list|check [tên]|login <tên>|add <tên>|import-tokens <file|json>|rename <cũ> <mới>|remove <tên>');
  }

  ctx.db.close();
}

async function cmdProject(
  config: ReturnType<typeof loadConfig>,
  sub: string | undefined,
  extraArgs: string[],
) {
  const ctx = createContext(config);

  switch (sub) {
    case 'add': {
      const name = extraArgs[0];
      const projectPath = extraArgs[1];
      if (!name || !projectPath) {
        console.error('Cách dùng: agenthub project add <name> <path>');
        process.exit(1);
      }
      const resolvedPath = path.resolve(projectPath);
      ctx.projectRepo.insert({
        id: name,
        name,
        path: resolvedPath,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 3,
      });
      console.log(`✓ Đã thêm project "${name}" tại ${resolvedPath}`);
      break;
    }

    default:
      console.log('Cách dùng: agenthub project add <name> <path>');
  }

  ctx.db.close();
}

async function cmdTask(
  config: ReturnType<typeof loadConfig>,
  sub: string | undefined,
  extraArgs: string[],
) {
  const ctx = createContext(config);

  switch (sub) {
    case 'add': {
      const projectId = extraArgs[0];
      const slug = extraArgs[1];
      if (!projectId || !slug) {
        console.error('Cách dùng: agenthub task add <project> <slug> --title "..." --level easy|hard [--body-file ...]');
        process.exit(1);
      }

      const title = getArg(extraArgs, '--title') || slug;
      const level = getArg(extraArgs, '--level') || 'easy';
      const bodyFile = getArg(extraArgs, '--body-file');
      const depends = getArg(extraArgs, '--depends');
      const shouldStart = extraArgs.includes('--start');

      let body = title;
      if (bodyFile) {
        const fs = await import('node:fs');
        body = fs.readFileSync(bodyFile, 'utf-8');
      }

      const taskId = `${projectId}/${slug}`;
      const dependsOn = depends ? depends.split(',').map((d) => d.trim()) : [];

      ctx.taskRepo.insert({
        id: taskId,
        projectId,
        slug,
        title,
        body,
        level,
        dependsOn,
        status: shouldStart ? 'queued' : 'draft',
      });

      console.log(`✓ Đã tạo task "${taskId}" (${shouldStart ? 'queued' : 'draft'})`);
      break;
    }

    case 'list': {
      const tasks = ctx.taskRepo.getAll();
      if (tasks.length === 0) {
        console.log('Không có task nào.');
        break;
      }
      console.log('=== Tasks ===\n');
      for (const t of tasks) {
        console.log(`  ${t.id}: ${t.title} [${t.status}] level=${t.level} attempt=${t.attempt}`);
      }
      break;
    }

    case 'show': {
      const taskId = extraArgs[0];
      if (!taskId) {
        console.error('Cách dùng: agenthub task show <id>');
        process.exit(1);
      }
      const task = ctx.taskRepo.get(taskId);
      if (!task) {
        console.error(`Task "${taskId}" không tồn tại`);
        process.exit(1);
      }
      console.log(`Task: ${task.id}`);
      console.log(`  Title: ${task.title}`);
      console.log(`  Status: ${task.status}`);
      console.log(`  Level: ${task.level}`);
      console.log(`  Attempt: ${task.attempt}`);
      console.log(`  Branch: ${task.branch || '(chưa tạo)'}`);
      console.log(`  Worktree: ${task.worktreePath || '(chưa tạo)'}`);
      console.log(`  Dependencies: ${task.dependsOn}`);

      const runs = ctx.runRepo.getByTask(taskId);
      if (runs.length > 0) {
        console.log(`\n  Runs:`);
        for (const r of runs) {
          console.log(
            `    ${r.id}: model=${r.model} profile=${r.profileName} outcome=${r.outcome || 'running'}`,
          );
        }
      }
      break;
    }

    case 'log': {
      const taskId = extraArgs[0];
      if (!taskId) {
        console.error('Cách dùng: agenthub task log <id>');
        process.exit(1);
      }
      const runs = ctx.runRepo.getByTask(taskId);
      const lastRun = runs[runs.length - 1];
      if (!lastRun?.logPath) {
        console.error('Không có log');
        break;
      }
      const fs = await import('node:fs');
      if (fs.existsSync(lastRun.logPath)) {
        console.log(fs.readFileSync(lastRun.logPath, 'utf-8'));
      } else {
        console.error(`Log file không tồn tại: ${lastRun.logPath}`);
      }
      break;
    }

    default:
      console.log('Cách dùng: agenthub task add|list|show|log');
  }

  ctx.db.close();
}

async function cmdReview(config: ReturnType<typeof loadConfig>, extraArgs: string[]): Promise<void> {
  const taskId = extraArgs[0];
  if (!taskId || !extraArgs.includes('--approve')) {
    console.error('Cách dùng: agenthub review <id> --approve [--merge]');
    process.exit(1);
  }
  const ctx = createContext(config);
  try {
    const task = await ctx.service.reviewTask(taskId, {
      verdict: 'approved',
      merge: extraArgs.includes('--merge'),
      by: 'cli',
    });
    console.log(`✓ Đã duyệt task "${task.id}"${extraArgs.includes('--merge') ? ' và merge' : ''}`);
  } finally {
    ctx.db.close();
  }
}

export async function cmdSavings(
  config: ReturnType<typeof loadConfig>,
  sub: string | undefined,
  extraArgs: string[],
): Promise<void> {
  const ctx = createContext(config);

  try {
    switch (sub) {
      case 'import-legacy': {
        const targetDir = extraArgs[0]
          ? path.resolve(extraArgs[0])
          : path.join(os.homedir(), '.gemini', 'agy-run-logs');

        if (!fs.existsSync(targetDir)) {
          console.log(`Thư mục log không tồn tại: ${targetDir}`);
          return;
        }

        console.log(`Đang quét log Codex trong: ${targetDir}...`);

        function scanDir(dir: string, depth = 0): string[] {
          const results: string[] = [];
          if (depth > 4) return results;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                results.push(...scanDir(fullPath, depth + 1));
              } else if (entry.isFile() && entry.name.endsWith('.log') && /codex/i.test(entry.name)) {
                results.push(fullPath);
              }
            }
          } catch {
            // ignore
          }
          return results;
        }

        const logFiles = scanDir(targetDir);
        if (logFiles.length === 0) {
          console.log('Không tìm thấy log Codex nào.');
          return;
        }

        let importedCount = 0;
        for (const filePath of logFiles) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const tokens = parseCodexTokens(content);
            if (tokens == null) continue;

            // The slug is the name of the directory containing the log file
            const slug = path.basename(path.dirname(filePath));
            const allTasks = ctx.taskRepo.getAll();
            const task = allTasks.find((t) => t.slug === slug);
            if (!task) {
              console.log(`- Bỏ qua: Không tìm thấy task có slug "${slug}" cho log ${path.basename(filePath)}`);
              continue;
            }

            const runs = ctx.runRepo.getByTask(task.id);
            const targetRun = runs.find((r) => r.engine === 'codex') || runs[0];
            const runId = targetRun ? targetRun.id : crypto.randomUUID();

            if (!targetRun) {
              ctx.runRepo.insert({
                id: runId,
                taskId: task.id,
                engine: 'codex',
                model: 'gpt-5.6-luna',
                profileName: 'codex',
              });
            }

            ctx.runMetricsRepo.upsert({
              runId,
              taskId: task.id,
              engine: 'codex',
              model: targetRun?.model || 'gpt-5.6-luna',
              profileName: targetRun?.profileName || 'codex',
              tokensUsed: tokens,
              usageBefore: null,
              usageAfter: null,
              linesAdded: 0,
              linesDeleted: 0,
              filesChanged: 0,
              durationMs: null,
            });

            console.log(`✓ Đã nhập ${tokens.toLocaleString()} tokens cho task "${task.id}" từ ${path.basename(filePath)}`);
            importedCount++;
          } catch (err) {
            console.error(`Lỗi đọc ${filePath}: ${err}`);
          }
        }

        console.log(`\nHoàn thành nhập lịch sử: đã gắn token cho ${importedCount} lượt chạy.`);
        break;
      }

      case 'backfill-lines': {
        const projectFlag = getArg(extraArgs, '--project') || getArg(extraArgs, '-p');
        console.log(`Bắt đầu tính lại số dòng cho các task${projectFlag ? ` thuộc project "${projectFlag}"` : ''}...`);

        const res = await ctx.savingsService.backfillLines(projectFlag);

        for (const item of res.updated) {
          console.log(`✓ Đã tính lại ${item.taskId}: +${item.linesAdded}/-${item.linesDeleted} (${item.filesChanged} file)`);
        }
        for (const item of res.skipped) {
          console.log(`- Bỏ qua ${item.taskId}: Nhánh không tồn tại hoặc project không hợp lệ`);
        }

        console.log(`\nHoàn thành: ${res.updated.length} task được cập nhật, ${res.skipped.length} task bỏ qua.`);
        break;
      }

      default:
        console.log('Cách dùng: agenthub savings import-legacy <dir> | backfill-lines [--project x]');
        process.exitCode = 1;
        break;
    }
  } catch (err) {
    console.error('Lỗi khi thực hiện lệnh savings:', err);
    process.exitCode = 1;
  } finally {
    closeContext(ctx);
  }
}

export async function cmdNote(
  config: AgentHubConfig,
  extraArgs: string[],
): Promise<void> {
  const content = extraArgs.join(' ').trim();
  if (!content) {
    console.error('Cách dùng: agenthub note "<nội dung>"');
    process.exit(1);
  }

  const taskId = process.env.AGENTHUB_TASK_ID;
  if (!taskId) {
    console.error('Lỗi: Biến môi trường AGENTHUB_TASK_ID không được thiết lập.');
    process.exit(1);
  }

  const port = config.port || 7700;
  const token = readExistingToken(config.tokenPath || getTokenPath());
  if (!token) {
    console.error('Lỗi: Không tìm thấy token xác thực.');
    process.exit(1);
  }

  const normalizedId = taskId.replace(/\//g, '~');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${encodeURIComponent(normalizedId)}/notes`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content, kind: 'note' }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Lỗi từ daemon API (${res.status}): ${err}`);
      process.exit(1);
    }

    const data = (await res.json()) as { id: number; content: string; taskId: string };
    console.log(`✓ Đã thêm ghi chú cho task ${data.taskId} (#${data.id})`);
  } catch (err) {
    console.error(`Không thể kết nối tới AgentHub daemon tại http://127.0.0.1:${port}:`, (err as Error).message);
    process.exit(1);
  }
}

export async function cmdNotes(
  config: AgentHubConfig,
  extraArgs: string[],
): Promise<void> {
  let projectId = getArg(extraArgs, '--project');
  if (!projectId && process.env.AGENTHUB_TASK_ID) {
    const taskId = process.env.AGENTHUB_TASK_ID;
    projectId = taskId.includes('/') ? taskId.split('/')[0] : taskId;
  }

  if (!projectId) {
    const ctx = createContext(config);
    const projects = ctx.projectRepo.getAll();
    const cwd = process.cwd();
    const matched = projects.find(
      (p) => cwd === p.path || cwd.startsWith(p.path + path.sep) || cwd.includes(p.id),
    );
    ctx.db.close();
    if (matched) {
      projectId = matched.id;
    }
  }

  if (!projectId) {
    console.error('Lỗi: Không xác định được project (AGENTHUB_TASK_ID chưa được thiết lập và không có --project).');
    process.exit(1);
  }

  const since = getArg(extraArgs, '--since');
  const port = config.port || 7700;
  const token = readExistingToken(config.tokenPath || getTokenPath());
  if (!token) {
    console.error('Lỗi: Không tìm thấy token xác thực.');
    process.exit(1);
  }

  const queryParams = new URLSearchParams();
  queryParams.set('runningOnly', 'true');
  if (since) {
    queryParams.set('since', since);
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectId)}/notes?${queryParams.toString()}`,
      {
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!res.ok) {
      const err = await res.text();
      console.error(`Lỗi từ daemon API (${res.status}): ${err}`);
      process.exit(1);
    }

    const notes = (await res.json()) as Array<{
      id: number;
      taskId: string;
      kind: 'note' | 'overlap';
      content: string;
      createdAt: string;
    }>;

    if (notes.length === 0) {
      console.log('Không có ghi chú nào.');
      return;
    }

    console.log(`=== Bảng tin project ${projectId} ===\n`);
    for (const note of notes) {
      const tag = note.kind === 'overlap' ? '[TRÙNG FILE] ' : '';
      console.log(`[#${note.id}] ${note.createdAt} [${note.taskId}] ${tag}${note.content}`);
    }
  } catch (err) {
    console.error(`Không thể kết nối tới AgentHub daemon tại http://127.0.0.1:${port}:`, (err as Error).message);
    process.exit(1);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
