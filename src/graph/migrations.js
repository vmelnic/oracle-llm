import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema',
    up(db) {
      db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
    },
  },
  {
    version: 2,
    description: 'Add schema_version tracking',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 3,
    description: 'Index edge endpoints and node parents',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
        CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
      `);
    },
  },
  {
    version: 4,
    description: 'Track unresolved references for incremental builds',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS unresolved_refs (
          subproject_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          target_key TEXT NOT NULL,
          PRIMARY KEY(subproject_id, source_path, target_key)
        );
        CREATE INDEX IF NOT EXISTS idx_unresolved_refs_key ON unresolved_refs(subproject_id, target_key);
      `);
      // Existing graphs have no unresolved refs recorded; forget file hashes so
      // the next ingest reprocesses every file once and fills the table.
      db.exec('DELETE FROM file_hashes');
    },
  },
  {
    version: 5,
    description: 'Indexed short symbol for namespace-suffix lookups',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
      if (!columns.includes('short_symbol')) db.exec('ALTER TABLE nodes ADD COLUMN short_symbol TEXT');
      db.function('oracle_short_symbol', { deterministic: true }, shortSymbol);
      db.exec('UPDATE nodes SET short_symbol = oracle_short_symbol(symbol)');
    },
  },
  {
    version: 6,
    description: 'Member names for method-call resolution, graph metadata, typed reference keys',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
      if (!columns.includes('member_name')) db.exec('ALTER TABLE nodes ADD COLUMN member_name TEXT');
      db.function('oracle_member_name', { deterministic: true }, memberName);
      db.exec('UPDATE nodes SET member_name = oracle_member_name(symbol)');

      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      const refColumns = db.prepare('PRAGMA table_info(unresolved_refs)').all().map(c => c.name);
      if (!refColumns.includes('ref_kind')) {
        db.exec(`
          CREATE TABLE unresolved_refs_v6 (
            subproject_id TEXT NOT NULL,
            source_path TEXT NOT NULL,
            target_key TEXT NOT NULL,
            ref_kind TEXT NOT NULL DEFAULT 'symbol',
            PRIMARY KEY(subproject_id, source_path, target_key, ref_kind)
          );
          INSERT INTO unresolved_refs_v6 (subproject_id, source_path, target_key)
            SELECT subproject_id, source_path, target_key FROM unresolved_refs;
          DROP TABLE unresolved_refs;
          ALTER TABLE unresolved_refs_v6 RENAME TO unresolved_refs;
          CREATE INDEX IF NOT EXISTS idx_unresolved_refs_key ON unresolved_refs(subproject_id, target_key);
        `);
      }
      // Method calls were not resolved before: reprocess every file once.
      db.exec('DELETE FROM file_hashes');
    },
  },
];

const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function getSchemaVersion(db) {
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    return row?.v || 0;
  } catch {
    return 0;
  }
}

// Indexes on columns added by migrations. They cannot live in schema.sql,
// which runs before migrations on databases that predate those columns.
const POST_MIGRATION_SQL = `
  CREATE INDEX IF NOT EXISTS idx_nodes_short_symbol ON nodes(subproject_id, short_symbol);
  CREATE INDEX IF NOT EXISTS idx_nodes_member_name ON nodes(subproject_id, member_name, kind);
`;

/** Last `\`-separated segment: `App\Models\User` -> `User`. */
export function shortSymbol(symbol) {
  const text = String(symbol ?? '');
  return text.slice(text.lastIndexOf('\\') + 1);
}

/**
 * Last name segment of a symbol: `App\\Models\\User::save`, `UserRepo.save`
 * and `save` all give `save`. Method calls are matched on it.
 */
export function memberName(symbol) {
  const text = String(symbol ?? '');
  const match = text.match(/(?:::|[.\\#])([^.\\#:]+)$/);
  return match ? match[1] : text;
}

/**
 * Brings any database to the current schema: fresh databases get schema.sql
 * (stamped at the latest version), existing ones run pending migrations.
 */
export function applyMigrations(db) {
  const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  // Graphs created before version tracking: record them as v1 so schema.sql
  // does not stamp them as current and every migration still runs.
  if (!tableExists('schema_version') && tableExists('nodes')) {
    db.exec(`CREATE TABLE schema_version (
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  }

  const current = getSchemaVersion(db);
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than supported v${CURRENT_SCHEMA_VERSION}`);
  }
  db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));

  const applyMigration = db.transaction((migration) => {
    migration.up(db);
    if (getSchemaVersion(db) < migration.version) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
    }
  });

  let applied = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= getSchemaVersion(db)) continue;
    applyMigration(migration);
    applied++;
  }
  db.exec(POST_MIGRATION_SQL);

  return { current, applied, newVersion: getSchemaVersion(db) };
}
