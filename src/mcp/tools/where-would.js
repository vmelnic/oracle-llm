import path from 'path';

export function whereWould(ctx, { intent }) {
  const { store, subproject } = ctx;

  if (!intent) {
    return { answer: { proposed_paths: [] }, evidence: [], layer: 'L1' };
  }

  const subId = subproject?.id ?? subproject;
  const keywords = extractKeywords(intent);
  const kindHints = inferKinds(intent);

  const candidateNodes = [];

  for (const kw of keywords) {
    const bySymbol = store.findNodes({ subprojectId: subId, symbol: kw });
    candidateNodes.push(...bySymbol);
  }

  for (const kind of kindHints) {
    const byKind = store.findNodes({ subprojectId: subId, kind });
    candidateNodes.push(...byKind);
  }

  if (candidateNodes.length === 0) {
    const allNodes = store.findNodes({ subprojectId: subId });
    for (const kw of keywords) {
      const lower = kw.toLowerCase();
      const fuzzy = allNodes.filter(
        (n) => n.symbol.toLowerCase().includes(lower) || n.path.toLowerCase().includes(lower)
      );
      candidateNodes.push(...fuzzy);
    }
  }

  const deduped = deduplicateById(candidateNodes);

  const dirFrequency = new Map();
  for (const node of deduped) {
    const dir = path.dirname(node.path);
    const entry = dirFrequency.get(dir) || { count: 0, kinds: new Set(), examples: [] };
    entry.count++;
    entry.kinds.add(node.kind);
    if (entry.examples.length < 3) {
      entry.examples.push({ symbol: node.symbol, path: node.path, kind: node.kind });
    }
    dirFrequency.set(dir, entry);
  }

  const kindDirs = new Map();
  for (const node of deduped) {
    const dir = path.dirname(node.path);
    const key = node.kind;
    if (!kindDirs.has(key)) kindDirs.set(key, new Map());
    const dirs = kindDirs.get(key);
    dirs.set(dir, (dirs.get(dir) || 0) + 1);
  }

  const proposedPaths = [];

  for (const kind of kindHints) {
    const dirs = kindDirs.get(kind);
    if (!dirs || dirs.size === 0) continue;

    const sorted = [...dirs.entries()].sort((a, b) => b[1] - a[1]);
    const topDir = sorted[0][0];

    const analog = deduped.find((n) => n.kind === kind && path.dirname(n.path) === topDir);
    const suggestedName = buildFilename(intent, kind, analog);

    proposedPaths.push({
      path: path.join(topDir, suggestedName),
      reason: `${sorted[0][1]} existing ${kind} node(s) live in ${topDir}`,
      analog: analog ? { path: analog.path, symbol: analog.symbol } : null,
    });
  }

  if (proposedPaths.length === 0 && dirFrequency.size > 0) {
    const sorted = [...dirFrequency.entries()].sort((a, b) => b[1].count - a[1].count);
    const topDir = sorted[0][0];
    const example = sorted[0][1].examples[0];

    proposedPaths.push({
      path: path.join(topDir, buildFilename(intent, null, example)),
      reason: `Most active directory with ${sorted[0][1].count} nodes`,
      analog: example ? { path: example.path, symbol: example.symbol } : null,
    });
  }

  const evidence = proposedPaths
    .filter((p) => p.analog)
    .map((p) => ({
      path: p.analog.path,
      symbol: p.analog.symbol,
      reason: p.reason,
    }));

  return {
    answer: { proposed_paths: proposedPaths },
    evidence,
    layer: 'L1',
  };
}

function extractKeywords(intent) {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'for', 'to', 'in', 'of', 'with', 'on',
    'is', 'it', 'at', 'by', 'from', 'as', 'new', 'add', 'create', 'make',
    'build', 'implement', 'write', 'update', 'modify', 'change',
  ]);

  return intent
    .replace(/[^\w\s/-]/g, ' ')
    .split(/[\s/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !stopWords.has(w.toLowerCase()));
}

function inferKinds(intent) {
  const lower = intent.toLowerCase();
  const kinds = [];

  if (/api|endpoint|controller|handler/.test(lower)) kinds.push('route', 'api_endpoint', 'class');
  if (/component|widget|view|page/.test(lower)) kinds.push('component');
  if (/migration|migrate|schema/.test(lower)) kinds.push('migration');
  if (/model|entity|table/.test(lower)) kinds.push('class', 'db_table');
  if (/service|provider/.test(lower)) kinds.push('class', 'provider');
  if (/test|spec/.test(lower)) kinds.push('function', 'class');
  if (/hook|composable/.test(lower)) kinds.push('hook', 'function');
  if (/store|state/.test(lower)) kinds.push('store');
  if (/route|routing/.test(lower)) kinds.push('route');
  if (/middleware/.test(lower)) kinds.push('function', 'class');
  if (/event|listener/.test(lower)) kinds.push('event', 'class');

  if (kinds.length === 0) kinds.push('class', 'function');

  return [...new Set(kinds)];
}

function buildFilename(intent, kind, analog) {
  const words = extractKeywords(intent);
  const base = words
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');

  if (analog) {
    const ext = path.extname(analog.path);
    return `${base}${ext}`;
  }

  const extMap = {
    route: '.php',
    api_endpoint: '.php',
    migration: '.php',
    component: '.vue',
    hook: '.js',
    store: '.js',
  };

  return `${base}${extMap[kind] || '.js'}`;
}

function deduplicateById(nodes) {
  const seen = new Set();
  return nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}
