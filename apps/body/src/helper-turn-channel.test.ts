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

describe('turn continuation', () => {
  it('keeps the active generation through disconnect and re-registers its pending control without a retry tick', async () => {
    vi.useFakeTimers();
    const frames: Record<string, unknown>[] = [];
    let open = true;
    const channel = new HelperTurnChannel(frame => {frames.push(frame);return true;},()=>open);
    const turn = {roomId:'room',requestId:'request',generationId:'generation'};
    const lost = vi.fn();
    try {
      channel.negotiate(source,true,true);
      channel.claimed(turn,source,lost);
      const receipt = channel.request('postAgentTurnReceipt',{agentId:'agent',...turn,status:'complete'});
      open=false; channel.suspend();
      await vi.advanceTimersByTimeAsync(24*60*60*1000);
      expect(lost).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      await expect(channel.runOwned(turn,async()=> 'still running')).resolves.toBe('still running');
      open=true; channel.negotiate(source,true,true);
      expect(frames).toHaveLength(2);
      expect(frames[1]).toEqual(frames[0]);
      channel.receive({type:'turn-result',requestId:frames[1]!.requestId,result:{id:'receipt',createdAt:1}});
      await expect(receipt).resolves.toMatchObject({id:'receipt'});
      expect(lost).not.toHaveBeenCalled();
      // A different helper runtime is a real owner replacement.
      channel.negotiate({connectionId:'replacement',epoch:2},true,true);
      expect(lost).toHaveBeenCalledOnce();
      await expect(channel.runOwned(turn,async()=> 'stale')).rejects.toThrow('ownership ended');
    } finally {channel.stop();vi.useRealTimers();}
  });

  it('reconnects on an unconfirmed control and resolves the same pending command on registration', async () => {
    const frames:Record<string,unknown>[]=[];
    let open=true;
    const lost=vi.fn();
    const reconnect=vi.fn(()=>{open=false;channel.suspend();});
    const channel=new HelperTurnChannel(frame=>{frames.push(frame);return true;},()=>open,reconnect);
    const turn={roomId:'room',requestId:'request',generationId:'generation'};
    channel.negotiate(source,true,true);channel.claimed(turn,source,lost);
    try {
      const control=channel.request('claimAgentCommand',{roomId:'room',commandId:'command',generationId:'generation'});
      channel.receive({type:'turn-result',requestId:frames[0]!.requestId,error:'turn_operation_unconfirmed',status:503});
      expect(reconnect).toHaveBeenCalledOnce();expect(lost).not.toHaveBeenCalled();
      open=true;channel.negotiate(source,true,true);
      expect(frames[1]).toEqual(frames[0]);
      channel.receive({type:'turn-result',requestId:frames[1]!.requestId,result:{id:'command',createdAt:1}});
      await expect(control).resolves.toMatchObject({id:'command'});
    }finally{channel.stop();}
  });

  it('rejects pending controls and ends active work on an explicit runtime stop', async () => {
    const channel = new HelperTurnChannel(()=>true,()=>true);
    const turn = {roomId:'room',requestId:'request',generationId:'generation'};
    const lost = vi.fn();
    channel.negotiate(source,true,true);channel.claimed(turn,source,lost);
    const receipt = channel.request('postAgentTurnReceipt',{agentId:'agent',...turn,status:'complete'});
    channel.stop();
    await expect(receipt).rejects.toThrow('UNKNOWN');
    expect(lost).toHaveBeenCalledOnce();
  });
});
