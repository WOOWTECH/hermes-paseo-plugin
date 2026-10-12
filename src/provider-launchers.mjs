import fs from 'node:fs';
import path from 'node:path';
import {findExecutable,runProcess} from './process.mjs';

export const PROVIDER_PACKAGES=Object.freeze({hermes:null,claude:null,codex:null,pi:null});
const providers=['hermes','claude','codex','pi'];
export async function resolveProviderLaunchers(loc,{env=process.env,discover=findExecutable,run=runProcess}={}) {
 const result={};
 for(const provider of providers) {
  const wanted=provider==='hermes'?(env.HERMES_PASEO_HERMES_COMMAND||'hermes'):provider;
  const command=discover(wanted,env);
  if(!command){result[provider]={command:null,version:null,startup:'missing'};continue;}
  try {
   const version=await run(command,['--version'],{env,timeoutMs:15000,maxBytes:8192});
   const parsed=version.match(/\d+\.\d+\.\d+/)?.[0];
   if(!parsed)throw new Error('Invalid version');
   if(provider==='hermes')await run(command,['acp','--help'],{env,timeoutMs:15000,maxBytes:16384});
   result[provider]={command:path.resolve(command),version:parsed,startup:'ready'};
  } catch {result[provider]={command:path.resolve(command),version:null,startup:'PROVIDER_LAUNCH_FAILED'};}
 }
 return result;
}
export function configureProviders(previous,launchers,loc,env=process.env) {
 const configured={...previous};
 for(const provider of providers) {
  const launcher=launchers[provider]||{startup:'missing',command:null};
  const inherited=provider==='hermes'?{HERMES_HOME:loc.agentDir,HOME:loc.home,HERMES_PASEO_ACP_CHILD:'1'}:{HOME:loc.home};
  configured[provider]={...configured[provider],enabled:launcher.startup==='ready',command:launcher.command?[launcher.command,...(provider==='hermes'?['acp']:[])]:undefined,env:{...configured[provider]?.env,...inherited},...(provider==='hermes'?{extends:'acp',label:'Hermes',description:'Hermes Agent using the current profile and official ACP'}:{})};
 }
 // Expose only configured agents, avoiding noisy unavailable stock entries.
 for(const id of ['copilot','opencode','antigravity','muse','omp'])if(!(id in configured))configured[id]={enabled:false};
 return configured;
}
