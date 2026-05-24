const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const INJECTION_CALLS = new Set([
  'useContext', 'useSelector', 'useStore', 'useDispatch', 'useTranslation',
  'inject', 'useRouter',
]);
const HOOK_PATTERN = /^use[A-Z]/;
const LIFECYCLE_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle',
  'useDebugValue', 'useDeferredValue', 'useTransition', 'useId',
  'useSyncExternalStore', 'useInsertionEffect',
  'onMounted', 'onUnmounted', 'onUpdated', 'onBeforeMount',
  'onBeforeUnmount', 'onBeforeUpdate', 'onActivated', 'onDeactivated',
  'watch', 'watchEffect', 'computed', 'ref', 'reactive', 'toRef', 'toRefs',
]);

export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const ctx = { filePath, subprojectId, nodes, edges };

  detectMigrationAndTables(filePath, tree, ctx);

  walk(tree.rootNode, null, ctx);

  return { nodes, edges };
}

function walk(node, scope, ctx) {
  switch (node.type) {
    case 'function_declaration':
      handleFunctionDeclaration(node, scope, ctx);
      return;

    case 'class_declaration':
      handleClassDeclaration(node, scope, ctx);
      return;

    case 'export_statement':
      handleExportStatement(node, scope, ctx);
      return;

    case 'variable_declaration':
    case 'lexical_declaration':
      handleVariableDeclaration(node, scope, ctx, false);
      return;

    case 'expression_statement':
      handleExpressionStatement(node, scope, ctx);
      return;

    case 'import_statement':
      handleImportStatement(node, ctx);
      return;

    case 'comment':
      if (node.text.startsWith('/**')) {
        extractJsdocTypeReferences(node.text, scope, ctx);
      }
      return;

    case 'call_expression':
      handleCallExpression(node, scope, ctx);
      break;

    default:
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), scope, ctx);
  }
}

function handleFunctionDeclaration(node, scope, ctx, exported = false) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const params = node.childForFieldName('parameters');
  const signature = name + (params ? params.text : '()');
  const doc = extractLeadingDoc(node);

  const kind = classifyFunction(name, node, ctx.filePath);
  const isHook = kind === 'hook';
  const isComponent = kind === 'component';

  ctx.nodes.push(makeNode(ctx, {
    symbol: scopedSymbol(scope, name),
    kind: isHook ? 'hook' : isComponent ? 'component' : 'function',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported,
    signature,
    doc,
  }));

  if (exported) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scopedSymbol(scope, name),
      source_kind: isHook ? 'hook' : isComponent ? 'component' : 'function',
      target_symbol: ctx.filePath,
      target_kind: 'file',
      kind: 'provides',
    }));
  }

  const body = node.childForFieldName('body');
  if (body) {
    walkFunctionBody(body, scopedSymbol(scope, name), ctx);
  }
}

function handleClassDeclaration(node, scope, ctx, exported = false) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const extendsName = extractSuperclass(node);
  const doc = extractLeadingDoc(node);

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'class',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported,
    signature: extendsName ? `class ${name} extends ${extendsName}` : `class ${name}`,
    doc,
    metadata: extendsName ? { extends: extendsName } : undefined,
  }));

  if (exported) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: ctx.filePath,
      target_kind: 'file',
      kind: 'provides',
    }));
  }

  if (extendsName) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: extendsName,
      target_kind: 'class',
      kind: 'extends',
    }));
  }

  const body = node.childForFieldName('body');
  if (body) {
    handleClassBody(body, name, ctx);
  }
}

function handleClassBody(bodyNode, className, ctx) {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (child.type === 'method_definition') {
      handleMethodDefinition(child, className, ctx);
    } else if (child.type === 'field_definition' || child.type === 'public_field_definition') {
      handleFieldDefinition(child, className, ctx);
    }
  }
}

function handleMethodDefinition(node, className, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const params = node.childForFieldName('parameters');
  const isStatic = nodeHasChild(node, 'static');
  const isAsync = nodeHasChild(node, 'async');
  const kind = detectMethodKind(node);
  const doc = extractLeadingDoc(node);

  const metadata = {};
  if (isStatic) metadata.static = true;
  if (isAsync) metadata.async = true;
  if (kind) metadata.method_kind = kind;

  const symbol = `${className}.${name}`;
  const signature = buildMethodSignature(name, params, { isStatic, isAsync, kind });

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
    walkFunctionBody(body, symbol, ctx);
  }
}

function handleFieldDefinition(node, className, ctx) {
  const nameNode = node.childForFieldName('property');
  if (!nameNode) return;

  const name = nameNode.text;
  const value = node.childForFieldName('value');

  if (value && isFunctionNode(value)) {
    const params = value.childForFieldName('parameters');
    const symbol = `${className}.${name}`;

    ctx.nodes.push(makeNode(ctx, {
      symbol,
      kind: 'method',
      parent_symbol: className,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: false,
      signature: name + (params ? params.text : '()'),
      doc: extractLeadingDoc(node),
    }));

    const body = value.childForFieldName('body');
    if (body) {
      walkFunctionBody(body, symbol, ctx);
    }
  }
}

function handleExportStatement(node, scope, ctx) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (child.type === 'function_declaration') {
      handleFunctionDeclaration(child, scope, ctx, true);
      return;
    }
    if (child.type === 'class_declaration') {
      handleClassDeclaration(child, scope, ctx, true);
      return;
    }
    if (child.type === 'variable_declaration' || child.type === 'lexical_declaration') {
      handleVariableDeclaration(child, scope, ctx, true);
      return;
    }
    if (child.type === 'export_clause') {
      handleExportClause(child, ctx);
      return;
    }
  }

  const decl = node.childForFieldName('declaration');
  if (decl) {
    if (decl.type === 'function_declaration') {
      handleFunctionDeclaration(decl, scope, ctx, true);
    } else if (decl.type === 'class_declaration') {
      handleClassDeclaration(decl, scope, ctx, true);
    } else if (decl.type === 'variable_declaration' || decl.type === 'lexical_declaration') {
      handleVariableDeclaration(decl, scope, ctx, true);
    }
    return;
  }

  const defaultExport = findChildOfType(node, 'function_expression') ||
                         findChildOfType(node, 'arrow_function');
  if (defaultExport) {
    const kind = classifyFunction('default', defaultExport, ctx.filePath);
    ctx.nodes.push(makeNode(ctx, {
      symbol: 'default',
      kind: kind === 'component' ? 'component' : kind === 'hook' ? 'hook' : 'function',
      parent_symbol: null,
      start_line: defaultExport.startPosition.row + 1,
      end_line: defaultExport.endPosition.row + 1,
      exported: true,
      signature: 'export default',
      doc: extractLeadingDoc(node),
    }));

    const body = defaultExport.childForFieldName('body');
    if (body) {
      walkFunctionBody(body, 'default', ctx);
    }
  }

  const defaultId = findChildOfType(node, 'identifier');
  if (defaultId) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: defaultId.text,
      source_kind: 'function',
      target_symbol: ctx.filePath,
      target_kind: 'file',
      kind: 'provides',
    }));
  }

  const source = node.childForFieldName('source');
  if (source) {
    const specifier = cleanStringLiteral(source.text);
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: ctx.filePath,
      source_kind: 'file',
      target_symbol: specifier,
      target_kind: 'module',
      kind: 'reexports',
    }));
  }
}

function handleExportClause(node, ctx) {
  for (let i = 0; i < node.childCount; i++) {
    const spec = node.child(i);
    if (spec.type === 'export_specifier') {
      const nameNode = spec.childForFieldName('name');
      if (nameNode) {
        const name = nameNode.text;
        ctx.nodes.push(makeNode(ctx, {
          symbol: name,
          kind: 'function',
          parent_symbol: null,
          start_line: spec.startPosition.row + 1,
          end_line: spec.endPosition.row + 1,
          exported: true,
          signature: name,
        }));
      }
    }
  }
}

function handleVariableDeclaration(node, scope, ctx, exported) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type !== 'variable_declarator') continue;

    const nameNode = child.childForFieldName('name');
    const value = child.childForFieldName('value');
    if (!nameNode || !value) continue;

    const name = nameNode.text;

    if (isFunctionNode(value)) {
      handleArrowOrFunctionExpression(name, value, scope, ctx, exported, node);
    } else if (value.type === 'call_expression') {
      handleVariableCallExpression(name, value, scope, ctx, exported, node);
    } else if (exported) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scopedSymbol(scope, name),
        source_kind: 'function',
        target_symbol: ctx.filePath,
        target_kind: 'file',
        kind: 'provides',
      }));
    }
  }
}

function handleArrowOrFunctionExpression(name, fnNode, scope, ctx, exported, declNode) {
  const params = fnNode.childForFieldName('parameters');
  const signature = name + (params ? params.text : '()');
  const doc = extractLeadingDoc(declNode);
  const kind = classifyFunction(name, fnNode, ctx.filePath);

  ctx.nodes.push(makeNode(ctx, {
    symbol: scopedSymbol(scope, name),
    kind: kind === 'hook' ? 'hook' : kind === 'component' ? 'component' : 'function',
    parent_symbol: scope || null,
    start_line: declNode.startPosition.row + 1,
    end_line: fnNode.endPosition.row + 1,
    exported: !!exported,
    signature,
    doc,
  }));

  if (exported) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scopedSymbol(scope, name),
      source_kind: kind === 'hook' ? 'hook' : kind === 'component' ? 'component' : 'function',
      target_symbol: ctx.filePath,
      target_kind: 'file',
      kind: 'provides',
    }));
  }

  const body = fnNode.childForFieldName('body');
  if (body) {
    walkFunctionBody(body, scopedSymbol(scope, name), ctx);
  }
}

function handleVariableCallExpression(name, callNode, scope, ctx, exported, declNode) {
  const callee = callNode.childForFieldName('function');
  if (!callee) return;

  const calleeName = callee.text;

  if (calleeName === 'require') {
    const args = callNode.childForFieldName('arguments');
    if (args) {
      const firstArg = firstNonTrivialChild(args);
      if (firstArg && firstArg.type === 'string') {
        const specifier = cleanStringLiteral(firstArg.text);
        ctx.edges.push(makeEdge(ctx, {
          source_symbol: ctx.filePath,
          source_kind: 'file',
          target_symbol: specifier,
          target_kind: 'module',
          kind: 'imports',
          metadata: { local: name },
        }));
        if (specifier.startsWith('.') || specifier.startsWith('/')) {
          ctx.edges.push(makeEdge(ctx, {
            source_symbol: ctx.filePath,
            source_kind: 'file',
            target_symbol: specifier,
            target_kind: 'module',
            kind: 'depends_on',
          }));
        }
      }
    }
    return;
  }

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
    if (exported) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scopedSymbol(scope, name),
        source_kind: 'component',
        target_symbol: ctx.filePath,
        target_kind: 'file',
        kind: 'provides',
      }));
    }
    return;
  }

  // Pinia / Vuex store detection
  if (/defineStore|createStore/.test(calleeName)) {
    ctx.nodes.push(makeNode(ctx, {
      symbol: name,
      kind: 'store',
      parent_symbol: scope || null,
      start_line: declNode.startPosition.row + 1,
      end_line: callNode.endPosition.row + 1,
      exported: !!exported,
      signature: `${name} = ${calleeName}(...)`,
      doc: extractLeadingDoc(declNode),
      metadata: { store_type: calleeName },
    }));
    if (exported) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scopedSymbol(scope, name),
        source_kind: 'store',
        target_symbol: ctx.filePath,
        target_kind: 'file',
        kind: 'provides',
      }));
    }
    return;
  }

  const args = callNode.childForFieldName('arguments');
  if (args) {
    for (let i = 0; i < args.childCount; i++) {
      const arg = args.child(i);
      if (isFunctionNode(arg)) {
        handleArrowOrFunctionExpression(name, arg, scope, ctx, exported, declNode);
        return;
      }
    }
  }
}

function handleExpressionStatement(node, scope, ctx) {
  const expr = node.childCount > 0 ? node.child(0) : null;
  if (!expr) return;

  if (expr.type === 'assignment_expression') {
    handleAssignmentExpression(expr, scope, ctx);
    return;
  }

  if (expr.type === 'call_expression') {
    handleCallExpression(expr, scope, ctx);
    return;
  }

  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), scope, ctx);
  }
}

function handleAssignmentExpression(node, scope, ctx) {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;

  const leftText = left.text;

  if (leftText.startsWith('module.exports') || leftText.startsWith('exports.')) {
    const name = extractModuleExportsName(leftText);
    if (isFunctionNode(right)) {
      handleArrowOrFunctionExpression(name || 'default', right, scope, ctx, true, node);
    } else if (right.type === 'object' || right.type === 'object_expression') {
      if (name) {
        ctx.nodes.push(makeNode(ctx, {
          symbol: name,
          kind: 'function',
          parent_symbol: null,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          exported: true,
          signature: name,
        }));
      }
      extractRouteObjectLiteral(right, ctx);
    }

    if (name) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: name,
        source_kind: 'function',
        target_symbol: ctx.filePath,
        target_kind: 'file',
        kind: 'provides',
      }));
    } else if (leftText === 'module.exports' && right.type === 'identifier') {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: right.text,
        source_kind: 'function',
        target_symbol: ctx.filePath,
        target_kind: 'file',
        kind: 'provides',
      }));
    }
  }
}

function handleImportStatement(node, ctx) {
  const source = node.childForFieldName('source');
  if (!source) return;

  const specifier = cleanStringLiteral(source.text);
  const importedNames = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    if (child.type === 'import_clause') {
      for (let j = 0; j < child.childCount; j++) {
        const part = child.child(j);
        if (part.type === 'identifier') {
          importedNames.push(part.text);
        } else if (part.type === 'named_imports') {
          for (let k = 0; k < part.childCount; k++) {
            const spec = part.child(k);
            if (spec.type === 'import_specifier') {
              const nameField = spec.childForFieldName('name');
              const aliasField = spec.childForFieldName('alias');
              importedNames.push((aliasField || nameField)?.text);
            }
          }
        } else if (part.type === 'namespace_import') {
          const id = findChildOfType(part, 'identifier');
          if (id) importedNames.push(id.text);
        }
      }
    }
  }

  ctx.edges.push(makeEdge(ctx, {
    source_symbol: ctx.filePath,
    source_kind: 'file',
    target_symbol: specifier,
    target_kind: 'module',
    kind: 'imports',
    metadata: importedNames.length ? { names: importedNames.filter(Boolean) } : undefined,
  }));

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: ctx.filePath,
      source_kind: 'file',
      target_symbol: specifier,
      target_kind: 'module',
      kind: 'depends_on',
    }));
  }
}

function handleCallExpression(node, scope, ctx) {
  const callee = node.childForFieldName('function');
  if (!callee) return;

  const args = node.childForFieldName('arguments');
  const calleeText = callee.text;

  if (callee.type === 'member_expression') {
    handleMemberCallExpression(callee, args, scope, ctx, node);
    return;
  }

  if (calleeText === 'require' && args) {
    const firstArg = firstNonTrivialChild(args);
    if (firstArg && firstArg.type === 'string') {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: ctx.filePath,
        source_kind: 'file',
        target_symbol: cleanStringLiteral(firstArg.text),
        target_kind: 'module',
        kind: 'imports',
      }));
    }
    return;
  }

  // ORM query detection
  if (/\.(find|findOne|findMany|query|select|insert|update|delete|create|where|get|all|exec|execute)\s*\(/.test(calleeText)) {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'function',
        target_symbol: calleeText,
        target_kind: 'function',
        kind: 'queries',
      }));
    }
  }

  // Injection detection
  if (INJECTION_CALLS.has(calleeText) && args && scope) {
    const firstArg = firstNonTrivialChild(args);
    if (firstArg && (firstArg.type === 'identifier' || firstArg.type === 'string')) {
      const target = firstArg.type === 'string' ? cleanStringLiteral(firstArg.text) : firstArg.text;
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'function',
        target_symbol: target,
        target_kind: 'function',
        kind: 'injects',
      }));
    }
  }

  if (scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: calleeText,
      target_kind: 'function',
      kind: 'calls',
    }));
  }
}

function handleMemberCallExpression(callee, args, scope, ctx, callNode) {
  const object = callee.childForFieldName('object');
  const property = callee.childForFieldName('property');
  if (!object || !property) return;

  const objText = object.text;
  const propText = property.text;

  if (HTTP_METHODS.has(propText) && args && isRouterLike(objText)) {
    const firstArg = firstNonTrivialChild(args);
    if (firstArg && firstArg.type === 'string') {
      const routePath = cleanStringLiteral(firstArg.text);
      if (routePath.startsWith('/')) {
        const method = propText.toUpperCase();
        const symbol = `${method} ${routePath}`;

        const middlewareArgs = collectMiddlewareArgs(args);

        ctx.nodes.push(makeNode(ctx, {
          symbol,
          kind: 'route',
          parent_symbol: null,
          start_line: callNode.startPosition.row + 1,
          end_line: callNode.endPosition.row + 1,
          exported: false,
          signature: `${objText}.${propText}('${routePath}', ...)`,
          metadata: {
            method,
            path: routePath,
            ...(middlewareArgs.length > 0 ? { middleware: middlewareArgs } : {}),
          },
        }));

        if (scope) {
          ctx.edges.push(makeEdge(ctx, {
            source_symbol: scope,
            source_kind: 'function',
            target_symbol: symbol,
            target_kind: 'route',
            kind: 'serves_route',
          }));
        }
      }
    }
  }

  if (propText === 'emit' && args) {
    const firstArg = firstNonTrivialChild(args);
    if (firstArg && firstArg.type === 'string') {
      const eventName = cleanStringLiteral(firstArg.text);
      ctx.nodes.push(makeNode(ctx, {
        symbol: eventName,
        kind: 'event',
        parent_symbol: scope || null,
        start_line: callNode.startPosition.row + 1,
        end_line: callNode.endPosition.row + 1,
        exported: false,
        signature: `${objText}.emit('${eventName}')`,
      }));
      if (scope) {
        ctx.edges.push(makeEdge(ctx, {
          source_symbol: scope,
          source_kind: 'function',
          target_symbol: eventName,
          target_kind: 'event',
          kind: 'fires_event',
        }));
      }
    }
  }

  if ((propText === 'on' || propText === 'addEventListener' || propText === 'once') && args) {
    const firstArg = firstNonTrivialChild(args);
    if (firstArg && firstArg.type === 'string') {
      const eventName = cleanStringLiteral(firstArg.text);
      if (scope) {
        ctx.edges.push(makeEdge(ctx, {
          source_symbol: scope,
          source_kind: 'function',
          target_symbol: eventName,
          target_kind: 'event',
          kind: 'consumes_event',
        }));
      }
    }
  }

  if (propText === 'use' && args && isRouterOrApp(objText)) {
    const firstArg = firstNonTrivialChild(args);
    if (firstArg && firstArg.type === 'string') {
      const mountPath = cleanStringLiteral(firstArg.text);
      ctx.nodes.push(makeNode(ctx, {
        symbol: `USE ${mountPath}`,
        kind: 'route',
        parent_symbol: null,
        start_line: callNode.startPosition.row + 1,
        end_line: callNode.endPosition.row + 1,
        exported: false,
        signature: `${objText}.use('${mountPath}', ...)`,
        metadata: { method: 'USE', path: mountPath },
      }));
    }
  }

  if (scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: `${objText}.${propText}`,
      target_kind: 'function',
      kind: 'calls',
    }));
  }
}

function walkFunctionBody(bodyNode, scope, ctx) {
  walkBodyRecursive(bodyNode, scope, ctx);
}

function walkBodyRecursive(node, scope, ctx) {
  if (!node) return;

  if (node.type === 'call_expression') {
    handleCallExpression(node, scope, ctx);
    extractEnvAccess(node, scope, ctx);
  }

  if (node.type === 'member_expression') {
    extractEnvAccess(node, scope, ctx);
  }

  if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element') {
    extractJsxRendering(node, scope, ctx);
  }

  if (node.type === 'pair') {
    extractRouteFromPair(node, ctx);
  }

  for (let i = 0; i < node.childCount; i++) {
    walkBodyRecursive(node.child(i), scope, ctx);
  }
}

function extractJsxRendering(node, scope, ctx) {
  let tagNameNode;

  if (node.type === 'jsx_self_closing_element') {
    tagNameNode = node.childForFieldName('name');
  } else {
    const opening = findChildOfType(node, 'jsx_opening_element');
    if (opening) {
      tagNameNode = opening.childForFieldName('name');
    }
  }

  if (!tagNameNode) return;
  const tagName = tagNameNode.text;

  if (tagName[0] && tagName[0] === tagName[0].toUpperCase() && /^[A-Z]/.test(tagName)) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'component',
      target_symbol: tagName,
      target_kind: 'component',
      kind: 'renders',
    }));
  }
}

function extractEnvAccess(node, scope, ctx) {
  const text = node.text;
  const envMatch = text.match(/process\.env\.([A-Z_][A-Z0-9_]*)/);
  if (!envMatch) return;

  const envKey = envMatch[1];
  ctx.nodes.push(makeNode(ctx, {
    symbol: envKey,
    kind: 'env_var',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: false,
    signature: `process.env.${envKey}`,
    metadata: { source: 'env' },
  }));
}

function extractRouteFromPair(node, ctx) {
  const keyNode = node.childForFieldName('key');
  if (!keyNode) return;

  const keyText = keyNode.type === 'string'
    ? cleanStringLiteral(keyNode.text)
    : keyNode.text;

  const routeMatch = keyText.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ALL)\s+(\/\S*)$/i);
  if (!routeMatch) return;

  const method = routeMatch[1].toUpperCase();
  const routePath = routeMatch[2];
  const symbol = `${method} ${routePath}`;

  const value = node.childForFieldName('value');
  const meta = { method, path: routePath };
  let handlerBody = null;

  if (value && value.type === 'object' || value?.type === 'object_expression') {
    const props = extractObjectProperties(value);
    if (props.auth !== undefined) meta.auth = props.auth === 'true' || props.auth === true;
    if (props.middleware) meta.middleware = props.middleware;
    if (props.handlerNode && isFunctionNode(props.handlerNode)) {
      handlerBody = props.handlerNode.childForFieldName('body');
    }
  } else if (value && isFunctionNode(value)) {
    handlerBody = value.childForFieldName('body');
  }

  ctx.nodes.push(makeNode(ctx, {
    symbol,
    kind: 'route',
    parent_symbol: null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: false,
    signature: `'${keyText}': handler`,
    metadata: meta,
  }));

  if (handlerBody) {
    walkFunctionBody(handlerBody, symbol, ctx);
  }
}

function extractObjectProperties(objNode) {
  const result = {};
  if (!objNode) return result;
  for (let i = 0; i < objNode.childCount; i++) {
    const child = objNode.child(i);
    if (child.type !== 'pair') continue;
    const k = child.childForFieldName('key');
    const v = child.childForFieldName('value');
    if (!k || !v) continue;
    const key = k.type === 'string' ? cleanStringLiteral(k.text) : k.text;
    if (key === 'handler' || key === 'action' || key === 'fn') {
      result.handlerNode = v;
    } else if (key === 'auth') {
      result.auth = v.text;
    } else if (key === 'middleware') {
      result.middleware = v.text;
    }
  }
  return result;
}

function extractRouteObjectLiteral(node, ctx) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'pair') {
      extractRouteFromPair(child, ctx);
    }
  }
}


// --- Classification helpers ---

function classifyFunction(name, fnNode, filePath) {
  if (HOOK_PATTERN.test(name)) {
    if (containsHookCall(fnNode)) return 'hook';
    if (isComposablePath(filePath)) return 'hook';
  }

  if (returnsJsx(fnNode)) return 'component';

  return 'function';
}

function returnsJsx(fnNode) {
  const body = fnNode.childForFieldName('body');
  if (!body) return false;

  return containsNodeType(body, 'jsx_element') ||
         containsNodeType(body, 'jsx_self_closing_element') ||
         containsNodeType(body, 'jsx_fragment');
}

function containsHookCall(fnNode) {
  const body = fnNode.childForFieldName('body');
  if (!body) return false;
  return containsHookCallRecursive(body);
}

function containsHookCallRecursive(node) {
  if (node.type === 'call_expression') {
    const callee = node.childForFieldName('function');
    if (callee && LIFECYCLE_HOOKS.has(callee.text)) return true;
    if (callee && HOOK_PATTERN.test(callee.text)) return true;
  }
  for (let i = 0; i < node.childCount; i++) {
    if (containsHookCallRecursive(node.child(i))) return true;
  }
  return false;
}

function isComposablePath(filePath) {
  return /composable/i.test(filePath) || /hooks?\//i.test(filePath);
}

function containsNodeType(node, type) {
  if (node.type === type) return true;
  for (let i = 0; i < node.childCount; i++) {
    if (containsNodeType(node.child(i), type)) return true;
  }
  return false;
}


// --- Utility helpers ---

function makeNode(ctx, fields) {
  return {
    subproject_id: ctx.subprojectId,
    path: ctx.filePath,
    lang: ctx.lang ?? 'javascript',
    symbol: fields.symbol,
    kind: fields.kind,
    parent_symbol: fields.parent_symbol ?? null,
    start_line: fields.start_line,
    end_line: fields.end_line,
    exported: fields.exported ?? false,
    signature: fields.signature ?? null,
    doc: fields.doc ?? null,
    metadata: fields.metadata ?? null,
  };
}

function makeEdge(ctx, fields) {
  return {
    subproject_id: ctx.subprojectId,
    source_symbol: fields.source_symbol,
    source_kind: fields.source_kind,
    source_path: ctx.filePath,
    target_symbol: fields.target_symbol,
    target_kind: fields.target_kind,
    kind: fields.kind,
    metadata: fields.metadata ?? null,
  };
}

export function makeLangNode(ctx, fields) {
  return makeNode(ctx, fields);
}

export function makeLangEdge(ctx, fields) {
  return makeEdge(ctx, fields);
}

function scopedSymbol(scope, name) {
  return scope ? `${scope}.${name}` : name;
}

function cleanStringLiteral(text) {
  return text.replace(/^['"`]|['"`]$/g, '');
}

function extractLeadingDoc(node) {
  const candidates = [node];
  if (node.parent && node.parent.type === 'export_statement') {
    candidates.push(node.parent);
  }

  for (const target of candidates) {
    let prev = target.previousNamedSibling;
    if (!prev) prev = target.previousSibling;
    if (prev && prev.type === 'comment') {
      const text = prev.text;
      if (text.startsWith('/**') || text.startsWith('//')) {
        return text;
      }
    }
  }
  return null;
}

function isFunctionNode(node) {
  return node.type === 'arrow_function' ||
         node.type === 'function_expression' ||
         node.type === 'function';
}

function extractSuperclass(classNode) {
  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (child.type === 'class_heritage') {
      // TS grammar: class_heritage > extends_clause > identifier
      for (let j = 0; j < child.childCount; j++) {
        const clause = child.child(j);
        if (clause.type === 'extends_clause') {
          for (let k = 0; k < clause.childCount; k++) {
            const heir = clause.child(k);
            if (heir.type === 'identifier' || heir.type === 'type_identifier' || heir.type === 'member_expression') {
              return heir.text;
            }
          }
        }
        // JS grammar: class_heritage > identifier directly
        if (clause.type === 'identifier' || clause.type === 'member_expression') {
          return clause.text;
        }
      }
    }
  }
  const superclass = classNode.childForFieldName('superclass');
  return superclass ? superclass.text : null;
}

function nodeHasChild(node, keyword) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === keyword || child.text === keyword) return true;
  }
  return false;
}

function detectMethodKind(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.text === 'get' && child.type !== 'property_identifier') return 'getter';
    if (child.text === 'set' && child.type !== 'property_identifier') return 'setter';
  }
  return null;
}

function buildMethodSignature(name, params, { isStatic, isAsync, kind }) {
  let sig = '';
  if (isStatic) sig += 'static ';
  if (isAsync) sig += 'async ';
  if (kind === 'getter') sig += 'get ';
  if (kind === 'setter') sig += 'set ';
  sig += name + (params ? params.text : '()');
  return sig;
}

function firstNonTrivialChild(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type !== '(' && child.type !== ')' && child.type !== ',') {
      return child;
    }
  }
  return null;
}

function findChildOfType(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === type) return node.child(i);
  }
  return null;
}

function collectMiddlewareArgs(argsNode) {
  const middleware = [];
  let first = true;
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child.type === '(' || child.type === ')' || child.type === ',') continue;
    if (first) { first = false; continue; }
    if (child.type === 'identifier') {
      middleware.push(child.text);
    }
  }
  return middleware;
}

function extractModuleExportsName(leftText) {
  const match = leftText.match(/(?:module\.exports|exports)\.(\w+)/);
  return match ? match[1] : null;
}

function extractJsdocTypeReferences(commentText, scope, ctx) {
  const regex = /@(?:type|param|returns?|return)\s*\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(commentText))) {
    const typeExpr = match[1];
    const parts = typeExpr.split(/[<>,|&()[\]{}: ]+/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
        const lower = trimmed.toLowerCase();
        if (['string', 'number', 'boolean', 'any', 'void', 'null', 'undefined', 'unknown', 'never', 'object', 'symbol', 'bigint', 'true', 'false'].includes(lower)) {
          continue;
        }
        if (scope) {
          ctx.edges.push(makeEdge(ctx, {
            source_symbol: scope,
            source_kind: 'function',
            target_symbol: trimmed,
            target_kind: 'type_alias',
            kind: 'type_references',
          }));
        }
      }
    }
  }
}

function detectMigrationAndTables(filePath, tree, ctx) {
  const isMigrationPath = /[\\/]migrations?[\\/]/.test(filePath) || /[\\/]migrate[\\/]/.test(filePath);
  const text = tree.rootNode.text;
  const isMigrationContent = /(?:Sequelize\.Migration|TypeORM\.Migration|up\s*\(\s*queryInterface|down\s*\(\s*queryInterface|exports\.up\s*=|exports\.down\s*=|async\s+up\s*\(|async\s+down\s*\()/.test(text);

  if (!isMigrationPath && !isMigrationContent) return;

  ctx.nodes.push(makeNode(ctx, {
    symbol: filePath,
    kind: 'migration',
    parent_symbol: null,
    start_line: 1,
    end_line: tree.rootNode.endPosition.row + 1,
    exported: false,
    signature: filePath,
  }));

  const tablePatterns = [
    /createTable\s*\(\s*['"`](\w+)['"`]/g,
    /dropTable\s*\(\s*['"`](\w+)['"`]/g,
    /renameTable\s*\(\s*['"`](\w+)['"`]/g,
    /sequelize\.define\s*\(\s*['"`](\w+)['"`]/g,
    /queryInterface\.(?:bulkInsert|bulkUpdate|bulkDelete)\s*\(\s*['"`](\w+)['"`]/g,
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/gi,
  ];

  const tables = new Set();
  for (const pattern of tablePatterns) {
    let m;
    while ((m = pattern.exec(text))) {
      tables.add(m[1]);
    }
  }

  for (const table of tables) {
    ctx.nodes.push(makeNode(ctx, {
      symbol: table,
      kind: 'db_table',
      parent_symbol: null,
      start_line: 1,
      end_line: 1,
      exported: false,
      signature: table,
    }));

    ctx.edges.push(makeEdge(ctx, {
      source_symbol: filePath,
      source_kind: 'migration',
      target_symbol: table,
      target_kind: 'db_table',
      kind: 'migrates_table',
    }));
  }
}

function isRouterLike(name) {
  return /^(app|router|server|route|api)$/i.test(name) || /[Rr]outer$/.test(name);
}

function isRouterOrApp(name) {
  return /^(app|router|server)$/i.test(name);
}

export {
  walk as walkTree,
  walkFunctionBody as walkBody,
  handleClassBody,
  handleMethodDefinition,
  handleImportStatement,
  handleCallExpression,
  handleExportStatement,
  classifyFunction,
  extractJsxRendering,
  extractEnvAccess,
  cleanStringLiteral,
  extractLeadingDoc,
  isFunctionNode,
  scopedSymbol,
  nodeHasChild,
  findChildOfType,
  firstNonTrivialChild,
  containsNodeType,
  extractSuperclass,
  HTTP_METHODS,
  detectMigrationAndTables,
};
