import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function diffSince(ctx, { ref, scope }) {
  const { store, subproject, workspace } = ctx;
  const subprojectId = subproject?.id ?? subproject;

  if (!ref) {
    return { answer: { changed_files: [], changed_symbols: [], summary: 'no ref provided' }, evidence: [], layer: 'L1' };
  }

  const root = subproject?.root ?? workspace?.root ?? null;
  if (!root) {
    return { answer: { changed_files: [], changed_symbols: [], summary: 'no project root found' }, evidence: [], layer: 'L1' };
  }

  const fail = (summary) => ({
    answer: { changed_files: [], changed_symbols: [], summary },
    evidence: [],
    layer: 'L1',
  });
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return fail('git not available or not a repository');
  }
  if (typeof ref !== 'string' || ref.length > 200 || /[\0\r\n]/.test(ref)) return fail(`invalid ref: ${String(ref).slice(0, 50)}`);
  if (scope && (typeof scope !== 'string' || path.isAbsolute(scope) || path.relative(root, path.resolve(root, scope)).startsWith('..'))) {
    return fail('invalid scope: must be a path inside the subproject');
  }

  let commit;
  try {
    commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  } catch {
    return fail(`unknown ref: ${ref}`);
  }

  let changedFiles;
  try {
    // --relative: paths relative to (and limited to) the subproject root, which
    // may be a subdirectory of the repository, matching how nodes are stored.
    // --literal-pathspecs: `scope` is a plain path, so pathspec magic such as
    // `:(top)` cannot widen the diff beyond the subproject.
    const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--relative', '--name-only', commit, '--'];
    if (scope) args.push(scope);
    const tracked = git(args).trim().split('\n').filter(Boolean);
    // New files not yet committed are changes too; ls-files paths are already
    // relative to the subproject root (cwd).
    const untracked = git(['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '--', ...(scope ? [scope] : [])])
      .trim().split('\n').filter(Boolean);
    changedFiles = [...new Set([...tracked, ...untracked])].sort();
  } catch {
    return fail(`git diff failed for ${ref}`);
  }

  if (changedFiles.length === 0) {
    return {
      answer: { changed_files: [], changed_symbols: [], summary: 'no changes since ' + ref },
      evidence: [],
      layer: 'L1',
    };
  }

  const changedSymbols = [];
  for (const file of changedFiles) {
    const nodes = store.getNodesByFile(subprojectId, file);
    for (const node of nodes) {
      changedSymbols.push({
        id: node.id,
        symbol: node.symbol,
        kind: node.kind,
        path: node.path,
        start_line: node.start_line,
        end_line: node.end_line,
      });
    }
  }

  const kindCounts = {};
  for (const s of changedSymbols) {
    kindCounts[s.kind] = (kindCounts[s.kind] || 0) + 1;
  }
  const kindParts = Object.entries(kindCounts).map(([k, v]) => `${v} ${k}(s)`);
  const summary = `${changedFiles.length} file(s) changed since ${ref}, affecting ${changedSymbols.length} symbol(s)` +
    (kindParts.length > 0 ? `: ${kindParts.join(', ')}` : '');

  const evidence = changedSymbols.slice(0, 10).map(s => ({
    path: s.path,
    line_range: [s.start_line, s.end_line],
    symbol: s.symbol,
    kind: s.kind,
  }));

  return {
    answer: { changed_files: changedFiles, changed_symbols: changedSymbols, summary },
    evidence,
    layer: 'L1',
  };
}
