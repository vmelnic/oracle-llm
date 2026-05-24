import fs from 'node:fs';
import path from 'node:path';

const LANG_MAP = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'typescriptreact', '.jsx': 'javascriptreact',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.php': 'php', '.dart': 'dart', '.vue': 'vue',
  '.css': 'css', '.scss': 'scss', '.html': 'html',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown', '.sql': 'sql', '.sh': 'shell',
};

function resolveSubprojectPath(workspaceRoot, subprojectRoot, filePath) {
  const base = subprojectRoot || workspaceRoot || process.cwd();
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(base, filePath);

  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    real = resolved;
  }

  const realBase = (() => {
    try { return fs.realpathSync(base); } catch { return base; }
  })();
  const realWs = (() => {
    try { return fs.realpathSync(workspaceRoot || process.cwd()); } catch { return workspaceRoot || process.cwd(); }
  })();

  const relativeToSub = path.relative(realBase, real);
  const relativeToWs = path.relative(realWs, real);

  if (relativeToSub.startsWith('..') && relativeToWs.startsWith('..')) {
    throw new Error(`Path ${filePath} escapes subproject scope`);
  }
  return real;
}

export function readExact(ctx, { path: filePath, line_range }) {
  const { workspace, subproject } = ctx;

  if (!filePath) {
    return { answer: null, evidence: [], layer: 'L1' };
  }

  const workspaceRoot = workspace?.root || null;
  const subprojectRoot = subproject?.root || workspaceRoot;

  let resolved;
  try {
    resolved = resolveSubprojectPath(workspaceRoot, subprojectRoot, filePath);
  } catch (err) {
    return { answer: { error: err.message, path: filePath }, evidence: [], layer: 'L1' };
  }

  if (!fs.existsSync(resolved)) {
    return { answer: { error: 'file not found', path: resolved }, evidence: [], layer: 'L1' };
  }

  let content;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    return { answer: { error: 'read failed', message: err.message }, evidence: [], layer: 'L1' };
  }

  const allLines = content.split('\n');

  let start = 1;
  let end = allLines.length;

  if (line_range) {
    if (Array.isArray(line_range) && line_range.length >= 2) {
      start = Math.max(1, line_range[0]);
      end = Math.min(allLines.length, line_range[1]);
    } else if (typeof line_range === 'string') {
      const match = line_range.match(/^(\d+)\s*[-:]\s*(\d+)$/);
      if (match) {
        start = Math.max(1, parseInt(match[1], 10));
        end = Math.min(allLines.length, parseInt(match[2], 10));
      }
    }
  }

  if (start > end || start > allLines.length) {
    return {
      answer: { error: 'invalid range', total_lines: allLines.length },
      evidence: [],
      layer: 'L1',
    };
  }

  const selected = allLines.slice(start - 1, end);
  const ext = path.extname(resolved).toLowerCase();
  const lang = LANG_MAP[ext] ?? null;

  const evidence = [{
    path: resolved,
    line_range: [start, end],
  }];

  return {
    answer: {
      path: resolved,
      lines: selected,
      line_range: [start, end],
      total_lines: allLines.length,
      lang,
    },
    evidence,
    layer: 'L1',
  };
}
