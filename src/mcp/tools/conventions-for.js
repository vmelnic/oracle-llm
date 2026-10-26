import path from 'path';
import { slugify } from '../../markdown/index.js';

// How a project does something (auth, errors, state...), from the code that
// embodies the topic: which base types it extends, where it lives, which
// route middleware guards it, recurring shapes, documented rules.
//
// A node is on-topic when a word of its name, its base types or its path is
// one of the topic's stems or an inflection of it ("log" matches logger and
// logging, not login; "error" matches errors). A trailing `*` makes a prefix
// ("valid*" matches validator and validation, not invalidate). Strong stems
// decide alone; weak ones (token, role, rule...) need another signal.

const STRONG = 3;
const WEAK = 1;
const MIN_SCORE = 2;
const PATH_FACTOR = 0.5;
const MEMBER_FACTOR = 0.5;
const PATTERN_SHARE = 0.5;
const MAX_EXAMPLES = 10;
const PER_FILE = 2;
const TOP = 5;

const TOPICS = {
  auth: {
    strong: ['auth', 'authent*', 'authoriz*', 'login', 'logout', 'signin', 'signup', 'guard', 'permission', 'jwt', 'oauth', 'credential', 'sanctum', 'passport', 'firewall'],
    weak: ['token', 'role', 'session', 'password', 'register', 'polic*', 'acl'],
    routeMiddleware: true,
    conventionKeys: ['auth_guards', 'auth_tokens', 'firewalls', 'role_hierarchy'],
  },
  validation: {
    strong: ['valid*', 'constraint', 'sanitiz*'],
    weak: ['rule', 'schema', 'assert'],
    conventionKeys: ['validation'],
  },
  errors: {
    strong: ['error', 'exception', 'failure', 'fail', 'fault', 'throwable'],
    weak: ['handler', 'catch'],
    conventionKeys: ['errors'],
  },
  routing: {
    kinds: ['route', 'api_endpoint'],
    strong: ['route', 'router', 'routing', 'navigat*'],
    weak: ['path', 'page'],
    routeMiddleware: true,
    conventionKeys: ['routing', 'routes_auto_load', 'nextjs_router'],
  },
  state: {
    kinds: ['store', 'provider'],
    strong: ['store', 'bloc', 'cubit', 'notifier', 'reducer', 'slice', 'observable', 'getx', 'mobx', 'redux', 'riverpod', 'zustand', 'pinia', 'vuex', 'recoil', 'jotai'],
    weak: ['state', 'provider', 'context', 'signal', 'atom'],
    conventionKeys: ['state_management', 'vue_api', 'react_style'],
  },
  migrations: {
    kinds: ['migration'],
    strong: ['migrat*'],
    weak: ['schema'],
    manifestKeys: ['migrations'],
  },
  testing: {
    kinds: ['test'],
    strong: ['test', 'spec'],
    weak: ['mock', 'fixture', 'fake'],
    manifestKeys: ['test_frameworks'],
    includeTests: true,
  },
};
const ALIASES = {
  authentication: 'auth', authorization: 'auth', login: 'auth', security: 'auth', permissions: 'auth',
  validations: 'validation', validate: 'validation', validators: 'validation',
  error: 'errors', exceptions: 'errors', exception: 'errors', 'error handling': 'errors',
  routes: 'routing', route: 'routing', router: 'routing', navigation: 'routing',
  'state management': 'state', store: 'state', stores: 'state',
  migration: 'migrations', database: 'migrations',
  test: 'testing', tests: 'testing',
};

const TYPE_KINDS = new Set(['class', 'interface', 'trait', 'mixin', 'enum', 'component', 'hook', 'store', 'provider', 'function', 'type_alias', 'migration', 'route', 'api_endpoint', 'test']);
const MEMBER_KINDS = new Set(['method', 'property']);
const IGNORED_KINDS = new Set(['doc_section', 'env_var', 'config_key', 'db_table', 'variable']);
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e|integration_test)\/|(\.(test|spec)\.[^./]+$)|(_test\.[^./]+$)|(Test\.php$)/;
const GENERATED_PATH = /(^|\/)(generated|__generated__|mocks?|__mocks__|fixtures?|stories|storybook|\.storybook|vendor|node_modules|dist|build|\.dart_tool)\/|\.(g|freezed|gr|gen|generated|stories|d)\.[^./]+$/i;

export function conventionsFor(ctx, { topic }) {
  const { store, subproject, patterns, manifest } = ctx;
  const subId = subproject?.id ?? subproject;

  if (!topic || !topic.trim()) return notFound('No topic given.');

  const normalized = topic.toLowerCase().trim().replace(/\s+/g, ' ');
  const spec = TOPICS[normalized] || TOPICS[ALIASES[normalized]] || genericTopic(normalized);
  const score = scorer(spec);

  const nodes = store.findNodes({ subprojectId: subId })
    .filter(n => !IGNORED_KINDS.has(n.kind) && n.path && !GENERATED_PATH.test(n.path))
    .filter(n => spec.includeTests || !TEST_PATH.test(n.path));
  let onTopic = nodes.map(n => ({ node: n, ...score(n) })).filter(s => s.score >= MIN_SCORE);
  // Multi-word topics ("data fetching"): code naming every word beats code naming one.
  let partial = false;
  if (spec.stems?.length > 1) {
    const full = onTopic.filter(s => s.matched >= spec.stems.length);
    if (full.length >= 3) onTopic = full;
    else partial = onTopic.length > 0;
  }
  onTopic.sort((a, b) => b.score - a.score || typeRank(a.node) - typeRank(b.node) || a.node.path.localeCompare(b.node.path) || a.node.start_line - b.node.start_line);

  const examples = pickExamples(onTopic);
  const types = onTopic.filter(s => !MEMBER_KINDS.has(s.node.kind)).map(s => s.node);
  const baseTypes = topCounts(types.flatMap(n => baseTypesOf(n).map(shortName)));
  const locations = topCounts(types.map(n => path.posix.dirname(n.path)));
  const routeMiddleware = spec.routeMiddleware ? middlewareCounts(nodes) : null;

  const matchedPatterns = matchPatterns(patterns, spec, score);
  const topPattern = matchedPatterns[0] || null;

  const { manifestRules, docSections } = manifestRulesFor(store, subId, manifest, spec, normalized);

  const evidence = [];
  if (topPattern?.canonical?.path) {
    evidence.push({ path: topPattern.canonical.path, line_range: [topPattern.canonical.line, topPattern.canonical.line], symbol: topPattern.template?.symbol ?? topPattern.name, kind: topPattern.kind });
  }
  for (const ex of examples.slice(0, TOP)) {
    evidence.push({ path: ex.path, line_range: [ex.line, ex.end_line], symbol: ex.symbol, kind: ex.kind });
  }
  for (const node of docSections) {
    evidence.push({ path: node.path, line_range: [node.start_line, node.end_line], symbol: node.symbol, kind: node.kind });
  }
  const seen = new Set();
  const uniqueEvidence = evidence.filter((e) => {
    const key = `${e.path}:${e.line_range.join('-')}:${e.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const found = examples.length > 0 || topPattern || manifestRules.length > 0;
  return {
    answer: {
      pattern: topPattern ? { name: topPattern.name, kind: topPattern.kind, frequency: topPattern.frequency } : null,
      canonical_example: topPattern
        ? { path: topPattern.canonical?.path ?? null, line: topPattern.canonical?.line ?? null, template: topPattern.template ?? null }
        : null,
      variants: (topPattern?.variants ?? []).slice(0, 3).map(v => ({ ...v, examples: (v.examples || []).slice(0, 3) })),
      manifest_rules: manifestRules,
      ...(baseTypes.length > 0 ? { base_types: baseTypes.map(([name, count]) => ({ name, count })) } : {}),
      ...(locations.length > 0 ? { locations: locations.map(([dir, count]) => ({ dir, count })) } : {}),
      ...(routeMiddleware ? { route_middleware: routeMiddleware } : {}),
      examples,
      examples_total: onTopic.length,
      ...(partial ? { note: `Little code names all of "${topic}"; examples match some of its words.` } : {}),
      // An explicit negative needs no evidence (see GroundingWrapper.enforceEvidence).
      ...(!found ? { found: false, note: `No code, recurring pattern or documented rule found for "${topic}".` } : {}),
      all_patterns: matchedPatterns.slice(0, TOP).map(p => ({ name: p.name, kind: p.kind, frequency: p.frequency })),
    },
    evidence: uniqueEvidence,
    layer: 'L1',
  };
}

function notFound(note) {
  return {
    answer: { found: false, pattern: null, canonical_example: null, variants: [], manifest_rules: [], examples: [], note },
    evidence: [],
    layer: 'L1',
  };
}

// Any other topic ("logging", "caching", "data fetching"): every word is a strong stem.
function genericTopic(topic) {
  const stems = [...new Set(topic.split(/[^a-z0-9]+/).filter(w => w.length >= 3).map(topicStem))];
  return { strong: stems, weak: [], stems, conventionKeys: [] };
}

// ---------------------------------------------------------------------------
// Scoring

function scorer(spec) {
  const kinds = new Set(spec.kinds || []);
  const stemsOf = (words, list) => list.filter(stem => words.some(w => matchesStem(w, stem)));
  return (node) => {
    const nameWordsList = nameWords(sourceName(node.symbol));
    const baseWords = baseTypesOf(node).flatMap(t => nameWords(shortName(t)));
    const pathWords = node.path.split('/').flatMap(seg => nameWords(seg.split('.')[0]));
    const strongHits = new Set([...stemsOf(nameWordsList, spec.strong), ...stemsOf(baseWords, spec.strong)]);
    const weakHits = new Set([...stemsOf(nameWordsList, spec.weak), ...stemsOf(baseWords, spec.weak)]);
    const pathStrong = stemsOf(pathWords, spec.strong);
    const pathWeak = stemsOf(pathWords, spec.weak);

    let score = strongHits.size * STRONG + weakHits.size * WEAK
      + (pathStrong.length * STRONG + pathWeak.length * WEAK) * PATH_FACTOR;
    if (kinds.has(node.kind)) score += STRONG;
    if (MEMBER_KINDS.has(node.kind)) score *= MEMBER_FACTOR;
    const matched = new Set([...strongHits, ...pathStrong]).size;
    return { score, matched };
  };
}

function typeRank(node) {
  if (MEMBER_KINDS.has(node.kind)) return 2;
  return TYPE_KINDS.has(node.kind) ? 0 : 1;
}

function pickExamples(onTopic) {
  const perFile = new Map();
  const out = [];
  for (const { node } of onTopic) {
    const n = perFile.get(node.path) || 0;
    if (n >= PER_FILE) continue;
    perFile.set(node.path, n + 1);
    out.push({ symbol: node.symbol, kind: node.kind, path: node.path, line: node.start_line, end_line: node.end_line });
    if (out.length >= MAX_EXAMPLES) break;
  }
  return out;
}

// Recurring shapes whose members mostly embody the topic.
function matchPatterns(patterns, spec, score) {
  if (!patterns) return [];
  const kinds = new Set(spec.kinds || []);
  const out = [];
  for (const p of patterns.listPatterns()) {
    const members = p.members || [];
    if (members.length === 0) continue;
    // The shape name carries the base type (`class:ext=GetxController:...`).
    const ext = /ext=([^:]+)/.exec(p.name)?.[1];
    const fromShape = ext && ext !== 'none' ? score({ symbol: ext, path: '', kind: 'class', metadata: null }).score >= STRONG : false;
    const onTopic = kinds.has(p.kind) || fromShape
      ? members.length
      : members.filter(m => score({ symbol: m.symbol, path: m.path, kind: p.kind, metadata: null }).score >= MIN_SCORE).length;
    if (onTopic / members.length >= PATTERN_SHARE) out.push(p);
  }
  return out.sort((a, b) => b.frequency.count - a.frequency.count);
}

// Route middleware across all routes: how the project guards endpoints.
function middlewareCounts(nodes) {
  const routes = nodes.filter(n => n.kind === 'route');
  if (routes.length === 0) return null;
  const counts = topCounts(routes.flatMap(r => [...new Set(parseMeta(r.metadata).middleware || [])]));
  if (counts.length === 0) return null;
  return { routes: routes.length, middleware: counts.map(([name, count]) => ({ name, count })) };
}

function manifestRulesFor(store, subId, manifest, spec, topic) {
  const manifestRules = [];
  const docSections = [];
  if (!manifest) return { manifestRules, docSections };
  for (const key of spec.manifestKeys || []) {
    if (manifest[key] != null) manifestRules.push({ source: `manifest.${key}`, value: manifest[key] });
  }
  const conventions = manifest.conventions || {};
  for (const key of spec.conventionKeys || []) {
    if (conventions[key] != null) manifestRules.push({ source: `manifest.conventions.${key}`, value: conventions[key] });
  }
  // Sections harvested from CONVENTION.md / AGENTS.md etc. whose heading names the topic.
  const stems = spec.stems || [topicStem(topic.split(' ')[0])];
  for (const [key, value] of Object.entries(conventions._from_docs || {})) {
    if (stems.some(stem => nameWords(key).some(w => matchesStem(w, stem)))) {
      manifestRules.push({ source: `docs.${key}`, value });
      docSections.push(...store.findNodes({ subprojectId: subId, path: value?._source, kind: 'doc_section' }).filter(n => slugify(n.symbol) === key));
    }
  }
  return { manifestRules, docSections };
}

// ---------------------------------------------------------------------------
// Helpers

function baseTypesOf(node) {
  const meta = parseMeta(node.metadata);
  return [meta.extends, ...(meta.implements || []), ...(meta.interfaces || []), ...(meta.mixins || []), ...(meta.traits || [])]
    .filter(t => typeof t === 'string' && t);
}

function topCounts(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP);
}

const INFLECTION = /^(|s|es|e|ed|d|ing|ings|er|ers)$/;

function matchesStem(word, stem) {
  if (stem.endsWith('*')) return word.startsWith(stem.slice(0, -1));
  if (!word.startsWith(stem)) return false;
  const rest = word.slice(stem.length);
  // Doubled final consonant: log -> logger, logging.
  return INFLECTION.test(rest) || (rest.length > 1 && rest[0] === stem[stem.length - 1] && INFLECTION.test(rest.slice(1)));
}

// `errors` -> `error`, `testing` -> `test`, `migrations` -> `migration`.
function topicStem(topic) {
  // "logging" -> "logg" -> "log": undo the doubled consonant left by -ing.
  const stem = topic.replace(/(ing|es|s)$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  return stem.length >= 3 ? stem : topic;
}

// Words of an identifier: `logThrottled` -> log, throttled; `error_handling` -> error, handling.
function nameWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// The node's own name: `App\\Models\\User` -> User, `Store.load` -> load.
function sourceName(symbol) {
  const segments = String(symbol).split(/\\|::|\./).filter(Boolean);
  return segments[segments.length - 1] || String(symbol);
}

function shortName(type) {
  return String(type).replace(/<.*$/, '').split(/\\|\./).pop();
}

function parseMeta(json) {
  if (!json) return {};
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
