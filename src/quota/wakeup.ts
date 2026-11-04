import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ProfileRow, QuotaUsageRow } from '../db/index.js';
import { applyIsolatedAgyEnv } from '../agy.js';

/**
 * Đánh thức quota (như "Wake-up Tasks" của Cockpit tools): cửa sổ 5 giờ chỉ bắt đầu tính khi tài khoản
 * được dùng, nên gửi một prompt rất ngắn vào giờ hẹn để cửa sổ bắt đầu sớm và reset sớm hơn lúc cần dùng.
 */

export interface WakeupConfig {
  enabled: boolean;
  /** Giờ địa phương "HH:MM". */
  times: string[];
  /** Tên hồ sơ cần đánh thức; rỗng = mọi hồ sơ agy/codex/claude đang bật. */
  profiles: string[];
  /** Model agy cho từng họ quota (Gemini và Claude/GPT tính quota riêng). */
  agyModels: string[];
}

export const DEFAULT_WAKEUP_CONFIG: WakeupConfig = {
  enabled: false,
  times: ['06:00'],
  profiles: [],
  agyModels: ['gemini-3.8-flash-low', 'claude-sonnet-4-6'],
};

export const WAKEUP_PROMPT = 'Reply with the single word OK.';

/** Họ quota agy theo tên nhóm trong /usage; họ model = phần trước dấu "-" đầu tiên (PLAN 2.1). */
const AGY_GROUP_BY_FAMILY: Record<string, string> = { gemini: 'Gemini Models', claude: 'Claude and GPT models', gpt: 'Claude and GPT models' };

/** Cửa sổ 5h đang chạy dở thì đánh thức không có ích (reset không sớm hơn). */
function fiveHourActive(rows: QuotaUsageRow[], group: string | null, nowSec: number): boolean {
  return rows.some((row) => row.window === '5h' && (group === null || row.grp === group) && row.resetAt > nowSec && row.remainingPct < 100);
}

export interface WakeupPlan {
  profile: string;
  engine: ProfileRow['engine'];
  /** Model agy cần đánh thức; rỗng với codex/claude. */
  models: string[];
  skip?: string;
}

/** Quyết định đánh thức gì cho một hồ sơ. `force` (bấm tay) bỏ qua kiểm tra cửa sổ đang chạy. */
export function planWakeup(
  profile: ProfileRow,
  usage: QuotaUsageRow[],
  config: WakeupConfig,
  state: { loggedIn: boolean; busy: boolean; nowSec: number; force?: boolean },
): WakeupPlan {
  const base = { profile: profile.name, engine: profile.engine, models: [] as string[] };
  if (!['agy', 'codex', 'claude'].includes(profile.engine)) return { ...base, skip: 'Engine không hỗ trợ đánh thức' };
  if (!profile.enabled) return { ...base, skip: 'Hồ sơ đang tắt' };
  if (!state.loggedIn) return { ...base, skip: 'Hồ sơ chưa đăng nhập' };
  if (state.busy) return { ...base, skip: 'Hồ sơ đang chạy task' };

  if (profile.engine === 'agy') {
    const models = config.agyModels.filter((model) => {
      if (state.force) return true;
      const group = AGY_GROUP_BY_FAMILY[model.split('-')[0]] ?? null;
      return !fiveHourActive(usage, group, state.nowSec);
    });
    return models.length > 0 ? { ...base, models } : { ...base, skip: 'Cửa sổ 5 giờ đang chạy' };
  }
  if (!state.force && fiveHourActive(usage, null, state.nowSec)) return { ...base, skip: 'Cửa sổ 5 giờ đang chạy' };
  return base;
}

export interface WakeupCommand {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

export interface WakeupBins {
  agy: string;
  codex: string | null;
  claude: string | null;
}

/** Lệnh chạy cho từng engine trong môi trường riêng của hồ sơ (giống khi chạy task). */
export function wakeupCommands(profile: ProfileRow, plan: WakeupPlan, bins: WakeupBins): WakeupCommand[] {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), BROWSER: '/bin/false' };
  if (profile.engine === 'agy') {
    if (profile.kind === 'isolated' && profile.home) {
      applyIsolatedAgyEnv(env, profile.home);
    }
    return plan.models.map((model) => ({
      bin: bins.agy,
      args: ['-p', WAKEUP_PROMPT, '--model', model, '--dangerously-skip-permissions', '--print-timeout', '0'],
      env,
    }));
  }
  if (profile.engine === 'codex') {
    if (!bins.codex) return [];
    if (profile.kind === 'isolated' && profile.home) env.CODEX_HOME = profile.home;
    return [{ bin: bins.codex, args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', WAKEUP_PROMPT], env }];
  }
  if (!bins.claude) return [];
  if (profile.kind !== 'system' && profile.home) env.CLAUDE_CONFIG_DIR = profile.home;
  return [{ bin: bins.claude, args: ['-p', WAKEUP_PROMPT, '--max-turns', '1'], env }];
}

export type WakeupRunner = (cmd: WakeupCommand, cwd: string) => Promise<{ output: string; error?: string }>;

export const defaultWakeupRunner: WakeupRunner = (cmd, cwd) =>
  new Promise((resolve) => {
    execFile(cmd.bin, cmd.args, { env: cmd.env, cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, error: error ? error.message : undefined });
    });
  });

/** agy trả exit 1 kể cả khi thành công (PLAN 2.1): xét theo output, không theo exit code. */
export function wakeupSucceeded(engine: ProfileRow['engine'], result: { output: string; error?: string }): boolean {
  if (/AGY_ERROR|RESOURCE_EXHAUSTED|exhausted your quota|not logged in|Not logged in|usage limit/i.test(result.output)) return false;
  if (engine === 'agy') return /\bOK\b/i.test(result.output);
  return !result.error;
}

export function wakeupCwd(hubHome: string): string {
  const dir = path.join(hubHome || os.tmpdir(), 'wakeup-cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
