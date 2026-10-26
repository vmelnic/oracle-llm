const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'how', 'in', 'is',
  'it', 'of', 'on', 'or', 'some', 'that', 'the', 'there', 'this', 'to', 'when', 'where', 'which', 'with',
]);
const MAX_CANDIDATES = 15;

// Lowercase words, with camelCase / snake_case / paths split apart.
function words(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 1);
}

// A keyword is covered by a word when one is a prefix of the other
// (`env` ~ `environment`, `migrations` ~ `migration`), min. 3 characters.
function covers(keyword, word) {
  if (keyword === word) return true;
  const [shorter, longer] = keyword.length <= word.length ? [keyword, word] : [word, keyword];
  return shorter.length >= 3 && longer.startsWith(shorter);
}

function coverage(keywords, node) {
  const haystack = new Set(words(`${node.symbol} ${node.path} ${node.signature || ''} ${node.doc || ''}`));
  let hits = 0;
  for (const kw of keywords) {
    for (const w of haystack) {
      if (covers(kw, w)) { hits++; break; }
    }
  }
  return hits / keywords.length;
}

/**
 * Does something matching a natural-language description exist? Candidates
 * are ranked by the L2 index (BM25 + optional vectors) blended with lexical
 * coverage over symbol, path, signature and doc. `present` is true when the
 * best candidate covers at least half of the description's meaningful words.
 */
export async function exists(ctx, { description }) {
  const { store, subproject, l2 } = ctx;
  const subprojectId = subproject?.id ?? subproject;

  const keywords = [...new Set(words(description).filter(w => !STOP_WORDS.has(w)))];
  if (keywords.length === 0) {
    return { answer: { present: false, candidates: [] }, evidence: [], layer: 'L1' };
  }

  const scored = new Map();
  const consider = (node, rankBoost = 0) => {
    const prev = scored.get(node.id);
    if (prev) {
      prev.rank = Math.max(prev.rank, rankBoost);
      return;
    }
    scored.set(node.id, { node, cover: coverage(keywords, node), rank: rankBoost });
  };

  if (l2) {
    const results = await l2.search(description, { limit: MAX_CANDIDATES * 2 });
    results.forEach((result, i) => {
      const node = store.getNode(Number(result.id));
      if (node) consider(node, 1 - i / results.length);
    });
  }
  for (const node of store.findNodes({ subprojectId })) {
    const name = words(`${node.symbol} ${node.path}`);
    if (keywords.some(kw => name.some(w => covers(kw, w)))) consider(node);
  }

  const ranked = [...scored.values()]
    .map(entry => ({ ...entry, score: entry.cover * 0.7 + entry.rank * 0.3 }))
    .sort((a, b) => b.score - a.score || b.cover - a.cover)
    .slice(0, MAX_CANDIDATES);

  const present = ranked.length > 0 && Math.max(...ranked.map(r => r.cover)) >= 0.5;

  const candidates = ranked.map(({ node, score, cover }) => ({
    id: node.id,
    symbol: node.symbol,
    kind: node.kind,
    path: node.path,
    start_line: node.start_line,
    end_line: node.end_line,
    relevance: Math.round(score * 100) / 100,
    coverage: Math.round(cover * 100) / 100,
  }));

  const evidence = candidates.slice(0, 10).map(c => ({
    path: c.path,
    line_range: [c.start_line, c.end_line],
    symbol: c.symbol,
    kind: c.kind,
  }));

  return {
    answer: { present, candidates },
    evidence,
    layer: l2 ? 'L2' : 'L1',
  };
}
