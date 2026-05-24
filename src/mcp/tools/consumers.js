export function consumers(ctx, { target, kind }) {
  const { store, subproject } = ctx;
  const subprojectId = subproject?.id ?? subproject;

  if (!target) {
    return { answer: { target: null, consumers: [] }, evidence: [], layer: 'L1' };
  }

  let nodeId;
  let targetNode;

  if (typeof target === 'number' || /^\d+$/.test(target)) {
    nodeId = typeof target === 'number' ? target : parseInt(target, 10);
    targetNode = store.getNode(nodeId);
  } else {
    const located = store.locate(subprojectId, target);
    if (located.length === 0) {
      return {
        answer: { target: target, consumers: [], message: 'symbol not found' },
        evidence: [],
        layer: 'L1',
      };
    }
    targetNode = located[0];
    nodeId = targetNode.id;
  }

  if (!targetNode) {
    return {
      answer: { target: target, consumers: [], message: 'node not found' },
      evidence: [],
      layer: 'L1',
    };
  }

  let result = store.consumers(subprojectId, nodeId);

  if (kind) {
    result = result.filter(r => r.edge_kind === kind || r.kind === kind);
  }

  const consumerList = result.map(r => ({
    id: r.id,
    symbol: r.symbol,
    kind: r.kind,
    path: r.path,
    start_line: r.start_line,
    end_line: r.end_line,
    edge_kind: r.edge_kind ?? null,
    depth: r.depth,
  }));

  const targetInfo = {
    id: targetNode.id,
    symbol: targetNode.symbol,
    kind: targetNode.kind,
    path: targetNode.path,
  };

  const evidence = [
    {
      path: targetNode.path,
      line_range: [targetNode.start_line, targetNode.end_line],
      symbol: targetNode.symbol,
      kind: targetNode.kind,
    },
    ...consumerList.slice(0, 9).map(c => ({
      path: c.path,
      line_range: [c.start_line, c.end_line],
      symbol: c.symbol,
      kind: c.kind,
    })),
  ];

  return {
    answer: { target: targetInfo, consumers: consumerList },
    evidence,
    layer: 'L1',
  };
}
