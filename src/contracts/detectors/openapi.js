import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

export class OpenApiDetector {
  async detect(subproject) {
    const patterns = [
      'openapi.{json,yaml,yml}',
      'swagger.{json,yaml,yml}',
      '**/openapi.{json,yaml,yml}',
      '**/swagger.{json,yaml,yml}',
    ];
    const files = await fg(patterns, { cwd: subproject.root, absolute: true });
    return files.map(f => ({
      path: path.relative(subproject.root, f),
      symbol: `openapi:${path.basename(f)}`,
      kind: 'api_endpoint',
      lang: subproject.language,
      metadata: { type: 'openapi', file: path.basename(f) },
    }));
  }
}
