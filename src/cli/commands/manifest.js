import { Command } from 'commander';
import path from 'path';
import { spawn } from 'child_process';
import { getSubprojectDir } from '../../scanner/workspace.js';
import { requireSubproject } from '../resolve.js';
import { ManifestDrafter } from '../../manifest/index.js';

export function manifestCommand() {
  const cmd = new Command('manifest');
  cmd.description('Manage project manifests');

  cmd
    .command('show <workspace_id> <subproject_id>')
    .description('Show the manifest for a subproject')
    .action((workspaceId, subprojectId) => {
      requireSubproject(workspaceId, subprojectId);
      const dir = getSubprojectDir(workspaceId, subprojectId);
      const drafter = new ManifestDrafter();
      const manifest = drafter.load(path.join(dir, 'manifest.yaml'));
      if (!manifest) throw new Error(`No manifest for '${workspaceId}/${subprojectId}'. Run \`oracle ingest ${workspaceId}\` first.`);
      console.log(JSON.stringify(manifest, null, 2));
    });

  cmd
    .command('draft <workspace_id> <subproject_id>')
    .description('Re-draft the manifest from code analysis (discards manual edits)')
    .action(async (workspaceId, subprojectId) => {
      const { subproject: sp } = requireSubproject(workspaceId, subprojectId);

      const dir = getSubprojectDir(workspaceId, subprojectId);
      const drafter = new ManifestDrafter();
      const manifest = await drafter.draft(sp);
      await drafter.save(manifest, path.join(dir, 'manifest.yaml'));
      // Keep the merge baseline in sync (see runIngestPipeline).
      await drafter.save(manifest, path.join(dir, 'manifest.drafted.yaml'));
      console.log('Manifest drafted and saved.');
      console.log(JSON.stringify(manifest, null, 2));
    });

  cmd
    .command('path <workspace_id> <subproject_id>')
    .description('Print the path to the manifest file')
    .action((workspaceId, subprojectId) => {
      requireSubproject(workspaceId, subprojectId);
      const dir = getSubprojectDir(workspaceId, subprojectId);
      console.log(path.join(dir, 'manifest.yaml'));
    });

  cmd
    .command('edit <workspace_id> <subproject_id>')
    .description('Open the manifest in $EDITOR (falls back to printing the path)')
    .action(async (workspaceId, subprojectId) => {
      requireSubproject(workspaceId, subprojectId);
      const dir = getSubprojectDir(workspaceId, subprojectId);
      const manifestPath = path.join(dir, 'manifest.yaml');

      const editor = process.env.EDITOR || process.env.VISUAL;
      if (editor) {
        // shell: true so EDITOR values with arguments (e.g. "code --wait") work.
        const quotedPath = `'${manifestPath.replace(/'/g, `'\\''`)}'`;
        const child = spawn(`${editor} ${quotedPath}`, { stdio: 'inherit', shell: true });
        await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('exit', (code) => {
            if (code) process.exitCode = code;
            resolve();
          });
        });
      } else {
        console.log(manifestPath);
        console.error('Set $EDITOR to open the file automatically.');
      }
    });

  return cmd;
}
