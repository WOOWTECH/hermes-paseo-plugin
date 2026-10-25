/** Archive only an agent created by this call, retaining its verification history. */
export async function usingAcceptanceAgent(client,options,row,verify) {
 const agent=await client.createAgent(options);
 if(!agent?.id)throw new Error('Agent creation was not confirmed');
 row.agentId=agent.id;
 try {return await verify(agent);}
 finally {
  try {
   const receipt=await client.archiveAgent(agent.id);
   if(receipt?.archivedAt===undefined||receipt.archivedAt===null)throw new Error('Unconfirmed cleanup');
   row.cleanup={archived:true};
  } catch {row.cleanup={archived:false,code:'ACCEPTANCE_CLEANUP_FAILED'};}
 }
}

/** The private verification workspace belongs to this call, not to a user's chat. */
export async function usingAcceptanceWorkspace(client,options,row,verify) {
 const receipt=await client.createWorkspace(options);
 if(!receipt?.workspace?.id)throw Object.assign(new Error('Workspace creation was not confirmed'),{code:'WORKSPACE_CREATE_FAILED'});
 try {return await verify(receipt.workspace);}
 finally {
  try {
   const archived=await client.archiveWorkspace(receipt.workspace.id);
   if(!archived?.archivedAt||archived.error)throw new Error('Unconfirmed workspace cleanup');
   row.cleanup={...row.cleanup,workspaceArchived:true};
  } catch {row.cleanup={...row.cleanup,workspaceArchived:false,code:'ACCEPTANCE_CLEANUP_FAILED'};}
 }
}
