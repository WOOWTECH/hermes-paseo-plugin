import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {privateDirectory,atomicJson,RuntimeError,assertSafePath} from './state.mjs';
import {applyBrandIdentityPatch,brandIdentityPatchReady,BRAND_IDENTITY_PATCH_ID} from './brand-identity-patch.mjs';
export const PASEO_VERSION='0.17.4';
// Every earlier release (0.1.2 through 0.1.4-rc.9) ran Paseo 0.11.2.
export const LEGACY_PASEO_VERSION='0.11.2';
const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runtime');
const lock=fs.readFileSync(path.join(template,'package-lock.json'));
const lockSha256=createHash('sha256').update(lock).digest('hex');
export const RUNTIME_REVISION=PASEO_VERSION+'-r1-'+lockSha256.slice(0,12);
export const runtimeDirectory=loc=>path.join(loc.runtimeDir,'releases',RUNTIME_REVISION);
const RECEIPT='.hermes-paseo-runtime.json';
// Control compatibility only: these releases are never installed or started again. Frozen
// lockfiles of 0.1.4-rc.1 through rc.9 (r2, newest first) and of 0.1.2-0.1.3 (r1).
export const PRIOR_RELEASES=Object.freeze([
 {generation:'r2',lockSha256:'71709cd7872f99ead132636d960ffa34e9cfa2eff23e5e21a08eea38045c3bd4'},
 {generation:'r1',lockSha256:'55efbfec4437453358be3a5315ad374360ad0944e935c9fa4a5be2542d11d4eb'},
].map(release=>Object.freeze({...release,revision:LEGACY_PASEO_VERSION+'-'+release.generation+'-'+release.lockSha256.slice(0,12)})));
function readVersion(root,pkg) {
 const file=path.join(root,'node_modules/@getpaseo',pkg,'package.json');assertSafePath(file);
 return JSON.parse(fs.readFileSync(file,'utf8')).version;
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
  const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  if(receipt.revision!==release.revision||receipt.lockSha256!==release.lockSha256)return null;
  if(readVersion(root,'cli')!==LEGACY_PASEO_VERSION||readVersion(root,'server')!==LEGACY_PASEO_VERSION)return null;
  return root;
 } catch {return null;}
}
/**
 * After this release's daemon has started, older releases no daemon uses are removed, except
 * the newest 0.11.2 one (r2): a rollback to 0.1.4 reuses it instead of downloading it again.
 * Only exact known release directories are touched; links are never followed. Best effort.
 */
export function pruneUnusedPriorReleases(loc) {
 const removed=[];
 for(const release of PRIOR_RELEASES.slice(1)){
  const root=path.join(loc.runtimeDir,'releases',release.revision);
  try {
   if(!fs.lstatSync(root).isDirectory()||!priorRuntimeDirectory(loc,release.revision))continue;
   fs.rmSync(root,{recursive:true,force:true});removed.push(release.revision);
  } catch { /* Absent, foreign or not removable now. */ }
 }
 return removed;
}
export function runtimeReady(loc) {
 try {
  const root=runtimeDirectory(loc),receiptFile=path.join(root,RECEIPT);
  assertSafePath(receiptFile);
  const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  return receipt.lockSha256===lockSha256&&receipt.revision===RUNTIME_REVISION&&receipt.brandIdentityPatchId===BRAND_IDENTITY_PATCH_ID&&
   brandIdentityPatchReady(root)&&readVersion(root,'cli')===PASEO_VERSION&&readVersion(root,'server')===PASEO_VERSION;
 } catch {return false;}
}
export function prepareRuntimeManifest(loc) {
 const root=runtimeDirectory(loc);privateDirectory(root);
 const file=path.join(root,'package.json');assertSafePath(file);
 if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).name!=='hermes-paseo-managed-runtime')throw new RuntimeError('RUNTIME_NOT_OWNED');
 for(const name of ['package.json','package-lock.json']) {
  assertSafePath(path.join(root,name));fs.copyFileSync(path.join(template,name),path.join(root,name));
 }
 return root;
}
export function markRuntimeReady(loc) {
 const root=runtimeDirectory(loc);applyBrandIdentityPatch(root);
 atomicJson(path.join(root,RECEIPT),{lockSha256,revision:RUNTIME_REVISION,brandIdentityPatchId:BRAND_IDENTITY_PATCH_ID});
}
