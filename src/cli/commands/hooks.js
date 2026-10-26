import { Command } from 'commander';
import { installHooks, uninstallHooks, runReindex } from '../../hooks/index.js';

export function hooksCommand() {
  const cmd = new Command('hooks');

  cmd
    .description('Manage git hooks for automatic re-indexing on push/pull')
    .addCommand(
      new Command('install')
        .description('Install post-merge and post-checkout hooks for a workspace')
        .argument('<workspace_id>', 'Workspace ID')
        .action(async (workspaceId) => {
          const result = installHooks(workspaceId);
          console.log(`Installed oracle re-index hooks: ${result.installed.join(', ')}`);
        })
    )
    .addCommand(
      new Command('uninstall')
        .description('Remove oracle re-index hooks for a workspace')
        .argument('<workspace_id>', 'Workspace ID')
        .action(async (workspaceId) => {
          const result = uninstallHooks(workspaceId);
          if (result.removed.length > 0) {
            console.log(`Removed hooks: ${result.removed.join(', ')}`);
          } else {
            console.log('No oracle hooks found to remove.');
          }
        })
    )
    .addCommand(
      new Command('reindex')
        .description('Run incremental re-index for all subprojects in a workspace')
        .argument('<workspace_id>', 'Workspace ID')
        .action(async (workspaceId) => {
          const result = await runReindex(workspaceId);
          console.log(`Re-indexed: ${result.totalFiles} files, ${result.totalNodes} nodes, ${result.totalEdges} edges`);
        })
    );

  return cmd;
}
