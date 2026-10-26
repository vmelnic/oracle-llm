import fs from 'fs';
import { positiveInt } from '../utils/env.js';
import path from 'path';

// Answer size caps in estimated tokens (ORACLE_TOKEN_CAP / _EXTENDED). Tools
// whose answer is a list of places (users, impact, definitions) or a task
// packet get the extended cap.
const DEFAULT_TOKEN_CAP = 400;
const EXTENDED_CAP_TOOLS = new Set([
  'oracle.where_would',
  'oracle.conventions_for',
  'oracle.context',
  'oracle.consumers',
  'oracle.impact',
  'oracle.locate',
]);
const EXTENDED_TOKEN_CAP = 1500;
const NO_CAP_TOOLS = new Set([
  'oracle.read_exact',
]);

function estimateTokens(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return Math.ceil(json.length / 4);
}

/**
 * Shrinks an answer to about `cap` tokens without dropping fields: long lists
 * keep their first items and gain a `<field>_total` count, long strings are
 * cut. Field order matters — earlier fields get the budget first.
 */
function truncateToTokenCap(obj, cap) {
  const json = JSON.stringify(obj);
  if (Math.ceil(json.length / 4) <= cap) return obj;
  return shrink(JSON.parse(json), cap * 4);
}

function shrink(value, budget) {
  if (typeof value === 'string') return value.length + 2 <= budget ? value : `${value.slice(0, Math.max(0, budget - 5))}...`;
  if (Array.isArray(value)) {
    const out = [];
    let used = 2;
    for (const item of value) {
      const size = JSON.stringify(item).length + 1;
      // Items are kept whole or dropped: a half-kept record misleads.
      if (used + size > budget) break;
      out.push(item);
      used += size;
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    let used = 2;
    const entries = Object.entries(value);
    for (let i = 0; i < entries.length; i++) {
      const [key, val] = entries[i];
      const keySize = JSON.stringify(key).length + 2;
      const size = keySize + JSON.stringify(val).length;
      // Leave room for the remaining keys' names so later fields survive too.
      const reserve = entries.slice(i + 1).reduce((n, [k]) => n + JSON.stringify(k).length + 8, 0);
      const room = budget - used - reserve;
      if (size <= room) {
        out[key] = val;
        used += size;
      } else if (room > keySize + 8 && val && typeof val === 'object') {
        const shrunk = shrink(val, room - keySize);
        out[key] = shrunk;
        used += keySize + JSON.stringify(shrunk).length;
        if (Array.isArray(val) && shrunk.length < val.length) {
          out[`${key}_total`] = val.length;
          used += JSON.stringify(`${key}_total`).length + 8;
        }
      } else if (room > keySize + 8 && typeof val === 'string') {
        out[key] = shrink(val, room - keySize);
        used += keySize + JSON.stringify(out[key]).length;
      } else if (Array.isArray(val)) {
        out[`${key}_total`] = val.length;
        used += JSON.stringify(`${key}_total`).length + 8;
      }
    }
    return out;
  }
  return value;
}

export class GroundingWrapper {
  constructor(store, { parser, subprojectRoot } = {}) {
    this.store = store;
    this.parser = parser;
    this.subprojectRoot = subprojectRoot || null;
    // One wrapper serves one request: cache file text and parse trees so many
    // evidence items in the same file cost one read and one parse.
    this._files = new Map();
  }

  _file(resolved) {
    if (!this._files.has(resolved)) {
      const content = fs.readFileSync(resolved, 'utf-8');
      this._files.set(resolved, { content, lines: content.split('\n'), trees: new Map() });
    }
    return this._files.get(resolved);
  }

  wrap(answer, toolName) {
    if (!answer) return { answer: null, evidence: [], confidence: 0, layer: 'L1' };

    const evidence = answer.evidence || [];
    const verified = [];
    const failed = [];

    for (const e of evidence) {
      if (this.verifyEvidence(e)) {
        verified.push(e);
      } else {
        const patched = this._patchFromL1(e);
        if (patched && this.verifyEvidence(patched)) {
          verified.push(patched);
        } else {
          failed.push(e);
        }
      }
    }

    const confidence = this.computeConfidence(answer, verified, failed);

    let result = {
      answer: answer.answer || answer.data || answer,
      evidence: verified,
      confidence,
      layer: answer.layer || 'L1',
      ...l3Fields(answer),
      ...(failed.length > 0 ? { unverified_evidence: failed } : {}),
    };

    if (NO_CAP_TOOLS.has(toolName)) return result;

    const cap = EXTENDED_CAP_TOOLS.has(toolName)
      ? positiveInt(process.env.ORACLE_TOKEN_CAP_EXTENDED, EXTENDED_TOKEN_CAP)
      : positiveInt(process.env.ORACLE_TOKEN_CAP, DEFAULT_TOKEN_CAP);
    const tokenEst = estimateTokens(result);
    const truncatedAnswer = tokenEst > cap ? truncateToTokenCap(result.answer, cap - 200) : result.answer;
    // Only an answer that actually lost content is reported as truncated.
    if (tokenEst > cap && JSON.stringify(truncatedAnswer) !== JSON.stringify(result.answer)) {
      result = {
        answer: truncatedAnswer,
        // Evidence pointers are the cheap, valuable part of a big answer (a
        // broad question can touch dozens of symbols): trim the body, keep
        // the pointers up to ORACLE_MAX_EVIDENCE.
        evidence: verified.slice(0, positiveInt(process.env.ORACLE_MAX_EVIDENCE, 50)),
        confidence: Math.min(confidence, 0.6),
        layer: answer.layer || 'L1',
        ...l3Fields(answer),
        _truncated: true,
        _token_estimate: tokenEst,
        _token_cap: cap,
        ...(failed.length > 0 ? { _unverified_evidence_count: failed.length } : {}),
        _hint: 'Answer exceeds the token cap: lists were shortened (see *_total). Use oracle.read_exact with evidence pointers, narrow the query, or raise ORACLE_TOKEN_CAP / ORACLE_TOKEN_CAP_EXTENDED.',
      };
    }

    return result;
  }

  verifyEvidence(evidence) {
    if (!evidence.path) return false;

    try {
      const root = evidence.subproject_root || this.subprojectRoot;
      const candidate = path.isAbsolute(evidence.path)
        ? evidence.path
        : path.resolve(root || process.cwd(), evidence.path);
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return false;
      const resolved = fs.realpathSync(candidate);
      if (root) {
        const realRoot = fs.realpathSync(root);
        const relative = path.relative(realRoot, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
      }

      if (evidence.line_range) {
        if (!Array.isArray(evidence.line_range) || evidence.line_range.length !== 2) return false;
        const [start, end] = evidence.line_range;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end) return false;
        const file = this._file(resolved);
        const { content, lines } = file;
        if (end > lines.length) return false;

        // Qualified symbols (`Class.method`, `App\\Models\\User`, `Foo::bar`) appear
        // in source by their last segment only.
        const symLower = evidence.symbol ? sourceName(evidence.symbol).toLowerCase() : '';
        if (symLower) {
          const citedText = lines.slice(start - 1, end).join('\n').toLowerCase();
          if (!citedText.includes(symLower)) return false;
        }

        if (this.parser && evidence.symbol) {
          const lang = this.parser.languageFor(resolved);
          if (lang) {
            try {
              if (!file.trees.has(lang)) file.trees.set(lang, this.parser.parse(content, lang));
              const tree = file.trees.get(lang);
              const rootStart = Math.max(0, start - 1);
              const rootEnd = Math.min(lines.length, end);
              // End at the end of the last cited line: ending at column 0 of a
              // single-line range selects only its first token (e.g. `export`).
              const nodeAtRange = tree.rootNode.descendantForPosition(
                { row: rootStart, column: 0 },
                { row: rootEnd - 1, column: lines[rootEnd - 1].length }
              );
              if (nodeAtRange && !nodeAtRange.hasError) {
                const nodeText = content.slice(nodeAtRange.startIndex, nodeAtRange.endIndex);
                if (symLower && !nodeText.toLowerCase().includes(symLower)) {
                  return false;
                }
              }
            } catch {
              return false;
            }
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  computeConfidence(answer, verified, failed) {
    let confidence = 1.0;

    const totalEvidence = verified.length + failed.length;
    if (totalEvidence === 0) return 0.3;

    const coverage = verified.length / totalEvidence;
    confidence *= coverage;

    if (answer.layer === 'L3') confidence *= 0.85;
    if (answer.layer === 'L2') confidence *= 0.95;

    if (verified.length >= 3) confidence = Math.min(confidence * 1.1, 1.0);

    const l1l2Agreement = this._computeL1L2Agreement(answer, verified);
    confidence *= l1l2Agreement;

    const selfConsistency = this._computeSelfConsistency(answer);
    confidence *= selfConsistency;

    // A tool can cap its own confidence (e.g. a caller list with unbound call sites).
    if (typeof answer.confidence_cap === 'number') confidence = Math.min(confidence, answer.confidence_cap);

    return Math.round(Math.min(confidence, 1.0) * 100) / 100;
  }

  _computeL1L2Agreement(answer, verified) {
    if (!answer || !answer.evidence) return 0.9;

    const answerObj = answer.answer || answer.data || answer;
    if (typeof answerObj !== 'object' || !answerObj) return 0.9;

    const claims = [];
    if (answerObj.definitions) claims.push(...answerObj.definitions);
    if (answerObj.affected_routes) claims.push(...answerObj.affected_routes);
    if (answerObj.affected_components) claims.push(...answerObj.affected_components);
    if (answerObj.consumers) claims.push(...answerObj.consumers);
    if (answerObj.changed_symbols) claims.push(...answerObj.changed_symbols);
    if (answerObj.candidates) claims.push(...answerObj.candidates);
    if (answerObj.existing) claims.push(...answerObj.existing);

    if (claims.length === 0 || verified.length === 0) return 0.9;

    const verifiedPaths = new Set(verified.map((e) => e.path));
    const claimsWithPaths = claims.filter((c) => c && c.path);
    if (claimsWithPaths.length === 0) return 0.9;

    const matching = claimsWithPaths.filter((c) => verifiedPaths.has(c.path)).length;
    return 0.5 + 0.5 * (matching / claimsWithPaths.length);
  }

  _computeSelfConsistency(answer) {
    const answerObj = answer?.answer || answer?.data || answer;
    if (typeof answerObj !== 'object' || !answerObj) return 0.9;

    let consistent = 0;
    let total = 0;

    if (answerObj.breaking === true && answerObj.affected_routes?.length === 0 &&
        answerObj.affected_components?.length === 0 && answerObj.total_affected === 0) {
      return 0.7;
    }

    if (answerObj.present === false && answerObj.candidates?.length > 0) {
      total++;
      consistent += 0.5;
    }

    if (total === 0) return 0.95;
    return 0.5 + 0.5 * (consistent / total);
  }

  enforceEvidence(result, toolName) {
    const EVIDENCE_OPTIONAL_TOOLS = new Set([
      'oracle.read_exact', 'oracle.stats', 'oracle.validate',
      'oracle.diff_since', 'oracle.impact',
    ]);
    if (!result.evidence || result.evidence.length === 0) {
      // An explicit negative ("no such symbol") claims nothing about the code,
      // so it needs no evidence; only positive claims must be grounded.
      if (EVIDENCE_OPTIONAL_TOOLS.has(toolName) || result.answer?.found === false) {
        return result;
      }

      if (!result._retried) {
        const retried = this._retryFromL1(result, toolName);
        if (retried) {
          retried._retried = true;
          return this.enforceEvidence(retried, toolName);
        }
      }

      const residual = this._residualPointers(result);
      if (residual) return residual;

      return {
        ...result,
        confidence: 0,
        _error: 'no evidence attached — answer rejected per grounding rules',
        answer: null,
      };
    }
    return result;
  }

  _retryFromL1(result, _toolName) {
    if (!this.store) return null;

    const answerObj = result.answer;
    if (!answerObj || typeof answerObj !== 'object') return null;

    const symbol = answerObj.definitions?.[0]?.symbol
      || answerObj.candidates?.[0]?.symbol
      || extractFirstSymbol(answerObj);

    if (!symbol) return null;

    const subprojectId = answerObj.definitions?.[0]?.subproject_id
      || result.evidence?.[0]?.subproject_id
      || result.unverified_evidence?.[0]?.subproject_id;

    try {
      let rows = [];
      if (subprojectId) {
        rows = this.store.locate(subprojectId, symbol);
      }
      if (rows.length === 0 && subprojectId) {
        rows = this.store.findNodes({ subprojectId, symbol });
      }

      if (rows.length > 0) {
        const evidence = rows.slice(0, 5)
          .map(r => ({
            path: r.path,
            line_range: [r.start_line, r.end_line],
            symbol: r.symbol,
            kind: r.kind,
            subproject_id: subprojectId,
          }))
          .filter(item => this.verifyEvidence(item));
        if (evidence.length === 0) return null;
        return {
          ...result,
          evidence,
          confidence: Math.min(result.confidence || 0.5, 0.6),
          _retried: true,
          _hint: 'Evidence attached via L1 retry',
        };
      }
    } catch {}

    return null;
  }

  _patchFromL1(evidence) {
    if (!this.store || !evidence.symbol || !evidence.subproject_id) return null;

    try {
      const rows = this.store.findNodes({
        subprojectId: evidence.subproject_id,
        symbol: evidence.symbol,
      });
      if (rows.length > 0) {
        const node = rows[0];
        if (node.path && node.start_line != null && node.end_line != null) {
          return {
            ...evidence,
            path: node.path,
            line_range: [node.start_line, node.end_line],
            _patched: true,
          };
        }
      }
    } catch {}

    return null;
  }

  _residualPointers(result) {
    const answerObj = result.answer;
    if (!answerObj || typeof answerObj !== 'object') return null;

    const residual = {};
    if (answerObj.definitions && answerObj.definitions.length > 0) {
      const definitions = answerObj.definitions
        .filter(d => typeof d?.path === 'string' && d.path.length > 0)
        .map((d) => ({
          path: d.path,
          start_line: d.start_line,
          end_line: d.end_line,
        }));
      if (definitions.length > 0) residual.definitions = definitions;
    }
    if (answerObj.candidates && answerObj.candidates.length > 0) {
      const candidates = answerObj.candidates
        .filter(c => typeof c?.path === 'string' && c.path.length > 0)
        .slice(0, 3)
        .map((c) => ({ path: c.path, kind: c.kind }));
      if (candidates.length > 0) residual.candidates = candidates;
    }

    if (Object.keys(residual).length === 0) return null;

    return {
      ...result,
      answer: residual,
      confidence: 0.1,
      _warning: 'original answer stripped — no verifiable evidence; pointers retained for oracle.read_exact',
    };
  }
}

function extractFirstSymbol(answerObj) {
  if (!answerObj || typeof answerObj !== 'object') return null;
  for (const key of Object.keys(answerObj)) {
    const val = answerObj[key];
    if (typeof val === 'string' && val.length > 0 && val.length < 200) return val;
    if (Array.isArray(val) && val.length > 0 && val[0]?.symbol) return val[0].symbol;
  }
  return null;
}

function sourceName(symbol) {
  const segments = String(symbol).split(/\\|::|\./).filter(Boolean);
  return segments[segments.length - 1] || String(symbol);
}

// The synthesis travels with its untrusted-content note, never without it.
function l3Fields(answer) {
  return answer._l3_synthesis
    ? { _l3_synthesis: answer._l3_synthesis, _l3_citations: answer._l3_citations, _l3_synthesis_note: answer._l3_synthesis_note }
    : {};
}
