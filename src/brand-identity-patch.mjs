import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertSafePath, RuntimeError } from './state.mjs';

// Frozen @getpaseo/server 0.11.2. The hello response is serialized as built, so its status envelope keeps
// extra fields; the Woowtech and Apporo Smart apps require this optional brand identity and refuse a daemon
// without it. The same transformation as Agent Connect, with this plugin's own helper name, which is why
// the patched hash differs from that plugin's. The release itself is never replaced: an installed runtime
// is patched in place, once, and only with the exact original or the exact patched bytes in place.
export const ORIGINAL_BRAND_SERVER_SHA256 = 'ba8122d01dd17533231a573097ec4e9f91f4fd12caada107adb9f6706f5f8950';
export const PATCHED_BRAND_SERVER_SHA256 = '7c4d2a764e2971da9cdcbc8c93cc5f467f632b04d55e1a3a8334abad8cd9abaf';
export const BRAND_SERVER_PATH = 'node_modules/@getpaseo/server/dist/server/server/websocket-server.js';
export const BRAND_HELPER_NAME = 'hermes-paseo-brand-identity.mjs';
const SITE = '            status: "server_info",';
const helper = fs.readFileSync(new URL('./brand-identity.mjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');

/** The patched source of exactly the original, or the same source again when it is already patched. */
export function patchBrandIdentitySource(source) {
  if (sha(source) === PATCHED_BRAND_SERVER_SHA256) return source;
  if (sha(source) !== ORIGINAL_BRAND_SERVER_SHA256) throw new RuntimeError('BRAND_IDENTITY_SOURCE_MISMATCH');
  const result = `import {agentConnectBrand} from "./${BRAND_HELPER_NAME}";\n` +
    source.replace(SITE, () => `${SITE}\n            brand: agentConnectBrand,`);
  if (sha(result) !== PATCHED_BRAND_SERVER_SHA256) throw new RuntimeError('BRAND_IDENTITY_PATCH_MISMATCH');
  return result;
}

const files = root => {
  const server = path.join(root, BRAND_SERVER_PATH);
  return { server, helper: path.join(path.dirname(server), BRAND_HELPER_NAME) };
};
// Permission and read-only errors have a stable code of their own: the bridge would otherwise report the raw errno
// as OPERATION_FAILED and nothing could explain it to the person who has to fix the directory.
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS']);
// Reads a regular file without following a link at its last component. Opened non-blocking and judged by fstat, so a FIFO
// or device put at the path is refused instead of hanging the start while it holds the runtime lock.
function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new RuntimeError('BRAND_IDENTITY_SOURCE_MISMATCH');
    return { bytes: fs.readFileSync(fd), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if (error.code === 'ELOOP') throw new RuntimeError('UNSAFE_SYMLINK');
    if (DENIED.has(error.code)) throw new RuntimeError('RUNTIME_NOT_READABLE');
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Temporary file next to the target (O_EXCL, so an existing link of that name is refused), then a rename:
// a reader sees the old file or the new one, never a half-written one, and a link at the target is replaced
// as a name, never written through.
function replaceAtomically(file, bytes, mode) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } catch (error) {
    if (DENIED.has(error?.code)) throw new RuntimeError('RUNTIME_NOT_WRITABLE');
    throw error;
  } finally { try { fs.unlinkSync(temp); } catch { /* renamed away, or never created */ } }
}

/**
 * Patches an installed release in place. Caller holds the runtime lock and no daemon runs from `root`.
 * The helper is written first, because the patched server imports it; an unknown original, a tampered
 * patched file or a link anywhere on the path changes neither file. Both hashes are checked afterwards.
 */
export function applyBrandIdentityPatch(root) {
  const { server, helper: target } = files(root);
  assertSafePath(server); assertSafePath(target);
  const before = (() => { try { return readRegular(server); } catch (error) { if (error.code === 'ENOENT') throw new RuntimeError('BRAND_IDENTITY_SOURCE_MISMATCH'); throw error; } })();
  const current = sha(before.bytes);
  if (current !== ORIGINAL_BRAND_SERVER_SHA256 && current !== PATCHED_BRAND_SERVER_SHA256) throw new RuntimeError('BRAND_IDENTITY_SOURCE_MISMATCH');
  const installed = (() => { try { return readRegular(target).bytes; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } })();
  if (!installed || !installed.equals(helper)) replaceAtomically(target, helper, 0o644);
  if (current === ORIGINAL_BRAND_SERVER_SHA256) replaceAtomically(server, Buffer.from(patchBrandIdentitySource(before.bytes.toString('utf8'))), before.mode);
  if (!brandIdentityPatchReady(root)) {
    // Never leave a server that imports a helper it cannot trust.
    try { if (current === ORIGINAL_BRAND_SERVER_SHA256) replaceAtomically(server, before.bytes, before.mode); } catch { /* reported below */ }
    throw new RuntimeError('BRAND_IDENTITY_PATCH_MISMATCH');
  }
}

/** True only when the server bytes are the exact patched build and the helper is this release's. Never throws. */
export function brandIdentityPatchReady(root) {
  try {
    const { server, helper: target } = files(root);
    assertSafePath(server); assertSafePath(target);
    return sha(readRegular(server).bytes) === PATCHED_BRAND_SERVER_SHA256 && readRegular(target).bytes.equals(helper);
  } catch { return false; }
}
