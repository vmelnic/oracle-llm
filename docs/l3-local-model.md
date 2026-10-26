# L3 and the local model

L3 is the optional third layer of the oracle. It adds a short natural-language
answer to the three open-ended MCP tools, written by a language model **from
the verified L1/L2 facts only**, and keeps it only if every fact it cites is
real. Everything else in the oracle works without it.

This document covers what L3 does, how to plug in any OpenAI-compatible
backend, how to run the bundled local llama.cpp server, what gets installed
where, measured performance, and how to use the same local model as an agent
over the oracle's MCP tools (e.g. with [pi](https://pi.dev)).

- [What L3 does](#what-l3-does)
- [Configuration (any OpenAI-compatible backend)](#configuration-any-openai-compatible-backend)
- [Local model with llama.cpp](#local-model-with-llamacpp)
- [What gets installed, where, and how to remove it](#what-gets-installed-where-and-how-to-remove-it)
- [Measured performance](#measured-performance)
- [Prompts](#prompts)
- [Using the local model as an agent (pi)](#using-the-local-model-as-an-agent-pi)
- [Troubleshooting](#troubleshooting)

## What L3 does

L3 runs inside the MCP server for `oracle.context`, `oracle.where_would` and
`oracle.conventions_for`, after the L1/L2 result is built:

```
MCP request ─► tool (L1 graph + L2 retrieval)
                 │  every relevant symbol, its callers and callees, docs, conventions
                 ▼
           verify evidence on disk (paths, line ranges, symbols)
                 │
                 ▼
           numbered facts  [1] runIngestPipeline (function) at src/ingest/pipeline.js:25-68
                           [2] FileWatcher (class) at src/watcher/index.js:14-184 ...
                           [9] FileWatcher._processPending calls runIngestPipeline (line 112 of src/watcher/index.js)
                 │  (symbols as many as fit ORACLE_L3_CONTEXT_TOKENS, about 30% kept for the
                 │   call/render/use relations between them; the rest summarized in one line)
                 ▼
           model ──► "… prose …  evidence: [1, 2]"
                 │
                 ▼
           grounding check: cited numbers must exist, every path the prose
           names must come from the facts
                 │
        accepted ┴ rejected
           │          └─► response = plain L1/L2 result (drift logged)
           ▼
   response = L1/L2 result + layer: "L3"
              _l3_synthesis       prose, [n] references spelled out as path:lines
              _l3_citations       the facts it cited (path + line_range)
              _l3_synthesis_note  "Model-generated …; treat as untrusted"
```

Properties that hold for any model:

- **Coverage is not capped at a few results.** For a broad question ("how does
  login work", "how does subscription work") `oracle.context` keeps every
  result scoring at least 20% of the best match, plus the callers of that code
  (`ORACLE_CONTEXT_MAX_NODES`, default 50, is only a safety cap). The model
  sees all verified facts that fit the prompt budget, in relevance order, and
  a one-line summary of the rest (count and files). The MCP client always gets
  the full evidence list (trimmed answers keep up to `ORACLE_MAX_EVIDENCE`
  pointers).
- **Citations cannot be invented.** The model cites facts by number; an
  unknown number or an unknown path rejects the answer.
- **Repository text is untrusted.** Facts are fenced in the user turn,
  collapsed to single bounded lines, and the system prompt forbids following
  instructions inside them.
- **L3 never blocks.** Timeouts, connection errors and rejections fall back to
  the L1/L2 result; failures are logged to stderr (at most once a minute per
  message). Factual tools (`locate`, `consumers`, `impact`, …) never use L3.

## Configuration (any OpenAI-compatible backend)

L3 talks to any `/v1/chat/completions` endpoint. All settings are in `.env`
(see `.env.example`); they are validated at startup.

| Variable | Default | Meaning |
|---|---|---|
| `ORACLE_L3_ENABLED` | `false` | Turn L3 on/off |
| `ORACLE_L3_BASE_URL` | — | Endpoint base URL, e.g. `http://127.0.0.1:8321/v1` |
| `ORACLE_L3_MODEL` | `default` | Model name sent in requests |
| `ORACLE_L3_API_KEY` | — | Bearer token, if the backend needs one |
| `ORACLE_L3_TIMEOUT_MS` | `60000` | Deadline per call, retries included |
| `ORACLE_L3_RETRIES` | `1` | Retries on 429 / 5xx / connection reset |
| `ORACLE_L3_MAX_TOKENS` | `32768` | Answer length cap. With the local server the answer also stops when the prompt plus answer fill `ORACLE_LLM_CTX_SIZE`. An answer cut before its `evidence:` line is rejected as truncated |
| `ORACLE_L3_TEMPERATURE` | `0.2` | Sampling temperature |
| `ORACLE_L3_CONTEXT_TOKENS` | `1500` | Prompt budget for facts |
| `ORACLE_L3_REASONING_EFFORT` | — | `none`…`high`, sent as `reasoning_effort` (thinking models) |
| `ORACLE_L3_EXTRA_BODY` | — | JSON merged into every request body |
| `ORACLE_L3_EXTRA_HEADERS` | — | JSON of extra HTTP headers |
| `ORACLE_L3_PROMPTS_DIR` | `prompts/l3` | Directory with the prompt templates |

Backend-specific options are only sent when set, so a backend that doesn't
know them is unaffected. Examples:

```bash
# Bundled llama.cpp server (below)
ORACLE_L3_BASE_URL=http://127.0.0.1:8321/v1
ORACLE_L3_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M

# Ollama (thinking off for hybrid models)
ORACLE_L3_BASE_URL=http://127.0.0.1:11434/v1
ORACLE_L3_MODEL=qwen3:4b-instruct
ORACLE_L3_REASONING_EFFORT=none

# vLLM serving a hybrid-thinking model
ORACLE_L3_EXTRA_BODY={"chat_template_kwargs": {"enable_thinking": false}}

# OpenRouter / hosted APIs
ORACLE_L3_BASE_URL=https://openrouter.ai/api/v1
ORACLE_L3_API_KEY=sk-or-...
ORACLE_L3_MODEL=qwen/qwen3-4b
ORACLE_L3_EXTRA_HEADERS={"HTTP-Referer": "https://example.com"}
```

The MCP server reads these at startup: restart it (or reconnect the MCP
client) after changing them.

Measure any backend on your own code with the same path the server uses:

```bash
node bin/oracle.js llm bench <workspace_id> <subproject_id> [--tasks tasks.json] [--output results.json]
```

It runs the real tools, sends their verified facts to the configured L3
backend and reports acceptance, latency (p50/p95), generation and prompt
speed, and — for the local llama.cpp server — peak memory. Default tasks are
derived from the most-referenced symbols (templates in
`prompts/l3/bench-tasks.json`); `--tasks` takes a JSON array of
`{ "tool": "oracle.context" | "oracle.where_would" | "oracle.conventions_for", "args": {…} }`.

## Local model with llama.cpp

The repo can manage a local [llama.cpp](https://github.com/ggml-org/llama.cpp)
`llama-server` that serves one GGUF model over an OpenAI-compatible API on
`127.0.0.1`. It is optional: any other backend above works too.

```bash
# 1. Install llama.cpp yourself (the oracle never installs software) — see below
brew install llama.cpp          # macOS; other platforms: llama.cpp releases

# 2. Download the model (verified against Hugging Face's published SHA-256)
npm run llm:download            # = node bin/oracle.js llm download

# 3. Start the server in the background (waits until it serves requests)
npm run llm:start

# 4. Enable L3 in .env, then restart the MCP server
ORACLE_L3_ENABLED=true
ORACLE_L3_BASE_URL=http://127.0.0.1:8321/v1
ORACLE_L3_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M

npm run llm:status              # pid, health, served model, resident memory, log path
npm run llm:stop
```

`oracle llm start` refuses to bind a non-loopback address without
`ORACLE_LLM_API_KEY` (passed to llama-server through the environment, not the
command line). Its pid file and log live in `$ORACLE_HOME/llm/`. A stale pid
whose process is no longer `llama-server` is never signalled.

Server settings (`ORACLE_LLM_*` in `.env`):

| Variable | Default | Meaning |
|---|---|---|
| `ORACLE_LLM_BIN` | `llama-server` | Binary name or path |
| `ORACLE_LLM_HF_REPO` / `ORACLE_LLM_HF_FILE` | `unsloth/Qwen3-4B-Instruct-2507-GGUF` / `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` | Model to download |
| `ORACLE_LLM_HF_REVISION` | `main` | Repo revision |
| `ORACLE_LLM_HF_TOKEN` | — | For gated/private repos |
| `ORACLE_LLM_SHA256` | — | Enforce a checksum (otherwise Hugging Face's is used) |
| `ORACLE_LLM_MODELS_DIR` / `ORACLE_LLM_MODEL_PATH` | `$ORACLE_HOME/models` / — | Where models live, or a full GGUF path |
| `ORACLE_LLM_HOST` / `ORACLE_LLM_PORT` | `127.0.0.1` / `8321` | Bind address |
| `ORACLE_LLM_ALIAS` | file name | Model name the server reports (use it as `ORACLE_L3_MODEL`) |
| `ORACLE_LLM_API_KEY` | — | Required for non-loopback binds; set `ORACLE_L3_API_KEY` to the same value |
| `ORACLE_LLM_CTX_SIZE` | `32768` | Context window, shared by the `ORACLE_LLM_PARALLEL` slots. Must hold the prompt (~0.3–2K tokens) plus the answer (`ORACLE_L3_MAX_TOKENS`). Qwen3-4B with a q8_0 KV cache: ~4.8 GB resident at 32768, ~3.1 GB at 4096 |
| `ORACLE_LLM_KV_CACHE_TYPE` | `q8_0` | KV cache precision; halves cache memory vs f16 |
| `ORACLE_LLM_CACHE_RAM_MIB` | `256` | Prompt cache in RAM (llama.cpp's default is 8192) |
| `ORACLE_LLM_GPU_LAYERS` | `all` | Layers offloaded to the GPU |
| `ORACLE_LLM_THREADS` / `ORACLE_LLM_PARALLEL` | default / `1` | CPU threads / request slots |
| `ORACLE_LLM_REASONING_BUDGET` | `0` | `0` disables thinking for hybrid models |
| `ORACLE_LLM_START_TIMEOUT_MS` | `120000` | Startup wait |
| `ORACLE_LLM_EXTRA_ARGS` | — | Extra llama-server flags |

**Choosing a model.** The default is
[Qwen3-4B-Instruct-2507](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF)
(Q4_K_M, 2.33 GB): a non-thinking instruct model, so no time is spent on
hidden reasoning tokens, with the best answer quality of the models measured.
For machines with little memory,
[Ministral-3-3B-Instruct-2512](https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF)
(Q4_K_M, 2.00 GB) uses ~0.5 GB less RAM and is about as fast, but its prose
contains more factual slips (its citations are still checked):

```bash
ORACLE_LLM_HF_REPO=mistralai/Ministral-3-3B-Instruct-2512-GGUF
ORACLE_LLM_HF_FILE=Ministral-3-3B-Instruct-2512-Q4_K_M.gguf
ORACLE_L3_MODEL=Ministral-3-3B-Instruct-2512-Q4_K_M
```

Ministral 3B (2410) was never released as open weights, so it cannot run
locally.

## What gets installed, where, and how to remove it

Nothing is installed by the oracle itself. You install llama.cpp; the oracle
only downloads model files when you run `oracle llm download`.

| What | Installed by | Where | Size | Remove |
|---|---|---|---|---|
| llama.cpp (`llama-server`, `llama-cli`, … ) | you: `brew install llama.cpp` | `/opt/homebrew/Cellar/llama.cpp/<version>`, links in `/opt/homebrew/bin/llama-*` | ~19 MB | `brew uninstall llama.cpp` |
| its dependencies `ggml`, `openssl@4`, `libomp`, `ca-certificates` | Homebrew, with llama.cpp | `/opt/homebrew/Cellar/<name>` | ~74 MB | `brew uninstall ggml openssl@4 libomp ca-certificates` (only if nothing else uses them; `brew uses --installed <name>` tells you) |
| model files (`*.gguf`) | `oracle llm download` | `$ORACLE_HOME/models/` (default `~/.oracle/models/`) | 2.0–2.5 GB each | delete the file |
| server pid file and log | `oracle llm start` | `$ORACLE_HOME/llm/` | small | `oracle llm stop`, then delete the directory |

On Linux, install llama.cpp from your package manager or a
[release build](https://github.com/ggml-org/llama.cpp/releases) and point
`ORACLE_LLM_BIN` at `llama-server` if it is not on `PATH`.

## Measured performance

20 tasks (10 `context` explanations, 2 `context` creation tasks, 4
`where_would`, 4 `conventions_for`) on this repository, with
`oracle llm bench`. Apple M4 (base, 24 GB), llama.cpp 0.7.0 (Metal), Q4_K_M,
`ctx 4096`, KV cache `q8_0`, prompt cache 256 MiB.

| | Qwen3-4B-Instruct-2507 | Ministral-3-3B-Instruct-2512 |
|---|---|---|
| Accepted (grounding check) | **19/19 (100%)** | 19/19 (100%) |
| Latency p50 / p95 | 4.7 s / 10.5 s | 4.9 s / 8.5 s |
| Generation | ~32 tok/s | ~34 tok/s |
| Prompt processing | ~210–290 tok/s | ~265 tok/s |
| Peak resident memory | 3.3 GB | **2.8 GB** |
| Prose quality | accurate, complete | factual slips (e.g. inverted call direction) |

With the current default `ORACLE_LLM_CTX_SIZE=32768` the server holds
~4.8 GB resident (measured on the same machine); latency is unchanged, since
it depends on prompt and answer length, not on the window size.

One task per run had no verified facts and was skipped. On a base M4,
generation speed is bound by memory bandwidth, so latency mostly follows
answer length (≈90 tokens on average); prompt processing adds ~3.5 s per 1K
fact tokens. Lower `ORACLE_L3_CONTEXT_TOKENS` / `ORACLE_L3_MAX_TOKENS` for
speed, raise them for broader answers. Numbers on faster GPUs or larger Macs
will be proportionally better; measure with `oracle llm bench`.

## Prompts

Every text sent to the model is a template in `prompts/l3/`, with Twig-style
`{{placeholders}}`; nothing is hardcoded in JavaScript. A placeholder without
a value is an error, not literal braces in the prompt.

| File | Placeholders | Used for |
|---|---|---|
| `system.txt` | — | System prompt (rules, citation format) |
| `user.txt` | `{{context}}`, `{{question}}` | User turn; the tag around `{{context}}` is the untrusted-data fence |
| `question.context.txt` | `{{task}}` | Question for `oracle.context` |
| `question.where_would.txt` | `{{intent}}` | Question for `oracle.where_would` |
| `question.conventions_for.txt` | `{{topic}}` | Question for `oracle.conventions_for` |
| `fact.evidence.txt` | `{{id}}`, `{{symbol}}`, `{{kind}}`, `{{path}}`, `{{start_line}}`, `{{end_line}}` | A citable fact |
| `fact.relation.calls.txt`, `fact.relation.renders.txt`, `fact.relation.references.txt` | `{{id}}`, `{{caller}}`, `{{callee}}`, `{{line}}`, `{{path}}` | A verified relation between two facts from the graph; citing it cites the caller |
| `fact.file.txt`, `fact.suggested_file.txt`, `fact.pattern.txt`, `fact.convention.txt`, `fact.rule.txt`, `fact.more.txt` | see files | Other context lines |
| `bench-tasks.json` | `{{symbol}}` | Default tasks of `oracle llm bench` |

To customize, copy the directory, edit it and set `ORACLE_L3_PROMPTS_DIR`;
restart the MCP server to pick up changes. Keep the `[{{id}}]` numbering in
`fact.evidence.txt` and the "cite by number" rule in `system.txt`: citations
are matched by number. The MCP tool names, descriptions and input schemas that
clients show their model live in `prompts/mcp/tools.json`.

## Using the local model as an agent (pi)

L3 uses the model for one narrow job. The same local model can also *drive*
the oracle: an agent harness gives it the MCP tools and lets it decide what to
call. Probed directly against llama-server with the oracle's tool schemas,
Qwen3-4B-Instruct-2507 picks sensible tools with correct arguments (`locate`
for "where is X defined", `read_exact` with the right line range, `context`
for "how does X work") in 1.5–4 s per decision. Expect a 4B model to handle
lookups and short investigations well and long multi-step plans poorly.

[pi](https://pi.dev) is a minimal agent harness that supports local
OpenAI-compatible models and, since 1.0, MCP servers. Install it yourself
(it is not a dependency of this repo; see pi's docs for its installer), then:

1. **Give the model room for tool schemas and conversation.** Agent turns are
   much longer than L3 prompts; raise the context before starting the server:

   ```bash
   ORACLE_LLM_CTX_SIZE=32768 npm run llm:start   # or set it in .env
   ```

   At 32K context with a `q8_0` KV cache, expect roughly 2 GB more memory.

2. **Register the local model** in pi's `models.json` (in pi's agent
   directory; see `examples/pi/models.json`):

   ```json
   {
     "$schema": "https://pi.dev/schemas/models.schema.json",
     "providers": {
       "oracle-local": {
         "baseUrl": "http://127.0.0.1:8321/v1",
         "api": "openai-completions",
         "apiKey": "local",
         "models": [{ "id": "Qwen3-4B-Instruct-2507-Q4_K_M" }]
       }
     }
   }
   ```

   `apiKey` must be non-empty for pi; use `ORACLE_LLM_API_KEY`'s value if you
   set one. Select the model with `/model` inside pi.

3. **Add the oracle MCP server**: per project in `.pi/mcp.json`, or for all
   projects in `~/.pi/agent/mcp.json` (see `examples/pi/mcp.json`):

   ```json
   {
     "mcpServers": {
       "oracle": {
         "command": "node",
         "args": ["/absolute/path/to/llm-oracle/bin/oracle.js", "serve"],
         "exposure": "direct"
       }
     }
   }
   ```

   `direct` exposure declares the oracle tools to the model like built-in
   tools, which suits small models better than pi's default `codemode`
   (writing JavaScript to call tools). Check the connection with
   `pi mcp list`.

4. **Ingest the project first** (`node bin/oracle.js workspace add <path>` and
   `node bin/oracle.js ingest <workspace_id>`), then ask pi questions that name
   the workspace and subproject, e.g. "In workspace my-app, subproject
   backend: how does subscription renewal work?".

With L3 enabled as well, the agent receives `_l3_synthesis` alongside the
facts; with a 4B agent this often saves it a step. Both use the same
llama-server; set `ORACLE_LLM_PARALLEL=2` if they run at the same time.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `'llama-server' not found` | Install llama.cpp, or set `ORACLE_LLM_BIN` to its path |
| `Model not found: …gguf` | `oracle llm download` |
| `SHA-256 mismatch` | The partial download was deleted; run `oracle llm download` again |
| No `_l3_synthesis` in responses | `ORACLE_L3_ENABLED=true`, server reachable (`oracle llm status`), MCP server restarted; check its stderr for `[l3] synthesis failed` |
| `Model returned only reasoning` | A thinking model: `ORACLE_LLM_REASONING_BUDGET=0` (llama.cpp) or `ORACLE_L3_REASONING_EFFORT=none` |
| Slow answers | Lower `ORACLE_L3_CONTEXT_TOKENS` / `ORACLE_L3_MAX_TOKENS`, or use a smaller quantization |
| Memory grows | Keep `ORACLE_LLM_CACHE_RAM_MIB` small and `ORACLE_LLM_CTX_SIZE` as low as your prompts allow |
