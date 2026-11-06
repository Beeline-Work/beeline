import type { WebSocket } from 'ws';

/** A slow reader loses replaceable updates, never replies or its connection. */
export function phoneLiveOutput(client: WebSocket, maximumBufferedBytes: number, dropped: () => void) {
  const rooms = new Set<string>();
  const streams = new Set<string>();
  let workspace = false;
  let missed = false;
  const drained = () => {
    if (!missed || client.readyState !== client.OPEN || client.bufferedAmount !== 0) return;
    const note = JSON.stringify({ type: 'missed-updates', roomIds: [...rooms], streams: [...streams], workspace });
    missed = false; rooms.clear(); streams.clear(); workspace = false;
    client.send(note, drained);
  };
  return (payload: string): boolean => {
    if (client.readyState !== client.OPEN) return false;
    const frame = JSON.parse(payload);
    const update = frame.t !== 'res' && (typeof frame.roomId === 'string' &&
      !['subscribed', 'cursor', 'reload', 'workspace-cursor'].includes(frame.type) ||
      frame.kind === 'push-part' || frame.kind === 'push-commit');
    if (update && (missed || client.bufferedAmount + Buffer.byteLength(payload) > maximumBufferedBytes)) {
      dropped(); missed = true;
      if (frame.roomId) rooms.add(frame.roomId);
      else if (frame.roomId === '') workspace = true;
      const stream = frame.to?.stream ?? frame.stream;
      if (typeof stream === 'string') streams.add(stream);
      drained();
      // The recovery note owns coverage; keep the projection source listening.
      return true;
    }
    client.send(payload, drained);
    return true;
  };
}
