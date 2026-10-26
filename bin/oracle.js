#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

// Load .env relative to THIS script (the oracle project root), not the caller's
// cwd — so oracle works when spawned from any directory, e.g. as an MCP server.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });

// Import the CLI dynamically, AFTER env is loaded: some modules read process.env
// at import time (e.g. src/mcp/index.js, src/retrieval/bm25.js), so they must
// not be in the static import graph that runs before dotenv.config() above.
const { validateEnv } = await import('../src/utils/env.js');
const { errors, warnings } = validateEnv();
for (const warning of warnings) console.error(`oracle: warning: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`oracle: ${error}`);
  console.error('oracle: fix the settings above (see .env.example)');
  process.exit(1);
}

const { createCli } = await import('../src/cli/index.js');

try {
  await createCli().parseAsync(process.argv);
} catch (err) {
  // Expected failures (bad input, missing workspace, locked DB) print one line;
  // ORACLE_DEBUG=true adds the stack for bug reports.
  console.error(`oracle: ${err.message}`);
  if (process.env.ORACLE_DEBUG === 'true' && err.stack) console.error(err.stack);
  process.exitCode = 1;
}
