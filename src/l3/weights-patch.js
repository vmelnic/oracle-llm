import fs from 'fs';
import path from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export class WeightsThenPatch {
  constructor(store, patterns, manifest) {
    this.store = store;
    this.patterns = patterns;
    this.manifest = manifest;
    this.driftLog = [];
  }

  validate(l3Answer, subprojectId) {
    if (!l3Answer || !l3Answer.answer) return l3Answer;

    const claims = extractClaims(l3Answer.answer);
    const patches = [];
    let agreementScore = 1.0;

    for (const claim of claims) {
      const l1Fact = this._checkAgainstL1(claim, subprojectId);
      if (l1Fact.mismatch) {
        patches.push({ claim, correction: l1Fact });
        agreementScore -= 0.1;
      }
    }

    if (patches.length === 0) {
      return { ...l3Answer, _validated: true, _patches: 0 };
    }

    const patched = applyPatches(l3Answer, patches);
    const drift = {
      timestamp: new Date().toISOString(),
      subprojectId,
      patches: patches.map(p => ({
        claim: p.claim,
        corrected_to: p.correction.value,
      })),
    };
    this.driftLog.push(drift);

    return {
      ...patched,
      confidence: Math.max(0, (l3Answer.confidence || 1.0) * agreementScore),
      _validated: true,
      _patches: patches.length,
      _drift_logged: true,
    };
  }

  _checkAgainstL1(claim, subprojectId) {
    if (claim.type === 'symbol_location') {
      const nodes = this.store.locate(subprojectId, claim.symbol);
      if (nodes.length === 0) {
        return { mismatch: true, value: null, reason: 'symbol not found in L1' };
      }
      const node = nodes[0];
      if (claim.path && claim.path !== node.path) {
        return { mismatch: true, value: { path: node.path, line: node.start_line }, reason: 'path mismatch' };
      }
      if (claim.line && Math.abs(claim.line - node.start_line) > 2) {
        return { mismatch: true, value: { path: node.path, line: node.start_line }, reason: 'line mismatch' };
      }
      return { mismatch: false, value: { path: node.path, line: node.start_line } };
    }

    if (claim.type === 'kind') {
      const nodes = this.store.locate(subprojectId, claim.symbol);
      if (nodes.length === 0) return { mismatch: false, value: null };
      const node = nodes[0];
      if (claim.kind !== node.kind) {
        return { mismatch: true, value: node.kind, reason: 'kind mismatch' };
      }
      return { mismatch: false, value: node.kind };
    }

    if (claim.type === 'convention') {
      const conventions = this.manifest?.conventions || {};
      const actual = conventions[claim.topic];
      if (actual !== undefined && claim.value !== undefined && JSON.stringify(actual) !== JSON.stringify(claim.value)) {
        return { mismatch: true, value: actual, reason: 'convention mismatch' };
      }
      return { mismatch: false, value: actual };
    }

    if (claim.type === 'pattern_frequency') {
      if (!this.patterns) return { mismatch: false, value: null };
      const p = this.patterns.getPattern(claim.pattern_name);
      if (p && claim.frequency !== undefined && p.frequency.count !== claim.frequency) {
        return { mismatch: true, value: p.frequency, reason: 'frequency mismatch' };
      }
      return { mismatch: false, value: p?.frequency };
    }

    return { mismatch: false, value: null };
  }

  getDriftLog() {
    return this.driftLog;
  }

  // `mentionablePaths`: paths the answer may name but not cite as evidence,
  // e.g. new files suggested by where_would (they don't exist yet).
  validateSynthesis(l3Result, allowedEvidence, _subprojectId, { mentionablePaths = [] } = {}) {
    const text = l3Result?.text;
    const evidence = l3Result?.evidence;
    if (typeof text !== 'string' || !text.trim() || !Array.isArray(evidence) || evidence.length === 0) {
      return { accepted: false, reason: 'L3 response has no verifiable evidence' };
    }

    const allowed = new Map();
    const evidenceRoot = allowedEvidence?.find(item => item?.subproject_root)?.subproject_root;
    for (const item of allowedEvidence || []) {
      if (!item?.path || !Array.isArray(item.line_range)) continue;
      const key = normalizeEvidencePath(item.path, item.subproject_root);
      const ranges = allowed.get(key) || [];
      ranges.push(item.line_range);
      allowed.set(key, ranges);
    }

    for (const item of evidence) {
      const key = normalizeEvidencePath(item.path, evidenceRoot);
      const ranges = allowed.get(key);
      const exactRange = ranges?.some(([start, end]) =>
        item.line_range?.[0] === start && item.line_range?.[1] === end
      );
      if (!exactRange) {
        return { accepted: false, reason: `L3 cited evidence outside the L1 allowlist: ${item.path}` };
      }
    }

    const referencedPaths = text.match(/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.(?:js|jsx|mjs|cjs|ts|tsx|php|dart|vue|py|go|rs|java|sql|ya?ml|json|proto|graphql)/g) || [];
    const mentionable = new Set(mentionablePaths.map(p => normalizeEvidencePath(p, evidenceRoot)));
    const known = [...allowed.keys(), ...mentionable];
    for (const referenced of referencedPaths) {
      const key = normalizeEvidencePath(referenced, evidenceRoot);
      // A shortened real path ("retrieval/index.js" for src/retrieval/index.js)
      // names a known file; only paths matching nothing known are inventions.
      if (!known.some(k => k === key || k.endsWith(`/${key}`))) {
        return { accepted: false, reason: `L3 referenced a path outside the L1 allowlist: ${referenced}` };
      }
    }

    return { accepted: true };
  }

  recordDrift(subprojectId, reason) {
    this.driftLog.push({
      timestamp: new Date().toISOString(),
      subprojectId,
      reason,
    });
  }

  saveDriftLog(outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    let existing = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {}
    const combined = [...existing, ...this.driftLog].slice(-1000);
    atomicWriteFileSync(outputPath, JSON.stringify(combined, null, 2));
    this.driftLog = [];
  }
}

function normalizeEvidencePath(filePath, root) {
  if (!filePath) return '';
  let normalized = String(filePath).replace(/\\/g, '/');
  if (root && path.isAbsolute(normalized)) {
    normalized = path.relative(root, normalized).replace(/\\/g, '/');
  }
  return normalized.replace(/^\.\//, '');
}

function extractClaims(answer) {
  const claims = [];
  if (!answer || typeof answer !== 'object') return claims;

  if (answer.definitions) {
    for (const def of answer.definitions) {
      claims.push({
        type: 'symbol_location',
        symbol: def.symbol,
        path: def.path,
        line: def.start_line,
      });
      if (def.kind) {
        claims.push({ type: 'kind', symbol: def.symbol, kind: def.kind });
      }
    }
  }

  if (answer.candidates) {
    for (const c of answer.candidates) {
      claims.push({ type: 'symbol_location', symbol: c.symbol, path: c.path, line: c.start_line });
    }
  }

  if (answer.consumers) {
    for (const c of answer.consumers) {
      claims.push({ type: 'symbol_location', symbol: c.symbol, path: c.path, line: c.start_line });
    }
  }

  if (answer.pattern) {
    if (answer.pattern.frequency) {
      claims.push({ type: 'pattern_frequency', pattern_name: answer.pattern.name, frequency: answer.pattern.frequency.count });
    }
  }

  if (answer.conventions) {
    for (const conv of (Array.isArray(answer.conventions) ? answer.conventions : [answer.conventions])) {
      if (conv.topic) {
        claims.push({ type: 'convention', topic: conv.topic, value: conv.value || conv.pattern });
      }
    }
  }

  if (answer.existing) {
    for (const e of answer.existing) {
      claims.push({ type: 'symbol_location', symbol: e.symbols?.[0], path: e.path });
    }
  }

  return claims;
}

function applyPatches(l3Answer, patches) {
  const answer = { ...l3Answer.answer };

  for (const { claim, correction } of patches) {
    if (claim.type === 'symbol_location' && answer.definitions) {
      answer.definitions = answer.definitions.map((d) => {
        if (d.symbol === claim.symbol && correction.value) {
          return { ...d, path: correction.value.path || d.path, start_line: correction.value.line || d.start_line };
        }
        return d;
      });
    }

    if (claim.type === 'kind' && answer.definitions) {
      answer.definitions = answer.definitions.map((d) => {
        if (d.symbol === claim.symbol && correction.value) {
          return { ...d, kind: correction.value };
        }
        return d;
      });
    }
  }

  return { ...l3Answer, answer };
}
