const ROUTE_DECORATORS = new Set([
  'route', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head',
]);
const PYTHON_BUILTINS = new Set([
  'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'set', 'frozenset',
  'bytes', 'bytearray', 'memoryview', 'range', 'slice', 'complex', 'object',
  'type', 'None', 'Any', 'Optional', 'Union', 'List', 'Dict', 'Tuple', 'Set',
  'Callable', 'Iterable', 'Iterator', 'Generator', 'Coroutine', 'Awaitable',
  'Protocol', 'ClassVar', 'Final', 'Literal', 'TypedDict', 'NamedTuple',
]);

export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const ctx = { filePath, subprojectId, lang: 'python', nodes, edges };

  walk(tree.rootNode, null, ctx);

  return { nodes, edges };
}

function walk(node, scope, ctx) {
  switch (node.type) {
    case 'function_definition':
      handleFunction(node, scope, ctx);
      return;
    case 'class_definition':
      handleClass(node, scope, ctx);
      return;
    case 'decorated_definition':
      handleDecorated(node, scope, ctx);
      return;
    case 'import_statement':
    case 'import_from_statement':
      handleImport(node, ctx);
      return;
    case 'call_expression':
      handleCall(node, scope, ctx);
      break;
    case 'assignment':
      handleAssignment(node, scope, ctx);
      break;
    default:
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), scope, ctx);
  }
}

function handleFunction(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const params = node.childForFieldName('parameters');
  const signature = `def ${name}${params ? params.text : '()'}`;
  const doc = extractLeadingDoc(node);

  const symbol = scope ? `${scope}.${name}` : name;

  ctx.nodes.push(makeNode(ctx, {
    symbol,
    kind: 'function',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: scope === null,
    signature,
    doc,
  }));

  extractPythonTypeReferences(node, symbol, scope ? 'method' : 'function', ctx);

  // Migration function detection
  if ((name === 'upgrade' || name === 'downgrade') && (/migrations\//.test(ctx.filePath) || /alembic\//.test(ctx.filePath))) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: symbol,
      source_kind: 'function',
      target_symbol: 'migration',
      target_kind: 'migration',
      kind: 'migrates_table',
    }));
  }

  const body = node.childForFieldName('body');
  if (body) {
    walkBody(body, symbol, ctx);
  }
}

function handleClass(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const superClause = node.childForFieldName('superclasses');
  let extendsName = null;
  if (superClause) {
    const first = superClause.namedChildren[0];
    if (first) extendsName = first.text;
  }

  const doc = extractLeadingDoc(node);

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'class',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: scope === null,
    signature: extendsName ? `class ${name}(${extendsName})` : `class ${name}`,
    doc,
    metadata: extendsName ? { extends: extendsName } : undefined,
  }));

  if (extendsName) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: extendsName,
      target_kind: 'class',
      kind: 'extends',
    }));
  }

  // Migration class detection
  if (/Migration/.test(extendsName) || /migrations\//.test(ctx.filePath) || /alembic\//.test(ctx.filePath)) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: 'migration',
      target_kind: 'migration',
      kind: 'migrates_table',
    }));
  }

  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child.type === 'function_definition') {
        handleMethod(child, name, ctx);
      } else if (child.type === 'decorated_definition') {
        const def = child.namedChildren.find(n => n.type === 'function_definition');
        if (def) handleMethod(def, name, ctx);
      }
    }
  }
}

function handleMethod(node, className, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const params = node.childForFieldName('parameters');
  const signature = `def ${name}${params ? params.text : '()'}`;
  const doc = extractLeadingDoc(node);
  const symbol = `${className}.${name}`;

  ctx.nodes.push(makeNode(ctx, {
    symbol,
    kind: 'method',
    parent_symbol: className,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: !name.startsWith('_'),
    signature,
    doc,
  }));

  extractPythonTypeReferences(node, symbol, 'method', ctx);

  const body = node.childForFieldName('body');
  if (body) {
    walkBody(body, symbol, ctx);
  }
}

function handleDecorated(node, scope, ctx) {
  const def = node.namedChildren.find(n =>
    n.type === 'function_definition' || n.type === 'class_definition'
  );
  if (!def) return;

  const decorators = node.namedChildren.filter(n => n.type === 'decorator');
  const isRoute = decorators.some(d => isRouteDecorator(d));

  // @receiver event listener detection
  const receiverDecorator = decorators.find(d => {
    const call = d.namedChildren[0];
    if (!call || call.type !== 'call_expression') return false;
    const func = call.childForFieldName('function');
    return func && func.text === 'receiver';
  });
  if (receiverDecorator && def.type === 'function_definition') {
    const call = receiverDecorator.namedChildren[0];
    const args = call.childForFieldName('arguments');
    const firstArg = args?.namedChildren?.[0];
    const eventName = firstArg ? firstArg.text : 'event';
    const funcNameNode = def.childForFieldName('name');
    const funcName = funcNameNode ? (scope ? `${scope}.${funcNameNode.text}` : funcNameNode.text) : 'unknown';
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: funcName,
      source_kind: 'function',
      target_symbol: eventName,
      target_kind: 'event',
      kind: 'consumes_event',
    }));
  }

  // @inject decorator detection
  const hasInjectDecorator = decorators.some(d => d.text.includes('@inject'));

  if (def.type === 'function_definition' && isRoute) {
    const nameNode = def.childForFieldName('name');
    const name = nameNode ? nameNode.text : 'unknown';
    const params = def.childForFieldName('parameters');

    let method = 'GET';
    let routePath = '/';
    for (const d of decorators) {
      const decoInfo = parseRouteDecorator(d);
      if (decoInfo) {
        method = decoInfo.method;
        routePath = decoInfo.path;
        break;
      }
    }

    const symbol = `${method} ${routePath}`;
    ctx.nodes.push(makeNode(ctx, {
      symbol,
      kind: 'route',
      parent_symbol: scope || null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `${method} ${routePath} → ${name}${params ? params.text : '()'}`,
      metadata: { method, path: routePath, handler: name },
    }));

    // Also emit the function node
    handleFunction(def, scope, ctx);

    // Edge from function to route
    const funcName = nameNode ? (scope ? `${scope}.${name}` : name) : name;
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: funcName,
      source_kind: 'function',
      target_symbol: symbol,
      target_kind: 'route',
      kind: 'serves_route',
    }));

    if (hasInjectDecorator) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: funcName,
        source_kind: 'function',
        target_symbol: 'dependency',
        target_kind: 'class',
        kind: 'injects',
      }));
    }
    return;
  }

  for (const d of decorators) {
    const decoName = extractDecoratorName(d);
    if (decoName && !ROUTE_DECORATORS.has(decoName) && decoName !== 'receiver') {
      ctx.nodes.push(makeNode(ctx, {
        symbol: decoName,
        kind: 'decorator',
        parent_symbol: scope || null,
        start_line: d.startPosition.row + 1,
        end_line: d.endPosition.row + 1,
        exported: false,
        signature: d.text,
      }));
    }
  }

  if (def.type === 'function_definition') {
    handleFunction(def, scope, ctx);
  } else if (def.type === 'class_definition') {
    handleClass(def, scope, ctx);
  }
}

function isRouteDecorator(decoratorNode) {
  const call = decoratorNode.namedChildren[0];
  if (!call || call.type !== 'call_expression') return false;
  const func = call.childForFieldName('function');
  if (!func) return false;
  const name = func.type === 'attribute' ? func.childForFieldName('attribute')?.text : func.text;
  return ROUTE_DECORATORS.has(name);
}

function parseRouteDecorator(decoratorNode) {
  const call = decoratorNode.namedChildren[0];
  if (!call || call.type !== 'call_expression') return null;
  const func = call.childForFieldName('function');
  if (!func) return null;
  const name = func.type === 'attribute' ? func.childForFieldName('attribute')?.text : func.text;
  if (!ROUTE_DECORATORS.has(name)) return null;

  const args = call.childForFieldName('arguments');
  if (!args || args.namedChildren.length === 0) return { method: name.toUpperCase(), path: '/' };

  const firstArg = args.namedChildren[0];
  if (firstArg && firstArg.type === 'string') {
    const content = firstArg.namedChildren.find(n => n.type === 'string_content');
    return { method: name === 'route' ? 'GET' : name.toUpperCase(), path: content ? content.text : firstArg.text };
  }
  return { method: name.toUpperCase(), path: '/' };
}

function handleImport(node, ctx) {
  if (node.type === 'import_statement') {
    const moduleNode = node.namedChildren.find(n => n.type === 'dotted_name' || n.type === 'aliased_import');
    if (!moduleNode) return;
    const name = moduleNode.type === 'aliased_import'
      ? moduleNode.namedChildren.find(n => n.type === 'dotted_name')?.text
      : moduleNode.text;
    if (name) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: ctx.filePath,
        source_kind: 'file',
        target_symbol: name,
        target_kind: 'module',
        kind: 'imports',
      }));
      if (isLocalImport(name)) {
        ctx.edges.push(makeEdge(ctx, {
          source_symbol: ctx.filePath,
          source_kind: 'file',
          target_symbol: name,
          target_kind: 'module',
          kind: 'depends_on',
        }));
      }
    }
  } else if (node.type === 'import_from_statement') {
    const moduleNode = node.namedChildren.find(n => n.type === 'dotted_name' || n.type === 'relative_import');
    const name = moduleNode ? moduleNode.text : null;
    const names = node.namedChildren
      .filter(n => n.type === 'aliased_import')
      .map(n => n.namedChildren.find(c => c.type === 'identifier')?.text)
      .filter(Boolean);

    if (name) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: ctx.filePath,
        source_kind: 'file',
        target_symbol: name,
        target_kind: 'module',
        kind: 'imports',
        metadata: names.length ? { names } : undefined,
      }));
      if (isLocalImport(name)) {
        ctx.edges.push(makeEdge(ctx, {
          source_symbol: ctx.filePath,
          source_kind: 'file',
          target_symbol: name,
          target_kind: 'module',
          kind: 'depends_on',
        }));
      }
    }
  }
}

function isLocalImport(name) {
  return name.startsWith('.') || (!name.includes('.') && /^[a-z_]/.test(name));
}

function handleCall(node, scope, ctx) {
  const func = node.childForFieldName('function');
  if (!func) return;

  const funcText = func.text;

  // ORM query detection
  const isQuery = /\.(get|filter|all|first|create|update|delete|save|query|execute|select|insert)\s*\(/.test(funcText);
  if (isQuery && scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: funcText,
      target_kind: 'function',
      kind: 'queries',
    }));
  }

  // Template rendering detection
  if (/^(render_template|render|HttpResponse|TemplateResponse)$/.test(funcText) ||
      /\.(render_template|render|TemplateResponse)$/.test(funcText) ||
      /^HttpResponse$/.test(funcText)) {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'function',
        target_symbol: funcText,
        target_kind: 'function',
        kind: 'renders',
      }));
    }
  }

  // Event consumption detection
  if (/\bconnect\s*\(/.test(funcText) || /\bon_event\s*\(/.test(funcText) ||
      funcText.endsWith('.connect') || funcText === 'on_event') {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'function',
        target_symbol: funcText,
        target_kind: 'function',
        kind: 'consumes_event',
      }));
    }
  }

  // Dependency injection detection
  if (/\bDepends\s*\(/.test(funcText) || funcText === 'Depends') {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'function',
        target_symbol: funcText,
        target_kind: 'function',
        kind: 'injects',
      }));
    }
  }

  // Blueprint / router registration (provides)
  if (/\bregister_blueprint\s*\(/.test(funcText) || /\binclude_router\s*\(/.test(funcText)) {
    const args = node.childForFieldName('arguments');
    const firstArg = args?.namedChildren?.[0];
    if (firstArg && firstArg.type === 'identifier') {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope || ctx.filePath,
        source_kind: scope ? 'function' : 'file',
        target_symbol: firstArg.text,
        target_kind: 'function',
        kind: 'provides',
      }));
    }
  }

  // Event emit
  if (funcText.endsWith('.emit') || funcText.endsWith('send_event')) {
    const args = node.childForFieldName('arguments');
    const firstArg = args?.namedChildren?.[0];
    if (firstArg && firstArg.type === 'string') {
      const content = firstArg.namedChildren.find(n => n.type === 'string_content');
      const eventName = content ? content.text : firstArg.text;
      ctx.nodes.push(makeNode(ctx, {
        symbol: eventName,
        kind: 'event',
        parent_symbol: scope || null,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: false,
        signature: `emit('${eventName}')`,
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

  // env access
  if (funcText === 'os.getenv' || funcText === 'getenv') {
    const args = node.childForFieldName('arguments');
    const firstArg = args?.namedChildren?.[0];
    if (firstArg && firstArg.type === 'string') {
      const content = firstArg.namedChildren.find(n => n.type === 'string_content');
      const envKey = content ? content.text : firstArg.text;
      ctx.nodes.push(makeNode(ctx, {
        symbol: envKey,
        kind: 'env_var',
        parent_symbol: scope || null,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: false,
        signature: `os.getenv('${envKey}')`,
        metadata: { source: 'env' },
      }));
    }
  }

  if (scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: funcText,
      target_kind: 'function',
      kind: 'calls',
    }));
  }
}

function handleAssignment(node, scope, ctx) {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;

  // Pinia / Vuex store detection
  const isStore = right.type === 'call_expression' &&
    /defineStore|createStore|Store/.test(right.text);
  if (isStore) {
    const name = left.text;
    ctx.nodes.push(makeNode(ctx, {
      symbol: name,
      kind: 'store',
      parent_symbol: scope || null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: scope === null,
      signature: `${name} = defineStore(...)`,
    }));
  }

  // __all__ = [...] provides exports
  if (left.type === 'identifier' && left.text === '__all__') {
    if (right.type === 'list' || right.type === 'tuple') {
      for (const child of right.namedChildren) {
        let exportName = null;
        if (child.type === 'string') {
          const content = child.namedChildren.find(n => n.type === 'string_content');
          exportName = content ? content.text : child.text;
        } else if (child.type === 'identifier') {
          exportName = child.text;
        }
        if (exportName) {
          ctx.edges.push(makeEdge(ctx, {
            source_symbol: ctx.filePath,
            source_kind: 'file',
            target_symbol: exportName,
            target_kind: 'function',
            kind: 'provides',
          }));
        }
      }
    }
  }

  // os.environ detection
  if (left.text.startsWith('os.environ[')) {
    const keyMatch = left.text.match(/os\.environ\[(['"'])(.+?)\1\]/);
    if (keyMatch) {
      ctx.nodes.push(makeNode(ctx, {
        symbol: keyMatch[2],
        kind: 'env_var',
        parent_symbol: scope || null,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: false,
        signature: `os.environ['${keyMatch[2]}']`,
        metadata: { source: 'env' },
      }));
    }
  }
}

function walkBody(node, scope, ctx) {
  if (!node) return;
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), scope, ctx);
  }
}

function makeNode(ctx, fields) {
  return {
    subproject_id: ctx.subprojectId,
    path: ctx.filePath,
    lang: ctx.lang,
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

function extractPythonTypeReferences(node, symbol, sourceKind, ctx) {
  const params = node.childForFieldName('parameters');
  if (params) {
    for (let i = 0; i < params.namedChildCount; i++) {
      const param = params.namedChild(i);
      if (param.type === 'typed_parameter') {
        const typeNode = param.childForFieldName('type');
        if (typeNode) {
          const typeName = typeNode.text;
          if (!PYTHON_BUILTINS.has(typeName)) {
            ctx.edges.push(makeEdge(ctx, {
              source_symbol: symbol,
              source_kind: sourceKind,
              target_symbol: typeName,
              target_kind: 'class',
              kind: 'type_references',
            }));
          }
        }
      }
    }
  }

  const returnType = node.childForFieldName('return_type');
  if (returnType) {
    const typeName = returnType.text;
    if (!PYTHON_BUILTINS.has(typeName)) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: symbol,
        source_kind: sourceKind,
        target_symbol: typeName,
        target_kind: 'class',
        kind: 'type_references',
      }));
    }
  }
}

function extractDecoratorName(decoratorNode) {
  const child = decoratorNode.namedChildren[0];
  if (!child) return null;
  if (child.type === 'call_expression') {
    const func = child.childForFieldName('function');
    if (!func) return null;
    return func.type === 'attribute' ? func.childForFieldName('attribute')?.text : func.text;
  }
  if (child.type === 'identifier') return child.text;
  if (child.type === 'attribute') return child.childForFieldName('attribute')?.text || child.text;
  return null;
}

function extractLeadingDoc(node) {
  let prev = node.previousNamedSibling;
  if (!prev) prev = node.previousSibling;
  if (prev && prev.type === 'expression_statement') {
    const expr = prev.namedChildren[0];
    if (expr && expr.type === 'string') {
      const content = expr.namedChildren.find(n => n.type === 'string_content');
      return content ? content.text : expr.text;
    }
  }
  return null;
}
