#!/usr/bin/env node
import {control} from '../src/control.mjs';
import {RuntimeError} from '../src/state.mjs';
const action=process.argv[2];
// This process owns one request. Dependency timers/subscriptions must never
// retain a completed response; the managed daemon has its own detached session.
function respond(value,code=0) {
 process.stdout.write(JSON.stringify(value)+'\n',()=>process.exit(code));
}
try {
 let body='',bytes=0;
 for await (const chunk of process.stdin){bytes+=chunk.length;if(bytes>16384)throw new RuntimeError('REQUEST_TOO_LARGE');body+=chunk.toString('utf8');}
 const input=JSON.parse(body||'{}');
 const result=await control(action,input);
 respond(result);
} catch(e) {
 const code=/^[A-Z][A-Z0-9_]{0,63}$/.test(e?.code||'')?e.code:'OPERATION_FAILED';
 respond({ok:false,code},1);
}
