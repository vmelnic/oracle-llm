import { whereWould } from './where-would.js';
import { positiveInt } from '../../utils/env.js';
import { conventionsFor } from './conventions-for.js';
import { pattern as patternTool } from './pattern.js';

const RELEVANCE_FLOOR = 0.2;
const CODE_KINDS = new Set(['function', 'method', 'hook', 'component', 'route']);
const CALLABLE_KINDS = new Set(['function', 'method', 'hook']);
const CALLEE_SEEDS = 25;
const CALLEE_DEPTH = 2;
const CALLEE_DECAY = 0.35;
const CREATION_INTENT = /\b(add|create|new|implement|build|write|introduce|scaffold|generate)\b/i;

export async function context(ctx, { task }) {
  const { store, subproject, patterns, l2 } = ctx;

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
    // Search with the meaningful words only: raw question words ("where")
    // would match unrelated paths such as where-would.js.
    const l2Results = await l2.search(keywords.join(' ') || task, { limit: 20 });
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

  // Keep everything clearly related to the task, not a fixed top-N: a broad
  // question ("how does login work") can span dozens of symbols. Relevance
  // is relative to the best match; ORACLE_CONTEXT_MAX_NODES is a safety cap.
  // Exact symbol matches always stay; the floor is measured against the best
  // non-exact match, so a function literally named `ingest` cannot push out
  // everything else that implements ingest.
  const exactMatches = matchingNodes.filter((n) => n._exact);
  const others = matchingNodes.filter((n) => !n._exact);
  // Callers and callees of relevant code stay too: they are included by the
  // graph, not by score.
  const floor = (others[0]?._score || 0) * RELEVANCE_FLOOR;
  // When the cap bites, fill it by evidence strength, not raw score: words of
  // the task in the symbol, then what that code calls / is called by, then
  // semantic-only (L2) hits, then neighbours that merely sit nearby.
  const tier = (n) => {
    if (n._exact) return 0;
    if (n._layer === 'L1' || n._layer === 'L1+L2' || n._layer === undefined) return n._score >= floor ? 1 : 2;
    if (n._caller || n._callee) return 2;
    return n._layer === 'L2' ? 3 : 4;
  };
  const relevant = [...exactMatches, ...others.filter((n) => n._score >= floor || n._caller || n._callee)]
    .map((n, i) => ({ n, i, t: tier(n) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ n }) => n)
    .slice(0, positiveInt(process.env.ORACLE_CONTEXT_MAX_NODES, 50));

  const existing = relevant.map((n) => ({
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

  // New-file suggestions only make sense when the task creates something;
  // for "explain how X works" they would just be invented file names.
  const create = CREATION_INTENT.test(task) ? (whereWould(ctx, { intent: task }).answer.proposed_paths || []) : [];

  const modify = [];
  for (const node of relevant) {
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

  const relevantCode = relevant.map((n) => ({
    path: n.path,
    line_range: [n.start_line, n.end_line],
    snippet_summary: `${n.kind} ${n.symbol}${n.signature ? ` — ${n.signature}` : ''}`,
  }));

  const evidence = [];
  for (const node of relevant) {
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
    // Question words carry no code meaning ("how X works", "where it is used").
    'explain', 'how', 'what', 'why', 'where', 'when', 'which', 'who', 'works',
    'work', 'working', 'used', 'use', 'uses', 'using', 'show', 'find', 'me', 'about',
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

// Members and properties matched only through their class's name
// (`LoginRequest::rules`) say less than symbols that carry the word themselves
// (`UserController::loginForm`); the class itself already stands for them.
const OWNER_ONLY_FACTOR = 0.3;
const PROPERTY_FACTOR = 0.5;
// Tests rank below the code they test unless the task is about tests.
const TEST_FACTOR = 0.5;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|Test\.php$/i;

function findMatchingNodes(allNodes, keywords) {
  const idf = computeIdf(allNodes, keywords);
  const scored = [];
  const aboutTests = keywords.some((k) => /^(tests?|specs?|testing)$/i.test(k));

  for (const node of allNodes) {
    let score = 0;
    const symTokens = tokenize(node.symbol);
    const memberTokens = tokenize(memberOf(node.symbol));
    const pathTokens = tokenize(node.path);
    let distinctMatches = 0;
    const isMember = node.kind === 'method' || node.kind === 'property';

    const symLower = node.symbol.toLowerCase();
    const symName = symLower.split('.').pop();
    let exact = false;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      const kwWeight = idf.get(kwLower) || 1;
      let matched = false;

      // A symbol named verbatim in the task ("how GraphStore works") is the
      // strongest signal; tokenizing it into "graph"/"store" would lose it.
      if (symName === kwLower || symLower === kwLower) {
        score += 50 * kwWeight;
        matched = true;
        exact = true;
      } else if (symTokens.includes(kwLower)) {
        const isExact = symTokens.length === 1;
        const ownerOnly = isMember && !memberTokens.includes(kwLower);
        score += (isExact ? 10 : 5) * kwWeight * (ownerOnly ? OWNER_ONLY_FACTOR : 1);
        matched = true;
      }

      if (pathTokens.includes(kwLower)) {
        const ownerOnly = isMember && !memberTokens.includes(kwLower);
        score += 3 * kwWeight * (ownerOnly ? OWNER_ONLY_FACTOR : 1);
        matched = true;
      }

      if (matched) distinctMatches++;
    }

    if (node.exported) score += 1;
    if (distinctMatches > 1) score *= 1 + 0.5 * (distinctMatches - 1);
    if (node.kind === 'property') score *= PROPERTY_FACTOR;
    if (!aboutTests && TEST_PATH.test(node.path)) score *= TEST_FACTOR;

    if (score > 0) {
      scored.push({ ...node, _score: score, ...(exact ? { _exact: true } : {}) });
    }
  }

  return scored.sort((a, b) => b._score - a._score);
}

// Last name segment: `App\\Foo::bar` -> `bar`, `Foo.bar` -> `bar`.
function memberOf(symbol) {
  const text = String(symbol);
  const cut = Math.max(text.lastIndexOf('::') + 1, text.lastIndexOf('.'), text.lastIndexOf('\\'));
  return cut > 0 ? text.slice(cut + 1) : text;
}

function graphRerank(store, matchingNodes, allNodes) {
  if (matchingNodes.length === 0) return matchingNodes;

  // Built once per call: lookups below must not scan every node per item.
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const matchedIds = new Set(matchingNodes.map((n) => n.id));

  // Callers are part of "how does X work": every relevant match brings its
  // callers, ranked after the direct matches (a verbatim symbol's callers
  // first) but never below the relevance floor, so they are kept.
  const bestOther = matchingNodes.find((n) => !n._exact)?._score || 0;
  const seeds = matchingNodes.filter((n) => n._exact || n._score >= bestOther * RELEVANCE_FLOOR);
  for (const seed of seeds) {
    for (const consumer of store.getConsumers(seed.id)) {
      if (consumer.path === seed.path) continue;
      const score = seed._score * (seed._exact ? 0.6 : 0.4);
      const existing = matchingNodes.find((n) => n.id === consumer.id);
      if (existing) {
        existing._score = Math.max(existing._score, score);
        existing._caller = true;
      } else if (byId.has(consumer.id)) {
        matchingNodes.push({ ...byId.get(consumer.id), _score: score, _layer: 'graph', _caller: true });
        matchedIds.add(consumer.id);
      }
    }
  }
  // What relevant code calls is part of it too (the action a controller runs,
  // the token that action issues): callees of the strongest code seeds, two
  // calls deep. Code nobody calls (framework hooks such as `rules()`) gets no
  // boost this way.
  let frontier = seeds.filter((n) => CODE_KINDS.has(n.kind)).slice(0, CALLEE_SEEDS);
  for (let depth = 0; depth < CALLEE_DEPTH && frontier.length > 0; depth++) {
    const next = [];
    for (const seed of frontier) {
      for (const edge of store.getProducers(seed.id)) {
        if (edge.kind !== 'calls' || !CALLABLE_KINDS.has(edge.target_kind)) continue;
        const score = seed._score * CALLEE_DECAY;
        let node = matchingNodes.find((n) => n.id === edge.target_id);
        if (node) {
          if (score > node._score) node._score = score;
          node._callee = true;
        } else if (byId.has(edge.target_id)) {
          node = { ...byId.get(edge.target_id), _score: score, _layer: 'graph', _callee: true };
          matchingNodes.push(node);
          matchedIds.add(edge.target_id);
        }
        if (node) next.push(node);
      }
    }
    frontier = next;
  }
  matchingNodes.sort((a, b) => b._score - a._score);

  const seedIds = new Set(matchingNodes.slice(0, 30).map((n) => n.id));
  const neighborScores = new Map();

  for (const id of seedIds) {
    for (const n of store.getConsumers(id)) {
      neighborScores.set(n.id, (neighborScores.get(n.id) || 0) + 1);
    }
    for (const e of store.getProducers(id)) {
      if (e.target_id) neighborScores.set(e.target_id, (neighborScores.get(e.target_id) || 0) + 1);
    }
  }

  let maxConnections = 1;
  for (const v of neighborScores.values()) if (v > maxConnections) maxConnections = v;

  for (const node of matchingNodes) {
    const connections = neighborScores.get(node.id) || 0;
    if (connections > 0) {
      node._score *= 1 + (connections / maxConnections);
    }
  }

  for (const [neighborId, connections] of neighborScores) {
    if (matchedIds.has(neighborId) || connections < 2) continue;
    const node = byId.get(neighborId);
    if (node) {
      matchingNodes.push({ ...node, _score: (connections / maxConnections) * 5, _layer: 'graph' });
      matchedIds.add(neighborId);
    }
  }

  // Path-token document frequencies, computed once over all nodes.
  const nodePathTokens = new Map(allNodes.map((n) => [n.id, tokenize(n.path)]));
  const seedPathTokens = new Set();
  for (const node of matchingNodes.slice(0, 20)) {
    for (const t of nodePathTokens.get(node.id) || tokenize(node.path)) seedPathTokens.add(t);
  }
  const df = new Map();
  for (const tokens of nodePathTokens.values()) {
    for (const t of new Set(tokens)) if (seedPathTokens.has(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = allNodes.length || 1;
  const pathTokenIdf = new Map();
  for (const tok of seedPathTokens) {
    const idf = Math.log(N / (1 + (df.get(tok) || 0)));
    if (idf > 0.5) pathTokenIdf.set(tok, idf);
  }

  if (pathTokenIdf.size > 0) {
    for (const node of allNodes) {
      if (matchedIds.has(node.id)) continue;
      let proximityScore = 0;
      let rareMatches = 0;
      for (const t of nodePathTokens.get(node.id)) {
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

  // Neighbours and path-proximity nodes only fill leftover room: never above
  // the relevance floor, so direct matches, callers and callees come first.
  const direct = matchingNodes.filter((n) => n._layer !== 'proximity' && !(n._layer === 'graph' && !n._caller && !n._callee));
  const bestDirect = direct.filter((n) => !n._exact).reduce((max, n) => Math.max(max, n._score), 0);
  const ceiling = bestDirect * RELEVANCE_FLOOR;
  for (const node of matchingNodes) {
    if (!direct.includes(node) && node._score > ceiling) node._score = ceiling;
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

// The pattern whose members mostly live in test files (by count), trimmed
// to its summary: a pattern can have thousands of members.
function findBestPatternByPath(patterns, pathSegment) {
  let best = null;
  for (const p of patterns.listPatterns()) {
    const members = p.members || [];
    if (members.length === 0) continue;
    const inPath = members.filter((m) => String(m.path).toLowerCase().includes(pathSegment)).length;
    if (inPath / members.length < 0.5) continue;
    if (!best || inPath > best.inPath) best = { p, inPath };
  }
  if (!best) return null;
  const { name, kind, frequency, template, canonical } = best.p;
  return { name, kind, frequency, template, canonical };
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
