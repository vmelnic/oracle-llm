import fs from 'fs';

const DEFAULT_TOKEN_CAP = 400;
const EXTENDED_CAP_TOOLS = new Set([
  'oracle.where_would',
  'oracle.conventions_for',
  'oracle.context',
]);
const EXTENDED_TOKEN_CAP = 1500;
const NO_CAP_TOOLS = new Set([
  'oracle.read_exact',
]);

function estimateTokens(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return Math.ceil(json.length / 4);
}

function truncateToTokenCap(obj, cap) {
  const json = JSON.stringify(obj);
  const estimatedTokens = Math.ceil(json.length / 4);
  if (estimatedTokens <= cap) return obj;

  const maxChars = cap * 4;
  const target = JSON.parse(JSON.stringify(obj));

  function truncateValue(v, budget) {
    if (typeof v === 'string') {
      return v.slice(0, Math.max(0, Math.floor(budget) - 2));
    }
    if (Array.isArray(v)) {
      const result = [];
      let used = 2; // []
      for (const item of v) {
        const itemJson = JSON.stringify(item);
        if (used + itemJson.length + (result.length > 0 ? 1 : 0) > budget) break;
        result.push(item);
        used += itemJson.length + (result.length > 1 ? 1 : 0);
      }
      return result;
    }
    if (v && typeof v === 'object') {
      const result = {};
      let used = 2; // {}
      for (const [k, val] of Object.entries(v)) {
        const keyJson = JSON.stringify(k);
        const valJson = JSON.stringify(val);
        const sep = Object.keys(result).length > 0 ? 1 : 0;
        if (used + sep + keyJson.length + 1 + valJson.length > budget) break;
        result[k] = val;
        used += sep + keyJson.length + 1 + valJson.length;
      }
      return result;
    }
    return v;
  }

  let attempt = truncateValue(target, maxChars);
  let safety = 10;
  while (JSON.stringify(attempt).length > maxChars && safety-- > 0) {
    attempt = truncateValue(target, maxChars - (10 - safety) * 100);
  }

  if (JSON.stringify(attempt).length > maxChars) {
    return { truncated: true, token_estimate: estimatedTokens, cap };
  }
  return attempt;
}

export class GroundingWrapper {
  constructor(store, { parser } = {}) {
    this.store = store;
    this.parser = parser;
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
        if (patched) {
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
      ...(failed.length > 0 ? { unverified_evidence: failed } : {}),
    };

    if (NO_CAP_TOOLS.has(toolName)) return result;

    const cap = EXTENDED_CAP_TOOLS.has(toolName) ? EXTENDED_TOKEN_CAP : DEFAULT_TOKEN_CAP;
    const tokenEst = estimateTokens(result);
    if (tokenEst > cap) {
      const truncatedAnswer = truncateToTokenCap(result.answer, cap - 200);
      result = {
        answer: truncatedAnswer,
        evidence: verified.slice(0, 5),
        confidence: Math.min(confidence, 0.6),
        layer: answer.layer || 'L1',
        _truncated: true,
        _token_estimate: tokenEst,
        _token_cap: cap,
        _hint: 'Answer exceeds token cap. Use oracle.read_exact with evidence pointers for full content.',
      };
    }

    return result;
  }

  verifyEvidence(evidence) {
    if (!evidence.path) return false;

    try {
      if (!fs.existsSync(evidence.path)) {
        if (!evidence.subproject_root) return false;
        const fullPath = `${evidence.subproject_root}/${evidence.path}`;
        if (!fs.existsSync(fullPath)) return false;
        evidence.path = fullPath;
      }

      if (evidence.line_range) {
        const content = fs.readFileSync(evidence.path, 'utf-8');
        const lines = content.split('\n');
        const [start, end] = evidence.line_range;
        if (start < 1 || end > lines.length) return false;

        if (this.parser && evidence.symbol) {
          const ext = '.' + evidence.path.split('.').pop();
          const lang = this.parser.languageFor(evidence.path);
          if (lang) {
            try {
              const tree = this.parser.parse(content, lang);
              const rootStart = Math.max(0, start - 1);
              const rootEnd = Math.min(lines.length, end);
              const startByte = lines.slice(0, rootStart).join('\n').length + (rootStart > 0 ? 1 : 0);
              const endByte = lines.slice(0, rootEnd).join('\n').length;
              const nodeAtRange = tree.rootNode.descendantForPosition(
                { row: rootStart, column: 0 },
                { row: rootEnd - 1, column: 0 }
              );
              if (nodeAtRange && !nodeAtRange.hasError) {
                const nodeText = content.slice(nodeAtRange.startIndex, nodeAtRange.endIndex);
                const symLower = (evidence.symbol || '').toLowerCase();
                if (symLower && !nodeText.toLowerCase().includes(symLower)) {
                  return true;
                }
              }
            } catch {
              // AST sanity check failed; still accept if file/line range is valid
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
      if (EVIDENCE_OPTIONAL_TOOLS.has(toolName)) {
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

  _retryFromL1(result, toolName) {
    if (!this.store) return null;

    const answerObj = result.answer;
    if (!answerObj || typeof answerObj !== 'object') return null;

    const symbol = answerObj.definitions?.[0]?.symbol
      || answerObj.candidates?.[0]?.symbol
      || extractFirstSymbol(answerObj);

    if (!symbol) return null;

    const subprojectId = answerObj.definitions?.[0]?.subproject_id
      || result.evidence?.[0]?.subproject_id;

    try {
      let rows = [];
      if (subprojectId) {
        rows = this.store.locate(subprojectId, symbol);
      }
      if (rows.length === 0 && subprojectId) {
        rows = this.store.findNodes({ subprojectId, symbol });
      }

      if (rows.length > 0) {
        const evidence = rows.slice(0, 5).map(r => ({
          path: r.path,
          line_range: [r.start_line, r.end_line],
          symbol: r.symbol,
          kind: r.kind,
          subproject_id: subprojectId,
        }));
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
      residual.definitions = answerObj.definitions.map((d) => ({
        path: d.path,
        start_line: d.start_line,
        end_line: d.end_line,
      }));
    }
    if (answerObj.candidates && answerObj.candidates.length > 0) {
      residual.candidates = answerObj.candidates.slice(0, 3).map((c) => ({
        path: c.path,
        kind: c.kind,
      }));
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
