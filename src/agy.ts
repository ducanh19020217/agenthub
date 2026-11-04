import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve agy in the same order for the daemon, setup wizard and workers.
 * Service managers often provide a smaller PATH than an interactive shell,
 * so also check the locations used by the official installer and legacy agy.
 */
export function findAgyBin(
  customHome?: string,
  existsFn: (filePath: string) => boolean = (filePath) => fs.existsSync(filePath),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: string[] = [];
  const configured = env.AGENTHUB_AGY_BIN?.trim();
  if (configured) return existsFn(configured) ? configured : null;

  const pathValue = env.PATH || '';
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, 'agy'));
  }

  const homes = [customHome, os.homedir()].filter(Boolean) as string[];
  for (const home of homes) {
    candidates.push(
      path.join(home, '.local', 'bin', 'agy'),
      path.join(home, '.gemini', 'bin', 'agy'),
      path.join(home, '.antigravity', 'bin', 'agy'),
      path.join(home, '.local', 'share', 'antigravity', 'bin', 'agy'),
    );
  }
  if (env.AGENTHUB_TOOLS_DIR) {
    candidates.push(path.join(env.AGENTHUB_TOOLS_DIR, 'node_modules', '.bin', 'agy'));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!seen.has(candidate) && existsFn(candidate)) {
      seen.add(candidate);
      return candidate;
    }
    seen.add(candidate);
  }
  return null;
}

export function agyInstallHint(): string {
  return 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
}

/**
 * Environment for an isolated agy profile: its own HOME and no OS keyring, so the
 * session is saved to `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token`.
 * Linux: a dead DBus address hides the Secret Service. macOS: the fake HOME has no
 * login keychain, so saving pops "A keychain cannot be found"; agy skips the
 * keychain when it detects an SSH session (DEC-013).
 */
export function applyIsolatedAgyEnv(env: Record<string, string>, home: string, platform: NodeJS.Platform = process.platform): void {
  env.HOME = home;
  env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/agy-no-keyring';
  if (platform === 'darwin' && !env.SSH_CONNECTION) env.SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0';
}
