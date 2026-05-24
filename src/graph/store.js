import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NODE_KINDS = new Set([
  'function', 'class', 'method', 'route', 'component', 'store', 'migration',
  'db_table', 'api_endpoint', 'event', 'config_key', 'env_var', 'interface',
  'type_alias', 'trait', 'mixin', 'property', 'decorator', 'hook', 'provider',
  'directive', 'pipe', 'module', 'enum', 'doc_section',
]);

const EDGE_KINDS = new Set([
  'calls', 'imports', 'reexports', 'queries', 'renders', 'depends_on', 'fires_event',
  'consumes_event', 'migrates_table', 'serves_route', 'implements', 'extends',
  'uses_trait', 'provides', 'injects', 'type_references', 'reads_config',
]);

export class GraphStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createSchema();
    this._prepareStatements();
  }

  _createSchema() {
    const schemaPath = join(__dirname, 'schema.sql');
    const sql = readFileSync(schemaPath, 'utf-8');
    this.db.exec(sql);
  }

  _prepareStatements() {
    this._stmts = {
      upsertNode: this.db.prepare(`
        INSERT INTO nodes (subproject_id, path, lang, symbol, kind, parent_id, start_line, end_line, exported, signature, doc, commit_sha, file_blob_hash, metadata)
        VALUES (@subprojectId, @path, @lang, @symbol, @kind, @parentId, @startLine, @endLine, @exported, @signature, @doc, @commitSha, @fileBlobHash, @metadata)
        ON CONFLICT(subproject_id, path, symbol, kind, start_line)
        DO UPDATE SET
          lang = excluded.lang,
          parent_id = excluded.parent_id,
          end_line = excluded.end_line,
          exported = excluded.exported,
          signature = excluded.signature,
          doc = excluded.doc,
          commit_sha = excluded.commit_sha,
          file_blob_hash = excluded.file_blob_hash,
          metadata = excluded.metadata
        RETURNING id
      `),

      getNode: this.db.prepare(`SELECT * FROM nodes WHERE id = ?`),

      getNodesByFile: this.db.prepare(`
        SELECT * FROM nodes WHERE subproject_id = ? AND path = ?
      `),

      deleteNodesByFile: this.db.prepare(`
        DELETE FROM nodes WHERE subproject_id = ? AND path = ?
      `),

      upsertEdge: this.db.prepare(`
        INSERT INTO edges (subproject_id, source_id, target_id, kind, metadata)
        VALUES (@subprojectId, @sourceId, @targetId, @kind, @metadata)
        ON CONFLICT(subproject_id, source_id, target_id, kind)
        DO UPDATE SET metadata = excluded.metadata
        RETURNING id
      `),

      getConsumers: this.db.prepare(`
        SELECT n.* FROM nodes n
        JOIN edges e ON e.source_id = n.id
        WHERE e.target_id = ?
      `),

      getProducers: this.db.prepare(`
        SELECT e.*, n.symbol AS target_symbol, n.kind AS target_kind, n.path AS target_path
        FROM edges e
        JOIN nodes n ON e.target_id = n.id
        WHERE e.source_id = ?
      `),

      deleteEdgesByFile: this.db.prepare(`
        DELETE FROM edges WHERE source_id IN (
          SELECT id FROM nodes WHERE subproject_id = ? AND path = ?
        )
      `),

      getFileHash: this.db.prepare(`
        SELECT blob_hash FROM file_hashes WHERE subproject_id = ? AND path = ?
      `),

      setFileHash: this.db.prepare(`
        INSERT INTO file_hashes (subproject_id, path, blob_hash, last_indexed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(subproject_id, path)
        DO UPDATE SET blob_hash = excluded.blob_hash, last_indexed_at = excluded.last_indexed_at
      `),

      getSymbolsInRange: this.db.prepare(`
        SELECT * FROM nodes
        WHERE subproject_id = ? AND path = ?
          AND start_line <= ? AND end_line >= ?
        ORDER BY start_line
      `),

      clearSubproject: this.db.prepare(`DELETE FROM edges WHERE subproject_id = ?`),
      clearSubprojectNodes: this.db.prepare(`DELETE FROM nodes WHERE subproject_id = ?`),
      clearSubprojectHashes: this.db.prepare(`DELETE FROM file_hashes WHERE subproject_id = ?`),

      countNodesByKind: this.db.prepare(`
        SELECT kind, COUNT(*) as count FROM nodes WHERE subproject_id = ? GROUP BY kind
      `),
      countEdgesByKind: this.db.prepare(`
        SELECT kind, COUNT(*) as count FROM edges WHERE subproject_id = ? GROUP BY kind
      `),

      locateBySymbol: this.db.prepare(`
        SELECT n.*, (
          SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id
        ) AS ref_count
        FROM nodes n
        WHERE n.subproject_id = ? AND n.symbol = ?
        ORDER BY ref_count DESC
      `),
      locateBySymbolAndKind: this.db.prepare(`
        SELECT n.*, (
          SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id
        ) AS ref_count
        FROM nodes n
        WHERE n.subproject_id = ? AND n.symbol = ? AND n.kind = ?
        ORDER BY ref_count DESC
      `),
      locateBySuffix: this.db.prepare(`
        SELECT n.*, (
          SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id
        ) AS ref_count
        FROM nodes n
        WHERE n.subproject_id = ? AND n.symbol LIKE ?
        ORDER BY ref_count DESC
        LIMIT 10
      `),
      locateBySuffixAndKind: this.db.prepare(`
        SELECT n.*, (
          SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id
        ) AS ref_count
        FROM nodes n
        WHERE n.subproject_id = ? AND n.symbol LIKE ? AND n.kind = ?
        ORDER BY ref_count DESC
        LIMIT 10
      `),

      consumersOneHop: this.db.prepare(`
        SELECT DISTINCT n.id, n.subproject_id, n.path, n.lang, n.symbol, n.kind,
               n.parent_id, n.start_line, n.end_line, n.exported, n.signature, n.doc,
               n.commit_sha, n.file_blob_hash, n.metadata,
               e.kind AS edge_kind
        FROM edges e
        JOIN nodes n ON e.source_id = n.id
        WHERE e.target_id = ?
      `),

      impactOneHop: this.db.prepare(`
        SELECT DISTINCT n.id, n.subproject_id, n.path, n.lang, n.symbol, n.kind,
               n.parent_id, n.start_line, n.end_line, n.exported, n.signature, n.doc,
               n.commit_sha, n.file_blob_hash, n.metadata,
               e.kind AS edge_kind
        FROM edges e
        JOIN nodes n ON e.source_id = n.id
        WHERE e.target_id = ?
      `),
    };
  }

  // ── Node operations ──

  upsertNode(node) {
    const row = this._stmts.upsertNode.get(this._normalizeNode(node));
    return row.id;
  }

  upsertNodes(nodes) {
    const insert = this.db.transaction((items) => {
      const ids = [];
      for (const node of items) {
        const row = this._stmts.upsertNode.get(this._normalizeNode(node));
        ids.push(row.id);
      }
      return ids;
    });
    return insert(nodes);
  }

  findNodes({ subprojectId, symbol, kind, path, exported }) {
    const clauses = ['subproject_id = @subprojectId'];
    const params = { subprojectId };

    if (symbol !== undefined) {
      clauses.push('symbol = @symbol');
      params.symbol = symbol;
    }
    if (kind !== undefined) {
      clauses.push('kind = @kind');
      params.kind = kind;
    }
    if (path !== undefined) {
      clauses.push('path = @path');
      params.path = path;
    }
    if (exported !== undefined) {
      clauses.push('exported = @exported');
      params.exported = exported ? 1 : 0;
    }

    const sql = `SELECT * FROM nodes WHERE ${clauses.join(' AND ')}`;
    return this.db.prepare(sql).all(params);
  }

  getNode(id) {
    return this._stmts.getNode.get(id) ?? null;
  }

  getNodesByFile(subprojectId, path) {
    return this._stmts.getNodesByFile.all(subprojectId, path);
  }

  deleteNodesByFile(subprojectId, path) {
    return this._stmts.deleteNodesByFile.run(subprojectId, path);
  }

  updateNodeMetadata(nodeId, metadata) {
    this.db.prepare('UPDATE nodes SET metadata = ? WHERE id = ?').run(metadata, nodeId);
  }

  // ── Edge operations ──

  upsertEdge(edge) {
    const row = this._stmts.upsertEdge.get(this._normalizeEdge(edge));
    return row.id;
  }

  upsertEdges(edges) {
    const insert = this.db.transaction((items) => {
      const ids = [];
      for (const edge of items) {
        const row = this._stmts.upsertEdge.get(this._normalizeEdge(edge));
        ids.push(row.id);
      }
      return ids;
    });
    return insert(edges);
  }

  findEdges({ subprojectId, sourceId, targetId, kind }) {
    const clauses = ['subproject_id = @subprojectId'];
    const params = { subprojectId };

    if (sourceId !== undefined) {
      clauses.push('source_id = @sourceId');
      params.sourceId = sourceId;
    }
    if (targetId !== undefined) {
      clauses.push('target_id = @targetId');
      params.targetId = targetId;
    }
    if (kind !== undefined) {
      clauses.push('kind = @kind');
      params.kind = kind;
    }

    const sql = `SELECT * FROM edges WHERE ${clauses.join(' AND ')}`;
    return this.db.prepare(sql).all(params);
  }

  getConsumers(nodeId) {
    return this._stmts.getConsumers.all(nodeId);
  }

  getProducers(nodeId) {
    return this._stmts.getProducers.all(nodeId);
  }

  deleteEdgesByFile(subprojectId, path) {
    return this._stmts.deleteEdgesByFile.run(subprojectId, path);
  }

  // ── File hash operations ──

  getFileHash(subprojectId, path) {
    const row = this._stmts.getFileHash.get(subprojectId, path);
    return row ? row.blob_hash : null;
  }

  setFileHash(subprojectId, path, blobHash) {
    this._stmts.setFileHash.run(subprojectId, path, blobHash, new Date().toISOString());
  }

  getStaleFiles(subprojectId, fileHashes) {
    const stale = [];
    for (const { path, blobHash } of fileHashes) {
      const stored = this.getFileHash(subprojectId, path);
      if (stored !== blobHash) {
        stale.push(path);
      }
    }
    return stale;
  }

  // ── Graph queries (for MCP tools) ──

  locate(subprojectId, symbol, kind) {
    if (kind) {
      const exact = this._stmts.locateBySymbolAndKind.all(subprojectId, symbol, kind);
      if (exact.length > 0) return exact;
      return this._stmts.locateBySuffixAndKind.all(subprojectId, `%\\${symbol}`, kind);
    }
    const exact = this._stmts.locateBySymbol.all(subprojectId, symbol);
    if (exact.length > 0) return exact;
    return this._stmts.locateBySuffix.all(subprojectId, `%\\${symbol}`);
  }

  consumers(subprojectId, nodeId, maxDepth = parseInt(process.env.ORACLE_MAX_DEPTH || '5', 10)) {
    const visited = new Set();
    const result = [];
    let frontier = [nodeId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier = [];
      for (const nid of frontier) {
        if (visited.has(nid)) continue;
        visited.add(nid);

        const rows = this._stmts.consumersOneHop.all(nid);
        for (const row of rows) {
          if (!visited.has(row.id)) {
            result.push({ ...row, depth: depth + 1 });
            nextFrontier.push(row.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    return result;
  }

  impact(subprojectId, nodeIds) {
    const visited = new Set(nodeIds);
    const result = [];
    let frontier = [...nodeIds];
    const maxDepth = parseInt(process.env.ORACLE_MAX_DEPTH || '5', 10);

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier = [];
      for (const nid of frontier) {
        const rows = this._stmts.impactOneHop.all(nid);
        for (const row of rows) {
          if (!visited.has(row.id)) {
            visited.add(row.id);
            result.push({ ...row, depth: depth + 1 });
            nextFrontier.push(row.id);
          }
        }
      }
      frontier = nextFrontier;
    }

    return result;
  }

  getSymbolsInRange(subprojectId, path, startLine, endLine) {
    return this._stmts.getSymbolsInRange.all(subprojectId, path, endLine, startLine);
  }

  // ── Utility ──

  close() {
    this.db.close();
  }

  clear(subprojectId) {
    const run = this.db.transaction(() => {
      this._stmts.clearSubproject.run(subprojectId);
      this._stmts.clearSubprojectNodes.run(subprojectId);
      this._stmts.clearSubprojectHashes.run(subprojectId);
    });
    run();
  }

  stats(subprojectId) {
    const nodeRows = this._stmts.countNodesByKind.all(subprojectId);
    const edgeRows = this._stmts.countEdgesByKind.all(subprojectId);

    const nodes = {};
    let totalNodes = 0;
    for (const row of nodeRows) {
      nodes[row.kind] = row.count;
      totalNodes += row.count;
    }

    const edges = {};
    let totalEdges = 0;
    for (const row of edgeRows) {
      edges[row.kind] = row.count;
      totalEdges += row.count;
    }

    return { totalNodes, totalEdges, nodes, edges };
  }

  // ── Internal ──

  _normalizeNode(node) {
    return {
      subprojectId: node.subprojectId ?? node.subproject_id,
      path: node.path,
      lang: node.lang,
      symbol: node.symbol,
      kind: node.kind,
      parentId: node.parentId ?? node.parent_id ?? null,
      startLine: node.startLine ?? node.start_line,
      endLine: node.endLine ?? node.end_line,
      exported: node.exported ? 1 : 0,
      signature: node.signature ?? null,
      doc: node.doc ?? null,
      commitSha: node.commitSha ?? node.commit_sha ?? null,
      fileBlobHash: node.fileBlobHash ?? node.file_blob_hash ?? null,
      metadata: node.metadata ? (typeof node.metadata === 'string' ? node.metadata : JSON.stringify(node.metadata)) : null,
    };
  }

  _normalizeEdge(edge) {
    return {
      subprojectId: edge.subprojectId,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
    };
  }
}
