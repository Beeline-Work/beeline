import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';
it.each(['bone', 'obsidian'])('CONNECTORS-1: %s removes a disconnected row despite an older read', async palette => {
  const mobile=process.cwd(),dir=await mkdtemp(path.join(mobile,'sources/test/cleanup-'));
  try {
    const entry=path.join(dir,'proof.jsx');
    await writeFile(entry, `import React from'react';import{createRoot}from'react-dom/client';import Workbench from'@/app/(app)/beeline/settings/workbench';
      globalThis.__params={workspaceId:'ws',viewerId:'viewer'};
      const find=id=>document.querySelector('[data-testid="'+id+'"]');
      const wait=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error(document.body.innerText);};
      async function run(){createRoot(document.getElementById('root')).render(<Workbench/>);await wait(()=>find('ai-client-grok'));
        const before=document.body.innerText,attention=find('connectors-company-notion').textContent;
        globalThis.startStaleRead();await wait(()=>globalThis.releaseStale);
        find('ai-client-grok').click();await wait(()=>find('ai-client-disconnect'));find('ai-client-disconnect').click();
        await wait(()=>!find('ai-client-grok'));globalThis.releaseStale();await new Promise(r=>setTimeout(r,300));
        document.getElementById('result').textContent=JSON.stringify({before,attention,after:document.body.innerText,removed:!find('ai-client-grok')});
      }run().catch(e=>document.getElementById('result').textContent=JSON.stringify({error:String(e)}));`);
    const shims=webProofShims(mobile);
    shims['react-native-unistyles']=shims['react-native-unistyles'].replace('beelineThemes.obsidian','beelineThemes.'+palette);
    Object.assign(shims,{
      '@expo/vector-icons':'export const Ionicons=()=>null;',
      'expo-router':`import{useEffect}from'react';export const useLocalSearchParams=()=>globalThis.__params;export const useFocusEffect=fn=>useEffect(fn,[fn]);export const router={back(){},push(){}};`,
      '@/buzz/runtime-config':'export const getBuzzRuntimeConfig=()=>({monolithUrl:"https://fixture.test"});',
      '@/auth/auth-session':'export const authSessionOptions=()=>({});',
      '@/buzz/wallet-workspace':'export const resolveWalletWorkspaceId=async()=>"ws";',
      '@/auth/buzz-identity-storage':'export const loadBuzzIdentity=async()=>({publicKey:"viewer"});export const getEffectiveRelayUrl=async()=>"https://fixture.test";',
      '@/sync/transport/live-connection':'export const sharedLiveConnection=()=>({register:async()=>()=>undefined});',
      '@/sync/transport/monolith-operation':`import{readSharedWorkbench}from'@/buzz/workbench-surface';import{companyWorkbench,companyRow}from'@/test/company-workbench';
        const clients=[{clientId:'grok',name:'Grok Bot',scopes:['rooms:read','rooms:write'],connectedAt:1,lastUsedAt:null},{clientId:'muse',name:'Meta Muse',scopes:['rooms:read'],connectedAt:1,lastUsedAt:null}];let removed=false,stale=false;
        const view=()=>{const active=clients.filter(c=>!removed||c.clientId!=='grok');return{workspaceId:'ws',catalog:[],helpers:[],connectors:[],connections:[],apps:[],aiClients:active,companies:companyWorkbench([{...companyRow('notion','Notion','attention'),state:'connect'},...active.map(c=>({...companyRow('rooms:'+c.clientId,c.name,'apps'),roomsClientId:c.clientId,items:[]}))]).companies};};
        globalThis.startStaleRead=()=>{stale=true;void readSharedWorkbench({workspaceId:'ws',viewerId:'viewer'},{refresh:true});};
        export class MonolithPhoneOperationError extends Error{};export const phoneOperationFailureReason=e=>String(e);
        export const monolithPhoneOperation=async(operation)=>{if(operation==='disconnectAiClient'){removed=true;return;}if(operation==='readWorkbench'){const answer=view();if(stale){stale=false;return new Promise(resolve=>{globalThis.releaseStale=()=>resolve(answer);});}return answer;}return{};};`,
    });
    const result=await runBrowserProof({entry,mobile,shims,width:430,height:932,budgetMs:14000});
    expect(result.status,result.stderr).toBe(0);const shown=JSON.parse(result.result);
    expect(shown.error).toBeUndefined();expect(shown.before).not.toMatch(/AI CLIENTS|AI clients/);
    expect(shown.before.indexOf('CONNECTED APPS')).toBeLessThan(shown.before.indexOf('Grok Bot'));
    expect(shown.before.indexOf('Grok Bot')).toBeLessThan(shown.before.indexOf('Meta Muse'));
    expect(shown.attention).toContain('Reconnect');expect(shown.removed).toBe(true);
    expect(shown.after).toContain('Meta Muse');expect(shown.after).not.toContain('Grok Bot');
  }finally{await rm(dir,{recursive:true,force:true});}
},90000);
