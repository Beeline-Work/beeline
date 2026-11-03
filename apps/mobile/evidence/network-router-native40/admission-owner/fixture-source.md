# Native admission fixture source

These inputs replace only the isolated fixture entry and synthetic identity/config boundaries. Production owner, metadata connection, store, digest and cache come from the recorded checkout.

## entry.tsx

```tsx
import 'react-native-get-random-values';
import React,{useEffect,useState} from 'react';
import {registerRootComponent} from 'expo';
import {Text,View} from 'react-native';
import * as Updates from 'expo-updates';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex,utf8ToBytes} from '@noble/hashes/utils.js';
import {readArtifactObject,artifactObjectLocalUri,subscribeArtifactBytesPurge} from '@/buzz/artifact-byte-owner';
import {installMediaCacheConnection,installLegacyMediaCacheConnection,suspendMediaCacheConnection,receiveMediaAuthorityRemoval} from '@/buzz/media-cache-connection';
const bytes=new Uint8Array([17,23,42]);
const digest=bytesToHex(sha256(bytes));
const id='c1111111-1111-4111-8111-111111111111';
const attachment={url:`/v1/media/${id}`,name:'fixture.png',mimeType:'image/png',size:3,kind:'artifact' as const};
let generation=0;
let metadataReads=0;
function metadata(size=3){const scopes=[{authorityScope:`object:${id}`,epoch:'1'}];return {objectId:id,sha256:digest,size,mimeType:'image/png',expiresAt:Date.now()+60000,authority:{scopes,digest:bytesToHex(sha256(utf8ToBytes(JSON.stringify(scopes))))}};}
function install(size=3){installMediaCacheConnection({generation:++generation,mediaMetadataV1:true,executeMetadata:async()=>{metadataReads++;return metadata(size);}});}
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw Error(message);}
async function rejected(action:()=>Promise<unknown>,fragment:string){try{await action();}catch(error){assert(String(error).includes(fragment),`wrong rejection: ${error}`);return;}throw Error(`accepted ${fragment}`);}
function report(value:unknown){console.log('NATIVE40_OWNER',JSON.stringify(value));}
async function run(){
 report({kind:'start',runtime:Updates.runtimeVersion,embedded:Updates.isEmbeddedLaunch,emergency:Updates.isEmergencyLaunch});
 install();let reads=0;const caps:number[]=[];
 const read=async(_id:string,_signal:AbortSignal,maxBytes:number)=>{reads++;caps.push(maxBytes);return bytes;};
 const values=await Promise.all([readArtifactObject(attachment,read,{preview:true}),readArtifactObject(attachment,read),readArtifactObject(attachment,read)]);
 await readArtifactObject(attachment,read);
 assert(reads===1&&metadataReads===1,'shared completion');
 assert(values.every(value=>value.bytes.length===3&&value.isCurrent()),'current bytes');
 assert((await artifactObjectLocalUri(values[0]!.key)).startsWith('file://'),'native file');
 report({kind:'shared',reads,metadataReads,caps,nativeFile:true});
 suspendMediaCacheConnection();await rejected(()=>readArtifactObject(attachment,read),'awaiting connection');assert(reads===1,'disconnected byte call');
 report({kind:'disconnect',reads});
 installLegacyMediaCacheConnection(++generation);
 await rejected(()=>readArtifactObject({...attachment,size:32768},read,{preview:true}),'bounded preview');
 await rejected(()=>readArtifactObject(attachment,read,{thumbnail:true,preview:true}),'bounded preview');
 assert(reads===1,'oversize preview byte call');
 await readArtifactObject(attachment,read);await readArtifactObject(attachment,read);
 assert(Number(reads)===3,'legacy reused completion');report({kind:'legacy',reads,previewRejected:true});
 install(32768);await rejected(()=>readArtifactObject(attachment,read,{preview:true}),'bounded preview');assert(Number(reads)===3,'metadata size ignored');
 report({kind:'metadata-bound',reads});
 let release!:(value:ReturnType<typeof metadata>)=>void;
 installMediaCacheConnection({generation:++generation,mediaMetadataV1:true,executeMetadata:()=>new Promise(resolve=>{release=resolve;})});
 const abort=new AbortController();const pending=readArtifactObject(attachment,read,{signal:abort.signal});
 // The metadata adapter yields one microtask after the async identity read.
 await Promise.resolve();await Promise.resolve();assert(release,'metadata did not start');abort.abort();release(metadata());
 await rejected(()=>pending,'no longer visible');assert(Number(reads)===3,'canceled metadata started bytes');report({kind:'metadata-cancel',reads});
 install();let purges=0;const stop=subscribeArtifactBytesPurge(attachment,()=>purges++);
 const current=await readArtifactObject(attachment,read);const before=reads;
 receiveMediaAuthorityRemoval(`object:${id}`,'1');assert(purges===1&&!current.isCurrent(),'revocation did not fence');
 await rejected(()=>readArtifactObject(attachment,read),'authority');assert(reads===before,'revoked byte call');stop();
 report({kind:'revocation',purges,reads,current:current.isCurrent()});
 report({kind:'complete'});
}
function App(){const [status,setStatus]=useState('running');useEffect(()=>{void run().then(()=>setStatus('complete')).catch(error=>{report({kind:'failed',message:String(error)});setStatus(String(error));});},[]);return <View style={{padding:60}}><Text>Native40 admission owner: {status}</Text></View>;}
registerRootComponent(App);
```

## identity-adapter.ts

```tsx
export async function loadBuzzIdentity(){return {publicKey:'native40-synthetic-owner'};}
```

## runtime-adapter.ts

```tsx
export function getBuzzRuntimeConfig(){return {monolithUrl:'http://10.0.2.2:58542'};}
```

## Metro fixture resolver

```js

;(() => {
 const old=config.resolver.resolveRequest;
 const {FileStore}=require(path.join(__dirname,'node_modules/metro-cache'));
 config.cacheStores=[new FileStore({root:'<isolated-proof-root>'+'/cache/metro-owner'})];
 config.cacheVersion+='-native40-owner';
 config.resolver.resolveRequest=(ctx,name,platform)=>{
 const result=old(ctx,name,platform);
 const suffix=result.filePath?.slice(__dirname.length);
 const adapter=suffix==='/sources/auth/buzz-identity-storage.ts'?'identity-adapter.ts':suffix==='/sources/buzz/runtime-config.ts'?'runtime-adapter.ts':undefined;
 return adapter?{type:'sourceFile',filePath:path.join(__dirname,'scripts/network-native40-owner',adapter)}:result;
 };
})();
```
