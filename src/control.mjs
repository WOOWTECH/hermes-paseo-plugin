import * as runtime from './runtime.mjs';
import {RuntimeError} from './state.mjs';
import {CONNECTION_TARGETS} from './connection-targets.mjs';
const providers=new Set(['hermes','claude','codex','pi']);
const targets=new Set(CONNECTION_TARGETS.map(row=>row.id));
const actions=new Set(['status','start','stop','prepare','models','pair','relay','config','acceptance','chat','continue']);
export function validateInput(action,input) {
 if(!actions.has(action)||!input||typeof input!=='object'||Array.isArray(input))throw new RuntimeError('INVALID_REQUEST');
 const fields={status:[],start:[],stop:[],prepare:[],models:['provider'],pair:[],relay:[],config:['target'],acceptance:['providers'],chat:['provider','model','mode','thinking','message'],continue:['agentId','message']}[action];
 if(Object.keys(input).some(k=>!fields.includes(k)))throw new RuntimeError('INVALID_REQUEST');
 if(action==='config'&&(typeof input.target!=='string'||!targets.has(input.target)))throw new RuntimeError('INVALID_TARGET');
 if(input.provider!==undefined&&!providers.has(input.provider))throw new RuntimeError('INVALID_PROVIDER');
 if(action==='models'&&!providers.has(input.provider))throw new RuntimeError('INVALID_PROVIDER');
 if(action==='chat'&&!providers.has(input.provider))throw new RuntimeError('INVALID_PROVIDER');
 if(action==='acceptance'&&input.providers!==undefined&&(!Array.isArray(input.providers)||!input.providers.length||input.providers.some(x=>!providers.has(x))))throw new RuntimeError('INVALID_PROVIDER');
 for(const key of ['model','mode','thinking'])if(input[key]!==undefined&&(typeof input[key]!=='string'||input[key].length>256||/[\x00-\x1f]/.test(input[key])))throw new RuntimeError('INVALID_REQUEST');
 if(['chat','continue'].includes(action)&&(typeof input.message!=='string'||!input.message.trim()||input.message.length>12000))throw new RuntimeError('INVALID_MESSAGE');
 if(action==='continue'&&(typeof input.agentId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(input.agentId)))throw new RuntimeError('INVALID_AGENT_ID');
 return input;
}
const target=value=>targets.has(value)?value:null;
const safeCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:null;
const publicConfigCheck=value=>value&&typeof value==='object'?{ok:value.ok===true,code:value.ok===true?null:safeCode(value.code)||'CONFIG_INCOMPATIBLE',checkedAt:typeof value.checkedAt==='string'?value.checkedAt.slice(0,40):null}:null;
export function publicStatus(s) {
 return {installed:s.installed,version:s.version,enabled:s.enabled,phase:s.phase,diagnosticCode:s.diagnosticCode||null,daemon:{running:s.daemon.running,reachable:s.daemon.reachable,version:s.daemon.version||null,relayEnabled:s.daemon.relayEnabled,relayVerified:s.daemon.relayVerified,relayVerifiedAt:s.daemon.relayVerifiedAt},providers:s.providers.filter(p=>providers.has(p.provider)),chatVerified:s.chatVerified,chatVerifiedAt:s.state?.acceptance?.checkedAt||null,
  selectedTarget:target(s.selectedTarget)||'paseo',activeTarget:target(s.activeTarget),configurationPending:s.configurationPending===true,
  configCheck:publicConfigCheck(s.configCheck)};
}
export async function control(action,input={}) {
 validateInput(action,input);
 if(action==='status')return publicStatus(await runtime.status());
 if(action==='start'){await runtime.activate();return publicStatus(await runtime.status());}
 if(action==='stop'){await runtime.deactivate();return publicStatus(await runtime.status());}
 if(action==='prepare')return publicStatus(await runtime.prepare());
 if(action==='models')return runtime.listModels(input.provider);
 if(action==='pair')return runtime.pair();
 if(action==='relay'){await runtime.verifyRelay();return publicStatus(await runtime.status());}
 if(action==='config')return runtime.saveConnectionSettings(input);
 if(action==='acceptance')return runtime.acceptance(input);
 if(action==='chat')return runtime.createChat({...input,cwd:runtime.locations().agentDir,title:'Hermes Paseo conversation'});
 if(action==='continue')return runtime.continueChat(input);
}
