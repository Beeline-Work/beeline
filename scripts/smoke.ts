/**
 * Transport smoke test for the repo-corner lifecycle that ships today.
 *
 * This deliberately proves the relay facts the mobile app consumes rather
 * than exercising the retired review/approval transport. GitHub itself is
 * covered by the daemon's lifecycle tests and the release emulator canary.
 */
import { execFileSync } from 'node:child_process';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  CORNER_REMOTE_STATE_KIND,
  CORNER_REMOTE_STATE_TAG,
  cornerRemoteStateKey,
  KIND_STREAM_MESSAGE,
  parseCornerRemoteState,
} from '@beeline/buzz-client';
import { newIdentity, type Identity } from '../apps/gate/src/identity.js';
import { archiveChannel, createChannel, setMemberRole } from '../apps/gate/src/buzz.js';
import { publishEvent, queryEvents } from '../apps/gate/src/relay.js';

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', 'buzzy-gate-postgres-1', 'psql', '-U', 'buzz', '-d', 'buzz', '-tAc', sql],
    { encoding: 'utf8' },
  ).trim();
}

function signed(
  identity: Identity,
  kind: number,
  tags: string[][],
  content: string,
): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content,
    },
    identity.secretKey,
  );
}

async function main() {
  const owner = newIdentity('owner');
  const agent = newIdentity('agent');
  const roomId = await createChannel(owner, 'corner-lifecycle-smoke');
  await setMemberRole(owner, roomId, agent.publicKey, 'member');
  const cornerId = await createChannel(agent, 'ship-the-change', { parentChannelId: roomId });
  console.log('Room/corner created:', roomId, cornerId);

  const pullRequest = {
    number: 42,
    url: 'https://github.com/lunchboxfortwo/beeline/pull/42',
    title: 'Ship the change',
    targetBranch: 'main',
    headSha: 'a'.repeat(40),
  };
  await publishEvent(
    signed(
      agent,
      CORNER_REMOTE_STATE_KIND,
      [
        ['d', cornerRemoteStateKey(cornerId)],
        ['h', cornerId],
        ['t', CORNER_REMOTE_STATE_TAG],
      ],
      JSON.stringify({
        version: 1,
        cornerId,
        branch: 'buzz/ship-the-change',
        state: 'in-review',
        checks: 'passing',
        observedAt: Date.now(),
        branchTip: pullRequest.headSha,
        pr: pullRequest,
      }),
    ),
    agent,
  );
  await publishEvent(
    signed(
      agent,
      KIND_STREAM_MESSAGE,
      [
        ['h', cornerId],
        ['t', 'github-event'],
        ['event', 'pull-request-opened'],
        ['url', pullRequest.url],
        ['title', pullRequest.title],
        ['target', pullRequest.targetBranch],
      ],
      `Pull request opened: ${pullRequest.title}`,
    ),
    agent,
  );

  const stateEvents = await queryEvents(
    [
      {
        kinds: [CORNER_REMOTE_STATE_KIND],
        authors: [agent.publicKey],
        '#d': [cornerRemoteStateKey(cornerId)],
        limit: 5,
      },
    ],
    owner,
  );
  const state = stateEvents.map(parseCornerRemoteState).find(Boolean);
  if (state?.state !== 'in-review' || state.pr?.url !== pullRequest.url) {
    throw new Error('PR remote-state fact did not round-trip');
  }

  const prFacts = await queryEvents(
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        authors: [agent.publicKey],
        '#h': [cornerId],
        '#t': ['github-event'],
        limit: 20,
      },
    ],
    owner,
  );
  if (
    !prFacts.some((event) =>
      event.tags.some((tag) => tag[0] === 'url' && tag[1] === pullRequest.url),
    )
  ) {
    throw new Error('typed PR fact did not round-trip');
  }
  console.log('OK: PR state and typed fact round-trip');

  await publishEvent(
    signed(
      agent,
      KIND_STREAM_MESSAGE,
      [
        ['h', roomId],
        ['t', 'corner-branch-ended'],
        ['corner', cornerId],
        ['outcome', 'landed'],
        ['url', pullRequest.url],
      ],
      `Landed ${pullRequest.title}`,
    ),
    agent,
  );
  await archiveChannel(agent, cornerId);

  const summary = await queryEvents(
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        authors: [agent.publicKey],
        '#h': [roomId],
        '#t': ['corner-branch-ended'],
        limit: 20,
      },
    ],
    owner,
  );
  if (
    !summary.some((event) =>
      event.tags.some((tag) => tag[0] === 'corner' && tag[1] === cornerId),
    )
  ) {
    throw new Error('Room landed summary did not round-trip');
  }
  const archivedAt = psql(`SELECT archived_at IS NOT NULL FROM channels WHERE id='${cornerId}'`);
  if (archivedAt !== 't') {
    throw new Error(`corner was not archived (database value: ${archivedAt})`);
  }
  console.log('OK: Room landed summary round-trips and corner archives');
  console.log('\nSMOKE PASSED');
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error);
  process.exit(1);
});
