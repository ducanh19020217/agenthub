import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ProfileRow } from '../db/index.js';

export type CockpitSource = 'antigravity' | 'codex' | 'claude';
export type CockpitHubStatus = 'new' | 'exists' | 'conflict';

export interface CockpitScanItem {
  source: CockpitSource;
  cockpitId: string;
  email: string;
  /** Tên hiển thị trong Cockpit (Antigravity), nếu có. */
  name?: string;
  /** Gói tài khoản theo chỉ mục Cockpit (plus, pro, max…), nếu có. */
  planType?: string;
  disabled: boolean;
  importable: boolean;
  skipReason?: string;
  hubStatus: CockpitHubStatus;
}

export interface CockpitScanResult {
  dataDir: string | null;
  exists: boolean;
  schemaVersion: string;
  items: CockpitScanItem[];
}

/** Expand leading ~ in file paths */
export function expandHomeDir(dirPath: string): string {
  if (dirPath === '~') return os.homedir();
  if (dirPath.startsWith('~/') || dirPath.startsWith('~\\')) {
    return path.join(os.homedir(), dirPath.slice(2));
  }
  return dirPath;
}

/**
 * Resolve Cockpit data directory path in order:
 * 1. Explicit argument / config integrations.cockpit.dataDir
 * 2. COCKPIT_TOOLS_DATA_DIR environment variable
 * 3. ~/.cockpit_tools (if exists)
 * 4. ~/.antigravity_cockpit (if exists)
 * 5. Fallback: ~/.cockpit_tools
 */
export function resolveCockpitDir(configDataDir?: string): string {
  if (configDataDir && configDataDir.trim()) {
    return path.resolve(expandHomeDir(configDataDir.trim()));
  }

  const envDir = process.env.COCKPIT_TOOLS_DATA_DIR;
  if (envDir && envDir.trim()) {
    return path.resolve(expandHomeDir(envDir.trim()));
  }

  const currentDefault = path.join(os.homedir(), '.cockpit_tools');
  if (fs.existsSync(currentDefault)) {
    return currentDefault;
  }

  const legacyDefault = path.join(os.homedir(), '.antigravity_cockpit');
  if (fs.existsSync(legacyDefault)) {
    return legacyDefault;
  }

  return currentDefault;
}

function safeReadJson(filePath: string): unknown | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Thông tin không nhạy cảm lấy từ file chỉ mục Cockpit (luôn để dạng thường). */
interface CockpitIndexMeta { email: string; name?: string; planType?: string }

/** Đọc email, tên, gói từ mảng `accounts` của file chỉ mục, theo id. */
function readIndexMeta(indexRaw: Record<string, unknown> | null): Map<string, CockpitIndexMeta> {
  const meta = new Map<string, CockpitIndexMeta>();
  if (!indexRaw || !Array.isArray(indexRaw.accounts)) return meta;
  for (const acc of indexRaw.accounts) {
    if (!acc || typeof acc !== 'object') continue;
    const row = acc as Record<string, unknown>;
    if (typeof row.id !== 'string') continue;
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined;
    const planType = typeof row.plan_type === 'string' && row.plan_type.trim() ? row.plan_type.trim() : undefined;
    meta.set(row.id, { email: String(row.email || '').trim().toLowerCase(), name, planType });
  }
  return meta;
}

/**
 * Cockpit (từ bản có secure_account_storage) mã hoá file chi tiết tài khoản bằng AES-256-GCM:
 * `{ version, kind, algorithm, key_id, nonce, ciphertext }`. Chỉ mục vẫn để dạng thường.
 */
function isSecureEnvelope(data: Record<string, unknown>): boolean {
  return typeof data.ciphertext === 'string' && typeof data.nonce === 'string';
}

/** File khoá AES-256-GCM của Cockpit: 32 byte ngẫu nhiên dạng base64, nằm trong thư mục dữ liệu. */
export const COCKPIT_KEY_FILE = 'secure-account-storage.key';

/**
 * Đọc khoá giải mã của Cockpit. Trả về chuỗi lỗi (tiếng Việt) thay vì ném lỗi để
 * bộ quét có thể ghi lý do theo từng tài khoản.
 */
export function loadCockpitKey(dir: string): Buffer | string {
  const keyPath = path.join(path.resolve(expandHomeDir(dir)), COCKPIT_KEY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(keyPath, 'utf8');
  } catch {
    return `Không tìm thấy khoá giải mã ${COCKPIT_KEY_FILE} của Cockpit. Hãy nhập file Export từ Cockpit`;
  }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    return `Khoá ${COCKPIT_KEY_FILE} không đúng định dạng (cần 32 byte base64). Hãy nhập file Export từ Cockpit`;
  }
  return key;
}

/**
 * Giải mã envelope `{ nonce, ciphertext }` (base64) của Cockpit. Định dạng AES-256-GCM:
 * nonce 12 byte, ciphertext có 16 byte tag xác thực nối ở cuối, bản rõ là JSON tài khoản.
 * Ném lỗi với thông báo không chứa dữ liệu nhạy cảm.
 */
export function decryptCockpitEnvelope(envelope: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const nonce = Buffer.from(String(envelope.nonce || '').trim(), 'base64');
  const sealed = Buffer.from(String(envelope.ciphertext || '').trim(), 'base64');
  if (nonce.length !== 12 || sealed.length <= 16) {
    throw new Error('Dữ liệu mã hoá của Cockpit không đúng định dạng');
  }
  const algorithm = String(envelope.algorithm || 'aes-256-gcm').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (algorithm && algorithm !== 'aes256gcm') {
    throw new Error(`Cockpit dùng thuật toán mã hoá chưa hỗ trợ (${String(envelope.algorithm)})`);
  }
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  } catch {
    throw new Error('Không giải mã được: khoá Cockpit không khớp hoặc file đã hỏng');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('Giải mã xong nhưng nội dung không phải JSON hợp lệ');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Giải mã xong nhưng nội dung không phải tài khoản hợp lệ');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Đọc một file tài khoản Cockpit, tự giải mã nếu là envelope. Chỉ dùng phía server;
 * không bao giờ log hay trả kết quả ra API.
 */
export function loadCockpitAccountData(dir: string, subdir: string, cockpitId: string, label: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9._-]+$/.test(cockpitId)) {
    throw new Error(`Mã tài khoản ${label} Cockpit không hợp lệ`);
  }
  const resolved = path.resolve(expandHomeDir(dir));
  const accFile = path.join(resolved, subdir, `${cockpitId}.json`);
  if (!fs.existsSync(accFile)) {
    throw new Error(`Tài khoản ${label} Cockpit "${cockpitId}" không tồn tại`);
  }
  const data = JSON.parse(fs.readFileSync(accFile, 'utf8')) as Record<string, unknown>;
  if (!isSecureEnvelope(data)) return data;
  const key = loadCockpitKey(resolved);
  if (typeof key === 'string') throw new Error(key);
  return decryptCockpitEnvelope(data, key);
}

/** Giải mã tại chỗ trong lúc quét; trả lỗi dạng chuỗi để ghi vào skipReason. */
function unwrapForScan(data: Record<string, unknown>, key: Buffer | string): { data: Record<string, unknown>; error?: string } {
  if (!isSecureEnvelope(data)) return { data };
  if (typeof key === 'string') return { data, error: key };
  try {
    return { data: decryptCockpitEnvelope(data, key) };
  } catch (err) {
    return { data, error: err instanceof Error ? err.message : String(err) };
  }
}

function listAccountFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.json') && !file.startsWith('.'))
      .map((file) => file.slice(0, -5));
  } catch {
    return [];
  }
}

function matchProfileStatus(
  source: CockpitSource,
  cockpitId: string,
  email: string,
  existingProfiles: ProfileRow[],
): CockpitHubStatus {
  const engine = source === 'antigravity' ? 'agy' : source;
  const cleanEmail = email.toLowerCase();

  const byCockpitId = existingProfiles.find(
    (p) => p.engine === engine && p.source === 'cockpit' && p.cockpitId === cockpitId,
  );
  if (byCockpitId) {
    if (cleanEmail && (byCockpitId.email || '').toLowerCase() !== cleanEmail) {
      return 'conflict';
    }
    return 'exists';
  }

  if (cleanEmail) {
    const byEmail = existingProfiles.find(
      (p) => p.engine === engine && (p.email || '').toLowerCase() === cleanEmail,
    );
    if (byEmail) {
      return 'exists';
    }
  }

  return 'new';
}

/**
 * Scan Cockpit data directory and return account metadata without tokens.
 */
export function scanCockpit(dir: string, existingProfiles: ProfileRow[] = []): CockpitScanResult {
  const resolvedDir = path.resolve(expandHomeDir(dir));
  if (!fs.existsSync(resolvedDir)) {
    return {
      dataDir: resolvedDir,
      exists: false,
      schemaVersion: 'unknown',
      items: [],
    };
  }

  const schemaVersions: string[] = [];
  const items: CockpitScanItem[] = [];

  // --- 1. Antigravity ---
  // Khoá chỉ đọc khi thật sự gặp file mã hoá, để thư mục không mã hoá vẫn quét bình thường.
  let cockpitKey: Buffer | string | undefined;
  const getKey = (): Buffer | string => (cockpitKey ??= loadCockpitKey(resolvedDir));
  const agyIndexFile = path.join(resolvedDir, 'accounts.json');
  const agyAccountsDir = path.join(resolvedDir, 'accounts');
  const agyKeyFile = path.join(resolvedDir, 'account-token.key');
  const hasAgyKeyFile = fs.existsSync(agyKeyFile);

  const agyIds = new Set<string>();
  const agyIndexRaw = safeReadJson(agyIndexFile) as Record<string, unknown> | null;
  if (agyIndexRaw) {
    if (typeof agyIndexRaw.version === 'string') {
      schemaVersions.push(`accounts:${agyIndexRaw.version}`);
    }
    if (Array.isArray(agyIndexRaw.accounts)) {
      for (const acc of agyIndexRaw.accounts) {
        if (acc && typeof acc === 'object' && typeof (acc as Record<string, unknown>).id === 'string') {
          agyIds.add((acc as Record<string, unknown>).id as string);
        }
      }
    }
  }
  for (const id of listAccountFiles(agyAccountsDir)) {
    agyIds.add(id);
  }
  const agyMeta = readIndexMeta(agyIndexRaw);

  for (const id of agyIds) {
    const accFile = path.join(agyAccountsDir, `${id}.json`);
    let data: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(accFile, 'utf8');
      data = JSON.parse(raw);
    } catch {
      items.push({
        source: 'antigravity',
        cockpitId: id,
        email: agyMeta.get(id)?.email || '',
        disabled: false,
        importable: false,
        skipReason: 'File JSON hỏng',
        hubStatus: 'new',
      });
      continue;
    }

    const unwrapped = unwrapForScan(data, isSecureEnvelope(data) ? getKey() : '');
    data = unwrapped.data;
    const decryptError = unwrapped.error;
    const meta = agyMeta.get(id);
    const email = String(data.email || meta?.email || '').trim().toLowerCase();
    const disabled = Boolean(data.disabled);
    const tokenObj = data.token && typeof data.token === 'object' ? (data.token as Record<string, unknown>) : null;

    let importable = true;
    let skipReason: string | undefined;

    const isEncryptedEnvelope = Boolean(
      (tokenObj && (tokenObj.ciphertext || tokenObj.nonce || tokenObj.algorithm)) ||
      data.ciphertext ||
      (hasAgyKeyFile && tokenObj && !tokenObj.refresh_token),
    );

    if (decryptError) {
      importable = false;
      skipReason = decryptError;
    } else if (isEncryptedEnvelope) {
      importable = false;
      skipReason = 'Token mã hoá kiểu cũ, hãy mở Cockpit để nâng cấp';
    } else if (!tokenObj || typeof tokenObj.refresh_token !== 'string' || !tokenObj.refresh_token.trim()) {
      importable = false;
      skipReason = 'Thiếu refresh_token Antigravity';
    } else if (!email || !email.includes('@')) {
      importable = false;
      skipReason = 'Thiếu email hợp lệ';
    }

    const hubStatus = matchProfileStatus('antigravity', id, email, existingProfiles);
    items.push({
      source: 'antigravity',
      cockpitId: id,
      email,
      ...(meta?.name ? { name: meta.name } : {}),
      ...(meta?.planType ? { planType: meta.planType } : {}),
      disabled,
      importable,
      skipReason,
      hubStatus,
    });
  }

  // --- 2. Codex ---
  const codexIndexFile = path.join(resolvedDir, 'codex_accounts.json');
  const codexAccountsDir = path.join(resolvedDir, 'codex_accounts');
  const codexIds = new Set<string>();

  const codexIndexRaw = safeReadJson(codexIndexFile) as Record<string, unknown> | null;
  if (codexIndexRaw) {
    if (typeof codexIndexRaw.version === 'string') {
      schemaVersions.push(`codex:${codexIndexRaw.version}`);
    }
    if (Array.isArray(codexIndexRaw.accounts)) {
      for (const acc of codexIndexRaw.accounts) {
        if (acc && typeof acc === 'object' && typeof (acc as Record<string, unknown>).id === 'string') {
          codexIds.add((acc as Record<string, unknown>).id as string);
        }
      }
    }
  }
  for (const id of listAccountFiles(codexAccountsDir)) {
    codexIds.add(id);
  }
  const codexMeta = readIndexMeta(codexIndexRaw);

  for (const id of codexIds) {
    const accFile = path.join(codexAccountsDir, `${id}.json`);
    let data: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(accFile, 'utf8');
      data = JSON.parse(raw);
    } catch {
      items.push({
        source: 'codex',
        cockpitId: id,
        email: codexMeta.get(id)?.email || '',
        disabled: false,
        importable: false,
        skipReason: 'File JSON hỏng',
        hubStatus: 'new',
      });
      continue;
    }

    const unwrapped = unwrapForScan(data, isSecureEnvelope(data) ? getKey() : '');
    data = unwrapped.data;
    const decryptError = unwrapped.error;
    const meta = codexMeta.get(id);
    const email = String(data.email || meta?.email || '').trim().toLowerCase();
    const disabled = Boolean(data.disabled || data.requires_reauth);
    const authMode = String(data.auth_mode || '').trim().toLowerCase();
    const apiProviderId = String(data.api_provider_id || '').trim();

    let importable = true;
    let skipReason: string | undefined;

    if (decryptError) {
      importable = false;
      skipReason = decryptError;
    } else if (authMode === 'apikey' || authMode === 'api_key' || Boolean(data.openai_api_key)) {
      importable = false;
      skipReason = 'Bỏ qua tài khoản API key';
    } else if (apiProviderId === 'cockpit_chatgpt_plan' || id.startsWith('chatgpt_plan_')) {
      importable = false;
      skipReason = 'Bỏ qua tài khoản ChatGPT plan nội bộ';
    } else {
      const tokens = data.tokens && typeof data.tokens === 'object' ? (data.tokens as Record<string, unknown>) : null;
      if (!tokens || typeof tokens.id_token !== 'string' || typeof tokens.access_token !== 'string') {
        importable = false;
        skipReason = 'Thiếu token Codex (cần id_token và access_token)';
      } else if (!email || !email.includes('@')) {
        importable = false;
        skipReason = 'Thiếu email hợp lệ';
      }
    }

    const hubStatus = matchProfileStatus('codex', id, email, existingProfiles);
    items.push({
      source: 'codex',
      cockpitId: id,
      email,
      ...(meta?.name ? { name: meta.name } : {}),
      ...(meta?.planType ? { planType: meta.planType } : {}),
      disabled,
      importable,
      skipReason,
      hubStatus,
    });
  }

  // --- 3. Claude ---
  const claudeIndexFile = path.join(resolvedDir, 'claude_accounts.json');
  const claudeAccountsDir = path.join(resolvedDir, 'claude_accounts');
  const claudeIds = new Set<string>();

  const claudeIndexRaw = safeReadJson(claudeIndexFile) as Record<string, unknown> | null;
  if (claudeIndexRaw) {
    if (typeof claudeIndexRaw.version === 'string') {
      schemaVersions.push(`claude:${claudeIndexRaw.version}`);
    }
    if (Array.isArray(claudeIndexRaw.accounts)) {
      for (const acc of claudeIndexRaw.accounts) {
        if (acc && typeof acc === 'object' && typeof (acc as Record<string, unknown>).id === 'string') {
          claudeIds.add((acc as Record<string, unknown>).id as string);
        }
      }
    }
  }
  for (const id of listAccountFiles(claudeAccountsDir)) {
    claudeIds.add(id);
  }
  const claudeMeta = readIndexMeta(claudeIndexRaw);

  for (const id of claudeIds) {
    const accFile = path.join(claudeAccountsDir, `${id}.json`);
    let data: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(accFile, 'utf8');
      data = JSON.parse(raw);
    } catch {
      items.push({
        source: 'claude',
        cockpitId: id,
        email: claudeMeta.get(id)?.email || '',
        disabled: false,
        importable: false,
        skipReason: 'File JSON hỏng',
        hubStatus: 'new',
      });
      continue;
    }

    const unwrapped = unwrapForScan(data, isSecureEnvelope(data) ? getKey() : '');
    data = unwrapped.data;
    const decryptError = unwrapped.error;
    const meta = claudeMeta.get(id);
    const email = String(data.email || meta?.email || '').trim().toLowerCase();
    const disabled = Boolean(data.disabled || data.status === 'disabled');
    const authMode = String(data.auth_mode || '').trim().toLowerCase();

    let importable = true;
    let skipReason: string | undefined;

    if (decryptError) {
      importable = false;
      skipReason = decryptError;
    } else if (authMode === 'desktop_oauth') {
      importable = false;
      skipReason = 'Bỏ qua tài khoản desktop_oauth';
    } else if (authMode === 'api_key' || authMode === 'apikey') {
      importable = false;
      skipReason = 'Bỏ qua tài khoản API key';
    } else if (authMode && authMode !== 'oauth') {
      importable = false;
      skipReason = `Chỉ hỗ trợ auth_mode = oauth (bỏ qua ${authMode})`;
    } else {
      const credsRaw = data.claude_credentials_raw && typeof data.claude_credentials_raw === 'object'
        ? (data.claude_credentials_raw as Record<string, unknown>)
        : null;
      const oauth = credsRaw?.claudeAiOauth && typeof credsRaw.claudeAiOauth === 'object'
        ? (credsRaw.claudeAiOauth as Record<string, unknown>)
        : null;

      if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) {
        importable = false;
        skipReason = 'Thiếu credentials Claude OAuth (claudeAiOauth.accessToken)';
      } else if (!email || !email.includes('@')) {
        importable = false;
        skipReason = 'Thiếu email hợp lệ';
      }
    }

    const hubStatus = matchProfileStatus('claude', id, email, existingProfiles);
    items.push({
      source: 'claude',
      cockpitId: id,
      email,
      ...(meta?.name ? { name: meta.name } : {}),
      ...(meta?.planType ? { planType: meta.planType } : {}),
      disabled,
      importable,
      skipReason,
      hubStatus,
    });
  }

  // Sort: antigravity, codex, claude; then by email
  const sourceOrder: Record<CockpitSource, number> = { antigravity: 0, codex: 1, claude: 2 };
  items.sort((a, b) => {
    const diff = sourceOrder[a.source] - sourceOrder[b.source];
    if (diff !== 0) return diff;
    return a.email.localeCompare(b.email);
  });

  return {
    dataDir: resolvedDir,
    exists: true,
    schemaVersion: schemaVersions.join(',') || '1.0',
    items,
  };
}

/**
 * Server-only helper to read an Antigravity account token from Cockpit storage.
 * Never log or expose the returned token.
 */
export function readCockpitAgyAccount(dir: string, cockpitId: string): {
  id: string;
  email: string;
  refreshToken: string;
  disabled: boolean;
} {
  const data = loadCockpitAccountData(dir, 'accounts', cockpitId, 'Antigravity');
  const tokenObj = data.token && typeof data.token === 'object' ? (data.token as Record<string, unknown>) : null;
  const refreshToken = typeof tokenObj?.refresh_token === 'string' ? tokenObj.refresh_token.trim() : '';
  const email = String(data.email || '').trim().toLowerCase();

  if (!refreshToken) {
    throw new Error(`Tài khoản Antigravity "${cockpitId}" không có refresh_token hợp lệ`);
  }
  if (!email || !email.includes('@')) {
    throw new Error(`Tài khoản Antigravity "${cockpitId}" không có email hợp lệ`);
  }

  return {
    id: cockpitId,
    email,
    refreshToken,
    disabled: Boolean(data.disabled),
  };
}

/**
 * Server-only helper to read a Codex account token from Cockpit storage.
 * Never log or expose the returned token.
 */
export function readCockpitCodexAccount(dir: string, cockpitId: string): {
  id: string;
  email: string;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    account_id?: string | null;
  };
  accountId: string | null;
  planType: string | null;
  disabled: boolean;
} {
  const data = loadCockpitAccountData(dir, 'codex_accounts', cockpitId, 'Codex');
  const authMode = String(data.auth_mode || '').trim().toLowerCase();
  if (authMode === 'apikey' || authMode === 'api_key' || Boolean(data.openai_api_key)) {
    throw new Error(`Tài khoản Codex "${cockpitId}" là tài khoản API key, không thể nhập`);
  }
  if (String(data.api_provider_id || '') === 'cockpit_chatgpt_plan' || cockpitId.startsWith('chatgpt_plan_')) {
    throw new Error(`Tài khoản Codex "${cockpitId}" là tài khoản ChatGPT plan nội bộ, không thể nhập`);
  }

  const rawTokens = data.tokens && typeof data.tokens === 'object' ? (data.tokens as Record<string, unknown>) : null;
  const idToken = typeof rawTokens?.id_token === 'string' ? rawTokens.id_token.trim() : '';
  const accessToken = typeof rawTokens?.access_token === 'string' ? rawTokens.access_token.trim() : '';
  const refreshToken = typeof rawTokens?.refresh_token === 'string' ? rawTokens.refresh_token.trim() : undefined;
  const accountId = (typeof data.account_id === 'string' ? data.account_id : typeof rawTokens?.account_id === 'string' ? rawTokens.account_id : null) || null;
  const email = String(data.email || '').trim().toLowerCase();
  const planType = typeof data.plan_type === 'string' ? data.plan_type : null;

  if (!idToken || !accessToken) {
    throw new Error(`Tài khoản Codex "${cockpitId}" thiếu id_token hoặc access_token`);
  }
  if (!email || !email.includes('@')) {
    throw new Error(`Tài khoản Codex "${cockpitId}" không có email hợp lệ`);
  }

  return {
    id: cockpitId,
    email,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      account_id: accountId,
    },
    accountId,
    planType,
    disabled: Boolean(data.disabled || data.requires_reauth),
  };
}

/**
 * Server-only helper to read a Claude account token from Cockpit storage.
 * Never log or expose the returned token.
 */
export function readCockpitClaudeAccount(dir: string, cockpitId: string): {
  id: string;
  email: string;
  claudeAiOauth: Record<string, unknown>;
  accountUuid?: string | null;
  organizationUuid?: string | null;
  organizationName?: string | null;
  planType?: string | null;
  disabled: boolean;
} {
  const data = loadCockpitAccountData(dir, 'claude_accounts', cockpitId, 'Claude');
  const authMode = String(data.auth_mode || '').trim().toLowerCase();
  if (authMode !== 'oauth') {
    throw new Error(`Tài khoản Claude "${cockpitId}" có auth_mode="${authMode}", chỉ hỗ trợ "oauth"`);
  }

  const rawCreds = data.claude_credentials_raw && typeof data.claude_credentials_raw === 'object'
    ? (data.claude_credentials_raw as Record<string, unknown>)
    : null;
  const oauth = rawCreds?.claudeAiOauth && typeof rawCreds.claudeAiOauth === 'object'
    ? (rawCreds.claudeAiOauth as Record<string, unknown>)
    : null;

  const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : '';
  const email = String(data.email || '').trim().toLowerCase();

  if (!accessToken) {
    throw new Error(`Tài khoản Claude "${cockpitId}" thiếu claudeAiOauth.accessToken`);
  }
  if (!email || !email.includes('@')) {
    throw new Error(`Tài khoản Claude "${cockpitId}" không có email hợp lệ`);
  }

  return {
    id: cockpitId,
    email,
    claudeAiOauth: oauth!,
    accountUuid: typeof data.account_uuid === 'string' ? data.account_uuid : null,
    organizationUuid: typeof data.organization_uuid === 'string' ? data.organization_uuid : null,
    organizationName: typeof data.organization_name === 'string' ? data.organization_name : null,
    planType: typeof data.plan_type === 'string' ? data.plan_type : null,
    disabled: Boolean(data.disabled || data.status === 'disabled'),
  };
}

/**
 * Nhận diện loại tài khoản trong file Export của Cockpit theo từng mục:
 * Codex có `tokens.id_token`, Claude có `claude_credentials_raw.claudeAiOauth` (hoặc `claudeAiOauth`),
 * Antigravity có `refresh_token` (hoặc `token.refresh_token`).
 */
export function detectCockpitExportSource(item: Record<string, unknown>): CockpitSource | null {
  const tokens = item.tokens && typeof item.tokens === 'object' ? (item.tokens as Record<string, unknown>) : null;
  if (tokens && (typeof tokens.id_token === 'string' || typeof tokens.idToken === 'string')) return 'codex';
  const creds = item.claude_credentials_raw && typeof item.claude_credentials_raw === 'object'
    ? (item.claude_credentials_raw as Record<string, unknown>)
    : item;
  if (creds.claudeAiOauth && typeof creds.claudeAiOauth === 'object') return 'claude';
  const token = item.token && typeof item.token === 'object' ? (item.token as Record<string, unknown>) : null;
  if (typeof item.refresh_token === 'string' || typeof item.refreshToken === 'string' || typeof token?.refresh_token === 'string') {
    return 'antigravity';
  }
  return null;
}
