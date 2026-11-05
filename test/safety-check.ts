import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export interface AgyHomesSnapshot {
  dir: string;
  subdirs: string[];
  profiles: Map<string, Map<string, string>>;
}

export interface HubHomeSnapshot {
  dir: string;
  exists: boolean;
  entries: string[];
  /** Checksums of sensitive files that must not be created or modified by tests. */
  sensitiveChecksums: Map<string, string | null>;
  hubDbExists: boolean;
  hubDbWalExists: boolean;
  hubDbShmExists: boolean;
  hubDbSensitiveHash: string | null;
}

// Sensitive entries: tests must never create or modify these.
const SENSITIVE_FILES = ['config.json', 'token'];
const SENSITIVE_DIRS = ['secrets', 'profiles'];
const SENSITIVE_TABLES = ['projects', 'profiles', 'departments', 'permission_rules', 'chat_permissions'];

// Runtime entries (directories and files) that the daemon or deploy process may
// create in the real hub home while tests are running. These include daemon
// runtime directories (reports, tracker, logs) and deploy/web runtime entries.
const ALLOWED_HUB_RUNTIME_ENTRIES = new Set([
  'deploy-push-state.json',
  'deploy-restart.json',
  'logs',
  'reports',
  'tracker',
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

export function findHubEntryChanges(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((name) => !beforeSet.has(name)),
    removed: before.filter((name) => !afterSet.has(name)),
  };
}

export function getHubEntries(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function getHubDbSensitiveHash(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let schemaVersion = '';
    try {
      const row = db.prepare('SELECT user_version FROM pragma_user_version').get() as { user_version: number } | undefined;
      schemaVersion = String(row?.user_version ?? '');
    } catch { /* ignore */ }

    let tables: string[] = [];
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      tables = rows.map((r) => r.name);
    } catch { /* ignore */ }

    const hash = crypto.createHash('sha256');
    hash.update(schemaVersion);
    hash.update(tables.join(','));

    for (const tableName of SENSITIVE_TABLES) {
      if (tables.includes(tableName)) {
        try {
          const rows = db.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid`).all();
          hash.update(JSON.stringify(rows));
        } catch {
          try {
            const rows = db.prepare(`SELECT * FROM "${tableName}"`).all();
            hash.update(JSON.stringify(rows));
          } catch { /* ignore */ }
        }
      }
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

function getSensitiveChecksums(dir: string): Map<string, string | null> {
  const checksums = new Map<string, string | null>();
  for (const name of SENSITIVE_FILES) {
    checksums.set(name, getChecksum(path.join(dir, name)));
  }
  for (const name of SENSITIVE_DIRS) {
    const dirPath = path.join(dir, name);
    if (fs.existsSync(dirPath)) {
      try {
        const hash = crypto.createHash('sha256');
        const entries = fs.readdirSync(dirPath, { recursive: true }).map(String).sort();
        hash.update(entries.join('\n'));
        for (const entry of entries) {
          const entryPath = path.join(dirPath, entry);
          try {
            const stat = fs.statSync(entryPath);
            if (stat.isFile()) hash.update(fs.readFileSync(entryPath));
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
  const dbPath = path.join(dir, 'hub.db');
  const hubDbExists = exists && fs.existsSync(dbPath);
  return {
    dir,
    exists,
    entries: exists ? getHubEntries(dir) : [],
    sensitiveChecksums: exists ? getSensitiveChecksums(dir) : new Map(),
    hubDbExists,
    hubDbWalExists: exists && fs.existsSync(path.join(dir, 'hub.db-wal')),
    hubDbShmExists: exists && fs.existsSync(path.join(dir, 'hub.db-shm')),
    hubDbSensitiveHash: hubDbExists ? getHubDbSensitiveHash(dbPath) : null,
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
    const changes = findHubEntryChanges(snap.entries, currentEntries);
    const sensitiveCreated = changes.added.filter((name) => SENSITIVE_FILES.includes(name) || SENSITIVE_DIRS.includes(name) || ['hub.db', 'hub.db-wal', 'hub.db-shm'].includes(name));
    if (sensitiveCreated.length) {
      throw new Error(`SAFETY NET VIOLATION: ${currentDir} was modified during test execution! Sensitive entry changed: ${sensitiveCreated[0]}`);
    }
    const unexpected = [...changes.added, ...changes.removed].filter((name) => !isIgnoredHubEntry(name));
    if (unexpected.length > 0) {
      console.warn(`SAFETY NET WARNING: ${currentDir} high-level entries changed: [${unexpected.join(', ')}]`);
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

    if (snap.hubDbExists) {
      const dbPath = path.join(currentDir, 'hub.db');
      if (!fs.existsSync(dbPath) || snap.hubDbSensitiveHash !== getHubDbSensitiveHash(dbPath)) {
        throw new Error(
          `SAFETY NET VIOLATION: ${currentDir} was modified during test execution! Sensitive entry changed: hub.db`,
        );
      }
    }

    for (const [sidecar, exists] of [
      ['hub.db-wal', snap.hubDbWalExists],
      ['hub.db-shm', snap.hubDbShmExists],
    ] as const) {
      if (exists && !fs.existsSync(path.join(currentDir, sidecar))) {
        throw new Error(
          `SAFETY NET VIOLATION: ${currentDir} was modified during test execution! Sensitive entry changed: ${sidecar}`,
        );
      }
    }
  }
}

interface WebSnapshot { path: string; checksum: string | null; }
interface ServiceSnapshot { path: string; exists: boolean; mtime: number | null; checksum: string | null; }

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

function getProfileMetadata(dir: string): Map<string, string> {
  const metadata = new Map<string, string>();
  const walk = (current: string, relative: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      const full = path.join(current, entry.name);
      try {
        const stat = fs.lstatSync(full);
        // Metadata only: never read token/keyring contents.
        metadata.set(rel, `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}:${stat.size}:${stat.mode}:${stat.mtimeMs}`);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, rel);
      } catch { /* entry may disappear while the daemon is running */ }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return metadata;
}

function getAgyProfiles(dir: string): Map<string, Map<string, string>> {
  const profiles = new Map<string, Map<string, string>>();
  for (const name of getSubdirectories(dir)) profiles.set(name, getProfileMetadata(path.join(dir, name)));
  return profiles;
}

export function getAgyHomesSnapshot(dir: string): AgyHomesSnapshot {
  return { dir, subdirs: getSubdirectories(dir), profiles: getAgyProfiles(dir) };
}

export function verifyAgyHomesSafety(snap: AgyHomesSnapshot): void {
  const currentProfiles = getAgyProfiles(snap.dir);
  const removed = snap.subdirs.filter((name) => !currentProfiles.has(name));
  const added = [...currentProfiles.keys()].filter((name) => !snap.profiles.has(name));
  if (added.length || removed.length) console.warn(`SAFETY NET WARNING: profiles changed in ${snap.dir}: added [${added.join(', ')}], removed [${removed.join(', ')}]`);
  for (const [name, original] of snap.profiles) {
    const current = currentProfiles.get(name);
    if (!current) continue;
    const changed = [...new Set([...original.keys(), ...current.keys()])].filter((file) => original.get(file) !== current.get(file));
    if (changed.length) throw new Error(`SAFETY NET VIOLATION: profile ${path.join(snap.dir, name)} changed inside: [${changed.join(', ')}]`);
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
let originalTestEnv: Record<string, string | undefined> = {};

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
  const realHome = os.userInfo().homedir;
  const targetHomes = [realHome];
  testTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-run-'));
  const safeHome = path.join(testTempRoot, 'home');
  fs.mkdirSync(safeHome, { recursive: true });
  originalTestEnv = Object.fromEntries(['HOME', 'AGENTHUB_HOME', 'AGENTHUB_AGY_HOMES', 'XDG_CONFIG_HOME', 'TMPDIR'].map((key) => [key, process.env[key]]));
  process.env.HOME = safeHome;
  process.env.AGENTHUB_HOME = path.join(safeHome, '.agenthub');
  process.env.AGENTHUB_AGY_HOMES = path.join(safeHome, '.agy-homes');
  process.env.XDG_CONFIG_HOME = path.join(safeHome, 'config');
  process.env.AGENTHUB_TEST_TMP_ROOT = testTempRoot;
  process.env.TMPDIR = testTempRoot;
  provide('agenthubTestTmpRoot', testTempRoot);
  initialServices = [
    path.join(realHome, '.config', 'systemd', 'user', 'agenthub.service'),
    path.join(realHome, 'Library', 'LaunchAgents', 'dev.agenthub.plist'),
  ].map(getServiceSnapshot);

  initialAgyHomes = targetHomes.map((home) => {
    const dir = path.join(home, '.agy-homes');
    return {
      dir,
      subdirs: getSubdirectories(dir),
      profiles: getAgyProfiles(dir),
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
    for (const [key, value] of Object.entries(originalTestEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
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
      verifyAgyHomesSafety(snap);
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
