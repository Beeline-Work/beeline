import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  directMessageChannelId,
  KIND_AGENT_PRESENCE,
  TAG_AGENT_PRESENCE,
} from '@beeline/buzz-client';
import { migrateRoomReadMarks, type DatabaseQueryable } from './database.js';
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
        removed_at timestamptz
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
          channelId,
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
    await event(ROOM, VIEWER, 3, 9, [['h', ROOM]], 'Hello');
    await event(ROOM, AGENT, 4, 9, [['h', ROOM]], 'Ready');
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
    const descriptor = {
      version: 2,
      base: '1'.repeat(40),
      tip: '2'.repeat(40),
      patchId: '3'.repeat(40),
      summary: 'One file',
      fileCount: 1,
      files: [{ path: 'README.md', status: 'modified', linesAdded: 1 }],
      url: 'https://media.test/review.json',
      sha256: '4'.repeat(64),
      size: 100,
    };
    await event(
      CORNER,
      AGENT,
      8,
      30078,
      [
        ['h', CORNER],
        ['d', `${CORNER}:${descriptor.tip}:artifact`],
        ['t', 'change-review-artifact'],
      ],
      JSON.stringify(descriptor),
    );
    await event(CORNER, VIEWER, 9, 9, [
      ['h', CORNER],
      ['t', 'buzz-merge-approval'],
      ['repo', 'acme/beeline'],
      ['branch', 'refs/heads/main'],
    ]);
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
      corners: [{ corner: { id: CORNER, updatedAt: 7 }, status: 'working' }],
    });
    expect(view?.messages.map((message) => [message.text, message.author.name])).toEqual([
      ['Hello', 'Ada'],
      ['Ready', 'Milo'],
    ]);
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

  it('projects a model-unavailable event as a visible system line', async () => {
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id)
       VALUES ($1, $2, $3, to_timestamp(12), 9, $4, $5, $6)`,
      [
        TENANT,
        bytes('e'.repeat(64)),
        bytes(AGENT),
        JSON.stringify([
          ['h', ROOM],
          ['t', 'buzz-agent-model-unavailable'],
          ['status', 'model-unavailable'],
          ['unavailable', 'model'],
          ['unavailable-value', 'openrouter-ox/z-ai/glm-5.3-flash'],
        ]),
        'Model unavailable · openrouter-ox/z-ai/glm-5.3-flash',
        ROOM,
      ],
    );

    const view = await indexer.readRoom(ROOM, VIEWER);
    const history = await indexer.readHistory(ROOM, VIEWER);

    expect(view?.messages).toContainEqual(
      expect.objectContaining({
        text: 'Model unavailable · openrouter-ox/z-ai/glm-5.3-flash',
        presentation: 'system',
      }),
    );
    expect(history?.messages).toContainEqual(
      expect.objectContaining({
        text: 'Model unavailable · openrouter-ox/z-ai/glm-5.3-flash',
        presentation: 'system',
      }),
    );
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

  it('uses the current Workspace soul name on every indexed agent surface', async () => {
    await postgres.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, role, removed_at)
       VALUES ($1, $2, $3, 'member', to_timestamp(14))`,
      [TENANT, WORKSPACE, bytes(OUTSIDER)],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(12), 30078, $4, $5, $6, $7)`,
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
        WORKSPACE,
        `${WORKSPACE}:${AGENT}`,
      ],
    );
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES ($1, $2, $3, to_timestamp(13), 30078, $4, $5, $6, $7)`,
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
        WORKSPACE,
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
      agents: [{ identity: { pubkey: AGENT, name: 'Codex' } }],
    });
    expect(chats).toMatchObject({
      chats: [{ latestMessage: { author: { pubkey: AGENT, name: 'Codex' } } }],
    });
    expect(detail).toMatchObject({
      agent: { identity: { pubkey: AGENT, name: 'Codex' } },
    });
    expect(room).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ pubkey: VIEWER, name: 'Ada' }),
        }),
        expect.objectContaining({
          identity: expect.objectContaining({
            pubkey: AGENT,
            name: 'Codex',
          }),
        }),
      ]),
      messages: expect.arrayContaining([
        expect.objectContaining({
          text: 'Ready',
          author: expect.objectContaining({
            pubkey: AGENT,
            name: 'Codex',
          }),
        }),
      ]),
      corners: [
        expect.objectContaining({
          agent: expect.objectContaining({
            pubkey: AGENT,
            name: 'Codex',
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
            name: 'Codex',
          }),
        }),
      ]),
    );
    expect(corners).toMatchObject({
      corners: [
        {
          agent: expect.objectContaining({
            pubkey: AGENT,
            name: 'Codex',
          }),
          latestMessage: expect.objectContaining({
            author: expect.objectContaining({
              pubkey: AGENT,
              name: 'Codex',
            }),
          }),
        },
      ],
    });
    expect(room?.watchFilters[0]?.['#h']).toContain(WORKSPACE);
    expect(corners?.watchFilters[0]?.['#h']).toContain(WORKSPACE);
  });

  it('projects the agent soul and allow-listed model catalog through the indexed agent read', async () => {
    const modelKey = `${WORKSPACE}:${AGENT}`;
    await postgres.query(
      `INSERT INTO events
        (community_id, id, pubkey, created_at, kind, tags, content, channel_id, d_tag)
       VALUES
        ($1, $2, $3, to_timestamp(20), 30078, $5, $6, $4, $8),
        ($1, $7, $2, to_timestamp(21), 30078, $9, $10, $4, $8),
        ($1, $11, $2, to_timestamp(22), 30078, $12, $13, $4, $8)`,
      [
        TENANT,
        bytes(VIEWER),
        bytes(AGENT),
        WORKSPACE,
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
      agent: { identity: { name: 'Clara' } },
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
      agents: [{ identity: { name: 'Clara' } }],
    });
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

  it('returns corner metadata, review descriptors, and no patch body', async () => {
    physicalQueries = 0;
    const corners = await indexer.readCorners(ROOM, VIEWER);
    expect(corners).toMatchObject({ corners: [{ corner: { id: CORNER }, status: 'working' }] });
    expect(physicalQueries).toBe(1);

    physicalQueries = 0;
    const corner = await indexer.readRoom(CORNER, VIEWER);
    expect(physicalQueries).toBe(1);
    expect(corner).toMatchObject({
      room: { id: CORNER, parentId: ROOM },
      parent: { id: ROOM },
      repository: { name: 'beeline', targetBranch: 'main' },
      review: {
        status: 'ready',
        files: [{ path: 'README.md', status: 'modified' }],
        approvedBy: [{ name: 'Ada' }],
      },
    });
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
         VALUES ($1, $2, $3, to_timestamp($4), 30078, $5, '', $6, $7::text)`,
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
          WORKSPACE,
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
});
