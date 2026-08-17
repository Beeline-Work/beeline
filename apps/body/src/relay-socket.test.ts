/**
 * R5: the daemon holds ONE authenticated relay socket, not ~N+1 on the same
 * agent pubkey. Every Room push loop, presence cache and the control plane
 * multiplex their own NIP-01 subId onto it, and a reconnect must restore all
 * of them.
 *
 * These tests drive a real `BuzzClient`/`RelayWs` through a fake transport, so
 * NIP-42 AUTH and the reconnect REQ replay are genuinely exercised rather than
 * mocked away.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuzzClient } from '@beeline/buzz-client';
import { newIdentity } from '@beeline/gate';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';

import { SharedRelaySocket } from './relay-socket.js';

const KIND_NIP42_AUTH = 22242;

type Listener = (event: unknown) => void;

/** Minimal relay transport: challenges NIP-42, records every frame it receives. */
class FakeRelayTransport {
  static instances: FakeRelayTransport[] = [];
  static authenticatedPubkeys: string[] = [];

  readyState = 0;
  readonly sent: unknown[][] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly challenge: string;

  constructor(readonly url: string) {
    this.challenge = `challenge-${FakeRelayTransport.instances.length}`;
    FakeRelayTransport.instances.push(this);
    setTimeout(() => this.open(), 0);
  }

  static reset(): void {
    FakeRelayTransport.instances = [];
    FakeRelayTransport.authenticatedPubkeys = [];
  }

  static latest(): FakeRelayTransport {
    return FakeRelayTransport.instances[FakeRelayTransport.instances.length - 1]!;
  }

  addEventListener(type: string, handler: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(handler);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners.get(type)?.delete(handler);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as unknown[];
    this.sent.push(frame);
    if (frame[0] === 'AUTH') {
      const event = frame[1] as NostrEvent;
      // The socket is only usable if the client really signs the challenge.
      const challenge = event.tags.find((tag) => tag[0] === 'challenge')?.[1];
      const ok =
        event.kind === KIND_NIP42_AUTH && challenge === this.challenge && verifyEvent(event);
      if (ok) FakeRelayTransport.authenticatedPubkeys.push(event.pubkey);
      setTimeout(() => this.deliver(['OK', event.id, ok]), 0);
    }
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', {});
  }

  /** Subscription ids this transport was asked to open, in order. */
  requestedSubIds(): string[] {
    return this.sent.filter((frame) => frame[0] === 'REQ').map((frame) => String(frame[1]));
  }

  private open(): void {
    this.readyState = 1;
    this.emit('open', {});
    this.deliver(['AUTH', this.challenge]);
  }

  private deliver(frame: unknown[]): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  private emit(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
  }
}

function sharedSocket(identity = newIdentity('daemon-agent')): SharedRelaySocket {
  return new SharedRelaySocket({
    baseUrl: 'http://relay.test',
    wsUrl: 'ws://relay.test',
    identity,
    createClient: (options) =>
      createBuzzClient({
        baseUrl: options.baseUrl,
        wsUrl: options.wsUrl,
        identity: options.identity,
        WebSocketImpl: FakeRelayTransport as never,
        reconnectDelayMs: 5,
      }),
  });
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

afterEach(() => {
  FakeRelayTransport.reset();
  vi.restoreAllMocks();
});

describe('SharedRelaySocket', () => {
  it('opens exactly one authenticated connection for N concurrent room-instances', async () => {
    const identity = newIdentity('daemon-agent');
    const socket = sharedSocket(identity);

    const leases = await Promise.all(
      Array.from({ length: 6 }, () => socket.acquire()),
    );

    expect(FakeRelayTransport.instances).toHaveLength(1);
    expect(FakeRelayTransport.authenticatedPubkeys).toEqual([identity.publicKey]);
    // Every holder gets the same client, so a Room can never open a second
    // socket on this agent pubkey by accident.
    for (const lease of leases) expect(lease.client).toBe(leases[0]!.client);
    socket.disconnect();
  });

  it('releasing one room-instance never closes the socket its siblings share', async () => {
    const socket = sharedSocket();
    const first = await socket.acquire();
    const second = await socket.acquire();

    first.release();

    expect(second.client.socket?.connected).toBe(true);
    socket.disconnect();
    expect(second.client.socket).toBeNull();
  });

  it('multiplexes every Room, presence cache and the control plane onto one socket', async () => {
    const socket = sharedSocket();
    const client = await socket.connected();
    const rooms = ['room-a', 'room-b', 'room-c', 'room-d'];

    const unsubscribes = [];
    for (const room of rooms) {
      unsubscribes.push(await client.sessionEventsSubscribe(room, () => undefined, { since: 1 }));
      unsubscribes.push(await client.agentPresenceSubscribe(room, () => undefined));
    }
    // The supervisor's control plane is one more subId, not another socket.
    unsubscribes.push(
      client.socket!.subscribe([{ kinds: [9000, 9001], '#p': [client.identity.publicKey] }], () =>
        undefined,
      ),
    );

    expect(FakeRelayTransport.instances).toHaveLength(1);
    const subIds = FakeRelayTransport.latest().requestedSubIds();
    expect(subIds).toHaveLength(rooms.length * 2 + 1);
    expect(new Set(subIds).size).toBe(subIds.length);

    for (const unsubscribe of unsubscribes) unsubscribe();
    socket.disconnect();
  });

  it('re-authenticates and re-subscribes every room-instance after a reconnect', async () => {
    const identity = newIdentity('daemon-agent');
    const socket = sharedSocket(identity);
    const client = await socket.connected();
    const rooms = ['room-a', 'room-b', 'room-c'];
    for (const room of rooms) {
      await client.sessionEventsSubscribe(room, () => undefined, { since: 1 });
    }
    const before = FakeRelayTransport.latest().requestedSubIds();
    expect(before).toHaveLength(rooms.length);

    // Transport loss: RelayWs owns reconnect + REQ replay for every subId.
    FakeRelayTransport.latest().close();
    await waitFor(() => FakeRelayTransport.instances.length === 2);
    await waitFor(
      () => FakeRelayTransport.latest().requestedSubIds().length >= rooms.length,
    );

    const replacement = FakeRelayTransport.latest();
    expect(replacement.requestedSubIds().sort()).toEqual([...before].sort());
    // NIP-42 is redone on the replacement socket, on the same agent identity.
    expect(FakeRelayTransport.authenticatedPubkeys).toEqual([
      identity.publicKey,
      identity.publicKey,
    ]);
    const authIndex = replacement.sent.findIndex((frame) => frame[0] === 'AUTH');
    const firstReqIndex = replacement.sent.findIndex((frame) => frame[0] === 'REQ');
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(firstReqIndex);

    socket.disconnect();
  });

  it('refuses to hand out a socket once the daemon has closed it', async () => {
    const socket = sharedSocket();
    await socket.connected();
    socket.disconnect();

    await expect(socket.connected()).rejects.toThrow('shared relay socket is closed');
    expect(FakeRelayTransport.instances).toHaveLength(1);
  });
});
