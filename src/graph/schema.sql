-- llm-oracle entity graph schema
-- SQLite with WAL mode and foreign keys
--
-- Runs on every open, before migrations (src/graph/migrations.js). Keep it
-- idempotent, and put indexes on migration-added columns in POST_MIGRATION_SQL.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subproject_id TEXT NOT NULL,
  path TEXT NOT NULL,
  lang TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER DEFAULT 0,
  signature TEXT,
  doc TEXT,
  commit_sha TEXT,
  file_blob_hash TEXT,
  metadata TEXT,
  short_symbol TEXT,
  member_name TEXT,
  UNIQUE(subproject_id, path, symbol, kind, start_line)
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subproject_id TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  metadata TEXT,
  UNIQUE(subproject_id, source_id, target_id, kind)
);

CREATE TABLE IF NOT EXISTS file_hashes (
  subproject_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL,
  PRIMARY KEY(subproject_id, path)
);

-- Name-based references of a file, keyed by the lowercased last name segment.
-- Lets incremental builds revisit files when a matching symbol appears
-- elsewhere. ref_kind: 'symbol' (did not resolve), 'call' (method call on a
-- receiver of unknown type, did not resolve: a possible call site), 'soft'
-- (resolved by inheritance or receiver name; may change with new symbols).
CREATE TABLE IF NOT EXISTS unresolved_refs (
  subproject_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  target_key TEXT NOT NULL,
  ref_kind TEXT NOT NULL DEFAULT 'symbol',
  PRIMARY KEY(subproject_id, source_path, target_key, ref_kind)
);

-- Build metadata (e.g. the extractor version the graph was built with).
CREATE TABLE IF NOT EXISTS graph_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unresolved_refs_key
  ON unresolved_refs(subproject_id, target_key);

CREATE INDEX IF NOT EXISTS idx_nodes_subproject_kind
  ON nodes(subproject_id, kind);

CREATE INDEX IF NOT EXISTS idx_nodes_subproject_symbol
  ON nodes(subproject_id, symbol);

CREATE INDEX IF NOT EXISTS idx_nodes_subproject_path
  ON nodes(subproject_id, path);

CREATE INDEX IF NOT EXISTS idx_edges_subproject_source
  ON edges(subproject_id, source_id);

CREATE INDEX IF NOT EXISTS idx_edges_subproject_target
  ON edges(subproject_id, target_id);

CREATE INDEX IF NOT EXISTS idx_edges_subproject_kind
  ON edges(subproject_id, kind);

CREATE INDEX IF NOT EXISTS idx_edges_source
  ON edges(source_id);

CREATE INDEX IF NOT EXISTS idx_edges_target
  ON edges(target_id);

CREATE INDEX IF NOT EXISTS idx_nodes_parent
  ON nodes(parent_id);

INSERT INTO schema_version (version)
SELECT 6
WHERE NOT EXISTS (SELECT 1 FROM schema_version);
