import fs from 'node:fs';
import path from 'node:path';
import { positiveInt } from '../../utils/env.js';

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
  const relativeToSub = path.relative(realBase, real);
  if (relativeToSub.startsWith('..') || path.isAbsolute(relativeToSub)) {
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

  // Errors echo the path as requested, never the resolved absolute path.
  if (!fs.existsSync(resolved)) {
    return { answer: { error: 'file not found', path: filePath }, evidence: [], layer: 'L1' };
  }
  const fileStat = fs.statSync(resolved);
  if (!fileStat.isFile()) {
    return { answer: { error: 'path is not a regular file', path: filePath }, evidence: [], layer: 'L1' };
  }
  // Same ceiling as ingest: files above it were never indexed, and reading
  // them whole just to slice a range could exhaust memory.
  const maxFileBytes = positiveInt(process.env.ORACLE_MAX_FILE_BYTES, 5 * 1024 * 1024);
  if (fileStat.size > maxFileBytes) {
    return { answer: { error: 'file too large', path: filePath, max_file_bytes: maxFileBytes }, evidence: [], layer: 'L1' };
  }

  let content;
  try {
    content = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    return { answer: { error: 'read failed', path: filePath, code: err.code || null }, evidence: [], layer: 'L1' };
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

  const maxLines = positiveInt(process.env.ORACLE_READ_EXACT_MAX_LINES, 2000);
  if (end - start + 1 > maxLines) {
    return {
      answer: { error: 'range too large', max_lines: maxLines, requested_lines: end - start + 1 },
      evidence: [],
      layer: 'L1',
    };
  }

  const selected = allLines.slice(start - 1, end);
  const maxBytes = positiveInt(process.env.ORACLE_READ_EXACT_MAX_BYTES, 1024 * 1024);
  if (Buffer.byteLength(selected.join('\n')) > maxBytes) {
    return {
      answer: { error: 'response too large', max_bytes: maxBytes },
      evidence: [],
      layer: 'L1',
    };
  }
  const ext = path.extname(resolved).toLowerCase();
  const lang = LANG_MAP[ext] ?? null;

  // Relative to the subproject, like every other tool's evidence; absolute
  // paths would expose the server's directory layout.
  const realBase = (() => {
    try { return fs.realpathSync(subprojectRoot); } catch { return subprojectRoot; }
  })();
  const relPath = realBase ? path.relative(realBase, resolved).split(path.sep).join('/') : filePath;

  const evidence = [{
    path: relPath,
    line_range: [start, end],
  }];

  return {
    answer: {
      path: relPath,
      lines: selected,
      line_range: [start, end],
      total_lines: allLines.length,
      lang,
    },
    evidence,
    layer: 'L1',
  };
}
