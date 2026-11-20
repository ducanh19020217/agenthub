import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { getPlatform } from './platform/index.js';

const processGroups = new Set<number>();

/**
 * Giới hạn worker của test runner trong tiến trình con của worker và bước kiểm tra.
 * Máy người dùng 12 nhân chạy 4–6 worker song song; vitest mặc định bật số thread = số nhân.
 */
export const LIMITED_TEST_ENV: Record<string, string> = {
  VITEST_MAX_THREADS: '2',
  VITEST_MIN_THREADS: '1',
  VITEST_MAX_FORKS: '2',
  VITEST_MIN_FORKS: '1',
};

export function testThreadLimit(workerCount = 1, cpuCount = os.cpus().length): number {
  return Math.min(2, Math.max(1, Math.ceil(cpuCount / Math.max(1, Math.floor(workerCount || 1)))));
}

/**
 * Chạy lệnh với độ ưu tiên thấp để IDE và trình duyệt của người dùng luôn được ưu tiên.
 * Linux dùng `nice`/`ionice`; macOS chỉ dùng `nice`. Wrapper dùng exec nên PID giữ nguyên.
 */
export function lowPriority(executable: string, args: string[]): [string, string[]] {
  return getPlatform().lowPriority(executable, args);
}

export interface GroupRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Chạy lệnh trong process group riêng; khi xong hoặc hết giờ thì kill CẢ group để không còn
 * tiến trình cháu (vitest pool, next build worker…) sống sót sau bước kiểm tra.
 */
export function runInProcessGroup(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutput?: number; logPath?: string },
): Promise<GroupRunResult> {
  const maxOutput = opts.maxOutput ?? 4 * 1024 * 1024;
  const [exe, finalArgs] = lowPriority(command, args);
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    // Nested checks already run inside one process group; cap their own test
    // runner at the shared two-thread limit regardless of the parent worker
    // pool or the host's reported CPU count.
    const threadLimit = Number(LIMITED_TEST_ENV.VITEST_MAX_THREADS);
    const limitedEnv = {
      ...opts.env,
      VITEST_MAX_THREADS: String(threadLimit), VITEST_MIN_THREADS: '1',
      VITEST_MAX_FORKS: String(threadLimit), VITEST_MIN_FORKS: '1',
      JEST_WORKERS: String(threadLimit), UV_THREADPOOL_SIZE: String(Math.min(4, threadLimit)),
    };
    const child = spawn(exe, finalArgs, {
      cwd: opts.cwd,
      env: limitedEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) processGroups.add(child.pid);
    const logStream = opts.logPath ? fs.createWriteStream(opts.logPath, { flags: 'w' }) : null;
    const append = (chunk: Buffer) => {
      if (logStream) logStream.write(chunk);
      output += chunk.toString();
      if (output.length > maxOutput) output = output.slice(-maxOutput);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // group đã thoát
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    }, opts.timeoutMs);
    timer.unref();
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (extra && logStream) logStream.write(extra);
      if (logStream) logStream.end();
      // Dọn tiến trình cháu còn sót trong group sau khi lệnh chính đã thoát.
      killGroup('SIGKILL');
      if (child.pid) processGroups.delete(child.pid);
      resolve({ code, output: output + extra, timedOut });
    };
    child.on('error', (err) => finish(null, String(err)));
    child.on('close', (code) => finish(code));
  });
}

/** Stop every check/merge process group started by this daemon instance. */
export function stopProcessGroups(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const pid of processGroups) {
    try { process.kill(-pid, signal); } catch { /* group already exited */ }
    if (signal === 'SIGTERM') {
      const timer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* group already exited */ }
      }, 10_000);
      timer.unref();
    }
  }
}
