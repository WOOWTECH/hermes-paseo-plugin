import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafePath, RuntimeError } from './state.mjs';

export const CONFIG_BACKUP_NAME = 'config.json.pre-agent-connect';

// Where a hard link cannot be made the backup is placed with a rename after a last look instead (some network and FUSE file systems).
const NO_LINKS = new Set(['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK']);

/**
 * The daemon's config.json is the operator's until a target is saved. Before the plugin first rewrites it for a
 * saved target, one copy is kept beside it as config.json.pre-agent-connect (mode 0600) so the operator can go back.
 *
 * Never overwrites: an existing backup, of any kind, is left as it is, and the copy is put in place with link(), which
 * fails instead of replacing, so even one that appears between the check and the write survives. Never goes through a
 * link: a link anywhere on the path, or a config.json that is not a regular file, is refused, and nothing is read that
 * could block (a FIFO). Returns whether a copy was made (false: there was no config.json yet, or a backup already
 * exists). The caller holds the runtime lock.
 */
export function backupDaemonConfig(paseoHome) {
  const file = path.join(paseoHome, 'config.json'), backup = path.join(paseoHome, CONFIG_BACKUP_NAME);
  assertSafePath(file); assertSafePath(backup);
  if (fs.existsSync(backup)) return false;
  let source;
  try { source = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    if (error.code === 'ELOOP') throw new RuntimeError('UNSAFE_SYMLINK');
    throw new RuntimeError('CONFIG_BACKUP_FAILED');
  }
  let bytes;
  try {
    if (!fs.fstatSync(source).isFile()) throw new RuntimeError('CONFIG_CORRUPT');
    bytes = fs.readFileSync(source);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('CONFIG_BACKUP_FAILED');
  } finally { fs.closeSync(source); }
  // Written whole under a temporary name first: a crash leaves no half-written backup that would then be kept for good.
  const temp = path.join(paseoHome, `.${CONFIG_BACKUP_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, backup); }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      if (!NO_LINKS.has(error.code)) throw error;
      if (fs.existsSync(backup)) return false;
      fs.renameSync(temp, backup);
    }
    return true;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('CONFIG_BACKUP_FAILED');
  } finally { try { fs.unlinkSync(temp); } catch { /* renamed away, or never created */ } }
}
