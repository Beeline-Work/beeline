/**
 * Live round-trip: identity A creates channel, adds B; both connect;
 * A sends, B receives live over WS; B sends, A receives; backfill returns both in order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, sleep, uniqueMarker, waitFor } from './live-helpers.js';
import type { SessionEvent } from './types.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live round-trip (two members, WS + backfill)', () => {
  const runId = uniqueMarker('rt');
  const alice = createIdentity('alice');
  const bob = createIdentity('bob');
  let channelId = '';
  const clientA = createBuzzClient({
    baseUrl: DEFAULT_BASE_URL,
    host: DEFAULT_HOST,
    identity: alice,
  });
  const clientB = createBuzzClient({
    baseUrl: DEFAULT_BASE_URL,
    host: DEFAULT_HOST,
    identity: bob,
  });
  const unsubs: Array<() => void> = [];

  beforeAll(async () => {
    console.log(`[live] round-trip run=${runId} relay=${DEFAULT_BASE_URL}`);
    channelId = await clientA.createChannel(`buzz-client-rt-${runId}`);
    // Owner is creator; add bob and assert membership (gotcha guard).
    await clientA.addMember(channelId, bob.publicKey, 'member');
    await clientA.waitUntilMember(channelId, bob.publicKey, { timeoutMs: 15_000 });
    // Creator should also appear on 39002.
    await clientA.waitUntilMember(channelId, alice.publicKey, { timeoutMs: 15_000 });

    await clientA.connect();
    await clientB.connect();
  });

  afterAll(() => {
    for (const u of unsubs) u();
    clientA.disconnect();
    clientB.disconnect();
  });

  it('A sends, B receives live; B sends, A receives; backfill ordered', async () => {
    const msgA = `hello-from-A ${runId}`;
    const msgB = `hello-from-B ${runId}`;

    const seenByB: SessionEvent[] = [];
    const seenByA: SessionEvent[] = [];

    unsubs.push(
      await clientB.sessionEventsSubscribe(channelId, (ev) => {
        if (ev.content.includes(runId)) seenByB.push(ev);
      }),
    );
    unsubs.push(
      await clientA.sessionEventsSubscribe(channelId, (ev) => {
        if (ev.content.includes(runId)) seenByA.push(ev);
      }),
    );

    // Small settle so REQ is active before publish.
    await new Promise((r) => setTimeout(r, 200));

    const pubA = await clientA.messageSubmit(channelId, msgA);
    expect(pubA.id).toMatch(/^[0-9a-f]{64}$/);

    await waitFor(() => seenByB.some((e) => e.content === msgA), {
      label: 'B receives A live',
      timeoutMs: 15_000,
    });

    // Ensure at least 1s gap so created_at differs (relay returns newest-first;
    // same-second events have non-deterministic id-based tiebreaking).
    await sleep(1100);

    const pubB = await clientB.messageSubmit(channelId, msgB);
    expect(pubB.id).toMatch(/^[0-9a-f]{64}$/);

    await waitFor(() => seenByA.some((e) => e.content === msgB), {
      label: 'A receives B live',
      timeoutMs: 15_000,
    });

    // Backfill should include both in chronological order.
    const backfill = await clientA.sessionEventsBackfill(channelId, { limit: 50 });
    const ours = backfill.filter((e) => e.content.includes(runId));
    expect(ours.map((e) => e.content)).toEqual([msgA, msgB]);

    console.log(
      `[live] round-trip OK channel=${channelId} events=${ours.map((e) => e.id.slice(0, 8)).join(',')}`,
    );
  });
});

describe.runIf(!reachable)('live round-trip (skipped — relay down)', () => {
  it('soft-skips when relay unreachable', () => {
    console.log(`[live] SKIP round-trip: relay not reachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
