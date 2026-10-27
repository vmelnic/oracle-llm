const SPECIAL_PROPERTIES = new Set(['table', 'fillable', 'casts', 'hidden', 'guarded', 'connection']);
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match']);

export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const root = tree.rootNode;

  const namespace = extractNamespace(root);
  const useImports = extractUseStatements(root);
  const useMap = buildUseMap(useImports);

  for (const imp of useImports) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: namespace || filePath,
      source_kind: 'file',
      source_path: filePath,
      target_symbol: imp.fqn,
      target_kind: imp.alias ? 'alias' : 'class',
      kind: 'imports',
      metadata: imp.alias ? { alias: imp.alias } : {},
    });
    if (isLocalPhpImport(imp.fqn)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: namespace || filePath,
        source_kind: 'file',
        source_path: filePath,
        target_symbol: imp.fqn,
        target_kind: 'class',
        kind: 'depends_on',
        metadata: {},
      });
    }
  }

  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'class_declaration':
        extractClass(child, namespace, filePath, subprojectId, useMap, nodes, edges);
        break;
      case 'interface_declaration':
        extractInterface(child, namespace, filePath, subprojectId, useMap, nodes, edges);
        break;
      case 'trait_declaration':
        extractTrait(child, namespace, filePath, subprojectId, useMap, nodes, edges);
        break;
      case 'function_definition':
        extractFunction(child, namespace, filePath, subprojectId, useMap, nodes, edges);
        break;
      case 'expression_statement':
        extractTopLevelExpressions(child, namespace, filePath, subprojectId, useMap, nodes, edges);
        break;
    }
  }

  return { nodes, edges };
}

function extractNamespace(root) {
  const nsDef = root.namedChildren.find(n => n.type === 'namespace_definition');
  if (!nsDef) return '';
  const nsName = nsDef.namedChildren.find(n => n.type === 'namespace_name');
  return nsName ? nsName.text : '';
}

function extractUseStatements(root) {
  const imports = [];
  for (const child of root.namedChildren) {
    if (child.type !== 'namespace_use_declaration') continue;

    const group = child.namedChildren.find(n => n.type === 'namespace_use_group');
    if (group) {
      const prefix = child.namedChildren.find(n => n.type === 'namespace_name')?.text ?? '';
      for (const clause of group.namedChildren) {
        if (clause.type !== 'namespace_use_clause') continue;
        const qn = clause.namedChildren.find(n => n.type === 'qualified_name' || n.type === 'name');
        const aliasNode = clause.namedChildren.find(n => n.type === 'name' && n.previousSibling?.type === 'as');
        const shortName = qn?.text ?? '';
        const fqn = prefix ? `${prefix}\\${shortName}` : shortName;
        const alias = aliasNode?.text ?? null;
        imports.push({ fqn, alias, shortName: alias || lastSegment(fqn) });
      }
      continue;
    }

    for (const clause of child.namedChildren) {
      if (clause.type !== 'namespace_use_clause') continue;
      const qn = clause.namedChildren.find(n => n.type === 'qualified_name' || n.type === 'name');
      if (!qn) continue;
      const fqn = qn.text;
      const aliasNode = clause.namedChildren.find(n => n.type === 'name' && n !== qn);
      const hasAs = Array.from(clause.children).some(c => c.type === 'as');
      const alias = hasAs && aliasNode ? aliasNode.text : null;
      imports.push({ fqn, alias, shortName: alias || lastSegment(fqn) });
    }
  }
  return imports;
}

function isLocalPhpImport(fqn) {
  const first = fqn.split('\\')[0];
  return first === 'App' || first === 'src' || first === '' || fqn.startsWith('App\\');
}

function buildUseMap(imports) {
  const map = new Map();
  for (const imp of imports) {
    map.set(imp.shortName, imp.fqn);
  }
  return map;
}

function resolveType(name, useMap, namespace) {
  if (!name) return name;
  const parts = name.split('\\');
  const first = parts[0];
  if (useMap.has(first)) {
    if (parts.length === 1) return useMap.get(first);
    return useMap.get(first) + '\\' + parts.slice(1).join('\\');
  }
  if (name.startsWith('\\')) return name.substring(1);
  if (namespace && !name.includes('\\')) return `${namespace}\\${name}`;
  return name;
}

function lastSegment(fqn) {
  const parts = fqn.split('\\');
  return parts[parts.length - 1];
}

function extractAttributes(node) {
  const attrs = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'attribute_list') continue;
    for (const group of child.namedChildren) {
      if (group.type !== 'attribute_group') continue;
      for (const attr of group.namedChildren) {
        if (attr.type !== 'attribute') continue;
        const nameNode = attr.namedChildren.find(n =>
          n.type === 'name' || n.type === 'qualified_name'
        );
        const argsNode = attr.namedChildren.find(n => n.type === 'arguments');
        const parsed = { name: nameNode?.text ?? '', args: parseArguments(argsNode), raw: attr.text };
        attrs.push(parsed);
      }
    }
  }
  return attrs;
}

function parseArguments(argsNode) {
  if (!argsNode) return [];
  const result = [];
  for (const child of argsNode.namedChildren) {
    if (child.type !== 'argument') continue;
    const nameNode = child.namedChildren.find(n => n.type === 'name');
    const hasColon = Array.from(child.children).some(c => c.type === ':');
    if (hasColon && nameNode) {
      const val = child.namedChildren.find(n => n !== nameNode);
      result.push({ key: nameNode.text, value: extractValue(val) });
    } else {
      result.push({ key: null, value: extractValue(child.namedChildren[0] ?? child) });
    }
  }
  return result;
}

function extractValue(node) {
  if (!node) return null;
  if (node.type === 'string') {
    const content = node.namedChildren.find(n => n.type === 'string_content');
    return content ? content.text : node.text.replace(/^['"]|['"]$/g, '');
  }
  if (node.type === 'integer') return parseInt(node.text, 10);
  if (node.type === 'float') return parseFloat(node.text);
  if (node.type === 'boolean') return node.text.toLowerCase() === 'true';
  if (node.type === 'null') return null;
  if (node.type === 'array_creation_expression') return extractArrayValues(node);
  if (node.type === 'class_constant_access_expression') return node.text;
  return node.text;
}

function extractArrayValues(node) {
  const result = [];
  for (const child of node.namedChildren) {
    if (child.type === 'array_element_initializer') {
      const hasArrow = Array.from(child.children).some(c => c.type === '=>');
      if (hasArrow && child.namedChildren.length >= 2) {
        result.push({ key: extractValue(child.namedChildren[0]), value: extractValue(child.namedChildren[1]) });
      } else {
        result.push(extractValue(child.namedChildren[0]));
      }
    }
  }
  return result;
}

function getDocComment(node) {
  let prev = node.previousNamedSibling;
  if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) {
    return prev.text;
  }
  prev = node.previousSibling;
  if (prev && prev.type === 'comment' && prev.text.startsWith('/**')) {
    return prev.text;
  }
  return null;
}

function extractClass(node, namespace, filePath, subprojectId, useMap, nodes, edges) {
  const nameNode = node.namedChildren.find(n => n.type === 'name');
  if (!nameNode) return;
  const className = nameNode.text;
  const fqcn = namespace ? `${namespace}\\${className}` : className;
  const attrs = extractAttributes(node);
  const doc = getDocComment(node);

  const baseClause = node.namedChildren.find(n => n.type === 'base_clause');
  let parentClass = null;
  if (baseClause) {
    const parentName = baseClause.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name');
    parentClass = parentName ? parentName.text : null;
  }

  const interfaceClause = node.namedChildren.find(n => n.type === 'class_interface_clause');
  const interfaces = [];
  if (interfaceClause) {
    for (const child of interfaceClause.namedChildren) {
      if (child.type === 'name' || child.type === 'qualified_name') {
        interfaces.push(child.text);
      }
    }
  }

  const isFinal = node.namedChildren.some(n => n.type === 'final_modifier');
  const isAbstract = node.namedChildren.some(n => n.type === 'abstract_modifier');

  const resolvedParent = parentClass ? resolveType(parentClass, useMap, namespace) : null;
  const isMigration = resolvedParent?.includes('AbstractMigration') || parentClass === 'AbstractMigration';
  const isEloquentModel = parentClass === 'Model' || resolvedParent?.includes('Eloquent\\Model');
  const isServiceProvider = resolvedParent?.includes('ServiceProvider') || parentClass === 'ServiceProvider' || className.endsWith('Provider');
  const isEventSubscriber = className.endsWith('Listener') || className.endsWith('Subscriber') || resolvedParent?.includes('Listener') || interfaces.some(i => i.includes('EventSubscriberInterface'));

  const isDoctrineEntity = attrs.some(a => attrNameMatches(a.name, 'Entity', 'ORM'));
  const hasApiResource = attrs.some(a => attrNameMatches(a.name, 'ApiResource'));
  const classRouteAttr = attrs.find(a => attrNameMatches(a.name, 'Route'));

  let classRoutePath = '';
  if (classRouteAttr) {
    const pathArg = classRouteAttr.args.find(a => a.key === null || a.key === 'path');
    classRoutePath = typeof pathArg?.value === 'string' ? pathArg.value : '';
  }

  const metadata = {};
  if (isFinal) metadata.final = true;
  if (isAbstract) metadata.abstract = true;
  if (parentClass) metadata.extends = resolvedParent || parentClass;
  // Calls this class does not define are forwarded elsewhere: a `__call`
  // method, or an API resource proxying to the model it wraps.
  const declList0 = node.namedChildren.find(n => n.type === 'declaration_list');
  const definesMagicCall = !!declList0?.namedChildren.some(m => m.type === 'method_declaration' && m.namedChildren.find(n => n.type === 'name')?.text === '__call');
  if (definesMagicCall || /(^|\\)(Json)?Resource(Collection)?$/.test(resolvedParent || '')) metadata.forwards_calls = true;
  if (interfaces.length) metadata.implements = interfaces.map(i => resolveType(i, useMap, namespace));
  if (attrs.length) metadata.attributes = attrs.map(a => a.raw);
  if (isEloquentModel) metadata.eloquent = true;
  if (isDoctrineEntity) metadata.doctrine_entity = true;

  nodes.push({
    subproject_id: subprojectId,
    path: filePath,
    lang: 'php',
    symbol: fqcn,
    kind: 'class',
    parent_symbol: null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: buildClassSignature(className, parentClass, interfaces, isFinal, isAbstract),
    doc,
    metadata,
  });

  if (resolvedParent) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: fqcn,
      source_kind: 'class',
      source_path: filePath,
      target_symbol: resolvedParent,
      target_kind: 'class',
      kind: 'extends',
      metadata: {},
    });
  }

  // `@mixin Foo` (PHPDoc): Foo's methods are callable on this class.
  for (const mixin of (doc || '').matchAll(/@mixin\s+([\\\w]+)/g)) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: fqcn,
      source_kind: 'class',
      source_path: filePath,
      target_symbol: resolveType(mixin[1], useMap, namespace),
      target_kind: 'class',
      kind: 'mixin',
      metadata: {},
    });
  }

  for (const iface of interfaces) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: fqcn,
      source_kind: 'class',
      source_path: filePath,
      target_symbol: resolveType(iface, useMap, namespace),
      target_kind: 'interface',
      kind: 'implements',
      metadata: {},
    });
  }

  if (hasApiResource) {
    const apiPath = classRoutePath || `/${className.replace(/Controller$/, '').toLowerCase()}s`;
    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'php',
      symbol: `API ${fqcn}`,
      kind: 'api_endpoint',
      parent_symbol: fqcn,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `#[ApiResource] ${fqcn}`,
      doc: null,
      metadata: { resource_class: fqcn, path: apiPath },
    });
  }

  if (isDoctrineEntity) {
    const tableName = extractDoctrineTableName(attrs, className);
    const columns = [];
    extractDoctrineColumns(node, columns);
    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'php',
      symbol: tableName,
      kind: 'db_table',
      parent_symbol: fqcn,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `table ${tableName}`,
      doc: null,
      metadata: { source: 'doctrine', entity: fqcn, columns },
    });
  }

  const declList = node.namedChildren.find(n => n.type === 'declaration_list');
  if (!declList) return;

  let eloquentTable = null;
  const eloquentColumns = [];
  const typeCtx = classTypeContext(declList, fqcn, resolvedParent, useMap, namespace);

  for (const member of declList.namedChildren) {
    switch (member.type) {
      case 'method_declaration':
        extractMethod(member, fqcn, classRoutePath, namespace, filePath, subprojectId, useMap, isMigration, isServiceProvider, isEventSubscriber, nodes, edges, typeCtx);
        break;
      case 'property_declaration':
        extractProperty(member, fqcn, namespace, filePath, subprojectId, useMap, isEloquentModel, nodes, edges, eloquentColumns, val => { eloquentTable = val; });
        break;
      case 'use_declaration':
        extractTraitUse(member, fqcn, filePath, subprojectId, useMap, namespace, edges);
        break;
    }
  }

  if (isEloquentModel) {
    const tableName = eloquentTable || classNameToTable(className);
    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'php',
      symbol: tableName,
      kind: 'db_table',
      parent_symbol: fqcn,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `table ${tableName}`,
      doc: null,
      metadata: { source: 'eloquent', model: fqcn, columns: eloquentColumns },
    });
  }

  if (isMigration) {
    extractMigration(node, fqcn, filePath, subprojectId, nodes, edges);
  }
}

function extractInterface(node, namespace, filePath, subprojectId, useMap, nodes, edges) {
  const nameNode = node.namedChildren.find(n => n.type === 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const fqn = namespace ? `${namespace}\\${name}` : name;
  const doc = getDocComment(node);
  const attrs = extractAttributes(node);

  const baseClause = node.namedChildren.find(n => n.type === 'base_clause');
  const parentInterfaces = [];
  if (baseClause) {
    for (const child of baseClause.namedChildren) {
      if (child.type === 'name' || child.type === 'qualified_name') {
        parentInterfaces.push(child.text);
      }
    }
  }

  const metadata = {};
  if (parentInterfaces.length) metadata.extends = parentInterfaces.map(i => resolveType(i, useMap, namespace));
  if (attrs.length) metadata.attributes = attrs.map(a => a.raw);

  nodes.push({
    subproject_id: subprojectId,
    path: filePath,
    lang: 'php',
    symbol: fqn,
    kind: 'interface',
    parent_symbol: null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `interface ${name}` + (parentInterfaces.length ? ` extends ${parentInterfaces.join(', ')}` : ''),
    doc,
    metadata,
  });

  for (const pi of parentInterfaces) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: fqn,
      source_kind: 'interface',
      source_path: filePath,
      target_symbol: resolveType(pi, useMap, namespace),
      target_kind: 'interface',
      kind: 'extends',
      metadata: {},
    });
  }

  const declList = node.namedChildren.find(n => n.type === 'declaration_list');
  if (!declList) return;

  const typeCtx = classTypeContext(declList, fqn, null, useMap, namespace);
  for (const member of declList.namedChildren) {
    if (member.type === 'method_declaration') {
      extractMethod(member, fqn, '', namespace, filePath, subprojectId, useMap, false, false, false, nodes, edges, typeCtx);
    }
  }
}

function extractTrait(node, namespace, filePath, subprojectId, useMap, nodes, edges) {
  const nameNode = node.namedChildren.find(n => n.type === 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const fqn = namespace ? `${namespace}\\${name}` : name;
  const doc = getDocComment(node);
  const attrs = extractAttributes(node);
  const metadata = {};
  if (attrs.length) metadata.attributes = attrs.map(a => a.raw);

  nodes.push({
    subproject_id: subprojectId,
    path: filePath,
    lang: 'php',
    symbol: fqn,
    kind: 'trait',
    parent_symbol: null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `trait ${name}`,
    doc,
    metadata,
  });

  const declList = node.namedChildren.find(n => n.type === 'declaration_list');
  if (!declList) return;

  const typeCtx = classTypeContext(declList, fqn, null, useMap, namespace);
  for (const member of declList.namedChildren) {
    if (member.type === 'method_declaration') {
      extractMethod(member, fqn, '', namespace, filePath, subprojectId, useMap, false, false, false, nodes, edges, typeCtx);
    } else if (member.type === 'use_declaration') {
      extractTraitUse(member, fqn, filePath, subprojectId, useMap, namespace, edges);
    }
  }
}

function extractFunction(node, namespace, filePath, subprojectId, useMap, nodes, edges) {
  const nameNode = node.namedChildren.find(n => n.type === 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const fqn = namespace ? `${namespace}\\${name}` : name;
  const doc = getDocComment(node);
  const params = extractParams(node);
  const returnType = extractReturnType(node);

  nodes.push({
    subproject_id: subprojectId,
    path: filePath,
    lang: 'php',
    symbol: fqn,
    kind: 'function',
    parent_symbol: null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `function ${name}(${params.map(p => p.text).join(', ')})${returnType ? `: ${returnType}` : ''}`,
    doc,
    metadata: classType(returnType, useMap, namespace) ? { return_type: classType(returnType, useMap, namespace) } : {},
  });

  for (const p of params) {
    for (const typeTarget of typeTargets(p.type, useMap, namespace)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: fqn,
        source_kind: 'function',
        source_path: filePath,
        target_symbol: typeTarget,
        target_kind: 'class',
        kind: 'type_references',
        metadata: { context: 'parameter', name: p.name },
      });
    }
  }
  for (const typeTarget of typeTargets(returnType, useMap, namespace)) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: fqn,
      source_kind: 'function',
      source_path: filePath,
      target_symbol: typeTarget,
      target_kind: 'class',
      kind: 'type_references',
      metadata: { context: 'return' },
    });
  }

  const typeCtx = { classSymbol: null, parentClass: null, properties: new Map(), useMap, namespace };
  extractBodyEdges(node, fqn, 'function', filePath, subprojectId, edges, nodes, { ...typeCtx, locals: localTypes(node, params, typeCtx) });
}

function extractMethod(node, parentSymbol, classRoutePath, namespace, filePath, subprojectId, useMap, isMigration, isServiceProvider, isEventSubscriber, nodes, edges, typeCtx) {
  const nameNode = node.namedChildren.find(n => n.type === 'name');
  if (!nameNode) return;
  const name = nameNode.text;
  const symbol = `${parentSymbol}::${name}`;
  const doc = getDocComment(node);
  const attrs = extractAttributes(node);

  const visibility = extractVisibility(node);
  const isStatic = node.namedChildren.some(n => n.type === 'static_modifier');
  const isAbstract = node.namedChildren.some(n => n.type === 'abstract_modifier');
  const params = extractParams(node);
  const returnType = extractReturnType(node);

  const metadata = {};
  if (visibility) metadata.visibility = visibility;
  if (isStatic) metadata.static = true;
  if (isAbstract) metadata.abstract = true;
  if (attrs.length) metadata.attributes = attrs.map(a => a.raw);
  // Class the method returns, resolved, for calls chained on its result.
  const returnClass = /^\??(static|self|\$this)$/.test(returnType || '') ? parentSymbol : classType(returnType, useMap, namespace);
  if (returnClass) metadata.return_type = returnClass;

  const paramTexts = params.map(p => p.text);

  nodes.push({
    subproject_id: subprojectId,
    path: filePath,
    lang: 'php',
    symbol,
    kind: 'method',
    parent_symbol: parentSymbol,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: visibility === 'public',
    signature: `${visibility || ''}${isStatic ? ' static' : ''}${isAbstract ? ' abstract' : ''} function ${name}(${paramTexts.join(', ')})${returnType ? `: ${returnType}` : ''}`.trim(),
    doc,
    metadata,
  });

  const routeAttr = attrs.find(a => attrNameMatches(a.name, 'Route'));
  if (routeAttr) {
    extractRouteFromAttribute(routeAttr, classRoutePath, symbol, parentSymbol, name, filePath, subprojectId, node, nodes, edges);
  }

  for (const p of params) {
    for (const typeTarget of typeTargets(p.type, useMap, namespace)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: symbol,
        source_kind: 'method',
        source_path: filePath,
        target_symbol: typeTarget,
        target_kind: 'class',
        kind: 'type_references',
        metadata: { context: 'parameter', name: p.name },
      });
    }
  }
  for (const typeTarget of typeTargets(returnType, useMap, namespace)) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: symbol,
      source_kind: 'method',
      source_path: filePath,
      target_symbol: typeTarget,
      target_kind: 'class',
      kind: 'type_references',
      metadata: { context: 'return' },
    });
  }

  if (isServiceProvider && (name === 'register' || name === 'boot')) {
    const body = node.namedChildren.find(n => n.type === 'compound_statement');
    if (body) {
      const text = body.text;
      const patterns = [
        /\$this->app->bind\s*\(\s*([^,)]+)/g,
        /\$this->app->singleton\s*\(\s*([^,)]+)/g,
        /\$this->app->register\s*\(\s*([^,)]+)/g,
      ];
      for (const regex of patterns) {
        let match;
        while ((match = regex.exec(text)) !== null) {
          const serviceName = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/::class$/, '');
          if (serviceName && !serviceName.startsWith('$')) {
            edges.push({
              subproject_id: subprojectId,
              source_symbol: parentSymbol,
              source_kind: 'class',
              source_path: filePath,
              target_symbol: resolveType(serviceName, useMap, namespace),
              target_kind: 'class',
              kind: 'provides',
              metadata: { method: name },
            });
          }
        }
      }
    }
  }

  const providedType = name.startsWith('provide') ? classType(returnType, useMap, namespace) : null;
  if (providedType) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: parentSymbol,
      source_kind: 'class',
      source_path: filePath,
      target_symbol: providedType,
      target_kind: 'class',
      kind: 'provides',
      metadata: { method: name },
    });
  }

  const handledEvent = isEventSubscriber && name === 'handle' ? classType(params[0]?.type, useMap, namespace) : null;
  if (handledEvent) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: symbol,
      source_kind: 'method',
      source_path: filePath,
      target_symbol: handledEvent,
      target_kind: 'event',
      kind: 'consumes_event',
      metadata: {},
    });
  }

  if (name.startsWith('onKernel') || name.startsWith('onSecurity') || name.startsWith('onForm')) {
    const eventParam = params.find(p => classType(p.type, useMap, namespace));
    if (eventParam) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: symbol,
        source_kind: 'method',
        source_path: filePath,
        target_symbol: classType(eventParam.type, useMap, namespace),
        target_kind: 'event',
        kind: 'consumes_event',
        metadata: {},
      });
    } else {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: symbol,
        source_kind: 'method',
        source_path: filePath,
        target_symbol: name.replace(/^on/, ''),
        target_kind: 'event',
        kind: 'consumes_event',
        metadata: {},
      });
    }
  }

  extractConstructorInjections(name, params, parentSymbol, filePath, subprojectId, useMap, namespace, edges);
  extractBodyEdges(node, symbol, 'method', filePath, subprojectId, edges, nodes, { ...typeCtx, locals: localTypes(node, params, typeCtx) });
}

function extractProperty(node, parentSymbol, namespace, filePath, subprojectId, useMap, isEloquentModel, nodes, edges, eloquentColumns, setTable) {
  const attrs = extractAttributes(node);
  const visibility = extractVisibility(node);
  const isStatic = node.namedChildren.some(n => n.type === 'static_modifier');
  const isReadonly = node.namedChildren.some(n => n.type === 'readonly_modifier');
  const doc = getDocComment(node);

  const typeNode = node.namedChildren.find(n =>
    n.type === 'named_type' || n.type === 'primitive_type' ||
    n.type === 'optional_type' || n.type === 'union_type' ||
    n.type === 'intersection_type'
  );
  const typeStr = typeNode?.text ?? null;

  for (const child of node.namedChildren) {
    if (child.type !== 'property_element') continue;
    const varNode = child.namedChildren.find(n => n.type === 'variable_name');
    if (!varNode) continue;
    const propName = varNode.text;
    const cleanName = propName.replace(/^\$/, '');
    const symbol = `${parentSymbol}::$${cleanName}`;

    const metadata = {};
    if (visibility) metadata.visibility = visibility;
    if (isStatic) metadata.static = true;
    if (isReadonly) metadata.readonly = true;
    if (typeStr) metadata.type = typeStr;
    if (attrs.length) metadata.attributes = attrs.map(a => a.raw);

    const defaultValueNode = child.namedChildren.find(n =>
      n.type !== 'variable_name'
    );

    if (isEloquentModel && SPECIAL_PROPERTIES.has(cleanName) && defaultValueNode) {
      const val = extractValue(defaultValueNode);
      if (cleanName === 'table' && typeof val === 'string') {
        setTable(val);
        metadata.table_name = val;
      } else if (Array.isArray(val)) {
        metadata[cleanName] = val;
        if (cleanName === 'fillable' || cleanName === 'guarded') {
          for (const col of val) {
            if (typeof col === 'string') eloquentColumns.push(col);
          }
        } else if (cleanName === 'casts') {
          for (const entry of val) {
            if (entry && typeof entry === 'object' && entry.key) {
              eloquentColumns.push(typeof entry.key === 'string' ? entry.key : String(entry.key));
            }
          }
        }
      }
    }

    const isDoctrineColumn = attrs.some(a => attrNameMatches(a.name, 'Column', 'ORM'));
    if (isDoctrineColumn) metadata.doctrine_column = true;

    for (const typeTarget of typeTargets(typeStr, useMap, namespace)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: symbol,
        source_kind: 'property',
        source_path: filePath,
        target_symbol: typeTarget,
        target_kind: 'class',
        kind: 'type_references',
        metadata: {},
      });
    }

    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'php',
      symbol,
      kind: 'property',
      parent_symbol: parentSymbol,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: visibility === 'public',
      signature: `${visibility || ''} ${typeStr || ''}${typeStr ? ' ' : ''}$${cleanName}`.trim(),
      doc,
      metadata,
    });
  }
}

function extractTraitUse(node, parentSymbol, filePath, subprojectId, useMap, namespace, edges) {
  for (const child of node.namedChildren) {
    if (child.type === 'name' || child.type === 'qualified_name') {
      const resolved = resolveType(child.text, useMap, namespace);
      edges.push({
        subproject_id: subprojectId,
        source_symbol: parentSymbol,
        source_kind: 'class',
        source_path: filePath,
        target_symbol: resolved,
        target_kind: 'trait',
        kind: 'uses_trait',
        metadata: {},
      });
      edges.push({
        subproject_id: subprojectId,
        source_symbol: parentSymbol,
        source_kind: 'class',
        source_path: filePath,
        target_symbol: resolved,
        target_kind: 'trait',
        kind: 'type_references',
        metadata: {},
      });
    }
    if (child.type === 'use_list') {
      for (const item of child.namedChildren) {
        if (item.type === 'name' || item.type === 'qualified_name') {
          const resolved = resolveType(item.text, useMap, namespace);
          edges.push({
            subproject_id: subprojectId,
            source_symbol: parentSymbol,
            source_kind: 'class',
            source_path: filePath,
            target_symbol: resolved,
            target_kind: 'trait',
            kind: 'uses_trait',
            metadata: {},
          });
          edges.push({
            subproject_id: subprojectId,
            source_symbol: parentSymbol,
            source_kind: 'class',
            source_path: filePath,
            target_symbol: resolved,
            target_kind: 'trait',
            kind: 'type_references',
            metadata: {},
          });
        }
      }
    }
  }
}

function extractRouteFromAttribute(routeAttr, classRoutePath, methodSymbol, classSymbol, methodName, filePath, subprojectId, node, nodes, _edges) {
  const pathArg = routeAttr.args.find(a => a.key === null || a.key === 'path');
  const methodsArg = routeAttr.args.find(a => a.key === 'methods');
  const nameArg = routeAttr.args.find(a => a.key === 'name');

  const routePath = classRoutePath + (typeof pathArg?.value === 'string' ? pathArg.value : '');
  const methods = Array.isArray(methodsArg?.value) ? methodsArg.value.filter(v => typeof v === 'string') : [];
  const routeName = typeof nameArg?.value === 'string' ? nameArg.value : null;

  const isApiRoute = routePath.startsWith('/api') || routePath.startsWith('api');

  if (methods.length === 0) methods.push('ANY');

  for (const method of methods) {
    const symbol = `${method.toUpperCase()} ${routePath}`;
    const metadata = {
      method: method.toUpperCase(),
      path: routePath,
      controller: classSymbol,
      action: methodName,
    };
    if (routeName) metadata.name = routeName;

    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'php',
      symbol,
      kind: 'route',
      parent_symbol: methodSymbol,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `${method.toUpperCase()} ${routePath}`,
      doc: null,
      metadata,
    });

    if (isApiRoute) {
      nodes.push({
        subproject_id: subprojectId,
        path: filePath,
        lang: 'php',
        symbol: `API ${symbol}`,
        kind: 'api_endpoint',
        parent_symbol: methodSymbol,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: true,
        signature: `API ${method.toUpperCase()} ${routePath}`,
        doc: null,
        metadata,
      });
    }
  }
}

function extractConstructorInjections(methodName, params, parentSymbol, filePath, subprojectId, useMap, namespace, edges) {
  if (methodName !== '__construct') return;

  for (const p of params) {
    for (const resolved of typeTargets(p.type, useMap, namespace)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: parentSymbol,
        source_kind: 'class',
        source_path: filePath,
        target_symbol: resolved,
        target_kind: 'class',
        kind: 'injects',
        metadata: { parameter: p.name },
      });
    }
  }
}

function extractBodyEdges(node, sourceSymbol, sourceKind, filePath, subprojectId, edges, nodes, typeCtx) {
  const body = node.namedChildren.find(n => n.type === 'compound_statement');
  if (!body) return;

  walkNode(body, (child) => {
    if (child.type === 'object_creation_expression') {
      const nameNode = child.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name');
      if (nameNode) {
        edges.push({
          subproject_id: subprojectId,
          source_symbol: sourceSymbol,
          source_kind: sourceKind,
          source_path: filePath,
          target_symbol: typeCtx ? resolveType(nameNode.text, typeCtx.useMap, typeCtx.namespace) : nameNode.text,
          target_kind: 'class',
          kind: 'calls',
          metadata: { type: 'instantiation', line: child.startPosition.row + 1 },
        });
      }
    }

    if (child.type === 'member_call_expression' || child.type === 'nullsafe_member_call_expression') {
      const obj = child.childForFieldName('object');
      const methodNode = child.childForFieldName('name');
      if (obj && methodNode?.type === 'name') {
        const objText = obj.text;
        const isThis = objText === '$this';
        const receiverType = expressionType(obj, typeCtx);
        edges.push(callEdge(subprojectId, sourceSymbol, sourceKind, filePath, methodNode, {
          receiver: objText,
          receiverType,
          self: isThis,
        }));

        const methodName = methodNode.text;
        if (methodName === 'render' && (isThis || objText.endsWith('twig'))) {
          const template = extractFirstStringArg(child);
          if (template) {
            edges.push({
              subproject_id: subprojectId,
              source_symbol: sourceSymbol,
              source_kind: sourceKind,
              source_path: filePath,
              target_symbol: template,
              target_kind: 'template',
              kind: 'renders',
              metadata: {},
            });
          }
        }

        if (methodName === 'on' || (methodName === 'addListener' && objText === '$dispatcher')) {
          const argsNode = child.namedChildren.find(n => n.type === 'arguments');
          const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
          const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
          const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
          const eventName = content?.text ?? firstArg?.text;
          if (eventName) {
            edges.push({
              subproject_id: subprojectId,
              source_symbol: sourceSymbol,
              source_kind: sourceKind,
              source_path: filePath,
              target_symbol: eventName.replace(/^['"]|['"]$/g, ''),
              target_kind: 'event',
              kind: 'consumes_event',
              metadata: {},
            });
          }
        }

        const queryMethods = ['createQuery', 'createQueryBuilder', 'select', 'where', 'join', 'query', 'table', 'raw'];
        const isQueryBuilderCall = child.text.includes('QueryBuilder') || child.text.includes('createQueryBuilder');
        const isDbContext = objText === '$qb' || objText === '$em' || objText === '$query' || objText === '$builder' || objText === 'DB' || objText.endsWith('QueryBuilder');
        if (queryMethods.includes(methodName) && (isQueryBuilderCall || isDbContext || methodName === 'createQuery' || methodName === 'createQueryBuilder')) {
          let tableName = 'database';
          if (methodName === 'table') {
            const t = extractFirstStringArg(child);
            if (t) tableName = t;
          } else {
            const text = child.text;
            const fromMatch = text.match(/from\s+['"](\w+)['"]/i);
            if (fromMatch) tableName = fromMatch[1];
          }
          edges.push({
            subproject_id: subprojectId,
            source_symbol: sourceSymbol,
            source_kind: sourceKind,
            source_path: filePath,
            target_symbol: tableName,
            target_kind: 'db_table',
            kind: 'queries',
            metadata: {},
          });
        }
      }
    }

    if (child.type === 'scoped_call_expression') {
      const scopeNode = child.childForFieldName('scope');
      const methodNode = child.childForFieldName('name');
      if (scopeNode && methodNode?.type === 'name') {
        const scopeText = scopeNode.text;
        const relative = scopeNode.type === 'relative_scope';
        const named = scopeNode.type === 'name' || scopeNode.type === 'qualified_name';
        let receiverType;
        if (relative) receiverType = scopeText === 'parent' ? typeCtx?.parentClass : typeCtx?.classSymbol;
        else if (named) receiverType = resolveType(scopeText, typeCtx?.useMap ?? new Map(), typeCtx?.namespace);
        else receiverType = expressionType(scopeNode, typeCtx);
        edges.push(callEdge(subprojectId, sourceSymbol, sourceKind, filePath, methodNode, {
          receiver: scopeText,
          receiverType,
          self: relative && scopeText !== 'parent',
        }));
      }
      if ((scopeNode?.type === 'name' || scopeNode?.type === 'qualified_name') && methodNode) {
        const cls = scopeNode.text;
        const methodName = methodNode.text;
        if (cls === 'Event' && methodName === 'listen') {
          const argsNode = child.namedChildren.find(n => n.type === 'arguments');
          const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
          const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
          const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
          const eventName = content?.text ?? firstArg?.text;
          if (eventName) {
            edges.push({
              subproject_id: subprojectId,
              source_symbol: sourceSymbol,
              source_kind: sourceKind,
              source_path: filePath,
              target_symbol: eventName.replace(/^['"]|['"]$/g, ''),
              target_kind: 'event',
              kind: 'consumes_event',
              metadata: {},
            });
          }
        }

        if (cls === 'DB' && (methodName === 'table' || methodName === 'raw')) {
          let tableName = 'database';
          if (methodName === 'table') {
            const t = extractFirstStringArg(child);
            if (t) tableName = t;
          }
          edges.push({
            subproject_id: subprojectId,
            source_symbol: sourceSymbol,
            source_kind: sourceKind,
            source_path: filePath,
            target_symbol: tableName,
            target_kind: 'db_table',
            kind: 'queries',
            metadata: {},
          });
        }

        if (methodName === 'query') {
          edges.push({
            subproject_id: subprojectId,
            source_symbol: sourceSymbol,
            source_kind: sourceKind,
            source_path: filePath,
            target_symbol: 'database',
            target_kind: 'db_table',
            kind: 'queries',
            metadata: {},
          });
        }
      }
    }

    if (child.type === 'function_call_expression') {
      const fnName = child.namedChildren.find(n => n.type === 'name');
      const argsNode = child.namedChildren.find(n => n.type === 'arguments');
      if (fnName) {
        const name = fnName.text;
        if (name === 'env' || name === 'getenv') {
          const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
          const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
          const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
          if (content) {
            nodes.push({
              subproject_id: subprojectId,
              path: filePath,
              lang: 'php',
              symbol: content.text,
              kind: 'env_var',
              parent_symbol: null,
              start_line: child.startPosition.row + 1,
              end_line: child.endPosition.row + 1,
              exported: true,
              signature: `${name}('${content.text}')`,
              doc: null,
              metadata: { function: name },
            });
            edges.push({
              subproject_id: subprojectId,
              source_symbol: sourceSymbol,
              source_kind: sourceKind,
              source_path: filePath,
              target_symbol: content.text,
              target_kind: 'env_var',
              kind: 'reads_config',
              metadata: { function: name },
            });
          }
        }

        if (name === 'event' || name === 'dispatch') {
          const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
          const newExpr = firstArg?.namedChildren?.find(n => n.type === 'object_creation_expression');
          if (newExpr) {
            const eventName = newExpr.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name');
            if (eventName) {
              edges.push({
                subproject_id: subprojectId,
                source_symbol: sourceSymbol,
                source_kind: sourceKind,
                source_path: filePath,
                target_symbol: eventName.text,
                target_kind: 'event',
                kind: 'fires_event',
                metadata: {},
              });
            }
          }
        }

        if (name === 'view' || name === 'blade') {
          const template = extractFirstStringArg(child);
          if (template) {
            edges.push({
              subproject_id: subprojectId,
              source_symbol: sourceSymbol,
              source_kind: sourceKind,
              source_path: filePath,
              target_symbol: template,
              target_kind: 'template',
              kind: 'renders',
              metadata: {},
            });
          }
        }

        if (name === 'createQueryBuilder') {
          edges.push({
            subproject_id: subprojectId,
            source_symbol: sourceSymbol,
            source_kind: sourceKind,
            source_path: filePath,
            target_symbol: 'database',
            target_kind: 'db_table',
            kind: 'queries',
            metadata: {},
          });
        }
      }
    }

    if (child.type === 'subscript_expression') {
      const varNode = child.namedChildren.find(n => n.type === 'variable_name');
      if (varNode?.text === '$_ENV') {
        const keyNode = child.namedChildren.find(n => n.type === 'string');
        const content = keyNode?.namedChildren?.find(n => n.type === 'string_content');
        if (content) {
          edges.push({
            subproject_id: subprojectId,
            source_symbol: sourceSymbol,
            source_kind: sourceKind,
            source_path: filePath,
            target_symbol: content.text,
            target_kind: 'config_key',
            kind: 'reads_config',
            metadata: { function: '$_ENV' },
          });
        }
      }
    }
  });
}

function extractMigration(classNode, fqcn, filePath, subprojectId, nodes, edges) {
  const tables = new Set();
  const operations = [];

  walkNode(classNode, (node) => {
    if (node.type === 'member_call_expression') {
      const method = findMethodName(node);
      if (!method) return;

      if (method === 'addSql') {
        const argsNode = node.namedChildren.find(n => n.type === 'arguments');
        const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
        const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
        const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
        if (content) {
          const sql = content.text;
          const tableOps = parseSqlForTables(sql);
          for (const op of tableOps) {
            tables.add(op.table);
            operations.push(op);
          }
        }
      }

      const schemaOps = ['createTable', 'dropTable', 'renameTable', 'addColumn', 'dropColumn', 'changeColumn'];
      if (schemaOps.includes(method)) {
        const argsNode = node.namedChildren.find(n => n.type === 'arguments');
        const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
        const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
        const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
        if (content) {
          tables.add(content.text);
          operations.push({ operation: method, table: content.text });
        }
      }
    }

    if (node.type === 'scoped_call_expression') {
      const allNames = node.namedChildren.filter(n => n.type === 'name');
      const cls = allNames[0]?.text;
      const method = allNames[1]?.text;
      if (cls === 'Schema' && (method === 'create' || method === 'drop' || method === 'table' || method === 'dropIfExists')) {
        const argsNode = node.namedChildren.find(n => n.type === 'arguments');
        const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
        const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
        const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
        if (content) {
          tables.add(content.text);
          operations.push({ operation: method, table: content.text });
        }
      }
    }
  });

  if (tables.size > 0 || operations.length > 0) {
    nodes.push({
      subproject_id: subprojectId,
      path: filePath,
      lang: 'php',
      symbol: fqcn,
      kind: 'migration',
      parent_symbol: null,
      start_line: classNode.startPosition.row + 1,
      end_line: classNode.endPosition.row + 1,
      exported: true,
      signature: `migration ${lastSegment(fqcn)}`,
      doc: null,
      metadata: { tables: [...tables], operations },
    });

    for (const table of tables) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: fqcn,
        source_kind: 'migration',
        source_path: filePath,
        target_symbol: table,
        target_kind: 'db_table',
        kind: 'migrates_table',
        metadata: { operations: operations.filter(o => o.table === table) },
      });
    }
  }
}

function extractTopLevelExpressions(node, namespace, filePath, subprojectId, useMap, nodes, edges) {
  walkNode(node, (child) => {
    if (child.type === 'scoped_call_expression') {
      const allNames = child.namedChildren.filter(n => n.type === 'name');
      if (allNames.length < 2) return;
      const cls = allNames[0].text;
      const method = allNames[1].text;

      if (cls === 'Route' && ROUTE_METHODS.has(method)) {
        extractLaravelRoute(child, method, filePath, subprojectId, useMap, namespace, nodes, edges);
      }
      if (cls === 'Route' && (method === 'resource' || method === 'apiResource')) {
        extractLaravelResource(child, method, filePath, subprojectId, useMap, namespace, nodes, edges);
      }

      if ((cls === 'Event' && method === 'dispatch') || (method === 'dispatch')) {
        const argsNode = child.namedChildren.find(n => n.type === 'arguments');
        const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
        const newExpr = firstArg?.namedChildren?.find(n => n.type === 'object_creation_expression');
        if (newExpr) {
          const eventName = newExpr.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name');
          if (eventName) {
            nodes.push({
              subproject_id: subprojectId,
              path: filePath,
              lang: 'php',
              symbol: eventName.text,
              kind: 'event',
              parent_symbol: null,
              start_line: child.startPosition.row + 1,
              end_line: child.endPosition.row + 1,
              exported: true,
              signature: `event ${eventName.text}`,
              doc: null,
              metadata: {},
            });
          }
        }
      }
    }

    if (child.type === 'function_call_expression') {
      const fnName = child.namedChildren.find(n => n.type === 'name');
      const argsNode = child.namedChildren.find(n => n.type === 'arguments');
      if (fnName && (fnName.text === 'env' || fnName.text === 'getenv')) {
        const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
        const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
        const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
        if (content) {
          nodes.push({
            subproject_id: subprojectId,
            path: filePath,
            lang: 'php',
            symbol: content.text,
            kind: 'config_key',
            parent_symbol: null,
            start_line: child.startPosition.row + 1,
            end_line: child.endPosition.row + 1,
            exported: true,
            signature: `config ${content.text}`,
            doc: null,
            metadata: { function: fnName.text },
          });
        }
      }

      if (fnName?.text === 'event') {
        const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
        const newExpr = firstArg?.namedChildren?.find(n => n.type === 'object_creation_expression');
        if (newExpr) {
          const eventName = newExpr.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name');
          if (eventName) {
            nodes.push({
              subproject_id: subprojectId,
              path: filePath,
              lang: 'php',
              symbol: eventName.text,
              kind: 'event',
              parent_symbol: null,
              start_line: child.startPosition.row + 1,
              end_line: child.endPosition.row + 1,
              exported: true,
              signature: `event ${eventName.text}`,
              doc: null,
              metadata: {},
            });
          }
        }
      }
    }

    if (child.type === 'subscript_expression') {
      const varNode = child.namedChildren.find(n => n.type === 'variable_name');
      if (varNode?.text === '$_ENV') {
        const keyNode = child.namedChildren.find(n => n.type === 'string');
        const content = keyNode?.namedChildren?.find(n => n.type === 'string_content');
        if (content) {
          nodes.push({
            subproject_id: subprojectId,
            path: filePath,
            lang: 'php',
            symbol: content.text,
            kind: 'config_key',
            parent_symbol: null,
            start_line: child.startPosition.row + 1,
            end_line: child.endPosition.row + 1,
            exported: true,
            signature: `config ${content.text}`,
            doc: null,
            metadata: { function: '$_ENV' },
          });
        }
      }
    }
  });
}

const ROUTE_FUNCTION_TYPES = new Set(['anonymous_function', 'anonymous_function_creation_expression', 'arrow_function']);

/**
 * What enclosing route groups and the route's own chain add to a Laravel
 * route: `Route::prefix('user')->middleware([...])->group(fn)`,
 * `Route::group(['prefix' => .., 'middleware' => ..], fn)` and
 * `Route::get(..)->middleware(..)->name(..)`. Outer groups come first.
 */
function laravelRouteContext(node, useMap, namespace) {
  const prefixes = [];
  const middleware = [];
  const names = [];
  const apply = (calls) => {
    for (const { method, args } of calls) {
      if (method === 'prefix') prefixes.push(phpStringValue(args[0]) ?? '');
      else if (method === 'middleware') middleware.push(...args.flatMap(a => middlewareValues(a, useMap, namespace)));
      else if (method === 'withoutMiddleware') {
        const removed = new Set(args.flatMap(a => middlewareValues(a, useMap, namespace)));
        for (let i = middleware.length - 1; i >= 0; i--) if (removed.has(middleware[i])) middleware.splice(i, 1);
      }
      else if (method === 'name' || method === 'as') names.push(phpStringValue(args[0]) ?? '');
    }
  };

  const groups = [];
  for (let n = node.parent; n; n = n.parent) {
    if (!ROUTE_FUNCTION_TYPES.has(n.type) || n.parent?.type !== 'argument') continue;
    const call = n.parent.parent?.parent;
    if (!call) continue;
    if (call.type === 'member_call_expression' && callName(call) === 'group') {
      groups.unshift(chainCalls(call.namedChildren[0]));
    } else if (call.type === 'scoped_call_expression' && callName(call) === 'group') {
      const options = callArgs(call)[0]?.namedChildren.find(c => c.type === 'array_creation_expression');
      const calls = [];
      for (const el of options?.namedChildren.filter(c => c.type === 'array_element_initializer') || []) {
        const [key, value] = el.namedChildren;
        const k = key && phpStringValue(key);
        if (k && value) calls.push({ method: k, args: [value] });
      }
      groups.unshift(calls);
    }
  }
  for (const calls of groups) apply(calls);

  // The route's own chain: Route::get(...)->middleware(...)->name(...).
  const own = [];
  for (let cur = node; cur.parent?.type === 'member_call_expression' && sameNode(cur.parent.namedChildren[0], cur); cur = cur.parent) {
    own.push({ method: callName(cur.parent), args: callArgs(cur.parent) });
  }
  const groupNames = names.length;
  const groupName = names.join('');
  apply(own);

  // Group `as` prefixes only make a name together with the route's own name.
  const name = names.length > groupNames ? names.join('') : '';
  return { prefixes, middleware: [...new Set(middleware.filter(Boolean))], name, groupName, own };
}

// Calls of a chain, innermost (Route::prefix) first.
function chainCalls(expr) {
  const calls = [];
  for (let cur = expr; cur; cur = cur.namedChildren[0]) {
    if (cur.type === 'member_call_expression') calls.unshift({ method: callName(cur), args: callArgs(cur) });
    else if (cur.type === 'scoped_call_expression') {
      calls.unshift({ method: callName(cur), args: callArgs(cur) });
      break;
    } else break;
  }
  return calls;
}

function callName(call) {
  const names = call.namedChildren.filter(c => c.type === 'name');
  return names[names.length - 1]?.text ?? null;
}

function callArgs(call) {
  return call.namedChildren.find(c => c.type === 'arguments')?.namedChildren.filter(c => c.type === 'argument') ?? [];
}

function sameNode(a, b) {
  return a && b && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

// Literal text of a string argument/expression; null when it is not a literal.
function phpStringValue(node) {
  if (!node) return null;
  const str = node.type === 'string' || node.type === 'encapsed_string' ? node : node.namedChildren?.find(c => c.type === 'string' || c.type === 'encapsed_string');
  if (!str) return null;
  return str.namedChildren.filter(c => c.type === 'string_content' || c.type === 'string_value').map(c => c.text).join('');
}

// 'auth:sanctum', CheckUserStatus::class, ['a', 'b'], 'role:' . Role::ADMIN -> names.
function middlewareValues(node, useMap, namespace) {
  if (!node) return [];
  const value = node.type === 'argument' ? node.namedChildren[0] : node;
  if (!value) return [];
  if (value.type === 'array_creation_expression') {
    return value.namedChildren.filter(c => c.type === 'array_element_initializer').flatMap(el => middlewareValues(el.namedChildren[el.namedChildren.length - 1], useMap, namespace));
  }
  if (value.type === 'class_constant_access_expression') {
    const cls = value.namedChildren.find(c => c.type === 'name' || c.type === 'qualified_name');
    return cls ? [resolveType(cls.text, useMap, namespace).split('\\').pop()] : [];
  }
  if (value.type === 'binary_expression') {
    const literal = phpStringValue(value.namedChildren[0]);
    return literal ? [literal.replace(/[:,]$/, '')] : [];
  }
  const literal = phpStringValue(value);
  return literal ? [literal] : [];
}

function joinRoutePath(parts) {
  const segments = parts.flatMap(p => String(p).split('/')).filter(Boolean);
  return `/${segments.join('/')}`;
}

function extractLaravelRoute(node, method, filePath, subprojectId, useMap, namespace, nodes, edges) {
  const argsNode = node.namedChildren.find(n => n.type === 'arguments');
  if (!argsNode) return;

  let args = argsNode.namedChildren.filter(n => n.type === 'argument');
  // Route::match(['get', 'post'], 'path', ...): the verbs come first.
  let verbs = method.toUpperCase();
  if (method === 'match') {
    const list = middlewareValues(args[0], useMap, namespace).map(v => v.toUpperCase());
    if (list.length > 0) verbs = list.join('|');
    args = args.slice(1);
  }
  if (args.length < 1) return;

  const group = laravelRouteContext(node, useMap, namespace);
  const ownPath = phpStringValue(args[0]) ?? '';
  const routePath = joinRoutePath([...group.prefixes, ownPath]);

  let controller = null;
  let action = null;

  if (args.length >= 2) {
    const handler = args[1].namedChildren[0];
    if (handler?.type === 'array_creation_expression') {
      const elements = handler.namedChildren.filter(n => n.type === 'array_element_initializer');
      if (elements.length >= 2) {
        controller = classConstantName(elements[0].namedChildren.find(n => n.type === 'class_constant_access_expression'));
        action = phpStringValue(elements[1]) || null;
      }
    } else if (handler?.type === 'class_constant_access_expression') {
      // Invokable controller: Route::get('/x', ShowReport::class).
      controller = classConstantName(handler);
      action = controller ? '__invoke' : null;
    }
  }

  pushLaravelRoute({ node, filePath, subprojectId, useMap, namespace, nodes, edges, verbs, routePath, controller, action, middleware: group.middleware, name: group.name });
}

// Route::resource / apiResource: the conventional actions, minus ->only()/->except().
const RESOURCE_ACTIONS = [
  ['index', 'GET', ''],
  ['create', 'GET', '/create'],
  ['store', 'POST', ''],
  ['show', 'GET', '/{param}'],
  ['edit', 'GET', '/{param}/edit'],
  ['update', 'PUT|PATCH', '/{param}'],
  ['destroy', 'DELETE', '/{param}'],
];

function extractLaravelResource(node, method, filePath, subprojectId, useMap, namespace, nodes, edges) {
  const args = callArgs(node);
  const resource = phpStringValue(args[0]);
  if (!resource) return;
  const controller = classConstantName(args[1]?.namedChildren.find(n => n.type === 'class_constant_access_expression'));
  const group = laravelRouteContext(node, useMap, namespace);

  let actions = RESOURCE_ACTIONS.filter(([a]) => method !== 'apiResource' || (a !== 'create' && a !== 'edit'));
  for (const { method: m, args: a } of group.own) {
    const listed = new Set(a.flatMap(arg => middlewareValues(arg, useMap, namespace)));
    if (m === 'only') actions = actions.filter(([name]) => listed.has(name));
    if (m === 'except') actions = actions.filter(([name]) => !listed.has(name));
  }

  // `photos.comments` -> /photos/{photo}/comments/{comment}
  const parts = resource.split('.');
  const param = (segment) => singularize(segment).replace(/-/g, '_');
  const base = parts.map((seg, i) => (i < parts.length - 1 ? `${seg}/{${param(seg)}}` : seg)).join('/');
  const leaf = param(parts[parts.length - 1]);
  for (const [action, verbs, suffix] of actions) {
    pushLaravelRoute({
      node, filePath, subprojectId, useMap, namespace, nodes, edges, verbs,
      routePath: joinRoutePath([...group.prefixes, base + suffix.replace('{param}', `{${leaf}}`)]),
      controller, action,
      middleware: group.middleware,
      name: `${group.groupName}${resource}.${action}`,
    });
  }
}

function singularize(word) {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(xes|ches|shes|sses)$/.test(word)) return word.slice(0, -2);
  return word.replace(/s$/, '');
}

function classConstantName(node) {
  if (!node) return null;
  return node.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name')?.text ?? null;
}

// One route node (plus its api_endpoint twin) and the edge from the
// controller action that serves it, as the other extractors record it.
function pushLaravelRoute({ node, filePath, subprojectId, useMap, namespace, nodes, edges, verbs, routePath, controller, action, middleware, name }) {
  const symbol = `${verbs} ${routePath}`;
  const metadata = { method: verbs, path: routePath };
  const controllerFqn = controller ? resolveType(controller, useMap, namespace) : null;
  if (controllerFqn) metadata.controller = controllerFqn;
  if (action) metadata.action = action;
  if (middleware.length > 0) metadata.middleware = middleware;
  if (name) metadata.name = name;

  const base = {
    subproject_id: subprojectId,
    path: filePath,
    lang: 'php',
    parent_symbol: null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    doc: null,
    metadata,
  };
  nodes.push({ ...base, symbol, kind: 'route', signature: symbol });
  if (routePath.startsWith('/api')) {
    nodes.push({ ...base, symbol: `API ${symbol}`, kind: 'api_endpoint', signature: `API ${symbol}` });
  }
  if (controllerFqn && action) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: `${controllerFqn}::${action}`,
      source_kind: 'method',
      source_path: filePath,
      target_symbol: symbol,
      target_kind: 'route',
      kind: 'serves_route',
      metadata: { line: node.startPosition.row + 1 },
    });
  }
}

function extractDoctrineTableName(attrs, className) {
  const tableAttr = attrs.find(a => attrNameMatches(a.name, 'Table', 'ORM'));
  if (tableAttr) {
    const nameArg = tableAttr.args.find(a => a.key === 'name');
    if (nameArg && typeof nameArg.value === 'string') return nameArg.value;
  }
  return classNameToTable(className);
}

function extractDoctrineColumns(classNode, columns) {
  const declList = classNode.namedChildren.find(n => n.type === 'declaration_list');
  if (!declList) return;

  for (const member of declList.namedChildren) {
    if (member.type !== 'property_declaration') continue;
    const attrs = extractAttributes(member);
    const isColumn = attrs.some(a => attrNameMatches(a.name, 'Column', 'ORM'));
    if (!isColumn) continue;

    for (const child of member.namedChildren) {
      if (child.type !== 'property_element') continue;
      const varNode = child.namedChildren.find(n => n.type === 'variable_name');
      if (varNode) {
        const colAttr = attrs.find(a => attrNameMatches(a.name, 'Column', 'ORM'));
        const typeArg = colAttr?.args?.find(a => a.key === 'type');
        const lengthArg = colAttr?.args?.find(a => a.key === 'length');
        const col = { name: varNode.text.replace(/^\$/, '') };
        if (typeArg) col.type = typeArg.value;
        if (lengthArg) col.length = lengthArg.value;
        columns.push(col);
      }
    }
  }
}

function extractParams(node) {
  const params = [];
  const formalParams = node.namedChildren.find(n => n.type === 'formal_parameters');
  if (!formalParams) return params;

  for (const param of formalParams.namedChildren) {
    if (param.type !== 'simple_parameter' && param.type !== 'variadic_parameter' && param.type !== 'property_promotion_parameter') continue;

    const varNode = param.namedChildren.find(n => n.type === 'variable_name');
    const typeNode = param.namedChildren.find(n =>
      n.type === 'named_type' || n.type === 'primitive_type' ||
      n.type === 'optional_type' || n.type === 'union_type' ||
      n.type === 'intersection_type'
    );

    const name = varNode?.text?.replace(/^\$/, '') ?? '';
    const type = typeNode?.text ?? null;
    const isVariadic = param.type === 'variadic_parameter';
    const isPromoted = param.type === 'property_promotion_parameter';
    const visibility = isPromoted ? extractVisibility(param) : null;
    const isReadonly = isPromoted ? param.namedChildren.some(n => n.type === 'readonly_modifier') : false;

    let text = '';
    if (visibility) text += `${visibility} `;
    if (isReadonly) text += 'readonly ';
    if (type) text += `${type} `;
    if (isVariadic) text += '...';
    text += `$${name}`;

    params.push({ name, type, text: text.trim(), variadic: isVariadic, promoted: isPromoted });
  }
  return params;
}

function extractReturnType(node) {
  const children = Array.from(node.children);
  const colonIdx = children.findIndex(c => c.type === ':');
  if (colonIdx === -1) return null;

  const afterColon = children[colonIdx + 1];
  if (afterColon && afterColon.isNamed &&
    (afterColon.type === 'named_type' || afterColon.type === 'primitive_type' ||
      afterColon.type === 'optional_type' || afterColon.type === 'union_type' ||
      afterColon.type === 'intersection_type' || afterColon.type === 'bottom_type')) {
    return afterColon.text;
  }
  return null;
}

function extractVisibility(node) {
  const vis = node.namedChildren.find(n => n.type === 'visibility_modifier');
  if (!vis) return null;
  const child = vis.namedChildren[0] ?? vis;
  const text = child.text;
  if (text === 'public' || text === 'protected' || text === 'private') return text;
  return vis.text?.replace(/\s+/g, '') || null;
}

function buildClassSignature(name, parentClass, interfaces, isFinal, isAbstract) {
  let sig = '';
  if (isFinal) sig += 'final ';
  if (isAbstract) sig += 'abstract ';
  sig += `class ${name}`;
  if (parentClass) sig += ` extends ${parentClass}`;
  if (interfaces.length) sig += ` implements ${interfaces.join(', ')}`;
  return sig;
}

function attrNameMatches(attrName, target, prefix) {
  if (attrName === target) return true;
  if (prefix && attrName === `${prefix}\\${target}`) return true;
  const parts = attrName.split('\\');
  return parts[parts.length - 1] === target;
}

function isPrimitive(type) {
  const cleaned = type.replace(/^\?/, '');
  const prims = new Set(['int', 'string', 'float', 'bool', 'boolean', 'array', 'object', 'mixed', 'void', 'null', 'callable', 'iterable', 'self', 'static', 'never']);
  return prims.has(cleaned);
}

function classNameToTable(className) {
  return className
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase() + 's';
}

function parseSqlForTables(sql) {
  const ops = [];
  const patterns = [
    { regex: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi, operation: 'createTable' },
    { regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi, operation: 'dropTable' },
    { regex: /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?/gi, operation: 'alterTable' },
    { regex: /INSERT\s+INTO\s+[`"]?(\w+)[`"]?/gi, operation: 'insert' },
    { regex: /UPDATE\s+[`"]?(\w+)[`"]?\s+SET/gi, operation: 'update' },
    { regex: /TRUNCATE\s+(?:TABLE\s+)?[`"]?(\w+)[`"]?/gi, operation: 'truncate' },
  ];

  for (const { regex, operation } of patterns) {
    let match;
    while ((match = regex.exec(sql)) !== null) {
      ops.push({ operation, table: match[1] });
    }
  }
  return ops;
}

function findMethodName(node) {
  const names = node.namedChildren.filter(n => n.type === 'name');
  return names.length >= 2 ? names[1].text : names.length === 1 ? names[0].text : null;
}

function extractFirstStringArg(node) {
  const argsNode = node.namedChildren.find(n => n.type === 'arguments');
  const firstArg = argsNode?.namedChildren?.find(n => n.type === 'argument');
  const strNode = firstArg?.namedChildren?.find(n => n.type === 'string');
  const content = strNode?.namedChildren?.find(n => n.type === 'string_content');
  return content?.text ?? null;
}

// ── Receiver types for method calls (see src/graph/calls.js) ──

// Static methods that return an instance of their class.
const FACTORY_METHODS = new Set([
  'make', 'create', 'new', 'from', 'fromArray', 'getInstance', 'instance',
  'find', 'findOrFail', 'first', 'firstOrFail', 'firstOrCreate', 'firstOrNew', 'updateOrCreate',
]);
// Container lookups: app(Foo::class), resolve(Foo::class), $this->app->make(Foo::class).
const CONTAINER_FUNCTIONS = new Set(['app', 'resolve']);
const CONTAINER_METHODS = new Set(['make', 'get', 'makeWith']);

function callEdge(subprojectId, sourceSymbol, sourceKind, filePath, methodNode, { receiver, receiverType, self }) {
  const method = methodNode.text;
  const typeName = typeof receiverType === 'string' ? receiverType : null;
  return {
    subproject_id: subprojectId,
    source_symbol: sourceSymbol,
    source_kind: sourceKind,
    source_path: filePath,
    target_symbol: typeName ? `${typeName}::${method}` : method,
    target_kind: 'method',
    kind: 'calls',
    metadata: {
      call: {
        ...describeCall(method, receiver, receiverType, self),
        line: methodNode.startPosition.row + 1,
      },
    },
  };
}

// `receiverType` is a class name, `{ call }` (the receiver is what another
// call returns, resolved by the builder from that method's return type) or null.
function describeCall(method, receiver, receiverType, self) {
  const typeName = typeof receiverType === 'string' ? receiverType : null;
  return {
    method,
    receiver: receiver.length > 120 ? `${receiver.slice(0, 117)}...` : receiver,
    ...(typeName ? { receiver_type: typeName } : {}),
    ...(receiverType?.call ? { receiver_call: receiverType.call } : {}),
    ...(self && typeName ? { self: true } : {}),
  };
}

// The call an expression is, as a nested call description (no line).
function callDescription(expr, typeCtx, depth = 0) {
  if (depth > 3) return null;
  if (expr.type === 'member_call_expression' || expr.type === 'nullsafe_member_call_expression') {
    const obj = expr.childForFieldName('object');
    const name = expr.childForFieldName('name');
    if (!obj || name?.type !== 'name') return null;
    return describeCall(name.text, obj.text, expressionType(obj, typeCtx, depth + 1), obj.text === '$this');
  }
  if (expr.type === 'scoped_call_expression') {
    const scope = expr.childForFieldName('scope');
    const name = expr.childForFieldName('name');
    if (!scope || name?.type !== 'name') return null;
    const relative = scope.type === 'relative_scope';
    let type;
    if (relative) type = scope.text === 'parent' ? typeCtx.parentClass : typeCtx.classSymbol;
    else type = classType(scope.text, typeCtx.useMap, typeCtx.namespace);
    return describeCall(name.text, scope.text, type, relative && scope.text !== 'parent');
  }
  return null;
}

// `?Foo`, `Foo|null` -> `Foo`; null for scalars and unions of classes.
function classType(typeText, useMap, namespace) {
  if (!typeText) return null;
  const members = typeText.replace(/^\?/, '').split('|').map(t => t.trim()).filter(t => t && t.toLowerCase() !== 'null');
  if (members.length !== 1 || members[0].includes('&') || isPrimitive(members[0])) return null;
  return resolveType(members[0], useMap, namespace);
}

// Every class in a type (`?Foo`, `Foo|Bar|null`, `Foo&Bar`), resolved; scalars dropped.
function typeTargets(typeText, useMap, namespace) {
  if (!typeText) return [];
  return [...new Set(typeText.replace(/^\?/, '').split(/[|&]/)
    .map(t => t.trim().replace(/^\(|\)$/g, ''))
    .filter(t => t && t.toLowerCase() !== 'null' && !isPrimitive(t))
    .map(t => resolveType(t, useMap, namespace)))];
}

function docVarType(comment, varName) {
  const match = comment.match(/@var\s+([\\\w|?]+)(?:\s+\$(\w+))?/);
  if (!match || (varName && match[2] && match[2] !== varName)) return null;
  return { type: match[1], name: match[2] || null };
}

/**
 * Types of a class's properties: typed and promoted properties, `@var`
 * docblocks, and `$this->x = $typedParam` / `$this->x = new Foo()`.
 */
function classTypeContext(declList, classSymbol, parentClass, useMap, namespace) {
  const properties = new Map();
  const set = (name, typeText) => {
    const type = classType(typeText, useMap, namespace);
    if (type && !properties.has(name)) properties.set(name, type);
  };
  for (const member of declList.namedChildren) {
    if (member.type === 'property_declaration') {
      const typeNode = member.namedChildren.find(n => ['named_type', 'optional_type', 'union_type'].includes(n.type));
      const doc = getDocComment(member);
      for (const el of member.namedChildren.filter(n => n.type === 'property_element')) {
        const name = el.namedChildren.find(n => n.type === 'variable_name')?.text.replace(/^\$/, '');
        if (!name) continue;
        if (typeNode) set(name, typeNode.text);
        else if (doc) set(name, docVarType(doc, name)?.type);
      }
    } else if (member.type === 'method_declaration') {
      const params = extractParams(member);
      const paramTypes = new Map(params.filter(p => p.type).map(p => [p.name, p.type]));
      for (const p of params) if (p.promoted && p.type) set(p.name, p.type);
      walkNode(member, (n) => {
        if (n.type !== 'assignment_expression') return;
        const left = n.childForFieldName('left');
        const right = n.childForFieldName('right');
        if (left?.type !== 'member_access_expression' || left.childForFieldName('object')?.text !== '$this') return;
        const name = left.childForFieldName('name')?.text;
        if (!name || !right) return;
        if (right.type === 'variable_name' && paramTypes.has(right.text.slice(1))) set(name, paramTypes.get(right.text.slice(1)));
        else if (right.type === 'object_creation_expression') set(name, creationClass(right));
      });
    }
  }
  return { classSymbol, parentClass, properties, useMap, namespace };
}

/** Types of a function's variables: typed parameters, assignments, `@var`. */
function localTypes(fnNode, params, typeCtx) {
  const locals = new Map();
  const ctx = { ...typeCtx, locals };
  const set = (name, type) => { if (name && type && !locals.has(name)) locals.set(name, type); };
  for (const p of params) set(p.name, classType(p.type, typeCtx.useMap, typeCtx.namespace));
  const body = fnNode.namedChildren.find(n => n.type === 'compound_statement');
  if (!body) return locals;
  walkNode(body, (n) => {
    if (n.type === 'assignment_expression') {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (left?.type === 'variable_name' && right) set(left.text.slice(1), expressionType(right, ctx));
    } else if (n.type === 'simple_parameter') {
      const typeNode = n.namedChildren.find(c => ['named_type', 'optional_type', 'union_type'].includes(c.type));
      const name = n.namedChildren.find(c => c.type === 'variable_name')?.text.slice(1);
      set(name, classType(typeNode?.text, typeCtx.useMap, typeCtx.namespace));
    } else if (n.type === 'comment' && n.text.startsWith('/**')) {
      const doc = docVarType(n.text);
      if (doc?.name) set(doc.name, classType(doc.type, typeCtx.useMap, typeCtx.namespace));
    }
  });
  return locals;
}

function creationClass(node) {
  return node.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name')?.text ?? null;
}

// The class an expression evaluates to: a class name when it can be told
// syntactically, `{ call }` when it is the result of a method call, or null.
function expressionType(expr, typeCtx, depth = 0) {
  if (!expr || !typeCtx || depth > 3) return null;
  const resolve = (name) => {
    if (!name) return null;
    if (name === 'self' || name === 'static') return typeCtx.classSymbol;
    if (name === 'parent') return typeCtx.parentClass;
    return classType(name, typeCtx.useMap, typeCtx.namespace);
  };
  switch (expr.type) {
    case 'parenthesized_expression':
      return expressionType(expr.namedChildren[0], typeCtx, depth + 1);
    case 'object_creation_expression': {
      const name = creationClass(expr);
      if (name) return resolve(name);
      return expr.text.match(/^new\s+(self|static)\b/) ? typeCtx.classSymbol : null;
    }
    case 'variable_name':
      return expr.text === '$this' ? typeCtx.classSymbol : (typeCtx.locals?.get(expr.text.slice(1)) ?? null);
    case 'member_access_expression':
    case 'nullsafe_member_access_expression':
      return expr.childForFieldName('object')?.text === '$this'
        ? (typeCtx.properties.get(expr.childForFieldName('name')?.text) ?? null)
        : null;
    case 'scoped_call_expression': {
      const scope = expr.childForFieldName('scope');
      if (FACTORY_METHODS.has(expr.childForFieldName('name')?.text) && scope) return resolve(scope.text);
      const call = callDescription(expr, typeCtx, depth);
      return call ? { call } : null;
    }
    case 'function_call_expression': {
      const fn = expr.childForFieldName('function')?.text;
      return CONTAINER_FUNCTIONS.has(fn) ? resolve(classConstantArg(expr)) : null;
    }
    case 'member_call_expression':
    case 'nullsafe_member_call_expression': {
      if (CONTAINER_METHODS.has(expr.childForFieldName('name')?.text) && /->app$/.test(expr.childForFieldName('object')?.text || '')) {
        return resolve(classConstantArg(expr));
      }
      const call = callDescription(expr, typeCtx, depth);
      return call ? { call } : null;
    }
    default:
      return null;
  }
}

// `Foo::class` as the first argument -> `Foo`.
function classConstantArg(callNode) {
  const args = callNode.childForFieldName('arguments');
  const first = args?.namedChildren.find(n => n.type === 'argument')?.namedChildren[0];
  if (first?.type !== 'class_constant_access_expression') return null;
  const [cls, constant] = first.namedChildren;
  return constant?.text === 'class' ? cls?.text ?? null : null;
}

function walkNode(node, visitor) {
  visitor(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    walkNode(node.namedChild(i), visitor);
  }
}
