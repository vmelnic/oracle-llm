import {
  handleImportStatement,
  handleCallExpression,
  handleExportStatement,
  classifyFunction,
  extractJsxRendering,
  extractEnvAccess,
  extractLeadingDoc,
  isFunctionNode,
  scopedSymbol,
  nodeHasChild,
  findChildOfType,
  extractSuperclass,
  makeLangNode,
  makeLangEdge,
  handleModuleVariable,
  collectImportedNames,
  extractValueReference,
} from './javascript.js';

export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const ctx = { filePath, subprojectId, lang: 'typescript', nodes, edges, importedNames: collectImportedNames(tree.rootNode) };

  walkTs(tree.rootNode, null, ctx);

  return { nodes, edges };
}

function walkTs(node, scope, ctx) {
  switch (node.type) {
    case 'interface_declaration':
      handleInterfaceDeclaration(node, scope, ctx, false);
      return;

    case 'type_alias_declaration':
      handleTypeAliasDeclaration(node, scope, ctx, false);
      return;

    case 'enum_declaration':
      handleEnumDeclaration(node, scope, ctx, false);
      return;

    case 'function_declaration':
      handleTsFunctionDeclaration(node, scope, ctx, false);
      return;

    case 'class_declaration':
      handleTsClassDeclaration(node, scope, ctx, false);
      return;

    case 'abstract_class_declaration':
      handleTsClassDeclaration(node, scope, ctx, false, true);
      return;

    case 'export_statement':
      handleTsExportStatement(node, scope, ctx);
      return;

    case 'variable_declaration':
    case 'lexical_declaration':
      handleTsVariableDeclaration(node, scope, ctx, false);
      return;

    case 'expression_statement':
      handleTsExpressionStatement(node, scope, ctx);
      return;

    case 'import_statement':
      handleImportStatement(node, ctx);
      return;

    case 'call_expression':
      handleCallExpression(node, scope, ctx);
      break;

    default:
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    walkTs(node.child(i), scope, ctx);
  }
}

function handleInterfaceDeclaration(node, scope, ctx, exported) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const doc = extractLeadingDoc(node);
  const extendsClause = findChildOfType(node, 'extends_type_clause');
  const extendsList = extendsClause ? extractExtendsList(extendsClause) : [];

  let signature = `interface ${name}`;
  if (extendsList.length) {
    signature += ` extends ${extendsList.join(', ')}`;
  }

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'interface',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: !!exported,
    signature,
    doc,
    metadata: extendsList.length ? { extends: extendsList } : undefined,
  }));

  for (const ext of extendsList) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'interface',
      target_symbol: ext,
      target_kind: 'interface',
      kind: 'extends',
    }));
  }

  const body = node.childForFieldName('body');
  if (body) {
    extractInterfaceMembers(body, name, ctx);
  }
}

function extractInterfaceMembers(body, interfaceName, ctx) {
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (child.type === 'property_signature' || child.type === 'method_signature') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        const memberName = nameNode.text;
        const typeAnno = findChildOfType(child, 'type_annotation');
        const returnType = typeAnno ? typeAnno.text.replace(/^:\s*/, '') : null;

        // A property is callable (`props.onSave()`) only when its type is a function.
        const callable = child.type === 'method_signature' || typeAnno?.namedChild(0)?.type === 'function_type';
        ctx.nodes.push(makeNode(ctx, {
          symbol: `${interfaceName}.${memberName}`,
          kind: callable ? 'method' : 'property',
          parent_symbol: interfaceName,
          start_line: child.startPosition.row + 1,
          end_line: child.endPosition.row + 1,
          exported: false,
          signature: child.text.replace(/;$/, ''),
          metadata: returnType ? { return_type: returnType } : undefined,
        }));
      }
    }
  }
}

function handleTypeAliasDeclaration(node, scope, ctx, exported) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const doc = extractLeadingDoc(node);
  const value = node.childForFieldName('value');
  const typeParams = findChildOfType(node, 'type_parameters');

  let signature = `type ${name}`;
  if (typeParams) signature += typeParams.text;
  if (value) signature += ` = ${truncate(value.text, 120)}`;

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'type_alias',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: !!exported,
    signature,
    doc,
  }));
}

function handleEnumDeclaration(node, scope, ctx, exported) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const doc = extractLeadingDoc(node);
  const isConst = nodeHasChild(node, 'const');
  const body = node.childForFieldName('body');
  const members = [];

  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child.type === 'enum_member' || child.type === 'property_identifier') {
        const memberName = child.childForFieldName('name');
        if (memberName) members.push(memberName.text);
        else if (child.type === 'property_identifier') members.push(child.text);
      }
    }
  }

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'enum',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: !!exported,
    signature: `${isConst ? 'const ' : ''}enum ${name}`,
    doc,
    metadata: members.length ? { members } : undefined,
  }));
}

function handleTsFunctionDeclaration(node, scope, ctx, exported) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const params = node.childForFieldName('parameters');
  const returnType = findChildOfType(node, 'type_annotation');
  const typeParams = findChildOfType(node, 'type_parameters');
  const isAsync = nodeHasChild(node, 'async');
  const doc = extractLeadingDoc(node);

  let signature = '';
  if (isAsync) signature += 'async ';
  signature += name;
  if (typeParams) signature += typeParams.text;
  signature += params ? params.text : '()';
  if (returnType) signature += returnType.text;

  const kind = classifyFunction(name, node, ctx.filePath);

  ctx.nodes.push(makeNode(ctx, {
    symbol: scopedSymbol(scope, name),
    kind: kind === 'hook' ? 'hook' : kind === 'component' ? 'component' : 'function',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: !!exported,
    signature,
    doc,
    metadata: returnType ? { return_type: returnType.text.replace(/^:\s*/, '') } : undefined,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    walkTsBody(body, scopedSymbol(scope, name), ctx);
  }
}

function handleTsClassDeclaration(node, scope, ctx, exported, abstract = false) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const extendsName = extractSuperclass(node);
  const typeParams = findChildOfType(node, 'type_parameters');
  const doc = extractLeadingDoc(node);
  const decorators = collectDecorators(node);
  const implementsClause = extractImplementsList(node);

  let signature = '';
  if (abstract) signature += 'abstract ';
  signature += `class ${name}`;
  if (typeParams) signature += typeParams.text;
  if (extendsName) signature += ` extends ${extendsName}`;
  if (implementsClause.length) signature += ` implements ${implementsClause.join(', ')}`;

  const metadata = {};
  if (extendsName) metadata.extends = extendsName;
  if (abstract) metadata.abstract = true;
  if (implementsClause.length) metadata.implements = implementsClause;
  if (decorators.length) metadata.decorators = decorators;

  let kind = 'class';
  if (decorators.some(d => d.name === 'Component')) kind = 'component';
  if (decorators.some(d => d.name === 'Directive')) kind = 'directive';
  if (decorators.some(d => d.name === 'Pipe')) kind = 'pipe';
  if (decorators.some(d => d.name === 'Injectable')) kind = 'provider';

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind,
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: !!exported,
    signature,
    doc,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  }));

  if (extendsName) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: kind,
      target_symbol: extendsName,
      target_kind: 'class',
      kind: 'extends',
    }));
  }

  for (const impl of implementsClause) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: kind,
      target_symbol: impl,
      target_kind: 'interface',
      kind: 'implements',
    }));
  }

  const body = node.childForFieldName('body');
  if (body) {
    handleTsClassBody(body, name, ctx);
  }
}

function handleTsClassBody(bodyNode, className, ctx) {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (child.type === 'method_definition') {
      handleTsMethodDefinition(child, className, ctx);
    } else if (child.type === 'public_field_definition' || child.type === 'field_definition') {
      handleTsFieldDefinition(child, className, ctx);
    }
  }
}

function handleTsMethodDefinition(node, className, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const params = node.childForFieldName('parameters');
  const returnType = findChildOfType(node, 'type_annotation');
  const isStatic = nodeHasChild(node, 'static');
  const isAsync = nodeHasChild(node, 'async');
  const isAbstract = nodeHasChild(node, 'abstract');
  const accessibility = detectAccessibility(node);
  const methodKind = detectMethodKindTs(node);
  const decorators = collectDecorators(node);
  const doc = extractLeadingDoc(node);

  const metadata = {};
  if (isStatic) metadata.static = true;
  if (isAsync) metadata.async = true;
  if (isAbstract) metadata.abstract = true;
  if (accessibility) metadata.accessibility = accessibility;
  if (methodKind) metadata.method_kind = methodKind;
  if (decorators.length) metadata.decorators = decorators;
  if (returnType) metadata.return_type = returnType.text.replace(/^:\s*/, '');

  const symbol = `${className}.${name}`;
  let signature = '';
  if (accessibility) signature += accessibility + ' ';
  if (isStatic) signature += 'static ';
  if (isAsync) signature += 'async ';
  if (isAbstract) signature += 'abstract ';
  if (methodKind === 'getter') signature += 'get ';
  if (methodKind === 'setter') signature += 'set ';
  signature += name;
  signature += params ? params.text : '()';
  if (returnType) signature += returnType.text;

  ctx.nodes.push(makeNode(ctx, {
    symbol,
    kind: 'method',
    parent_symbol: className,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: false,
    signature,
    doc,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    walkTsBody(body, symbol, ctx);
  }
}

function handleTsFieldDefinition(node, className, ctx) {
  const nameNode = node.childForFieldName('property') || node.childForFieldName('name');
  if (!nameNode) return;

  const name = nameNode.text;
  const value = node.childForFieldName('value');
  const decorators = collectDecorators(node);

  if (value && isFunctionNode(value)) {
    const params = value.childForFieldName('parameters');
    const returnType = findChildOfType(value, 'type_annotation');
    const symbol = `${className}.${name}`;

    const metadata = {};
    if (decorators.length) metadata.decorators = decorators;
    if (returnType) metadata.return_type = returnType.text.replace(/^:\s*/, '');

    ctx.nodes.push(makeNode(ctx, {
      symbol,
      kind: 'method',
      parent_symbol: className,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: false,
      signature: name + (params ? params.text : '()'),
      doc: extractLeadingDoc(node),
      metadata: Object.keys(metadata).length ? metadata : undefined,
    }));

    const body = value.childForFieldName('body');
    if (body) {
      walkTsBody(body, symbol, ctx);
    }
  }
}

function handleTsExportStatement(node, scope, ctx) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (child.type === 'interface_declaration') {
      handleInterfaceDeclaration(child, scope, ctx, true);
      return;
    }
    if (child.type === 'type_alias_declaration') {
      handleTypeAliasDeclaration(child, scope, ctx, true);
      return;
    }
    if (child.type === 'enum_declaration') {
      handleEnumDeclaration(child, scope, ctx, true);
      return;
    }
    if (child.type === 'function_declaration') {
      handleTsFunctionDeclaration(child, scope, ctx, true);
      return;
    }
    if (child.type === 'class_declaration' || child.type === 'abstract_class_declaration') {
      handleTsClassDeclaration(child, scope, ctx, true, child.type === 'abstract_class_declaration');
      return;
    }
    if (child.type === 'variable_declaration' || child.type === 'lexical_declaration') {
      handleTsVariableDeclaration(child, scope, ctx, true);
      return;
    }
  }

  const decl = node.childForFieldName('declaration');
  if (decl) {
    switch (decl.type) {
      case 'interface_declaration':
        handleInterfaceDeclaration(decl, scope, ctx, true);
        return;
      case 'type_alias_declaration':
        handleTypeAliasDeclaration(decl, scope, ctx, true);
        return;
      case 'enum_declaration':
        handleEnumDeclaration(decl, scope, ctx, true);
        return;
      case 'function_declaration':
        handleTsFunctionDeclaration(decl, scope, ctx, true);
        return;
      case 'class_declaration':
      case 'abstract_class_declaration':
        handleTsClassDeclaration(decl, scope, ctx, true, decl.type === 'abstract_class_declaration');
        return;
      case 'variable_declaration':
      case 'lexical_declaration':
        handleTsVariableDeclaration(decl, scope, ctx, true);
        return;
    }
  }

  handleExportStatement(node, scope, ctx);
}

function handleTsVariableDeclaration(node, scope, ctx, exported) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type !== 'variable_declarator') continue;

    const nameNode = child.childForFieldName('name');
    const value = child.childForFieldName('value');
    const typeAnno = findChildOfType(child, 'type_annotation');
    if (!nameNode || !value) continue;

    const name = nameNode.text;

    if (isFunctionNode(value)) {
      handleTsArrowOrFunctionExpression(name, value, scope, ctx, exported, node, typeAnno);
    } else if (value.type === 'call_expression') {
      if (!handleTsVariableCallExpression(name, value, scope, ctx, exported, node) && !scope) {
        handleModuleVariable(name, value, ctx, exported, node, walkTsBody, typeAnno);
      }
    } else if (!scope) {
      handleModuleVariable(name, value, ctx, exported, node, walkTsBody, typeAnno);
    }
  }
}

function handleTsArrowOrFunctionExpression(name, fnNode, scope, ctx, exported, declNode, typeAnno) {
  const params = fnNode.childForFieldName('parameters');
  const returnType = findChildOfType(fnNode, 'type_annotation');
  const typeParams = findChildOfType(fnNode, 'type_parameters');
  const doc = extractLeadingDoc(declNode);
  const kind = classifyFunction(name, fnNode, ctx.filePath);

  let signature = name;
  if (typeParams) signature += typeParams.text;
  signature += params ? params.text : '()';
  if (returnType) signature += returnType.text;

  const metadata = {};
  if (returnType) metadata.return_type = returnType.text.replace(/^:\s*/, '');
  if (typeAnno) metadata.declared_type = typeAnno.text.replace(/^:\s*/, '');

  ctx.nodes.push(makeNode(ctx, {
    symbol: scopedSymbol(scope, name),
    kind: kind === 'hook' ? 'hook' : kind === 'component' ? 'component' : 'function',
    parent_symbol: scope || null,
    start_line: declNode.startPosition.row + 1,
    end_line: fnNode.endPosition.row + 1,
    exported: !!exported,
    signature,
    doc,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  }));

  const body = fnNode.childForFieldName('body');
  if (body) {
    walkTsBody(body, scopedSymbol(scope, name), ctx);
  }
}

/** Returns true when the declaration was recognised (function, component, store). */
function handleTsVariableCallExpression(name, callNode, scope, ctx, exported, declNode) {
  const callee = callNode.childForFieldName('function');
  if (!callee) return false;

  const calleeName = callee.text;

  if (calleeName === 'defineComponent') {
    ctx.nodes.push(makeNode(ctx, {
      symbol: name,
      kind: 'component',
      parent_symbol: scope || null,
      start_line: declNode.startPosition.row + 1,
      end_line: callNode.endPosition.row + 1,
      exported: !!exported,
      signature: `${name} = defineComponent(...)`,
      doc: extractLeadingDoc(declNode),
      metadata: { vue: true },
    }));
    return true;
  }

  const args = callNode.childForFieldName('arguments');
  if (args) {
    for (let i = 0; i < args.childCount; i++) {
      const arg = args.child(i);
      if (isFunctionNode(arg)) {
        handleTsArrowOrFunctionExpression(name, arg, scope, ctx, exported, declNode, null);
        return true;
      }
    }
  }
  return false;
}

function handleTsExpressionStatement(node, scope, ctx) {
  const expr = node.childCount > 0 ? node.child(0) : null;
  if (!expr) return;

  if (expr.type === 'call_expression') {
    handleCallExpression(expr, scope, ctx);
    return;
  }

  for (let i = 0; i < node.childCount; i++) {
    walkTs(node.child(i), scope, ctx);
  }
}

function walkTsBody(bodyNode, scope, ctx) {
  walkTsBodyRecursive(bodyNode, scope, ctx);
}

function walkTsBodyRecursive(node, scope, ctx) {
  if (!node) return;

  if (node.type === 'call_expression') {
    handleCallExpression(node, scope, ctx);
    extractEnvAccess(node, scope, ctx);
  }

  if (node.type === 'member_expression') {
    extractEnvAccess(node, scope, ctx);
  }

  if (node.type === 'identifier' || node.type === 'shorthand_property_identifier') {
    extractValueReference(node, scope, ctx);
  }

  if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element') {
    extractJsxRendering(node, scope, ctx);
  }

  for (let i = 0; i < node.childCount; i++) {
    walkTsBodyRecursive(node.child(i), scope, ctx);
  }
}


// --- TypeScript-specific helpers ---

function collectDecorators(node) {
  const decorators = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'decorator') {
      const expr = child.childCount > 1 ? child.child(1) : null;
      if (expr) {
        if (expr.type === 'call_expression') {
          const callee = expr.childForFieldName('function');
          decorators.push({ name: callee ? callee.text : expr.text, full: child.text });
        } else {
          decorators.push({ name: expr.text, full: child.text });
        }
      }
    }
  }

  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'decorator') {
    const expr = prev.childCount > 1 ? prev.child(1) : null;
    if (expr) {
      if (expr.type === 'call_expression') {
        const callee = expr.childForFieldName('function');
        decorators.unshift({ name: callee ? callee.text : expr.text, full: prev.text });
      } else {
        decorators.unshift({ name: expr.text, full: prev.text });
      }
    }
    prev = prev.previousNamedSibling;
  }

  return decorators;
}

function extractExtendsList(extendsClause) {
  const names = [];
  for (let i = 0; i < extendsClause.childCount; i++) {
    const child = extendsClause.child(i);
    if (child.type === 'type_identifier' || child.type === 'identifier' || child.type === 'generic_type') {
      const name = child.type === 'generic_type'
        ? (child.childForFieldName('name')?.text || child.text)
        : child.text;
      names.push(name);
    }
  }
  return names;
}

function extractImplementsList(classNode) {
  const names = [];

  function extractFromClause(clause) {
    for (let j = 0; j < clause.childCount; j++) {
      const impl = clause.child(j);
      if (impl.type === 'type_identifier' || impl.type === 'identifier' || impl.type === 'generic_type') {
        const name = impl.type === 'generic_type'
          ? (impl.childForFieldName('name')?.text || impl.text)
          : impl.text;
        names.push(name);
      }
    }
  }

  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (child.type === 'implements_clause') {
      extractFromClause(child);
    } else if (child.type === 'class_heritage') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner.type === 'implements_clause') {
          extractFromClause(inner);
        }
      }
    }
  }

  return names;
}

function detectAccessibility(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'accessibility_modifier') return child.text;
    if (child.text === 'public' || child.text === 'private' || child.text === 'protected') {
      return child.text;
    }
  }
  return null;
}

function detectMethodKindTs(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.text === 'get' && child.type !== 'property_identifier' && child.type !== 'identifier') return 'getter';
    if (child.text === 'set' && child.type !== 'property_identifier' && child.type !== 'identifier') return 'setter';
  }
  return null;
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}


function makeNode(ctx, fields) {
  return makeLangNode(ctx, fields);
}

function makeEdge(ctx, fields) {
  return makeLangEdge(ctx, fields);
}
