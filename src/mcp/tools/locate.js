export function locate(ctx, { symbol, kind }) {
  const { store, subproject } = ctx;

  if (!symbol) {
    return { answer: { definitions: [], references_count: 0 }, evidence: [], layer: 'L1' };
  }

  const subprojectId = subproject?.id ?? subproject;
  let rows = store.locate(subprojectId, symbol, kind || undefined);

  if (rows.length === 0) {
    rows = store.findNodes({ subprojectId, symbol }).map(n => ({ ...n, ref_count: 0 }));
  }

  if (rows.length === 0 && !kind) {
    const allNodes = store.findNodes({ subprojectId });
    rows = allNodes
      .filter(n => n.symbol.startsWith(symbol) || n.symbol.includes(symbol))
      .map(n => ({ ...n, ref_count: 0 }));
  }

  if (kind) {
    rows = rows.filter(r => r.kind === kind);
  }

  const totalRefs = rows.reduce((sum, r) => sum + (r.ref_count ?? 0), 0);

  const definitions = rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    kind: r.kind,
    path: r.path,
    start_line: r.start_line,
    end_line: r.end_line,
    exported: !!r.exported,
    signature: r.signature ?? null,
    ref_count: r.ref_count ?? 0,
  }));

  const evidence = definitions.slice(0, 10).map(d => ({
    path: d.path,
    line_range: [d.start_line, d.end_line],
    symbol: d.symbol,
    kind: d.kind,
  }));

  return {
    answer: { definitions, references_count: totalRefs },
    evidence,
    layer: 'L1',
  };
}
