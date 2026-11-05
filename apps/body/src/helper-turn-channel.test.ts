import { describe, expect, it, vi } from 'vitest';
import { HelperTurnChannel } from './helper-turn-channel.js';
import { HELPER_TURN_REQUEST_DEADLINE_MS } from '@beeline/api-contract/helper-turn-ownership';

const source = { connectionId: 'connection', epoch: 1 };
describe('HelperTurnChannel', () => {
  it.each(['deadline', 'send', 'malformed', 'refused', 'disconnect'])('reconnects %s once without replaying controls or cascading socket-loss recovery', async failure => {
    vi.useFakeTimers();
    const frames: Record<string, unknown>[] = [];
    const reconnect = vi.fn(() => channel.suspend());
    const channel = new HelperTurnChannel(frame => { frames.push(frame); return failure !== 'send'; }, () => true, reconnect);
    channel.negotiate(source);
    const first = channel.request('acknowledgeAgentCommand', { roomId: 'room', commandId: 'one', generationId: 'generation' });
    const results = Promise.allSettled([first]);
    try {
      if (failure === 'deadline') await vi.advanceTimersByTimeAsync(HELPER_TURN_REQUEST_DEADLINE_MS);
      else if (failure === 'disconnect') channel.suspend();
      else if (failure !== 'send') channel.receive({ type: 'turn-result', requestId: frames[0]!.requestId,
        ...(failure === 'refused' ? { error: 'unavailable' } : { result: {} }) });
      expect((await results)[0]!.status).toBe('rejected');
      expect(reconnect).toHaveBeenCalledTimes(failure === 'disconnect' ? 0 : 1);
      expect(frames).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(HELPER_TURN_REQUEST_DEADLINE_MS * 2);
      expect(frames).toHaveLength(1);
    } finally { channel.suspend(); vi.useRealTimers(); }
  });

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
