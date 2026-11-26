import type { SqliteDb } from "./db.js";

/** Forward-only migrations, tracked with PRAGMA user_version. Never edit a shipped one. */
export const MIGRATIONS: string[] = [
  /* 1: core schema */ `
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    parts TEXT NOT NULL,
    origin TEXT NOT NULL,
    client_message_id TEXT,
    reply_to TEXT,
    search_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX messages_client_id ON messages(client_message_id) WHERE client_message_id IS NOT NULL;
  CREATE INDEX messages_order ON messages(created_at, id);

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    search_text, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF search_text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
    INSERT INTO messages_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
  END;

  CREATE TABLE blocks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    v INTEGER NOT NULL,
    props TEXT NOT NULL,
    state TEXT NOT NULL,
    resolution TEXT,
    owner TEXT NOT NULL,
    message_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX blocks_message ON blocks(message_id);
  CREATE INDEX blocks_state ON blocks(state);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    context TEXT NOT NULL,
    skills TEXT NOT NULL,
    status TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    parent_message_id TEXT,
    routine_run_id TEXT,
    runtime_ref TEXT,
    result TEXT,
    error TEXT,
    need TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX tasks_status ON tasks(status);
  CREATE INDEX tasks_name ON tasks(name);

  CREATE TABLE traces (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    message_id TEXT NOT NULL,
    task_ids TEXT NOT NULL,
    status TEXT NOT NULL,
    line TEXT,
    line_app TEXT,
    tool_count INTEGER NOT NULL,
    apps TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    label TEXT NOT NULL,
    app TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX steps_trace ON steps(trace_id, started_at);
  CREATE INDEX steps_task ON steps(task_id, started_at);

  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    schedule TEXT NOT NULL,
    deliver TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    model TEXT,
    run_count INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX routines_next ON routines(enabled, next_run_at);

  CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL,
    late INTEGER NOT NULL,
    task_id TEXT,
    message_id TEXT,
    summary TEXT
  );
  CREATE INDEX routine_runs_routine ON routine_runs(routine_id, started_at);

  CREATE TABLE skills (
    name TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    location TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    source TEXT,
    license TEXT,
    compatibility TEXT,
    metadata TEXT,
    allowed_tools TEXT,
    warnings TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    scope TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    origin TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_created ON attachments(created_at);

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE model_assignments (
    role TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning TEXT,
    voice_reasoning TEXT,
    dimensions INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE compactions (
    id TEXT PRIMARY KEY,
    session_kind TEXT NOT NULL,
    session_ref TEXT NOT NULL,
    trigger TEXT NOT NULL,
    pre_tokens INTEGER NOT NULL,
    post_tokens INTEGER,
    runtime TEXT NOT NULL,
    model TEXT NOT NULL,
    summary TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX compactions_session ON compactions(session_kind, session_ref, created_at);

  CREATE TABLE usage (
    day TEXT NOT NULL,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, role, provider, model)
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    integration TEXT NOT NULL,
    tool TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    reason TEXT,
    args TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    resume TEXT NOT NULL,
    requester TEXT NOT NULL,
    status TEXT NOT NULL,
    rule_id TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX approvals_status ON approvals(status);

  CREATE TABLE approval_rules (
    id TEXT PRIMARY KEY,
    integration TEXT NOT NULL,
    tool TEXT NOT NULL,
    constraint_logic TEXT,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE approval_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    rule_id TEXT,
    at INTEGER NOT NULL
  );

  CREATE TABLE integrations (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);

  CREATE TABLE sessions (
    key TEXT PRIMARY KEY,
    runtime TEXT NOT NULL,
    ref TEXT NOT NULL,
    model TEXT NOT NULL,
    context_tokens INTEGER,
    cache_lifetime TEXT,
    last_activity_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 2: blocks (milestone 4) */ `
  ALTER TABLE blocks ADD COLUMN fallback TEXT;
  ALTER TABLE blocks ADD COLUMN task_id TEXT;
  CREATE INDEX blocks_task ON blocks(task_id);
  CREATE TABLE block_actions (
    client_action_id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL,
    action TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX block_actions_block ON block_actions(block_id);
  `,
];

export function migrate(db: SqliteDb): { from: number; to: number } {
  const from = Number(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0);
  for (let version = from; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return { from, to: MIGRATIONS.length };
}
