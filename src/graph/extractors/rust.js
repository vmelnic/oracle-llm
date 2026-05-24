export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const ctx = { filePath, subprojectId, lang: 'rust', nodes, edges };

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
    case 'function_item':
      handleFunction(node, scope, ctx);
      return;
    case 'impl_item':
      handleImpl(node, scope, ctx);
      return;
    case 'trait_item':
      handleTrait(node, scope, ctx);
      return;
    case 'struct_item':
      handleStruct(node, scope, ctx);
      return;
    case 'enum_item':
      handleEnum(node, scope, ctx);
      return;
    case 'type_item':
      handleTypeAlias(node, scope, ctx);
      return;
    case 'use_declaration':
      handleUse(node, ctx);
      return;
    case 'macro_invocation':
      handleMacro(node, scope, ctx);
      return;
    case 'call_expression':
      handleCall(node, scope, ctx);
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
  const returnType = node.childForFieldName('return_type');
  const signature = `fn ${name}${params ? params.text : '()'}${returnType ? ' -> ' + returnType.text : ''}`;
  const doc = extractLeadingDoc(node);
  const symbol = scope ? `${scope}::${name}` : name;

  ctx.nodes.push(makeNode(ctx, {
    symbol,
    kind: 'function',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature,
    doc,
  }));

  // Extract generic type references
  const typeParams = node.childForFieldName('type_parameters');
  if (typeParams) {
    const referencedTypes = new Set();
    for (let i = 0; i < typeParams.namedChildCount; i++) {
      const tp = typeParams.namedChild(i);
      if (tp.type === 'type_parameter') {
        for (let j = 0; j < tp.namedChildCount; j++) {
          const bound = tp.namedChild(j);
          if (bound.type === 'type_identifier' || bound.type === 'scoped_type_identifier') {
            referencedTypes.add(bound.text);
          }
        }
      }
    }
    for (const t of referencedTypes) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: symbol,
        source_kind: 'function',
        target_symbol: t,
        target_kind: 'trait',
        kind: 'type_references',
      }));
    }
  }

  const body = node.childForFieldName('body');
  if (body) {
    walkBody(body, symbol, ctx);
  }
}

function handleImpl(node, scope, ctx) {
  const typeNode = node.childForFieldName('type');
  const traitNode = node.childForFieldName('trait');
  const typeName = typeNode ? typeNode.text : null;
  const traitName = traitNode ? traitNode.text : null;

  if (traitName && typeName) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: typeName,
      source_kind: 'class',
      target_symbol: traitName,
      target_kind: 'trait',
      kind: 'implements',
    }));
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: typeName,
      source_kind: 'class',
      target_symbol: traitName,
      target_kind: 'trait',
      kind: 'provides',
    }));
  }

  // Migration trait detection
  if (traitName && /Migration/.test(traitName)) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: typeName,
      source_kind: 'class',
      target_symbol: traitName,
      target_kind: 'trait',
      kind: 'migrates_table',
    }));
  }

  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child.type === 'function_item') {
        handleFunction(child, typeName, ctx);
      } else if (child.type === 'const_item') {
        handleConst(child, typeName, ctx);
      }
    }
  }
}

function handleTrait(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const doc = extractLeadingDoc(node);
  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'trait',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `trait ${name}`,
    doc,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child.type === 'function_item') {
        handleFunction(child, name, ctx);
      } else if (child.type === 'const_item') {
        handleConst(child, name, ctx);
      } else if (child.type === 'type_item') {
        handleTypeAlias(child, name, ctx);
      }
    }
  }
}

function handleStruct(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const doc = extractLeadingDoc(node);
  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'class',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `struct ${name}`,
    doc,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    for (const field of body.namedChildren.filter(n => n.type === 'field_declaration')) {
      const fieldName = field.childForFieldName('name')?.text;
      const fieldType = field.childForFieldName('type')?.text;
      if (fieldName) {
        ctx.nodes.push(makeNode(ctx, {
          symbol: `${name}::${fieldName}`,
          kind: 'property',
          parent_symbol: name,
          start_line: field.startPosition.row + 1,
          end_line: field.endPosition.row + 1,
          exported: true,
          signature: `${fieldName}: ${fieldType || ''}`,
        }));
      }
    }
  }
}

function handleEnum(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const doc = extractLeadingDoc(node);
  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'enum',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `enum ${name}`,
    doc,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    for (const variant of body.namedChildren.filter(n => n.type === 'enum_variant')) {
      const vName = variant.childForFieldName('name')?.text;
      if (vName) {
        ctx.nodes.push(makeNode(ctx, {
          symbol: `${name}::${vName}`,
          kind: 'property',
          parent_symbol: name,
          start_line: variant.startPosition.row + 1,
          end_line: variant.endPosition.row + 1,
          exported: true,
          signature: vName,
        }));
      }
    }
  }
}

function handleTypeAlias(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const typeNode = node.childForFieldName('type');
  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'type_alias',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `type ${name} = ${typeNode ? typeNode.text : ''}`,
  }));
}

function handleConst(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  ctx.nodes.push(makeNode(ctx, {
    symbol: scope ? `${scope}::${name}` : name,
    kind: 'property',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `const ${name}`,
  }));
}

function handleUse(node, ctx) {
  const arg = node.childForFieldName('argument');
  if (!arg) return;

  const isPub = node.text.startsWith('pub use') || node.text.startsWith('pub mod');

  const paths = [];
  if (arg.type === 'use_list') {
    for (const child of arg.namedChildren) {
      if (child.type === 'identifier' || child.type === 'scoped_identifier') {
        paths.push(child.text);
      }
    }
  } else {
    paths.push(arg.text);
  }

  for (const p of paths) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: ctx.filePath,
      source_kind: 'file',
      target_symbol: p,
      target_kind: 'module',
      kind: 'imports',
    }));
    if (p.startsWith('crate::') || p.startsWith('super::') || p.startsWith('self::')) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: ctx.filePath,
        source_kind: 'file',
        target_symbol: p,
        target_kind: 'module',
        kind: 'depends_on',
      }));
    }
    if (isPub) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: ctx.filePath,
        source_kind: 'file',
        target_symbol: p,
        target_kind: 'module',
        kind: 'provides',
      }));
    }
  }
}

function handleMacro(node, scope, ctx) {
  const macro = node.childForFieldName('macro');
  if (!macro) return;
  const name = macro.text;

  // Route detection for Actix / Axum / Rocket macros
  if (name === 'get' || name === 'post' || name === 'put' || name === 'delete' || name === 'patch') {
    const tokenTree = node.childForFieldName('token_tree');
    if (tokenTree) {
      const first = tokenTree.namedChildren[0];
      if (first && first.type === 'string_literal') {
        const pathStr = first.text.replace(/^"|"$/g, '');
        const method = name.toUpperCase();
        const symbol = `${method} ${pathStr}`;

        ctx.nodes.push(makeNode(ctx, {
          symbol,
          kind: 'route',
          parent_symbol: scope || null,
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          exported: true,
          signature: `#[${name}("${pathStr}")]`,
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
  }
}

function handleCall(node, scope, ctx) {
  const func = node.childForFieldName('function');
  if (!func) return;

  const funcText = func.text;

  // DB query detection
  if (/\.(query|execute|fetch|find|select|insert|update|delete|get)\s*\(/.test(funcText)) {
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

  // Template rendering detection
  if (/\.render\s*\(/.test(funcText) || /tera\.render/.test(funcText) ||
      /handlebars\.render/.test(funcText) || /Template::render/.test(funcText)) {
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
  if (/\.on\s*\(/.test(funcText) || /\.emit\s*\(/.test(funcText)) {
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

  // Dependency injection detection (Actix web::Data<Dep>)
  const dataMatch = node.text.match(/Data<\s*(\w+(?:::\w+)*)\s*>/);
  if (dataMatch && scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: dataMatch[1],
      target_kind: 'class',
      kind: 'injects',
    }));
  }

  // env::var
  if (funcText === 'std::env::var' || funcText === 'env::var') {
    const args = node.childForFieldName('arguments');
    const firstArg = args?.namedChildren?.[0];
    if (firstArg && firstArg.type === 'string_literal') {
      const envKey = firstArg.text.replace(/^"|"$/g, '');
      ctx.nodes.push(makeNode(ctx, {
        symbol: envKey,
        kind: 'env_var',
        parent_symbol: scope || null,
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: false,
        signature: `env::var("${envKey}")`,
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
  if (prev && prev.type === 'line_comment') {
    return prev.text.replace(/^\/\/\s?/gm, '').trim();
  }
  if (prev && prev.type === 'block_comment') {
    return prev.text.replace(/^\/\*\*?\s?|\*\/$/gm, '').replace(/^\s*\*\s?/gm, '').trim();
  }
  return null;
}
