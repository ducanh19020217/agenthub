import Database from 'better-sqlite3';
import { decodeCursor, encodeCursor, parsePageSize, PageResult } from '../pagination.js';

function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, (c) => c === 'đ' ? 'd' : 'D').toLowerCase();
}

export const MIGRATIONS: string[] = [
  // Migration 0: initial schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    defaultBranch TEXT NOT NULL DEFAULT 'main',
    envTemplate TEXT, -- JSON
    maxParallel INTEGER NOT NULL DEFAULT 3,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profiles (
    name TEXT PRIMARY KEY,
    engine TEXT NOT NULL CHECK(engine IN ('agy', 'codex')),
    kind TEXT NOT NULL CHECK(kind IN ('keyring', 'isolated', 'codex')),
    home TEXT,
    email TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quota_marks (
    profileName TEXT NOT NULL,
    family TEXT NOT NULL,
    until INTEGER NOT NULL, -- epoch seconds
    reason TEXT,
    PRIMARY KEY (profileName, family),
    FOREIGN KEY (profileName) REFERENCES profiles(name)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, -- projectId/slug
    projectId TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy', 'hard')),
    modelChain TEXT, -- JSON array or null
    baseRef TEXT,
    branch TEXT,
    worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota')),
    dependsOn TEXT NOT NULL DEFAULT '[]', -- JSON array of task ids
    attempt INTEGER NOT NULL DEFAULT 0,
    resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS task_deps (
    taskId TEXT NOT NULL,
    dependsOnId TEXT NOT NULL,
    PRIMARY KEY (taskId, dependsOnId),
    FOREIGN KEY (taskId) REFERENCES tasks(id),
    FOREIGN KEY (dependsOnId) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    profileName TEXT NOT NULL,
    pid INTEGER,
    startedAt TEXT NOT NULL DEFAULT (datetime('now')),
    endedAt TEXT,
    outcome TEXT CHECK(outcome IN ('done','blocked','quota','crashed','cancelled','timeout','stalled')),
    logPath TEXT,
    resetAt INTEGER,
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('approved', 'changes_requested')),
    feedback TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL,
    taskId TEXT,
    payload TEXT -- JSON
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0');
  `,
  // Migration 1: scheduler recovery, retry and slot state
  `
  ALTER TABLE tasks ADD COLUMN notBefore INTEGER;
  ALTER TABLE tasks ADD COLUMN transientRetries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN slot INTEGER;
  ALTER TABLE runs ADD COLUMN pidStart INTEGER;
  `,
  // Migration 2: live quota usage snapshots
  `
  CREATE TABLE IF NOT EXISTS quota_usage (
    profileName TEXT NOT NULL,
    grp TEXT NOT NULL,
    window TEXT NOT NULL CHECK(window IN ('5h', 'week')),
    remainingPct INTEGER NOT NULL,
    resetAt INTEGER NOT NULL,
    fetchedAt INTEGER NOT NULL,
    PRIMARY KEY (profileName, grp, window),
    FOREIGN KEY (profileName) REFERENCES profiles(name)
  );
  `,
  // Migration 3: project checks and persisted results
  `
  ALTER TABLE projects ADD COLUMN checks TEXT;
  ALTER TABLE tasks ADD COLUMN checkFixAttempts INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS check_results (taskId TEXT NOT NULL, runId TEXT NOT NULL, name TEXT NOT NULL, ok INTEGER NOT NULL, exitCode INTEGER, durationMs INTEGER NOT NULL, outputTail TEXT NOT NULL, FOREIGN KEY (taskId) REFERENCES tasks(id), FOREIGN KEY (runId) REFERENCES runs(id));
  `,
  // Migration 4: brain status
  `
  CREATE TABLE IF NOT EXISTS brain_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    activity TEXT NOT NULL,
    detail TEXT NOT NULL,
    taskId TEXT,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO brain_status (id, activity, detail, taskId, updatedAt)
  VALUES (1, 'idle', '', NULL, datetime('now'));
  `,
  // Migration 5: chat sessions and messages
  `
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    claudeSessionId TEXT,
    title TEXT,
    mode TEXT NOT NULL DEFAULT 'safe' CHECK(mode IN ('safe','full')),
    busy INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','error')),
    content TEXT NOT NULL,
    meta TEXT, -- JSON
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );
  `,
  // Migration 6: chat model per session
  `
  ALTER TABLE chat_sessions ADD COLUMN model TEXT NOT NULL DEFAULT '';
  `,
  // Migration 7: preserve foreign keys while recording stalled runs
  `
  ALTER TABLE runs ADD COLUMN reason TEXT;
  `,
  // Migration 8: profile auth state and verification URL
  `
  ALTER TABLE profiles ADD COLUMN authState TEXT CHECK(authState IS NULL OR authState IN ('ok', 'not_logged_in', 'needs_verification', 'error'));
  ALTER TABLE profiles ADD COLUMN authMessage TEXT;
  ALTER TABLE profiles ADD COLUMN verifyUrl TEXT;
  `,
  // Migration 9: checking status in tasks
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy', 'hard')),
    modelChain TEXT,
    baseRef TEXT,
    branch TEXT,
    worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota')),
    dependsOn TEXT NOT NULL DEFAULT '[]',
    attempt INTEGER NOT NULL DEFAULT 0,
    resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    notBefore INTEGER,
    transientRetries INTEGER NOT NULL DEFAULT 0,
    slot INTEGER,
    checkFixAttempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO tasks_new (id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath, status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot, checkFixAttempts)
    SELECT id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath, status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot, checkFixAttempts FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  PRAGMA foreign_keys = ON;
  `,
  // Migration 10: identify the reviewer that produced each decision
  `
  ALTER TABLE reviews ADD COLUMN actor TEXT NOT NULL DEFAULT 'claude';
  `,
  // Migration 11: distinguish durable reviewer runs from worker runs
  `
  ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker' CHECK(kind IN ('worker', 'reviewer'));
  `,
  // Migration 12: persist reviewer loop protection and manual escalation state
  `
  ALTER TABLE tasks ADD COLUMN reviewerChangesRequested INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reviewerEscalated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reviewerEscalatedAt TEXT;
  ALTER TABLE tasks ADD COLUMN reviewerEscalationReason TEXT;
  `,
  // Migration 13: run metrics for savings calculation
  `
  CREATE TABLE IF NOT EXISTS run_metrics (
    runId TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    profileName TEXT NOT NULL,
    tokensUsed INTEGER,
    usageBefore INTEGER,
    usageAfter INTEGER,
    linesAdded INTEGER NOT NULL DEFAULT 0,
    linesDeleted INTEGER NOT NULL DEFAULT 0,
    filesChanged INTEGER NOT NULL DEFAULT 0,
    durationMs INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (runId) REFERENCES runs(id),
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );
  `,
  // Migration 14: Claude Code session usage
  `
  CREATE TABLE IF NOT EXISTS claude_scan_state (
    path TEXT PRIMARY KEY, inode INTEGER NOT NULL, size INTEGER NOT NULL,
    offset INTEGER NOT NULL, mtime INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS claude_sessions (
    sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT, firstAt TEXT,
    lastAt TEXT, model TEXT, messages INTEGER NOT NULL DEFAULT 0,
    inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
    cacheCreationTokens INTEGER NOT NULL DEFAULT 0, cacheReadTokens INTEGER NOT NULL DEFAULT 0,
    effectiveTokens REAL NOT NULL DEFAULT 0, isHubChat INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS claude_usage (
    sessionId TEXT NOT NULL, messageId TEXT NOT NULL, ts TEXT NOT NULL,
    turnId TEXT NOT NULL, model TEXT, input INTEGER NOT NULL, output INTEGER NOT NULL,
    cacheCreation INTEGER NOT NULL, cacheRead INTEGER NOT NULL, effective REAL NOT NULL,
    isSidechain INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sessionId, messageId)
  );
  CREATE TABLE IF NOT EXISTS claude_task_usage (
    taskId TEXT NOT NULL, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
    effectiveTokens REAL NOT NULL, PRIMARY KEY(taskId, sessionId, turnId)
  );
  CREATE TABLE IF NOT EXISTS claude_quota (
    id INTEGER PRIMARY KEY CHECK(id = 1), status TEXT, resetsAt INTEGER,
    rateLimitType TEXT, isUsingOverage INTEGER NOT NULL DEFAULT 0, observedAt TEXT NOT NULL
  );
  `,
  // Migration 15: resume attribution state without splitting an in-progress turn
  `
  ALTER TABLE claude_scan_state ADD COLUMN turnId TEXT NOT NULL DEFAULT '';
  ALTER TABLE claude_scan_state ADD COLUMN turnTasks TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE claude_scan_state ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1;
  `,
  // Migration 16: task wait reason
  `
  ALTER TABLE tasks ADD COLUMN waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk', 'quota', 'parallel', 'profile_busy'));
  `,
  // Migration 17: project hooks (e.g. onWorktreeRemoved)
  `
  ALTER TABLE projects ADD COLUMN hooks TEXT;
  `,
  // Migration 18: automatic merge configuration
  `
  ALTER TABLE projects ADD COLUMN merge TEXT;
  `,
  // Migration 19: explicit chat lifecycle state
  `
  ALTER TABLE chat_sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'idle'
    CHECK(state IN ('idle','running','waiting_permission','error'));
  `,
  // Migration 20: Claude Code profiles and chat account selection
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE profiles_new (
    name TEXT PRIMARY KEY,
    engine TEXT NOT NULL CHECK(engine IN ('agy', 'codex', 'claude')),
    kind TEXT NOT NULL CHECK(kind IN ('keyring', 'isolated', 'codex', 'system')),
    home TEXT,
    email TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    authState TEXT CHECK(authState IS NULL OR authState IN ('ok', 'not_logged_in', 'needs_verification', 'error')),
    authMessage TEXT,
    verifyUrl TEXT
  );
  INSERT INTO profiles_new (name, engine, kind, home, email, enabled, createdAt, authState, authMessage, verifyUrl)
    SELECT name, engine, kind, home, email, enabled, createdAt, authState, authMessage, verifyUrl FROM profiles;
  DROP TABLE profiles;
  ALTER TABLE profiles_new RENAME TO profiles;
  PRAGMA foreign_keys = ON;
  ALTER TABLE chat_sessions ADD COLUMN profileName TEXT;
  `,
  // Migration 21: chat permission requests
  `
  CREATE TABLE IF NOT EXISTS chat_permissions (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    messageId TEXT,
    toolName TEXT NOT NULL,
    input TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','allow','deny','allow_always')),
    message TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    resolvedAt TEXT,
    FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS chat_permissions_pending_idx ON chat_permissions(sessionId, status, createdAt);
  `,
  // Migration 22: chat session metadata, token tracking, and message indexing
  `
  ALTER TABLE chat_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN lastMessageAt TEXT;
  ALTER TABLE chat_sessions ADD COLUMN inputTokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN outputTokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN contextTokens INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(sessionId, createdAt);
  UPDATE chat_sessions SET lastMessageAt = (SELECT MAX(createdAt) FROM chat_messages WHERE sessionId = chat_sessions.id);
  `,
  // Migration 23: soft-deleted profiles (hidden and never scheduled; run history keeps the name)
  `
  ALTER TABLE profiles ADD COLUMN deletedAt TEXT;
  `,
  // Migration 24: task notes and overlaps
  `
  CREATE TABLE IF NOT EXISTS task_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId TEXT NOT NULL,
    taskId TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('note', 'overlap')),
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id),
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_notes_project ON task_notes(projectId, id);
  CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(taskId, id);
  `,
  // Migration 25: persist dependency context before worktrees are cleaned up
  `
  ALTER TABLE tasks ADD COLUMN doneReport TEXT;
  ALTER TABLE tasks ADD COLUMN diffStat TEXT;
  `,
  // Migration 26: task provenance for captured errors
  `ALTER TABLE tasks ADD COLUMN sourceRef TEXT;`,
  // Migration 27: project knowledge entries
  `
  CREATE TABLE IF NOT EXISTS knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId TEXT NOT NULL,
    taskId TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    pinned INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (projectId) REFERENCES projects(id),
    CHECK (length(taskId) > 0)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(projectId, pinned DESC, createdAt DESC);
  `,
  // Migration 28: profile management (label, notes, priority)
  `
  ALTER TABLE profiles ADD COLUMN label TEXT;
  ALTER TABLE profiles ADD COLUMN notes TEXT;
  ALTER TABLE profiles ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  `,
  // Migration 29: provider account type and legacy multiple-profile policy
  `
  ALTER TABLE profiles ADD COLUMN accountType TEXT NOT NULL DEFAULT 'personal'
    CHECK(accountType IN ('personal', 'team', 'api'));
  INSERT OR REPLACE INTO meta (key, value)
    SELECT 'multiple_per_provider_legacy', 'true'
    WHERE EXISTS (
      SELECT 1 FROM profiles
      WHERE accountType = 'personal' AND deletedAt IS NULL
      GROUP BY engine HAVING COUNT(*) > 1
    );
  `,
  // Migration 30: per-project multi-step review chains
  `
  ALTER TABLE projects ADD COLUMN reviewChain TEXT;
  ALTER TABLE tasks ADD COLUMN reviewStep INTEGER NOT NULL DEFAULT 0;
  `,
  // Migration 31: review settings (chain and gate round limit)
  `ALTER TABLE projects ADD COLUMN review TEXT;`,
  // Migration 32: allow system role in chat_messages
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE chat_messages_new (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','error','system')),
    content TEXT NOT NULL,
    meta TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );
  INSERT INTO chat_messages_new (id, sessionId, role, content, meta, createdAt)
    SELECT id, sessionId, role, content, meta, createdAt FROM chat_messages;
  DROP TABLE chat_messages;
  ALTER TABLE chat_messages_new RENAME TO chat_messages;
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(sessionId, createdAt);
  PRAGMA foreign_keys = ON;
  `,
  // Migration 33: durable Claude chat retries and session auto-resume metadata
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE chat_sessions_new (
    id TEXT PRIMARY KEY, projectId TEXT, claudeSessionId TEXT, title TEXT,
    mode TEXT NOT NULL DEFAULT 'safe' CHECK(mode IN ('safe','full')),
    busy INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    model TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','running','waiting_permission','waiting_limit','error')),
    profileName TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    lastMessageAt TEXT, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
    contextTokens INTEGER NOT NULL DEFAULT 0, waitingLimitResetAt INTEGER,
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO chat_sessions_new (id,projectId,claudeSessionId,title,mode,busy,createdAt,updatedAt,model,state,profileName,pinned,archived,lastMessageAt,inputTokens,outputTokens,contextTokens)
    SELECT id,projectId,claudeSessionId,title,mode,busy,createdAt,updatedAt,model,state,profileName,pinned,archived,lastMessageAt,inputTokens,outputTokens,contextTokens FROM chat_sessions;
  DROP TABLE chat_sessions;
  ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS chat_retries (
    sessionId TEXT NOT NULL,
    messageId TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    resetAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('pending','sent','cancelled','failed')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_chat_retries_pending ON chat_retries(status, resetAt);
  ALTER TABLE claude_sessions ADD COLUMN limitResetAt INTEGER;
  ALTER TABLE claude_sessions ADD COLUMN limitHitAt TEXT;
  ALTER TABLE claude_sessions ADD COLUMN autoResumeEnabled INTEGER NOT NULL DEFAULT 0;
  `,
  // Migration 34: task batches and batchId for tasks
  `
  CREATE TABLE IF NOT EXISTS task_batches (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'dispatched', 'discarded')),
    createdBy TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_batches_project ON task_batches(projectId, createdAt DESC);
  ALTER TABLE tasks ADD COLUMN batchId TEXT;
  CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batchId);
  `,
  // Migration 35: per-task lookup indexes (savings and task detail did a full scan per task)
  `
  CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(taskId);
  CREATE INDEX IF NOT EXISTS idx_reviews_task ON reviews(taskId);
  CREATE INDEX IF NOT EXISTS idx_run_metrics_task ON run_metrics(taskId);
  CREATE INDEX IF NOT EXISTS idx_claude_task_usage_task ON claude_task_usage(taskId);
  `,
  // Migration 36: auditable permission decision reasons
  `
  ALTER TABLE chat_permissions ADD COLUMN reason TEXT;
  `,
  // Migration 37: safe Claude transcript activity metadata for brain status
  `
  ALTER TABLE claude_sessions ADD COLUMN lastUserRequest TEXT;
  ALTER TABLE claude_sessions ADD COLUMN lastToolName TEXT;
  ALTER TABLE claude_sessions ADD COLUMN lastToolSummary TEXT;
  ALTER TABLE claude_sessions ADD COLUMN lastEventKind TEXT;
  ALTER TABLE claude_sessions ADD COLUMN fiveHourTokens REAL;
  `,
  // Migration 38: distinguish the resident brain chat from ordinary chats
  `
  ALTER TABLE chat_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'
    CHECK(kind IN ('chat','brain'));
  `,
  // Migration 39: durable resident brain turn accounting
  `
  CREATE TABLE IF NOT EXISTS brain_turns (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    input TEXT NOT NULL,
    summary TEXT,
    status TEXT NOT NULL CHECK(status IN ('running','done','quota','failed','limited')),
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    startedAt TEXT NOT NULL DEFAULT (datetime('now')),
    finishedAt TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_brain_turns_started ON brain_turns(startedAt);
  `,
  // Migration 40: forget transcript paths of Claude projects the hub does not manage (privacy).
  // The scanner used to record every transcript path on the machine; folder names reveal project names.
  `
  DELETE FROM claude_scan_state WHERE eligible = 0;
  `,
  // Migration 41: per-project settings (JSON, see src/projects/settings.ts) and per-project brain turns.
  `
  ALTER TABLE projects ADD COLUMN settings TEXT;
  ALTER TABLE brain_turns ADD COLUMN projectId TEXT;
  CREATE INDEX IF NOT EXISTS idx_brain_turns_project ON brain_turns(projectId, startedAt);
  `,
  // Migration 42: allow 'project_unavailable' waitReason for unmounted drives
  `
  ALTER TABLE tasks ADD COLUMN waitReason_old TEXT;
  UPDATE tasks SET waitReason_old = waitReason;
  ALTER TABLE tasks DROP COLUMN waitReason;
  ALTER TABLE tasks ADD COLUMN waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk', 'quota', 'parallel', 'profile_busy', 'project_unavailable'));
  UPDATE tasks SET waitReason = waitReason_old;
  ALTER TABLE tasks DROP COLUMN waitReason_old;
  `,
  // Migration 43: Claude quota observations per profile (keep claude_quota for legacy clients).
  `
  CREATE TABLE IF NOT EXISTS claude_quota_profiles (
    profileName TEXT PRIMARY KEY,
    status TEXT,
    resetsAt INTEGER,
    rateLimitType TEXT,
    isUsingOverage INTEGER NOT NULL DEFAULT 0,
    observedAt TEXT NOT NULL
  );
  `,
  // Migration 44: GitHub Actions CI runs and annotations
  `
  CREATE TABLE IF NOT EXISTS ci_runs (
    projectId TEXT NOT NULL,
    runId INTEGER NOT NULL,
    workflow TEXT NOT NULL,
    sha TEXT NOT NULL,
    status TEXT NOT NULL,
    conclusion TEXT,
    jobs TEXT NOT NULL DEFAULT '[]',
    completedAt TEXT,
    url TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (projectId, runId),
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ci_runs_project ON ci_runs(projectId, completedAt);
  `,
  // Migration 45: durable chat permission rules
  `
  CREATE TABLE IF NOT EXISTS permission_rules (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('session','project','global')),
    sessionId TEXT,
    projectId TEXT,
    toolName TEXT NOT NULL,
    pattern TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    createdBy TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_permission_rules_lookup
    ON permission_rules(scope, sessionId, projectId, toolName, pattern);
  `,
  // Migration 46: assistant sessions and durable user directives for the brain.
  // chat_sessions had a CHECK on kind, so rebuild it while preserving every column.
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE chat_sessions_new (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    claudeSessionId TEXT,
    title TEXT,
    mode TEXT NOT NULL DEFAULT 'safe' CHECK(mode IN ('safe','full')),
    busy INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    model TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','running','waiting_permission','waiting_limit','error')),
    profileName TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    lastMessageAt TEXT,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    contextTokens INTEGER NOT NULL DEFAULT 0,
    waitingLimitResetAt INTEGER,
    kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','brain','assistant')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO chat_sessions_new
    (id,projectId,claudeSessionId,title,mode,busy,createdAt,updatedAt,model,state,profileName,pinned,archived,lastMessageAt,inputTokens,outputTokens,contextTokens,waitingLimitResetAt,kind)
    SELECT id,projectId,claudeSessionId,title,mode,busy,createdAt,updatedAt,model,state,profileName,pinned,archived,lastMessageAt,inputTokens,outputTokens,contextTokens,waitingLimitResetAt,kind
    FROM chat_sessions;
  DROP TABLE chat_sessions;
  ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS brain_directives (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    text TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    createdBy TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_brain_directives_project_active ON brain_directives(projectId, active, createdAt);
  `,
  // Migration 47: preserve the Claude session and original goal for standalone task history grouping.
  `
  ALTER TABLE tasks ADD COLUMN creationSessionId TEXT;
  ALTER TABLE tasks ADD COLUMN creationGoal TEXT;
  CREATE INDEX IF NOT EXISTS idx_tasks_creation_session ON tasks(projectId, creationSessionId, createdAt);
  `,
  // Migration 48: indexes for dashboard/API filters and per-resource history.
  `
  CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(projectId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status_created ON tasks(projectId, status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_task_deps_dependency ON task_deps(dependsOnId, taskId);
  CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(taskId, id);
  CREATE INDEX IF NOT EXISTS idx_runs_outcome_task ON runs(outcome, taskId);
  CREATE INDEX IF NOT EXISTS idx_check_results_task_run ON check_results(taskId, runId);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(sessionId, createdAt);
  `,
  // Migration 49: bind persisted check results to the worktree revision.
  `
  ALTER TABLE check_results ADD COLUMN head TEXT;
  `,
  // Migration 50: soft-deleted projects remain restorable with their history.
  `ALTER TABLE projects ADD COLUMN archivedAt TEXT;`,
  // Migration 51: paused tasks are retained while their project is hidden.
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy','hard')),
    modelChain TEXT,
    baseRef TEXT,
    branch TEXT,
    worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota','paused')),
    dependsOn TEXT NOT NULL DEFAULT '[]',
    attempt INTEGER NOT NULL DEFAULT 0,
    resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    notBefore INTEGER,
    transientRetries INTEGER NOT NULL DEFAULT 0,
    slot INTEGER,
    checkFixAttempts INTEGER NOT NULL DEFAULT 0,
    reviewerChangesRequested INTEGER NOT NULL DEFAULT 0,
    reviewerEscalated INTEGER NOT NULL DEFAULT 0,
    reviewerEscalatedAt TEXT,
    reviewerEscalationReason TEXT,
    waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk','quota','parallel','profile_busy','project_unavailable')),
    doneReport TEXT,
    diffStat TEXT,
    sourceRef TEXT,
    reviewStep INTEGER NOT NULL DEFAULT 0,
    batchId TEXT,
    creationSessionId TEXT,
    creationGoal TEXT,
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO tasks_new (
    id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath,
    status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries,
    slot, checkFixAttempts, reviewerChangesRequested, reviewerEscalated, reviewerEscalatedAt,
    reviewerEscalationReason, waitReason, doneReport, diffStat, sourceRef, reviewStep, batchId,
    creationSessionId, creationGoal
  )
  SELECT
    id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath,
    status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries,
    slot, checkFixAttempts, reviewerChangesRequested, reviewerEscalated, reviewerEscalatedAt,
    reviewerEscalationReason, waitReason, doneReport, diffStat, sourceRef, reviewStep, batchId,
    creationSessionId, creationGoal
  FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(projectId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status_created ON tasks(projectId, status, createdAt);
  PRAGMA foreign_keys = ON;
  `,
  // Migration 52: departments group projects and optionally assign worker profiles.
  `
  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    priority INTEGER NOT NULL DEFAULT 0,
    maxParallel INTEGER NOT NULL DEFAULT 3,
    claudeDailyTokenBudget INTEGER NOT NULL DEFAULT 0,
    telegramTopicId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO departments (id, name) VALUES ('chung', 'Chung');
  ALTER TABLE projects ADD COLUMN departmentId TEXT NOT NULL DEFAULT 'chung';
  CREATE INDEX IF NOT EXISTS idx_projects_department ON projects(departmentId);
  CREATE TABLE IF NOT EXISTS department_profiles (
    departmentId TEXT NOT NULL,
    profileName TEXT NOT NULL,
    share REAL,
    PRIMARY KEY (departmentId, profileName),
    FOREIGN KEY (departmentId) REFERENCES departments(id) ON DELETE CASCADE,
    FOREIGN KEY (profileName) REFERENCES profiles(name) ON DELETE CASCADE
  );
  `,
  // Migration 53: resident brain settings and department-scoped turn accounting.
  `
  ALTER TABLE departments ADD COLUMN brainEngine TEXT NOT NULL DEFAULT 'claude';
  ALTER TABLE departments ADD COLUMN brainModel TEXT NOT NULL DEFAULT 'sonnet';
  ALTER TABLE departments ADD COLUMN brainCodexProfile TEXT;
  ALTER TABLE departments ADD COLUMN brainMode TEXT NOT NULL DEFAULT 'inherit';
  ALTER TABLE departments ADD COLUMN brainPermissions TEXT NOT NULL DEFAULT 'full';
  ALTER TABLE departments ADD COLUMN brainDailyTokenBudget INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE departments ADD COLUMN brainMaxTurnsPerHour INTEGER NOT NULL DEFAULT 20;
  ALTER TABLE brain_turns ADD COLUMN departmentId TEXT;
  CREATE INDEX IF NOT EXISTS idx_brain_turns_department ON brain_turns(departmentId, startedAt);
  `,
  // Migration 54: external references for task/project commit conventions.
  `ALTER TABLE tasks ADD COLUMN externalRef TEXT;`,
  // Migration 55: project focus wait reason (after externalRef, which live hubs applied first as 54).
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE tasks_focus_new AS SELECT * FROM tasks;
  DROP TABLE tasks;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy','hard')), modelChain TEXT, baseRef TEXT,
    branch TEXT, worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota','paused')),
    dependsOn TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 0, resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    notBefore INTEGER, transientRetries INTEGER NOT NULL DEFAULT 0, slot INTEGER, checkFixAttempts INTEGER NOT NULL DEFAULT 0,
    reviewerChangesRequested INTEGER NOT NULL DEFAULT 0, reviewerEscalated INTEGER NOT NULL DEFAULT 0,
    reviewerEscalatedAt TEXT, reviewerEscalationReason TEXT,
    waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk','quota','parallel','profile_busy','project_unavailable','focus')),
    doneReport TEXT, diffStat TEXT, sourceRef TEXT, reviewStep INTEGER NOT NULL DEFAULT 0, batchId TEXT,
    creationSessionId TEXT, creationGoal TEXT, externalRef TEXT, FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO tasks SELECT * FROM tasks_focus_new;
  DROP TABLE tasks_focus_new;
  CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(projectId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status_created ON tasks(projectId, status, createdAt);
  PRAGMA foreign_keys = ON;
  `,
  // Migration 56: unlimited default department and department-level wait reasons.
  `
  UPDATE departments SET maxParallel = 0 WHERE id = 'chung' AND maxParallel = 3;
  PRAGMA foreign_keys = OFF;
  CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy','hard')), modelChain TEXT, baseRef TEXT,
    branch TEXT, worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota','paused')),
    dependsOn TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 0, resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    notBefore INTEGER, transientRetries INTEGER NOT NULL DEFAULT 0, slot INTEGER, checkFixAttempts INTEGER NOT NULL DEFAULT 0,
    reviewerChangesRequested INTEGER NOT NULL DEFAULT 0, reviewerEscalated INTEGER NOT NULL DEFAULT 0,
    reviewerEscalatedAt TEXT, reviewerEscalationReason TEXT,
    waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk','quota','parallel','department_parallel','profile_busy','project_unavailable','focus')),
    doneReport TEXT, diffStat TEXT, sourceRef TEXT, reviewStep INTEGER NOT NULL DEFAULT 0, batchId TEXT,
    creationSessionId TEXT, creationGoal TEXT, externalRef TEXT, FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO tasks_new (
    id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath,
    status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot,
    checkFixAttempts, reviewerChangesRequested, reviewerEscalated, reviewerEscalatedAt,
    reviewerEscalationReason, waitReason, doneReport, diffStat, sourceRef, reviewStep, batchId,
    creationSessionId, creationGoal, externalRef
  ) SELECT
    id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath,
    status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot,
    checkFixAttempts, reviewerChangesRequested, reviewerEscalated, reviewerEscalatedAt,
    reviewerEscalationReason, waitReason, doneReport, diffStat, sourceRef, reviewStep, batchId,
    creationSessionId, creationGoal, externalRef
  FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(projectId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status_created ON tasks(projectId, status, createdAt);
  PRAGMA foreign_keys = ON;
  `,
  // Migration 57: distinguish department configuration waits from quota waits.
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy','hard')), modelChain TEXT, baseRef TEXT,
    branch TEXT, worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota','paused')),
    dependsOn TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 0, resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    notBefore INTEGER, transientRetries INTEGER NOT NULL DEFAULT 0, slot INTEGER, checkFixAttempts INTEGER NOT NULL DEFAULT 0,
    reviewerChangesRequested INTEGER NOT NULL DEFAULT 0, reviewerEscalated INTEGER NOT NULL DEFAULT 0,
    reviewerEscalatedAt TEXT, reviewerEscalationReason TEXT,
    waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk','quota','no_department_profile','no_matching_profile','parallel','department_parallel','profile_busy','project_unavailable','focus')),
    doneReport TEXT, diffStat TEXT, sourceRef TEXT, reviewStep INTEGER NOT NULL DEFAULT 0, batchId TEXT,
    creationSessionId TEXT, creationGoal TEXT, externalRef TEXT, FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO tasks_new SELECT * FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(projectId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status_created ON tasks(projectId, status, createdAt);
  PRAGMA foreign_keys = ON;
  `,
  // Migration 58: department brain* fields default to 'inherit' so project > department > global priority works.
  `
  UPDATE departments SET brainEngine = 'inherit' WHERE brainEngine = 'claude';
  UPDATE departments SET brainModel = 'inherit' WHERE brainModel = 'sonnet';
  UPDATE departments SET brainPermissions = 'inherit' WHERE brainPermissions = 'full';
  UPDATE departments SET brainMaxTurnsPerHour = 0 WHERE brainMaxTurnsPerHour = 20;
  `,
  // Migration 59: OpenProject tracker synchronization state.
  `
  CREATE TABLE IF NOT EXISTS tracker_items (
    source_id TEXT NOT NULL,
    wp_id INTEGER NOT NULL,
    display_id TEXT NOT NULL,
    status_id INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_comment_id INTEGER,
    task_ids TEXT NOT NULL DEFAULT '[]',
    writeback TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, wp_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tracker_items_source_updated ON tracker_items(source_id, updated_at);
  `,
  // Migration 60: persist BLOCKED reports after the worktree is cleaned up.
  `ALTER TABLE tasks ADD COLUMN blockedReport TEXT;`,
  // Migration 61: pending secret entry requests never store secret values in SQLite.
  `
  CREATE TABLE IF NOT EXISTS secret_requests (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','configured','expired')),
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    configuredAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_secret_requests_status_expiry ON secret_requests(status, expiresAt);
  `,
  // Migration 62: expand task wait reasons to distinguish slot, load, and dependency.
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy','hard')), modelChain TEXT, baseRef TEXT,
    branch TEXT, worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota','paused')),
    dependsOn TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 0, resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    notBefore INTEGER, transientRetries INTEGER NOT NULL DEFAULT 0, slot INTEGER, checkFixAttempts INTEGER NOT NULL DEFAULT 0,
    reviewerChangesRequested INTEGER NOT NULL DEFAULT 0, reviewerEscalated INTEGER NOT NULL DEFAULT 0,
    reviewerEscalatedAt TEXT, reviewerEscalationReason TEXT,
    waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk','quota','no_department_profile','no_matching_profile','parallel','department_parallel','profile_busy','project_unavailable','focus','slot','load','dependency')),
    doneReport TEXT, blockedReport TEXT, diffStat TEXT, sourceRef TEXT, reviewStep INTEGER NOT NULL DEFAULT 0, batchId TEXT,
    creationSessionId TEXT, creationGoal TEXT, externalRef TEXT,
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO tasks_new (
    id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath,
    status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot,
    checkFixAttempts, reviewerChangesRequested, reviewerEscalated, reviewerEscalatedAt,
    reviewerEscalationReason, waitReason, doneReport, blockedReport, diffStat, sourceRef, reviewStep, batchId,
    creationSessionId, creationGoal, externalRef
  ) SELECT
    id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath,
    status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot,
    checkFixAttempts, reviewerChangesRequested, reviewerEscalated, reviewerEscalatedAt,
    reviewerEscalationReason, waitReason, doneReport, blockedReport, diffStat, sourceRef, reviewStep, batchId,
    creationSessionId, creationGoal, externalRef
  FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE INDEX IF NOT EXISTS idx_tasks_project_created ON tasks(projectId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, createdAt);
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status_created ON tasks(projectId, status, createdAt);
  PRAGMA foreign_keys = ON;
  `,
  // Migration 63: setup chat sessions use the setup playbook and have their own MCP policy.
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE chat_sessions_setup_new AS SELECT * FROM chat_sessions;
  DROP TABLE chat_sessions;
  CREATE TABLE chat_sessions (
    id TEXT PRIMARY KEY, projectId TEXT, claudeSessionId TEXT, title TEXT,
    mode TEXT NOT NULL DEFAULT 'safe' CHECK(mode IN ('safe','full')),
    busy INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')), model TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','running','waiting_permission','waiting_limit','error')),
    profileName TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    lastMessageAt TEXT, inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
    contextTokens INTEGER NOT NULL DEFAULT 0, waitingLimitResetAt INTEGER,
    kind TEXT NOT NULL DEFAULT 'chat' CHECK(kind IN ('chat','brain','assistant','setup')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO chat_sessions SELECT * FROM chat_sessions_setup_new;
  DROP TABLE chat_sessions_setup_new;
  PRAGMA foreign_keys = ON;
  `,
  // Migration 64: idempotent OpenProject timesheet writeback.
  `
  CREATE TABLE IF NOT EXISTS timesheet_entries (
    source_id TEXT NOT NULL, spent_on TEXT NOT NULL, wp_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL, hours REAL NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, spent_on, wp_id)
  );
  `,
  // Migration 65: rawHours per day and written_estimate tracking for Estimated Time writeback.
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE IF NOT EXISTS timesheet_entries_new (
    source_id TEXT NOT NULL,
    spent_on TEXT NOT NULL,
    wp_id INTEGER NOT NULL,
    entry_id INTEGER NOT NULL,
    hours REAL NOT NULL,
    raw_hours REAL,
    written_estimate REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, spent_on, wp_id)
  );
  INSERT OR REPLACE INTO timesheet_entries_new (source_id, spent_on, wp_id, entry_id, hours, updated_at)
    SELECT source_id, spent_on, wp_id, entry_id, hours, updated_at FROM timesheet_entries;
  DROP TABLE timesheet_entries;
  ALTER TABLE timesheet_entries_new RENAME TO timesheet_entries;
  PRAGMA foreign_keys = ON;
  `,
  // Migration 66: manually entered OpenProject timesheet work.
  `
  CREATE TABLE IF NOT EXISTS timesheet_manual_entries (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    spent_on TEXT NOT NULL,
    wp_id INTEGER NOT NULL,
    display_id TEXT NOT NULL,
    description TEXT NOT NULL,
    active_hours REAL NOT NULL CHECK(active_hours >= 0),
    wait_hours REAL NOT NULL CHECK(wait_hours >= 0),
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy', 'hard')),
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK(active_hours + wait_hours > 0),
    CHECK(active_hours + wait_hours <= 24)
  );
  CREATE INDEX IF NOT EXISTS idx_timesheet_manual_date ON timesheet_manual_entries(source_id, spent_on);
  `,
  // Migration 67: per-day total-hour overrides for timesheet preview/writeback.
  `
  CREATE TABLE IF NOT EXISTS timesheet_day_overrides (
    source_id TEXT NOT NULL,
    spent_on TEXT NOT NULL,
    hours REAL NOT NULL CHECK(hours >= 8),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, spent_on)
  );
  `,
];

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.function('agenthub_normalize', normalizeSearchText);

  // Run migrations
  const versionRow = (() => {
    try {
      return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
    } catch {
      return undefined;
    }
  })();

  let currentVersion = versionRow ? parseInt(versionRow.value, 10) : -1;
  currentVersion = repairForkAvatarMigration(db, currentVersion);

  for (let i = currentVersion + 1; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(i),
    );
  }
  ensureProfileAvatarColumn(db);
  ensureSchedulerLimitColumns(db);
  cleanExpiredClaudeLimits(db);

  return db;
}

function cleanExpiredClaudeLimits(db: Database.Database): void {
  try {
    const threshold = Math.floor(Date.now() / 1000) - 24 * 3600;
    db.prepare('UPDATE claude_sessions SET limitResetAt = NULL, limitHitAt = NULL WHERE limitResetAt IS NOT NULL AND limitResetAt <= ?').run(threshold);
  } catch {
    // claude_sessions table may not exist in early migration states
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>)
    .some((row) => row.name === column);
}

/**
 * Bản fork từng dùng migration 41 cho profiles.avatarUrl, trùng số với migration 41 của upstream
 * (projects.settings). DB đã chạy bản fork có schema_version = 41 nhưng thiếu cột của upstream:
 * lùi về 40 để migration 41 thật được chạy. Cột avatarUrl do ensureProfileAvatarColumn lo.
 */
function repairForkAvatarMigration(db: Database.Database, currentVersion: number): number {
  if (currentVersion !== 41 || hasColumn(db, 'projects', 'settings') || !hasColumn(db, 'profiles', 'avatarUrl')) {
    return currentVersion;
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run('40');
  return 40;
}

/** Cột riêng của bản fork (avatarUrl, plan) nằm ngoài MIGRATIONS để không giành số migration với upstream. */
function ensureProfileAvatarColumn(db: Database.Database): void {
  if (!hasColumn(db, 'profiles', 'avatarUrl')) db.exec('ALTER TABLE profiles ADD COLUMN avatarUrl TEXT');
  if (!hasColumn(db, 'profiles', 'plan')) db.exec('ALTER TABLE profiles ADD COLUMN plan TEXT');
}

/** Scheduler safety state is appended outside numbered migrations to preserve the public schema sequence. */
function ensureSchedulerLimitColumns(db: Database.Database): void {
  const add = (table: string, column: string, definition: string) => {
    if (hasColumn(db, table, column)) return;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch (error) {
      if (!String(error).includes('duplicate column name')) throw error;
    }
  };
  add('tasks', 'runCount', 'INTEGER NOT NULL DEFAULT 0');
  add('tasks', 'consecutiveCrashes', 'INTEGER NOT NULL DEFAULT 0');
  add('profiles', 'consecutiveCrashes', 'INTEGER NOT NULL DEFAULT 0');
  add('profiles', 'lastCrashAt', 'INTEGER');
  add('profiles', 'coolingUntil', 'INTEGER');
}

// Repository helpers
export interface ProjectHooks {
  onWorktreeRemoved?: string[];
}

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  envTemplate: string | null;
  maxParallel: number;
  departmentId: string;
  checks: string | null;
  hooks: string | null;
  merge?: string | null;
  reviewChain?: string | null;
  review?: string | null;
  /** JSON ProjectSettings; read through projectSettings() in src/projects/settings.ts. */
  settings?: string | null;
  integrationStatus?: {
    path: string;
    branch: string;
    exists: boolean;
    currentBranch: string | null;
    dirty: boolean;
    ahead: number;
    behind: number;
  } | null;
  createdAt: string;
  archivedAt?: string | null;
}

export interface DepartmentRow {
  id: string;
  name: string;
  priority: number;
  maxParallel: number;
  claudeDailyTokenBudget: number;
  telegramTopicId: number | null;
  brainEngine?: 'inherit' | 'claude' | 'codex';
  brainModel?: string;
  brainCodexProfile?: string | null;
  brainMode?: 'inherit' | 'off' | 'suggest' | 'auto';
  brainPermissions?: 'inherit' | 'standard' | 'trusted' | 'full';
  brainDailyTokenBudget?: number;
  brainMaxTurnsPerHour?: number;
  createdAt: string;
  profiles?: DepartmentProfileRow[];
  projectCount?: number;
}

export interface DepartmentProfileRow {
  departmentId: string;
  profileName: string;
  share: number | null;
}

export interface DepartmentProjectRow {
  id: string;
  name: string;
}

export interface ProjectDeleteTask {
  id: string;
  projectId: string;
  slug: string;
  worktreePath: string | null;
}

export interface ProjectDeleteData {
  tasks: ProjectDeleteTask[];
  counts: Record<string, number>;
}

export type ProfileAuthState = 'ok' | 'not_logged_in' | 'needs_verification' | 'error';

export interface ProfileRow {
  name: string;
  engine: 'agy' | 'codex' | 'claude';
  kind: 'keyring' | 'isolated' | 'codex' | 'system';
  home: string | null;
  email: string | null;
  enabled: number;
  createdAt: string;
  authState?: ProfileAuthState | null;
  authMessage?: string | null;
  verifyUrl?: string | null;
  label?: string | null;
  notes?: string | null;
  priority?: number;
  accountType?: 'personal' | 'team' | 'api';
  avatarUrl?: string | null;
  /** Gói tài khoản đã chuẩn hoá (free, plus, pro, team, max_20x…); xem src/profiles/plan.ts. */
  plan?: string | null;
  deletedAt?: string | null;
  consecutiveCrashes?: number;
  lastCrashAt?: number | null;
  coolingUntil?: number | null;
}

export interface QuotaMarkRow {
  profileName: string;
  family: string;
  until: number;
  reason: string | null;
}

export interface QuotaUsageRow {
  profileName: string;
  grp: string;
  window: '5h' | 'week';
  remainingPct: number;
  resetAt: number;
  fetchedAt: number;
}

export type WaitReason = 'disk' | 'quota' | 'no_department_profile' | 'no_matching_profile' | 'parallel' | 'department_parallel' | 'profile_busy' | 'project_unavailable' | 'focus' | 'slot' | 'load' | 'dependency' | null;

export interface BlockingDiskInfo {
  path: string;
  label: string;
  freeGB: number;
  minFreeGB: number;
}

export interface TaskRow {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  externalRef: string | null;
  body: string | null;
  level: string;
  modelChain: string | null;
  baseRef: string | null;
  branch: string | null;
  worktreePath: string | null;
  sourceRef?: string | null;
  status: string;
  waitReason?: WaitReason;
  blockingDisk?: BlockingDiskInfo | null;
  dependsOn: string;
  attempt: number;
  resume: number;
  notBefore: number | null;
  transientRetries: number;
  runCount: number;
  consecutiveCrashes: number;
  checkFixAttempts: number;
  reviewerChangesRequested?: number;
  reviewerEscalated?: number;
  reviewerEscalatedAt?: string | null;
  reviewerEscalationReason?: string | null;
  autoMergeSkippedReason?: string | null;
  autoMergeSkippedChecks?: unknown[];
  reviewStep?: number;
  doneReport?: string | null;
  blockedReport?: string | null;
  diffStat?: string | null;
  slot: number | null;
  batchId?: string | null;
  creationSessionId?: string | null;
  creationGoal?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BatchStatus = 'draft' | 'dispatched' | 'discarded';

export interface TaskBatchRow {
  id: string;
  projectId: string;
  title: string;
  goal: string | null;
  status: BatchStatus;
  createdBy: string | null;
  createdAt: string;
}

export interface RunRow {
  id: string;
  taskId: string;
  engine: string;
  model: string;
  profileName: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  reason: string | null;
  logPath: string | null;
  resetAt: number | null;
  pidStart: number | null;
  kind: 'worker' | 'reviewer';
}

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  taskId: string | null;
  payload: string | null;
}

export class ProjectRepo {
  constructor(private db: Database.Database) {}

  getAll(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects WHERE archivedAt IS NULL ORDER BY id').all() as ProjectRow[];
  }

  getAllIncludingArchived(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
  }

  get(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ? AND archivedAt IS NULL').get(id) as ProjectRow | undefined;
  }

  getIncludingArchived(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  insert(
    row: Omit<ProjectRow, 'createdAt' | 'checks' | 'hooks' | 'merge' | 'reviewChain' | 'review' | 'settings' | 'departmentId'> & {
      checks?: string | null;
      hooks?: string | null;
      merge?: string | null;
      reviewChain?: string | null;
      review?: string | null;
      settings?: string | null;
      departmentId?: string;
    },
  ): void {
    this.db
      .prepare(
        'INSERT INTO projects (id, name, path, defaultBranch, envTemplate, maxParallel, checks, hooks, merge, reviewChain, review, settings, departmentId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.name,
        row.path,
        row.defaultBranch,
        row.envTemplate,
        row.maxParallel,
        row.checks || null,
        row.hooks || null,
        row.merge || null,
        row.reviewChain || null,
        row.review || null,
        row.settings || null,
        row.departmentId || 'chung',
      );
  }

  update(
    id: string,
    fields: Partial<Pick<ProjectRow, 'name' | 'defaultBranch' | 'envTemplate' | 'maxParallel' | 'checks' | 'hooks' | 'merge' | 'reviewChain' | 'review' | 'settings' | 'archivedAt' | 'departmentId'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      // A partial update must not clear columns the caller did not send.
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  archive(id: string): void {
    this.db.prepare("UPDATE projects SET archivedAt = datetime('now') WHERE id = ?").run(id);
  }

  restore(id: string): void {
    this.db.prepare('UPDATE projects SET archivedAt = NULL WHERE id = ?').run(id);
  }

  getDeleteData(id: string): ProjectDeleteData {
    const tasks = this.db.prepare('SELECT id, projectId, slug, worktreePath FROM tasks WHERE projectId = ?').all(id) as ProjectDeleteTask[];
    const count = (table: string, where: string, value: string | null = id): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(value) as { count: number };
      return row.count;
    };
    const taskIds = tasks.map((task) => task.id);
    const taskCount = (table: string, column: string): number => {
      if (taskIds.length === 0) return 0;
      const placeholders = taskIds.map(() => '?').join(',');
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders})`).get(...taskIds) as { count: number };
      return row.count;
    };
    return {
      tasks,
      counts: {
        tasks: tasks.length,
        runs: taskCount('runs', 'taskId'),
        reviews: taskCount('reviews', 'taskId'),
        runMetrics: taskCount('run_metrics', 'taskId'),
        claudeTaskUsage: taskCount('claude_task_usage', 'taskId'),
        taskNotes: count('task_notes', 'projectId = ?'),
        knowledgeEntries: count('knowledge_entries', 'projectId = ?'),
        taskBatches: count('task_batches', 'projectId = ?'),
        chatSessions: count('chat_sessions', 'projectId = ?'),
        brainTurns: count('brain_turns', 'projectId = ?'),
        permissionRules: (this.db.prepare('SELECT COUNT(*) AS count FROM permission_rules WHERE projectId = ? OR sessionId IN (SELECT id FROM chat_sessions WHERE projectId = ?)').get(id, id) as { count: number }).count,
        ciRuns: count('ci_runs', 'projectId = ?'),
        brainDirectives: count('brain_directives', 'projectId = ?'),
      },
    };
  }

  purge(id: string): void {
    const transaction = this.db.transaction(() => {
      const tasks = this.db.prepare('SELECT id FROM tasks WHERE projectId = ?').all(id) as Array<{ id: string }>;
      const taskIds = tasks.map((task) => task.id);
      const deleteByTasks = (table: string, column: string) => {
        if (taskIds.length === 0) return;
        const placeholders = taskIds.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...taskIds);
      };
      deleteByTasks('check_results', 'taskId');
      deleteByTasks('run_metrics', 'taskId');
      deleteByTasks('claude_task_usage', 'taskId');
      deleteByTasks('reviews', 'taskId');
      deleteByTasks('task_notes', 'taskId');
      deleteByTasks('runs', 'taskId');
      deleteByTasks('events', 'taskId');
      this.db.prepare('DELETE FROM task_notes WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM knowledge_entries WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM task_deps WHERE taskId IN (SELECT id FROM tasks WHERE projectId = ?) OR dependsOnId IN (SELECT id FROM tasks WHERE projectId = ?)').run(id, id);
      this.db.prepare('DELETE FROM tasks WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM task_batches WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM permission_rules WHERE projectId = ? OR sessionId IN (SELECT id FROM chat_sessions WHERE projectId = ?)').run(id, id);
      this.db.prepare('DELETE FROM chat_permissions WHERE sessionId IN (SELECT id FROM chat_sessions WHERE projectId = ?)').run(id);
      this.db.prepare('DELETE FROM chat_retries WHERE sessionId IN (SELECT id FROM chat_sessions WHERE projectId = ?)').run(id);
      this.db.prepare('DELETE FROM chat_messages WHERE sessionId IN (SELECT id FROM chat_sessions WHERE projectId = ?)').run(id);
      this.db.prepare('DELETE FROM chat_sessions WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM brain_turns WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM ci_runs WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM brain_directives WHERE projectId = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    transaction();
  }
}

export class DepartmentRepo {
  constructor(private db: Database.Database) {}

  getAll(): DepartmentRow[] {
    return this.db.prepare(`
      SELECT d.*, COUNT(DISTINCT p.id) AS projectCount
      FROM departments d LEFT JOIN projects p ON p.departmentId = d.id AND p.archivedAt IS NULL
      GROUP BY d.id ORDER BY d.priority DESC, d.name
    `).all() as DepartmentRow[];
  }

  get(id: string): DepartmentRow | undefined {
    return this.db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as DepartmentRow | undefined;
  }

  insert(row: Omit<DepartmentRow, 'createdAt' | 'profiles' | 'projectCount'>): void {
    this.db.prepare(
      `INSERT INTO departments
       (id, name, priority, maxParallel, claudeDailyTokenBudget, telegramTopicId,
        brainEngine, brainModel, brainCodexProfile, brainMode, brainPermissions,
        brainDailyTokenBudget, brainMaxTurnsPerHour)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.name, row.priority, row.maxParallel, row.claudeDailyTokenBudget, row.telegramTopicId,
      row.brainEngine || 'inherit', row.brainModel || 'inherit', row.brainCodexProfile || null,
      row.brainMode || 'inherit', row.brainPermissions || 'inherit', row.brainDailyTokenBudget || 0,
      row.brainMaxTurnsPerHour || 0);
  }

  update(id: string, fields: Partial<Pick<DepartmentRow, 'name' | 'priority' | 'maxParallel' | 'claudeDailyTokenBudget' | 'telegramTopicId' | 'brainEngine' | 'brainModel' | 'brainCodexProfile' | 'brainMode' | 'brainPermissions' | 'brainDailyTokenBudget' | 'brainMaxTurnsPerHour'>>): void {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    this.db.prepare(`UPDATE departments SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  delete(id: string): void {
    if (id === 'chung') throw new Error('Không thể xóa phòng ban Chung');
    this.db.prepare("UPDATE projects SET departmentId = 'chung' WHERE departmentId = ?").run(id);
    this.db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  }

  profiles(departmentId: string): DepartmentProfileRow[] {
    return this.db.prepare('SELECT * FROM department_profiles WHERE departmentId = ? ORDER BY profileName').all(departmentId) as DepartmentProfileRow[];
  }

  projects(departmentId: string): DepartmentProjectRow[] {
    return this.db.prepare('SELECT id, name FROM projects WHERE departmentId = ? AND archivedAt IS NULL ORDER BY name').all(departmentId) as DepartmentProjectRow[];
  }

  claudeUsageToday(departmentId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(ctu.effectiveTokens), 0) AS tokens
      FROM claude_task_usage ctu
      JOIN tasks t ON t.id = ctu.taskId
      JOIN projects p ON p.id = t.projectId
      WHERE p.departmentId = ? AND EXISTS (
        SELECT 1 FROM claude_usage cu
        WHERE cu.sessionId = ctu.sessionId AND cu.turnId = ctu.turnId
          AND date(cu.ts, 'localtime') = date('now', 'localtime')
      )
    `).get(departmentId) as { tokens: number };
    return Number(row?.tokens || 0);
  }

  setProfiles(departmentId: string, profiles: Array<{ profileName: string; share?: number | null }>): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM department_profiles WHERE departmentId = ?').run(departmentId);
      const insert = this.db.prepare('INSERT INTO department_profiles (departmentId, profileName, share) VALUES (?, ?, ?)');
      for (const profile of profiles) insert.run(departmentId, profile.profileName, profile.share ?? null);
    });
    transaction();
  }

  transferProfile(profileName: string, fromDepartmentId: string, toDepartmentId: string): void {
    if (fromDepartmentId === toDepartmentId) return;
    const transaction = this.db.transaction(() => {
      const assignment = this.db.prepare(
        'SELECT share FROM department_profiles WHERE departmentId = ? AND profileName = ?',
      ).get(fromDepartmentId, profileName) as { share: number | null } | undefined;
      if (!assignment) throw new Error(`Profile ${profileName} is not assigned to ${fromDepartmentId}`);
      this.db.prepare(
        'DELETE FROM department_profiles WHERE departmentId = ? AND profileName = ?',
      ).run(fromDepartmentId, profileName);
      this.db.prepare(
        `INSERT INTO department_profiles (departmentId, profileName, share) VALUES (?, ?, ?)
         ON CONFLICT(departmentId, profileName) DO UPDATE SET share = excluded.share`,
      ).run(toDepartmentId, profileName, assignment.share);
    });
    transaction();
  }
}

export class ProfileRepo {
  constructor(private db: Database.Database) {}

  getAll(includeDeleted = false): ProfileRow[] {
    if (includeDeleted) {
      return this.db.prepare('SELECT * FROM profiles ORDER BY name').all() as ProfileRow[];
    }
    return this.db.prepare('SELECT * FROM profiles WHERE deletedAt IS NULL ORDER BY name').all() as ProfileRow[];
  }

  get(name: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
      | ProfileRow
      | undefined;
  }

  upsert(row: Omit<ProfileRow, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO profiles (name, engine, kind, home, email, enabled, authState, authMessage, verifyUrl, label, notes, priority, deletedAt, accountType, avatarUrl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           engine=excluded.engine,
           kind=excluded.kind,
           home=excluded.home,
           email=excluded.email,
           authState=COALESCE(excluded.authState, profiles.authState),
           authMessage=COALESCE(excluded.authMessage, profiles.authMessage),
           verifyUrl=COALESCE(excluded.verifyUrl, profiles.verifyUrl),
           label=COALESCE(excluded.label, profiles.label),
           notes=COALESCE(excluded.notes, profiles.notes),
           priority=COALESCE(excluded.priority, profiles.priority),
           accountType=COALESCE(excluded.accountType, profiles.accountType),
           avatarUrl=COALESCE(excluded.avatarUrl, profiles.avatarUrl),
           deletedAt=COALESCE(excluded.deletedAt, profiles.deletedAt)`,
      )
      .run(
        row.name,
        row.engine,
        row.kind,
        row.home,
        row.email,
        row.enabled,
        row.authState ?? null,
        row.authMessage ?? null,
        row.verifyUrl ?? null,
        row.label ?? null,
        row.notes ?? null,
        row.priority ?? 0,
        row.deletedAt ?? null,
        row.accountType ?? 'personal',
        row.avatarUrl ?? null,
      );
  }

  updatePlan(name: string, plan: string | null): void {
    this.db.prepare('UPDATE profiles SET plan = ? WHERE name = ?').run(plan, name);
  }

  updateAvatarUrl(name: string, avatarUrl: string | null): void {
    this.db.prepare('UPDATE profiles SET avatarUrl = ? WHERE name = ?').run(avatarUrl, name);
  }

  update(
    name: string,
    fields: Partial<Pick<ProfileRow, 'label' | 'notes' | 'priority' | 'enabled'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    values.push(name);
    this.db.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE name = ?`).run(...values);
  }

  updateAuthState(
    name: string,
    authState: ProfileAuthState | null,
    authMessage: string | null = null,
    verifyUrl: string | null = null,
  ): void {
    this.db
      .prepare('UPDATE profiles SET authState = ?, authMessage = ?, verifyUrl = ? WHERE name = ?')
      .run(authState, authMessage, verifyUrl, name);
  }

  softDelete(name: string): void {
    this.db.prepare('DELETE FROM quota_marks WHERE profileName = ?').run(name);
    this.db.prepare('DELETE FROM quota_usage WHERE profileName = ?').run(name);
    this.db.prepare("UPDATE profiles SET deletedAt = datetime('now'), enabled = 0 WHERE name = ?").run(name);
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM quota_marks WHERE profileName = ?').run(name);
    this.db.prepare('DELETE FROM quota_usage WHERE profileName = ?').run(name);
    this.db.prepare('DELETE FROM profiles WHERE name = ?').run(name);
  }

  rename(oldName: string, newName: string, newHome?: string): void {
    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.transaction(() => {
        if (newHome !== undefined) {
          this.db.prepare('UPDATE profiles SET name = ?, home = ? WHERE name = ?').run(newName, newHome, oldName);
        } else {
          this.db.prepare('UPDATE profiles SET name = ? WHERE name = ?').run(newName, oldName);
        }
        this.db.prepare('UPDATE quota_marks SET profileName = ? WHERE profileName = ?').run(newName, oldName);
        this.db.prepare('UPDATE quota_usage SET profileName = ? WHERE profileName = ?').run(newName, oldName);
        this.db.prepare('UPDATE runs SET profileName = ? WHERE profileName = ?').run(newName, oldName);
        this.db.prepare('UPDATE run_metrics SET profileName = ? WHERE profileName = ?').run(newName, oldName);
        this.db.prepare('UPDATE chat_sessions SET profileName = ? WHERE profileName = ?').run(newName, oldName);
      })();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  restore(name: string): void {
    this.db.prepare('UPDATE profiles SET deletedAt = NULL, enabled = 1 WHERE name = ?').run(name);
  }

  isDeleted(name: string): boolean {
    const row = this.db.prepare('SELECT deletedAt FROM profiles WHERE name = ?').get(name) as { deletedAt: string | null } | undefined;
    return !!row?.deletedAt;
  }

  updateEnabled(name: string, enabled: number): void {
    this.db.prepare('UPDATE profiles SET enabled = ? WHERE name = ?').run(enabled, name);
  }

  recordCrash(name: string, now: number, coolingUntil: number | null): number {
    this.db.prepare('UPDATE profiles SET consecutiveCrashes = consecutiveCrashes + 1, lastCrashAt = ?, coolingUntil = ? WHERE name = ?').run(now, coolingUntil, name);
    return (this.db.prepare('SELECT consecutiveCrashes FROM profiles WHERE name = ?').get(name) as { consecutiveCrashes: number } | undefined)?.consecutiveCrashes || 0;
  }

  resetCrashes(name: string): void {
    this.db.prepare('UPDATE profiles SET consecutiveCrashes = 0, lastCrashAt = NULL, coolingUntil = NULL WHERE name = ?').run(name);
  }

  getEnabled(): ProfileRow[] {
    return this.db
      .prepare('SELECT * FROM profiles WHERE enabled = 1 AND deletedAt IS NULL ORDER BY name')
      .all() as ProfileRow[];
  }

  hasMetaFlag(key: string): boolean {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value === 'true';
  }
}

export class QuotaMarkRepo {
  constructor(private db: Database.Database) {}

  getAll(): QuotaMarkRow[] {
    return this.db.prepare('SELECT * FROM quota_marks').all() as QuotaMarkRow[];
  }

  getActive(nowSeconds?: number): QuotaMarkRow[] {
    const now = nowSeconds !== undefined ? nowSeconds : Math.floor(Date.now() / 1000);
    return this.db
      .prepare('SELECT * FROM quota_marks WHERE until > ?')
      .all(now) as QuotaMarkRow[];
  }

  mark(profileName: string, family: string, until: number, reason?: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const previous = this.db
      .prepare('SELECT until FROM quota_marks WHERE profileName = ? AND family = ?')
      .get(profileName, family) as { until: number } | undefined;
    const shouldEmit = !previous || previous.until <= now || until - previous.until > 10 * 60;
    this.db
      .prepare(
        `INSERT INTO quota_marks (profileName, family, until, reason)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profileName, family) DO UPDATE SET until=excluded.until, reason=excluded.reason`,
      )
      .run(profileName, family, until, reason || null);
    return shouldEmit;
  }

  clear(profileName: string, family: string): void {
    this.db
      .prepare('DELETE FROM quota_marks WHERE profileName = ? AND family = ?')
      .run(profileName, family);
  }

  isExhausted(profileName: string, family: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare('SELECT 1 FROM quota_marks WHERE profileName = ? AND family = ? AND until > ?')
      .get(profileName, family, now);
    return !!row;
  }
}

export class QuotaUsageRepo {
  constructor(private db: Database.Database) {}

  getForProfile(profileName: string): QuotaUsageRow[] {
    return this.db.prepare('SELECT * FROM quota_usage WHERE profileName = ? ORDER BY grp, window')
      .all(profileName) as QuotaUsageRow[];
  }

  getAll(): QuotaUsageRow[] {
    return this.db.prepare('SELECT * FROM quota_usage ORDER BY profileName, grp, window')
      .all() as QuotaUsageRow[];
  }

  deleteForProfile(profileName: string): void {
    this.db.prepare('DELETE FROM quota_usage WHERE profileName = ?').run(profileName);
  }

  deleteForEngine(engine: string): void {
    this.db.prepare(`
      DELETE FROM quota_usage
      WHERE profileName IN (SELECT name FROM profiles WHERE engine = ?)
         OR profileName = ?
    `).run(engine, engine);
  }

  upsert(row: QuotaUsageRow): void {
    this.db.prepare(`
      INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profileName, grp, window) DO UPDATE SET
        remainingPct=excluded.remainingPct, resetAt=excluded.resetAt, fetchedAt=excluded.fetchedAt
    `).run(row.profileName, row.grp, row.window, row.remainingPct, row.resetAt, row.fetchedAt);
  }
}

export class TaskRepo {
  constructor(private db: Database.Database) {}

  getAll(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY createdAt').all() as TaskRow[];
  }

  list(filter?: { project?: string; status?: string }): TaskRow[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filter?.project) {
      conditions.push('projectId = ?');
      values.push(filter.project);
    }
    if (filter?.status) {
      conditions.push('status = ?');
      values.push(filter.status);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM tasks${where} ORDER BY createdAt`).all(...values) as TaskRow[];
  }

  page(filter?: { project?: string; status?: string; search?: string; limit?: string | number; cursor?: string; offset?: string | number; sort?: string; order?: string }): PageResult<TaskRow> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (filter?.project && filter.project !== 'all') { conditions.push('projectId = ?'); values.push(filter.project); }
    if (filter?.status && filter.status !== 'all') { conditions.push('status = ?'); values.push(filter.status); }
    if (filter?.search?.trim()) {
      const search = `%${filter.search.trim().replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push("(agenthub_normalize(slug) LIKE agenthub_normalize(?) ESCAPE '\\' OR agenthub_normalize(title) LIKE agenthub_normalize(?) ESCAPE '\\')");
      values.push(search, search);
    }
    const cursor = decodeCursor(filter?.cursor);
    if (filter?.cursor && !cursor) throw new Error('Invalid pagination cursor');
    const sortColumn = filter?.sort === 'updatedAt' ? 'updatedAt' : filter?.sort === 'title' ? 'title' : filter?.sort === 'slug' ? 'slug' : 'createdAt';
    const descending = filter?.order !== 'asc';
    const comparison = descending ? '<' : '>';
    if (cursor) {
      conditions.push(`(${sortColumn} ${comparison} ? OR (${sortColumn} = ? AND id ${comparison} ?))`);
      values.push(cursor.value, cursor.value, cursor.id);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countConditions = conditions.slice(0, cursor ? -1 : undefined);
    const countValues = values.slice(0, cursor ? -3 : undefined);
    const total = (this.db.prepare(`SELECT COUNT(*) as count FROM tasks${countConditions.length ? ` WHERE ${countConditions.join(' AND ')}` : ''}`).get(...countValues) as { count: number }).count;
    const limit = parsePageSize(filter?.limit);
    const offset = typeof filter?.offset === 'number' ? filter.offset : Number(filter?.offset || 0);
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const rows = this.db.prepare(`SELECT * FROM tasks${where} ORDER BY ${sortColumn} ${descending ? 'DESC' : 'ASC'}, id ${descending ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`).all(...values, limit + 1, safeOffset) as TaskRow[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor((last[sortColumn as keyof TaskRow] as string | number | null) ?? '', last.id) : null };
  }

  getByProject(projectId: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY createdAt')
      .all(projectId) as TaskRow[];
  }

  getByStatus(status: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY createdAt')
      .all(status) as TaskRow[];
  }

  getByBatch(batchId: string): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks WHERE batchId = ? ORDER BY createdAt').all(batchId) as TaskRow[];
  }

  get(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  resetRunLimits(id: string): void {
    this.db.prepare('UPDATE tasks SET runCount = 0, consecutiveCrashes = 0 WHERE id = ?').run(id);
  }

  getDerivedFrom(sourceTaskId: string): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks WHERE json_extract(sourceRef, '$.taskId') = ? ORDER BY createdAt").all(sourceTaskId) as TaskRow[];
  }

  insert(row: {
    id: string;
    projectId: string;
    slug: string;
    title: string;
    externalRef?: string | null;
    body?: string;
    level?: string;
    modelChain?: string;
    baseRef?: string;
    branch?: string;
    dependsOn?: string[];
    status?: string;
    waitReason?: WaitReason;
    worktreePath?: string | null;
    doneReport?: string | null;
    blockedReport?: string | null;
    diffStat?: string | null;
    sourceRef?: string | null;
    batchId?: string | null;
    creationSessionId?: string | null;
    creationGoal?: string | null;
    skipDeps?: boolean;
  }): void {
    const deps = JSON.stringify(row.dependsOn || []);
    this.db
      .prepare(
        `INSERT INTO tasks (id, projectId, slug, title, externalRef, body, level, modelChain, baseRef, branch, dependsOn, status, waitReason, worktreePath, doneReport, blockedReport, diffStat, sourceRef, batchId, creationSessionId, creationGoal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.slug,
        row.title,
        row.externalRef || null,
        row.body || null,
        row.level || 'easy',
        row.modelChain || null,
        row.baseRef || null,
        row.branch || null,
        deps,
        row.status || 'draft',
        row.waitReason || null,
        row.worktreePath || null,
        row.doneReport || null,
        row.blockedReport || null,
        row.diffStat || null,
        row.sourceRef || null,
        row.batchId || null,
        row.creationSessionId || null,
        row.creationGoal || null,
      );

    // Populate task_deps
    if (!row.skipDeps && row.dependsOn && row.dependsOn.length > 0) {
      const stmt = this.db.prepare('INSERT INTO task_deps (taskId, dependsOnId) VALUES (?, ?)');
      for (const dep of row.dependsOn) {
        stmt.run(row.id, dep);
      }
    }
  }

  populateDeps(taskId: string, dependsOn: string[]): void {
    if (!dependsOn || dependsOn.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO task_deps (taskId, dependsOnId) VALUES (?, ?)');
    for (const dep of dependsOn) {
      stmt.run(taskId, dep);
    }
  }

  updateStatus(id: string, status: string, waitReason: WaitReason = null): void {
    if (status === 'waiting_quota' || (status === 'queued' && waitReason !== null)) {
      this.db
        .prepare("UPDATE tasks SET status = ?, waitReason = ?, updatedAt = datetime('now') WHERE id = ?")
        .run(status, waitReason, id);
    } else {
      this.db
        .prepare("UPDATE tasks SET status = ?, waitReason = NULL, updatedAt = datetime('now') WHERE id = ?")
        .run(status, id);
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM task_deps WHERE taskId = ? OR dependsOnId = ?').run(id, id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    this.db.prepare("DELETE FROM meta WHERE key LIKE 'notified:%:' || ?").run(id);
  }

  isNotificationSent(channel: string, type: string, taskId: string): boolean {
    const key = `notified:${channel}:${type}:${taskId}`;
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row?.value === '1';
  }

  markNotificationSent(channel: string, type: string, taskId: string): void {
    const key = `notified:${channel}:${type}:${taskId}`;
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')").run(key);
  }

  setBatchId(id: string, batchId: string | null): void {
    this.db.prepare("UPDATE tasks SET batchId = ?, updatedAt = datetime('now') WHERE id = ?").run(batchId, id);
  }

  update(
    id: string,
    fields: Partial<Pick<TaskRow, 'status' | 'waitReason' | 'worktreePath' | 'attempt' | 'resume' | 'branch' | 'baseRef' | 'body' | 'notBefore' | 'transientRetries' | 'runCount' | 'consecutiveCrashes' | 'checkFixAttempts' | 'slot' | 'reviewerChangesRequested' | 'reviewerEscalated' | 'reviewerEscalatedAt' | 'reviewerEscalationReason' | 'reviewStep' | 'doneReport' | 'blockedReport' | 'diffStat' | 'title' | 'externalRef' | 'level' | 'modelChain' | 'dependsOn' | 'batchId'>>,
  ): void {
    const sets: string[] = ["updatedAt = datetime('now')"];
    const values: unknown[] = [];
    const fieldsToApply = { ...fields };
    if ('status' in fieldsToApply && fieldsToApply.status !== 'waiting_quota' && fieldsToApply.waitReason === undefined) {
      fieldsToApply.waitReason = null;
    }
    for (const [key, value] of Object.entries(fieldsToApply)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    if ('dependsOn' in fields && fields.dependsOn !== undefined) {
      this.db.prepare('DELETE FROM task_deps WHERE taskId = ?').run(id);
      try {
        const deps = JSON.parse(fields.dependsOn);
        if (Array.isArray(deps) && deps.length > 0) {
          const stmt = this.db.prepare('INSERT INTO task_deps (taskId, dependsOnId) VALUES (?, ?)');
          for (const dep of deps) {
            stmt.run(id, dep);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  getUsedSlots(projectId: string): number[] {
    const rows = this.db
      .prepare("SELECT slot FROM tasks WHERE projectId = ? AND slot IS NOT NULL AND status NOT IN ('done', 'cancelled')")
      .all(projectId) as Array<{ slot: number }>;
    return rows.map((row) => row.slot);
  }
}

export class TaskBatchRepo {
  constructor(private db: Database.Database) {}

  create(row: {
    id: string;
    projectId: string;
    title: string;
    goal?: string | null;
    status?: BatchStatus;
    createdBy?: string | null;
  }): void {
    this.db
      .prepare(
        'INSERT INTO task_batches (id, projectId, title, goal, status, createdBy) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.projectId,
        row.title,
        row.goal || null,
        row.status || 'draft',
        row.createdBy || null,
      );
  }

  get(id: string): TaskBatchRow | undefined {
    return this.db.prepare('SELECT * FROM task_batches WHERE id = ?').get(id) as TaskBatchRow | undefined;
  }

  list(projectId?: string, status?: string): TaskBatchRow[] {
    let query = 'SELECT * FROM task_batches';
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (projectId && projectId !== 'all') {
      conditions.push('projectId = ?');
      params.push(projectId);
    }
    if (status && status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY createdAt DESC';
    return this.db.prepare(query).all(...params) as TaskBatchRow[];
  }

  page(options?: { project?: string; status?: string; limit?: string | number; cursor?: string; offset?: string | number }): PageResult<TaskBatchRow> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options?.project && options.project !== 'all') { conditions.push('projectId = ?'); values.push(options.project); }
    if (options?.status && options.status !== 'all') { conditions.push('status = ?'); values.push(options.status); }
    const cursor = decodeCursor(options?.cursor);
    if (options?.cursor && !cursor) throw new Error('Invalid pagination cursor');
    if (cursor) { conditions.push('(createdAt < ? OR (createdAt = ? AND id < ?))'); values.push(cursor.value, cursor.value, cursor.id); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countConditions = cursor ? conditions.slice(0, -1) : conditions;
    const countValues = cursor ? values.slice(0, -3) : values;
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM task_batches${countConditions.length ? ` WHERE ${countConditions.join(' AND ')}` : ''}`).get(...countValues) as { count: number }).count;
    const limit = parsePageSize(options?.limit);
    const offset = Number.isFinite(Number(options?.offset)) && Number(options?.offset) > 0 ? Math.floor(Number(options?.offset)) : 0;
    const rows = this.db.prepare(`SELECT * FROM task_batches${where} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit + 1, offset) as TaskBatchRow[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  updateStatus(id: string, status: BatchStatus): void {
    this.db.prepare('UPDATE task_batches SET status = ? WHERE id = ?').run(status, id);
  }

  update(
    id: string,
    fields: Partial<{ title: string; goal: string | null; status: BatchStatus }>,
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) {
      sets.push('title = ?');
      params.push(fields.title);
    }
    if (fields.goal !== undefined) {
      sets.push('goal = ?');
      params.push(fields.goal);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE task_batches SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM task_batches WHERE id = ?').run(id);
  }
}

export class RunRepo {
  constructor(private db: Database.Database) {}

  getAll(): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY startedAt').all() as RunRow[];
  }

  getByTask(taskId: string): RunRow[] {
    return this.db
      // startedAt used to be second-precision for older rows. Keep rowid as a
      // deterministic tiebreaker so a newer worker inserted in the same
      // second cannot be mistaken for the previous completion.
      .prepare('SELECT * FROM runs WHERE taskId = ? ORDER BY startedAt, rowid')
      .all(taskId) as RunRow[];
  }

  pageByTask(taskId: string, limit: string | number | undefined, cursor?: string, offset: string | number | undefined = 0): PageResult<RunRow> {
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('Invalid pagination cursor');
    const pageSize = parsePageSize(limit);
    const values: unknown[] = [taskId];
    const where = decoded
      ? ' WHERE taskId = ? AND (startedAt < ? OR (startedAt = ? AND id < ?))'
      : ' WHERE taskId = ?';
    if (decoded) values.push(decoded.value, decoded.value, decoded.id);
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM runs WHERE taskId = ?').get(taskId) as { count: number }).count;
    const safeOffset = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
    const rows = this.db.prepare(`SELECT * FROM runs${where} ORDER BY startedAt DESC, id DESC LIMIT ? OFFSET ?`).all(...values, pageSize + 1, safeOffset) as RunRow[];
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor(last.startedAt, last.id) : null };
  }

  getRunning(): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE outcome IS NULL')
      .all() as RunRow[];
  }

  getShutdownRuns(): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE outcome = 'crashed' AND reason = 'daemon_shutdown'")
      .all() as RunRow[];
  }

  get(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  insert(row: {
    id: string;
    taskId: string;
    engine: string;
    model: string;
    profileName: string;
    pid?: number;
    logPath?: string;
    pidStart?: number;
    startedAt?: string;
    kind?: 'worker' | 'reviewer';
  }): void {
    this.db
      .prepare(
        'INSERT INTO runs (id, taskId, engine, model, profileName, pid, startedAt, logPath, pidStart, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.taskId, row.engine, row.model, row.profileName, row.pid || null, row.startedAt || new Date().toISOString(), row.logPath || null, row.pidStart || null, row.kind || 'worker');
  }

  finish(id: string, outcome: string, resetAt?: number, reason?: string): void {
    this.db
      .prepare("UPDATE runs SET outcome = ?, endedAt = datetime('now'), resetAt = ?, reason = ? WHERE id = ?")
      .run(outcome, resetAt || null, reason || null, id);
  }

  updatePid(id: string, pid: number, pidStart?: number | null): void {
    this.db.prepare('UPDATE runs SET pid = ?, pidStart = ? WHERE id = ?').run(pid, pidStart || null, id);
  }
}

export class EventRepo {
  constructor(private db: Database.Database) {}

  insert(type: string, taskId?: string, payload?: unknown): number {
    const result = this.db
      .prepare('INSERT INTO events (type, taskId, payload) VALUES (?, ?, ?)')
      .run(type, taskId || null, payload ? JSON.stringify(payload) : null);
    return result.lastInsertRowid as number;
  }

  getRecent(limit = 50): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as EventRow[];
  }

  getSince(afterId: number): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id')
      .all(afterId) as EventRow[];
  }

  getByTask(taskId: string): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE taskId = ? ORDER BY id')
      .all(taskId) as EventRow[];
  }

  hasTimesheetPosted(sourceId: string, date: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM events
      WHERE type = 'tracker.timesheet.posted'
        AND json_extract(payload, '$.sourceId') = ?
        AND json_extract(payload, '$.date') = ?
      LIMIT 1`).get(sourceId, date));
  }

  page(options?: { taskId?: string; limit?: string | number; cursor?: string; offset?: string | number }): PageResult<EventRow> {
    const decoded = decodeCursor(options?.cursor);
    if (options?.cursor && !decoded) throw new Error('Invalid pagination cursor');
    const pageSize = parsePageSize(options?.limit);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options?.taskId) { conditions.push('taskId = ?'); values.push(options.taskId); }
    if (decoded) { conditions.push('id < ?'); values.push(Number(decoded.value)); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countConditions = options?.taskId ? ' WHERE taskId = ?' : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM events${countConditions}`).get(...(options?.taskId ? [options.taskId] : [])) as { count: number }).count;
    const offset = decoded ? 0 : Math.max(0, Math.floor(Number(options?.offset) || 0));
    const rows = this.db.prepare(`SELECT * FROM events${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...values, pageSize + 1, offset) as EventRow[];
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor(last.id, String(last.id)) : null };
  }
}

export interface ReviewRow {
  id: string;
  taskId: string;
  verdict: string;
  feedback: string | null;
  createdAt: string;
  actor: string;
}

export class ReviewRepo {
  constructor(private db: Database.Database) {}

  getAll(): ReviewRow[] {
    return this.db.prepare('SELECT * FROM reviews ORDER BY createdAt').all() as ReviewRow[];
  }

  getByTask(taskId: string): ReviewRow[] {
    return this.db
      .prepare('SELECT * FROM reviews WHERE taskId = ? ORDER BY createdAt')
      .all(taskId) as ReviewRow[];
  }

  insert(row: { id: string; taskId: string; verdict: string; feedback?: string | null; actor?: string }): void {
    this.db
      .prepare(
        'INSERT INTO reviews (id, taskId, verdict, feedback, actor) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, row.taskId, row.verdict, row.feedback || null, row.actor || 'claude');
  }
}

export interface ChatSessionRow {
  id: string;
  projectId: string | null;
  claudeSessionId: string | null;
  title: string | null;
  mode: 'safe' | 'full';
  model: string;
  profileName: string | null;
  busy: number;
  state: 'idle' | 'running' | 'waiting_permission' | 'waiting_limit' | 'error';
  waitingLimitResetAt?: number | null;
  pinned: number;
  archived: number;
  lastMessageAt: string | null;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  createdAt: string;
  updatedAt: string;
  kind: 'chat' | 'brain' | 'assistant' | 'setup';
}

export interface ChatRetryRow {
  sessionId: string;
  messageId: string;
  text: string;
  resetAt: number;
  attempts: number;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRow {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'error' | 'system';
  content: string;
  meta: string | null;
  createdAt: string;
}

export class ChatSessionRepo {
  constructor(private db: Database.Database) {}

  private normalizeAssistantSession(session: ChatSessionRow): ChatSessionRow {
    const isAssistantId = session.id === 'assistant' || session.id.startsWith('assistant:');
    if (!isAssistantId) return session;
    const projectId = session.id === 'assistant' || session.id === 'assistant:global'
      ? null
      : session.id.slice('assistant:'.length);
    if (session.kind === 'assistant' && session.projectId === projectId) return session;
    if (!this.db.open) return session;
    try {
      this.db.prepare("UPDATE chat_sessions SET kind = 'assistant', projectId = ?, updatedAt = datetime('now') WHERE id = ?")
        .run(projectId, session.id);
      return this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(session.id) as ChatSessionRow;
    } catch {
      // Keep the assistant kind even if an old database references a project
      // that has since been removed and the foreign-key update cannot apply.
      this.db.prepare("UPDATE chat_sessions SET kind = 'assistant', updatedAt = datetime('now') WHERE id = ?").run(session.id);
      return this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(session.id) as ChatSessionRow;
    }
  }

  getAll(options?: { archived?: number | null }): ChatSessionRow[] {
    const archived = options?.archived !== undefined ? options.archived : 0;
    if (archived === null) {
      return this.db
        .prepare('SELECT * FROM chat_sessions ORDER BY pinned DESC, updatedAt DESC, createdAt DESC')
        .all().map((session) => this.normalizeAssistantSession(session as ChatSessionRow));
    }
    return this.db
      .prepare('SELECT * FROM chat_sessions WHERE archived = ? ORDER BY pinned DESC, updatedAt DESC, createdAt DESC')
      .all(archived).map((session) => this.normalizeAssistantSession(session as ChatSessionRow));
  }

  search(query: string, options?: { archived?: number | null }): ChatSessionRow[] {
    const trimmed = query.trim();
    const archived = options?.archived !== undefined ? options.archived : 0;
    if (!trimmed) {
      return this.getAll(options);
    }
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    if (archived === null) {
      return this.db
        .prepare(
          `SELECT DISTINCT s.* FROM chat_sessions s
           LEFT JOIN chat_messages m ON m.sessionId = s.id
           WHERE (s.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
           ORDER BY s.pinned DESC, s.updatedAt DESC, s.createdAt DESC`
        )
        .all(pattern, pattern).map((session) => this.normalizeAssistantSession(session as ChatSessionRow));
    }
    return this.db
      .prepare(
        `SELECT DISTINCT s.* FROM chat_sessions s
         LEFT JOIN chat_messages m ON m.sessionId = s.id
         WHERE s.archived = ? AND (s.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
         ORDER BY s.pinned DESC, s.updatedAt DESC, s.createdAt DESC`
      )
      .all(archived, pattern, pattern).map((session) => this.normalizeAssistantSession(session as ChatSessionRow));
  }

  page(options?: {
    search?: string;
    archived?: number | null;
    limit?: string | number;
    cursor?: string;
  }): PageResult<ChatSessionRow> {
    const archived = options?.archived !== undefined ? options.archived : 0;
    const search = options?.search?.trim();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (archived !== null) {
      conditions.push('s.archived = ?');
      values.push(archived);
    }
    if (search) {
      const escaped = search.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const pattern = `%${escaped}%`;
      conditions.push("(s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.sessionId = s.id AND m.content LIKE ? ESCAPE '\\'))");
      values.push(pattern, pattern);
    }
    const cursor = decodeCursor(options?.cursor);
    if (options?.cursor && !cursor) throw new Error('Invalid pagination cursor');
    if (cursor) {
      conditions.push('(s.updatedAt < ? OR (s.updatedAt = ? AND s.id < ?))');
      values.push(cursor.value, cursor.value, cursor.id);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const countConditions = cursor ? conditions.slice(0, -1) : conditions;
    const countValues = cursor ? values.slice(0, -3) : values;
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM chat_sessions s${countConditions.length ? ` WHERE ${countConditions.join(' AND ')}` : ''}`).get(...countValues) as { count: number }).count;
    const limit = parsePageSize(options?.limit);
    const rows = this.db.prepare(`SELECT s.* FROM chat_sessions s${where} ORDER BY s.updatedAt DESC, s.id DESC LIMIT ?`).all(...values, limit + 1) as ChatSessionRow[];
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((session) => this.normalizeAssistantSession(session));
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor(last.updatedAt, last.id) : null };
  }

  get(id: string): ChatSessionRow | undefined {
    if (!this.db.open) return undefined;
    const session = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSessionRow | undefined;
    return session ? this.normalizeAssistantSession(session) : undefined;
  }

  insert(row: {
    id: string;
    projectId?: string | null;
    claudeSessionId?: string | null;
    title?: string | null;
    mode?: 'safe' | 'full';
    model?: string;
    profileName?: string | null;
    busy?: number;
    state?: ChatSessionRow['state'];
    pinned?: number;
    archived?: number;
    lastMessageAt?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    kind?: 'chat' | 'brain' | 'assistant' | 'setup';
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, projectId, claudeSessionId, title, mode, busy, model, profileName, state, pinned, archived, lastMessageAt, inputTokens, outputTokens, contextTokens, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.projectId || null,
        row.claudeSessionId || null,
        row.title || null,
        row.mode || 'safe',
        row.busy ?? 0,
        row.model || '',
        row.profileName || null,
        row.state || 'idle',
        row.pinned ?? 0,
        row.archived ?? 0,
        row.lastMessageAt || null,
        row.inputTokens ?? 0,
        row.outputTokens ?? 0,
        row.contextTokens ?? 0,
        row.kind || 'chat',
      );
  }

  getByKind(kind: 'chat' | 'brain' | 'assistant' | 'setup', projectId?: string | null): ChatSessionRow | undefined {
    if (kind === 'assistant') {
      const id = projectId ? `assistant:${projectId}` : 'assistant';
      const session = this.get(id);
      if (session?.kind === 'assistant') return session;
    }
    if (projectId === undefined) {
      const session = this.db.prepare('SELECT * FROM chat_sessions WHERE kind = ? ORDER BY createdAt LIMIT 1').get(kind) as ChatSessionRow | undefined;
      return session ? this.normalizeAssistantSession(session) : undefined;
    }
    const session = this.db.prepare('SELECT * FROM chat_sessions WHERE kind = ? AND projectId IS ? ORDER BY createdAt LIMIT 1').get(kind, projectId) as ChatSessionRow | undefined;
    return session ? this.normalizeAssistantSession(session) : undefined;
  }

  updateKind(id: string, kind: 'chat' | 'brain' | 'assistant' | 'setup'): void {
    this.db.prepare("UPDATE chat_sessions SET kind = ?, updatedAt = datetime('now') WHERE id = ?").run(kind, id);
  }

  updateProfileName(id: string, profileName: string | null): void {
    this.db.prepare("UPDATE chat_sessions SET profileName = ?, updatedAt = datetime('now') WHERE id = ?").run(profileName, id);
  }

  updateModel(id: string, model: string): void {
    this.db.prepare("UPDATE chat_sessions SET model = ?, updatedAt = datetime('now') WHERE id = ?").run(model, id);
  }

  updateMode(id: string, mode: 'safe' | 'full'): void {
    this.db.prepare("UPDATE chat_sessions SET mode = ?, updatedAt = datetime('now') WHERE id = ?").run(mode, id);
  }

  updateTitle(id: string, title: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET title = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(title, id);
  }

  updatePinned(id: string, pinned: number): void {
    this.db
      .prepare("UPDATE chat_sessions SET pinned = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(pinned ? 1 : 0, id);
  }

  updateArchived(id: string, archived: number): void {
    this.db
      .prepare("UPDATE chat_sessions SET archived = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(archived ? 1 : 0, id);
  }

  touchLastMessage(id: string, timestamp?: string): void {
    this.db
      .prepare(
        "UPDATE chat_sessions SET lastMessageAt = COALESCE(?, datetime('now')), updatedAt = datetime('now') WHERE id = ?"
      )
      .run(timestamp || null, id);
  }

  addUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number; contextTokens?: number },
  ): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET inputTokens = inputTokens + ?,
             outputTokens = outputTokens + ?,
             contextTokens = COALESCE(?, contextTokens),
             lastMessageAt = datetime('now'),
             updatedAt = datetime('now')
         WHERE id = ?`
      )
      .run(usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.contextTokens ?? null, id);
  }

  updateClaudeSessionId(id: string, claudeSessionId: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET claudeSessionId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(claudeSessionId, id);
  }

  setBusy(id: string, busy: number): void {
    this.db
      .prepare("UPDATE chat_sessions SET busy = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(busy, id);
  }

  updateState(id: string, state: ChatSessionRow['state']): void {
    this.db.prepare("UPDATE chat_sessions SET state = ?, updatedAt = datetime('now') WHERE id = ?").run(state, id);
  }

  clearClaudeSessionId(id: string): void {
    this.db.prepare("UPDATE chat_sessions SET claudeSessionId = NULL, updatedAt = datetime('now') WHERE id = ?").run(id);
  }

  touchUpdatedAt(id: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET updatedAt = datetime('now') WHERE id = ?")
      .run(id);
  }

  resetAllBusy(): void {
    this.db.prepare("UPDATE chat_sessions SET busy = 0, state = 'idle' WHERE (busy != 0 OR state != 'idle') AND state != 'waiting_limit'").run();
  }

  setWaitingLimit(id: string, resetAt: number | null): void {
    this.db.prepare("UPDATE chat_sessions SET waitingLimitResetAt = ?, busy = 0, state = 'waiting_limit', updatedAt = datetime('now') WHERE id = ?").run(resetAt, id);
  }

  clearWaitingLimit(id: string): void {
    this.db.prepare("UPDATE chat_sessions SET waitingLimitResetAt = NULL, state = 'idle', updatedAt = datetime('now') WHERE id = ?").run(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_messages WHERE sessionId = ?').run(id);
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  }
}

export interface BrainDirectiveRow {
  id: string;
  projectId: string | null;
  text: string;
  createdAt: string;
  createdBy: string;
  active: number;
}

export class BrainDirectiveRepo {
  constructor(private db: Database.Database) {}

  add(row: { id: string; projectId?: string | null; text: string; createdBy: string }): BrainDirectiveRow {
    this.db.prepare('INSERT INTO brain_directives (id, projectId, text, createdBy, active) VALUES (?, ?, ?, ?, 1)')
      .run(row.id, row.projectId || null, row.text, row.createdBy);
    return this.get(row.id)!;
  }

  list(projectId?: string | null, includeGlobal = true): BrainDirectiveRow[] {
    if (projectId == null) {
      return this.db.prepare('SELECT * FROM brain_directives WHERE active = 1 AND projectId IS NULL ORDER BY createdAt, id').all() as BrainDirectiveRow[];
    }
    return this.db.prepare(
      `SELECT * FROM brain_directives
       WHERE active = 1 AND (projectId = ? OR (projectId IS NULL AND ? = 1))
       ORDER BY createdAt, id`,
    ).all(projectId, includeGlobal ? 1 : 0) as BrainDirectiveRow[];
  }

  get(id: string): BrainDirectiveRow | undefined {
    return this.db.prepare('SELECT * FROM brain_directives WHERE id = ?').get(id) as BrainDirectiveRow | undefined;
  }

  remove(id: string): boolean {
    return this.db.prepare('UPDATE brain_directives SET active = 0 WHERE id = ? AND active = 1').run(id).changes > 0;
  }
}

export interface BrainTurnRow {
  id: string;
  trigger: string;
  input: string;
  summary: string | null;
  status: 'running' | 'done' | 'quota' | 'failed' | 'limited';
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  projectId: string | null;
  departmentId: string | null;
}

export class BrainTurnRepo {
  constructor(private db: Database.Database) {}

  insert(row: { id: string; trigger: string; input: string; projectId?: string | null; departmentId?: string | null; status?: BrainTurnRow['status'] }): BrainTurnRow {
    this.db.prepare('INSERT INTO brain_turns (id, trigger, input, projectId, departmentId, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.trigger, row.input, row.projectId || null, row.departmentId || null, row.status || 'running');
    return this.get(row.id)!;
  }

  get(id: string): BrainTurnRow | undefined {
    return this.db.prepare('SELECT * FROM brain_turns WHERE id = ?').get(id) as BrainTurnRow | undefined;
  }

  latest(projectId?: string | null): BrainTurnRow | undefined {
    const query = projectId === undefined
      ? 'SELECT * FROM brain_turns ORDER BY startedAt DESC LIMIT 1'
      : 'SELECT * FROM brain_turns WHERE projectId IS ? ORDER BY startedAt DESC LIMIT 1';
    return (projectId === undefined ? this.db.prepare(query).get() : this.db.prepare(query).get(projectId)) as BrainTurnRow | undefined;
  }

  latestDepartment(departmentId: string): BrainTurnRow | undefined {
    return this.db.prepare('SELECT * FROM brain_turns WHERE departmentId = ? ORDER BY startedAt DESC LIMIT 1')
      .get(departmentId) as BrainTurnRow | undefined;
  }

  finish(id: string, fields: { status: Exclude<BrainTurnRow['status'], 'running'>; summary?: string; inputTokens?: number; outputTokens?: number; error?: string }): void {
    this.db.prepare(`UPDATE brain_turns SET status = ?, summary = ?, inputTokens = ?, outputTokens = ?, error = ?, finishedAt = datetime('now') WHERE id = ?`)
      .run(fields.status, fields.summary || null, fields.inputTokens || 0, fields.outputTokens || 0, fields.error || null, id);
  }

  countSince(epochMs: number, projectId?: string | null): number {
    const query = projectId === undefined
      ? "SELECT COUNT(*) AS count FROM brain_turns WHERE startedAt >= datetime(?, 'unixepoch')"
      : "SELECT COUNT(*) AS count FROM brain_turns WHERE startedAt >= datetime(?, 'unixepoch') AND projectId IS ?";
    const row = projectId === undefined
      ? this.db.prepare(query).get(Math.floor(epochMs / 1000))
      : this.db.prepare(query).get(Math.floor(epochMs / 1000), projectId);
    return (row as { count: number }).count;
  }

  tokensSince(isoDate: string, projectId?: string | null): number {
    const query = projectId === undefined
      ? 'SELECT COALESCE(SUM(inputTokens + outputTokens), 0) AS total FROM brain_turns WHERE startedAt >= ?'
      : 'SELECT COALESCE(SUM(inputTokens + outputTokens), 0) AS total FROM brain_turns WHERE startedAt >= ? AND projectId IS ?';
    const row = projectId === undefined
      ? this.db.prepare(query).get(isoDate)
      : this.db.prepare(query).get(isoDate, projectId);
    return (row as { total: number }).total;
  }

  tokensBreakdownSince(isoDate: string, projectId?: string | null): { inputTokens: number; outputTokens: number; total: number; count: number } {
    const query = projectId === undefined
      ? 'SELECT COALESCE(SUM(inputTokens), 0) AS inputTokens, COALESCE(SUM(outputTokens), 0) AS outputTokens, COUNT(*) AS count FROM brain_turns WHERE startedAt >= ?'
      : 'SELECT COALESCE(SUM(inputTokens), 0) AS inputTokens, COALESCE(SUM(outputTokens), 0) AS outputTokens, COUNT(*) AS count FROM brain_turns WHERE startedAt >= ? AND projectId IS ?';
    const row = (projectId === undefined ? this.db.prepare(query).get(isoDate) : this.db.prepare(query).get(isoDate, projectId)) as { inputTokens: number; outputTokens: number; count: number };
    return {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      total: row.inputTokens + row.outputTokens,
      count: row.count,
    };
  }

  countSinceDepartment(epochMs: number, departmentId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM brain_turns WHERE startedAt >= datetime(?, 'unixepoch') AND departmentId = ?")
      .get(Math.floor(epochMs / 1000), departmentId) as { count: number };
    return row.count;
  }

  tokensSinceDepartment(isoDate: string, departmentId: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(inputTokens + outputTokens), 0) AS total FROM brain_turns WHERE startedAt >= ? AND departmentId = ?')
      .get(isoDate, departmentId) as { total: number };
    return row.total;
  }

  tokensBreakdownSinceDepartment(isoDate: string, departmentId: string): { inputTokens: number; outputTokens: number; total: number; count: number } {
    const row = this.db.prepare('SELECT COALESCE(SUM(inputTokens), 0) AS inputTokens, COALESCE(SUM(outputTokens), 0) AS outputTokens, COUNT(*) AS count FROM brain_turns WHERE startedAt >= ? AND departmentId = ?')
      .get(isoDate, departmentId) as { inputTokens: number; outputTokens: number; count: number };
    return {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      total: row.inputTokens + row.outputTokens,
      count: row.count,
    };
  }
}

export class ChatRetryRepo {
  constructor(private db: Database.Database) {}

  getPending(): ChatRetryRow[] {
    return this.db.prepare("SELECT * FROM chat_retries WHERE status = 'pending' ORDER BY resetAt, createdAt").all() as ChatRetryRow[];
  }

  get(messageId: string): ChatRetryRow | undefined {
    return this.db.prepare('SELECT * FROM chat_retries WHERE messageId = ?').get(messageId) as ChatRetryRow | undefined;
  }

  insert(row: Pick<ChatRetryRow, 'sessionId' | 'messageId' | 'text' | 'resetAt'>): void {
    this.db.prepare(`INSERT INTO chat_retries (sessionId,messageId,text,resetAt,attempts,status) VALUES (?,?,?,?,0,'pending') ON CONFLICT(messageId) DO UPDATE SET text=excluded.text,resetAt=excluded.resetAt,status='pending',updatedAt=datetime('now')`).run(row.sessionId, row.messageId, row.text, row.resetAt);
  }

  markSent(messageId: string): void { this.db.prepare("UPDATE chat_retries SET status='sent', updatedAt=datetime('now') WHERE messageId=?").run(messageId); }
  markCancelled(messageId: string): void { this.db.prepare("UPDATE chat_retries SET status='cancelled', updatedAt=datetime('now') WHERE messageId=?").run(messageId); }
  markFailed(messageId: string): void { this.db.prepare("UPDATE chat_retries SET status='failed', updatedAt=datetime('now') WHERE messageId=?").run(messageId); }
  defer(messageId: string, resetAt: number): void { this.db.prepare("UPDATE chat_retries SET attempts=attempts+1, resetAt=?, status='pending', updatedAt=datetime('now') WHERE messageId=?").run(resetAt, messageId); }
}

export interface ChatPermissionRow {
  id: string;
  sessionId: string;
  messageId: string | null;
  toolName: string;
  input: string;
  status: 'pending' | 'allow' | 'deny' | 'allow_always';
  message: string | null;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export class ChatPermissionRepo {
  constructor(private db: Database.Database) {}

  insert(row: { id: string; sessionId: string; messageId?: string | null; toolName: string; input: string; status?: ChatPermissionRow['status'] }): ChatPermissionRow {
    this.db.prepare('INSERT INTO chat_permissions (id, sessionId, messageId, toolName, input, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.sessionId, row.messageId || null, row.toolName, row.input, row.status || 'pending');
    return this.get(row.id)!;
  }

  get(id: string): ChatPermissionRow | undefined {
    return this.db.prepare('SELECT * FROM chat_permissions WHERE id = ?').get(id) as ChatPermissionRow | undefined;
  }

  listPending(sessionId?: string): ChatPermissionRow[] {
    return (sessionId
      ? this.db.prepare("SELECT * FROM chat_permissions WHERE sessionId = ? AND status = 'pending' ORDER BY createdAt").all(sessionId)
      : this.db.prepare("SELECT * FROM chat_permissions WHERE status = 'pending' ORDER BY createdAt").all()) as ChatPermissionRow[];
  }

  listAlways(sessionId: string, toolName: string): ChatPermissionRow[] {
    return this.db.prepare("SELECT * FROM chat_permissions WHERE sessionId = ? AND toolName = ? AND status = 'allow_always'").all(sessionId, toolName) as ChatPermissionRow[];
  }

  expirePending(message = 'AgentHub khởi động lại'): number {
    const result = this.db.prepare("UPDATE chat_permissions SET status = 'deny', message = ?, resolvedAt = datetime('now') WHERE status = 'pending'").run(message);
    return result.changes;
  }

  getLatest(sessionId: string, messageId: string | null | undefined, toolName: string): ChatPermissionRow | undefined {
    return this.db.prepare('SELECT * FROM chat_permissions WHERE sessionId = ? AND messageId IS ? AND toolName = ? ORDER BY createdAt DESC LIMIT 1')
      .get(sessionId, messageId || null, toolName) as ChatPermissionRow | undefined;
  }

  resolve(id: string, status: Exclude<ChatPermissionRow['status'], 'pending'>, message: string | null, reason?: string): ChatPermissionRow | undefined {
    this.db.prepare("UPDATE chat_permissions SET status = ?, message = ?, reason = ?, resolvedAt = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(status, message, reason || null, id);
    return this.get(id);
  }
}

export interface PermissionRuleRow {
  id: string;
  scope: 'session' | 'project' | 'global';
  sessionId: string | null;
  projectId: string | null;
  toolName: string;
  pattern: string;
  createdAt: string;
  createdBy: string;
}

export class PermissionRuleRepo {
  constructor(private db: Database.Database) {}

  list(options?: { sessionId?: string; projectId?: string; toolName?: string }): PermissionRuleRow[] {
    const scopes: string[] = [];
    const values: unknown[] = [];
    if (options?.sessionId) { scopes.push('(scope = \'session\' AND sessionId = ?)'); values.push(options.sessionId); }
    if (options?.projectId) { scopes.push('(scope = \'project\' AND projectId = ?)'); values.push(options.projectId); }
    if (options?.sessionId || options?.projectId) scopes.push("scope = 'global'");
    if (options?.toolName) values.push(options.toolName);
    const where = scopes.length ? ` WHERE (${scopes.join(' OR ')})${options?.toolName ? ' AND toolName = ?' : ''}` : options?.toolName ? ' WHERE toolName = ?' : '';
    return this.db.prepare(`SELECT * FROM permission_rules${where} ORDER BY createdAt, id`).all(...values) as PermissionRuleRow[];
  }

  listAll(): PermissionRuleRow[] {
    return this.db.prepare('SELECT * FROM permission_rules ORDER BY createdAt, id').all() as PermissionRuleRow[];
  }

  page(limit: string | number | undefined, cursor?: string): PageResult<PermissionRuleRow> {
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('Invalid pagination cursor');
    const pageSize = parsePageSize(limit);
    const values: unknown[] = [];
    const where = decoded ? ' WHERE (createdAt < ? OR (createdAt = ? AND id < ?))' : '';
    if (decoded) values.push(decoded.value, decoded.value, decoded.id);
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM permission_rules').get() as { count: number }).count;
    const rows = this.db.prepare(`SELECT * FROM permission_rules${where} ORDER BY createdAt DESC, id DESC LIMIT ?`).all(...values, pageSize + 1) as PermissionRuleRow[];
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
  }

  insert(row: Omit<PermissionRuleRow, 'createdAt'>): PermissionRuleRow {
    this.db.prepare('INSERT INTO permission_rules (id, scope, sessionId, projectId, toolName, pattern, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.scope, row.sessionId, row.projectId, row.toolName, row.pattern, row.createdBy);
    return this.db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(row.id) as PermissionRuleRow;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id).changes > 0;
  }
}

export class ChatMessageRepo {
  constructor(private db: Database.Database) {}

  getBySession(sessionId: string, limit = 200): ChatMessageRow[] {
    return this.db
      .prepare('SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY createdAt ASC, rowid ASC LIMIT ?')
      .all(sessionId, limit) as ChatMessageRow[];
  }

  getPaginated(
    sessionId: string,
    before?: string,
    limit = 50,
  ): { messages: ChatMessageRow[]; hasMore: boolean } {
    const safeLimit = Math.max(1, limit);
    let rows: ChatMessageRow[];

    if (before) {
      const target = this.db
        .prepare('SELECT rowid, createdAt FROM chat_messages WHERE id = ? AND sessionId = ?')
        .get(before, sessionId) as { rowid: number; createdAt: string } | undefined;

      if (!target) {
        return { messages: [], hasMore: false };
      }

      rows = this.db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE sessionId = ? AND (createdAt < ? OR (createdAt = ? AND rowid < ?))
           ORDER BY createdAt DESC, rowid DESC
           LIMIT ?`
        )
        .all(sessionId, target.createdAt, target.createdAt, target.rowid, safeLimit + 1) as ChatMessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE sessionId = ?
           ORDER BY createdAt DESC, rowid DESC
           LIMIT ?`
        )
        .all(sessionId, safeLimit + 1) as ChatMessageRow[];
    }

    const hasMore = rows.length > safeLimit;
    const paginated = hasMore ? rows.slice(0, safeLimit) : rows;
    paginated.reverse();

    return { messages: paginated, hasMore };
  }

  getLastBySession(sessionId: string): ChatMessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1')
      .get(sessionId) as ChatMessageRow | undefined;
  }

  insert(row: {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'tool' | 'error' | 'system';
    content: string;
    meta?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, sessionId, role, content, meta)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(row.id, row.sessionId, row.role, row.content, row.meta || null);
  }

  upsert(row: {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'tool' | 'error' | 'system';
    content: string;
    meta?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, sessionId, role, content, meta)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET role = excluded.role, content = excluded.content, meta = excluded.meta`
      )
      .run(row.id, row.sessionId, row.role, row.content, row.meta || null);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM chat_messages WHERE sessionId = ?').run(sessionId);
  }
}

export interface RunMetricsRow {
  runId: string;
  taskId: string;
  engine: string;
  model: string;
  profileName: string;
  tokensUsed: number | null;
  usageBefore: number | null;
  usageAfter: number | null;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  durationMs: number | null;
  createdAt: string;
}

export class RunMetricsRepo {
  constructor(private db: Database.Database) {}

  get(runId: string): RunMetricsRow | undefined {
    return this.db.prepare('SELECT * FROM run_metrics WHERE runId = ?').get(runId) as
      | RunMetricsRow
      | undefined;
  }

  getByTask(taskId: string): RunMetricsRow[] {
    return this.db
      .prepare('SELECT * FROM run_metrics WHERE taskId = ? ORDER BY createdAt')
      .all(taskId) as RunMetricsRow[];
  }

  getAll(): RunMetricsRow[] {
    return this.db
      .prepare('SELECT * FROM run_metrics ORDER BY createdAt')
      .all() as RunMetricsRow[];
  }

  upsert(row: Omit<RunMetricsRow, 'createdAt'> & { createdAt?: string }): void {
    this.db
      .prepare(
        `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed, usageBefore, usageAfter, linesAdded, linesDeleted, filesChanged, durationMs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runId) DO UPDATE SET
           taskId = excluded.taskId,
           engine = excluded.engine,
           model = excluded.model,
           profileName = excluded.profileName,
           tokensUsed = excluded.tokensUsed,
           usageBefore = excluded.usageBefore,
           usageAfter = excluded.usageAfter,
           linesAdded = excluded.linesAdded,
           linesDeleted = excluded.linesDeleted,
           filesChanged = excluded.filesChanged,
           durationMs = excluded.durationMs`,
      )
      .run(
        row.runId,
        row.taskId,
        row.engine,
        row.model,
        row.profileName,
        row.tokensUsed ?? null,
        row.usageBefore ?? null,
        row.usageAfter ?? null,
        row.linesAdded ?? 0,
        row.linesDeleted ?? 0,
        row.filesChanged ?? 0,
        row.durationMs ?? null,
      );
  }

  updateLines(runId: string, linesAdded: number, linesDeleted: number, filesChanged: number): void {
    this.db
      .prepare(
        `UPDATE run_metrics
         SET linesAdded = ?, linesDeleted = ?, filesChanged = ?
         WHERE runId = ?`,
      )
      .run(linesAdded, linesDeleted, filesChanged, runId);
  }

  clearOtherRunsLines(taskId: string, keepRunId: string): void {
    this.db
      .prepare(
        `UPDATE run_metrics
         SET linesAdded = 0, linesDeleted = 0, filesChanged = 0
         WHERE taskId = ? AND runId != ?`,
      )
      .run(taskId, keepRunId);
  }
}

export type TaskNoteKind = 'note' | 'overlap';

export interface TaskNoteRow {
  id: number;
  projectId: string;
  taskId: string;
  kind: TaskNoteKind;
  content: string;
  createdAt: string;
}

export interface KnowledgeEntryRow {
  id: number;
  projectId: string;
  taskId: string;
  content: string;
  createdAt: string;
  pinned: number;
}

export class KnowledgeRepo {
  constructor(private db: Database.Database) {}

  getByProject(projectId: string): KnowledgeEntryRow[] {
    return this.db
      .prepare('SELECT * FROM knowledge_entries WHERE projectId = ? ORDER BY pinned DESC, createdAt DESC, id DESC')
      .all(projectId) as KnowledgeEntryRow[];
  }

  pageByProject(projectId: string, limit: string | number | undefined, cursor?: string, offset?: string | number): PageResult<KnowledgeEntryRow> {
    const decoded = decodeCursor(cursor);
    if (cursor && !decoded) throw new Error('Invalid pagination cursor');
    const pageSize = parsePageSize(limit);
    const values: unknown[] = [projectId];
    const where = decoded
      ? ' WHERE projectId = ? AND (createdAt < ? OR (createdAt = ? AND id < ?))'
      : ' WHERE projectId = ?';
    if (decoded) values.push(decoded.value, decoded.value, decoded.id);
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM knowledge_entries WHERE projectId = ?').get(projectId) as { count: number }).count;
    const safeOffset = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Math.floor(Number(offset)) : 0;
    const rows = this.db.prepare(`SELECT * FROM knowledge_entries${where} ORDER BY createdAt DESC, id DESC LIMIT ? OFFSET ?`).all(...values, pageSize + 1, safeOffset) as KnowledgeEntryRow[];
    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    const last = items.at(-1);
    return { items, total, nextCursor: hasMore && last ? encodeCursor(last.createdAt, String(last.id)) : null };
  }

  get(id: number): KnowledgeEntryRow | undefined {
    return this.db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as KnowledgeEntryRow | undefined;
  }

  insert(row: { projectId: string; taskId: string; content: string; pinned?: boolean }): KnowledgeEntryRow {
    const result = this.db
      .prepare('INSERT INTO knowledge_entries (projectId, taskId, content, pinned) VALUES (?, ?, ?, ?)')
      .run(row.projectId, row.taskId, row.content, row.pinned ? 1 : 0);
    return this.get(result.lastInsertRowid as number)!;
  }

  update(id: number, fields: { content?: string; pinned?: boolean }): KnowledgeEntryRow | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.content !== undefined) { sets.push('content = ?'); values.push(fields.content); }
    if (fields.pinned !== undefined) { sets.push('pinned = ?'); values.push(fields.pinned ? 1 : 0); }
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE knowledge_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.get(id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
  }
}

export class TaskNoteRepo {
  constructor(private db: Database.Database) {}

  insert(row: {
    projectId: string;
    taskId: string;
    kind: TaskNoteKind;
    content: string;
  }): TaskNoteRow {
    const info = this.db
      .prepare(
        'INSERT INTO task_notes (projectId, taskId, kind, content) VALUES (?, ?, ?, ?)',
      )
      .run(row.projectId, row.taskId, row.kind, row.content);
    return this.get(info.lastInsertRowid as number)!;
  }

  get(id: number): TaskNoteRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_notes WHERE id = ?')
      .get(id) as TaskNoteRow | undefined;
  }

  getByProject(projectId: string, sinceId?: number): TaskNoteRow[] {
    if (sinceId !== undefined && !Number.isNaN(sinceId)) {
      return this.db
        .prepare('SELECT * FROM task_notes WHERE projectId = ? AND id > ? ORDER BY id ASC')
        .all(projectId, sinceId) as TaskNoteRow[];
    }
    return this.db
      .prepare('SELECT * FROM task_notes WHERE projectId = ? ORDER BY id ASC')
      .all(projectId) as TaskNoteRow[];
  }

  getByTask(taskId: string): TaskNoteRow[] {
    return this.db
      .prepare('SELECT * FROM task_notes WHERE taskId = ? ORDER BY id ASC')
      .all(taskId) as TaskNoteRow[];
  }

  hasOverlap(taskId: string, otherTaskId: string, file: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM task_notes WHERE taskId = ? AND kind = 'overlap' AND content LIKE ? LIMIT 1",
      )
      .get(taskId, `%${file}%${otherTaskId}%`);
    return Boolean(row);
  }

  getActiveOverlaps(runningTaskIds: string[]): TaskNoteRow[] {
    if (runningTaskIds.length === 0) return [];
    const placeholders = runningTaskIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM task_notes
         WHERE kind = 'overlap' AND taskId IN (${placeholders})
         ORDER BY id DESC LIMIT 50`,
      )
      .all(...runningTaskIds) as TaskNoteRow[];
  }
}

export interface CiRunRow {
  projectId: string;
  runId: number;
  workflow: string;
  sha: string;
  status: string;
  conclusion: string | null;
  jobs: string; // JSON
  completedAt: string | null;
  url?: string | null;
  createdAt?: string;
}

export class CiRepo {
  constructor(private db: Database.Database) {}

  insert(row: {
    projectId: string;
    runId: number;
    workflow: string;
    sha: string;
    status: string;
    conclusion: string | null;
    jobs: string;
    completedAt: string | null;
    url?: string | null;
  }): CiRunRow {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ci_runs (projectId, runId, workflow, sha, status, conclusion, jobs, completedAt, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.projectId,
        row.runId,
        row.workflow,
        row.sha,
        row.status,
        row.conclusion,
        row.jobs,
        row.completedAt,
        row.url ?? null,
      );
    return this.get(row.projectId, row.runId)!;
  }

  get(projectId: string, runId: number): CiRunRow | undefined {
    return this.db
      .prepare('SELECT * FROM ci_runs WHERE projectId = ? AND runId = ?')
      .get(projectId, runId) as CiRunRow | undefined;
  }

  listActiveProjects(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT projectId FROM ci_runs WHERE completedAt IS NULL AND status != 'completed'")
        .all() as Array<{ projectId: string }>
    ).map((row) => row.projectId);
  }

  getLatest(projectId: string): CiRunRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM ci_runs WHERE projectId = ? ORDER BY runId DESC LIMIT 1',
      )
      .get(projectId) as CiRunRow | undefined;
  }

  listByProject(projectId: string, limit = 20): CiRunRow[] {
    return this.db
      .prepare(
        'SELECT * FROM ci_runs WHERE projectId = ? ORDER BY runId DESC LIMIT ?',
      )
      .all(projectId, limit) as CiRunRow[];
  }

  pageByProject(projectId: string, options?: { limit?: string | number; cursor?: string; offset?: string | number }): PageResult<CiRunRow> {
    const limit = parsePageSize(options?.limit);
    const cursor = decodeCursor(options?.cursor);
    if (options?.cursor && !cursor) throw new Error('Invalid pagination cursor');
    const offset = cursor ? 0 : Math.max(0, Number(options?.offset) || 0);
    const params: Array<string | number> = [projectId];
    let where = 'projectId = ?';
    if (cursor) {
      where += ' AND (runId < ? OR (runId = ? AND projectId < ?))';
      params.push(Number(cursor.value), Number(cursor.value), cursor.id);
    }
    const rows = this.db.prepare(`SELECT * FROM ci_runs WHERE ${where} ORDER BY runId DESC LIMIT ? OFFSET ?`)
      .all(...params, limit + 1, offset) as CiRunRow[];
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      total: (this.db.prepare('SELECT COUNT(*) AS count FROM ci_runs WHERE projectId = ?').get(projectId) as { count: number }).count,
      nextCursor: rows.length > limit && last ? encodeCursor(last.runId, String(last.runId)) : null,
    };
  }

  getLatestForAllProjects(): Map<string, CiRunRow> {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM ci_runs c
         INNER JOIN (
           SELECT projectId, MAX(runId) AS maxRunId
           FROM ci_runs
           GROUP BY projectId
         ) latest ON c.projectId = latest.projectId AND c.runId = latest.maxRunId`,
      )
      .all() as CiRunRow[];
    const map = new Map<string, CiRunRow>();
    for (const row of rows) {
      map.set(row.projectId, row);
    }
    return map;
  }
}

export interface TrackerItemRow {
  source_id: string; wp_id: number; display_id: string; status_id: number | null; updated_at: string;
  last_comment_id: number | null; task_ids: string; writeback: string; created_at: string;
}

export class TrackerItemRepo {
  constructor(private db: Database.Database) {}
  get(sourceId: string, wpId: number): TrackerItemRow | undefined { return this.db.prepare('SELECT * FROM tracker_items WHERE source_id = ? AND wp_id = ?').get(sourceId, wpId) as TrackerItemRow | undefined; }
  linkTask(sourceId: string, wpId: number, displayId: string, taskId: string): TrackerItemRow {
    const existing = this.get(sourceId, wpId);
    if (existing) {
      let taskIds: string[];
      try {
        const parsed = JSON.parse(existing.task_ids || '[]');
        taskIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
      } catch {
        taskIds = [];
      }
      if (!taskIds.includes(taskId)) taskIds.push(taskId);
      this.db.prepare('UPDATE tracker_items SET task_ids = ? WHERE source_id = ? AND wp_id = ?').run(JSON.stringify(taskIds), sourceId, wpId);
      return this.get(sourceId, wpId)!;
    }
    return this.upsert({
      source_id: sourceId,
      wp_id: wpId,
      display_id: displayId,
      status_id: null,
      updated_at: new Date().toISOString(),
      last_comment_id: null,
      task_ids: JSON.stringify([taskId]),
      writeback: '{}',
    });
  }
  delete(sourceId: string, wpId: number): void { this.db.prepare('DELETE FROM tracker_items WHERE source_id = ? AND wp_id = ?').run(sourceId, wpId); }
  upsert(row: Omit<TrackerItemRow, 'created_at'>): TrackerItemRow {
    this.db.prepare(`INSERT INTO tracker_items (source_id,wp_id,display_id,status_id,updated_at,last_comment_id,task_ids,writeback) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source_id,wp_id) DO UPDATE SET display_id=excluded.display_id,status_id=excluded.status_id,updated_at=excluded.updated_at,last_comment_id=excluded.last_comment_id,task_ids=excluded.task_ids,writeback=excluded.writeback`).run(row.source_id,row.wp_id,row.display_id,row.status_id,row.updated_at,row.last_comment_id,row.task_ids,row.writeback);
    return this.get(row.source_id, row.wp_id)!;
  }
  list(sourceId: string): TrackerItemRow[] { return this.db.prepare('SELECT * FROM tracker_items WHERE source_id = ? ORDER BY wp_id').all(sourceId) as TrackerItemRow[]; }
  listAll(): TrackerItemRow[] { return this.db.prepare('SELECT * FROM tracker_items ORDER BY source_id, wp_id').all() as TrackerItemRow[]; }
  listForTask(taskId: string): TrackerItemRow[] {
    return this.db.prepare(`SELECT t.* FROM tracker_items t WHERE EXISTS (SELECT 1 FROM json_each(t.task_ids) WHERE json_each.value = ?) ORDER BY t.source_id, t.wp_id`).all(taskId) as TrackerItemRow[];
  }
}

export interface TimesheetEntryRow { source_id: string; spent_on: string; wp_id: number; entry_id: number; hours: number; raw_hours: number | null; written_estimate: number | null; updated_at: string; }
export class TimesheetEntryRepo {
  constructor(private db: Database.Database) {}
  get(sourceId: string, date: string, wpId: number): TimesheetEntryRow | undefined {
    return this.db.prepare('SELECT * FROM timesheet_entries WHERE source_id = ? AND spent_on = ? AND wp_id = ?').get(sourceId, date, wpId) as TimesheetEntryRow | undefined;
  }
  listForDate(sourceId: string, date: string): TimesheetEntryRow[] {
    return this.db.prepare('SELECT * FROM timesheet_entries WHERE source_id = ? AND spent_on = ? ORDER BY wp_id').all(sourceId, date) as TimesheetEntryRow[];
  }
  /** Tổng raw_hours qua mọi ngày đã ghi cho (source_id, wp_id). Không tính ngày excludeDate. */
  sumRawHours(sourceId: string, wpId: number, excludeDate: string): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(raw_hours),0) AS total FROM timesheet_entries WHERE source_id = ? AND wp_id = ? AND spent_on != ?').get(sourceId, wpId, excludeDate) as { total: number };
    return row.total;
  }
  /** Giá trị written_estimate gần nhất hub đã ghi lên OP cho (source_id, wp_id), hoặc null nếu chưa ghi. */
  lastWrittenEstimate(sourceId: string, wpId: number): number | null {
    const row = this.db.prepare('SELECT written_estimate FROM timesheet_entries WHERE source_id = ? AND wp_id = ? AND written_estimate IS NOT NULL ORDER BY spent_on DESC LIMIT 1').get(sourceId, wpId) as { written_estimate: number } | undefined;
    return row?.written_estimate ?? null;
  }
  upsert(row: Omit<TimesheetEntryRow, 'updated_at'>): void {
    this.db.prepare(`INSERT INTO timesheet_entries (source_id, spent_on, wp_id, entry_id, hours, raw_hours, written_estimate) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, spent_on, wp_id) DO UPDATE SET entry_id=excluded.entry_id, hours=excluded.hours, raw_hours=excluded.raw_hours, written_estimate=excluded.written_estimate, updated_at=datetime('now')`)
      .run(row.source_id, row.spent_on, row.wp_id, row.entry_id, row.hours, row.raw_hours ?? null, row.written_estimate ?? null);
  }
}

export interface TimesheetManualEntryRow {
  id: string; source_id: string; spent_on: string; wp_id: number; display_id: string;
  description: string; active_hours: number; wait_hours: number; level: 'easy' | 'hard';
  pinned: number; created_at: string; updated_at: string;
}

export class TimesheetManualEntryRepo {
  constructor(private db: Database.Database) {}
  get(id: string): TimesheetManualEntryRow | undefined {
    return this.db.prepare('SELECT * FROM timesheet_manual_entries WHERE id = ?').get(id) as TimesheetManualEntryRow | undefined;
  }
  listForDate(sourceId: string, date: string): TimesheetManualEntryRow[] {
    return this.db.prepare('SELECT * FROM timesheet_manual_entries WHERE source_id = ? AND spent_on = ? ORDER BY created_at, id').all(sourceId, date) as TimesheetManualEntryRow[];
  }
  insert(row: Omit<TimesheetManualEntryRow, 'created_at' | 'updated_at'>): TimesheetManualEntryRow {
    this.db.prepare(`INSERT INTO timesheet_manual_entries
      (id, source_id, spent_on, wp_id, display_id, description, active_hours, wait_hours, level, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.source_id, row.spent_on, row.wp_id, row.display_id, row.description, row.active_hours, row.wait_hours, row.level, row.pinned ? 1 : 0);
    return this.get(row.id)!;
  }
  update(id: string, patch: Partial<Omit<TimesheetManualEntryRow, 'id' | 'created_at' | 'updated_at'>>): TimesheetManualEntryRow {
    const current = this.get(id);
    if (!current) throw new Error('Mục thủ công không tồn tại');
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE timesheet_manual_entries SET source_id=?, spent_on=?, wp_id=?, display_id=?, description=?, active_hours=?, wait_hours=?, level=?, pinned=?, updated_at=datetime('now') WHERE id=?`)
      .run(next.source_id, next.spent_on, next.wp_id, next.display_id, next.description, next.active_hours, next.wait_hours, next.level, next.pinned ? 1 : 0, id);
    return this.get(id)!;
  }
  delete(id: string): void { this.db.prepare('DELETE FROM timesheet_manual_entries WHERE id = ?').run(id); }
}

export interface TimesheetDayOverrideRow { source_id: string; spent_on: string; hours: number; updated_at: string; }
export class TimesheetDayOverrideRepo {
  constructor(private db: Database.Database) {}
  get(sourceId: string, date: string): TimesheetDayOverrideRow | undefined {
    return this.db.prepare('SELECT * FROM timesheet_day_overrides WHERE source_id = ? AND spent_on = ?').get(sourceId, date) as TimesheetDayOverrideRow | undefined;
  }
  upsert(sourceId: string, date: string, hours: number): TimesheetDayOverrideRow {
    this.db.prepare(`INSERT INTO timesheet_day_overrides (source_id, spent_on, hours) VALUES (?, ?, ?)
      ON CONFLICT(source_id, spent_on) DO UPDATE SET hours=excluded.hours, updated_at=datetime('now')`).run(sourceId, date, hours);
    return this.get(sourceId, date)!;
  }
}

