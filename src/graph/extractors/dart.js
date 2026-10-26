import { basename } from 'node:path';

const FLUTTER_WIDGETS = new Set([
  'StatelessWidget', 'StatefulWidget',
]);

const FLUTTER_STATE_PATTERN = /^_\w+State$/;

// Generic lookups that return an instance of their type argument:
// Get.find<T>(), GetIt.I<T>(), locator<T>(), context.read<T>(), Provider.of<T>().
const DI_LOOKUPS = new Set(['find', 'put', 'get', 'read', 'watch', 'of', 'I', 'instance', 'call', 'getIt', 'locator', 'sl', 'inject', 'resolve']);
// GetX views expose their controller as `controller`.
const GETX_VIEWS = new Set(['GetView', 'GetWidget', 'GetResponsiveView', 'GetResponsiveWidget']);

function nextBody(parent, index) {
  const next = parent.namedChild(index + 1);
  return next?.type === 'function_body' ? next : null;
}

// Calls `visit(primary, selectors)` for each primary followed by selectors
// among a node's children.
function forEachChain(node, visit) {
  const kids = node.namedChildren;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type === 'selector' || kids[i + 1]?.type !== 'selector') continue;
    let j = i + 1;
    while (j < kids.length && kids[j].type === 'selector') j++;
    visit(kids[i], kids.slice(i + 1, j));
    i = j - 1;
  }
}

function isInvocation(selector) {
  return selector.namedChild(0)?.type === 'argument_part';
}

function selectorName(selector) {
  const inner = selector.namedChild(0);
  if (inner?.type !== 'unconditional_assignable_selector' && inner?.type !== 'conditional_assignable_selector') return null;
  return findFirst(inner, 'identifier')?.text ?? null;
}

// The single type argument of an invocation: `<Foo>()` -> Foo.
function typeArgument(selector) {
  const args = findFirst(selector.namedChild(0), 'type_arguments');
  const types = args ? collectNamedChildren(args, 'type_identifier') : [];
  return args && args.namedChildCount === 1 && types.length === 1 ? types[0].text : null;
}

// Return type written before a function's name (`Future<Foo> load()` -> `Future<Foo>`).
function declaredReturnType(sig) {
  const parts = [];
  for (const child of sig.namedChildren) {
    if (child.type === 'identifier' || child.type === 'formal_parameter_list') break;
    if (child.type === 'type_identifier' || child.type === 'type_arguments') parts.push(child.text);
  }
  const text = parts.join('');
  return /^[A-Z]/.test(text) ? text : null;
}

// Declared class type of a declaration or parameter (`final Repo repo`, `Foo? x`).
function typeOf(node) {
  const type = findFirst(node, 'type_identifier')?.text;
  return type && /^[A-Z]/.test(type) && !BUILTIN_TYPES.has(type) ? type : null;
}

const BUILTIN_TYPES = new Set(['String', 'List', 'Map', 'Set', 'Iterable', 'Future', 'Stream', 'Object', 'Function', 'DateTime', 'Duration', 'Uri', 'Type', 'Never', 'Null', 'Record', 'Symbol', 'BigInt', 'RegExp', 'Completer', 'FutureOr', 'Rx', 'RxList', 'RxMap', 'RxBool', 'RxInt', 'RxString', 'RxDouble']);

function walk(node, visitor) {
  const result = visitor(node);
  if (result === false) return;
  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i), visitor);
  }
}

function collectNamedChildren(node, type) {
  const results = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === type) results.push(child);
  }
  return results;
}

function findFirst(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === type) return child;
  }
  return null;
}

function findFirstDeep(node, type) {
  if (node.type === type) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const result = findFirstDeep(node.namedChild(i), type);
    if (result) return result;
  }
  return null;
}

function collectAllDeep(node, type) {
  const results = [];
  walk(node, (n) => {
    if (n.type === type) results.push(n);
  });
  return results;
}

function getDocComment(node) {
  let prev = node.previousSibling;
  const lines = [];
  while (prev && prev.type === 'documentation_comment') {
    lines.unshift(prev.text);
    prev = prev.previousSibling;
  }
  return lines.length ? lines.join('\n') : null;
}

function getSuperclassName(classNode) {
  const superclassNode = classNode.childForFieldName('superclass');
  if (!superclassNode) return null;
  const typeId = findFirst(superclassNode, 'type_identifier');
  return typeId ? typeId.text : null;
}

function getMixinNames(classNode) {
  const superclassNode = classNode.childForFieldName('superclass');
  const mixinsNode = superclassNode
    ? findFirst(superclassNode, 'mixins')
    : null;

  const interfacesParent = classNode.childForFieldName('interfaces');
  if (!mixinsNode && interfacesParent) {
    const fromInterfaces = findFirst(interfacesParent, 'mixins');
    if (fromInterfaces) {
      return collectNamedChildren(fromInterfaces, 'type_identifier').map(n => n.text);
    }
  }

  if (!mixinsNode) {
    for (let i = 0; i < classNode.namedChildCount; i++) {
      const child = classNode.namedChild(i);
      if (child.type === 'mixins') {
        return collectNamedChildren(child, 'type_identifier').map(n => n.text);
      }
    }
    return [];
  }

  return collectNamedChildren(mixinsNode, 'type_identifier').map(n => n.text);
}

function getInterfaceNames(classNode) {
  const interfacesNode = classNode.childForFieldName('interfaces');
  if (!interfacesNode) return [];
  return collectNamedChildren(interfacesNode, 'type_identifier').map(n => n.text);
}

function getParamSignature(node) {
  const params = findFirstDeep(node, 'formal_parameter_list');
  return params ? params.text : null;
}

function hasChildText(node, text) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).text === text) return true;
  }
  return false;
}

function isStatic(declarationNode) {
  for (let i = 0; i < declarationNode.childCount; i++) {
    if (declarationNode.child(i).text === 'static') return true;
  }
  return false;
}

function isAsync(declarationNode) {
  const body = findFirst(declarationNode, 'function_body');
  if (!body) return false;
  return body.text.includes('async');
}

function extractImportUri(importNode) {
  const spec = findFirstDeep(importNode, 'import_specification');
  if (!spec) return null;
  const uri = findFirst(spec, 'uri') || findFirst(spec, 'configurable_uri');
  if (!uri) return null;
  const stringLit = findFirstDeep(uri, 'string_literal');
  if (stringLit) {
    return stringLit.text.replace(/^['"]|['"]$/g, '');
  }
  return uri.text.replace(/^['"]|['"]$/g, '');
}

function extractImportAlias(importNode) {
  const spec = findFirstDeep(importNode, 'import_specification');
  if (!spec) return null;
  const text = spec.text;
  const asMatch = text.match(/\bas\s+(\w+)/);
  return asMatch ? asMatch[1] : null;
}

function makeNode(subprojectId, path, symbol, kind, opts = {}) {
  return {
    subproject_id: subprojectId,
    path,
    lang: 'dart',
    symbol,
    kind,
    parent_symbol: opts.parent_symbol ?? null,
    start_line: opts.start_line ?? 0,
    end_line: opts.end_line ?? 0,
    exported: opts.exported ?? !symbol.startsWith('_'),
    signature: opts.signature ?? null,
    doc: opts.doc ?? null,
    metadata: opts.metadata ?? null,
  };
}

function makeEdge(subprojectId, source, target, edgeKind, meta = null) {
  return {
    subproject_id: subprojectId,
    source_symbol: source.symbol,
    source_kind: source.kind,
    source_path: source.path,
    target_symbol: target.symbol,
    target_kind: target.kind,
    kind: edgeKind,
    metadata: meta,
  };
}

export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const root = tree.rootNode;
  const sourceText = root.text;
  const classMap = new Map();
  const renderedWidgets = new Set();

  if (/migrations\//.test(filePath) && /MigrationStrategy|onCreate|onUpgrade/.test(sourceText)) {
    edges.push(makeEdge(subprojectId,
      { symbol: filePath, kind: 'file', path: filePath },
      { symbol: 'migration', kind: 'table' },
      'migrates_table'));
  }

  for (let i = 0; i < root.namedChildCount; i++) {
    const topNode = root.namedChild(i);

    if (topNode.type === 'import_or_export') {
      extractImport(topNode);
    } else if (topNode.type === 'class_definition') {
      extractClass(topNode);
    } else if (topNode.type === 'enum_declaration') {
      extractEnum(topNode);
    } else if (topNode.type === 'mixin_declaration') {
      extractMixin(topNode);
    } else if (topNode.type === 'function_signature') {
      extractTopLevelFunction(topNode, null, nextBody(root, i));
    } else if (topNode.type === 'declaration') {
      extractDeclaration(topNode, null, nextBody(root, i));
    } else if (topNode.type === 'initialized_variable_definition') {
      extractTopLevelVariable(topNode);
    } else if (topNode.type === 'expression_statement') {
      extractExpressionStatement(topNode, null);
    } else if (topNode.type !== 'function_body') {
      const funcSig = findFirst(topNode, 'function_signature');
      if (funcSig) {
        extractTopLevelFunction(funcSig, topNode, nextBody(root, i));
      }
    }
  }

  return { nodes, edges };

  function extractImport(node) {
    const uri = extractImportUri(node);
    if (!uri) return;

    const fileSymbol = basename(filePath, '.dart');
    edges.push({
      subproject_id: subprojectId,
      source_symbol: fileSymbol,
      source_kind: 'file',
      source_path: filePath,
      target_symbol: uri,
      target_kind: 'module',
      kind: 'imports',
      metadata: { alias: extractImportAlias(node) },
    });
  }

  function extractClass(node) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const superName = getSuperclassName(node);
    const mixinNames = getMixinNames(node);
    const interfaceNames = getInterfaceNames(node);
    const doc = getDocComment(node);

    const isWidget = FLUTTER_WIDGETS.has(superName);
    const isAbstract = hasChildText(node, 'abstract');

    const metadata = {};
    if (superName) metadata.extends = superName;
    if (mixinNames.length) metadata.mixins = mixinNames;
    if (interfaceNames.length) metadata.implements = interfaceNames;
    if (isAbstract) metadata.abstract = true;

    const classEntity = makeNode(subprojectId, filePath, name, 'class', {
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      signature: buildClassSignature(name, superName, mixinNames, interfaceNames, isAbstract),
      doc,
      metadata: Object.keys(metadata).length ? metadata : null,
    });
    nodes.push(classEntity);
    classMap.set(name, classEntity);

    if (isWidget) {
      const widgetType = superName === 'StatelessWidget' ? 'stateless' : 'stateful';
      const componentNode = makeNode(subprojectId, filePath, name, 'component', {
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        doc,
        metadata: { type: widgetType },
      });
      nodes.push(componentNode);
    }

    if (superName) {
      edges.push(makeEdge(subprojectId,
        { symbol: name, kind: 'class', path: filePath },
        { symbol: superName, kind: 'class' },
        'extends'));
    }

    for (const iface of interfaceNames) {
      edges.push(makeEdge(subprojectId,
        { symbol: name, kind: 'class', path: filePath },
        { symbol: iface, kind: 'class' },
        'implements'));
    }

    for (const mixin of mixinNames) {
      edges.push(makeEdge(subprojectId,
        { symbol: name, kind: 'class', path: filePath },
        { symbol: mixin, kind: 'mixin' },
        'uses_trait'));
    }

    const seenGenerics = new Set();
    const genericRegex = /<([A-Z_]\w*)>/g;
    for (const sourceNode of [node.childForFieldName('superclass'), node.childForFieldName('interfaces')]) {
      if (!sourceNode) continue;
      for (const match of sourceNode.text.matchAll(genericRegex)) {
        if (seenGenerics.has(match[1])) continue;
        seenGenerics.add(match[1]);
        edges.push(makeEdge(subprojectId,
          { symbol: name, kind: 'class', path: filePath },
          { symbol: match[1], kind: 'class' },
          'type_references'));
      }
    }

    const body = node.childForFieldName('body');
    if (body) {
      extractClassBody(body, name, isWidget, superName, node);
    }
  }

  // A member's body is the `function_body` that follows its signature.
  function extractClassBody(body, className, isWidget, superName, typeNode) {
    const classCtx = classTypeContext(typeNode, body, className);
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);
      const fnBody = nextBody(body, i);

      if (member.type === 'declaration') {
        extractClassMember(member, className, isWidget, superName, fnBody, classCtx);
      } else if (member.type === 'method_signature') {
        extractMethodSignature(member, className, isWidget, superName, fnBody, classCtx);
      }
    }
  }

  function extractMethodSignature(sigNode, className, isWidget, superName, fnBody, classCtx) {
    const funcSig = findFirst(sigNode, 'function_signature');
    const getterSig = findFirst(sigNode, 'getter_signature');
    const setterSig = findFirst(sigNode, 'setter_signature');
    const ctorSig = findFirst(sigNode, 'constructor_signature');
    const factorySig = findFirst(sigNode, 'factory_constructor_signature');

    if (funcSig) {
      processMethodFunction(funcSig, sigNode, className, isWidget, superName, isStatic(sigNode), fnBody, classCtx);
    } else if (getterSig) {
      processGetterSetter(getterSig, sigNode, className, 'getter', fnBody, classCtx);
    } else if (setterSig) {
      processGetterSetter(setterSig, sigNode, className, 'setter', fnBody, classCtx);
    } else if (ctorSig || factorySig) {
      processConstructor(ctorSig || factorySig, sigNode, className, !!factorySig, fnBody, classCtx);
    }
  }

  // Constructors are `Class.Class` (unnamed) or `Class.named`, so a call
  // `Class.named(...)` resolves like a static method.
  function processConstructor(sig, declNode, className, factory, fnBody, classCtx) {
    const identifiers = collectNamedChildren(sig, 'identifier').map(n => n.text);
    const name = identifiers.length > 1 ? identifiers.slice(1).join('.') : className;
    const symbol = `${className}.${name}`;
    const spans = [declNode, fnBody].filter(Boolean);
    nodes.push(makeNode(subprojectId, filePath, symbol, 'method', {
      parent_symbol: className,
      start_line: declNode.startPosition.row + 1,
      end_line: spans.at(-1).endPosition.row + 1,
      signature: `${identifiers.join('.') || className}${getParamSignature(sig) || '()'}`,
      doc: getDocComment(declNode),
      metadata: { constructor: true, factory },
    }));
    extractCalls(spans, { symbol, kind: 'method' }, classCtx, false);
  }

  function extractClassMember(declNode, className, isWidget, superName, fnBody, classCtx) {
    const funcSig = findFirst(declNode, 'function_signature');
    const getterSig = findFirst(declNode, 'getter_signature');
    const setterSig = findFirst(declNode, 'setter_signature');
    const ctorSig = findFirst(declNode, 'constructor_signature');
    const factorySig = findFirst(declNode, 'factory_constructor_signature');

    if (funcSig) {
      processMethodFunction(funcSig, declNode, className, isWidget, superName, isStatic(declNode), fnBody, classCtx);
    } else if (getterSig) {
      processGetterSetter(getterSig, declNode, className, 'getter', fnBody, classCtx);
    } else if (setterSig) {
      processGetterSetter(setterSig, declNode, className, 'setter', fnBody, classCtx);
    } else if (ctorSig || factorySig) {
      processConstructor(ctorSig || factorySig, declNode, className, !!factorySig, fnBody, classCtx);
    } else {
      // Field initialisers (`final repo = Get.find<Repo>()`) call code too.
      extractCalls([declNode], { symbol: className, kind: 'class' }, classCtx, false);
    }
  }

  function processMethodFunction(funcSig, parentNode, className, isWidget, superName, staticFlag, fnBody, classCtx) {
    const nameNode = funcSig.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const params = getParamSignature(funcSig);
    const doc = getDocComment(parentNode);
    const spans = [parentNode, fnBody].filter(Boolean);
    const asyncFlag = isAsync(parentNode) || /^\s*async\b/.test(fnBody?.text || '');

    const meta = {};
    if (staticFlag) meta.static = true;
    if (asyncFlag) meta.async = true;

    const isBuild = name === 'build';
    const isStateClass = FLUTTER_STATE_PATTERN.test(className);

    const renders = isBuild && (isWidget || isStateClass);
    if (renders) {
      meta.widget_build = true;
      extractRenderedWidgets(spans, className);
    }

    const returnType = declaredReturnType(funcSig);
    if (returnType) meta.return_type = returnType;
    const symbol = `${className}.${name}`;
    nodes.push(makeNode(subprojectId, filePath, symbol, 'method', {
      parent_symbol: className,
      start_line: parentNode.startPosition.row + 1,
      end_line: spans.at(-1).endPosition.row + 1,
      signature: `${name}${params || '()'}`,
      doc,
      metadata: Object.keys(meta).length ? meta : null,
    }));

    extractConstructorCalls(spans, className);
    extractDbQueries(spans, className);
    extractEventListeners(spans, className);
    extractInjections(spans, className);
    extractCalls(spans, { symbol, kind: 'method' }, classCtx, renders);
  }

  function processGetterSetter(sig, parentNode, className, accessorKind, fnBody, classCtx) {
    const nameNode = sig.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const symbol = `${className}.${name}`;
    const spans = [parentNode, fnBody].filter(Boolean);
    const returnType = accessorKind === 'getter' ? declaredReturnType(sig) : null;
    nodes.push(makeNode(subprojectId, filePath, symbol, 'method', {
      parent_symbol: className,
      start_line: parentNode.startPosition.row + 1,
      end_line: spans.at(-1).endPosition.row + 1,
      signature: `${accessorKind} ${name}`,
      doc: getDocComment(parentNode),
      metadata: { [accessorKind]: true, ...(returnType ? { return_type: returnType } : {}) },
    }));
    extractCalls(spans, { symbol, kind: 'method' }, classCtx, false);
  }

  function extractRenderedWidgets(spans, className) {
    const constructorInvocations = spans.flatMap(span => collectAllDeep(span, 'constructor_invocation'));
    const seen = new Set();
    for (const inv of constructorInvocations) {
      const typeId = findFirst(inv, 'type_identifier') || findFirst(inv, 'identifier');
      if (!typeId) continue;
      const widgetName = typeId.text;
      if (seen.has(widgetName)) continue;
      seen.add(widgetName);
      renderedWidgets.add(`${className}:${widgetName}`);
      edges.push(makeEdge(subprojectId,
        { symbol: className, kind: 'component', path: filePath },
        { symbol: widgetName, kind: 'component' },
        'renders'));
    }
  }

  function extractConstructorCalls(spans, contextSymbol) {
    const invocations = spans.flatMap(span => collectAllDeep(span, 'constructor_invocation'));
    const seen = new Set();
    for (const inv of invocations) {
      const typeId = findFirst(inv, 'type_identifier') || findFirst(inv, 'identifier');
      if (!typeId) continue;
      const name = typeId.text;
      if (seen.has(name)) continue;
      seen.add(name);
      if (renderedWidgets.has(`${contextSymbol}:${name}`)) continue;
      edges.push(makeEdge(subprojectId,
        { symbol: contextSymbol, kind: 'class', path: filePath },
        { symbol: name, kind: 'class' },
        'calls'));
    }
  }

  function extractDbQueries(spans, contextSymbol) {
    const text = spans.map(span => span.text).join('\n');
    const dbMethods = ['collection', 'doc', 'get', 'where', 'select', 'insert', 'update', 'delete'];
    const seen = new Set();
    for (const method of dbMethods) {
      const regex = new RegExp(`\\.${method}\\(`);
      if (regex.test(text) && !seen.has(method)) {
        seen.add(method);
        edges.push(makeEdge(subprojectId,
          { symbol: contextSymbol, kind: 'class', path: filePath },
          { symbol: method, kind: 'function' },
          'queries'));
      }
    }
  }

  function extractEventListeners(spans, contextSymbol) {
    const text = spans.map(span => span.text).join('\n');
    const listenerPatterns = ['addListener(', '.listen(', 'Stream.listen(', 'BlocListener'];
    const seen = new Set();
    for (const pattern of listenerPatterns) {
      if (text.includes(pattern) && !seen.has(pattern)) {
        seen.add(pattern);
        edges.push(makeEdge(subprojectId,
          { symbol: contextSymbol, kind: 'class', path: filePath },
          { symbol: pattern, kind: 'event' },
          'consumes_event'));
      }
    }
  }

  function extractInjections(spans, contextSymbol) {
    const text = spans.map(span => span.text).join('\n');
    const patterns = [
      /GetIt\.I\.get<(\w+)>/g,
      /Provider\.of<(\w+)>/g,
      /GetIt\.I\.registerSingleton<(\w+)>/g,
      /locator<(\w+)>/g,
    ];
    const seen = new Set();
    for (const regex of patterns) {
      for (const match of text.matchAll(regex)) {
        const typeName = match[1];
        if (seen.has(typeName)) continue;
        seen.add(typeName);
        edges.push(makeEdge(subprojectId,
          { symbol: contextSymbol, kind: 'class', path: filePath },
          { symbol: typeName, kind: 'class' },
          'injects'));
      }
    }
  }

  function extractEnum(node) {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;

    const body = node.childForFieldName('body');
    const constants = body
      ? collectNamedChildren(body, 'enum_constant').map(c => c.text)
      : [];

    nodes.push(makeNode(subprojectId, filePath, name, 'enum', {
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      doc: getDocComment(node),
      metadata: constants.length ? { values: constants } : null,
    }));
  }

  function extractMixin(node) {
    const identifiers = collectNamedChildren(node, 'identifier');
    const name = identifiers[0]?.text;
    if (!name) return;

    const interfaces = findFirst(node, 'interfaces');
    const interfaceNames = interfaces
      ? collectNamedChildren(interfaces, 'type_identifier').map(n => n.text)
      : [];

    const onTypes = [];
    const text = node.text;
    const onMatch = text.match(/\bon\s+(\w+)/);
    if (onMatch) onTypes.push(onMatch[1]);

    const meta = {};
    if (onTypes.length) meta.on = onTypes;
    if (interfaceNames.length) meta.implements = interfaceNames;

    nodes.push(makeNode(subprojectId, filePath, name, 'mixin', {
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      doc: getDocComment(node),
      metadata: Object.keys(meta).length ? meta : null,
    }));

    const body = findFirst(node, 'class_body');
    if (body) extractClassBody(body, name, false, null, node);
  }

  function extractTopLevelFunction(funcSigNode, wrapperNode, fnBody) {
    const container = wrapperNode || funcSigNode;
    const nameNode = funcSigNode.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const params = getParamSignature(funcSigNode);
    const spans = [container, fnBody].filter(Boolean);

    const fnMeta = {};
    if (isAsync(container) || /^\s*async\b/.test(fnBody?.text || '')) fnMeta.async = true;
    const returnType = declaredReturnType(funcSigNode);
    if (returnType) fnMeta.return_type = returnType;
    nodes.push(makeNode(subprojectId, filePath, name, 'function', {
      start_line: container.startPosition.row + 1,
      end_line: spans.at(-1).endPosition.row + 1,
      signature: `${name}${params || '()'}`,
      doc: getDocComment(container),
      metadata: Object.keys(fnMeta).length ? fnMeta : null,
    }));

    extractConstructorCalls(spans, name);
    extractDbQueries(spans, name);
    extractEventListeners(spans, name);
    extractInjections(spans, name);
    extractCalls(spans, { symbol: name, kind: 'function' }, null, false);
  }

  function extractTopLevelVariable(node) {
    const name = node.childForFieldName?.('name')?.text
      ?? findFirst(node, 'identifier')?.text;
    if (!name) return;

    const valueText = node.text;
    extractProvider(name, valueText, node);
    extractRoute(valueText, name, node);
  }

  function extractDeclaration(node, parentSymbol, fnBody) {
    const varDef = findFirst(node, 'initialized_variable_definition');
    if (varDef) {
      const name = varDef.childForFieldName?.('name')?.text
        ?? findFirst(varDef, 'identifier')?.text;
      if (name) {
        const valueText = varDef.text;
        extractProvider(name, valueText, node);
        extractRoute(valueText, name, node);
      }
      return;
    }

    const funcSig = findFirst(node, 'function_signature');
    if (funcSig && !parentSymbol) {
      extractTopLevelFunction(funcSig, node, fnBody);
    }
  }

  function extractExpressionStatement(node, contextSymbol) {
    const text = node.text;
    extractRoute(text, contextSymbol, node);
    extractGetXPut(text, node);
  }

  function extractProvider(name, valueText, node) {
    const providerMatch = valueText.match(
      /\b(Provider|StateProvider|FutureProvider|StreamProvider|StateNotifierProvider|ChangeNotifierProvider|NotifierProvider|AsyncNotifierProvider|BlocProvider|RepositoryProvider)\s*[<(]/
    );
    if (!providerMatch) return;

    nodes.push(makeNode(subprojectId, filePath, name, 'provider', {
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      metadata: { provider_type: providerMatch[1] },
    }));

    edges.push(makeEdge(subprojectId,
      { symbol: name, kind: 'provider', path: filePath },
      { symbol: providerMatch[1], kind: 'class' },
      'provides'));
  }

  function extractRoute(text, contextSymbol, node) {
    const goRouteMatch = text.match(/GoRoute\s*\(\s*path\s*:\s*['"]([^'"]+)['"]/);
    if (goRouteMatch) {
      nodes.push(makeNode(subprojectId, filePath, goRouteMatch[1], 'route', {
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        metadata: { type: 'go_router' },
      }));
      return;
    }

    const materialRouteMatch = text.match(/MaterialPageRoute|CupertinoPageRoute/);
    if (materialRouteMatch) {
      const routeType = materialRouteMatch[0];
      nodes.push(makeNode(subprojectId, filePath, contextSymbol || routeType, 'route', {
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        metadata: { type: routeType },
      }));
      return;
    }

    const pushNamedMatch = text.match(/Navigator\.\w*push\w*\(\s*['"]([^'"]+)['"]/);
    if (pushNamedMatch) {
      nodes.push(makeNode(subprojectId, filePath, pushNamedMatch[1], 'route', {
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        metadata: { type: 'navigator_push' },
      }));
    }
  }

  function extractGetXPut(text, node) {
    const getxMatch = text.match(/Get\.put\s*[<(]\s*(\w+)/);
    if (getxMatch) {
      nodes.push(makeNode(subprojectId, filePath, getxMatch[1], 'provider', {
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        metadata: { provider_type: 'GetX' },
      }));
    }
  }

  // ── Calls (resolved by the graph builder, see src/graph/calls.js) ──
  //
  // Dart chains are flat: a primary (`repo`, `this`, `Foo`) followed by
  // selectors (`.save`, `(args)`). A name selector followed by arguments is a
  // method call on everything before it; arguments right after the primary
  // are a call to a function, a constructor (`Foo()`), or a method on the
  // implicit `this`.

  function extractCalls(spans, source, classCtx, renders) {
    const locals = new Map();
    const ctx = { classCtx, locals };
    const instantiated = new Set();
    for (const span of spans) {
      walk(span, (n) => {
        recordLocal(n, ctx);
        forEachChain(n, (primary, selectors) => handleChain(primary, selectors, source, ctx, renders, instantiated));
      });
    }
  }

  function handleChain(primary, selectors, source, ctx, renders, instantiated) {
    const from = { symbol: source.symbol, kind: source.kind, path: filePath };
    for (let t = 0; t < selectors.length; t++) {
      if (!isInvocation(selectors[t])) continue;
      const nameSelector = t > 0 ? selectors[t - 1] : null;
      const method = nameSelector ? selectorName(nameSelector) : null;
      if (method) {
        const receiverSelectors = selectors.slice(0, t - 1);
        const typed = chainType(primary, receiverSelectors, ctx);
        const receiver = primary.text + receiverSelectors.map(sel => sel.text).join('');
        edges.push(callEdge(from, method, receiver, typed, nameSelector));
      } else if (t === 0 && primary.type === 'identifier') {
        const name = primary.text;
        if (/^[A-Z]/.test(name)) {
          const seenKey = `${name}:${primary.startPosition.row}`;
          if (instantiated.has(seenKey)) continue;
          instantiated.add(seenKey);
          const line = primary.startPosition.row + 1;
          edges.push(renders
            ? makeEdge(subprojectId, { symbol: source.symbol.split('.')[0], kind: 'component', path: filePath }, { symbol: name, kind: 'component' }, 'renders', { line })
            : makeEdge(subprojectId, from, { symbol: name, kind: 'class' }, 'calls', { type: 'instantiation', line }));
        } else if (!ctx.locals.has(name)) {
          edges.push(ctx.classCtx
            ? callEdge(from, name, 'this', { type: ctx.classCtx.className, self: true }, primary, true)
            : makeEdge(subprojectId, from, { symbol: name, kind: 'function' }, 'calls', { line: primary.startPosition.row + 1 }));
        }
      }
    }
  }

  function callEdge(from, method, receiver, typed, lineNode, implicit = false) {
    return makeEdge(subprojectId, from, { symbol: typed?.type ? `${typed.type}.${method}` : method, kind: 'method' }, 'calls', {
      call: { ...describeCall(method, receiver, typed, implicit), line: lineNode.startPosition.row + 1 },
    });
  }

  // `typed` is { type, self } (known class), { call } (what another call
  // returns, typed by the builder from its return type) or null.
  function describeCall(method, receiver, typed, implicit = false) {
    return {
      method,
      receiver: receiver.length > 120 ? `${receiver.slice(0, 117)}...` : receiver,
      ...(typed?.type ? { receiver_type: typed.type } : {}),
      ...(typed?.call ? { receiver_call: typed.call } : {}),
      ...(typed?.self ? { self: true } : {}),
      // A bare `name()` inside a class may also be a top-level function.
      ...(implicit ? { implicit: true } : {}),
    };
  }

  // Locals and parameters, in source order, so later chains see their types.
  function recordLocal(n, ctx) {
    const set = (name, type) => { if (name && !ctx.locals.has(name)) ctx.locals.set(name, type ?? null); };
    if (n.type === 'formal_parameter') {
      const ctorParam = findFirst(n, 'constructor_param');
      if (ctorParam) return;
      const name = n.childForFieldName('name')?.text ?? collectNamedChildren(n, 'identifier').at(-1)?.text;
      set(name, typeOf(n));
    } else if (n.type === 'initialized_variable_definition') {
      const name = n.childForFieldName('name')?.text;
      set(name, typeOf(n) ?? valueType(n, name, ctx));
    }
  }

  function chainType(primary, selectors, ctx) {
    let current = primaryType(primary, ctx);
    for (let t = 0; t < selectors.length; t++) {
      const sel = selectors[t];
      if (isInvocation(sel)) {
        const callee = t > 0 ? selectorName(selectors[t - 1]) : (primary.type === 'identifier' ? primary.text : null);
        const generic = typeArgument(sel);
        if (generic && DI_LOOKUPS.has(callee)) current = { type: generic };
        else if (t <= 1 && current?.isClass) current = { type: current.type }; // Foo(), Foo.named()
        else if (t > 0 && callee) {
          // The result of a method call: typed later from its return type.
          const receiver = primary.text + selectors.slice(0, t - 1).map(x => x.text).join('');
          current = { call: describeCall(callee, receiver, current) };
        } else if (t === 0 && callee && !ctx.locals?.has(callee)) {
          current = ctx.classCtx
            ? { call: describeCall(callee, 'this', { type: ctx.classCtx.className, self: true }, true) }
            : { call: { method: callee, receiver: '', function: true } };
        } else current = null;
      } else {
        if (t + 1 < selectors.length && isInvocation(selectors[t + 1])) continue; // a method name
        const field = current?.self ? ctx.classCtx?.fields.get(selectorName(sel)) : null;
        current = field ? { type: field } : null;
      }
    }
    return current;
  }

  function primaryType(primary, ctx) {
    if (primary.type === 'this') return ctx.classCtx ? { type: ctx.classCtx.className, self: true } : null;
    if (primary.type !== 'identifier') return null;
    const name = primary.text;
    if (ctx.locals?.has(name)) {
      const type = ctx.locals.get(name);
      if (!type) return null;
      return typeof type === 'string' ? { type } : type;
    }
    const field = ctx.classCtx?.fields.get(name);
    if (field) return { type: field };
    return /^[A-Z]/.test(name) ? { type: name, isClass: true } : null;
  }

  // Type of an initialiser: the primary/selectors that follow the name.
  function valueType(defNode, name, ctx) {
    const kids = defNode.namedChildren;
    const start = kids.findIndex(k => k.type === 'identifier' && k.text === name);
    let rest = kids.slice(start + 1);
    if (rest[0]?.type === 'unary_expression' || rest[0]?.type === 'await_expression') {
      const inner = rest[0].type === 'unary_expression' ? findFirst(rest[0], 'await_expression') : rest[0];
      rest = inner ? inner.namedChildren : [];
    }
    if (!rest[0] || rest[0].type === 'selector') return null;
    const selectors = [];
    for (const k of rest.slice(1)) {
      if (k.type !== 'selector') break;
      selectors.push(k);
    }
    const typed = selectors.length > 0 ? chainType(rest[0], selectors, ctx) : null;
    if (typed?.type) return typed.type;
    return typed?.call ? { call: typed.call } : null;
  }

  // Fields of a class: declared types, `= Foo()` / `= Get.find<Foo>()`
  // initialisers, `controller` of GetX views and `widget` of a `State<W>`.
  function classTypeContext(typeNode, body, className) {
    const fields = new Map();
    const classCtx = { className, fields };
    for (const member of body.namedChildren) {
      if (member.type !== 'declaration') continue;
      const declared = typeOf(member);
      const list = findFirst(member, 'initialized_identifier_list');
      for (const item of list ? collectNamedChildren(list, 'initialized_identifier') : []) {
        const name = findFirst(item, 'identifier')?.text;
        const type = declared ?? valueType(item, name, { classCtx, locals: new Map() });
        if (name && typeof type === 'string' && !fields.has(name)) fields.set(name, type);
      }
    }
    const superclass = typeNode?.childForFieldName?.('superclass');
    const base = superclass ? findFirst(superclass, 'type_identifier')?.text : null;
    const typeArgs = superclass ? findFirst(superclass, 'type_arguments') : null;
    const argument = typeArgs ? findFirst(typeArgs, 'type_identifier')?.text : null;
    if (argument && GETX_VIEWS.has(base) && !fields.has('controller')) fields.set('controller', argument);
    if (argument && base === 'State' && !fields.has('widget')) fields.set('widget', argument);
    return classCtx;
  }

  function buildClassSignature(name, superName, mixins, interfaces, isAbstract) {
    let sig = isAbstract ? 'abstract class ' : 'class ';
    sig += name;
    if (superName) sig += ` extends ${superName}`;
    if (mixins.length) sig += ` with ${mixins.join(', ')}`;
    if (interfaces.length) sig += ` implements ${interfaces.join(', ')}`;
    return sig;
  }
}
