import { signEvent, type NostrEvent, type UnsignedEvent } from '@beeline/nostr';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createIdentity } from '../identity.js';
import { buildScheduledTurnReceipt, deterministicScheduleRunId } from '../scheduled-turn.js';
import {
  KIND_CHANNEL_MEMBERS,
  KIND_AGENT_DRAFT,
  KIND_CORNER_STATE,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
  TAG_CORNER_STATE,
  TAG_PARENT,
} from '../kinds.js';
import { guardReadModelBoot, snapshotForPersistence } from './cache.js';
import { parseRelayEvent } from './parser.js';
import {
  commitRoomCoverage,
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  reduceWorkspaceSnapshot,
  replaceIdentitySnapshot,
} from './reducer.js';
import {
  selectAgentHistory,
  selectCorners,
  selectMembers,
  selectReplyTarget,
  selectRoomRow,
  selectTranscript,
} from './selectors.js';
import type { IdentityRecord, ParseAuthority, Pubkey, ReadEvent } from './types.js';

const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_ROOM = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CORNER = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace-read-model-property';
const human = createIdentity('read-model-human');
const secondHuman = createIdentity('read-model-human-two');
const agent = createIdentity('read-model-agent');
const relay = createIdentity('read-model-relay');

function identityRecord(
  source: typeof human,
  kind: 'human' | 'agent',
  displayName: string,
  revision = '1',
): IdentityRecord {
  return { kind, pubkey: source.publicKey as Pubkey, displayName, revision };
}

const humanRecord = identityRecord(human, 'human', 'Captain');
const secondHumanRecord = identityRecord(secondHuman, 'human', 'Crewmate');
const agentRecord = identityRecord(agent, 'agent', 'Buzzy');

function authority(overrides: Partial<ParseAuthority> = {}): ParseAuthority {
  return {
    workspaceId: WORKSPACE,
    identities: {
      [human.publicKey]: humanRecord,
      [secondHuman.publicKey]: secondHumanRecord,
      [agent.publicKey]: agentRecord,
    },
    channelCreators: { [ROOM]: human.publicKey, [CORNER]: agent.publicKey },
    channelAdmins: { [ROOM]: [human.publicKey], [CORNER]: [human.publicKey] },
    trustedProjectionPubkeys: [relay.publicKey],
    ...overrides,
  };
}

function signed(source: typeof human, input: Omit<UnsignedEvent, 'pubkey'>): NostrEvent {
  return signEvent({ ...input, pubkey: source.publicKey }, source.secretKey);
}

function message(
  source: typeof human,
  content: string,
  createdAt: number,
  extraTags: string[][] = [],
  channelId = ROOM,
): NostrEvent {
  return signed(source, {
    created_at: createdAt,
    kind: KIND_STREAM_MESSAGE,
    tags: [['h', channelId], ...extraTags],
    content,
  });
}

function memberSnapshot(channelId: string, members: string[], createdAt = 1): NostrEvent {
  return signed(relay, {
    created_at: createdAt,
    kind: KIND_CHANNEL_MEMBERS,
    tags: [['d', channelId], ...members.map((pubkey) => ['p', pubkey, 'member'])],
    content: '',
  });
}

function cornerCreate(createdAt = 2): NostrEvent {
  return signed(agent, {
    created_at: createdAt,
    kind: KIND_CREATE_GROUP,
    tags: [
      ['h', CORNER],
      [TAG_PARENT, ROOM],
      ['name', 'read model corner'],
    ],
    content: '',
  });
}

function cornerState(state: string, createdAt: number): NostrEvent {
  return signed(agent, {
    created_at: createdAt,
    kind: KIND_CORNER_STATE,
    tags: [
      ['d', `${TAG_CORNER_STATE}:${CORNER}`],
      ['t', TAG_CORNER_STATE],
      ['h', ROOM],
      ['state', state],
      ['at', String(createdAt)],
    ],
    content: '',
  });
}

function turn(status: 'working' | 'complete' | 'failed', createdAt: number): NostrEvent {
  return message(agent, `turn ${status}`, createdAt, [
    ['t', 'body-control'],
    ['t', 'agent-turn'],
    ['request', 'request-1'],
    ['session', 'session-1'],
    ['agent', agent.publicKey],
    ['status', status],
  ]);
}

function lane(
  marker: typeof TAG_AGENT_DRAFT | typeof TAG_AGENT_THOUGHT,
  text: string,
  createdAt: number,
  closed = false,
): NostrEvent {
  return signed(agent, {
    created_at: createdAt,
    kind: KIND_AGENT_DRAFT,
    tags: [
      ['d', `${marker}:${ROOM}`],
      ['h', ROOM],
      ['t', marker],
      ['agent', agent.publicKey],
      ['session', 'session-1'],
      ...(marker === TAG_AGENT_DRAFT ? [['request', 'request-1']] : []),
      ...(closed ? [['status', 'closed']] : []),
    ],
    content: text,
  });
}

function parse(events: readonly NostrEvent[], context = authority()): ReadEvent[] {
  return events.map((event) => parseRelayEvent(event, context));
}

function replay(events: readonly ReadEvent[]) {
  return reduceWorkspaceEvents(
    createWorkspaceSnapshot({
      identities: [humanRecord, secondHumanRecord, agentRecord],
      workspaceId: WORKSPACE,
    }),
    events,
  );
}

function delivery<T>(items: readonly T[], seed: number): T[] {
  const ordered = [...items].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    const score = (value: string) =>
      [...value].reduce(
        (total, character) => (total * 33 + character.charCodeAt(0) + seed) | 0,
        seed,
      );
    return score(a) - score(b) || a.localeCompare(b);
  });
  return ordered.flatMap((item, index) =>
    Math.abs(seed + index) % 3 === 0 ? [item, item] : [item],
  );
}

describe('read-model invariants (property based)', () => {
  it('RM-01 conserves every verified human message exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 80 }).filter((value) => value.trim().length > 0),
          { minLength: 1, maxLength: 12 },
        ),
        fc.integer(),
        fc.constantFrom('body-control', 'agent-activity', 'agent-message', 'random-human-tag'),
        (bodies, seed, reservedTag) => {
          const raw = bodies.map((body, index) =>
            message(human, body, 10 + index, [['t', reservedTag]]),
          );
          const snapshot = replay(delivery(parse(raw), seed));
          const transcript = selectTranscript(snapshot, ROOM).filter(
            (item) => item.kind === 'human-message',
          );
          const history = selectAgentHistory(snapshot, ROOM, { limit: 100 });
          expect(new Set(transcript.map((item) => item.id))).toEqual(
            new Set(raw.map((event) => event.id)),
          );
          expect(new Set(history.map((item) => item.eventId))).toEqual(
            new Set(raw.map((event) => event.id)),
          );
        },
      ),
      { numRuns: 80 },
    );
  });

  it('RM-02 never renders control, session, lifecycle, membership, or activity as chat', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const control = message(agent, 'control raw body', 20, [
          ['t', 'body-control'],
          ['t', 'steer-queued'],
        ]);
        const activity = message(
          agent,
          JSON.stringify({
            sessionId: 's',
            update: { sessionUpdate: 'tool_activity', title: 'Read' },
          }),
          21,
          [['t', TAG_AGENT_ACTIVITY]],
        );
        const events = parse([
          control,
          activity,
          memberSnapshot(ROOM, [human.publicKey]),
          signed(human, {
            created_at: 22,
            kind: KIND_CREATE_GROUP,
            tags: [['h', ROOM]],
            content: '',
          }),
        ]);
        const transcript = selectTranscript(replay(delivery(events, seed)), ROOM);
        expect(
          transcript.some((item) => item.kind === 'human-message' || item.kind === 'agent-message'),
        ).toBe(false);
        expect(JSON.stringify(transcript)).not.toContain('sessionUpdate');
      }),
    );
  });

  it('RM-03 quarantines agent session envelopes while preserving identical human prose', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (body) => {
        const envelope = JSON.stringify({
          sessionId: 's',
          update: { sessionUpdate: 'progress_update', text: body },
        });
        const events = parse([message(agent, envelope, 30), message(human, envelope, 31)]);
        const transcript = selectTranscript(replay(events), ROOM);
        expect(transcript.filter((item) => item.kind === 'human-message')).toHaveLength(1);
        expect(transcript.some((item) => item.kind === 'agent-message')).toBe(false);
        expect(selectRoomRow(replay(events), ROOM).preview?.body).toBe(envelope);
      }),
    );
  });

  it('RM-04 is idempotent under arbitrary redelivery', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (body) => {
        const event = parseRelayEvent(message(human, body, 40), authority());
        const once = reduceWorkspaceSnapshot(replay([]), event);
        expect(reduceWorkspaceSnapshot(once, event)).toBe(once);
      }),
    );
  });

  it('RM-05 converges across shuffled, duplicated, and delayed delivery', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const events = parse([
          message(human, 'one', 50),
          message(agent, 'two', 51, [['t', 'agent-message']]),
          message(human, 'three', 51),
          memberSnapshot(ROOM, [human.publicKey, agent.publicKey], 49),
        ]);
        const expected = replay(events);
        const actual = replay(delivery(events, seed));
        expect(actual).toEqual(expected);
        expect(selectTranscript(actual, ROOM)).toEqual(selectTranscript(expected, ROOM));
      }),
      { numRuns: 100 },
    );
  });

  it('RM-06 never lets an old async commit erase a live human event', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000 }), (epoch) => {
        const live = parseRelayEvent(message(human, 'live', 60), authority());
        const older = parseRelayEvent(message(human, 'older', 10), authority());
        const liveSnapshot = reduceWorkspaceSnapshot(replay([]), live);
        const withBackfill = reduceWorkspaceSnapshot(liveSnapshot, older);
        const committed = commitRoomCoverage(withBackfill, ROOM, {
          epoch,
          initialBackfillComplete: true,
          oldest: 10,
          newest: 10,
        });
        expect(
          selectTranscript(committed, ROOM).filter((item) => item.kind === 'human-message'),
        ).toHaveLength(2);
        expect(selectRoomRow(committed, ROOM).preview?.body).toBe('live');
      }),
    );
  });

  it('RM-07 includes every member even when identity enrichment is partial or empty', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc
            .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 64, maxLength: 64 })
            .map((digits) => digits.join('')),
          { minLength: 1, maxLength: 20 },
        ),
        (pubkeys) => {
          const snapshot = reduceWorkspaceSnapshot(
            createWorkspaceSnapshot({ workspaceId: WORKSPACE }),
            parseRelayEvent(memberSnapshot(ROOM, pubkeys), authority({ identities: {} })),
          );
          expect(selectMembers(snapshot, ROOM).map((member) => member.pubkey)).toEqual(
            [...pubkeys].sort(),
          );
          expect(selectRoomRow(snapshot, ROOM).memberCount).toBe(pubkeys.length);
        },
      ),
    );
  });

  it('RM-08 makes an agent-only nonterminal corner an integrity halt', () => {
    fc.assert(
      fc.property(fc.constantFrom('open', 'working', 'waiting', 'idle'), (state) => {
        const snapshot = replay(
          parse([
            cornerCreate(),
            cornerState(state, 3),
            memberSnapshot(CORNER, [agent.publicKey], 2),
          ]),
        );
        const corners = selectCorners(snapshot, ROOM);
        expect(corners).toHaveLength(1);
        expect(corners[0]?.kind).toBe('integrity-halt');
        expect(selectRoomRow(snapshot, ROOM).cornerCount).toBe(0);
      }),
    );
  });

  it('RM-09 converges deleted and closed corners out of every surface', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const events = parse([
          cornerCreate(),
          cornerState('closed', 4),
          memberSnapshot(CORNER, [human.publicKey, agent.publicKey], 2),
          message(agent, 'historical card', 3, [
            ['t', 'body-control'],
            ['subchannel', CORNER],
          ]),
        ]);
        const snapshot = replay(delivery(events, seed));
        expect(selectCorners(snapshot, ROOM)).toEqual([]);
        expect(selectRoomRow(snapshot, ROOM).cornerCount).toBe(0);
        expect(selectRoomRow(snapshot, ROOM).pinnedCorner).toBeUndefined();
      }),
    );
  });

  it('RM-10 resolves identities late and cannot retain a stale handle', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((value) => value.trim().length > 0),
        (newName) => {
          const snapshot = replay(parse([message(agent, 'answer', 70, [['t', 'agent-message']])]));
          const rebound = replaceIdentitySnapshot(snapshot, [
            humanRecord,
            secondHumanRecord,
            identityRecord(agent, 'agent', newName, 'z-new'),
          ]);
          expect(selectAgentHistory(rebound, ROOM)[0]?.author.label).toBe(newName.trim());
          expect(JSON.stringify(rebound.rooms[ROOM]?.eventJournal)).not.toContain('Buzzy');
        },
      ),
    );
  });

  it('RM-11 isolates foreign channel events from every selector', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (body) => {
        const event = parseRelayEvent(
          message(human, body, 80, [], OTHER_ROOM),
          authority({ expectedChannelId: ROOM }),
        );
        const snapshot = replay([event]);
        expect(event.type).toBe('unknown');
        expect(selectTranscript(snapshot, ROOM)).toEqual([]);
        expect(selectAgentHistory(snapshot, ROOM)).toEqual([]);
      }),
    );
  });

  it('RM-12 constructs replies only from a known same-channel message', () => {
    fc.assert(
      fc.property(fc.boolean(), (foreign) => {
        const parent = message(human, 'parent', 90);
        const child = message(agent, 'reply', 91, [
          ['t', 'agent-message'],
          ['e', parent.id, '', 'reply'],
        ]);
        const context = authority({
          knownMessages: {
            [parent.id]: { channelId: foreign ? OTHER_ROOM : ROOM },
          },
        });
        const snapshot = replay(parse([parent, child], context));
        const childItem = selectTranscript(snapshot, ROOM).find((item) => item.id === child.id);
        expect(childItem?.kind).toBe('agent-message');
        expect(childItem && 'reply' in childItem ? childItem.reply : undefined).toEqual(
          foreign ? undefined : expect.objectContaining({ channelId: ROOM, eventId: parent.id }),
        );
        expect(selectReplyTarget(snapshot, ROOM, parent.id).status).toBe('available');
        expect(selectReplyTarget(snapshot, OTHER_ROOM, parent.id).status).toBe('unavailable');
      }),
    );
  });

  it('RM-13 keeps transcript, roster, corner count, pin, and preview on one revision', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const events = parse([
          message(human, 'latest', 101),
          memberSnapshot(ROOM, [human.publicKey, agent.publicKey], 95),
          cornerCreate(96),
          cornerState('open', 97),
          memberSnapshot(CORNER, [human.publicKey, agent.publicKey], 96),
        ]);
        const snapshot = replay(delivery(events, seed));
        const row = selectRoomRow(snapshot, ROOM);
        expect(row.memberCount).toBe(selectMembers(snapshot, ROOM).length);
        expect(row.cornerCount).toBe(
          selectCorners(snapshot, ROOM).filter((corner) => corner.kind === 'active').length,
        );
        expect(row.pinnedCorner && selectCorners(snapshot, ROOM)).toContain(row.pinnedCorner);
        expect(selectTranscript(snapshot, ROOM).map((item) => item.id)).toContain(row.preview?.id);
      }),
    );
  });

  it('RM-14 renders activity only for a live turn and never eats prose', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0),
        (prose) => {
          const activity = (createdAt: number) =>
            message(
              agent,
              JSON.stringify({
                sessionId: 'session-1',
                update: { sessionUpdate: 'tool_activity', title: 'Read' },
              }),
              createdAt,
              [['t', TAG_AGENT_ACTIVITY]],
            );
          const snapshot = replay(
            parse([message(human, prose, 110), turn('working', 111), activity(111), activity(112)]),
          );
          const transcript = selectTranscript(snapshot, ROOM);
          expect(transcript.map((item) => item.kind)).toEqual(['human-message', 'activity']);
          expect(transcript[1]?.kind === 'activity' && transcript[1].steps).toHaveLength(2);
          const settled = replay(
            parse([
              message(human, prose, 110),
              turn('working', 111),
              activity(112),
              message(agent, 'done', 113, [['t', 'agent-message']]),
              turn('complete', 114),
            ]),
          );
          expect(selectTranscript(settled, ROOM).map((item) => item.kind)).toEqual([
            'human-message',
            'agent-message',
          ]);
        },
      ),
    );
  });

  it('RM-17 maps live thought, tool, and message lanes then spends all machine work on success', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const tool = message(
          agent,
          JSON.stringify({
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'activity_batch',
              updates: [
                {
                  sessionUpdate: 'tool_activity',
                  toolCallId: 'gate',
                  title: 'Certification gate',
                  status: 'completed',
                },
              ],
            },
          }),
          403,
          [['t', TAG_AGENT_ACTIVITY]],
        );
        const liveEvents = parse([
          message(human, 'please check', 400),
          turn('working', 401),
          lane(TAG_AGENT_THOUGHT, 'Checking the gate', 402),
          tool,
          lane(TAG_AGENT_DRAFT, 'The answer is arriving', 404),
        ]);
        const live = selectTranscript(replay(delivery(liveEvents, seed)), ROOM);
        const liveTurn = live.find((item) => item.kind === 'activity');
        expect(liveTurn).toMatchObject({
          kind: 'activity',
          thought: 'Checking the gate',
          messageDraft: 'The answer is arriving',
        });
        expect(liveTurn?.kind === 'activity' && liveTurn.steps[0]?.details[0]?.kind).toBe('tool');

        const settled = replay(
          delivery(
            parse([
              ...[message(human, 'please check', 400), turn('working', 401), tool],
              lane(TAG_AGENT_THOUGHT, '', 405, true),
              lane(TAG_AGENT_DRAFT, '', 406, true),
              message(agent, 'Only this answer remains.', 407, [['t', 'agent-message']]),
              turn('complete', 408),
            ]),
            seed,
          ),
        );
        expect(selectTranscript(settled, ROOM).map((item) => item.kind)).toEqual([
          'human-message',
          'agent-message',
        ]);
        expect(JSON.stringify(snapshotForPersistence(settled))).not.toContain('activity_batch');
      }),
      { numRuns: 60 },
    );
  });

  it('RM-18 keeps exactly one durable failure fact and no thought/tool residue', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const failed = message(
          agent,
          JSON.stringify({
            sessionId: 'physical-session',
            update: {
              sessionUpdate: 'activity_batch',
              updates: [
                {
                  sessionUpdate: 'tool_activity',
                  toolCallId: 'gate',
                  title: 'Certification gate',
                  status: 'failed',
                  output: 'sh: 1: pnpm: not found',
                },
              ],
            },
          }),
          503,
          [
            ['t', TAG_AGENT_ACTIVITY],
            ['status', 'failed'],
          ],
        );
        const snapshot = replay(
          delivery(
            parse([
              message(human, 'run the gate', 500),
              turn('working', 501),
              lane(TAG_AGENT_THOUGHT, 'Running checks', 502),
              failed,
              message(agent, 'The gate could not run.', 504, [['t', 'agent-message']]),
              turn('failed', 505),
            ]),
            seed,
          ),
        );
        const transcript = selectTranscript(snapshot, ROOM);
        expect(transcript.filter((item) => item.kind === 'durable-fact')).toHaveLength(1);
        expect(transcript.filter((item) => item.kind === 'activity')).toHaveLength(0);
        expect(transcript.find((item) => item.kind === 'durable-fact')).toMatchObject({
          factKind: 'failure',
        });
        const persisted = snapshotForPersistence(snapshot);
        expect(JSON.stringify(persisted)).not.toContain('Running checks');
        expect(JSON.stringify(persisted)).toContain('Certification gate');
      }),
      { numRuns: 60 },
    );
  });

  it('RM-19 collapses failure, merge, and consequential action runs to one durable fact', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('failure' as const, 'merge' as const, 'action' as const),
        fc.integer(),
        (factKind, seed) => {
          const factTags =
            factKind === 'failure'
              ? ([['status', 'failed']] as string[][])
              : factKind === 'merge'
                ? ([['delivery-stage', 'landed']] as string[][])
                : ([['t', 'corner-open']] as string[][]);
          const fact = (id: string, createdAt: number) =>
            message(
              agent,
              JSON.stringify({
                sessionId: 'physical-session',
                update: {
                  sessionUpdate: 'activity_batch',
                  updates: [
                    {
                      sessionUpdate: 'tool_activity',
                      toolCallId: id,
                      title: id,
                      status: factKind === 'failure' ? 'failed' : 'completed',
                    },
                  ],
                },
              }),
              createdAt,
              [['t', TAG_AGENT_ACTIVITY], ...factTags],
            );
          const snapshot = replay(
            delivery(
              parse([
                message(human, 'do the consequential work', 600),
                turn('working', 601),
                fact('first fact', 602),
                fact('newest fact', 603),
                message(agent, 'Done.', 604, [['t', 'agent-message']]),
                turn(factKind === 'failure' ? 'failed' : 'complete', 605),
              ]),
              seed,
            ),
          );
          const facts = selectTranscript(snapshot, ROOM).filter(
            (item) => item.kind === 'durable-fact',
          );
          expect(facts).toHaveLength(1);
          expect(facts[0]).toMatchObject({ factKind });
          expect(
            selectTranscript(snapshot, ROOM).filter((item) => item.kind === 'activity'),
          ).toEqual([]);
        },
      ),
      { numRuns: 90 },
    );
  });

  it('RM-15 expands pagination coverage without replacing the recent tail', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100 }), (epoch) => {
        let snapshot = replay(parse([message(human, 'recent', 200)]));
        snapshot = commitRoomCoverage(snapshot, ROOM, {
          epoch,
          initialBackfillComplete: true,
          oldest: 200,
          newest: 200,
        });
        snapshot = reduceWorkspaceSnapshot(
          snapshot,
          parseRelayEvent(message(human, 'old', 2), authority()),
        );
        snapshot = commitRoomCoverage(snapshot, ROOM, {
          epoch: epoch + 1,
          initialBackfillComplete: true,
          oldest: 2,
          newest: 200,
        });
        expect(selectTranscript(snapshot, ROOM).map((item) => item.body)).toEqual([
          'old',
          'recent',
        ]);
        expect(snapshot.rooms[ROOM]?.coverage).toMatchObject({ oldest: 2, newest: 200 });
      }),
    );
  });

  it('RM-16 halts loudly on corrupt or empty cache instead of rendering blank history', () => {
    fc.assert(
      fc.property(fc.anything(), (corrupt) => {
        const result = guardReadModelBoot(corrupt);
        if (result.status === 'ready') {
          expect(result.snapshot.schemaVersion).toBe(1);
        } else {
          expect(result.diagnostic.length).toBeGreaterThan(0);
        }
      }),
    );
    expect(guardReadModelBoot(null).status).toBe('integrity-halt');
    expect(
      guardReadModelBoot({
        schemaVersion: 1,
        workspaceId: WORKSPACE,
        revision: 0,
        identities: {},
        rooms: {},
        diagnostics: [],
      }).status,
    ).toBe('ready');
  });

  it('PROD-ORDER-01 is a total chronological order under every generated delivery permutation', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 10_000 }), { minLength: 1, maxLength: 30 }),
        fc.integer(),
        (timestamps, seed) => {
          const raw = timestamps.map((createdAt, index) =>
            message(human, `chronological-message-${index}`, createdAt),
          );
          const expected = [...raw]
            .sort(
              (left, right) =>
                left.created_at - right.created_at || left.id.localeCompare(right.id),
            )
            .map((event) => event.id);
          const actual = selectTranscript(replay(delivery(parse(raw), seed)), ROOM)
            .filter((item) => item.kind === 'human-message')
            .map((item) => item.id);
          expect(actual).toEqual(expected);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('PROD-CONTROL-01b reproduces that UNMARKED retry narration rides the chat path (producer obligation)', () => {
    // Verbatim capture: Room `charles`, 18:42. The read-model filter is a
    // MARKER boundary (`t=agent-activity/narration` classifies as control;
    // content wording is deliberately never inspected — that stance is what
    // keeps the closed typed-event family honest). The daemon published this
    // text as an ordinary `#t=agent-message`, so it sailed through into chat
    // and the request was marked delivered behind a reply that never existed.
    // This test pins the bypass as the producer obligation: Body must never
    // select or publish narration as final output (see apps/body's
    // `isPureRetryNarration` / `finalAgentMessageText`), because readers will
    // correctly trust any unmarked agent-message they are handed.
    const capturedNarration =
      'Retrying (attempt 1/3, waiting 2s)...Retrying...Retry finished, resuming.';
    const unmarked = message(agent, capturedNarration, 300, [['t', 'agent-message']]);
    const parsed = parseRelayEvent(unmarked, authority());
    expect(parsed.type).toBe('agent-message');
    if (parsed.type !== 'agent-message') return;
    expect(parsed.body).toBe(capturedNarration);
    const snapshot = replay(delivery([parsed], 7));
    const transcript = selectTranscript(snapshot, ROOM);
    // Reproduced: without the wire marker the narration IS chat. The fix is
    // at the publisher, not a content sniff here.
    expect(transcript.some((item) => item.kind === 'agent-message')).toBe(true);
  });

  it('PROD-CONTROL-01 keeps harness retry/backoff narration out of chat', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.nat({ max: 60 }),
        fc.integer(),
        (attempt, waitSeconds, seed) => {
          const retryText =
            `Retrying (attempt ${attempt}/3, waiting ${waitSeconds}s)...` +
            'Retry finished, resuming';
          const retry = message(agent, retryText, 300, [['t', 'agent-activity/narration']]);
          const parsed = parseRelayEvent(retry, authority());
          expect(parsed.type).toBe('control');
          const snapshot = replay(delivery([parsed], seed));
          expect(
            selectTranscript(snapshot, ROOM).some(
              (item) => item.kind === 'human-message' || item.kind === 'agent-message',
            ),
          ).toBe(false);
          expect(selectAgentHistory(snapshot, ROOM)).toEqual([]);
          expect(JSON.stringify(selectRoomRow(snapshot, ROOM))).not.toContain(retryText);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('projects only a validated failed schedule receipt as one system line', () => {
    const nominalAt = 400;
    const runId = deterministicScheduleRunId('nightly', 2, nominalAt);
    const receipt = buildScheduledTurnReceipt(agent, {
      version: 1,
      workspaceId: WORKSPACE,
      roomId: ROOM,
      agentPubkey: agent.publicKey,
      principalPubkey: human.publicKey,
      scheduleId: 'nightly',
      revision: 2,
      runId,
      nominalAt,
      status: 'failed',
      at: 401,
      reservedTokens: 500,
      reason: 'script failed',
    });
    const parsed = parseRelayEvent(receipt, authority());
    expect(parsed).toMatchObject({
      type: 'control',
      visibility: 'system-line',
      payload: { kind: 'system', status: 'failed', text: 'Scheduled work failed: script failed' },
    });
    const transcript = selectTranscript(replay([parsed]), ROOM);
    expect(
      [parsed].filter((item) => item.type === 'control' && item.visibility === 'system-line'),
    ).toHaveLength(1);
    expect(transcript.some((item) => item.kind === 'agent-message')).toBe(false);

    const malformed = signed(agent, {
      created_at: 401,
      kind: 9,
      tags: receipt.tags.map((tag) => (tag[0] === 'status' ? ['status', 'complete'] : [...tag])),
      content: receipt.content,
    });
    expect(parseRelayEvent(malformed, authority())).toMatchObject({
      type: 'unknown',
      reason: 'malformed-schema',
    });
    const wrongRun = JSON.parse(receipt.content) as { runId: string };
    wrongRun.runId = `wsr_${'f'.repeat(64)}`;
    const malformedRun = signed(agent, {
      created_at: 401,
      kind: 9,
      tags: receipt.tags.map((tag) => (tag[0] === 'run' ? ['run', wrongRun.runId] : [...tag])),
      content: JSON.stringify(wrongRun),
    });
    expect(parseRelayEvent(malformedRun, authority())).toMatchObject({
      type: 'unknown',
      reason: 'malformed-schema',
    });
  });
});
