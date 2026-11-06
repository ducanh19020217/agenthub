import fs from 'node:fs';
import path from 'node:path';
import { normalizePlan } from './plan.js';

export interface CodexTokenData {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  lastRefresh: string;
  email: string | null;
  /** chatgpt_plan_type trong id_token, đã chuẩn hoá (free, plus, pro, team…). */
  plan: string | null;
}

/** Đọc payload của JWT (không kiểm chữ ký): chỉ dùng để lấy email/account id hiển thị. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Chuẩn hoá một mục token Codex. Nhận cả dạng export phẳng
 * ({ id_token, access_token, refresh_token, account_id, last_refresh, email, type: "codex" })
 * lẫn nội dung auth.json của Codex CLI ({ tokens: {...}, last_refresh }).
 */
export function parseCodexTokenItem(item: Record<string, unknown>): CodexTokenData | { error: string } {
  const tokens = item.tokens && typeof item.tokens === 'object' ? (item.tokens as Record<string, unknown>) : item;
  const idToken = str(tokens.id_token ?? tokens.idToken);
  const accessToken = str(tokens.access_token ?? tokens.accessToken);
  const refreshToken = str(tokens.refresh_token ?? tokens.refreshToken);
  if (!idToken || !accessToken || !refreshToken) {
    return { error: 'Thiếu id_token, access_token hoặc refresh_token' };
  }
  if (item.type !== undefined && str(item.type).toLowerCase() !== 'codex') {
    return { error: `Mục này là tài khoản "${str(item.type)}", không phải Codex` };
  }

  const claims = decodeJwtPayload(idToken);
  const auth = claims?.['https://api.openai.com/auth'];
  const authClaims = auth && typeof auth === 'object' ? (auth as Record<string, unknown>) : {};
  const claimAccountId = str(authClaims.chatgpt_account_id);
  const email = (str(item.email) || str(claims?.email)).toLowerCase() || null;
  const lastRefresh = str(item.last_refresh ?? item.lastRefresh);

  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: str(tokens.account_id ?? tokens.accountId ?? item.account_id) || claimAccountId || null,
    lastRefresh: Number.isFinite(Date.parse(lastRefresh)) ? lastRefresh : new Date().toISOString(),
    email: email && email.includes('@') ? email : null,
    plan: normalizePlan(str(authClaims.chatgpt_plan_type), str(item.plan_type ?? item.plan)),
  };
}

/**
 * Ghi auth.json theo định dạng Codex CLI vào CODEX_HOME riêng của hồ sơ.
 * Thư mục 0700, file 0600; không bao giờ đọc lại hay log nội dung.
 */
export function writeCodexAuthFile(codexHome: string, data: CodexTokenData): void {
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const payload = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: data.idToken,
      access_token: data.accessToken,
      refresh_token: data.refreshToken,
      account_id: data.accountId,
    },
    last_refresh: data.lastRefresh,
  };
  const file = path.join(codexHome, 'auth.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}
