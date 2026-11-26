import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateDirectory,atomicJson,RuntimeError,assertSafePath} from './state.mjs';
import {applyBrandIdentityPatch} from './brand-identity-patch.mjs';
import {hostCapacity} from './host-capacity.mjs';
import {runtimeInUse} from './runtime-processes.mjs';
export const PASEO_VERSION='0.11.2';
// Every earlier release (0.1.2 through 0.1.4-rc.9) ran Paseo 0.11.2.
export const LEGACY_PASEO_VERSION='0.11.2';
const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const lock=fs.readFileSync(path.join(template,'package-lock.json'));
const lockSha256=createHash('sha256').update(lock).digest('hex');
export const RUNTIME_REVISION=PASEO_VERSION+'-r3-'+lockSha256.slice(0,12);
export const runtimeDirectory=loc=>path.join(loc.runtimeDir,'releases',RUNTIME_REVISION);
const RECEIPT='.hermes-paseo-runtime.json';
const MANAGED_NAME='hermes-paseo-managed-runtime';
// Control compatibility only: these releases are never installed or started again. Frozen
// lockfiles of 0.1.4-rc.1 through rc.9 (r2, newest first) and of 0.1.2-0.1.3 (r1).
export const PRIOR_RELEASES=Object.freeze([
 {generation:'r2',lockSha256:'71709cd7872f99ead132636d960ffa34e9cfa2eff23e5e21a08eea38045c3bd4'},
 {generation:'r1',lockSha256:'55efbfec4437453358be3a5315ad374360ad0944e935c9fa4a5be2542d11d4eb'},
].map(release=>Object.freeze({...release,revision:LEGACY_PASEO_VERSION+'-'+release.generation+'-'+release.lockSha256.slice(0,12)})));
// Reject links and special files without blocking (e.g. a receipt replaced with a FIFO).
function readJson(file) {
 assertSafePath(file);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);
 try {
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||stat.size>1048576)throw new RuntimeError('RUNTIME_NOT_OWNED');
  return JSON.parse(fs.readFileSync(fd,'utf8'));
 } finally {fs.closeSync(fd);}
}
function readVersion(root,pkg) {
 const file=path.join(root,'node_modules/@getpaseo',pkg,'package.json');assertSafePath(file);
 return readJson(file).version;
}
/**
 * The installed earlier release named exactly by `revision`, which can still control the 0.11.2
 * daemon it started. Any other revision, including an unrecorded or a newer one, gets none:
 * 0.11.2 modules never control a daemon they did not start.
 */
export function priorRuntimeDirectory(loc,revision) {
 const release=PRIOR_RELEASES.find(row=>row.revision===revision);
 if(!release)return null;
 const root=path.join(loc.runtimeDir,'releases',release.revision);
 try {
  const receiptFile=path.join(root,RECEIPT);assertSafePath(receiptFile);
  const receipt=readJson(receiptFile);
  if(receipt.revision!==release.revision||receipt.lockSha256!==release.lockSha256||readJson(path.join(root,'package.json')).name!==MANAGED_NAME)return null;
  if(readVersion(root,'cli')!==LEGACY_PASEO_VERSION||readVersion(root,'server')!==LEGACY_PASEO_VERSION)return null;
  return root;
 } catch {return null;}
}
/** Called under the runtime lock only after the new daemon is reachable. Keep r2 for rollback,
 * even on low disk: lack of space is reported before installation, never solved by deleting it.
 * Exact receipts, ownership and a complete process scan gate deletion; unknown/future paths stay. */
export function pruneUnusedPriorReleases(loc) {
 const removed=[];
 for(const release of PRIOR_RELEASES.slice(1)) {
  const root=priorRuntimeDirectory(loc,release.revision);
  if(!root||runtimeInUse(root,release.revision))continue;
  try { discardOwnedDirectory(root);removed.push(release.revision); } catch { /* best effort */ }
 }
 return removed;
}
function discardOwnedDirectory(root) {
 const info=assertSafePath(root);
 if(!info?.isDirectory()||info.uid!==process.getuid?.())throw new RuntimeError('RUNTIME_NOT_OWNED');
 // rm removes child links themselves; assertSafePath prevents redirected parents/roots.
 fs.rmSync(root,{recursive:true,force:true});
}
/**
 * Removes this release's directory when it is not a complete install (no matching receipt, or a
 * failed attempt): it is never reused, and a fresh install starts from nothing. Only a real
 * directory that is empty or carries this plugin's runtime manifest is removed; a link, a foreign
 * directory or anything under a linked parent is refused. Returns whether something was removed.
 */
export function discardPartialRuntime(loc) {
 const root=runtimeDirectory(loc);
 let info;
 try { info=fs.lstatSync(root); } catch(error) { if(error.code==='ENOENT')return false; throw error; }
 assertSafePath(root);
 if(!info.isDirectory()||info.uid!==process.getuid?.())throw new RuntimeError('RUNTIME_NOT_OWNED');
 const manifest=path.join(root,'package.json');
 let ours=false;
 try { ours=readJson(manifest).name===MANAGED_NAME; } catch { /* absent or unreadable */ }
 if(!ours&&fs.readdirSync(root).length)throw new RuntimeError('RUNTIME_NOT_OWNED');
 if(runtimeInUse(root,RUNTIME_REVISION))throw new RuntimeError('RUNTIME_IN_USE');
 discardOwnedDirectory(root);
 return true;
}
/**
 * npm installs both the glibc and the musl builds of the Claude SDK's native binary (the lockfile
 * does not tell them apart), about 340 MB of musl that a glibc host never runs. They are removed after
 * the install; nothing else, and no receipt, depends on them. A host that is not glibc keeps everything.
 */
export function removeUnusedLibcVariants(root,{glibc=hostCapacity.glibc()}={}) {
 const removed=[];
 if(!glibc)return removed;
 const scope=path.join(root,'node_modules/@anthropic-ai');
 let names;
 try { assertSafePath(scope);names=fs.readdirSync(scope); } catch { return removed; }
 for(const name of names) {
  if(!/^claude-agent-sdk-.+-musl$/.test(name))continue;
  const directory=path.join(scope,name);
  try {
   if(!fs.lstatSync(directory).isDirectory())continue;
   fs.rmSync(directory,{recursive:true,force:true});removed.push(name);
  } catch { /* The next release install removes what is left. */ }
 }
 return removed;
}
export function runtimeReady(loc) {
 try {
  const root=runtimeDirectory(loc),receiptFile=path.join(root,RECEIPT);
  assertSafePath(receiptFile);
  const receipt=readJson(receiptFile);
  return receipt.lockSha256===lockSha256&&receipt.revision===RUNTIME_REVISION&&readVersion(root,'cli')===PASEO_VERSION&&readVersion(root,'server')===PASEO_VERSION;
 } catch {return false;}
}
export function prepareRuntimeManifest(loc) {
 const root=runtimeDirectory(loc);privateDirectory(root);
 const file=path.join(root,'package.json');assertSafePath(file);
 if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).name!==MANAGED_NAME)throw new RuntimeError('RUNTIME_NOT_OWNED');
 for(const name of ['package.json','package-lock.json']) {
  assertSafePath(path.join(root,name));fs.copyFileSync(path.join(template,name),path.join(root,name));
 }
 return root;
}
export function markRuntimeReady(loc) {
 const root=runtimeDirectory(loc);
 atomicJson(path.join(root,RECEIPT),{lockSha256,revision:RUNTIME_REVISION});
}

// Smart branding is applied only by activate for an explicitly saved Smart target.
export function patchInstalledRuntime(loc) {applyBrandIdentityPatch(runtimeDirectory(loc));}
