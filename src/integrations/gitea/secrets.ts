import fs from 'node:fs';
import path from 'node:path';

export function getGiteaTokenPath(hubHome: string, projectId: string): string {
  return path.join(hubHome, 'secrets', `gitea-${projectId}.token`);
}

export function saveGiteaToken(hubHome: string, projectId: string, token: string): void {
  const dir = path.join(hubHome, 'secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best-effort chmod on directory
  }
  const file = getGiteaTokenPath(hubHome, projectId);
  fs.writeFileSync(file, `${token.trim()}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort chmod on file
  }
}

export function readGiteaToken(hubHome: string, projectId: string): string | null {
  try {
    const file = getGiteaTokenPath(hubHome, projectId);
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if ((stat.mode & 0o777) !== 0o600) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // best-effort
      }
    }
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

export function isGiteaTokenConfigured(hubHome: string, projectId: string): boolean {
  return readGiteaToken(hubHome, projectId) !== null;
}

export function removeGiteaToken(hubHome: string, projectId: string): void {
  try {
    const file = getGiteaTokenPath(hubHome, projectId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // ignore
  }
}
