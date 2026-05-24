export function pattern(ctx, { name, context }) {
  const { patterns } = ctx;

  if (!name && !context) {
    return {
      answer: { code: null, frequency: null, canonical: null, variants: [] },
      evidence: [],
      layer: 'L1',
    };
  }

  if (!patterns) {
    return {
      answer: { code: null, frequency: null, canonical: null, variants: [], note: 'No pattern catalogue available' },
      evidence: [],
      layer: 'L1',
    };
  }

  let match = null;

  if (name) {
    match = patterns.getPattern(name);
  }

  if (!match && name) {
    const all = patterns.listPatterns();
    match = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  if (!match && name) {
    const all = patterns.listPatterns();
    match = all.find((p) => p.kind === name);
    if (!match) {
      const candidates = all.filter(
        (p) => p.name.toLowerCase().includes(name.toLowerCase()) ||
               p.kind.toLowerCase().includes(name.toLowerCase())
      );
      if (context) {
        const contextLower = context.toLowerCase();
        match = candidates.find((p) =>
          (p.members || []).some(
            (m) => m.symbol.toLowerCase().includes(contextLower) ||
                   m.path.toLowerCase().includes(contextLower)
          )
        ) || candidates[0];
      } else {
        match = candidates.sort((a, b) => b.frequency.count - a.frequency.count)[0];
      }
    }
  }

  if (!match && context) {
    const all = patterns.listPatterns();
    const contextLower = context.toLowerCase();
    match = all.find((p) =>
      (p.members || []).some(
        (m) => m.symbol.toLowerCase().includes(contextLower) ||
               m.path.toLowerCase().includes(contextLower)
      )
    );
  }

  if (!match) {
    const searchTerms = [name, context].filter(Boolean).join(', ');
    const all = patterns.listPatterns();
    const available = all.slice(0, 10).map((p) => p.name);

    return {
      answer: {
        code: null,
        frequency: null,
        canonical: null,
        variants: [],
        note: `No pattern found for "${searchTerms}"`,
        available_patterns: available,
      },
      evidence: [],
      layer: 'L1',
    };
  }

  const evidence = [];
  if (match.canonical?.path) {
    evidence.push({
      path: match.canonical.path,
      line_range: [match.canonical.line, match.canonical.line],
      symbol: match.template?.symbol ?? match.name,
      kind: match.kind,
      role: 'canonical',
    });
  }
  for (const v of match.variants || []) {
    for (const ex of (v.examples || []).slice(0, 2)) {
      evidence.push({
        path: ex.path,
        line_range: [ex.line, ex.line],
        symbol: ex.symbol,
        kind: match.kind,
        role: 'variant',
        variant: v.name,
      });
    }
  }

  return {
    answer: {
      code: match.template ?? null,
      frequency: match.frequency ?? null,
      canonical: match.canonical ?? null,
      variants: match.variants ?? [],
      name: match.name,
      kind: match.kind,
      members_count: (match.members || []).length,
    },
    evidence,
    layer: 'L1',
  };
}
