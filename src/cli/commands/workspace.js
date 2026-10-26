import { Command } from 'commander';
import path from 'path';
import { scanWorkspace } from '../../scanner/index.js';
import { saveWorkspace, loadWorkspace, listWorkspaces } from '../../scanner/workspace.js';
import { requireWorkspace } from '../resolve.js';

export function workspaceCommand() {
  const cmd = new Command('workspace');
  cmd.description('Manage workspaces');

  cmd
    .command('add <path>')
    .description('Add a workspace by scanning a directory for subprojects')
    .option('--only <ids>', 'Comma-separated subproject ids (paths relative to the root) to keep; re-scans keep the same selection')
    .action(async (dirPath, opts) => {
      const root = path.resolve(dirPath);
      console.log(`Scanning ${root} ...`);
      const workspace = await scanWorkspace(root, { only: opts.only });
      saveWorkspace(workspace);
      console.log(`Workspace '${workspace.id}' saved with ${workspace.subprojects.length} subproject(s):`);
      for (const sp of workspace.subprojects) {
        console.log(`  ${sp.id} — ${sp.framework || sp.language} (${sp.buildManifest})`);
      }
    });

  cmd
    .command('scan <workspace_id>')
    .description('Re-scan an existing workspace to detect changes')
    .option('--only <ids>', 'Replace the subproject selection (comma-separated ids; "" selects all)')
    .action(async (workspaceId, opts) => {
      const existing = requireWorkspace(workspaceId);
      const workspace = await scanWorkspace(existing.root, { only: opts.only ?? existing.only });
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

  return cmd;
}
