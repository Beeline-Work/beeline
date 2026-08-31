#!/usr/bin/env node
/**
 * Fixture-only remote participant for the mobile Maestro smoke. It waits for
 * the device's real relay events, then replies through the same relay so the
 * assertions cover subscription delivery rather than preloaded transcript UI.
 */
import {
  AGENT_PRESENCE_HEARTBEAT_MS,
  CORNER_REMOTE_STATE_KIND,
  CORNER_REMOTE_STATE_TAG,
  KIND_AGENT_DRAFT,
  agentDraftKey,
  cornerRemoteStateKey,
  createBuzzClient,
  KIND_AGENT_PRESENCE,
  RoomViewClient,
  loadIdentityFromNsec,
  TAG_AGENT_PRESENCE,
  type SessionEvent,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';

const [agentNsec, roomId, cornerId] = process.argv.slice(2);
const RELAY = process.env.RELAY_URL || 'https://usebeeline.app';
const RELAY_PUBLIC_ORIGIN = process.env.RELAY_PUBLIC_ORIGIN || RELAY;
const ROOMVIEW_LATENCY_BUDGET_MS = 8_000;

if (!agentNsec || !roomId || !cornerId) {
  throw new Error('usage: publish-smoke-replies <agent-nsec> <room-id> <corner-id>');
}

async function waitForRelayMessage(
  client: ReturnType<typeof createBuzzClient>,
  channelId: string,
  needle: string,
): Promise<SessionEvent> {
  let settle!: (event: SessionEvent) => void;
  const seen = new Promise<SessionEvent>((resolve) => {
    settle = resolve;
  });
  let stopped = false;
  const stop = await client.sessionEventsSubscribe(channelId, (event) => {
    if (!stopped && event.content?.includes(needle)) settle(event);
  });
  const backfill = await client.sessionEventsBackfill(channelId, { limit: 100 });
  const existing = backfill.find((event) => event.content?.includes(needle));
  const event = existing ?? (await seen);
  stopped = true;
  stop();
  return event;
}

async function requireRoomViewWithinBudget(
  client: RoomViewClient,
  channelId: string,
  event: SessionEvent,
  label: string,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + ROOMVIEW_LATENCY_BUDGET_MS;
  while (Date.now() < deadline) {
    const view = await client.room(channelId);
    if (view.messages.some((message) => message.id === event.id)) {
      console.log(`ROOMVIEW_LATENCY ${label} ${Date.now() - startedAt}ms`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${label} did not become visible in RoomView within ${ROOMVIEW_LATENCY_BUDGET_MS}ms`,
  );
}

/** The device event is the proof: retries must preserve one relay event id. */
async function requireExactlyOneMessage(
  client: ReturnType<typeof createBuzzClient>,
  channelId: string,
  content: string,
): Promise<void> {
  // Give an accidental second tap or resume flush enough time to arrive.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const events = await client.sessionEventsBackfill(channelId, { limit: 100 });
  const matches = events.filter((event) => event.content === content);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${JSON.stringify(content)} event, found ${matches.length}`,
    );
  }
}

async function main(agentNsec: string, roomId: string, cornerId: string) {
  const cornerProofOnly = process.env.SMOKE_CORNER_PROOF_ONLY === '1';
  const identity = loadIdentityFromNsec(agentNsec, 'buzzy-smoke-agent');
  const client = createBuzzClient({
    baseUrl: RELAY,
    publicOrigin: RELAY_PUBLIC_ORIGIN,
    identity,
  });
  const roomViews = new RoomViewClient({
    baseUrl: RELAY,
    publicOrigin: RELAY_PUBLIC_ORIGIN,
    identity,
  });
  await client.connect();
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const publishPresence = () =>
    client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: Math.floor(Date.now() / 1_000),
          kind: KIND_AGENT_PRESENCE,
          tags: [
            ['d', `${TAG_AGENT_PRESENCE}:${roomId}`],
            ['h', roomId],
            ['t', TAG_AGENT_PRESENCE],
            ['agent', identity.publicKey],
            ['status', 'online'],
          ],
          content: '',
        },
        identity.secretKey,
      ),
    );
  const publishCornerTurnStatus = (requestId: string, status: 'working' | 'complete') => {
    return client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: Math.floor(Date.now() / 1_000),
          kind: 9,
          tags: [
            ['h', cornerId],
            ['t', 'body-control'],
            ['t', 'agent-turn'],
            ['request', requestId],
            ['session', 'smoke-corner-session'],
            ['agent', identity.publicKey],
            ['mode', 'readonly'],
            ['status', status],
          ],
          content: status === 'working' ? 'Agent is thinking…' : 'Agent reply complete.',
        },
        identity.secretKey,
      ),
    );
  };
  const publishCornerDraft = (requestId: string, content: string, closed = false) => {
    return client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: Math.floor(Date.now() / 1_000),
          kind: KIND_AGENT_DRAFT,
          tags: [
            ['d', agentDraftKey(cornerId)],
            ['h', cornerId],
            ['t', 'agent-draft'],
            ['agent', identity.publicKey],
            ['session', 'smoke-corner-session'],
            ['request', requestId],
            ...(closed ? [['status', 'closed']] : []),
          ],
          content,
        },
        identity.secretKey,
      ),
    );
  };
  const pullRequest = {
    number: 42,
    url: 'https://github.com/lunchboxfortwo/beeline/pull/42',
    title: 'Smoke lifecycle PR',
    targetBranch: 'main',
    headSha: 'a'.repeat(40),
  };
  const publishCornerRemoteState = async (
    state: 'in-review' | 'gone',
    input: {
      checks?: 'passing' | 'failing';
      outcome?: 'landed' | 'abandoned';
    } = {},
  ) => {
    const checks = state === 'in-review' ? (input.checks ?? 'passing') : 'unknown';
    await client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: Math.floor(Date.now() / 1_000),
          kind: CORNER_REMOTE_STATE_KIND,
          tags: [
            ['d', cornerRemoteStateKey(cornerId)],
            ['h', cornerId],
            ['t', CORNER_REMOTE_STATE_TAG],
            ['branch', 'fm/smoke-lifecycle'],
            ['state', state],
            ['checks', checks],
            ['pr-number', String(pullRequest.number)],
            ['pr-url', pullRequest.url],
            ['target-branch', pullRequest.targetBranch],
            ...(input.outcome ? [['outcome', input.outcome]] : []),
          ],
          content: JSON.stringify({
            version: 1,
            cornerId,
            branch: 'fm/smoke-lifecycle',
            state,
            checks,
            observedAt: Math.floor(Date.now() / 1_000),
            ...(state === 'in-review' ? { branchTip: pullRequest.headSha } : {}),
            pr: pullRequest,
            ...(input.outcome ? { outcome: input.outcome } : {}),
          }),
        },
        identity.secretKey,
      ),
    );
  };
  const schedulePresenceHeartbeat = () => {
    if (stopped) return;
    heartbeatTimer = setTimeout(() => {
      void publishPresence()
        .catch((error) => console.warn('Smoke presence heartbeat failed:', error))
        .finally(schedulePresenceHeartbeat);
    }, AGENT_PRESENCE_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };

  try {
    await publishPresence();
    schedulePresenceHeartbeat();
    // Relay observation is the action boundary. Navigation time before a send
    // cannot consume its latency budget; only relay -> authoritative RoomView
    // materialization is measured.
    if (!cornerProofOnly) {
      const roomSend = await waitForRelayMessage(client, roomId, 'SMOKE ROOM SEND');
      await requireRoomViewWithinBudget(roomViews, roomId, roomSend, 'room-send');
      const roomReply = await client.messageSubmit(
        roomId,
        'SMOKE AGENT ROOM REPLY — delivered live',
      );
      await requireRoomViewWithinBudget(roomViews, roomId, roomReply, 'room-agent-reply');
      // The smoke performs a separate picker/responsiveness send before its
      // exact Beebee mention. Use that relay-backed action as the phase boundary
      // so time spent navigating and exercising the first mention cannot consume
      // the timeout for an action the device has not reached yet.
      await waitForRelayMessage(client, roomId, 'mention picker stayed responsive');
      await waitForRelayMessage(client, roomId, "@beebee what's up");
      await requireExactlyOneMessage(client, roomId, "@beebee what's up");
      await client.messageSubmit(roomId, "SMOKE AGENT MENTION REPLY — @beebee what's up");
      await waitForRelayMessage(client, roomId, 'SMOKE KEYBOARD PIN TRIGGER');
      await client.messageSubmit(roomId, 'SMOKE AGENT KEYBOARD REPLY — newest above keyboard');
    }
    const cornerPhaseRequest = await waitForRelayMessage(
      client,
      roomId,
      'SMOKE CORNER PHASE READY',
    );
    await publishCornerTurnStatus(cornerPhaseRequest.id, 'working');
    const idleNudge = await client.messageSubmit(
      cornerId,
      'Completion needed: open a pull request for fm/smoke-lifecycle.',
      {
        extraTags: [
          ['t', 'corner-completion-nudge'],
          ['rung', 'pushed-no-pr'],
          ['branch', 'fm/smoke-lifecycle'],
        ],
      },
    );
    await requireRoomViewWithinBudget(roomViews, cornerId, idleNudge, 'corner-idle-nudge');
    await publishCornerTurnStatus(cornerPhaseRequest.id, 'complete');
    const cornerSteer = await waitForRelayMessage(client, cornerId, 'SMOKE CORNER STEER');
    await requireRoomViewWithinBudget(roomViews, cornerId, cornerSteer, 'corner-steer');
    await publishCornerTurnStatus(cornerSteer.id, 'working');
    await publishCornerDraft(cornerSteer.id, 'SMOKE AGENT CORNER STREAM — first chunk');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await publishCornerDraft(
      cornerSteer.id,
      'SMOKE AGENT CORNER STREAM — first chunk, then second chunk',
    );
    // Maestro deliberately settles after each Android action. Keep the live
    // state open across those independent assertions and the screenshot; the
    // completed-reply wait below owns the longer terminal deadline.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const cornerReply = await client.messageSubmit(
      cornerId,
      'SMOKE AGENT CORNER REPLY — steering delivered live',
    );
    await requireRoomViewWithinBudget(roomViews, cornerId, cornerReply, 'corner-agent-reply');
    await publishCornerDraft(cornerSteer.id, '', true);
    await publishCornerTurnStatus(cornerSteer.id, 'complete');
    // This mirrors the daemon's mechanical PR fact: the signed remote state
    // drives lifecycle rendering and the typed event drives the visible
    // GitHub link card. The device waits for this exact card before issuing
    // its explicit `gh merge` fixture trigger below.
    await publishCornerRemoteState('in-review', { checks: 'failing' });
    const prFact = await client.messageSubmit(cornerId, '', {
      extraTags: [
        ['t', 'daemon-fact'],
        ['t', 'corner-pr'],
        ['t', 'github-event'],
        ['service', 'beeline-events'],
        ['github-event-id', `corner:${cornerId}:pr:${pullRequest.number}`],
        ['github-event-type', 'pull-request'],
        ['github-event-action', 'opened'],
        ['github-event-actor', 'GitHub'],
        ['github-event-title', pullRequest.title],
        ['github-event-url', pullRequest.url],
        ['pr-number', String(pullRequest.number)],
        ['branch', 'fm/smoke-lifecycle'],
        ['target-branch', pullRequest.targetBranch],
      ],
    });
    await requireRoomViewWithinBudget(roomViews, cornerId, prFact, 'corner-pr-fact');
    await waitForRelayMessage(client, cornerId, 'SMOKE CHECKS GREEN');
    await publishCornerRemoteState('in-review', { checks: 'passing' });
    await waitForRelayMessage(client, cornerId, 'SMOKE GH MERGE');
    await publishCornerRemoteState('gone', { outcome: 'landed' });
    const landed = await client.messageSubmit(
      roomId,
      `Landed “${pullRequest.title}” into ${pullRequest.targetBranch}: ${pullRequest.url}`,
      {
        extraTags: [
          ['t', 'daemon-fact'],
          ['t', 'corner-branch-ended'],
          ['subchannel', cornerId],
          ['outcome', 'landed'],
          ['branch', 'fm/smoke-lifecycle'],
          ['pr-number', String(pullRequest.number)],
          ['url', pullRequest.url],
          ['target-branch', pullRequest.targetBranch],
        ],
      },
    );
    await requireRoomViewWithinBudget(roomViews, roomId, landed, 'room-landed-summary');
    // A corner is agent-owned. This is the same final kind:9002 the daemon
    // publishes after observing GitHub's auto-deleted branch; no mobile-only
    // lifecycle projection is involved.
    await client.publish(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: Math.floor(Date.now() / 1_000),
          kind: 9002,
          tags: [
            ['h', cornerId],
            ['archived', 'true'],
          ],
          content: '',
        },
        identity.secretKey,
      ),
    );
    const worktreeCleaned = await client.messageSubmit(
      roomId,
      'Corner worktree cleaned after branch deletion.',
      {
        extraTags: [
          ['t', 'daemon-fact'],
          ['t', 'corner-worktree-cleaned'],
          ['subchannel', cornerId],
          ['branch', 'fm/smoke-lifecycle'],
        ],
      },
    );
    await requireRoomViewWithinBudget(
      roomViews,
      roomId,
      worktreeCleaned,
      'corner-worktree-cleaned',
    );
  } finally {
    stopped = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    client.disconnect();
  }
}

main(agentNsec, roomId, cornerId).catch((error) => {
  console.error('Smoke reply fixture failed:', error);
  process.exit(1);
});
