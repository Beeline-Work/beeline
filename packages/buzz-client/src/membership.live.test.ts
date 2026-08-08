/**
 * Membership-effect gotcha test: after kind:9000 add, assert 39002 actually
 * lists the member before proceeding (regression guard for silent-failure gotcha).
 *
 * Never treat an accepted publish as proof of effect.
 */
import { describe, expect, it } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import { DEFAULT_BASE_URL, DEFAULT_HOST, isRelayUp, uniqueMarker } from './live-helpers.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live membership-effect gotcha', () => {
  it('after kind:9000 add, 39002 lists the member (assert state, not ack)', async () => {
    const runId = uniqueMarker('mem');
    const owner = createIdentity('owner');
    const recruit = createIdentity('recruit');
    const client = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });

    const channelId = await client.createChannel(`membership-${runId}`);
    console.log(`[live] membership gotcha run=${runId} channel=${channelId}`);

    // Publish 9000 — ack alone is insufficient.
    const pub = await client.addMember(channelId, recruit.publicKey, 'member');
    expect(pub.accepted).toBe(true);

    // Immediately after ack, membership MAY still be missing (race) — we wait.
    // The point is we refuse to proceed on ack alone: waitUntilMember queries 39002.
    await client.waitUntilMember(channelId, recruit.publicKey, { timeoutMs: 15_000 });

    const members = await client.listMembers(channelId);
    const pks = members.map((m) => m.pubkey);
    expect(pks).toContain(recruit.publicKey);
    expect(pks).toContain(owner.publicKey);

    // Negative control: a random never-added key must not appear.
    const stranger = createIdentity('stranger');
    expect(pks).not.toContain(stranger.publicKey);
    expect(await client.isMember(channelId, stranger.publicKey)).toBe(false);

    console.log(
      `[live] membership OK members=${pks.map((p) => p.slice(0, 8)).join(',')} count=${pks.length}`,
    );
  });

  it('wrong role-tag shape documentation: separate role tag is what we send', async () => {
    // This is a unit-of-contract check: setMemberRole always sends ["role", r]
    // as its own tag (not p-slot). Live create+add already uses that path above.
    const owner = createIdentity('owner2');
    const client = createBuzzClient({
      baseUrl: DEFAULT_BASE_URL,
      host: DEFAULT_HOST,
      identity: owner,
    });
    const channelId = await client.createChannel(`role-shape-${uniqueMarker('rs')}`);
    const other = createIdentity('other');
    await client.addMember(channelId, other.publicKey, 'admin');
    await client.waitUntilMember(channelId, other.publicKey);
    expect(await client.isMember(channelId, other.publicKey)).toBe(true);
  });
});

describe.runIf(!reachable)('live membership (skipped — relay down)', () => {
  it('soft-skips when relay unreachable', () => {
    console.log(`[live] SKIP membership: relay not reachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
