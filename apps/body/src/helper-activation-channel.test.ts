import { describe, expect, it, vi } from 'vitest';
import type { CommandActivationSnapshot } from '@beeline/api-contract/helper-activation';
import { HelperActivationChannel } from './helper-activation-channel.js';

const source = { connectionId: 'connection', epoch: 1 };
const identity = { agentId: 'agent', roomId: 'room', workspaceId: 'workspace', commandId: 'command', generationId: 'generation', source };
const snapshot = (text: string): CommandActivationSnapshot => ({ ...identity, v: 1, capturedAt: 100,
  authority: {generation:'a'.repeat(32),revision:1,commandRevision:'b'.repeat(64)},
  configuration: {fastMode:false,commands:[],yoloMode:false,isReviewer:false,soul:{name:'agent',instructions:text}},
  roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'} });

describe('HelperActivationChannel', () => {
  it('accepts a >256 KiB setup result and 1,895 activation requests', async () => {
    const frames: Record<string, unknown>[] = [];
    const channel = new HelperActivationChannel(frame => { frames.push(frame); return true; }, () => true);
    const value = {...snapshot('Rich setup ☃ '.repeat(30_000)), roster:{members:Array.from({length:1895},(_,index)=>({identityId:'agent-'+index,name:'member '+index,kind:'agent' as const,role:'member' as const,detail:Array.from({length:20},()=> 'roster context')}))}};
    const big = channel.request(identity);
    channel.receive({type:'activation-context-result',requestId:frames[0]!.requestId,result:value});
    expect(await big).toEqual(value);
    frames.length = 0;
    const calls = Array.from({length:1895}, () => channel.request(identity));
    expect(frames).toHaveLength(1895);
    for (const frame of frames) channel.receive({type:'activation-context-result',requestId:frame.requestId,result:snapshot('ordinary')});
    const results = await Promise.all(calls);
    expect(results).toHaveLength(1895); expect(results.at(-1)).toEqual(snapshot('ordinary'));
  });
  it('waits through repeated disconnects and ignores late results from the old registration', async () => {
    vi.useFakeTimers();
    const frames: Record<string, any>[] = [];
    const channel = new HelperActivationChannel(frame => {frames.push(frame); return true;}, () => true);
    let settled = false;
    const read = channel.request(identity).finally(() => {settled = true;});
    const oldRequest = frames[0]!.requestId;
    channel.suspend();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    const source = {connectionId: 'reconnected', epoch: 2};
    channel.resume(source);
    channel.receive({type: 'activation-context-result', requestId: oldRequest, result: snapshot('old')});
    await Promise.resolve();
    expect(settled).toBe(false);
    channel.suspend();channel.resume({...source, epoch: 3});
    const current = frames.at(-1)!;
    channel.receive({type: 'activation-context-result', requestId: current.requestId, result: {...snapshot('current'), source: current.input.source}});
    expect(await read).toMatchObject({source: {connectionId: 'reconnected', epoch: 3}});
    vi.useRealTimers();
  });
  it('ends pending reads when the helper stops or registration definitively loses activation', async () => {
    const channel = new HelperActivationChannel(() => true, () => true);
    const stopped = channel.request(identity);channel.stop();
    await expect(stopped).rejects.toThrow('ended');
    const refused = channel.request(identity);channel.resume(undefined);
    await expect(refused).rejects.toThrow('ended');
  });

});
