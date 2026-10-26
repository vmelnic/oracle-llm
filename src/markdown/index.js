import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';

const CONVENTION_FILES = ['CONVENTIONS.md', 'CONVENTION.md', 'AGENTS.md', 'CLAUDE.md', 'CODING.md', 'STYLE.md'];
const DOC_FILES = ['README.md', 'ARCHITECTURE.md', 'API.md', 'SETUP.md'];
const MAX_RULES_PER_SECTION = 20;
const MAX_RULE_LENGTH = 300;

export function parseMarkdown(content) {
  const sections = [];
  let current = null;
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      if (current) {
        current.endLine = i;
        sections.push(current);
      }
      current = {
        level: headingMatch[1].length,
        title: headingMatch[2].trim(),
        rawLines: [],
        startLine: i + 1,
      };
      continue;
    }

    if (current) {
      current.rawLines.push(line);
    }
  }

  if (current) {
    current.endLine = lines.length;
    sections.push(current);
  }

  return sections.map(s => {
    const body = s.rawLines.join('\n');
    return {
      level: s.level,
      title: s.title,
      body,
      startLine: s.startLine,
      endLine: s.endLine,
      tables: extractTables(s.rawLines),
      codeBlocks: extractCodeBlocks(s.rawLines),
      bullets: extractBullets(s.rawLines),
    };
  });
}

function extractTables(lines) {
  const tables = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
      const headers = lines[i].split('|').map(h => h.trim()).filter(Boolean);
      const rows = [];
      i += 2;

      while (i < lines.length && lines[i].includes('|') && lines[i].trim().length > 0) {
        const cells = lines[i].split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length > 0) {
          const row = {};
          for (let j = 0; j < headers.length && j < cells.length; j++) {
            row[headers[j]] = cells[j];
          }
          rows.push(row);
        }
        i++;
      }

      if (rows.length > 0) tables.push({ headers, rows });
      continue;
    }
    i++;
  }

  return tables;
}

function extractCodeBlocks(lines) {
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || null;
      const blockLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        blockLines.push(lines[i]);
        i++;
      }
      blocks.push({ lang, content: blockLines.join('\n') });
      i++;
      continue;
    }
    i++;
  }

  return blocks;
}

function extractBullets(lines) {
  return lines
    .filter(l => /^\s*[-*+]\s+/.test(l))
    .map(l => l.replace(/^\s*[-*+]\s+/, '').trim());
}

export function slugify(str) {
  return str
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export function extractConventionRules(sections) {
  const conventions = {};

  for (const section of sections) {
    if (!section.title) continue;
    const sectionKey = slugify(section.title);
    if (!sectionKey) continue;

    for (const table of section.tables) {
      if (table.headers.length >= 2) {
        const keyH = table.headers[0];
        const valH = table.headers[1];
        const tableConventions = {};
        for (const row of table.rows) {
          const key = slugify(row[keyH] || '');
          const value = row[valH] || '';
          if (key && value) tableConventions[key] = value;
        }
        if (Object.keys(tableConventions).length > 0) {
          conventions[sectionKey] = { ...(conventions[sectionKey] || {}), ...tableConventions };
        }
      }
    }

    for (const bullet of section.bullets) {
      const kvMatch = bullet.match(/^\*\*(.+?)\*\*[:\s]+(.+)/)
        || bullet.match(/^`(.+?)`[:\s]+(.+)/)
        || bullet.match(/^(\w[\w\s]{1,30}?)\s*:\s+(.{3,})/);

      if (kvMatch) {
        const key = slugify(kvMatch[1]);
        const value = kvMatch[2].trim();
        if (key && value) {
          if (!conventions[sectionKey]) conventions[sectionKey] = {};
          conventions[sectionKey][key] = value;
        }
      } else if (bullet.trim().length >= 10) {
        // Prose rules ("Parsers swallow errors silently ...") are the
        // conventions themselves; keep them, bounded.
        if (!conventions[sectionKey]) conventions[sectionKey] = {};
        const rules = conventions[sectionKey]._rules || (conventions[sectionKey]._rules = []);
        if (rules.length < MAX_RULES_PER_SECTION) rules.push(bullet.trim().slice(0, MAX_RULE_LENGTH));
      }
    }

    if (section.codeBlocks.length > 0 && Object.keys(conventions[sectionKey] || {}).length === 0) {
      conventions[sectionKey] = {
        _example: section.codeBlocks[0].content.slice(0, 500),
        _lang: section.codeBlocks[0].lang,
      };
    }
  }

  return conventions;
}

export function findConventionFiles(root) {
  const found = [];
  for (const name of CONVENTION_FILES) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) found.push(p);
  }
  return found;
}

export function findDocFiles(root) {
  const found = [];
  for (const name of DOC_FILES) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) found.push(p);
  }
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir)) {
    try {
      const docMds = fg.sync(['*.md'], { cwd: docsDir, absolute: true });
      found.push(...docMds);
    } catch {}
  }
  return found;
}

export function extractConventionsFromFiles(root) {
  const files = findConventionFiles(root);
  const merged = {};

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const sections = parseMarkdown(content);
      const rules = extractConventionRules(sections);
      const source = path.basename(filePath);

      for (const [key, value] of Object.entries(rules)) {
        if (typeof value === 'object' && !merged[key]) {
          merged[key] = { ...value, _source: source };
        } else if (typeof value === 'object') {
          const rules = [...(merged[key]._rules || []), ...(value._rules || [])];
          merged[key] = { ...merged[key], ...value, ...(rules.length ? { _rules: rules.slice(0, MAX_RULES_PER_SECTION) } : {}) };
        } else {
          merged[key] = value;
        }
      }
    } catch {}
  }

  return Object.keys(merged).length > 0 ? merged : null;
}

export function processMarkdownFiles(subproject, store) {
  const run = () => processMarkdownFilesInternal(subproject, store);
  return typeof store.runInTransaction === 'function' ? store.runInTransaction(run) : run();
}

function processMarkdownFilesInternal(subproject, store) {
  const { id: subprojectId, root } = subproject;
  const allFiles = [...findConventionFiles(root), ...findDocFiles(root)];
  const unique = [...new Set(allFiles)];
  const presentPaths = new Set(unique.map(filePath => path.relative(root, filePath)));
  let nodesCreated = 0;
  let nodesEnriched = 0;

  // Remove sections for deleted docs and rebuild documentation enrichment so
  // renamed/removed sections cannot leave stale context on code symbols.
  for (const node of store.findNodes({ subprojectId })) {
    if (node.kind === 'doc_section' && !presentPaths.has(node.path)) {
      store.deleteNode(node.id);
      continue;
    }
    if (!node.metadata) continue;
    try {
      const metadata = JSON.parse(node.metadata);
      if (metadata._doc_context) {
        delete metadata._doc_context;
        store.updateNodeMetadata(node.id, Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null);
      }
    } catch {}
  }

  for (const filePath of unique) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relPath = path.relative(root, filePath);
      const sections = parseMarkdown(content);

      store.deleteNodesByFile(subprojectId, relPath);

      for (const section of sections) {
        if (!section.title || section.body.trim().length < 10) continue;

        const referencedSymbols = findSymbolRefs(section.body, store, subprojectId);

        const searchableText = buildSearchText(section);

        const metadata = {};
        if (referencedSymbols.length > 0) {
          metadata.references = referencedSymbols.map(r => r.symbol);
        }
        if (section.tables.length > 0) {
          metadata.tables = section.tables.map(t => ({
            headers: t.headers,
            row_count: t.rows.length,
          }));
        }
        if (section.codeBlocks.length > 0) {
          metadata.has_code_examples = true;
          metadata.example_langs = [...new Set(section.codeBlocks.map(b => b.lang).filter(Boolean))];
        }
        metadata._oracle_sources = ['markdown'];

        store.upsertNodes([{
          subprojectId,
          path: relPath,
          lang: 'markdown',
          symbol: section.title,
          kind: 'doc_section',
          parentId: null,
          startLine: section.startLine,
          endLine: section.endLine,
          exported: false,
          signature: searchableText.slice(0, 200),
          doc: searchableText,
          commitSha: null,
          fileBlobHash: null,
          metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        }]);

        nodesCreated++;

        for (const ref of referencedSymbols) {
          enrichNodeWithDocContext(store, ref.nodeId, section.title, section.body, relPath);
          nodesEnriched++;
        }
      }
    } catch {}
  }

  return { nodesCreated, nodesEnriched, filesProcessed: unique.length };
}

function findSymbolRefs(text, store, subprojectId) {
  const matches = [];
  const seen = new Set();

  const symbolRefs = text.matchAll(/`(\w[\w.]*)`/g);
  for (const m of symbolRefs) {
    const symbol = m[1];
    if (seen.has(symbol) || symbol.length < 2) continue;
    seen.add(symbol);
    try {
      const rows = store.locate(subprojectId, symbol);
      if (rows.length > 0) {
        matches.push({ symbol, nodeId: rows[0].id });
      }
    } catch {}
  }

  return matches;
}

function buildSearchText(section) {
  const parts = [section.title];

  for (const bullet of section.bullets) {
    parts.push(bullet);
  }

  for (const table of section.tables) {
    parts.push(table.headers.join(' '));
    for (const row of table.rows.slice(0, 10)) {
      parts.push(Object.values(row).join(' '));
    }
  }

  const plainText = section.body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\|[^\n]+\|/g, '')
    .replace(/[-*+]\s+/g, '')
    .replace(/#{1,6}\s+/g, '')
    .trim();

  if (plainText.length > 0) {
    parts.push(plainText.slice(0, 500));
  }

  return parts.join(' ');
}

function enrichNodeWithDocContext(store, nodeId, sectionTitle, sectionBody, sourceFile) {
  try {
    const node = store.getNode(nodeId);
    if (!node) return;

    const meta = node.metadata ? JSON.parse(node.metadata) : {};
    if (!meta._doc_context) meta._doc_context = [];

    if (meta._doc_context.some(d => d.source === sourceFile && d.section === sectionTitle)) return;

    const summary = sectionBody
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\|[^\n]+\|/g, '')
      .trim()
      .slice(0, 300);

    meta._doc_context.push({
      section: sectionTitle,
      source: sourceFile,
      summary,
    });

    store.updateNodeMetadata(nodeId, JSON.stringify(meta));
  } catch {}
}
