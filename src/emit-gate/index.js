import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import fg from 'fast-glob';
import os from 'node:os';
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
    this.executionRoot = subproject?.root || null;
    this.shadowRoot = null;
  }

  async check(diff) {
    const steps = [];

    const inputValidation = this.runInputValidation(diff);
    steps.push(inputValidation);
    if (!inputValidation.passed) {
      return {
        committable: false,
        steps,
        summary: '1 check(s) failed: input-validation',
      };
    }

    try {
      this._createShadowWorkspace(diff);
      steps.push(await this.runParseCheck(diff));
      steps.push(await this.runTypeCheck(diff));
      steps.push(await this.runValidate(diff));
      steps.push(await this.runImpact(diff));
      steps.push(await this.runTests(diff));
    } finally {
      this._removeShadowWorkspace();
    }

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

  _createShadowWorkspace(diff) {
    const root = this.subproject?.root;
    const changes = diff?.files || [];
    if (!root || changes.length === 0 || process.env.ORACLE_GATE_USE_SHADOW === 'false') return;

    const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-gate-'));
    const excluded = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', 'target', 'dist', 'build']);
    const maxShadowFiles = positiveInt(process.env.ORACLE_GATE_MAX_SHADOW_FILES, 100_000);
    const maxShadowBytes = positiveInt(process.env.ORACLE_GATE_MAX_SHADOW_BYTES, 1024 * 1024 * 1024);
    let copiedFiles = 0;
    let copiedBytes = 0;
    try {
      fs.cpSync(root, shadow, {
        recursive: true,
        dereference: false,
        filter(source) {
          if (source === root) return true;
          if (excluded.has(path.basename(source))) return false;
          const sourceStat = fs.lstatSync(source);
          if (sourceStat.isFile()) {
            copiedFiles++;
            copiedBytes += sourceStat.size;
            if (copiedFiles > maxShadowFiles) throw new Error(`shadow file limit exceeded (${maxShadowFiles})`);
            if (copiedBytes > maxShadowBytes) throw new Error(`shadow size limit exceeded (${maxShadowBytes} bytes)`);
          }
          return true;
        },
      });

      for (const dependencyDir of ['node_modules', 'vendor', '.venv', 'venv']) {
        const source = path.join(root, dependencyDir);
        const target = path.join(shadow, dependencyDir);
        if (fs.existsSync(source) && !fs.existsSync(target)) {
          fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }

      for (const change of changes) {
        const target = path.join(shadow, change.path);
        if (change.action === 'delete' || change.deleted === true) {
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        } else if (typeof change.proposed_code === 'string') {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, change.proposed_code, 'utf-8');
        }
      }
      this.shadowRoot = shadow;
      this.executionRoot = shadow;
    } catch (err) {
      try { fs.rmSync(shadow, { recursive: true, force: true }); } catch {}
      throw new Error(`Failed to prepare isolated emit-gate workspace: ${err.message}`);
    }
  }

  _removeShadowWorkspace() {
    if (!this.shadowRoot) return;
    const tempRoot = path.resolve(os.tmpdir());
    const candidate = path.resolve(this.shadowRoot);
    const relative = path.relative(tempRoot, candidate);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(candidate).startsWith('oracle-gate-')) {
      try { fs.rmSync(candidate, { recursive: true, force: true }); } catch {}
    }
    this.shadowRoot = null;
    this.executionRoot = this.subproject?.root || null;
  }

  runInputValidation(diff) {
    const start = Date.now();
    const issues = [];
    const files = diff?.files;
    const maxFiles = positiveInt(process.env.ORACLE_GATE_MAX_FILES, 500);
    const maxCodeBytes = positiveInt(process.env.ORACLE_GATE_MAX_CODE_BYTES, 5 * 1024 * 1024);
    const maxTotalCodeBytes = positiveInt(process.env.ORACLE_GATE_MAX_TOTAL_CODE_BYTES, 20 * 1024 * 1024);
    const root = path.resolve(this.subproject?.root || process.cwd());
    let totalCodeBytes = 0;

    if (!Array.isArray(files)) {
      issues.push({ severity: 'error', message: 'Diff must contain a files array' });
    } else if (files.length > maxFiles) {
      issues.push({ severity: 'error', message: `Diff contains ${files.length} files; limit is ${maxFiles}` });
    } else {
      for (const file of files) {
        if (!file?.path || path.isAbsolute(file.path)) {
          issues.push({ severity: 'error', file: file?.path, message: 'File path must be relative to the subproject root' });
          continue;
        }
        const resolved = path.resolve(root, file.path);
        const relative = path.relative(root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          issues.push({ severity: 'error', file: file.path, message: 'File path escapes the subproject root' });
        }
        if (hasSymlinkComponent(root, file.path)) {
          issues.push({ severity: 'error', file: file.path, message: 'File path traverses a symbolic link' });
        }
        const isDelete = file.action === 'delete' || file.deleted === true;
        if (!isDelete && typeof file.proposed_code !== 'string') {
          issues.push({ severity: 'error', file: file.path, message: 'Each non-delete change must include proposed_code' });
        }
        if (typeof file.proposed_code === 'string') {
          const codeBytes = Buffer.byteLength(file.proposed_code);
          totalCodeBytes += codeBytes;
          if (codeBytes > maxCodeBytes) {
            issues.push({ severity: 'error', file: file.path, message: `Proposed code exceeds ${maxCodeBytes} bytes` });
          }
        }
      }
      if (totalCodeBytes > maxTotalCodeBytes) {
        issues.push({ severity: 'error', message: `Total proposed code exceeds ${maxTotalCodeBytes} bytes` });
      }
    }

    return {
      name: 'input-validation',
      passed: issues.length === 0,
      issues,
      durationMs: Date.now() - start,
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
    const root = this.executionRoot;
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
          if (autoCmd.perFile) {
            for (const file of (diff.files || []).filter(item => item.path?.endsWith(autoCmd.extension) && item.action !== 'delete' && item.deleted !== true)) {
              execFileSync(autoCmd.command, [...autoCmd.args, path.join(root, file.path)], {
                cwd: root,
                encoding: 'utf-8',
                timeout: 60_000,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            }
          } else {
            execFileSync(autoCmd.command, autoCmd.args, {
              cwd: root,
              encoding: 'utf-8',
              timeout: 60_000,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          }
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
    const root = this.executionRoot;
    if (!root) return null;

    if (lang === 'typescript' || lang === 'javascript') {
      if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
        const tsc = localBinary(root, 'tsc');
        if (tsc && commandWorks(tsc, ['--version'], root)) return { command: tsc, args: ['--noEmit'] };
      }
    }

    if (lang === 'php') {
      if (commandWorks('php', ['-v'], root)) {
        return { command: 'php', args: ['-l'], perFile: true, extension: '.php' };
      }
    }

    if (lang === 'dart') {
      if (commandWorks('dart', ['analyze', '--help'], root)) return { command: 'dart', args: ['analyze'] };
    }

    if (lang === 'go') {
      if (commandWorks('go', ['version'], root)) return { command: 'go', args: ['vet', './...'] };
    }

    if (lang === 'rust') {
      if (commandWorks('cargo', ['--version'], root)) return { command: 'cargo', args: ['check'] };
    }

    if (lang === 'java') {
      if (fs.existsSync(path.join(root, 'pom.xml'))) {
        if (commandWorks('mvn', ['--version'], root)) return { command: 'mvn', args: ['compile', '-q'] };
      }
      if (fs.existsSync(path.join(root, 'build.gradle'))) {
        if (commandWorks('gradle', ['--version'], root)) return { command: 'gradle', args: ['compileJava', '-q'] };
      }
    }

    if (lang === 'python') {
      if (commandWorks('mypy', ['--version'], root)) return { command: 'mypy', args: ['--ignore-missing-imports', '.'] };
      if (commandWorks('pyright', ['--version'], root)) return { command: 'pyright', args: [] };
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
    const root = this.executionRoot;

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
      const testFileArgs = affectedTestFiles.map(f => path.isAbsolute(f) ? path.relative(root, f) : f);
      let testArgs;
      const lower = testFrameworks[0]?.toLowerCase() || '';

      if (lower === 'phpunit') {
        const configFile = fs.existsSync(path.join(root, 'phpunit.xml')) ? 'phpunit.xml' : 'phpunit.xml.dist';
        testArgs = [...testCmd.args, '--configuration', configFile, ...testFileArgs];
      } else if (lower === 'jest') {
        testArgs = [...testCmd.args, '--runTestsByPath', ...testFileArgs];
      } else if (lower === 'vitest') {
        testArgs = [...testCmd.args, 'run', ...testFileArgs];
      } else if (lower === 'playwright') {
        testArgs = [...testCmd.args, ...testFileArgs];
      } else {
        testArgs = [...testCmd.args, ...testFileArgs];
      }

      execFileSync(testCmd.command, testArgs, {
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
    const root = this.executionRoot;
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
    const root = this.executionRoot;
    if (!root) return null;

    for (const fw of testFrameworks) {
      const lower = fw.toLowerCase();

      if (lower === 'phpunit') {
        if (fs.existsSync(path.join(root, 'vendor/bin/phpunit'))) {
          return { command: path.join(root, 'vendor/bin/phpunit'), args: [] };
        }
        if (commandWorks('phpunit', ['--version'], root)) return { command: 'phpunit', args: [] };
      }

      if (lower === 'jest') {
        const binary = localBinary(root, 'jest');
        if (binary && commandWorks(binary, ['--version'], root)) return { command: binary, args: ['--no-coverage'] };
      }

      if (lower === 'vitest') {
        const binary = localBinary(root, 'vitest');
        if (binary && commandWorks(binary, ['--version'], root)) return { command: binary, args: [] };
      }

      if (lower === 'mocha') {
        const binary = localBinary(root, 'mocha');
        if (binary && commandWorks(binary, ['--version'], root)) return { command: binary, args: [] };
      }

      if (lower === 'pytest') {
        if (commandWorks('pytest', ['--version'], root)) return { command: 'pytest', args: ['-x'] };
      }

      if (lower === 'playwright') {
        const binary = localBinary(root, 'playwright');
        if (binary && commandWorks(binary, ['--version'], root)) return { command: binary, args: ['test'] };
      }

      if (lower === 'flutter_test' || lower === 'dart') {
        if (commandWorks('flutter', ['test', '--help'], root)) return { command: 'flutter', args: ['test'] };
      }

      if (lower === 'go' || lower === 'go_test') {
        if (commandWorks('go', ['version'], root)) return { command: 'go', args: ['test'] };
      }

      if (lower === 'cargo' || lower === 'rust') {
        if (commandWorks('cargo', ['--version'], root)) return { command: 'cargo', args: ['test'] };
      }

      if (lower === 'unittest' || lower === 'python') {
        if (commandWorks('python', ['-m', 'pytest', '--version'], root)) return { command: 'python', args: ['-m', 'pytest', '-x'] };
        if (commandWorks('python', ['--version'], root)) return { command: 'python', args: ['-m', 'unittest'] };
      }

      if (lower === 'junit' || lower === 'maven') {
        if (commandWorks('mvn', ['--version'], root)) return { command: 'mvn', args: ['test', '-q'] };
      }

      if (lower === 'gradle') {
        if (commandWorks('gradle', ['--version'], root)) return { command: 'gradle', args: ['test'] };
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

function localBinary(root, name) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const candidate = path.join(root, 'node_modules', '.bin', `${name}${suffix}`);
  return fs.existsSync(candidate) ? candidate : null;
}

function commandWorks(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hasSymlinkComponent(root, relativePath) {
  let current = root;
  for (const segment of relativePath.replace(/\\/g, '/').split('/')) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
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
