import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

export class SymfonyRouteDetector {
  async detect(subproject) {
    if (subproject.framework !== 'symfony') return [];
    const surfaces = [];

    const routeFiles = await fg(
      ['config/routes.yaml', 'config/routes/*.yaml', 'config/routes.xml'],
      { cwd: subproject.root, absolute: true }
    );
    for (const f of routeFiles) {
      surfaces.push({
        path: path.relative(subproject.root, f),
        symbol: `routes:${path.basename(f)}`,
        kind: 'route',
        lang: 'php',
        metadata: { type: 'symfony_routes_config' },
      });
    }

    const controllers = await fg(
      ['src/Controller/**/*.php'],
      { cwd: subproject.root, absolute: true }
    );
    for (const f of controllers) {
      const content = fs.readFileSync(f, 'utf-8');
      const routeMatches = content.matchAll(/#\[Route\(['"]([^'"]+)['"]/g);
      for (const m of routeMatches) {
        const methodMatch = content.slice(
          Math.max(0, m.index - 200), m.index + m[0].length + 200
        ).match(/methods:\s*\[['"](\w+)['"]/);
        const method = methodMatch ? methodMatch[1] : 'GET';
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `${method} ${m[1]}`,
          kind: 'route',
          lang: 'php',
          startLine: content.slice(0, m.index).split('\n').length,
          metadata: { type: 'symfony_attribute_route', method, path: m[1] },
        });
      }
    }
    return surfaces;
  }
}
