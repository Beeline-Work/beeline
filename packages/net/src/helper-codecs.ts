import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { routeCodecs } from './route-codecs.js';
import type { Codec } from './wire-codec.js';
function closedParams<T extends object>(codec:Codec<T>,fields:Readonly<Record<keyof T,true>>):Codec<T>{
  return Object.freeze({parse(value:unknown):T{
    // Preflight/structural validation rejects getters, exotic objects and
    // oversized values before this adapter examines any caller field names.
    const parsed=codec.parse(value);
    if(Object.keys(parsed).some(key=>!Object.hasOwn(fields,key)))throw new Error('Helper usage unknown input field');
    return parsed;
  }});
}
const publish=routeCodecs('daemon.publishAgentUsageAccount'),attach=routeCodecs('daemon.attachAgentUsageAccount'),post=routeCodecs('daemon.postAgentUsage');
const publishFields={agentId:true,usage:true,revision:true,ownerId:true,source:true} as const satisfies Record<keyof DaemonOperationMap['publishAgentUsageAccount']['input'],true>;
const attachFields={agentId:true,account:true,revision:true,source:true} as const satisfies Record<keyof DaemonOperationMap['attachAgentUsageAccount']['input'],true>;
const postFields={agentId:true,usage:true,usageSource:true} as const satisfies Record<keyof DaemonOperationMap['postAgentUsage']['input'],true>;
/** Restricted transport adapter capability: three exact data-write routes.
 * Feature code cannot obtain a generic route registry or dispatch owner. */
const codecs=Object.freeze({
  publishAgentUsageAccount:Object.freeze({...publish,params:closedParams(publish.params,publishFields)}),
  attachAgentUsageAccount:Object.freeze({...attach,params:closedParams(attach.params,attachFields)}),
  postAgentUsage:Object.freeze({...post,params:closedParams(post.params,postFields)}),
});
export type HelperUsageCodecOperation=keyof typeof codecs;
export function helperUsageCodecs<K extends HelperUsageCodecOperation>(operation:K):typeof codecs[K]{
  if(!Object.hasOwn(codecs,operation))throw new Error('Helper usage route unavailable');
  return codecs[operation];
}
