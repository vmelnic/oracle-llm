const TOPIC_MAP = {
  migrations: {
    kinds: ['migration'],
    manifestKeys: ['migrations'],
    conventionKeys: [],
  },
  auth: {
    kinds: ['route'],
    manifestKeys: [],
    conventionKeys: ['auth_guards', 'firewalls', 'role_hierarchy'],
    filterMeta: (meta) => /auth|guard|protect/i.test(JSON.stringify(meta)),
  },
  validation: {
    kinds: ['function', 'method', 'class'],
    manifestKeys: [],
    conventionKeys: ['validation'],
    filterMeta: (meta) => /valid|assert|constraint/i.test(JSON.stringify(meta)),
    filterSymbol: (sym) => /valid|assert|constraint|rule/i.test(sym),
  },
  errors: {
    kinds: ['function', 'method', 'class'],
    manifestKeys: [],
    conventionKeys: ['errors'],
    filterSymbol: (sym) => /error|exception|handler|catch/i.test(sym),
  },
  routing: {
    kinds: ['route', 'api_endpoint'],
    manifestKeys: [],
    conventionKeys: ['routing', 'routes_auto_load', 'nextjs_router'],
  },
  state: {
    kinds: ['store', 'provider', 'hook'],
    manifestKeys: [],
    conventionKeys: ['state_management', 'vue_api', 'react_style'],
  },
};

export function conventionsFor(ctx, { topic }) {
  const { store, subproject, patterns, manifest } = ctx;

  if (!topic) {
    return {
      answer: { pattern: null, canonical_example: null, variants: [], manifest_rules: [] },
      evidence: [],
      layer: 'L1',
    };
  }

  const normalized = topic.toLowerCase().trim();
  const mapping = TOPIC_MAP[normalized];

  if (!mapping) {
    return {
      answer: {
        pattern: null,
        canonical_example: null,
        variants: [],
        manifest_rules: [],
        note: `Unknown topic "${topic}". Known topics: ${Object.keys(TOPIC_MAP).join(', ')}`,
      },
      evidence: [],
      layer: 'L1',
    };
  }

  const matchedPatterns = [];
  if (patterns) {
    for (const kind of mapping.kinds) {
      const kindPatterns = patterns.findPatternsForKind(kind);
      for (const p of kindPatterns) {
        if (mapping.filterMeta) {
          const members = p.members || [];
          const hasMatch = members.some((m) => {
            const subId = subproject?.id ?? subproject;
            const nodes = store.findNodes({ subprojectId: subId, path: m.path, symbol: m.symbol });
            return nodes.some((n) => {
              const meta = safeParse(n.metadata);
              return mapping.filterMeta(meta);
            });
          });
          if (!hasMatch) continue;
        }
        matchedPatterns.push(p);
      }
    }

    if (mapping.filterSymbol && matchedPatterns.length === 0) {
      const allPatterns = patterns.listPatterns();
      for (const p of allPatterns) {
        const members = p.members || [];
        if (members.some((m) => mapping.filterSymbol(m.symbol))) {
          matchedPatterns.push(p);
        }
      }
    }

    if (matchedPatterns.length === 0) {
      for (const kind of mapping.kinds) {
        matchedPatterns.push(...patterns.findPatternsForKind(kind));
      }
    }
  }

  const topPattern = matchedPatterns[0] || null;

  const canonicalExample = topPattern
    ? {
        path: topPattern.canonical?.path ?? null,
        line: topPattern.canonical?.line ?? null,
        template: topPattern.template ?? null,
      }
    : null;

  const variants = topPattern?.variants ?? [];

  const manifestRules = [];

  if (manifest) {
    for (const key of mapping.manifestKeys) {
      if (manifest[key] != null) {
        manifestRules.push({ source: `manifest.${key}`, value: manifest[key] });
      }
    }

    const conventions = manifest.conventions || {};
    for (const key of mapping.conventionKeys) {
      if (conventions[key] != null) {
        manifestRules.push({ source: `manifest.conventions.${key}`, value: conventions[key] });
      }
    }
  }

  const evidence = [];
  if (topPattern?.canonical?.path) {
    evidence.push({
      path: topPattern.canonical.path,
      line_range: [topPattern.canonical.line, topPattern.canonical.line],
      symbol: topPattern.template?.symbol ?? topPattern.name,
      kind: topPattern.kind,
    });
  }
  for (const p of matchedPatterns.slice(0, 5)) {
    for (const m of (p.members || []).slice(0, 2)) {
      evidence.push({
        path: m.path,
        line_range: [m.line, m.line],
        symbol: m.symbol,
        kind: p.kind,
      });
    }
  }

  return {
    answer: {
      pattern: topPattern
        ? { name: topPattern.name, kind: topPattern.kind, frequency: topPattern.frequency }
        : null,
      canonical_example: canonicalExample,
      variants,
      manifest_rules: manifestRules,
      all_patterns: matchedPatterns.map((p) => ({
        name: p.name,
        kind: p.kind,
        frequency: p.frequency,
      })),
    },
    evidence,
    layer: 'L1',
  };
}

function safeParse(json) {
  if (!json) return {};
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
