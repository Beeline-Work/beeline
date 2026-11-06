import { describe, expect, it } from 'vitest';
import { HelperOverlayChannel } from './helper-overlay-channel.js';

const source = { connectionId: 'connection', epoch: 1 };
describe('HelperOverlayChannel', () => {
  it('accepts more than 128 overlay requests', async () => {
    const frames: Record<string, unknown>[] = [];
    const channel = new HelperOverlayChannel(frame=>{frames.push(frame);return true;},()=>true); channel.negotiate(true);
    const frame = {agentId:'agent',roomId:'room',commandId:'command',generationId:'generation',source,revision:1,viewingRevision:1,kind:'snapshot',text:'hi'};
    const calls = Array.from({length:1895},()=>channel.send(frame as never));
    expect(frames).toHaveLength(1895);
    for (const value of frames) channel.receive({type:'overlay-ack',requestId:value.requestId,revision:1,accepted:true});
    expect((await Promise.all(calls)).every(value=>value.accepted)).toBe(true);
  });
});
