import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'node:util';
import fg from 'fast-glob';
import { globFiles } from '../utils/glob.js';
import os from 'node:os';
import { positiveInt } from '../utils/env.js';
import { possibleCallSites, relatedMethods } from '../graph/usage.js';

const execFileAsyncRaw = promisify(execFile);
// execFile pipes stdin; close it so a tool that reads stdin exits instead of
// waiting for input until its timeout.
function execFileAsync(command, args, options) {
  const pending = execFileAsyncRaw(command, args, options);
  pending.child.stdin?.end();
  return pending;
}
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

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
      await this._createShadowWorkspace(diff);
      steps.push(await this.runParseCheck(diff));
      steps.push(await this.runTypeCheck(diff));
      steps.push(await this.runValidate(diff));
      steps.push(await this.runImpact(diff));
      steps.push(await this.runTests(diff));
    } finally {
      await this._removeShadowWorkspace();
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

  // Async throughout: copying up to ORACLE_GATE_MAX_SHADOW_BYTES must not block
  // the event loop (and with it every other MCP session).
  async _createShadowWorkspace(diff) {
    const root = this.subproject?.root;
    const changes = diff?.files || [];
    if (!root || changes.length === 0 || process.env.ORACLE_GATE_USE_SHADOW === 'false') return;

    const shadow = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oracle-gate-'));
    const excluded = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', 'target', 'dist', 'build']);
    const maxShadowFiles = positiveInt(process.env.ORACLE_GATE_MAX_SHADOW_FILES, 100_000);
    const maxShadowBytes = positiveInt(process.env.ORACLE_GATE_MAX_SHADOW_BYTES, 1024 * 1024 * 1024);
    let copiedFiles = 0;
    let copiedBytes = 0;
    try {
      await fs.promises.cp(root, shadow, {
        recursive: true,
        dereference: false,
        async filter(source) {
          if (source === root) return true;
          if (excluded.has(path.basename(source))) return false;
          const sourceStat = await fs.promises.lstat(source);
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
          await fs.promises.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
        }
      }

      for (const change of changes) {
        const target = path.join(shadow, change.path);
        if (change.action === 'delete' || change.deleted === true) {
          await fs.promises.rm(target, { recursive: true, force: true });
        } else if (typeof change.proposed_code === 'string') {
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.writeFile(target, change.proposed_code, 'utf-8');
        }
      }
      this.shadowRoot = shadow;
      this.executionRoot = shadow;
    } catch (err) {
      try { await fs.promises.rm(shadow, { recursive: true, force: true }); } catch {}
      throw new Error(`Failed to prepare isolated emit-gate workspace: ${err.message}`, { cause: err });
    }
  }

  async _removeShadowWorkspace() {
    if (!this.shadowRoot) return;
    const tempRoot = path.resolve(os.tmpdir());
    const candidate = path.resolve(this.shadowRoot);
    const relative = path.relative(tempRoot, candidate);
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(candidate).startsWith('oracle-gate-')) {
      try { await fs.promises.rm(candidate, { recursive: true, force: true }); } catch {}
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
      const { diagnostics, unavailable } = await this._runLspTypecheck(diff, lspConfig, root);
      // A missing language server is an environment gap, not a code defect.
      if (unavailable) issues.push({ severity: 'info', message: `Typecheck skipped: ${unavailable}` });
      for (const d of diagnostics) {
        issues.push({
          severity: d.severity,
          file: d.file,
          line: d.line,
          message: d.message,
        });
      }
    } else {
      const autoCmd = await this._detectTypecheckCommand(lang);
      if (autoCmd) {
        try {
          if (autoCmd.perFile) {
            for (const file of (diff.files || []).filter(item => item.path?.endsWith(autoCmd.extension) && item.action !== 'delete' && item.deleted !== true)) {
              await execFileAsync(autoCmd.command, [...autoCmd.args, path.join(root, file.path)], {
                cwd: root,
                encoding: 'utf-8',
                timeout: 60_000,
                maxBuffer: EXEC_MAX_BUFFER,
              });
            }
          } else {
            await execFileAsync(autoCmd.command, autoCmd.args, {
              cwd: root,
              encoding: 'utf-8',
              timeout: 60_000,
              maxBuffer: EXEC_MAX_BUFFER,
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
    if (!root || !lspConfig?.cmd) return { diagnostics: [], unavailable: null };

    const files = (diff.files || []).filter(f => f.proposed_code);
    if (files.length === 0) return { diagnostics: [], unavailable: null };

    const diagnostics = [];
    let lspProcess = null;
    let unavailable = null;

    try {
      // Configs saved before `npx --no` was the default would let npx download
      // and run a package from the registry; force install-free mode.
      const cmd = lspConfig.cmd.replace(/^npx\s+(?!--no\b|--no-install\b)/, 'npx --no ');
      const cmdParts = cmd.split(/\s+/);
      lspProcess = spawn(cmdParts[0], cmdParts.slice(1), {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });

      let msgId = 0;
      const pending = new Map();
      // A server that can't start (missing binary, npx --no refusing to
      // install) fails pending requests now instead of after their timeout.
      const failPending = (reason) => {
        unavailable = unavailable || reason;
        for (const { reject } of pending.values()) reject(new Error(reason));
        pending.clear();
      };
      lspProcess.on('error', (err) => failPending(`could not start '${lspConfig.cmd}': ${err.message}`));
      lspProcess.on('exit', (code) => {
        if (code) failPending(`'${lspConfig.cmd}' exited with code ${code}`);
      });
      const notifications = [];
      let buffer = '';

      const sendRaw = (payload) => {
        const msg = JSON.stringify(payload);
        const header = `Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n`;
        lspProcess.stdin.write(header + msg);
      };

      const lspTimeout = positiveInt(process.env.ORACLE_LSP_TIMEOUT_MS, 10_000);
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
              severity: d.severity === 1 ? 'error' : 'warning',
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
      if (!unavailable) diagnostics.push({ severity: 'error', file: null, line: null, message: `LSP error: ${err.message}` });
    } finally {
      if (lspProcess) {
        try { lspProcess.kill(); } catch {}
      }
    }

    return { diagnostics, unavailable };
  }

  async _detectTypecheckCommand(lang) {
    const root = this.executionRoot;
    if (!root) return null;

    if (lang === 'typescript' || lang === 'javascript') {
      if (fs.existsSync(path.join(root, 'tsconfig.json'))) {
        const tsc = localBinary(root, 'tsc');
        if (tsc && await commandWorks(tsc, ['--version'], root)) return { command: tsc, args: ['--noEmit'] };
      }
    }

    if (lang === 'php') {
      if (await commandWorks('php', ['-v'], root)) {
        return { command: 'php', args: ['-l'], perFile: true, extension: '.php' };
      }
    }

    if (lang === 'dart') {
      if (await commandWorks('dart', ['analyze', '--help'], root)) return { command: 'dart', args: ['analyze'] };
    }

    if (lang === 'go') {
      if (await commandWorks('go', ['version'], root)) return { command: 'go', args: ['vet', './...'] };
    }

    if (lang === 'rust') {
      if (await commandWorks('cargo', ['--version'], root)) return { command: 'cargo', args: ['check'] };
    }

    if (lang === 'java') {
      if (fs.existsSync(path.join(root, 'pom.xml'))) {
        if (await commandWorks('mvn', ['--version'], root)) return { command: 'mvn', args: ['compile', '-q'] };
      }
      if (fs.existsSync(path.join(root, 'build.gradle'))) {
        if (await commandWorks('gradle', ['--version'], root)) return { command: 'gradle', args: ['compileJava', '-q'] };
      }
    }

    if (lang === 'python') {
      if (await commandWorks('mypy', ['--version'], root)) return { command: 'mypy', args: ['--ignore-missing-imports', '.'] };
      if (await commandWorks('pyright', ['--version'], root)) return { command: 'pyright', args: [] };
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

  // Breaking = an exported symbol that other files use is removed or changes
  // signature. Decided structurally from the proposed code (same extractor as
  // ingest), not from how many nodes a file touches.
  async runImpact(diff) {
    const start = Date.now();
    const issues = [];
    const subprojectId = this.subproject?.id;
    const root = this.executionRoot || this.subproject?.root;

    for (const change of diff.files || []) {
      if (!change.path) continue;
      try {
        const breaks = await this._breakingChanges(change, subprojectId, root);
        if (breaks.length > 0) {
          issues.push({
            severity: 'error',
            file: change.path,
            message: `Breaking change: ${breaks.map(b => `${b.symbol} ${b.reason}`).join('; ')}`,
            symbols: breaks,
          });
        }
        if (change.change_description) {
          // Free-text intent can still reveal schema work the code diff doesn't show.
          const { impact } = await import('../mcp/tools/impact.js');
          const result = impact({ store: this.store, subproject: this.subproject, manifest: this.manifest }, { change: change.change_description });
          if (result.answer.migration_needed) {
            issues.push({ severity: 'warning', file: change.path, message: `Migration recommended: ${result.answer.recommendation}` });
          }
        }
      } catch (err) {
        issues.push({ severity: 'warning', file: change.path, message: `Impact analysis failed: ${err.message}` });
      }
    }

    return {
      name: 'oracle.impact',
      passed: !issues.some((i) => i.severity === 'error'),
      issues,
      durationMs: Date.now() - start,
    };
  }

  async _breakingChanges(change, subprojectId, root) {
    if (!this.store) return [];
    // Anything used from another file counts, exported or not: class methods
    // are not "exported" in JS/TS, yet callers break when they change.
    // Callers through the interface/parent declaration count too.
    const usersOf = (node) => {
      const direct = this.store.getConsumers(node.id);
      const viaParent = relatedMethods(this.store, subprojectId, node).overrides.flatMap(decl => this.store.getConsumers(decl.id));
      return [...direct, ...viaParent].filter(c => c.path !== change.path);
    };
    const used = this.store.getNodesByFile(subprojectId, change.path)
      .map(node => ({ node, consumers: usersOf(node) }))
      .filter(entry => entry.consumers.length > 0 || entry.node.exported);
    if (used.length === 0) return [];

    const describe = (node, consumers, reason) => {
      const possible = possibleCallSites(this.store, subprojectId, this.subproject?.root, node).sites;
      return {
        symbol: node.symbol,
        kind: node.kind,
        reason,
        consumers: consumers.length,
        consumer_files: [...new Set(consumers.map(c => c.path))].slice(0, 10),
        ...(possible.length > 0 ? { possible_call_site_files: possible.map(p => p.path).slice(0, 10) } : {}),
      };
    };

    if (change.action === 'delete' || change.deleted === true) {
      return used.filter(({ consumers }) => consumers.length > 0).map(({ node, consumers }) => describe(node, consumers, 'removed (file deleted)'));
    }
    if (typeof change.proposed_code !== 'string') return [];

    const { extractFromSource } = await import('../graph/builder.js');
    let proposed;
    try {
      proposed = await extractFromSource(change.proposed_code, path.join(root, change.path), change.path, subprojectId, this.parser);
    } catch {
      return []; // unparseable: the parse step reports it
    }
    if (!proposed) return [];

    const normalize = (sig) => String(sig || '').replace(/\s+/g, ' ').trim();
    const breaks = [];
    for (const { node, consumers } of used) {
      if (consumers.length === 0 && possibleCallSites(this.store, subprojectId, this.subproject?.root, node).sites.length === 0) continue;
      const match = proposed.nodes.find(n => n.symbol === node.symbol && n.kind === node.kind);
      if (!match || !match.exported) {
        breaks.push(describe(node, consumers, match ? 'no longer exported' : 'removed'));
      } else if (normalize(match.signature) !== normalize(node.signature)) {
        breaks.push(describe(node, consumers, `signature changed: ${normalize(node.signature)} -> ${normalize(match.signature)}`));
      }
    }
    return breaks;
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
    const affectedTestFiles = await this._findAffectedTests(changedPaths);

    if (affectedTestFiles.length === 0) {
      return {
        name: 'affected-tests',
        passed: true,
        issues: [{ severity: 'info', message: 'No affected test files detected.' }],
        durationMs: Date.now() - start,
      };
    }

    const testCmd = await this._detectTestCommand(testFrameworks);
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

      await execFileAsync(testCmd.command, testArgs, {
        cwd: root,
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: EXEC_MAX_BUFFER,
      });
      issues.push({
        severity: 'info',
        message: `${affectedTestFiles.length} affected test(s) passed.`,
      });
    } catch (err) {
      issues.push({
        severity: 'error',
        message: `Test failure: ${summarizeTestFailure(err)}`,
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

  async _findAffectedTests(changedPaths) {
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
      // Escaped: file names may contain glob syntax ([id].js, (group)/page.tsx).
      const base = fg.escapePath(path.basename(changed, path.extname(changed)));
      const dir = fg.escapePath(path.dirname(changed));

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

      try {
        for (const m of await globFiles(patterns, { cwd: root, absolute: false })) testFiles.add(m);
      } catch {}
    }

    return [...testFiles];
  }

  async _detectTestCommand(testFrameworks) {
    const root = this.executionRoot;
    if (!root) return null;

    for (const fw of testFrameworks) {
      const lower = fw.toLowerCase();

      if (lower === 'phpunit') {
        if (fs.existsSync(path.join(root, 'vendor/bin/phpunit'))) {
          return { command: path.join(root, 'vendor/bin/phpunit'), args: [] };
        }
        if (await commandWorks('phpunit', ['--version'], root)) return { command: 'phpunit', args: [] };
      }

      if (lower === 'jest') {
        const binary = localBinary(root, 'jest');
        if (binary && await commandWorks(binary, ['--version'], root)) return { command: binary, args: ['--no-coverage'] };
      }

      if (lower === 'vitest') {
        const binary = localBinary(root, 'vitest');
        if (binary && await commandWorks(binary, ['--version'], root)) return { command: binary, args: [] };
      }

      if (lower === 'node-test') {
        // Same Node binary as the oracle: always available, no probe needed.
        return { command: process.execPath, args: ['--test'] };
      }

      if (lower === 'mocha') {
        const binary = localBinary(root, 'mocha');
        if (binary && await commandWorks(binary, ['--version'], root)) return { command: binary, args: [] };
      }

      if (lower === 'pytest') {
        if (await commandWorks('pytest', ['--version'], root)) return { command: 'pytest', args: ['-x'] };
      }

      if (lower === 'playwright') {
        const binary = localBinary(root, 'playwright');
        if (binary && await commandWorks(binary, ['--version'], root)) return { command: binary, args: ['test'] };
      }

      if (lower === 'flutter_test' || lower === 'dart') {
        if (await commandWorks('flutter', ['test', '--help'], root)) return { command: 'flutter', args: ['test'] };
      }

      if (lower === 'go' || lower === 'go_test') {
        if (await commandWorks('go', ['version'], root)) return { command: 'go', args: ['test'] };
      }

      if (lower === 'cargo' || lower === 'rust') {
        if (await commandWorks('cargo', ['--version'], root)) return { command: 'cargo', args: ['test'] };
      }

      if (lower === 'unittest' || lower === 'python') {
        if (await commandWorks('python', ['-m', 'pytest', '--version'], root)) return { command: 'python', args: ['-m', 'pytest', '-x'] };
        if (await commandWorks('python', ['--version'], root)) return { command: 'python', args: ['-m', 'unittest'] };
      }

      if (lower === 'junit' || lower === 'maven') {
        if (await commandWorks('mvn', ['--version'], root)) return { command: 'mvn', args: ['test', '-q'] };
      }

      if (lower === 'gradle') {
        if (await commandWorks('gradle', ['--version'], root)) return { command: 'gradle', args: ['test'] };
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
    /^ {2}(.+?):(\d+):(\d+):\s*error:\s*(.+)$/gm,
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

async function commandWorks(command, args, cwd) {
  try {
    await execFileAsync(command, args, { cwd, timeout: 5000, maxBuffer: EXEC_MAX_BUFFER });
    return true;
  } catch {
    return false;
  }
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

// The useful part of a failed test run: failing test names and their error
// lines (TAP `not ok` blocks), else the tail of the output, which is where
// runners print the failure summary.
function summarizeTestFailure(err) {
  if (err.killed || err.signal) return `test run terminated (${err.signal || 'timeout'})`;
  const output = `${err.stdout || ''}\n${err.stderr || ''}`;
  const lines = output.split('\n');
  const picked = [];
  for (let i = 0; i < lines.length && picked.length < 20; i++) {
    if (!/^\s*not ok\b/.test(lines[i])) continue;
    picked.push(lines[i].trim());
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      if (/^\s*(not )?ok\b/.test(lines[j])) break;
      if (!/^\s*(error|message|failureType|expected|actual|code):/.test(lines[j])) continue;
      picked.push(`  ${lines[j].trim()}`);
      // YAML block scalar (`error: |-`): the message is on the following lines.
      if (/:\s*\|-?\s*$/.test(lines[j])) {
        for (let k = j + 1; k < Math.min(lines.length, j + 4) && !/^\s*\w+:/.test(lines[k]); k++) {
          if (lines[k].trim()) picked.push(`    ${lines[k].trim()}`);
        }
      }
    }
  }
  // A file that fails to load (bad import, syntax error) is reported only as
  // "test failed"; the cause is in diagnostic lines like "# SyntaxError: ...".
  const causes = [...new Set(lines
    .map(line => line.replace(/^\s*#\s*/, '').trim())
    .filter(line => /^(\w+Error|Error)\b.*:/.test(line)))].slice(0, 5);
  const text = picked.length > 0 ? [...causes, ...picked].join('\n') : lines.filter(Boolean).slice(-15).join('\n');
  return text.slice(0, 2000);
}
