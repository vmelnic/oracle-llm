# CONVENTION.md

Conventions for the llm-oracle codebase. Machine-readable reference for oracle meta-ingestion.

## Language & Runtime

- JavaScript ES modules (`"type": "module"`), no TypeScript, no build step
- Node.js >= 20.3
- Imports use `import`/`export`, never `require`/`module.exports`

## Naming

- **JS variables/functions:** camelCase
- **DB columns:** snake_case (`subproject_id`, `start_line`, `blob_hash`, `last_indexed_at`)
- **Files:** kebab-case (`weights-patch.js`, `diff-since.js`, `graph-stats.js`)
- **Classes:** PascalCase (`GraphStore`, `GroundingWrapper`, `PatternCatalogue`)
- **Constants:** UPPER_SNAKE or camelCase depending on scope (module-level sets/maps use UPPER_SNAKE)

## Semicolons

Mixed codebase. Follow the file you're editing.

## Module Patterns

### Extractors (`src/graph/extractors/*.js`)

Export a single `extract(tree, filePath, subprojectId)` function returning `{ nodes, edges }`.

### MCP tool handlers (`src/mcp/tools/*.js`)

Export a single function `handler(ctx, toolArgs)` returning `{ answer, evidence[], layer }`. Registered in `TOOL_DEFS` and `TOOL_HANDLERS` in `src/mcp/index.js`.

### Contract detectors (`src/contracts/detectors/*.js`)

Export a class with an `async detect(subproject)` method returning an array of node-like objects.

### Core classes

Export named classes (`export class GraphStore`, `export class GroundingWrapper`). No default exports.

## Error Handling

- Parsers, detectors, and file-system reads swallow errors silently (`try { ... } catch {}`). Intentional — the oracle must be resilient to malformed/missing files.
- Only validate at system boundaries (user input, external APIs). Internal code trusts framework guarantees.
- Environment variables are a boundary: `validateEnv` (`src/utils/env.js`) checks them at CLI startup; read numbers with `positiveInt`/`nonNegativeInt`.
- CLI commands throw `Error`s with user-facing messages; `bin/oracle.js` prints them and exits 1.

## Prompts

- Every text sent to a model is a template file: L3 prompts in `prompts/l3/*.txt` with Twig-style `{{placeholder}}` variables (rendered by `src/l3/prompts.js`; a missing value throws), MCP tool definitions in `prompts/mcp/tools.json`. No prompt text in JavaScript.

## Logging

- stdout is the MCP stdio channel. Outside `src/cli/` and `bin/`, log with `console.error` only (ESLint `no-console`).

## Database

- SQLite via `better-sqlite3`, WAL mode, foreign keys enabled
- Tables: `nodes`, `edges`, `file_hashes`, `unresolved_refs`, `schema_version`
- Schema changes go in a new migration in `src/graph/migrations.js` (plus the CREATE in `schema.sql` for fresh databases)
- Metadata stored as JSON strings; extractors pass plain objects, `GraphStore` serializes
- `UNIQUE` constraints enforce idempotent upserts

## Tree-sitter

- Extractors walk AST nodes manually with `node.child(i)` and `node.childForFieldName()`
- Vue files: extract `<script>` block content, parse as JS/TS (tree-sitter-vue grammar incompatible with tree-sitter 0.25)
- `node.isMissing` is a property, not a method

## MCP Response Shape

Every tool returns `{ answer, evidence[], confidence, layer }`. Evidence is verified against the filesystem by `GroundingWrapper` before return.

## Storage

All generated data under `ORACLE_HOME` (default `~/.oracle/`), scoped per workspace/subproject. The oracle never writes into source trees.

## Testing

- Node native test runner (`node --test`)
- Tests in `tests/`
- Mock `GraphStore` and filesystem state; no real workspaces in tests
