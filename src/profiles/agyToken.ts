import fs from 'node:fs';
import path from 'node:path';

const AGY_CLIENT_ID_BYTES = [6,7,0,6,7,7,1,7,1,7,2,14,6,26,67,90,95,68,68,94,89,5,95,5,6,91,84,69,82,5,4,2,65,67,88,91,88,93,95,3,80,3,7,4,82,71,25,86,71,71,68,25,80,88,88,80,91,82,66,68,82,69,84,88,89,67,82,89,67,25,84,88,90];
const AGY_CLIENT_SECRET_BYTES = [112,120,116,100,103,111,26,124,2,15,113,96,101,3,15,1,123,83,123,125,6,90,123,117,15,68,111,116,3,77,1,70,115,118,81];

function xorDecode(bytes: number[], mask = 0x37): string {
  return Buffer.from(bytes.map((b) => b ^ mask)).toString('utf8');
}

export function getAgyGoogleClientId(): string {
  return process.env.AGENTHUB_AGY_CLIENT_ID || xorDecode(AGY_CLIENT_ID_BYTES);
}

export function getAgyGoogleClientSecret(): string {
  return process.env.AGENTHUB_AGY_CLIENT_SECRET || xorDecode(AGY_CLIENT_SECRET_BYTES);
}

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface ExchangedTokenData {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  expiry: string;
  expiresIn: number;
  idToken?: string;
}

/**
 * Trao đổi Antigravity refresh_token với Google OAuth để lấy access_token mới và kiểm tra tính hợp lệ của token.
 */
export async function exchangeAgyRefreshToken(
  refreshToken: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ExchangedTokenData> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const signal = options?.signal ?? AbortSignal.timeout(timeoutMs);

  const body = new URLSearchParams({
    client_id: getAgyGoogleClientId(),
    client_secret: getAgyGoogleClientSecret(),
    refresh_token: refreshToken.trim(),
    grant_type: 'refresh_token',
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Không thể kết nối tới Google OAuth endpoint: ${message}`);
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Phản hồi không hợp lệ từ Google OAuth (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const errorMsg = String(data?.error_description || data?.error || `HTTP ${response.status}`);
    if (data?.error === 'invalid_grant') {
      throw new Error(`Refresh token không hợp lệ hoặc đã bị thu hồi/hết hạn (${errorMsg})`);
    }
    throw new Error(`Google OAuth từ chối xác thực: ${errorMsg}`);
  }

  const accessToken = typeof data?.access_token === 'string' ? data.access_token : '';
  if (!accessToken) {
    throw new Error('Google OAuth phản hồi thành công nhưng không chứa access_token');
  }

  const expiresInSec = typeof data?.expires_in === 'number' ? data.expires_in : 3600;
  const expiry = new Date(Date.now() + expiresInSec * 1000).toISOString();

  return {
    accessToken,
    tokenType: typeof data?.token_type === 'string' ? data.token_type : 'Bearer',
    refreshToken: refreshToken.trim(),
    expiry,
    expiresIn: expiresInSec,
    // Có khi scope gồm openid (agy xin openid); agy lưu kèm trong file token.
    idToken: typeof data?.id_token === 'string' ? data.id_token : undefined,
  };
}

/**
 * Ghi cấu trúc token Antigravity CLI và log xác thực vào thư mục isolated home của profile.
 * Đảm bảo quyền bảo mật nghiêm ngặt: thư mục 0700, file 0600.
 */
export function writeAgyIsolatedToken(
  profileHome: string,
  tokenData: {
    accessToken?: string;
    refreshToken: string;
    tokenType?: string;
    expiry?: string;
    expiresIn?: number;
    idToken?: string;
  },
  email?: string | null,
): void {
  const cliDir = path.join(profileHome, '.gemini', 'antigravity-cli');
  if (!fs.existsSync(cliDir)) {
    fs.mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(cliDir, 0o700);
    } catch {
      // ignore
    }
  }

  // Cùng cấu trúc file agy tự ghi khi đăng nhập Google (người dùng cung cấp, chỉ tên trường).
  const tokenPayload = {
    token: {
      access_token: tokenData.accessToken || '',
      token_type: tokenData.tokenType || 'Bearer',
      refresh_token: tokenData.refreshToken,
      expiry: tokenData.expiry || new Date(Date.now() + 3600 * 1000).toISOString(),
      expires_in: tokenData.expiresIn ?? 3600,
    },
    auth_method: 'consumer',
    ...(tokenData.idToken ? { id_token: tokenData.idToken } : {}),
  };

  const tokenFilePath = path.join(cliDir, 'antigravity-oauth-token');
  fs.writeFileSync(tokenFilePath, JSON.stringify(tokenPayload, null, 2) + '\n', {
    mode: 0o600,
  });
  try {
    fs.chmodSync(tokenFilePath, 0o600);
  } catch {
    // ignore
  }

  // Ghi log giả lập để ProfileService.readEmailFromLog() nhận diện được email ngay lập tức
  if (email && email.trim()) {
    const cleanEmail = email.trim();
    const logDir = path.join(cliDir, 'log');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    }
    const logFilePath = path.join(logDir, 'auth.log');
    const logContent = `[${new Date().toISOString()}] authenticated successfully as ${cleanEmail}\n`;
    // Ghi đè (không append): readEmailFromLog lấy match đầu tiên trong file, append sẽ giữ email cũ.
    fs.writeFileSync(logFilePath, logContent, { mode: 0o600 });
    try {
      fs.chmodSync(logFilePath, 0o600);
    } catch {
      // ignore
    }
  }
}

export interface GoogleUserInfo {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * Lấy thông tin tài khoản Google (bao gồm picture / avatar) từ Google OAuth userinfo endpoint.
 * `status` cho biết vì sao thất bại (mã HTTP, hoặc 0 khi lỗi mạng) để báo cho người dùng.
 */
export async function fetchAgyGoogleUserInfo(
  accessToken: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<GoogleUserInfo | null> {
  const result = await fetchAgyGoogleUserInfoDetailed(accessToken, options);
  return result.info;
}

export async function fetchAgyGoogleUserInfoDetailed(
  accessToken: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ info: GoogleUserInfo | null; status: number }> {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const signal = options?.signal ?? AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });
    if (!response.ok) return { info: null, status: response.status };
    const data = (await response.json()) as Record<string, unknown>;
    return {
      status: response.status,
      info: {
        sub: typeof data.sub === 'string' ? data.sub : undefined,
        email: typeof data.email === 'string' ? data.email : undefined,
        name: typeof data.name === 'string' ? data.name : undefined,
        picture: typeof data.picture === 'string' ? data.picture : undefined,
      },
    };
  } catch {
    return { info: null, status: 0 };
  }
}

export type AgyAccessTokenSkip = 'no_token_file' | 'unreadable' | 'no_access_token' | 'expired';

/**
 * Ngoại lệ DEC-007: chỉ lấy access_token còn hạn để gọi Google userinfo.
 * Không đọc refresh_token, không ghi lại file, không log token.
 */
export function inspectAgyAccessToken(
  profileHome: string,
): { accessToken: string } | { skip: AgyAccessTokenSkip; fieldNames?: string[] } {
  const tokenFile = path.join(profileHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  if (!fs.existsSync(tokenFile)) return { skip: 'no_token_file' };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  } catch {
    return { skip: 'unreadable' };
  }
  // agy tự ghi file theo định dạng riêng (có thể lồng nhau, camelCase); file do hub ghi thì phẳng.
  const found = findAccessTokenFields(raw);
  if (!found) return { skip: 'no_access_token', fieldNames: listFieldNames(raw) };
  // Không có expiry thì cứ thử; Google sẽ trả 401 nếu token đã hết hạn.
  if (found.expiresAt !== null && found.expiresAt <= Date.now() + 60_000) return { skip: 'expired' };
  return { accessToken: found.accessToken };
}

const ACCESS_TOKEN_KEY = /^access_?token$/i;
const EXPIRY_KEY = /^(expiry|expires_?at|expiry_?date|expiration)$/i;

/** Tìm access token và thời điểm hết hạn (ms) của cùng một object, duyệt tối đa 4 cấp. */
function findAccessTokenFields(value: unknown, depth = 0): { accessToken: string; expiresAt: number | null } | null {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  const token = entries.find(([key, v]) => ACCESS_TOKEN_KEY.test(key) && typeof v === 'string' && v.length > 0);
  if (token) {
    const expiry = entries.find(([key]) => EXPIRY_KEY.test(key))?.[1];
    return { accessToken: token[1] as string, expiresAt: parseExpiry(expiry) };
  }
  for (const [, v] of entries) {
    const nested = findAccessTokenFields(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Chỉ tên trường (vd. `token.foo`), không bao giờ có giá trị; dùng để chẩn đoán định dạng file. */
function listFieldNames(value: unknown, prefix = '', depth = 0): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    const nested = listFieldNames(v, name, depth + 1);
    return nested.length > 0 ? nested : [name];
  });
}

function parseExpiry(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000; // ms hoặc giây
  }
  if (typeof value === 'string') {
    const parsed = /^\d+$/.test(value) ? parseExpiry(Number(value)) : Date.parse(value);
    return parsed !== null && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function readAgyAccessToken(profileHome: string): string | null {
  const result = inspectAgyAccessToken(profileHome);
  return 'accessToken' in result ? result.accessToken : null;
}

export const CLOUD_CODE_LOAD_CODE_ASSIST_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

function cloudCodePlatform(): string {
  const os = process.platform === 'darwin' ? 'DARWIN' : process.platform === 'win32' ? 'WINDOWS' : process.platform === 'linux' ? 'LINUX' : '';
  const arch = process.arch === 'x64' ? 'AMD64' : process.arch === 'arm64' ? 'ARM64' : '';
  return os && arch ? `${os}_${arch}` : 'PLATFORM_UNSPECIFIED';
}

/** Đổi tier id của Code Assist (vd. g1-pro-tier, g1-ultra-tier, free-tier) thành gói, giống Cockpit tools. */
export function agyTierToPlan(tierId: string | null | undefined): string | null {
  const tier = (tierId || '').trim().toLowerCase();
  if (!tier) return null;
  if (tier.includes('ultra')) return 'ultra';
  if (tier.includes('pro')) return 'pro';
  return 'free';
}

/**
 * Hỏi gói Google AI của tài khoản agy qua Code Assist `loadCodeAssist` (cách Cockpit tools và agy dùng):
 * paidTier.id, không có thì currentTier.id. `status` là mã HTTP (0 khi lỗi mạng) để báo lý do.
 */
export async function fetchAgyTier(
  accessToken: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ tierId: string | null; status: number }> {
  const signal = options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 10_000);
  try {
    const response = await fetch(CLOUD_CODE_LOAD_CODE_ASSIST_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metadata: { ideName: 'antigravity', ideType: 'ANTIGRAVITY', platform: cloudCodePlatform(), pluginType: 'GEMINI' },
        mode: 'FULL_ELIGIBILITY_CHECK',
      }),
      signal,
    });
    if (!response.ok) return { tierId: null, status: response.status };
    const data = (await response.json()) as { paidTier?: { id?: unknown }; currentTier?: { id?: unknown } };
    const pick = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return { tierId: pick(data?.paidTier?.id) ?? pick(data?.currentTier?.id), status: response.status };
  } catch {
    return { tierId: null, status: 0 };
  }
}
