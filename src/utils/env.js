import fs from 'node:fs';

export function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const POSITIVE_INTS = [
  'ORACLE_MAX_FILES', 'ORACLE_MAX_FILE_BYTES', 'ORACLE_DETECTOR_MAX_FILES',
  'ORACLE_MAX_DEPTH', 'ORACLE_MAX_TRAVERSAL_RESULTS',
  'ORACLE_READ_EXACT_MAX_LINES', 'ORACLE_READ_EXACT_MAX_BYTES',
  'ORACLE_GATE_MAX_FILES', 'ORACLE_GATE_MAX_CODE_BYTES', 'ORACLE_GATE_MAX_TOTAL_CODE_BYTES',
  'ORACLE_GATE_MAX_SHADOW_FILES', 'ORACLE_GATE_MAX_SHADOW_BYTES', 'ORACLE_LSP_TIMEOUT_MS',
  'ORACLE_MCP_CACHE_SIZE', 'ORACLE_MCP_MAX_BODY_BYTES', 'ORACLE_MCP_RATE_LIMIT_PER_MINUTE',
  'ORACLE_MCP_MAX_SESSIONS', 'ORACLE_MCP_SESSION_IDLE_MINUTES', 'ORACLE_MCP_MAX_CONNECTIONS',
  'ORACLE_MCP_HEADERS_TIMEOUT_MS', 'ORACLE_MCP_REQUEST_TIMEOUT_MS', 'ORACLE_MCP_KEEPALIVE_TIMEOUT_MS',
  'ORACLE_L3_TIMEOUT_MS', 'ORACLE_L3_MAX_TOKENS', 'ORACLE_L3_CONTEXT_TOKENS',
  'ORACLE_CONTEXT_MAX_NODES', 'ORACLE_MAX_EVIDENCE', 'ORACLE_TOKEN_CAP', 'ORACLE_TOKEN_CAP_EXTENDED',
  'ORACLE_LLM_CTX_SIZE', 'ORACLE_LLM_PARALLEL', 'ORACLE_LLM_START_TIMEOUT_MS',
];
// 0 is meaningful for these (disabled / unlimited / model default).
const NON_NEGATIVE_INTS = [
  'ORACLE_MCP_IDLE_TIMEOUT_MINUTES', 'ORACLE_EMBED_DIMENSIONS', 'ORACLE_EMBED_MAX_NODES',
  'ORACLE_EMBED_UNLOAD_TIMEOUT', 'ORACLE_L3_RETRIES', 'ORACLE_LLM_THREADS',
];
const BOOLEANS = [
  'ORACLE_DEBUG', 'ORACLE_EMBEDDINGS', 'ORACLE_GATE_USE_SHADOW', 'ORACLE_L3_ENABLED',
  'ORACLE_MCP_ADMIN_ENABLED', 'ORACLE_MCP_GATE_ENABLED', 'ORACLE_RESPECT_GITIGNORE',
];
const URLS = ['ORACLE_L3_BASE_URL', 'ORACLE_EMBED_API_URL'];

/**
 * Checks ORACLE_* settings once at startup so a typo fails loudly instead of
 * silently falling back to a default deep inside a request. Empty values
 * count as unset. Returns { errors, warnings } as human-readable strings.
 */
export function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const value = (name) => (env[name] ?? '').trim();
  const isSet = (name) => value(name) !== '';
  // Mirrors how the code reads flags: only ORACLE_EMBEDDINGS also accepts 1/0.
  const allowed = (name) => (name === 'ORACLE_EMBEDDINGS' ? ['true', 'false', '1', '0'] : ['true', 'false']);
  const isTrue = (name) => value(name) === 'true' || (name === 'ORACLE_EMBEDDINGS' && value(name) === '1');

  for (const name of POSITIVE_INTS) {
    if (isSet(name) && !/^[1-9]\d*$/.test(value(name))) errors.push(`${name} must be a positive integer (got '${value(name)}')`);
  }
  for (const name of NON_NEGATIVE_INTS) {
    if (isSet(name) && !/^\d+$/.test(value(name))) errors.push(`${name} must be a non-negative integer (got '${value(name)}')`);
  }
  for (const name of ['ORACLE_MCP_PORT', 'ORACLE_LLM_PORT']) {
    if (!isSet(name)) continue;
    const port = Number(value(name));
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`${name} must be 1-65535 (got '${value(name)}')`);
  }
  if (isSet('ORACLE_L3_TEMPERATURE')) {
    const t = Number(value('ORACLE_L3_TEMPERATURE'));
    if (!(t >= 0 && t <= 2)) errors.push(`ORACLE_L3_TEMPERATURE must be between 0 and 2 (got '${value('ORACLE_L3_TEMPERATURE')}')`);
  }
  if (isSet('ORACLE_L3_OUTPUT') && !['claims', 'text'].includes(value('ORACLE_L3_OUTPUT'))) {
    errors.push(`ORACLE_L3_OUTPUT must be claims or text (got '${value('ORACLE_L3_OUTPUT')}')`);
  }
  if (isSet('ORACLE_L3_REASONING_EFFORT') && !['none', 'minimal', 'low', 'medium', 'high'].includes(value('ORACLE_L3_REASONING_EFFORT'))) {
    errors.push(`ORACLE_L3_REASONING_EFFORT must be none, minimal, low, medium or high (got '${value('ORACLE_L3_REASONING_EFFORT')}')`);
  }
  for (const name of ['ORACLE_L3_EXTRA_BODY', 'ORACLE_L3_EXTRA_HEADERS']) {
    if (!isSet(name)) continue;
    let parsed;
    try { parsed = JSON.parse(value(name)); } catch {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push(`${name} must be a JSON object (got '${value(name).slice(0, 60)}')`);
  }
  if (isSet('ORACLE_LLM_GPU_LAYERS') && !/^(\d+|auto|all)$/.test(value('ORACLE_LLM_GPU_LAYERS'))) {
    errors.push(`ORACLE_LLM_GPU_LAYERS must be a number, auto or all (got '${value('ORACLE_LLM_GPU_LAYERS')}')`);
  }
  if (isSet('ORACLE_LLM_REASONING_BUDGET') && !/^(-1|\d+)$/.test(value('ORACLE_LLM_REASONING_BUDGET'))) {
    errors.push(`ORACLE_LLM_REASONING_BUDGET must be -1 (unlimited) or a non-negative integer (got '${value('ORACLE_LLM_REASONING_BUDGET')}')`);
  }
  if (isSet('ORACLE_L3_PROMPTS_DIR')) {
    const dir = value('ORACLE_L3_PROMPTS_DIR').replace(/^~/, process.env.HOME || '~');
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch {}
    if (!isDir) errors.push(`ORACLE_L3_PROMPTS_DIR is not a directory: ${dir}`);
  }
  if (isSet('ORACLE_LLM_CACHE_RAM_MIB') && !/^(-1|\d+)$/.test(value('ORACLE_LLM_CACHE_RAM_MIB'))) {
    errors.push(`ORACLE_LLM_CACHE_RAM_MIB must be -1 (no limit), 0 (off) or a size in MiB (got '${value('ORACLE_LLM_CACHE_RAM_MIB')}')`);
  }
  if (isSet('ORACLE_LLM_KV_CACHE_TYPE') && !['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'].includes(value('ORACLE_LLM_KV_CACHE_TYPE'))) {
    errors.push(`ORACLE_LLM_KV_CACHE_TYPE must be a llama.cpp cache type such as f16, q8_0 or q4_0 (got '${value('ORACLE_LLM_KV_CACHE_TYPE')}')`);
  }
  if (isSet('ORACLE_LLM_SHA256') && !/^[0-9a-fA-F]{64}$/.test(value('ORACLE_LLM_SHA256'))) {
    errors.push('ORACLE_LLM_SHA256 must be a 64-character hex SHA-256');
  }
  for (const name of BOOLEANS) {
    if (isSet(name) && !allowed(name).includes(value(name))) errors.push(`${name} must be true or false (got '${value(name)}')`);
  }
  for (const name of URLS) {
    if (!isSet(name)) continue;
    let protocol = null;
    try { protocol = new URL(value(name)).protocol; } catch {}
    if (protocol !== 'http:' && protocol !== 'https:') errors.push(`${name} must be an http(s) URL (got '${value(name)}')`);
  }
  if (isSet('ORACLE_BM25_K1') && !(Number(value('ORACLE_BM25_K1')) >= 0)) {
    errors.push(`ORACLE_BM25_K1 must be a non-negative number (got '${value('ORACLE_BM25_K1')}')`);
  }
  if (isSet('ORACLE_BM25_B')) {
    const b = Number(value('ORACLE_BM25_B'));
    if (!(b >= 0 && b <= 1)) errors.push(`ORACLE_BM25_B must be between 0 and 1 (got '${value('ORACLE_BM25_B')}')`);
  }
  if (isSet('ORACLE_OUTPUT_FORMAT') && !['toon', 'json'].includes(value('ORACLE_OUTPUT_FORMAT'))) {
    errors.push(`ORACLE_OUTPUT_FORMAT must be toon or json (got '${value('ORACLE_OUTPUT_FORMAT')}')`);
  }

  if (isTrue('ORACLE_L3_ENABLED')) {
    if (!isSet('ORACLE_L3_BASE_URL')) errors.push('ORACLE_L3_ENABLED=true requires ORACLE_L3_BASE_URL');
    if (!isSet('ORACLE_L3_MODEL')) warnings.push("ORACLE_L3_MODEL is not set; requests will use model 'default'");
  }
  if (isTrue('ORACLE_EMBEDDINGS') && !isSet('ORACLE_EMBED_MODEL')) {
    errors.push('ORACLE_EMBEDDINGS=true requires ORACLE_EMBED_MODEL');
  }
  if (isSet('ORACLE_EMBED_API_URL') && !isSet('ORACLE_EMBED_MODEL')) {
    errors.push('ORACLE_EMBED_API_URL requires ORACLE_EMBED_MODEL (otherwise the local model is used silently)');
  }
  if (isTrue('ORACLE_MCP_GATE_ENABLED') && !isTrue('ORACLE_MCP_ADMIN_ENABLED')) {
    warnings.push('ORACLE_MCP_GATE_ENABLED has no effect unless ORACLE_MCP_ADMIN_ENABLED=true');
  }

  return { errors, warnings };
}
