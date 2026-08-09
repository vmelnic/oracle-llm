import fs from 'fs';
import path from 'path';
import { GraphStore } from '../graph/store.js';
import { PatternCatalogue } from '../patterns/index.js';
import { ManifestDrafter } from '../manifest/index.js';
import { L2Index } from '../retrieval/index.js';
import { GroundingWrapper } from '../grounding/index.js';
import { estimateToonSavings } from '../grounding/toon.js';
import { createParser } from '../parser/index.js';
import { getSubprojectDir } from '../scanner/workspace.js';

import { context } from '../mcp/tools/context.js';
import { locate } from '../mcp/tools/locate.js';
import { impact } from '../mcp/tools/impact.js';
import { consumers } from '../mcp/tools/consumers.js';
import { conventionsFor } from '../mcp/tools/conventions-for.js';
import { pattern } from '../mcp/tools/pattern.js';

const TOOL_MAP = {
  'oracle.context': context,
  'oracle.locate': locate,
  'oracle.impact': impact,
  'oracle.consumers': consumers,
  'oracle.conventions_for': conventionsFor,
  'oracle.pattern': pattern,
};

export function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(str.length / 4);
}

export class BenchmarkRunner {
  constructor(workspace, subprojectId) {
    this.workspace = workspace;
    this.subprojectId = subprojectId;
    this.subproject = workspace.subprojects.find(s => s.id === subprojectId);
    this.results = [];
    this.ctx = null;
  }

  _loadContext() {
    if (this.ctx) return this.ctx;

    const dir = getSubprojectDir(this.workspace.id, this.subprojectId);
    const dbPath = path.join(dir, 'entity_graph.sqlite');
    const store = new GraphStore(dbPath);

    const catalogue = new PatternCatalogue(store);
    const cataloguePath = path.join(dir, 'pattern_catalog.json');
    if (fs.existsSync(cataloguePath)) catalogue.load(cataloguePath);

    const drafter = new ManifestDrafter();
    const manifest = drafter.load(path.join(dir, 'manifest.yaml')) || {};

    const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index.json') });
    l2.load();

    const parser = createParser();

    this.ctx = {
      store,
      subproject: this.subproject,
      grounding: new GroundingWrapper(store, { parser, subprojectRoot: this.subproject.root }),
      workspace: this.workspace,
      patterns: catalogue,
      manifest,
      l2,
      l3: null,
      weightsPatch: null,
    };
    return this.ctx;
  }

  async runTask(task) {
    const ctx = this._loadContext();
    const entry = {
      task: task.description,
      tool: task.tool || 'oracle.context',
      toolArgs: task.args || { task: task.description },
      oracleTokens: 0,
      baselineTokens: 0,
      reductionRatio: 0,
      oracleLatencyMs: 0,
      evidenceCount: 0,
      evidenceVerified: 0,
      confidence: 0,
      layer: null,
    };

    const handler = TOOL_MAP[entry.tool];
    if (!handler) {
      entry.error = `Unknown tool: ${entry.tool}`;
      this.results.push(entry);
      return entry;
    }

    const start = performance.now();
    try {
      const raw = await handler(ctx, entry.toolArgs);
      entry.oracleLatencyMs = Math.round(performance.now() - start);

      if (raw?.evidence) {
        for (const e of raw.evidence) {
          if (!e.subproject_root) e.subproject_root = ctx.subproject?.root;
        }
      }

      const grounded = ctx.grounding.wrap(raw, entry.tool);
      entry.oracleTokens = estimateTokens(grounded);
      entry.confidence = grounded.confidence || 0;
      entry.layer = grounded.layer || 'L1';

      const evidence = grounded.evidence || [];
      const unverifiedCount = grounded.unverified_evidence?.length
        || grounded._unverified_evidence_count
        || 0;
      entry.evidenceCount = evidence.length + unverifiedCount;
      entry.evidenceVerified = evidence.length;

      const seenFiles = new Set();
      let baselineTokens = 0;
      for (const e of evidence) {
        const filePath = e.path || e.file;
        if (!filePath || seenFiles.has(filePath)) continue;
        seenFiles.add(filePath);
        try {
          const abs = path.isAbsolute(filePath) ? filePath : path.join(ctx.subproject?.root || '', filePath);
          const content = fs.readFileSync(abs, 'utf-8');
          baselineTokens += estimateTokens(content);
        } catch {}
      }
      entry.baselineTokens = baselineTokens;
      entry.reductionRatio = baselineTokens > 0 ? Math.round((baselineTokens / entry.oracleTokens) * 10) / 10 : 0;
    } catch (err) {
      entry.oracleLatencyMs = Math.round(performance.now() - start);
      entry.error = err.message;
    }

    this.results.push(entry);
    return entry;
  }

  async runSuite(tasks) {
    for (const task of tasks) {
      await this.runTask(task);
    }
    return this.summarize();
  }

  summarize() {
    const total = this.results.length;
    if (total === 0) return { total: 0 };

    const successful = this.results.filter(r => !r.error);
    const totalTokens = successful.reduce((sum, r) => sum + r.oracleTokens, 0);
    const totalBaseline = successful.reduce((sum, r) => sum + r.baselineTokens, 0);
    const totalLatency = successful.reduce((sum, r) => sum + r.oracleLatencyMs, 0);
    const totalEvidence = successful.reduce((sum, r) => sum + r.evidenceCount, 0);
    const totalVerified = successful.reduce((sum, r) => sum + r.evidenceVerified, 0);
    const avgConfidence = successful.reduce((sum, r) => sum + r.confidence, 0) / (successful.length || 1);
    const avgReduction = successful.length > 0
      ? Math.round(successful.reduce((sum, r) => sum + r.reductionRatio, 0) / successful.length * 10) / 10
      : 0;

    return {
      total,
      successful: successful.length,
      errors: total - successful.length,
      avgTokensPerQuery: Math.round(totalTokens / (successful.length || 1)),
      avgBaselineTokensPerQuery: Math.round(totalBaseline / (successful.length || 1)),
      avgReductionRatio: avgReduction,
      avgLatencyMs: Math.round(totalLatency / (successful.length || 1)),
      totalEvidencePointers: totalEvidence,
      evidenceVerificationRate: totalEvidence > 0 ? Math.round((totalVerified / totalEvidence) * 1000) / 1000 : 1.0,
      avgConfidence: Math.round(avgConfidence * 1000) / 1000,
      toonSavings: estimateToonSavings({ results: successful }),
      results: this.results,
    };
  }

  close() {
    if (this.ctx?.store) this.ctx.store.close();
  }
}

export function generateDefaultTasks(store, subprojectId) {
  const tasks = [];

  const functions = store.findNodes({ subprojectId, kind: 'function' }).slice(0, 3);
  for (const fn of functions) {
    tasks.push({
      description: `Where is ${fn.symbol} defined?`,
      tool: 'oracle.locate',
      args: { symbol: fn.symbol },
    });
  }

  const routes = store.findNodes({ subprojectId, kind: 'route' }).slice(0, 2);
  for (const r of routes) {
    tasks.push({
      description: `Show route ${r.symbol} and related code`,
      tool: 'oracle.context',
      args: { task: `Show the route definition for ${r.symbol}` },
    });
  }

  const tables = store.findNodes({ subprojectId, kind: 'db_table' }).slice(0, 2);
  for (const t of tables) {
    tasks.push({
      description: `Impact of adding a column to ${t.symbol}`,
      tool: 'oracle.impact',
      args: { change: `Add status column to ${t.symbol}` },
    });
  }

  tasks.push({
    description: 'What are the error handling patterns?',
    tool: 'oracle.conventions_for',
    args: { topic: 'errors' },
  });

  tasks.push({
    description: 'What are the routing patterns?',
    tool: 'oracle.conventions_for',
    args: { topic: 'routing' },
  });

  return tasks;
}
