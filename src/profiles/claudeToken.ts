import fs from 'node:fs';
import path from 'node:path';
import { normalizePlan } from './plan.js';

export const CLAUDE_OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';

export interface ClaudeTokenData {
  email: string;
  claudeAiOauth: Record<string, unknown>;
  accountUuid?: string | null;
  organizationUuid?: string | null;
  organizationName?: string | null;
  planType?: string | null;
}

export interface ClaudeVerifyResult {
  email?: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationName?: string;
  plan?: string | null;
}

/** Read an OAuth access token for verification without ever exposing it to logs or API output. */
export function readClaudeOAuthAccessToken(home: string, systemProfile: boolean): string | null {
  const file = path.join(home, systemProfile ? '.claude/.credentials.json' : '.credentials.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const oauth = value.claudeAiOauth;
    const token = oauth && typeof oauth === 'object' ? (oauth as Record<string, unknown>).accessToken : undefined;
    return typeof token === 'string' && token.trim() ? token : null;
  } catch { return null; }
}

/**
 * Verify Claude OAuth token via Anthropic OAuth profile endpoint.
 * Does NOT invoke Claude CLI.
 */
export async function verifyClaudeOAuthToken(
  accessToken: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ClaudeVerifyResult> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const signal = options?.signal ?? AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(CLAUDE_OAUTH_PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken.trim()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'agenthub',
      },
      signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Không thể kết nối tới Claude OAuth endpoint: ${msg}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Xác thực token Claude thất bại: HTTP ${response.status}${body ? ` ${body}` : ''}`);
  }

  try {
    const data = (await response.json()) as Record<string, unknown>;
    const account = (data.account && typeof data.account === 'object' ? data.account : {}) as Record<string, unknown>;
    const org = (data.organization && typeof data.organization === 'object' ? data.organization : {}) as Record<string, unknown>;

    const email = typeof account.email_address === 'string' ? account.email_address.toLowerCase() : undefined;
    const accountUuid = typeof account.uuid === 'string' ? account.uuid : undefined;
    const organizationUuid = typeof org.uuid === 'string' ? org.uuid : undefined;
    const organizationName = typeof org.name === 'string' ? org.name : undefined;

    return {
      email,
      accountUuid,
      organizationUuid,
      organizationName,
      plan: normalizePlan(
        typeof org.billing_type === 'string' ? org.billing_type : null,
        typeof account.subscription_type === 'string' ? account.subscription_type : null,
      ),
    };
  } catch {
    return {};
  }
}

/**
 * Parse a Claude token item from user input or Cockpit export.
 */
export function parseClaudeTokenItem(raw: Record<string, unknown>): ClaudeTokenData | { error: string } {
  const credsRaw = (raw.claude_credentials_raw && typeof raw.claude_credentials_raw === 'object'
    ? raw.claude_credentials_raw
    : raw) as Record<string, unknown>;
  const oauthRaw = (credsRaw.claudeAiOauth && typeof credsRaw.claudeAiOauth === 'object'
    ? credsRaw.claudeAiOauth
    : raw.tokens && typeof raw.tokens === 'object'
      ? raw.tokens
      : raw) as Record<string, unknown>;

  const accessToken = typeof oauthRaw.accessToken === 'string'
    ? oauthRaw.accessToken.trim()
    : typeof oauthRaw.access_token === 'string'
      ? oauthRaw.access_token.trim()
      : '';

  if (!accessToken) {
    return { error: 'Thiếu accessToken Claude OAuth' };
  }

  const emailRaw = raw.email || oauthRaw.email || (raw.oauthAccount && typeof raw.oauthAccount === 'object' ? (raw.oauthAccount as Record<string, unknown>).emailAddress : undefined);
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return { error: 'Thiếu địa chỉ email hợp lệ cho tài khoản Claude' };
  }

  const claudeAiOauth: Record<string, unknown> = {
    accessToken,
    ...(typeof oauthRaw.refreshToken === 'string' ? { refreshToken: oauthRaw.refreshToken.trim() } : {}),
    ...(typeof oauthRaw.refresh_token === 'string' ? { refreshToken: oauthRaw.refresh_token.trim() } : {}),
    ...(oauthRaw.expiresAt !== undefined ? { expiresAt: oauthRaw.expiresAt } : {}),
    ...(oauthRaw.subscriptionType ? { subscriptionType: oauthRaw.subscriptionType } : {}),
  };

  const accountUuid = typeof raw.account_uuid === 'string' ? raw.account_uuid : typeof raw.accountUuid === 'string' ? raw.accountUuid : null;
  const organizationUuid = typeof raw.organization_uuid === 'string' ? raw.organization_uuid : typeof raw.organizationUuid === 'string' ? raw.organizationUuid : null;
  const organizationName = typeof raw.organization_name === 'string' ? raw.organization_name : typeof raw.organizationName === 'string' ? raw.organizationName : null;
  const planType = typeof raw.plan_type === 'string' ? raw.plan_type : typeof raw.planType === 'string' ? raw.planType : typeof oauthRaw.subscriptionType === 'string' ? oauthRaw.subscriptionType : null;

  return {
    email,
    claudeAiOauth,
    accountUuid,
    organizationUuid,
    organizationName,
    planType,
  };
}

/**
 * Write credentials to isolated Claude home:
 * - <home>/.credentials.json with mode 0600
 * - <home>/.claude.json with mode 0600 (minimum { oauthAccount: { emailAddress } })
 */
export function writeClaudeIsolatedFiles(homeDir: string, data: ClaudeTokenData): void {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  // 1. .credentials.json (mode 0600)
  const credentialsPath = path.join(homeDir, '.credentials.json');
  const credentialsContent = JSON.stringify({ claudeAiOauth: data.claudeAiOauth }, null, 2) + '\n';
  fs.writeFileSync(credentialsPath, credentialsContent, { mode: 0o600 });
  try {
    fs.chmodSync(credentialsPath, 0o600);
  } catch {
    // ignore
  }

  // 2. .claude.json (mode 0600)
  const accountPath = path.join(homeDir, '.claude.json');
  let accountJson: Record<string, unknown> = {};
  if (fs.existsSync(accountPath)) {
    try {
      accountJson = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
    } catch {
      accountJson = {};
    }
  }

  const existingOauth = (accountJson.oauthAccount && typeof accountJson.oauthAccount === 'object'
    ? accountJson.oauthAccount
    : {}) as Record<string, unknown>;

  accountJson.oauthAccount = {
    ...existingOauth,
    emailAddress: data.email,
    ...(data.accountUuid ? { accountUuid: data.accountUuid } : {}),
    ...(data.organizationUuid ? { organizationUuid: data.organizationUuid } : {}),
    ...(data.organizationName ? { organizationName: data.organizationName } : {}),
    ...(data.planType ? { subscriptionType: data.planType, billingType: data.planType } : {}),
  };

  fs.writeFileSync(accountPath, JSON.stringify(accountJson, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(accountPath, 0o600);
  } catch {
    // ignore
  }
}
