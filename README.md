# llm-oracle

Layered grounded oracle for code intelligence via MCP. Lets a frontier model (Claude, GPT, etc.) work on any multi-subproject workspace without reading the repo itself — all discovery is delegated to the oracle.

Three layers: **L1 deterministic** (entity graph, patterns, manifest, contracts) → **L2 BM25 retrieval** → **L3 optional neural synthesis** (local model with L1 context injection). Every answer carries `{ answer, evidence[], confidence, layer }`. The oracle never writes code.

## Install

```bash
# Requires Node.js >= 20.3 and a C++ toolchain (for native deps)
# @huggingface/transformers (local embeddings) is optional; installs without it still work
npm install
```

## Quick start

```bash
# 1. Register a workspace
node bin/oracle.js workspace add /path/to/your/project

# 2. Ingest (builds L1 entity graph + patterns + manifest + contracts + L2 index)
node bin/oracle.js ingest my-project

# 3. Check status
node bin/oracle.js status my-project

# 4. Start MCP server
node bin/oracle.js serve                       # stdio (for Claude Code, Cursor, etc.)
node bin/oracle.js serve --transport http      # Streamable HTTP (http://127.0.0.1:3000/mcp)
```

## Configuration

Copy `.env.example` to `.env` (it is the complete, commented list of settings). Every `ORACLE_*`
value is validated when the CLI starts; an invalid one stops it with a clear message.

```bash
ORACLE_HOME=~/.oracle              # data directory
ORACLE_MCP_PORT=3000               # Streamable HTTP server port
ORACLE_MCP_HOST=127.0.0.1          # loopback by default
ORACLE_MCP_IDLE_TIMEOUT_MINUTES=0  # 0 = no timeout
ORACLE_MCP_CACHE_SIZE=128          # LRU cache entries
ORACLE_BM25_K1=1.2                 # BM25 tuning
ORACLE_BM25_B=0.75
ORACLE_MAX_DEPTH=5                 # graph traversal depth
ORACLE_RESPECT_GITIGNORE=true      # skip git-ignored files when indexing
ORACLE_OUTPUT_FORMAT=toon          # 'toon' (~35% fewer tokens) or 'json'

# L2 semantic embeddings (optional, BM25-only by default)
ORACLE_EMBEDDINGS=false
ORACLE_EMBED_MODEL=jinaai/jina-embeddings-v2-base-code
ORACLE_EMBED_UNLOAD_TIMEOUT=300  # unload ONNX model after N seconds idle (0 = never)
# Remote API alternative:
# ORACLE_EMBED_API_URL=https://api.voyageai.com/v1/embeddings
# ORACLE_EMBED_API_KEY=your-api-key
# ORACLE_EMBED_DIMENSIONS=1024

# L3 synthesis (optional; any OpenAI-compatible backend, see docs/l3-local-model.md)
ORACLE_L3_ENABLED=false
ORACLE_L3_BASE_URL=http://127.0.0.1:8321/v1
ORACLE_L3_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M
```

HTTP is loopback-only by default. Binding to another interface requires
an `ORACLE_MCP_AUTH_TOKEN` of at least 32 bytes and an explicit
`ORACLE_MCP_ALLOWED_HOSTS` allowlist. Administrative MCP tools remain disabled over HTTP
unless `ORACLE_MCP_ADMIN_ENABLED=true` and `ORACLE_ALLOWED_ROOTS` contains the
canonical roots that may be registered; over HTTP the same allowlist also limits which
workspaces the query tools can read. `oracle.gate` executes the project's type-checker
and tests on client-supplied code, so over HTTP it additionally requires
`ORACLE_MCP_GATE_ENABLED=true`. Put TLS and network policy in front of
the process for remote deployments; see `SECURITY.md` for the deployment baseline.

## CLI commands

```bash
# Workspace management
node bin/oracle.js workspace add <path> [--only api,web]   # --only keeps those subprojects
node bin/oracle.js workspace list

# Ingestion
node bin/oracle.js ingest <workspace_id>
node bin/oracle.js ingest <workspace_id> --embeddings   # with semantic vectors

# MCP server
node bin/oracle.js serve [--transport stdio|http] [--host 127.0.0.1] [--port 3000] [--watch]

# Inspection
node bin/oracle.js status [workspace_id]
node bin/oracle.js manifest show <workspace_id> <subproject_id>
node bin/oracle.js patterns list <workspace_id> <subproject_id>

# Emit gate (pre-commit validation)
node bin/oracle.js gate <workspace_id> <subproject_id> --diff <path.json>

# Git hooks (auto re-index on pull/checkout)
node bin/oracle.js hooks install <workspace_id>
node bin/oracle.js hooks uninstall <workspace_id>

# Database management
node bin/oracle.js db migrate <workspace_id> <subproject_id>
node bin/oracle.js db reset <workspace_id> <subproject_id>

# Efficiency benchmarking
node bin/oracle.js benchmark <workspace_id> <subproject_id> [--output results.json]

# Local model server for L3 (llama.cpp; see docs/l3-local-model.md)
node bin/oracle.js llm download|start|status|stop
node bin/oracle.js llm bench <workspace_id> <subproject_id>   # L3 speed + grounding acceptance
```

## L3 synthesis (optional)

With L3 on, `oracle.context`, `oracle.where_would` and `oracle.conventions_for`
also return `_l3_synthesis`: a short answer written by a language model from
the verified L1/L2 facts only, with `_l3_citations` pointing at the facts it
used. The model cites facts by number; an answer citing anything that isn't a
verified fact is dropped and the plain L1/L2 result is returned. Broad
questions ("how does login work") consider every related symbol and its
callers, not a fixed top few.

It works with any OpenAI-compatible backend configured in `.env`. The repo can
run a local llama.cpp server for it (you install llama.cpp; the oracle never
installs software):

```bash
brew install llama.cpp       # macOS; see the doc for other platforms and what this installs
npm run llm:download         # Qwen3-4B-Instruct-2507 Q4_K_M, 2.3 GB, SHA-256 verified
npm run llm:start            # 127.0.0.1:8321, OpenAI-compatible
# .env: ORACLE_L3_ENABLED=true, then restart the MCP server
```

On a base Apple M4 it answers in ~4.7 s (p50) with ~4.8 GB of memory (32K context; ~3.3 GB at 4K) and 100%
of answers passing the grounding check. The same local model can drive the
oracle's MCP tools as an agent through a harness such as [pi](https://pi.dev).

Full guide (configuration, other backends, installed files and removal,
measurements, prompt templates, agent setup):
**[docs/l3-local-model.md](docs/l3-local-model.md)**.

## MCP tools (22 total)

Core tools require `workspace_id` + `subproject_id`. All return `{ answer, evidence[], confidence, layer }`.

### Discovery

| Tool | Description |
|------|-------------|
| `oracle.locate` | Find definitions of a symbol. Returns `definitions[]`, `references_count` |
| `oracle.signature` | Signature + type info + doc for a symbol or `path:line` |
| `oracle.exists` | Search by description. Returns `present`, `candidates[]` |
| `oracle.nearby` | Symbols near a `path:line`, ranked by proximity and optional `intent` |
| `oracle.consumers` | Who uses a symbol: call lines, transitive users, callers through interfaces, implementations, possible call sites (`complete: false`) |
| `oracle.diff_since` | Changed files + symbols since a git `ref` |

### Synthesis

| Tool | Description |
|------|-------------|
| `oracle.context` | **Primary tool.** Full task packet: existing files, suggested creates/modifies, DB schema, patterns, conventions, relevant code |
| `oracle.conventions_for` | Conventions for a `topic` (auth, routing, errors, validation, state, migrations) |
| `oracle.where_would` | Suggest file placement for an `intent` (e.g. "user registration API") |
| `oracle.pattern` | Look up a named pattern from the catalogue |

### Validation

| Tool | Description |
|------|-------------|
| `oracle.impact` | Impact analysis for a proposed `change`. Breaking status, affected routes/components, migration needs |
| `oracle.validate` | Validate `proposed_code` at `path` against conventions + patterns |

### Raw access

| Tool | Description |
|------|-------------|
| `oracle.read_exact` | Verbatim lines from `path` with `line_range: [start, end]` |
| `oracle.stats` | Node/edge counts by kind |

### Admin / workspace management

| Tool | Description |
|------|-------------|
| `oracle.ingest` | Trigger ingestion for a workspace/subproject |
| `oracle.workspace_add` | Register a new workspace |
| `oracle.workspace_scan` | Scan workspace for subprojects |
| `oracle.workspace_list` | List registered workspaces |
| `oracle.status` | Show layer status for a workspace |
| `oracle.gate` | Run emit-gate validation |
| `oracle.manifest_show` | Show manifest for a subproject |
| `oracle.patterns_list` | List pattern catalogue entries |

## Using with Claude Code

The project includes `.mcp.json` at the root — Claude Code auto-discovers it when you open the project directory.

To install globally instead, add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "oracle": {
      "command": "node",
      "args": ["/absolute/path/to/llm-oracle/bin/oracle.js", "serve"]
    }
  }
}
```

## Emit gate

The emit gate validates proposed code changes before commit. It runs 5 checks:

1. **Tree-sitter parse** — syntax errors
2. **Typecheck** — auto-detects tsc, php, dart analyze, go vet, cargo check, mypy
3. **oracle.validate** — convention + pattern conformance
4. **oracle.impact** — downstream consumer check, breaking change detection
5. **Affected tests** — auto-detects jest, vitest, mocha, phpunit, pytest, playwright, go test, cargo test

```bash
node bin/oracle.js gate my-project backend --diff changes.json
# Exit code 0 = committable, 1 = failed
```

`changes.json` is `{ "files": [{ "path": "src/x.js", "proposed_code": "..." }] }` (or a bare
array; `content` is accepted instead of `proposed_code`, and `"action": "delete"` removes a file).
The MCP `oracle.gate` tool takes the same array as its `diff` argument.

## Benchmarking

Measure oracle efficiency — tokens per query, latency, evidence accuracy:

```bash
node bin/oracle.js benchmark my-project backend
node bin/oracle.js benchmark my-project backend --tasks tasks.json --output results.json
```

## Historical proof-of-concept results

On a 21-subproject workspace (10,184 nodes, 4,115 edges):

| Metric | Value |
|--------|-------|
| Tokens per task | ~7,000 avg |
| Latency | <160ms |
| Evidence verification | 100% in the referenced sample |
| Token reduction vs baseline | ~9x |

These historical sample results are not an SLA. Run `oracle benchmark` against
the exact workspace and commit used in a deployment. For L3, see the measured
results in [docs/l3-local-model.md](docs/l3-local-model.md#measured-performance)
and run `oracle llm bench`.

## Supported languages

javascript, typescript, tsx, php, dart, vue, python, go, rust, java

### How method calls are resolved (JS/TS, PHP, Dart)

Static analysis, no type checker. A call `receiver.method()` is bound when the
receiver's type can be told from the code: `this`/`self`/`static`/`parent`,
typed parameters and properties (TS, PHP, Dart, JSDoc), PHP constructor
promotion and `@var`, `new X()`, static calls, DI lookups (`app(X::class)`,
`Get.find<X>()`, `context.read<X>()`), the declared return type of the call
that produced the receiver, then the class itself or the nearest class,
interface, trait or `@mixin` it inherits from. With the type unknown, a call is
bound only when the receiver's name points at exactly one concrete class
defining the method (`$userService->find()`, `store.getNode()`); otherwise it
is kept as a *possible call site*. `oracle.consumers` reports those and sets
`complete: false` instead of claiming a method is unused. Calls made through
dynamic dispatch the code does not spell out (magic `__call` without a naming
link, reflection, string callbacks) are not resolved.

Python, Go, Rust and Java keep their earlier, simpler call extraction.

## Storage layout

```
~/.oracle/
  workspaces/
    my-project/
      workspace.json
      subprojects/
        backend/
          entity_graph.sqlite       # L1
          pattern_catalog.json      # L1
          manifest.yaml             # L1 (safe to edit by hand)
          manifest.drafted.yaml     # last auto-draft, baseline for the re-ingest merge
          contract_surfaces.json    # L1
          ast_embed_index/           # L2
            bm25.json                # BM25 + vector generation it pairs with
            vectors.<gen>.bin        # (optional) Float32 embeddings
            vectors.<gen>.meta.json  # (optional) ids, hashes, dimension
  models/                           # GGUF models from `oracle llm download`
  llm/                              # llama-server pid file and log
```

## Tests

```bash
npm test
npm run test:coverage   # with per-file coverage
npm run lint            # ESLint
npm run check           # lint + tests + knip + npm audit
```

The suite covers: benchmark, BM25, builder, contracts, emit-gate, graph-store, grounding, L3 inference, manifest, markdown, MCP tools, parser, patterns, retrieval (L2), scanner, toon, weights-patch, workspace.

## License

MIT — see [LICENSE](LICENSE).
