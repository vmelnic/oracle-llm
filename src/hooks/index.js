import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { loadWorkspace, listWorkspaces, getSubprojectDir } from '../scanner/workspace.js';
import { GraphStore } from '../graph/store.js';
import { buildGraph } from '../graph/builder.js';
import { createParser } from '../parser/index.js';
import { createContractRegistry } from '../contracts/index.js';
import { PatternCatalogue } from '../patterns/index.js';
import { L2Index } from '../retrieval/index.js';

const HOOK_NAME = 'oracle-post-merge';

export function installHooks(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const gitDir = findGitDir(workspace.root);
  if (!gitDir) throw new Error('No .git directory found in workspace root');

  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookTargets = ['post-merge', 'post-checkout'];
  const cliPath = process.argv[1] || 'oracle';
  const hookScript = `#!/bin/sh
# Auto-installed by llm-oracle
# Triggers incremental re-index after git pull/checkout
node ${path.resolve(process.argv[1] || 'oracle')} hooks reindex ${workspaceId} 2>/dev/null || true
`;

  for (const target of hookTargets) {
    const hookPath = path.join(hooksDir, target);
    let existing = '';
    if (fs.existsSync(hookPath)) {
      existing = fs.readFileSync(hookPath, 'utf-8');
      if (existing.includes('oracle-post-merge')) continue;
    }

    const newContent = existing
      ? existing + '\n' + hookScript
      : hookScript;

    fs.writeFileSync(hookPath, newContent);
    fs.chmodSync(hookPath, 0o755);
  }

  return { installed: hookTargets, gitDir };
}

export async function runReindex(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const parser = createParser();
  let totalFiles = 0;
  let totalNodes = 0;
  let totalEdges = 0;

  for (const sp of workspace.subprojects) {
    const dir = getSubprojectDir(workspaceId, sp.id);
    const dbPath = path.join(dir, 'entity_graph.sqlite');
    if (!fs.existsSync(dbPath)) continue;

    const store = new GraphStore(dbPath);
    try {
      const graphStats = await buildGraph(sp, parser, store);
      totalFiles += graphStats.filesProcessed;
      totalNodes += graphStats.nodesCreated;
      totalEdges += graphStats.edgesCreated;

      if (graphStats.filesProcessed > 0) {
        const contracts = createContractRegistry(store);
        const contractStats = await contracts.index(sp);
        if (contractStats.surfaces.length > 0) {
          contracts.saveSurfacesJson(contractStats.surfaces, path.join(dir, 'contract_surfaces.json'));
        }

        const patterns = new PatternCatalogue(store);
        patterns.extract(sp);
        const changedFiles = await getChangedFiles(sp.root);
        patterns.rerank(changedFiles);
        patterns.save(path.join(dir, 'pattern_catalog.json'));

        const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index') });
        l2.build(sp.id);
        l2.save();
      }
    } finally {
      store.close();
    }
  }

  return { totalFiles, totalNodes, totalEdges };
}

export function uninstallHooks(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const gitDir = findGitDir(workspace.root);
  if (!gitDir) return { removed: [] };

  const hooksDir = path.join(gitDir, 'hooks');
  const removed = [];

  for (const target of ['post-merge', 'post-checkout']) {
    const hookPath = path.join(hooksDir, target);
    if (!fs.existsSync(hookPath)) continue;

    let content = fs.readFileSync(hookPath, 'utf-8');
    if (content.includes('oracle-post-merge')) {
      const lines = content.split('\n').filter(line =>
        !line.includes('oracle-post-merge') && !line.includes('hook:reindex')
      );
      const cleaned = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (cleaned && cleaned !== '#!/bin/sh') {
        fs.writeFileSync(hookPath, cleaned + '\n');
      } else {
        fs.unlinkSync(hookPath);
      }
      removed.push(target);
    }
  }

  return { removed };
}

function findGitDir(root) {
  const gitPath = path.join(root, '.git');
  if (!fs.existsSync(gitPath)) return null;

  if (fs.statSync(gitPath).isFile()) {
    const content = fs.readFileSync(gitPath, 'utf-8');
    const match = content.match(/gitdir:\s*(.+)/);
    if (match) return path.resolve(root, match[1].trim());
  }

  return gitPath;
}

async function getChangedFiles(root) {
  try {
    const diff = execSync('git diff --name-only HEAD@{1} HEAD', {
      cwd: root, encoding: 'utf-8', timeout: 10000,
    });
    return diff.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
