export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const ctx = { filePath, subprojectId, lang: 'go', nodes, edges };

  // File-level migration detection
  if (/migrations\//.test(filePath)) {
    edges.push(makeEdge(ctx, {
      source_symbol: filePath,
      source_kind: 'file',
      target_symbol: 'migration',
      target_kind: 'migration',
      kind: 'migrates_table',
    }));
  }

  walk(tree.rootNode, null, ctx);

  return { nodes, edges };
}

function walk(node, scope, ctx) {
  switch (node.type) {
    case 'function_declaration':
      handleFunction(node, scope, ctx);
      return;
    case 'method_declaration':
      handleMethod(node, scope, ctx);
      return;
    case 'type_declaration':
      handleTypeDeclaration(node, scope, ctx);
      return;
    case 'import_declaration':
      handleImport(node, ctx);
      return;
    case 'call_expression':
      handleCall(node, scope, ctx);
      break;
    case 'type_assertion_expression':
      handleTypeAssertion(node, scope, ctx);
      break;
    case 'var_declaration':
      handleVarDeclaration(node, ctx);
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
  const result = node.childForFieldName('result');
  const signature = `func ${name}${params ? params.text : '()'}${result ? ' ' + result.text : ''}`;
  const doc = extractLeadingDoc(node);

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'function',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: /^[A-Z]/.test(name),
    signature,
    doc,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    // Channel consumer heuristic
    if (body.text.includes('<-')) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: name,
        source_kind: 'function',
        target_symbol: 'channel',
        target_kind: 'event',
        kind: 'consumes_event',
      }));
    }
    walkBody(body, name, ctx);
  }
}

function handleMethod(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const receiver = node.childForFieldName('receiver');
  let receiverType = null;
  if (receiver) {
    const param = receiver.namedChildren[0];
    if (param) {
      const typeNode = param.childForFieldName('type');
      receiverType = typeNode ? typeNode.text.replace(/^\*/, '') : null;
    }
  }

  const params = node.childForFieldName('parameters');
  const result = node.childForFieldName('result');
  const signature = `func (${receiverType || ''}) ${name}${params ? params.text : '()'}${result ? ' ' + result.text : ''}`;
  const doc = extractLeadingDoc(node);
  const symbol = receiverType ? `${receiverType}.${name}` : name;

  ctx.nodes.push(makeNode(ctx, {
    symbol,
    kind: 'method',
    parent_symbol: receiverType || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: /^[A-Z]/.test(name),
    signature,
    doc,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    walkBody(body, symbol, ctx);
  }
}

function handleTypeDeclaration(node, scope, ctx) {
  const spec = node.namedChildren.find(n => n.type === 'type_spec');
  if (!spec) return;

  const nameNode = spec.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const typeNode = spec.childForFieldName('type');
  if (!typeNode) return;

  const doc = extractLeadingDoc(node);

  if (typeNode.type === 'struct_type') {
    ctx.nodes.push(makeNode(ctx, {
      symbol: name,
      kind: 'class',
      parent_symbol: scope || null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: /^[A-Z]/.test(name),
      signature: `type ${name} struct`,
      doc,
    }));

    // Extract struct fields
    const fieldList = typeNode.childForFieldName('fields');
    if (fieldList) {
      for (const field of fieldList.namedChildren.filter(n => n.type === 'field_declaration')) {
        const fieldNames = field.namedChildren.filter(n => n.type === 'identifier' || n.type === 'field_identifier');
        const typeN = field.namedChildren.find(n => n.type === 'type_identifier' || n.type === 'qualified_type' || n.type === 'pointer_type');
        for (const fn of fieldNames) {
          ctx.nodes.push(makeNode(ctx, {
            symbol: `${name}.${fn.text}`,
            kind: 'property',
            parent_symbol: name,
            start_line: field.startPosition.row + 1,
            end_line: field.endPosition.row + 1,
            exported: /^[A-Z]/.test(fn.text),
            signature: `${fn.text} ${typeN ? typeN.text : ''}`,
          }));
        }
      }
    }
  } else if (typeNode.type === 'interface_type') {
    ctx.nodes.push(makeNode(ctx, {
      symbol: name,
      kind: 'interface',
      parent_symbol: scope || null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: /^[A-Z]/.test(name),
      signature: `type ${name} interface`,
      doc,
    }));

    const methods = typeNode.namedChildren.filter(n => n.type === 'method_spec');
    for (const m of methods) {
      const mName = m.childForFieldName('name')?.text;
      if (mName) {
        ctx.nodes.push(makeNode(ctx, {
          symbol: `${name}.${mName}`,
          kind: 'method',
          parent_symbol: name,
          start_line: m.startPosition.row + 1,
          end_line: m.endPosition.row + 1,
          exported: /^[A-Z]/.test(mName),
          signature: m.text,
        }));
      }
    }
  } else {
    ctx.nodes.push(makeNode(ctx, {
      symbol: name,
      kind: 'type_alias',
      parent_symbol: scope || null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: /^[A-Z]/.test(name),
      signature: `type ${name} ${typeNode.text}`,
      doc,
    }));
  }
}

function handleImport(node, ctx) {
  const spec = node.namedChildren.find(n => n.type === 'import_spec');
  if (!spec) {
    // import block
    const specList = node.namedChildren.find(n => n.type === 'import_spec_list');
    if (specList) {
      for (const s of specList.namedChildren.filter(n => n.type === 'import_spec')) {
        extractImportSpec(s, ctx);
      }
    }
    return;
  }
  extractImportSpec(spec, ctx);
}

function extractImportSpec(spec, ctx) {
  const pathNode = spec.childForFieldName('path');
  if (!pathNode) return;
  const rawPath = pathNode.text.replace(/^"|"$/g, '');
  const alias = spec.childForFieldName('name')?.text;

  ctx.edges.push(makeEdge(ctx, {
    source_symbol: ctx.filePath,
    source_kind: 'file',
    target_symbol: rawPath,
    target_kind: 'module',
    kind: 'imports',
    metadata: alias ? { alias } : undefined,
  }));

  if (!rawPath.includes('.') || rawPath.startsWith('.')) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: ctx.filePath,
      source_kind: 'file',
      target_symbol: rawPath,
      target_kind: 'module',
      kind: 'depends_on',
    }));
  }
}

function handleCall(node, scope, ctx) {
  const func = node.childForFieldName('function');
  if (!func) return;

  const funcText = func.text;

  // Template rendering detection
  if (/\.(Execute|ExecuteTemplate|Render)\s*\(/.test(funcText)) {
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

  // Channel consumer / event handler detection
  if (/\.(On|Handle|HandleFunc|AddHandler)\s*\(/.test(funcText)) {
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

  // Dependency injection / Wire patterns
  if (/\.(Build|Inject)\s*\(/.test(funcText) || /wire\.Build/.test(funcText)) {
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

  // Type reference via type assertion or conversion
  const typeAssertion = node.text.match(/\.(\([\w*]+\))\s*$/);
  if (typeAssertion && scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: typeAssertion[1].replace(/[()]/g, ''),
      target_kind: 'type_alias',
      kind: 'type_references',
    }));
  }

  // Route detection heuristics for Gin/Echo/Fiber
  if (/\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any)\s*\(/.test(funcText)) {
    const args = node.childForFieldName('arguments');
    const firstArg = args?.namedChildren?.[0];
    if (firstArg && firstArg.type === 'interpreted_string_literal') {
      const pathStr = firstArg.text.replace(/^"|"$/g, '');
      const method = funcText.match(/\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any)/)?.[1] || 'GET';
      const symbol = `${method} ${pathStr}`;

      ctx.nodes.push(makeNode(ctx, {
        symbol,
        kind: 'route',
        parent_symbol: scope || null,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: true,
        signature: `${funcText}('${pathStr}', ...)`,
        metadata: { method, path: pathStr },
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

  // DB query detection
  if (/\.(Query|Exec|QueryRow|Get|Select|Insert|Update|Delete|Create|Find|First|Where)\s*\(/.test(funcText)) {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'function',
        target_symbol: funcText,
        target_kind: 'function',
        kind: 'queries',
      }));
    }
  }

  // Migration detection
  if (/\.(Up|Down|Migrate|RunMigrations)\s*\(/.test(funcText)) {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'function',
        target_symbol: funcText,
        target_kind: 'function',
        kind: 'migrates_table',
      }));
    }
  }

  // os.Getenv
  if (funcText === 'os.Getenv') {
    const args = node.childForFieldName('arguments');
    const firstArg = args?.namedChildren?.[0];
    if (firstArg && firstArg.type === 'interpreted_string_literal') {
      const envKey = firstArg.text.replace(/^"|"$/g, '');
      ctx.nodes.push(makeNode(ctx, {
        symbol: envKey,
        kind: 'env_var',
        parent_symbol: scope || null,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: false,
        signature: `os.Getenv("${envKey}")`,
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

function handleTypeAssertion(node, scope, ctx) {
  const typeNode = node.childForFieldName('type');
  if (typeNode && scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: typeNode.text,
      target_kind: 'type_alias',
      kind: 'type_references',
    }));
  }
}

function handleVarDeclaration(node, ctx) {
  const text = node.text;
  const match = text.match(/var\s+_\s+(\w+)\s*=\s*\(\*(\w+)\)\(nil\)/);
  if (match) {
    const iface = match[1];
    const structName = match[2];
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: structName,
      source_kind: 'class',
      target_symbol: iface,
      target_kind: 'interface',
      kind: 'provides',
    }));
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

function extractLeadingDoc(node) {
  let prev = node.previousNamedSibling;
  if (!prev) prev = node.previousSibling;
  if (prev && prev.type === 'comment') {
    return prev.text.replace(/^\/\/\s?/gm, '').trim();
  }
  return null;
}
