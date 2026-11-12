import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AgentHubConfig } from './config.js';
import { findProjectRoot } from './cli.js';
import { getPlatform } from './platform/index.js';
import type { PlatformApi, ServiceInstallResult, ServiceUninstallResult } from './platform/types.js';

export function compareSemver(a: string, b: string): number {
  // "1.0.0-rc.1" -> core [1,0,0], pre ["rc", 1]. A release ranks above its pre-releases.
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2) as [string, string | undefined];
    const nums = core.split('.').map((p) => {
      const n = parseInt(p, 10);
      return Number.isNaN(n) ? 0 : n;
    });
    const preParts = pre ? pre.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
    return { nums, preParts };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length, 3); i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  if (!pa.preParts.length || !pb.preParts.length) {
    return pa.preParts.length === pb.preParts.length ? 0 : pa.preParts.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(pa.preParts.length, pb.preParts.length); i++) {
    const x = pa.preParts[i];
    const y = pb.preParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export interface VersionCheckResult {
  version: string;
  latest: string | null;
  upToDate: boolean;
  checked: boolean;
  disabled?: boolean;
  error?: string;
}

export interface VersionDeps {
  fetch?: typeof fetch;
  projectRoot?: string;
  log?: (msg: string) => void;
}

export async function cmdVersion(
  config: AgentHubConfig,
  extraArgs: string[] = [],
  deps: VersionDeps = {},
): Promise<VersionCheckResult> {
  const log = deps.log || console.log;
  const projectRoot = deps.projectRoot || findProjectRoot();

  let currentVersion = '0.1.0';
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.version) currentVersion = pkg.version;
    }
  } catch {
    // fallback
  }

  if (extraArgs.includes('--help') || extraArgs.includes('-h')) {
    log(`Cách dùng: agenthub version [--check]
Hiển thị phiên bản hiện tại, hoặc kiểm tra bản phát hành mới nhất từ GitHub.`);
    return { version: currentVersion, latest: null, upToDate: true, checked: false };
  }

  const isCheck = extraArgs.includes('--check');
  if (!isCheck) {
    log(`AgentHub v${currentVersion}`);
    return { version: currentVersion, latest: null, upToDate: true, checked: false };
  }

  if (config.updates?.check === false) {
    log(`AgentHub v${currentVersion}`);
    log(`Kiểm tra cập nhật bị tắt trong cấu hình (updates.check=false).`);
    return {
      version: currentVersion,
      latest: null,
      upToDate: true,
      checked: false,
      disabled: true,
    };
  }

  const repo = config.updates?.repo || 'ducanh19020217/agenthub';
  const fetchFn = deps.fetch || fetch;

  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        'User-Agent': 'agenthub',
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log(`AgentHub v${currentVersion}`);
      log(`Không thể kiểm tra bản phát hành mới nhất: HTTP ${res.status}.`);
      return {
        version: currentVersion,
        latest: null,
        upToDate: true,
        checked: false,
        error: `HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as { tag_name?: string; name?: string };
    const latestRaw = data.tag_name || data.name || '';
    const latestClean = latestRaw.replace(/^v/, '');

    const isNewer = compareSemver(latestClean, currentVersion) > 0;
    if (isNewer) {
      log(`Phiên bản hiện tại: v${currentVersion}`);
      log(`Phiên bản mới nhất: v${latestClean}`);
      log(`Có bản cập nhật mới! Chạy 'agenthub update' để cập nhật.`);
      return {
        version: currentVersion,
        latest: latestClean,
        upToDate: false,
        checked: true,
      };
    }

    log(`AgentHub v${currentVersion} (mới nhất).`);
    return {
      version: currentVersion,
      latest: latestClean,
      upToDate: true,
      checked: true,
    };
  } catch (err) {
    const message = (err as Error).message || String(err);
    log(`AgentHub v${currentVersion}`);
    log(`Không thể kiểm tra bản phát hành mới nhất: ${message}.`);
    return {
      version: currentVersion,
      latest: null,
      upToDate: true,
      checked: false,
      error: message,
    };
  }
}

export interface ExecResult {
  stdout?: string;
  stderr?: string;
  status?: number | null;
  error?: Error;
}

export interface UpdateResult {
  success: boolean;
  version: string;
  tag: string;
  restarted: boolean;
  message: string;
}

export interface UpdateDeps {
  projectRoot?: string;
  exec?: (command: string, args: string[], options?: { cwd?: string; stdio?: 'inherit' | 'pipe' | 'ignore' }) => ExecResult;
  installService?: (opts: Parameters<PlatformApi['installService']>[0]) => ServiceInstallResult;
  restartService?: () => { restarted: boolean; message: string };
  log?: (msg: string) => void;
}

export async function cmdUpdate(
  _config: AgentHubConfig,
  extraArgs: string[] = [],
  deps: UpdateDeps = {},
): Promise<UpdateResult> {
  const log = deps.log || console.log;
  const projectRoot = deps.projectRoot || findProjectRoot();

  if (extraArgs.includes('--help') || extraArgs.includes('-h')) {
    log(`Cách dùng: agenthub update
Cập nhật AgentHub lên phiên bản mới nhất từ git tag, build lại và khởi động lại service.`);
    return { success: true, version: '', tag: '', restarted: false, message: 'Help' };
  }

  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    throw new Error(`Không tìm thấy git repository tại ${projectRoot}. Không thể tự động update.`);
  }

  const exec =
    deps.exec ||
    ((cmd, args, opts) => {
      const res = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
      return {
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        status: res.status,
        error: res.error,
      };
    });

  // 1. Fetch tags
  const fetchRes = exec('git', ['fetch', '--tags', 'origin'], { cwd: projectRoot });
  if (fetchRes.status !== 0) {
    // Retry without origin
    exec('git', ['fetch', '--tags'], { cwd: projectRoot });
  }

  // 2. Find latest tag
  const tagRes = exec('git', ['tag', '-l', '--sort=-v:refname'], { cwd: projectRoot });
  const tags = (tagRes.stdout || '')
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const versionTags = tags.filter((t) => /^v?\d+\.\d+(\.\d+)?/.test(t));
  const latestTag = versionTags[0];

  // 3. Check dirty state
  const statusRes = exec('git', ['status', '--porcelain'], { cwd: projectRoot });
  if (statusRes.stdout && statusRes.stdout.trim().length > 0) {
    throw new Error(`Có thay đổi chưa commit trong ${projectRoot}. Vui lòng commit hoặc stash trước khi update.`);
  }

  // 4. Checkout or pull
  if (latestTag) {
    log(`==> Cập nhật theo tag mới nhất: ${latestTag}...`);
    const checkoutRes = exec('git', ['checkout', latestTag], { cwd: projectRoot });
    if (checkoutRes.status !== 0) {
      throw new Error(`Lỗi khi checkout tag ${latestTag}: ${checkoutRes.stderr || checkoutRes.stdout}`);
    }
  } else {
    log(`==> Không tìm thấy tag phát hành, đang pull code mới nhất...`);
    const pullRes = exec('git', ['pull'], { cwd: projectRoot });
    if (pullRes.status !== 0) {
      throw new Error(`Lỗi khi git pull: ${pullRes.stderr || pullRes.stdout}`);
    }
  }

  // 5. Rebuild
  log(`==> Đang build lại backend (npm run build)...`);
  const buildRes = exec('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' });
  if (buildRes.status !== 0) {
    throw new Error(`Lỗi khi build backend: ${buildRes.stderr || buildRes.stdout || 'Thất bại'}`);
  }

  log(`==> Đang build lại web dashboard (npm run build:web)...`);
  const buildWebRes = exec('npm', ['run', 'build:web'], { cwd: projectRoot, stdio: 'inherit' });
  if (buildWebRes.status !== 0) {
    throw new Error(`Lỗi khi build web: ${buildWebRes.stderr || buildWebRes.stdout || 'Thất bại'}`);
  }

  // 6. Update service unit if already installed, then restart
  const homeDir = os.homedir();
  const linuxServiceFile = path.join(homeDir, '.config', 'systemd', 'user', 'agenthub.service');
  const darwinServiceFile = path.join(homeDir, 'Library', 'LaunchAgents', 'dev.agenthub.plist');
  const isServiceInstalled = fs.existsSync(linuxServiceFile) || fs.existsSync(darwinServiceFile);

  if (isServiceInstalled) {
    try {
      log(`==> Đang cập nhật cấu hình service...`);
      const cliPath = path.resolve(projectRoot, 'dist', 'cli.js');
      const installRes = (deps.installService || ((o) => getPlatform().installService(o)))({
        nodePath: process.execPath,
        cliPath,
        currentPath: process.env.PATH || '',
        homeDir,
        print: false,
      });
      if (!installRes.skipped) {
        log(`✓ Đã cập nhật file service tại ${installRes.file}`);
      }
    } catch (err) {
      log(`! Không thể tự cập nhật file service: ${(err as Error).message}`);
    }
  }

  log(`==> Đang khởi động lại service...`);
  const restartResult = deps.restartService ? deps.restartService() : getPlatform().restartService();
  if (restartResult.restarted) {
    log(`✓ ${restartResult.message}`);
  } else {
    log(`! ${restartResult.message}`);
  }

  let updatedVersion = latestTag ? latestTag.replace(/^v/, '') : 'latest';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (pkg.version) updatedVersion = pkg.version;
  } catch {
    // ignore
  }

  log(`✓ Cập nhật thành công AgentHub v${updatedVersion}!`);
  return {
    success: true,
    version: updatedVersion,
    tag: latestTag || 'HEAD',
    restarted: restartResult.restarted,
    message: `Cập nhật thành công lên v${updatedVersion}`,
  };
}

export async function cmdUninstallService(
  _extraArgs: string[] = [],
  deps?: { uninstall?: () => ServiceUninstallResult },
): Promise<ServiceUninstallResult> {
  const result = deps?.uninstall ? deps.uninstall() : getPlatform().uninstallService();
  console.log(`✓ ${result.message}`);
  return result;
}
