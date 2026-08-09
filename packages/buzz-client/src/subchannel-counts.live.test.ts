/**
 * Live test: scoped subchannel counts via `listSubchannels`.
 *
 * Verifies:
 *   - Creating 2 subchannels under parent A and 1 under parent B yields
 *     counts 2 and 1 respectively.
 *   - A subchannel itself shows 0 subchannels.
 *
 * Soft-skips when relay is unreachable.
 */
import { describe, expect, it } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, uniqueMarker, sleep } from './live-helpers.js';
import { listSubchannels } from './channel.js';
import { tagValue } from './parse.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live scoped subchannel counts', () => {
  it('listSubchannels returns only children of the specified parent', async () => {
    const runId = uniqueMarker('sc');
    const owner = createIdentity('subcount-owner');
    const client = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });

    // Create parent A.
    const parentA = await client.createChannel(`parent-a-${runId}`);
    console.log(`[live] parentA=${parentA}`);

    // Create parent B.
    const parentB = await client.createChannel(`parent-b-${runId}`);
    console.log(`[live] parentB=${parentB}`);

    // Create 2 subchannels under parent A.
    const subA1 = await client.createChannel(`suba1-${runId}`, { parentChannelId: parentA });
    const subA2 = await client.createChannel(`suba2-${runId}`, { parentChannelId: parentA });
    console.log(`[live] subA1=${subA1} subA2=${subA2}`);

    // Create 1 subchannel under parent B.
    const subB1 = await client.createChannel(`subb1-${runId}`, { parentChannelId: parentB });
    console.log(`[live] subB1=${subB1}`);

    // Wait for relay to index events.
    await sleep(1000);

    // Query subchannels via buzz-client's listSubchannels.
    const httpOpts = { baseUrl: DEFAULT_BASE_URL, host: DEFAULT_HOST, identity: owner };
    const ctx = { http: httpOpts, identity: owner };

    const childrenA = await listSubchannels(ctx, parentA);
    console.log(
      `[live] childrenA count=${childrenA.length} ids=${childrenA.map((c) => c.slice(0, 8))}`,
    );

    const childrenB = await listSubchannels(ctx, parentB);
    console.log(
      `[live] childrenB count=${childrenB.length} ids=${childrenB.map((c) => c.slice(0, 8))}`,
    );

    const childrenSub = await listSubchannels(ctx, subA1);
    console.log(`[live] childrenSub (subA1) count=${childrenSub.length}`);

    // Parent A must have exactly 2 children (subA1, subA2)
    expect(childrenA.length).toBe(2);
    expect(childrenA).toContain(subA1);
    expect(childrenA).toContain(subA2);
    // Must not contain parentA itself or unrelated channels
    expect(childrenA).not.toContain(parentA);
    expect(childrenA).not.toContain(parentB);
    expect(childrenA).not.toContain(subB1);

    // Parent B must have exactly 1 child (subB1)
    expect(childrenB.length).toBe(1);
    expect(childrenB).toContain(subB1);
    expect(childrenB).not.toContain(parentA);
    expect(childrenB).not.toContain(parentB);
    expect(childrenB).not.toContain(subA1);
    expect(childrenB).not.toContain(subA2);

    // A subchannel itself must have 0 subchannels
    expect(childrenSub.length).toBe(0);
  });
});

describe.runIf(!reachable)('live subchannel counts (skipped — relay down)', () => {
  it('soft-skips when relay unreachable', () => {
    console.log(`[live] SKIP subchannel counts: relay not reachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
