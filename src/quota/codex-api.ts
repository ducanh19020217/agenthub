import fs from 'node:fs';
import path from 'node:path';
import { normalizePlan } from '../profiles/plan.js';

/** Endpoint Codex CLI/ChatGPT dùng cho hạn mức; Cockpit tools gọi cùng endpoint. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export type CodexTokenSkip = 'no_auth_file' | 'unreadable' | 'no_access_token';

/**
 * Ngoại lệ DEC-014: chỉ lấy access_token và account_id trong auth.json của CODEX_HOME riêng.
 * Không đọc refresh_token/id_token, không ghi lại file, không log token.
 */
export function readCodexAccessToken(codexHome: string): { accessToken: string; accountId: string | null } | { skip: CodexTokenSkip } {
  const file = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(file)) return { skip: 'no_auth_file' };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return { skip: 'unreadable' };
  }
  const tokens = raw.tokens && typeof raw.tokens === 'object' ? (raw.tokens as Record<string, unknown>) : {};
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  if (!accessToken) return { skip: 'no_access_token' };
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id.trim() ? tokens.account_id.trim() : null;
  return { accessToken, accountId };
}

export interface CodexUsageWindow {
  window: '5h' | 'week';
  usedPercent: number;
  resetAt: number;
}

export interface CodexUsageResult {
  status: number;
  plan: string | null;
  windows: CodexUsageWindow[];
}

function toWindow(raw: unknown, fallback: '5h' | 'week', nowSec: number): CodexUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const used = typeof w.used_percent === 'number' ? w.used_percent : NaN;
  if (!Number.isFinite(used)) return null;
  const seconds = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : NaN;
  // Phân loại theo độ dài cửa sổ; thiếu thì primary = 5h, secondary = tuần như Codex CLI.
  const window = Number.isFinite(seconds) ? (seconds <= 6 * 3600 ? '5h' : 'week') : fallback;
  const resetAt = typeof w.reset_at === 'number'
    ? w.reset_at
    : typeof w.reset_after_seconds === 'number' && w.reset_after_seconds >= 0
      ? nowSec + w.reset_after_seconds
      : 0;
  return { window, usedPercent: Math.max(0, Math.min(100, used)), resetAt };
}

export function parseCodexUsage(data: unknown, nowSec = Math.floor(Date.now() / 1000)): Omit<CodexUsageResult, 'status'> {
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const limit = body.rate_limit && typeof body.rate_limit === 'object' ? (body.rate_limit as Record<string, unknown>) : {};
  const windows = [toWindow(limit.primary_window, '5h', nowSec), toWindow(limit.secondary_window, 'week', nowSec)]
    .filter((w): w is CodexUsageWindow => w !== null);
  return { plan: normalizePlan(typeof body.plan_type === 'string' ? body.plan_type : null), windows };
}

export async function fetchCodexUsage(
  accessToken: string,
  accountId: string | null,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CodexUsageResult> {
  const signal = options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 10_000);
  try {
    const response = await fetch(CODEX_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
      signal,
    });
    if (!response.ok) return { status: response.status, plan: null, windows: [] };
    return { status: response.status, ...parseCodexUsage(await response.json()) };
  } catch {
    return { status: 0, plan: null, windows: [] };
  }
}
