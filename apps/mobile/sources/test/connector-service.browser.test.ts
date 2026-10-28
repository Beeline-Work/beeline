import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { it, expect } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

const origin = process.env.CONNECTOR_PROOF_ORIGIN;
it.skipIf(!origin)('disconnects through PhoneService and refreshes the rendered list', async () => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/service-proof-'));
  const evidence = path.join(mobile, 'evidence/connector-removal');
  await mkdir(evidence, { recursive: true });
  const fonts = await Promise.all(['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'].map(async name =>
    "@font-face{font-family:'"+name+"';src:url(data:font/ttf;base64,"+(await readFile(path.join(mobile,'sources/assets/fonts',name+'.ttf'))).toString('base64')+")}"));
  const head = '<style>'+fonts.join('')+'#result{display:none}html,body,#root{min-height:100vh}</style>';
  try {
    for (const theme of ['bone', 'obsidian']) for (const width of [390, 1280]) {
      await fetch(origin!, { method: 'POST', body: JSON.stringify({ operation: 'resetProof' }) });
      const entry = path.join(directory, 'proof.jsx');
      await writeFile(entry, `
        import React from 'react'; import { createRoot } from 'react-dom/client';
        import Workbench from '@/app/(app)/beeline/settings/workbench';
        import Service from '@/app/(app)/beeline/settings/workbench/service';
        const root = createRoot(document.getElementById('root'));
        globalThis.__params = { workspaceId: '11111111-1111-4111-8111-111111111111', viewerId: '${'a'.repeat(64)}' };
        globalThis.__pushes = [];
        const find = id => document.querySelector('[data-testid="' + id + '"]');
        const delay = () => new Promise(resolve => setTimeout(resolve, 100));
        async function until(fn) { for (let i=0;i<200;i++) { if(fn()) return; await delay(); } throw new Error('Timed out: '+document.body.innerText); }
        async function run() {
          root.render(<Workbench/>);
          await until(() => find('connectors-company-slack'));
          find('connectors-company-slack').click();
          await until(() => globalThis.__pushes.length);
          globalThis.__params = globalThis.__pushes[0].params;
          root.render(<Service/>);
          await until(() => document.querySelector('[data-testid^="company-item-"]'));
          document.querySelector('[data-testid^="company-item-"]').click();
          await until(() => [...document.querySelectorAll('[role="button"]')].some(el => el.textContent === 'Disconnect'));
          if (location.search.includes('before')) { document.getElementById('result').textContent = JSON.stringify({sheet:true}); return; }
          [...document.querySelectorAll('[role="button"]')].find(el => el.textContent === 'Disconnect').click();
          await until(() => globalThis.__removed);
          root.render(<Workbench key="refreshed"/>);
          await until(() => find('workbench-scroll') && !find('connectors-company-slack'));
          const view = await (await fetch('${origin}', {method:'POST', body:JSON.stringify({operation:'readWorkbench',input:{workspaceId:globalThis.__params.workspaceId}})})).json();
          document.getElementById('result').textContent = JSON.stringify({removed:!view.apps.some(app => app.appKey === 'slack'), absent:!find('connectors-company-slack')});
        }
        run().catch(error => document.getElementById('result').textContent = JSON.stringify({error:String(error)}));
      `);
      const shims = webProofShims(mobile);
      shims['react-native-unistyles'] = shims['react-native-unistyles'].replace('beelineThemes.obsidian', 'beelineThemes.' + theme);
      Object.assign(shims, {
        '@expo/vector-icons': 'export const Ionicons = () => null;',
        'expo-router': `import {useEffect} from 'react'; export const useLocalSearchParams=()=>globalThis.__params;
          export const useFocusEffect=effect=>useEffect(()=>effect(),[effect]);
          export const router={back(){},replace(){},push(href){globalThis.__pushes.push(href)}};`,
        '@/buzz/runtime-config': 'export const getBuzzRuntimeConfig=()=>({monolithUrl:"http://proof.test"});',
        '@/auth/auth-session': 'export const authSessionOptions=()=>({});',
        '@/buzz/wallet-workspace': 'export const resolveWalletWorkspaceId=async id=>id;',
        '@/auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:'${'a'.repeat(64)}'});
          export const getEffectiveRelayUrl=async()=>'http://proof.test';`,
        '@/sync/transport/live-connection': 'export const sharedLiveConnection=()=>({register:async()=>()=>undefined});',
        '@/sync/transport/monolith-operation': `
          export class MonolithPhoneOperationError extends Error {}
          export const phoneOperationFailureReason=error=>String(error);
          export const monolithPhoneOperation=async(operation,input)=>{
            const response=await fetch('${origin}',{method:'POST',body:JSON.stringify({operation,input})});
            const result=await response.json(); if(!response.ok) throw new Error(result.error);
            if(operation==='disconnectWorkbenchApp') globalThis.__removed=true;
            return result;
          };`,
      });
      shims['./app-sign-in'] = 'export const openAppSignIn=async(url)=>{globalThis.__authorization=url;};';
      for (const stage of ['before', 'after']) {
        const result = await runBrowserProof({ entry, mobile, shims, head, width, height: 900, budgetMs: 30000,
          query: '?' + stage, screenshotPath: path.join(evidence, theme + '-' + width + '-' + stage + '.png') });
        console.log(theme, width, stage, result.result);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.result)).toEqual(stage === 'before' ? {sheet:true} : {removed:true,absent:true});
      }

      for (const query of ['fly', 'https://mcp.fly.io']) {
        await writeFile(entry, `
          import React from 'react'; import {createRoot} from 'react-dom/client';
          import Search from '@/app/(app)/beeline/settings/workbench/connect-app';
          globalThis.__params={workspaceId:'11111111-1111-4111-8111-111111111111',viewerId:'${'a'.repeat(64)}',query:${JSON.stringify(query)}};
          globalThis.__pushes=[];
          const root=createRoot(document.getElementById('root'));
          const delay=()=>new Promise(resolve=>setTimeout(resolve,100));
          async function run(){
            root.render(<Search/>);
            for(let i=0;i<200 && !document.querySelector('[data-testid="connect-app-fly"]');i++) await delay();
            const row=document.querySelector('[data-testid="connect-app-fly"]');
            if(!row) throw new Error('No Fly result: '+document.body.innerText);
            if(location.search.includes('before')) {document.getElementById('result').textContent=JSON.stringify({found:true});return;}
            row.click();
            for(let i=0;i<200 && !globalThis.__authorization;i++) await delay();
            const view=await(await fetch('${origin}',{method:'POST',body:JSON.stringify({operation:'readWorkbench',input:{workspaceId:globalThis.__params.workspaceId}})})).json();
            document.getElementById('result').textContent=JSON.stringify({authorization:globalThis.__authorization,keys:view.companies.rows.find(row=>row.id==='fly').items.filter(item=>item.kind==='key').length});
          }
          run().catch(error=>document.getElementById('result').textContent=JSON.stringify({error:String(error)}));
        `);
        for (const stage of ['before', 'after']) {
          const result = await runBrowserProof({entry,mobile,shims,head,width,height:900,budgetMs:30000,query:'?'+stage,
            screenshotPath:path.join(evidence, theme+'-'+width+'-'+(query==='fly'?'fly':'url')+'-'+stage+'.png')});
          console.log(theme,width,query,stage,result.result);
          const proof=JSON.parse(result.result);
          if(stage==='before') expect(proof).toEqual({found:true});
          else expect(proof).toEqual({authorization:expect.stringContaining('https://fly.io/mcp/oauth/'),keys:6});
        }
      }
    }
  } finally { await rm(directory, { recursive:true, force:true }); }
}, 240000);
