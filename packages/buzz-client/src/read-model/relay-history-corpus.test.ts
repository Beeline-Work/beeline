import { signEvent, type NostrEvent, type UnsignedEvent } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import { createIdentity } from '../identity.js';
import corpus from './fixtures/relay-history-corpus.json';
import { parseRelayEvent } from './parser.js';
import { createWorkspaceSnapshot, reduceWorkspaceEvents } from './reducer.js';
import { selectCorners, selectMembers, selectTranscript } from './selectors.js';
import type { IdentityRecord, ParseAuthority, Pubkey } from './types.js';

describe('one-time real-history proof gate', () => {
  it('reproduces every human message, member, and canonical corner from the captured corpus', () => {
    const human = createIdentity('corpus-human');
    const agent = createIdentity('corpus-agent');
    const relay = createIdentity('corpus-relay');
    const actors = { human, agent, relay };
    const identities: IdentityRecord[] = [
      { kind: 'human', pubkey: human.publicKey as Pubkey, displayName: 'Captain', revision: '1' },
      { kind: 'agent', pubkey: agent.publicKey as Pubkey, displayName: 'Buzzy', revision: '1' },
    ];
    const substitute = (value: string) =>
      value === '$human' ? human.publicKey : value === '$agent' ? agent.publicKey : value;
    const events = corpus.events.map((fixture) => {
      const source = actors[fixture.actor as keyof typeof actors];
      return signEvent(
        {
          pubkey: source.publicKey,
          created_at: fixture.created_at,
          kind: fixture.kind,
          tags: fixture.tags.map((tag) => tag.map(substitute)),
          content: fixture.content,
        } satisfies UnsignedEvent,
        source.secretKey,
      ) as NostrEvent;
    });
    const authority: ParseAuthority = {
      workspaceId: corpus.workspaceId,
      identities: Object.fromEntries(identities.map((identity) => [identity.pubkey, identity])),
      channelCreators: { [corpus.roomId]: human.publicKey, [corpus.cornerId]: agent.publicKey },
      channelAdmins: { [corpus.roomId]: [human.publicKey] },
      trustedProjectionPubkeys: [relay.publicKey],
    };
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: corpus.workspaceId, identities }),
      events.map((event) => parseRelayEvent(event, authority)),
    );
    const transcript = selectTranscript(snapshot, corpus.roomId);
    expect(
      transcript.filter((item) => item.kind === 'human-message').map((item) => item.body),
    ).toEqual(corpus.expected.humanMessages);
    expect(
      transcript.filter((item) => item.kind === 'agent-message').map((item) => item.body),
    ).toEqual(corpus.expected.agentMessages);
    expect(selectMembers(snapshot, corpus.roomId)).toHaveLength(corpus.expected.members);
    expect(
      selectCorners(snapshot, corpus.roomId)
        .filter((corner) => corner.kind === 'active')
        .map((corner) => corner.id),
    ).toEqual(corpus.expected.activeCorners);
    expect(JSON.stringify(transcript)).not.toContain('sessionUpdate');
    expect(JSON.stringify(transcript)).not.toContain(corpus.expected.excludedControlText);
    expect(
      Object.values(snapshot.rooms[corpus.roomId]?.eventJournal ?? {}).some(
        (event) => event.type === 'control' && event.payload.kind === 'record',
      ),
    ).toBe(true);
  });
});
