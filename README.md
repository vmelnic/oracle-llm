# llm-oracle

Layered grounded oracle for code intelligence via MCP. Lets a frontier model (Claude, GPT, etc.) work on any multi-subproject workspace without reading the repo itself — all discovery is delegated to the oracle.

Three layers: **L1 deterministic** (entity graph, patterns, manifest, contracts) → **L2 BM25 retrieval** → **L3 optional neural synthesis** (local model with L1 context injection). Every answer carries `{ answer, evidence[], confidence, layer }`. The oracle never writes code.

## Install

```bash
# Requires Node.js >= 20 and a C++ toolchain (for native deps)
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
node bin/oracle.js serve --transport sse       # SSE (http://localhost:3000/sse)
```

## Configuration

Copy `.env.example` to `.env`:

```bash
ORACLE_HOME=~/.oracle              # data directory
ORACLE_MCP_PORT=3000               # SSE server port
ORACLE_MCP_IDLE_TIMEOUT_MINUTES=0  # 0 = no timeout
ORACLE_MCP_CACHE_SIZE=128          # LRU cache entries
ORACLE_BM25_K1=1.2                 # BM25 tuning
ORACLE_BM25_B=0.75
ORACLE_MAX_DEPTH=5                 # graph traversal depth
ORACLE_OUTPUT_FORMAT=toon          # 'toon' (~35% fewer tokens) or 'json'

# L2 semantic embeddings (optional, BM25-only by default)
ORACLE_EMBEDDINGS=true
ORACLE_EMBED_MODEL=jinaai/jina-embeddings-v2-base-code
ORACLE_EMBED_UNLOAD_TIMEOUT=300  # unload ONNX model after N seconds idle (0 = never)
# Remote API alternative:
# ORACLE_EMBED_API_URL=https://api.voyageai.com/v1/embeddings
# ORACLE_EMBED_API_KEY=your-api-key
# ORACLE_EMBED_DIMENSIONS=1024

# L3 neural synthesis (optional)
ORACLE_L3_ENABLED=false
# ORACLE_L3_BASE_URL=http://localhost:8321/v1
# ORACLE_L3_MODEL=Qwen/Qwen2.5-Coder-3B-Instruct
# ORACLE_L3_API_KEY=
```

## CLI commands

```bash
# Workspace management
node bin/oracle.js workspace add <path>
node bin/oracle.js workspace list

# Ingestion
node bin/oracle.js ingest <workspace_id>
node bin/oracle.js ingest <workspace_id> --embeddings   # with semantic vectors

# MCP server
node bin/oracle.js serve [--transport stdio|sse] [--port 3000] [--watch]

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
```

## L3 Neural Synthesis

Optional layer that augments open-ended tools (`context`, `where_would`, `conventions_for`) with natural-language synthesis from a local model. No fine-tuning required — L1 facts are injected into the model's system prompt, the model synthesizes around them, and WeightsThenPatch validates evidence against L1.

Any OpenAI-compatible `/v1/chat/completions` endpoint works. Three options:

### Option A: Ollama (recommended)

```bash
# 1. Install Ollama (https://ollama.com)
# 2. Pull a model
ollama pull qwen3.5:9b

# 3. Enable L3 in .env
ORACLE_L3_ENABLED=true
ORACLE_L3_BASE_URL=http://localhost:11434/v1
ORACLE_L3_MODEL=qwen3.5:9b

# 4. Start oracle MCP
node bin/oracle.js serve
```

### Option B: mlx-lm (Apple Silicon) or vllm (NVIDIA)

```bash
# 1. Set up Python venv and install model server
python3 -m venv .venv
source .venv/bin/activate
pip install mlx-lm         # Apple Silicon (M1/M2/M3/M4)
# pip install vllm          # NVIDIA GPU (CUDA)

# 2. Start model server
./scripts/serve-model.sh
# or with options:
./scripts/serve-model.sh --model Qwen/Qwen2.5-Coder-7B-Instruct --port 8321

# 3. Enable L3 in .env
ORACLE_L3_ENABLED=true
ORACLE_L3_BASE_URL=http://localhost:8321/v1
ORACLE_L3_MODEL=Qwen/Qwen2.5-Coder-3B-Instruct

# 4. Start oracle MCP
node bin/oracle.js serve
```

Factual tools always use L1 — the model is only used for synthesis on open-ended queries.

### How it works

The oracle injects L1 facts (entity graph nodes, patterns, conventions) into the model's system prompt. The model synthesizes natural language around those facts — it never invents paths or symbols. WeightsThenPatch validates every evidence pointer against L1 before returning.

```
User query: "How does the entity graph get built?"

L1 retrieves:
  - buildGraph: function, src/graph/builder.js:33-209
  - GraphStore: class, src/graph/store.js:21-422
  - createParser: function, src/parser/index.js:106-205

Model receives L1 facts in system prompt → synthesizes:

  "The entity graph is built incrementally from a file tree using the
   buildGraph function in src/graph/builder.js:33-209."
   evidence: [{"path": "src/graph/builder.js", "line_range": [33, 209]}]

WeightsThenPatch validates evidence against L1 → ✓ all paths exist, line ranges match
```

### Direct model server test

```bash
# Verify model server is running
curl -s http://localhost:8321/v1/models | python3 -m json.tool

# Query with L1 context injection
curl -s http://localhost:8321/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-Coder-3B-Instruct",
    "messages": [
      {"role": "system", "content": "You are a codebase oracle. Answer using ONLY the provided context. Be concise.\nEnd every answer with: evidence: [{\"path\": \"file/path\", \"line_range\": [start, end]}]\n\nContext:\n- authenticate: function, middleware/auth.js:5-32\n- verifyJwt: function, mcp-http.js:26-44"},
      {"role": "user", "content": "Where is JWT verification handled?"}
    ],
    "max_tokens": 200,
    "temperature": 0.1
  }'

# Response:
# "JWT verification is handled in the authenticate function,
#  which is a middleware located in middleware/auth.js at lines 5-32.
#  evidence: [{"path": "middleware/auth.js", "line_range": [5, 32]}]"
```

## MCP tools (22 total)

Core tools require `workspace_id` + `subproject_id`. All return `{ answer, evidence[], confidence, layer }`.

### Discovery

| Tool | Description |
|------|-------------|
| `oracle.locate` | Find definitions of a symbol. Returns `definitions[]`, `references_count` |
| `oracle.signature` | Signature + type info + doc for a symbol or `path:line` |
| `oracle.exists` | Search by description. Returns `present`, `candidates[]` |
| `oracle.nearby` | Symbols near a `path:line`, ranked by proximity and optional `intent` |
| `oracle.consumers` | Transitive BFS consumers of a symbol |
| `oracle.diff_since` | Changed files + symbols since a git `ref` |

### Synthesis

| Tool | Description |
|------|-------------|
| `oracle.context` | **Primary tool.** Full task packet: existing files, suggested creates/modifies, DB schema, patterns, conventions, relevant code |
| `oracle.conventions_for` | Conventions for a `topic` (auth, routing, errors, validation, state, migrations) |
| `oracle.where_would` | Suggest file placement for an `intent` (e.g. "therapist registration API") |
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

## Benchmarking

Measure oracle efficiency — tokens per query, latency, evidence accuracy:

```bash
node bin/oracle.js benchmark my-project backend
node bin/oracle.js benchmark my-project backend --tasks tasks.json --output results.json
```

## Proof-of-concept results

On a 21-subproject workspace (10,184 nodes, 4,115 edges):

| Metric | Value |
|--------|-------|
| Tokens per task | ~7,000 avg |
| Latency | <160ms |
| Evidence verification | 100% |
| Token reduction vs baseline | ~9x |
| L3 synthesis accuracy | 100% (Qwen2.5-Coder-3B-Instruct, zero fine-tuning) |

## Supported languages

javascript, typescript, tsx, php, dart, vue, python, go, rust, java

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
          manifest.yaml             # L1
          contract_surfaces.json    # L1
          ast_embed_index/           # L2
            bm25.json
            vectors.json             # (optional, when embeddings enabled)
```

## Tests

```bash
npm test
```

28 suites, 147 tests covering: benchmark, BM25, builder, contracts, emit-gate, graph-store, grounding, L3 inference, manifest, markdown, MCP tools, parser, patterns, retrieval (L2), scanner, toon, weights-patch, workspace.
