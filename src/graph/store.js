import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { applyMigrations, memberName, shortSymbol } from './migrations.js';
import { positiveInt } from '../utils/env.js';

export class GraphStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('wal_autocheckpoint = 1000');
    try {
      applyMigrations(this.db);
    } catch (err) {
      this.db.close();
      throw err;
    }
    const integrity = this.db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') {
      this.db.close();
      throw new Error(`SQLite integrity check failed: ${integrity}`);
    }
    this._prepareStatements();
  }

  async withTransaction(operation) {
    if (this.db.inTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await operation();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (this.db.inTransaction) {
        try { this.db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  }

  /** Runs a synchronous function atomically; nests inside an outer transaction. */
  runInTransaction(operation) {
    return this.db.transaction(operation)();
  }

  _prepareStatements() {
    this._stmts = {
      upsertNode: this.db.prepare(`
        INSERT INTO nodes (subproject_id, path, lang, symbol, kind, parent_id, start_line, end_line, exported, signature, doc, commit_sha, file_blob_hash, metadata, short_symbol, member_name)
        VALUES (@subprojectId, @path, @lang, @symbol, @kind, @parentId, @startLine, @endLine, @exported, @signature, @doc, @commitSha, @fileBlobHash, @metadata, @shortSymbol, @memberName)
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

      deleteNodeById: this.db.prepare(`DELETE FROM nodes WHERE id = ?`),
      parkNode: this.db.prepare(`UPDATE nodes SET start_line = -id WHERE id = ?`),

      updateNodeById: this.db.prepare(`
        UPDATE nodes SET
          subproject_id = @subprojectId, path = @path, lang = @lang, symbol = @symbol,
          kind = @kind, parent_id = @parentId, start_line = @startLine,
          end_line = @endLine, exported = @exported, signature = @signature,
          doc = @doc, commit_sha = @commitSha, file_blob_hash = @fileBlobHash,
          metadata = @metadata, short_symbol = @shortSymbol, member_name = @memberName
        WHERE id = @id
      `),

      upsertEdge: this.db.prepare(`
        INSERT INTO edges (subproject_id, source_id, target_id, kind, metadata)
        VALUES (@subprojectId, @sourceId, @targetId, @kind, @metadata)
        ON CONFLICT(subproject_id, source_id, target_id, kind)
        DO UPDATE SET metadata = excluded.metadata
        RETURNING id
      `),

      // A route uses the handler that serves it: `serves_route` edges point
      // from the handler to the route, so they count in the other direction.
      getConsumers: this.db.prepare(`
        SELECT n.* FROM nodes n
        JOIN edges e ON e.source_id = n.id
        WHERE e.target_id = @id AND e.kind != 'serves_route'
        UNION
        SELECT n.* FROM nodes n
        JOIN edges e ON e.target_id = n.id
        WHERE e.source_id = @id AND e.kind = 'serves_route'
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

      getIndexedFiles: this.db.prepare(`SELECT path FROM file_hashes WHERE subproject_id = ?`),
      getDependentPathsOfFile: this.db.prepare(`
        SELECT DISTINCT s.path FROM nodes t
        JOIN edges e ON e.target_id = t.id
        JOIN nodes s ON s.id = e.source_id
        WHERE t.subproject_id = ? AND t.path = ? AND s.path != t.path
      `),
      getDependentPathsOfNode: this.db.prepare(`
        SELECT DISTINCT s.path FROM edges e
        JOIN nodes s ON s.id = e.source_id
        WHERE e.target_id = ?
      `),
      deleteUnresolvedRefs: this.db.prepare(`DELETE FROM unresolved_refs WHERE subproject_id = ? AND source_path = ?`),
      insertUnresolvedRef: this.db.prepare(`
        INSERT OR IGNORE INTO unresolved_refs (subproject_id, source_path, target_key, ref_kind) VALUES (?, ?, ?, ?)
      `),
      findPathsByRefKind: this.db.prepare(`
        SELECT DISTINCT source_path FROM unresolved_refs WHERE subproject_id = ? AND target_key = ? AND ref_kind = ?
        ORDER BY source_path
      `),
      getMeta: this.db.prepare(`SELECT value FROM graph_meta WHERE key = ?`),
      setMeta: this.db.prepare(`
        INSERT INTO graph_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      findMembersByName: this.db.prepare(`
        SELECT * FROM nodes WHERE subproject_id = ? AND member_name = ? AND kind = ?
        ORDER BY path, start_line
      `),
      findInheritanceParents: this.db.prepare(`
        SELECT n.* FROM edges e JOIN nodes n ON n.id = e.target_id
        WHERE e.source_id = ? AND e.kind IN ('extends', 'implements', 'uses_trait', 'mixin')
        ORDER BY CASE e.kind WHEN 'extends' THEN 0 WHEN 'uses_trait' THEN 1 WHEN 'mixin' THEN 2 ELSE 3 END, n.path, n.start_line
      `),
      findInheritanceChildren: this.db.prepare(`
        SELECT n.* FROM edges e JOIN nodes n ON n.id = e.source_id
        WHERE e.target_id = ? AND e.kind IN ('extends', 'implements', 'uses_trait', 'mixin')
        ORDER BY n.path, n.start_line
      `),
      findPathsByUnresolvedKey: this.db.prepare(`
        SELECT DISTINCT source_path FROM unresolved_refs WHERE subproject_id = ? AND target_key = ?
      `),
      clearSubprojectUnresolvedRefs: this.db.prepare(`DELETE FROM unresolved_refs WHERE subproject_id = ?`),
      deleteFileHash: this.db.prepare(`DELETE FROM file_hashes WHERE subproject_id = ? AND path = ?`),

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
        ORDER BY ref_count DESC, n.path, n.start_line
      `),
      locateBySymbolAndKind: this.db.prepare(`
        SELECT n.*, (
          SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id
        ) AS ref_count
        FROM nodes n
        WHERE n.subproject_id = ? AND n.symbol = ? AND n.kind = ?
        ORDER BY ref_count DESC, n.path, n.start_line
      `),
      locateBySuffix: this.db.prepare(`
        SELECT n.*, (
          SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id
        ) AS ref_count
        FROM nodes n
        WHERE n.subproject_id = ? AND n.short_symbol = ? AND substr(n.symbol, -length(?)) = ?
        ORDER BY ref_count DESC, n.path, n.start_line
        LIMIT 10
      `),
      locateBySuffixAndKind: this.db.prepare(`
        SELECT n.*, (
          SELECT COUNT(*) FROM edges e WHERE e.target_id = n.id
        ) AS ref_count
        FROM nodes n
        WHERE n.subproject_id = ? AND n.short_symbol = ? AND substr(n.symbol, -length(?)) = ? AND n.kind = ?
        ORDER BY ref_count DESC, n.path, n.start_line
        LIMIT 10
      `),

      consumersOneHop: this.db.prepare(`
        SELECT * FROM (
        SELECT DISTINCT n.id, n.subproject_id, n.path, n.lang, n.symbol, n.kind,
               n.parent_id, n.start_line, n.end_line, n.exported, n.signature, n.doc,
               n.commit_sha, n.file_blob_hash, n.metadata,
               e.kind AS edge_kind, e.metadata AS edge_metadata
        FROM edges e
        JOIN nodes n ON e.source_id = n.id
        WHERE e.target_id = @id AND e.kind != 'serves_route'
        UNION
        SELECT DISTINCT n.id, n.subproject_id, n.path, n.lang, n.symbol, n.kind,
               n.parent_id, n.start_line, n.end_line, n.exported, n.signature, n.doc,
               n.commit_sha, n.file_blob_hash, n.metadata,
               e.kind AS edge_kind, e.metadata AS edge_metadata
        FROM edges e
        JOIN nodes n ON e.target_id = n.id
        WHERE e.source_id = @id AND e.kind = 'serves_route'
        )
        ORDER BY CASE edge_kind WHEN 'calls' THEN 0 ELSE 1 END, path, start_line
      `),

      impactOneHop: this.db.prepare(`
        SELECT DISTINCT n.id, n.subproject_id, n.path, n.lang, n.symbol, n.kind,
               n.parent_id, n.start_line, n.end_line, n.exported, n.signature, n.doc,
               n.commit_sha, n.file_blob_hash, n.metadata,
               e.kind AS edge_kind
        FROM edges e
        JOIN nodes n ON e.source_id = n.id
        WHERE e.target_id = @id AND e.kind != 'serves_route'
        UNION
        SELECT DISTINCT n.id, n.subproject_id, n.path, n.lang, n.symbol, n.kind,
               n.parent_id, n.start_line, n.end_line, n.exported, n.signature, n.doc,
               n.commit_sha, n.file_blob_hash, n.metadata,
               e.kind AS edge_kind
        FROM edges e
        JOIN nodes n ON e.target_id = n.id
        WHERE e.source_id = @id AND e.kind = 'serves_route'
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

  replaceNodesByFile(subprojectId, filePath, nodes) {
    const replace = this.db.transaction(() => {
      const existing = this.getNodesByFile(subprojectId, filePath);
      const used = new Set();
      const matches = [];

      for (const node of nodes) {
        const normalized = this._normalizeNode(node);
        let match = existing.find(row => !used.has(row.id)
          && row.symbol === normalized.symbol
          && row.kind === normalized.kind
          && (row.signature || null) === normalized.signature);
        if (!match) {
          match = existing.find(row => !used.has(row.id)
            && row.symbol === normalized.symbol
            && row.kind === normalized.kind);
        }
        if (match) used.add(match.id);
        matches.push({ normalized, match });
      }

      for (const row of existing) {
        if (!used.has(row.id)) this._stmts.deleteNodeById.run(row.id);
      }

      // Kept rows may trade places (two same-named nodes moving past each
      // other): park them on unique temporary lines first, so no update hits
      // the (path, symbol, kind, start_line) key of a row not yet moved.
      for (const { match } of matches) {
        if (match) this._stmts.parkNode.run(match.id);
      }

      const ids = [];
      const byKey = new Map();
      for (const { normalized, match } of matches) {
        // Identical nodes (same key) share one row.
        const key = `${normalized.symbol}\x00${normalized.kind}\x00${normalized.startLine}`;
        if (byKey.has(key)) {
          if (match) this._stmts.deleteNodeById.run(match.id);
          ids.push(byKey.get(key));
          continue;
        }
        let id;
        if (match) {
          this._stmts.updateNodeById.run({ ...normalized, id: match.id });
          id = match.id;
        } else {
          id = this._stmts.upsertNode.get(normalized).id;
        }
        byKey.set(key, id);
        ids.push(id);
      }
      return ids;
    });
    return replace();
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

  deleteNode(nodeId) {
    return this._stmts.deleteNodeById.run(nodeId);
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
    return this._stmts.getConsumers.all({ id: nodeId });
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

  getIndexedFiles(subprojectId) {
    return this._stmts.getIndexedFiles.all(subprojectId).map(row => row.path);
  }

  deleteFileData(subprojectId, filePath) {
    const remove = this.db.transaction(() => {
      this._stmts.deleteEdgesByFile.run(subprojectId, filePath);
      this._stmts.deleteNodesByFile.run(subprojectId, filePath);
      this._stmts.deleteFileHash.run(subprojectId, filePath);
      this._stmts.deleteUnresolvedRefs.run(subprojectId, filePath);
    });
    remove();
  }

  /** Paths of other files with edges into any node of `filePath`. */
  getDependentPathsOfFile(subprojectId, filePath) {
    return this._stmts.getDependentPathsOfFile.all(subprojectId, filePath).map(row => row.path);
  }

  /** Paths of files with edges into any of the given nodes. */
  getDependentPathsOfNodes(nodeIds) {
    const paths = new Set();
    for (const id of nodeIds) {
      for (const row of this._stmts.getDependentPathsOfNode.all(id)) paths.add(row.path);
    }
    return [...paths];
  }

  /**
   * Replaces the name-based references of a file. `refs` holds plain keys
   * (kind 'symbol') or `{ key, kind }` with kind 'symbol' | 'call' | 'soft'.
   */
  setUnresolvedRefs(subprojectId, filePath, refs) {
    const replace = this.db.transaction(() => {
      this._stmts.deleteUnresolvedRefs.run(subprojectId, filePath);
      for (const ref of refs) {
        const { key, kind } = typeof ref === 'string' ? { key: ref, kind: 'symbol' } : ref;
        this._stmts.insertUnresolvedRef.run(subprojectId, filePath, key, kind);
      }
    });
    replace();
  }

  /** Files with method calls named `name` whose receiver type is unknown. */
  findPossibleCallSites(subprojectId, name) {
    return this._stmts.findPathsByRefKind.all(subprojectId, String(name).toLowerCase(), 'call').map(r => r.source_path);
  }

  getMeta(key) {
    return this._stmts.getMeta.get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this._stmts.setMeta.run(key, String(value));
  }

  /** Nodes of `kind` whose last name segment is `name` (`X::save`, `Y.save`). */
  findMembersByName(subprojectId, name, kind = 'method') {
    return this._stmts.findMembersByName.all(subprojectId, name, kind);
  }

  /** Classes, interfaces, traits and `@mixin`s a type extends, implements or uses. */
  getInheritanceParents(nodeId) {
    return this._stmts.findInheritanceParents.all(nodeId);
  }

  /** Types that extend, implement or use the given type. */
  getInheritanceChildren(nodeId) {
    return this._stmts.findInheritanceChildren.all(nodeId);
  }

  /** Files with a name-based reference keyed `key` (of `refKind`, or any). */
  findPathsByUnresolvedKeys(subprojectId, keys, refKind = null) {
    const paths = new Set();
    for (const key of keys) {
      const rows = refKind
        ? this._stmts.findPathsByRefKind.all(subprojectId, key, refKind)
        : this._stmts.findPathsByUnresolvedKey.all(subprojectId, key);
      for (const row of rows) paths.add(row.source_path);
    }
    return [...paths];
  }

  clearEdges(subprojectId) {
    this._stmts.clearSubproject.run(subprojectId);
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
      return this._stmts.locateBySuffixAndKind.all(subprojectId, shortSymbol(symbol), `\\${symbol}`, `\\${symbol}`, kind);
    }
    const exact = this._stmts.locateBySymbol.all(subprojectId, symbol);
    if (exact.length > 0) return exact;
    // Namespace suffix match: `User` finds `App\Models\User`.
    return this._stmts.locateBySuffix.all(subprojectId, shortSymbol(symbol), `\\${symbol}`, `\\${symbol}`);
  }

  consumers(subprojectId, nodeId, maxDepth = positiveInt(process.env.ORACLE_MAX_DEPTH, 5)) {
    const maxResults = positiveInt(process.env.ORACLE_MAX_TRAVERSAL_RESULTS, 1000);
    const visited = new Set([nodeId]);
    const result = [];
    let frontier = [nodeId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier = [];
      for (const nid of frontier) {
        for (const row of this._stmts.consumersOneHop.all({ id: nid })) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          result.push({ ...row, depth: depth + 1 });
          if (result.length >= maxResults) return result;
          nextFrontier.push(row.id);
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
    const maxDepth = positiveInt(process.env.ORACLE_MAX_DEPTH, 5);
    const maxResults = positiveInt(process.env.ORACLE_MAX_TRAVERSAL_RESULTS, 1000);

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier = [];
      for (const nid of frontier) {
        const rows = this._stmts.impactOneHop.all({ id: nid });
        for (const row of rows) {
          if (!visited.has(row.id)) {
            visited.add(row.id);
            result.push({ ...row, depth: depth + 1 });
            if (result.length >= maxResults) return result;
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
      this._stmts.clearSubprojectUnresolvedRefs.run(subprojectId);
    });
    run();
  }

  /** Marks every file of the subproject stale so the next build re-extracts it. */
  forgetFileHashes(subprojectId) {
    this._stmts.clearSubprojectHashes.run(subprojectId);
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
      shortSymbol: shortSymbol(node.symbol),
      memberName: memberName(node.symbol),
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
