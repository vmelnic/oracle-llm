# CLAUDE.md

## Quick reference

- **Language:** JavaScript (ES modules, no TypeScript, no build step)
- **Runtime:** Node.js >= 20
- **Entry:** `bin/oracle.js` / `npm start`
- **Test:** `npm test` (Node native test runner, `node --test tests/**/*.test.js`)
- **Install:** `npm install` (native deps: better-sqlite3, tree-sitter — needs C++ toolchain)

## Commands

```bash
node bin/oracle.js workspace add <path>              # register workspace
node bin/oracle.js workspace list                    # list registered workspaces
node bin/oracle.js ingest <workspace_id>             # build L1+L2 layers (BM25)
node bin/oracle.js ingest <ws> --embeddings          # build L1+L2 + semantic vectors
node bin/oracle.js serve                             # MCP server (stdio)
node bin/oracle.js serve --transport sse --port 3000 # MCP server (SSE)
node bin/oracle.js serve --watch                     # MCP server with auto-reindex
node bin/oracle.js status [workspace_id]             # show layer status
node bin/oracle.js gate <ws> <sp> --diff <path>      # emit gate
node bin/oracle.js benchmark <ws> <sp>               # run efficiency benchmark
node bin/oracle.js manifest show <ws> <sp>           # show manifest
node bin/oracle.js patterns list <ws> <sp>           # list pattern catalogue
node bin/oracle.js hooks install <ws>                # install auto-reindex git hooks
node bin/oracle.js hooks uninstall <ws>              # remove git hooks
node bin/oracle.js db migrate <ws> <sp>              # apply DB schema migrations
node bin/oracle.js db reset <ws> <sp>                # reset subproject DB
```

## Architecture

Three-layer oracle: L1 deterministic (entity graph, patterns, manifest, contracts) → L2 BM25 retrieval → L3 optional neural synthesis (local model with L1 context injection). Every answer carries `{ answer, evidence[], confidence, layer }`.

Data stored under `ORACLE_HOME` (default `~/.oracle/`), per-workspace/per-subproject. SQLite for entity graph, JSON for patterns/L2 index, YAML for manifest.

## MCP tools (22 total)

Core tools require `workspace_id` + `subproject_id`. All return `{ answer, evidence[], confidence, layer }`.

| Tool | Purpose |
|------|---------|
| `oracle.context` | **Primary tool.** Full task packet: existing files, create/modify suggestions, patterns, conventions, relevant code |
| `oracle.locate` | Find symbol definitions + reference count |
| `oracle.signature` | Signature, type info, JSDoc for a symbol or location |
| `oracle.exists` | Search by description, returns candidates |
| `oracle.nearby` | Symbols near a file:line, ranked by proximity |
| `oracle.consumers` | Transitive BFS consumer traversal |
| `oracle.diff_since` | Changed files + symbols since a git ref |
| `oracle.conventions_for` | Conventions for a topic (auth, routing, errors, etc.) |
| `oracle.where_would` | Suggest placement for new code |
| `oracle.pattern` | Look up a named pattern from the catalogue |
| `oracle.impact` | Impact analysis: breaking status, affected routes/components, migration needs |
| `oracle.validate` | Validate code against conventions + patterns |
| `oracle.read_exact` | Verbatim code lines (the only way to get raw code) |
| `oracle.stats` | Node/edge counts by kind |
| `oracle.ingest` | Trigger ingestion for a workspace/subproject |
| `oracle.workspace_add` | Register a new workspace |
| `oracle.workspace_scan` | Scan workspace for subprojects |
| `oracle.workspace_list` | List registered workspaces |
| `oracle.status` | Show layer status |
| `oracle.gate` | Run emit-gate validation |
| `oracle.manifest_show` | Show manifest for a subproject |
| `oracle.patterns_list` | List pattern catalogue entries |

## Key conventions

- No semicolons required (mixed codebase — follow the file you're editing)
- snake_case for DB columns, camelCase for JS variables
- Errors are intentionally swallowed in many places (parser failures, detector failures) — resilient by design
- Tree-sitter extractors walk nodes manually with `node.child(i)` and `node.childForFieldName()`
- `ORACLE_HOME` env var supports `~` tilde (expanded at runtime)
- Vue files: `<script>` block extracted and parsed as JS/TS (tree-sitter-vue grammar is incompatible with tree-sitter 0.25)

## Supported languages

javascript, typescript, tsx, php, dart, vue, python, go, rust, java

## Testing

- Tests live in `tests/`. 28 suites, 147 tests covering: benchmark, bm25, builder, contracts, emit-gate, graph-store, grounding, l3-inference, manifest, markdown, mcp, mcp-tools, parser, patterns, retrieval-l2, scanner, toon, weights-patch, workspace.
- Do not write or update tests unless explicitly asked.
- Mock GraphStore and filesystem state; avoid requiring real workspaces.

## L3 Neural Synthesis

L3 is an optional layer that augments open-ended tools (`context`, `where_would`, `conventions_for`) with natural-language synthesis from a local model. No fine-tuning required — L1 facts are injected into the model's system prompt, the model synthesizes around them, and WeightsThenPatch validates evidence against L1.

```bash
# Option A: Ollama (recommended)
ollama pull qwen3.5:9b
ORACLE_L3_BASE_URL=http://localhost:11434/v1
ORACLE_L3_MODEL=qwen3.5:9b

# Option B: mlx-lm / vllm
./scripts/serve-model.sh
ORACLE_L3_BASE_URL=http://localhost:8321/v1
ORACLE_L3_MODEL=Qwen/Qwen2.5-Coder-3B-Instruct

# Enable L3 in .env
ORACLE_L3_ENABLED=true

# Oracle MCP with L3
node bin/oracle.js serve
```

Factual tools always use L1. Any OpenAI-compatible `/v1/chat/completions` endpoint works.

## Proof-of-concept results

On a 21-subproject workspace (10,184 nodes, 4,115 edges):
- **L1+L2**: ~7,000 tokens/task avg, <160ms latency, 100% evidence verification, ~9x token reduction vs baseline
- **L3 synthesis**: 100% accuracy with Qwen2.5-Coder-3B-Instruct (zero fine-tuning, L1 context injection)

## Gotchas

- Extractors emit edges with `source_symbol`/`target_symbol` (not IDs). The graph builder resolves these to node IDs via local symbol map + DB lookup.
- L2 index path is `ast_embed_index/` (directory with `bm25.json` + optional `vectors.json`). Legacy `.json` single-file format is still loadable.
- Semantic embeddings require `ORACLE_EMBEDDINGS=true` + `ORACLE_EMBED_MODEL` in `.env` (or `--embeddings` on ingest). Package: `@huggingface/transformers` (optional dep).
- Native deps (better-sqlite3, tree-sitter grammars) need C++ toolchain. `package.json` has `overrides` to reconcile tree-sitter peer dep conflicts.
- `.env` loaded via dotenv at CLI startup. See `.env.example` for all options.
- Grounding wrapper allows empty evidence for `validate`, `diff_since`, `impact`, `read_exact`, `stats` — these are operational tools, not factual lookups.
- Emit gate `collectParseErrors` uses `node.isMissing` (property), not `node.isMissing()`.

## See also

- `CONVENTION.md` — code conventions (used by oracle meta-ingestion)
