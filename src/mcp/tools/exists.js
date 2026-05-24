export function exists(ctx, { description }) {
  const { store, subproject } = ctx;
  const subprojectId = subproject?.id ?? subproject;

  if (!description || !description.trim()) {
    return { answer: { present: false, candidates: [] }, evidence: [], layer: 'L1' };
  }

  const keywords = description
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter(w => w.length > 1);

  if (keywords.length === 0) {
    return { answer: { present: false, candidates: [] }, evidence: [], layer: 'L1' };
  }

  const allNodes = store.findNodes({ subprojectId });

  const scored = [];
  for (const node of allNodes) {
    const haystack = `${node.symbol} ${node.kind} ${node.path}`.toLowerCase();
    let hits = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) hits++;
    }
    if (hits > 0) {
      scored.push({ node, hits, score: hits / keywords.length });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.hits - a.hits);

  const top = scored.slice(0, 15);
  const present = top.length > 0 && top[0].score >= 0.5;

  const candidates = top.map(({ node, score }) => ({
    id: node.id,
    symbol: node.symbol,
    kind: node.kind,
    path: node.path,
    start_line: node.start_line,
    end_line: node.end_line,
    relevance: Math.round(score * 100) / 100,
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
    layer: 'L1',
  };
}
