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

  let changedFiles;
  try {
    if (typeof ref !== 'string' || ref.length > 200 || /[\0\r\n]/.test(ref)) throw new Error('invalid ref');
    const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    const args = ['diff', '--no-ext-diff', '--name-only', commit, '--'];
    if (scope) {
      if (path.isAbsolute(scope) || path.relative(root, path.resolve(root, scope)).startsWith('..')) {
        throw new Error('invalid scope');
      }
      args.push(scope);
    }
    const output = execFileSync('git', args, { cwd: root, encoding: 'utf-8', timeout: 10000 });
    changedFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    return {
      answer: { changed_files: [], changed_symbols: [], summary: 'git not available or not a repository' },
      evidence: [],
      layer: 'L1',
    };
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
    path: path.join(root, s.path),
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
