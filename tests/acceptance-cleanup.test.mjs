import test from 'node:test';
import assert from 'node:assert/strict';
import {usingAcceptanceAgent,usingAcceptanceWorkspace} from '../src/acceptance-agent.mjs';

function fixture() {
 const calls=[];
 const client={
  createWorkspace:async()=>{calls.push('create-workspace');return {workspace:{id:'owned-workspace'}};},
  createAgent:async()=>{calls.push('create-agent');return {id:'owned-agent'};},
  archiveAgent:async id=>{assert.equal(id,'owned-agent');calls.push('archive-agent');return {archivedAt:'date'};},
  archiveWorkspace:async id=>{assert.equal(id,'owned-workspace');calls.push('archive-workspace');return {archivedAt:'date',error:null};},
 };
 return {client,calls};
}
test('acceptance archives its agent and workspace while retaining the verification history',async()=>{
 const {client,calls}=fixture(),row={};
 await usingAcceptanceWorkspace(client,{},row,async workspace=>usingAcceptanceAgent(client,{workspaceId:workspace.id},row,async()=>{calls.push('verify');row.passed=true;}));
 assert.deepEqual(calls,['create-workspace','create-agent','verify','archive-agent','archive-workspace']);
 assert.deepEqual(row.cleanup,{archived:true,workspaceArchived:true});
});
test('a failed model verification still archives only the resources it created',async()=>{
 const {client,calls}=fixture(),row={};const failure=Error('verification failed');
 await assert.rejects(usingAcceptanceWorkspace(client,{},row,async()=>usingAcceptanceAgent(client,{},row,async()=>{throw failure;})),error=>error===failure);
 assert.deepEqual(calls,['create-workspace','create-agent','archive-agent','archive-workspace']);
 assert.deepEqual(row.cleanup,{archived:true,workspaceArchived:true});
});
test('unconfirmed workspace creation never archives an unrelated workspace',async()=>{
 const {client,calls}=fixture();client.createWorkspace=async()=>({});
 await assert.rejects(usingAcceptanceWorkspace(client,{}, {},async()=>assert.fail('unconfirmed creation')),error=>error.code==='WORKSPACE_CREATE_FAILED');
 assert.deepEqual(calls,[]);
});
test('unconfirmed workspace archive remains a visible cleanup failure',async()=>{
 const {client}=fixture(),row={cleanup:{archived:true}};
 client.archiveWorkspace=async()=>({archivedAt:null,error:'refused'});
 await usingAcceptanceWorkspace(client,{},row,async()=>{});
 assert.deepEqual(row.cleanup,{archived:true,workspaceArchived:false,code:'ACCEPTANCE_CLEANUP_FAILED'});
});
