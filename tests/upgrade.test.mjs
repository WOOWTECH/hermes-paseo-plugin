import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {activate,prepare,status,deactivate,createChat} from '../src/runtime.mjs';
import {readState,processIdentity,locations} from '../src/state.mjs';
import {runtimeInUse,runtimeProcessTable} from '../src/runtime-processes.mjs';
import {PRIOR_RELEASES,RUNTIME_REVISION,runtimeDirectory,runtimeReady,priorRuntimeDirectory,pruneUnusedPriorReleases} from '../src/runtime-layout.mjs';
import {fixture,ownedHome,seedPriorRelease,seedCurrentRelease,fakeSupervisor,lifecycleModules,handled,fakeNpm} from './release-fixtures.mjs';
const R2=PRIOR_RELEASES[0].revision,R1=PRIOR_RELEASES[1].revision;

test('same-version rc9 daemon uses only r2 modules for status/chat/stop, before and after r3 preparation',async t=>{
 const f=fixture();t.after(()=>f.close());const loc=ownedHome();
 const modules=lifecycleModules('r2');
 modules['node_modules/@getpaseo/cli/dist/utils/client.js']=modules['node_modules/@getpaseo/cli/dist/utils/client.js'].replace('    close: async () => {},', `
    listProviderModels:async()=>({models:[{id:'test-model'}]}),
    getProvidersSnapshot:async()=>({entries:[{provider:'codex',modes:[]}]}),
    createWorkspace:async()=>({workspace:{id:'workspace'}}),createAgent:async()=>({id:'agent1234'}),
    waitForFinish:async()=>({status:'idle'}),fetchAgentTimeline:async()=>({entries:[{seqStart:1,item:{type:'assistant_message',text:'r2 chat reply'}}]}),
    close: async () => {},`);
 seedPriorRelease(loc,{modules});fakeNpm(f,{tree:{modules:lifecycleModules('r3')}});
 const {child}=await fakeSupervisor(f,loc.paseoHome,{HERMES_PASEO_RUNTIME_REVISION:R2});
 for(const prepared of [false,true]) {
  if(prepared)await prepare();
  const s=await status();assert.equal(s.installed,prepared);assert.equal(s.daemon.running,true);assert.equal(s.diagnosticCode,'RESTART_REQUIRED');
  const reply=await createChat({provider:'codex',message:'hello',cwd:f.dir});assert.equal(reply.reply,'r2 chat reply');
 }
 assert.ok(processIdentity(child.pid));assert.doesNotMatch(handled(loc,'read-by')+handled(loc,'client-by'),/r3/);
 await deactivate();assert.equal(handled(loc,'stopped-by'),'r2');
 assert.equal(fs.existsSync(path.join(loc.runtimeDir,'releases',R2)),true);
});

test('unknown, unrecorded and forged-receipt daemon revisions never fall back to installed r3 modules',async t=>{
 for(const revision of ['0.11.2-r99-unknown','unrecorded',R2]) {
  const f=fixture();try {
   const loc=ownedHome();seedCurrentRelease(loc,{modules:lifecycleModules('current')});
   if(revision===R2) {const {root}=seedPriorRelease(loc);fs.writeFileSync(path.join(root,'.hermes-paseo-runtime.json'),JSON.stringify({revision:R2,lockSha256:'0'.repeat(64)}));}
   const {child}=await fakeSupervisor(f,loc.paseoHome,{HERMES_PASEO_RUNTIME_REVISION:revision});
   assert.equal((await status()).diagnosticCode,'DAEMON_NOT_OWNED');
   await assert.rejects(deactivate(),{code:'DAEMON_NOT_OWNED'});await assert.rejects(activate(),{code:'DAEMON_NOT_OWNED'});
   assert.equal(readState().desiredEnabled,true);assert.ok(processIdentity(child.pid));assert.equal(handled(loc,'read-by'),'');assert.equal(handled(loc,'client-by'),'');
  } finally {f.close();}
 }
});

test('a matching process title and version cannot authorize a different supervisor revision',async t=>{
 const f=fixture();t.after(()=>f.close());const loc=ownedHome();
 seedCurrentRelease(loc,{modules:lifecycleModules('current')});seedPriorRelease(loc,{modules:lifecycleModules('prior')});
 const {child}=await fakeSupervisor(f,loc.paseoHome,{HERMES_PASEO_RUNTIME_REVISION:'0.11.2-r4-future'});
 await assert.rejects(createChat({provider:'codex',message:'hello',cwd:f.dir}),{code:'DAEMON_NOT_OWNED'});
 assert.ok(processIdentity(child.pid));
});

test('receipts, version files and release parents cannot be links; matching version alone is not ready',t=>{
 const f=fixture();t.after(()=>f.close());const loc=locations();const root=seedCurrentRelease(loc);
 const file=path.join(root,'.hermes-paseo-runtime.json'),bytes=fs.readFileSync(file);
 fs.writeFileSync(file,JSON.stringify({...JSON.parse(bytes),revision:R2}));assert.equal(runtimeReady(loc),false);
 fs.writeFileSync(file,bytes);const version=path.join(root,'node_modules/@getpaseo/server/package.json');const outside=path.join(f.dir,'version.json');fs.renameSync(version,outside);fs.symlinkSync(outside,version);assert.equal(runtimeReady(loc),false);
 const prior=seedPriorRelease(loc);const moved=path.join(f.dir,'prior');fs.renameSync(prior.root,moved);fs.symlinkSync(moved,prior.root);
 assert.equal(priorRuntimeDirectory(loc,R2),null);assert.deepEqual(pruneUnusedPriorReleases(loc),[]);assert.equal(fs.existsSync(moved),true);
});

test('pruning retains r2 and unknown/future/link directories; any same-UID user of r1 prevents deletion',async t=>{
 const f=fixture();t.after(()=>f.close());const loc=ownedHome();
 const r1=seedPriorRelease(loc,{generation:'r1'}),r2=seedPriorRelease(loc);
 const future=path.join(loc.runtimeDir,'releases','0.11.2-r4-future');fs.mkdirSync(future);
 const unknown=path.join(loc.runtimeDir,'releases','foreign');fs.mkdirSync(unknown);
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:r1.root,stdio:'ignore',env:{...process.env,HERMES_PASEO_RUNTIME_REVISION:R1}});f.children.push(child);
 assert.equal(runtimeInUse(r1.root,R1),true);assert.deepEqual(pruneUnusedPriorReleases(loc),[]);
 child.kill();await new Promise(resolve=>child.once('exit',resolve));
 assert.deepEqual(pruneUnusedPriorReleases(loc),[R1]);
 for(const root of [r2.root,future,unknown])assert.equal(fs.existsSync(root),true);
 // Owned known r1 name redirected to another directory is never touched.
 fs.symlinkSync(unknown,r1.root);assert.deepEqual(pruneUnusedPriorReleases(loc),[]);assert.equal(fs.existsSync(unknown),true);
});

function procFixture(f) {
 const proc=path.join(f.dir,'proc');fs.mkdirSync(proc);
 const put=(pid,name,bytes)=>{const dir=path.join(proc,String(pid));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name),bytes);};
 // A root/s6-like process has unreadable metadata (directories stand in for a read failure).
 fs.mkdirSync(path.join(proc,'10','environ'),{recursive:true});
 put(20,'stat','20 (node) S');put(20,'cmdline','node\0unrelated.js\0');put(20,'environ','');fs.symlinkSync(f.dir,path.join(proc,'20','cwd'));
 return {root:proc,owner:base=>path.basename(base)==='10'?process.getuid()+1:process.getuid(),put};
}

test('mixed-UID process table skips other users before reads; unreadable same-UID metadata fails closed',t=>{
 const f=fixture();t.after(()=>f.close());const proc=procFixture(f),root=runtimeDirectory(locations());
 assert.equal(runtimeInUse(root,RUNTIME_REVISION,{procRoot:proc.root,owner:proc.owner}),false);
 fs.rmSync(path.join(proc.root,'20','environ'));fs.mkdirSync(path.join(proc.root,'20','environ'));
 assert.equal(runtimeInUse(root,RUNTIME_REVISION,{procRoot:proc.root,owner:proc.owner}),true);
});

test('failed-install cleanup and retry work under a mixed-UID process table',async t=>{
 const f=fixture();t.after(()=>f.close());const saved={...runtimeProcessTable},proc=procFixture(f);
 Object.assign(runtimeProcessTable,{root:proc.root,owner:proc.owner});t.after(()=>Object.assign(runtimeProcessTable,saved));
 const npm=fakeNpm(f);npm.mode('fail');await assert.rejects(prepare(),{code:'RUNTIME_INSTALL_FAILED'});
 assert.equal(fs.existsSync(runtimeDirectory(locations())),false);
 npm.mode('ok');assert.equal((await prepare()).installed,true);assert.equal(npm.calls().length,2);
});

test('prepare and old-daemon start retain r1; pruning runs only after a reachable new daemon starts',async t=>{
 const {seedFakeRuntime,trapNpm,stopFakeDaemons}=await import('./fake-runtime.mjs');
 const f=fixture();const loc=ownedHome();t.after(()=>{stopFakeDaemons(loc);f.close();});
 const savedPath=process.env.PATH;t.after(()=>{process.env.PATH=savedPath;});trapNpm(f.dir);
 const r1=seedPriorRelease(loc,{generation:'r1'}),r2=seedPriorRelease(loc,{modules:lifecycleModules('r2')});seedFakeRuntime(loc);
 await fakeSupervisor(f,loc.paseoHome,{HERMES_PASEO_RUNTIME_REVISION:R2});
 fs.writeFileSync(path.join(loc.paseoHome,'config.json'),JSON.stringify({version:1}));
 for(const name of ['server-id','keys.json'])fs.writeFileSync(path.join(loc.paseoHome,name),'preserved');
 await prepare();assert.equal(fs.existsSync(r1.root),true);await activate();assert.equal(fs.existsSync(r1.root),true);
 await deactivate();assert.equal(fs.existsSync(r1.root),true);
 const started=await activate();assert.equal(started.daemon.reachable,true);assert.equal(started.daemon.runtimeRevision,RUNTIME_REVISION);
 assert.equal(fs.existsSync(r1.root),false);assert.equal(fs.existsSync(r2.root),true);
 for(const name of ['server-id','keys.json'])assert.equal(fs.readFileSync(path.join(loc.paseoHome,name),'utf8'),'preserved');
 await deactivate();
});

test('process revision guards distinguish profiles and retain an ambiguous relative runtime path',t=>{
 const f=fixture();t.after(()=>f.close());const proc=procFixture(f),root=runtimeDirectory(locations());
 const inUse=()=>runtimeInUse(root,RUNTIME_REVISION,{procRoot:proc.root,owner:proc.owner});
 proc.put(20,'environ',`HERMES_PASEO_RUNTIME_REVISION=${RUNTIME_REVISION}\0HERMES_PASEO_RUNTIME_DIR=${path.join(f.dir,'other')}\0`);
 assert.equal(inUse(),false,'another private profile using the same revision is independent');
 proc.put(20,'environ',`HERMES_PASEO_RUNTIME_REVISION=${RUNTIME_REVISION}\0HERMES_PASEO_RUNTIME_DIR=relative-runtime\0`);
 assert.equal(inUse(),true,'the process working directory may differ: never resolve its relative path against ours');
 proc.put(20,'environ',`HERMES_PASEO_RUNTIME_REVISION=${RUNTIME_REVISION}\0HERMES_PASEO_RUNTIME_DIR=${locations().runtimeDir}\0`);
 assert.equal(inUse(),true);
});
