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
      // Heartbeat: a held lock keeps a fresh mtime, so other processes can
      // tell a live holder from one that crashed, even if its PID was reused.
      const heartbeat = setInterval(() => {
        const now = new Date();
        try { fs.futimesSync(fd, now, now); } catch {}
      }, Math.max(1000, Math.floor(staleMs / 5)));
      heartbeat.unref();
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try { fs.closeSync(fd); } catch {}
          try {
            if (fs.readFileSync(lockPath, 'utf-8') === token) fs.unlinkSync(lockPath);
          } catch {}
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const staleToken = attempt === 0 ? readStaleToken(lockPath, staleMs) : null;
      if (staleToken === null) {
        const locked = new Error(`Operation already in progress: ${lockPath}`);
        locked.code = 'ORACLE_LOCKED';
        throw locked;
      }
      // Only remove the lock if it is still the one we judged stale; another
      // process may have replaced it between the check and now.
      try {
        if (fs.readFileSync(lockPath, 'utf-8') === staleToken) fs.unlinkSync(lockPath);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  throw new Error(`Unable to acquire lock: ${lockPath}`);
}

// Returns the lock's contents if it is stale, otherwise null. Stale means the
// owner process is gone, or its heartbeat stopped for longer than `staleMs`
// (crashed holder whose PID now belongs to another process, e.g. PID 1 in a
// restarted container).
function readStaleToken(lockPath, staleMs) {
  let token;
  let mtimeMs;
  try {
    token = fs.readFileSync(lockPath, 'utf-8');
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    return err.code === 'ENOENT' ? '' : null;
  }
  if (Date.now() - mtimeMs > staleMs) return token;

  const pid = Number.parseInt(token.split(':')[0], 10);
  // Unknown owner (e.g. a lock still being written): trust the heartbeat window.
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return null;
  } catch (err) {
    return err.code === 'ESRCH' ? token : null;
  }
}
