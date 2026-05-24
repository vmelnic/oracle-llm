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

export function createCli() {
  const program = new Command();

  program
    .name('oracle')
    .description('Layered grounded oracle — deterministic code intelligence via MCP')
    .version('0.1.0');

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

  return program;
}
