import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ connected: undefined as (() => void) | undefined, state: 3, fetch: vi.fn(), holds: 0, stores: new Map<string, Map<string, string>>() }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(7) }));
vi.mock('@/auth/signin-funnel', () => ({ funnelSuccessfulOperation: async () => undefined }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: async () => ({ publicKey: 'c'.repeat(64), secretKey: new Uint8Array() }),
  peekBuzzViewerContext: () => ({ relayUrl: 'https://server.example', viewerPubkey: 'c'.repeat(64) }),
}));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example' }) }));
vi.mock('@/auth/monolith-session', () => ({ MONOLITH_REQUEST_TIMEOUT_MS: 15_000, MonolithRequestTimeoutError: class extends Error {}, monolithSession: { fetch: fixture.fetch } }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  diagnostics: () => ({ state: fixture.state }),
  subscribeConnected: (listener: () => void) => { fixture.connected = listener; return () => { fixture.connected = undefined; }; },
  register: async () => { fixture.holds++; return () => { fixture.holds--; }; },
}) }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
  values: Map<string, string>;
  constructor({ id }: { id: string }) { this.values = fixture.stores.get(id) ?? new Map(); fixture.stores.set(id, this.values); }
  getString(key: string) { return this.values.get(key); }
  set(key: string, value: string) { this.values.set(key, value); }
  delete(key: string) { this.values.delete(key); }
  getAllKeys() { return [...this.values.keys()]; }
} }));

it('R2 app startup flushes the persisted owner over the one phone operation path on every reconnect', async () => {
  const { startMessageOutbox } = await import('./message-outbox-runtime');
  const { createRoomOutbox, getMessageOutbox, resetMessageOutboxes } = await import('./surface-storage');
  const identity = { publicKey: 'c'.repeat(64) };
  const owner = getMessageOutbox('https://server.example', identity);
  const room = createRoomOutbox('https://server.example', identity, 'room-a');
  const e = { id: 'a'.repeat(64), pubkey: identity.publicKey, kind: 9, sig: '', created_at: 1, content: 'Start with the server PR', tags: [['h', 'room-a'], ['monolith-attachments', '[]'], ['monolith-mentions', '[]']] };
  await room.enqueue(e, { id: e.id, text: e.content, createdAt: 1, author: { pubkey: identity.publicKey, kind: 'human', name: 'Kai' }, presentation: 'message' });
  await startMessageOutbox(); await owner.connectionChanged(false);
  await room.send(e.id); expect(fixture.fetch).not.toHaveBeenCalled(); expect(room.state(e.id)?.text).toBe('Sending');
  fixture.fetch.mockImplementation(async (_url, init) => new Response(JSON.stringify({ messageId: JSON.parse(init.body).messageId }), { status: 200 }));
  fixture.state = 1; fixture.connected!();
  await vi.waitFor(() => expect(owner.list()).toHaveLength(0));
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  const [url, request] = fixture.fetch.mock.calls[0]!;
  expect(url).toBe('https://server.example/v1/phone/operations/sendRoomMessage');
  expect(JSON.parse(request.body)).toMatchObject({ roomId: 'room-a', messageId: e.id, text: e.content });
  expect(fixture.holds).toBe(1);
  // A Room's handle is just a selector; dropping it does not own delivery.
  const refused = { ...e, id: 'b'.repeat(64) };
  await room.enqueue(refused, { id: refused.id, text: refused.content, createdAt: 2, author: { pubkey: identity.publicKey, kind: 'human', name: 'Kai' }, presentation: 'message' });
  fixture.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'The relay did not allow this message.' }), { status: 403 }));
  fixture.connected!();
  await vi.waitFor(() => expect(owner.state(refused.id)?.kind).toBe('refused'));
  expect(owner.state(refused.id)?.text).toBe('Not sent · The relay did not allow this message.');
  fixture.connected!(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
  resetMessageOutboxes();
});
