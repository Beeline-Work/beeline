# Disposable native40 fixture source

These files are proof inputs, never production entrypoints. Restore them only into a task-owned scratch path under the mobile project. The byte-cache probe uses explicit authorization stand-ins; the ComputerSession probe replaces metadata, modal fallback and authenticated conversation-dock adapters. All endpoints are isolated loopback fixtures.

## `byte-probe.tsx`

```tsx
import React,{useEffect,useState} from 'react';
import {Text,View} from 'react-native';
import {Image} from 'expo-image';
import {cacheDirectory,getInfoAsync,readDirectoryAsync} from 'expo-file-system/legacy';
import {createArtifactByteStore} from '../../sources/buzz/artifact-byte-store';
import {bytesToBase64} from '../../sources/buzz/byte-base64';
import {ImmutableByteCache} from '../../sources/buzz/immutable-byte-cache';
const root='http://10.0.2.2:58542';
const address={origin:root,principal:'synthetic-no-account',objectId:'00000000-0000-4000-8000-000000000001',version:'synthetic-v1'};
export function ByteProbe({scenario,report}:{scenario:string;report:(value:unknown)=>void}){
 const [uri,setUri]=useState<string|null>(null);const [status,setStatus]=useState('running');
 useEffect(()=>{let live=true;void(async()=>{
  const store=createArtifactByteStore(()=>({format:'png'}));await store.clear();
  if(scenario==='cache'){
   const cache=new ImmutableByteCache(store);let loads=0;
   const load=async(signal:AbortSignal)=>{loads++;const response=await fetch(root+'/bytes/shared',{signal});return new Uint8Array(await response.arrayBuffer());};
   const demand={restoreAuthorized:true,reuseAuthorized:true,isCurrent:()=>live};
   const values=await Promise.all([cache.get(address,load,demand),cache.get(address,load,demand),cache.get(address,load,demand)]);
   const local=await store.localUri(cache.key(address));if(live)setUri(local);
   report({kind:'shared-cache',loads,sizes:values.map(value=>value.byteLength),localFile:local?.startsWith('file://'),diagnostics:cache.diagnostics()});
   const cold=new ImmutableByteCache(store);const restored=await cold.get(address,async()=>{throw new Error('unexpected cold read');},demand);
   report({kind:'cold-restore',bytes:restored.byteLength,loads});
   const parallel=Array.from({length:8},(_,index)=>cache.get({...address,objectId:'parallel-'+index},async(signal)=>{
    const response=await fetch(root+'/bytes/parallel/'+index,{signal});return new Uint8Array(await response.arrayBuffer());
   },demand));
   await Promise.all(parallel);report({kind:'parallel-done',diagnostics:cache.diagnostics()});
   await cache.purge();report({kind:'purged',uri:await store.localUri(cache.key(address))});
  }else{
   const bytes=new Uint8Array(25*1024*1024);let max=0;
   const encodeStart=performance.now();const encodedLength=bytesToBase64(bytes).length;report({kind:'sync-base64',bytes:bytes.length,encodedLength,elapsedMs:performance.now()-encodeStart});
   let previous=performance.now(),maxRafGapMs=0,frames=0,sampling=true;
   const sample=(now:number)=>{if(!sampling)return;maxRafGapMs=Math.max(maxRafGapMs,now-previous);previous=now;frames++;requestAnimationFrame(sample);};
   requestAnimationFrame(sample);
   const measure=async(label:string,start:number)=>{let total=0;for(const file of await readDirectoryAsync(cacheDirectory+'beeline-immutable-bytes-v1/')){const info=await getInfoAsync(cacheDirectory+'beeline-immutable-bytes-v1/'+file);if(info.exists&&!info.isDirectory&&'size'in info)total+=info.size;}max=Math.max(max,total);report({kind:'disk-write',label,elapsedMs:Date.now()-start,residentBytes:total});};
   for(let i=0;i<5;i++){const start=Date.now();await store.set('key-'+i,bytes);await measure('key-'+i,start);}
   let start=Date.now();await store.set('key-0',bytes);await measure('replacement',start);
   start=Date.now();await store.set('small',new Uint8Array(4*1024*1024));await measure('small',start);
   let rejected=false;try{await store.set('oversized',new Uint8Array(25*1024*1024+1));}catch{rejected=true;}
   await new Promise(resolve=>requestAnimationFrame(resolve));sampling=false;report({kind:'frame-pacing',maxRafGapMs,frames});
   report({kind:'disk-complete',maxResidentBytes:max,limitBytes:128*1024*1024,oversizeRejected:rejected,evictedOldest:await store.localUri('key-1')===null});
   await store.clear();report({kind:'disk-cleared'});
  }
  if(live)setStatus('complete');
 })().catch(error=>{report({kind:'probe-error',message:String(error)});if(live)setStatus('failed');});return()=>{live=false;};},[scenario]);
 return <View style={{flex:1,backgroundColor:'white'}}><Text>NATIVE40 {scenario} {status}</Text>{uri?<Image source={{uri}} style={{width:160,height:160}} onLoad={()=>report({kind:'native-image-load',localFile:true})} onError={event=>report({kind:'native-image-error',message:event.error})}/>:null}</View>;
}

```

## `computer-probe.tsx`

```tsx
import React,{useEffect,useRef,useState} from 'react';
import {FlatList,Text,View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {publishViewerConversation,removeViewerConversation} from '../../sources/buzz/viewer-conversation';
import {observeArtifactRows,setArtifactViewportActive} from '../../sources/buzz/artifact-viewport';
const session={id:'fixture-session',title:'Native40 browser fixture',url:'http://10.0.2.2:58542/browser',status:'live' as const,access:undefined};
const rows=[{id:'spacer'},{id:'native40-message'}];
export function ComputerProbe({report}:{report:(value:unknown)=>void}){
 const [components,setComponents]=useState<any>(null);
 const viewability=useRef(({viewableItems}:any)=>{const ids=viewableItems.filter((value:any)=>value.isViewable&&value.item.id==='native40-message').map((value:any)=>value.item.id);observeArtifactRows('native40-room',ids);report({kind:'computer-viewport',visible:ids.length>0});}).current;
 useEffect(()=>{publishViewerConversation({roomId:'native40-room',messages:[],send:async()=>false});setArtifactViewportActive('native40-room',true);void import('../../sources/components/buzz/ComputerSession').then(setComponents).catch(error=>report({kind:'computer-error',message:String(error)}));return()=>{setArtifactViewportActive('native40-room',false);removeViewerConversation('native40-room');};},[]);
 if(!components)return <Text>Loading actual browser component</Text>;
 const {ComputerSessionCard,WarmComputerSessionHost}=components;
 return <SafeAreaProvider style={{flex:1}}><View style={{flex:1}}><Text>NATIVE40 actual browser visibility</Text><FlatList data={rows} initialNumToRender={2} keyExtractor={item=>item.id} onViewableItemsChanged={viewability} renderItem={({item})=>item.id==='spacer'?<View style={{height:1200}}/>:<ComputerSessionCard session={session} roomId="native40-room" messageId="native40-message"/>}/><WarmComputerSessionHost/></View></SafeAreaProvider>;
}

```

## `dock-adapter.tsx`

```tsx
/** The authenticated conversation composer is outside this browser-stream probe. */
export const ViewerConversationDock=()=>null;

```

## `entry.tsx`

```tsx
import 'react-native-get-random-values';
import './theme-init';
import React,{useEffect,useRef,useState} from 'react';
import {registerRootComponent} from 'expo';
import {View,Text,Linking} from 'react-native';
import {ByteProbe} from './byte-probe';
import {ComputerProbe} from './computer-probe';
import {loadPdfViewerDocument,ARTIFACT_PDF_BASE_URL} from '../../sources/buzz/artifact-pdf';
import * as Updates from 'expo-updates';
import {wrapArtifactMarkup,createInitialLoadGuard} from '../../sources/buzz/artifact';
import {artifactWebViewProps} from '../../sources/components/buzz/artifact-webview';
const root='http://10.0.2.2:58542';
const stamp='native40-artifact-source-3465f9ec';
const PDF_BASE64="JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNTIgPj4Kc3RyZWFtCkJUIC9GMSAyOCBUZiA3MCA3MDAgVGQgKE5BVElWRTQwIFBERiBSRU5ERVJFRCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxMwolJUVPRgo=";
function report(value:unknown){console.log('NATIVE40_PROOF',JSON.stringify(value));void fetch(root+'/report',{method:'POST',body:JSON.stringify(value)}).catch(()=>{});}
function App(){
 const [Web,setWeb]=useState<React.ComponentType<any>|null>(null);
 const [scenario,setScenario]=useState('pending');
 const guard=useRef(createInitialLoadGuard());
 const [pdf,setPdf]=useState<string|null>(null);
 useEffect(()=>{if(scenario==='pdf'){guard.current=createInitialLoadGuard(ARTIFACT_PDF_BASE_URL);void loadPdfViewerDocument({pdfBase64:PDF_BASE64,mode:'viewer',signalRendered:true}).then(setPdf).catch(error=>report({kind:'pdf-error',message:String(error)}));}},[scenario]);
 useEffect(()=>{void Promise.all([import('react-native-webview'),Linking.getInitialURL()]).then(([mod,url])=>{const name=url?.split('/').at(-1)||'sandbox';setScenario(name);setWeb(()=>mod.WebView);report({kind:'start',stamp,scenario:name,runtime:Updates.runtimeVersion,embedded:Updates.isEmbeddedLaunch,emergency:Updates.isEmergencyLaunch});});},[]);
 if(scenario==='computer')return <ComputerProbe report={report}/>;
 if(scenario==='cache'||scenario==='disk')return <ByteProbe scenario={scenario} report={report}/>;
 if(!Web||scenario==='pending')return <View><Text>Loading renderer</Text></View>;
 const payload=`<img src="${root}/egress/${scenario}/image"><html><head><style>body{font-size:28px;background:white;color:black}p{color:rgb(12,34,56)}</style><meta http-equiv="refresh" content="0;url=${root}/egress/${scenario}/refresh"><link rel="stylesheet" href="${root}/egress/${scenario}/style"></head><body><p>NATIVE40 INERT CONTENT</p><iframe src="${root}/egress/${scenario}/frame"></iframe><form action="${root}/egress/${scenario}/form"><button>Forbidden form</button></form><script>setInterval(()=>fetch('${root}/egress/${scenario}/poll'),50)</script></body></html>`;
 const html=wrapArtifactMarkup(payload,'html');
 if(scenario==='pdf'){if(!pdf)return <Text>Loading PDF renderer</Text>;const props=artifactWebViewProps({source:{html:pdf,baseUrl:ARTIFACT_PDF_BASE_URL},guard:guard.current,javaScript:true,scrollEnabled:true});return <View style={{flex:1}}><Text>{stamp} PDF</Text><Web {...props} style={{flex:1}} onShouldStartLoadWithRequest={(request:any)=>{if(request.url.startsWith('beeline-artifact://pdf-rendered'))report({kind:'pdf-rendered'});return (props.onShouldStartLoadWithRequest as any)(request);}} onError={(event:any)=>report({kind:'pdf-error',message:event.nativeEvent.description})}/></View>;}
 const props=scenario==='control'?{source:{html},javaScriptEnabled:false,originWhitelist:['*'],onShouldStartLoadWithRequest:(request:{url:string})=>guard.current.allow(request.url)}:artifactWebViewProps({source:{html},guard:guard.current,scrollEnabled:true});
 return <View style={{flex:1,backgroundColor:'white'}}><Text>{stamp} {scenario}</Text><Web {...props} style={{flex:1}} onLoadStart={()=>{report({kind:'load-start',scenario});const end=Date.now()+1500;while(Date.now()<end){};}} onLoadEnd={()=>report({kind:'load-end',scenario})} onError={(event:any)=>report({kind:'error',scenario,error:event.nativeEvent.description})}/></View>;
}
registerRootComponent(App);

```

## `metadata-adapter.ts`

```ts
export async function monolithPhoneOperation(operation:string,args:unknown){if(operation!=='openComputerSession')throw new Error('Unexpected fixture operation');const response=await fetch('http://10.0.2.2:58542/session/metadata',{method:'POST',body:JSON.stringify({operation,args})});return response.json();}

```

## `modal-adapter.ts`

```ts
export const Modal={show(){throw new Error('Unexpected modal fallback in native warm-host proof');},alert(title:string){console.log('NATIVE40_PROOF_ALERT',title);}};

```

## `theme-init.ts`

```ts
import {StyleSheet} from 'react-native-unistyles';
import {boneTheme,obsidianTheme,boneSmallTheme,boneLargeTheme,obsidianSmallTheme,obsidianLargeTheme} from '../../sources/theme';
StyleSheet.configure({themes:{bone:boneTheme,obsidian:obsidianTheme,boneSmall:boneSmallTheme,boneLarge:boneLargeTheme,obsidianSmall:obsidianSmallTheme,obsidianLarge:obsidianLargeTheme},settings:{initialTheme:'bone'}});

```

## `metro.cjs`

Use `EXPO_OVERRIDE_METRO_CONFIG` with `expo export:embed`; its `--config` flag does not select this Metro override.

```js
const path = require('node:path');
const mobile = path.resolve(__dirname, '../..');
const proof = process.env.NATIVE40_PROOF_ROOT;
if (!proof) throw new Error('A task-owned proof root is required');
const config = require(path.join(mobile,'metro.config.js'));
const {FileStore}=require(path.join(mobile,'node_modules/metro-cache'));
config.cacheStores=[new FileStore({root:path.join(proof,'cache/metro')})];
config.cacheVersion += '-native40-proof-v2';
config.watchFolders.push(proof);
const oldResolve=config.resolver.resolveRequest;
const aliases={'@/sync/transport/monolith-operation':'metadata-adapter.ts','@/modal':'modal-adapter.ts','@/components/buzz/ViewerConversationDock':'dock-adapter.tsx'};
const canonical={'/sources/sync/transport/monolith-operation.ts':'metadata-adapter.ts','/sources/modal/index.ts':'modal-adapter.ts','/sources/modal/index.tsx':'modal-adapter.ts','/sources/components/buzz/ViewerConversationDock.tsx':'dock-adapter.tsx'};
config.resolver.resolveRequest=(ctx,name,platform)=>{const result=oldResolve(ctx,name,platform);const replacement=aliases[name]||canonical[result.filePath?.slice(mobile.length)];return replacement?{type:'sourceFile',filePath:path.join(mobile,'scripts/network-native40-proof',replacement)}:result;};
module.exports=config;

```

## `fixture-server.mjs`

The server requires a synthetic 80×80 PNG at `$NATIVE40_PROOF_ROOT/bin/fixture.png`. Never expose this test server outside its private network namespace.

```js
import {createServer} from 'node:http';
import fs from 'node:fs';
import {WebSocketServer} from 'ws';
const root=process.env.NATIVE40_PROOF_ROOT;
const log=root+'/evidence/http.ndjson';
let active=0;const server=createServer((req,res)=>{if(req.url.startsWith('/browser')){fs.appendFileSync(log,JSON.stringify({at:Date.now(),kind:'browser-http',path:new URL(req.url,'http://fixture').pathname,warm:req.url.includes('warm=1'),preview:req.url.includes('preview=1')})+'\n');res.setHeader('Content-Type','text/html');res.end(`<!doctype html><body><p>NATIVE40 EXPLICIT BROWSER</p><script>const wire=new WebSocket('ws://'+location.host+'/browser/stream'+location.search);const send=value=>window.ReactNativeWebView?.postMessage(JSON.stringify(value));wire.onopen=()=>send({type:'computer-first-frame',id:'fixture-session'});addEventListener('message',event=>{if(event.data?.type==='viewer-snapshot-request')send({type:'computer-snapshot',id:'fixture-session',requestId:event.data.requestId,image:'${fs.readFileSync(root+'/bin/fixture.png').toString('base64')}'});});</script></body>`);return;}if(req.url.startsWith('/bytes/')){const parallel=req.url.includes('/parallel/');const bytes=parallel?Buffer.alloc(65536):fs.readFileSync(root+'/bin/fixture.png');active++;fs.appendFileSync(log,JSON.stringify({at:Date.now(),method:req.method,path:req.url,kind:'byte-start',active})+'\n');const finish=()=>{res.setHeader('Content-Type',parallel?'application/octet-stream':'image/png');res.end(bytes);active--;fs.appendFileSync(log,JSON.stringify({at:Date.now(),path:req.url,kind:'byte-end',active})+'\n');};if(parallel)setTimeout(finish,250);else finish();return;}let body='';req.on('data',b=>body+=b);req.on('end',()=>{fs.appendFileSync(log,JSON.stringify({at:Date.now(),method:req.method,path:req.url,body:body.slice(0,16384)})+'\n');res.setHeader('Content-Type',req.url==='/session/metadata'?'application/json':'text/plain');res.end(req.url==='/session/metadata'?JSON.stringify({access:'fixture.9999999999999.synthetic'}):req.url.startsWith('/egress/')?'UNEXPECTED EGRESS':'ok');});});
let browserActive=0;const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,wire=>{browserActive++;fs.appendFileSync(log,JSON.stringify({at:Date.now(),kind:'browser-open',active:browserActive,warm:req.url.includes('warm=1')})+'\n');wire.on('close',()=>{browserActive--;fs.appendFileSync(log,JSON.stringify({at:Date.now(),kind:'browser-close',active:browserActive})+'\n');});}));
server.listen(58542,'0.0.0.0',()=>console.log('synthetic loopback fixture ready'));

```
