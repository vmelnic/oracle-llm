import path from 'path';

export function validate(ctx, { path: filePath, proposed_code }) {
  const { store, subproject, patterns, manifest } = ctx;

  if (!filePath && !proposed_code) {
    return {
      answer: { valid: true, issues: [], ok_checks: [] },
      evidence: [],
      layer: 'L1',
    };
  }

  const subId = subproject?.id ?? subproject;
  const issues = [];
  const okChecks = [];

  if (filePath) {
    checkNamingConventions(filePath, store, subId, manifest, issues, okChecks);
  }

  if (filePath && patterns) {
    checkPatternConformance(filePath, proposed_code, patterns, store, subId, issues, okChecks);
  }

  if (manifest?.conventions) {
    checkConventionCompliance(filePath, proposed_code, manifest.conventions, issues, okChecks);
  }

  if (proposed_code) {
    checkImportConsistency(proposed_code, store, subId, filePath, issues, okChecks);
    checkStructuralIssues(proposed_code, filePath, issues, okChecks);
  }

  const valid = issues.every((i) => i.severity !== 'error');

  const evidence = [];
  for (const issue of issues) {
    if (issue.analog) {
      evidence.push({
        path: issue.analog,
        symbol: issue.rule,
        kind: 'convention',
        role: 'reference',
      });
    }
  }

  return {
    answer: { valid, issues, ok_checks: okChecks },
    evidence,
    layer: 'L1',
  };
}

function checkNamingConventions(filePath, store, subId, manifest, issues, okChecks) {
  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath, ext);

  const kindForDir = inferKindFromDir(dir);
  if (kindForDir) {
    const existingInDir = store.findNodes({ subprojectId: subId, kind: kindForDir });
    const dirsForKind = new Set(existingInDir.map((n) => path.dirname(n.path)));

    if (dirsForKind.size > 0 && !dirsForKind.has(dir)) {
      const expectedDirs = [...dirsForKind].slice(0, 3).join(', ');
      issues.push({
        severity: 'warning',
        rule: 'directory-convention',
        fix: `${kindForDir} files are typically in: ${expectedDirs}`,
        analog: existingInDir[0]?.path ?? null,
      });
    } else if (dirsForKind.has(dir)) {
      okChecks.push(`File is in expected directory for ${kindForDir}`);
    }
  }

  const existingInSameDir = store.findNodes({ subprojectId: subId })
    .filter((n) => path.dirname(n.path) === dir);

  if (existingInSameDir.length > 0) {
    const existingCasing = detectCasing(existingInSameDir.map((n) => path.basename(n.path, path.extname(n.path))));
    const fileCasing = classifyCasing(basename);

    if (existingCasing && fileCasing && existingCasing !== fileCasing) {
      issues.push({
        severity: 'warning',
        rule: 'naming-casing',
        fix: `Files in ${dir} use ${existingCasing} casing. Got ${fileCasing}.`,
        analog: existingInSameDir[0]?.path ?? null,
      });
    } else if (existingCasing && fileCasing === existingCasing) {
      okChecks.push(`Filename casing matches directory convention (${existingCasing})`);
    }
  }

  if (manifest?.conventions?.typescript && !ext.match(/\.[tj]sx?$/)) {
    // No issue for non-JS/TS files in a TS project
  } else if (ext) {
    const existingExts = new Set(
      store.findNodes({ subprojectId: subId })
        .filter((n) => path.dirname(n.path) === dir)
        .map((n) => path.extname(n.path))
    );
    if (existingExts.size > 0 && !existingExts.has(ext)) {
      issues.push({
        severity: 'info',
        rule: 'file-extension',
        fix: `Files in ${dir} typically use ${[...existingExts].join(', ')} extension(s).`,
      });
    }
  }
}

function checkPatternConformance(filePath, proposedCode, patterns, store, subId, issues, okChecks) {
  const kind = inferKindFromDir(path.dirname(filePath));
  if (!kind) return;

  const kindPatterns = patterns.findPatternsForKind(kind);
  if (kindPatterns.length === 0) return;

  const dominant = kindPatterns[0];

  if (proposedCode && dominant.template?.signature) {
    const sigPattern = extractSignatureShape(dominant.template.signature);
    if (sigPattern && !proposedCode.includes(sigPattern.keyword)) {
      issues.push({
        severity: 'info',
        rule: 'pattern-conformance',
        fix: `Dominant ${kind} pattern uses "${sigPattern.keyword}" — consider matching it.`,
        analog: dominant.canonical?.path ?? null,
      });
    } else {
      okChecks.push(`Code follows dominant ${kind} pattern`);
    }
  }

  if (dominant.frequency) {
    okChecks.push(`Matching pattern "${dominant.name}" (${dominant.frequency.count}/${dominant.frequency.total} instances)`);
  }
}

function checkConventionCompliance(filePath, proposedCode, conventions, issues, okChecks) {
  if (conventions.linter) {
    okChecks.push(`Project uses ${conventions.linter}`);
  }

  if (conventions.formatter) {
    okChecks.push(`Project uses ${conventions.formatter}`);
  }

  if (conventions.typescript && filePath) {
    const ext = path.extname(filePath);
    if (ext === '.js' || ext === '.jsx') {
      issues.push({
        severity: 'warning',
        rule: 'typescript-convention',
        fix: `Project uses TypeScript. Consider using ${ext === '.js' ? '.ts' : '.tsx'} instead.`,
      });
    }
  }

  if (conventions.vue_api && proposedCode) {
    if (conventions.vue_api === 'composition') {
      if (proposedCode.includes('export default {') && !proposedCode.includes('defineComponent')) {
        issues.push({
          severity: 'warning',
          rule: 'vue-api-convention',
          fix: 'Project uses Composition API. Use <script setup> or defineComponent().',
        });
      } else if (proposedCode.includes('<script setup') || proposedCode.includes('defineComponent')) {
        okChecks.push('Uses Composition API as per convention');
      }
    }

    if (conventions.vue_api === 'options') {
      if (proposedCode.includes('<script setup')) {
        issues.push({
          severity: 'info',
          rule: 'vue-api-convention',
          fix: 'Project uses Options API. Consider using export default {} pattern.',
        });
      }
    }
  }

  if (conventions.state_management && proposedCode) {
    const sm = conventions.state_management;
    if (sm === 'pinia' && proposedCode.includes('new Vuex.Store')) {
      issues.push({
        severity: 'warning',
        rule: 'state-management-convention',
        fix: 'Project uses Pinia. Avoid Vuex.',
      });
    }
    if (sm === 'vuex' && proposedCode.includes('defineStore')) {
      issues.push({
        severity: 'info',
        rule: 'state-management-convention',
        fix: 'Project uses Vuex. This code uses Pinia.',
      });
    }
  }

  if (conventions.react_style && proposedCode) {
    if (conventions.react_style === 'hooks') {
      if (proposedCode.includes('extends React.Component') || proposedCode.includes('extends Component')) {
        issues.push({
          severity: 'warning',
          rule: 'react-style-convention',
          fix: 'Project uses hooks. Consider functional components instead of class components.',
        });
      }
    }
  }

  if (conventions.soft_delete && proposedCode) {
    if (/DELETE\s+FROM/i.test(proposedCode) && !/soft.?delete/i.test(proposedCode)) {
      issues.push({
        severity: 'warning',
        rule: 'soft-delete-convention',
        fix: `Project uses soft deletes (${conventions.soft_delete}). Avoid hard DELETE statements.`,
      });
    }
  }
}

function checkImportConsistency(proposedCode, store, subId, filePath, issues, okChecks) {
  const importLines = proposedCode.split('\n').filter(
    (l) => l.trim().startsWith('import ') || l.trim().startsWith('require(') || l.trim().startsWith('use ')
  );

  if (importLines.length === 0) return;

  const existingNodes = store.findNodes({ subprojectId: subId });
  if (existingNodes.length === 0) return;

  const dir = filePath ? path.dirname(filePath) : null;
  if (!dir) return;

  const sameDir = existingNodes.filter((n) => path.dirname(n.path) === dir);
  if (sameDir.length === 0) return;

  const hasEsm = importLines.some((l) => l.trim().startsWith('import '));
  const hasCjs = importLines.some((l) => /require\s*\(/.test(l));

  if (hasEsm && hasCjs) {
    issues.push({
      severity: 'warning',
      rule: 'import-style-mixed',
      fix: 'Mixing ESM imports and CJS require(). Pick one style.',
    });
  } else {
    okChecks.push(`Consistent import style (${hasEsm ? 'ESM' : 'CJS'})`);
  }
}

function checkStructuralIssues(proposedCode, filePath, issues, okChecks) {
  const lines = proposedCode.split('\n');

  if (lines.length > 500) {
    issues.push({
      severity: 'info',
      rule: 'file-size',
      fix: `File has ${lines.length} lines. Consider splitting into smaller modules.`,
    });
  } else {
    okChecks.push('File size within reasonable bounds');
  }

  const longLines = lines.filter((l) => l.length > 120);
  if (longLines.length > lines.length * 0.1 && longLines.length > 5) {
    issues.push({
      severity: 'info',
      rule: 'line-length',
      fix: `${longLines.length} lines exceed 120 characters.`,
    });
  }

  if (filePath && /\.(vue|jsx|tsx)$/.test(filePath)) {
    const hasTemplate = proposedCode.includes('<template') || proposedCode.includes('return (');
    if (!hasTemplate && lines.length > 10) {
      issues.push({
        severity: 'info',
        rule: 'component-structure',
        fix: 'Component file does not appear to have a template/render section.',
      });
    }
  }
}

function inferKindFromDir(dir) {
  if (!dir) return null;
  const lower = dir.toLowerCase();

  if (/controller/i.test(lower)) return 'route';
  if (/component/i.test(lower)) return 'component';
  if (/migration/i.test(lower)) return 'migration';
  if (/model|entit/i.test(lower)) return 'class';
  if (/store/i.test(lower)) return 'store';
  if (/hook|composable/i.test(lower)) return 'hook';
  if (/provider/i.test(lower)) return 'provider';
  if (/middleware/i.test(lower)) return 'function';
  if (/route/i.test(lower)) return 'route';
  if (/service/i.test(lower)) return 'class';
  if (/directive/i.test(lower)) return 'directive';
  if (/pipe/i.test(lower)) return 'pipe';

  return null;
}

function detectCasing(names) {
  if (names.length === 0) return null;

  const counts = { PascalCase: 0, camelCase: 0, 'kebab-case': 0, snake_case: 0 };
  for (const name of names) {
    const c = classifyCasing(name);
    if (c && counts[c] !== undefined) counts[c]++;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] > 0 ? sorted[0][0] : null;
}

function classifyCasing(name) {
  if (!name) return null;
  if (name.includes('-')) return 'kebab-case';
  if (name.includes('_')) return 'snake_case';
  if (/^[A-Z]/.test(name)) return 'PascalCase';
  if (/^[a-z]/.test(name) && /[A-Z]/.test(name)) return 'camelCase';
  return null;
}

function extractSignatureShape(signature) {
  if (!signature) return null;
  const keywords = ['async', 'function', 'class', 'export', 'public', 'private', 'protected'];
  for (const kw of keywords) {
    if (signature.includes(kw)) return { keyword: kw };
  }
  return null;
}
