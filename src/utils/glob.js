import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fg from 'fast-glob';
import { positiveInt } from './env.js';

const ALWAYS_IGNORE = ['**/node_modules/**', '**/.git/**'];

/**
 * fast-glob with safe defaults: never follows symlinks, always skips
 * node_modules/.git, drops files ignored by .gitignore when `cwd` is inside a
 * git work tree (disable with ORACLE_RESPECT_GITIGNORE=false), and returns
 * the files sorted.
 */
export async function globFiles(patterns, { cwd, ignore = [], ...options } = {}) {
  const files = await fg(patterns, {
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ...options,
    cwd,
    ignore: [...ALWAYS_IGNORE, ...ignore],
  });
  // Sorted: fast-glob's order varies between runs, and anything that caps or
  // orders by this list (detectors, the builder) must be deterministic.
  files.sort();
  const visible = gitVisibleFiles(cwd);
  if (!visible) return files;
  return files.filter((file) => {
    const rel = (path.isAbsolute(file) ? path.relative(cwd, file) : file).split(path.sep).join('/');
    return visible.files.has(rel) || insideOpaqueDir(rel, visible.opaqueDirs);
  });
}

/**
 * What git does not ignore under `cwd` (paths relative to it, forward
 * slashes): tracked files plus untracked files not matched by an ignore rule.
 * Nested repositories and submodules are opaque to the outer repo — git lists
 * them as a single entry — so their contents are kept wholesale.
 * Not cached: the watcher re-globs right after files are created.
 * Returns null when filtering should not apply (not a git repo, git missing,
 * opted out, or git reports nothing — e.g. the directory itself is ignored).
 */
function gitVisibleFiles(cwd) {
  if (!cwd || process.env.ORACLE_RESPECT_GITIGNORE === 'false') return null;
  const git = (args) => execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\0').filter(Boolean);

  try {
    const entries = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (entries.length === 0) return null;
    const files = new Set();
    const opaqueDirs = new Set();
    for (const entry of entries) {
      // An untracked nested repository is listed as `dir/`.
      if (entry.endsWith('/')) opaqueDirs.add(entry.slice(0, -1));
      else files.add(entry);
    }
    // Submodules are tracked as gitlinks (mode 160000), listed like a file.
    for (const line of git(['ls-files', '-z', '--stage'])) {
      if (line.startsWith('160000 ')) opaqueDirs.add(line.slice(line.indexOf('\t') + 1));
    }
    return { files, opaqueDirs };
  } catch {
    return null;
  }
}

function insideOpaqueDir(rel, opaqueDirs) {
  if (opaqueDirs.size === 0) return false;
  for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
    if (opaqueDirs.has(rel.slice(0, i))) return true;
  }
  return false;
}

/** Caps a file list for content-scanning detectors, warning when it truncates. */
export function capFiles(files, label) {
  const max = positiveInt(process.env.ORACLE_DETECTOR_MAX_FILES, 10000);
  if (files.length <= max) return files;
  console.error(`[${label}] scanning first ${max} of ${files.length} files (raise ORACLE_DETECTOR_MAX_FILES to scan more)`);
  return files.slice(0, max);
}
