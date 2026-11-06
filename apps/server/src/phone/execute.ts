import { type PhoneOperationMap } from '@beeline/api-contract/phone';
import type { PhoneContext } from './context.js';
import { Input, Output } from './types.js';
import { phoneExecuteOperation } from './operations.js';



  export async function phoneExecute<Name extends keyof PhoneOperationMap>(ctx: PhoneContext, 
    name: Name, input: Input<Name>, viewerId: string,
    sourceClient?: { id: string; name: string }, familyId?: string,
    deferPostCommitObservation = false,
  ): Promise<Output<Name>> {
    const result = await phoneExecuteOperation(ctx, name, input, viewerId, sourceClient, familyId, deferPostCommitObservation);
    return result;
  }
