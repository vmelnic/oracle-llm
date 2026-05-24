export function stats(ctx) {
  const { store, subproject } = ctx;
  const subId = subproject?.id ?? subproject;

  const raw = store.stats(subId);

  const nodesByKind = Object.entries(raw.nodes || {})
    .sort(([, a], [, b]) => b - a)
    .map(([kind, count]) => ({ kind, count }));

  const edgesByKind = Object.entries(raw.edges || {})
    .sort(([, a], [, b]) => b - a)
    .map(([kind, count]) => ({ kind, count }));

  return {
    answer: {
      total_nodes: raw.totalNodes,
      total_edges: raw.totalEdges,
      nodes_by_kind: nodesByKind,
      edges_by_kind: edgesByKind,
    },
    evidence: [],
    layer: 'L1',
  };
}
