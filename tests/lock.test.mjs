import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {withLockTransition} from '../src/state.mjs';

test('kernel guard preserves one inode and rejects symlink guard',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-paseo-lock-'));const file=path.join(root,'test.lock');
 try{let count=0;withLockTransition(file,()=>count++);const inode=fs.statSync(file+'.guard').ino;withLockTransition(file,()=>count++);assert.equal(fs.statSync(file+'.guard').ino,inode);assert.equal(count,2);fs.symlinkSync(file+'.guard',path.join(root,'redirect.guard'));assert.throws(()=>withLockTransition(path.join(root,'redirect'),()=>{}),e=>e.code==='UNSAFE_SYMLINK');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('competing real processes serialize read/modify/write without losing updates',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-paseo-concurrent-'));const file=path.join(root,'count');fs.writeFileSync(file,'0');const moduleUrl=new URL('../src/state.mjs',import.meta.url).href;
 const code=`import fs from 'node:fs';import {withRuntimeLock} from ${JSON.stringify(moduleUrl)};for(let i=0;i<6;i++)await withRuntimeLock(async()=>{const n=Number(fs.readFileSync(${JSON.stringify(file)},'utf8'));await new Promise(r=>setTimeout(r,8));fs.writeFileSync(${JSON.stringify(file)},String(n+1));});`;
 try{await Promise.all(Array.from({length:3},()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,HERMES_HOME:root,HERMES_PASEO_STATE_DIR:root},stdio:'ignore'});p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error('child failed')));})));assert.equal(Number(fs.readFileSync(file)),18);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
