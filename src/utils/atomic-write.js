import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicWriteFileSync(targetPath, data, options = {}) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const mode = options.mode ?? 0o600;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, data, { encoding: options.encoding || 'utf-8' });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, targetPath);
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}
