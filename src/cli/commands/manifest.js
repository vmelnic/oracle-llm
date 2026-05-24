import { Command } from 'commander';
import path from 'path';
import { spawn } from 'child_process';
import { loadWorkspace, getSubprojectDir } from '../../scanner/workspace.js';
import { ManifestDrafter } from '../../manifest/index.js';

export function manifestCommand() {
  const cmd = new Command('manifest');
  cmd.description('Manage project manifests');

  cmd
    .command('show <workspace_id> <subproject_id>')
    .description('Show the manifest for a subproject')
    .action((workspaceId, subprojectId) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) { console.error('Workspace not found.'); process.exit(1); }

      const dir = getSubprojectDir(workspaceId, subprojectId);
      const drafter = new ManifestDrafter();
      const manifest = drafter.load(path.join(dir, 'manifest.yaml'));
      if (!manifest) {
        console.error('No manifest found. Run `oracle ingest` first.');
        process.exit(1);
      }
      console.log(JSON.stringify(manifest, null, 2));
    });

  cmd
    .command('draft <workspace_id> <subproject_id>')
    .description('Re-draft the manifest from code analysis')
    .action(async (workspaceId, subprojectId) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) { console.error('Workspace not found.'); process.exit(1); }

      const sp = workspace.subprojects.find(s => s.id === subprojectId);
      if (!sp) { console.error('Subproject not found.'); process.exit(1); }

      const dir = getSubprojectDir(workspaceId, subprojectId);
      const drafter = new ManifestDrafter();
      const manifest = await drafter.draft(sp);
      await drafter.save(manifest, path.join(dir, 'manifest.yaml'));
      console.log('Manifest drafted and saved.');
      console.log(JSON.stringify(manifest, null, 2));
    });

  cmd
    .command('path <workspace_id> <subproject_id>')
    .description('Print the path to the manifest file')
    .action((workspaceId, subprojectId) => {
      const dir = getSubprojectDir(workspaceId, subprojectId);
      console.log(path.join(dir, 'manifest.yaml'));
    });

  cmd
    .command('edit <workspace_id> <subproject_id>')
    .description('Open the manifest in $EDITOR (falls back to printing the path)')
    .action((workspaceId, subprojectId) => {
      const workspace = loadWorkspace(workspaceId);
      if (!workspace) { console.error('Workspace not found.'); process.exit(1); }

      const dir = getSubprojectDir(workspaceId, subprojectId);
      const manifestPath = path.join(dir, 'manifest.yaml');

      const editor = process.env.EDITOR || process.env.VISUAL;
      if (editor) {
        const child = spawn(editor, [manifestPath], { stdio: 'inherit' });
        child.on('exit', (code) => {
          process.exit(code ?? 0);
        });
      } else {
        console.log(manifestPath);
        console.error('Set $EDITOR to open the file automatically.');
      }
    });

  return cmd;
}
