export const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  -- identity is the key, never the display name: names are chosen by humans,
  -- so they collide, change and go missing
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  root_path TEXT, git_root TEXT, first_seen INTEGER
);
-- one process lifetime. Always known: burn0 is *in* the process.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, service TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, pid INTEGER,
  entry TEXT, node_version TEXT
);
-- one logical unit of work. Nullable on requests: NULL = outside any trace.
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,   -- denormalized so scoping never needs a join
  parent_id INTEGER REFERENCES traces(id),
  name TEXT, kind TEXT NOT NULL, -- 'http-server' | 'explicit' | 'tool'
  started_at INTEGER NOT NULL, ended_at INTEGER, status INTEGER,
  -- force-closed by the stale sweep: the response never finished
  incomplete INTEGER NOT NULL DEFAULT 0,
  tool_status TEXT,              -- ok | error | unresolved  (§8)
  attribution TEXT,              -- exact | window | turn | none  (§8)
  tags TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, service TEXT,
  run_id INTEGER, trace_id INTEGER, seq INTEGER,
  entity TEXT NOT NULL, entity_class TEXT NOT NULL, provider TEXT,
  method TEXT NOT NULL, url TEXT NOT NULL, normalized_endpoint TEXT NOT NULL, hostname TEXT NOT NULL,
  status INTEGER, started_at INTEGER NOT NULL, first_byte_ms INTEGER, latency_ms INTEGER,
  req_bytes INTEGER, res_bytes INTEGER,
  model TEXT, tokens_in INTEGER, tokens_out INTEGER, tokens_cached INTEGER, cost_usd REAL,
  estimated INTEGER NOT NULL DEFAULT 0,
  tags TEXT
);
-- bulky tool arguments and results, pruned with payloads at 7 days while the
-- trace structure itself lives to 30 (§8.6)
CREATE TABLE IF NOT EXISTS tool_io (
  trace_id INTEGER PRIMARY KEY REFERENCES traces(id) ON DELETE CASCADE,
  args TEXT, result TEXT, truncated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payloads (
  request_id INTEGER PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  req_headers TEXT, req_body TEXT, res_headers TEXT, res_body TEXT,
  stack_snippet TEXT, req_truncated INTEGER NOT NULL DEFAULT 0, res_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_project_time ON requests(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_requests_entity_time ON requests(entity, started_at);
CREATE INDEX IF NOT EXISTS idx_requests_provider_model ON requests(provider, model);
CREATE INDEX IF NOT EXISTS idx_requests_time ON requests(started_at);
CREATE INDEX IF NOT EXISTS idx_traces_project_time ON traces(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_traces_parent ON traces(parent_id);
CREATE INDEX IF NOT EXISTS idx_requests_trace ON requests(trace_id, seq);
`
