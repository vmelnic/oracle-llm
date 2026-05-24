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

  for (const member of declList.namedChildren) {
    switch (member.type) {
      case 'method_declaration':
        extractMethod(member, fqcn, classRoutePath, namespace, filePath, subprojectId, useMap, isMigration, isServiceProvider, isEventSubscriber, nodes, edges);
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

  for (const member of declList.namedChildren) {
    if (member.type === 'method_declaration') {
      extractMethod(member, fqn, '', namespace, filePath, subprojectId, useMap, false, false, false, nodes, edges);
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

  for (const member of declList.namedChildren) {
    if (member.type === 'method_declaration') {
      extractMethod(member, fqn, '', namespace, filePath, subprojectId, useMap, false, false, false, nodes, edges);
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
    metadata: {},
  });

  for (const p of params) {
    if (p.type && !isPrimitive(p.type)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: fqn,
        source_kind: 'function',
        source_path: filePath,
        target_symbol: resolveType(p.type, useMap, namespace),
        target_kind: 'class',
        kind: 'type_references',
        metadata: { context: 'parameter', name: p.name },
      });
    }
  }
  if (returnType && !isPrimitive(returnType)) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: fqn,
      source_kind: 'function',
      source_path: filePath,
      target_symbol: resolveType(returnType, useMap, namespace),
      target_kind: 'class',
      kind: 'type_references',
      metadata: { context: 'return' },
    });
  }

  extractBodyEdges(node, fqn, 'function', filePath, subprojectId, edges);
}

function extractMethod(node, parentSymbol, classRoutePath, namespace, filePath, subprojectId, useMap, isMigration, isServiceProvider, isEventSubscriber, nodes, edges) {
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
    if (p.type && !isPrimitive(p.type)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: symbol,
        source_kind: 'method',
        source_path: filePath,
        target_symbol: resolveType(p.type, useMap, namespace),
        target_kind: 'class',
        kind: 'type_references',
        metadata: { context: 'parameter', name: p.name },
      });
    }
  }
  if (returnType && !isPrimitive(returnType)) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: symbol,
      source_kind: 'method',
      source_path: filePath,
      target_symbol: resolveType(returnType, useMap, namespace),
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

  if (name.startsWith('provide') && returnType && !isPrimitive(returnType)) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: parentSymbol,
      source_kind: 'class',
      source_path: filePath,
      target_symbol: resolveType(returnType, useMap, namespace),
      target_kind: 'class',
      kind: 'provides',
      metadata: { method: name },
    });
  }

  if (isEventSubscriber && name === 'handle' && params.length > 0 && params[0].type && !isPrimitive(params[0].type)) {
    edges.push({
      subproject_id: subprojectId,
      source_symbol: symbol,
      source_kind: 'method',
      source_path: filePath,
      target_symbol: resolveType(params[0].type, useMap, namespace),
      target_kind: 'event',
      kind: 'consumes_event',
      metadata: {},
    });
  }

  if (name.startsWith('onKernel') || name.startsWith('onSecurity') || name.startsWith('onForm')) {
    const eventParam = params.find(p => p.type && !isPrimitive(p.type));
    if (eventParam) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: symbol,
        source_kind: 'method',
        source_path: filePath,
        target_symbol: resolveType(eventParam.type, useMap, namespace),
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
  extractBodyEdges(node, symbol, 'method', filePath, subprojectId, edges);
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

    if (typeStr && !isPrimitive(typeStr)) {
      edges.push({
        subproject_id: subprojectId,
        source_symbol: symbol,
        source_kind: 'property',
        source_path: filePath,
        target_symbol: resolveType(typeStr, useMap, namespace),
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

function extractRouteFromAttribute(routeAttr, classRoutePath, methodSymbol, classSymbol, methodName, filePath, subprojectId, node, nodes, edges) {
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
    if (p.type && !isPrimitive(p.type)) {
      const resolved = resolveType(p.type, useMap, namespace);
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

function extractBodyEdges(node, sourceSymbol, sourceKind, filePath, subprojectId, edges) {
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
          target_symbol: nameNode.text,
          target_kind: 'class',
          kind: 'calls',
          metadata: { type: 'instantiation' },
        });
      }
    }

    if (child.type === 'member_call_expression') {
      const obj = child.namedChildren[0];
      const methodNode = child.namedChildren.find(n => n.type === 'name' && n !== obj);
      if (methodNode) {
        const objText = obj?.text ?? '';
        const isThis = objText === '$this';
        edges.push({
          subproject_id: subprojectId,
          source_symbol: sourceSymbol,
          source_kind: sourceKind,
          source_path: filePath,
          target_symbol: isThis ? `${sourceSymbol.split('::')[0]}::${methodNode.text}` : methodNode.text,
          target_kind: 'method',
          kind: 'calls',
          metadata: isThis ? { self_call: true } : { receiver: objText },
        });

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
      const scopeNode = child.namedChildren.find(n => n.type === 'name' || n.type === 'qualified_name');
      const allNames = child.namedChildren.filter(n => n.type === 'name');
      const methodNode = allNames.length >= 2 ? allNames[1] : null;
      if (scopeNode && methodNode) {
        edges.push({
          subproject_id: subprojectId,
          source_symbol: sourceSymbol,
          source_kind: sourceKind,
          source_path: filePath,
          target_symbol: `${scopeNode.text}::${methodNode.text}`,
          target_kind: 'method',
          kind: 'calls',
          metadata: { static_call: true },
        });

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

function extractLaravelRoute(node, method, filePath, subprojectId, useMap, namespace, nodes, edges) {
  const argsNode = node.namedChildren.find(n => n.type === 'arguments');
  if (!argsNode) return;

  const args = argsNode.namedChildren.filter(n => n.type === 'argument');
  if (args.length < 1) return;

  const pathStr = args[0].namedChildren.find(n => n.type === 'string');
  const pathContent = pathStr?.namedChildren?.find(n => n.type === 'string_content');
  const routePath = pathContent?.text ?? '';

  let controller = null;
  let action = null;

  if (args.length >= 2) {
    const arrayArg = args[1].namedChildren.find(n => n.type === 'array_creation_expression');
    if (arrayArg) {
      const elements = arrayArg.namedChildren.filter(n => n.type === 'array_element_initializer');
      if (elements.length >= 2) {
        const classAccess = elements[0].namedChildren.find(n => n.type === 'class_constant_access_expression');
        if (classAccess) {
          controller = classAccess.namedChildren.find(n => n.type === 'name')?.text ?? null;
        }
        const actionStr = elements[1].namedChildren.find(n => n.type === 'string');
        const actionContent = actionStr?.namedChildren?.find(n => n.type === 'string_content');
        action = actionContent?.text ?? null;
      }
    }
  }

  const httpMethod = method.toUpperCase();
  const symbol = `${httpMethod} ${routePath}`;
  const isApiRoute = routePath.startsWith('/api') || routePath.startsWith('api');

  const metadata = {
    method: httpMethod,
    path: routePath,
  };
  if (controller) metadata.controller = resolveType(controller, useMap, namespace);
  if (action) metadata.action = action;

  nodes.push({
    subproject_id: subprojectId,
    path: filePath,
    lang: 'php',
    symbol,
    kind: 'route',
    parent_symbol: null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: symbol,
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
      parent_symbol: null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `API ${symbol}`,
      doc: null,
      metadata,
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

function walkNode(node, visitor) {
  visitor(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    walkNode(node.namedChild(i), visitor);
  }
}
