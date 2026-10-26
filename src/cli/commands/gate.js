import { Command } from 'commander';
import { readJsonFile, requireGraph, requireSubproject } from '../resolve.js';
import { GraphStore } from '../../graph/store.js';
import { createParser } from '../../parser/index.js';
import { runEmitGate } from '../../emit-gate/run.js';

export function gateCommand() {
  const cmd = new Command('gate');
  cmd
    .description('Run the emit gate on a proposed diff')
    .argument('<workspace_id>', 'Workspace ID')
    .argument('<subproject_id>', 'Subproject ID')
    .requiredOption('--diff <path>', 'Path to a JSON diff: { "files": [{ "path", "proposed_code" | "content" }] } or a bare array')
    .action(async (workspaceId, subprojectId, opts) => {
      const { subproject } = requireSubproject(workspaceId, subprojectId);
      const diff = readJsonFile(opts.diff, 'diff file');
      const { dir, dbPath } = requireGraph(workspaceId, subprojectId);

      const store = new GraphStore(dbPath);
      let result;
      try {
        result = await runEmitGate({ subproject, dir, store, parser: createParser(), diff });
      } finally {
        store.close();
      }

      console.log(JSON.stringify(result, null, 2));
      // exitCode, not exit(): let the JSON above flush when stdout is a pipe.
      if (!result.committable) process.exitCode = 1;
    });

  return cmd;
}
