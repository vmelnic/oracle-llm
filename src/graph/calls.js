// Method-call resolution, shared by every language.
//
// Extractors describe a call `receiver.method()` as a `calls` edge with
// `metadata.call = { method, receiver, receiver_type?, self?, line }`, where
// receiver_type is the receiver's class when the extractor could infer it
// (`$this`, a typed parameter or property, `new X()`, a static call...). The
// builder resolves these edges once every node is written:
//
//   typed          the method on receiver_type or, failing that, the nearest
//                  class/interface/trait it extends, implements or uses
//   self           same, for calls on `this` / `self` / `static`
//   receiver_name  receiver type unknown: the method is bound only when the
//                  receiver's name points at exactly one class (not an
//                  interface) that defines it (`$userService->x()`,
//                  `store.getNode()`)
//   function       a bare `name()` inside a class (`metadata.call.implicit`,
//                  Dart) that is not a method of it: the top-level function
//
// Anything else stays unresolved. Untyped calls are remembered by method name
// as possible call sites, so tools can say what static analysis could not
// bind instead of reporting "no callers".

export const TYPE_KINDS = new Set(['class', 'interface', 'trait', 'mixin', 'enum', 'component', 'struct']);

const NAME_BINDABLE_KINDS = new Set(['class', 'trait', 'mixin', 'component']);
const MAX_INHERITANCE_DEPTH = 8;
const MAX_CALL_LINES = 20;
const RESOLUTION_STRENGTH = { self: 3, typed: 3, function: 3, receiver_name: 1 };

export function createCallResolver(store, subprojectId) {
  const typeCache = new Map();
  const memberCache = new Map();
  const parentCache = new Map();

  function typesNamed(name) {
    if (!typeCache.has(name)) {
      // Path order, not locate's ref_count order (which depends on build progress).
      typeCache.set(name, store.locate(subprojectId, name).filter(n => TYPE_KINDS.has(n.kind))
        .sort((a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line || a.kind.localeCompare(b.kind)));
    }
    return typeCache.get(name);
  }

  function methodsNamed(name) {
    if (!memberCache.has(name)) {
      const byOwner = new Map();
      for (const node of store.findMembersByName(subprojectId, name, 'method')) {
        const owner = ownerSymbol(node.symbol);
        if (owner && !byOwner.has(owner)) byOwner.set(owner, node);
      }
      memberCache.set(name, byOwner);
    }
    return memberCache.get(name);
  }

  // The type declarations that enclose a member (a component and its props
  // interface can share a name; only the one around the member counts).
  function declaringTypes(owner, member) {
    return typesNamed(owner).filter(t => t.path === member.path && t.start_line <= member.start_line && t.end_line >= member.end_line);
  }

  function parentsOf(typeNode) {
    if (!parentCache.has(typeNode.id)) parentCache.set(typeNode.id, store.getInheritanceParents(typeNode.id));
    return parentCache.get(typeNode.id);
  }

  // The method on `typeNode` or its nearest ancestor (breadth first, so a
  // class's own parent wins over an interface further up). `path` lists the
  // types walked to reach it: a change to any of them can change the answer.
  function findOnType(typeNode, method) {
    const byOwner = methodsNamed(method);
    if (byOwner.size === 0) return null;
    const via = new Map([[typeNode.id, null]]);
    let frontier = [typeNode];
    for (let depth = 0; depth <= MAX_INHERITANCE_DEPTH && frontier.length > 0; depth++) {
      const next = [];
      for (const type of frontier) {
        const hit = byOwner.get(type.symbol);
        if (hit) {
          const path = [];
          for (let t = type; t; t = via.get(t.id)) path.push(t.symbol);
          return { node: hit, inherited: depth > 0, path };
        }
        for (const parent of parentsOf(type)) {
          if (!via.has(parent.id)) {
            via.set(parent.id, type);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  // The class a method or function returns (metadata.return_type), with
  // Future/Promise-style wrappers removed and `static`/`self` mapped to the owner.
  function returnTypeOf(node) {
    const raw = String(parseMeta(node.metadata).return_type || '').trim();
    if (!raw) return null;
    if (/^\??(static|self|this|\$this)$/.test(raw)) return ownerSymbol(node.symbol);
    const unwrapped = raw.replace(/^(?:Promise|Future|FutureOr|Observable|Awaited)<(.+)>$/s, '$1');
    const name = cleanTypeName(unwrapped);
    return /^[A-Za-z_\\][\w\\]*$/.test(name) && !/^(void|never|null|mixed|any|unknown|bool|boolean|int|float|string|number|array|object|dynamic)$/i.test(name) ? name : null;
  }

  // Type of the receiver: declared by the extractor, or the return type of
  // the call that produced it (`$repo->find()->save()`, `final x = a.b(); x.c()`).
  function receiverTypeOf(call, depth) {
    if (call.receiver_type) return call.receiver_type;
    if (!call.receiver_call || depth >= 4) return null;
    const inner = call.receiver_call;
    let node;
    if (inner.function) {
      node = store.locate(subprojectId, inner.method).filter(n => n.kind === 'function' || n.kind === 'hook')
        .sort((a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line)[0];
    } else {
      const hit = resolve(inner, depth + 1);
      node = hit ? store.getNode(hit.targetId) : null;
    }
    return node ? returnTypeOf(node) : null;
  }

  /**
   * Returns { targetId, resolution, inherited } or null. Results depend only
   * on the graph, so full and incremental builds agree.
   */
  function resolve(call, depth = 0) {
    const method = call?.method;
    if (!method) return null;

    const receiverType = receiverTypeOf(call, depth);
    if (receiverType) {
      const types = typesNamed(cleanTypeName(receiverType));
      for (const type of types) {
        const hit = findOnType(type, method);
        if (hit) {
          const viaReturn = !call.receiver_type;
          return { targetId: hit.node.id, resolution: call.self ? 'self' : 'typed', inherited: hit.inherited || viaReturn, path: hit.path };
        }
      }
      return call.self ? forwardedCall(types, method) : null;
    }

    const receiver = receiverTokens(call.receiver);
    if (!receiver) return null;
    // Only concrete types: an interface member matches any object with that
    // shape (`form.handleSubmit()` of a library is not `SomeFormProps`).
    const matches = [...methodsNamed(method)].filter(([owner, node]) =>
      ownerMatchesReceiver(owner, receiver) && declaringTypes(owner, node).some(t => NAME_BINDABLE_KINDS.has(t.kind)));
    if (matches.length !== 1) return null;
    return { targetId: matches[0][1].id, resolution: 'receiver_name', inherited: false };
  }

  // `$this->x()` in a class that forwards unknown calls (`__call`, an API
  // resource wrapping a model): the class named by the longest leading part
  // of this class's name (`OrderSummaryResource` -> `Order`) that defines x.
  function forwardedCall(types, method) {
    const forwarding = types.find(t => parseMeta(t.metadata).forwards_calls);
    if (!forwarding) return null;
    const words = nameTokens(shortName(forwarding.symbol));
    let best = null;
    for (const [owner, node] of methodsNamed(method)) {
      const ownerWords = nameTokens(shortName(owner));
      if (ownerWords.length === 0 || ownerWords.length >= words.length) continue;
      if (!ownerWords.every((w, i) => words[i] === w)) continue;
      if (!declaringTypes(owner, node).some(t => NAME_BINDABLE_KINDS.has(t.kind))) continue;
      if (!best || ownerWords.length > best.words) best = { node, words: ownerWords.length, tie: false };
      else if (ownerWords.length === best.words) best.tie = true;
    }
    return best && !best.tie ? { targetId: best.node.id, resolution: 'receiver_name', inherited: true } : null;
  }

  /** Whether the graph defines the type (a miss on a known type is a missing method). */
  function hasType(name) {
    return typesNamed(cleanTypeName(name)).length > 0;
  }

  /** Method names a call's receiver chain depends on (for incremental rebuilds). */
  function chainMethods(call) {
    const names = [];
    for (let c = call?.receiver_call; c && names.length < 5; c = c.receiver_call) names.push(c.method);
    return names;
  }

  return { resolve, hasType, chainMethods };
}

/**
 * Collapses repeated calls between the same two symbols into one edge that
 * keeps the strongest resolution and the call-site lines.
 */
export function mergeCallMetadata(existing, call, resolution) {
  const lines = new Set(existing?.lines || []);
  if (Number.isInteger(call.line) && lines.size < MAX_CALL_LINES) lines.add(call.line);
  const keepExisting = existing && RESOLUTION_STRENGTH[existing.resolution] >= RESOLUTION_STRENGTH[resolution];
  return {
    resolution: keepExisting ? existing.resolution : resolution,
    receiver: keepExisting ? existing.receiver : call.receiver,
    lines: [...lines].sort((a, b) => a - b),
  };
}

/** `App\Models\User::save` -> `App\Models\User`; `UserRepo.save` -> `UserRepo`. */
export function ownerSymbol(symbol) {
  const text = String(symbol);
  const colon = text.lastIndexOf('::');
  if (colon > 0) return text.slice(0, colon);
  const dot = text.lastIndexOf('.');
  return dot > 0 ? text.slice(0, dot) : null;
}

function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function shortName(symbol) {
  const text = String(symbol);
  return text.slice(Math.max(text.lastIndexOf('\\'), text.lastIndexOf('.')) + 1);
}

// `?Foo`, `Foo?`, `Foo<Bar>`, `Foo[]`, `\App\Foo`, `Foo|null` -> the class name.
function cleanTypeName(type) {
  const first = String(type).split('|').map(t => t.trim()).find(t => t && t.toLowerCase() !== 'null') || '';
  return first.replace(/^\?/, '').replace(/\?$/, '').replace(/<.*$/s, '').replace(/\[\]$/, '').replace(/^\\/, '').trim();
}

// Name tokens of the last identifier in a receiver expression:
// `$this->userService` -> [user, service], `ctx.store` -> [store].
// Call results (`$this->repo()`) and literals give null: their name says
// nothing reliable about the type.
function receiverTokens(receiver) {
  if (!receiver) return null;
  const text = String(receiver).trim();
  if (/[)\]'"`]$/.test(text)) return null;
  const last = text.split(/->|\?->|\?\.|!\.|\.|::/).filter(Boolean).pop() || '';
  const name = last.replace(/^[$_]+/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name === 'this' || name === 'self') return null;
  return nameTokens(name);
}

function nameTokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean)
    .map(t => t.toLowerCase());
}

// The receiver names the owner class: its last word matches the class's last
// word (`store` ~ GraphStore, `repo` ~ UserRepository) and every other word
// appears in the class name (`userRepo` ~ UserRepository, not AdminRepository).
function ownerMatchesReceiver(owner, receiver) {
  const ownerWords = nameTokens(shortName(owner));
  if (ownerWords.length === 0) return false;
  const matchesWord = (r, o) => r === o || (r.length >= 3 && o.startsWith(r));
  const lastReceiver = receiver[receiver.length - 1];
  if (!matchesWord(lastReceiver, ownerWords[ownerWords.length - 1])) return false;
  return receiver.slice(0, -1).every(r => ownerWords.some(o => matchesWord(r, o)));
}
