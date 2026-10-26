import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSubprojectDir } from '../../scanner/workspace.js';
import { requireSubproject } from '../resolve.js';
import { acquireFileLock } from '../../utils/file-lock.js';
import { markIngestState } from '../../ingest/state.js';
import { applyMigrations } from '../../graph/migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'graph', 'schema.sql');

function getDbPath(workspaceId, subprojectId) {
  const dir = getSubprojectDir(workspaceId, subprojectId);
  return path.join(dir, 'entity_graph.sqlite');
}

function schemaSql() {
  return readFileSync(SCHEMA_PATH, 'utf-8');
}

export function dbCommand() {
  const cmd = new Command('db');
  cmd.description('Database management');

  cmd
    .command('migrate <workspace_id> <subproject_id>')
    .description('Apply or update the SQL schema for a subproject database')
    .action((workspaceId, subprojectId) => {
      requireSubproject(workspaceId, subprojectId);

      const dbPath = getDbPath(workspaceId, subprojectId);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      const lock = acquireFileLock(path.join(path.dirname(dbPath), '.ingest.lock'));
      let db;
      try {
        db = new Database(dbPath);
        const result = applyMigrations(db);
        if (result.applied === 0) {
          console.log(`Schema up to date (version ${result.newVersion}): ${dbPath}`);
        } else {
          console.log(`Applied ${result.applied} migration(s) (v${result.current} → v${result.newVersion}): ${dbPath}`);
        }
      } finally {
        if (db) db.close();
        lock.release();
      }
    });

  cmd
    .command('reset <workspace_id> <subproject_id>')
    .description('Wipe the database and recreate schema from scratch')
    .option('--keep-artifacts', 'Keep generated L2, pattern, and contract artifacts')
    .option('--no-backup', 'Do not keep a timestamped backup of the database')
    .action(async (workspaceId, subprojectId, opts) => {
      requireSubproject(workspaceId, subprojectId);

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
        markIngestState(path.dirname(dbPath), 'reset');
        console.log('Done.');
        return;
      }

      console.log(`Resetting database: ${dbPath}`);
      const lock = acquireFileLock(path.join(path.dirname(dbPath), '.ingest.lock'));
      try {
        if (opts.backup) {
          const backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          const sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
          try {
            await sourceDb.backup(backupPath);
          } finally {
            sourceDb.close();
          }
          fs.chmodSync(backupPath, 0o600);
          console.log(`Backup created: ${backupPath}`);
        }
        for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
        }

        const db = new Database(dbPath);
        try {
          db.exec(schemaSql());
        } finally {
          db.close();
        }

        if (!opts.keepArtifacts) {
          const dir = path.dirname(dbPath);
          const toRemove = [
            path.join(dir, 'ast_embed_index'),
            path.join(dir, 'ast_embed_index.json'),
            path.join(dir, 'pattern_catalog.json'),
            path.join(dir, 'contract_surfaces.json'),
          ];
          for (const artifact of toRemove) {
            if (fs.existsSync(artifact)) {
              fs.rmSync(artifact, { recursive: true, force: true });
              console.log(`  removed: ${path.basename(artifact)}`);
            }
          }
        }
        markIngestState(path.dirname(dbPath), 'reset');
      } finally {
        lock.release();
      }

      console.log('Database reset. Run `oracle ingest` to rebuild data.');
    });

  cmd
    .command('path <workspace_id> <subproject_id>')
    .description('Print the database file path')
    .action((workspaceId, subprojectId) => {
      requireSubproject(workspaceId, subprojectId);
      console.log(getDbPath(workspaceId, subprojectId));
    });

  return cmd;
}
