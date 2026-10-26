import fs from 'fs';
import path from 'path';
import { globFiles } from '../../utils/glob.js';

export class ProtobufDetector {
  async detect(subproject) {
    const surfaces = [];
    const protoFiles = await globFiles(
      ['**/*.proto'],
      { cwd: subproject.root, absolute: true, ignore: ['**/vendor/**'] }
    );

    for (const f of protoFiles) {
      const content = fs.readFileSync(f, 'utf-8');

      const pkgMatch = content.match(/^package\s+([\w.]+);/m);
      const pkg = pkgMatch ? pkgMatch[1] : null;

      const serviceMatches = content.matchAll(/^service\s+(\w+)\s*\{/gm);
      for (const m of serviceMatches) {
        const serviceName = m[1];
        const startLine = content.slice(0, m.index).split('\n').length;

        const serviceBlock = extractBlock(content, m.index + m[0].length);
        const rpcs = [];
        const rpcMatches = serviceBlock.matchAll(/^\s*rpc\s+(\w+)\s*\(\s*([\w.]+)\s*\)\s*returns\s*\(\s*([\w.]+)\s*\)/gm);
        for (const rpc of rpcMatches) {
          rpcs.push({ name: rpc[1], input: rpc[2], output: rpc[3] });
        }

        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `grpc:${pkg ? pkg + '.' : ''}${serviceName}`,
          kind: 'api_endpoint',
          lang: 'protobuf',
          startLine,
          metadata: {
            type: 'grpc_service',
            service: serviceName,
            package: pkg,
            rpcs,
          },
        });
      }

      const messageMatches = content.matchAll(/^message\s+(\w+)\s*\{/gm);
      for (const m of messageMatches) {
        surfaces.push({
          path: path.relative(subproject.root, f),
          symbol: `proto:${pkg ? pkg + '.' : ''}${m[1]}`,
          kind: 'class',
          lang: 'protobuf',
          startLine: content.slice(0, m.index).split('\n').length,
          metadata: { type: 'proto_message', name: m[1], package: pkg },
        });
      }
    }
    return surfaces;
  }
}

function extractBlock(content, startIndex) {
  let depth = 1;
  let i = startIndex;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }
  return content.slice(startIndex, i - 1);
}
