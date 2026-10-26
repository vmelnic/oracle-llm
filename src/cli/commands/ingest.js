import { Command } from 'commander';
import { requireSubproject, requireWorkspace } from '../resolve.js';
import { createParser } from '../../parser/index.js';
import { describeIngest, ingestSubproject } from '../../ingest/pipeline.js';

export function ingestCommand() {
  const cmd = new Command('ingest');
  cmd
    .description('Build entity graph, patterns, manifest, and contracts for a subproject (or all)')
    .argument('<workspace_id>', 'Workspace ID')
    .argument('[subproject_id]', 'Optional subproject ID (ingests all if omitted)')
    .option('--embeddings', 'Enable semantic embeddings for L2 index')
    .option('--no-embeddings', 'Disable semantic embeddings')
    .action(async (workspaceId, subprojectId, opts) => {
      const workspace = requireWorkspace(workspaceId);
      const targets = subprojectId
        ? [requireSubproject(workspaceId, subprojectId).subproject]
        : workspace.subprojects;
      if (targets.length === 0) throw new Error(`Workspace '${workspaceId}' has no subprojects.`);

      const parser = createParser();
      console.log(`Parser loaded: ${parser.supportedLanguages().join(', ')}`);

      const failed = [];
      for (const subproject of targets) {
        console.log(`\nIngesting ${subproject.id} ...`);
        try {
          const stats = await ingestSubproject({ workspaceId, subproject, parser, embeddings: opts.embeddings });
          for (const line of describeIngest(stats)) console.log(`  ${line}`);
        } catch (err) {
          // ORACLE_LOCKED: another ingest owns this subproject; its state is left alone.
          console.error(`  ${err.code === 'ORACLE_LOCKED' ? 'SKIPPED' : 'ERROR'}: ${err.message}`);
          failed.push(subproject.id);
        }
      }

      if (failed.length > 0) throw new Error(`Failed subprojects: ${failed.join(', ')}`);
      console.log('\nDone.');
    });

  return cmd;
}
