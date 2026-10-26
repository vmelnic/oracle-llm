import fs from 'fs';
import path from 'path';
import { globFiles } from '../../utils/glob.js';

export class DatabaseSchemaDetector {
  async detect(subproject) {
    const surfaces = [];

    const migrations = await globFiles(
      [
        'migrations/**/*.{php,sql,js,ts,py}',
        'database/migrations/**/*.php',
        'src/Migrations/**/*.php',
        'alembic/versions/**/*.py',
        'prisma/migrations/**/*.sql',
      ],
      { cwd: subproject.root, absolute: true }
    );

    for (const f of migrations) {
      const content = fs.readFileSync(f, 'utf-8');
      const tableCreates = content.matchAll(
        /create(?:Table|_table|)\s*\(\s*['"](\w+)['"]/gi
      );
      for (const m of tableCreates) {
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `migration:${path.basename(f)}:${m[1]}`,
          kind: 'migration',
          lang: subproject.language,
          startLine: content.slice(0, m.index).split('\n').length,
          metadata: { type: 'migration', table: m[1], operation: 'create' },
        });
      }
    }

    const schemaDumps = await globFiles(
      ['schema.sql', 'database/schema/*.sql', 'dump.sql'],
      { cwd: subproject.root, absolute: true }
    );
    for (const f of schemaDumps) {
      surfaces.push({
        path: path.relative(subproject.root, f),
        symbol: `schema:${path.basename(f)}`,
        kind: 'db_table',
        lang: 'sql',
        metadata: { type: 'schema_dump' },
      });
    }
    return surfaces;
  }
}
