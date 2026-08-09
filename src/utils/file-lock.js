import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireFileLock(lockPath, { staleMs = 10 * 60_000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, token, 'utf-8');
      fs.fsyncSync(fd);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try { fs.closeSync(fd); } catch {}
          try {
            if (fs.readFileSync(lockPath, 'utf-8') === token) fs.unlinkSync(lockPath);
          } catch {}
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!isStale(lockPath, staleMs) || attempt > 0) {
        const locked = new Error(`Operation already in progress: ${lockPath}`);
        locked.code = 'ORACLE_LOCKED';
        throw locked;
      }
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error(`Unable to acquire lock: ${lockPath}`);
}

function isStale(lockPath, staleMs) {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) return true;
    const [pidText] = fs.readFileSync(lockPath, 'utf-8').split(':');
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return false; }
    catch (err) { return err.code === 'ESRCH'; }
  } catch {
    return true;
  }
}
