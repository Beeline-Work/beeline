import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  directMessageChannelId,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_PRESENCE,
} from '@beeline/buzz-client';
import {
  migrateAgentPairingClaims,
  migrateRoomReadMarks,
  type DatabaseQueryable,
} from './database.js';
import { RoomIndexer } from './room-indexer.js';

const TENANT = 'e8299f28-f095-472f-941a-80d1195b9a24';
const WORKSPACE = 'ec08be9d-9d9d-413e-b546-959d4abe39df';
const ROOM = '7d111868-52eb-43ab-98ae-8a6c49b92da8';
const CORNER = '80a5a6f1-fb5a-493b-93eb-f3db33f696e6';
const MISSING = '3f37b271-1a12-4d2a-b002-202b3f3582b9';
const VIEWER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const OUTSIDER = 'c'.repeat(64);

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

describe('RoomIndexer', () => {
  let postgres: PGlite;
  let physicalQueries: number;
  let database: DatabaseQueryable;
  let indexer: RoomIndexer;
  let rootMessageId: string;
  let directReplyId: string;

  beforeEach(async () => {
    postgres = new PGlite();
    physicalQueries = 0;
    database = {
      query: async <Row>(text: string, values?: unknown[]) => {
        physicalQueries += 1;
        const result = await postgres.query<Row>(text, values as never[] | undefined);
        return { rows: result.rows };
      },
    };
    indexer = new RoomIndexer(database);
    await postgres.exec(`
      CREATE TABLE channels (
        community_id uuid NOT NULL,
        id uuid NOT NULL,
        name text NOT NULL,
        description text,
        visibility text NOT NULL DEFAULT 'open',
        created_by bytea NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        archived_at timestamptz,
        deleted_at timestamptz,
        PRIMARY KEY (community_id, id)
      );
      CREATE TABLE channel_members (
        community_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        pubkey bytea NOT NULL,
        role text NOT NULL,
        joined_at timestamptz NOT NULL DEFAULT now(),
        invited_by bytea,
        removed_at timestamptz,
        removed_by bytea,
        hidden_at timestamptz,
        PRIMARY KEY (community_id, channel_id, pubkey)
      );
      CREATE TABLE users (
        community_id uuid NOT NULL,
        pubkey bytea NOT NULL,
        display_name text,
        nip05_handle text,
        avatar_url text,
        deactivated_at timestamptz
      );
      CREATE TABLE events (
        community_id uuid NOT NULL,
        id bytea NOT NULL,
        pubkey bytea NOT NULL,
        created_at timestamptz NOT NULL,
        kind integer NOT NULL,
        tags jsonb NOT NULL,
        content text NOT NULL,
        d_tag text,
        channel_id uuid,
        deleted_at timestamptz
      );
    `);
    await migrateRoomReadMarks(database);
    await migrateAgentPairingClaims(database);
    await postgres.query(
      `INSERT INTO channels
        (community_id, id, name, description, visibility, created_by, created_at, updated_at)
       VALUES
        ($1, $2, 'Builders', 'Workspace about', 'private', $5, to_timestamp(1), to_timestamp(9)),
        ($1, $3, 'Fast Room', 'Room about', 'open', $5, to_timestamp(2), to_timestamp(8)),
        ($1, $4, 'Agent corner', 'Build it', 'open', $6, to_timestamp(5), to_timestamp(5))`,
      [TENANT, WORKSPACE, ROOM, CORNER, bytes(VIEWER), bytes(AGENT)],
    );
    for (const channelId of [WORKSPACE, ROOM, CORNER]) {
      await postgres.query(
        `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
         VALUES ($1, $2, $3, 'owner'), ($1, $2, $4, 'member')`,
        [TENANT, channelId, bytes(VIEWER), bytes(AGENT)],
      );
    }
    await postgres.query(
      `INSERT INTO users (community_id, pubkey, display_name, nip05_handle, avatar_url)
       VALUES ($1, $2, 'Ada', 'ada@example.test', 'https://media.test/ada.png')`,
      [TENANT, bytes(VIEWER)],
    );

    let eventNumber = 1;
    const event = async (
      channelId: string,
      pubkey: string,
      createdAt: number,
      kind: number,
      tags: string[][],
      content = '',
    ) => {
      const id = eventNumber.toString(16).padStart(64, '0');
      eventNumber += 1;
      await postgres.query(
        `INSERT INTO events
          (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
         VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9::text)`,
        [
          TENANT,
          bytes(id),
          bytes(pubkey),
          createdAt,
          kind,
          JSON.stringify(tags),
          content,
          kind === 30078 ? null : channelId,
          tags.find((tag) => tag[0] === 'd')?.[1] ?? null,
        ],
      );
      return id;
    };

    await event(WORKSPACE, VIEWER, 1, 9007, [
      ['h', WORKSPACE],
      ['community', WORKSPACE],
      ['name', 'Builders'],
    ]);
    // The relay's 39000 projection retains the namespaced purpose instead of
    // an arbitrary image field. The indexer must make that current metadata
    // visible to every Workspace surface, not fall back to the 9007 create.
    await event(WORKSPACE, VIEWER, 11, 39000, [
      ['d', WORKSPACE],
      ['h', WORKSPACE],
      ['purpose', 'buzz-workspace-avatar:https://media.test/workspace-projected.png'],
    ]);
    await event(ROOM, VIEWER, 2, 9007, [
      ['h', ROOM],
      ['community', WORKSPACE],
      ['name', 'Fast Room'],
    ]);
    await event(CORNER, AGENT, 5, 9007, [
      ['h', CORNER],
      ['community', WORKSPACE],
      ['parent', ROOM],
      ['name', 'Agent corner'],
      ['task', 'Build it'],
    ]);
    await event(
      WORKSPACE,
      AGENT,
      3,
      9,
      [
        ['h', WORKSPACE],
        ['t', 'buzz-agent'],
        ['agent', AGENT],
      ],
      JSON.stringify({ displayName: 'Milo', avatar: 'https://media.test/milo.png' }),
    );
    rootMessageId = await event(ROOM, VIEWER, 3, 9, [['h', ROOM]], 'Hello');
    directReplyId = await event(
      ROOM,
      AGENT,
      4,
      9,
      [
        ['h', ROOM],
        ['e', rootMessageId, '', 'reply'],
      ],
      'Ready',
    );
    await event(ROOM, AGENT, 12, 9, [
      ['h', ROOM],
      ['t', 'agent-turn'],
      ['request', 'c'.repeat(64)],
      ['session', 'session-1'],
      ['agent', AGENT],
      ['mode', 'readonly'],
      ['status', 'working'],
      ['generation', 'generation-1'],
    ]);
    await event(ROOM, AGENT, 10, KIND_AGENT_PRESENCE, [
      ['h', ROOM],
      ['d', `${TAG_AGENT_PRESENCE}:${ROOM}`],
      ['t', TAG_AGENT_PRESENCE],
      ['agent', AGENT],
      ['status', 'online'],
    ]);
    await event(CORNER, AGENT, 6, 9, [['h', CORNER]], 'Working');
    await event(CORNER, AGENT, 7, 30078, [
      ['h', ROOM],
      ['d', `buzz-corner-state:${CORNER}`],
      ['t', 'buzz-corner-state'],
      ['state', 'working'],
    ]);
    await event(
      ROOM,
      VIEWER,
      4,
      30078,
      [
        ['h', ROOM],
        ['d', `buzz-room-repository:${ROOM}`],
        ['t', 'buzz-room-repository'],
      ],
      JSON.stringify({
        key: 'github:1',
        name: 'beeline',
        remote: 'git://github.com/acme/beeline',
        targetBranch: 'main',
        githubEventsEnabled: true,
      }),
    );
    const token = `bzi_${'d'.repeat(64)}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await event(WORKSPACE, VIEWER, 10, 30078, [
      ['h', WORKSPACE],
      ['community', WORKSPACE],
      ['t', 'buzz-community-invite'],
      ['d', tokenHash],
      ['expiration', '2000000000'],
    ]);
  });

  afterEach(async () => {
    await postgres.close();
  });

  it('opens a Room with one physical bounded query and resolved paint rows', async () => {
    physicalQueries = 0;
    const view = await indexer.readRoom(ROOM, VIEWER);

    expect(physicalQueries).toBe(1);
    expect(view).toMatchObject({
      room: { id: ROOM, workspaceId: WORKSPACE, name: 'Fast Room' },
      repositoryResolution: 'repository',
      viewer: { identity: { name: 'Ada' }, role: 'owner' },
      members: [
        { identity: { pubkey: VIEWER, kind: 'human', name: 'Ada' }, role: 'owner' },
        {
          identity: { pubkey: AGENT, kind: 'agent', name: 'Milo' },
          role: 'member',
          presence: { status: 'online', observedAt: 10, roomId: ROOM },
        },
      ],
      latestAgentTurns: [
        {
          requestId: 'c'.repeat(64),
          agentPubkey: AGENT,
          status: 'working',
          createdAt: 12,
          generationId: 'generation-1',
        },
      ],
      corners: [{ corner: { id: CORNER, updatedAt: 5 } }],
    });
    expect(view?.messages.map((message) => [message.text, message.author.name])).toEqual([
      ['Hello', 'Ada'],
      ['Ready', 'Milo'],
    ]);
  });

  it('pages every same-second message through a cursor beyond four thousand events', async () => {
    const firstSequence = 10_000;
    const count = 4_096;
    const ids = Array.from({ length: count }, (_, index) =>
      (firstSequence + index).toString(16).padStart(64, '0'),
    );
    // The cursor needs both coordinates: production can legitimately publish
    // thousands of Room events in one relay-second. If its id tie-breaker ever
    // reverses or becomes inclusive, a page boundary silently drops or repeats
    // part of this burst.
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       SELECT $1, decode(lpad(to_hex(sequence), 64, '0'), 'hex'), $2, to_timestamp(100), 9,
         jsonb_build_array(jsonb_build_array('h', $3::text)),
         'same-second message ' || sequence, $3::uuid
       FROM generate_series($4::int, $5::int) sequence`,
      [TENANT, bytes(VIEWER), ROOM, firstSequence, firstSequence + count - 1],
    );

    const seen: string[] = [];
    let before: { createdAt: number; id: string } | undefined;
    for (;;) {
      const page = await indexer.readHistory(ROOM, VIEWER, before);
      expect(page).not.toBeNull();
      seen.push(...(page?.messages.map((message) => message.id) ?? []));
      if (!page?.nextBefore) break;
      before = page.nextBefore;
    }

    expect(seen.filter((id) => ids.includes(id))).toEqual(ids);
  }, 30_000);

  it('late-opens a corner with its first durable reply after activity exhausts the raw window', async () => {
    const requestId = '1'.repeat(64);
    const firstReplyId = 'e'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, to_timestamp(20), 9, $4, $5, $6)`,
      [
        TENANT,
        bytes(firstReplyId),
        bytes(AGENT),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-message'],
          ['request', requestId],
        ]),
        'The first durable corner reply survives a late open.',
        CORNER,
      ],
    );
    // Pre-agent-message corners carried their authored answer only inside an
    // activity batch. It belongs in the bounded conversation lane even after
    // later machine receipts exhaust the raw page.
    const legacyReplyId = 'c'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, to_timestamp(19), 9, $4, $5, $6)`,
      [
        TENANT,
        bytes(legacyReplyId),
        bytes(AGENT),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-activity'],
          ['session', 'legacy-corner-turn'],
        ]),
        JSON.stringify({
          sessionId: 'legacy-corner-turn',
          update: {
            sessionUpdate: 'activity_batch',
            updates: [
              {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'The older model reply also survives.' },
              },
            ],
          },
        }),
        CORNER,
      ],
    );
    // Activity rows themselves leave the terminal transcript, but their last
    // complete plan remains the objective panel's durable fixture.
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, d_tag, channel_id)
       VALUES ($1, $2, $3, to_timestamp(499), 30078, $4, $5, $6, NULL)`,
      [
        TENANT,
        bytes('f'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-activity'],
          ['request', requestId],
        ]),
        JSON.stringify({
          sessionId: 'first-corner-turn',
          update: {
            sessionUpdate: 'plan',
            plan: {
              objective: 'Keep the objective and checklist visible after completion.',
              items: [{ step: 'Persist the plan', status: 'completed' }],
            },
          },
        }),
        `buzz-agent-activity:${CORNER}:first-corner-turn`,
      ],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       SELECT $1, decode(lpad(to_hex(1000 + n), 64, '0'), 'hex'), $2,
         to_timestamp(20 + n), 9, $3,
         jsonb_build_object(
           'sessionId', 'first-corner-turn',
           'update', jsonb_build_object(
             'sessionUpdate', 'tool_call', 'title', 'Read file', 'status', 'completed'
           )
         )::text,
         $4
       FROM generate_series(1, 190) n`,
      [
        TENANT,
        bytes(AGENT),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-activity'],
          ['request', requestId],
        ]),
        CORNER,
      ],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, to_timestamp(500), 9, $4, '', $5)`,
      [
        TENANT,
        bytes('d'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-turn'],
          ['request', requestId],
          ['agent', AGENT],
          ['status', 'complete'],
        ]),
        CORNER,
      ],
    );

    const lateOpen = await indexer.readRoom(CORNER, VIEWER);

    expect(lateOpen?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstReplyId,
          text: 'The first durable corner reply survives a late open.',
          presentation: 'message',
        }),
        expect.objectContaining({
          id: legacyReplyId,
          text: 'The older model reply also survives.',
          presentation: 'message',
        }),
      ]),
    );
    expect(lateOpen?.messages.some((message) => message.presentation === 'activity')).toBe(false);
    expect(lateOpen?.cornerPlan).toEqual({
      objective: 'Keep the objective and checklist visible after completion.',
      items: [{ step: 'Persist the plan', status: 'completed' }],
    });
  });

  it('indexes a Room repository by its parameterized d key without channel_id', async () => {
    // Production relay storage does not stamp channel_id for kind:30078. The
    // d tag is the indexed coordinate for parameterized replaceable records.
    await postgres.query(
      `UPDATE events SET channel_id = NULL
       WHERE community_id = $1 AND kind = 30078
         AND d_tag = $2`,
      [TENANT, `buzz-room-repository:${ROOM}`],
    );

    const room = await indexer.readRoom(ROOM, VIEWER);
    expect(room?.repositoryResolution).toBe('repository');
    expect(room?.repository?.key).toBe('github:1');

    const chats = await indexer.readChats(WORKSPACE, VIEWER);
    expect(chats?.chats.find((chat) => chat.room.id === ROOM)?.repositoryName).toBe('beeline');
  });

  it('never renders a removed ghost agent as thinking/working on any surface', async () => {
    // A human removal (`removeAgent`) evicts channel_members rows, but it can
    // never retract another key's already-published relay events: the
    // fixture's AGENT keeps its stale "working" room turn, "working"
    // corner-state lease, and "online" presence heartbeat exactly as
    // published above. Once evicted, none of those receipts may resurrect a
    // thinking/working render anywhere — the Room progress line, the pinned
    // sibling corner bar, the standalone corner screen, or the Room-list dot.
    await postgres.query(
      `UPDATE channel_members SET removed_at = to_timestamp(20)
       WHERE community_id = $1 AND pubkey = $2`,
      [TENANT, bytes(AGENT)],
    );

    const room = await indexer.readRoom(ROOM, VIEWER);
    expect(room?.latestAgentTurns).toEqual([]);
    expect(room?.members.some((member) => member.identity.pubkey === AGENT)).toBe(false);
    expect(room?.corners).toMatchObject([{ corner: { id: CORNER }, status: 'idle' }]);

    const chats = await indexer.readChats(WORKSPACE, VIEWER);
    expect(chats?.chats.find((chat) => chat.room.id === ROOM)?.agentState).toBeUndefined();

    const corners = await indexer.readCorners(ROOM, VIEWER);
    expect(corners?.corners).toMatchObject([{ corner: { id: CORNER }, status: 'idle' }]);
  });

  it('keeps a predecessor-authored repository binding unverified instead of calling it absent', async () => {
    await postgres.query(
      `DELETE FROM events
       WHERE community_id = $1 AND d_tag = $2 AND kind = 30078
         AND tags @> '[["t", "buzz-room-repository"]]'::jsonb`,
      [TENANT, `buzz-room-repository:${ROOM}`],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(20), 30078, $4, $5, NULL, $6)`,
      [
        TENANT,
        bytes('e'.repeat(64)),
        bytes(OUTSIDER),
        JSON.stringify([
          ['h', ROOM],
          ['d', `buzz-room-repository:${ROOM}`],
          ['t', 'buzz-room-repository'],
        ]),
        JSON.stringify({
          key: 'github:1',
          name: 'beeline',
          remote: 'git://github.com/acme/beeline',
        }),
        `buzz-room-repository:${ROOM}`,
      ],
    );

    const view = await indexer.readRoom(ROOM, VIEWER);

    expect(view?.repository).toBeUndefined();
    expect(view?.repositoryResolution).toBe('unverified');
  });

  it('does not retain predecessor repository authority after identity recovery', async () => {
    const successor = 'd'.repeat(64);
    // Recovery moves the person to a fresh key. The old binding remains in the
    // relay forever, but the direct view must evaluate it against current
    // membership on every read instead of retaining an auth-era alias.
    await postgres.query(
      `UPDATE channel_members SET removed_at = to_timestamp(20)
       WHERE community_id = $1 AND pubkey = $2`,
      [TENANT, bytes(VIEWER)],
    );
    for (const channelId of [WORKSPACE, ROOM]) {
      await postgres.query(
        `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
         VALUES ($1, $2, $3, 'owner')`,
        [TENANT, channelId, bytes(successor)],
      );
    }

    const view = await indexer.readRoom(ROOM, successor);

    expect(view?.viewer).toMatchObject({ identity: { pubkey: successor }, role: 'owner' });
    expect(view?.repository).toBeUndefined();
    expect(view?.repositoryResolution).toBe('unverified');
  });

  it('reports none only when the Room has no repository event at all', async () => {
    await postgres.query(
      `DELETE FROM events
       WHERE community_id = $1 AND d_tag = $2 AND kind = 30078
         AND tags @> '[["t", "buzz-room-repository"]]'::jsonb`,
      [TENANT, `buzz-room-repository:${ROOM}`],
    );

    const view = await indexer.readRoom(ROOM, VIEWER);

    expect(view?.repository).toBeUndefined();
    expect(view?.repositoryResolution).toBe('none');
  });

  it('returns the original same-Room root as the proof for a current direct reply', async () => {
    const nestedReplyId = '7'.repeat(64);
    const deepReplyId = '6'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES
        ($1, $2, $3, to_timestamp(15), 9, $4, 'Nested reply', $5),
        ($1, $6, $3, to_timestamp(16), 9, $7, 'Deep reply', $5)`,
      [
        TENANT,
        bytes(nestedReplyId),
        bytes(VIEWER),
        JSON.stringify([
          ['h', ROOM],
          ['e', rootMessageId, '', 'root'],
          ['e', directReplyId, '', 'reply'],
        ]),
        ROOM,
        bytes(deepReplyId),
        JSON.stringify([
          ['h', ROOM],
          ['e', rootMessageId, '', 'root'],
          ['e', nestedReplyId, '', 'reply'],
        ]),
      ],
    );
    const room = await indexer.readRoom(ROOM, VIEWER);
    const history = await indexer.readHistory(ROOM, VIEWER);

    for (const messages of [room?.messages, history?.messages]) {
      expect(messages?.find((message) => message.id === rootMessageId)?.reference).toEqual({
        channelId: ROOM,
        eventId: rootMessageId,
        rootId: rootMessageId,
      });
      expect(messages?.find((message) => message.id === directReplyId)).toMatchObject({
        reply: { channelId: ROOM, eventId: rootMessageId, rootId: rootMessageId },
        reference: { channelId: ROOM, eventId: directReplyId, rootId: rootMessageId },
      });
      expect(messages?.find((message) => message.id === nestedReplyId)).toMatchObject({
        reply: { channelId: ROOM, eventId: directReplyId, rootId: rootMessageId },
        reference: { channelId: ROOM, eventId: nestedReplyId, rootId: rootMessageId },
      });
      expect(messages?.find((message) => message.id === deepReplyId)).toMatchObject({
        reply: { channelId: ROOM, eventId: nestedReplyId, rootId: rootMessageId },
        reference: { channelId: ROOM, eventId: deepReplyId, rootId: rootMessageId },
      });
    }
  });

  it('projects delegation replies and limit/refusal lines as visible rooted conversation', async () => {
    const delegatedId = '4'.repeat(64);
    const limitId = '5'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES
        ($1, $2, $3, to_timestamp(80), 9, $4, '@peer produce the quotes.', $5),
        ($1, $6, $3, to_timestamp(81), 9, $7, 'Delegation limit reached after 4 agent-initiated hops.', $5)`,
      [
        TENANT,
        bytes(delegatedId),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'agent-message'],
          ['t', 'buzz-agent-delegation'],
          ['e', rootMessageId, '', 'reply'],
          ['root-request', rootMessageId],
          ['root-human', VIEWER],
          ['from-agent', AGENT],
          ['to-agent', OUTSIDER],
          ['hop', '1'],
          ['p', OUTSIDER],
        ]),
        ROOM,
        bytes(limitId),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'agent-message'],
          ['t', 'buzz-agent-delegation'],
          ['e', rootMessageId, '', 'root'],
          ['e', delegatedId, '', 'reply'],
          ['root-request', rootMessageId],
          ['root-human', VIEWER],
          ['delegation-status', 'limit'],
        ]),
      ],
    );

    const room = await indexer.readRoom(ROOM, VIEWER);
    expect(room?.messages.find((message) => message.id === delegatedId)).toMatchObject({
      presentation: 'message',
      author: { pubkey: AGENT, kind: 'agent' },
      mentionPubkeys: [OUTSIDER],
      reply: { channelId: ROOM, eventId: rootMessageId, rootId: rootMessageId },
    });
    expect(room?.messages.find((message) => message.id === limitId)).toMatchObject({
      presentation: 'message',
      reply: { channelId: ROOM, eventId: delegatedId, rootId: rootMessageId },
    });

    const chats = await indexer.readChats(WORKSPACE, VIEWER);
    expect(chats?.chats.find((chat) => chat.room.id === ROOM)?.latestMessage?.text).toContain(
      'Delegation limit reached',
    );
  });

  it('tombstones retired agent notices before transcript and preview projection', async () => {
    const stallText =
      'Still working on this — my coding backend is taking longer than usual to respond.';
    const roomStallId = '9'.repeat(64);
    const cornerStallId = '8'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES
        ($1, $2, $3, to_timestamp(20), 9, $4, $5, $6),
        ($1, $7, $3, to_timestamp(21), 9, $8, $5, $9)`,
      [
        TENANT,
        bytes(roomStallId),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'agent-message'],
        ]),
        stallText,
        ROOM,
        bytes(cornerStallId),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-message'],
        ]),
        CORNER,
      ],
    );

    const room = await indexer.readRoom(ROOM, VIEWER);
    const history = await indexer.readHistory(ROOM, VIEWER);
    const chats = await indexer.readChats(WORKSPACE, VIEWER);
    const corners = await indexer.readCorners(ROOM, VIEWER);

    expect(room?.messages.map((message) => message.id)).not.toContain(roomStallId);
    expect(history?.messages.map((message) => message.id)).not.toContain(roomStallId);
    expect(chats?.chats.find((chat) => chat.room.id === ROOM)?.latestMessage).toMatchObject({
      id: directReplyId,
      text: 'Ready',
    });
    expect(
      corners?.corners.find((corner) => corner.corner.id === CORNER)?.latestMessage,
    ).toMatchObject({
      text: 'Working',
    });
  });

  it('tombstones the bounded structural retired-notice shapes too', async () => {
    // A relay event cannot be unpublished, so the two bounded structural
    // shapes (a raw attachment-delivery ENOENT dump, and the model-unavailable
    // wall — both carry variable data so they cannot join the exact-set list)
    // must be caught here the same as the exact-text notices above.
    const attachmentEnoent =
      'Attachment unavailable: ENOENT: no such file or directory, realpath ' +
      "'/proc/2952774/root/home/lunchbox/.local/state/beeline/agents/agent/rooms/room/agent-private/workbench/report.html'";
    const modelUnavailable =
      'Model validation unavailable · gpt-5\n' +
      'The live harness catalog could not verify "gpt-5".\n' +
      'Restore access to the selected harness and its live catalog, then restart the agent.';
    const attachmentWallId = '5'.repeat(64);
    const modelWallId = '4'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES
        ($1, $2, $3, to_timestamp(20), 9, $4, $5, $6),
        ($1, $7, $3, to_timestamp(21), 9, $4, $8, $6)`,
      [
        TENANT,
        bytes(attachmentWallId),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'agent-message'],
        ]),
        attachmentEnoent,
        ROOM,
        bytes(modelWallId),
        modelUnavailable,
      ],
    );

    const room = await indexer.readRoom(ROOM, VIEWER);
    const history = await indexer.readHistory(ROOM, VIEWER);

    expect(room?.messages.map((message) => message.id)).not.toContain(attachmentWallId);
    expect(room?.messages.map((message) => message.id)).not.toContain(modelWallId);
    expect(history?.messages.map((message) => message.id)).not.toContain(attachmentWallId);
    expect(history?.messages.map((message) => message.id)).not.toContain(modelWallId);
  });

  it('rolls the Room deck up to the max-severity state of the room turn and its corners', async () => {
    // The fixture already published a working room-level agent-turn for ROOM
    // (created_at=12) and a working corner-state for CORNER, parented on
    // ROOM (created_at=7). A live turn or a live corner must gold/spin the
    // deck row even when nothing in the Room is unread.
    const working = await indexer.readChats(WORKSPACE, VIEWER);
    expect(working?.chats.find((chat) => chat.room.id === ROOM)).toMatchObject({
      agentState: 'working',
    });

    // Legacy corner-state records are non-rendered machine facts and do not
    // override the signed room turn receipt.
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(30), 30078, $4, '', NULL, $5)`,
      [
        TENANT,
        bytes('9'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['d', `buzz-corner-state:${CORNER}`],
          ['t', 'buzz-corner-state'],
          ['state', 'waiting-on-human'],
          ['reason', 'question'],
        ]),
        `buzz-corner-state:${CORNER}`,
      ],
    );
    const needsYou = await indexer.readChats(WORKSPACE, VIEWER);
    expect(needsYou?.chats.find((chat) => chat.room.id === ROOM)).toMatchObject({
      agentState: 'working',
    });

    // Once the room turn completes and the corner concludes, the rollup
    // clears — an old lease does not linger forever.
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(31), 9, $4, '', $5, NULL)`,
      [
        TENANT,
        bytes('8'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'agent-turn'],
          ['request', 'c'.repeat(64)],
          ['session', 'session-1'],
          ['agent', AGENT],
          ['mode', 'readonly'],
          ['status', 'complete'],
          ['generation', 'generation-1'],
        ]),
        ROOM,
      ],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(32), 30078, $4, '', NULL, $5)`,
      [
        TENANT,
        bytes('7'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['d', `buzz-corner-state:${CORNER}`],
          ['t', 'buzz-corner-state'],
          ['state', 'concluded'],
        ]),
        `buzz-corner-state:${CORNER}`,
      ],
    );
    const idle = await indexer.readChats(WORKSPACE, VIEWER);
    expect(idle?.chats.find((chat) => chat.room.id === ROOM)?.agentState).toBeUndefined();
  });

  it("excludes terminal corners from the Room row's corner count", async () => {
    // The base fixture's CORNER is already 'working' (created_at=7), so the
    // row starts with one open corner — the count a person can act on.
    const working = await indexer.readChats(WORKSPACE, VIEWER);
    expect(working?.chats.find((chat) => chat.room.id === ROOM)).toMatchObject({
      cornerCount: 1,
    });

    // A legacy corner-state record is not a durable lifecycle authority. The
    // metadata child remains counted until its channel is actually archived.
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(20), 30078, $4, '', NULL, $5)`,
      [
        TENANT,
        bytes('6'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['d', `buzz-corner-state:${CORNER}`],
          ['t', 'buzz-corner-state'],
          ['state', 'concluded'],
        ]),
        `buzz-corner-state:${CORNER}`,
      ],
    );
    const concluded = await indexer.readChats(WORKSPACE, VIEWER);
    expect(concluded?.chats.find((chat) => chat.room.id === ROOM)).toMatchObject({
      cornerCount: 1,
    });

    // A corner archived outright (post-cleanup 'closed', or a bare archive)
    // must never resurface in the count either.
    await postgres.query(
      `UPDATE channels SET archived_at = now() WHERE community_id = $1 AND id = $2`,
      [TENANT, CORNER],
    );
    const archived = await indexer.readChats(WORKSPACE, VIEWER);
    expect(archived?.chats.find((chat) => chat.room.id === ROOM)).toMatchObject({
      cornerCount: 0,
    });
  });

  it('watches corner lifecycle coordinates that can change the Room list', async () => {
    const chats = await indexer.readChats(WORKSPACE, VIEWER);
    const archiveFilter = chats?.watchFilters.find(
      (filter) => filter.kinds?.includes(9002) && filter['#h']?.includes(CORNER),
    );
    const cornerStateFilter = chats?.watchFilters.find(
      (filter) => filter.kinds?.includes(30078) && filter['#h']?.includes(ROOM),
    );
    const metadataFilter = chats?.watchFilters.find(
      (filter) => filter.kinds?.includes(39000) && filter['#d']?.includes(CORNER),
    );

    expect(archiveFilter).toBeDefined();
    expect(cornerStateFilter).toBeDefined();
    expect(metadataFilter).toBeDefined();
  });

  it('watches remote lifecycle facts by h even when storage channel_id is null', async () => {
    const corner = await indexer.readRoom(CORNER, VIEWER);
    const lifecycleFilter = corner?.watchFilters.find(
      (filter) => filter.kinds?.includes(30078) && filter['#h']?.includes(CORNER),
    );

    expect(lifecycleFilter).toBeDefined();
  });

  it('serves an archived corner transcript read-only to its members', async () => {
    await postgres.query(
      `UPDATE channels SET archived_at = now() WHERE community_id = $1 AND id = $2`,
      [TENANT, CORNER],
    );

    const archived = await indexer.readRoom(CORNER, VIEWER);

    expect(archived).toMatchObject({
      room: { id: CORNER, archived: true },
      viewer: { permissions: { send: false } },
    });
    expect(archived?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Working' })]),
    );
  });

  it('withholds reply proof from deleted or foreign ancestry', async () => {
    const foreignParentId = 'c'.repeat(64);
    const foreignReplyId = 'd'.repeat(64);
    const deletedParentId = 'e'.repeat(64);
    const deletedReplyId = 'f'.repeat(64);
    const legacyNestedReplyId = 'a'.repeat(64);
    const deletedRootReplyId = 'b'.repeat(64);
    const rootOnlyReplyId = '0'.repeat(64);
    const redundantRootReplyId = '1'.repeat(64);
    const otherRootId = '2'.repeat(64);
    const mismatchedRootReplyId = '3'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, deleted_at)
       VALUES
        ($1, $2, $3, to_timestamp(20), 9, $4, 'Foreign parent', $5, NULL),
        ($1, $6, $3, to_timestamp(21), 9, $7, 'Foreign reply', $8, NULL),
        ($1, $9, $3, to_timestamp(22), 9, $10, 'Deleted parent', $8, now()),
        ($1, $11, $3, to_timestamp(23), 9, $12, 'Deleted reply', $8, NULL),
        ($1, $13, $3, to_timestamp(24), 9, $14,
          'Legacy nested reply without a root marker', $8, NULL),
        ($1, $15, $3, to_timestamp(25), 9, $16,
          'Nested reply with a deleted root', $8, NULL)`,
      [
        TENANT,
        bytes(foreignParentId),
        bytes(VIEWER),
        JSON.stringify([['h', CORNER]]),
        CORNER,
        bytes(foreignReplyId),
        JSON.stringify([
          ['h', ROOM],
          ['e', foreignParentId, '', 'reply'],
        ]),
        ROOM,
        bytes(deletedParentId),
        JSON.stringify([['h', ROOM]]),
        bytes(deletedReplyId),
        JSON.stringify([
          ['h', ROOM],
          ['e', deletedParentId, '', 'reply'],
        ]),
        bytes(legacyNestedReplyId),
        JSON.stringify([
          ['h', ROOM],
          ['e', directReplyId, '', 'reply'],
        ]),
        bytes(deletedRootReplyId),
        JSON.stringify([
          ['h', ROOM],
          ['e', deletedParentId, '', 'root'],
          ['e', directReplyId, '', 'reply'],
        ]),
      ],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES
        ($1, $2, $3, to_timestamp(26), 9, $4, 'Root marker without reply', $5),
        ($1, $6, $3, to_timestamp(27), 9, $7, 'Redundant root on direct reply', $5),
        ($1, $8, $3, to_timestamp(28), 9, $9, 'Other root', $5),
        ($1, $10, $3, to_timestamp(29), 9, $11, 'Mismatched nested root', $5)`,
      [
        TENANT,
        bytes(rootOnlyReplyId),
        bytes(VIEWER),
        JSON.stringify([
          ['h', ROOM],
          ['e', rootMessageId, '', 'root'],
        ]),
        ROOM,
        bytes(redundantRootReplyId),
        JSON.stringify([
          ['h', ROOM],
          ['e', rootMessageId, '', 'root'],
          ['e', rootMessageId, '', 'reply'],
        ]),
        bytes(otherRootId),
        JSON.stringify([['h', ROOM]]),
        bytes(mismatchedRootReplyId),
        JSON.stringify([
          ['h', ROOM],
          ['e', otherRootId, '', 'root'],
          ['e', directReplyId, '', 'reply'],
        ]),
      ],
    );

    const room = await indexer.readRoom(ROOM, VIEWER);
    for (const id of [
      foreignReplyId,
      deletedReplyId,
      legacyNestedReplyId,
      deletedRootReplyId,
      rootOnlyReplyId,
      redundantRootReplyId,
      mismatchedRootReplyId,
    ]) {
      const message = room?.messages.find((candidate) => candidate.id === id);
      expect(message?.id).toBe(id);
      expect(message?.reference).toBeUndefined();
      expect(message?.reply).toBeUndefined();
    }
  });

  it('returns the latest terminal receipt so completion clears a working turn', async () => {
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, to_timestamp(13), 9, $4, 'Agent reply complete.', $5)`,
      [
        TENANT,
        bytes('9'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'agent-turn'],
          ['request', 'c'.repeat(64)],
          ['session', 'session-1'],
          ['agent', AGENT],
          ['mode', 'readonly'],
          ['status', 'complete'],
          ['generation', 'generation-1'],
        ]),
        ROOM,
      ],
    );

    await expect(indexer.readRoom(ROOM, VIEWER)).resolves.toMatchObject({
      latestAgentTurns: [
        {
          requestId: 'c'.repeat(64),
          agentPubkey: AGENT,
          status: 'complete',
          createdAt: 13,
          generationId: 'generation-1',
        },
      ],
    });
  });

  it('suppresses every legacy model-availability diagnostic from indexed surfaces', async () => {
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES
        ($1, $2, $3, to_timestamp(11), 9, $4, 'Ready', $8),
        ($1, $5, $3, to_timestamp(12), 9, $6, 'Model unavailable · retired-model', $8),
        ($1, $7, $3, to_timestamp(13), 9, $9, 'Model validation unavailable · gpt-5', $8),
        ($1, $10, $3, to_timestamp(14), 9, $11, '', $8)`,
      [
        TENANT,
        bytes('a'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'agent-message'],
        ]),
        bytes('b'.repeat(64)),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'buzz-agent-model-unavailable'],
          ['status', 'model-unavailable'],
          ['unavailable', 'model'],
          ['unavailable-value', 'openrouter-ox/z-ai/glm-5.3-flash'],
        ]),
        bytes('c'.repeat(64)),
        ROOM,
        JSON.stringify([
          ['h', ROOM],
          ['t', 'buzz-agent-model-unavailable'],
          ['status', 'validation-unavailable'],
          ['unavailable', 'selection'],
          ['unavailable-value', 'gpt-5'],
        ]),
        bytes('d'.repeat(64)),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'buzz-agent-model-unavailable'],
          ['status', 'model-available'],
        ]),
      ],
    );

    const view = await indexer.readRoom(ROOM, VIEWER);
    const history = await indexer.readHistory(ROOM, VIEWER);
    const chats = await indexer.readChats(WORKSPACE, VIEWER);
    const retiredIds = ['b', 'c', 'd'].map((id) => id.repeat(64));

    expect(view?.messages.map((message) => message.id)).toContain('a'.repeat(64));
    expect(history?.messages.map((message) => message.id)).toContain('a'.repeat(64));
    expect(view?.messages.map((message) => message.id)).toEqual(
      expect.not.arrayContaining(retiredIds),
    );
    expect(history?.messages.map((message) => message.id)).toEqual(
      expect.not.arrayContaining(retiredIds),
    );
    expect(chats?.chats.find((chat) => chat.room.id === ROOM)?.latestMessage).toMatchObject({
      id: 'a'.repeat(64),
      text: 'Ready',
    });
  });

  it('classifies a mixed durable inbox so only human and agent conversation can enter model history', async () => {
    const inbox = [
      {
        id: 'a'.repeat(64),
        createdAt: 12,
        pubkey: AGENT,
        markers: ['body-control'],
        text: '🤖 Agent session started',
      },
      {
        id: 'b'.repeat(64),
        createdAt: 13,
        pubkey: AGENT,
        markers: ['agent-message', 'buzz-agent-model-unavailable'],
        text: 'Model unavailable · unavailable-model',
      },
      {
        id: 'c'.repeat(64),
        createdAt: 14,
        pubkey: AGENT,
        markers: ['github-event'],
        extraTags: [
          ['service', 'beeline-events'],
          ['github-event-type', 'pull-request'],
          ['github-event-action', 'merged'],
          ['github-event-actor', 'lena'],
          ['github-event-title', 'Ship the card'],
          ['github-event-url', 'https://github.com/acme/widget/pull/42'],
          ['github-event-id', '42'],
        ],
        text: '',
      },
      {
        id: 'd'.repeat(64),
        createdAt: 15,
        pubkey: AGENT,
        markers: ['github-event-health'],
        text: 'GitHub polling degraded',
      },
      {
        id: 'e'.repeat(64),
        createdAt: 16,
        pubkey: AGENT,
        markers: ['agent-message', 'steer-queued'],
        text: 'Steer queued for the active turn.',
      },
      {
        id: 'f'.repeat(64),
        createdAt: 17,
        pubkey: AGENT,
        markers: ['factory-permission-execution'],
        text: 'Permission execution acknowledged',
      },
      {
        id: '7'.repeat(64),
        createdAt: 17,
        pubkey: AGENT,
        markers: ['agent-message', 'land-summary'],
        extraTags: [
          ['subchannel', 'corner-checksum'],
          ['objective', 'Add checksum verification'],
          ['delivered', '2 commits across 3 files'],
          ['omitted', 'The upload protocol stayed unchanged.'],
          ['branch', 'main'],
          ['tip', '4'.repeat(40)],
          ['url', `https://github.com/acme/widget/commit/${'4'.repeat(40)}`],
          ['approver', VIEWER],
          ['approver-name', 'Ada Lovelace'],
          ['approver-handle', 'ada'],
        ],
        text: 'Landed checksum verification. Approved by @ada.',
      },
      {
        id: '6'.repeat(64),
        createdAt: 17,
        pubkey: AGENT,
        markers: ['agent-message', 'ci-result'],
        text: 'CI passed for the landed checksum.',
      },
      {
        id: '4'.repeat(64),
        createdAt: 17,
        pubkey: AGENT,
        markers: ['daemon-fact', 'corner-branch-ended'],
        extraTags: [
          ['subchannel', CORNER],
          ['outcome', 'landed'],
          ['objective', 'Add checksum verification'],
        ],
        text: 'Landed checksum verification into main.',
      },
      {
        id: '5'.repeat(64),
        createdAt: 17,
        pubkey: AGENT,
        markers: ['agent-message', 'buzz-agent-exchange'],
        text: 'A peer agent confirmed the checksum.',
      },
      {
        id: '9'.repeat(64),
        createdAt: 18,
        pubkey: VIEWER,
        markers: [],
        text: 'Captain: you are my chief of staff.',
      },
      {
        id: '8'.repeat(64),
        createdAt: 19,
        pubkey: AGENT,
        markers: ['agent-message'],
        text: 'I will maintain the launch checklist.',
      },
    ];
    for (const item of inbox) {
      await postgres.query(
        `INSERT INTO events
          (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
         VALUES ($1, $2, $3, to_timestamp($4), 9, $5, $6, $7)`,
        [
          TENANT,
          bytes(item.id),
          bytes(item.pubkey),
          item.createdAt,
          JSON.stringify([
            ['h', ROOM],
            ...item.markers.map((marker) => ['t', marker]),
            ...('extraTags' in item ? item.extraTags : []),
          ]),
          item.text,
          ROOM,
        ],
      );
    }

    const view = await indexer.readRoom(ROOM, VIEWER);
    const modelConversation = view?.messages
      .filter((message) => message.presentation === 'message')
      .map((message) => message.text);

    expect(modelConversation).toEqual([
      'Hello',
      'Ready',
      'A peer agent confirmed the checksum.',
      'Captain: you are my chief of staff.',
      'I will maintain the launch checklist.',
    ]);
    expect(view?.messages).not.toContainEqual(
      expect.objectContaining({ text: '🤖 Agent session started' }),
    );
    for (const text of [
      'GitHub polling degraded',
      'Steer queued for the active turn.',
      'Permission execution acknowledged',
      'CI passed for the landed checksum.',
    ]) {
      expect(view?.messages).toContainEqual(
        expect.objectContaining({ text, presentation: 'system' }),
      );
    }
    expect(view?.messages).not.toContainEqual(
      expect.objectContaining({ text: 'Model unavailable · unavailable-model' }),
    );
    expect(view?.messages).toContainEqual(
      expect.objectContaining({ id: 'c'.repeat(64), presentation: 'card' }),
    );
    expect(view?.messages).toContainEqual(
      expect.objectContaining({
        presentation: 'card',
        daemonFact: expect.objectContaining({
          type: 'corner-complete',
          cornerId: CORNER,
          objective: 'Add checksum verification',
          outcome: 'landed',
        }),
      }),
    );
    expect(view?.messages).not.toContainEqual(expect.objectContaining({ id: '7'.repeat(64) }));
  });

  it('projects a body-control corner permission request as an approval card', async () => {
    const permissionId = '941bce77-1111-4222-8333-444444444444';
    const requestId = '0510a90f'.repeat(8);
    const eventId = '4'.repeat(64);
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, to_timestamp(20), 9, $4, $5, $6)`,
      [
        TENANT,
        bytes(eventId),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'body-control'],
          ['t', 'buzz-write-permission-request'],
          ['permission', permissionId],
          ['request', requestId],
          ['requester', VIEWER],
          ['agent', AGENT],
          ['tool', 'open_corner'],
          ['repo', 'acme/beeline'],
          ['objective', 'Add the requested test coverage'],
          ['status', 'pending'],
          ['p', VIEWER],
        ]),
        '@ada asked Lina to open a corner for: Add the requested test coverage',
        ROOM,
      ],
    );

    const view = await indexer.readRoom(ROOM, VIEWER);

    expect(view?.messages).toContainEqual(
      expect.objectContaining({
        id: eventId,
        presentation: 'card',
        permission: {
          permissionId,
          requestId,
          agent: expect.objectContaining({ pubkey: AGENT, kind: 'agent', name: 'Milo' }),
          requester: {
            pubkey: VIEWER,
            kind: 'human',
            name: `Person ${VIEWER.slice(0, 8)}`,
          },
          tool: 'open_corner',
          repository: 'acme/beeline',
          status: 'pending',
        },
      }),
    );
  });

  it('projects only complete typed GitHub cards without a service-publisher roster entry', async () => {
    const service = 'd'.repeat(64);
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
       VALUES ($1, $2, $3, 'member')`,
      [TENANT, ROOM, bytes(service)],
    );
    const cardId = 'f'.repeat(64);
    const legacyId = 'e'.repeat(64);
    const insertGitHubEvent = async (
      id: string,
      createdAt: number,
      tags: string[][],
      content = '',
    ) => {
      await postgres.query(
        `INSERT INTO events
          (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
         VALUES ($1, $2, $3, to_timestamp($4), 9, $5, $6, $7)`,
        [TENANT, bytes(id), bytes(service), createdAt, JSON.stringify(tags), content, ROOM],
      );
    };
    await insertGitHubEvent(cardId, 13, [
      ['h', ROOM],
      ['t', 'github-event'],
      ['service', 'beeline-events'],
      ['github-event-type', 'pull-request'],
      ['github-event-action', 'opened'],
      ['github-event-actor', 'lena'],
      ['github-event-title', 'Ship the card'],
      ['github-event-url', 'https://github.com/acme/widget/pull/7'],
      ['github-event-id', '7'],
    ]);
    await insertGitHubEvent(
      legacyId,
      14,
      [
        ['h', ROOM],
        ['t', 'github-event'],
        ['service', 'beeline-events'],
      ],
      'lena pushed 0 commits to acme/widget:main',
    );

    const view = await indexer.readRoom(ROOM, VIEWER);
    const history = await indexer.readHistory(ROOM, VIEWER);

    expect(view?.members.map((member) => member.identity.pubkey)).not.toContain(service);
    expect(view?.messages).toContainEqual(
      expect.objectContaining({
        id: cardId,
        presentation: 'card',
        githubEvent: {
          type: 'pull-request',
          action: 'opened',
          actor: 'lena',
          title: 'Ship the card',
          url: 'https://github.com/acme/widget/pull/7',
        },
      }),
    );
    expect(view?.messages.map((message) => message.id)).not.toContain(legacyId);
    expect(history?.messages.map((message) => message.id)).not.toContain(legacyId);
  });

  it('owns read marks on the server across devices and viewers without a second Room query', async () => {
    await expect(indexer.readChats(WORKSPACE, VIEWER)).resolves.toMatchObject({
      chats: [{ room: { id: ROOM }, unread: true }],
    });

    physicalQueries = 0;
    await expect(indexer.readRoom(ROOM, VIEWER)).resolves.not.toBeNull();
    expect(physicalQueries).toBe(1);

    await expect(indexer.readChats(WORKSPACE, VIEWER)).resolves.toMatchObject({
      chats: [{ room: { id: ROOM }, unread: false }],
    });
    await expect(indexer.readChats(WORKSPACE, AGENT)).resolves.toMatchObject({
      chats: [{ room: { id: ROOM }, unread: true }],
    });
  });

  it('keeps chat preview and read state aligned with messages amid live and terminal corner activity', async () => {
    const terminalCorner = '5c1455f1-3690-4b35-b52b-67c7fbce64c9';
    await postgres.query(
      `INSERT INTO channels
        (community_id, id, name, description, visibility, created_by, created_at, updated_at)
       VALUES ($1, $2, 'Landed corner', 'Already shipped', 'open', $3,
         to_timestamp(13), to_timestamp(14))`,
      [TENANT, terminalCorner, bytes(AGENT)],
    );
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
       VALUES ($1, $2, $3, 'owner'), ($1, $2, $4, 'member')`,
      [TENANT, terminalCorner, bytes(VIEWER), bytes(AGENT)],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES
        ($1, $2, $3, to_timestamp(13), 9007, $4, '', $5, NULL),
        ($1, $6, $7, to_timestamp(14), 30078, $8, '', NULL, $9)`,
      [
        TENANT,
        bytes(createHash('sha256').update('terminal-corner-generation').digest('hex')),
        bytes(VIEWER),
        JSON.stringify([
          ['h', terminalCorner],
          ['community', WORKSPACE],
          ['parent', ROOM],
          ['name', 'Landed corner'],
        ]),
        terminalCorner,
        bytes(createHash('sha256').update('terminal-corner-state').digest('hex')),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['d', `buzz-corner-state:${terminalCorner}`],
          ['t', 'buzz-corner-state'],
          ['state', 'concluded'],
        ]),
        `buzz-corner-state:${terminalCorner}`,
      ],
    );
    await postgres.query(
      `INSERT INTO beeline_room_read_marks
        (community_id, room_id, viewer_pubkey, message_created_at, message_id)
       VALUES ($1, $2, $3, to_timestamp(4), $4)`,
      [TENANT, ROOM, bytes(VIEWER), bytes(directReplyId)],
    );

    // Production Rooms accumulate many typed kind:9 lifecycle records after
    // the last conversation message. They must not consume the bounded chat
    // preview window or move the server-owned conversation read cursor.
    for (let ordinal = 0; ordinal < 12; ordinal += 1) {
      const requestId = createHash('sha256')
        .update(`chat-list-control-request-${ordinal}`)
        .digest('hex');
      await postgres.query(
        `INSERT INTO events
          (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
         VALUES ($1, $2, $3, to_timestamp($4), 9, $5, '', $6)`,
        [
          TENANT,
          bytes(createHash('sha256').update(`chat-list-control-${ordinal}`).digest('hex')),
          bytes(AGENT),
          20 + ordinal,
          JSON.stringify([
            ['h', ROOM],
            ['t', 'agent-turn'],
            ['request', requestId],
            ['agent', AGENT],
            ['status', 'complete'],
          ]),
          ROOM,
        ],
      );
    }

    const chat = (await indexer.readChats(WORKSPACE, VIEWER))?.chats.find(
      (candidate) => candidate.room.id === ROOM,
    );
    expect(chat).toMatchObject({
      latestMessage: { id: directReplyId, text: 'Ready' },
      unread: false,
      cornerCount: 2,
    });
  });

  it('returns an exact immutable direct-message binding in the Room response', async () => {
    const directRoom = directMessageChannelId(WORKSPACE, VIEWER, AGENT);
    await postgres.query(
      `INSERT INTO channels
        (community_id, id, name, description, visibility, created_by, created_at, updated_at)
       VALUES ($1, $2, 'Direct Room', NULL, 'private', $3, to_timestamp(11), to_timestamp(11))`,
      [TENANT, directRoom, bytes(VIEWER)],
    );
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
       VALUES ($1, $2, $3, 'owner'), ($1, $2, $4, 'member')`,
      [TENANT, directRoom, bytes(VIEWER), bytes(AGENT)],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, to_timestamp(11), 9007, $4, '', $5)`,
      [
        TENANT,
        bytes('f'.repeat(64)),
        bytes(VIEWER),
        JSON.stringify([
          ['h', directRoom],
          ['community', WORKSPACE],
          ['name', 'Direct Room'],
          ['t', 'buzz-dm'],
          ['visibility', 'private'],
          ['p', VIEWER],
          ['p', AGENT],
        ]),
        directRoom,
      ],
    );

    physicalQueries = 0;
    await expect(indexer.readRoom(directRoom, VIEWER)).resolves.toMatchObject({
      room: { id: directRoom },
      directMessage: { participants: [VIEWER, AGENT].sort() },
    });
    expect(physicalQueries).toBe(1);
  });

  it('uses the same empty answer for a non-member and a missing Room', async () => {
    await expect(indexer.readRoom(ROOM, OUTSIDER)).resolves.toBeNull();
    await expect(indexer.readRoom(MISSING, VIEWER)).resolves.toBeNull();
  });

  it('projects a stored Workspace picture from relay metadata into Workspace tiles', async () => {
    const workspaces = await indexer.readWorkspaces(VIEWER);

    expect(workspaces.workspaces).toMatchObject([
      { id: WORKSPACE, avatar: 'https://media.test/workspace-projected.png' },
    ]);
  });

  it('serves each workspace tier in one physical query', async () => {
    for (const read of [
      () => indexer.readWorkspaces(VIEWER),
      () => indexer.readWorkspace(WORKSPACE, VIEWER),
      () => indexer.readChats(WORKSPACE, VIEWER),
      () => indexer.readAgent(WORKSPACE, AGENT, VIEWER),
    ]) {
      physicalQueries = 0;
      const value = await read();
      expect(value).not.toBeNull();
      expect(physicalQueries).toBe(1);
    }
    await expect(indexer.readWorkspace(WORKSPACE, VIEWER)).resolves.toMatchObject({
      workspace: {
        name: 'Builders',
        visibility: 'invite-only',
        avatar: 'https://media.test/workspace-projected.png',
      },
      members: [{ identity: { name: 'Ada' } }],
      agents: [{ identity: { name: 'Milo' } }],
    });
    const workspace = await indexer.readWorkspace(WORKSPACE, VIEWER);
    expect(workspace?.watchFilters).toContainEqual({
      kinds: [30078],
      authors: [AGENT],
      '#t': ['agent-presence'],
    });
    await expect(indexer.readChats(WORKSPACE, VIEWER)).resolves.toMatchObject({
      workspace: { id: WORKSPACE, avatar: 'https://media.test/workspace-projected.png' },
      chats: [{ room: { id: ROOM }, latestMessage: { text: 'Ready', author: { name: 'Milo' } } }],
    });
    await expect(indexer.readAgent(WORKSPACE, AGENT, VIEWER)).resolves.toMatchObject({
      workspaceId: WORKSPACE,
      agent: { identity: { pubkey: AGENT, name: 'Milo' } },
      catalog: [],
    });
    await expect(indexer.readWorkspaces(VIEWER)).resolves.toMatchObject({
      workspaces: [{ id: WORKSPACE, avatar: 'https://media.test/workspace-projected.png' }],
    });
  });

  it('uses the one current declaration name on every indexed agent surface', async () => {
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, role, removed_at)
       VALUES ($1, $2, $3, 'member', to_timestamp(14))`,
      [TENANT, WORKSPACE, bytes(OUTSIDER)],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(12), 30078, $4, $5, NULL, $6)`,
      [
        TENANT,
        bytes('9'.repeat(64)),
        bytes(OUTSIDER),
        JSON.stringify([
          ['d', `${WORKSPACE}:${AGENT}`],
          ['h', WORKSPACE],
          ['p', AGENT],
          ['t', 'buzz-agent-soul'],
          ['community', WORKSPACE],
        ]),
        JSON.stringify({ name: 'Codex', soul: 'Builds carefully.', avatarSeed: 'codex' }),
        `${WORKSPACE}:${AGENT}`,
      ],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(13), 30078, $4::jsonb, $5, NULL, $6)`,
      [
        TENANT,
        bytes('8'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['d', `${WORKSPACE}:${AGENT}`],
          ['h', WORKSPACE],
          ['p', AGENT],
          ['t', 'buzz-agent-soul'],
          ['community', WORKSPACE],
        ]),
        JSON.stringify({ name: 'Forged', soul: 'Overrides the captain.', avatarSeed: 'forged' }),
        `${WORKSPACE}:${AGENT}`,
      ],
    );

    const workspace = await indexer.readWorkspace(WORKSPACE, VIEWER);
    const chats = await indexer.readChats(WORKSPACE, VIEWER);
    const detail = await indexer.readAgent(WORKSPACE, AGENT, VIEWER);
    const room = await indexer.readRoom(ROOM, VIEWER);
    const history = await indexer.readHistory(ROOM, VIEWER);
    const corners = await indexer.readCorners(ROOM, VIEWER);

    expect(workspace).toMatchObject({
      members: [{ identity: { pubkey: VIEWER, name: 'Ada' } }],
      agents: [{ identity: { pubkey: AGENT, name: 'Milo' } }],
    });
    expect(chats).toMatchObject({
      chats: [{ latestMessage: { author: { pubkey: AGENT, name: 'Milo' } } }],
    });
    expect(detail).toMatchObject({
      agent: { identity: { pubkey: AGENT, name: 'Milo' } },
    });
    expect(room).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ pubkey: VIEWER, name: 'Ada' }),
        }),
        expect.objectContaining({
          identity: expect.objectContaining({
            pubkey: AGENT,
            name: 'Milo',
          }),
        }),
      ]),
      messages: expect.arrayContaining([
        expect.objectContaining({
          text: 'Ready',
          author: expect.objectContaining({
            pubkey: AGENT,
            name: 'Milo',
          }),
        }),
      ]),
      corners: [
        expect.objectContaining({
          agent: expect.objectContaining({
            pubkey: AGENT,
            name: 'Milo',
          }),
        }),
      ],
    });
    expect(history?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Ready',
          author: expect.objectContaining({
            pubkey: AGENT,
            name: 'Milo',
          }),
        }),
      ]),
    );
    expect(corners).toMatchObject({
      corners: [
        {
          agent: expect.objectContaining({
            pubkey: AGENT,
            name: 'Milo',
          }),
          latestMessage: expect.objectContaining({
            author: expect.objectContaining({
              pubkey: AGENT,
              name: 'Milo',
            }),
          }),
        },
      ],
    });
    expect(room?.watchFilters[0]?.['#h']).toContain(WORKSPACE);
    expect(corners?.watchFilters[0]?.['#h']).toContain(WORKSPACE);
  });

  it('projects only the newest valid corner agent-turn receipt as working', async () => {
    const memberWithoutDeclaration = 'd'.repeat(64);
    await postgres.query(
      `DELETE FROM events
       WHERE community_id = $1 AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(tags) tag
         WHERE tag->>0 = 't'
           AND tag->>1 = 'buzz-corner-remote-state'
       )`,
      [TENANT],
    );
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
       VALUES ($1, $2, $3, 'member')`,
      [TENANT, CORNER, bytes(memberWithoutDeclaration)],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES
        ($1, $2, $3, to_timestamp(40), 9, $4, '{}', $5),
        ($1, $6, $7, to_timestamp(50), 9, $8, '', $9),
        ($1, $10, $11, to_timestamp(51), 9, $12, '', $9)`,
      [
        TENANT,
        bytes('1'.repeat(64)),
        bytes(OUTSIDER),
        JSON.stringify([
          ['h', WORKSPACE],
          ['t', 'buzz-agent'],
          ['agent', OUTSIDER],
        ]),
        WORKSPACE,
        bytes('2'.repeat(64)),
        bytes(OUTSIDER),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-turn'],
          ['agent', OUTSIDER],
          ['request', '2'.repeat(64)],
          ['status', 'working'],
        ]),
        CORNER,
        bytes('3'.repeat(64)),
        bytes(memberWithoutDeclaration),
        JSON.stringify([
          ['h', CORNER],
          ['t', 'agent-turn'],
          ['agent', memberWithoutDeclaration],
          ['request', '3'.repeat(64)],
          ['status', 'working'],
        ]),
      ],
    );

    expect((await indexer.readCorners(ROOM, VIEWER))?.corners[0]?.status).toBe('idle');

    const publishAgentTurn = async (id: string, createdAt: number, status: string) => {
      await postgres.query(
        `INSERT INTO events
          (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
         VALUES ($1, $2, $3, to_timestamp($4), 9, $5, '', $6)`,
        [
          TENANT,
          bytes(id.repeat(64)),
          bytes(AGENT),
          createdAt,
          JSON.stringify([
            ['h', CORNER],
            ['t', 'agent-turn'],
            ['agent', AGENT],
            ['request', id.repeat(64)],
            ['status', status],
          ]),
          CORNER,
        ],
      );
    };

    await publishAgentTurn('4', 49, 'working');
    expect((await indexer.readCorners(ROOM, VIEWER))?.corners[0]).toMatchObject({
      status: 'working',
      statusAt: 49,
    });
    expect((await indexer.readRoom(ROOM, VIEWER))?.corners[0]).toMatchObject({
      status: 'working',
      statusAt: 49,
    });

    await publishAgentTurn('5', 52, 'complete');
    expect((await indexer.readCorners(ROOM, VIEWER))?.corners[0]?.status).toBe('idle');
    expect((await indexer.readRoom(ROOM, VIEWER))?.corners[0]?.status).toBe('idle');

    await publishAgentTurn('6', 53, 'failed');
    expect((await indexer.readCorners(ROOM, VIEWER))?.corners[0]?.status).toBe('idle');
  });

  it('projects the agent soul and allow-listed model catalog through the indexed agent read', async () => {
    const modelKey = `${WORKSPACE}:${AGENT}`;
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES
        ($1, $2, $3, to_timestamp(20), 30078, $4, $5, NULL, $7),
        ($1, $6, $2, to_timestamp(21), 30078, $8, $9, NULL, $7),
        ($1, $10, $2, to_timestamp(22), 30078, $11, $12, NULL, $7)`,
      [
        TENANT,
        bytes(VIEWER),
        bytes(AGENT),
        JSON.stringify([
          ['h', WORKSPACE],
          ['p', AGENT],
          ['d', modelKey],
          ['t', 'buzz-agent-model-catalog'],
        ]),
        JSON.stringify({
          options: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'sonnet',
              options: [
                { id: 'sonnet', name: 'Sonnet' },
                { id: 'opus', name: 'Opus' },
              ],
            },
            {
              id: 'mode',
              category: 'mode',
              options: [{ id: 'bypassPermissions' }],
            },
          ],
          selection: { model: 'sonnet', effort: 'medium' },
        }),
        bytes('d'.repeat(64)),
        modelKey,
        JSON.stringify([
          ['h', WORKSPACE],
          ['p', AGENT],
          ['d', modelKey],
          ['t', 'buzz-agent-model-config'],
        ]),
        JSON.stringify({ model: 'opus', effort: 'high' }),
        bytes('e'.repeat(64)),
        JSON.stringify([
          ['h', WORKSPACE],
          ['p', AGENT],
          ['d', modelKey],
          ['t', 'buzz-agent-soul'],
          ['community', WORKSPACE],
        ]),
        JSON.stringify({
          name: 'Clara',
          soul: 'Keep the tests green.',
          avatarSeed: AGENT,
        }),
      ],
    );

    await expect(indexer.readAgent(WORKSPACE, AGENT, VIEWER)).resolves.toMatchObject({
      agent: { identity: { name: 'Milo' } },
      soul: {
        name: 'Clara',
        instructions: 'Keep the tests green.',
        avatarSeed: AGENT,
      },
      catalog: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'sonnet',
          options: [
            { id: 'sonnet', name: 'Sonnet' },
            { id: 'opus', name: 'Opus' },
          ],
        },
      ],
      runtimeSelection: { model: 'sonnet', effort: 'medium' },
      selected: { model: 'opus', effort: 'high' },
    });
    await expect(indexer.readWorkspace(WORKSPACE, VIEWER)).resolves.toMatchObject({
      agents: [{ identity: { name: 'Milo' } }],
    });
    const detail = await indexer.readAgent(WORKSPACE, AGENT, VIEWER);
    expect(detail?.watchFilters).toContainEqual({
      kinds: [30078],
      '#d': [modelKey],
    });
    expect(
      detail?.watchFilters.some((filter) => filter.kinds?.includes(30078) && filter['#h']),
    ).toBe(false);
  });

  it('keeps the scoped chat query to one physical statement at 1, 47, and 200 Rooms', async () => {
    const addRooms = async (from: number, through: number) => {
      await postgres.query(
        `WITH generated AS (
           SELECT i,
             ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid AS room_id
           FROM generate_series($4::int, $5::int) i
         ), inserted_channels AS (
           INSERT INTO channels
             (community_id, id, name, visibility, created_by, created_at, updated_at)
           SELECT $1::uuid, room_id, 'Room ' || i, 'open', $2::bytea,
             to_timestamp(i + 20), to_timestamp(i + 20)
           FROM generated RETURNING id
         ), inserted_members AS (
           INSERT INTO channel_members (community_id, channel_id, pubkey, role)
           SELECT $1::uuid, room_id, $2::bytea, 'member' FROM generated
           RETURNING channel_id
         )
         INSERT INTO events
           (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
         SELECT $1::uuid, decode(lpad(to_hex(i + 10000), 64, '0'), 'hex'), $2::bytea,
           to_timestamp(i + 20), 9007,
           jsonb_build_array(
             jsonb_build_array('h', room_id::text),
             jsonb_build_array('community', $3::text),
             jsonb_build_array('name', 'Room ' || i)
           ), '', room_id, NULL::text
         FROM generated`,
        [TENANT, bytes(VIEWER), WORKSPACE, from, through],
      );
    };

    for (const expected of [1, 47, 200]) {
      if (expected === 47) await addRooms(1, 46);
      if (expected === 200) await addRooms(47, 199);
      physicalQueries = 0;
      const view = await indexer.readChats(WORKSPACE, VIEWER);
      expect(physicalQueries).toBe(1);
      expect(view?.chats).toHaveLength(expected);
      expect(view?.truncated).toBe(false);
    }

    await addRooms(200, 200);
    physicalQueries = 0;
    const capped = await indexer.readChats(WORKSPACE, VIEWER);
    expect(physicalQueries).toBe(1);
    expect(capped?.chats).toHaveLength(200);
    expect(capped?.truncated).toBe(true);
  });

  it('returns the observed 82-human/54-agent roster whole, caps overflow, and projects privilege', async () => {
    const addRoster = async (
      humanFrom: number,
      humanThrough: number,
      agentFrom: number,
      agentThrough: number,
    ) => {
      await postgres.query(
        `WITH humans AS (
           SELECT decode(lpad(to_hex(i), 64, '0'), 'hex') AS pubkey, i
           FROM generate_series($4::int, $5::int) i
         ), agents AS (
           SELECT decode(lpad(to_hex(i), 64, '0'), 'hex') AS pubkey, i
           FROM generate_series($6::int, $7::int) i
         ), inserted_members AS (
           INSERT INTO channel_members (community_id, channel_id, pubkey, role)
           SELECT $1::uuid, $2::uuid, pubkey, 'member' FROM humans
           UNION ALL SELECT $1::uuid, $2::uuid, pubkey, 'member' FROM agents
           RETURNING pubkey
         ), inserted_users AS (
           INSERT INTO users (community_id, pubkey, display_name)
           SELECT $1::uuid, pubkey, 'Human ' || i FROM humans RETURNING pubkey
         )
         INSERT INTO events
           (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
         SELECT $1::uuid, decode(lpad(to_hex(i + 20000), 64, '0'), 'hex'), pubkey,
           to_timestamp(i + 20), 9,
           jsonb_build_array(
             jsonb_build_array('h', $3::text),
             jsonb_build_array('t', 'buzz-agent')
           ), jsonb_build_object('displayName', 'Agent ' || i)::text, $2::uuid, NULL::text
         FROM agents`,
        [TENANT, WORKSPACE, WORKSPACE, humanFrom, humanThrough, agentFrom, agentThrough],
      );
    };

    await addRoster(1, 81, 1001, 1053);
    physicalQueries = 0;
    const observed = await indexer.readWorkspace(WORKSPACE, VIEWER);
    expect(physicalQueries).toBe(1);
    expect(observed?.members).toHaveLength(82);
    expect(observed?.agents).toHaveLength(54);
    expect(observed?.membersTruncated).toBe(false);
    expect(observed?.agentsTruncated).toBe(false);
    expect(JSON.stringify(observed)).not.toContain('catalog');

    const normalMember = await indexer.readWorkspace(WORKSPACE, AGENT);
    expect(normalMember?.managerSettings).toBeUndefined();

    await addRoster(101, 219, 2001, 2147);
    physicalQueries = 0;
    const capped = await indexer.readWorkspace(WORKSPACE, VIEWER);
    expect(physicalQueries).toBe(1);
    expect(capped?.members).toHaveLength(200);
    expect(capped?.agents).toHaveLength(200);
    expect(capped?.membersTruncated).toBe(true);
    expect(capped?.agentsTruncated).toBe(true);
  });

  it('returns corner metadata without a review artifact body', async () => {
    physicalQueries = 0;
    const corners = await indexer.readCorners(ROOM, VIEWER);
    expect(corners).toMatchObject({ corners: [{ corner: { id: CORNER } }] });
    expect(corners?.corners[0]?.lifecycle).toMatchObject({ lifecycle: 'working' });
    expect(physicalQueries).toBe(1);

    physicalQueries = 0;
    const corner = await indexer.readRoom(CORNER, VIEWER);
    expect(physicalQueries).toBe(1);
    expect(corner).toMatchObject({
      room: { id: CORNER, parentId: ROOM },
      parent: { id: ROOM },
      repository: { name: 'beeline', targetBranch: 'main' },
      cornerLifecycle: { lifecycle: 'working' },
    });
    expect(corner).not.toHaveProperty('review');
    expect(JSON.stringify(corner)).not.toContain('diff');
  });

  it('resolves only the current opaque invite capability in one query', async () => {
    const token = `bzi_${'d'.repeat(64)}`;
    physicalQueries = 0;
    const valid = await indexer.readInvite(createHash('sha256').update(token).digest('hex'));
    expect(valid).toEqual({
      name: 'Builders',
      avatar: 'https://media.test/workspace-projected.png',
      expiresAt: 2_000_000_000,
    });
    expect(physicalQueries).toBe(1);

    const invalid = [
      { token: `bzi_${'1'.repeat(64)}`, expiration: '1' },
      { token: `bzi_${'2'.repeat(64)}`, expiration: '2000000000', revoked: true },
    ];
    let id = 50_000;
    for (const candidate of invalid) {
      const hash = createHash('sha256').update(candidate.token).digest('hex');
      await postgres.query(
        `INSERT INTO events
          (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
         VALUES ($1, $2, $3, to_timestamp($4), 30078, $5, '', NULL, $6::text)`,
        [
          TENANT,
          bytes((id++).toString(16).padStart(64, '0')),
          bytes(VIEWER),
          id,
          JSON.stringify([
            ['h', WORKSPACE],
            ['t', 'buzz-community-invite'],
            ['d', hash],
            ['expiration', candidate.expiration],
            ...(candidate.revoked ? [['revoked', 'true']] : []),
          ]),
          hash,
        ],
      );
      physicalQueries = 0;
      await expect(indexer.readInvite(hash)).resolves.toBeNull();
      expect(physicalQueries).toBe(1);
    }

    physicalQueries = 0;
    await expect(indexer.readInvite('0'.repeat(64))).resolves.toBeNull();
    expect(physicalQueries).toBe(1);

    await postgres.query(`UPDATE channels SET archived_at = now() WHERE id = $1`, [WORKSPACE]);
    physicalQueries = 0;
    await expect(
      indexer.readInvite(createHash('sha256').update(token).digest('hex')),
    ).resolves.toBeNull();
    expect(physicalQueries).toBe(1);
  });

  it('atomically reserves a member-authored pairing marker for one outsider identity', async () => {
    const code = 'BUZZ-4S4P-ZPJP';
    const tokenHash = createHash('sha256').update(code).digest('hex');
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, now(), 30078, $4, '', NULL, $5)`,
      [
        TENANT,
        bytes('f'.repeat(64)),
        bytes(VIEWER),
        JSON.stringify([
          ['h', WORKSPACE],
          ['t', 'buzz-agent-pairing'],
          ['d', tokenHash],
          ['expiration', '2000000000'],
        ]),
        tokenHash,
      ],
    );

    await expect(indexer.claimAgentPairing(tokenHash, OUTSIDER, true)).resolves.toEqual({
      workspaceId: WORKSPACE,
      pairedBy: VIEWER,
      joined: true,
      attachedRoomIds: [ROOM],
    });
    await expect(indexer.claimAgentPairing(tokenHash, OUTSIDER, true)).resolves.toEqual({
      workspaceId: WORKSPACE,
      pairedBy: VIEWER,
      joined: false,
      attachedRoomIds: [ROOM],
    });
    await expect(indexer.claimAgentPairing(tokenHash, 'e'.repeat(64), true)).resolves.toBeNull();
    const membership = await postgres.query<{ invited_by: Uint8Array }>(
      `SELECT invited_by FROM channel_members
       WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3 AND removed_at IS NULL`,
      [TENANT, WORKSPACE, bytes(OUTSIDER)],
    );
    expect(Buffer.from(membership.rows[0]!.invited_by).toString('hex')).toBe(VIEWER);
    const inheritedRooms = await postgres.query<{ channel_id: string }>(
      `SELECT channel_id FROM channel_members
       WHERE community_id = $1 AND pubkey = $2 AND removed_at IS NULL
         AND channel_id <> $3
       ORDER BY channel_id`,
      [TENANT, bytes(OUTSIDER), WORKSPACE],
    );
    expect(inheritedRooms.rows.map((row) => row.channel_id)).toEqual([ROOM]);

    // A later, independent Room grant must survive abandoning the original
    // pairing code. The claim ledger must contain only the initial Workspace
    // and inherited Room memberships.
    await postgres.query(
      `INSERT INTO channels
        (community_id, id, name, description, visibility, created_by, created_at, updated_at)
       VALUES ($1, $2, 'Later Room', 'Granted after pairing', 'open', $3, now(), now())`,
      [TENANT, MISSING, bytes(VIEWER)],
    );
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, role)
       VALUES ($1, $2, $3, 'member')`,
      [TENANT, MISSING, bytes(OUTSIDER)],
    );

    await expect(indexer.abandonAgentPairing(tokenHash, 'e'.repeat(64))).resolves.toBe(false);
    await expect(indexer.abandonAgentPairing(tokenHash, OUTSIDER)).resolves.toBe(true);
    const activeAfterRollback = await postgres.query<{ channel_id: string }>(
      `SELECT channel_id FROM channel_members
      WHERE community_id = $1 AND pubkey = $2 AND removed_at IS NULL`,
      [TENANT, bytes(OUTSIDER)],
    );
    expect(activeAfterRollback.rows).toEqual([{ channel_id: MISSING }]);
    const claimCreatedMemberships = await postgres.query<{ channel_id: string }>(
      `SELECT channel_id FROM channel_members
       WHERE community_id = $1 AND pubkey = $2 AND channel_id IN ($3, $4)
         AND removed_at IS NOT NULL
       ORDER BY channel_id`,
      [TENANT, bytes(OUTSIDER), WORKSPACE, ROOM],
    );
    expect(claimCreatedMemberships.rows.map((row) => row.channel_id)).toEqual([ROOM, WORKSPACE]);
    // The first rollback consumes its generations. An independent re-grant to
    // one of the original Rooms must survive a repeated abandon with the raw
    // pairing code.
    await postgres.query(
      `UPDATE channel_members SET joined_at = now(), removed_at = NULL, removed_by = NULL
       WHERE community_id = $1 AND channel_id = $2 AND pubkey = $3`,
      [TENANT, ROOM, bytes(OUTSIDER)],
    );
    await expect(indexer.abandonAgentPairing(tokenHash, OUTSIDER)).resolves.toBe(true);
    const activeAfterRepeatedRollback = await postgres.query<{ channel_id: string }>(
      `SELECT channel_id FROM channel_members
       WHERE community_id = $1 AND pubkey = $2 AND removed_at IS NULL
       ORDER BY channel_id`,
      [TENANT, bytes(OUTSIDER)],
    );
    expect(activeAfterRepeatedRollback.rows.map((row) => row.channel_id)).toEqual([MISSING, ROOM]);

    // A retry activates a new pair of membership generations, which a later
    // abandon must consume and revoke.
    await expect(indexer.claimAgentPairing(tokenHash, OUTSIDER, true)).resolves.toEqual({
      workspaceId: WORKSPACE,
      pairedBy: VIEWER,
      joined: false,
      attachedRoomIds: [ROOM],
    });
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, now(), 9, $4, $5, $6)`,
      [
        TENANT,
        bytes('1'.repeat(64)),
        bytes(OUTSIDER),
        JSON.stringify([
          ['h', WORKSPACE],
          ['t', 'buzz-agent'],
          ['pairing', tokenHash],
        ]),
        JSON.stringify({ displayName: 'Grok' }),
        WORKSPACE,
      ],
    );
    await expect(indexer.readWorkspace(WORKSPACE, VIEWER)).resolves.toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ pubkey: OUTSIDER, kind: 'agent' }),
        }),
      ]),
    });
    await expect(indexer.abandonAgentPairing(tokenHash, OUTSIDER)).resolves.toBe(true);
    const activeAfterRetryRollback = await postgres.query<{ channel_id: string }>(
      `SELECT channel_id FROM channel_members
       WHERE community_id = $1 AND pubkey = $2 AND removed_at IS NULL`,
      [TENANT, bytes(OUTSIDER)],
    );
    expect(activeAfterRetryRollback.rows).toEqual([{ channel_id: MISSING }]);
    await expect(indexer.claimAgentPairing(tokenHash, OUTSIDER, true)).resolves.toBeNull();
  });

  it('leaves legacy pairing claims Workspace-only when they cannot roll back inherited Rooms', async () => {
    const code = 'BUZZ-8F5Q-RTUV';
    const tokenHash = createHash('sha256').update(code).digest('hex');
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, now(), 30078, $4, '', NULL, $5)`,
      [
        TENANT,
        bytes('9'.repeat(64)),
        bytes(VIEWER),
        JSON.stringify([
          ['h', WORKSPACE],
          ['t', 'buzz-agent-pairing'],
          ['d', tokenHash],
          ['expiration', '2000000000'],
        ]),
        tokenHash,
      ],
    );

    await expect(indexer.claimAgentPairing(tokenHash, 'c'.repeat(64))).resolves.toEqual({
      workspaceId: WORKSPACE,
      pairedBy: VIEWER,
      joined: true,
      attachedRoomIds: [],
    });
    const memberships = await postgres.query<{ channel_id: string }>(
      `SELECT channel_id FROM channel_members
       WHERE community_id = $1 AND pubkey = $2 AND removed_at IS NULL
       ORDER BY channel_id`,
      [TENANT, bytes('c'.repeat(64))],
    );
    expect(memberships.rows).toEqual([{ channel_id: WORKSPACE }]);
  });

  it('accepts a short-lived auth grant only for its exact agent identity', async () => {
    const tokenHash = createHash('sha256').update('BUZZ-GOLD-BEES').digest('hex');
    await postgres.query(
      `INSERT INTO beeline_agent_connect_grants
        (token_hash, community_id, workspace_id, minter_pubkey, agent_pubkey,
         expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes', now())`,
      [tokenHash, TENANT, WORKSPACE, bytes(VIEWER), bytes(OUTSIDER)],
    );

    await expect(indexer.claimAgentPairing(tokenHash, 'e'.repeat(64))).resolves.toBeNull();
    await expect(indexer.claimAgentPairing(tokenHash, OUTSIDER)).resolves.toEqual({
      workspaceId: WORKSPACE,
      pairedBy: VIEWER,
      joined: true,
      attachedRoomIds: [],
    });
    await expect(indexer.claimAgentPairing(tokenHash, OUTSIDER)).resolves.toEqual({
      workspaceId: WORKSPACE,
      pairedBy: VIEWER,
      joined: false,
      attachedRoomIds: [],
    });
  });
});
