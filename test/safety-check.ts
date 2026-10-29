import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

interface AgyHomesSnapshot {
  dir: string;
  subdirs: string[];
}

export interface HubHomeSnapshot {
  dir: string;
  exists: boolean;
  entries: string[];
  /** Checksums of sensitive files that must not be created or modified by tests. */
  sensitiveChecksums: Map<string, string | null>;
}

// Sensitive entries: tests must never create or modify these.
const SENSITIVE_FILES = ['config.json', 'token', 'hub.db', 'hub.db-wal', 'hub.db-shm'];
const SENSITIVE_DIRS = ['secrets', 'profiles'];

// Runtime entries that the daemon or worker setup may create in the real hub
// home while tests are running. User/configuration data must not be added here.
const ALLOWED_HUB_RUNTIME_ENTRIES = new Set([
  'deploy-pending-state.json',
  'deploy-push-state.json',
  'deploy-restart.json',
  'web',
]);

export function isIgnoredHubEntry(name: string): boolean {
  if (name.startsWith('web-staging-')) return true;
  if (name.startsWith('web-previous-')) return true;
  if (ALLOWED_HUB_RUNTIME_ENTRIES.has(name)) return true;
  return false;
}

export function findUnexpectedHubEntries(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const newEntries = after.filter((name) => !beforeSet.has(name));
  return newEntries.filter((name) => !isIgnoredHubEntry(name));
}

export function getHubEntries(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function getSensitiveChecksums(dir: string): Map<string, string | null> {
  const checksums = new Map<string, string | null>();
  for (const name of SENSITIVE_FILES) {
    checksums.set(name, getChecksum(path.join(dir, name)));
  }
  for (const name of SENSITIVE_DIRS) {
    // For directories, record whether they exist (null = absent, hash of listing = present)
    const dirPath = path.join(dir, name);
    if (fs.existsSync(dirPath)) {
      try {
        // Hash the recursive listing + file contents for full integrity
        const hash = crypto.createHash('sha256');
        const entries = fs.readdirSync(dirPath, { recursive: true })
          .map(String).sort();
        hash.update(entries.join('\n'));
        for (const entry of entries) {
          const entryPath = path.join(dirPath, entry);
          try {
            const stat = fs.statSync(entryPath);
            if (stat.isFile()) {
              hash.update(fs.readFileSync(entryPath));
            }
          } catch { /* skip unreadable */ }
        }
        checksums.set(name, hash.digest('hex'));
      } catch {
        checksums.set(name, null);
      }
    } else {
      checksums.set(name, null);
    }
  }
  return checksums;
}

export function getHubSnapshot(dir: string): HubHomeSnapshot {
  const exists = fs.existsSync(dir);
  return {
    dir,
    exists,
    entries: exists ? getHubEntries(dir) : [],
    sensitiveChecksums: exists ? getSensitiveChecksums(dir) : new Map(),
  };
}

export function verifyHubHomeSafety(snap: HubHomeSnapshot, currentDir: string = snap.dir): void {
  const currentExists = fs.existsSync(currentDir);

  if (!snap.exists && currentExists) {
    throw new Error(
      `SAFETY NET VIOLATION: ${currentDir} was created during test execution! Tests must use temporary directory.`,
    );
  }

  if (snap.exists && currentExists) {
    const currentEntries = getHubEntries(currentDir);
    const unexpected = findUnexpectedHubEntries(snap.entries, currentEntries);
    if (unexpected.length > 0) {
      throw new Error(
        `SAFETY NET VIOLATION: ${currentDir} was modified during test execution! Unexpected new entries: [${unexpected.join(', ')}]`,
      );
    }

    // Check sensitive files and dirs for content modification
    const currentChecksums = getSensitiveChecksums(currentDir);
    for (const [name, originalChecksum] of snap.sensitiveChecksums) {
      const currentChecksum = currentChecksums.get(name) ?? null;
      if (originalChecksum !== currentChecksum) {
        throw new Error(
          `SAFETY NET VIOLATION: ${currentDir} was modified during test execution! ` +
          `Sensitive entry changed: ${name}`,
        );
      }
    }
  }
}

interface WebSnapshot { path: string; checksum: string | null; }
interface ServiceSnapshot { path: string; exists: boolean; mtime: number | null; checksum: string | null; }

function resolveTargetHomes(): string[] {
  const homes = new Set<string>();
  const curr = os.homedir();
  homes.add(curr);

  // If running inside isolated worker HOME e.g. /home/user/.agy-homes/g2
  const match = curr.match(/(.*?)\/\.agy-homes\/[^/]+$/);
  if (match) {
    homes.add(match[1]);
  }

  return Array.from(homes);
}

function getSubdirectories(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}


function getChecksum(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch { return null; }
}

function getServiceSnapshot(filePath: string): ServiceSnapshot {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, mtime: null, checksum: null };
  try {
    return { path: filePath, exists: true, mtime: fs.statSync(filePath).mtimeMs, checksum: getChecksum(filePath) };
  } catch {
    return { path: filePath, exists: false, mtime: null, checksum: null };
  }
}

let initialAgyHomes: AgyHomesSnapshot[] = [];
let initialHubHomes: HubHomeSnapshot[] = [];
let initialWeb: WebSnapshot;
let initialServices: ServiceSnapshot[] = [];
let initialTempDirNames = new Set<string>();
let testTempRoot: string | undefined;

function getAgentHubTempDirNames(): Set<string> {
  try {
    return new Set(fs.readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('agenthub-'))
      .map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

export function setup({ provide }: { provide: (key: string, value: string) => void }) {
  initialTempDirNames = getAgentHubTempDirNames();
  testTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-run-'));
  process.env.AGENTHUB_TEST_TMP_ROOT = testTempRoot;
  process.env.TMPDIR = testTempRoot;
  provide('agenthubTestTmpRoot', testTempRoot);
  const targetHomes = resolveTargetHomes();
  const realHome = os.userInfo().homedir;
  initialServices = [
    path.join(realHome, '.config', 'systemd', 'user', 'agenthub.service'),
    path.join(realHome, 'Library', 'LaunchAgents', 'dev.agenthub.plist'),
  ].map(getServiceSnapshot);

  initialAgyHomes = targetHomes.map((home) => {
    const dir = path.join(home, '.agy-homes');
    return {
      dir,
      subdirs: getSubdirectories(dir),
    };
  });

  initialHubHomes = targetHomes.map((home) => {
    const dir = path.join(home, '.agenthub');
    return getHubSnapshot(dir);
  });
  const webPath = path.resolve(__dirname, '..', 'dist', 'web', 'index.html');
  initialWeb = { path: webPath, checksum: getChecksum(webPath) };

  return () => {
    if (testTempRoot) {
      try { fs.rmSync(testTempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    delete process.env.AGENTHUB_TEST_TMP_ROOT;
    const remainingNewTempDirs = [...getAgentHubTempDirNames()]
      .filter((name) => !initialTempDirNames.has(name));
    const leakedTempDirs = remainingNewTempDirs.length;
    if (leakedTempDirs > 5) {
      const prefixes = new Set(remainingNewTempDirs.map((name) => name.replace(/[^-]+$/, '')));
      const message = `TEMP LEAK WARNING: ${leakedTempDirs} agenthub-* directories remain after tests; prefixes: ${[...prefixes].join(', ')}`;
      console.warn(message);
      if (process.env.AGENTHUB_TEST_TMP_FAIL === '1') throw new Error(message);
    }
    // Teardown safety checks
    for (const snap of initialAgyHomes) {
      const currentSubdirs = getSubdirectories(snap.dir);
      const isMatch =
        snap.subdirs.length === currentSubdirs.length &&
        snap.subdirs.every((name, idx) => name === currentSubdirs[idx]);

      if (!isMatch) {
        throw new Error(
          `SAFETY NET VIOLATION: Subdirectories of ${snap.dir} changed during test execution!\n` +
          `Before: [${snap.subdirs.join(', ')}]\n` +
          `After:  [${currentSubdirs.join(', ')}]`,
        );
      }
    }

    for (const snap of initialHubHomes) {
      verifyHubHomeSafety(snap);
    }

    const currentChecksum = getChecksum(initialWeb.path);
    if (currentChecksum !== initialWeb.checksum) {
      throw new Error(`SAFETY NET VIOLATION: ${initialWeb.path} checksum changed during test execution!`);
    }

    for (const snap of initialServices) {
      const current = getServiceSnapshot(snap.path);
      if (snap.exists !== current.exists || snap.mtime !== current.mtime || snap.checksum !== current.checksum) {
        throw new Error(
          `SAFETY NET VIOLATION: service file changed during test execution: ${snap.path}\n` +
          `Before: exists=${snap.exists}, mtime=${snap.mtime}, sha256=${snap.checksum}\n` +
          `After:  exists=${current.exists}, mtime=${current.mtime}, sha256=${current.checksum}`,
        );
      }
    }
  };
}
