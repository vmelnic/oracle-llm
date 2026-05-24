import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

export class PrismaDetector {
  async detect(subproject) {
    const surfaces = [];
    const prismaFiles = await fg(
      ['prisma/schema.prisma', '**/schema.prisma'],
      { cwd: subproject.root, absolute: true }
    );

    for (const f of prismaFiles) {
      const content = fs.readFileSync(f, 'utf-8');
      const modelMatches = content.matchAll(/^model\s+(\w+)\s*\{/gm);
      for (const m of modelMatches) {
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `prisma:${m[1]}`,
          kind: 'db_table',
          lang: 'prisma',
          startLine: content.slice(0, m.index).split('\n').length,
          metadata: { type: 'prisma_model', model: m[1] },
        });
      }

      const enumMatches = content.matchAll(/^enum\s+(\w+)\s*\{/gm);
      for (const m of enumMatches) {
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `prisma_enum:${m[1]}`,
          kind: 'enum',
          lang: 'prisma',
          startLine: content.slice(0, m.index).split('\n').length,
          metadata: { type: 'prisma_enum', name: m[1] },
        });
      }
    }
    return surfaces;
  }
}
