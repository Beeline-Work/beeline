import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ stores: new Map<string, Map<string, string>>() }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }, NativeModules: {},
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(7) }));
vi.mock('@/auth/signin-funnel', () => ({ funnelSuccessfulOperation: async () => undefined }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'c'.repeat(64), secretKey: new Uint8Array() }),
  peekBuzzViewerContext: () => ({ relayUrl: 'https://server.example', viewerPubkey: 'c'.repeat(64) }),
}));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }) }));
vi.mock('@/auth/monolith-session', () => ({
  MONOLITH_REQUEST_TIMEOUT_MS: 15_000, MonolithRequestTimeoutError: class extends Error {},
  monolithSession: { authorization: async () => 'fixture-access' },
}));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
  values: Map<string, string>;
  constructor({ id }: { id: string }) { this.values = fixture.stores.get(id) ?? new Map(); fixture.stores.set(id, this.values); }
  getString(key: string) { return this.values.get(key); }
  set(key: string, value: string) { this.values.set(key, value); }
  delete(key: string) { this.values.delete(key); }
  getAllKeys() { return [...this.values.keys()]; }
} }));

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(_url: string, _protocols: string[]) { Socket.instances.push(this); }
  send(frame: string) { this.sent.push(frame); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }
  requests() { return this.sent.map(value => JSON.parse(value)).filter(frame => frame.t === 'req'); }
  reply(request: { id: string }, result: unknown) {
    this.onmessage?.({ data: JSON.stringify({ t: 'res', id: request.id, ok: true, result }) });
  }
}
const tick = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); fixture.stores.clear(); Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(async () => {
  (await import('./message-outbox-storage')).resetMessageOutboxes();
  (await import('@/sync/transport/live-connection')).resetSharedLiveConnection();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function setup() {
  const { startMessageOutbox } = await import('./message-outbox-runtime');
  const { sharedLiveConnection } = await import('@/sync/transport/live-connection');
  const { createRoomOutbox } = await import('./message-outbox-storage');
  await startMessageOutbox(); await tick();
  const connection = sharedLiveConnection();
  const reads: Promise<unknown>[] = [];
  await connection.register([{ '#h': ['room-a'] }], () => {
    reads.push(connection.request('readRoom', { roomId: 'room-a' }).catch(error => error));
  });
  const first = Socket.instances[0]!; first.open(); await tick();
  const room = createRoomOutbox('https://server.example', { publicKey: 'c'.repeat(64) }, 'room-a');
  async function enqueue(id = 'a'.repeat(64)) {
    const event = { id, pubkey: 'c'.repeat(64), kind: 9, sig: '', created_at: 1, content: 'Please check this',
      tags: [['h', 'room-a'], ['monolith-attachments', '[]'], ['monolith-mentions', '[]']] };
    await room.enqueue(event, { id, text: event.content, createdAt: 1,
      author: { pubkey: event.pubkey, kind: 'human', name: 'Kai' }, presentation: 'message' });
    return event;
  }
  return { room, first, connection, reads, enqueue };
}

it('SEND-RECONNECT reopens once and flushes a send that timed out while the app stayed active', async () => {
  const { room, first, reads, enqueue } = await setup();
  const event = await enqueue(); const sending = room.send(event.id); await tick();
  expect(first.requests()).toHaveLength(1);
  // No native close or online/resume event: the socket still claims to be open.
  await vi.advanceTimersByTimeAsync(15_000); await sending;
  expect(Socket.instances).toHaveLength(2);
  expect(first.readyState).toBe(3);
  expect(room.get(event.id)).toBeDefined();
  const replacement = Socket.instances[1]!; replacement.open(); await tick();
  expect(reads).toHaveLength(1);
  const replay = replacement.requests().find(request => request.op === 'sendRoomMessage');
  expect(replay.args.messageId).toBe(event.id);
  const read = replacement.requests().find(request => request.op === 'readRoom');
  replacement.reply(read, { room: { id: 'room-a' }, messages: [] });
  replacement.reply(replay, { messageId: event.id }); await tick();
  expect(room.list()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
  expect(Socket.instances).toHaveLength(2);
  expect(replacement.requests()).toHaveLength(2);
});

it('a failed reconnect send remains visibly pending without another reconnect or replay loop', async () => {
  const { room, first, connection, enqueue } = await setup();
  const event = await enqueue(); const sending = room.send(event.id); await tick();
  // A concurrent read must not suppress the send owner's recovery.
  const interruptedRead = connection.request('readRoom', { roomId: 'room-a' }).catch(error => error);
  first.drop(); await sending; await interruptedRead; await tick();
  expect(Socket.instances).toHaveLength(2);
  const replacement = Socket.instances[1]!; replacement.open(); await tick();
  for (const request of replacement.requests().filter(request => request.op === 'readRoom')) replacement.reply(request, {});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(room.get(event.id)).toBeDefined();
  await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
  expect(room.state(event.id)?.text).toBe('Not sent yet');
  expect(Socket.instances).toHaveLength(2);
  expect(replacement.requests().filter(request => request.op === 'sendRoomMessage')).toHaveLength(1);
});

it('concurrent failed sends share one replacement and each keep their original message id', async () => {
  const { room, enqueue } = await setup();
  const events = await Promise.all([enqueue(), enqueue('b'.repeat(64))]);
  const sends = events.map(event => room.send(event.id)); await tick();
  await vi.advanceTimersByTimeAsync(15_000); await Promise.all(sends);
  expect(Socket.instances).toHaveLength(2);
  const replacement = Socket.instances[1]!; replacement.open(); await tick();
  const replays = replacement.requests().filter(request => request.op === 'sendRoomMessage');
  expect(replays.map(request => request.args.messageId).sort()).toEqual(events.map(event => event.id).sort());
  for (const request of replacement.requests()) replacement.reply(request, { messageId: request.args.messageId });
  await tick(); expect(room.list()).toHaveLength(0);
});

it('a failed replacement opening ends recovery after that one connection attempt', async () => {
  const { room, enqueue } = await setup();
  const event = await enqueue(); const sending = room.send(event.id); await tick();
  await vi.advanceTimersByTimeAsync(15_000); await sending;
  expect(Socket.instances).toHaveLength(2);
  Socket.instances[1]!.drop(); await tick();
  await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
  expect(Socket.instances).toHaveLength(2);
  expect(room.state(event.id)?.text).toBe('Not sent yet');
});

it('a server refusal settles without replacing its answered socket', async () => {
  const { room, first, enqueue } = await setup();
  const event = await enqueue(); const sending = room.send(event.id); await tick();
  first.onmessage?.({ data: JSON.stringify({ t: 'res', id: first.requests()[0].id, ok: false,
    error: { code: 'access_denied', message: 'Room access denied', retryable: false } }) });
  await sending;
  expect(room.state(event.id)).toEqual({ kind: 'refused', text: 'Not sent · Room access denied' });
  expect(Socket.instances).toHaveLength(1);
  expect(first.readyState).toBe(1);
});
