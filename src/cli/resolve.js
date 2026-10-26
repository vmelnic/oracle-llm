import fs from 'node:fs';
import path from 'node:path';
import { InvalidArgumentError } from 'commander';
import { loadWorkspace, getSubprojectDir } from '../scanner/workspace.js';

// Lookups shared by CLI commands. They throw; bin/oracle.js prints the
// message and sets a non-zero exit code.

export function requireWorkspace(workspaceId) {
  const workspace = loadWorkspace(workspaceId);
  if (!workspace) throw new Error(`Workspace '${workspaceId}' not found. Run \`oracle workspace list\`.`);
  return workspace;
}

export function requireSubproject(workspaceId, subprojectId) {
  const workspace = requireWorkspace(workspaceId);
  const subproject = workspace.subprojects.find(s => s.id === subprojectId);
  if (!subproject) {
    const known = workspace.subprojects.map(s => s.id).join(', ') || 'none';
    throw new Error(`Subproject '${subprojectId}' not found in workspace '${workspaceId}' (known: ${known}).`);
  }
  return { workspace, subproject };
}

/** Subproject data dir and graph path; throws if the graph was never built. */
export function requireGraph(workspaceId, subprojectId) {
  const dir = getSubprojectDir(workspaceId, subprojectId);
  const dbPath = path.join(dir, 'entity_graph.sqlite');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Entity graph not built for '${workspaceId}/${subprojectId}'. Run \`oracle ingest ${workspaceId}\` first.`);
  }
  return { dir, dbPath };
}

export function readJsonFile(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read ${label} '${filePath}': ${err.code === 'ENOENT' ? 'file not found' : err.message}`, { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${label} '${filePath}': ${err.message}`, { cause: err });
  }
}

/** Commander option parser for integers within [min, max]. */
export function intOption(min, max = Number.MAX_SAFE_INTEGER) {
  return (value) => {
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      throw new InvalidArgumentError(`expected an integer between ${min} and ${max}`);
    }
    return Number(value);
  };
}
