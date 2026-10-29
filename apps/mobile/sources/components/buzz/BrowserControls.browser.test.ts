import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { it, expect } from 'vitest';
import { webProofShims } from '@/test/browserProof';
import { captureBrowserControls as runBrowserProof } from '@/test/browserControlsProof';

const baselineRef = process.env.BROWSER_CONTROLS_BASELINE;

// Built production components; only network, navigation and native services are fixtures.
it.skipIf(!process.env.BROWSER_CONTROLS_CHROME_DRIVER).each(['bone', 'obsidian'])('browser controls visual proof: %s', async theme => {
  const mobile = process.cwd();
  const entry = path.join(mobile, 'scripts/browser-controls-proof.jsx');
  const evidence = path.join(mobile, 'evidence/browser-controls');
  mkdirSync(evidence, { recursive: true });
  const server = readFileSync(path.join(mobile, '../server/src/computer-session.ts'), 'utf8');
  const focusCss = server.match(/#focus\{[^}]+\}/)![0] + server.match(/#focus::before\{[^}]+\}/)![0];
  const fonts = ['SpaceGrotesk-Regular', 'SpaceGrotesk-SemiBold', 'IBMPlexMono-Regular'].map(font => `@font-face{font-family:${font};src:url(data:font/ttf;base64,${readFileSync(path.join(mobile, 'sources/assets/fonts', font + '.ttf')).toString('base64')})}`).join('');
  writeFileSync(entry, `import React from 'react'; import {createRoot} from 'react-dom/client';
import {ComputerSessionCard,ComputerSessionViewer} from '@/components/buzz/ComputerSession';
import {publishViewerConversation} from '@/buzz/viewer-conversation';
const query=new URLSearchParams(location.search); const state=query.get('state');
const session={id:'proof',title:'Shared browser',url:'https://example.test/',status:'live',access:'fixture'};
publishViewerConversation({roomId:'proof',messages:[],send:async()=>true});
createRoot(document.getElementById('root')).render(state==='card'?<ComputerSessionCard session={session}/>:<ComputerSessionViewer session={session} roomId="proof" onClose={()=>{}}/>);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{await document.fonts.ready; await wait(500);
const find=id=>document.querySelector('[data-testid="'+id+'"]');
if(state==='expanded') {find('viewer-conversation-toggle').click(); await wait(700);}
if(state==='keyboard') {document.getElementById('focus').click(); await wait(300);}
const pill=find('viewer-conversation-pill');
const output={innerWidth,rect:pill?.getBoundingClientRect().toJSON(),radius:pill?getComputedStyle(pill).borderRadius:null,text:document.body.textContent,keyboardFocused:document.activeElement?.id==='remote-input',expanded:find('viewer-conversation-toggle')?.getAttribute('aria-label')};
if(state==='card'&&query.get('stage')==='after'){find('computer-session-card-open-browser').click();await wait(100);output.external=globalThis.__external;find('computer-session-open').click();await wait(100);output.opened=!!globalThis.__opened;}
document.getElementById('result').textContent=JSON.stringify(output);
})().catch(e=>document.getElementById('result').textContent=String(e.stack));`);
  const base=webProofShims(mobile);
  base['react-native-unistyles']=base['react-native-unistyles'].replace('beelineThemes.obsidian',`beelineThemes.${theme}`);
  Object.assign(base,{
    '@/components/buzz/sandbox-webview':'export const useSandboxWebView=()=>null;',
    '@/sync/transport/monolith-operation':'export const monolithPhoneOperation=async()=>({access:"fresh-fixture"});',
    '@/buzz/desktop-computer-pane':'export const openComputerInDesktopWorkPane=()=>false;',
    '@/modal':'export const Modal={show(){globalThis.__opened=true},alert(){}};',
    '@/utils/open-external-url':'export const openExternalUrl=async url=>{globalThis.__external=url};',
    'expo-image':'export const Image=()=>null;',
    'expo-clipboard':'export const getStringAsync=async()=>"";export const setStringAsync=async()=>{};',
    'expo-router':'export const router={push(){},navigate(){}}; export const useRouter=()=>router;',
    '@/buzz/speech-input':'export const useSpeechInput=()=>({capability:"available",state:"idle",partialText:"",volumeLevel:0,modelDownloadOffered:false,start:async()=>{},stop:async()=>{},cancel:async()=>{}});',
    './VoiceBar':'export const VoiceBar=()=>null;export const VoiceAgentStrip=()=>null;',
    '@/buzz/client-error-report':'export const reportClientError=async()=>{};',
  });
  const head=`<style>${fonts}#result{display:none}body{background:${theme==='bone'?'#F3EEE4':'#14091A'}}#root{height:100vh}[data-testid="computer-session-viewer"]{height:100%}${focusCss}#focus{position:fixed;right:12px;bottom:12px;z-index:10}#remote-input{position:fixed;z-index:10;left:16px;bottom:16px;width:180px}iframe{visibility:hidden}@media(pointer:fine){#focus{display:none}}</style>`;
  try { for(const stage of [...(baselineRef ? ['before'] : []), 'after']) for(const width of [390,1200]) for(const state of ['card','collapsed','expanded',...(width<600?['keyboard']:[])]) {
    const shims={...base};
    if(stage==='before') for(const name of ['ComputerSession','ViewerConversationDock']) {
      shims[`@/components/buzz/${name}`]=execFileSync('git',['show',`${baselineRef}:apps/mobile/sources/components/buzz/${name}.tsx`],{encoding:'utf8'}).replaceAll("from './", "from '@/components/buzz/");
    }
    const keyboard=state==='card'?'':`<input id="remote-input" aria-label="Remote keyboard input"><button id="focus" aria-label="Open keyboard" onclick="document.getElementById('remote-input').focus()"></button>`;
    const proof=await runBrowserProof({mobile,entry,shims,width,height:844,head:head+keyboard,query:`?state=${state}&stage=${stage}`,screenshotPath:path.join(evidence,`${stage}-${theme}-${width}-${state}.png`)});
    expect(proof.status,proof.stderr).toBe(0);
    const result=JSON.parse(proof.result);
    expect(result.innerWidth).toBe(width);
    if(state==='expanded') {expect(result.rect.left).toBeGreaterThanOrEqual(0);expect(result.rect.width).toBeGreaterThan(44);}
    if(state!=='card') expect(result.radius).toBe(stage==='after'?'14px':'3px');
    if(state==='expanded') expect(result.expanded).toBe('Collapse conversation');
    if(state==='keyboard') expect(result.keyboardFocused).toBe(true);
    if(state==='card'&&stage==='after') {
      expect(result.text).toContain('Open in browser');
      expect(result.external).toBe('https://example.test/?access=fresh-fixture');
      expect(result.opened).toBe(true);
    }
  }} finally { unlinkSync(entry); }
},180000);
