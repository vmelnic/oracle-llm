import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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

const MAX_CACHE_SIZE = parseInt(process.env.ORACLE_MCP_CACHE_SIZE || '10', 10);

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

function evictResources(key) {
  const store = openStores.get(key);
  if (store) { try { store.close(); } catch {} }
  openPatterns.delete(key);
  loadedManifests.delete(key);
  openL2.delete(key);
  loadedL3.delete(key);
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
      evictResources(storeKey);
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
  touch(storeKey);

  if (!openStores.has(storeKey)) {
    const dir = getSubprojectDir(workspaceId, subprojectId);
    const dbPath = path.join(dir, 'entity_graph.sqlite');
    if (!fs.existsSync(dbPath)) throw new Error(`Entity graph not built for ${storeKey}. Run 'oracle ingest' first.`);
    openStores.set(storeKey, new GraphStore(dbPath));
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
    grounding: new GroundingWrapper(openStores.get(storeKey), { parser: getParser() }),
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
      const found = siblingStore.locate(sp.id, searchTerm);
      siblingStore.close();
      if (found.length > 0) siblingIds.push(sp.id);
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
      const found = siblingStore.locate(sp.id, searchTerm);
      siblingStore.close();
      if (found.length > 0) siblingIds.push(sp.id);
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

export async function createMcpServer() {
  const server = new Server(
    { name: 'llm-oracle', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const adminHandler = ADMIN_HANDLERS[name];
    if (adminHandler) {
      try {
        const adminCtx = {
          evict(workspaceId, subprojectId) {
            const storeKey = `${workspaceId}/${subprojectId}`;
            evictResources(storeKey);
            openStores.delete(storeKey);
          },
        };
        const result = await adminHandler(adminCtx, args || {});
        const outputFormat = process.env.ORACLE_OUTPUT_FORMAT || 'toon';
        const text = outputFormat === 'toon' ? toToon(result) : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }

    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }] };
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
          const l1Context = buildL1Context(enriched, ctx);
          const l3Result = await ctx.l3.query(JSON.stringify(toolArgs), { maxTokens: 512, l1Context });
          const patched = ctx.weightsPatch.validate({
            answer: { text: l3Result.text },
            evidence: l3Result.evidence,
            confidence: 0.75,
            layer: 'L3',
          }, subproject_id);

          if (patched._patches === 0 && l3Result.evidence.length > 0) {
            enriched = {
              ...enriched,
              answer: enriched.answer,
              _l3_synthesis: l3Result.text,
              evidence: [...(enriched.evidence || []), ...l3Result.evidence],
              layer: 'L3',
            };
          }

          if (patched._patches > 0) {
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
          text: JSON.stringify({ error: err.message, layer: 'L1', evidence: [], confidence: 0 }),
        }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startMcpServer(opts = {}) {
  const { transport: transportType = 'stdio', port = 3000, idleTimeoutMinutes = 0, watch = false } = opts;
  idleTimeoutMs = idleTimeoutMinutes > 0 ? idleTimeoutMinutes * 60_000 : 0;
  watchEnabled = watch;
  startIdleTimer();

  const server = await createMcpServer();

  if (transportType === 'sse') {
    const http = await import('node:http');
    const { URL } = await import('node:url');

    let activeTransport = null;

    return new Promise((resolve) => {
      const httpServer = http.createServer(async (req, res) => {
        const parsed = new URL(req.url || '/', `http://localhost:${port}`);

        if (parsed.pathname === '/sse') {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.flushHeaders();

          const transport = new SSEServerTransport('/message', res);
          activeTransport = transport;
          await server.connect(transport);
        } else if (parsed.pathname === '/message' && req.method === 'POST') {
          if (activeTransport) {
            let body = '';
            req.on('data', (chunk) => { body += chunk });
            req.on('end', () => {
              try {
                const message = JSON.parse(body);
                activeTransport.handlePostMessage(message, res);
              } catch {
                res.writeHead(400);
                res.end('Bad request');
              }
            });
          } else {
            res.writeHead(503);
            res.end('No active SSE connection');
          }
        } else {
          res.writeHead(200);
          res.end('llm-oracle MCP server (SSE)');
        }
      });

      httpServer.listen(port, () => {
        console.error(`MCP server listening on http://localhost:${port}/sse`);
        setupGracefulShutdown({ server, httpServer });
        resolve({ server, httpServer });
      });
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  setupGracefulShutdown({ server });

  return { server };
}

function setupGracefulShutdown({ server, httpServer }) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[oracle] ${signal} received, shutting down...`);

    if (idleTimer) clearInterval(idleTimer);

    for (const [key, watcher] of activeWatchers) {
      try { watcher.stop(); } catch {}
      activeWatchers.delete(key);
    }

    for (const [key] of openStores) {
      evictResources(key);
    }

    if (httpServer) {
      httpServer.close();
    }

    try { await server.close(); } catch {}

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
