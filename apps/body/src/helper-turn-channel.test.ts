import { describe, expect, it } from 'vitest';
import { HelperTurnChannel } from './helper-turn-channel.js';

const source = { connectionId: 'connection', epoch: 1 };
describe('HelperTurnChannel', () => {
  it('accepts a large turn request once and >16 turn controls without replay', async () => {
    const frames: Record<string, unknown>[] = [];
    const channel = new HelperTurnChannel(frame => { frames.push(frame); return true; }, () => true);
    channel.negotiate(source);
    const reason = 'turn output '.repeat(30_000);
    const large = channel.request('postAgentTurnReceipt', {agentId:'agent',roomId:'room',requestId:'turn',generationId:'generation',status:'failed',reason});
    expect(frames).toHaveLength(1); expect(Buffer.byteLength(JSON.stringify(frames[0]))).toBeGreaterThan(256*1024);
    expect((frames[0]!.input as {reason:string}).reason).toBe(reason);
    channel.receive({type:'turn-result',requestId:frames[0]!.requestId,result:{id:'ok',createdAt:1}}); await large;
    frames.length = 0;
    const calls = Array.from({length:129},()=>channel.request('acknowledgeAgentCommand',{roomId:'room',commandId:'command',generationId:'generation'}));
    expect(frames).toHaveLength(129);
    for (const frame of frames) channel.receive({type:'turn-result',requestId:frame.requestId,result:{id:'ok',createdAt:1}});
    expect(await Promise.all(calls)).toHaveLength(129);
    channel.suspend();
  });
  it('accepts more than 8,192 legacy turn owners', () => {
    const channel = new HelperTurnChannel(()=>true,()=>true);
    for (let i=0; i<9000; i++) channel.claimedLegacy({roomId:'room',requestId:String(i)});
    expect(channel.isLegacy({roomId:'room',requestId:'8999'})).toBe(true);
  });
});
