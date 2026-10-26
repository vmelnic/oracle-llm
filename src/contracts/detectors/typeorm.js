import fs from 'fs';
import path from 'path';
import { globFiles } from '../../utils/glob.js';

export class TypeOrmDetector {
  async detect(subproject) {
    const surfaces = [];
    const ormFiles = await globFiles(
      ['**/*.entity.{ts,js}', '**/entities/**/*.{ts,js}', '**/entity/**/*.{ts,js}'],
      { cwd: subproject.root, absolute: true }
    );

    for (const f of ormFiles) {
      const content = fs.readFileSync(f, 'utf-8');

      const classMatch = content.match(/class\s+(\w+)/);
      if (!classMatch) continue;

      const tableName = content.match(/@Entity\(['"]?(\w+)['"]?\)/)?.[1]
        || content.match(/tableName:\s*['"](\w+)['"]/)?.[1]
        || classMatch[1].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

      const columns = [];
      const colMatches = content.matchAll(/@(Column|PrimaryColumn|PrimaryGeneratedColumn|ManyToOne|OneToMany|OneToOne|ManyToMany|JoinColumn)\s*\(/gi);
      for (const cm of colMatches) {
        const line = content.slice(0, cm.index).split('\n').length;
        const nearby = content.slice(cm.index, cm.index + 200);
        const propName = nearby.match(/\)\s*(?:public\s+)?(?:readonly\s+)?(\w+)\s*[?:]?/)?.[1];
        if (propName) {
          columns.push({ name: propName, line, decorator: cm[1] });
        }
      }

      surfaces.push({
        path: path.relative(subproject.root, f),
        symbol: `typeorm:${classMatch[1]}`,
        kind: 'db_table',
        lang: subproject.language,
        startLine: content.slice(0, content.indexOf('@Entity') || content.indexOf('class ')).split('\n').length,
        metadata: {
          type: 'typeorm_entity',
          class: classMatch[1],
          table: tableName,
          columns,
        },
      });
    }
    return surfaces;
  }
}
