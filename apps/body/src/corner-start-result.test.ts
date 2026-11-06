import { afterEach, expect, it, vi } from 'vitest';
import { RoomRuntimeCoordinator } from './room-runtime.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';
const report=RoomRuntimeCoordinator.prototype as unknown as {
  reportCornerStartFailure(this:unknown,cornerId:string,error:unknown):Promise<boolean>;
};
afterEach(()=>vi.restoreAllMocks());
it.each([false,true])('startup failure claims its sources and releases unfinished work (receipt refused: %s)',async refused=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  let commands=[{id:'one',turnRequestId:'request-one',action:'input'},
    {id:'two',turnRequestId:'request-two',action:'resume'}] as AgentCommand[];
  const calls:{name:string;input:Record<string,unknown>}[]=[];
  const api={execute:async(name:string,input:Record<string,unknown>)=>{
    calls.push({name,input});
    if(name==='getAgentCommands'||name==='claimAgentTurn')return {commands};
    if(name==='postAgentTurnReceipt'){
      if(refused)throw new Error('connection changed');
      commands=commands.filter(command=>command.turnRequestId!==input.requestId);
    }
    return {commands};
  }};
  const context={options:{daemonApi:api},agent:{publicKey:'agent'}};
  expect(await report.reportCornerStartFailure.call(context,'corner',new Error('Repository checkout failed'))).toBe(!refused);
  expect(calls.slice(0,2).map(call=>call.name)).toEqual(['getAgentCommands','claimAgentTurn']);
  const claim=calls[1]!.input;
  expect(claim).toMatchObject({roomId:'corner',commandId:'one',generationId:expect.any(String)});
  const receipts=calls.filter(call=>call.name==='postAgentTurnReceipt');
  expect(receipts).toHaveLength(refused?1:2);
  for(const receipt of receipts)expect(receipt.input).toMatchObject({generationId:claim.generationId,status:'failed',reasonKind:'workspace-failure'});
  expect(receipts.map(call=>call.input.requestId)).toEqual(refused?['request-one']:['request-one','request-two']);
  expect(calls.at(-1)).toEqual({name:'releaseAgentTurn',input:{roomId:'corner',generationId:claim.generationId}});
  if(!refused){
    const before=calls.length;
    expect(await report.reportCornerStartFailure.call(context,'corner',new Error('Still unavailable'))).toBe(false);
    expect(calls.slice(before).map(call=>call.name)).toEqual(['getAgentCommands']);
  }
});
