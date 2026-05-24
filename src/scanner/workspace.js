import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const rawHome = process.env.ORACLE_HOME || path.join(os.homedir(), '.oracle');
const ORACLE_HOME = rawHome.startsWith('~') ? path.join(os.homedir(), rawHome.slice(1)) : rawHome;
const WORKSPACES_DIR = path.join(ORACLE_HOME, 'workspaces');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function getOracleDir(workspaceId) {
  return path.join(WORKSPACES_DIR, workspaceId);
}

export function getSubprojectDir(workspaceId, subprojectId) {
  return path.join(WORKSPACES_DIR, workspaceId, 'subprojects', subprojectId);
}

export function saveWorkspace(workspace) {
  const dir = getOracleDir(workspace.id);
  ensureDir(dir);
  const filePath = path.join(dir, 'workspace.json');
  fs.writeFileSync(filePath, JSON.stringify(workspace, null, 2), 'utf-8');
  return filePath;
}

export function loadWorkspace(workspaceId) {
  const filePath = path.join(getOracleDir(workspaceId), 'workspace.json');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function listWorkspaces() {
  ensureDir(WORKSPACES_DIR);
  return fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true })
    .filter(entry => {
      if (!entry.isDirectory()) return false;
      const wsFile = path.join(WORKSPACES_DIR, entry.name, 'workspace.json');
      return fs.existsSync(wsFile);
    })
    .map(entry => entry.name);
}
