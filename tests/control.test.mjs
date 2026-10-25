import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateInput,publicStatus} from '../src/control.mjs';
import {configureProviders,resolveProviderLaunchers} from '../src/provider-launchers.mjs';

test('reject unknown action/command/path and unsupported providers before side effects',()=>{
 for(const [a,b] of [['exec',{}],['start',{cwd:'/'}],['chat',{provider:'bad',message:'hi'}],['pair',{command:'echo secret'}],['models',{provider:'hermes',token:'secret'}],['acceptance',{providers:[]}]])assert.throws(()=>validateInput(a,b));
 assert.deepEqual(validateInput('models',{provider:'hermes'}),{provider:'hermes'});
});
test('chat input never admits cwd or arbitrary command and validates resume IDs',()=>{
 assert.throws(()=>validateInput('continue',{agentId:'../../config.json',message:'hi'}));
 assert.throws(()=>validateInput('chat',{provider:'hermes',message:'',model:'model'}));
 assert.throws(()=>validateInput('chat',{provider:'hermes',message:'hi',cwd:'/root'}));
 assert.equal(validateInput('chat',{provider:'hermes',message:'hi'}).provider,'hermes');
});
test('fresh status is isolated and secret free in actual control subprocess',()=>{
 const root=mkdtempSync(join(tmpdir(),'hermes-paseo-control-'));
 try{const r=spawnSync(process.execPath,['bin/control.mjs','status'],{cwd:new URL('..',import.meta.url),input:'{}',encoding:'utf8',env:{...process.env,HERMES_HOME:root,HERMES_PASEO_STATE_DIR:join(root,'plugin-data/hermes-paseo'),PASEO_PASSWORD:'private-value'}});assert.equal(r.status,0);const s=JSON.parse(r.stdout);assert.equal(s.installed,false);assert.equal(s.daemon.reachable,false);assert.equal(s.enabled,false);assert.ok(!r.stdout.includes('private-value'));assert.ok(!('state' in s));}finally{rmSync(root,{recursive:true,force:true});}
});
test('one-shot control flushes its result and exits despite a dependency keeping an event-loop handle',()=>{
 const root=mkdtempSync(join(tmpdir(),'hermes-paseo-worker-exit-'));
 try {
  const preload=join(root,'dependency-timer.mjs');writeFileSync(preload,'setInterval(()=>{},60000);');
  for(const action of ['status','unknown']) {
   const r=spawnSync(process.execPath,['--import',preload,'bin/control.mjs',action],{cwd:new URL('..',import.meta.url),input:'{}',encoding:'utf8',timeout:2000,env:{...process.env,HERMES_HOME:root,HERMES_PASEO_STATE_DIR:join(root,'state')}});
   assert.equal(r.error,undefined,'control must not wait for unrelated event-loop handles');
   assert.equal(r.status,action==='status'?0:1);
   const result=JSON.parse(r.stdout);assert.equal(action==='status'?result.installed:result.code,action==='status'?false:'INVALID_REQUEST');
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('public snapshot excludes raw state, pairing offer and unknown provider',()=>{
 const value=publicStatus({installed:true,enabled:true,phase:'running',state:{password:'secret'},daemon:{running:true,reachable:true,pairingUrl:'secret'},providers:[{provider:'hermes',status:'ready'},{provider:'unknown',status:'ready'}]});assert.equal(value.providers.length,1);assert.ok(!JSON.stringify(value).includes('secret'));
});
test('configure Hermes via official ACP without mixing Pi settings or escalating mode',()=>{
 const c=configureProviders({}, {hermes:{startup:'ready',command:'/bin/hermes'},codex:{startup:'missing'}},{agentDir:'/profile/a',home:'/users/a'});
 assert.equal(c.hermes.extends,'acp');assert.deepEqual(c.hermes.command,['/bin/hermes','acp']);assert.equal(c.hermes.env.HERMES_HOME,'/profile/a');assert.equal(c.hermes.env.HERMES_PASEO_ACP_CHILD,'1');assert.equal(c.codex.enabled,false);assert.equal(c.hermes.options,undefined);assert.ok(!('PI_CODING_AGENT_DIR' in c.hermes.env));
});
test('probe detects ACP failure without installing or leaking stderr',async()=>{
 const calls=[];const launchers=await resolveProviderLaunchers({}, {env:{PATH:'/bin'},discover:n=>n==='hermes'?'/bin/hermes':null,run:async(c,a)=>{calls.push(a);if(a[0]==='acp')throw new Error('secret');return'Hermes 0.19.0';}});assert.equal(launchers.hermes.startup,'PROVIDER_LAUNCH_FAILED');assert.equal(launchers.codex.startup,'missing');assert.deepEqual(calls,[['--version'],['acp','--help']]);assert.ok(!JSON.stringify(launchers).includes('secret'));
});
