import { describe,expect,it,vi } from 'vitest';
import type { CommandActivationInput,CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';
import { CommandActivationContext } from './helper-activation-context.js';
import { MonolithRoomTurnLoop } from './monolith-room-turn.js';
import { MonolithCornerTurnLoop } from './monolith-corner-turn.js';
vi.mock('./agent-home.js',async original=>({...await original<typeof import('./agent-home.js')>(),hostImportedMcpDeclarations:()=>({})}));

describe('actual monolith command setup getters',()=>{
  it.each(['room','corner'] as const)('reuses the complete command cut across %s fingerprint/cold/prompt setup consumers',async kind=>{
    const scope={origin:'https://synthetic.invalid',generation:1,source:{connectionId:'source',epoch:1}};
    const read=vi.fn(async(input:CommandActivationInput):Promise<CommandActivationSnapshot>=>({...input,v:1,capturedAt:100,
      authority:{generation:'a'.repeat(32),revision:1,commandRevision:'b'.repeat(64)},configuration:{fastMode:false,commands:[],yoloMode:false,isReviewer:false},
      roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'},
      ...(kind==='corner'?{corner:{cornerId:'room',objective:'Synthetic setup',closeRequested:false,holds:[]}}:{})}));
    const execute=vi.fn(()=>{throw new Error('Legacy setup route must not run');});
    const loop=Object.create(kind==='room'?MonolithRoomTurnLoop.prototype:MonolithCornerTurnLoop.prototype) as any;
    Object.assign(loop,{agent:{publicKey:'agent'},commandContext:{current:{id:'command'},generationId:'generation'},
      options:{roomId:'room',cornerId:'room',workspaceId:'workspace',config:{operatorHome:'/synthetic/operator-no-credentials'},
        api:{execute,channel:{activationContextSelected:true}}},
      activationContext:new CommandActivationContext({scope:()=>scope,selected:()=>true,read},()=>100)});
    const consume=()=>Promise.all([loop.configuration(),loop.roster(),loop.grantedResources(),loop.repositoryState(),...(kind==='corner'?[loop.restoredState()]:[])]);
    await consume();await consume();await consume();
    expect(read).toHaveBeenCalledTimes(1);expect(execute).not.toHaveBeenCalled();
    loop.commandContext.current={id:'next-command'};await consume();expect(read).toHaveBeenCalledTimes(2);
  });
});
