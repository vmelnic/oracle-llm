import fs from 'fs';
import path from 'path';
import { execSync, execFileSync, spawn } from 'child_process';
import fg from 'fast-glob';
import { createParser } from '../parser/index.js';
import { GraphStore } from '../graph/store.js';
import { L2Index } from '../retrieval/index.js';

/**
 * EmitGate — pre-commit validation pipeline for proposed code changes.
 *
 * Steps (all optional depending on subproject config):
 *   1. Tree-sitter parse check
 *   2. LSP / compiler typecheck (auto-detects tsc, php, dart, go, rust, java, python)
 *   3. oracle.validate — convention + pattern check
 *   4. oracle.impact — downstream consumer check
 *   5. Affected tests runner (auto-detects phpunit, jest, vitest, mocha, pytest, playwright, go, cargo, gradle)
 *
 * Every step returns { passed, issues[], durationMs }.
 * The gate as a whole returns { commitable, steps[], summary }.
 */

export class EmitGate {
  constructor({ subproject, store, parser, l2, patterns, manifest }) {
    this.subproject = subproject;
    this.store = store;
    this.parser = parser;
    this.l2 = l2;
    this.patterns = patterns;
    this.manifest = manifest;
  }

  async check(diff) {
    const steps = [];

    steps.push(await this.runParseCheck(diff));
    steps.push(await this.runTypeCheck(diff));
    steps.push(await this.runValidate(diff));
    steps.push(await this.runImpact(diff));
    steps.push(await this.runTests(diff));

    const failed = steps.filter((s) => !s.passed);
    const committable = failed.length === 0;

    return {
      committable,
      steps,
      summary: committable
        ? 'All checks passed — change is safe to commit.'
        : `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`,
    };
  }

  async runParseCheck(diff) {
    const start = Date.now();
    const issues = [];

    for (const change of diff.files || []) {
      const { path: filePath, proposed_code } = change;
      if (!proposed_code) continue;

      const lang = this.parser.languageFor(filePath);
      if (!lang) {
        issues.push({
          severity: 'warning',
          file: filePath,
          message: 'No parser available for this file extension — skipping parse check',
        });
        continue;
      }

      try {
        const tree = this.parser.parse(proposed_code, lang);
        const root = tree.rootNode;
        if (root.hasError) {
          const errors = collectParseErrors(root);
          for (const e of errors) {
            issues.push({
              severity: 'error',
              file: filePath,
              line: e.line,
              column: e.column,
              message: `Parse error: ${e.message}`,
            });
          }
        }
      } catch (err) {
        issues.push({
          severity: 'error',
          file: filePath,
          message: `Parser crashed: ${err.message}`,
        });
      }
    }

    return {
      name: 'tree-sitter-parse',
      passed: !issues.some((i) => i.severity === 'error'),
      issues,
      durationMs: Date.now() - start,
    };
  }

  async runTypeCheck(diff) {
    const start = Date.now();
    const issues = [];
    const lang = this.subproject?.language || '';
    const root = this.subproject?.root;
    const lspConfig = this.subproject?.lsp || this.manifest?.lsp;

    if (lspConfig?.cmd) {
      const diagnostics = await this._runLspTypecheck(diff, lspConfig, root);
      for (const d of diagnostics) {
        issues.push({
          severity: 'error',
          file: d.file,
          line: d.line,
          message: d.message,
        });
      }
    } else {
      const autoCmd = this._detectTypecheckCommand(lang);
      if (autoCmd) {
        try {
          execSync(autoCmd, {
            cwd: root,
            encoding: 'utf-8',
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (err) {
          const stderr = err.stderr || err.stdout || '';
          const errors = parseTypecheckOutput(stderr);
          for (const e of errors) {
            issues.push({
              severity: 'error',
              file: e.file,
              line: e.line,
              message: e.message,
            });
          }
        }
      } else {
        issues.push({
          severity: 'info',
          message: 'No LSP or typecheck command configured. Skipping typecheck.',
        });
      }
    }

    return {
      name: 'typecheck',
      passed: !issues.some((i) => i.severity === 'error'),
      issues,
      durationMs: Date.now() - start,
    };
  }

  async _runLspTypecheck(diff, lspConfig, root) {
    if (!root || !lspConfig?.cmd) return [];

    const files = (diff.files || []).filter(f => f.proposed_code);
    if (files.length === 0) return [];

    const diagnostics = [];
    let lspProcess = null;

    try {
      const cmdParts = lspConfig.cmd.split(' ');
      lspProcess = spawn(cmdParts[0], cmdParts.slice(1), {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });

      let msgId = 0;
      const pending = new Map();
      const notifications = [];
      let buffer = '';

      const sendRaw = (payload) => {
        const msg = JSON.stringify(payload);
        const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
        lspProcess.stdin.write(header + msg);
      };

      const lspTimeout = parseInt(process.env.ORACLE_LSP_TIMEOUT_MS, 10) || 10000;
      const request = (method, params, timeoutMs = lspTimeout) => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        sendRaw({ jsonrpc: '2.0', id, method, params });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`LSP request ${method} timed out`));
          }
        }, timeoutMs);
      });

      const notify = (method, params) => {
        sendRaw({ jsonrpc: '2.0', method, params });
      };

      lspProcess.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        while (true) {
          const headerMatch = buffer.match(/Content-Length:\s*(\d+)\r\n\r\n/);
          if (!headerMatch) break;
          const contentLength = parseInt(headerMatch[1], 10);
          const headerEnd = headerMatch.index + headerMatch[0].length;
          if (buffer.length < headerEnd + contentLength) break;

          const body = buffer.slice(headerEnd, headerEnd + contentLength);
          buffer = buffer.slice(headerEnd + contentLength);

          try {
            const parsed = JSON.parse(body);
            if (parsed.id != null && pending.has(parsed.id)) {
              const { resolve } = pending.get(parsed.id);
              pending.delete(parsed.id);
              resolve(parsed);
            } else if (parsed.method === 'textDocument/publishDiagnostics') {
              notifications.push(parsed.params);
            }
          } catch {}
        }
      });

      await request('initialize', {
        processId: process.pid,
        rootUri: `file://${root}`,
        capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
        ...(lspConfig.init || {}),
      }, 15000);

      notify('initialized', {});

      for (const file of files) {
        const filePath = file.path?.startsWith('/') ? file.path : path.join(root, file.path || '');
        notify('textDocument/didOpen', {
          textDocument: {
            uri: `file://${filePath}`,
            languageId: this.subproject?.language || 'unknown',
            version: 1,
            text: file.proposed_code,
          },
        });
      }

      await sleep(2000);

      for (const diag of notifications) {
        const uri = diag.uri || '';
        const filePath = uri.replace('file://', '');
        for (const d of (diag.diagnostics || [])) {
          if (d.severity === 1 || d.severity === 2) {
            diagnostics.push({
              file: path.relative(root, filePath),
              line: (d.range?.start?.line || 0) + 1,
              message: d.message,
            });
          }
        }
      }

      try {
        await request('shutdown', {}, 5000);
        notify('exit', {});
      } catch {}
    } catch (err) {
      diagnostics.push({ file: null, line: null, message: `LSP error: ${err.message}` });
    } finally {
      if (lspProcess) {
        try { lspProcess.kill(); } catch {}
      }
    }

    return diagnostics;
  }

  _detectTypecheckCommand(lang) {
    const root = this.subproject?.root;
    if (!root) return null;

    if (lang === 'typescript' || lang === 'javascript') {
      if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
        try { execSync('npx tsc --noEmit', { cwd: root, stdio: 'pipe', timeout: 5000 }); return 'npx tsc --noEmit'; } catch {}
      }
    }

    if (lang === 'php') {
      try { execSync('php -v', { stdio: 'pipe', timeout: 5000 }); return 'php -l'; } catch {}
    }

    if (lang === 'dart') {
      try { execSync('dart analyze --help', { stdio: 'pipe', timeout: 5000 }); return 'dart analyze'; } catch {}
    }

    if (lang === 'go') {
      try { execSync('go vet --help', { stdio: 'pipe', timeout: 5000 }); return 'go vet ./...'; } catch {}
    }

    if (lang === 'rust') {
      try { execSync('cargo check --help', { stdio: 'pipe', timeout: 5000 }); return 'cargo check'; } catch {}
    }

    if (lang === 'java') {
      if (fs.existsSync(path.join(root, 'pom.xml'))) {
        try { execSync('mvn --version', { stdio: 'pipe', timeout: 5000 }); return 'mvn compile -q'; } catch {}
      }
      if (fs.existsSync(path.join(root, 'build.gradle'))) {
        try { execSync('gradle --version', { stdio: 'pipe', timeout: 5000 }); return 'gradle compileJava -q'; } catch {}
      }
    }

    if (lang === 'python') {
      try { execSync('mypy --version', { stdio: 'pipe', timeout: 5000 }); return 'mypy --ignore-missing-imports .'; } catch {}
      try { execSync('pyright --version', { stdio: 'pipe', timeout: 5000 }); return 'pyright'; } catch {}
    }

    return null;
  }

  async runValidate(diff) {
    const start = Date.now();
    const { validate } = await import('../mcp/tools/validate.js');
    const issues = [];

    for (const change of diff.files || []) {
      const { path: filePath, proposed_code } = change;
      if (!filePath && !proposed_code) continue;

      const ctx = {
        store: this.store,
        subproject: this.subproject,
        patterns: this.patterns,
        manifest: this.manifest,
      };

      try {
        const result = validate(ctx, { path: filePath, proposed_code });
        if (result.answer.issues) {
          for (const issue of result.answer.issues) {
            issues.push({
              severity: issue.severity || 'warning',
              file: filePath,
              rule: issue.rule,
              message: issue.message || `${issue.rule} violation`,
              fix: issue.fix,
            });
          }
        }
      } catch (err) {
        issues.push({
          severity: 'warning',
          file: filePath,
          message: `Validation failed to run: ${err.message}`,
        });
      }
    }

    return {
      name: 'oracle.validate',
      passed: !issues.some((i) => i.severity === 'error'),
      issues,
      durationMs: Date.now() - start,
    };
  }

  async runImpact(diff) {
    const start = Date.now();
    const { impact } = await import('../mcp/tools/impact.js');
    const issues = [];

    for (const change of diff.files || []) {
      const desc = change.change_description || `modify ${change.path}`;
      const ctx = {
        store: this.store,
        subproject: this.subproject,
        manifest: this.manifest,
      };

      try {
        const result = impact(ctx, { change: desc });
        if (result.answer.breaking) {
          issues.push({
            severity: 'error',
            file: change.path,
            message: `Breaking change detected: ${result.answer.recommendation}`,
            affected_routes: result.answer.affected_routes,
            affected_components: result.answer.affected_components,
          });
        } else if (result.answer.migration_needed) {
          issues.push({
            severity: 'warning',
            file: change.path,
            message: `Migration recommended: ${result.answer.recommendation}`,
          });
        }
      } catch (err) {
        issues.push({
          severity: 'warning',
          file: change.path,
          message: `Impact analysis failed: ${err.message}`,
        });
      }
    }

    return {
      name: 'oracle.impact',
      passed: !issues.some((i) => i.severity === 'error'),
      issues,
      durationMs: Date.now() - start,
    };
  }

  async runTests(diff) {
    const start = Date.now();
    const issues = [];
    const testFrameworks = this.manifest?.test_frameworks || [];
    const root = this.subproject?.root;

    if (!root || testFrameworks.length === 0) {
      return {
        name: 'affected-tests',
        passed: true,
        issues: [{ severity: 'info', message: 'No test frameworks configured. Skipping test run.' }],
        durationMs: Date.now() - start,
      };
    }

    const changedPaths = (diff.files || []).map(f => f.path).filter(Boolean);
    const affectedTestFiles = this._findAffectedTests(changedPaths);

    if (affectedTestFiles.length === 0) {
      return {
        name: 'affected-tests',
        passed: true,
        issues: [{ severity: 'info', message: 'No affected test files detected.' }],
        durationMs: Date.now() - start,
      };
    }

    const testCmd = this._detectTestCommand(testFrameworks);
    if (!testCmd) {
      return {
        name: 'affected-tests',
        passed: true,
        issues: [{ severity: 'warning', message: `Test frameworks detected (${testFrameworks.join(', ')}) but no test runner command found.` }],
        durationMs: Date.now() - start,
      };
    }

    try {
      const testFileArgs = affectedTestFiles.map(f => path.relative(root, f));
      let fullCmd;
      const lower = testFrameworks[0]?.toLowerCase() || '';

      if (lower === 'phpunit') {
        const configFile = fs.existsSync(path.join(root, 'phpunit.xml')) ? 'phpunit.xml' : 'phpunit.xml.dist';
        fullCmd = `${testCmd} --configuration ${configFile} ${testFileArgs.join(' ')}`;
      } else if (lower === 'jest') {
        fullCmd = `${testCmd} --runTestsByPath ${testFileArgs.join(' ')}`;
      } else if (lower === 'vitest') {
        fullCmd = `${testCmd} run ${testFileArgs.join(' ')}`;
      } else if (lower === 'playwright') {
        fullCmd = `${testCmd} ${testFileArgs.join(' ')}`;
      } else {
        fullCmd = `${testCmd} ${testFileArgs.join(' ')}`;
      }

      execSync(fullCmd, {
        cwd: root,
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      issues.push({
        severity: 'info',
        message: `${affectedTestFiles.length} affected test(s) passed.`,
      });
    } catch (err) {
      const stderr = err.stderr || err.stdout || '';
      issues.push({
        severity: 'error',
        message: `Test failure: ${stderr.trim().slice(0, 500)}`,
        files: affectedTestFiles,
      });
    }

    return {
      name: 'affected-tests',
      passed: !issues.some((i) => i.severity === 'error'),
      issues,
      durationMs: Date.now() - start,
    };
  }

  _findAffectedTests(changedPaths) {
    const root = this.subproject?.root;
    if (!root) return [];

    const testFiles = new Set();

    if (this.store) {
      const subprojectId = this.subproject?.id;
      for (const changed of changedPaths) {
        const fileNodes = this.store.getNodesByFile(subprojectId, changed);
        for (const node of fileNodes) {
          const consumers = this.store.consumers(subprojectId, node.id, 2);
          for (const consumer of consumers) {
            if (isTestPath(consumer.path)) {
              testFiles.add(consumer.path);
            }
          }
        }
      }
    }

    for (const changed of changedPaths) {
      const base = path.basename(changed, path.extname(changed));
      const dir = path.dirname(changed);

      const patterns = [
        `${dir}/${base}.test.*`,
        `${dir}/${base}.spec.*`,
        `tests/**/${base}.test.*`,
        `tests/**/${base}.spec.*`,
        `test/**/${base}.test.*`,
        `test/**/${base}.spec.*`,
        `__tests__/**/${base}.*`,
        `spec/**/${base}_spec.*`,
      ];

      for (const pattern of patterns) {
        try {
          const matches = fg.sync(pattern, { cwd: root, absolute: false });
          for (const m of matches) testFiles.add(m);
        } catch {}
      }
    }

    return [...testFiles];
  }

  _detectTestCommand(testFrameworks) {
    const root = this.subproject?.root;
    if (!root) return null;

    for (const fw of testFrameworks) {
      const lower = fw.toLowerCase();

      if (lower === 'phpunit') {
        if (fs.existsSync(path.join(root, 'vendor/bin/phpunit'))) {
          return 'vendor/bin/phpunit';
        }
        try { execSync('which phpunit', { stdio: 'pipe', timeout: 3000 }); return 'phpunit'; } catch {}
      }

      if (lower === 'jest') {
        try { execSync('npx jest --version', { cwd: root, stdio: 'pipe', timeout: 5000 }); return 'npx jest --no-coverage'; } catch {}
      }

      if (lower === 'vitest') {
        try { execSync('npx vitest run --version', { cwd: root, stdio: 'pipe', timeout: 5000 }); return 'npx vitest run'; } catch {}
      }

      if (lower === 'mocha') {
        try { execSync('npx mocha --version', { cwd: root, stdio: 'pipe', timeout: 5000 }); return 'npx mocha'; } catch {}
      }

      if (lower === 'pytest') {
        try { execSync('pytest --version', { cwd: root, stdio: 'pipe', timeout: 5000 }); return 'pytest -x'; } catch {}
      }

      if (lower === 'playwright') {
        try { execSync('npx playwright --version', { cwd: root, stdio: 'pipe', timeout: 5000 }); return 'npx playwright test'; } catch {}
      }

      if (lower === 'flutter_test' || lower === 'dart') {
        try { execSync('flutter test --help', { cwd: root, stdio: 'pipe', timeout: 5000 }); return 'flutter test'; } catch {}
      }

      if (lower === 'go' || lower === 'go_test') {
        try { execSync('go version', { stdio: 'pipe', timeout: 3000 }); return 'go test'; } catch {}
      }

      if (lower === 'cargo' || lower === 'rust') {
        try { execSync('cargo --version', { stdio: 'pipe', timeout: 3000 }); return 'cargo test'; } catch {}
      }

      if (lower === 'unittest' || lower === 'python') {
        try { execSync('python -m pytest --version', { stdio: 'pipe', timeout: 3000 }); return 'python -m pytest -x'; } catch {}
        return 'python -m unittest';
      }

      if (lower === 'junit' || lower === 'maven') {
        try { execSync('mvn --version', { stdio: 'pipe', timeout: 3000 }); return 'mvn test -q'; } catch {}
      }

      if (lower === 'gradle') {
        try { execSync('gradle --version', { stdio: 'pipe', timeout: 3000 }); return 'gradle test'; } catch {}
      }
    }

    return null;
  }
}

function collectParseErrors(node) {
  const errors = [];
  if (node.type === 'ERROR' || node.isMissing) {
    errors.push({
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      message: node.type === 'ERROR' ? 'syntax error' : `missing ${node.type}`,
    });
  }
  for (let i = 0; i < node.childCount; i++) {
    errors.push(...collectParseErrors(node.child(i)));
  }
  return errors;
}

function parseTypecheckOutput(output) {
  const errors = [];
  if (!output) return errors;

  const patterns = [
    /^(.+?):(\d+):(\d+)?\s*-\s*error\s+(.+)$/gm,
    /^(.+?):(\d+):(\d+)?:\s*error:\s*(.+)$/gm,
    /^(ERROR|error)\s+\[(.+?)\]\s+(.+?):(\d+):(\d+)/gm,
    /^  (.+?):(\d+):(\d+):\s*error:\s*(.+)$/gm,
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(output)) !== null) {
      errors.push({
        file: m[1] || m[3] || '',
        line: parseInt(m[2] || m[4], 10) || 0,
        message: m[4] || m[5] || m[2] || 'typecheck error',
      });
    }
  }

  if (errors.length === 0 && /error/i.test(output)) {
    const lines = output.split('\n').filter(l => /error/i.test(l));
    for (const line of lines.slice(0, 5)) {
      errors.push({ file: null, line: null, message: line.trim().slice(0, 200) });
    }
  }

  return errors;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTestPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return /\.(test|spec)\.[jt]sx?$/.test(lower)
    || /(^|\/)(tests?|__tests__|spec)\//.test(lower)
    || /_test\.(dart|go|py)$/.test(lower)
    || /Test\.php$/.test(filePath)
    || lower.includes('tests/') || lower.includes('test/');
}
