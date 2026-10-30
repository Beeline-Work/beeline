import { expect, it, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createBeelineServer } from '../../../server/src/server';
import { LiveHub } from '../../../server/src/live';
import { readRoomView, type RoomLiveDelta } from '@beeline/api-contract/phone';
import { SurfaceResponseCache, isRoomView } from '@beeline/buzz-client';
import { SurfaceRegistry } from './surface-registry';
import { cacheRoomMessageDelta } from './cache-room-message-delta';

it('caches the exact small offscreen frame delivered by the server', async () => {
  const roomId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const delta = { type: 'message-delta', roomId, message: { id: 'b'.repeat(64), text: 'new arrival', createdAt: 1, presentation: 'message', author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Agent' } } } as const;
  const live = new LiveHub();
  const server = createBeelineServer({
    database: { query: vi.fn().mockResolvedValue({ rows: [] }), transaction: vi.fn() },
    auth: { authenticatePhone: async () => 'viewer' },
    phone: { canReadRoom: async () => true, canReadRooms: async () => new Set([roomId]), liveDraftSnapshot: async () => [], readLiveDeltas: async () => new Map([['viewer', delta]]) },
    daemon: {}, live, mediaMaximumBytes: 1,
  } as unknown as Parameters<typeof createBeelineServer>[0]);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/live`, ['bearer.phone']);
  const next = (type: string) => new Promise<any>(resolve => {
    const listener = (data: WebSocket.RawData) => { const frame = JSON.parse(data.toString()); if (frame.type === type) { socket.off('message', listener); resolve(frame); } };
    socket.on('message', listener);
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const subscribed = next('subscribed');
    socket.send(JSON.stringify({ type: 'subscribe', roomId, sidebarPreviews: true }));
    await subscribed;
    const frame = next('message-delta');
    live.publish({ type: 'invalidate', roomId, reason: 'message', messageId: delta.message.id });
    const wire = await frame;
    expect(wire).toMatchObject(delta);
    const cache = new SurfaceRegistry(new SurfaceResponseCache({ get: async () => null, set: async () => {}, remove: async () => {} }));
    const address = { relayOrigin: 'https://example.test', viewerPubkey: 'viewer', endpoint: `/room/${roomId}` };
    cache.publish(address, readRoomView({ room: { id: roomId }, messages: [] })!, isRoomView);
    cacheRoomMessageDelta(cache, address, wire as Extract<RoomLiveDelta, { type: 'message-delta' }>);
    expect(cache.peek(address, isRoomView)?.messages).toEqual([delta.message]);
  } finally {
    socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15000);
