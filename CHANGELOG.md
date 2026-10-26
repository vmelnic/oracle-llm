# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Upgrade notes

- Requires Node.js >= 20.3.
- L3: existing `ORACLE_L3_BASE_URL` / `ORACLE_L3_MODEL` / `ORACLE_L3_API_KEY`
  settings keep working. Responses now add `_l3_citations`, and
  `_l3_synthesis` no longer ends with an evidence line. `scripts/serve-model.sh`
  is gone: use `oracle llm start` or any OpenAI-compatible server.
- Databases migrate automatically on first open (schema v3–v6). The first ingest
  after upgrading reprocesses every file once; later ingests are incremental.
  The graph also records the extractor version it was built with: after an
  upgrade that changes extraction or resolution, the next ingest rebuilds the
  graph in full on its own.
- `oracle.consumers` returns a new shape: `direct` (with `call_lines`),
  `transitive`, `through_parent`, `implementations`, `possible_call_sites`,
  `summary` and `complete`.
- The L2 index is rewritten in the binary vector format on the next ingest.
  Cached embeddings are reused.
- Files ignored by `.gitignore` are dropped from the index on the next ingest.
  Set `ORACLE_RESPECT_GITIGNORE=false` to keep the old behaviour.
- Invalid `ORACLE_*` values now stop the CLI at startup instead of silently
  falling back to defaults.
- Over HTTP, `oracle.gate` needs `ORACLE_MCP_GATE_ENABLED=true` in addition to
  admin tools, and `ORACLE_ALLOWED_ROOTS` now also limits the query tools.
- Re-run `oracle hooks install <ws>` to get the background (non-blocking) hook.
- `workspace install-hooks` / `uninstall-hooks` were removed; use
  `hooks install` / `uninstall`.

### Added

- L3 facts include the verified relations between the facts ("A calls B (line N of path)", renders, uses), with about 30% of the fact budget kept for them; `system.txt` tells the model to describe flow only from these, not from names.
- `oracle.context` also brings in what relevant code calls (two calls deep), weights down members matched only through their class name, properties and tests, and fills `ORACLE_CONTEXT_MAX_NODES` by evidence strength (task words in the symbol, then callers/callees, then semantic-only hits, then nearby code).
- Method calls are part of the graph. Extractors (JS/TS, PHP, Dart) describe
  each `receiver.method()` call with what they know about the receiver's type
  (`this`, typed parameters and properties, constructor promotion, `new X()`,
  static calls, `@var`, DI lookups such as `app(X::class)` / `Get.find<X>()`,
  GetX `controller`, `State<W>.widget`), and the builder binds it once every
  node is written (`src/graph/calls.js`): on the type or the nearest class,
  interface, trait or `@mixin` it inherits from; through the return type of
  the call that produced the receiver (`$repo->find()->save()`); or, with the
  type unknown, only when the receiver's name points at exactly one concrete
  class (`$userService->x()`, `store.getNode()`). Calls that stay unbound are
  recorded as possible call sites. Edges keep their resolution and call lines.
- `oracle.consumers` lists exact call lines, callers that reach a method
  through the interface or parent declaration it implements, its
  implementations, and possible call sites with `complete: false` (confidence
  capped) instead of reporting "no callers". `oracle.impact` and the emit
  gate's breaking-change check use the same information; the gate now checks
  every symbol used from another file, not only exported ones (JS/TS class
  methods are never "exported").
- Module resolution beyond relative paths (`src/graph/modules.js`): tsconfig /
  jsconfig `paths` (with `extends`), workspace packages by name (with simple
  `exports` maps) and Dart `package:<own name>/`. Monorepo imports through
  aliases now resolve.
- JS/TS: module-level constants (columns, schemas, route tables) are
  `variable` nodes, so the calls and JSX inside them have a source; imported
  or top-level names passed as values are `references` edges; top-level
  `describe`/`test` blocks are `test` nodes; return types come from TS
  annotations, JSDoc `@returns` or `return new X()`.
- Dart: method bodies are analysed (calls, constructors without `new`, implicit
  `this`, widgets rendered in `build`); method and function ranges include the
  body; mixin members are extracted; constructors are `Class.Class` /
  `Class.named`.
- `oracle workspace add --only a,b` / `oracle.workspace_add { subprojects }`
  register a subset of a workspace's subprojects; re-scans keep the selection.
- Framework detection reads the package.json files of a monorepo's workspaces
  (npm/yarn `workspaces`, pnpm-workspace.yaml).
- `ORACLE_TOKEN_CAP` / `ORACLE_TOKEN_CAP_EXTENDED` configure answer size caps;
  `consumers`, `impact` and `locate` use the extended cap.

- L3 rebuilt: one synthesis path (`src/l3/synthesize.js`) shared by the MCP
  server and `oracle llm bench`. The model gets the verified facts as numbered
  lines, cites them by number (a few tokens instead of copied paths and line
  ranges), and the oracle maps numbers back to facts: unknown numbers or
  invented paths reject the answer. Responses carry `_l3_synthesis` (inline
  `[n]` spelled out as `path:lines`), `_l3_citations` and the untrusted note.
- L3 works with any OpenAI-compatible backend, configured only through `.env`:
  `ORACLE_L3_MAX_TOKENS`, `ORACLE_L3_TEMPERATURE`, `ORACLE_L3_CONTEXT_TOKENS`
  (fact budget; overflow summarized in one line), `ORACLE_L3_REASONING_EFFORT`,
  `ORACLE_L3_EXTRA_BODY`, `ORACLE_L3_EXTRA_HEADERS`, `ORACLE_L3_PROMPTS_DIR`.
- `oracle llm download|start|status|stop|bench` (and `npm run llm:*`) manage a
  local llama.cpp `llama-server`: SHA-256-verified, resumable model download;
  background start with readiness wait, loopback by default, API key via the
  environment; status with resident memory; low-RAM defaults (4K context,
  q8_0 KV cache, 256 MiB prompt cache). All settings are `ORACLE_LLM_*`.
  Default model Qwen3-4B-Instruct-2507 Q4_K_M; Ministral-3-3B-2512 documented
  as the low-memory alternative. llama.cpp is never installed by the oracle.
- All model-facing text moved to files: `prompts/l3/*.txt` (Twig-style
  `{{placeholders}}`) and `prompts/mcp/tools.json` (MCP tool definitions).
- `docs/l3-local-model.md`: L3 behaviour, backends, what gets installed where
  and how to remove it, measured performance, prompt templates, and running
  the local model as an agent over the oracle's MCP tools with pi
  (`examples/pi/`).
- Incremental ingest: only changed files and the files whose edges depend on
  them are reprocessed (`unresolved_refs` table tracks dangling references).
- `.gitignore`-aware file discovery shared by the builder, scanner and contract
  detectors (`src/utils/glob.js`); never follows symlinks. Nested repositories
  and submodules are indexed as a whole.
- Automatic schema migrations on open, including databases created before
  version tracking.
- Startup validation of all `ORACLE_*` environment variables.
- `ORACLE_L3_TIMEOUT_MS`, `ORACLE_L3_RETRIES`, `ORACLE_MCP_GATE_ENABLED`,
  `ORACLE_RESPECT_GITIGNORE`, `ORACLE_DETECTOR_MAX_FILES`,
  `ORACLE_MAX_TRAVERSAL_RESULTS`, `ORACLE_DEBUG`.
- ESLint (`npm run lint`), `.editorconfig`, `npm run test:coverage`; CI runs
  lint and coverage.
- MIT license.

### Changed

- `oracle.where_would` learns placement from the repository instead of picking the directory with the most classes. The intent's head noun is the role ("API *controller* for invoices"); its files are found by file-name suffix, parent directory or node kind. The proposal goes to the directory already holding that role for the feature, else the per-feature layout (`modules/<feature>/controllers`), else the main directory, with the alternative listed. Names copy the neighbours' prefix/suffix (`Api…Controller`, `use-…`), timestamp prefix, extension and casing; shared code ("reusable …") goes outside feature directories; tests and generated code are never proposed unless asked; an existing name is reported instead of inventing `name_2`.
- `oracle.conventions_for` scores code by the topic's words in names, base types and paths (whole words and inflections: "log" matches logger, not login), and reports the base types the topic's code extends, where it lives, route middleware counts for auth/routing, matching patterns, documented rules and ranked examples. Any topic word works; multi-word topics say when only part of the words match.

- `ORACLE_LLM_CTX_SIZE` defaults to 32768 (was 4096) so the local server fits the prompt plus a long answer; Qwen3-4B then holds ~4.8 GB resident instead of ~3.1 GB.
- `ORACLE_L3_MAX_TOKENS` defaults to 32768 (was 256, which cut longer answers before their evidence line). A cut answer is now rejected with that reason, and repeated citations are listed once.
- MCP server keeps per-subproject resources in reference-counted bundles, so a
  reindex or cache eviction never closes a database under an in-flight request.
  While a reindex runs, a subproject that is already loaded keeps answering
  from its last complete build (otherwise the request asks to retry).
  The graph is committed first and contracts/markdown afterwards, each
  atomically, so a query in between can see a new graph with old contracts.
- File watchers are independent of the resource cache and stop only on shutdown.
- The ingest lock is kept alive by a heartbeat; a lock is stale only when its
  owner died or the heartbeat stopped (also covers PIDs reused after a crash).
- `oracle.gate` runs type-checkers and tests asynchronously instead of blocking
  the event loop.
- L2 vectors are stored as binary Float32 generations committed atomically with
  `bm25.json`; BM25 loads in linear time.
- Namespace-suffix symbol lookups use an indexed `short_symbol` column.
- L3 calls have a total deadline, retry transient failures, are cancelled with
  the MCP request, and log failures (throttled) instead of failing silently.
- CLI errors print one line and exit with code 1; `ORACLE_DEBUG=true` adds the
  stack trace. Numeric options are validated.
- Git hooks reindex in the background, use the absolute `node` path and honour
  `core.hooksPath`.
- One ingest pipeline (`src/ingest/pipeline.js`) is shared by the CLI, the MCP
  admin tool, the file watcher and git hooks; the four copies had drifted.
  Patterns are now extracted after markdown, so the first ingest and later ones
  produce the same catalogue.
- One emit-gate runner (`src/emit-gate/run.js`) for the CLI and the MCP tool;
  both accept `{ files: [...] }` or a bare array, with `proposed_code` or
  `content`, and both merge manifest/subproject LSP settings.
- References to explicitly imported names resolve through the file's own
  imports (e.g. a call to `createParser` imported from `../parser/index.js`
  binds to that module, not to a re-export elsewhere). Files are processed in
  sorted order, so builds are deterministic and an incremental build matches a
  full rebuild.
- The watcher retries after 5 s (not every 500 ms) while another ingest holds
  the lock, and logs stack traces only with `ORACLE_DEBUG=true`.
- `oracle.context` keeps every result scoring at least 20% of the best match
  (exact symbol matches always), plus the callers of relevant code, instead of
  a fixed top 10-20: broad questions ("how does ingest work") now cover the
  whole feature. A symbol named verbatim in the task ranks first; question
  words ("how", "works", "where") no longer match code; L2 searches the
  meaningful words only. Ranking no longer scans all nodes per candidate.
- Trimmed answers keep their evidence pointers (up to `ORACLE_MAX_EVIDENCE`)
  instead of cutting them to 5; grounding parses each file once per request.
- `oracle.where_would` anchors on symbols the intent names, drops directories
  unrelated to the intent, never reuses an existing file name, returns the
  analog's line range, and states its reason truthfully (the named symbol
  lives there, or the directory's real file count, not the number of matches).
- `oracle.exists` ranks candidates with the L2 index (BM25 + vectors) and
  lexical coverage over symbol, path, signature and doc, instead of substring
  matching on symbol/path only.
- `oracle.where_would` / `oracle.context` name new files after the convention
  of the target directory (kebab/snake/Pascal/camel case) and drop words the
  directory already implies.
- `oracle.conventions_for` applies its topic filter strictly, returns matching
  example symbols and documented rules whose heading names the topic, and says
  so when nothing matches instead of returning an unrelated pattern.
- `oracle.conventions_for` accepts any topic: beyond the tuned ones (auth,
  errors, migrations, routing, state, validation) it searches symbols and
  documented rules by the topic's stem (e.g. `testing`, `logging`), and answers
  `found: false` instead of an evidence-less rejection when nothing matches.
- `oracle.validate` flags require() in ES-module packages (error), function
  names that break the codebase's casing, and eval()/new Function(); require()
  is detected anywhere, not only at line start.
- `CONVENTION.md` and `AGENTS.md` are harvested for conventions, alongside
  `CONVENTIONS.md`, `CLAUDE.md`, `CODING.md` and `STYLE.md`. Prose bullets are
  kept as `_rules` per section; previously only `key: value` bullets survived,
  which dropped most written conventions (error handling, logging, testing).
- Node's built-in test runner (`node --test` in the `test` script) is detected
  in the manifest and run by the emit gate for affected tests.
- Emit-gate test failures report the failing tests, their assertion messages
  and load-time errors (from TAP output) instead of the first 500 characters.
- A language server that can't start makes the gate skip typechecking with a
  note, after under a second, instead of failing after a 15 s timeout; LSP
  warnings are reported as warnings, not errors.
- Grammar-loading log lines are printed only with `ORACLE_DEBUG=true`.
- `@huggingface/transformers` is an optional dependency.
- The version is read from `package.json` everywhere.

### Fixed

- Laravel routes include their group prefixes and middleware (`Route::prefix()->middleware()->group()`, `Route::group([...])`, chained `->middleware()` / `->withoutMiddleware()` / `->name()`), and `Route::match` lists its verbs. Routes declared in different groups no longer collapse into the same symbol. Route patterns count auth middleware as authenticated.
- Evidence for routes (`GET /users/{id}`) and contract ids (`migration:<file>:<table>`) is verified by the name the source spells out, so `oracle.conventions_for` / `oracle.where_would` answers citing them are no longer rejected.

- `oracle.context` returned the test pattern with all its members (hundreds of thousands of tokens before truncation); it now picks the pattern whose members mostly live in test files and returns its summary.
- Every PHP method call was missing from the graph except calls on `$this`,
  so `consumers`/`impact` reported methods as unused. Dart had no call edges at
  all and recorded method ranges as the signature line only.
- PHP nullable and union types (`?Foo`, `Foo|null`) produced unresolvable type
  references; references to interfaces, traits and enums written as a class
  did not resolve.
- TS interface properties were recorded as methods.
- Upgrading an existing graph could fail with a UNIQUE constraint error when
  two same-named nodes in a file traded places.
- Symbol resolution no longer depends on file order or on how much of the
  graph is written yet, so incremental and full builds agree on ambiguous
  names.
- Content-scanning contract detectors capped an unsorted file list, scanning a
  different subset on each run; `globFiles` now returns sorted paths and the
  default `ORACLE_DETECTOR_MAX_FILES` is 10000.
- Truncated answers dropped whole lists (e.g. the consumer list); lists are now
  shortened and report `<field>_total`.

- Parser log line on stdout corrupted the MCP stdio transport.
- A build could fail permanently with `FOREIGN KEY constraint failed` when a
  symbol cached earlier in the same build was removed by a later file.
- The emit gate copied the project into its shadow workspace synchronously,
  blocking the server; child processes kept stdin open and could hang until
  their timeout.
- Remote embedding requests had only an idle timeout (also used by hybrid
  search inside MCP queries); they now have a 30 s total deadline.
- The event-bus detector created an `event:undefined` node from
  annotation-only matches; contract surfaces without lines got line 0
  (now 1-based start, end defaults to start).
- Evidence verification rejected every single-line citation (re-exports,
  env vars, doc lines), lowering confidence.
- Git-hook reindexing rebuilt the L2 index without loading it first, so every
  `git pull` re-embedded all nodes and discarded the previous vector
  generation; one locked subproject also aborted the remaining ones.
- Evidence citing a method (`Class.method`) or namespaced symbol was always
  marked unverified, because verification looked for the qualified name.
- Function and method patterns were merged, so a pattern could report more
  members than nodes of its kind (e.g. 217 of 152); pattern evidence cited the
  pattern name instead of its canonical symbol.
- The emit gate flagged any edit to a widely used file as breaking (it only
  counted affected nodes); it now compares the proposed code with the indexed
  exports and reports a break only when an exported symbol used by other files
  is removed, un-exported or changes signature.
- `oracle.impact` treated any word after add/drop/rename as a DB column (so
  "rename positiveInt" demanded a migration) and seeded from unrelated doc
  sections; tables/columns now need an explicit mention or a match in the
  indexed schema, exact identifiers win, and a path in the description narrows
  the seeds.
- `oracle.diff_since` returned repo-root-relative paths, so subprojects in a
  subdirectory matched no symbols; it now diffs relative to the subproject,
  includes untracked files, uses subproject-relative evidence paths and reports
  unknown refs / invalid scopes distinctly.
- The manifest merge let the existing file win for every key, so derived data
  (doc conventions, migration counts, entry points) froze at the first draft.
  Re-ingest now does a three-way merge against the previous draft
  (`manifest.drafted.yaml`): untouched values refresh, manual edits are kept.
- A lookup for a symbol that doesn't exist was reported as "answer rejected per
  grounding rules"; `locate`/`consumers` now return an explicit
  `found: false`, which grounding accepts (a negative claims nothing about the
  code) and which still triggers the cross-subproject re-route hint.
- `oracle.read_exact` answered with absolute paths; it now uses
  subproject-relative ones like every other tool.
- The emit gate globbed for affected tests synchronously and without escaping
  file names containing glob syntax.
- Ingest reported more edges than were written (repeated calls counted once
  per call site).
- An `fs.watch` error crashed the server.
- A long ingest could have its lock taken over by a second process after 10
  minutes.
- Missing indexes on edge endpoints and node parents caused full table scans.
- Any changed file triggered a full rebuild; files without an extractor or
  that failed to parse triggered a full rebuild on every run.
- L3 evidence parsing stopped at the first `]`, so every synthesis was rejected.
- Hybrid search threw `RangeError` on large indexes and fell back silently.
- `_` in symbol names acted as a SQL wildcard in suffix lookups.
- Watcher ignored every event for projects under a directory named `build`,
  `bin`, `target`, etc.
- Contracts and markdown writes were not atomic.
- `consumers`/`impact` returned duplicates and had no result cap; an invalid
  `ORACLE_MAX_DEPTH` disabled traversal.

### Security

- The auto-detected TypeScript language server ran as `npx typescript-language-server`,
  so an emit-gate run could download and execute a package from the npm registry.
  It is now `npx --no ...` (installed servers only; older saved configs are
  rewritten at run time) and is only configured when `tsconfig.json` or
  `jsconfig.json` exists.
- `ORACLE_ALLOWED_ROOTS` applies to query tools over HTTP, not only admin tools.
- `oracle.gate` (executes client-supplied code) requires a separate HTTP opt-in.
- Repository text reaches L3 as fenced, untrusted context; synthesis output is
  labelled untrusted.
- `read_exact` checks file size before reading and no longer echoes absolute
  paths in errors.
- `diff_since` uses literal pathspecs, so `scope` cannot escape the subproject.
- Dependency updates resolve all `npm audit` findings (previously 1 critical,
  8 high).

### Removed

- `CLAUDE.md`: merged into `AGENTS.md`, the single guide for coding agents.
- `scripts/serve-model.sh` and `npm run model:serve` (mlx/vllm); replaced by
  `oracle llm` (llama.cpp) or any OpenAI-compatible backend.
- `workspace install-hooks` / `uninstall-hooks` (duplicates of `hooks`).
- `npm run serve:sse` (use `serve:http`; `--transport sse` remains an alias).

## [0.1.0]

- Initial release.
