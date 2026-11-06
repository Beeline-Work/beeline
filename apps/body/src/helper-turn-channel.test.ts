import {expect,it,vi} from 'vitest';
import {HelperTurnChannel} from './helper-turn-channel.js';
const source={connectionId:'connection',epoch:1};
const turn={roomId:'room',requestId:'request',generationId:'generation'};
it('retains the current connection owner until authenticated replacement and cancels it once',async()=>{
  const channel=new HelperTurnChannel(),lost=vi.fn();channel.negotiate(source);channel.claimed(turn,source,lost);
  await expect(channel.runOwned(turn,async()=>'running')).resolves.toBe('running');
  channel.negotiate(source);expect(lost).not.toHaveBeenCalled();
  channel.negotiate({connectionId:'replacement',epoch:2});channel.negotiate({connectionId:'replacement',epoch:2});
  expect(lost).toHaveBeenCalledOnce();await expect(channel.runOwned(turn,async()=>'stale')).rejects.toThrow('ownership ended');
});
it('rejects an unclaimed generation and ends owned work on explicit stop',async()=>{
  const channel=new HelperTurnChannel(),lost=vi.fn();channel.negotiate(source);
  await expect(channel.runOwned(turn,async()=>'unclaimed')).rejects.toThrow('not admitted');
  channel.claimed(turn,source,lost);channel.stop();expect(lost).toHaveBeenCalledOnce();
});
it('does not revive a released generation or change its owner',async()=>{
  const channel=new HelperTurnChannel();channel.negotiate(source);channel.claimed(turn,source,()=>{});
  expect(()=>channel.claimed(turn,{connectionId:'other',epoch:2},()=>{})).toThrow('cannot change owner');
  channel.release(turn);expect(()=>channel.claimed(turn,source,()=>{})).toThrow('already ended');
});
