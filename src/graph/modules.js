import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { globFiles } from '../utils/glob.js';

// Maps import specifiers to files of the subproject, beyond relative paths:
//   - TS/JS path aliases from the nearest tsconfig.json / jsconfig.json
//     (`compilerOptions.paths`, following `extends`)
//   - workspace packages by their package.json `name` (monorepos), honouring
//     simple `exports` subpath maps
//   - Dart `package:<name>/...` for the subproject's own pubspec name
// Anything else (node_modules, pub packages) is external and stays unresolved.

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.d.ts'];
const INDEX_FILES = SCRIPT_EXTENSIONS.filter(ext => ext !== '.d.ts').map(ext => `/index${ext}`);

/** Files a relative or absolute specifier can refer to (paths relative to the root). */
function fileCandidates(resolvedPath) {
  const clean = resolvedPath.replace(/\/+$/, '');
  if (path.extname(clean) && !/\.(js|mjs|cjs|jsx)$/.test(clean)) return [clean];
  // `./x.js` may be `./x.ts` in TypeScript sources.
  const stem = clean.replace(/\.(js|mjs|cjs|jsx)$/, '');
  const exact = stem !== clean ? [clean] : [];
  return [...exact, ...SCRIPT_EXTENSIONS.map(ext => stem + ext), ...INDEX_FILES.map(index => stem + index)];
}

export async function createModuleResolver(root) {
  const configFiles = await globFiles(['**/tsconfig.json', '**/jsconfig.json', '**/package.json', 'pubspec.yaml'], {
    cwd: root,
    ignore: ['**/dist/**', '**/build/**', '**/.next/**', '**/.turbo/**', '**/.dart_tool/**', '**/vendor/**'],
  });
  const fingerprint = createHash('sha1');
  const packages = new Map();
  const tsconfigDirs = new Set();
  let dartPackage = null;

  for (const rel of configFiles.sort()) {
    const abs = path.join(root, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
    const base = path.basename(rel);
    if (base === 'package.json') {
      const pkg = parseJsonc(text);
      if (pkg?.name && rel !== 'package.json') {
        packages.set(pkg.name, { dir: path.posix.dirname(rel), exports: pkg.exports, main: pkg.main || pkg.module || pkg.types });
        fingerprint.update(`pkg:${pkg.name}:${rel}:${JSON.stringify(pkg.exports ?? null)}\n`);
      }
    } else if (base === 'pubspec.yaml') {
      try { dartPackage = yaml.load(text)?.name ?? null; } catch {}
      fingerprint.update(`pub:${dartPackage}\n`);
    } else {
      tsconfigDirs.add(path.posix.dirname(rel));
      fingerprint.update(`${rel}:${text}\n`);
    }
  }

  const configCache = new Map();

  // compilerOptions.paths of the tsconfig at `dir`, with `extends` applied;
  // targets are made relative to the subproject root.
  function aliasesAt(dir) {
    if (configCache.has(dir)) return configCache.get(dir);
    configCache.set(dir, null);
    const file = ['tsconfig.json', 'jsconfig.json'].map(name => path.posix.join(dir, name)).find(f => fs.existsSync(path.join(root, f)));
    const aliases = file ? loadPaths(file, new Set()) : null;
    configCache.set(dir, aliases);
    return aliases;
  }

  function loadPaths(file, seen) {
    if (seen.has(file) || seen.size > 10) return null;
    seen.add(file);
    let config;
    try { config = parseJsonc(fs.readFileSync(path.join(root, file), 'utf-8')); } catch { return null; }
    if (!config) return null;
    const dir = path.posix.dirname(file);
    let inherited = null;
    for (const parent of [].concat(config.extends || [])) {
      const parentFile = resolveExtends(dir, parent);
      if (parentFile) inherited = loadPaths(parentFile, seen) || inherited;
    }
    const options = config.compilerOptions || {};
    if (!options.paths) return inherited;
    const baseDir = path.posix.normalize(path.posix.join(dir, options.baseUrl || '.'));
    return Object.entries(options.paths).map(([pattern, targets]) => ({
      pattern,
      targets: [].concat(targets).map(t => path.posix.normalize(path.posix.join(baseDir, t))),
    }));
  }

  function resolveExtends(dir, specifier) {
    if (typeof specifier !== 'string') return null;
    const withJson = (p) => (p.endsWith('.json') ? p : `${p}.json`);
    if (specifier.startsWith('.')) return inside(withJson(path.posix.join(dir, specifier)));
    for (const [name, pkg] of packages) {
      if (specifier === name) return inside(path.posix.join(pkg.dir, 'tsconfig.json'));
      if (specifier.startsWith(`${name}/`)) return inside(withJson(path.posix.join(pkg.dir, specifier.slice(name.length + 1))));
    }
    return null;
  }

  function inside(rel) {
    const normalized = path.posix.normalize(rel);
    return normalized.startsWith('..') ? null : normalized;
  }

  function nearestAliases(sourceFile) {
    for (let dir = path.posix.dirname(sourceFile); ; dir = path.posix.dirname(dir)) {
      if (tsconfigDirs.has(dir)) {
        const aliases = aliasesAt(dir);
        if (aliases) return aliases;
      }
      if (dir === '.' || dir === '/' || dir === '') return null;
    }
  }

  function viaAliases(sourceFile, specifier) {
    const aliases = nearestAliases(sourceFile);
    if (!aliases) return [];
    const out = [];
    for (const { pattern, targets } of aliases) {
      const star = pattern.indexOf('*');
      let rest = null;
      if (star === -1) {
        if (specifier === pattern) rest = '';
      } else if (specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))) {
        rest = specifier.slice(star, specifier.length - (pattern.length - star - 1));
      }
      if (rest === null) continue;
      for (const target of targets) out.push(target.replace('*', rest));
    }
    return out;
  }

  function viaPackages(specifier) {
    for (const [name, pkg] of packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const sub = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`;
      const mapped = exportTarget(pkg.exports, sub);
      if (mapped) return [path.posix.join(pkg.dir, mapped)];
      if (sub === '.') return [path.posix.join(pkg.dir, pkg.main || 'index')];
      return [path.posix.join(pkg.dir, sub)];
    }
    return [];
  }

  return {
    fingerprint: fingerprint.digest('hex').slice(0, 12),

    /** Candidate files (relative to the root) for a specifier, or [] when external. */
    candidates(sourceFile, specifier) {
      if (!specifier) return [];
      if (specifier.startsWith('.')) {
        const resolved = inside(path.posix.join(path.posix.dirname(sourceFile), specifier));
        return resolved ? fileCandidates(resolved) : [];
      }
      if (specifier.startsWith('package:')) {
        const [pkgName, ...rest] = specifier.slice('package:'.length).split('/');
        return pkgName === dartPackage ? [path.posix.join('lib', ...rest)] : [];
      }
      const targets = [...viaAliases(sourceFile, specifier), ...viaPackages(specifier)];
      return [...new Set(targets.map(inside).filter(Boolean).flatMap(fileCandidates))];
    },
  };
}

function exportTarget(exports, sub) {
  if (!exports) return null;
  if (typeof exports === 'string') return sub === '.' ? exports : null;
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return pick(value.import ?? value.default ?? value.types ?? value.require);
    return null;
  };
  if (exports[sub] !== undefined) return pick(exports[sub]);
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf('*');
    if (star === -1 || !sub.startsWith(key.slice(0, star)) || !sub.endsWith(key.slice(star + 1))) continue;
    const target = pick(value);
    if (target) return target.replace('*', sub.slice(star, sub.length - (key.length - star - 1)));
  }
  return null;
}

/** JSON with comments and trailing commas (tsconfig style); null when unreadable. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  let pendingComma = -1; // index in `out` of a comma that may turn out to be trailing
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if ((c === '}' || c === ']') && pendingComma !== -1) {
      out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
    }
    if (c === ',') pendingComma = out.length;
    else if (!/\s/.test(c)) pendingComma = -1;
    if (c === '"') inString = true;
    out += c;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
