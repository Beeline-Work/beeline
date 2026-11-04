import { HelperOverlayChannel } from './helper-overlay-channel.js';
import { describe, expect, it, vi } from 'vitest';
import type { HelperOverlayAck, HelperOverlayDemand, HelperOverlayFrame } from '@beeline/api-contract/helper-overlay';
import { HelperOverlayOwner, type HelperOverlayTransport } from './helper-overlay.js';
const identity={agentId:'agent',roomId:'room',commandId:'command',turnId:'turn',turnGeneration:'turn-generation',kind:'draft' as const};
function fixture(){
  let listener!:(demand:HelperOverlayDemand)=>void;
  const send=vi.fn(async(frame:HelperOverlayFrame):Promise<HelperOverlayAck>=>({accepted:true,revision:frame.revision}));
  const transport:HelperOverlayTransport={enabled:()=>true,send,subscribe:(_room,receive)=>{listener=receive;return vi.fn();}};
  const owner=new HelperOverlayOwner(identity,transport);
  const demand=(viewing:boolean,revision:number)=>listener({v:1,roomId:'room',viewing,viewingRevision:revision});
  return {owner,send,demand};
}
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
describe('negotiated helper overlay owner',()=>{
  it('uploads zero tokens without viewers and sends a fresh baseline on actual viewing activation',async()=>{
    const {owner,send,demand}=fixture();
    for(let i=0;i<100;i++)owner.update('x'.repeat(i));
    await settle();expect(send).not.toHaveBeenCalled();
    demand(true,1);await settle();expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({type:'baseline',offset:0,text:'x'.repeat(99),viewingRevision:1});
    owner.update('x'.repeat(100));await settle();expect(send.mock.calls[1]?.[0]).toMatchObject({type:'append',offset:99,text:'x'});
    demand(false,2);owner.update('retained locally');await settle();expect(send).toHaveBeenCalledTimes(2);
    demand(true,3);await settle();expect(send.mock.calls[2]?.[0]).toMatchObject({type:'baseline',offset:0,text:'retained locally',viewingRevision:3});
    await owner.close();
  });
  it('measures append offsets in UTF-8 bytes and replaces rewritten values',async()=>{
    const {owner,send,demand}=fixture();owner.update('🌍');demand(true,1);await settle();
    owner.update('🌍é');await settle();expect(send.mock.calls[1]?.[0]).toMatchObject({type:'append',offset:4,text:'é'});
    owner.update('new answer');await settle();expect(send.mock.calls[2]?.[0]).toMatchObject({type:'replace',offset:0,text:'new answer'});
    await owner.close();
  });
  it('keeps one upload in flight and one latest local value across a run reset',async()=>{
    const {owner,send,demand}=fixture();let release!:(ack:HelperOverlayAck)=>void;
    send.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    owner.update('old');demand(true,1);await settle();
    for(let i=0;i<100;i++)owner.update('old'+'x'.repeat(i));
    expect(send).toHaveBeenCalledTimes(1);owner.beginRun();owner.update('fresh run');
    release({accepted:true,revision:1});await settle();
    expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1]?.[0]).toMatchObject({type:'baseline',runGeneration:1,text:'fresh run'});
    await owner.close();owner.update('late');await settle();expect(send).toHaveBeenCalledTimes(3);
  });
  it('does not retry a failed frame when time passes or an identical demand repeats',async()=>{
    const {owner,send,demand}=fixture();send.mockResolvedValueOnce({accepted:false,reason:'gap'});
    owner.update('text');demand(true,1);await settle();demand(true,1);await settle();expect(send).toHaveBeenCalledTimes(1);
    demand(true,2);await settle();expect(send.mock.calls[1]?.[0]).toMatchObject({type:'baseline',viewingRevision:2});await owner.close();
  });
  it('bounds serialized escaped frames including the real transport envelope',async()=>{
    const write=vi.fn(()=>true),channel=new HelperOverlayChannel(write,()=>true);channel.negotiate(true);
    const ack=await channel.send({...identity,v:1,runGeneration:0,type:'baseline',revision:1,offset:0,
      text:'\u0000'.repeat(50_000),viewingRevision:1});
    expect(ack).toEqual({accepted:false,reason:'unavailable'});expect(write).not.toHaveBeenCalled();channel.suspend();
  });

});
