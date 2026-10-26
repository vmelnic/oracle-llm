# AGENTS.md — llm-oracle

> This file is for AI coding agents. It describes the project structure, conventions, and runtime behavior so you can work on the codebase without guessing. Code conventions used by oracle meta-ingestion live in `CONVENTION.md`.

## Quick reference

- **Language:** JavaScript (ES modules, no TypeScript, no build step)
- **Runtime:** Node.js >= 20.3
- **Entry:** `bin/oracle.js` / `npm start`
- **Test:** `npm test` (Node native test runner); `npm run test:coverage` for coverage
- **Lint:** `npm run lint` (ESLint); `npm run check` runs lint + tests + knip + audit
- **Install:** `npm install` (native deps: better-sqlite3, tree-sitter — needs a C++ toolchain)
- **Data:** `ORACLE_HOME` (default `~/.oracle`, `~` expanded) — SQLite entity graph, JSON patterns / L2 index, YAML manifest per workspace and subproject

---

## Project Overview

`llm-oracle` is a **layered grounded oracle** — a local code-intelligence server that answers structured queries about software projects via the Model Context Protocol (MCP). It is designed to be used by frontier AI models (Claude, GPT, Kimi, etc.) as a deterministic second brain: the frontier plans and writes code, but never touches the filesystem directly; the oracle supplies facts, evidence pointers, and impact analysis.

The architecture has three layers:
- **L1 — Deterministic** (implemented): entity graph, pattern catalogue, project manifest, contract registry.
- **L2 — AST-aware retrieval** (implemented): BM25-based retrieval over AST node summaries. Augments `oracle.context` when keyword matching is sparse.
- **L3 — Synthesis** (implemented, optional): `context`, `where_would` and `conventions_for` add a short model-written answer built only from the verified L1/L2 facts, which the model cites by number; answers citing anything else are dropped. Any OpenAI-compatible backend; the repo can run a local llama.cpp server (`oracle llm …`). See `docs/l3-local-model.md`.

Additional features:
- **Emit Gate** (`src/emit-gate/`): pre-commit validation pipeline (tree-sitter parse, `oracle.validate`, `oracle.impact`, test runner detection, LSP type-check via robust JSON-RPC).
- **File Watcher** (`src/watcher/`): auto re-index on file changes (`serve --watch`).
- **Git Hooks** (`src/hooks/`, `oracle hooks install <ws>`): background re-index on post-merge / post-checkout; honours `core.hooksPath`.
- **MCP Process Manager**: stdio (default) or Streamable HTTP transport, with idle timeout and a reference-counted LRU cache of per-subproject resources.

Every answer returned by the oracle must carry `{ answer, evidence[], confidence, layer }`. Evidence is verified against the filesystem before return.

---

## Technology Stack

- **Runtime:** Node.js >= 20.3 (ES modules, `"type": "module"` in `package.json`).
- **Language:** JavaScript (no TypeScript, no transpilation step).
- **CLI framework:** `commander`.
- **MCP transport:** `@modelcontextprotocol/sdk` over stdio or Streamable HTTP (`--transport sse` is a deprecated alias for `http`).
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
├── eslint.config.js        # ESLint flat config (no-console outside the CLI)
├── .editorconfig
├── src/
│   ├── index.js            # Public API exports
│   ├── version.js          # VERSION, read from package.json
│   ├── cli/                # Commander-based CLI commands
│   │   ├── index.js        # CLI factory
│   │   ├── resolve.js      # requireWorkspace/Subproject/Graph, readJsonFile, intOption
│   │   └── commands/
│   │       ├── workspace.js   # add, scan, list workspaces
│   │       ├── ingest.js      # build graph + patterns + manifest + contracts + L2 index
│   │       ├── manifest.js    # show, draft, path
│   │       ├── patterns.js    # list pattern catalogue
│   │       ├── serve.js       # start MCP server (--watch)
│   │       ├── llm.js         # local llama-server: download, start, status, stop, bench
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
│   │   ├── schema.sql      # Schema for fresh databases (runs before migrations)
│   │   ├── migrations.js   # Numbered migrations, applied automatically on open
│   │   ├── calls.js        # Method-call resolution (receiver type, inheritance, return types, receiver name)
│   │   ├── modules.js      # Import resolution: tsconfig paths, workspace packages, Dart package:
│   │   ├── usage.js        # Interface/parent callers and possible call sites (consumers, impact, gate)
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
│   │   ├── index.js        # EmitGate — parse, validate, impact, test checks, LSP JSON-RPC
│   │   └── run.js          # runEmitGate — shared setup for `oracle gate` and `oracle.gate`
│   ├── l3/                 # L3 synthesis
│   │   ├── config.js       # l3Config / createL3Engine — ORACLE_L3_* settings
│   │   ├── inference.js    # L3InferenceEngine — any OpenAI-compatible /chat/completions backend
│   │   ├── prompts.js      # renders prompts/l3/*.txt ({{placeholders}})
│   │   ├── synthesize.js   # numbered facts -> model -> citation check (shared by MCP and llm bench)
│   │   └── weights-patch.js # WeightsThenPatch — validates citations/paths against L1, drift log
│   ├── llm/                # Local model server (optional)
│   │   ├── server.js       # llama-server download (SHA-256) / start / status / stop
│   │   └── bench.js        # oracle llm bench: L3 speed and acceptance on real tool results
│   ├── watcher/            # File watcher for auto re-index
│   │   └── index.js        # FileWatcher — debounce, incremental rebuild
│   ├── hooks/              # Git hooks for auto re-index
│   │   └── index.js        # installHooks, uninstallHooks, runReindex
│   ├── grounding/          # Grounding wrapper
│   │   ├── index.js        # Evidence verification, confidence computation, token caps, retry-once, safe truncation
│   │   └── toon.js         # TOON serializer (token-optimized output) + savings estimator
│   ├── markdown/           # Markdown file processing
│   │   └── index.js        # Markdown extraction for non-code files
│   ├── ingest/
│   │   ├── pipeline.js     # runIngestPipeline / ingestSubproject — the one ingest sequence (CLI, MCP, watcher, hooks)
│   │   └── state.js        # ingest_state.json (building/ready/failed)
│   └── utils/
│       ├── glob.js         # globFiles: .gitignore-aware, no symlinks, skips node_modules
│       ├── env.js          # validateEnv, positiveInt, nonNegativeInt
│       ├── file-lock.js    # Ingest lock (stale only if the owner process is dead)
│       └── atomic-write.js # Temp-file + rename writes
├── tests/                  # Node native test suite
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
├── prompts/
│   ├── l3/                 # L3 prompt templates (*.txt, {{placeholders}}) + bench-tasks.json
│   └── mcp/tools.json      # MCP tool names, descriptions, input schemas
├── docs/
│   └── l3-local-model.md   # L3, local llama.cpp model, installs, measurements, pi agent setup
└── examples/pi/            # pi (agent harness) models.json / mcp.json templates
```

---

## Running and Installing

No build step is required. After `npm install`:

```bash
# Start the MCP server (stdio transport — default for MCP clients)
npm start
# or
npm run serve

# Streamable HTTP transport (e.g. for remote access)
npm run serve:http -- --port 3000 --idle-timeout 10

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

# Local model server for L3 (install llama.cpp yourself first; see docs/l3-local-model.md)
npm run llm:download
npm run llm:start
npm run llm:status
npm run llm:stop
npm run llm:bench -- <workspace> <subproject>
```

All commands can also be run directly via `node bin/oracle.js <command>`. The CLI binary is exposed as `oracle` if the package is linked globally:

```bash
node bin/oracle.js workspace add <path> [--only a,b] # register a workspace (optionally only some subprojects)
node bin/oracle.js workspace scan <workspace_id>     # re-scan (keeps the --only selection)
node bin/oracle.js workspace list
node bin/oracle.js ingest <workspace_id> [subproject] [--embeddings]
node bin/oracle.js serve [--transport stdio|http] [--port 3000] [--watch]
node bin/oracle.js status [workspace_id]
node bin/oracle.js gate <ws> <sp> --diff <path>
node bin/oracle.js benchmark <ws> <sp>
node bin/oracle.js manifest show <ws> <sp>
node bin/oracle.js patterns list <ws> <sp>
node bin/oracle.js hooks install|uninstall <ws>
node bin/oracle.js db migrate|reset|path <ws> <sp>
node bin/oracle.js llm download|start|status|stop
node bin/oracle.js llm bench <ws> <sp>
```

---

## Code Style Guidelines

- **ES modules only.** Every source file uses `import` / `export`.
- **No semicolons** required, but the codebase is mixed; follow the file you are editing.
- ** snake_case** is used for database columns and some internal APIs; **camelCase** for JavaScript variables/functions.
- **Error handling:** `try / catch` blocks often swallow errors silently (e.g. detector failures, parse failures). This is intentional — the oracle is meant to be resilient to malformed files.
- **Tree-sitter traversal:** extractors walk nodes manually with `node.child(i)` and `node.childForFieldName()`. Be careful with grammar differences (JS vs TS class heritage, for example).
- **Metadata:** node metadata is stored as JSON strings in SQLite. Extractors pass plain objects; `GraphStore` serializes them.
- **Logging:** stdout carries the MCP stdio protocol, so code outside `src/cli/` and `bin/` logs with `console.error` only (enforced by ESLint `no-console`).
- **Formatting:** `.editorconfig` (2 spaces, LF). There is no auto-formatter because semicolon style is mixed by design.
- **Vue:** the `<script>` block is extracted and parsed as JS/TS (tree-sitter-vue is incompatible with tree-sitter 0.25).

---

## Gotchas

- Extractors emit edges with `source_symbol`/`target_symbol` (not IDs). The graph builder resolves these to node IDs via local symbol map + DB lookup.
- L2 index path is `ast_embed_index/`: `bm25.json` plus optional binary `vectors.<gen>.bin` + `vectors.<gen>.meta.json`. `bm25.json` names its vector generation and is written last (atomic pair). Legacy `vectors.json` and single-file `ast_embed_index.json` are still loadable.
- Semantic embeddings require `ORACLE_EMBEDDINGS=true` + `ORACLE_EMBED_MODEL` in `.env` (or `--embeddings` on ingest). Package: `@huggingface/transformers` (optional dep).
- Native deps (better-sqlite3, tree-sitter grammars) need C++ toolchain. `package.json` has `overrides` to reconcile tree-sitter peer dep conflicts.
- `.env` loaded via dotenv at CLI startup. See `.env.example` for all options.
- Grounding wrapper allows empty evidence for `validate`, `diff_since`, `impact`, `read_exact`, `stats` — these are operational tools, not factual lookups.
- Emit gate `collectParseErrors` uses `node.isMissing` (property), not `node.isMissing()`.
- `src/graph/schema.sql` runs on every open *before* migrations (`src/graph/migrations.js`). Keep it idempotent; indexes on migration-added columns go in `POST_MIGRATION_SQL`. Bump the stamped version in `schema.sql` with each new migration.
- Ingest is incremental: changed files plus dependents (edges into removed nodes, `unresolved_refs` matches). Files to index (builder, scanner, contract detectors, gate test lookup) are listed via `src/utils/glob.js`, which respects `.gitignore` and never follows symlinks — use it for any new discovery code. Only the manifest heuristics, which read specific config files (including the git-ignored `.env` for TOKEN variable names), and the single-directory doc lookup in markdown use `fast-glob` directly.
- stdout is the MCP stdio channel: outside `src/cli/` and `bin/`, log with `console.error` (ESLint enforces it).
- `ORACLE_*` env vars are validated at CLI startup (`validateEnv` in `src/utils/env.js`); add new variables there and to `.env.example`. Read numeric ones with `positiveInt`/`nonNegativeInt`.
- Ingest steps live only in `src/ingest/pipeline.js` (`runIngestPipeline`, `ingestSubproject`); the CLI, MCP admin tool, watcher and git hooks all call it. Change the sequence there, never in a caller. Same for the emit gate: `src/emit-gate/run.js`.
- CLI commands throw on bad input (`requireWorkspace`/`requireSubproject`/`requireGraph` in `src/cli/resolve.js`); `bin/oracle.js` prints one line and exits 1. Don't call `process.exit` in commands.
- Every text sent to a model is a template file: L3 prompts in `prompts/l3/*.txt` (Twig-style `{{placeholder}}`, rendered by `src/l3/prompts.js`; missing values throw), MCP tool definitions in `prompts/mcp/tools.json`. Never hardcode prompt text in JS.
- The oracle never installs software. `oracle llm start` checks for `llama-server` and prints the install command; models are downloaded only by `oracle llm download` (SHA-256 verified) into `$ORACLE_HOME/models`.
- `oracle.context` keeps every result scoring >= 20% of the best non-exact match plus exact symbol matches and the callers of relevant code (`ORACLE_CONTEXT_MAX_NODES` is only a cap). Don't reintroduce fixed top-N cuts: broad questions must see the whole feature.
- Over HTTP, `oracle.gate` needs `ORACLE_MCP_GATE_ENABLED=true` on top of admin tools, and `ORACLE_ALLOWED_ROOTS` applies to every tool.
- Method calls: extractors describe `receiver.method()` as a `calls` edge with `metadata.call` (method, receiver, `receiver_type` when known, `receiver_call` when the receiver is another call's result); `src/graph/calls.js` binds them after every node is written. Never bind a method by name alone: unbound calls become `call` refs (possible call sites) that `oracle.consumers`/`impact` report.
- Bump `EXTRACTOR_VERSION` in `src/graph/builder.js` whenever extractor output or edge resolution changes; graphs built by another version are rebuilt in full on the next ingest, unchanged files would otherwise keep stale edges.
- Incremental builds must equal full rebuilds: global name lookups happen only in the builder's deferred pass, never order by `ref_count` or row ids when choosing a node, and record `soft` refs for anything resolved through another symbol (inheritance path, return type, receiver name).
- Non-relative imports (tsconfig `paths`, workspace packages, Dart `package:`) resolve through `src/graph/modules.js`.

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
- `unresolved_refs` — name-based references by `ref_kind`: `symbol` (did not resolve), `call` (method call on a receiver of unknown type: a possible call site), `soft` (bound through inheritance, a return type or the receiver's name; re-resolved when those change)
- `graph_meta` — build metadata (extractor version + module-config fingerprint per subproject)
- `schema_version` — applied migrations (`src/graph/migrations.js`, run automatically on open)

Incremental ingest reprocesses changed files plus the unchanged files whose edges depend on them, and respects `.gitignore`. It produces the same graph as a full rebuild. A graph built by another extractor version (or with different tsconfig paths / workspace packages / pubspec name) is rebuilt in full.

Method calls: extractors emit `calls` edges with `metadata.call = { method, receiver, receiver_type?, receiver_call?, self?, implicit?, line }`; `src/graph/calls.js` binds them after all nodes are written. Stored call edges carry `{ resolution: typed|self|function|receiver_name, receiver, lines[] }`; other call/render/reference edges carry `lines[]`.

Supported node kinds: `function`, `class`, `method`, `route`, `component`, `store`, `migration`, `db_table`, `api_endpoint`, `event`, `config_key`, `env_var`, `interface`, `type_alias`, `trait`, `mixin`, `property`, `decorator`, `hook`, `provider`, `directive`, `pipe`, `module`, `enum`, `variable` (JS/TS module-level constant), `test` (JS/TS top-level `describe`/`test` block).

Supported edge kinds: `calls`, `imports`, `reexports`, `queries`, `renders`, `depends_on`, `fires_event`, `consumes_event`, `migrates_table`, `serves_route`, `implements`, `extends`, `uses_trait`, `mixin` (PHPDoc `@mixin`), `provides`, `injects`, `type_references`, `references` (a name used as a value), `reads_config`.

### L2 Index
Per-subproject BM25 index persisted in the `ast_embed_index/` directory. Each AST node is indexed by a searchable text summary (`kind + symbol + signature + doc + metadata`). Optional embeddings are stored as binary Float32 generations; `bm25.json` names the generation it pairs with and is written last, so the pair is replaced atomically. The legacy single-file `ast_embed_index.json` and `vectors.json` are still loadable.

### Storage Layout
All generated data lives under `~/.oracle/workspaces/<workspace_id>/`:
```
subprojects/<subproject_id>/
  entity_graph.sqlite
  pattern_catalog.json
  manifest.yaml                 # editable; manual edits survive re-ingest
  manifest.drafted.yaml         # last auto-draft (three-way merge baseline)
  drift_log.json                # L3 drift log (auto-persisted when patches occur)
  ast_embed_index/              # L2
    bm25.json                   # BM25 data + vectorsGeneration
    vectors.<gen>.bin           # (optional) Float32 vectors
    vectors.<gen>.meta.json     # (optional) ids, hashes, dimension
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
| `oracle.consumers` | Direct users with call lines, transitive users, callers through the interface/parent a method implements, implementations, possible call sites (`complete: false`) |
| `oracle.diff_since` | Changed files/symbols since a git ref |
| `oracle.conventions_for` | How the project handles a topic: base types, locations, route middleware, patterns, documented rules |
| `oracle.where_would` | Path for new code, learned from files of the same kind (role from file-name suffix, parent directory or node kind; per-feature layouts; naming) |
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

## Historical proof-of-concept results

Sample results, not an SLA (see README). On a 21-subproject workspace (10,184 nodes, 4,115 edges): ~7,000 tokens/task on average with L1+L2, <160 ms latency, 100% evidence verification, ~9x fewer tokens than a baseline that reads files.

---

## Testing

Tests use Node's native test runner (`node --test`).

```bash
npm test
npm run test:coverage   # same, with a per-file coverage report
npm run lint            # ESLint (eslint.config.js)
npm run check           # lint + tests + knip + npm audit
```

If you add tests, place them in `tests/` or alongside source files. Keep tests fast and avoid requiring real workspaces — mock `GraphStore` and file-system state.

**Note:** Do not write or update tests unless explicitly asked. Focus on main implementation only.

---

## Security Considerations

- The CLI reads arbitrary file paths from workspace roots. It does not write into the source tree (only into `~/.oracle`).
- MCP server runs over stdio by default; the HTTP transport binds to 127.0.0.1 unless a non-loopback host, an auth token and a Host allowlist are all configured.
- Over HTTP, `ORACLE_ALLOWED_ROOTS` limits which workspaces every tool can read. Admin tools need `ORACLE_MCP_ADMIN_ENABLED=true`, and `oracle.gate` (which runs the project's type-checker and tests on client-supplied code) additionally needs `ORACLE_MCP_GATE_ENABLED=true`.
- L3 receives repository text as fenced, untrusted context in the user turn; its output is labelled untrusted in tool responses.
- Evidence verification in `grounding/index.js` resolves paths against `subproject_root`. Be careful about path traversal if `subproject_root` is ever user-controlled.
- `read_exact` enforces subproject scope: paths that escape the subproject directory (or workspace) are rejected with an error.
- Native dependencies (`better-sqlite3`, `tree-sitter`) load compiled binaries. Ensure the lockfile (`package-lock.json`) is not tampered with.

---

## Environment Variables

The CLI loads `.env` automatically via `dotenv`. All variables have sensible defaults; `.env.example` is the complete, commented list. Every `ORACLE_*` value is validated at startup and an invalid one stops the CLI with a clear message.

| Variable | Default | Description |
|---|---|---|
| `ORACLE_HOME` | `~/.oracle` | Root directory for all persisted data |
| `ORACLE_MCP_PORT` | `3000` | Default port for the HTTP transport |
| `ORACLE_MCP_IDLE_TIMEOUT_MINUTES` | `0` | Default idle timeout (0 = disabled) |
| `ORACLE_MCP_CACHE_SIZE` | `128` | LRU cache size for MCP tool results |
| `ORACLE_BM25_K1` | `1.2` | BM25 term frequency saturation parameter |
| `ORACLE_BM25_B` | `0.75` | BM25 length normalization parameter |
| `ORACLE_MAX_DEPTH` | `5` | BFS traversal depth for `consumers()` and `impact()` |
| `ORACLE_MAX_TRAVERSAL_RESULTS` | `1000` | Max nodes one `consumers()`/`impact()` traversal returns |
| `ORACLE_RESPECT_GITIGNORE` | `true` | Skip files ignored by git when indexing |
| `ORACLE_DETECTOR_MAX_FILES` | `10000` | Files each content-scanning contract detector reads |
| `ORACLE_DEBUG` | `false` | Log grammar loading, per-file extraction failures and CLI stack traces |
| `ORACLE_EMBED_MODEL` | _(empty)_ | L2 embedding model name (e.g. `voyage-code-3`). BM25-only when empty. |
| `ORACLE_EMBED_API_URL` | _(empty)_ | OpenAI-compatible embedding API endpoint |
| `ORACLE_EMBED_API_KEY` | _(empty)_ | API key for the embedding service |
| `ORACLE_EMBED_DIMENSIONS` | `0` | Embedding vector dimensions (0 = use model default) |
| `ORACLE_EMBED_MAX_NODES` | `0` | Max nodes to embed per subproject (0 = all). Embeddings are cached by content hash — re-ingests only embed changed nodes |
| `ORACLE_L3_ENABLED` | `false` | Enable L3 synthesis |
| `ORACLE_L3_BASE_URL` | _(empty)_ | Any OpenAI-compatible endpoint, e.g. `http://127.0.0.1:8321/v1` (local llama.cpp) |
| `ORACLE_L3_MODEL` | `default` | Model name, e.g. `Qwen3-4B-Instruct-2507-Q4_K_M` |
| `ORACLE_L3_API_KEY` | _(empty)_ | Bearer token, if the backend needs one |
| `ORACLE_L3_TIMEOUT_MS` | `60000` | Deadline for one synthesis call, retries included |
| `ORACLE_L3_RETRIES` | `1` | Retries on 429/5xx/connection reset |
| `ORACLE_L3_MAX_TOKENS` / `ORACLE_L3_CONTEXT_TOKENS` | `32768` / `1500` | Answer cap / prompt budget for facts |
| `ORACLE_L3_TEMPERATURE` / `ORACLE_L3_REASONING_EFFORT` | `0.2` / _(empty)_ | Sampling; `reasoning_effort` for thinking models |
| `ORACLE_L3_EXTRA_BODY` / `ORACLE_L3_EXTRA_HEADERS` | _(empty)_ | JSON merged into requests (backend-specific options) |
| `ORACLE_L3_PROMPTS_DIR` | `prompts/l3` | Prompt template directory |
| `ORACLE_LLM_*` | see `.env.example` | Local llama.cpp server: model repo/file, host/port, context, KV cache, prompt cache, GPU layers, ... |
| `ORACLE_CONTEXT_MAX_NODES` / `ORACLE_MAX_EVIDENCE` | `50` / `50` | Safety caps on `oracle.context` results / evidence kept when trimming |
| `ORACLE_TOKEN_CAP` / `ORACLE_TOKEN_CAP_EXTENDED` | `400` / `1500` | Answer size caps (estimated tokens); the extended cap applies to context, where_would, conventions_for, consumers, impact, locate. Longer lists are shortened and report `<field>_total` |
| `ORACLE_MCP_GATE_ENABLED` | `false` | Allow `oracle.gate` over HTTP (also needs admin tools) |
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
3. Create `src/graph/extractors/<lang>.js` exporting `extract(tree, filePath, subprojectId) -> { nodes, edges }`. Emit method calls as `calls` edges with `metadata.call` (see Entity Graph) so `src/graph/calls.js` resolves them, and record `metadata.return_type` on methods/functions.
4. Add framework/language detection logic in `src/scanner/index.js` if the language uses a recognizable build manifest.
5. Add default include/exclude globs in `defaultGlobs()` inside `src/scanner/index.js`.
6. Add the extractor alias in `src/graph/builder.js` (`EXTRACTOR_ALIAS`).
7. Bump `EXTRACTOR_VERSION` in `src/graph/builder.js`, run `npm install` and test with `oracle ingest`.

---

## Adding a New MCP Tool

1. Create a handler in `src/mcp/tools/<tool-name>.js`. Export a function `handler(ctx, toolArgs)` returning `{ answer, evidence[], layer }`.
2. Add the tool definition (name, description, input schema) to `prompts/mcp/tools.json`.
3. Wire the handler in `TOOL_HANDLERS` in `src/mcp/index.js`.
4. The `GroundingWrapper` will automatically verify evidence and compute confidence.

---

## Adding a New CLI Command

1. Create `src/cli/commands/<name>.js` exporting a `Command` factory function.
2. Import and add it in `src/cli/index.js`.
3. Follow the pattern of existing commands: load workspace, validate subproject, use `getSubprojectDir` for artifact paths.
