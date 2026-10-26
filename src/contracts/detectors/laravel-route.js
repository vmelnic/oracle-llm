import fs from 'fs';
import path from 'path';
import { globFiles } from '../../utils/glob.js';

export class LaravelRouteDetector {
  async detect(subproject) {
    if (subproject.framework !== 'laravel') return [];
    const surfaces = [];

    const routeFiles = await globFiles(
      ['routes/*.php'],
      { cwd: subproject.root, absolute: true }
    );

    for (const f of routeFiles) {
      const content = fs.readFileSync(f, 'utf-8');
      const routeMatches = content.matchAll(
        /Route::(get|post|put|patch|delete|options)\(\s*['"]([^'"]+)['"]/gi
      );
      for (const m of routeMatches) {
        const method = m[1].toUpperCase();
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `${method} ${m[2]}`,
          kind: 'route',
          lang: 'php',
          startLine: content.slice(0, m.index).split('\n').length,
          metadata: { type: 'laravel_route', method, path: m[2] },
        });
      }

      const resourceMatches = content.matchAll(
        /Route::resource\(\s*['"]([^'"]+)['"]/gi
      );
      for (const m of resourceMatches) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
          surfaces.push({
            path: path.relative(subproject.root, f),
            symbol: `${method} ${m[1]}`,
            kind: 'route',
            lang: 'php',
            startLine: content.slice(0, m.index).split('\n').length,
            metadata: { type: 'laravel_resource_route', method, resource: m[1] },
          });
        }
      }
    }

    const models = await globFiles(
      ['app/Models/*.php', 'app/*.php'],
      { cwd: subproject.root, absolute: true }
    );
    for (const f of models) {
      const content = fs.readFileSync(f, 'utf-8');
      if (!content.includes('extends Model')) continue;
      const classMatch = content.match(/class\s+(\w+)\s+extends\s+Model/);
      if (!classMatch) continue;
      const tableProp = content.match(/\$table\s*=\s*['"](\w+)['"]/);
      const tableName = tableProp
        ? tableProp[1]
        : classMatch[1].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() + 's';
      surfaces.push({
        path: path.relative(subproject.root, f),
        symbol: `table:${tableName}`,
        kind: 'db_table',
        lang: 'php',
        metadata: { type: 'eloquent_model', model: classMatch[1], table: tableName },
      });
    }
    return surfaces;
  }
}
