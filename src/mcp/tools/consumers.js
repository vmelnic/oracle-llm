import { callLines, callResolution, possibleCallSites, relatedMethods } from '../../graph/usage.js';
import { positiveInt } from '../../utils/env.js';

/**
 * Who uses a symbol: direct users with the exact call lines, transitive
 * users, callers that reach a method through the interface or parent it
 * implements, its implementations, and call sites static analysis could not
 * bind. `complete: false` says the list may miss callers.
 */
export function consumers(ctx, { target, kind }) {
  const { store, subproject } = ctx;
  const subprojectId = subproject?.id ?? subproject;

  if (!target) {
    return { answer: { target: null, consumers: [] }, evidence: [], layer: 'L1' };
  }

  let targetNode;
  let others = [];
  if (typeof target === 'number' || /^\d+$/.test(target)) {
    targetNode = store.getNode(typeof target === 'number' ? target : parseInt(target, 10));
  } else {
    const located = store.locate(subprojectId, target);
    targetNode = located[0];
    others = located.slice(1, 6);
  }
  if (!targetNode) {
    return {
      answer: { found: false, target, consumers: [], message: 'symbol not found' },
      evidence: [],
      layer: 'L1',
    };
  }

  let rows = store.consumers(subprojectId, targetNode.id);
  if (kind) rows = rows.filter(r => r.edge_kind === kind || r.kind === kind);

  const direct = rows.filter(r => r.depth === 1).map(r => describeUser(r));
  const transitive = rows.filter(r => r.depth > 1).map(r => ({
    symbol: r.symbol, kind: r.kind, path: r.path, line: r.start_line, via: r.edge_kind, depth: r.depth,
  }));

  // Callers of the interface / parent declaration this method implements.
  const related = relatedMethods(store, subprojectId, targetNode);
  const directIds = new Set(rows.map(r => r.id));
  const throughParent = [];
  for (const decl of related.overrides) {
    const callers = store.consumers(subprojectId, decl.id, 1)
      .filter(r => r.edge_kind === 'calls' && !directIds.has(r.id))
      .map(r => describeUser(r));
    if (callers.length > 0) throughParent.push({ declared_in: decl.symbol, path: decl.path, callers });
  }
  const implementations = related.implementations.map(m => ({ symbol: m.symbol, path: m.path, line_range: [m.start_line, m.end_line] }));

  const resolvedLines = new Set([...direct, ...throughParent.flatMap(t => t.callers)]
    .flatMap(c => (c.call_lines || []).map(line => `${c.path}:${line}`)));
  const possible = kind && kind !== 'calls' ? { sites: [], files: 0 } : possibleCallSites(store, subprojectId, subproject?.root, targetNode, { exclude: resolvedLines });

  const inferred = [...direct, ...throughParent.flatMap(t => t.callers)].filter(c => c.resolution === 'receiver_name').length;
  const complete = possible.sites.length === 0;

  const answer = {
    target: { symbol: targetNode.symbol, kind: targetNode.kind, path: targetNode.path, line_range: [targetNode.start_line, targetNode.end_line] },
    summary: summarize(direct, transitive, throughParent, possible, inferred),
    complete,
    direct,
    ...(throughParent.length > 0 ? { through_parent: throughParent } : {}),
    ...(implementations.length > 0 ? { implementations } : {}),
    ...(possible.sites.length > 0 ? { possible_call_sites: possible.sites } : {}),
    transitive,
    ...(others.length > 0 ? { other_matches: others.map(o => `${o.symbol} (${o.kind}) ${o.path}`) } : {}),
  };

  return {
    answer,
    evidence: buildEvidence(targetNode, direct, throughParent, possible.sites),
    layer: 'L1',
    // Unbound call sites mean the caller list may be incomplete.
    ...(complete ? {} : { confidence_cap: 0.7 }),
  };
}

function describeUser(row) {
  const lines = row.edge_kind === 'calls' ? callLines(row.edge_metadata) : [];
  const resolution = row.edge_kind === 'calls' ? callResolution(row.edge_metadata) : null;
  return {
    symbol: row.symbol,
    kind: row.kind,
    path: row.path,
    via: row.edge_kind,
    ...(lines.length > 0 ? { call_lines: lines } : { line: row.start_line }),
    ...(resolution && resolution !== 'typed' && resolution !== 'self' ? { resolution } : {}),
  };
}

function summarize(direct, transitive, throughParent, possible, inferred) {
  const parts = [`${direct.length} direct user(s)`];
  if (inferred > 0) parts.push(`${inferred} bound by receiver name`);
  const viaParent = throughParent.reduce((n, t) => n + t.callers.length, 0);
  if (viaParent > 0) parts.push(`${viaParent} through the declaration it implements`);
  parts.push(`${transitive.length} transitive`);
  if (possible.sites.length > 0) {
    const lines = possible.sites.reduce((n, s) => n + s.lines.length, 0);
    parts.push(`${lines} possible call site(s) in ${possible.sites.length} file(s) with a receiver of unknown type — check them`);
  }
  return parts.join(', ');
}

// Call lines are the evidence for calls (the method name is on that line);
// other users cite their own declaration. A sample is enough: the answer
// lists every user.
const EVIDENCE_SAMPLE = 15;

function buildEvidence(target, direct, throughParent, possibleSites) {
  const max = Math.min(EVIDENCE_SAMPLE, positiveInt(process.env.ORACLE_MAX_EVIDENCE, 50));
  const evidence = [{ path: target.path, line_range: [target.start_line, target.end_line], symbol: target.symbol, kind: target.kind }];
  const users = [...direct, ...throughParent.flatMap(t => t.callers)];
  for (const u of users) {
    if (evidence.length >= max) break;
    if (u.call_lines) {
      for (const line of u.call_lines.slice(0, 2)) {
        evidence.push({ path: u.path, line_range: [line, line], symbol: target.symbol, kind: 'call_site', caller: u.symbol });
      }
    } else {
      evidence.push({ path: u.path, line_range: [u.line, u.line], symbol: u.symbol, kind: u.kind });
    }
  }
  // Keep room for possible call sites: they are the part to double-check.
  for (const site of possibleSites.slice(0, 5)) {
    evidence.push({ path: site.path, line_range: [site.lines[0], site.lines[0]], symbol: target.symbol, kind: 'possible_call_site' });
  }
  return evidence.slice(0, max + 5);
}
