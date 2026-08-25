/**
 * Two-participants proof (transport layer) — spec money shot:
 * "Two participants, one subchannel: both attached, both receive session/update,
 * both can submit a command."
 *
 * ONE channel, TWO simultaneously-connected member clients (distinct keys),
 * a third publisher (simulating the body) emits agent-activity events;
 * BOTH connected clients receive the same activity events live, and both can
 * submit (kind:9 accepted and visible to each other + backfill).
 *
 * Uses unique run markers so transcripts are unambiguous in CI/PR bodies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_HOST,
  isRelayUp,
  sleep,
  uniqueMarker,
  waitFor,
} from './live-helpers.js';
import type { SessionEvent } from './types.js';

const reachable = await isRelayUp();

describe.runIf(reachable)('live two-participants transport proof', () => {
  const runId = uniqueMarker('2p');
  const participantA = createIdentity('participant-A');
  const participantB = createIdentity('participant-B');
  const body = createIdentity('body-simulator'); // third publisher

  const clientA = createBuzzClient({
    baseUrl: DEFAULT_BASE_URL,
    host: DEFAULT_HOST,
    identity: participantA,
  });
  const clientB = createBuzzClient({
    baseUrl: DEFAULT_BASE_URL,
    host: DEFAULT_HOST,
    identity: participantB,
  });
  const clientBody = createBuzzClient({
    baseUrl: DEFAULT_BASE_URL,
    host: DEFAULT_HOST,
    identity: body,
  });

  let channelId = '';
  const unsubs: Array<() => void> = [];
  const receivedA: SessionEvent[] = [];
  const receivedB: SessionEvent[] = [];

  beforeAll(async () => {
    console.log(`[live] two-participants run=${runId}`);
    console.log(`[live]   A.pubkey=${participantA.publicKey}`);
    console.log(`[live]   B.pubkey=${participantB.publicKey}`);
    console.log(`[live]   body.pubkey=${body.publicKey}`);

    // A owns the channel; adds B and body as members.
    channelId = await clientA.createChannel(`two-part-${runId}`);
    await clientA.addMember(channelId, participantB.publicKey, 'member');
    await clientA.waitUntilMember(channelId, participantB.publicKey);
    await clientA.addMember(channelId, body.publicKey, 'member');
    await clientA.waitUntilMember(channelId, body.publicKey);
    await clientA.waitUntilMember(channelId, participantA.publicKey);

    // TWO concurrent WS connections with distinct keys — not one connection twice.
    await clientA.connect();
    await clientB.connect();
    expect(clientA.socket).not.toBeNull();
    expect(clientB.socket).not.toBeNull();
    expect(clientA.socket).not.toBe(clientB.socket);
    expect(participantA.publicKey).not.toBe(participantB.publicKey);

    unsubs.push(
      await clientA.sessionEventsSubscribe(channelId, (ev) => {
        if (ev.content.includes(runId)) receivedA.push(ev);
      }),
    );
    unsubs.push(
      await clientB.sessionEventsSubscribe(channelId, (ev) => {
        if (ev.content.includes(runId)) receivedB.push(ev);
      }),
    );

    await new Promise((r) => setTimeout(r, 300));
    console.log(`[live]   channel=${channelId} both WS attached`);
  });

  afterAll(() => {
    for (const u of unsubs) u();
    clientA.disconnect();
    clientB.disconnect();
    clientBody.disconnect();
  });

  it('both participants receive the same agent-activity events live', async () => {
    const activity1 = `agent-activity-1 ${runId} session/update tool_call`;
    const activity2 = `agent-activity-2 ${runId} session/update agent_message_chunk`;

    const ev1 = await clientBody.publishAgentActivity(channelId, activity1);
    // Separate created_at seconds so backfill ordering is deterministic.
    await sleep(1100);
    const ev2 = await clientBody.publishAgentActivity(channelId, activity2);
    expect(ev1.id).not.toBe(ev2.id);

    await waitFor(
      () =>
        receivedA.some((e) => e.content === activity1) &&
        receivedA.some((e) => e.content === activity2),
      { label: 'A receives both agent-activity', timeoutMs: 20_000 },
    );
    await waitFor(
      () =>
        receivedB.some((e) => e.content === activity1) &&
        receivedB.some((e) => e.content === activity2),
      { label: 'B receives both agent-activity', timeoutMs: 20_000 },
    );

    const idsA = receivedA
      .filter((e) => e.content === activity1 || e.content === activity2)
      .map((e) => e.id)
      .sort();
    const idsB = receivedB
      .filter((e) => e.content === activity1 || e.content === activity2)
      .map((e) => e.id)
      .sort();
    expect(idsA).toEqual(idsB);
    expect(idsA).toContain(ev1.id);
    expect(idsA).toContain(ev2.id);

    console.log(`[live] both saw activity ids=${idsA.map((i) => i.slice(0, 10)).join(',')}`);
  });

  it('both participants can submit; messages visible cross-client and in backfill', async () => {
    const cmdA = `cmd-from-A ${runId} please continue`;
    const cmdB = `cmd-from-B ${runId} abort that`;

    const pubA = await clientA.messageSubmit(channelId, cmdA);
    const pubB = await clientB.messageSubmit(channelId, cmdB);

    await waitFor(() => receivedB.some((e) => e.content === cmdA), {
      label: 'B sees A command',
    });
    await waitFor(() => receivedA.some((e) => e.content === cmdB), {
      label: 'A sees B command',
    });

    // A should also see own echo if relay fans out to publisher; not required.
    // Backfill must show both commands + activity.
    const backfill = await clientA.sessionEventsBackfill(channelId, { limit: 100 });
    const ours = backfill.filter((e) => e.content.includes(runId));
    const contents = ours.map((e) => e.content);

    expect(contents).toContain(cmdA);
    expect(contents).toContain(cmdB);
    expect(ours.some((e) => e.content === activity1 || e.content === activity2)).toBe(true);

    // Temporal ordering (creation-time guarantees):
    //   activity-1 has a 1s head-start over every other event (sleep(1100) before activity-2,
    //   plus waitFor delays before cmds). All other events may share the same wall-clock
    //   second, making id-based tiebreaking non-deterministic. Only assert activity-1 is
    //   chronologically first.
    const act1 = ours.find((e) => e.content.includes('agent-activity-1'))!;
    for (const e of ours) {
      if (e.content.includes('agent-activity-1')) continue;
      expect(e.created_at).toBeGreaterThanOrEqual(act1.created_at);
    }

    console.log('[live] === two-participants transcript ===');
    console.log(`[live] runId=${runId}`);
    console.log(`[live] channelId=${channelId}`);
    console.log(
      `[live] A=${participantA.publicKey.slice(0, 16)}… B=${participantB.publicKey.slice(0, 16)}…`,
    );
    console.log(`[live] concurrent sockets: A≠B confirmed`);
    console.log(`[live] pubA=${pubA.id.slice(0, 12)} pubB=${pubB.id.slice(0, 12)}`);
    for (const e of ours) {
      console.log(
        `[live]   ${e.created_at} ${String(e.kind).padEnd(15)} ${e.pubkey.slice(0, 8)}… ${e.content}`,
      );
    }
    console.log('[live] === end transcript ===');
  });
});

describe.runIf(!reachable)('live two-participants (skipped — relay down)', () => {
  it('soft-skips when relay unreachable', () => {
    console.log(`[live] SKIP two-participants: relay not reachable at ${DEFAULT_BASE_URL}`);
    expect(true).toBe(true);
  });
});
