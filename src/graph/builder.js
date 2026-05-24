import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, join, dirname, resolve, extname } from 'node:path';
import { execSync } from 'child_process';
import fg from 'fast-glob';

const extractorCache = new Map();

const EXTRACTOR_ALIAS = {
  tsx: 'typescript',
  py: 'python',
  vue: 'javascript',
};

async function loadExtractor(language) {
  const extractorName = EXTRACTOR_ALIAS[language] || language;
  if (extractorCache.has(extractorName)) return extractorCache.get(extractorName);

  try {
    const mod = await import(`./extractors/${extractorName}.js`);
    extractorCache.set(extractorName, mod);
    return mod;
  } catch {
    extractorCache.set(extractorName, null);
    return null;
  }
}

function blobHash(content) {
  return createHash('sha1').update(content).digest('hex');
}

export async function buildGraph(subproject, parserManager, store, { onlyFiles } = {}) {
  const { id: subprojectId, root, language, includeGlobs, excludeGlobs } = subproject;

  let commitSha = null;
  try {
    commitSha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {}

  let files;
  if (onlyFiles && onlyFiles.length > 0) {
    files = [];
    for (const rel of onlyFiles) {
      const absPath = join(root, rel);
      try {
        const stat = await import('node:fs').then(fs => fs.promises.stat(absPath));
        if (stat.isFile()) files.push(absPath);
      } catch {}
    }
  } else {
    files = await fg(includeGlobs, {
      cwd: root,
      ignore: excludeGlobs,
      absolute: true,
      onlyFiles: true,
      dot: false,
    });
  }

  const fileHashes = await Promise.all(
    files.map(async (absPath) => {
      const content = await readFile(absPath, 'utf-8');
      const relPath = relative(root, absPath);
      return { absPath, relPath, content, blobHash: blobHash(content) };
    })
  );

  const staleSet = new Set(
    store.getStaleFiles(
      subprojectId,
      fileHashes.map(f => ({ path: f.relPath, blobHash: f.blobHash }))
    )
  );

  let filesProcessed = 0;
  let nodesCreated = 0;
  let edgesCreated = 0;
  let skipped = 0;
  const deferredEdges = [];

  for (const file of fileHashes) {
    if (!staleSet.has(file.relPath)) {
      skipped++;
      continue;
    }

    const lang = parserManager.languageFor(file.absPath);
    if (!lang) {
      skipped++;
      continue;
    }

    const extractor = await loadExtractor(lang);
    if (!extractor) {
      skipped++;
      continue;
    }

    let tree;
    try {
      tree = parserManager.parse(file.content, lang);
    } catch {
      skipped++;
      continue;
    }

    store.deleteEdgesByFile(subprojectId, file.relPath);
    store.deleteNodesByFile(subprojectId, file.relPath);

    let nodes, edges;
    try {
      ({ nodes, edges } = extractor.extract(tree, file.relPath, subprojectId));
    } catch {
      skipped++;
      continue;
    }

    const sqlNodes = extractSqlTables(file.content, file.relPath, subprojectId);
    if (sqlNodes.length > 0) nodes.push(...sqlNodes);

    if (nodes.length > 0) {
      const nodeIds = store.upsertNodes(
        nodes.map(n => ({
          ...n,
          subprojectId,
          path: file.relPath,
          lang,
          fileBlobHash: file.blobHash,
          commitSha: n.commitSha ?? commitSha,
        }))
      );

      if (edges.length > 0) {
        const localSymbolMap = new Map();
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          localSymbolMap.set(`${n.symbol}::${n.kind}`, nodeIds[i]);
          localSymbolMap.set(n.symbol, nodeIds[i]);
        }

        const resolvedEdges = edges.map(e => {
          let sourceId = typeof e.sourceIndex === 'number' ? nodeIds[e.sourceIndex] : e.sourceId;
          let targetId = typeof e.targetIndex === 'number' ? nodeIds[e.targetIndex] : e.targetId;

          if (sourceId == null && e.source_symbol) {
            sourceId = localSymbolMap.get(`${e.source_symbol}::${e.source_kind}`)
              || localSymbolMap.get(e.source_symbol)
              || resolveSymbolId(store, subprojectId, e.source_symbol, e.source_kind);

            if (sourceId == null && e.source_kind === 'file' && e.source_symbol === file.relPath) {
              const fileNodes = store.getNodesByFile(subprojectId, file.relPath);
              const exported = fileNodes.find(n => n.exported);
              if (exported) sourceId = exported.id;
              else if (fileNodes.length > 0) sourceId = fileNodes[0].id;
            }
          }
          if (targetId == null && e.target_symbol) {
            targetId = localSymbolMap.get(`${e.target_symbol}::${e.target_kind}`)
              || localSymbolMap.get(e.target_symbol)
              || resolveSymbolId(store, subprojectId, e.target_symbol, e.target_kind);

            if (targetId == null && (e.kind === 'imports' || e.kind === 'depends_on') && e.target_symbol.startsWith('.')) {
              targetId = resolveModulePath(store, subprojectId, file.relPath, e.target_symbol, e.metadata);
            }
          }

          return { ...e, subprojectId, sourceId, targetId };
        });

        const validEdges = resolvedEdges.filter(e => e.sourceId != null && e.targetId != null);
        if (validEdges.length > 0) {
          store.upsertEdges(validEdges);
          edgesCreated += validEdges.length;
        }

        const unresolvedEdges = resolvedEdges.filter(e => (e.sourceId == null || e.targetId == null) && e.target_symbol);
        for (const e of unresolvedEdges) {
          deferredEdges.push({ ...e, _sourceFile: file.relPath });
        }
      }

      nodesCreated += nodeIds.length;
    }

    store.setFileHash(subprojectId, file.relPath, file.blobHash);
    filesProcessed++;
  }

  if (deferredEdges.length > 0) {
    let deferredResolved = 0;
    for (const e of deferredEdges) {
      let { sourceId, targetId } = e;

      if (sourceId == null && e.source_symbol) {
        sourceId = resolveSymbolId(store, subprojectId, e.source_symbol, e.source_kind);
        if (sourceId == null && e.source_kind === 'file') {
          const fileNodes = store.getNodesByFile(subprojectId, e._sourceFile);
          const exported = fileNodes.find(n => n.exported);
          if (exported) sourceId = exported.id;
          else if (fileNodes.length > 0) sourceId = fileNodes[0].id;
        }
      }

      if (targetId == null && e.target_symbol) {
        targetId = resolveSymbolId(store, subprojectId, e.target_symbol, e.target_kind);
        if (targetId == null && (e.kind === 'imports' || e.kind === 'depends_on') && e.target_symbol.startsWith('.')) {
          targetId = resolveModulePath(store, subprojectId, e._sourceFile, e.target_symbol, e.metadata);
        }
      }

      if (sourceId != null && targetId != null) {
        store.upsertEdges([{ ...e, subprojectId, sourceId, targetId }]);
        edgesCreated++;
        deferredResolved++;
      }
    }
  }

  return { filesProcessed, nodesCreated, edgesCreated, skipped };
}

function resolveSymbolId(store, subprojectId, symbol, kind) {
  const rows = kind
    ? store.locate(subprojectId, symbol, kind)
    : store.locate(subprojectId, symbol);
  return rows.length > 0 ? rows[0].id : null;
}

function extractSqlTables(content, filePath, subprojectId) {
  const nodes = [];
  const tableColumns = new Map();

  // Phase 1: extract tables with static column lists
  const patterns = [
    { re: /INSERT\s+INTO\s+[`"']?(\w+)[`"']?\s*\(([^)]+)\)/gi, type: 'insert' },
    { re: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi, type: 'create' },
  ];

  for (const { re, type } of patterns) {
    let m;
    while ((m = re.exec(content))) {
      const table = m[1];
      const colBlock = m[2];

      // Skip dynamic column lists like ${fields.join()}
      if (/\$\{/.test(colBlock)) continue;

      const columns = parseColumns(colBlock, type === 'insert');
      if (columns.length === 0) continue;

      const existing = tableColumns.get(table);
      if (!existing || columns.length > existing.columns.length) {
        tableColumns.set(table, { columns, index: m.index, type });
      }
    }
  }

  // Phase 2: extract UPDATE SET columns for tables not yet found
  const updateRe = /UPDATE\s+[`"']?(\w+)[`"']?\s+SET\s+([^WHERE]+?)(?:\s+WHERE|\s+RETURNING|\s*$)/gi;
  let um;
  while ((um = updateRe.exec(content))) {
    const table = um[1];
    if (tableColumns.has(table)) continue;

    const setBlock = um[2];
    if (/\$\{/.test(setBlock)) continue;

    const columns = setBlock
      .split(',')
      .map(c => c.trim().split(/\s*=\s*/)[0].replace(/[`"']/g, ''))
      .filter(c => c && /^\w+$/.test(c))
      .map(name => ({ name }));

    if (columns.length > 0) {
      tableColumns.set(table, { columns, index: um.index, type: 'update' });
    }
  }

  // Phase 3: tables referenced but only with dynamic columns — record table name only
  const dynInsertRe = /INSERT\s+INTO\s+[`"']?(\w+)[`"']?\s*\(/gi;
  let dm;
  while ((dm = dynInsertRe.exec(content))) {
    const table = dm[1];
    if (!tableColumns.has(table)) {
      tableColumns.set(table, { columns: [], index: dm.index, type: 'dynamic' });
    }
  }

  for (const [table, { columns, index }] of tableColumns) {
    const lineNum = content.slice(0, index).split('\n').length;
    const sig = columns.length > 0
      ? `${table}(${columns.map(c => c.name).join(', ')})`
      : table;

    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'sql',
      symbol: table,
      kind: 'db_table',
      parent_symbol: null,
      start_line: lineNum,
      end_line: lineNum,
      exported: false,
      signature: sig,
      doc: null,
      metadata: columns.length > 0 ? { columns } : null,
    });
  }

  return nodes;
}

function parseColumns(block, isInsert) {
  if (isInsert) {
    return block
      .split(',')
      .map(c => c.trim().replace(/[`"']/g, ''))
      .filter(Boolean)
      .map(name => ({ name }));
  }

  const columns = [];
  for (const line of block.split(',')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX)\s/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const name = parts[0].replace(/[`"']/g, '');
      const type = parts[1].replace(/[`"']/g, '');
      if (name && !/^[($]/.test(name)) {
        columns.push({ name, type });
      }
    }
  }
  return columns;
}

function resolveModulePath(store, subprojectId, sourceFile, specifier, metadata) {
  const dir = dirname(sourceFile);
  let resolved = resolve('/', dir, specifier).slice(1);

  const extensions = ['.js', '.mjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'];
  const candidates = extname(resolved) ? [resolved] : extensions.map(ext => resolved + ext);

  for (const candidate of candidates) {
    const nodes = store.findNodes({ subprojectId, path: candidate });
    if (nodes.length === 0) continue;

    if (metadata?.names?.length > 0) {
      for (const name of metadata.names) {
        const match = nodes.find(n => n.symbol === name || n.symbol.endsWith('.' + name));
        if (match) return match.id;
      }
    }

    const exported = nodes.filter(n => n.exported);
    if (exported.length > 0) return exported[0].id;
    return nodes[0].id;
  }

  if (metadata?.local) {
    const rows = store.locate(subprojectId, metadata.local);
    if (rows.length > 0) return rows[0].id;
  }

  return null;
}
