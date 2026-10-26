import fs from 'node:fs';
import path from 'node:path';
import { ownerSymbol, TYPE_KINDS } from './calls.js';
import { memberName } from './migrations.js';

// Who uses a symbol, beyond direct edges: callers that reach a method through
// the interface or parent class it implements, and call sites static
// analysis could not bind (receiver of unknown type). Shared by
// oracle.consumers, oracle.impact and the emit gate.

const MAX_INHERITANCE_DEPTH = 8;

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Call-site lines recorded on a `calls` edge (empty for other edges). */
export function callLines(edgeMetadata) {
  const lines = parseMetadata(edgeMetadata).lines;
  return Array.isArray(lines) ? lines.filter(Number.isInteger) : [];
}

export function callResolution(edgeMetadata) {
  return parseMetadata(edgeMetadata).resolution ?? null;
}

// The type node that declares a method (same file, enclosing range).
function declaringType(store, subprojectId, method) {
  const owner = ownerSymbol(method.symbol);
  if (!owner) return null;
  return store.locate(subprojectId, owner)
    .find(t => TYPE_KINDS.has(t.kind) && t.path === method.path && t.start_line <= method.start_line && t.end_line >= method.end_line)
    ?? null;
}

function walkTypes(store, start, next) {
  const seen = new Set([start.id]);
  const out = [];
  let frontier = [start];
  for (let depth = 0; depth < MAX_INHERITANCE_DEPTH && frontier.length > 0; depth++) {
    const following = [];
    for (const type of frontier) {
      for (const t of next(type.id)) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
        following.push(t);
      }
    }
    frontier = following;
  }
  return out;
}

/**
 * For a method: the declarations it overrides or implements (same name on an
 * ancestor type) and its implementations/overrides (same name on descendant
 * types). Empty for anything that is not a method of a known type.
 */
export function relatedMethods(store, subprojectId, node) {
  if (node?.kind !== 'method') return { overrides: [], implementations: [] };
  const type = declaringType(store, subprojectId, node);
  if (!type) return { overrides: [], implementations: [] };
  const name = memberName(node.symbol);
  const byOwner = new Map();
  for (const m of store.findMembersByName(subprojectId, name, 'method')) {
    const owner = ownerSymbol(m.symbol);
    if (owner && m.id !== node.id && !byOwner.has(owner)) byOwner.set(owner, m);
  }
  if (byOwner.size === 0) return { overrides: [], implementations: [] };
  const pick = (types) => types.map(t => byOwner.get(t.symbol)).filter(Boolean);
  return {
    overrides: pick(walkTypes(store, type, id => store.getInheritanceParents(id))),
    implementations: pick(walkTypes(store, type, id => store.getInheritanceChildren(id))),
  };
}

/**
 * Lines in files where a method of this name is called on a receiver whose
 * type is unknown — possible callers that were not bound. `exclude` holds
 * `path:line` keys already reported as resolved calls.
 */
export function possibleCallSites(store, subprojectId, root, node, { exclude = new Set(), maxFiles = 30 } = {}) {
  if (node?.kind !== 'method' || !root) return { sites: [], files: 0 };
  const name = memberName(node.symbol);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { sites: [], files: 0 };
  const paths = store.findPossibleCallSites(subprojectId, name);
  const pattern = new RegExp(`(?:->|\\?->|\\?\\.|\\.|::)\\s*${name.replace(/\$/g, '\\$')}\\s*\\(`);
  const sites = [];
  for (const rel of paths.slice(0, maxFiles)) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf-8'); } catch { continue; }
    const lines = [];
    text.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return;
      if (pattern.test(line) && !exclude.has(`${rel}:${i + 1}`)) lines.push(i + 1);
    });
    if (lines.length > 0) sites.push({ path: rel, lines });
  }
  return { sites, files: paths.length };
}
