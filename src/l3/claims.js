/**
 * Claim-level check of an L3 answer (prompts/l3/system.claims.txt). The
 * model returns sentences, each listing the claims it makes; every claim is
 * checked against the facts it was shown and the graph relations between
 * them. Sentences with an unsupported claim, or naming a symbol or file
 * without a claim, are dropped:
 *   - relation: "A calls|renders|uses B" must be a graph relation between
 *     two shown facts (calls/renders exactly, uses = any of them);
 *   - symbol: the cited fact must be that symbol or file;
 *   - suggestion: the path must be one of the tool's suggested new files.
 */

const RELATIONS = new Set(['calls', 'renders', 'uses']);
// Verbs that state a relation between two named symbols.
const RELATION_VERB = /\b(call(s|ed|ing)?|invok(e|es|ed|ing)|use(s|d)?|using|render(s|ed|ing)?|creat(e|es|ed|ing)|dispatch(es|ed|ing)?|trigger(s|ed|ing)?|delegat(e|es|ed|ing)|pass(es|ed)?|forward(s|ed)?|handl(e|es|ed|ing)|run(s)?|execut(e|es|ed|ing))\b/i;
const TYPE_KINDS = new Set(['interface', 'type_alias', 'enum', 'property', 'variable', 'db_table']);
const PATH_IN_TEXT = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;

/** The `{ sentences: [{ text, claims }] }` object in a reply, or null. */
export function parseClaimsAnswer(text) {
  if (typeof text !== 'string') return null;
  // Small models may wrap the object in a ```json fence or add a word around it.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const sentences = Array.isArray(parsed?.sentences) ? parsed.sentences : null;
  if (!sentences || sentences.length === 0) return null;
  const clean = sentences
    .filter(s => s && typeof s.text === 'string' && s.text.trim())
    .map(s => ({ text: s.text.trim(), claims: Array.isArray(s.claims) ? s.claims.filter(c => c && typeof c === 'object') : [] }));
  return clean.length > 0 ? { sentences: clean } : null;
}

// The answer is kept to what the prompt asks for (system.claims.txt rule 1).
const MAX_SENTENCES = 4;

/**
 * @param answer   parsed `{ sentences }`
 * @param facts    Map id -> { symbol, kind, path, line_range, relation? }
 * @param relations [{ from: { symbol }, to: { symbol }, kind }] between shown facts
 * @param suggestions paths of suggested new files
 * @returns {{ kept: [{ text, factIds }], dropped: [{ text, reason }], omitted }}
 *   Each entry's text is split into real sentences, checked one by one with
 *   the entry's claims; repeats and sentences past MAX_SENTENCES are omitted.
 */
export function verifyClaims(answer, { facts, relations = [], suggestions = [] }) {
  const kept = [];
  const dropped = [];
  let omitted = 0;
  const symbolFacts = [...facts.entries()].filter(([, f]) => !f.relation && f.symbol);
  const suggested = new Set(suggestions);
  const seen = new Set();

  for (const entry of answer.sentences) {
    const checked = checkClaims(entry.claims, { facts, relations, suggested });
    for (const text of splitSentences(entry.text)) {
      const result = checkSentence(text, checked, symbolFacts);
      if (result.reason) {
        dropped.push({ text, reason: result.reason });
        continue;
      }
      // The same names again ("The login flow is ... LoginForm ... useLogin") add nothing.
      const key = result.names.length > 0 ? result.names.sort().join('|') : text.toLowerCase();
      if (seen.has(key) || kept.length >= MAX_SENTENCES) {
        omitted++;
        continue;
      }
      seen.add(key);
      kept.push({ text, factIds: checked.factIds });
    }
  }
  return { kept, dropped, omitted };
}

// Sentences end at . ! ? followed by a space ("useLogin calls ..." starts
// lowercase); a qualified name (Request.post) has no space, and common
// abbreviations (e.g., i.e.) do not end a sentence.
function splitSentences(text) {
  const out = [];
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    if (out.length > 0 && /\b(e\.g|i\.e|etc|vs|cf)\.$/i.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out.map(t => t.trim()).filter(Boolean);
}

// Checks every claim of an entry: { factIds, covered, verified, invalid }.
// An invalid claim only sinks the sentences that rely on it (see checkSentence).
function checkClaims(claims, { facts, relations, suggested }) {
  const factIds = new Set();
  const covered = []; // names and paths the valid claims vouch for
  const verified = []; // [from, to] symbols of verified relation claims
  const invalid = []; // { names, reason }

  for (const claim of claims) {
    const names = [claim.subject, claim.object, claim.symbol, claim.path].filter(v => typeof v === 'string' && v);
    const fail = (reason) => invalid.push({ names, ordered: claim.type === 'relation', reason });
    if (claim.type === 'relation') {
      if (!RELATIONS.has(claim.relation)) { fail(`unknown relation "${claim.relation}"`); continue; }
      if (!facts.get(Number(claim.fact))) { fail(`cites unknown fact ${claim.fact}`); continue; }
      const match = relations.find(r => namesOrOwns(claim.subject, r.from.symbol) && namesOrOwns(claim.object, r.to.symbol)
        && (claim.relation === 'uses' || r.kind === claim.relation));
      if (!match) { fail(`no "${claim.relation}" relation from ${claim.subject} to ${claim.object} in the graph`); continue; }
      factIds.add(Number(claim.fact));
      covered.push(match.from.symbol, match.to.symbol);
      verified.push([match.from.symbol, match.to.symbol]);
    } else if (claim.type === 'symbol') {
      const fact = facts.get(Number(claim.fact));
      if (!fact) { fail(`cites unknown fact ${claim.fact}`); continue; }
      const name = String(claim.symbol ?? '');
      const ok = fact.relation
        ? namesOrOwns(name, fact.relation.from) || namesOrOwns(name, fact.relation.to)
        : namesOrOwns(name, fact.symbol) || samePath(name, fact.path);
      if (!ok) { fail(`fact ${claim.fact} is not ${name}`); continue; }
      factIds.add(Number(claim.fact));
      covered.push(fact.relation ? name : fact.symbol, fact.path);
    } else if (claim.type === 'suggestion') {
      if (!suggested.has(String(claim.path))) { fail(`${claim.path} is not a suggested file`); continue; }
      covered.push(String(claim.path));
    } else {
      fail(`unknown claim type "${claim.type}"`);
    }
  }
  return { factIds: [...factIds], covered, verified, invalid };
}

// One sentence against its entry's verified claims: { names } or { reason }.
function checkSentence(text, { covered, verified, invalid }, symbolFacts) {
  const same = (a, b) => namesOrOwns(a, b) || namesOrOwns(b, a) || matchesSymbol(shortName(a), b);

  // A failed claim sinks the sentence that names what it is about: all of
  // its names, in subject-before-object order for a relation ("B calls A"
  // is not "A calls B"); a claim without names (unknown type) sinks them all.
  for (const bad of invalid) {
    const at = bad.names.map(n => positionOf(text, n));
    const named = at.every(i => i >= 0) && (!bad.ordered || at.length < 2 || at[0] < at[1]);
    if (bad.names.length === 0 || named) return { reason: bad.reason };
  }

  // Everything the sentence names must be vouched for by one of the claims.
  const mentionedFacts = symbolFacts.map(([, f]) => f).filter(f => mentions(text, f.symbol));
  const mentioned = mentionedFacts.map(f => f.symbol);
  for (const sym of mentioned) {
    if (!covered.some(c => same(sym, c))) return { reason: `names ${shortName(sym)} without a claim` };
  }
  for (const p of text.match(PATH_IN_TEXT) || []) {
    if (!covered.some(c => samePath(p, c))) return { reason: `names ${p} without a claim` };
  }

  // "A calls B and C" in words: every code unit named must be an end of a
  // verified relation whose other end is named in the same sentence. Types
  // ("returns LoginResponse") only need their symbol claim: type usage is not
  // among the relation facts the model is given.
  const names = [...new Set(mentioned.map(shortName))];
  if (names.length >= 2 && RELATION_VERB.test(text)) {
    const inSentence = (sym) => mentioned.some(m => same(m, sym));
    const linked = verified.filter(([from, to]) => inSentence(from) && inSentence(to));
    const actors = mentionedFacts.filter(f => !TYPE_KINDS.has(f.kind)).map(f => f.symbol);
    const unlinked = actors.filter(m => !linked.some(([from, to]) => same(m, from) || same(m, to)));
    if (unlinked.length > 0) {
      return { reason: `states a relation involving ${shortName(unlinked[0])} without a verified relation claim` };
    }
  }
  return { names };
}

// `UserTask::createToken`, `createToken()`, `App\\Tasks\\UserTask::createToken`
// all name the same method; a bare short name matches any qualified one.
function matchesSymbol(name, symbol) {
  if (!name || !symbol) return false;
  const n = normalize(name);
  const s = normalize(symbol);
  if (n === s) return true;
  if (shortName(n) !== shortName(s)) return false;
  return !/[\\:.#]/.test(n) || s.endsWith(n);
}

// A class stands for its members: "LoginController calls X" holds when
// LoginController.performLogin calls X; a symbol fact for a method also
// shows its class.
function namesOrOwns(name, symbol) {
  if (matchesSymbol(name, symbol)) return true;
  const owner = ownerOf(symbol);
  return !!owner && matchesSymbol(name, owner);
}

function ownerOf(symbol) {
  const text = String(symbol);
  const cut = Math.max(text.lastIndexOf('::'), text.lastIndexOf('.'), text.lastIndexOf('#'));
  return cut > 0 ? text.slice(0, cut) : null;
}

function normalize(value) {
  return String(value).trim().replace(/\(\)$/, '').replace(/->/g, '::').toLowerCase();
}

function shortName(symbol) {
  const parts = String(symbol).split(/\\|::|\.|#/).filter(Boolean);
  return parts[parts.length - 1] || String(symbol);
}

function samePath(a, b) {
  if (!a || !b) return false;
  const x = String(a).replace(/^\.\//, '');
  const y = String(b).replace(/^\.\//, '');
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// Where a claimed name appears in the sentence (its last segment), or -1.
function positionOf(text, name) {
  const lower = text.toLowerCase();
  const full = lower.indexOf(String(name).toLowerCase());
  return full >= 0 ? full : lower.indexOf(shortName(name).toLowerCase());
}

// Only identifier-like names count as mentions (`createToken`, `UserTask`,
// `MAX_SIZE`), so plain words such as "index" in prose are not.
function mentions(text, symbol) {
  const parts = String(symbol).split(/\\|::|\.|#/).filter(Boolean);
  // `TokenService::issue` / `TokenService.issue` names even a one-word method.
  if (parts.length >= 2) {
    const [owner, member] = parts.slice(-2);
    if (['::', '.', '->', '#'].some(sep => text.includes(`${owner}${sep}${member}`))) return true;
  }
  const name = shortName(symbol);
  const identifierLike = name.length >= 4 && (/^[A-Z]/.test(name) || /[A-Z_\d]/.test(name.slice(1)));
  if (!identifierLike) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(text);
}
