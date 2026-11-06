import { describe, it, expect, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { phoneLiveOutput } from './phone-live-output.js';

describe('slow phone output', () => {
  it('drops updates and sends one scoped recovery note after drain, retaining replies and pong', () => {
    const completions: Array<() => void> = [];
    const sent: object[] = [];
    const client = { readyState: 1, OPEN: 1, bufferedAmount: 0,
      send: (payload: string, done?: () => void) => { sent.push(JSON.parse(payload)); if (done) completions.push(done); },
      close: vi.fn() };
    const send = phoneLiveOutput(client as unknown as WebSocket, 100, vi.fn());
    send(JSON.stringify({ type: 'invalidate', roomId: 'a', reason: 'message' }));
    client.bufferedAmount = 100;
    send(JSON.stringify({ type: 'invalidate', roomId: 'a', reason: 'message' }));
    send(JSON.stringify({ type: 'invalidate', roomId: 'b', reason: 'message' }));
    send(JSON.stringify({ kind: 'push-commit', to: { stream: 'workspace:w' } }));
    send(JSON.stringify({ t: 'res', id: 'req', ok: false, error: { code: 'unavailable' } }));
    send(JSON.stringify({ type: 'pong' }));
    expect(sent).toHaveLength(3);
    expect(client.close).not.toHaveBeenCalled();
    client.bufferedAmount = 0;
    for (const complete of completions) complete();
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)).toEqual({ type: 'missed-updates', roomIds: ['a', 'b'], streams: ['workspace:w'], workspace: false });
    send(JSON.stringify({ type: 'invalidate', roomId: 'b', reason: 'message' }));
    expect(sent).toHaveLength(5);
    expect(client.close).not.toHaveBeenCalled();
  });
});
