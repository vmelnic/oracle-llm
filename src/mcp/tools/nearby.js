export function nearby(ctx, { path, line, intent }) {
  const { store, subproject } = ctx;
  const subprojectId = subproject?.id ?? subproject;

  if (!path || line == null) {
    return { answer: [], evidence: [], layer: 'L1' };
  }

  const nodes = store.getNodesByFile(subprojectId, path);
  if (nodes.length === 0) {
    return { answer: [], evidence: [], layer: 'L1' };
  }

  const intentLower = intent ? intent.toLowerCase() : null;
  const intentKeywords = intentLower ? intentLower.split(/[\s_\-./]+/).filter(w => w.length > 1) : [];

  const scored = nodes.map(node => {
    const midpoint = (node.start_line + node.end_line) / 2;
    const distance = Math.abs(midpoint - line);
    const contains = node.start_line <= line && node.end_line >= line;

    let proximityScore = 1 / (1 + distance);
    if (contains) proximityScore += 0.5;

    let intentBoost = 0;
    if (intentKeywords.length > 0) {
      const haystack = `${node.symbol} ${node.kind}`.toLowerCase();
      for (const kw of intentKeywords) {
        if (haystack.includes(kw)) intentBoost += 0.3;
      }
    }

    return {
      id: node.id,
      symbol: node.symbol,
      kind: node.kind,
      start_line: node.start_line,
      end_line: node.end_line,
      exported: !!node.exported,
      signature: node.signature ?? null,
      distance,
      score: proximityScore + intentBoost,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const ranked = scored.slice(0, 20);

  const evidence = ranked.slice(0, 10).map(s => ({
    path,
    line_range: [s.start_line, s.end_line],
    symbol: s.symbol,
    kind: s.kind,
  }));

  return {
    answer: ranked,
    evidence,
    layer: 'L1',
  };
}
