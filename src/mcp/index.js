import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { GraphStore } from '../graph/store.js';
import { GroundingWrapper } from '../grounding/index.js';
import { PatternCatalogue } from '../patterns/index.js';
import { ManifestDrafter } from '../manifest/index.js';
import { L2Index } from '../retrieval/index.js';
import { createParser } from '../parser/index.js';
import { loadWorkspace, getSubprojectDir } from '../scanner/workspace.js';
import { createL3Engine } from '../l3/config.js';
import { synthesizeWithL3 } from '../l3/synthesize.js';
import { WeightsThenPatch } from '../l3/weights-patch.js';
import { FileWatcher } from '../watcher/index.js';
import { toToon } from '../grounding/toon.js';

import { locate } from './tools/locate.js';
import { signature } from './tools/signature.js';
import { exists } from './tools/exists.js';
import { nearby } from './tools/nearby.js';
import { consumers } from './tools/consumers.js';
import { diffSince } from './tools/diff-since.js';
import { conventionsFor } from './tools/conventions-for.js';
import { whereWould } from './tools/where-would.js';
import { pattern } from './tools/pattern.js';
import { impact } from './tools/impact.js';
import { validate } from './tools/validate.js';
import { context } from './tools/context.js';
import { readExact } from './tools/read-exact.js';
import { stats } from './tools/graph-stats.js';
import {
  ingest as adminIngest,
  workspaceAdd, workspaceScan, workspaceListTool,
  status as adminStatus,
  gate as adminGate,
  manifestShow, patternsList,
} from './tools/admin.js';

import path from 'path';
import fs from 'fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { VERSION } from '../version.js';
import { positiveInt } from '../utils/env.js';

// Tool names, descriptions and input schemas (the text MCP clients show their
// model) live in prompts/mcp/tools.json, not in code.
const TOOL_DEFS = JSON.parse(fs.readFileSync(new URL('../../prompts/mcp/tools.json', import.meta.url), 'utf-8'));

const ADMIN_HANDLERS = {
  'oracle.ingest': adminIngest,
  'oracle.workspace_add': workspaceAdd,
  'oracle.workspace_scan': workspaceScan,
  'oracle.workspace_list': workspaceListTool,
  'oracle.status': adminStatus,
  'oracle.gate': adminGate,
  'oracle.manifest_show': manifestShow,
  'oracle.patterns_list': patternsList,
};

const TOOL_HANDLERS = {
  'oracle.locate': locate,
  'oracle.signature': signature,
  'oracle.exists': exists,
  'oracle.nearby': nearby,
  'oracle.consumers': consumers,
  'oracle.diff_since': diffSince,
  'oracle.conventions_for': conventionsFor,
  'oracle.where_would': whereWould,
  'oracle.pattern': pattern,
  'oracle.impact': impact,
  'oracle.validate': validate,
  'oracle.context': context,
  'oracle.read_exact': readExact,
  'oracle.stats': stats,
};

const MAX_CACHE_SIZE = positiveInt(process.env.ORACLE_MCP_CACHE_SIZE, 128);

class SimpleLruMap extends Map {
  constructor(maxSize, onEvict) {
    super();
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  get(key) {
    const value = super.get(key);
    if (value !== undefined) {
      // Re-insert to maintain LRU order
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  set(key, value) {
    if (this.has(key)) {
      super.delete(key);
    } else if (this.size >= this.maxSize) {
      const first = this.keys().next().value;
      this.delete(first);
    }
    super.set(key, value);
  }

  delete(key) {
    if (this.onEvict) this.onEvict(key, super.get(key));
    return super.delete(key);
  }
}

// Per-subproject resources. Reference-counted so a bundle that is evicted or
// superseded by a newer ingest is closed only after the last in-flight
// request using it has finished.
class ResourceBundle {
  constructor(store, version) {
    this.store = store;
    this.version = version;
    this.patterns = null;
    this.manifest = null;
    this.l2 = null;
    this.l3 = null;
    this.refs = 0;
    this.retired = false;
    this.lastAccessed = Date.now();
  }

  acquire() {
    this.refs++;
    this.lastAccessed = Date.now();
  }

  release() {
    this.refs--;
    if (this.retired && this.refs <= 0) this._close();
  }

  retire() {
    this.retired = true;
    if (this.refs <= 0) this._close();
  }

  _close() {
    try { this.store.close(); } catch {}
  }
}

const openBundles = new SimpleLruMap(MAX_CACHE_SIZE, (_key, bundle) => bundle?.retire());
// Watchers keep their own store and outlive cache eviction; they stop only on shutdown.
const activeWatchers = new Map();
let idleTimer = null;
let idleTimeoutMs = 0;
let sharedParser = null;
let watchEnabled = false;

function getParser() {
  if (!sharedParser) {
    sharedParser = createParser();
  }
  return sharedParser;
}

function closeIdleResources() {
  if (idleTimeoutMs <= 0) return;
  const cutoff = Date.now() - idleTimeoutMs;
  for (const [storeKey, bundle] of [...openBundles]) {
    if (bundle.lastAccessed < cutoff && bundle.refs === 0) openBundles.delete(storeKey);
  }
}

function startIdleTimer() {
  if (idleTimer) clearInterval(idleTimer);
  if (idleTimeoutMs > 0) {
    idleTimer = setInterval(closeIdleResources, 60_000);
  }
}

function getContext(workspaceId, subprojectId, { allowedRoots = [] } = {}) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);
  if (allowedRoots.length > 0 && !isRootAllowed(workspace.root, allowedRoots)) {
    throw new Error(`Workspace '${workspaceId}' is outside ORACLE_ALLOWED_ROOTS`);
  }

  const subproject = workspace.subprojects.find(s => s.id === subprojectId);
  if (!subproject) throw new Error(`Subproject '${subprojectId}' not found in workspace '${workspaceId}'`);
  if (allowedRoots.length > 0 && !isRootAllowed(subproject.root, allowedRoots)) {
    throw new Error(`Subproject '${subprojectId}' is outside ORACLE_ALLOWED_ROOTS`);
  }

  const storeKey = `${workspaceId}/${subprojectId}`;
  const resourceDir = getSubprojectDir(workspaceId, subprojectId);
  let bundle = openBundles.get(storeKey);
  if (fs.existsSync(path.join(resourceDir, '.ingest.lock'))) {
    // Keep serving the last complete build while a reindex runs. Opening a
    // fresh store mid-build would contend for the write lock, so without a
    // cached bundle the caller has to wait.
    if (!bundle) throw new Error(`Subproject '${storeKey}' is being reindexed; retry shortly`);
  } else {
    bundle = refreshBundle(storeKey, resourceDir, bundle);
  }
  if (watchEnabled && !activeWatchers.has(storeKey)) startWatcher(storeKey, workspace, subproject);

  // Build everything that can throw first; acquire last, so a failure here
  // never leaves the bundle with a reference nobody will release.
  const grounding = new GroundingWrapper(bundle.store, {
    parser: getParser(),
    subprojectRoot: subproject.root,
  });
  const weightsPatch = new WeightsThenPatch(bundle.store, bundle.patterns, bundle.manifest);
  bundle.acquire();

  let released = false;
  return {
    store: bundle.store,
    subproject,
    grounding,
    workspace,
    patterns: bundle.patterns,
    manifest: bundle.manifest,
    l2: bundle.l2,
    l3: bundle.l3,
    weightsPatch,
    allowedRoots,
    release() {
      if (released) return;
      released = true;
      bundle.release();
    },
  };
}

// Returns the cached bundle if it matches the current ingest version,
// otherwise retires it and opens a new one.
function refreshBundle(storeKey, resourceDir, bundle) {
  const ingestStatePath = path.join(resourceDir, 'ingest_state.json');
  let ingestVersion = null;
  if (fs.existsSync(ingestStatePath)) {
    try {
      const ingestState = JSON.parse(fs.readFileSync(ingestStatePath, 'utf-8'));
      ingestVersion = ingestState.updated_at || null;
      if (ingestState.status === 'failed' || ingestState.status === 'reset') {
        throw new Error(`Subproject '${storeKey}' is not ready; run oracle.ingest before querying`);
      }
    } catch (err) {
      if (err.message.includes('not ready')) throw err;
      throw new Error(`Subproject '${storeKey}' has an unreadable ingest state`, { cause: err });
    }
  }

  if (bundle && bundle.version === ingestVersion) return bundle;
  if (bundle) openBundles.delete(storeKey);
  return openBundle(storeKey, resourceDir, ingestVersion);
}

function openBundle(storeKey, dir, ingestVersion) {
  const dbPath = path.join(dir, 'entity_graph.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`Entity graph not built for ${storeKey}. Run 'oracle ingest' first.`);
  const bundle = new ResourceBundle(new GraphStore(dbPath), ingestVersion);
  try {
    bundle.patterns = new PatternCatalogue(bundle.store);
    const cataloguePath = path.join(dir, 'pattern_catalog.json');
    if (fs.existsSync(cataloguePath)) bundle.patterns.load(cataloguePath);

    bundle.manifest = new ManifestDrafter().load(path.join(dir, 'manifest.yaml')) || {};

    bundle.l2 = new L2Index(bundle.store, { indexPath: path.join(dir, 'ast_embed_index') });
    bundle.l2.load();

    bundle.l3 = createL3Engine();
  } catch (err) {
    bundle.retire();
    throw err;
  }
  openBundles.set(storeKey, bundle);
  return bundle;
}

function startWatcher(storeKey, workspace, subproject) {
  try {
    const watcher = new FileWatcher({ workspace, subproject });
    watcher.onReindex = (stats) => {
      console.error(`[watch] ${storeKey} reindexed: ${JSON.stringify(stats)}`);
    };
    activeWatchers.set(storeKey, watcher);
    watcher.start().catch((err) => {
      console.error(`[watch] failed to start watcher for ${storeKey}: ${err.message}`);
      watcher.stop();
      activeWatchers.delete(storeKey);
    });
  } catch (err) {
    console.error(`[watch] failed to start watcher for ${storeKey}: ${err.message}`);
  }
}

function enrichEvidence(raw, workspaceId, subprojectId, subproject) {
  if (!raw || !raw.evidence) return raw;
  const lang = subproject?.language || null;
  const root = subproject?.root || null;
  return {
    ...raw,
    evidence: raw.evidence.map((e) => ({
      ...e,
      workspace_id: e.workspace_id || workspaceId,
      subproject_id: e.subproject_id || subprojectId,
      subproject_root: e.subproject_root || root,
      lang: e.lang || lang,
    })),
  };
}

const CROSS_SUBPROJECT_REROUTE_TOOLS = new Set([
  'oracle.locate', 'oracle.exists', 'oracle.consumers',
  'oracle.signature', 'oracle.nearby', 'oracle.pattern',
]);
const CROSS_SUBPROJECT_HINT_TOOLS = new Set([
  ...CROSS_SUBPROJECT_REROUTE_TOOLS, 'oracle.context', 'oracle.conventions_for',
]);

// Sibling stores used only for cross-subproject symbol hints, keyed by DB path
// and reopened when the sibling's ingest version changes.
const siblingStores = new SimpleLruMap(32, (_key, entry) => {
  try { entry?.store.close(); } catch {}
});

function readIngestVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'ingest_state.json'), 'utf-8')).updated_at || null;
  } catch {
    return null;
  }
}

function getSiblingStore(workspaceId, subprojectId) {
  const dir = getSubprojectDir(workspaceId, subprojectId);
  const dbPath = path.join(dir, 'entity_graph.sqlite');
  if (!fs.existsSync(dbPath) || fs.existsSync(path.join(dir, '.ingest.lock'))) return null;
  const version = readIngestVersion(dir);
  const cached = siblingStores.get(dbPath);
  if (cached && cached.version === version) return cached.store;
  if (cached) siblingStores.delete(dbPath);
  const store = new GraphStore(dbPath);
  siblingStores.set(dbPath, { store, version });
  return store;
}

function findSiblingSubprojects(ctx, workspaceId, currentSubprojectId, toolArgs, toolName) {
  const { workspace, allowedRoots } = ctx;
  if (!workspace?.subprojects || workspace.subprojects.length <= 1) return [];
  if (!CROSS_SUBPROJECT_HINT_TOOLS.has(toolName)) return [];

  const searchTerm = toolArgs.symbol || toolArgs.description || toolArgs.target
    || toolArgs.name || toolArgs.intent || toolArgs.task || '';
  if (!searchTerm || searchTerm.length < 2) return [];

  const siblingIds = [];
  for (const sp of workspace.subprojects) {
    if (sp.id === currentSubprojectId) continue;
    if (allowedRoots.length > 0 && !isRootAllowed(sp.root, allowedRoots)) continue;
    try {
      const store = getSiblingStore(workspaceId, sp.id);
      if (store && store.locate(sp.id, searchTerm).length > 0) siblingIds.push(sp.id);
    } catch {}
  }
  return siblingIds;
}

function rerouteResponse(siblingIds, searchTerm, currentSubprojectId) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        needs_other_subproject: siblingIds,
        hint: `'${searchTerm}' was not found in ${currentSubprojectId} but exists in: ${siblingIds.join(', ')}. Re-route your query to the appropriate subproject.`,
        answer: null,
        evidence: [],
        confidence: 0,
        layer: 'L1',
      }),
    }],
  };
}

const FACTUAL_TOOLS = new Set([
  'oracle.locate', 'oracle.signature', 'oracle.exists',
  'oracle.consumers', 'oracle.impact', 'oracle.validate',
]);

// oracle.gate runs the project's type-checker and tests against client-supplied
// code, so on shared transports it needs its own opt-in on top of admin tools.
const CODE_EXECUTING_TOOLS = new Set(['oracle.gate']);

export async function createMcpServer({ allowAdmin = true, allowGate = allowAdmin, allowedRoots = [] } = {}) {
  const server = new Server(
    { name: 'llm-oracle', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.filter(tool => (allowAdmin || !ADMIN_HANDLERS[tool.name])
      && (allowGate || !CODE_EXECUTING_TOOLS.has(tool.name))),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    const adminHandler = ADMIN_HANDLERS[name];
    if (adminHandler) {
      if (!allowAdmin) {
        return {
          content: [{ type: 'text', text: JSON.stringify(toolErrorEnvelope('Administrative tools are disabled for this transport')) }],
          isError: true,
        };
      }
      if (!allowGate && CODE_EXECUTING_TOOLS.has(name)) {
        return {
          content: [{ type: 'text', text: JSON.stringify(toolErrorEnvelope(`${name} is disabled for this transport; set ORACLE_MCP_GATE_ENABLED=true to allow it`)) }],
          isError: true,
        };
      }
      try {
        if (allowedRoots.length > 0 && args?.workspace_id) {
          const requestedWorkspace = loadWorkspace(args.workspace_id);
          if (requestedWorkspace && !isRootAllowed(requestedWorkspace.root, allowedRoots)) {
            throw new Error(`Workspace '${args.workspace_id}' is outside ORACLE_ALLOWED_ROOTS`);
          }
        }
        const adminCtx = {
          allowedRoots,
          isRootAllowed(root) {
            return allowedRoots.length === 0 || isRootAllowed(root, allowedRoots);
          },
          evict(workspaceId, subprojectId) {
            openBundles.delete(`${workspaceId}/${subprojectId}`);
          },
        };
        const result = await adminHandler(adminCtx, args || {});
        const normalized = result?.answer !== undefined && Array.isArray(result?.evidence)
          ? result
          : {
              answer: result,
              evidence: [],
              confidence: result?.error ? 0 : 1,
              layer: 'L1',
            };
        const outputFormat = process.env.ORACLE_OUTPUT_FORMAT || 'toon';
        const text = outputFormat === 'toon' ? toToon(normalized) : JSON.stringify(normalized, null, 2);
        return { content: [{ type: 'text', text }], ...(result?.error ? { isError: true } : {}) };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify(toolErrorEnvelope(err.message)) }],
          isError: true,
        };
      }
    }

    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return {
        content: [{ type: 'text', text: JSON.stringify(toolErrorEnvelope(`Unknown tool: ${name}`)) }],
        isError: true,
      };
    }

    let ctx;
    try {
      const { workspace_id, subproject_id, ...toolArgs } = args;
      ctx = getContext(workspace_id, subproject_id, { allowedRoots });
      const raw = await handler(ctx, toolArgs);

      if (raw && raw._needs_other_subproject) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              needs_other_subproject: raw._needs_other_subproject,
              answer: null,
              evidence: [],
              confidence: 0,
              layer: 'L1',
            }),
          }],
        };
      }

      let enriched = enrichEvidence(raw, workspace_id, subproject_id, ctx.subproject);

      // L3 (optional): natural-language synthesis over the verified facts of
      // open-ended tools, accepted only if it cites nothing outside them.
      if (ctx.l3) {
        const { result: synthesized, outcome } = await synthesizeWithL3(ctx, name, toolArgs, enriched, {
          signal: extra?.signal,
          driftLogPath: path.join(getSubprojectDir(workspace_id, subproject_id), 'drift_log.json'),
        });
        enriched = synthesized;
        if (outcome.status === 'failed') logThrottled(`[l3] synthesis failed, using L1/L2 result: ${outcome.reason}`);
      }

      const result = ctx.grounding.wrap(enriched, name);

      if (FACTUAL_TOOLS.has(name) && result.layer && result.layer !== 'L1' && result.layer !== 'L2') {
        result._l1_preface_warning = `Factual tool ${name} returned from ${result.layer} without L1 preface — confidence reduced`;
        result.confidence = Math.min(result.confidence, 0.5);
        if (result.evidence && result.evidence.length > 0) {
          result.evidence = result.evidence.map(e => ({ ...e, _l1_verified: false }));
        }
      }

      const grounded = ctx.grounding.enforceEvidence(result, name);

      const siblingIds = findSiblingSubprojects(ctx, workspace_id, subproject_id, toolArgs, name);
      if (siblingIds.length > 0) {
        const notHere = grounded.answer?.found === false
          || grounded._error === 'no evidence attached — answer rejected per grounding rules';
        if (notHere && CROSS_SUBPROJECT_REROUTE_TOOLS.has(name)) {
          const searchTerm = toolArgs.symbol || toolArgs.description || toolArgs.target
            || toolArgs.name || toolArgs.intent || '';
          return rerouteResponse(siblingIds, searchTerm, subproject_id);
        }
        grounded._also_in = siblingIds;
      }

      const outputFormat = process.env.ORACLE_OUTPUT_FORMAT || 'toon';
      const text = outputFormat === 'toon' ? toToon(grounded) : JSON.stringify(grounded, null, 2);

      return {
        content: [{
          type: 'text',
          text,
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(toolErrorEnvelope(err.message)),
        }],
        isError: true,
      };
    } finally {
      ctx?.release();
    }
  });

  return server;
}

// Logs to stderr at most once a minute per distinct message, so a down L3
// endpoint is visible without flooding the log on every request.
const lastLogged = new Map();
function logThrottled(message) {
  const now = Date.now();
  if (now - (lastLogged.get(message) || 0) < 60_000) return;
  lastLogged.set(message, now);
  if (lastLogged.size > 100) lastLogged.delete(lastLogged.keys().next().value);
  console.error(message);
}

function toolErrorEnvelope(message) {
  return { answer: { error: message }, evidence: [], confidence: 0, layer: 'L1' };
}

export async function startMcpServer(opts = {}) {
  const {
    transport: requestedTransport = 'stdio',
    port = 3000,
    host = process.env.ORACLE_MCP_HOST || '127.0.0.1',
    idleTimeoutMinutes = 0,
    watch = false,
  } = opts;
  const transportType = requestedTransport === 'sse' ? 'http' : requestedTransport;
  if (!['stdio', 'http'].includes(transportType)) {
    throw new Error(`Unsupported transport '${requestedTransport}'. Use 'stdio' or 'http'.`);
  }
  idleTimeoutMs = idleTimeoutMinutes > 0 ? idleTimeoutMinutes * 60_000 : 0;
  watchEnabled = watch;
  startIdleTimer();

  if (transportType === 'http') {
    const http = await import('node:http');
    const { URL } = await import('node:url');

    const authToken = process.env.ORACLE_MCP_AUTH_TOKEN || '';
    const loopback = isLoopbackHost(host);
    if (authToken && Buffer.byteLength(authToken) < 32) {
      throw new Error('ORACLE_MCP_AUTH_TOKEN must contain at least 32 bytes');
    }
    if (!loopback && !authToken) {
      throw new Error('ORACLE_MCP_AUTH_TOKEN is required when binding MCP HTTP to a non-loopback host');
    }

    const allowAdmin = process.env.ORACLE_MCP_ADMIN_ENABLED === 'true';
    const allowGate = allowAdmin && process.env.ORACLE_MCP_GATE_ENABLED === 'true';
    const allowedRoots = parseAllowedRoots(process.env.ORACLE_ALLOWED_ROOTS || '');
    if (allowAdmin && allowedRoots.length === 0) {
      throw new Error('ORACLE_ALLOWED_ROOTS is required when HTTP administrative tools are enabled');
    }

    const maxBodyBytes = positiveInt(process.env.ORACLE_MCP_MAX_BODY_BYTES, 1_048_576);
    const rateLimit = positiveInt(process.env.ORACLE_MCP_RATE_LIMIT_PER_MINUTE, 120);
    const maxSessions = positiveInt(process.env.ORACLE_MCP_MAX_SESSIONS, 100);
    const sessionIdleMs = positiveInt(process.env.ORACLE_MCP_SESSION_IDLE_MINUTES, 30) * 60_000;
    const allowedHosts = new Set(parseCsv(process.env.ORACLE_MCP_ALLOWED_HOSTS || ''));
    const allowedOrigins = new Set(parseCsv(process.env.ORACLE_MCP_ALLOWED_ORIGINS || ''));
    if (!loopback && allowedHosts.size === 0) {
      throw new Error('ORACLE_MCP_ALLOWED_HOSTS is required when binding MCP HTTP to a non-loopback host');
    }
    if (allowedHosts.size === 0 && loopback) {
      for (const value of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) allowedHosts.add(value);
    }
    const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

    const transports = new Map();
    const sessionServers = new Map();
    const sessionLastAccess = new Map();
    const clients = new Map();
    const sessionTimer = setInterval(async () => {
      const cutoff = Date.now() - sessionIdleMs;
      for (const [sid, timestamp] of sessionLastAccess) {
        if (timestamp >= cutoff) continue;
        sessionLastAccess.delete(sid);
        const transport = transports.get(sid);
        if (transport) try { await transport.close(); } catch {}
      }
    }, 60_000);
    sessionTimer.unref?.();

    return new Promise((resolve, reject) => {
      const httpServer = http.createServer(async (req, res) => {
        setSecurityHeaders(res);
        try {
          const parsed = new URL(req.url || '/', `http://${urlHost}:${port}`);
          if (parsed.pathname === '/healthz' || parsed.pathname === '/readyz') {
            return sendJson(res, 200, { status: 'ok' });
          }
          if (parsed.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' });
          if (!isHostAllowed(req.headers.host, allowedHosts) || !isOriginAllowed(req.headers.origin, allowedOrigins)) {
            return sendJson(res, 403, { error: 'forbidden host or origin' });
          }
          if (!authenticateRequest(req, authToken)) return sendJson(res, 401, { error: 'unauthorized' });
          if (!consumeRateLimit(clients, req.socket.remoteAddress || 'unknown', rateLimit)) {
            res.setHeader('Retry-After', '60');
            return sendJson(res, 429, { error: 'rate limit exceeded' });
          }

          const sessionId = req.headers['mcp-session-id'];
          let transport = typeof sessionId === 'string' ? transports.get(sessionId) : null;
          if (transport) sessionLastAccess.set(sessionId, Date.now());
          let body;

          if (req.method === 'POST') {
            body = await readJsonBody(req, maxBodyBytes);
            if (!transport && !sessionId && isInitializeRequest(body)) {
              if (transports.size >= maxSessions) return sendJson(res, 503, jsonRpcError('MCP session limit reached'));
              let sessionServer;
              let createdTransport;
              createdTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                  transports.set(sid, createdTransport);
                  sessionServers.set(sid, sessionServer);
                  sessionLastAccess.set(sid, Date.now());
                },
              });
              sessionServer = await createMcpServer({ allowAdmin, allowGate, allowedRoots });
              createdTransport.onclose = async () => {
                const sid = createdTransport.sessionId;
                if (sid) transports.delete(sid);
                if (sid) sessionServers.delete(sid);
                if (sid) sessionLastAccess.delete(sid);
                try { await sessionServer.close(); } catch {}
              };
              await sessionServer.connect(createdTransport);
              transport = createdTransport;
            }
          }

          if (!transport) return sendJson(res, 400, jsonRpcError('No valid MCP session'));
          await transport.handleRequest(req, res, body);
        } catch (err) {
          const status = err?.statusCode || 500;
          if (!res.headersSent) sendJson(res, status, jsonRpcError(status === 500 ? 'Internal server error' : err.message));
          else if (!res.writableEnded) res.end();
        }
      });

      httpServer.maxHeadersCount = 100;
      httpServer.maxConnections = positiveInt(process.env.ORACLE_MCP_MAX_CONNECTIONS, 200);
      httpServer.headersTimeout = positiveInt(process.env.ORACLE_MCP_HEADERS_TIMEOUT_MS, 10_000);
      httpServer.requestTimeout = positiveInt(process.env.ORACLE_MCP_REQUEST_TIMEOUT_MS, 120_000);
      httpServer.keepAliveTimeout = positiveInt(process.env.ORACLE_MCP_KEEPALIVE_TIMEOUT_MS, 5_000);
      httpServer.on('clientError', (_err, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
      let listening = false;
      httpServer.on('error', err => {
        clearInterval(sessionTimer);
        if (!listening) reject(err);
        else console.error(`[oracle] MCP HTTP server error: ${err.message}`);
      });

      httpServer.listen(port, host, () => {
        listening = true;
        console.error(`MCP server listening on http://${urlHost}:${port}/mcp`);
        setupGracefulShutdown({ httpServer, transports, sessionServers, timers: [sessionTimer] });
        resolve({ httpServer, transports });
      });
    });
  }

  const server = await createMcpServer({ allowAdmin: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  setupGracefulShutdown({ server });

  return { server };
}

function setupGracefulShutdown({ server, httpServer, transports = new Map(), sessionServers = new Map(), timers = [] }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[oracle] ${signal} received, shutting down...`);

    if (idleTimer) clearInterval(idleTimer);
    for (const timer of timers) clearInterval(timer);

    for (const [key, watcher] of activeWatchers) {
      try { watcher.stop(); } catch {}
      activeWatchers.delete(key);
    }

    for (const [key] of [...openBundles]) openBundles.delete(key);
    for (const [key] of [...siblingStores]) siblingStores.delete(key);

    for (const transport of transports.values()) {
      try { await transport.close(); } catch {}
    }
    for (const sessionServer of sessionServers.values()) {
      if (sessionServer) try { await sessionServer.close(); } catch {}
    }
    if (server) try { await server.close(); } catch {}

    if (httpServer) {
      await Promise.race([
        new Promise(resolve => httpServer.close(resolve)),
        new Promise(resolve => setTimeout(resolve, 5_000)),
      ]);
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function parseCsv(value) {
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

function parseAllowedRoots(value) {
  return parseCsv(value).map(root => {
    const resolved = path.resolve(root);
    let canonical;
    try { canonical = fs.realpathSync(resolved); }
    catch { throw new Error(`Allowed root does not exist: ${resolved}`); }
    if (!fs.statSync(canonical).isDirectory()) throw new Error(`Allowed root is not a directory: ${resolved}`);
    return canonical;
  });
}

function isRootAllowed(root, allowedRoots) {
  let canonical;
  try { canonical = fs.realpathSync(path.resolve(root)); } catch { return false; }
  return allowedRoots.some(base => {
    const relative = path.relative(base, canonical);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function isHostAllowed(host, allowed) {
  return allowed.size === 0 || (typeof host === 'string' && allowed.has(host));
}

function isOriginAllowed(origin, allowed) {
  return !origin || (allowed.size > 0 && allowed.has(origin));
}

function authenticateRequest(req, expectedToken) {
  if (!expectedToken) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const received = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function consumeRateLimit(clients, key, limit) {
  const now = Date.now();
  if (clients.size > 10_000) {
    for (const [clientKey, value] of clients) {
      if (now - value.startedAt >= 60_000) clients.delete(clientKey);
    }
    if (clients.size > 10_000 && !clients.has(key)) return false;
  }
  const entry = clients.get(key);
  if (!entry || now - entry.startedAt >= 60_000) {
    clients.set(key, { startedAt: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      const err = new Error('request body too large');
      err.statusCode = 413;
      reject(err);
      return;
    }

    let size = 0;
    const chunks = [];
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        const err = new Error('request body too large');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch {
        const err = new Error('invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
}

function sendJson(res, status, value) {
  if (res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function jsonRpcError(message) {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}
