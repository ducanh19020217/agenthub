import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AgyHomesSnapshot { dir: string; subdirs: string[]; }
export interface HubHomeSnapshot { dir: string; exists: boolean; entries: string[]; metadata: Map<string, string>; }

function getSubdirectories(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { return []; }
}

export function getHubEntries(dir: string): string[] {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

export function findHubEntryChanges(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return { added: after.filter((name) => !beforeSet.has(name)), removed: before.filter((name) => !afterSet.has(name)) };
}

function recordMetadata(root: string, relative: string, metadata: Map<string, string>): void {
  const fullPath = path.join(root, relative);
  let stat: fs.Stats;
  try { stat = fs.statSync(fullPath); } catch { return; }
  metadata.set(relative, `${stat.size}:${stat.mtimeMs}`);
  if (!stat.isDirectory()) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(fullPath, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) recordMetadata(root, path.join(relative, entry.name), metadata);
}

function getHubMetadata(dir: string): Map<string, string> {
  const metadata = new Map<string, string>();
  for (const name of getHubEntries(dir)) {
    if (name === 'config.json' || name === 'token' || name === 'secrets' || name === 'profiles' || name === 'hub.db' || name.startsWith('hub.db-')) {
      recordMetadata(dir, name, metadata);
    }
  }
  return metadata;
}

export function getHubSnapshot(dir: string): HubHomeSnapshot {
  const exists = fs.existsSync(dir);
  return { dir, exists, entries: exists ? getHubEntries(dir) : [], metadata: exists ? getHubMetadata(dir) : new Map() };
}

export function verifyHubHomeSafety(snap: HubHomeSnapshot, currentDir: string = snap.dir): void {
  const currentExists = fs.existsSync(currentDir);
  const currentEntries = currentExists ? getHubEntries(currentDir) : [];
  const changes = findHubEntryChanges(snap.entries, currentEntries);
  const metadata = currentExists ? getHubMetadata(currentDir) : new Map<string, string>();
  const metadataChanges = [...new Set([...snap.metadata.keys(), ...metadata.keys()])].filter((name) => snap.metadata.get(name) !== metadata.get(name));
  if (changes.added.length || changes.removed.length || metadataChanges.length) {
    const names = [...changes.added, ...changes.removed, ...metadataChanges];
    console.warn(`SAFETY NET WARNING: .agenthub changed: ${[...new Set(names)].join(', ')}`);
  }
}

export function getAgyHomesSnapshot(dir: string): AgyHomesSnapshot { return { dir, subdirs: getSubdirectories(dir) }; }

export function verifyAgyHomesSafety(snap: AgyHomesSnapshot): void {
  const { added, removed } = findHubEntryChanges(snap.subdirs, getSubdirectories(snap.dir));
  if (added.length || removed.length) console.warn(`SAFETY NET WARNING: .agy-homes changed: ${[...added, ...removed].join(', ')}`);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export interface IsolationPaths { home?: string; hubHome?: string; agyHomesDir?: string; }

export function assertTestIsolation(paths: IsolationPaths = {}): void {
  const realHome = os.userInfo().homedir;
  const home = paths.home ?? process.env.HOME ?? os.homedir();
  const hubHome = paths.hubHome ?? process.env.AGENTHUB_HOME ?? path.join(home, '.agenthub');
  const agyHomesDir = paths.agyHomesDir ?? process.env.AGENTHUB_AGY_HOMES ?? path.join(home, '.agy-homes');
  const unsafe = [['os.homedir()', os.homedir()], ['HOME', home], ['AGENTHUB_HOME', hubHome], ['AGENTHUB_AGY_HOMES', agyHomesDir]].find(([, value]) => isInside(realHome, value));
  if (unsafe) throw new Error(`SAFETY NET VIOLATION: test isolation is broken: ${unsafe[0]} points into the real HOME`);
}

let initialAgyHomes: AgyHomesSnapshot;
let initialHubHome: HubHomeSnapshot;
let testTempRoot: string | undefined;
let originalTestEnv: Record<string, string | undefined> = {};

export function setup({ provide }: { provide: (key: string, value: string) => void }) {
  const realHome = os.userInfo().homedir;
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
  assertTestIsolation();
  provide('agenthubTestTmpRoot', testTempRoot);
  initialHubHome = getHubSnapshot(path.join(realHome, '.agenthub'));
  initialAgyHomes = getAgyHomesSnapshot(path.join(realHome, '.agy-homes'));
  return () => {
    verifyHubHomeSafety(initialHubHome);
    verifyAgyHomesSafety(initialAgyHomes);
    if (testTempRoot) try { fs.rmSync(testTempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    delete process.env.AGENTHUB_TEST_TMP_ROOT;
    for (const [key, value] of Object.entries(originalTestEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
}
