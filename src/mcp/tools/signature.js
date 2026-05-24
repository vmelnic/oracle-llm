export function signature(ctx, { path, line, symbol }) {
  const { store, subproject } = ctx;
  const subprojectId = subproject?.id ?? subproject;

  if (!path && !symbol) {
    return { answer: null, evidence: [], layer: 'L1' };
  }

  let node = null;

  if (path && line != null) {
    const nodes = store.getSymbolsInRange(subprojectId, path, line, line);
    node = nodes.reduce((best, n) => {
      if (!best) return n;
      const bestSpan = best.end_line - best.start_line;
      const nSpan = n.end_line - n.start_line;
      return nSpan < bestSpan ? n : best;
    }, null);
  }

  if (!node && symbol) {
    const rows = store.locate(subprojectId, symbol);
    if (path) {
      node = rows.find(r => r.path === path) ?? rows[0] ?? null;
    } else {
      node = rows[0] ?? null;
    }
  }

  if (!node && path) {
    const fileNodes = store.getNodesByFile(subprojectId, path);
    if (symbol) {
      node = fileNodes.find(n => n.symbol === symbol) ?? null;
    }
  }

  if (!node) {
    return { answer: null, evidence: [], layer: 'L1' };
  }

  let metadata = null;
  if (node.metadata) {
    try {
      metadata = typeof node.metadata === 'string' ? JSON.parse(node.metadata) : node.metadata;
    } catch {
      metadata = null;
    }
  }

  const answer = {
    symbol: node.symbol,
    kind: node.kind,
    path: node.path,
    start_line: node.start_line,
    end_line: node.end_line,
    signature: node.signature ?? null,
    doc: node.doc ?? null,
    type_env: metadata?.type_env ?? metadata?.types ?? null,
    exported: !!node.exported,
    lang: node.lang,
  };

  const evidence = [{
    path: node.path,
    line_range: [node.start_line, node.end_line],
    symbol: node.symbol,
    kind: node.kind,
  }];

  return { answer, evidence, layer: 'L1' };
}
