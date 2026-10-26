import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const rawHome = process.env.ORACLE_HOME || path.join(os.homedir(), '.oracle');
const ORACLE_HOME = rawHome.startsWith('~') ? path.join(os.homedir(), rawHome.slice(1)) : rawHome;
const WORKSPACES_DIR = path.join(ORACLE_HOME, 'workspaces');

/** Root of all oracle data (ORACLE_HOME, default ~/.oracle; `~` expanded). */
export function getOracleHome() {
  return ORACLE_HOME;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dirPath, 0o700); } catch {}
}

export function getOracleDir(workspaceId) {
  assertWorkspaceId(workspaceId);
  return resolveWithin(WORKSPACES_DIR, workspaceId);
}

export function getSubprojectDir(workspaceId, subprojectId) {
  const workspaceDir = getOracleDir(workspaceId);
  assertSubprojectId(subprojectId);
  return resolveWithin(path.join(workspaceDir, 'subprojects'), subprojectId);
}

export function saveWorkspace(workspace) {
  assertWorkspaceId(workspace?.id);
  const initialPath = path.join(getOracleDir(workspace.id), 'workspace.json');
  if (fs.existsSync(initialPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(initialPath, 'utf-8'));
      if (existing.root && workspace.root && path.resolve(existing.root) !== path.resolve(workspace.root)) {
        const suffix = createHash('sha256').update(path.resolve(workspace.root)).digest('hex').slice(0, 8);
        workspace.id = `${workspace.id}-${suffix}`;
      }
    } catch (err) {
      throw new Error(`Refusing to overwrite unreadable workspace metadata: ${err.message}`, { cause: err });
    }
  }
  const dir = getOracleDir(workspace.id);
  ensureDir(dir);
  const filePath = path.join(dir, 'workspace.json');
  const tempPath = path.join(dir, `.workspace-${process.pid}-${randomUUID()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(workspace, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

export function loadWorkspace(workspaceId) {
  let filePath;
  try { filePath = path.join(getOracleDir(workspaceId), 'workspace.json'); }
  catch { return null; }
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function assertWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(workspaceId)
      || workspaceId === '.' || workspaceId === '..') {
    throw new Error('Invalid workspace ID');
  }
}

function assertSubprojectId(subprojectId) {
  if (typeof subprojectId !== 'string' || !subprojectId || path.isAbsolute(subprojectId)) {
    throw new Error('Invalid subproject ID');
  }
  const segments = subprojectId.replace(/\\/g, '/').split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid subproject ID');
  }
}

function resolveWithin(base, child) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, child);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes oracle storage');
  return resolved;
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
