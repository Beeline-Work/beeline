import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { webProofShims } from '../../sources/test/browserProof.ts';
const evidence=path.dirname(fileURLToPath(import.meta.url));
const mobile=path.resolve(evidence,'../..');
const source=process.env.ONBOARDING_SOURCE ?? path.join(mobile,'sources');
const output=process.env.ONBOARDING_BUILD ?? '/tmp/jellybean-onboarding-preview';
fs.mkdirSync(output,{recursive:true});
const shims=webProofShims(mobile);
const fixture=`const q=new URLSearchParams(location.search);const screen=q.get('screen');const noop=()=>{};`;
// Native services and server reads are deterministic fixtures; screen and shared-control implementations stay real.
const routes=['app/(app)/beeline/onboarding.tsx','app/(app)/beeline/community.tsx','app/(app)/beeline/create-workspace.tsx','app/(app)/join/[token].tsx','app/(app)/beeline/github-installation.tsx'];
const servicePrefixes=['@/auth/','@/sync/','@/push/','@/buzz/person-name','@/buzz/runtime-config','@/buzz/pending-invite','@/buzz/community-storage','@/buzz/enter-workspace','@/buzz/surface-storage','@/buzz/room-view-presentation','@/buzz/latency-route-hook'];
for(const route of routes){const sf=ts.createSourceFile(route,fs.readFileSync(path.join(source,route),'utf8'),99,true,4);for(const n of sf.statements){if(!ts.isImportDeclaration(n)||!n.importClause||n.importClause.isTypeOnly)continue;const spec=n.moduleSpecifier.text;if(!servicePrefixes.some(p=>spec.startsWith(p)))continue;const names=n.importClause.namedBindings;if(!names||!ts.isNamedImports(names))continue;shims[spec]??=fixture;for(const e of names.elements.filter(e=>!e.isTypeOnly)){const name=e.name.text;if(shims[spec].includes(`export const ${name}=`)||shims[spec].includes(`export class ${name} `))continue;shims[spec]+=`export const ${name}=async()=>null;`;}}}
Object.assign(shims,{
 '@expo/vector-icons':'export const Ionicons=()=>null;',
 'expo-crypto':`export const randomUUID=()=> 'fixture-id';export const getRandomBytes=n=>new Uint8Array(n);`,
 'expo-linking':`export const useURL=()=>null;export const addEventListener=()=>({remove(){}});export const createURL=p=>'beeline://'+p;`,
 'expo-router':`${fixture}export const router={push:noop,replace:noop,back:noop,canGoBack:()=>true};export const Redirect=()=>null;export const useLocalSearchParams=()=>({token:'fixture',mode:q.get('join')?'join':undefined,installed:'1'});`,
 'expo-web-browser':'export const maybeCompleteAuthSession=()=>{};export const openAuthSessionAsync=async()=>({type:"cancel"});',
 '@/utils/isTauri':'export const isTauri=()=>false;',
 '@/auth/account-sign-in-platform':'export const accountSignInAvailable=()=>true;',
 '@/buzz/onboarding-rollout':'export const useRepositoryOnboarding=()=>true;export const readRepositoryOnboardingEligibility=async()=>true;',
 '@/buzz/use-text-draft':`import{useState}from'react';export const useTextDraft=(_,v)=>[...useState(v),{capture:()=>()=>{}}];`,
 '@/buzz/latency-route-hook':'export const useLatencyRouteFrame=()=>{};',
 '@/components/buzz/CommunityRail':`import React from'react';export const BuzzCommunityShell=({children})=><>{children}</>;`,
 '@/buzz/surface-storage':'export const surfaceAddress=()=>"fixture";export const mobileSurfaceCache={read:async()=>null,write:async()=>{}};',
 '@/buzz/room-view-presentation':'export const workspaceRailItem=x=>x;',
 '@/sync/transport':'export class BuzzRigTransport {}',
 '@/sync/transport/monolith-operation':`export const monolithPhoneOperation=async()=>{throw new Error('Offline. Try again.');};`,
 '@/auth/monolith-session':`export class GitHubAccountMismatchError extends Error{};export const monolithSession={identityId:async()=>null};`,
 '@/buzz/community-invite':`export const parseCommunityInviteToken=v=>v||null;export const resolveCommunityInviteRelayUrl=()=> 'https://example.com';`,
 '@/auth/buzz-identity-storage':`${fixture}export const loadBuzzIdentity=async()=>screen?.startsWith('sign-in')?null:{publicKey:'a'.repeat(64)};export const getEffectiveRelayUrl=async()=> 'https://example.com';export const loadPendingGitHubIdentity=async()=>null;export const clearPendingGitHubIdentity=async()=>{};`,
 '@/sync/transport/room-view-client':`${fixture}export class RoomViewHttpError extends Error {status=404};export class RoomViewClient{async workspaces(){return {viewer:{name:'Octo Cat'},workspaces:[]}};async invite(){if(screen==='invite-unavailable')throw new RoomViewHttpError('Invite expired');if(screen==='invite-offline')throw new Error('Offline');return {name:'Northstar Lab',expiresAt:1900000000,memberCount:3,agentCount:2,inviter:{name:'Mara',handle:'mara',role:'owner'}};}}`,
});
shims['@/auth/desktop-auth-session']+=`export const initialAuthUrl=async()=>null;export const subscribeToAuthUrls=()=>({remove(){}});export const openAccountAuthSession=async()=>({type:'cancel'});`;
// Replace generic exports that require synchronous subscription semantics.
shims['@/auth/onboarding-state']=fixture+`export const subscribeToOnboardingFaceStep=()=>noop;export const subscribeToOnboardingNotices=cb=>{if(screen==='sign-in-error')cb({status:'offline',title:'Could not connect',message:'Check your connection and try again.'});return noop};export const isSignInInFlight=()=>false;export const markSignInInFlight=noop;export const clearOnboardingFaceStep=noop;export const clearOnboardingNotice=noop;export const nextOnboardingStatus=()=> 'idle';export const noticeForAuthError=e=>({status:'offline',title:'Could not connect',message:String(e)});export const publishOnboardingFaceStep=noop;export const publishOnboardingNotice=noop;`;
// Keep just one declaration of each generic service export when customizing it above.
for(const key of ['@/auth/desktop-auth-session']){shims[key]=shims[key].replace(/export const (initialAuthUrl|subscribeToAuthUrls|openAccountAuthSession)=async\(\)=>null;/g,'');}
shims['@/auth/desktop-auth-session'] += 'export const initialAuthUrl=async()=>null;';
shims['react-native-reanimated'] += 'export const FadeOut=FadeInDown;export const interpolateColor=(v)=>v;';
shims['react-native-unistyles']=shims['react-native-unistyles'].replace('beelineThemes.obsidian',`beelineThemes[new URLSearchParams(location.search).get('theme')||'obsidian']`);
shims['react-native-safe-area-context']=`import React from'react';import{View}from'react-native';export const SafeAreaProvider=({children})=><View style={{flex:1}}>{children}</View>;export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`;
if(process.env.ONBOARDING_SHIMS)fs.writeFileSync(process.env.ONBOARDING_SHIMS,JSON.stringify(shims));
await build({entryPoints:[path.join(evidence,'preview.tsx')],outfile:path.join(output,'bundle.js'),bundle:true,platform:'browser',jsx:'automatic',mainFields:['browser','module','main'],resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],loader:{'.js':'jsx','.ttf':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"development"','process.env.EXPO_OS':'"web"',__DEV__:'true',global:'globalThis'},plugins:[{name:'proof',setup(api){api.onResolve({filter:/.*/},({path:spec})=>{if(spec in shims)return{path:spec,namespace:'shim'};if(spec==='react-native')return{path:path.join(mobile,'node_modules/react-native-web/dist/index.js')};if(spec.startsWith('@/')){const base=path.join(source,spec.slice(2));return{path:['','.web.tsx','.web.ts','.tsx','.ts','.json','/index.ts','/index.tsx'].map(e=>base+e).find(p=>fs.existsSync(p)&&fs.statSync(p).isFile())};}});api.onLoad({filter:/.*/,namespace:'shim'},({path:spec})=>({contents:shims[spec],loader:'tsx',resolveDir:mobile}));}}]});
let fonts='';for(const name of ['SpaceGrotesk-Regular','SpaceGrotesk-Medium','SpaceGrotesk-SemiBold','IBMPlexMono-Regular'])fonts+=`@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${fs.readFileSync(path.join(mobile,'sources/assets/fonts',name+'.ttf')).toString('base64')})}`;
fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}html,body,#root{height:100%;margin:0}body{background:#14091A}</style><div id="root"></div><script src="bundle.js"></script>`);
console.log(output);
