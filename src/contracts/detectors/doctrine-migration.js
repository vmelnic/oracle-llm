import fs from 'fs';
import path from 'path';
import { globFiles } from '../../utils/glob.js';

export class DoctrineMigrationDetector {
  async detect(subproject) {
    if (subproject.framework !== 'symfony') return [];
    const surfaces = [];

    const migrations = await globFiles(
      ['migrations/**/*.php', 'src/Migrations/**/*.php', 'doctrine/migrations/**/*.php'],
      { cwd: subproject.root, absolute: true }
    );

    for (const f of migrations) {
      const content = fs.readFileSync(f, 'utf-8');

      const versionMatch = content.match(/Version(\d{14})/);
      const version = versionMatch ? versionMatch[1] : null;

      const tablesCreated = [];
      const createMatches = content.matchAll(
        /createTable\s*\(\s*['"](\w+)['"]|->createTable\s*\(\s*['"](\w+)['"]|Schema::create\s*\(\s*['"](\w+)['"]/gi
      );
      for (const m of createMatches) {
        tablesCreated.push({ table: m[1] || m[2] || m[3], index: m.index });
      }

      const tablesAltered = [];
      const alterMatches = content.matchAll(
        /->alterTable\s*\(\s*['"](\w+)['"]|Schema::table\s*\(\s*['"](\w+)['"]|addSql\(['"].*ALTER\s+TABLE\s+(\w+)/gi
      );
      for (const m of alterMatches) {
        tablesAltered.push({ table: m[1] || m[2] || m[3], index: m.index });
      }

      if (tablesCreated.length === 0 && tablesAltered.length === 0) {
        const classMatch = content.match(/class\s+(Version\w+)\s+extends/);
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `doctrine_migration:${path.basename(f)}`,
          kind: 'migration',
          lang: 'php',
          metadata: { type: 'doctrine_migration', class: classMatch?.[1], version },
        });
        continue;
      }

      const lineAt = (index) => content.slice(0, index).split('\n').length;
      for (const { table, index } of tablesCreated) {
        const colMatches = content.matchAll(/addColumn\s*\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]/g);
        const columns = [];
        for (const cm of colMatches) {
          columns.push({ name: cm[1], type: cm[2] });
        }
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `doctrine:${table}`,
          kind: 'migration',
          lang: 'php',
          startLine: lineAt(index),
          metadata: {
            type: 'doctrine_migration',
            table,
            operation: 'create',
            columns,
            version,
            file: path.basename(f),
          },
        });
      }

      for (const { table, index } of tablesAltered) {
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `doctrine_alter:${table}`,
          kind: 'migration',
          lang: 'php',
          startLine: lineAt(index),
          metadata: {
            type: 'doctrine_migration',
            table,
            operation: 'alter',
            version,
            file: path.basename(f),
          },
        });
      }
    }
    return surfaces;
  }
}
