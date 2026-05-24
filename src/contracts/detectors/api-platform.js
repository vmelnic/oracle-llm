import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

export class ApiPlatformDetector {
  async detect(subproject) {
    if (subproject.framework !== 'symfony') return [];
    const surfaces = [];

    const phpFiles = await fg(
      ['src/Entity/**/*.php', 'src/ApiResource/**/*.php', 'src/Model/**/*.php'],
      { cwd: subproject.root, absolute: true }
    );

    for (const f of phpFiles) {
      const content = fs.readFileSync(f, 'utf-8');
      if (!content.includes('ApiResource') && !content.includes('ApiPlatform')) continue;

      const classMatch = content.match(/class\s+(\w+)/);
      if (!classMatch) continue;

      const resourceOps = [];
      const opMatches = content.matchAll(/operations:\s*\[([^\]]+)\]/g);
      for (const opMatch of opMatches) {
        const ops = opMatch[1];
        if (ops.includes('Get')) resourceOps.push('GET');
        if (ops.includes('GetCollection')) resourceOps.push('LIST');
        if (ops.includes('Post')) resourceOps.push('POST');
        if (ops.includes('Put') || ops.includes('Patch')) resourceOps.push('PUT/PATCH');
        if (ops.includes('Delete')) resourceOps.push('DELETE');
      }

      const shortNameMatch = content.match(/shortName:\s*['"](\w+)['"]/);
      const shortName = shortNameMatch ? shortNameMatch[1] : classMatch[1];

      surfaces.push({
        path: path.relative(subproject.root, f),
        symbol: `api_platform:${shortName}`,
        kind: 'api_endpoint',
        lang: 'php',
        startLine: content.slice(0, content.indexOf('ApiResource') || content.indexOf('ApiPlatform')).split('\n').length,
        metadata: {
          type: 'api_platform_resource',
          class: classMatch[1],
          short_name: shortName,
          operations: resourceOps.length > 0 ? resourceOps : ['GET', 'POST', 'PUT', 'DELETE'],
        },
      });
    }
    return surfaces;
  }
}
