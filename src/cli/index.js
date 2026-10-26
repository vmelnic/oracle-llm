import { Command } from 'commander';
import { workspaceCommand } from './commands/workspace.js';
import { ingestCommand } from './commands/ingest.js';
import { manifestCommand } from './commands/manifest.js';
import { patternsCommand } from './commands/patterns.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';
import { gateCommand } from './commands/gate.js';
import { dbCommand } from './commands/db.js';
import { hooksCommand } from './commands/hooks.js';
import { benchmarkCommand } from './commands/benchmark.js';
import { llmCommand } from './commands/llm.js';
import { VERSION } from '../version.js';

export function createCli() {
  const program = new Command();

  program
    .name('oracle')
    .description('Layered grounded oracle — deterministic code intelligence via MCP')
    .version(VERSION);

  program.addCommand(workspaceCommand());
  program.addCommand(ingestCommand());
  program.addCommand(manifestCommand());
  program.addCommand(patternsCommand());
  program.addCommand(serveCommand());
  program.addCommand(statusCommand());
  program.addCommand(gateCommand());
  program.addCommand(dbCommand());
  program.addCommand(hooksCommand());
  program.addCommand(benchmarkCommand());
  program.addCommand(llmCommand());

  return program;
}
