import { Command } from 'commander';
import path from 'path';
import { scanWorkspace } from '../../scanner/index.js';
import { saveWorkspace, loadWorkspace, listWorkspaces } from '../../scanner/workspace.js';

export function workspaceCommand() {
  const cmd = new Command('workspace');
  cmd.description('Manage workspaces');

  cmd
    .command('add <path>')
    .description('Add a workspace by scanning a directory for subprojects')
    .action(async (dirPath) => {
      const root = path.resolve(dirPath);
      console.log(`Scanning ${root} ...`);
      const workspace = await scanWorkspace(root);
      saveWorkspace(workspace);
      console.log(`Workspace '${workspace.id}' saved with ${workspace.subprojects.length} subproject(s):`);
      for (const sp of workspace.subprojects) {
        console.log(`  ${sp.id} — ${sp.framework || sp.language} (${sp.buildManifest})`);
      }
    });

  cmd
    .command('scan <workspace_id>')
    .description('Re-scan an existing workspace to detect changes')
    .action(async (workspaceId) => {
      const existing = loadWorkspace(workspaceId);
      if (!existing) {
        console.error(`Workspace '${workspaceId}' not found.`);
        process.exit(1);
      }
      const workspace = await scanWorkspace(existing.root);
      workspace.id = workspaceId;
      saveWorkspace(workspace);
      console.log(`Workspace '${workspaceId}' re-scanned: ${workspace.subprojects.length} subproject(s).`);
    });

  cmd
    .command('list')
    .description('List all registered workspaces')
    .action(() => {
      const ids = listWorkspaces();
      if (ids.length === 0) {
        console.log('No workspaces registered. Use `oracle workspace add <path>` to add one.');
        return;
      }
      for (const id of ids) {
        const ws = loadWorkspace(id);
        const count = ws ? ws.subprojects.length : '?';
        const root = ws ? ws.root : 'unknown';
        console.log(`  ${id} — ${count} subproject(s) — ${root}`);
      }
    });

  cmd
    .command('install-hooks <workspace_id>')
    .description('Install git post-merge/post-checkout hooks for auto-reindex')
    .action(async (workspaceId) => {
      const { installHooks } = await import('../../hooks/index.js');
      await installHooks(workspaceId);
      console.log('Hooks installed.');
    });

  cmd
    .command('uninstall-hooks <workspace_id>')
    .description('Uninstall git hooks installed by oracle')
    .action(async (workspaceId) => {
      const { uninstallHooks } = await import('../../hooks/index.js');
      await uninstallHooks(workspaceId);
      console.log('Hooks uninstalled.');
    });

  return cmd;
}
