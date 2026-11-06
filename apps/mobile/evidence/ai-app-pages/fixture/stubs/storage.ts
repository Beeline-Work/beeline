import {SurfaceResponseCache} from '@beeline/buzz-client';
import {SurfaceRegistry} from '../../../../sources/buzz/surface-registry';
const values=new Map();
export const mobileSurfaceCache=new SurfaceRegistry(new SurfaceResponseCache({get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v)},remove:async k=>{values.delete(k)} }));
export const surfaceAddress=(relayUrl,viewerId,endpoint,params)=>({relayOrigin:relayUrl,viewerPubkey:viewerId,endpoint,params});
export const restoreStoredSurface=()=>null;
