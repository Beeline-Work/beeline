import { describe, expect, it, vi } from 'vitest';
import type { CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';
import { HelperActivationChannel } from './helper-activation-channel.js';
import { HelperTurnChannel } from './helper-turn-channel.js';
import { HelperUsageChannel } from './helper-usage-channel.js';
import { HelperOverlayChannel } from './helper-overlay-channel.js';

const source = { connectionId: 'connection', epoch: 1 };
const identity = { agentId: 'agent', roomId: 'room', workspaceId: 'workspace', commandId: 'command', generationId: 'generation', source };
const snapshot = (text: string): CommandActivationSnapshot => ({ ...identity, v: 1, capturedAt: 100,
  authority: {generation:'a'.repeat(32),revision:1,commandRevision:'b'.repeat(64)},
  configuration: {fastMode:false,commands:[],yoloMode:false,isReviewer:false,soul:{name:'agent',instructions:text}},
  roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'} });

// Hold replies until the burst is admitted; replies use production codecs.
async function drain(frames: Record<string, unknown>[], receive: (frame: Record<string, unknown>) => boolean,
  type: string, result: unknown, count: number) {
  let answered = 0;
  while (answered < count) {
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    for (const frame of frames.splice(0)) {
      receive({type,requestId:frame.requestId,result});
      answered++;
    }
    await Promise.resolve();
  }
}

describe('helper growth and burst recovery', () => {
  it('accepts a >256 KiB setup result and 1,895 activation requests', async () => {
    const frames: Record<string, unknown>[] = [], value = {...snapshot('Rich setup ☃ '.repeat(30_000)),roster:{members:Array.from({length:1895},(_,index)=>({identityId:'agent-'+index,name:'member '+index,kind:'agent' as const,role:'member' as const,detail:Array.from({length:20},()=> 'roster context')}))}};
    const channel = new HelperActivationChannel(frame => { frames.push(frame); return true; }, () => true);
    const big = channel.request(identity);
    await drain(frames, frame => channel.receive(frame), 'activation-context-result', value, 1);
    expect(await big).toEqual(value);
    const calls = Array.from({length:1895}, () => channel.request(identity));
    await vi.waitFor(() => expect(frames).toHaveLength(1895));
    await drain(frames, frame => channel.receive(frame), 'activation-context-result', snapshot('ordinary'), calls.length);
    const results = await Promise.all(calls);
    expect(results).toHaveLength(1895); expect(results.at(-1)).toEqual(snapshot('ordinary'));
  }, 30000);

  it('accepts a large turn request once and >16 turn controls without replay', async () => {
    const frames: Record<string, unknown>[] = [];
    const channel = new HelperTurnChannel(frame => { frames.push(frame); return true; }, () => true);
    channel.negotiate(source);
    const reason = 'turn output '.repeat(30_000);
    const large = channel.request('postAgentTurnReceipt', {agentId:'agent',roomId:'room',requestId:'turn',generationId:'generation',status:'failed',reason});
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames).toHaveLength(1); expect(Buffer.byteLength(JSON.stringify(frames[0]))).toBeGreaterThan(256*1024);
    expect((frames[0]!.input as {reason:string}).reason).toBe(reason);
    channel.receive({type:'turn-result',requestId:frames[0]!.requestId,result:{id:'ok',createdAt:1}}); await large;
    frames.length=0;
    const calls=Array.from({length:129},()=>channel.request('acknowledgeAgentCommand',{roomId:'room',commandId:'command',generationId:'generation'}));
    await drain(frames,frame=>channel.receive(frame),'turn-result',{id:'ok',createdAt:1},calls.length);
    expect(await Promise.all(calls)).toHaveLength(129);
    channel.suspend();
  });

  it('accepts >64 usage calls with >256 KiB frames', async () => {
    const frames: Record<string, unknown>[] = [];
    const channel=new HelperUsageChannel(frame=>{frames.push(frame);return true;},()=>true);
    const calls=Array.from({length:129},()=>channel.request('postAgentUsage',{agentId:'agent',usage:{updatedAt:1,windows:[],context:{used:1,size:100},error:'usage '.repeat(50_000)}}));
    await drain(frames,frame=>channel.receive(frame),'usage-result',{id:'ok',createdAt:1},calls.length);
    expect(await Promise.all(calls)).toHaveLength(129);
  });

  it('accepts >128 overlays and does not exhaust legacy turn ownership after 8,192 completed turns', async () => {
    const frames:Record<string,unknown>[]=[];
    const channel=new HelperOverlayChannel(frame=>{frames.push(frame);return true;},()=>true);channel.negotiate(true);
    const frame={agentId:'agent',roomId:'room',commandId:'command',generationId:'generation',source,revision:1,viewingRevision:1,kind:'snapshot',text:'hi'};
    const calls=Array.from({length:1895},()=>channel.send(frame as never));
    let answered=0;
    while(answered<calls.length){
      await vi.waitFor(()=>expect(frames.length).toBeGreaterThan(0));expect(frames.length).toBe(calls.length);
      for(const value of frames.splice(0)){channel.receive({type:'overlay-ack',requestId:value.requestId,revision:1,accepted:true});answered++;}
    }
    expect((await Promise.all(calls)).every(value=>value.accepted)).toBe(true);
    const turns=new HelperTurnChannel(()=>true,()=>true);
    for(let i=0;i<9000;i++)turns.claimedLegacy({roomId:'room',requestId:String(i)});
    expect(turns.isLegacy({roomId:'room',requestId:'8999'})).toBe(true);
  });
});
