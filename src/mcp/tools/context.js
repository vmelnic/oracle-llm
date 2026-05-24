import path from 'path';
import { whereWould } from './where-would.js';
import { conventionsFor } from './conventions-for.js';
import { pattern as patternTool } from './pattern.js';
import { impact as impactTool } from './impact.js';

export async function context(ctx, { task }) {
  const { store, subproject, patterns, manifest, l2 } = ctx;

  if (!task) {
    return {
      answer: {
        existing: [],
        create: [],
        modify: [],
        db: { tables: [], columns: [] },
        pattern: null,
        conventions: [],
        relevant_code: [],
      },
      evidence: [],
      layer: 'L1',
    };
  }

  const subId = subproject?.id ?? subproject;
  const keywords = extractKeywords(task);
  const allNodes = store.findNodes({ subprojectId: subId });

  let matchingNodes = findMatchingNodes(allNodes, keywords);

  if (l2 && l2.isLoaded()) {
    const l2Results = await l2.search(task, { limit: 20 });
    const maxBm25 = l2Results.length > 0 ? l2Results[0].score : 1;
    for (const r of l2Results) {
      const normalizedScore = (r.score / (maxBm25 || 1)) * 10;
      const existing = matchingNodes.find((n) => n.id === r.node.id);
      if (existing) {
        existing._score += normalizedScore;
        existing._layer = 'L1+L2';
      } else {
        const full = allNodes.find((n) => n.id === r.node.id) || r.node;
        matchingNodes.push({ ...full, _score: normalizedScore, _layer: 'L2' });
      }
    }
    matchingNodes.sort((a, b) => b._score - a._score);
  }

  matchingNodes = graphRerank(store, matchingNodes, allNodes);

  const existing = matchingNodes.slice(0, 20).map((n) => ({
    path: n.path,
    role: n.kind,
    symbols: [n.symbol],
  }));

  const existingByPath = new Map();
  for (const entry of existing) {
    if (existingByPath.has(entry.path)) {
      existingByPath.get(entry.path).symbols.push(...entry.symbols);
    } else {
      existingByPath.set(entry.path, { ...entry });
    }
  }
  const dedupedExisting = [...existingByPath.values()];

  const whereResult = whereWould(ctx, { intent: task });
  const create = whereResult.answer.proposed_paths || [];

  const modify = [];
  for (const node of matchingNodes.slice(0, 10)) {
    const consumers = store.getConsumers(node.id);
    if (consumers.length > 0) {
      modify.push({
        path: node.path,
        changes: `${node.symbol} has ${consumers.length} consumer(s) that may need updates`,
      });
    }
  }

  const modifyByPath = new Map();
  for (const entry of modify) {
    if (!modifyByPath.has(entry.path)) {
      modifyByPath.set(entry.path, entry);
    }
  }
  const dedupedModify = [...modifyByPath.values()];

  const dbTables = allNodes
    .filter((n) => n.kind === 'db_table')
    .filter((n) => keywords.some((kw) => n.symbol.toLowerCase().includes(kw.toLowerCase())));

  const dbColumns = [];
  const dbFks = [];
  for (const table of dbTables) {
    const meta = safeParse(table.metadata);
    if (meta.columns) {
      for (const col of meta.columns) {
        if (typeof col === 'object' && col.name) {
          dbColumns.push({ table: table.symbol, column: col.name, type: col.type || null });
          if (col.foreignKey || col.reference || col.references) {
            dbFks.push({
              table: table.symbol,
              column: col.name,
              references: col.foreignKey || col.reference || col.references,
            });
          }
        } else {
          dbColumns.push({ table: table.symbol, column: col });
        }
      }
    }
  }

  const dbMigrations = allNodes
    .filter((n) => n.kind === 'migration')
    .filter((n) => keywords.some((kw) => n.symbol.toLowerCase().includes(kw.toLowerCase())));

  const db = {
    tables: dbTables.map((n) => ({
      symbol: n.symbol,
      path: n.path,
      line: n.start_line,
    })),
    columns: dbColumns,
    fks: dbFks,
    related_migrations: dbMigrations.map((n) => ({
      symbol: n.symbol,
      path: n.path,
      line: n.start_line,
    })),
  };

  let patternResult = null;
  if (patterns) {
    const patternBreakdown = { route: null, form: null, service: null, test: null };

    const routePattern = findBestPattern(patterns, matchingNodes, 'route');
    if (routePattern) patternBreakdown.route = routePattern;

    const formPattern = findBestPattern(patterns, matchingNodes, 'component');
    if (formPattern) patternBreakdown.form = formPattern;

    const servicePattern = findBestPattern(patterns, matchingNodes, 'class') ||
      findBestPattern(patterns, matchingNodes, 'function');
    if (servicePattern) patternBreakdown.service = servicePattern;

    const testPattern = findBestPatternByPath(patterns, 'test') ||
      findBestPatternByPath(patterns, 'spec');
    if (testPattern) patternBreakdown.test = testPattern;

    const hasAny = Object.values(patternBreakdown).some(Boolean);
    if (hasAny) {
      patternResult = patternBreakdown;
    } else {
      const dominantKind = detectDominantKind(matchingNodes);
      if (dominantKind) {
        const result = patternTool(ctx, { name: dominantKind, context: task });
        if (result.answer.code) {
          patternResult = result.answer;
        }
      }
    }

    if (!patternResult || (typeof patternResult === 'object' && !patternResult.code && !patternResult.route)) {
      for (const kw of keywords.slice(0, 3)) {
        const result = patternTool(ctx, { name: kw, context: task });
        if (result.answer.code) {
          if (!patternResult || (typeof patternResult === 'object' && !patternResult.code)) {
            patternResult = result.answer;
          }
          break;
        }
      }
    }
  }

  const conventionTopics = inferConventionTopics(task);
  const conventions = [];
  for (const topic of conventionTopics) {
    const result = conventionsFor(ctx, { topic });
    if (result.answer.pattern || result.answer.manifest_rules.length > 0) {
      conventions.push({
        topic,
        pattern: result.answer.pattern,
        rules: result.answer.manifest_rules,
      });
    }
  }

  const hasL2 = matchingNodes.some((n) => n._layer === 'L2');

  const relevantCode = matchingNodes.slice(0, 10).map((n) => ({
    path: n.path,
    line_range: [n.start_line, n.end_line],
    snippet_summary: `${n.kind} ${n.symbol}${n.signature ? ` — ${n.signature}` : ''}`,
  }));

  const evidence = [];
  for (const node of matchingNodes.slice(0, 15)) {
    evidence.push({
      path: node.path,
      line_range: [node.start_line, node.end_line],
      symbol: node.symbol,
      kind: node.kind,
    });
  }

  return {
    answer: {
      existing: dedupedExisting,
      create,
      modify: dedupedModify,
      db,
      pattern: patternResult,
      conventions,
      relevant_code: relevantCode,
    },
    evidence,
    layer: hasL2 ? 'L2' : 'L1',
  };
}

function extractKeywords(task) {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'for', 'to', 'in', 'of', 'with', 'on',
    'is', 'it', 'at', 'by', 'from', 'as', 'new', 'add', 'create', 'make',
    'build', 'implement', 'write', 'update', 'modify', 'change', 'need',
    'want', 'should', 'would', 'could', 'that', 'this', 'will', 'be',
    'have', 'has', 'been', 'was', 'were', 'are', 'can', 'do', 'does',
    'did', 'not', 'but', 'if', 'then', 'than', 'so', 'up', 'out',
  ]);

  return task
    .replace(/[^\w\s/-]/g, ' ')
    .split(/[\s/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()));
}

function tokenize(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./:\\]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function computeIdf(allNodes, keywords) {
  const idf = new Map();
  const N = allNodes.length || 1;
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    let df = 0;
    for (const node of allNodes) {
      const tokens = tokenize(node.symbol);
      const pathTokens = tokenize(node.path);
      if (tokens.includes(kwLower) || pathTokens.includes(kwLower)) df++;
    }
    idf.set(kwLower, Math.log(N / (1 + df)));
  }
  return idf;
}

function findMatchingNodes(allNodes, keywords) {
  const idf = computeIdf(allNodes, keywords);
  const scored = [];

  for (const node of allNodes) {
    let score = 0;
    const symTokens = tokenize(node.symbol);
    const pathTokens = tokenize(node.path);
    let distinctMatches = 0;

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      const kwWeight = idf.get(kwLower) || 1;
      let matched = false;

      if (symTokens.includes(kwLower)) {
        const isExact = symTokens.length === 1;
        score += (isExact ? 10 : 5) * kwWeight;
        matched = true;
      }

      if (pathTokens.includes(kwLower)) {
        score += 3 * kwWeight;
        matched = true;
      }

      if (matched) distinctMatches++;
    }

    if (node.exported) score += 1;
    if (distinctMatches > 1) score *= 1 + 0.5 * (distinctMatches - 1);

    if (score > 0) {
      scored.push({ ...node, _score: score });
    }
  }

  return scored.sort((a, b) => b._score - a._score);
}

function graphRerank(store, matchingNodes, allNodes) {
  if (matchingNodes.length === 0) return matchingNodes;

  const seedIds = new Set(matchingNodes.slice(0, 30).map((n) => n.id));
  const neighborScores = new Map();

  for (const id of seedIds) {
    const consumers = store.getConsumers(id);
    const producers = store.getProducers(id);
    for (const n of consumers) {
      neighborScores.set(n.id, (neighborScores.get(n.id) || 0) + 1);
    }
    for (const e of producers) {
      const targetId = e.target_id;
      if (targetId) neighborScores.set(targetId, (neighborScores.get(targetId) || 0) + 1);
    }
  }

  const maxConnections = Math.max(...neighborScores.values(), 1);

  for (const node of matchingNodes) {
    const connections = neighborScores.get(node.id) || 0;
    if (connections > 0) {
      node._score *= 1 + (connections / maxConnections);
    }
  }

  const matchedIds = new Set(matchingNodes.map((n) => n.id));
  for (const [neighborId, connections] of neighborScores) {
    if (matchedIds.has(neighborId) || connections < 2) continue;
    const node = allNodes.find((n) => n.id === neighborId);
    if (node) {
      const score = (connections / maxConnections) * 5;
      matchingNodes.push({ ...node, _score: score, _layer: 'graph' });
      matchedIds.add(neighborId);
    }
  }

  const seedPathTokens = new Set();
  for (const node of matchingNodes.slice(0, 20)) {
    for (const t of tokenize(node.path)) seedPathTokens.add(t);
  }

  const pathTokenIdf = new Map();
  const N = allNodes.length || 1;
  for (const tok of seedPathTokens) {
    let df = 0;
    for (const n of allNodes) {
      if (tokenize(n.path).includes(tok)) df++;
    }
    const idf = Math.log(N / (1 + df));
    if (idf > 0.5) pathTokenIdf.set(tok, idf);
  }

  if (pathTokenIdf.size > 0) {
    for (const node of allNodes) {
      if (matchedIds.has(node.id)) continue;
      const nodePathTokens = tokenize(node.path);
      let proximityScore = 0;
      let rareMatches = 0;
      for (const t of nodePathTokens) {
        const idf = pathTokenIdf.get(t);
        if (idf) {
          proximityScore += idf;
          rareMatches++;
        }
      }
      if (rareMatches >= 1 && proximityScore > 1.5) {
        matchingNodes.push({ ...node, _score: proximityScore, _layer: 'proximity' });
        matchedIds.add(node.id);
      }
    }
  }

  matchingNodes.sort((a, b) => b._score - a._score);
  return matchingNodes;
}

function detectDominantKind(nodes) {
  if (nodes.length === 0) return null;
  const counts = new Map();
  for (const n of nodes) {
    counts.set(n.kind, (counts.get(n.kind) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
}

function findBestPattern(patterns, matchingNodes, kind) {
  const kindPatterns = patterns.findPatternsForKind(kind);
  if (kindPatterns.length === 0) {
    const matching = matchingNodes.filter((n) => n.kind === kind);
    if (matching.length === 0) return null;
    return null;
  }
  const top = kindPatterns[0];
  return {
    name: top.name,
    kind: top.kind,
    frequency: top.frequency,
    template: top.template,
    canonical: top.canonical,
  };
}

function findBestPatternByPath(patterns, pathSegment) {
  const allPatterns = patterns.listPatterns();
  return allPatterns.find((p) => {
    const members = p.members || [];
    return members.some((m) => m.path.toLowerCase().includes(pathSegment));
  }) || null;
}

function inferConventionTopics(task) {
  const lower = task.toLowerCase();
  const topics = [];

  if (/migrat|schema|table|column|database/i.test(lower)) topics.push('migrations');
  if (/auth|login|guard|permission|role|security/i.test(lower)) topics.push('auth');
  if (/valid|assert|constraint|rule|check/i.test(lower)) topics.push('validation');
  if (/error|exception|handler|catch|fault/i.test(lower)) topics.push('errors');
  if (/route|endpoint|api|path|url/i.test(lower)) topics.push('routing');
  if (/state|store|redux|pinia|vuex|provider|context/i.test(lower)) topics.push('state');

  return topics;
}

function safeParse(json) {
  if (!json) return {};
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
