import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');

const GRAMMAR_REGISTRY = [
  {
    name: 'javascript',
    pkg: 'tree-sitter-javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    extract: (mod) => mod.default ?? mod,
  },
  {
    name: 'typescript',
    pkg: 'tree-sitter-typescript',
    extensions: ['.ts'],
    extract: (mod) => (mod.default ?? mod).typescript ?? mod.typescript,
  },
  {
    name: 'tsx',
    pkg: 'tree-sitter-typescript',
    extensions: ['.tsx'],
    extract: (mod) => (mod.default ?? mod).tsx ?? mod.tsx,
  },
  {
    name: 'php',
    pkg: 'tree-sitter-php',
    extensions: ['.php'],
    extract: (mod) => {
      const base = mod.default ?? mod;
      return base.php ?? base;
    },
  },
  {
    name: 'dart',
    pkg: '@sengac/tree-sitter-dart',
    extensions: ['.dart'],
    extract: (mod) => mod.default ?? mod,
  },
  {
    name: 'vue',
    pkg: 'tree-sitter-vue',
    extensions: ['.vue'],
    extract: (mod) => mod.default ?? mod,
  },
  {
    name: 'python',
    pkg: 'tree-sitter-python',
    extensions: ['.py'],
    extract: (mod) => mod.default ?? mod,
  },
  {
    name: 'go',
    pkg: 'tree-sitter-go',
    extensions: ['.go'],
    extract: (mod) => mod.default ?? mod,
  },
  {
    name: 'rust',
    pkg: 'tree-sitter-rust',
    extensions: ['.rs'],
    extract: (mod) => mod.default ?? mod,
  },
  {
    name: 'java',
    pkg: 'tree-sitter-java',
    extensions: ['.java'],
    extract: (mod) => mod.default ?? mod,
  },
];

function loadLanguages() {
  const languages = new Map();
  const extMap = new Map();

  for (const entry of GRAMMAR_REGISTRY) {
    try {
      let mod;
      try {
        mod = require(entry.pkg);
      } catch {
        continue;
      }

      const grammar = entry.extract(mod);
      if (!grammar) {
        console.warn(`[parser] ${entry.name}: grammar extracted as null/undefined, skipping`);
        continue;
      }

      const probe = new Parser();
      let abiOk = true;
      try {
        probe.setLanguage(grammar);
        probe.parse('');
      } catch (abiErr) {
        abiOk = false;
      }

      if (!abiOk && entry.name !== 'vue') {
        console.warn(`[parser] ${entry.name}: ABI incompatible with tree-sitter ${Parser.VERSION || '0.25'}, skipping`);
        continue;
      }

      if (abiOk) {
        languages.set(entry.name, grammar);
      }
      for (const ext of entry.extensions) {
        extMap.set(ext, entry.name);
      }
      if (process.env.ORACLE_DEBUG === 'true') console.error(`[parser] loaded ${entry.name}${abiOk ? '' : ' (script extraction only)'}`);
    } catch (err) {
      console.warn(`[parser] failed to load ${entry.name} (${entry.pkg}): ${err.message}`);
    }
  }

  return { languages, extMap };
}

export function createParser() {
  const { languages, extMap } = loadLanguages();
  const parser = new Parser();

  function setLanguage(langName) {
    const grammar = languages.get(langName);
    if (!grammar) {
      throw new Error(`Language "${langName}" is not available. Loaded: ${[...languages.keys()].join(', ')}`);
    }
    parser.setLanguage(grammar);
  }

  function extractVueScript(code) {
    const match = code.match(/<script[^>]*(?:\blang=["'](\w+)["'])?[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return { scriptCode: code, scriptLang: 'javascript' };
    const lang = match[1];
    const scriptLang = (lang === 'ts' || lang === 'typescript') ? 'typescript' : 'javascript';
    return { scriptCode: match[2], scriptLang };
  }

  function parse(code, language) {
    if (language === 'vue') {
      const { scriptCode, scriptLang } = extractVueScript(code);
      setLanguage(scriptLang);
      return parser.parse(scriptCode);
    }
    setLanguage(language);
    return parser.parse(code);
  }

  async function parseFile(filePath) {
    const lang = languageFor(filePath);
    if (!lang) return null;

    const code = await readFile(filePath, 'utf-8');
    const tree = parse(code, lang);
    return { tree, language: lang, filePath };
  }

  function walk(tree, visitor) {
    const cursor = tree.walk();
    let reachedRoot = false;

    while (!reachedRoot) {
      const result = visitor(cursor.currentNode);

      if (result !== false && cursor.gotoFirstChild()) {
        continue;
      }

      if (cursor.gotoNextSibling()) {
        continue;
      }

      while (!reachedRoot) {
        if (!cursor.gotoParent()) {
          reachedRoot = true;
        } else if (cursor.gotoNextSibling()) {
          break;
        }
      }
    }
  }

  function query(tree, queryString, language) {
    const grammar = languages.get(language);
    if (!grammar) {
      throw new Error(`Language "${language}" is not available for query`);
    }

    // Only pass S-expressions to Parser.Query; bare strings can segfault the native binding
    if (queryString.trimStart().startsWith('(')) {
      try {
        const q = new Parser.Query(grammar, queryString);
        return q.matches(tree.rootNode);
      } catch {
        // Fall through to walk-based filtering
      }
    }

    const matches = [];
    walk(tree, (node) => {
      if (node.type === queryString) {
        matches.push({ pattern: 0, captures: [{ name: queryString, node }] });
      }
    });
    return matches;
  }

  function supportedLanguages() {
    return [...languages.keys()];
  }

  function languageFor(filePath) {
    const ext = extname(filePath).toLowerCase();
    return extMap.get(ext) ?? null;
  }

  return { parse, parseFile, walk, query, supportedLanguages, languageFor };
}
