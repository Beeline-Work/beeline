import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof } from './browserProof';

it('Reproduction NET-WASTE-1: built browser navigation keeps hidden reads quiet', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/network-waste-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { useSharedWorkbench } from '@/buzz/workbench-surface';
      import { useDesktopParentRoom } from '@/buzz/use-desktop-parent-room';
      import { invalidatesWorkspaceList } from '@/buzz/workspace-list-invalidation';
      const counts={workspace:0,workbench:0,parent:0}, bytes={workspace:0,workbench:0,parent:0};
      globalThis.fixtureRead=async(kind,value)=>{
        const json=JSON.stringify(value);
        const response=new Response(json);
        const text=await response.text(); counts[kind]++; bytes[kind]+=new TextEncoder().encode(text).length;
        return JSON.parse(text);
      };
      const listeners=new Set(); globalThis.liveListeners=listeners;
      const emit=event=>{for(const fn of listeners)fn({monolithLive:event});};
      const parentClient={room:()=>fixtureRead('parent',{room:{id:'parent',name:'Parent Room'},messages:[]})};
      function Settings(){const resource=useSharedWorkbench({workspaceId:'ws',viewerId:'owner'});
        return <p>Settings: {resource.value?.helpers[0]?.name??JSON.stringify(resource)}</p>;}
      function App(){
        const [route,setRoute]=useState('list'),[pane,setPane]=useState(false);
        const parent=useDesktopParentRoom(route==='corner'&&pane,route==='corner'?'parent':undefined,parentClient);
        return <><button id="list" onClick={()=>{setRoute('list');setPane(false)}}>Conversations</button>
          <button id="settings" onClick={()=>setRoute('settings')}>Settings</button>
          <button id="corner" onClick={()=>{setRoute('corner');setPane(false)}}>Corner</button>
          <button id="pane" onClick={()=>setPane(true)}>Open work pane</button>
          {route==='settings'?<Settings/>:<p>{route==='corner'?'Corner transcript':'Workspace list'}</p>}
          {parent&&<p>Work pane: {parent.room.name}</p>}</>;
      }
      flushSync(()=>createRoot(document.getElementById('root')).render(<App/>));
      const wait=()=>new Promise(resolve=>setTimeout(resolve,500));
      const click=async id=>{flushSync(()=>document.getElementById(id).click());await wait();};
      (async()=>{
        await wait();
        const irrelevant=[
          {type:'resource-change',roomId:'',resource:'workbench'},
          {type:'needs-you-delta',roomId:''},
          {type:'bookmark-delta',roomId:''},
          {type:'person-changed',roomId:''},
        ];
        for(let i=0;i<98;i++){
          const event={monolithLive:irrelevant[i%irrelevant.length]};
          if(invalidatesWorkspaceList(event))await fixtureRead('workspace',{workspaces:[]});
        }
        const unrelated={...counts};
        for(const reason of ['postgres:memberships','postgres:workspaces','reconnect']){
          if(invalidatesWorkspaceList({monolithLive:{type:'invalidate',roomId:'',reason}}))
            await fixtureRead('workspace',{workspaces:[{id:'ws',name:'Workspace'}]});
        }
        await click('settings');
        const settingsText=document.getElementById('root').textContent;
        await click('list');
        const beforeHidden={...counts};
        for(let i=0;i<3;i++){emit(irrelevant[0]);await wait();}
        const afterHidden={...counts};
        await click('settings');
        const afterReopen={...counts};
        await click('corner');
        const beforePane={...counts};
        const cornerText=document.getElementById('root').textContent;
        await click('pane');
        document.getElementById('result').textContent=JSON.stringify({
          unrelated,beforeHidden,afterHidden,afterReopen,beforePane,counts,bytes,
          settingsText,cornerText,paneText:document.getElementById('root').textContent,
        });
      })().catch(e=>document.getElementById('result').textContent=JSON.stringify({error:String(e)}));
    `);
    const result = await runBrowserProof({ entry, mobile, width: 1440, budgetMs: 12000,
      head: `<script>window.process={env:{NODE_ENV:'development'}};window.addEventListener('error',e=>{document.getElementById('result').textContent=JSON.stringify({error:e.message});});setTimeout(()=>{if(document.getElementById('result').textContent==='PENDING')document.getElementById('result').textContent=JSON.stringify({error:window.__console,html:document.getElementById('root').innerHTML});},10000);</script>`,
      shims: {
        './workbench-source': `export const getWorkbenchSource=()=>({readWorkbench:()=>globalThis.fixtureRead('workbench',{apps:[],helpers:[{name:'squire'}],connectors:[],connections:[]})});`,
        './surface-storage': `export { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';`,
        'expo-router': `import { useEffect } from 'react'; export const useFocusEffect=effect=>useEffect(effect,[effect]);`,
        '@/auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:'owner'}); export const getEffectiveRelayUrl=async()=>'https://fixture.test';`,
        '@/buzz/surface-storage': `import { mockSurfaceStorage } from '@/test/mock-surface-storage'; const storage=mockSurfaceStorage(); export const mobileSurfaceCache=storage.mobileSurfaceCache; export const surfaceAddress=storage.surfaceAddress;`,
        '@/sync/transport/live-connection': `export const sharedLiveConnection=()=>({register:async(_,fn)=>{globalThis.liveListeners.add(fn);return()=>globalThis.liveListeners.delete(fn);}});`,
      } });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.result);
    console.info('Reproduction NET-WASTE-1 browser stand-in:', JSON.stringify(output));
    expect(output.error).toBeUndefined();
    expect(output.unrelated.workspace).toBe(0);
    expect(output.counts.workspace).toBe(3);
    expect(output.settingsText).toContain('squire');
    expect(output.afterHidden.workbench).toBe(output.beforeHidden.workbench);
    expect(output.afterReopen.workbench).toBe(output.afterHidden.workbench + 1);
    expect(output.beforePane.parent).toBe(0);
    expect(output.counts.parent).toBe(1);
    expect(output.cornerText).toContain('Corner transcript');
    expect(output.paneText).toContain('Work pane: Parent Room');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
