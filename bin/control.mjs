#!/usr/bin/env node
import {control} from '../src/control.mjs';
import {RuntimeError} from '../src/state.mjs';
const action=process.argv[2];
try {
 let body='',bytes=0;
 for await (const chunk of process.stdin){bytes+=chunk.length;if(bytes>16384)throw new RuntimeError('REQUEST_TOO_LARGE');body+=chunk.toString('utf8');}
 const input=JSON.parse(body||'{}');
 const result=await control(action,input);
 process.stdout.write(JSON.stringify(result)+'\n');
} catch(e) {
 const code=/^[A-Z][A-Z0-9_]{0,63}$/.test(e?.code||'')?e.code:'OPERATION_FAILED';
 process.stdout.write(JSON.stringify({ok:false,code})+'\n');process.exitCode=1;
}
