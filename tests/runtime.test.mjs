import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { locations, readState, updateState, withRuntimeLock, processIdentity } from '../src/state.mjs';
import { runProcess } from '../src/process.mjs';
import { activate, deactivate, status, listModels, inheritedEnv } from '../src/runtime.mjs';
import { demonstrablyReusedPid, linuxProcessBirth, linuxContainerIdentity, instanceFromPreviousContainer } from '../src/daemon-identity.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paseo-runtime-'));
  const saved = Object.fromEntries(['HOME','HERMES_HOME','HERMES_PASEO_STATE_DIR','HERMES_PASEO_RUNTIME_DIR','HERMES_PASEO_PORT'].map(key => [key, process.env[key]]));
  process.env.HOME = path.join(dir, 'home'); process.env.HERMES_HOME = path.join(dir,'agent');
  process.env.HERMES_PASEO_STATE_DIR = path.join(dir,'state'); process.env.HERMES_PASEO_RUNTIME_DIR = path.join(dir,'runtime'); delete process.env.HERMES_PASEO_PORT;
  return { dir, close() { for (const [key,value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; fs.rmSync(dir,{recursive:true,force:true}); } };
}

test('the daemon environment carries provider keys but never the host own credentials', () => {
  const f = fixture(); try {
    const host = ['HERMES_DASHBOARD_BASIC_AUTH_PASSWORD','HERMES_DASHBOARD_BASIC_AUTH_SECRET','API_SERVER_KEY'];
    for (const key of host) process.env[key] = 'host-secret';
    process.env.OPENROUTER_API_KEY = 'provider-only';
    try {
      const env = inheritedEnv();
      for (const key of host) assert.equal(key in env, false, key);
      assert.equal(Object.values(env).includes('host-secret'), false);
      assert.equal(env.OPENROUTER_API_KEY, 'provider-only');
      assert.equal(env.PI_WEB_PASSWORD, undefined);
    } finally {
      for (const key of [...host,'OPENROUTER_API_KEY']) delete process.env[key];
    }
  } finally { f.close(); }
});

test('state merges preserve host onboarding fields and files remain private', () => {
  const f = fixture(); try {
    updateState({ onboardingSessionId:'existing', desiredEnabled:true }); updateState({ phase:'running', port:6770 });
    assert.equal(readState().onboardingSessionId,'existing'); assert.equal(locations().port,6770);
    assert.equal(fs.statSync(path.join(locations().stateDir,'state.json')).mode & 0o777,0o600);
    assert.equal(fs.statSync(locations().stateDir).mode & 0o777,0o700);
    assert.throws(() => updateState({nested:{password:'never-store'}}),error => error.code === 'STATE_SECRET_FIELD');
    assert.equal(JSON.stringify(readState()).includes('never-store'),false);
  } finally { f.close(); }
});

test('corrupt state is reported without silently resetting installation identity', () => {
  const f=fixture();try {
    updateState({phase:'ready'});fs.writeFileSync(path.join(locations().stateDir,'state.json'),'{broken');
    assert.throws(()=>updateState({phase:'running'}),e=>e.code==='STATE_CORRUPT');
  }finally{f.close()}
});

test('runtime lock serializes competing lifecycle actions and recovers dead process lock', async () => {
  const f=fixture();try {
    const order=[];
    await Promise.all([withRuntimeLock(async()=>{order.push('first');await new Promise(resolve=>setTimeout(resolve,80));order.push('first-end')}),withRuntimeLock(async()=>{order.push('second')})]);
    assert.deepEqual(order,['first','first-end','second']);
    fs.writeFileSync(path.join(locations().stateDir,'runtime.lock'),JSON.stringify({pid:99999999,identity:'dead',token:'orphan'}));
    await withRuntimeLock(async()=>order.push('recovered'));
    assert.equal(order.at(-1),'recovered');
  }finally{f.close()}
});

test('installer refuses an unmarked existing daemon home before npm or daemon mutation', async () => {
  const f=fixture();try {
    const loc=locations();fs.mkdirSync(loc.paseoHome,{recursive:true});fs.writeFileSync(path.join(loc.paseoHome,'keep.txt'),'existing-user-data');
    await assert.rejects(activate(),e=>e.code==='DAEMON_NOT_OWNED');
    assert.equal(fs.readFileSync(path.join(loc.paseoHome,'keep.txt'),'utf8'),'existing-user-data');
    assert.equal(fs.existsSync(path.join(loc.paseoHome,'.hermes-paseo-owner.json')),false);
  }finally{f.close()}
});

test('subprocess failures expose no output and arguments never expand through shell', async () => {
  const marker='SUPER_PRIVATE_TOKEN';
  await assert.rejects(runProcess(process.execPath,['-e',`process.stdout.write('${marker}');process.stderr.write('${marker}');process.exit(23)`]),e=>e.code==='COMMAND_FAILED'&&!e.message.includes(marker)&&!JSON.stringify(e).includes(marker));
  const literal='$(touch /tmp/hermes-paseo-shell-expansion)';
  const out=await runProcess(process.execPath,['-e','process.stdout.write(process.argv[1])',literal]);assert.equal(out,literal);
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50}),e=>e.code==='COMMAND_TIMEOUT');
  await assert.rejects(runProcess(process.execPath,['-e','process.stdout.write("x".repeat(2000))'],{maxBytes:100}),e=>e.code==='COMMAND_OUTPUT_LIMIT');
});

test('an alive unrelated process referenced by owned home metadata is never stopped', async () => {
  const f=fixture();const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try {
    const loc=locations();const state=updateState({desiredEnabled:true});fs.mkdirSync(loc.paseoHome,{recursive:true});
    fs.writeFileSync(path.join(loc.paseoHome,'.hermes-paseo-owner.json'),JSON.stringify({installationId:state.installationId,home:loc.paseoHome}));
    fs.writeFileSync(path.join(loc.paseoHome,'paseo.pid'),JSON.stringify({pid:child.pid,uid:process.getuid?.(),startedAt:new Date().toISOString(),heartbeat:true,listen:'127.0.0.1:6769'}));
    const pkg=path.join(loc.runtimeDir,'node_modules/@getpaseo/server');fs.mkdirSync(path.join(pkg,'dist/server/server'),{recursive:true});
    fs.mkdirSync(path.join(loc.runtimeDir,'node_modules/@getpaseo/cli'),{recursive:true});fs.writeFileSync(path.join(loc.runtimeDir,'node_modules/@getpaseo/cli/package.json'),JSON.stringify({version:'0.11.2'}));
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({type:'module'}));
    fs.writeFileSync(path.join(pkg,'dist/server/server/daemon-instance.js'),'import fs from "node:fs";export async function readDaemonInstance(home){return JSON.parse(fs.readFileSync(home+"/paseo.pid","utf8"))};export async function stopDaemonInstance(){throw new Error("stop must never execute")};');
    const s=await status();assert.equal(s.daemon.running,false);assert.equal(s.diagnosticCode,'DAEMON_NOT_OWNED');
    await assert.rejects(deactivate(),e=>e.code==='DAEMON_NOT_OWNED');assert.ok(processIdentity(child.pid));
  }finally{child.kill('SIGTERM');f.close()}
});

test('missing runtime reports clean state and invalid provider never opens connection', async () => {
  const f=fixture();try {
    const s=await status();assert.equal(s.installed,false);assert.equal(s.daemon.running,false);assert.equal(s.chatVerified,false);
    await assert.rejects(listModels('unrecognized'),e=>e.code==='INVALID_PROVIDER');
  }finally{f.close()}
});

test('stale lock from an earlier container retires without signalling the unrelated live PID', async () => {
  const f=fixture();const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try {
    const loc=locations();const state=updateState({desiredEnabled:true});fs.mkdirSync(loc.paseoHome,{recursive:true});
    fs.writeFileSync(path.join(loc.paseoHome,'.hermes-paseo-owner.json'),JSON.stringify({installationId:state.installationId,home:loc.paseoHome}));
    const record={pid:child.pid,uid:process.getuid(),startedAt:'2000-01-01T00:00:00.000Z',heartbeat:true,listen:'127.0.0.1:6769'};
    fs.writeFileSync(path.join(loc.paseoHome,'paseo.pid'),JSON.stringify(record));
    const pkg=path.join(loc.runtimeDir,'node_modules/@getpaseo/server');fs.mkdirSync(path.join(pkg,'dist/server/server'),{recursive:true});
    fs.mkdirSync(path.join(loc.runtimeDir,'node_modules/@getpaseo/cli'),{recursive:true});fs.writeFileSync(path.join(loc.runtimeDir,'node_modules/@getpaseo/cli/package.json'),JSON.stringify({version:'0.11.2'}));
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({type:'module'}));
    fs.writeFileSync(path.join(pkg,'dist/server/server/daemon-instance.js'),'import fs from "node:fs";export async function readDaemonInstance(home){try{return JSON.parse(fs.readFileSync(home+"/paseo.pid","utf8"))}catch{return null}};export async function stopDaemonInstance(){throw new Error("must never signal a reused PID")};');
    fs.writeFileSync(path.join(pkg,'dist/server/server/pid-lock.js'),'import fs from "node:fs";export async function getPidLockInfo(home){try{return JSON.parse(fs.readFileSync(home+"/paseo.pid","utf8"))}catch{return null}};export async function releasePidLock(home,expected){const x=await getPidLockInfo(home);if(x&&x.pid===expected.ownerPid&&x.startedAt===expected.startedAt)fs.unlinkSync(home+"/paseo.pid")};');
    assert.ok(linuxProcessBirth(child.pid));
    assert.equal(demonstrablyReusedPid(record),true);
    assert.equal(demonstrablyReusedPid({...record,startedAt:'invalid'}),false);
    assert.equal(demonstrablyReusedPid({...record,startedAt:new Date().toISOString()}),false);
    const result=await deactivate();
    assert.equal(result.phase,'disabled');assert.equal(fs.existsSync(path.join(loc.paseoHome,'paseo.pid')),false);assert.ok(processIdentity(child.pid));
    // A fast restart must not depend on a wall-clock grace period. Namespace
    // evidence is valid only for the exact PID/timestamp previously recorded.
    const recent={...record,startedAt:new Date().toISOString()};
    const oldNamespace='00000000-0000-0000-0000-000000000000:123';
    updateState({daemonPid:recent.pid,daemonStartedAt:recent.startedAt,daemonContainerIdentity:oldNamespace});
    fs.writeFileSync(path.join(loc.paseoHome,'paseo.pid'),JSON.stringify(recent));
    assert.ok(linuxContainerIdentity());
    assert.equal(instanceFromPreviousContainer(recent,readState()),true);
    assert.equal(instanceFromPreviousContainer({...recent,pid:recent.pid+1},readState()),false);
    await deactivate();
    assert.equal(fs.existsSync(path.join(loc.paseoHome,'paseo.pid')),false);assert.ok(processIdentity(child.pid));
  } finally {child.kill('SIGTERM');f.close();}
});

test('timed out child kills its own inherited process group including descendants',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-paseo-process-group-')),file=path.join(dir,'pid');
 const code=`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(file)},String(child.pid));setInterval(()=>{},1000);`;
 try {
  await assert.rejects(runProcess(process.execPath,['-e',code],{timeoutMs:250}),e=>e.code==='COMMAND_TIMEOUT');
  const pid=Number(fs.readFileSync(file));let live=false;
  try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');live=!['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch{}
  const deadline=Date.now()+1000;
  while(live && Date.now()<deadline){
    await new Promise(r=>setTimeout(r,10));
    try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');live=!['Z','X'].includes(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]);}catch{live=false;}
  }
  assert.equal(live,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
