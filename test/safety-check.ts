import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

interface AgyHomesSnapshot {
  dir: string;
  subdirs: string[];
}

export interface HubDbEventsInfo {
  maxId: number;
  count: number;
  checksum: string;
}

export interface ClaudeQuotaRow {
  id: number;
  status: string | null;
  resetsAt: number | null;
  rateLimitType: string | null;
  isUsingOverage: number;
  observedAt: string;
}

export interface ClaudeQuotaProfileRow {
  profileName: string;
  status: string | null;
  resetsAt: number | null;
  rateLimitType: string | null;
  isUsingOverage: number;
  observedAt: string;
}

export interface QuotaUsageInfo {
  profileName: string;
  grp: string;
  window: string;
  remainingPct: number;
  resetAt: number;
  fetchedAt: number;
}

export interface QuotaMarkInfo {
  profileName: string;
  family: string;
  until: number;
  reason: string | null;
}

export interface ClaudeScanStateInfo {
  inode: number;
  size: number;
  offset: number;
  mtime: number;
}

export interface ClaudeSessionInfo {
  cwd: string;
}

export interface HubDbTableUsageDelta {
  maxRowid: number;
  count: number;
  checksum: string;
}

export interface HubDbInfo {
  isValid: boolean;
  schemaVersion?: string;
  sensitiveHash?: string;
  tables?: string[];
  tableChecksums?: Record<string, string>;
  eventsInfo?: HubDbEventsInfo | null;
  claudeQuotaInfo?: ClaudeQuotaRow | null;
  claudeQuotaProfilesMap?: Record<string, ClaudeQuotaProfileRow>;
  quotaUsageMap?: Record<string, QuotaUsageInfo>;
  quotaMarksMap?: Record<string, QuotaMarkInfo>;
  claudeScanStateMap?: Record<string, ClaudeScanStateInfo>;
  claudeSessionsMap?: Record<string, ClaudeSessionInfo>;
  claudeUsageInfo?: HubDbTableUsageDelta | null;
  claudeTaskUsageInfo?: HubDbTableUsageDelta | null;
  taskIds?: string[];
  profileNames?: string[];
  projectIds?: string[];
}

export interface HubHomeSnapshot {
  dir: string;
  exists: boolean;
  entries: string[];
  sensitiveFingerprints?: Record<string, string | null>;
  dbInfo?: HubDbInfo | null;
}

export const SENSITIVE_HUB_ENTRIES = [
  'config.json',
  'token',
  'hub.db',
  'secrets',
  'profiles',
] as const;

export const ALLOWED_DAEMON_BACKGROUND_TABLES = new Set([
  'events',
  'claude_quota',
  'claude_quota_profiles',
  'quota_usage',
  'quota_marks',
  'claude_scan_state',
  'claude_sessions',
  'claude_usage',
  'claude_task_usage',
]);

export const ALLOWED_DAEMON_EVENT_TYPES = new Set([
  'brain.updated',
  'brain.status',
  'brain.notify',
  'claude.quota_available',
  'claude.quota_depleted',
  'heartbeat',
  'daemon.heartbeat',
]);

export const ALLOWED_CLAUDE_QUOTA_STATUSES = new Set([
  'allowed',
  'rejected',
  'limit_reached',
  'exhausted',
]);

export const ALLOWED_RATE_LIMIT_TYPES = new Set([
  'five_hour',
  'weekly',
  'seven_day',
]);

function computeTableChecksum(db: Database.Database, tableName: string): string {
  try {
    const rows = db.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid`).all();
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } catch {
    const rows = db.prepare(`SELECT * FROM "${tableName}"`).all();
    return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
}

export function getSensitiveFingerprint(targetPath: string): string | null {
  if (!fs.existsSync(targetPath)) return null;
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      const items: string[] = [];
      const walk = (current: string) => {
        const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          const rel = path.relative(targetPath, full);
          if (entry.isDirectory()) {
            items.push(`dir:${rel}`);
            walk(full);
          } else if (entry.isFile()) {
            const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
            items.push(`file:${rel}:${hash}`);
          }
        }
      };
      walk(targetPath);
      return crypto.createHash('sha256').update(items.join('\n')).digest('hex');
    }
    return crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
  } catch {
    return null;
  }
}

export function getHubDbInfo(dbPath: string): HubDbInfo {
  if (!fs.existsSync(dbPath)) return { isValid: false };
  try {
    if (!fs.statSync(dbPath).isFile()) return { isValid: false };
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') return { isValid: false };

      let schemaVersion = '';
      try {
        const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
          | { value: string }
          | undefined;
        schemaVersion = metaRow?.value || '';
      } catch { /* table might not exist */ }

      let projects: unknown[] = [];
      try {
        projects = db.prepare('SELECT * FROM projects ORDER BY rowid').all();
      } catch {
        try {
          projects = db.prepare('SELECT * FROM projects').all();
        } catch { /* ignore */ }
      }

      let profiles: unknown[] = [];
      try {
        profiles = db.prepare('SELECT * FROM profiles ORDER BY rowid').all();
      } catch {
        try {
          profiles = db.prepare('SELECT * FROM profiles').all();
        } catch { /* ignore */ }
      }

      let departments: unknown[] = [];
      try {
        departments = db.prepare('SELECT * FROM departments ORDER BY rowid').all();
      } catch {
        try {
          departments = db.prepare('SELECT * FROM departments').all();
        } catch { /* ignore */ }
      }

      let permissionRules: unknown[] = [];
      try {
        permissionRules = db.prepare('SELECT * FROM permission_rules ORDER BY rowid').all();
      } catch {
        try {
          permissionRules = db.prepare('SELECT * FROM permission_rules').all();
        } catch { /* ignore */ }
      }

      let tables: string[] = [];
      try {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
        tables = rows.map((r) => r.name);
      } catch { /* ignore */ }

      const sensitiveHash = crypto.createHash('sha256')
        .update(schemaVersion)
        .update(tables.join(','))
        .update(JSON.stringify(projects))
        .update(JSON.stringify(profiles))
        .update(JSON.stringify(departments))
        .update(JSON.stringify(permissionRules))
        .digest('hex');

      const projectIds = (projects as Record<string, unknown>[])
        .map((p) => (typeof p.id === 'string' ? p.id : ''))
        .filter((id): id is string => Boolean(id));

      const taskIds: string[] = [];
      try {
        const rows = db.prepare('SELECT id FROM tasks').all() as { id: string }[];
        for (const r of rows) {
          taskIds.push(r.id);
        }
      } catch { /* table might not exist */ }

      const tableChecksums: Record<string, string> = {};
      for (const t of tables) {
        if (!ALLOWED_DAEMON_BACKGROUND_TABLES.has(t)) {
          tableChecksums[t] = computeTableChecksum(db, t);
        }
      }

      let eventsInfo: HubDbEventsInfo | null = null;
      if (tables.includes('events')) {
        try {
          const maxRow = db.prepare('SELECT MAX(id) as maxId, COUNT(*) as count FROM events').get() as {
            maxId: number | null;
            count: number;
          };
          const maxId = maxRow.maxId ?? 0;
          const count = maxRow.count;
          const existingRows = db
            .prepare('SELECT * FROM events WHERE id <= ? ORDER BY id')
            .all(maxId);
          const checksum = crypto.createHash('sha256').update(JSON.stringify(existingRows)).digest('hex');
          eventsInfo = { maxId, count, checksum };
        } catch { /* ignore */ }
      }

      const profileNamesSet = new Set<string>();
      for (const p of profiles as Record<string, unknown>[]) {
        if (typeof p.name === 'string') profileNamesSet.add(p.name);
        else if (typeof p.id === 'string') profileNamesSet.add(p.id);
      }

      let claudeQuotaInfo: ClaudeQuotaRow | null = null;
      if (tables.includes('claude_quota')) {
        try {
          const row = db.prepare('SELECT id, status, resetsAt, rateLimitType, isUsingOverage, observedAt FROM claude_quota WHERE id = 1').get() as ClaudeQuotaRow | undefined;
          claudeQuotaInfo = row || null;
        } catch { /* ignore */ }
      }

      const claudeQuotaProfilesMap: Record<string, ClaudeQuotaProfileRow> = {};
      if (tables.includes('claude_quota_profiles')) {
        try {
          const rows = db.prepare('SELECT profileName, status, resetsAt, rateLimitType, isUsingOverage, observedAt FROM claude_quota_profiles').all() as ClaudeQuotaProfileRow[];
          for (const r of rows) {
            claudeQuotaProfilesMap[r.profileName] = r;
            if (r.profileName) profileNamesSet.add(r.profileName);
          }
        } catch { /* ignore */ }
      }

      const quotaUsageMap: Record<string, QuotaUsageInfo> = {};
      if (tables.includes('quota_usage')) {
        try {
          const rows = db.prepare('SELECT profileName, grp, window, remainingPct, resetAt, fetchedAt FROM quota_usage').all() as QuotaUsageInfo[];
          for (const r of rows) {
            quotaUsageMap[`${r.profileName}::${r.grp}::${r.window}`] = r;
            if (r.profileName) profileNamesSet.add(r.profileName);
          }
        } catch { /* ignore */ }
      }

      const quotaMarksMap: Record<string, QuotaMarkInfo> = {};
      if (tables.includes('quota_marks')) {
        try {
          const rows = db.prepare('SELECT profileName, family, until, reason FROM quota_marks').all() as QuotaMarkInfo[];
          for (const r of rows) {
            quotaMarksMap[`${r.profileName}::${r.family}`] = r;
            if (r.profileName) profileNamesSet.add(r.profileName);
          }
        } catch { /* ignore */ }
      }

      const profileNames = Array.from(profileNamesSet);

      const claudeScanStateMap: Record<string, ClaudeScanStateInfo> = {};
      if (tables.includes('claude_scan_state')) {
        try {
          const rows = db.prepare('SELECT path, inode, size, offset, mtime FROM claude_scan_state').all() as {
            path: string;
            inode: number;
            size: number;
            offset: number;
            mtime: number;
          }[];
          for (const r of rows) {
            claudeScanStateMap[r.path] = { inode: r.inode, size: r.size, offset: r.offset, mtime: r.mtime };
          }
        } catch { /* ignore */ }
      }

      const claudeSessionsMap: Record<string, ClaudeSessionInfo> = {};
      if (tables.includes('claude_sessions')) {
        try {
          const rows = db.prepare('SELECT sessionId, cwd FROM claude_sessions').all() as {
            sessionId: string;
            cwd: string;
          }[];
          for (const r of rows) {
            claudeSessionsMap[r.sessionId] = { cwd: r.cwd };
          }
        } catch { /* ignore */ }
      }

      let claudeUsageInfo: HubDbTableUsageDelta | null = null;
      if (tables.includes('claude_usage')) {
        try {
          const maxRow = db.prepare('SELECT MAX(rowid) as m, COUNT(*) as c FROM claude_usage').get() as { m: number | null; c: number };
          const maxRowid = maxRow.m ?? 0;
          const rows = db.prepare('SELECT rowid, sessionId, messageId FROM claude_usage WHERE rowid <= ? ORDER BY rowid').all(maxRowid);
          const checksum = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
          claudeUsageInfo = { maxRowid, count: maxRow.c, checksum };
        } catch { /* ignore */ }
      }

      let claudeTaskUsageInfo: HubDbTableUsageDelta | null = null;
      if (tables.includes('claude_task_usage')) {
        try {
          const maxRow = db.prepare('SELECT MAX(rowid) as m, COUNT(*) as c FROM claude_task_usage').get() as { m: number | null; c: number };
          const maxRowid = maxRow.m ?? 0;
          const rows = db.prepare('SELECT rowid, taskId, sessionId FROM claude_task_usage WHERE rowid <= ? ORDER BY rowid').all(maxRowid);
          const checksum = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
          claudeTaskUsageInfo = { maxRowid, count: maxRow.c, checksum };
        } catch { /* ignore */ }
      }

      return {
        isValid: true,
        schemaVersion,
        sensitiveHash,
        tables,
        tableChecksums,
        eventsInfo,
        claudeQuotaInfo,
        claudeQuotaProfilesMap,
        quotaUsageMap,
        quotaMarksMap,
        claudeScanStateMap,
        claudeSessionsMap,
        claudeUsageInfo,
        claudeTaskUsageInfo,
        taskIds,
        profileNames,
        projectIds,
      };
    } finally {
      db.close();
    }
  } catch {
    return { isValid: false };
  }
}

export function checkDbProcessHolding(targetPath: string): { daemonHolding: boolean; testHolding: boolean } {
  if (process.platform !== 'linux') return { daemonHolding: false, testHolding: false };
  try {
    const resolved = fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath);
    const myPid = process.pid;
    const pids = fs.readdirSync('/proc');
    let daemonHolding = false;
    let testHolding = false;

    for (const p of pids) {
      if (!/^\d+$/.test(p)) continue;
      const pid = Number(p);
      try {
        const fdDir = path.join('/proc', p, 'fd');
        const fds = fs.readdirSync(fdDir);
        for (const fd of fds) {
          try {
            if (fs.readlinkSync(path.join(fdDir, fd)) === resolved) {
              const cmd = fs.readFileSync(path.join('/proc', p, 'cmdline'), 'utf8');
              if (pid === myPid || cmd.includes('vitest') || cmd.includes('test')) {
                testHolding = true;
              } else if (cmd.includes('daemon') || cmd.includes('agenthub')) {
                daemonHolding = true;
              }
            }
          } catch { /* fd closed or invalid */ }
        }
      } catch { /* process exited */ }
    }

    return { daemonHolding, testHolding };
  } catch {
    return { daemonHolding: false, testHolding: false };
  }
}

export function isHeldByExternalDaemon(targetPath: string): boolean {
  const { daemonHolding, testHolding } = checkDbProcessHolding(targetPath);
  return daemonHolding && !testHolding;
}

// Runtime entries that the daemon or worker setup may create in the real hub
// home while tests are running. User/configuration data must not be added here.
const ALLOWED_HUB_RUNTIME_ENTRIES = new Set([
  'claude-failover.json',
  'deploy-push-state.json',
  'deploy-pending-state.json',
  'deploy-restart.json',
  'daemon.log',
  'logs',
  'worktrees',
  'cache',
  'web',
  'claude-homes',
  'codex-homes',
  'claude-usage-cwd',
  'shims',
  'sessions',
  'empty-hooks',
  'no-browser-bin',
  'branding',
  'tools',
]);

export function isIgnoredHubEntry(name: string): boolean {
  if (/^chat-mcp.*\.json$/.test(name)) return true;
  if (name.endsWith('.tmp') || name.includes('.tmp-')) return true;
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

export function getHubSnapshot(dir: string): HubHomeSnapshot {
  const exists = fs.existsSync(dir);
  const sensitiveFingerprints: Record<string, string | null> = {};
  let dbInfo: HubDbInfo | null = null;
  if (exists) {
    for (const name of SENSITIVE_HUB_ENTRIES) {
      sensitiveFingerprints[name] = getSensitiveFingerprint(path.join(dir, name));
    }
    const dbPath = path.join(dir, 'hub.db');
    if (fs.existsSync(dbPath)) {
      dbInfo = getHubDbInfo(dbPath);
    }
  }
  return {
    dir,
    exists,
    entries: exists ? getHubEntries(dir) : [],
    sensitiveFingerprints,
    dbInfo,
  };
}

export function verifyHubHomeSafety(
  snap: HubHomeSnapshot,
  currentDir: string = snap.dir,
  options?: { processHoldingChecker?: (targetPath: string) => { daemonHolding: boolean; testHolding: boolean } },
): void {
  const currentExists = fs.existsSync(currentDir);

  if (!snap.exists && currentExists) {
    throw new Error(
      `SAFETY NET VIOLATION: ${currentDir} was created during test execution! Tests must use temporary directory.`,
    );
  }

  if (snap.exists && currentExists) {
    if (snap.sensitiveFingerprints) {
      const checker = options?.processHoldingChecker || checkDbProcessHolding;
      for (const name of SENSITIVE_HUB_ENTRIES) {
        const initialFp = snap.sensitiveFingerprints[name];
        const currentFp = getSensitiveFingerprint(path.join(currentDir, name));
        if (initialFp !== null && initialFp !== undefined && currentFp !== initialFp) {
          if (name === 'hub.db') {
            const dbPath = path.join(currentDir, name);
            const { daemonHolding, testHolding } = checker(dbPath);
            if (testHolding) {
              throw new Error(
                `SAFETY NET VIOLATION: ${dbPath} was accessed by a test process during test execution! Tests must use temporary directory.`,
              );
            }
            if (daemonHolding && snap.dbInfo?.isValid) {
              const currentDbInfo = getHubDbInfo(dbPath);
              if (!currentDbInfo.isValid) {
                throw new Error(
                  `SAFETY NET VIOLATION: ${dbPath} was corrupted or invalid SQLite database! Tests must not touch hub.db.`,
                );
              }
              if (currentDbInfo.schemaVersion !== snap.dbInfo.schemaVersion) {
                throw new Error(
                  `SAFETY NET VIOLATION: ${dbPath} schema version changed during test execution! Tests must not run migrations on real db.`,
                );
              }
              if (currentDbInfo.sensitiveHash !== snap.dbInfo.sensitiveHash) {
                throw new Error(
                  `SAFETY NET VIOLATION: ${dbPath} sensitive tables (projects, profiles, permissions) were modified during test execution!`,
                );
              }

              // Check table schema changes: no tables added or removed
              const beforeTables = snap.dbInfo.tables || [];
              const currentTables = currentDbInfo.tables || [];
              if (
                beforeTables.length !== currentTables.length ||
                beforeTables.some((t, i) => t !== currentTables[i])
              ) {
                throw new Error(
                  `SAFETY NET VIOLATION: ${dbPath} tables changed during test execution! Tests must not alter schema or create tables in real hub.db.`,
                );
              }

              // Verify non-allowlisted tables have NOT been touched at all
              const beforeChecksums = snap.dbInfo.tableChecksums || {};
              const currentChecksums = currentDbInfo.tableChecksums || {};
              for (const [table, beforeChecksum] of Object.entries(beforeChecksums)) {
                if (currentChecksums[table] !== beforeChecksum) {
                  throw new Error(
                    `SAFETY NET VIOLATION: ${dbPath} non-allowlisted table "${table}" was modified during test execution! Tests must not touch hub.db.`,
                  );
                }
              }

              try {
                const db = new Database(dbPath, { readonly: true, fileMustExist: true });
                try {
                  const fkErrors = db.pragma('foreign_key_check') as unknown[];
                  if (fkErrors.length > 0) {
                    throw new Error(`SAFETY NET VIOLATION: ${dbPath} has foreign key violations after test execution!`);
                  }

                  // Verify events delta if events table exists
                  if (beforeTables.includes('events')) {
                    if (!snap.dbInfo.eventsInfo) {
                      throw new Error(
                        `SAFETY NET VIOLATION: ${dbPath} events info was not captured in initial snapshot!`,
                      );
                    }
                    const snapEvents = snap.dbInfo.eventsInfo;
                    const prevCountRow = db.prepare('SELECT COUNT(*) as count FROM events WHERE id <= ?').get(snapEvents.maxId) as { count: number };
                    if (prevCountRow.count !== snapEvents.count) {
                      throw new Error(
                        `SAFETY NET VIOLATION: ${dbPath} events were deleted or tampered during test execution!`,
                      );
                    }
                    const prevRows = db
                      .prepare('SELECT * FROM events WHERE id <= ? ORDER BY id')
                      .all(snapEvents.maxId);
                    const prevChecksum = crypto.createHash('sha256').update(JSON.stringify(prevRows)).digest('hex');
                    if (prevChecksum !== snapEvents.checksum) {
                      throw new Error(
                        `SAFETY NET VIOLATION: ${dbPath} existing events were modified during test execution!`,
                      );
                    }

                    // Check new events (delta)
                    const newRows = db
                      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id')
                      .all(snapEvents.maxId) as Record<string, unknown>[];

                    const allowedTaskIds = new Set(snap.dbInfo.taskIds || []);
                    for (const row of newRows) {
                      const type = String(row.type || '');
                      if (!ALLOWED_DAEMON_EVENT_TYPES.has(type)) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} events table contains unauthorized event type "${type}"! Tests must not touch hub.db.`,
                        );
                      }
                      const taskId = row.taskId ? String(row.taskId) : null;
                      if (taskId !== null) {
                        if (!allowedTaskIds.has(taskId) || /agenthub-test-|test-worker-|vitest/i.test(taskId)) {
                          throw new Error(
                            `SAFETY NET VIOLATION: ${dbPath} events table contains unexpected task reference "${taskId}"! Tests must not touch hub.db.`,
                          );
                        }
                      }
                      const payload = row.payload ? String(row.payload) : '';
                      if (payload && (/agenthub-test-|test-worker-/i.test(payload) || payload.includes('/tmp/agenthub-test-'))) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} events table contains test payload! Tests must not touch hub.db.`,
                        );
                      }
                    }
                  }

                  // Verify claude_quota delta if present
                  if (beforeTables.includes('claude_quota')) {
                    const currentRows = db.prepare('SELECT id, status, resetsAt, rateLimitType, isUsingOverage, observedAt FROM claude_quota').all() as ClaudeQuotaRow[];
                    if (currentRows.length > 1) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota has unexpected multiple rows!`);
                    }
                    const initialQuota = snap.dbInfo?.claudeQuotaInfo;
                    if (initialQuota) {
                      if (currentRows.length === 0) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota row was deleted during test execution!`);
                      }
                      const current = currentRows[0];
                      if (current.id !== 1) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota has unexpected row id ${current.id}!`);
                      }
                      const initialObs = Date.parse(initialQuota.observedAt);
                      const currentObs = Date.parse(current.observedAt);
                      if (!Number.isFinite(currentObs) || currentObs < initialObs) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota observedAt is invalid or was moved backwards!`);
                      }
                      if (currentObs <= initialObs && (
                        current.status !== initialQuota.status ||
                        current.resetsAt !== initialQuota.resetsAt ||
                        current.rateLimitType !== initialQuota.rateLimitType ||
                        current.isUsingOverage !== initialQuota.isUsingOverage
                      )) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota was modified without new observation timestamp!`);
                      }
                      if (current.status !== null && !ALLOWED_CLAUDE_QUOTA_STATUSES.has(current.status)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota has invalid status "${current.status}"!`);
                      }
                      if (current.rateLimitType !== null && !ALLOWED_RATE_LIMIT_TYPES.has(current.rateLimitType)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota has invalid rateLimitType "${current.rateLimitType}"!`);
                      }
                      if (current.resetsAt !== null && (!Number.isInteger(current.resetsAt) || current.resetsAt < 0)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota has invalid resetsAt!`);
                      }
                      if (current.isUsingOverage !== 0 && current.isUsingOverage !== 1) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota has invalid isUsingOverage!`);
                      }
                      if (/agenthub-test-|test-worker-|vitest/i.test(JSON.stringify(current))) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota contains test markers!`);
                      }
                    } else if (currentRows.length > 0) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota was created during test execution!`);
                    }
                  }

                  // Verify claude_quota_profiles delta if present
                  if (beforeTables.includes('claude_quota_profiles')) {
                    const currentRows = db.prepare('SELECT profileName, status, resetsAt, rateLimitType, isUsingOverage, observedAt FROM claude_quota_profiles').all() as ClaudeQuotaProfileRow[];
                    const initialMap = snap.dbInfo?.claudeQuotaProfilesMap || {};
                    if (currentRows.length < Object.keys(initialMap).length) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles records were deleted during test execution!`);
                    }
                    for (const current of currentRows) {
                      const initial = initialMap[current.profileName];
                      if (!initial) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles has unexpected new profile "${current.profileName}"!`);
                      }
                      const initialObs = Date.parse(initial.observedAt);
                      const currentObs = Date.parse(current.observedAt);
                      if (!Number.isFinite(currentObs) || currentObs < initialObs) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles observedAt moved backwards for "${current.profileName}"!`);
                      }
                      if (currentObs <= initialObs && (
                        current.status !== initial.status ||
                        current.resetsAt !== initial.resetsAt ||
                        current.rateLimitType !== initial.rateLimitType ||
                        current.isUsingOverage !== initial.isUsingOverage
                      )) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles was modified without new observation timestamp for "${current.profileName}"!`);
                      }
                      if (current.status !== null && !ALLOWED_CLAUDE_QUOTA_STATUSES.has(current.status)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles has invalid status "${current.status}"!`);
                      }
                      if (current.rateLimitType !== null && !ALLOWED_RATE_LIMIT_TYPES.has(current.rateLimitType)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles has invalid rateLimitType "${current.rateLimitType}"!`);
                      }
                      if (current.resetsAt !== null && (!Number.isInteger(current.resetsAt) || current.resetsAt < 0)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles has invalid resetsAt!`);
                      }
                      if (current.isUsingOverage !== 0 && current.isUsingOverage !== 1) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles has invalid isUsingOverage!`);
                      }
                      if (/agenthub-test-|test-worker-|vitest/i.test(JSON.stringify(current))) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota_profiles contains test markers!`);
                      }
                    }
                  }

                  // Verify quota_usage delta if present
                  if (beforeTables.includes('quota_usage')) {
                    const currentRows = db.prepare('SELECT profileName, grp, window, remainingPct, resetAt, fetchedAt FROM quota_usage').all() as QuotaUsageInfo[];
                    const initialMap = snap.dbInfo?.quotaUsageMap || {};
                    if (currentRows.length < Object.keys(initialMap).length) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage records were deleted during test execution!`);
                    }
                    for (const current of currentRows) {
                      const key = `${current.profileName}::${current.grp}::${current.window}`;
                      const initial = initialMap[key];
                      if (!initial) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage has unexpected new entry "${key}"!`);
                      }
                      if (current.fetchedAt < initial.fetchedAt) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage fetchedAt moved backwards for "${key}"!`);
                      }
                      if (current.fetchedAt <= initial.fetchedAt && (
                        current.remainingPct !== initial.remainingPct ||
                        current.resetAt !== initial.resetAt
                      )) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage was modified without new fetch timestamp for "${key}"!`);
                      }
                      if (typeof current.remainingPct !== 'number' || current.remainingPct < 0 || current.remainingPct > 100) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage remainingPct out of bounds for "${key}"!`);
                      }
                      if (typeof current.resetAt !== 'number' || current.resetAt < 0) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage resetAt invalid for "${key}"!`);
                      }
                      if (/agenthub-test-|test-worker-|vitest/i.test(JSON.stringify(current))) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage contains test markers!`);
                      }
                    }
                  }

                  // Verify quota_marks delta if present
                  if (beforeTables.includes('quota_marks')) {
                    const currentRows = db.prepare('SELECT profileName, family, until, reason FROM quota_marks').all() as QuotaMarkInfo[];
                    const initialMap = snap.dbInfo?.quotaMarksMap || {};
                    const allowedProfiles = new Set(snap.dbInfo?.profileNames || []);
                    for (const current of currentRows) {
                      if (!allowedProfiles.has(current.profileName) || /agenthub-test-|test-worker-|vitest/i.test(current.profileName)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_marks has unexpected profile "${current.profileName}"!`);
                      }
                      const key = `${current.profileName}::${current.family}`;
                      const initial = initialMap[key];
                      if (initial && current.until < initial.until) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_marks until moved backwards for "${key}"!`);
                      }
                      if (initial && current.until <= initial.until && current.reason !== initial.reason) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_marks was modified without new timestamp for "${key}"!`);
                      }
                      if (current.reason && /agenthub-test-|test-worker-|vitest/i.test(current.reason)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_marks contains test reason!`);
                      }
                    }
                  }

                  // Verify claude_scan_state delta if present
                  if (beforeTables.includes('claude_scan_state')) {
                    const currentRows = db.prepare('SELECT path, inode, size, offset, mtime, turnId, turnTasks FROM claude_scan_state').all() as {
                      path: string;
                      inode: number;
                      size: number;
                      offset: number;
                      mtime: number;
                      turnId?: string;
                      turnTasks?: string;
                    }[];
                    const initialMap = snap.dbInfo?.claudeScanStateMap || {};
                    if (currentRows.length < Object.keys(initialMap).length) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_scan_state records were deleted during test execution!`);
                    }
                    for (const current of currentRows) {
                      if (/agenthub-test-|test-worker-|vitest|\/tmp\//i.test(current.path)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_scan_state references test path "${current.path}"!`);
                      }
                      if (current.turnTasks && /agenthub-test-|test-worker-|vitest/i.test(current.turnTasks)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_scan_state references test task in turnTasks!`);
                      }
                      if (current.turnId && /agenthub-test-|test-worker-|vitest/i.test(current.turnId)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_scan_state contains test turnId!`);
                      }
                    }
                  }

                  // Verify claude_sessions delta if present
                  if (beforeTables.includes('claude_sessions')) {
                    const currentRows = db.prepare('SELECT sessionId, cwd, title FROM claude_sessions').all() as {
                      sessionId: string;
                      cwd: string;
                      title?: string;
                    }[];
                    const initialMap = snap.dbInfo?.claudeSessionsMap || {};
                    if (currentRows.length < Object.keys(initialMap).length) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_sessions records were deleted during test execution!`);
                    }
                    for (const current of currentRows) {
                      if (/agenthub-test-|test-worker-|vitest/i.test(current.sessionId)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_sessions has test sessionId "${current.sessionId}"!`);
                      }
                      if (current.cwd && /agenthub-test-|test-worker-|\/tmp\//i.test(current.cwd)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_sessions references test cwd "${current.cwd}"!`);
                      }
                      if (current.title && /agenthub-test-|test-worker-/i.test(current.title)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_sessions contains test title!`);
                      }
                    }
                  }

                  // Verify claude_usage delta if present
                  if (beforeTables.includes('claude_usage') && snap.dbInfo?.claudeUsageInfo) {
                    const info = snap.dbInfo.claudeUsageInfo;
                    const prevCount = (db.prepare('SELECT COUNT(*) as c FROM claude_usage WHERE rowid <= ?').get(info.maxRowid) as { c: number }).c;
                    if (prevCount !== info.count) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_usage existing records were deleted or tampered!`);
                    }
                    const prevRows = db.prepare('SELECT rowid, sessionId, messageId FROM claude_usage WHERE rowid <= ? ORDER BY rowid').all(info.maxRowid);
                    const prevChecksum = crypto.createHash('sha256').update(JSON.stringify(prevRows)).digest('hex');
                    if (prevChecksum !== info.checksum) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_usage existing records were modified!`);
                    }
                    const newRows = db.prepare('SELECT sessionId, turnId FROM claude_usage WHERE rowid > ?').all(info.maxRowid) as {
                      sessionId: string;
                      turnId: string;
                    }[];
                    for (const row of newRows) {
                      if (/agenthub-test-|test-worker-|vitest/i.test(row.sessionId) || /agenthub-test-|test-worker-|vitest/i.test(row.turnId)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_usage contains test session or turn!`);
                      }
                    }
                  }

                  // Verify claude_task_usage delta if present
                  if (beforeTables.includes('claude_task_usage') && snap.dbInfo?.claudeTaskUsageInfo) {
                    const info = snap.dbInfo.claudeTaskUsageInfo;
                    const prevCount = (db.prepare('SELECT COUNT(*) as c FROM claude_task_usage WHERE rowid <= ?').get(info.maxRowid) as { c: number }).c;
                    if (prevCount !== info.count) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_task_usage existing records were deleted or tampered!`);
                    }
                    const prevRows = db.prepare('SELECT rowid, taskId, sessionId FROM claude_task_usage WHERE rowid <= ? ORDER BY rowid').all(info.maxRowid);
                    const prevChecksum = crypto.createHash('sha256').update(JSON.stringify(prevRows)).digest('hex');
                    if (prevChecksum !== info.checksum) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_task_usage existing records were modified!`);
                    }
                    const allowedTasks = new Set(snap.dbInfo.taskIds || []);
                    const newRows = db.prepare('SELECT taskId, sessionId FROM claude_task_usage WHERE rowid > ?').all(info.maxRowid) as {
                      taskId: string;
                      sessionId: string;
                    }[];
                    for (const row of newRows) {
                      if (!allowedTasks.has(row.taskId) || /agenthub-test-|test-worker-|vitest/i.test(row.taskId) || /agenthub-test-|test-worker-|vitest/i.test(row.sessionId)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_task_usage contains test task or session!`);
                      }
                    }
                  }
                } finally {
                  db.close();
                }
              } catch (err: unknown) {
                if (err instanceof Error && err.message.startsWith('SAFETY NET VIOLATION:')) throw err;
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`SAFETY NET VIOLATION: ${dbPath} verification failed: ${msg}`);
              }
              // Legitimate external daemon background activity verified
              continue;
            }
          }
          throw new Error(
            `SAFETY NET VIOLATION: ${path.join(currentDir, name)} was modified during test execution! Sensitive user or configuration data must not be touched.`,
          );
        }
        if (initialFp === null && currentFp !== null) {
          throw new Error(
            `SAFETY NET VIOLATION: ${path.join(currentDir, name)} was created during test execution! Sensitive user or configuration data must not be touched.`,
          );
        }
      }
    }

    const currentEntries = getHubEntries(currentDir);
    const unexpected = findUnexpectedHubEntries(snap.entries, currentEntries);
    if (unexpected.length > 0) {
      throw new Error(
        `SAFETY NET VIOLATION: ${currentDir} was modified during test execution! Unexpected new entries: [${unexpected.join(', ')}]`,
      );
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
