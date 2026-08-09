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
const { createCli } = await import('../src/cli/index.js');

const cli = createCli();
cli.parse(process.argv);
