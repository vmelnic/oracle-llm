import path from 'path';

// Where new code goes, learned from the repository itself rather than from
// framework rules:
//   1. The intent's head noun ("API *controller* for invoices") is the role.
//      A word is a role when the repo has files carrying it: as the last word
//      of the file name (InvoiceController.php, alerts_controller.dart), as
//      the parent directory (Middleware/, hooks/, detectors/) or through the
//      node kind it implies (hook, component, migration...).
//   2. Those role files say where such code lives: the directory that already
//      holds them for the intent's domain ("alerts"), else the per-feature
//      layout they follow (modules/<feature>/controllers), else the directory
//      holding most of them.
//   3. The file name copies the role files' conventions: shared prefix/suffix
//      (Api...Controller, use-...), timestamp prefix, extension, casing, or a
//      fixed name (page.tsx) inside a new feature directory.
// Tests, generated code and fixtures are never proposed unless asked for.

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'is', 'it', 'are', 'be', 'as', 'new', 'add', 'create', 'make',
  'build', 'implement', 'write', 'update', 'modify', 'change', 'some', 'any', 'all', 'one',
  'returns', 'return', 'get', 'gets', 'show', 'shows', 'code', 'file', 'module', 'should', 'we', 'i',
  'need', 'want', 'please', 'our', 'my', 'this', 'that', 'there',
]);
// Words that end the head phrase: "controller *for* invoices", "page *listing* x".
const BOUNDARY_WORDS = new Set([
  'for', 'to', 'that', 'which', 'when', 'with', 'of', 'on', 'in', 'from', 'by', 'about', 'into',
  'per', 'while', 'after', 'before', 'who', 'similar', 'like', 'based', 'same',
]);
// Code meant to be shared across features, not placed inside one.
const SHARED_QUALIFIERS = new Set(['reusable', 'shared', 'common', 'generic', 'global']);
// Directory names of cross-feature code: never a feature, preferred for shared code.
const SHARED_DIRS = new Set(['shared', 'common', 'core', 'global', 'base', 'ui', 'components', 'widgets', 'utils', 'helpers', 'lib']);
const SHARED_DIR_BONUS = 2;
// Describe how code is built, never what it is named.
const QUALIFIERS = new Set([
  'reusable', 'shared', 'common', 'global', 'generic', 'simple', 'basic', 'small', 'custom', 'react', 'vue', 'angular', 'svelte',
  'flutter', 'dart', 'laravel', 'symfony', 'php', 'typescript', 'javascript', 'ts', 'js', 'node',
  'next', 'nextjs', 'nuxt', 'django', 'rails', 'spring', 'go', 'rust', 'python', 'java', 'kotlin',
]);
// Generic software vocabulary: a role spelled differently by another stack.
const ROLE_SYNONYMS = {
  screen: ['view', 'page'], page: ['screen', 'view'], view: ['screen', 'page'],
  widget: ['component'], component: ['widget'],
  model: ['entity'], entity: ['model'],
  listener: ['handler', 'subscriber'], subscriber: ['listener'],
  helper: ['util'], util: ['helper'], utility: ['util', 'helper'],
  test: ['spec'], spec: ['test'],
  endpoint: ['controller'], handler: ['controller'],
};
// Node kinds that identify a role when file and directory names do not.
const ROLE_KINDS = {
  hook: ['hook'], composable: ['hook'], component: ['component'], widget: ['component'],
  migration: ['migration'], store: ['store'], provider: ['provider'], event: ['event'],
  route: ['route'], model: ['db_table'], test: ['test'], interface: ['interface'],
  trait: ['trait'], enum: ['enum'], mixin: ['mixin'],
};

const NAME_WEIGHT = 3;
const PARENT_DIR_WEIGHT = 2;
const KIND_WEIGHT = 1;
const SYNONYM_FACTOR = 0.5;
const MIN_FEATURES = 3;
const MIN_ROLE_FILES = 2;
// A layout this close to the best one in size, but varying a shallower
// directory (modules/<feature>/... over modules/menu/<sub-feature>/...), is
// the project-wide convention.
const LAYOUT_SHARE = 0.25;
const AFFIX_SHARE = 0.5;
const LOCAL_PREFIX_SHARE = 0.9;

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e|integration_test)\//i;
const TEST_FILE = /(\.(test|spec)\.[^./]+$)|(_test\.[^./]+$)|(Test\.php$)/;
const GENERATED_PATH = /(^|\/)(generated|__generated__|mocks?|__mocks__|fixtures?|stories|storybook|\.storybook|vendor|node_modules|dist|build|coverage|\.dart_tool|\.next|\.turbo)\//i;
const GENERATED_FILE = /\.(g|freezed|gr|gen|generated|mocks?|stories|d|config)\.[^./]+$/i;

export function whereWould(ctx, { intent }) {
  const { store, subproject } = ctx;
  const subId = subproject?.id ?? subproject;
  if (!intent || !intent.trim()) return noProposal('No intent given.');

  const parsed = parseIntent(intent);
  const testIntent = parsed.words.some(w => w === 'test' || w === 'spec');
  const files = store.getIndexedFiles(subId)
    .filter(f => !GENERATED_PATH.test(f) && !GENERATED_FILE.test(f))
    .filter(f => isTestFile(f) === testIntent)
    .sort();
  if (files.length === 0) return noProposal('No indexed files to learn from.');

  const kindFiles = new Map();
  const filesOfKind = (kind) => {
    if (!kindFiles.has(kind)) kindFiles.set(kind, new Set(store.findNodes({ subprojectId: subId, kind }).map(n => n.path)));
    return kindFiles.get(kind);
  };

  const role = pickRole(parsed, files, filesOfKind);
  const anchor = findAnchor(store, subId, parsed.analogs, files, role);
  if (!role && !anchor) {
    return noProposal(`No existing files match a kind of code named in "${intent}". Name it (controller, component, hook, service, migration...) or an existing symbol to imitate ("similar to X").`);
  }

  const domain = parsed.domain.filter(w => w !== role?.word);
  const placements = anchor
    ? [anchorPlacement(anchor, files, role)]
    : rolePlacements(role, domain, parsed);

  const proposed = [];
  const evidence = [];
  const existing = [];
  for (const placement of placements) {
    const proposal = buildProposal(store, subId, placement, parsed, domain, role, files);
    if (proposal?.exists) {
      existing.push(proposal.exists);
      continue;
    }
    if (!proposal || proposed.some(p => p.path === proposal.path)) continue;
    proposed.push(proposal);
    if (proposal.analog) {
      evidence.push({ path: proposal.analog.path, line_range: proposal.analog.line_range, symbol: proposal.analog.symbol, reason: proposal.reason });
    }
  }
  if (proposed.length === 0) {
    return existing.length > 0
      ? noProposal(`${existing.join(', ')} already exists: the intent most likely changes existing code (see oracle.context), or name the new file differently.`)
      : noProposal(`Could not derive a location for "${intent}".`);
  }

  return { answer: { proposed_paths: proposed }, evidence, layer: 'L1' };
}

function noProposal(note) {
  return { answer: { proposed_paths: [], found: false, note }, evidence: [], layer: 'L1' };
}

// ---------------------------------------------------------------------------
// Intent

function parseIntent(intent) {
  const raw = intent.replace(/[^\w\s/-]/g, ' ').split(/[\s/]+/).filter(Boolean);
  const words = [];
  const head = [];
  const tail = [];
  const sentence = [];
  const analogs = [];
  let inHead = true;
  let analogNext = false;
  for (const token of raw) {
    const lower = token.toLowerCase();
    // The name after "similar to" is taken as written, even `Billing`.
    if (analogNext && !BOUNDARY_WORDS.has(lower) && !STOP_WORDS.has(lower)) {
      analogs.push(token);
      analogNext = false;
      continue;
    }
    const isGerund = lower.length > 4 && lower.endsWith('ing');
    if (BOUNDARY_WORDS.has(lower) || (isGerund && head.length > 0)) {
      if (['similar', 'like', 'same', 'based'].includes(lower)) analogNext = true;
      if (inHead && head.length > 0) inHead = false;
      else if (!inHead && sentence.length > 0) sentence.push(lower);
      continue;
    }
    if (STOP_WORDS.has(lower) && !(!inHead && ['add', 'create', 'remove', 'drop', 'update', 'change'].includes(lower))) {
      continue;
    }
    if (inHead) {
      if (STOP_WORDS.has(lower)) continue;
      head.push(lower);
    } else {
      sentence.push(lower);
      if (STOP_WORDS.has(lower) || isGerund) continue;
      tail.push(lower);
    }
    if (!STOP_WORDS.has(lower)) words.push(singular(lower));
  }
  const modifiers = head.filter(w => !QUALIFIERS.has(w));
  return {
    shared: head.some(w => SHARED_QUALIFIERS.has(w)),
    words,
    head: modifiers,
    // Domain words name the new file: what follows the head ("for invoices"),
    // or the head's modifiers when nothing follows ("table component").
    domain: tail.length > 0 ? tail : modifiers,
    domainFromHead: tail.length === 0,
    sentence,
    analogs,
  };
}

// Head words are tried right to left ("API controller" -> controller); a
// role needs files in the repo. Without a head match, the best-scoring word.
function pickRole(parsed, files, filesOfKind) {
  const scored = new Map();
  const score = (word) => {
    if (!scored.has(word)) scored.set(word, roleFiles(singular(word), files, filesOfKind));
    return scored.get(word);
  };
  for (const word of [...parsed.head].reverse()) {
    const r = score(word);
    if (r.weights.size >= MIN_ROLE_FILES) return r;
  }
  let best = null;
  for (const word of parsed.domain) {
    const r = score(word);
    if (r.weights.size >= MIN_ROLE_FILES && r.total >= NAME_WEIGHT * 2 && (!best || r.total > best.total)) best = r;
  }
  return best;
}

function roleFiles(word, files, filesOfKind) {
  const terms = new Map([[word, 1]]);
  for (const syn of ROLE_SYNONYMS[word] || []) terms.set(syn, SYNONYM_FACTOR);
  const kinds = new Map();
  for (const [term, factor] of terms) {
    for (const kind of ROLE_KINDS[term] || []) kinds.set(kind, Math.max(kinds.get(kind) || 0, factor));
  }
  const weights = new Map();
  let total = 0;
  for (const file of files) {
    const stemWords = nameWords(fileStem(file));
    const parent = path.posix.dirname(file).split('/').pop() || '';
    const parentWords = nameWords(parent).map(singular);
    let w = 0;
    for (const [term, factor] of terms) {
      if (singular(stemWords[stemWords.length - 1] || '') === term) w = Math.max(w, NAME_WEIGHT * factor);
      if (parentWords.length > 0 && (parentWords[parentWords.length - 1] === term || parentWords.join('') === term)) {
        w = Math.max(w, PARENT_DIR_WEIGHT * factor + (w > 0 ? NAME_WEIGHT * factor : 0));
      }
    }
    for (const [kind, factor] of kinds) {
      if (filesOfKind(kind).has(file)) w += KIND_WEIGHT * factor;
    }
    if (w > 0) {
      weights.set(file, w);
      total += w;
    }
  }
  return { word, weights, total };
}

// Symbols named after "similar to" / "like": the new code sits beside them.
// Preference: inside the role's files, then a top-level symbol, then a file
// of that name, then a method (`locate` the tool over GraphStore.locate).
function findAnchor(store, subId, analogs, files, role) {
  const indexed = new Set(files);
  const inRole = (p) => (role?.weights.has(p) ? 0 : 1);
  for (const name of analogs) {
    const candidates = [
      ...store.findNodes({ subprojectId: subId, symbol: name }).map(node => ({ node, path: node.path, rank: 0 })),
      ...files.filter(f => fileStem(f).toLowerCase() === name.toLowerCase()).map(file => ({ file, path: file, rank: 1 })),
      ...store.findMembersByName(subId, name, 'method').map(node => ({ node, path: node.path, rank: 2 })),
    ].filter(c => indexed.has(c.path));
    if (candidates.length === 0) continue;
    const best = candidates.sort((a, b) => inRole(a.path) - inRole(b.path) || a.rank - b.rank || a.path.localeCompare(b.path))[0];
    return { name, node: best.node, file: best.file };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Placement

function anchorPlacement(anchor, files, role) {
  const file = anchor.node?.path ?? anchor.file;
  const dir = path.posix.dirname(file);
  const siblings = files.filter(f => path.posix.dirname(f) === dir);
  return { dir, siblings, kind: 'anchor', anchor, analogFile: file, role };
}

function rolePlacements(role, domain, parsed) {
  const byDir = new Map();
  for (const [file, w] of role.weights) {
    const dir = path.posix.dirname(file);
    const entry = byDir.get(dir) || { dir, score: 0, files: [] };
    entry.score += w;
    entry.files.push(file);
    byDir.set(dir, entry);
  }
  const dirs = [...byDir.values()].sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
  const layouts = featureLayouts(dirs);

  // Shared code goes outside the per-feature directories.
  if (parsed.shared) {
    const insideFeature = (dir) => layouts.some(t => dir.startsWith(`${t.prefix}/`)
      && !SHARED_DIRS.has(dir.slice(t.prefix.length + 1).split('/')[0].toLowerCase()));
    const sharedScore = (d) => d.score * (d.dir.toLowerCase().split('/').some(seg => SHARED_DIRS.has(seg) && seg !== 'lib') ? SHARED_DIR_BONUS : 1);
    const outside = dirs.filter(d => !insideFeature(d.dir)).sort((a, b) => sharedScore(b) - sharedScore(a) || a.dir.localeCompare(b.dir));
    if (outside.length > 0) return [{ ...outside[0], siblings: outside[0].files, kind: 'shared' }];
  }

  // The role's files for this domain already live somewhere: go there.
  const domainKeys = parsed.domainFromHead && parsed.shared ? [] : domainKeysOf(domain);
  if (domainKeys.length > 0) {
    const matching = dirs.filter(d => d.dir.split('/').some(seg => domainKeys.includes(normalizeKey(seg))));
    if (matching.length > 0) return [{ ...matching[0], siblings: matching[0].files, kind: 'domain' }];
  }

  const top = dirs[0];
  const layout = preferredLayout(layouts);
  const fixed = { ...top, siblings: top.files, kind: 'directory' };
  if (!layout) return [fixed];
  const perFeature = { ...layout, kind: 'feature' };
  // The layout wins when it holds more of the role's files than the biggest
  // single directory; the other placement stays as an alternative.
  return layout.score > top.score ? [perFeature, fixed] : [fixed, perFeature];
}

// A directory pattern with one varying segment (modules/<feature>/controllers)
// shared by role files of at least MIN_FEATURES features.
function featureLayouts(dirs) {
  const templates = new Map();
  for (const d of dirs) {
    const segments = d.dir.split('/');
    for (let i = 1; i < segments.length; i++) {
      const key = [...segments.slice(0, i), '*', ...segments.slice(i + 1)].join('/');
      const t = templates.get(key) || { template: key, score: 0, values: new Map(), siblings: [] };
      t.score += d.score;
      t.values.set(segments[i], (t.values.get(segments[i]) || 0) + d.files.length);
      t.siblings.push(...d.files);
      templates.set(key, t);
    }
  }
  return [...templates.values()]
    .filter(t => t.values.size >= MIN_FEATURES)
    .map(t => ({ ...t, prefix: t.template.slice(0, t.template.indexOf('/*')) }));
}

function preferredLayout(valid) {
  if (valid.length === 0) return null;
  const best = Math.max(...valid.map(t => t.score));
  const depth = (t) => t.template.split('/').indexOf('*');
  return valid
    .filter(t => t.score >= best * LAYOUT_SHARE)
    .sort((a, b) => depth(a) - depth(b) || b.score - a.score || a.template.localeCompare(b.template))[0];
}

// ---------------------------------------------------------------------------
// Proposal

function buildProposal(store, subId, placement, parsed, domain, role, files) {
  const siblings = placement.siblings.filter(Boolean);
  if (siblings.length === 0) return null;
  const stems = siblings.map(fileStem);
  const convention = namingConvention(stems, siblings, role ? [...role.weights.keys()] : siblings, directoryWords(files));
  const roleTerms = new Set([role?.word, ...(ROLE_SYNONYMS[role?.word] || [])].filter(Boolean));

  let dir = placement.dir;
  let featureDir = null;
  const domainName = domain[0] ? domain[0] : null;
  // Feature directories named like the existing ones: Course/, Taxonomy/ -> Invoice/.
  const featureName = (dirNames) => applyStyle(
    domainName ? withNumber(nameWords(domainName), grammaticalNumber(dirNames)) : ['new', 'feature'],
    detectStyle(dirNames),
  );
  if (placement.kind === 'feature') {
    featureDir = featureName([...placement.values.keys()]);
    dir = placement.template.replace('*', featureDir);
  }

  const dirWords = new Set(dir.toLowerCase().split('/').flatMap(seg => nameWords(seg)).map(singular));
  const affixes = new Set([convention.prefix, convention.suffix].filter(Boolean).map(singular));
  // Words the directory already says are dropped from head modifiers only
  // ("contract detector" in src/contracts/detectors); the feature named after
  // "for" stays in the name, as in alerts/controllers/alerts_controller.dart.
  const pick = (words, fromHead) => words.filter(w => !roleTerms.has(singular(w)) && !affixes.has(singular(w))
    && !(fromHead && dirWords.has(singular(w))));

  let base;
  if (convention.fixedName) {
    // Every feature has the same file (page.tsx, index.ts): the name goes on the directory.
    if (placement.kind !== 'feature') {
      featureDir = featureName(siblingDirNames(siblings));
      dir = path.posix.join(dir, featureDir);
    }
    base = convention.fixedName;
  } else {
    // A timestamped name describes the change ("add_status_to_orders") and
    // keeps its words; other names follow the neighbours' singular/plural.
    const body = convention.timestamp && parsed.sentence.length > 0
      ? pick(parsed.sentence, false)
      : withNumber(pick(domain, parsed.domainFromHead), grammaticalNumber(stems, convention));
    const words = body.length > 0 ? body : ['new', role?.word || 'module'];
    const all = [
      ...(convention.timestamp ? [] : convention.prefix ? [convention.prefix] : []),
      ...words,
      ...(convention.suffix ? [convention.suffix] : []),
    ];
    base = applyStyle(all, convention.style);
    if (convention.timestamp) base = `${convention.timestamp}${convention.style === 'kebab' ? '-' : '_'}${base}`;
  }

  // A name that already exists means the intent is about that file: say so
  // instead of inventing `pipeline_2.js`.
  const candidate = path.posix.join(dir, `${base}${convention.ext}`);
  if (files.some(f => f.toLowerCase() === candidate.toLowerCase())) return { exists: candidate };

  const analogFile = placement.analogFile ?? bestSibling(siblings, role, placement);
  const analogNode = mainNode(store, subId, analogFile, placement.anchor, role);
  return {
    path: candidate,
    reason: reasonFor(placement, role, siblings, featureDir, dir, analogFile),
    convention: {
      ...(convention.prefix ? { prefix: convention.prefix } : {}),
      ...(convention.suffix ? { suffix: convention.suffix } : {}),
      ...(convention.timestamp ? { timestamp_prefix: true } : {}),
      ...(convention.fixedName ? { file_name: `${convention.fixedName}${convention.ext}` } : {}),
      style: convention.style,
      extension: convention.ext,
    },
    analog: analogNode
      ? { path: analogNode.path, symbol: analogNode.symbol, line_range: [analogNode.start_line, analogNode.end_line] }
      : null,
  };
}

function reasonFor(placement, role, siblings, featureDir, dir, analogFile) {
  const what = role ? `${role.word} files` : 'files';
  const example = fileStem(analogFile ?? siblings[0]);
  if (placement.kind === 'anchor') return `${placement.anchor.name}, named in the request, lives in ${placement.dir}`;
  if (placement.kind === 'shared') return `${placement.dir} holds the most ${what} outside per-feature directories (${siblings.length}, e.g. ${example})`;
  if (placement.kind === 'domain') return `${placement.dir} already holds ${siblings.length} ${what} for this feature (e.g. ${example})`;
  if (placement.kind === 'feature') {
    const features = placement.values.size;
    return `${what} are grouped per feature as ${placement.template.replace('*', '<feature>')} (${features} features, ${siblings.length} files); new feature directory ${featureDir}`;
  }
  return `${placement.dir} holds the most ${what} (${siblings.length}, e.g. ${example})${dir !== placement.dir ? `; new directory ${featureDir}` : ''}`;
}

function bestSibling(siblings, role, placement) {
  const ranked = [...siblings].sort((a, b) => (role?.weights.get(b) || 0) - (role?.weights.get(a) || 0) || a.localeCompare(b));
  if (placement.kind === 'feature') {
    // From the feature with the most files: the most typical example.
    const [value] = [...placement.values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const segIndex = placement.template.split('/').indexOf('*');
    return ranked.find(f => f.split('/')[segIndex] === value) ?? ranked[0];
  }
  return ranked[0];
}

// The node an analog file is about: the anchor itself, else its first
// top-level declaration (a type or component before helpers).
function mainNode(store, subId, file, anchor, role) {
  if (anchor?.node) return anchor.node;
  if (!file) return null;
  const nodes = store.findNodes({ subprojectId: subId, path: file }).filter(n => n.start_line > 0 && n.kind !== 'doc_section');
  if (nodes.length === 0) return null;
  const roleKinds = new Set(ROLE_KINDS[role?.word] || []);
  const rank = { class: 1, component: 1, interface: 2, trait: 2, mixin: 2, hook: 2, migration: 2, function: 3, enum: 3, db_table: 4 };
  // A table is derived from the model class: the class is the example to copy.
  const rankOf = (n) => (roleKinds.has(n.kind) && n.kind !== 'db_table' ? 0 : rank[n.kind] ?? 5);
  return nodes.sort((a, b) => rankOf(a) - rankOf(b) || (b.exported ? 1 : 0) - (a.exported ? 1 : 0) || a.start_line - b.start_line)[0];
}

// ---------------------------------------------------------------------------
// Naming conventions

function namingConvention(stems, siblings, roleFiles, dirWords = new Set()) {
  const ext = mostCommon(siblings.map(fileExt).filter(Boolean)) || '.js';
  const style = detectStyle(stems);
  const share = (n) => n / stems.length;

  const sameName = mostCommonEntry(stems.map(s => s.toLowerCase()));
  if (stems.length >= MIN_FEATURES && sameName && share(sameName[1]) >= 0.6) {
    return { ext, style, fixedName: stems.find(s => s.toLowerCase() === sameName[0]) };
  }

  const stampRe = /^(\d+(?:[_-]\d+)*)[_-]/;
  const stamped = stems.map(s => s.match(stampRe)?.[1]).filter(Boolean);
  const timestamp = stems.length >= 2 && share(stamped.length) >= 0.5 ? newTimestamp(mostCommon(stamped.map(shapeOf))) : null;

  const words = (files) => files.map(f => nameWords(fileStem(f).replace(stampRe, ''))).filter(w => w.length > 1);
  const local = words(siblings);
  const global = words(roleFiles);
  const dirsOf = (pick, word) => new Set(roleFiles.filter(f => pick(nameWords(fileStem(f).replace(stampRe, ''))) === word)
    .map(f => path.posix.dirname(f))).size;
  // An affix is a convention when most of the role's files carry it, here
  // and across the project. A prefix must also span several directories or
  // be no directory's name: `Course...` shared by one feature's files is a
  // domain word (there is a Course/ directory), `Api...` across features or
  // `use-...` in a single hooks/ directory is a convention.
  const affix = (pick, needsSpread) => {
    const source = local.length >= 2 ? local : global;
    const top = mostCommonEntry(source.map(pick));
    if (!top || top[1] / source.length < AFFIX_SHARE) return null;
    const support = global.filter(w => pick(w) === top[0]).length;
    if (global.length === 0 || support / global.length < AFFIX_SHARE) return null;
    if (needsSpread && dirsOf(pick, top[0]) < MIN_FEATURES) {
      // Within one directory only a near-universal prefix that names no
      // directory counts: `use-` on every hook, not `Send...` on 2 of 3 listeners.
      const universal = support >= MIN_FEATURES && support / global.length >= LOCAL_PREFIX_SHARE;
      if (!universal || dirWords.has(singular(top[0]))) return null;
    }
    return top[0];
  };
  return {
    ext,
    style,
    timestamp,
    // Timestamped names start with what the change does (create_, add_), not a fixed prefix.
    prefix: timestamp ? null : affix(w => w[0], true),
    suffix: affix(w => w[w.length - 1], false),
  };
}

// `2024_10_20_000001` -> "4_2_2_6": the digit groups and their separators.
function shapeOf(stamp) {
  return stamp.replace(/\d+/g, d => String(d.length));
}

function newTimestamp(shape) {
  if (!shape) return null;
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  let digits = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return shape.replace(/\d+/g, (len) => {
    const n = Number(len);
    const part = digits.slice(0, n).padEnd(n, '0');
    digits = digits.slice(n);
    return part;
  });
}

// Whether the neighbours name things in the singular (CourseController,
// UserController) or the plural (alerts_controller, orders_view): judged on
// the last word before the role suffix, only when at least 70% agree.
const NUMBER_SHARE = 0.7;

function grammaticalNumber(names, convention = {}) {
  const affixes = new Set([convention.prefix, convention.suffix].filter(Boolean));
  const nouns = [];
  for (const name of names) {
    const words = nameWords(String(name).replace(/^\d+(?:[_-]\d+)*[_-]/, '')).filter(w => !affixes.has(w));
    const last = words[words.length - 1];
    if (last && last.length > 3 && /^[a-z]+$/.test(last)) nouns.push(last);
  }
  if (nouns.length < MIN_FEATURES) return null;
  const plural = nouns.filter(w => singular(w) !== w).length / nouns.length;
  if (plural >= NUMBER_SHARE) return 'plural';
  if (plural <= 1 - NUMBER_SHARE) return 'singular';
  return null;
}

// Singular: every word ("invoices state" -> invoice state). Plural: the head
// noun only, the last word ("invoice" -> invoices).
function withNumber(words, number) {
  if (!number || words.length === 0) return words;
  const singularWords = words.map(singular);
  if (number === 'singular') return singularWords;
  return [...singularWords.slice(0, -1), plural(singularWords[singularWords.length - 1])];
}

function plural(word) {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

// Every word used in a directory name of the subproject.
function directoryWords(files) {
  const words = new Set();
  for (const f of files) {
    for (const seg of path.posix.dirname(f).split('/')) for (const w of nameWords(seg)) words.add(singular(w));
  }
  return words;
}

function siblingDirNames(files) {
  return [...new Set(files.map(f => path.posix.dirname(f).split('/').pop()))];
}

function detectStyle(names) {
  const counts = { kebab: 0, snake: 0, pascal: 0, camel: 0 };
  for (const name of names) {
    if (name.includes('-')) counts.kebab++;
    else if (name.includes('_')) counts.snake++;
    else if (/^[A-Z]/.test(name)) counts.pascal++;
    else if (/[a-z][A-Z]/.test(name)) counts.camel++;
  }
  const [style, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  // Single-word lowercase names (index.js, store.js) read best as kebab-case.
  return count > 0 ? style : 'kebab';
}

function applyStyle(words, style) {
  const parts = words.flatMap(w => nameWords(w));
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  if (style === 'kebab') return parts.join('-');
  if (style === 'snake') return parts.join('_');
  if (style === 'camel') return parts[0] + parts.slice(1).map(cap).join('');
  return parts.map(cap).join('');
}

// ---------------------------------------------------------------------------
// Words

function isTestFile(file) {
  return TEST_PATH.test(file) || TEST_FILE.test(file);
}

function fileStem(file) {
  return path.posix.basename(file).split('.')[0];
}

// Everything after the stem: `.test.js`, `.php`, `.dart`.
function fileExt(file) {
  return path.posix.basename(file).slice(fileStem(file).length);
}

// `ApiUserController` -> api, user, controller; `use-course-calendar` -> use, course, calendar.
function nameWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function singular(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|x|ch|sh|us)es$/.test(word)) return word.slice(0, -2);
  if (/(ss|us|is)$/.test(word)) return word;
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function normalizeKey(segment) {
  return singular(nameWords(segment).join(''));
}

function domainKeysOf(domain) {
  if (domain.length === 0) return [];
  const keys = new Set([singular(domain[0])]);
  if (domain.length > 1) keys.add(singular(domain.slice(0, 2).join('')));
  return [...keys];
}

function mostCommonEntry(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] ?? null;
}

function mostCommon(values) {
  return mostCommonEntry(values)?.[0] ?? null;
}
