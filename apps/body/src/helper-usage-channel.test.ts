import { describe, expect, it } from 'vitest';
import { HelperUsageChannel } from './helper-usage-channel.js';

describe('HelperUsageChannel', () => {
  it('accepts >64 usage calls with >256 KiB frames', async () => {
    const frames: Record<string, unknown>[] = [];
    const channel = new HelperUsageChannel(frame=>{frames.push(frame);return true;},()=>true);
    const calls = Array.from({length:129},()=>channel.request('postAgentUsage',{agentId:'agent',usage:{updatedAt:1,windows:[],context:{used:1,size:100},error:'usage '.repeat(50_000)}}));
    expect(frames).toHaveLength(129);
    expect(Buffer.byteLength(JSON.stringify(frames[0]))).toBeGreaterThan(256*1024);
    for (const frame of frames) channel.receive({type:'usage-result',requestId:frame.requestId,result:{id:'ok',createdAt:1}});
    expect(await Promise.all(calls)).toHaveLength(129);
  });
});
