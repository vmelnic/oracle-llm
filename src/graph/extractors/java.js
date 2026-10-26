export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const ctx = { filePath, subprojectId, lang: 'java', nodes, edges };

  // Migration file detection
  if (/db\/migration\//.test(filePath) || /db\/changelog\//.test(filePath)) {
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
    case 'method_declaration':
      handleMethod(node, scope, ctx);
      return;
    case 'class_declaration':
      handleClass(node, scope, ctx);
      return;
    case 'interface_declaration':
      handleInterface(node, scope, ctx);
      return;
    case 'enum_declaration':
      handleEnum(node, scope, ctx);
      return;
    case 'import_declaration':
      handleImport(node, ctx);
      return;
    case 'annotation':
      handleAnnotation(node, scope, ctx);
      return;
    case 'method_invocation':
      handleMethodInvocation(node, scope, ctx);
      return;
    case 'object_creation_expression':
      handleObjectCreation(node, scope, ctx);
      return;
    default:
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), scope, ctx);
  }
}

function handleClass(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const superClass = node.childForFieldName('superclass')?.text || null;
  const interfaces = [];
  const implementsClause = node.childForFieldName('interfaces');
  if (implementsClause) {
    for (const child of implementsClause.namedChildren) {
      if (child.type === 'type_list') {
        for (const t of child.namedChildren) {
          interfaces.push(t.text);
        }
      }
    }
  }

  const doc = extractLeadingDoc(node);
  const metadata = {};
  if (superClass) metadata.extends = superClass;
  if (interfaces.length) metadata.implements = interfaces;

  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'class',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `class ${name}`,
    doc,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  }));

  if (superClass) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: superClass,
      target_kind: 'class',
      kind: 'extends',
    }));
  }

  for (const iface of interfaces) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: iface,
      target_kind: 'interface',
      kind: 'implements',
    }));
  }

  // Migration class detection
  if (superClass === 'BaseJavaMigration' || /db\/migration\//.test(ctx.filePath)) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: 'migration',
      target_kind: 'migration',
      kind: 'migrates_table',
    }));
  }

  // ApplicationListener event consumer detection
  if (interfaces.some(i => i.includes('ApplicationListener')) || superClass?.includes('ApplicationListener')) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: name,
      source_kind: 'class',
      target_symbol: 'ApplicationListener',
      target_kind: 'interface',
      kind: 'consumes_event',
    }));
  }

  // Injection detection on fields and constructor parameters
  const injectAnnotations = ['Autowired', 'Inject', 'Resource'];
  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child.type === 'field_declaration') {
        const hasInject = child.namedChildren
          .filter(n => n.type === 'modifiers')
          .some(m => m.namedChildren.some(ann => {
            if (ann.type !== 'annotation') return false;
            const annName = ann.namedChildren.find(n => n.type === 'identifier' || n.type === 'scoped_identifier')?.text;
            return injectAnnotations.includes(annName);
          }));
        if (hasInject) {
          const fieldType = child.childForFieldName('type')?.text;
          if (fieldType) {
            ctx.edges.push(makeEdge(ctx, {
              source_symbol: name,
              source_kind: 'class',
              target_symbol: fieldType,
              target_kind: 'class',
              kind: 'injects',
            }));
          }
        }
      }
      if (child.type === 'constructor_declaration') {
        const params = child.childForFieldName('parameters');
        if (params) {
          for (let j = 0; j < params.namedChildCount; j++) {
            const param = params.namedChild(j);
            if (param.type === 'formal_parameter') {
              const hasInject = param.namedChildren
                .filter(n => n.type === 'modifiers')
                .some(m => m.namedChildren.some(ann => {
                  if (ann.type !== 'annotation') return false;
                  const annName = ann.namedChildren.find(n => n.type === 'identifier' || n.type === 'scoped_identifier')?.text;
                  return injectAnnotations.includes(annName);
                }));
              if (hasInject) {
                const paramType = param.childForFieldName('type')?.text;
                if (paramType) {
                  ctx.edges.push(makeEdge(ctx, {
                    source_symbol: name,
                    source_kind: 'class',
                    target_symbol: paramType,
                    target_kind: 'class',
                    kind: 'injects',
                  }));
                }
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < body.childCount; i++) {
      walk(body.child(i), name, ctx);
    }
  }
}

function handleInterface(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const doc = extractLeadingDoc(node);
  ctx.nodes.push(makeNode(ctx, {
    symbol: name,
    kind: 'interface',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: true,
    signature: `interface ${name}`,
    doc,
  }));

  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      walk(body.child(i), name, ctx);
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
    for (const constDecl of body.namedChildren.filter(n => n.type === 'enum_constant')) {
      const cName = constDecl.childForFieldName('name')?.text;
      if (cName) {
        ctx.nodes.push(makeNode(ctx, {
          symbol: `${name}.${cName}`,
          kind: 'property',
          parent_symbol: name,
          start_line: constDecl.startPosition.row + 1,
          end_line: constDecl.endPosition.row + 1,
          exported: true,
          signature: cName,
        }));
      }
    }
  }
}

function handleMethod(node, scope, ctx) {
  const nameNode = node.childForFieldName('name');
  const name = nameNode ? nameNode.text : null;
  if (!name) return;

  const params = node.childForFieldName('parameters');
  const typeNode = node.childForFieldName('type');
  const modifiers = node.namedChildren.filter(n => n.type === 'modifiers');
  const isStatic = modifiers.some(m => m.text.includes('static'));
  const isPublic = !modifiers.some(m => m.text.includes('private'));

  const symbol = scope ? `${scope}.${name}` : name;
  const signature = `${isStatic ? 'static ' : ''}${typeNode ? typeNode.text + ' ' : ''}${name}${params ? params.text : '()'}`;
  const doc = extractLeadingDoc(node);

  ctx.nodes.push(makeNode(ctx, {
    symbol,
    kind: 'method',
    parent_symbol: scope || null,
    start_line: node.startPosition.row + 1,
    end_line: node.endPosition.row + 1,
    exported: isPublic,
    signature,
    doc,
    metadata: isStatic ? { static: true } : undefined,
  }));

  // onApplicationEvent event consumer
  if (name === 'onApplicationEvent' && scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: symbol,
      source_kind: 'method',
      target_symbol: 'application_event',
      target_kind: 'event',
      kind: 'consumes_event',
    }));
  }

  // @Bean provides detection
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'annotation') {
    const annoName = prev.namedChildren.find(n => n.type === 'identifier' || n.type === 'scoped_identifier')?.text;
    if (annoName === 'Bean' && typeNode) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: symbol,
        source_kind: 'method',
        target_symbol: typeNode.text,
        target_kind: 'class',
        kind: 'provides',
      }));
    }
    prev = prev.previousNamedSibling;
  }

  // Extract generic type references from parameters and return type
  if (params) {
    for (let i = 0; i < params.namedChildCount; i++) {
      const child = params.namedChild(i);
      if (child.type === 'formal_parameter') {
        const tNode = child.childForFieldName('type');
        if (tNode) collectJavaTypeReferences(tNode, symbol, ctx);
      }
    }
  }
  if (typeNode) {
    collectJavaTypeReferences(typeNode, symbol, ctx);
  }

  const body = node.childForFieldName('body');
  if (body) {
    walkBody(body, symbol, ctx);
  }
}

function handleImport(node, ctx) {
  const decl = node.namedChildren.find(n => n.type === 'scoped_identifier' || n.type === 'identifier' || n.type === 'asterisk');
  if (!decl) return;

  const name = decl.text;
  ctx.edges.push(makeEdge(ctx, {
    source_symbol: ctx.filePath,
    source_kind: 'file',
    target_symbol: name,
    target_kind: 'module',
    kind: 'imports',
  }));

  // Local package imports
  const pkgRoot = name.split('.')[0];
  if (pkgRoot && /^[a-z]/.test(pkgRoot) && !['java', 'javax', 'jakarta', 'org', 'com', 'io', 'android', 'kotlin'].includes(pkgRoot)) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: ctx.filePath,
      source_kind: 'file',
      target_symbol: name,
      target_kind: 'module',
      kind: 'depends_on',
    }));
  }
}

function handleAnnotation(node, scope, ctx) {
  const nameNode = node.namedChildren.find(n => n.type === 'identifier' || n.type === 'scoped_identifier');
  if (!nameNode) return;
  const name = nameNode.text;

  // Spring route detection
  if (name === 'GetMapping' || name === 'PostMapping' || name === 'PutMapping' ||
      name === 'DeleteMapping' || name === 'PatchMapping' || name === 'RequestMapping') {
    const args = node.namedChildren.find(n => n.type === 'annotation_argument_list');
    let routePath = '/';
    if (args) {
      const stringArg = args.namedChildren.find(n => n.type === 'string_literal');
      if (stringArg) {
        routePath = stringArg.text.replace(/^"|"$/g, '');
      }
    }

    const methodMap = {
      GetMapping: 'GET',
      PostMapping: 'POST',
      PutMapping: 'PUT',
      DeleteMapping: 'DELETE',
      PatchMapping: 'PATCH',
      RequestMapping: 'GET',
    };
    const method = methodMap[name] || 'GET';
    const symbol = `${method} ${routePath}`;

    ctx.nodes.push(makeNode(ctx, {
      symbol,
      kind: 'route',
      parent_symbol: scope || null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `@${name}("${routePath}")`,
      metadata: { method, path: routePath, framework: 'spring' },
    }));

    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'class',
        target_symbol: symbol,
        target_kind: 'route',
        kind: 'serves_route',
      }));
    }
  }

  // JAX-RS route detection
  if (name === 'GET' || name === 'POST' || name === 'PUT' || name === 'DELETE' || name === 'PATCH') {
    const args = node.namedChildren.find(n => n.type === 'annotation_argument_list');
    let routePath = '/';
    if (args) {
      const stringArg = args.namedChildren.find(n => n.type === 'string_literal');
      if (stringArg) {
        routePath = stringArg.text.replace(/^"|"$/g, '');
      }
    }
    const method = name.toUpperCase();
    const symbol = `${method} ${routePath}`;

    ctx.nodes.push(makeNode(ctx, {
      symbol,
      kind: 'route',
      parent_symbol: scope || null,
      start_line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      exported: true,
      signature: `@${name}("${routePath}")`,
      metadata: { method, path: routePath, framework: 'jaxrs' },
    }));

    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'class',
        target_symbol: symbol,
        target_kind: 'route',
        kind: 'serves_route',
      }));
    }
  }

  // Event listener annotations
  if (name === 'EventListener' || name === 'TransactionalEventListener') {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'class',
        target_symbol: 'event',
        target_kind: 'event',
        kind: 'consumes_event',
      }));
    }
  }

  // Dependency injection annotations
  if (name === 'Autowired' || name === 'Inject' || name === 'Resource') {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'class',
        target_symbol: 'dependency',
        target_kind: 'class',
        kind: 'injects',
      }));
    }
  }

  // Service/provider annotations
  if (name === 'Service' || name === 'Component' || name === 'Repository') {
    if (scope) {
      ctx.edges.push(makeEdge(ctx, {
        source_symbol: scope,
        source_kind: 'class',
        target_symbol: scope,
        target_kind: 'class',
        kind: 'provides',
      }));
    }
  }
}

function handleMethodInvocation(node, scope, ctx) {
  const name = node.childForFieldName('name')?.text;
  const object = node.childForFieldName('object')?.text;
  const funcText = object ? `${object}.${name}` : name;

  if (!funcText) return;

  // DB query detection
  if (/\.(query|execute|find|select|insert|update|delete|get|save|createQuery)\s*\(/.test(funcText)) {
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
  if (funcText === 'ResponseEntity.ok' || /ModelAndView/.test(funcText)) {
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

function handleObjectCreation(node, scope, ctx) {
  const typeNode = node.childForFieldName('type');
  if (typeNode && scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: typeNode.text,
      target_kind: 'class',
      kind: 'calls',
      metadata: { type: 'instantiation' },
    }));
  }

  // ModelAndView creation (renders)
  if (typeNode && typeNode.text === 'ModelAndView' && scope) {
    ctx.edges.push(makeEdge(ctx, {
      source_symbol: scope,
      source_kind: 'function',
      target_symbol: 'ModelAndView',
      target_kind: 'class',
      kind: 'renders',
    }));
  }

  // Generic type references in object creation
  if (typeNode) {
    collectJavaTypeReferences(typeNode, scope || ctx.filePath, ctx);
  }
}

function collectJavaTypeReferences(typeNode, symbol, ctx) {
  const seen = new Set();
  function walkTypes(n) {
    if (n.type === 'type_arguments') {
      for (let i = 0; i < n.namedChildCount; i++) {
        const child = n.namedChild(i);
        if ((child.type === 'type_identifier' || child.type === 'scoped_type_identifier') && !seen.has(child.text)) {
          seen.add(child.text);
          ctx.edges.push(makeEdge(ctx, {
            source_symbol: symbol,
            source_kind: 'function',
            target_symbol: child.text,
            target_kind: 'class',
            kind: 'type_references',
          }));
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      walkTypes(n.child(i));
    }
  }
  walkTypes(typeNode);
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
  if (prev && prev.type === 'block_comment') {
    return prev.text;
  }
  return null;
}
