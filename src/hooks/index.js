import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { loadWorkspace, listWorkspaces, getSubprojectDir } from '../scanner/workspace.js';
import { GraphStore } from '../graph/store.js';
import { buildGraph } from '../graph/builder.js';
import { createParser } from '../parser/index.js';
import { createContractRegistry } from '../contracts/index.js';
import { PatternCatalogue } from '../patterns/index.js';
import { L2Index } from '../retrieval/index.js';
import { ManifestDrafter } from '../manifest/index.js';
import { processMarkdownFiles } from '../markdown/index.js';
import { acquireFileLock } from '../utils/file-lock.js';
import { markIngestState } from '../ingest/state.js';

const HOOK_NAME = 'llm-oracle-managed-hook';
const HOOK_START = `# BEGIN ${HOOK_NAME}`;
const HOOK_END = `# END ${HOOK_NAME}`;

export function installHooks(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const gitDir = findGitDir(workspace.root);
  if (!gitDir) throw new Error('No .git directory found in workspace root');

  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookTargets = ['post-merge', 'post-checkout'];
  const cliPath = path.resolve(process.argv[1] || 'oracle');
  const hookBlock = `${HOOK_START}
# Triggers incremental re-index after git pull/checkout
node ${shellQuote(cliPath)} hooks reindex ${shellQuote(workspaceId)} 2>/dev/null || true
${HOOK_END}
`;

  for (const target of hookTargets) {
    const hookPath = path.join(hooksDir, target);
    let existing = '';
    if (fs.existsSync(hookPath)) {
      existing = fs.readFileSync(hookPath, 'utf-8');
      if (existing.includes(HOOK_START)) continue;
      existing = removeLegacyHook(existing);
    }

    const newContent = existing
      ? `${existing.trimEnd()}\n\n${hookBlock}`
      : `#!/bin/sh\n${hookBlock}`;

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

    const lock = acquireFileLock(path.join(dir, '.ingest.lock'));
    let store;
    try {
      markIngestState(dir, 'building');
      store = new GraphStore(dbPath);
      const graphStats = await buildGraph(sp, parser, store);
      totalFiles += graphStats.filesProcessed;
      totalNodes += graphStats.nodesCreated;
      totalEdges += graphStats.edgesCreated;

      const contracts = createContractRegistry(store);
      const surfacesPath = path.join(dir, 'contract_surfaces.json');
      const previousSurfaces = contracts.loadSurfacesJson(surfacesPath);
      const contractStats = await contracts.index(sp, { previousSurfaces });
      contracts.saveSurfacesJson(contractStats.surfaces, surfacesPath);

      processMarkdownFiles(sp, store);

      const patterns = new PatternCatalogue(store);
      patterns.extract(sp);
      const changedFiles = await getChangedFiles(sp.root);
      patterns.rerank(changedFiles);
      patterns.save(path.join(dir, 'pattern_catalog.json'));

      const l2 = new L2Index(store, { indexPath: path.join(dir, 'ast_embed_index') });
      await l2.build(sp.id);
      l2.save();

      const drafter = new ManifestDrafter();
      const manifestPath = path.join(dir, 'manifest.yaml');
      const existing = drafter.load(manifestPath);
      const drafted = await drafter.draft(sp);
      await drafter.save(existing ? drafter.merge(existing, drafted) : drafted, manifestPath);

      const storeStats = store.stats(sp.id);
      markIngestState(dir, 'ready', { nodes: storeStats.totalNodes, edges: storeStats.totalEdges });
    } catch (err) {
      markIngestState(dir, 'failed', { error: err.message });
      throw err;
    } finally {
      if (store) store.close();
      lock.release();
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
    if (content.includes(HOOK_START) || content.includes('# Auto-installed by llm-oracle')) {
      const escapedStart = escapeRegExp(HOOK_START);
      const escapedEnd = escapeRegExp(HOOK_END);
      const cleaned = removeLegacyHook(content.replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g'), ''))
        .replace(/\n{3,}/g, '\n\n').trim();
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeLegacyHook(content) {
  return content.replace(
    /# Auto-installed by llm-oracle\n# Triggers incremental re-index after git pull\/checkout\nnode [^\n]+ hooks reindex [^\n]+\n?/g,
    '',
  );
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
    const diff = execFileSync('git', ['diff', '--name-only', 'HEAD@{1}', 'HEAD', '--'], {
      cwd: root, encoding: 'utf-8', timeout: 10000,
    });
    return diff.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
