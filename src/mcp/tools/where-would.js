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

  // Symbols named in the intent ("similar to globFiles") anchor the location;
  // only without them does the directory holding most nodes of a kind decide.
  for (const kw of keywords) {
    const bySymbol = store.findNodes({ subprojectId: subId, symbol: kw });
    candidateNodes.push(...bySymbol);
  }

  if (candidateNodes.length === 0) {
    for (const kind of kindHints) {
      const byKind = store.findNodes({ subprojectId: subId, kind });
      candidateNodes.push(...byKind);
    }
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
  // Symbols the intent names verbatim (lowercased) are analogs, not new names.
  const mentionedSymbols = new Set(deduped.map((n) => n.symbol.split('.').pop().toLowerCase())
    .filter((sym) => keywords.some((k) => k.toLowerCase() === sym)));

  const dirFrequency = new Map();
  for (const node of deduped) {
    const dir = path.dirname(node.path);
    const entry = dirFrequency.get(dir) || { count: 0, kinds: new Set(), examples: [] };
    entry.count++;
    entry.kinds.add(node.kind);
    if (entry.examples.length < 3) {
      entry.examples.push({ symbol: node.symbol, path: node.path, kind: node.kind, line_range: [node.start_line, node.end_line] });
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
    const suggestedName = buildFilename(intent, kind, analog, siblingFiles(store, subId, topDir), topDir, mentionedSymbols);

    proposedPaths.push({
      path: path.join(topDir, suggestedName),
      reason: placementReason(store, subId, topDir, analog, mentionedSymbols),
      analog: analog ? { path: analog.path, symbol: analog.symbol, line_range: [analog.start_line, analog.end_line] } : null,
    });
  }

  if (proposedPaths.length === 0 && dirFrequency.size > 0) {
    const sorted = [...dirFrequency.entries()].sort((a, b) => b[1].count - a[1].count);
    const topDir = sorted[0][0];
    const example = sorted[0][1].examples[0];

    proposedPaths.push({
      path: path.join(topDir, buildFilename(intent, null, example, siblingFiles(store, subId, topDir), topDir, mentionedSymbols)),
      reason: placementReason(store, subId, topDir, example, mentionedSymbols),
      analog: example ? { path: example.path, symbol: example.symbol, line_range: example.line_range } : null,
    });
  }

  // When some proposal's directory relates to the intent ("contract detector"
  // -> src/contracts/detectors), drop the ones picked only because a
  // directory holds many nodes of a kind.
  const intentWords = keywords.map((k) => k.toLowerCase().replace(/s$/, '')).filter((k) => k.length >= 3);
  const related = proposedPaths.filter((p) => path.dirname(p.path).toLowerCase().split(/[\\/]/)
    .some((segment) => intentWords.some((w) => segment.replace(/s$/, '') === w)));
  if (related.length > 0 && related.length < proposedPaths.length) proposedPaths.splice(0, proposedPaths.length, ...related);

  const evidence = proposedPaths
    .filter((p) => p.analog)
    .map((p) => ({
      path: p.analog.path,
      ...(p.analog.line_range?.[0] ? { line_range: p.analog.line_range } : {}),
      symbol: p.analog.symbol,
      reason: p.reason,
    }));

  return {
    answer: { proposed_paths: proposedPaths },
    evidence,
    layer: 'L1',
  };
}

// Why this directory, in true terms: the symbol the request named lives
// there, or the directory's actual size (not the number of matches).
function placementReason(store, subprojectId, dir, analog, mentionedSymbols) {
  if (analog && mentionedSymbols.has(analog.symbol.split('.').pop().toLowerCase())) {
    return `${analog.symbol}, named in the request, lives in ${dir}`;
  }
  const files = siblingFiles(store, subprojectId, dir).length;
  return `${dir} holds ${files} existing file(s)${analog ? `, e.g. ${analog.symbol}` : ''}`;
}

function extractKeywords(intent) {
  const stopWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'for', 'to', 'in', 'of', 'with', 'on',
    'is', 'it', 'at', 'by', 'from', 'as', 'new', 'add', 'create', 'make',
    'build', 'implement', 'write', 'update', 'modify', 'change', 'that',
    'which', 'this', 'returns', 'return', 'get', 'gets', 'show', 'shows',
    'some', 'any', 'all', 'into', 'when', 'where', 'how', 'similar',
    'like', 'based', 'using', 'module', 'file', 'code',
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

// File name for new code, following the naming style of the files already in
// the target directory and dropping words the directory already says
// (`contract detector for AsyncAPI` in src/contracts/detectors -> asyncapi.js).
function buildFilename(intent, kind, analog, siblings, dir, existingNames = new Set()) {
  const dirWords = dir.toLowerCase().split(/[\\/]+/);
  const implied = (w) => dirWords.some(d => d.startsWith(w) || w.startsWith(d.replace(/s$/, '')));
  const siblingNames = new Set(siblings.map(n => n.toLowerCase()));
  // "similar to locate": `locate` names the analog, not the new file.
  const existing = (w) => existingNames.has(w) || siblingNames.has(w);
  const words = extractKeywords(intent).map(w => w.toLowerCase());
  const specific = words.filter(w => !implied(w) && !existing(w));
  // Without a specific word left, say what it is: new-component, new-module...
  const genericKind = !kind || kind === 'function' || kind === 'class' ? 'module' : kind.replace(/_/g, '-');
  const chosen = specific.length > 0 ? specific.slice(0, 3) : ['new', genericKind];

  const ext = analog ? path.extname(analog.path) : ({
    route: '.php',
    api_endpoint: '.php',
    migration: '.php',
    component: '.vue',
  }[kind] || '.js');

  const style = detectNamingStyle(siblings);
  let base = applyNamingStyle(chosen, style);
  // Never propose a file that already exists.
  for (let i = 2; siblingNames.has(base.toLowerCase()); i++) base = applyNamingStyle([...chosen, String(i)], style);
  return `${base}${ext}`;
}

function siblingFiles(store, subprojectId, dir) {
  return store.getIndexedFiles(subprojectId)
    .filter(file => path.dirname(file) === dir)
    .map(file => path.basename(file, path.extname(file)));
}

function detectNamingStyle(names) {
  const counts = { kebab: 0, snake: 0, pascal: 0, camel: 0 };
  for (const name of names) {
    if (name.includes('-')) counts.kebab++;
    else if (name.includes('_')) counts.snake++;
    else if (/^[A-Z]/.test(name)) counts.pascal++;
    else if (/[a-z][A-Z]/.test(name)) counts.camel++;
  }
  const [style, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  // Single-word lowercase names (index.js, store.js) read best as kebab-case.
  return count > 0 ? style : (names.length > 0 ? 'kebab' : 'pascal');
}

function applyNamingStyle(words, style) {
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  if (style === 'kebab') return words.join('-');
  if (style === 'snake') return words.join('_');
  if (style === 'camel') return words[0] + words.slice(1).map(cap).join('');
  return words.map(cap).join('');
}

function deduplicateById(nodes) {
  const seen = new Set();
  return nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}
