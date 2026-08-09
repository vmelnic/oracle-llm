import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export function markIngestState(dir, status, details = {}) {
  atomicWriteFileSync(path.join(dir, 'ingest_state.json'), JSON.stringify({
    status,
    updated_at: new Date().toISOString(),
    pid: process.pid,
    ...details,
  }, null, 2));
}

export function readIngestState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'ingest_state.json'), 'utf-8'));
  } catch {
    return null;
  }
}
