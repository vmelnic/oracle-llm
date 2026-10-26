import path from 'path';
import { globFiles } from '../../utils/glob.js';

export class OpenApiDetector {
  async detect(subproject) {
    const patterns = [
      'openapi.{json,yaml,yml}',
      'swagger.{json,yaml,yml}',
      '**/openapi.{json,yaml,yml}',
      '**/swagger.{json,yaml,yml}',
    ];
    const files = await globFiles(patterns, { cwd: subproject.root, absolute: true });
    return files.map(f => ({
      path: path.relative(subproject.root, f),
      symbol: `openapi:${path.basename(f)}`,
      kind: 'api_endpoint',
      lang: subproject.language,
      metadata: { type: 'openapi', file: path.basename(f) },
    }));
  }
}
