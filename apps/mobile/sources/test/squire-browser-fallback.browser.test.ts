import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it('Reproduction squire-browser-fallback: repeated browser returns stay bounded and connected navigates', async () => {
  const theme = 'bone';
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/squire-proof-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
      import SignIn from '@/app/(app)/beeline/settings/workbench/connect-signin';
      const root=createRoot(document.getElementById('root'));
      globalThis.__route={params:{workspaceId:'ws',connectorId:'squire:machine',connectorName:'Trusty Squire',machineName:'squire',url:'https://tunnel.test',method:'streamed'}};
      const nativeTimeout=window.setTimeout.bind(window);
      window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===120000?1200:ms===15000?150:ms,...args);
      const sleep=ms=>new Promise(resolve=>nativeTimeout(resolve,ms));
      const has=id=>!!document.querySelector('[data-testid="'+id+'"]');
      const click=()=>document.querySelector('[data-testid="signin-open-external"]').click();
      const result={};
      root.render(<SignIn />);
      (async()=>{
        await sleep(1600);
        result.initialTimeout=has('signin-retry');
        click(); await sleep(100); result.firstFinishing=has('signin-finishing');
        await sleep(1500); result.firstRecovered=has('signin-retry')&&has('signin-open-external')&&!has('signin-finishing');
        if(result.firstRecovered){
          click(); await sleep(1500); result.secondRecovered=has('signin-retry')&&has('signin-open-external')&&!has('signin-finishing');
          click(); await sleep(100); globalThis.__connected=true;
          for(const listener of globalThis.__liveListeners) listener({monolithLive:{type:'resource-change',roomId:'',resource:'install',resourceId:'squire:machine'}});
          await sleep(100); result.destination=globalThis.__destination;
        }
        result.text=document.getElementById('root').textContent;
        document.getElementById('result').textContent=JSON.stringify(result);
      })();`);
    const base = webProofShims(mobile);
    const result = await runBrowserProof({ entry, mobile, width: 390, head: '<script>window.process={env:{NODE_ENV:"development"}};</script>', budgetMs: 8000,
      ...(process.env.SQUIRE_PROOF_OUT ? { screenshotPath: path.join(process.env.SQUIRE_PROOF_OUT, `squire-browser-fallback.png`) } : {}),
      shims: { ...base,
        'react-native-unistyles': base['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`),
        'expo-router': `export const useLocalSearchParams=()=>globalThis.__route?.params??{}; export const router={back(){},replace(route){globalThis.__destination=route;},push(route){globalThis.__route=route;}}; export const useRouter=()=>router; export const usePathname=()=>'/';`,
        '@expo/vector-icons': `import React from 'react'; export const Ionicons=props=>React.createElement('span',{'data-icon':props.name});`,
        '@/modal': 'export const Modal={alert(){},confirm:async()=>false};',
        '@/modal/ModalManager': 'export const Modal={alert(){},confirm:async()=>false};',
        '@/sync/storage': `const state={settings:{},localSettings:{}}; export const storage=Object.assign(select=>select(state),{getState:()=>state,subscribe:()=>()=>{}});`,
        '@/sync/persistence': 'export const loadLocalSettings=()=>({}); export const saveLocalSettings=()=>{}; export const loadSettings=()=>({settings:{},version:null});',
        'react-native-view-shot': "export const captureRef=async()=>''; export default {};",
        'react-native-reanimated': `${base['react-native-reanimated']} const builder=new Proxy({},{get:()=>()=>builder}); export const FadeOut=builder; export const FadeIn=builder; export const Layout=builder; export const FadeOutDown=builder; export const FadeInUp=builder; export const FadeOutUp=builder; export const LinearTransition=builder; export const withSpring=value=>value; export const interpolateColor=(_value,_input,output)=>output[output.length-1];`,
        'expo-web-browser': 'export const openBrowserAsync=async()=>({});',
        '@/buzz/latency-route-hook': 'export const useLatencyRouteFrame=()=>{};',
        '@/components/AnimatedOverlay': 'export const AnimatedBlurBackdrop=()=>null;',
        '@/buzz/app-sign-in': 'export const takeAppSignInReturn=async()=>null;',
        '@/buzz/workbench-surface': `export const useSharedWorkbench=()=>({value:{helpers:[{id:'machine',name:'squire',online:true}]},error:null});`,
        '@/buzz/workbench-source': `export const getWorkbenchSource=()=>({readInstallState:async()=>({connected:!!globalThis.__connected,steps:[]})});`,
        '@/sync/transport/live-connection': 'globalThis.__liveListeners=[]; export const sharedLiveConnection=()=>({register:async(_filters,listener)=>{globalThis.__liveListeners.push(listener);return ()=>{};}});',
        '@/components/buzz/sandbox-webview': 'export const useSandboxWebView=()=>null;',
        '@/sync/client-reset': 'export const subscribeClientReset=()=>()=>{}; export const resetClientState=()=>{}; export const clientResetGeneration=()=>0;',
        '@/sync/transport/monolith-operation': 'export const monolithPhoneOperation=async()=>({});',
      }});
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.result);
    console.info('Reproduction squire-browser-fallback:', output);
    expect(output.initialTimeout).toBe(true);
    expect(output.firstFinishing).toBe(true);
    expect(output.firstRecovered).toBe(true);
    expect(output.secondRecovered).toBe(true);
    expect(output.destination?.pathname).toBe('/beeline/settings/workbench/service');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
