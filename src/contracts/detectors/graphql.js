import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

export class GraphQLDetector {
  async detect(subproject) {
    const surfaces = [];
    const gqlFiles = await fg(
      ['**/*.graphql', '**/*.gql', '**/schema.graphqls'],
      { cwd: subproject.root, absolute: true, ignore: ['node_modules/**'] }
    );

    for (const f of gqlFiles) {
      const content = fs.readFileSync(f, 'utf-8');
      const typeMatches = content.matchAll(/^type\s+(\w+)/gm);
      for (const m of typeMatches) {
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `graphql:${m[1]}`,
          kind: 'api_endpoint',
          lang: 'graphql',
          startLine: content.slice(0, m.index).split('\n').length,
          metadata: { type: 'graphql_type', name: m[1] },
        });
      }
    }
    return surfaces;
  }
}
