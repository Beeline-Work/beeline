import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runBrowserProof, webProofShims } from './browserProof';

it.each(['obsidian', 'bone'])('Reproduction squire-spinner: card and Settings reconnect reach a bounded sign-in error (%s)', async theme => {
  const mobile = process.cwd();
  const directory = await mkdtemp(path.join(mobile, 'sources/test/squire-proof-'));
  try {
    const entry = path.join(directory, 'proof.jsx');
    await writeFile(entry, `import React from 'react'; import { createRoot } from 'react-dom/client';
      import SignIn from '@/app/(app)/beeline/settings/workbench/connect-signin';
      import { ConnectorOfferCard } from '@/app/(app)/beeline/chat/RoomMessageVariants';
      import Connect from '@/app/(app)/beeline/settings/workbench/connect';
      import { connectorOfferCeremonyRoute } from '@/buzz/connector-offer-ceremony';
      const root=createRoot(document.getElementById('root'));
      const result={};
      const owner={pubkey:'owner',kind:'human',name:'Owner',handle:'owner'};
      const agent={pubkey:'agent',kind:'agent',name:'Agent',handle:'agent'};
      const offer={offerId:'offer',agent,addressee:owner,connectorType:'trusty-squire',connectorName:'Trusty Squire',reason:'',consequence:'Sign in to Google once, so Trusty Squire can sign in to websites and APIs for you hands-free.',helper:{machineId:'machine',name:'squire'},status:'connecting',createdAt:1,intent:'reconnect',provider:'google',connectorId:'squire:machine'};
      root.render(<ConnectorOfferCard message={{id:'card',text:'',timestamp:1,connectorOffer:offer}} viewerIsAgent={false} viewerPubkey='owner' actionId={null} onAccept={()=>{}} onOpenWorkbench={()=>{}}
        onContinue={(offerId,connectorType,pairedConnectorId)=>{
          globalThis.__route=connectorOfferCeremonyRoute({workspaceId:'ws',viewerId:'owner',roomId:'room',offerId,connectorType,pairedConnectorId,directSignIn:true});
          result.cardRoute=globalThis.__route.pathname; root.render(<SignIn />);
        }} />);
      setTimeout(()=>document.querySelector('[data-testid="connector-offer-offer-continue"]').click(),100);
      setTimeout(()=>{result.cardError=document.querySelector('[data-testid="signin-card"]')?.textContent; result.cardRetry=!!document.querySelector('[data-testid="signin-retry"]');
        root.unmount(); const settings=createRoot(document.getElementById('root')); globalThis.__route={params:{workspaceId:'ws',viewerId:'owner',connectorId:'trusty-squire',helperId:'machine'}};
        settings.render(<Connect />);
      },16000);
      setTimeout(()=>{result.settingsError=document.querySelector('[data-testid="connect-error"]')?.textContent; result.text=document.getElementById('root').textContent;
        document.getElementById('result').textContent=JSON.stringify(result);},33000);`);
    const base = webProofShims(mobile);
    const result = await runBrowserProof({ entry, mobile, width: 390, head: '<script>window.process={env:{NODE_ENV:"development"}};</script>', budgetMs: 35000,
      ...(process.env.SQUIRE_PROOF_OUT ? { screenshotPath: path.join(process.env.SQUIRE_PROOF_OUT, `squire-${theme}.png`) } : {}),
      shims: { ...base,
        'react-native-unistyles': base['react-native-unistyles'].replace('beelineThemes.obsidian', `beelineThemes.${theme}`),
        'expo-router': `export const useLocalSearchParams=()=>globalThis.__route?.params??{}; export const router={back(){},replace(){},push(route){globalThis.__route=route;}}; export const useRouter=()=>router; export const usePathname=()=>'/';`,
        '@expo/vector-icons': `import React from 'react'; export const Ionicons=props=>React.createElement('span',{'data-icon':props.name});`,
        '@/modal': 'export const Modal={alert(){},confirm:async()=>false};',
        '@/modal/ModalManager': 'export const Modal={alert(){},confirm:async()=>false};',
        '@/sync/storage': `const state={settings:{},localSettings:{}}; export const storage=Object.assign(select=>select(state),{getState:()=>state,subscribe:()=>()=>{}});`,
        '@/sync/persistence': 'export const loadLocalSettings=()=>({}); export const saveLocalSettings=()=>{}; export const loadSettings=()=>({settings:{},version:null});',
        'react-native-view-shot': "export const captureRef=async()=>''; export default {};",
        'react-native-reanimated': `${base['react-native-reanimated']} const builder=new Proxy({},{get:()=>()=>builder}); export const FadeOut=builder; export const FadeIn=builder; export const Layout=builder; export const FadeOutDown=builder; export const FadeInUp=builder; export const FadeOutUp=builder; export const LinearTransition=builder; export const interpolateColor=(_value,_input,output)=>output[output.length-1];`,
        'expo-web-browser': 'export const openBrowserAsync=async()=>({});',
        '@/buzz/latency-route-hook': 'export const useLatencyRouteFrame=()=>{};',
        '@/components/AnimatedOverlay': 'export const AnimatedBlurBackdrop=()=>null;',
        '@/buzz/app-sign-in': 'export const takeAppSignInReturn=async()=>null;',
        '@/buzz/workbench-surface': `export const useSharedWorkbench=()=>({value:{helpers:[{id:'machine',name:'squire',online:true}]},error:null});`,
        '@/buzz/workbench-source': `export const getWorkbenchSource=()=>({readInstallState:()=>new Promise(()=>{}),pairConnector:async()=>({connectorId:'squire:machine'})});`,
        '@/sync/transport/live-connection': 'export const sharedLiveConnection=()=>({register:async()=>()=>{}});',
        '@/sync/client-reset': 'export const subscribeClientReset=()=>()=>{}; export const resetClientState=()=>{}; export const clientResetGeneration=()=>0;',
        '@/sync/transport/monolith-operation': 'export const monolithPhoneOperation=async()=>({});',
      }});
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.result);
    console.info('Reproduction squire-spinner:', output);
    expect(output.cardRoute).toBe('/beeline/settings/workbench/connect-signin');
    expect(output.cardError).toContain('Couldn’t reach Beeline');
    expect(output.cardRetry).toBe(true);
    expect(output.settingsError).toContain('Couldn’t reach Beeline');
    expect(output.text).toContain('Couldn’t reach Beeline');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
