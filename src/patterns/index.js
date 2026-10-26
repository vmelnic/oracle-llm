import fs from 'fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import path from 'path';

export class PatternCatalogue {
  constructor(store) {
    this.store = store;
    this.patterns = new Map();
  }

  extract(subproject) {
    const nodes = this.store.findNodes({ subprojectId: subproject.id });
    const grouped = groupByStructuralShape(nodes);

    this.patterns.clear();
    for (const [shape, members] of grouped) {
      if (members.length < 2) continue;
      const total = countTotalOfKind(nodes, members[0].kind);
      const canonical = pickCanonical(members);
      const variants = detectVariants(members, canonical);

      this.patterns.set(shape, {
        name: shape,
        kind: members[0].kind,
        frequency: { count: members.length, total },
        // The canonical symbol lets tools cite verifiable evidence for the pattern.
        template: { symbol: canonical.symbol, ...buildTemplate(canonical) },
        canonical: { path: canonical.path, line: canonical.start_line },
        variants,
        members: members.map(m => ({
          symbol: m.symbol,
          path: m.path,
          line: m.start_line,
        })),
      });
    }
    return this.patterns;
  }

  getPattern(name) {
    return this.patterns.get(name) || null;
  }

  listPatterns() {
    return Array.from(this.patterns.values()).sort(
      (a, b) => b.frequency.count - a.frequency.count
    );
  }

  rerank(recentlyChangedPaths = []) {
    const changedSet = new Set(recentlyChangedPaths.map(p => p.replace(/\\/g, '/')));

    for (const pattern of this.patterns.values()) {
      const membersInChanged = pattern.members.filter(m => changedSet.has(m.path.replace(/\\/g, '/'))).length;
      const freshnessBoost = membersInChanged / Math.max(pattern.members.length, 1);
      pattern._rank_score = pattern.frequency.count * (1 + freshnessBoost * 0.5);
    }

    const sorted = Array.from(this.patterns.entries()).sort(
      (a, b) => (b[1]._rank_score || b[1].frequency.count) - (a[1]._rank_score || a[1].frequency.count)
    );
    this.patterns = new Map(sorted);
  }

  findPatternsForKind(kind) {
    return this.listPatterns().filter(p => p.kind === kind);
  }

  save(outputPath) {
    const data = this.listPatterns();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    atomicWriteFileSync(outputPath, JSON.stringify(data, null, 2));
    return data.length;
  }

  load(inputPath) {
    if (!fs.existsSync(inputPath)) return 0;
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    this.patterns.clear();
    for (const p of data) {
      this.patterns.set(p.name, p);
    }
    return data.length;
  }
}

function groupByStructuralShape(nodes) {
  const groups = new Map();

  for (const node of nodes) {
    const shape = computeShape(node);
    if (!shape) continue;
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(node);
  }
  return groups;
}

// An explicit auth flag (decorators, attributes) or an auth middleware
// (`auth:sanctum`, `jwt`, `can:edit`, `role:admin`).
const AUTH_MIDDLEWARE = /auth|sanctum|passport|jwt|guard|^can:|^role|permission/i;

function routeHasAuth(meta) {
  return !!meta.auth || (Array.isArray(meta.middleware) && meta.middleware.some(m => AUTH_MIDDLEWARE.test(String(m))));
}

function computeShape(node) {
  const meta = safeParse(node.metadata);
  const kind = node.kind;

  if (kind === 'route') {
    const method = meta.method || 'GET';
    const pathDepth = (meta.path || '').split('/').filter(Boolean).length;
    return `route:${method}:depth=${pathDepth}:auth=${routeHasAuth(meta)}`;
  }

  if (kind === 'method' || kind === 'function') {
    const isAsync = meta.async || /^async /.test(node.signature || '');
    const paramCount = countParams(node.signature);
    const hasReturn = meta.return_type && meta.return_type !== 'void';
    const hasDoc = !!node.doc;
    // Kind is part of the shape: functions and methods are separate patterns,
    // so a pattern's count never exceeds the total for its kind.
    const prefix = kind === 'method' ? 'method' : 'fn';
    return `${prefix}:async=${!!isAsync}:params=${paramCount}:returns=${!!hasReturn}:doc=${hasDoc}`;
  }

  if (kind === 'class') {
    const ext = meta.extends || 'none';
    const ifaceCount = (meta.implements || []).length;
    const traitCount = (meta.traits || meta.uses || []).length;
    const decoratorCount = (meta.decorators || []).length;
    return `class:ext=${ext}:ifaces=${ifaceCount}:traits=${traitCount}:decorators=${decoratorCount}`;
  }

  if (kind === 'component') {
    const api = meta.api || 'unknown';
    const hasProps = (meta.props || []).length > 0;
    const hasEmits = (meta.emits || []).length > 0;
    const hasSlots = !!meta.slots;
    return `component:api=${api}:props=${hasProps}:emits=${hasEmits}:slots=${hasSlots}`;
  }

  if (kind === 'migration') {
    const op = meta.operation || 'unknown';
    return `migration:${op}`;
  }

  if (kind === 'api_endpoint') {
    return `api_endpoint:${meta.type || 'generic'}`;
  }

  return `${kind}:generic`;
}

function countParams(signature) {
  if (!signature) return 0;
  const match = signature.match(/\(([^)]*)\)/);
  if (!match || !match[1].trim()) return 0;
  return match[1].split(',').length;
}

function countTotalOfKind(nodes, kind) {
  return nodes.filter(n => n.kind === kind).length;
}

function pickCanonical(members) {
  return members.reduce((best, m) => {
    const bestLines = best.end_line - best.start_line;
    const mLines = m.end_line - m.start_line;
    if (Math.abs(mLines - median(members)) < Math.abs(bestLines - median(members))) {
      return m;
    }
    return best;
  });
}

function median(members) {
  const sizes = members.map(m => m.end_line - m.start_line).sort((a, b) => a - b);
  const mid = Math.floor(sizes.length / 2);
  return sizes.length % 2 === 0
    ? (sizes[mid - 1] + sizes[mid]) / 2
    : sizes[mid];
}

function detectVariants(members, canonical) {
  const variants = new Map();
  const canonicalShape = detailedShape(canonical);

  for (const m of members) {
    if (m === canonical) continue;
    const shape = detailedShape(m);
    const diffs = diffShapes(canonicalShape, shape);
    if (diffs.length === 0) continue;
    const variantName = diffs.join('+');
    if (!variants.has(variantName)) {
      variants.set(variantName, { name: variantName, diffs, examples: [] });
    }
    variants.get(variantName).examples.push({
      symbol: m.symbol,
      path: m.path,
      line: m.start_line,
    });
  }
  return Array.from(variants.values());
}

function detailedShape(node) {
  const meta = safeParse(node.metadata);
  return {
    kind: node.kind,
    exported: node.exported,
    hasDoc: !!(node.doc),
    paramCount: countParams(node.signature),
    lineCount: node.end_line - node.start_line,
    extras: Object.keys(meta).sort(),
  };
}

function diffShapes(a, b) {
  const diffs = [];
  if (a.exported !== b.exported) diffs.push('export-diff');
  if (a.hasDoc !== b.hasDoc) diffs.push('doc-diff');
  if (a.paramCount !== b.paramCount) diffs.push('param-count-diff');
  if (Math.abs(a.lineCount - b.lineCount) > a.lineCount * 0.5) diffs.push('size-diff');
  return diffs;
}

function buildTemplate(node) {
  const meta = safeParse(node.metadata);
  const kind = node.kind;

  if (kind === 'route') {
    const method = meta.method || 'GET';
    const auth = routeHasAuth(meta);
    const routePath = meta.path || '';
    const mw = Array.isArray(meta.middleware) ? meta.middleware : [];
    return {
      kind,
      pattern: `${method} ${routePath}${auth ? ' [auth]' : ''}`,
      structure: {
        method,
        path: routePath,
        auth,
        middleware: mw,
        handler_params: extractParamNames(node.signature),
      },
      signature: node.signature,
      path: node.path,
      line: node.start_line,
    };
  }

  if (kind === 'component') {
    return {
      kind,
      pattern: `<${node.symbol} props=[${(meta.props || []).length}] emits=[${(meta.emits || []).length}]>`,
      structure: {
        name: node.symbol,
        api: meta.api || 'unknown',
        props: meta.props || [],
        emits: meta.emits || [],
        imports: meta.imports || [],
      },
      signature: node.signature,
      path: node.path,
      line: node.start_line,
    };
  }

  if (kind === 'function' || kind === 'method') {
    const isAsync = meta.async || /^async /.test(node.signature || '');
    const params = extractParamNames(node.signature);
    return {
      kind,
      pattern: `${isAsync ? 'async ' : ''}${node.symbol}(${params.join(', ')})${meta.returnType ? ': ' + meta.returnType : ''}`,
      structure: {
        name: node.symbol,
        async: !!isAsync,
        params,
        returnType: meta.returnType || null,
        exported: !!node.exported,
      },
      signature: node.signature,
      path: node.path,
      line: node.start_line,
    };
  }

  if (kind === 'class') {
    return {
      kind,
      pattern: `class ${node.symbol}${meta.extends ? ' extends ' + meta.extends : ''}${(meta.implements || []).length ? ' implements ' + meta.implements.join(', ') : ''}`,
      structure: {
        name: node.symbol,
        extends: meta.extends || null,
        implements: meta.implements || [],
        traits: meta.traits || meta.uses || [],
        methods_count: meta.methodCount || null,
      },
      signature: node.signature,
      path: node.path,
      line: node.start_line,
    };
  }

  if (kind === 'migration') {
    return {
      kind,
      pattern: `${meta.operation || 'change'} ${meta.table || ''}`,
      structure: {
        operation: meta.operation || 'unknown',
        table: meta.table || null,
        columns: meta.columns || [],
      },
      signature: node.signature,
      path: node.path,
      line: node.start_line,
    };
  }

  return {
    symbol: node.symbol,
    kind,
    signature: node.signature,
    path: node.path,
    line: node.start_line,
    metadata: meta,
  };
}

function extractParamNames(signature) {
  if (!signature) return [];
  const match = signature.match(/\(([^)]*)\)/);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(p => {
    const trimmed = p.trim();
    const name = trimmed.split(':')[0].split('=')[0].split(/\s/).pop();
    return name || trimmed;
  }).filter(Boolean);
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
