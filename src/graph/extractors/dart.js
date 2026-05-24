import { basename } from 'node:path';

const FLUTTER_WIDGETS = new Set([
  'StatelessWidget', 'StatefulWidget',
]);

const FLUTTER_STATE_PATTERN = /^_\w+State$/;

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
      extractTopLevelFunction(topNode);
    } else if (topNode.type === 'declaration') {
      extractDeclaration(topNode, null);
    } else if (topNode.type === 'initialized_variable_definition') {
      extractTopLevelVariable(topNode);
    } else if (topNode.type === 'expression_statement') {
      extractExpressionStatement(topNode, null);
    } else {
      const funcSig = findFirst(topNode, 'function_signature');
      if (funcSig) {
        extractTopLevelFunction(funcSig, topNode);
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
      extractClassBody(body, name, isWidget, superName);
    }
  }

  function extractClassBody(body, className, isWidget, superName) {
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i);

      if (member.type === 'declaration') {
        extractClassMember(member, className, isWidget, superName);
      } else if (member.type === 'method_signature') {
        extractMethodSignature(member, className, isWidget, superName);
      }
    }
  }

  function extractMethodSignature(sigNode, className, isWidget, superName) {
    const funcSig = findFirst(sigNode, 'function_signature');
    const getterSig = findFirst(sigNode, 'getter_signature');
    const setterSig = findFirst(sigNode, 'setter_signature');
    const ctorSig = findFirst(sigNode, 'constructor_signature');
    const factorySig = findFirst(sigNode, 'factory_constructor_signature');

    if (funcSig) {
      processMethodFunction(funcSig, sigNode, className, isWidget, superName, false);
    } else if (getterSig) {
      processGetterSetter(getterSig, sigNode, className, 'getter');
    } else if (setterSig) {
      processGetterSetter(setterSig, sigNode, className, 'setter');
    } else if (ctorSig || factorySig) {
      const sig = ctorSig || factorySig;
      const nameNode = sig.childForFieldName('name');
      const name = nameNode ? nameNode.text : className;
      const params = getParamSignature(sig);
      nodes.push(makeNode(subprojectId, filePath, `${className}.${name}`, 'method', {
        parent_symbol: className,
        start_line: sigNode.startPosition.row + 1,
        end_line: sigNode.endPosition.row + 1,
        signature: `${className}${params || '()'}`,
        doc: getDocComment(sigNode),
        metadata: { constructor: true, factory: !!factorySig },
      }));
    }
  }

  function extractClassMember(declNode, className, isWidget, superName) {
    const funcSig = findFirst(declNode, 'function_signature');
    const getterSig = findFirst(declNode, 'getter_signature');
    const setterSig = findFirst(declNode, 'setter_signature');
    const ctorSig = findFirst(declNode, 'constructor_signature');
    const factorySig = findFirst(declNode, 'factory_constructor_signature');

    if (funcSig) {
      processMethodFunction(funcSig, declNode, className, isWidget, superName, isStatic(declNode));
    } else if (getterSig) {
      processGetterSetter(getterSig, declNode, className, 'getter');
    } else if (setterSig) {
      processGetterSetter(setterSig, declNode, className, 'setter');
    } else if (ctorSig || factorySig) {
      const sig = ctorSig || factorySig;
      const nameNode = sig.childForFieldName('name');
      const identifiers = nameNode
        ? collectNamedChildren(sig, 'identifier')
        : [];
      const name = identifiers.map(n => n.text).join('.') || className;
      const params = getParamSignature(sig);
      nodes.push(makeNode(subprojectId, filePath, `${className}.${name}`, 'method', {
        parent_symbol: className,
        start_line: declNode.startPosition.row + 1,
        end_line: declNode.endPosition.row + 1,
        signature: `${name}${params || '()'}`,
        doc: getDocComment(declNode),
        metadata: { constructor: true, factory: !!factorySig },
      }));
    }

    extractConstructorCalls(declNode, className);
  }

  function processMethodFunction(funcSig, parentNode, className, isWidget, superName, staticFlag) {
    const nameNode = funcSig.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const params = getParamSignature(funcSig);
    const doc = getDocComment(parentNode);
    const asyncFlag = isAsync(parentNode);

    const meta = {};
    if (staticFlag) meta.static = true;
    if (asyncFlag) meta.async = true;

    const isBuild = name === 'build';
    const isStateClass = FLUTTER_STATE_PATTERN.test(className);

    if (isBuild && (isWidget || isStateClass)) {
      meta.widget_build = true;
      extractRenderedWidgets(parentNode, className);
    }

    nodes.push(makeNode(subprojectId, filePath, `${className}.${name}`, 'method', {
      parent_symbol: className,
      start_line: parentNode.startPosition.row + 1,
      end_line: parentNode.endPosition.row + 1,
      signature: `${name}${params || '()'}`,
      doc,
      metadata: Object.keys(meta).length ? meta : null,
    }));

    extractConstructorCalls(parentNode, className);
    extractDbQueries(parentNode, className);
    extractEventListeners(parentNode, className);
    extractInjections(parentNode, className);
  }

  function processGetterSetter(sig, parentNode, className, accessorKind) {
    const nameNode = sig.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    nodes.push(makeNode(subprojectId, filePath, `${className}.${name}`, 'method', {
      parent_symbol: className,
      start_line: parentNode.startPosition.row + 1,
      end_line: parentNode.endPosition.row + 1,
      signature: `${accessorKind} ${name}`,
      doc: getDocComment(parentNode),
      metadata: { [accessorKind]: true },
    }));
  }

  function extractRenderedWidgets(node, className) {
    const constructorInvocations = collectAllDeep(node, 'constructor_invocation');
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

  function extractConstructorCalls(node, contextSymbol) {
    const invocations = collectAllDeep(node, 'constructor_invocation');
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

  function extractDbQueries(node, contextSymbol) {
    const text = node.text;
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

  function extractEventListeners(node, contextSymbol) {
    const text = node.text;
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

  function extractInjections(node, contextSymbol) {
    const text = node.text;
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
  }

  function extractTopLevelFunction(funcSigNode, wrapperNode) {
    const container = wrapperNode || funcSigNode;
    const nameNode = funcSigNode.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;
    const params = getParamSignature(funcSigNode);

    nodes.push(makeNode(subprojectId, filePath, name, 'function', {
      start_line: container.startPosition.row + 1,
      end_line: container.endPosition.row + 1,
      signature: `${name}${params || '()'}`,
      doc: getDocComment(container),
      metadata: isAsync(container) ? { async: true } : null,
    }));

    extractConstructorCalls(container, name);
    extractDbQueries(container, name);
    extractEventListeners(container, name);
    extractInjections(container, name);
  }

  function extractTopLevelVariable(node) {
    const name = node.childForFieldName?.('name')?.text
      ?? findFirst(node, 'identifier')?.text;
    if (!name) return;

    const valueText = node.text;
    extractProvider(name, valueText, node);
    extractRoute(valueText, name, node);
  }

  function extractDeclaration(node, parentSymbol) {
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
      extractTopLevelFunction(funcSig, node);
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

  function buildClassSignature(name, superName, mixins, interfaces, isAbstract) {
    let sig = isAbstract ? 'abstract class ' : 'class ';
    sig += name;
    if (superName) sig += ` extends ${superName}`;
    if (mixins.length) sig += ` with ${mixins.join(', ')}`;
    if (interfaces.length) sig += ` implements ${interfaces.join(', ')}`;
    return sig;
  }
}
