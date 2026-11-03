import { describe, expect, it } from 'vitest';
import { AdmissionOwner } from './private/admission.js';
const roomId='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const request={route:'phone.readRoomTools' as const,input:{roomId,anchor:'a'.repeat(64)}};
function fixture(){
  const owner=new AdmissionOwner({origin:'https://synthetic.test',principal:'reader',sessionEpoch:1});
  owner.focusOwner('Room',1,'Room',[{route:'phone.readRouterSnapshot',input:{family:'room-head',roomId}}]);
  return owner;
}
describe('tool disclosure admission',()=>{
  it('spends one target synchronously and keeps only focused completion authority',()=>{
    const owner=fixture();let saved:unknown;
    const permit=owner.toolTap(1,roomId,request,pass=>{saved=pass;return owner.spend(request,pass);});
    expect(permit.wire.operation).toBe('readRoomTools');expect(JSON.parse(permit.wire.input)).toEqual(request.input);
    expect(permit.isCurrent()).toBe(true);
    expect(()=>owner.spend(request,saved as never)).toThrow('inactive pass');
    owner.blur();expect(permit.isCurrent()).toBe(false);
    expect(()=>owner.toolTap(1,roomId,request,()=>{})).toThrow('inactive tool action');
  });
  it('refuses another Room, generation, background, a forged pass and deferred spending',()=>{
    const owner=fixture();
    expect(()=>owner.toolTap(1,other,request,()=>{})).toThrow();
    expect(()=>owner.toolTap(2,roomId,request,()=>{})).toThrow();
    expect(()=>owner.spend(request,{} as never)).toThrow();
    const pass=owner.toolTap(1,roomId,request,value=>value);
    expect(()=>owner.spend(request,pass)).toThrow('inactive pass');
    owner.background();expect(()=>owner.toolTap(1,roomId,request,()=>{})).toThrow('background');
  });
});
