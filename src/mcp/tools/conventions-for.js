import { slugify } from '../../markdown/index.js';

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

  if (!topic || !topic.trim()) {
    return {
      answer: { found: false, pattern: null, canonical_example: null, variants: [], manifest_rules: [], note: 'No topic given.' },
      evidence: [],
      layer: 'L1',
    };
  }

  const normalized = topic.toLowerCase().trim();
  // Known topics have tuned rules; any other topic ("testing", "logging",
  // "naming") searches symbols and documented rules by its stem.
  const mapping = TOPIC_MAP[normalized] || genericTopic(normalized);

  const matchedPatterns = [];
  if (patterns) {
    for (const kind of mapping.kinds) {
      const kindPatterns = patterns.findPatternsForKind(kind);
      for (const p of kindPatterns) {
        // A topic filter is a requirement, not a tie-breaker: a generic shape
        // with one error helper among 180 members is not "the convention for
        // errors". At least half the members must embody the topic.
        if (mapping.filterSymbol) {
          const members = p.members || [];
          const onTopic = members.filter((m) => mapping.filterSymbol(m.symbol)).length;
          if (members.length === 0 || onTopic / members.length < 0.5) continue;
        }
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

    if (matchedPatterns.length === 0 && !mapping.filterSymbol && !mapping.filterMeta) {
      for (const kind of mapping.kinds) {
        matchedPatterns.push(...patterns.findPatternsForKind(kind));
      }
    }
  }

  // Symbols that embody the topic directly (e.g. error helpers), even when
  // they don't form a recurring pattern.
  const subId = subproject?.id ?? subproject;
  const examples = mapping.filterSymbol
    ? store.findNodes({ subprojectId: subId })
      .filter((n) => mapping.kinds.includes(n.kind) && mapping.filterSymbol(n.symbol))
      .slice(0, 10)
      .map((n) => ({ symbol: n.symbol, kind: n.kind, path: n.path, line: n.start_line, end_line: n.end_line }))
    : [];

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
  const docSections = [];

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
    // Sections harvested from CONVENTION.md / AGENTS.md etc. whose heading names the topic.
    const stem = topicStem(normalized);
    for (const [key, value] of Object.entries(conventions._from_docs || {})) {
      if (mentionsStem(key, stem)) {
        manifestRules.push({ source: `docs.${key}`, value });
        docSections.push(...docSectionNodes(store, subproject?.id ?? subproject, value._source, key));
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

  // Documented rules point at the doc section they came from.
  for (const node of docSections) {
    evidence.push({ path: node.path, line_range: [node.start_line, node.end_line], symbol: node.symbol, kind: node.kind });
  }
  for (const ex of examples.slice(0, 5)) {
    evidence.push({ path: ex.path, line_range: [ex.line, ex.end_line], symbol: ex.symbol, kind: ex.kind });
  }
  const seen = new Set();
  const uniqueEvidence = evidence.filter((e) => {
    const key = `${e.path}:${e.line_range.join('-')}:${e.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    answer: {
      pattern: topPattern
        ? { name: topPattern.name, kind: topPattern.kind, frequency: topPattern.frequency }
        : null,
      canonical_example: canonicalExample,
      variants,
      manifest_rules: manifestRules,
      examples,
      // An explicit negative needs no evidence (see GroundingWrapper.enforceEvidence).
      ...(!topPattern && examples.length === 0 && manifestRules.length === 0
        ? { found: false, note: `No recurring pattern, example or documented rule found for "${topic}".` }
        : {}),
      all_patterns: matchedPatterns.map((p) => ({
        name: p.name,
        kind: p.kind,
        frequency: p.frequency,
      })),
    },
    evidence: uniqueEvidence,
    layer: 'L1',
  };
}

// `errors` -> `error`, `testing` -> `test`, `migrations` -> `migration`.
function topicStem(topic) {
  // "logging" -> "logg" -> "log": undo the doubled consonant left by -ing.
  const stem = topic.replace(/(ing|es|s)$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  return stem.length >= 3 ? stem : topic;
}

// Words of an identifier or slug: `logThrottled` -> log, throttled;
// `error_handling` -> error, handling.
function nameWords(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// True when a word of `name` starts with the stem: "log" matches logThrottled
// but not PatternCatalogue or technology_stack.
function mentionsStem(name, stem) {
  return nameWords(name).some((w) => w.startsWith(stem));
}

function genericTopic(topic) {
  const stems = topic.split(/[^a-z0-9]+/).filter(w => w.length >= 3).map(topicStem);
  return {
    kinds: ['function', 'method', 'class'],
    manifestKeys: [],
    conventionKeys: [],
    filterSymbol: (sym) => stems.some((stem) => mentionsStem(sym, stem)),
  };
}

// doc_section nodes (from markdown ingestion) for a harvested rule section.
function docSectionNodes(store, subprojectId, sourceFile, key) {
  if (!sourceFile) return [];
  return store.findNodes({ subprojectId, path: sourceFile, kind: 'doc_section' })
    .filter((n) => slugify(n.symbol) === key);
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
