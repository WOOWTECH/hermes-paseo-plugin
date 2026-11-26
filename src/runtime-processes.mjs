import fs from 'node:fs';
import path from 'node:path';
import {assertSafePath,RuntimeError,readState} from './state.mjs';
import {demonstrablyReusedPid,instanceFromPreviousContainer} from './daemon-identity.mjs';
const REVISION_ENTRY='HERMES_PASEO_RUNTIME_REVISION=';
/** A PID record may be momentarily blank while upstream updates its heartbeat. Fail closed
 * after bounded retries: an unreadable or unknown live daemon must never become a fresh start. */
export function readPidRecord(loc) {
 const file=path.join(loc.paseoHome,'paseo.pid');
 for(let attempt=0;attempt<10;attempt++) {
  try {
   const stat=assertSafePath(file);
   if(!stat)return null;
   if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.nlink!==1||stat.size>16384)throw new RuntimeError('DAEMON_NOT_OWNED');
   const value=JSON.parse(fs.readFileSync(file,'utf8'));
   if(Number.isInteger(value?.pid)&&value.pid>1)return value;
  } catch(error) {if(error.code==='ENOENT')return null;if(error instanceof RuntimeError)throw error;}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
 }
 throw new RuntimeError('DAEMON_NOT_OWNED');
}
export function daemonRevision(loc) {
 const lock=readPidRecord(loc);
 if(!lock||demonstrablyReusedPid(lock)||instanceFromPreviousContainer(lock,readState()))return null;
 try {process.kill(lock.pid,0);} catch(error) {if(error.code==='ESRCH')return null;throw new RuntimeError('DAEMON_NOT_OWNED');}
 if(process.platform==='linux') {
  try {
   const env=fs.readFileSync(`/proc/${lock.pid}/environ`,'utf8').split('\0');
   if(!env.includes(`PASEO_HOME=${loc.paseoHome}`))throw new Error();
   return env.find(entry=>entry.startsWith(REVISION_ENTRY))?.slice(REVISION_ENTRY.length)||'unrecorded';
  } catch {throw new RuntimeError('DAEMON_NOT_OWNED');}
 }
 const state=readState();
 return state.daemonPid===lock.pid&&state.daemonStartedAt===lock.startedAt?state.daemonRuntimeRevision||'unrecorded':'unrecorded';
}
/** Conservative deletion guard, including workers/other profiles using the same release.
 * Any inaccessible same-UID process metadata aborts cleanup. Never infer inactivity from a PID file alone.
 * Non-Linux hosts retain old/partial trees because there is no equivalent ownership evidence. */
export const runtimeProcessTable={root:'/proc',owner:base=>fs.statSync(base).uid};
export function runtimeInUse(root,revision,{procRoot=runtimeProcessTable.root,owner=runtimeProcessTable.owner}={}) {
 if(process.platform!=='linux')return true;
 const inside=value=>value===root||value.startsWith(root+path.sep);
 try {
  for(const pid of fs.readdirSync(procRoot).filter(name=>/^\d+$/.test(name))) {
   try {
    const base=path.join(procRoot,pid);
    // Managed releases are private to this UID. Other-UID supervisors (s6/root) are not ours.
    if(owner(base)!==process.getuid?.())continue;
    const stat=fs.readFileSync(path.join(base,'stat'),'utf8');
    if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='Z')continue;
    const args=fs.readFileSync(path.join(base,'cmdline'),'utf8').split('\0');
    const env=fs.readFileSync(path.join(base,'environ'),'utf8').split('\0');
    if(args.some(inside))return true;
    if(env.includes(REVISION_ENTRY+revision)) {
     const value=key=>env.find(entry=>entry.startsWith(key+'='))?.slice(key.length+1);
     const home=value('PASEO_HOME'),runtime=value('HERMES_PASEO_RUNTIME_DIR')||(home?path.join(path.dirname(home),'runtime'):null);
     if(!runtime||!path.isAbsolute(runtime)||path.resolve(runtime,'releases',revision)===root)return true;
    }
    if(inside(fs.readlinkSync(path.join(base,'cwd'))))return true;
   } catch(error) {if(!['ENOENT','ESRCH'].includes(error.code)) {
    if(process.env.HERMES_PASEO_DEBUG_PROC==='1')process.stderr.write('[DEBUG-proc-1126] '+JSON.stringify({pid,code:error.code,syscall:error.syscall,file:error.path})+'\n');
    return true;
   }}
  }
  return false;
 } catch {return true;}
}
