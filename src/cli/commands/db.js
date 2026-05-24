import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadWorkspace, getSubprojectDir } from '../../scanner/workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'graph', 'schema.sql');

const CURRENT_VERSION = 2;

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema',
    up(db) {
      const sql = readFileSync(SCHEMA_PATH, 'utf-8');
      db.exec(sql);
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
];

function getDbPath(workspaceId, subprojectId) {
  const dir = getSubprojectDir(workspaceId, subprojectId);
  return path.join(dir, 'entity_graph.sqlite');
}

function schemaSql() {
  return readFileSync(SCHEMA_PATH, 'utf-8');
}

function getSchemaVersion(db) {
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    return row?.v || 0;
  } catch {
    return 0;
  }
}

function applyMigrations(db) {
  const current = getSchemaVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > current);

  if (pending.length === 0) {
    return { current, applied: 0 };
  }

  const applyMigration = db.transaction((migration) => {
    migration.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
  });

  for (const migration of pending) {
    applyMigration(migration);
  }

  return { current, applied: pending.length, newVersion: CURRENT_VERSION };
}

export function dbCommand() {
  const cmd = new Command('db');
  cmd.description('Database management');

  cmd
    .command('migrate <workspace_id> <subproject_id>')
    .description('Apply or update the SQL schema for a subproject database')
    .action((workspaceId, subprojectId) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) {
        console.error(`Workspace '${workspaceId}' not found.`);
        process.exit(1);
      }

      const sp = workspace.subprojects.find((s) => s.id === subprojectId);
      if (!sp) {
        console.error(`Subproject '${subprojectId}' not found.`);
        process.exit(1);
      }

      const dbPath = getDbPath(workspaceId, subprojectId);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      const db = new Database(dbPath);
      try {
        const result = applyMigrations(db);
        if (result.applied === 0) {
          console.log(`Schema up to date (version ${result.current}): ${dbPath}`);
        } else {
          console.log(`Applied ${result.applied} migration(s) (v${result.current} → v${result.newVersion}): ${dbPath}`);
        }
      } finally {
        db.close();
      }
    });

  cmd
    .command('reset <workspace_id> <subproject_id>')
    .description('Wipe the database and recreate schema from scratch')
    .option('--keep-artifacts', 'Keep L2 index, patterns, and manifest files')
    .action((workspaceId, subprojectId, opts) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) {
        console.error(`Workspace '${workspaceId}' not found.`);
        process.exit(1);
      }

      const sp = workspace.subprojects.find((s) => s.id === subprojectId);
      if (!sp) {
        console.error(`Subproject '${subprojectId}' not found.`);
        process.exit(1);
      }

      const dbPath = getDbPath(workspaceId, subprojectId);
      if (!fs.existsSync(dbPath)) {
        console.log(`Database does not exist yet. Creating fresh schema at ${dbPath}`);
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const db = new Database(dbPath);
        try {
          db.exec(schemaSql());
        } finally {
          db.close();
        }
        console.log('Done.');
        return;
      }

      console.log(`Resetting database: ${dbPath}`);
      fs.unlinkSync(dbPath);

      // Also remove WAL/shm sidecars if they exist
      const walPath = dbPath + '-wal';
      const shmPath = dbPath + '-shm';
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

      const db = new Database(dbPath);
      try {
        db.exec(schemaSql());
      } finally {
        db.close();
      }

      if (!opts.keepArtifacts) {
        const dir = path.dirname(dbPath);
        const toRemove = [
          path.join(dir, 'ast_embed_index.json'),
          path.join(dir, 'pattern_catalog.json'),
        ];
        for (const f of toRemove) {
          if (fs.existsSync(f)) {
            fs.unlinkSync(f);
            console.log(`  removed: ${path.basename(f)}`);
          }
        }
      }

      console.log('Database reset. Run `oracle ingest` to rebuild data.');
    });

  cmd
    .command('path <workspace_id> <subproject_id>')
    .description('Print the database file path')
    .action((workspaceId, subprojectId) => {
      console.log(getDbPath(workspaceId, subprojectId));
    });

  return cmd;
}
