import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { loadWorkspace, getSubprojectDir } from '../scanner/workspace.js';
import { createParser } from '../parser/index.js';
import { ingestSubproject } from '../ingest/pipeline.js';

const HOOK_NAME = 'llm-oracle-managed-hook';
const HOOK_START = `# BEGIN ${HOOK_NAME}`;
const HOOK_END = `# END ${HOOK_NAME}`;

export function installHooks(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const hooksDir = findHooksDir(workspace.root);
  if (!hooksDir) throw new Error('No git repository found at workspace root');
  fs.mkdirSync(hooksDir, { recursive: true });

  const hookTargets = ['post-merge', 'post-checkout'];
  const cliPath = path.resolve(process.argv[1] || 'oracle');
  // Detached so a full reindex never blocks `git pull`/`git checkout`; the
  // absolute node path keeps working when git runs without the user's PATH.
  const hookBlock = `${HOOK_START}
# Triggers incremental re-index after git pull/checkout (runs in background)
( ${shellQuote(process.execPath)} ${shellQuote(cliPath)} hooks reindex ${shellQuote(workspaceId)} >/dev/null 2>&1 & ) || true
${HOOK_END}
`;

  for (const target of hookTargets) {
    const hookPath = path.join(hooksDir, target);
    let existing = '';
    if (fs.existsSync(hookPath)) {
      existing = removeLegacyHook(removeManagedBlock(fs.readFileSync(hookPath, 'utf-8'))).trim();
      if (existing === '#!/bin/sh') existing = '';
    }

    const newContent = existing
      ? `${existing}\n\n${hookBlock}`
      : `#!/bin/sh\n${hookBlock}`;

    fs.writeFileSync(hookPath, newContent);
    fs.chmodSync(hookPath, 0o755);
  }

  return { installed: hookTargets, hooksDir };
}

export async function runReindex(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const parser = createParser();
  let totalFiles = 0;
  let totalNodes = 0;
  let totalEdges = 0;
  const failed = [];

  for (const subproject of workspace.subprojects) {
    // Hooks only refresh subprojects that were ingested at least once.
    if (!fs.existsSync(path.join(getSubprojectDir(workspaceId, subproject.id), 'entity_graph.sqlite'))) continue;
    try {
      const stats = await ingestSubproject({ workspaceId, subproject, parser });
      totalFiles += stats.graph.filesProcessed;
      totalNodes += stats.graph.nodesCreated;
      totalEdges += stats.graph.edgesCreated;
    } catch (err) {
      failed.push(`${subproject.id}: ${err.message}`);
    }
  }

  if (failed.length > 0) throw new Error(`Re-index failed for ${failed.join('; ')}`);
  return { totalFiles, totalNodes, totalEdges };
}

export function uninstallHooks(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

  const hooksDir = findHooksDir(workspace.root);
  if (!hooksDir) return { removed: [] };

  const removed = [];

  for (const target of ['post-merge', 'post-checkout']) {
    const hookPath = path.join(hooksDir, target);
    if (!fs.existsSync(hookPath)) continue;

    let content = fs.readFileSync(hookPath, 'utf-8');
    if (content.includes(HOOK_START) || content.includes('# Auto-installed by llm-oracle')) {
      const cleaned = removeLegacyHook(removeManagedBlock(content))
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

function removeManagedBlock(content) {
  const escapedStart = escapeRegExp(HOOK_START);
  const escapedEnd = escapeRegExp(HOOK_END);
  return content.replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g'), '');
}

function removeLegacyHook(content) {
  return content.replace(
    /# Auto-installed by llm-oracle\n# Triggers incremental re-index after git pull\/checkout\nnode [^\n]+ hooks reindex [^\n]+\n?/g,
    '',
  );
}

// Asks git where hooks live, so core.hooksPath, worktrees and submodules
// (where .git is a file) are all honoured.
function findHooksDir(root) {
  try {
    const hooksPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return hooksPath ? path.resolve(root, hooksPath) : null;
  } catch {
    return null;
  }
}
