import { ProfileAuthState, ProfileRepo } from '../db/index.js';
import { sameAccount } from './account.js';

export function claudeLoginCommand(profile: { kind?: string | null; home?: string | null }): string {
  return profile.kind === 'isolated' && profile.home
    ? `CLAUDE_CONFIG_DIR=${profile.home} claude /login`
    : 'claude /login';
}

/** Match authentication failures only when called with failed-result/error output. */
export function isClaudeAuthError(text: string): boolean {
  return /failed to authenticate|oauth session expired|could not be refreshed|invalid api key|please run\s+\/?login|not logged in|http\s*401\b|authentication_error/i.test(text);
}

export function markClaudeProfileAuthExpired(
  profileRepo: ProfileRepo | undefined,
  emit: (type: string, taskId: string | undefined, payload: unknown) => void,
  profileName: string | null | undefined,
): void {
  const profile = profileRepo && profileName ? profileRepo.get(profileName) : undefined;
  const related = profile?.email && profileRepo
    ? profileRepo.getAll().filter((candidate) => sameAccount(candidate, profile))
    : profile ? [profile] : [];
  const candidates = related.length ? related : [{ name: 'system', email: null, home: null, authState: null } as const];
  for (const candidate of candidates) {
    if (candidate.authState === 'not_logged_in') continue;
    const message = 'Phiên đăng nhập Claude hết hạn – cần đăng nhập lại';
    if (candidate.name !== 'system' && profileRepo) profileRepo.updateAuthState(candidate.name, 'not_logged_in', message, null);
    const home = candidate.home || undefined;
    emit('profile.auth_expired', undefined, {
      name: candidate.name,
      email: candidate.email,
      engine: 'claude',
      home,
      loginCommand: claudeLoginCommand(candidate),
    });
  }
}

export interface AuthStateResult {
  authState: ProfileAuthState;
  authMessage: string | null;
  verifyUrl: string | null;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

/**
 * Extract Google accounts verification URL from CLI output.
 * If the URL is broken across multiple lines (e.g. terminal wrapping), stitches it together.
 */
export function extractVerifyUrl(raw: string): string | null {
  const text = raw.replace(ANSI_RE, '').replace(/\r/g, '');

  const startIdx = text.indexOf('https://accounts.google.com/');
  if (startIdx === -1) return null;

  const after = text.slice(startIdx);
  const lines = after.split('\n');

  let url = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      const token = line.trim().split(/\s+/)[0];
      url = token;
    } else {
      const trimmed = line.trim();
      if (!trimmed) break;
      // If line contains spaces, only accept if the previous URL part was abruptly broken
      if (
        trimmed.includes(' ') &&
        !url.endsWith('&') &&
        !url.endsWith('=') &&
        !url.endsWith('?') &&
        !url.endsWith('%')
      ) {
        break;
      }
      const token = trimmed.split(/\s+/)[0];
      // Valid URL characters in query strings
      if (/^[a-zA-Z0-9_.~:/?#[\]@!$&'()*+,;=%-]+$/.test(token)) {
        url += token;
        if (trimmed.includes(' ')) {
          break;
        }
      } else {
        break;
      }
    }
  }

  // Strip trailing punctuation often left from sentences or quotes
  url = url.replace(/["'>)]+$/, '');
  return url || null;
}

/**
 * Parse output from agy usage or check command to determine authState.
 */
export function parseAuthState(output: string, hasUsage = false): AuthStateResult {
  if (/not eligible|Verify your account|Eligibility check failed/i.test(output)) {
    return {
      authState: 'needs_verification',
      authMessage: 'Cần xác minh tài khoản',
      verifyUrl: extractVerifyUrl(output),
    };
  }

  if (/not logged in|authentication/i.test(output)) {
    return {
      authState: 'not_logged_in',
      authMessage: 'Chưa đăng nhập hoặc xác thực thất bại',
      verifyUrl: null,
    };
  }

  if (hasUsage) {
    return {
      authState: 'ok',
      authMessage: null,
      verifyUrl: null,
    };
  }

  return {
    authState: 'error',
    authMessage: null,
    verifyUrl: null,
  };
}

export interface CodexLoginStatus {
  loggedIn: boolean;
  notLoggedIn: boolean;
  email: string | null;
  plan: string | null;
}

export function parseCodexLoginStatus(output: string): CodexLoginStatus {
  const clean = output.replace(ANSI_RE, '').replace(/\r/g, '');
  if (/not logged in/i.test(clean)) {
    return { loggedIn: false, notLoggedIn: true, email: null, plan: null };
  }

  // Find email: e.g. "Logged in as user@example.com" or "user@example.com"
  const emailMatch = clean.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  const email = emailMatch ? emailMatch[1] : null;

  // Find plan / subscription: e.g. "ChatGPT Plus", "Team", "Plus", "Pro", etc.
  let plan: string | null = null;
  const planMatch =
    clean.match(/(?:subscription|plan)[:\s]+([^\n,]+)/i) ||
    clean.match(/\((ChatGPT [^)]+|Plus|Pro|Team|Enterprise|Free)\)/i) ||
    clean.match(/using (ChatGPT[a-zA-Z0-9 ]*|API key|workload identity|access token)/i);
  if (planMatch) {
    plan = planMatch[1].trim();
  }

  const loggedIn = /logged in/i.test(clean);
  return {
    loggedIn,
    notLoggedIn: !loggedIn,
    email,
    plan,
  };
}
