import { basename } from 'node:path';

const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base',
  'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section', 'select', 'slot',
  'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
  'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

const SVG_TAGS = new Set([
  'svg', 'circle', 'clipPath', 'defs', 'ellipse', 'g', 'line', 'linearGradient',
  'mask', 'path', 'pattern', 'polygon', 'polyline', 'radialGradient', 'rect',
  'stop', 'symbol', 'text', 'textPath', 'tspan', 'use',
]);

function toPascalCase(str) {
  if (!str) return str;
  if (/^[A-Z]/.test(str) && !str.includes('-')) return str;
  return str
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function isComponentTag(tag) {
  if (!tag) return false;
  if (HTML_TAGS.has(tag.toLowerCase()) || SVG_TAGS.has(tag)) return false;
  if (tag.startsWith('Transition') || tag.startsWith('KeepAlive') || tag === 'Teleport' || tag === 'Suspense') return false;
  return tag.includes('-') || /^[A-Z]/.test(tag);
}

function walk(node, visitor) {
  const result = visitor(node);
  if (result === false) return;
  for (let i = 0; i < node.namedChildCount; i++) {
    walk(node.namedChild(i), visitor);
  }
}

function findFirst(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child.type === type) return child;
  }
  return null;
}

function componentNameFromPath(filePath) {
  const name = basename(filePath, '.vue');
  return toPascalCase(name);
}

function getScriptContent(tree) {
  let scriptText = null;
  let isSetup = false;

  walk(tree.rootNode, (node) => {
    if (node.type === 'script_element') {
      const startTag = findFirst(node, 'start_tag');
      if (startTag) {
        const tagText = startTag.text;
        if (tagText.includes('setup')) isSetup = true;
      }
      const rawText = findFirst(node, 'raw_text');
      if (rawText) scriptText = rawText.text;
      return false;
    }
  });

  return { text: scriptText, isSetup };
}

function getTemplateNode(tree) {
  let templateNode = null;
  walk(tree.rootNode, (node) => {
    if (node.type === 'template_element') {
      templateNode = node;
      return false;
    }
  });
  return templateNode;
}

function extractImportsFromScript(scriptText) {
  const imports = [];
  const re = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)?\s*from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(scriptText))) {
    const specifiers = [];
    const specMatch = scriptText.substring(match.index, match.index + match[0].length);

    const defaultMatch = specMatch.match(/import\s+(\w+)/);
    if (defaultMatch && defaultMatch[1] !== 'type') {
      specifiers.push(defaultMatch[1]);
    }

    const namedMatch = specMatch.match(/\{([^}]+)\}/);
    if (namedMatch) {
      namedMatch[1].split(',').forEach(s => {
        const name = s.trim().split(/\s+as\s+/).pop().trim();
        if (name) specifiers.push(name);
      });
    }

    imports.push({ source: match[1], specifiers });
  }
  return imports;
}

function extractDefineProps(scriptText) {
  const withDefaultsMatch = scriptText.match(/withDefaults\s*\(\s*defineProps\s*<\s*\{([^}]*)\}\s*>/s);
  if (withDefaultsMatch) {
    return parseTypeProps(withDefaultsMatch[1]);
  }

  const genericMatch = scriptText.match(/defineProps\s*<\s*\{([^}]*)\}\s*>/s);
  if (genericMatch) {
    return parseTypeProps(genericMatch[1]);
  }

  const callMatch = scriptText.match(/defineProps\s*\(\s*(\{[\s\S]*?\})\s*\)/);
  if (callMatch) {
    return parseObjectProps(callMatch[1]);
  }

  const arrayMatch = scriptText.match(/defineProps\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  if (arrayMatch) {
    return arrayMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .map(name => ({ name, type: null }));
  }

  return [];
}

function extractOptionsApiProps(scriptText) {
  const propsMatch = scriptText.match(/props\s*:\s*(\{[\s\S]*?\})\s*[,\n]/);
  if (propsMatch) return parseObjectProps(propsMatch[1]);

  const arrayMatch = scriptText.match(/props\s*:\s*\[([\s\S]*?)\]/);
  if (arrayMatch) {
    return arrayMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .map(name => ({ name, type: null }));
  }
  return [];
}

function parseTypeProps(typeStr) {
  const props = [];
  const re = /(\w+)\s*(\?)?\s*:\s*([^;\n,]+)/g;
  let match;
  while ((match = re.exec(typeStr))) {
    props.push({ name: match[1], type: match[3].trim(), required: !match[2] });
  }
  return props;
}

function parseObjectProps(objStr) {
  const props = [];
  const re = /(\w+)\s*:/g;
  let match;
  while ((match = re.exec(objStr))) {
    const name = match[1];
    if (['type', 'default', 'required', 'validator'].includes(name)) continue;
    props.push({ name, type: null });
  }
  return props;
}

function extractDefineEmits(scriptText) {
  const genericMatch = scriptText.match(/defineEmits\s*<\s*\{([^}]*)\}\s*>/s);
  if (genericMatch) {
    const events = [];
    const re = /\(\s*e\s*:\s*['"](\w+)['"]/g;
    let match;
    while ((match = re.exec(genericMatch[1]))) events.push(match[1]);
    return events;
  }

  const arrayMatch = scriptText.match(/defineEmits\s*\(\s*\[([\s\S]*?)\]\s*\)/);
  if (arrayMatch) {
    return arrayMatch[1]
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  return [];
}

function extractOptionsApiEmits(scriptText) {
  const emitsMatch = scriptText.match(/emits\s*:\s*\[([\s\S]*?)\]/);
  if (!emitsMatch) return [];
  return emitsMatch[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function extractMethods(scriptText, isSetup) {
  const methods = [];

  if (isSetup) {
    const funcRe = /(?:^|\n)\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?.*?\)?\s*=>/gm;
    let match;
    while ((match = funcRe.exec(scriptText))) {
      methods.push({ name: match[1], async: scriptText.substring(match.index, match.index + match[0].length).includes('async') });
    }

    const declRe = /(?:^|\n)\s*(?:async\s+)?function\s+(\w+)\s*\(/gm;
    while ((match = declRe.exec(scriptText))) {
      methods.push({ name: match[1], async: scriptText.substring(match.index, match.index + match[0].length).includes('async') });
    }
  } else {
    const methodsBlock = scriptText.match(/methods\s*:\s*\{([\s\S]*?)\n\s*\}/);
    if (methodsBlock) {
      const re = /(?:async\s+)?(\w+)\s*\(/g;
      let match;
      while ((match = re.exec(methodsBlock[1]))) {
        methods.push({ name: match[1], async: methodsBlock[1].substring(match.index, match.index + match[0].length).includes('async') });
      }
    }
  }

  return methods;
}

function extractComposableCalls(scriptText) {
  const composables = [];
  const re = /\b(use[A-Z]\w*)\s*\(/g;
  let match;
  while ((match = re.exec(scriptText))) {
    composables.push(match[1]);
  }
  return [...new Set(composables)];
}

function extractStoreCalls(scriptText) {
  const stores = [];

  const piniaRe = /\b(use\w+Store)\s*\(/g;
  let match;
  while ((match = piniaRe.exec(scriptText))) {
    stores.push({ name: match[1], type: 'pinia' });
  }

  if (/\buseStore\s*\(/.test(scriptText)) {
    stores.push({ name: 'useStore', type: 'vuex' });
  }

  const vuexHelpers = ['mapState', 'mapGetters', 'mapActions', 'mapMutations'];
  for (const helper of vuexHelpers) {
    if (new RegExp(`\\b${helper}\\s*\\(`).test(scriptText)) {
      stores.push({ name: helper, type: 'vuex' });
    }
  }

  return stores;
}

function extractEmitCalls(scriptText) {
  const events = new Set();
  const re1 = /\$emit\s*\(\s*['"](\w+)['"]/g;
  let match;
  while ((match = re1.exec(scriptText))) events.add(match[1]);

  const re2 = /emit\s*\(\s*['"](\w+)['"]/g;
  while ((match = re2.exec(scriptText))) events.add(match[1]);

  return [...events];
}

function extractTemplateComponents(templateNode) {
  const components = new Set();
  if (!templateNode) return components;

  walk(templateNode, (node) => {
    if (node.type === 'start_tag' || node.type === 'self_closing_tag') {
      const tagNameNode = findFirst(node, 'tag_name');
      if (tagNameNode) {
        const tag = tagNameNode.text;
        if (isComponentTag(tag)) {
          components.add(toPascalCase(tag));
        }
      }
    }
  });

  return components;
}

function extractTemplateEvents(templateNode) {
  const consumed = [];
  if (!templateNode) return { consumed };

  walk(templateNode, (node) => {
    if (node.type === 'directive_attribute') {
      const nameNode = findFirst(node, 'directive_name');
      if (!nameNode) return;
      const name = nameNode.text;

      if (name === 'on' || name.startsWith('@')) {
        const argNode = findFirst(node, 'directive_argument');
        if (argNode) {
          consumed.push(argNode.text);
        }
      }
    }
  });

  return { consumed };
}

function extractTemplateEmitCalls(templateNode) {
  const events = new Set();
  if (!templateNode) return events;

  walk(templateNode, (node) => {
    if (node.type === 'raw_text' || node.type === 'attribute_value') {
      const text = node.text;
      const re = /\$emit\s*\(\s*['"](\w+)['"]/g;
      let match;
      while ((match = re.exec(text))) events.add(match[1]);
    }
    if (node.type === 'interpolation') {
      const rawText = findFirst(node, 'raw_text');
      if (rawText) {
        const re = /\$emit\s*\(\s*['"](\w+)['"]/g;
        let match;
        while ((match = re.exec(rawText.text))) events.add(match[1]);
      }
    }
  });

  return events;
}

function detectApi(scriptText, isSetup) {
  if (isSetup) return 'composition';
  if (/defineComponent\s*\(/.test(scriptText) && /setup\s*\(/.test(scriptText)) return 'composition';
  if (/export\s+default\s+\{/.test(scriptText)) return 'options';
  return 'composition';
}

function makeNode(subprojectId, path, symbol, kind, opts = {}) {
  return {
    subproject_id: subprojectId,
    path,
    lang: 'vue',
    symbol,
    kind,
    parent_symbol: opts.parent_symbol ?? null,
    start_line: opts.start_line ?? 0,
    end_line: opts.end_line ?? 0,
    exported: opts.exported ?? true,
    signature: opts.signature ?? null,
    doc: opts.doc ?? null,
    metadata: opts.metadata ?? null,
  };
}

function makeEdge(subprojectId, sourcePath, source, target, edgeKind, meta = null) {
  return {
    subproject_id: subprojectId,
    source_symbol: source.symbol,
    source_kind: source.kind,
    source_path: sourcePath,
    target_symbol: target.symbol,
    target_kind: target.kind,
    kind: edgeKind,
    metadata: meta,
  };
}

export function extract(tree, filePath, subprojectId) {
  const nodes = [];
  const edges = [];
  const componentName = componentNameFromPath(filePath);

  const script = getScriptContent(tree);
  const scriptText = script.text || '';
  const isSetup = script.isSetup;
  const templateNode = getTemplateNode(tree);

  const api = detectApi(scriptText, isSetup);

  const props = isSetup || api === 'composition'
    ? extractDefineProps(scriptText)
    : extractOptionsApiProps(scriptText);

  const emitsDeclared = isSetup || api === 'composition'
    ? extractDefineEmits(scriptText)
    : extractOptionsApiEmits(scriptText);

  const scriptEmitCalls = extractEmitCalls(scriptText);
  const templateEmitCalls = extractTemplateEmitCalls(templateNode);
  const allEmits = [...new Set([...emitsDeclared, ...scriptEmitCalls, ...templateEmitCalls])];

  nodes.push(makeNode(subprojectId, filePath, componentName, 'component', {
    start_line: 1,
    end_line: tree.rootNode.endPosition.row + 1,
    metadata: {
      api,
      props: props.map(p => p.name),
      emits: allEmits,
    },
  }));

  const componentRef = { symbol: componentName, kind: 'component' };

  for (const prop of props) {
    nodes.push(makeNode(subprojectId, filePath, `${componentName}.${prop.name}`, 'property', {
      parent_symbol: componentName,
      metadata: { type: prop.type || null, required: prop.required ?? null },
    }));
  }

  for (const event of allEmits) {
    nodes.push(makeNode(subprojectId, filePath, `${componentName}:${event}`, 'event', {
      parent_symbol: componentName,
      metadata: { declared: emitsDeclared.includes(event) },
    }));

    edges.push(makeEdge(subprojectId, filePath,
      componentRef,
      { symbol: event, kind: 'event' },
      'fires_event'));
  }

  const methods = extractMethods(scriptText, isSetup);
  for (const method of methods) {
    nodes.push(makeNode(subprojectId, filePath, `${componentName}.${method.name}`, 'method', {
      parent_symbol: componentName,
      metadata: method.async ? { async: true } : null,
    }));
  }

  const imports = extractImportsFromScript(scriptText);
  for (const imp of imports) {
    edges.push(makeEdge(subprojectId, filePath,
      componentRef,
      { symbol: imp.source, kind: 'module' },
      'imports',
      imp.specifiers.length ? { specifiers: imp.specifiers } : null));
  }

  const composables = extractComposableCalls(scriptText);
  for (const name of composables) {
    if (/Store$/.test(name)) continue;

    nodes.push(makeNode(subprojectId, filePath, `${componentName}:${name}`, 'hook', {
      parent_symbol: componentName,
    }));

    edges.push(makeEdge(subprojectId, filePath,
      componentRef,
      { symbol: name, kind: 'hook' },
      'calls'));
  }

  const stores = extractStoreCalls(scriptText);
  for (const store of stores) {
    nodes.push(makeNode(subprojectId, filePath, `${componentName}:${store.name}`, 'store', {
      parent_symbol: componentName,
      metadata: { store_type: store.type },
    }));

    edges.push(makeEdge(subprojectId, filePath,
      componentRef,
      { symbol: store.name, kind: 'store' },
      'depends_on',
      { store_type: store.type }));
  }

  const usedComponents = extractTemplateComponents(templateNode);
  for (const compName of usedComponents) {
    edges.push(makeEdge(subprojectId, filePath,
      componentRef,
      { symbol: compName, kind: 'component' },
      'renders'));
  }

  const templateEvents = extractTemplateEvents(templateNode);
  for (const event of templateEvents.consumed) {
    edges.push(makeEdge(subprojectId, filePath,
      componentRef,
      { symbol: event, kind: 'event' },
      'consumes_event'));
  }

  return { nodes, edges };
}
