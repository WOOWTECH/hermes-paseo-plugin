import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafePath, RuntimeError } from './state.mjs';

// Frozen @getpaseo/server 0.17.4. The hello response is serialized as built, so the status
// envelope keeps extra fields; the Woowtech and Apporo Smart apps require this optional brand
// identity during hello and refuse a daemon without it. Same transformation as Agent Connect
// 0.1.24, with this plugin's own helper and environment variable. 0.11.2 releases are never
// patched: offline control of their daemons does not load this module.
export const ORIGINAL_BRAND_SERVER_SHA256 = 'bfc79901aa7768a51b98385b6f729dac69a1098f4480a66fd3d2be1d6af06b4b';
export const PATCHED_BRAND_SERVER_SHA256 = 'd6905a697049464facd8147e9447c5e6022bef82d94b5045941a576842fb7a07';
export const BRAND_SERVER_PATH = 'node_modules/@getpaseo/server/dist/server/server/websocket-server.js';
export const BRAND_HELPER_NAME = 'hermes-paseo-brand-identity.mjs';
const helper = fs.readFileSync(new URL('./brand-identity.mjs', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
export const BRAND_IDENTITY_PATCH_ID = sha(Buffer.concat([helper, Buffer.from(PATCHED_BRAND_SERVER_SHA256)]));

export function patchBrandIdentitySource(source) {
  if (sha(source) === PATCHED_BRAND_SERVER_SHA256) return source;
  if (sha(source) !== ORIGINAL_BRAND_SERVER_SHA256) throw new RuntimeError('BRAND_IDENTITY_SOURCE_MISMATCH');
  const result = `import {hermesPaseoBrand} from "./${BRAND_HELPER_NAME}";\n` + source.replace(
    '            status: "server_info",', '            status: "server_info",\n            brand: hermesPaseoBrand,');
  if (sha(result) !== PATCHED_BRAND_SERVER_SHA256) throw new RuntimeError('BRAND_IDENTITY_PATCH_MISMATCH');
  return result;
}

const files = root => {
  const server = path.join(root, BRAND_SERVER_PATH);
  return { server, helper: path.join(path.dirname(server), BRAND_HELPER_NAME) };
};

/** Patches an installed release in place. An unknown server source changes neither file. */
export function applyBrandIdentityPatch(root) {
  const { server, helper: target } = files(root);
  assertSafePath(server); assertSafePath(target);
  const before = fs.readFileSync(server, 'utf8'), after = patchBrandIdentitySource(before);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(helper)) fs.writeFileSync(target, helper, { mode: 0o644 });
  if (before !== after) fs.writeFileSync(server, after);
}

/** True only when the server bytes are the exact patched build and the helper is this release's. */
export function brandIdentityPatchReady(root) {
  try {
    const { server, helper: target } = files(root);
    assertSafePath(server); assertSafePath(target);
    return sha(fs.readFileSync(server)) === PATCHED_BRAND_SERVER_SHA256 && fs.readFileSync(target).equals(helper);
  } catch { return false; }
}
