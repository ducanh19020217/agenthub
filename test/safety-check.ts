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

export interface HubDbInfo {
  isValid: boolean;
  schemaVersion?: string;
  sensitiveHash?: string;
  tables?: string[];
  tableChecksums?: Record<string, string>;
  eventsInfo?: HubDbEventsInfo | null;
  tasksMap?: Record<string, { projectId: string; worktreePath: string }>;
  maxReviewRowid?: number;
  maxRunRowid?: number;
  maxCheckResultRowid?: number;
  maxTaskNoteRowid?: number;
  maxRunMetricRowid?: number;
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
  'brain_status',
  'brain_turns',
  'quota_usage',
  'quota_marks',
  'claude_sessions',
  'claude_scan_state',
  'claude_task_usage',
  'claude_usage',
  'claude_quota',
  'claude_quota_profiles',
  'tasks',
  'runs',
  'reviews',
  'check_results',
  'run_metrics',
  'task_notes',
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
      try { projects = db.prepare('SELECT id, name, path FROM projects ORDER BY id').all(); } catch { /* ignore */ }

      let profiles: unknown[] = [];
      try { profiles = db.prepare('SELECT id, name, provider FROM profiles ORDER BY id').all(); } catch { /* ignore */ }

      let departments: unknown[] = [];
      try { departments = db.prepare('SELECT id, name FROM departments ORDER BY id').all(); } catch { /* ignore */ }

      let permissionRules: unknown[] = [];
      try { permissionRules = db.prepare('SELECT * FROM permission_rules ORDER BY id').all(); } catch { /* ignore */ }

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

      const projectIds = (projects as { id: string }[]).map((p) => p.id);

      const taskIds: string[] = [];
      const tasksMap: Record<string, { projectId: string; worktreePath: string }> = {};
      try {
        const rows = db.prepare('SELECT id, projectId, worktreePath FROM tasks').all() as {
          id: string;
          projectId: string;
          worktreePath: string;
        }[];
        for (const r of rows) {
          taskIds.push(r.id);
          tasksMap[r.id] = { projectId: r.projectId, worktreePath: r.worktreePath };
        }
      } catch { /* table might not exist */ }

      let maxReviewRowid = 0;
      try {
        const r = db.prepare('SELECT MAX(rowid) as m FROM reviews').get() as { m: number | null };
        maxReviewRowid = r?.m ?? 0;
      } catch { /* ignore */ }

      let maxRunRowid = 0;
      try {
        const r = db.prepare('SELECT MAX(rowid) as m FROM runs').get() as { m: number | null };
        maxRunRowid = r?.m ?? 0;
      } catch { /* ignore */ }

      let maxCheckResultRowid = 0;
      try {
        const r = db.prepare('SELECT MAX(rowid) as m FROM check_results').get() as { m: number | null };
        maxCheckResultRowid = r?.m ?? 0;
      } catch { /* ignore */ }

      let maxTaskNoteRowid = 0;
      try {
        const r = db.prepare('SELECT MAX(rowid) as m FROM task_notes').get() as { m: number | null };
        maxTaskNoteRowid = r?.m ?? 0;
      } catch { /* ignore */ }

      let maxRunMetricRowid = 0;
      try {
        const r = db.prepare('SELECT MAX(rowid) as m FROM run_metrics').get() as { m: number | null };
        maxRunMetricRowid = r?.m ?? 0;
      } catch { /* ignore */ }

      let profileNames: string[] = [];
      try {
        const rows = db.prepare('SELECT name FROM profiles').all() as { name: string }[];
        profileNames = rows.map((r) => r.name);
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

      return {
        isValid: true,
        schemaVersion,
        sensitiveHash,
        tables,
        tableChecksums,
        eventsInfo,
        tasksMap,
        maxReviewRowid,
        maxRunRowid,
        maxCheckResultRowid,
        maxTaskNoteRowid,
        maxRunMetricRowid,
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
                  if (beforeTables.includes('events') && snap.dbInfo.eventsInfo) {
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

                  // Verify brain_status delta if present
                  if (beforeTables.includes('brain_status')) {
                    const rows = db.prepare('SELECT id, taskId, detail FROM brain_status').all() as { id: number; taskId: string | null; detail: string | null }[];
                    const allowedTaskIds = new Set(snap.dbInfo.taskIds || []);
                    for (const row of rows) {
                      if (row.id !== 1) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} brain_status has unexpected row id ${row.id}!`);
                      }
                      if (row.taskId && (!allowedTaskIds.has(row.taskId) || /agenthub-test-|test-worker-/i.test(row.taskId))) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} brain_status references test task "${row.taskId}"!`);
                      }
                      if (row.detail && /agenthub-test-|test-worker-/i.test(row.detail)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} brain_status contains test details!`);
                      }
                    }
                  }

                  // Verify quota_usage if present
                  if (beforeTables.includes('quota_usage')) {
                    const rows = db.prepare('SELECT DISTINCT profileName FROM quota_usage').all() as { profileName: string }[];
                    const allowedProfiles = new Set(snap.dbInfo.profileNames || []);
                    for (const row of rows) {
                      if (!allowedProfiles.has(row.profileName)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_usage has unexpected profile "${row.profileName}"!`);
                      }
                    }
                  }

                  // Verify quota_marks if present
                  if (beforeTables.includes('quota_marks')) {
                    const rows = db.prepare('SELECT DISTINCT profileName FROM quota_marks').all() as { profileName: string }[];
                    const allowedProfiles = new Set(snap.dbInfo.profileNames || []);
                    for (const row of rows) {
                      if (!allowedProfiles.has(row.profileName)) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} quota_marks has unexpected profile "${row.profileName}"!`);
                      }
                    }
                  }

                  // Verify claude_quota if present
                  if (beforeTables.includes('claude_quota')) {
                    const rows = db.prepare('SELECT id FROM claude_quota').all() as { id: number }[];
                    for (const row of rows) {
                      if (row.id !== 1) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} claude_quota has unexpected row id ${row.id}!`);
                      }
                    }
                  }

                  // Verify tasks: no new tasks allowed, existing tasks paths immutable
                  if (beforeTables.includes('tasks')) {
                    const currentTasks = db.prepare('SELECT id, projectId, worktreePath FROM tasks').all() as {
                      id: string;
                      projectId: string;
                      worktreePath: string;
                    }[];
                    const initialTasks = snap.dbInfo.tasksMap || {};
                    if (currentTasks.length < Object.keys(initialTasks).length) {
                      throw new Error(`SAFETY NET VIOLATION: ${dbPath} tasks were deleted during test execution!`);
                    }
                    for (const task of currentTasks) {
                      const initial = initialTasks[task.id];
                      if (!initial) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} table "tasks" was modified with new task "${task.id}"! Tests must not touch hub.db.`,
                        );
                      }
                      if (task.projectId !== initial.projectId) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} task "${task.id}" projectId was modified during test execution!`,
                        );
                      }
                      if (task.worktreePath !== initial.worktreePath) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} task "${task.id}" worktreePath was modified during test execution!`,
                        );
                      }
                      if (
                        task.worktreePath &&
                        (/agenthub-test-|test-worker-/i.test(task.worktreePath) || task.worktreePath.includes('/tmp/'))
                      ) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} contains test tasks! Tests must not touch real hub.db.`);
                      }
                    }
                  }

                  // Verify reviews delta if present
                  if (beforeTables.includes('reviews')) {
                    const newReviews = db
                      .prepare('SELECT * FROM reviews WHERE rowid > ?')
                      .all(snap.dbInfo.maxReviewRowid ?? 0) as Record<string, unknown>[];
                    const allowedTaskIds = new Set(snap.dbInfo.taskIds || []);
                    for (const rev of newReviews) {
                      const taskId = String(rev.taskId || '');
                      if (!allowedTaskIds.has(taskId) || /agenthub-test-|test-worker-/i.test(taskId)) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} table "reviews" contains unexpected task reference "${taskId}"! Tests must not touch hub.db.`,
                        );
                      }
                      const feedback = String(rev.feedback || '');
                      if (/agenthub-test-|test-worker-/i.test(feedback) || feedback.includes('/tmp/agenthub-test-')) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} table "reviews" contains test feedback!`);
                      }
                    }
                  }

                  // Verify runs delta if present
                  if (beforeTables.includes('runs')) {
                    const newRuns = db
                      .prepare('SELECT * FROM runs WHERE rowid > ?')
                      .all(snap.dbInfo.maxRunRowid ?? 0) as Record<string, unknown>[];
                    const allowedTaskIds = new Set(snap.dbInfo.taskIds || []);
                    for (const run of newRuns) {
                      const taskId = String(run.taskId || '');
                      if (!allowedTaskIds.has(taskId) || /agenthub-test-|test-worker-/i.test(taskId)) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} table "runs" contains unexpected task reference "${taskId}"! Tests must not touch hub.db.`,
                        );
                      }
                      const logPath = String(run.logPath || '');
                      if (/agenthub-test-|test-worker-/i.test(logPath) || logPath.includes('/tmp/agenthub-test-')) {
                        throw new Error(`SAFETY NET VIOLATION: ${dbPath} table "runs" contains test logPath!`);
                      }
                    }
                  }

                  // Verify check_results delta if present
                  if (beforeTables.includes('check_results')) {
                    const newChecks = db
                      .prepare('SELECT * FROM check_results WHERE rowid > ?')
                      .all(snap.dbInfo.maxCheckResultRowid ?? 0) as Record<string, unknown>[];
                    const allowedTaskIds = new Set(snap.dbInfo.taskIds || []);
                    for (const chk of newChecks) {
                      const taskId = String(chk.taskId || '');
                      if (!allowedTaskIds.has(taskId) || /agenthub-test-|test-worker-/i.test(taskId)) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} table "check_results" contains unexpected task reference "${taskId}"! Tests must not touch hub.db.`,
                        );
                      }
                    }
                  }

                  // Verify run_metrics delta if present
                  if (beforeTables.includes('run_metrics')) {
                    const newMetrics = db
                      .prepare('SELECT * FROM run_metrics WHERE rowid > ?')
                      .all(snap.dbInfo.maxRunMetricRowid ?? 0) as Record<string, unknown>[];
                    const allowedTaskIds = new Set(snap.dbInfo.taskIds || []);
                    for (const m of newMetrics) {
                      const taskId = String(m.taskId || '');
                      if (!allowedTaskIds.has(taskId) || /agenthub-test-|test-worker-/i.test(taskId)) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} table "run_metrics" contains unexpected task reference "${taskId}"! Tests must not touch hub.db.`,
                        );
                      }
                    }
                  }

                  // Verify task_notes delta if present
                  if (beforeTables.includes('task_notes')) {
                    const newNotes = db
                      .prepare('SELECT * FROM task_notes WHERE rowid > ?')
                      .all(snap.dbInfo.maxTaskNoteRowid ?? 0) as Record<string, unknown>[];
                    const allowedTaskIds = new Set(snap.dbInfo.taskIds || []);
                    for (const note of newNotes) {
                      const taskId = String(note.taskId || '');
                      if (!allowedTaskIds.has(taskId) || /agenthub-test-|test-worker-/i.test(taskId)) {
                        throw new Error(
                          `SAFETY NET VIOLATION: ${dbPath} table "task_notes" contains unexpected task reference "${taskId}"! Tests must not touch hub.db.`,
                        );
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
