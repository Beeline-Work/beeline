import type { CommandActivationInput } from '@beeline/api-contract/helper-activation';
import { routeCodecs } from './route-codecs.js';
const codecs=routeCodecs('daemon.readCommandActivation');
const fields={agentId:true,workspaceId:true,roomId:true,commandId:true,generationId:true,source:true} as const satisfies Record<keyof CommandActivationInput,true>;
const sourceFields={connectionId:true,epoch:true} as const;
/** One private setup route only, exported solely to the two existing owned
 * machine adapters. This never exposes the generic route registry. */
export const helperActivationCodecs=Object.freeze({
  params:Object.freeze({parse(value:unknown):CommandActivationInput{
    const parsed=codecs.params.parse(value);
    if(Object.keys(parsed).some(key=>!Object.hasOwn(fields,key))||Object.keys(parsed.source).some(key=>!Object.hasOwn(sourceFields,key)))
      throw new Error('Activation unknown input field');
    return parsed;
  }}),
  result:codecs.result,
});
