import payload from '../fixture.json';
if(process.env.EXPO_PUBLIC_PROOF_BEFORE==='1'){payload.aiClients=payload.aiClients.map(({logo,agent,...c})=>c);payload.companies.rows=payload.companies.rows.map(r=>({...r,logo:{kind:'monogram'},subtitle:'Reads and posts'}));}
export const calls=[];
export async function monolithPhoneOperation(name,input){calls.push({name,input}); if(name==='readWorkbench')return payload; if(name==='disconnectAiClient'){payload.aiClients=payload.aiClients.filter(c=>c.clientId!==input.clientId);payload.companies.rows=payload.companies.rows.filter(r=>r.roomsClientId!==input.clientId);return {ok:true};} throw new Error('Unexpected fixture operation: '+name);}
