// Standalone visible proof of the shipped Room session, with only network/storage edges replaced.
// node apps/mobile/scripts/reply-recovery-proof.mjs
import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFile } from 'node:fs/promises';
const mobile = path.resolve('apps/mobile');
const output = path.resolve('.scratch/reply-recovery-proof');
mkdirSync(output, { recursive: true });
const mocks = {
  'expo-modules-core': `export const requireOptionalNativeModule=()=>null; export const requireNativeModule=()=>({}); export class EventEmitter {addListener(){return {remove(){}}}}`,
  '@/sync/appConfig': `export const loadAppConfig=()=>({});`,
  'react-native': `export const AppState = {currentState:'active',addEventListener:()=>({remove(){}})}; export const Platform = {OS:'web',select:x=>x.web??x.default};`,
  '@react-native-async-storage/async-storage': `export default {setItem:async()=>{}};`,
  'expo-router': `export const router={replace(){}};`,
  '@/auth/buzz-identity-storage': `export const loadBuzzIdentity=async()=>({publicKey:'viewer',secretKey:new Uint8Array(32)}); export const loadBuzzViewerPubkey=async()=> 'viewer'; export const getEffectiveRelayUrl=async()=>location.origin;`,
  '@/buzz/community-storage': `export const saveActiveCommunityId=async()=>{}; export const saveLastViewedChannel=async()=>{};`,
  '@/buzz/surface-storage': `export const mobileSurfaceCache={read:async()=>null,write:async()=>{},remove:async()=>{}}; export const surfaceAddress=()=> 'proof'; export const createRoomOutbox=()=>({restore:async()=>{},list:()=>[],reconcile:async()=>{},fail:async()=>{},retry:async()=>{},remove:async()=>{}});`,
  '@/buzz/chat-list-store': `export const liveChatList=()=>({current:()=>null,release(){}});`,
  '@/buzz/sentry': `export const captureMobileError=(scope,error)=>{ window.recoveredDiagnostic=error.message; };`,
  '@/sync/transport': `export class BuzzRigTransport { async ensureClient(){return this;} async surfaceSubscribe(filters,emit){this.socket=new WebSocket(location.origin.replace('http','ws')+'/live');this.socket.onmessage=e=>emit({monolithLive:JSON.parse(e.data)});return ()=>this.socket.close();} reconnectLive(){} liveDiagnostics(){return {state:this.socket?.readyState??null,connecting:false};} async reopenChat(){} }`,
  '@/sync/transport/room-view-client': `export class RoomViewHttpError extends Error {} export const isRoomViewTimeoutError=()=>false; export const readPushedMonolithRoom=async()=>null; export class RoomViewClient { async room(){const r=await fetch('/room'+location.search); if(!r.ok)throw new Error('temporary failure'); return r.json();} async markRead(){} }`,
  '@/push/push-room-prefetch': `export const takePrefetchedPushRoom=()=>null;`,
};
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {useRoomSurfaceSession} from './sources/app/(app)/beeline/chat/useRoomSurfaceSession';
function App(){const bindingsRef=React.useRef({resetTranscript(){},restoreOutboxMessages(){},dismissOptimisticMessage(){},observeRoomSurface(){}});
const session=useRoomSurfaceSession({channelId:'proof',bindingsRef}); window.proofSession=session;
const view=session.roomSurface; return React.createElement('main',null,React.createElement('h1',null,'Reply recovery proof'),React.createElement('p',{id:'state'}, view?.latestAgentTurns.some(t=>t.status==='working')?'Working':'Finished'),...(view?.messages??[]).map(m=>React.createElement('p',{key:m.id,'data-message':m.id},m.text)));}
createRoot(document.getElementById('root')).render(React.createElement(App));`;
await build({stdin:{contents:entry,resolveDir:mobile,loader:'tsx'},bundle:true,outfile:path.join(output,'bundle.js'),platform:'browser',mainFields:['browser','module','main'],define:{'process.env.NODE_ENV':'"production"','__DEV__':'false'},plugins:[{name:'proof-edges',setup(api){
api.onResolve({filter:/.*/},args=> mocks[args.path] ? {path:args.path,namespace:'mock'} : undefined);
api.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path],loader:'ts',resolveDir:mobile}));
api.onResolve({filter:/^@\//},args=>{const base=path.join(mobile,'sources',args.path.slice(2));return {path:['','.ts','.tsx','/index.ts'].map(x=>base+x).find(existsSync)??base};});
}}]});
const sessions=new Map();
const server=createServer(async(req,res)=>{
const url=new URL(req.url,'http://localhost');
if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript'); res.end(await readFile(path.join(output,'bundle.js')));return;}
if(url.pathname==='/room'){
const id=url.searchParams.get('case')??'normal'; let state=sessions.get(id); if(!state){state={reads:0,start:Date.now(),complete:false};sessions.set(id,state); setTimeout(()=>{state.complete=true;},100);} state.reads++;
if(id.includes('retry')&&state.reads===2){res.writeHead(503);res.end();return;}
const complete=state.complete; console.log(JSON.stringify({case:id,read:state.reads,elapsedMs:Date.now()-state.start,complete}));
const messages=[{id:'initial',text:'Agent started a long turn.',createdAt:1,author:{pubkey:'viewer',kind:'human',name:'Reviewer'},presentation:'message'}];
if(complete)messages.push({id:'hidden-reply',text:'Long reply recovered without a human send. '.repeat(60),createdAt:2,author:{pubkey:'agent',kind:'agent',name:'Agent'},presentation:'message'});
res.setHeader('Content-Type','application/json');res.end(JSON.stringify({room:{id:'proof',workspaceId:'workspace',name:'Recovery',createdAt:1,updatedAt:2,archived:false},messages,members:[],latestAgentTurns:[{agentPubkey:'agent',requestId:'turn',createdAt:1,status:complete?'complete':'working'}],viewer:{identity:{pubkey:'viewer',kind:'human',name:'Reviewer'},role:'owner',permissions:{send:true,manage:true}},repositoryResolution:{status:'absent'},watchFilters:[{'#h':['proof']}]}));return;}
res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
const sockets=new WebSocketServer({server,path:'/live'});
sockets.on('connection',socket=>socket.send(JSON.stringify({type:'subscribed',roomId:'proof'})));
server.listen(8746,'0.0.0.0',()=>console.log('Proof ready on port 8746'));
