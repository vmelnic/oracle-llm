# AGENTS.md — llm-oracle

> This file is for AI coding agents. It describes the project structure, conventions, and runtime behavior so you can work on the codebase without guessing.

---

## Project Overview

`llm-oracle` is a **layered grounded oracle** — a local code-intelligence server that answers structured queries about software projects via the Model Context Protocol (MCP). It is designed to be used by frontier AI models (Claude, GPT, Kimi, etc.) as a deterministic second brain: the frontier plans and writes code, but never touches the filesystem directly; the oracle supplies facts, evidence pointers, and impact analysis.

The architecture has three layers:
- **L1 — Deterministic** (implemented): entity graph, pattern catalogue, project manifest, contract registry.
- **L2 — AST-aware retrieval** (implemented): BM25-based retrieval over AST node summaries. Augments `oracle.context` when keyword matching is sparse.
- **L3 — Neural synthesis** (implemented, optional): augments open-ended tools with natural-language synthesis from a local model (Ollama, mlx-lm, vllm, or any OpenAI-compatible endpoint). L1 facts are injected into the prompt — no fine-tuning required.

Additional features:
- **Emit Gate** (`src/emit-gate/`): pre-commit validation pipeline (tree-sitter parse, `oracle.validate`, `oracle.impact`, test runner detection, LSP type-check via robust JSON-RPC).
- **File Watcher** (`src/watcher/`): auto re-index on file changes (`serve --watch`).
- **Git Hooks** (`src/cli/commands/workspace.js`): auto re-index on post-merge / post-checkout (`workspace add --install-hooks`).
- **MCP Process Manager**: stdio (default) or SSE transport, with idle timeout for subproject resources and LRU caching.

Every answer returned by the oracle must carry `{ answer, evidence[], confidence, layer }`. Evidence is verified against the filesystem before return.

---

## Technology Stack

- **Runtime:** Node.js >= 20.0.0 (ES modules, `"type": "module"` in `package.json`).
- **Language:** JavaScript (no TypeScript, no transpilation step).
- **CLI framework:** `commander`.
- **MCP transport:** `@modelcontextprotocol/sdk` over stdio or SSE.
- **Database:** SQLite via `better-sqlite3` (WAL mode, foreign keys).
- **Parsing:** `tree-sitter` with native grammar packages for JavaScript, TypeScript/TSX, PHP, Dart, Vue, Python, Go, Rust, and Java.
- **File globbing:** `fast-glob`.
- **YAML:** `js-yaml`.

Native dependencies are present (`better-sqlite3`, `tree-sitter`, language grammars), so `npm install` may require a working C++ toolchain.

`npm install` uses `overrides` in `package.json` to reconcile conflicting `tree-sitter` peer dependencies across grammar packages. No `--force` or `--legacy-peer-deps` is required.

Environment variables are loaded from `.env` via `dotenv` at CLI startup. See `.env.example` for available options.

---

## Repository Layout

```
llm-oracle/
├── bin/oracle.js           # CLI entry point
├── package.json            # Node project manifest; test script via node --test
├── src/
│   ├── index.js            # Public API exports
│   ├── cli/                # Commander-based CLI commands
│   │   ├── index.js        # CLI factory
│   │   └── commands/
│   │       ├── workspace.js   # add, scan, list workspaces (--install-hooks)
│   │       ├── ingest.js      # build graph + patterns + manifest + contracts + L2 index
│   │       ├── manifest.js    # show, draft, path
│   │       ├── patterns.js    # list pattern catalogue
│   │       ├── serve.js       # start MCP server (--watch)
│   │       ├── status.js      # workspace/subproject status
│   │       ├── gate.js        # run emit gate on a proposed diff
│   │       ├── db.js          # migrate, reset, path subproject databases
│   │       └── hooks.js       # install/uninstall git hooks for auto re-index
│   ├── scanner/            # Workspace/subproject discovery and persistence
│   │   ├── index.js        # detectSubprojects, scanWorkspace
│   │   └── workspace.js    # save/load workspace metadata to ~/.oracle
│   ├── parser/             # Tree-sitter parser manager
│   │   └── index.js        # createParser() — loads grammars, parses, walks, queries
│   ├── graph/              # Entity graph (L1)
│   │   ├── builder.js      # Incremental graph build from file tree
│   │   ├── store.js        # GraphStore — SQLite schema, upserts, queries
│   │   ├── schema.sql      # Authoritative SQLite schema for the entity graph
│   │   └── extractors/     # Language-specific AST extractors
│   │       ├── javascript.js
│   │       ├── typescript.js
│   │       ├── php.js
│   │       ├── dart.js
│   │       ├── vue.js
│   │       ├── python.js
│   │       ├── go.js
│   │       ├── rust.js
│   │       └── java.js
│   ├── contracts/          # Contract-surface registry (L1)
│   │   ├── index.js        # Contract registry orchestrator
│   │   └── detectors/      # One file per contract detector
│   │       ├── openapi.js
│   │       ├── symfony-route.js
│   │       ├── laravel-route.js
│   │       ├── database-schema.js
│   │       ├── prisma.js
│   │       ├── graphql.js
│   │       ├── api-platform.js
│   │       ├── doctrine-migration.js
│   │       ├── event-bus.js
│   │       ├── kafka-topic.js
│   │       ├── protobuf.js
│   │       └── typeorm.js
│   ├── patterns/           # Pattern catalogue (L1)
│   │   └── index.js        # Extract recurring structural shapes from graph nodes; rerank by freshness
│   ├── manifest/           # Project manifest drafter (L1)
│   │   └── index.js        # Auto-draft manifest.yaml from code heuristics
│   ├── retrieval/          # L2 AST-aware retrieval
│   │   ├── index.js        # L2Index — BM25-backed AST node search
│   │   ├── bm25.js         # Pure-JS BM25 implementation
│   │   └── embeddings.js   # Local ONNX / remote API semantic embeddings
│   ├── mcp/                # MCP server and tools
│   │   ├── index.js        # createMcpServer / startMcpServer, tool routing, idle timeout, L3 integration
│   │   └── tools/          # One file per MCP tool
│   │       ├── locate.js
│   │       ├── signature.js
│   │       ├── exists.js
│   │       ├── nearby.js
│   │       ├── consumers.js
│   │       ├── diff-since.js
│   │       ├── conventions-for.js
│   │       ├── where-would.js
│   │       ├── pattern.js
│   │       ├── impact.js
│   │       ├── validate.js
│   │       ├── context.js
│   │       ├── read-exact.js
│   │       └── graph-stats.js
│   ├── emit-gate/          # Pre-commit validation pipeline
│   │   └── index.js        # EmitGate — parse, validate, impact, test checks, LSP JSON-RPC
│   ├── l3/                 # L3 neural synthesis
│   │   ├── inference.js    # L3InferenceEngine — HTTP backend (OpenAI-compatible), L1 context injection
│   │   └── weights-patch.js # WeightsThenPatch — L3 response validation against L1/L2, drift log persistence
│   ├── watcher/            # File watcher for auto re-index
│   │   └── index.js        # FileWatcher — debounce, incremental rebuild
│   ├── hooks/              # Git hooks for auto re-index
│   │   └── index.js        # installHooks, uninstallHooks, runReindex
│   ├── grounding/          # Grounding wrapper
│   │   ├── index.js        # Evidence verification, confidence computation, token caps, retry-once, safe truncation
│   │   └── toon.js         # TOON serializer (token-optimized output) + savings estimator
│   ├── markdown/           # Markdown file processing
│   │   └── index.js        # Markdown extraction for non-code files
├── tests/                  # Node native test suite (28 suites, 147 tests)
│   ├── benchmark.test.js
│   ├── bm25.test.js
│   ├── builder.test.js
│   ├── contracts.test.js
│   ├── emit-gate.test.js
│   ├── emit-gate-extended.test.js
│   ├── graph-store.test.js
│   ├── grounding.test.js
│   ├── grounding-extended.test.js
│   ├── l3-inference.test.js
│   ├── manifest.test.js
│   ├── markdown.test.js
│   ├── mcp.test.js
│   ├── mcp-tools.test.js
│   ├── parser.test.js
│   ├── patterns.test.js
│   ├── retrieval-l2.test.js
│   ├── scanner.test.js
│   ├── toon.test.js
│   ├── weights-patch.test.js
│   └── workspace.test.js
├── scripts/
│   └── serve-model.sh      # Start local model server (mlx/vllm)
└── docs/PLAN.md            # Original design specification (authoritative reference)
```

---

## Running and Installing

No build step is required. After `npm install`:

```bash
# Start the MCP server (stdio transport — default for MCP clients)
npm start
# or
npm run serve

# SSE transport (e.g. for remote access)
npm run serve:sse -- --port 3000 --idle-timeout 10

# Register a workspace and ingest it
npm run workspace:add -- /path/to/project
npm run ingest -- <workspace_id>

# Show status
npm run status -- <workspace_id>

# Database management
npm run db:migrate -- <workspace> <subproject>
npm run db:reset -- <workspace> <subproject>
npm run db:path -- <workspace> <subproject>

# Git hooks (auto re-index on pull/checkout)
npm run hooks:install -- <workspace_id>
npm run hooks:uninstall -- <workspace_id>
npm run hooks:reindex -- <workspace_id>

# Manifest curation
npm run manifest:show -- <workspace> <subproject>
npm run manifest:draft -- <workspace> <subproject>
npm run manifest:edit -- <workspace> <subproject>
npm run manifest:path -- <workspace> <subproject>

# Patterns
npm run patterns:list -- <workspace> <subproject>

# Run emit gate on a proposed diff
npm run gate -- <workspace> <subproject> --diff /path/to/diff.json
```

All commands can also be run directly via `node bin/oracle.js <command>`. The CLI binary is exposed as `oracle` if the package is linked globally.

---

## Code Style Guidelines

- **ES modules only.** Every source file uses `import` / `export`.
- **No semicolons** required, but the codebase is mixed; follow the file you are editing.
- ** snake_case** is used for database columns and some internal APIs; **camelCase** for JavaScript variables/functions.
- **Error handling:** `try / catch` blocks often swallow errors silently (e.g. detector failures, parse failures). This is intentional — the oracle is meant to be resilient to malformed files.
- **Tree-sitter traversal:** extractors walk nodes manually with `node.child(i)` and `node.childForFieldName()`. Be careful with grammar differences (JS vs TS class heritage, for example).
- **Metadata:** node metadata is stored as JSON strings in SQLite. Extractors pass plain objects; `GraphStore` serializes them.

---

## Data Model

### Workspace
A workspace is a directory tree containing one or more subprojects. Discovered by looking for build manifests (`package.json`, `composer.json`, `pyproject.toml`, `pubspec.yaml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`).

### Subproject
Each subproject has:
- `id`, `root`, `language`, `framework`
- `includeGlobs` / `excludeGlobs` for file discovery
- `buildManifest` path

### Entity Graph (SQLite)
Tables:
- `nodes` — symbols with kind, location, signature, doc, metadata
- `edges` — relationships (calls, imports, extends, renders, fires_event, etc.)
- `file_hashes` — blob hashes for incremental re-indexing

Supported node kinds: `function`, `class`, `method`, `route`, `component`, `store`, `migration`, `db_table`, `api_endpoint`, `event`, `config_key`, `env_var`, `interface`, `type_alias`, `trait`, `mixin`, `property`, `decorator`, `hook`, `provider`, `directive`, `pipe`, `module`, `enum`.

Supported edge kinds: `calls`, `imports`, `reexports`, `queries`, `renders`, `depends_on`, `fires_event`, `consumes_event`, `migrates_table`, `serves_route`, `implements`, `extends`, `uses_trait`, `provides`, `injects`, `type_references`, `reads_config`.

### L2 Index
Per-subproject BM25 index persisted as `ast_embed_index.json`. Each AST node is indexed by a searchable text summary (`kind + symbol + signature + doc + metadata`).

### Storage Layout
All generated data lives under `~/.oracle/workspaces/<workspace_id>/`:
```
subprojects/<subproject_id>/
  entity_graph.sqlite
  pattern_catalog.json
  manifest.yaml
  drift_log.json                # L3 drift log (auto-persisted when patches occur)
  ast_embed_index/              # L2
    bm25.json
    vectors.json                # (optional, when embeddings enabled)
```

---

## MCP Tools

All tools require `workspace_id` and `subproject_id`. They return JSON with `{ answer, evidence[], confidence, layer }`.

| Tool | Purpose |
|---|---|
| `oracle.locate` | Find definitions of a symbol |
| `oracle.signature` | Get signature + type info + doc |
| `oracle.exists` | Search by description |
| `oracle.nearby` | Symbols near a file location |
| `oracle.consumers` | Transitive consumers (BFS up to depth 5) |
| `oracle.diff_since` | Changed files/symbols since a git ref |
| `oracle.conventions_for` | Conventions for a topic (auth, errors, routing, etc.) |
| `oracle.where_would` | Suggest where to place new code |
| `oracle.pattern` | Look up a pattern from the catalogue |
| `oracle.impact` | Analyze impact of a proposed change |
| `oracle.validate` | Validate proposed code against conventions |
| `oracle.context` | **Primary tool** — bundled task packet (L1 + L2 augmented, L3 synthesis if enabled) |
| `oracle.read_exact` | Read verbatim lines from a file (path scoped to subproject) |
| `oracle.stats` | Node/edge counts for debugging |
| `oracle.ingest` | Trigger ingestion for a workspace/subproject |
| `oracle.workspace_add` | Register a new workspace |
| `oracle.workspace_scan` | Scan workspace for subprojects |
| `oracle.workspace_list` | List registered workspaces |
| `oracle.status` | Show layer status for a workspace |
| `oracle.gate` | Run emit-gate validation |
| `oracle.manifest_show` | Show manifest for a subproject |
| `oracle.patterns_list` | List pattern catalogue entries |

---

## Testing

Tests use Node's native test runner (`node --test`).

```bash
npm test
```

If you add tests, place them in `tests/` or alongside source files. Keep tests fast and avoid requiring real workspaces — mock `GraphStore` and file-system state.

**Note:** Do not write or update tests unless explicitly asked. Focus on main implementation only.

---

## Security Considerations

- The CLI reads arbitrary file paths from workspace roots. It does not write into the source tree (only into `~/.oracle`).
- MCP server runs over stdio by default; SSE transport opens a local HTTP port.
- Evidence verification in `grounding/index.js` resolves paths against `subproject_root`. Be careful about path traversal if `subproject_root` is ever user-controlled.
- `read_exact` enforces subproject scope: paths that escape the subproject directory (or workspace) are rejected with an error.
- Native dependencies (`better-sqlite3`, `tree-sitter`) load compiled binaries. Ensure the lockfile (`package-lock.json`) is not tampered with.

---

## Environment Variables

The CLI loads `.env` automatically via `dotenv`. All variables have sensible defaults.

| Variable | Default | Description |
|---|---|---|
| `ORACLE_HOME` | `~/.oracle` | Root directory for all persisted data |
| `ORACLE_MCP_PORT` | `3000` | Default port for SSE transport |
| `ORACLE_MCP_IDLE_TIMEOUT_MINUTES` | `0` | Default idle timeout (0 = disabled) |
| `ORACLE_MCP_CACHE_SIZE` | `128` | LRU cache size for MCP tool results |
| `ORACLE_BM25_K1` | `1.2` | BM25 term frequency saturation parameter |
| `ORACLE_BM25_B` | `0.75` | BM25 length normalization parameter |
| `ORACLE_MAX_DEPTH` | `5` | BFS traversal depth for `consumers()` and `impact()` |
| `ORACLE_EMBED_MODEL` | _(empty)_ | L2 embedding model name (e.g. `voyage-code-3`). BM25-only when empty. |
| `ORACLE_EMBED_API_URL` | _(empty)_ | OpenAI-compatible embedding API endpoint |
| `ORACLE_EMBED_API_KEY` | _(empty)_ | API key for the embedding service |
| `ORACLE_EMBED_DIMENSIONS` | `0` | Embedding vector dimensions (0 = use model default) |
| `ORACLE_L3_ENABLED` | `false` | Enable L3 neural synthesis |
| `ORACLE_L3_BASE_URL` | _(empty)_ | OpenAI-compatible model server URL |
| `ORACLE_L3_MODEL` | _(empty)_ | Model name (e.g. `Qwen/Qwen2.5-Coder-3B-Instruct`) |
| `ORACLE_L3_API_KEY` | _(empty)_ | Model server API key (if required) |
| `ORACLE_EMBEDDINGS` | `false` | Enable L2 semantic embeddings |
| `ORACLE_EMBED_UNLOAD_TIMEOUT` | `300` | Unload ONNX model after N seconds idle (0 = never) |
| `ORACLE_OUTPUT_FORMAT` | `toon` | Output format: `toon` (~35% fewer tokens) or `json` |
| `ORACLE_LSP_TIMEOUT_MS` | `10000` | LSP JSON-RPC request timeout (used by emit-gate) |

Copy `.env.example` to `.env` and adjust values as needed:
```bash
cp .env.example .env
```

---

## Adding a New Language

1. Add a `tree-sitter-<lang>` dependency to `package.json`.
2. Register it in `src/parser/index.js` (`GRAMMAR_REGISTRY`) with extensions and an `extract` function.
3. Create `src/graph/extractors/<lang>.js` exporting `extract(tree, filePath, subprojectId) -> { nodes, edges }`.
4. Add framework/language detection logic in `src/scanner/index.js` if the language uses a recognizable build manifest.
5. Add default include/exclude globs in `defaultGlobs()` inside `src/scanner/index.js`.
6. Add the extractor alias in `src/graph/builder.js` (`EXTRACTOR_ALIAS`).
7. Run `npm install` and test with `oracle ingest`.

---

## Adding a New MCP Tool

1. Create a handler in `src/mcp/tools/<tool-name>.js`. Export a function `handler(ctx, toolArgs)` returning `{ answer, evidence[], layer }`.
2. Add the tool definition to `TOOL_DEFS` in `src/mcp/index.js`.
3. Wire the handler in `TOOL_HANDLERS` in the same file.
4. The `GroundingWrapper` will automatically verify evidence and compute confidence.

---

## Adding a New CLI Command

1. Create `src/cli/commands/<name>.js` exporting a `Command` factory function.
2. Import and add it in `src/cli/index.js`.
3. Follow the pattern of existing commands: load workspace, validate subproject, use `getSubprojectDir` for artifact paths.
