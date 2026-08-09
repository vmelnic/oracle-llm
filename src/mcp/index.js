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
import { L3InferenceEngine } from '../l3/inference.js';
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

const TOOL_DEFS = [
  {
    name: 'oracle.locate',
    description: 'Find definitions of a symbol. Returns definitions[] and references_count.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        symbol: { type: 'string', description: 'Symbol name to find' },
        kind: { type: 'string', description: 'Optional kind filter (function, class, method, route, component, etc.)' },
      },
      required: ['workspace_id', 'subproject_id', 'symbol'],
    },
  },
  {
    name: 'oracle.signature',
    description: 'Get the signature, type info, and doc for a symbol or location.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        path: { type: 'string', description: 'File path (relative to subproject root)' },
        line: { type: 'number', description: 'Line number' },
        symbol: { type: 'string', description: 'Symbol name (alternative to path+line)' },
      },
      required: ['workspace_id', 'subproject_id'],
    },
  },
  {
    name: 'oracle.exists',
    description: 'Search for something by description. Returns whether it exists and candidates.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        description: { type: 'string', description: 'What to search for' },
      },
      required: ['workspace_id', 'subproject_id', 'description'],
    },
  },
  {
    name: 'oracle.nearby',
    description: 'Find symbols near a location in a file, ranked by proximity and intent.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        path: { type: 'string' },
        line: { type: 'number' },
        intent: { type: 'string', description: 'What you are looking for' },
      },
      required: ['workspace_id', 'subproject_id', 'path', 'line'],
    },
  },
  {
    name: 'oracle.consumers',
    description: 'Find all consumers of a symbol (transitive, BFS).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        target: { type: 'string', description: 'Symbol name or node ID' },
        kind: { type: 'string', description: 'Optional kind filter' },
      },
      required: ['workspace_id', 'subproject_id', 'target'],
    },
  },
  {
    name: 'oracle.diff_since',
    description: 'Show changed files and symbols since a git ref.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        ref: { type: 'string', description: 'Git ref (commit, branch, tag)' },
        scope: { type: 'string', description: 'Optional scope filter' },
      },
      required: ['workspace_id', 'subproject_id', 'ref'],
    },
  },
  {
    name: 'oracle.conventions_for',
    description: 'Get conventions for a topic: patterns, canonical examples, manifest rules.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        topic: { type: 'string', description: 'Topic: migrations, auth, validation, errors, routing, state, etc.' },
      },
      required: ['workspace_id', 'subproject_id', 'topic'],
    },
  },
  {
    name: 'oracle.where_would',
    description: 'Suggest where new code should be placed based on existing structure.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        intent: { type: 'string', description: 'What you want to create, e.g. "therapist registration API"' },
      },
      required: ['workspace_id', 'subproject_id', 'intent'],
    },
  },
  {
    name: 'oracle.pattern',
    description: 'Look up a named pattern from the catalogue.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        name: { type: 'string', description: 'Pattern name or kind' },
        context: { type: 'string', description: 'Optional context for relevance ranking' },
      },
      required: ['workspace_id', 'subproject_id', 'name'],
    },
  },
  {
    name: 'oracle.impact',
    description: 'Analyze impact of a proposed change. Returns breaking status, affected routes/components, migration needs.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        change: { type: 'string', description: 'Description of the change, e.g. "add status column to therapist_profiles"' },
      },
      required: ['workspace_id', 'subproject_id', 'change'],
    },
  },
  {
    name: 'oracle.validate',
    description: 'Validate proposed code against conventions and patterns.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        path: { type: 'string', description: 'File path for the proposed code' },
        proposed_code: { type: 'string', description: 'The code to validate' },
      },
      required: ['workspace_id', 'subproject_id', 'path', 'proposed_code'],
    },
  },
  {
    name: 'oracle.context',
    description: 'Bundled discovery — the primary tool. Returns full task packet: existing files, suggested creates/modifies, DB schema, patterns, conventions, relevant code.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        task: { type: 'string', description: 'Task description, e.g. "Add therapist registration"' },
      },
      required: ['workspace_id', 'subproject_id', 'task'],
    },
  },
  {
    name: 'oracle.read_exact',
    description: 'Read exact lines from a file. The only way to get verbatim code.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        path: { type: 'string', description: 'File path (relative to subproject root)' },
        line_range: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '[start_line, end_line]',
        },
      },
      required: ['workspace_id', 'subproject_id', 'path', 'line_range'],
    },
  },
  {
    name: 'oracle.stats',
    description: 'Get node/edge counts by kind for debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
      },
      required: ['workspace_id', 'subproject_id'],
    },
  },
  {
    name: 'oracle.ingest',
    description: 'Ingest (build/rebuild) entity graph, patterns, manifest, contracts, L2 index, and markdown docs for a workspace or subproject.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string', description: 'Optional — ingests all subprojects if omitted' },
        embeddings: { type: 'boolean', description: 'Enable semantic embeddings (default: env ORACLE_EMBEDDINGS)' },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'oracle.workspace_add',
    description: 'Register a new workspace by scanning a directory for subprojects.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to project root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'oracle.workspace_scan',
    description: 'Re-scan an existing workspace to detect new or removed subprojects.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
      },
      required: ['workspace_id'],
    },
  },
  {
    name: 'oracle.workspace_list',
    description: 'List all registered workspaces and their subprojects.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'oracle.status',
    description: 'Show layer status (L1/L2/L3), node/edge counts for workspaces and subprojects.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Optional — shows all workspaces if omitted' },
      },
    },
  },
  {
    name: 'oracle.gate',
    description: 'Run emit gate (pre-commit validation) on a proposed diff. Checks: parse errors, conventions, impact, tests.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
        diff: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              action: { type: 'string', enum: ['add', 'modify', 'delete'] },
              deleted: { type: 'boolean' },
            },
          },
          description: 'Array of {path, content} objects representing the proposed changes',
        },
      },
      required: ['workspace_id', 'subproject_id', 'diff'],
    },
  },
  {
    name: 'oracle.manifest_show',
    description: 'Show the manifest (framework, conventions, migrations, tests, etc.) for a subproject.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
      },
      required: ['workspace_id', 'subproject_id'],
    },
  },
  {
    name: 'oracle.patterns_list',
    description: 'List all patterns in the pattern catalogue for a subproject.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string' },
        subproject_id: { type: 'string' },
      },
      required: ['workspace_id', 'subproject_id'],
    },
  },
];

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

function evictResources(key, cachedStore) {
  const store = cachedStore || Map.prototype.get.call(openStores, key);
  if (store) { try { store.close(); } catch {} }
  openPatterns.delete(key);
  loadedManifests.delete(key);
  openL2.delete(key);
  loadedL3.delete(key);
  loadedStateVersions.delete(key);
  lastAccessed.delete(key);
  const watcher = activeWatchers.get(key);
  if (watcher) {
    try { watcher.stop(); } catch {}
    activeWatchers.delete(key);
  }
}

const openStores = new SimpleLruMap(MAX_CACHE_SIZE, evictResources);
const openPatterns = new Map();
const loadedManifests = new Map();
const openL2 = new Map();
const loadedL3 = new Map();
const loadedStateVersions = new Map();
const lastAccessed = new Map();
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

function touch(storeKey) {
  lastAccessed.set(storeKey, Date.now());
}

function closeIdleResources() {
  if (idleTimeoutMs <= 0) return;
  const cutoff = Date.now() - idleTimeoutMs;
  for (const [storeKey, ts] of lastAccessed) {
    if (ts < cutoff) {
      openStores.delete(storeKey);
    }
  }
}

function startIdleTimer() {
  if (idleTimer) clearInterval(idleTimer);
  if (idleTimeoutMs > 0) {
    idleTimer = setInterval(closeIdleResources, 60_000);
  }
}

function getContext(workspaceId, subprojectId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const subproject = workspace.subprojects.find(s => s.id === subprojectId);
  if (!subproject) throw new Error(`Subproject '${subprojectId}' not found in workspace '${workspaceId}'`);

  const storeKey = `${workspaceId}/${subprojectId}`;
  const resourceDir = getSubprojectDir(workspaceId, subprojectId);
  if (fs.existsSync(path.join(resourceDir, '.ingest.lock'))) {
    throw new Error(`Subproject '${storeKey}' is being reindexed; retry shortly`);
  }
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
      throw new Error(`Subproject '${storeKey}' has an unreadable ingest state`);
    }
  }
  if (openStores.has(storeKey) && loadedStateVersions.get(storeKey) !== ingestVersion) {
    openStores.delete(storeKey);
  }
  touch(storeKey);

  if (!openStores.has(storeKey)) {
    const dir = resourceDir;
    const dbPath = path.join(dir, 'entity_graph.sqlite');
    if (!fs.existsSync(dbPath)) throw new Error(`Entity graph not built for ${storeKey}. Run 'oracle ingest' first.`);
    openStores.set(storeKey, new GraphStore(dbPath));
    loadedStateVersions.set(storeKey, ingestVersion);
  }

  if (!openPatterns.has(storeKey)) {
    const dir = getSubprojectDir(workspaceId, subprojectId);
    const catalogue = new PatternCatalogue(openStores.get(storeKey));
    const cataloguePath = path.join(dir, 'pattern_catalog.json');
    if (fs.existsSync(cataloguePath)) catalogue.load(cataloguePath);
    openPatterns.set(storeKey, catalogue);
  }

  if (!loadedManifests.has(storeKey)) {
    const dir = getSubprojectDir(workspaceId, subprojectId);
    const manifestPath = path.join(dir, 'manifest.yaml');
    const drafter = new ManifestDrafter();
    loadedManifests.set(storeKey, drafter.load(manifestPath) || {});
  }

  if (!openL2.has(storeKey)) {
    const dir = getSubprojectDir(workspaceId, subprojectId);
    const l2 = new L2Index(openStores.get(storeKey), { indexPath: path.join(dir, 'ast_embed_index.json') });
    l2.load();
    openL2.set(storeKey, l2);
  }

  if (!loadedL3.has(storeKey)) {
    const l3Enabled = process.env.ORACLE_L3_ENABLED === 'true';
    if (l3Enabled && process.env.ORACLE_L3_BASE_URL) {
      loadedL3.set(storeKey, new L3InferenceEngine({
        baseUrl: process.env.ORACLE_L3_BASE_URL,
        model: process.env.ORACLE_L3_MODEL || 'default',
        apiKey: process.env.ORACLE_L3_API_KEY,
      }));
    }
  }

  if (watchEnabled && !activeWatchers.has(storeKey)) {
    try {
      const watcher = new FileWatcher({ workspace, subproject });
      watcher.onReindex = (stats) => {
        console.error(`[watch] ${storeKey} reindexed: ${JSON.stringify(stats)}`);
      };
      watcher.start();
      activeWatchers.set(storeKey, watcher);
    } catch (err) {
      console.error(`[watch] failed to start watcher for ${storeKey}: ${err.message}`);
    }
  }

  return {
    store: openStores.get(storeKey),
    subproject,
    grounding: new GroundingWrapper(openStores.get(storeKey), {
      parser: getParser(),
      subprojectRoot: subproject.root,
    }),
    workspace,
    patterns: openPatterns.get(storeKey),
    manifest: loadedManifests.get(storeKey),
    l2: openL2.get(storeKey),
    l3: loadedL3.get(storeKey) || null,
    weightsPatch: new WeightsThenPatch(openStores.get(storeKey), openPatterns.get(storeKey), loadedManifests.get(storeKey)),
  };
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

function checkCrossSubproject(workspace, workspaceId, currentSubprojectId, toolArgs, toolName) {
  if (!workspace?.subprojects || workspace.subprojects.length <= 1) return null;

  const searchTools = new Set([
    'oracle.locate', 'oracle.exists', 'oracle.consumers',
    'oracle.signature', 'oracle.nearby', 'oracle.pattern',
  ]);
  if (!searchTools.has(toolName)) return null;

  const searchTerm = toolArgs.symbol || toolArgs.description || toolArgs.target
    || toolArgs.name || toolArgs.intent || '';
  if (!searchTerm || searchTerm.length < 2) return null;

  const siblingIds = [];
  for (const sp of workspace.subprojects) {
    if (sp.id === currentSubprojectId) continue;
    try {
      const dir = getSubprojectDir(workspaceId, sp.id);
      const dbPath = path.join(dir, 'entity_graph.sqlite');
      if (!fs.existsSync(dbPath)) continue;
      const siblingStore = new GraphStore(dbPath);
      try {
        const found = siblingStore.locate(sp.id, searchTerm);
        if (found.length > 0) siblingIds.push(sp.id);
      } finally {
        siblingStore.close();
      }
    } catch {}
  }

  if (siblingIds.length === 0) return null;

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

function checkCrossSubprojectHint(workspace, workspaceId, currentSubprojectId, toolArgs, toolName) {
  if (!workspace?.subprojects || workspace.subprojects.length <= 1) return null;

  const hintTools = new Set([
    'oracle.locate', 'oracle.exists', 'oracle.consumers',
    'oracle.signature', 'oracle.nearby', 'oracle.pattern',
    'oracle.context', 'oracle.conventions_for',
  ]);
  if (!hintTools.has(toolName)) return null;

  const searchTerm = toolArgs.symbol || toolArgs.description || toolArgs.target
    || toolArgs.name || toolArgs.intent || toolArgs.task || '';
  if (!searchTerm || searchTerm.length < 2) return null;

  const siblingIds = [];
  for (const sp of workspace.subprojects) {
    if (sp.id === currentSubprojectId) continue;
    try {
      const dir = getSubprojectDir(workspaceId, sp.id);
      const dbPath = path.join(dir, 'entity_graph.sqlite');
      if (!fs.existsSync(dbPath)) continue;
      const siblingStore = new GraphStore(dbPath);
      try {
        const found = siblingStore.locate(sp.id, searchTerm);
        if (found.length > 0) siblingIds.push(sp.id);
      } finally {
        siblingStore.close();
      }
    } catch {}
  }

  if (siblingIds.length === 0) return null;
  return siblingIds;
}

function buildL1Context(l1Result, ctx) {
  const parts = [];

  if (l1Result.evidence && l1Result.evidence.length > 0) {
    for (const e of l1Result.evidence) {
      const loc = e.line_range ? `:${e.line_range[0]}-${e.line_range[1]}` : '';
      const kind = e.kind ? ` (${e.kind})` : '';
      parts.push(`- ${e.symbol || e.path}${kind}, ${e.path}${loc}`);
    }
  }

  if (l1Result.answer) {
    const a = l1Result.answer;
    if (a.existing_files) {
      for (const f of a.existing_files) {
        const symbols = f.symbols?.map(s => s.name || s).join(', ') || '';
        parts.push(`- file: ${f.path}${symbols ? ' — ' + symbols : ''}`);
      }
    }
    if (a.patterns) {
      for (const p of a.patterns) {
        parts.push(`- pattern: ${p.name || p.kind} — ${p.summary || ''}`);
      }
    }
    if (a.conventions) {
      for (const c of a.conventions) {
        parts.push(`- convention: ${c}`);
      }
    }
  }

  return parts.join('\n');
}

const FACTUAL_TOOLS = new Set([
  'oracle.locate', 'oracle.signature', 'oracle.exists',
  'oracle.consumers', 'oracle.impact', 'oracle.validate',
]);

export async function createMcpServer({ allowAdmin = true, allowedRoots = [] } = {}) {
  const server = new Server(
    { name: 'llm-oracle', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowAdmin ? TOOL_DEFS : TOOL_DEFS.filter(tool => !ADMIN_HANDLERS[tool.name]),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const adminHandler = ADMIN_HANDLERS[name];
    if (adminHandler) {
      if (!allowAdmin) {
        return {
          content: [{ type: 'text', text: JSON.stringify(toolErrorEnvelope('Administrative tools are disabled for this transport')) }],
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
            const storeKey = `${workspaceId}/${subprojectId}`;
            openStores.delete(storeKey);
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

    try {
      const { workspace_id, subproject_id, ...toolArgs } = args;
      const ctx = getContext(workspace_id, subproject_id);
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

      // L3 augmentation for open-ended tools — inject L1 context into the model prompt
      const OPEN_ENDED_TOOLS = new Set([
        'oracle.context', 'oracle.where_would', 'oracle.conventions_for',
      ]);
      if (OPEN_ENDED_TOOLS.has(name) && ctx.l3?.isAvailable()) {
        try {
          const verifiedL1Evidence = (enriched.evidence || []).filter(item => ctx.grounding.verifyEvidence(item));
          if (verifiedL1Evidence.length === 0) throw new Error('No verified L1 evidence available for L3 synthesis');
          const l1Context = buildL1Context({ ...enriched, evidence: verifiedL1Evidence }, ctx);
          const l3Result = await ctx.l3.query(JSON.stringify(toolArgs), { maxTokens: 512, l1Context });
          const synthesisValidation = ctx.weightsPatch.validateSynthesis(
            l3Result,
            verifiedL1Evidence,
            subproject_id,
          );

          if (synthesisValidation.accepted) {
            enriched = {
              ...enriched,
              answer: enriched.answer,
              _l3_synthesis: l3Result.text,
              evidence: verifiedL1Evidence,
              layer: 'L3',
            };
          }

          if (!synthesisValidation.accepted) {
            ctx.weightsPatch.recordDrift(subproject_id, synthesisValidation.reason);
            const dir = getSubprojectDir(workspace_id, subproject_id);
            const driftPath = path.join(dir, 'drift_log.json');
            try { ctx.weightsPatch.saveDriftLog(driftPath); } catch {}
          }
        } catch {
          // L3 failed — fall back to L1/L2 result silently
        }
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

      if (grounded._error === 'no evidence attached — answer rejected per grounding rules') {
        const crossCheck = checkCrossSubproject(
          ctx.workspace, workspace_id, subproject_id, toolArgs, name
        );
        if (crossCheck) return crossCheck;
      }

      const siblingHint = checkCrossSubprojectHint(
        ctx.workspace, workspace_id, subproject_id, toolArgs, name
      );
      if (siblingHint) {
        grounded._also_in = siblingHint;
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
    }
  });

  return server;
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
              sessionServer = await createMcpServer({ allowAdmin, allowedRoots });
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

    for (const [key] of [...openStores]) openStores.delete(key);

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

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
