import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { getOracleHome } from '../scanner/workspace.js';
import { positiveInt } from '../utils/env.js';

/**
 * Manages an optional local llama.cpp server (`llama-server`) that L3 can use
 * through its OpenAI-compatible API. Nothing here installs software: the
 * binary must already exist (see README "Local model (llama.cpp)"). Every
 * setting comes from ORACLE_LLM_* environment variables.
 */
export function llmConfig(env = process.env) {
  const value = (name, fallback = '') => (env[name] ?? '').trim() || fallback;
  const home = getOracleHome();
  const file = value('ORACLE_LLM_HF_FILE', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  const modelsDir = expandHome(value('ORACLE_LLM_MODELS_DIR', path.join(home, 'models')));
  return {
    bin: value('ORACLE_LLM_BIN', 'llama-server'),
    repo: value('ORACLE_LLM_HF_REPO', 'unsloth/Qwen3-4B-Instruct-2507-GGUF'),
    file,
    revision: value('ORACLE_LLM_HF_REVISION', 'main'),
    sha256: value('ORACLE_LLM_SHA256').toLowerCase(),
    hfToken: value('ORACLE_LLM_HF_TOKEN'),
    modelsDir,
    modelPath: expandHome(value('ORACLE_LLM_MODEL_PATH', path.join(modelsDir, file))),
    host: value('ORACLE_LLM_HOST', '127.0.0.1'),
    port: positiveInt(value('ORACLE_LLM_PORT'), 8321),
    alias: value('ORACLE_LLM_ALIAS', path.basename(file, '.gguf')),
    apiKey: value('ORACLE_LLM_API_KEY'),
    // L3 prompts are ~1K tokens and answers <= ORACLE_L3_MAX_TOKENS: a small
    // context, quantized KV cache and capped prompt cache keep RAM low.
    ctxSize: positiveInt(value('ORACLE_LLM_CTX_SIZE'), 32768),
    kvCacheType: value('ORACLE_LLM_KV_CACHE_TYPE', 'q8_0'),
    cacheRamMib: value('ORACLE_LLM_CACHE_RAM_MIB', '256'),
    gpuLayers: value('ORACLE_LLM_GPU_LAYERS', 'all'),
    threads: value('ORACLE_LLM_THREADS'),
    parallel: positiveInt(value('ORACLE_LLM_PARALLEL'), 1),
    reasoningBudget: value('ORACLE_LLM_REASONING_BUDGET', '0'),
    extraArgs: value('ORACLE_LLM_EXTRA_ARGS').split(/\s+/).filter(Boolean),
    startTimeoutMs: positiveInt(value('ORACLE_LLM_START_TIMEOUT_MS'), 120_000),
    stateDir: path.join(home, 'llm'),
  };
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const pidFile = (cfg) => path.join(cfg.stateDir, 'llama-server.pid');
const logFile = (cfg) => path.join(cfg.stateDir, 'llama-server.log');
const baseUrl = (cfg) => `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`;
const authHeaders = (cfg) => (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});

// ── download ──────────────────────────────────────────────────────────────

/**
 * Downloads the GGUF from Hugging Face into the models dir, resuming a
 * partial file, then verifies its SHA-256 (ORACLE_LLM_SHA256, or the LFS
 * checksum Hugging Face publishes for the file).
 */
export async function downloadModel(cfg, { log = () => {} } = {}) {
  const expected = cfg.sha256 || await publishedSha256(cfg);
  if (fs.existsSync(cfg.modelPath)) {
    if (!expected || await sha256File(cfg.modelPath) === expected) {
      log(`Model already present: ${cfg.modelPath}`);
      return { path: cfg.modelPath, downloaded: false };
    }
    throw new Error(`${cfg.modelPath} exists but its SHA-256 does not match ${expected}. Delete it and download again.`);
  }

  fs.mkdirSync(path.dirname(cfg.modelPath), { recursive: true });
  const partial = `${cfg.modelPath}.part`;
  const offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const url = `https://huggingface.co/${cfg.repo}/resolve/${encodeURIComponent(cfg.revision)}/${cfg.file.split('/').map(encodeURIComponent).join('/')}`;
  log(`Downloading ${cfg.repo}/${cfg.file}${offset ? ` (resuming at ${formatBytes(offset)})` : ''}`);
  log(`  -> ${cfg.modelPath}`);

  const res = await fetch(url, {
    headers: {
      ...(offset ? { Range: `bytes=${offset}-` } : {}),
      ...(cfg.hfToken ? { Authorization: `Bearer ${cfg.hfToken}` } : {}),
    },
    redirect: 'follow',
  });
  if (res.status === 416) {
    // The partial file is already complete.
  } else if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}${res.status === 401 || res.status === 403 ? ' (gated or private repo: set ORACLE_LLM_HF_TOKEN)' : ''}`);
  } else {
    const resumed = res.status === 206;
    const total = Number(res.headers.get('content-length') || 0) + (resumed ? offset : 0);
    const out = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' });
    let received = resumed ? offset : 0;
    let lastReport = 0;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        received += chunk.length;
        if (Date.now() - lastReport > 2000) {
          lastReport = Date.now();
          log(`  ${formatBytes(received)}${total ? ` / ${formatBytes(total)} (${Math.floor((received / total) * 100)}%)` : ''}`);
        }
      }
    } finally {
      await new Promise(resolve => out.end(resolve));
    }
  }

  if (expected) {
    log('Verifying SHA-256 ...');
    const actual = await sha256File(partial);
    if (actual !== expected) {
      fs.unlinkSync(partial);
      throw new Error(`SHA-256 mismatch (expected ${expected}, got ${actual}); the partial download was deleted`);
    }
  } else {
    log('No checksum available to verify against (set ORACLE_LLM_SHA256 to enforce one).');
  }
  fs.renameSync(partial, cfg.modelPath);
  log(`Saved ${formatBytes(fs.statSync(cfg.modelPath).size)} to ${cfg.modelPath}`);
  return { path: cfg.modelPath, downloaded: true };
}

async function publishedSha256(cfg) {
  try {
    const dir = path.posix.dirname(cfg.file);
    const url = `https://huggingface.co/api/models/${cfg.repo}/tree/${encodeURIComponent(cfg.revision)}${dir === '.' ? '' : `/${dir}`}`;
    const res = await fetch(url, { headers: cfg.hfToken ? { Authorization: `Bearer ${cfg.hfToken}` } : {} });
    if (!res.ok) return '';
    const entry = (await res.json()).find(e => e.path === cfg.file);
    return entry?.lfs?.oid || '';
  } catch {
    return '';
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// ── start / stop / status ─────────────────────────────────────────────────

/** Starts llama-server in the background and waits until it serves requests. */
export async function startServer(cfg, { log = () => {} } = {}) {
  const running = readPid(cfg);
  if (running) {
    log(`llama-server already running (pid ${running}) at ${baseUrl(cfg)}/v1`);
    return { pid: running, baseUrl: `${baseUrl(cfg)}/v1`, alreadyRunning: true };
  }
  if (!isLoopback(cfg.host) && !cfg.apiKey) {
    throw new Error(`Refusing to bind llama-server to ${cfg.host} without ORACLE_LLM_API_KEY`);
  }
  if (!fs.existsSync(cfg.modelPath)) {
    throw new Error(`Model not found: ${cfg.modelPath}. Run \`oracle llm download\` first.`);
  }
  assertBinary(cfg.bin);

  const args = [
    '--model', cfg.modelPath,
    '--alias', cfg.alias,
    '--host', cfg.host,
    '--port', String(cfg.port),
    '--ctx-size', String(cfg.ctxSize),
    '--n-gpu-layers', cfg.gpuLayers,
    '--parallel', String(cfg.parallel),
    '--reasoning-budget', cfg.reasoningBudget,
    '--cache-type-k', cfg.kvCacheType,
    '--cache-type-v', cfg.kvCacheType,
    '--cache-ram', cfg.cacheRamMib,
    '--no-webui',
    ...(cfg.threads ? ['--threads', cfg.threads] : []),
    ...cfg.extraArgs,
  ];

  fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logFile(cfg), 'w', 0o600);
  // The API key goes through the environment, not argv, so `ps` doesn't show it.
  const child = spawn(cfg.bin, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...(cfg.apiKey ? { LLAMA_API_KEY: cfg.apiKey } : {}) },
  });
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(pidFile(cfg), String(child.pid), { mode: 0o600 });
  log(`Starting llama-server (pid ${child.pid}): ${cfg.alias} on ${baseUrl(cfg)} ...`);

  const deadline = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) {
      fs.rmSync(pidFile(cfg), { force: true });
      throw new Error(`llama-server exited during startup. Last log lines:\n${tailLog(cfg, 20)}`);
    }
    if ((await health(cfg)).ok) {
      log(`Ready: ${baseUrl(cfg)}/v1 (model "${cfg.alias}", log ${logFile(cfg)})`);
      return { pid: child.pid, baseUrl: `${baseUrl(cfg)}/v1`, alreadyRunning: false };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await stopServer(cfg, { log: () => {} });
  throw new Error(`llama-server did not become ready within ${cfg.startTimeoutMs} ms. Last log lines:\n${tailLog(cfg, 20)}`);
}

export async function stopServer(cfg, { log = () => {} } = {}) {
  const pid = readPid(cfg);
  if (!pid) {
    log('llama-server is not running.');
    return { stopped: false };
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise(resolve => setTimeout(resolve, 250));
  if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  fs.rmSync(pidFile(cfg), { force: true });
  log(`Stopped llama-server (pid ${pid}).`);
  return { stopped: true, pid };
}

export async function serverStatus(cfg) {
  const pid = readPid(cfg);
  const status = {
    running: !!pid,
    pid: pid || null,
    baseUrl: `${baseUrl(cfg)}/v1`,
    model: cfg.alias,
    modelPath: cfg.modelPath,
    modelPresent: fs.existsSync(cfg.modelPath),
    modelBytes: fs.existsSync(cfg.modelPath) ? fs.statSync(cfg.modelPath).size : 0,
    log: logFile(cfg),
  };
  if (!pid) return status;
  status.health = (await health(cfg)).status;
  status.rssBytes = processRss(pid);
  try {
    const res = await fetch(`${baseUrl(cfg)}/v1/models`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(3000) });
    if (res.ok) status.servedModels = ((await res.json()).data || []).map(m => m.id);
  } catch {}
  return status;
}

/** Resident memory of a process in bytes (macOS/Linux `ps`), or null. */
export function processRss(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' }).trim()) * 1024 || null;
  } catch {
    return null;
  }
}

/** PID of our llama-server if it is still that process; clears stale files. */
export function readPid(cfg) {
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile(cfg), 'utf-8'), 10);
  } catch {
    return null;
  }
  let command = '';
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
  } catch {}
  // A reused PID belongs to some other program: never signal it.
  if (!isAlive(pid) || !command.includes(path.basename(cfg.bin))) {
    fs.rmSync(pidFile(cfg), { force: true });
    return null;
  }
  return pid;
}

async function health(cfg) {
  try {
    const res = await fetch(`${baseUrl(cfg)}/health`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(2000) });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: body.status || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: `unreachable (${err.cause?.code || err.message})` };
  }
}

function assertBinary(bin) {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    throw new Error(`'${bin}' not found. Install llama.cpp yourself (macOS: \`brew install llama.cpp\`; other platforms: https://github.com/ggml-org/llama.cpp), or set ORACLE_LLM_BIN to the llama-server path. Oracle never installs it for you.`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function tailLog(cfg, lines) {
  try {
    return fs.readFileSync(logFile(cfg), 'utf-8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 2 : 0)} ${units[i]}`;
}
