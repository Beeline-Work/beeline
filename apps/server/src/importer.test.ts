import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectEvent } from '@beeline/push-gateway/projection';
import { isRoomView } from '@beeline/api-contract/phone';
import { measureDatabaseBreakdown, migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { SnapshotImporter, type LegacySnapshot } from './importer.js';
import { PhoneService } from './phone-service.js';

const OWNER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const REMOVED = 'c'.repeat(64);
const ORPHAN_MEDIA_OWNER = 'd'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const DM = '33333333-3333-4333-8333-333333333333';
const CORNER = '44444444-4444-4444-8444-444444444444';
const ARCHIVED = '55555555-5555-4555-8555-555555555555';
const DELETED_ROOM = '66666666-6666-4666-8666-666666666666';
const MESSAGE = '1'.repeat(64);
const REPLY = '2'.repeat(64);
const ATTACHMENT = '3'.repeat(64);
const PERMISSION = '4'.repeat(64);
const TARGET = '5'.repeat(64);
const FACT = '6'.repeat(64);
const GITHUB = '7'.repeat(64);
const PLAN = '8'.repeat(64);
const BASE = 2_000_000_000;

function snapshot(): LegacySnapshot {
  return {
    identities: [
      {
        id: AGENT,
        kind: 'agent',
        name: 'Bee',
        ownerId: OWNER,
        soul: { name: 'Bee', instructions: 'Ship carefully', avatarSeed: 'bee' },
        model: 'gpt-5',
        effort: 'high',
        catalog: [{ id: 'model', category: 'model', options: [{ id: 'gpt-5' }] }],
      },
      { id: OWNER, kind: 'human', name: 'Owner' },
      { id: REMOVED, kind: 'human', name: 'Former' },
    ],
    workspaces: [
      {
        id: WORKSPACE,
        name: 'Hive',
        avatar: 'http://old.invalid/media/a',
        visibility: 'invite-only',
        createdAt: BASE - 100,
        updatedAt: BASE + 20,
      },
    ],
    rooms: [
      {
        id: CORNER,
        workspaceId: WORKSPACE,
        createdBy: AGENT,
        parentId: ROOM,
        name: 'Migration corner',
        visibility: 'invite-only',
        archived: false,
        objective: 'Build monolith',
        remoteStateContent: JSON.stringify({
          version: 1,
          cornerId: CORNER,
          branch: 'fm/monolith',
          state: 'in-review',
          checks: 'passing',
          observedAt: BASE + 8,
        }),
        createdAt: BASE - 70,
        updatedAt: BASE + 15,
      },
      {
        id: ROOM,
        workspaceId: WORKSPACE,
        name: 'General',
        visibility: 'invite-only',
        archived: false,
        repository: {
          key: 'acme/beeline',
          remote: 'git://github.com/acme/beeline',
          targetBranch: 'main',
          githubInstallationId: 1,
          githubEventsEnabled: true,
          updatedAt: BASE + 12,
        },
        repositoryResolution: 'repository',
        createdAt: BASE - 90,
        updatedAt: BASE + 20,
      },
      {
        id: DM,
        workspaceId: WORKSPACE,
        name: 'Direct',
        visibility: 'invite-only',
        archived: false,
        directParticipants: [OWNER, AGENT],
        createdAt: BASE - 80,
        updatedAt: BASE + 10,
      },
      {
        id: ARCHIVED,
        workspaceId: WORKSPACE,
        name: 'Archive',
        visibility: 'invite-only',
        archived: true,
        createdAt: BASE - 60,
        updatedAt: BASE + 5,
      },
    ],
    memberships: [
      { workspaceId: WORKSPACE, identityId: OWNER, role: 'owner', removed: false },
      { workspaceId: WORKSPACE, identityId: AGENT, role: 'member', removed: false },
      { workspaceId: WORKSPACE, identityId: REMOVED, role: 'member', removed: true },
      {
        workspaceId: WORKSPACE,
        roomId: ROOM,
        identityId: OWNER,
        role: 'owner',
        removed: false,
        identity: { kind: 'human', name: 'Workspace Owner', handle: 'owner@hive.test' },
      },
      { workspaceId: WORKSPACE, roomId: ROOM, identityId: AGENT, role: 'member', removed: false },
      { workspaceId: WORKSPACE, roomId: ROOM, identityId: REMOVED, role: 'member', removed: true },
      { workspaceId: WORKSPACE, roomId: DM, identityId: OWNER, role: 'member', removed: false },
      { workspaceId: WORKSPACE, roomId: DM, identityId: AGENT, role: 'member', removed: false },
      { workspaceId: WORKSPACE, roomId: CORNER, identityId: AGENT, role: 'owner', removed: false },
      { workspaceId: WORKSPACE, roomId: CORNER, identityId: OWNER, role: 'member', removed: false },
      {
        workspaceId: WORKSPACE,
        roomId: ARCHIVED,
        identityId: OWNER,
        role: 'owner',
        removed: false,
      },
    ],
    events: [
      {
        id: MESSAGE,
        roomId: ROOM,
        authorId: OWNER,
        authorKind: 'human',
        authorName: 'Workspace Owner',
        kind: 9,
        tags: [['h', ROOM]],
        content: 'Start migration',
        createdAt: BASE,
      },
      {
        id: REPLY,
        roomId: ROOM,
        authorId: AGENT,
        authorKind: 'agent',
        authorName: 'Bee',
        kind: 9,
        tags: [
          ['h', ROOM],
          ['t', 'agent-message'],
          ['e', MESSAGE, '', 'reply'],
        ],
        content: 'Acknowledged',
        createdAt: BASE + 1,
        rootId: MESSAGE,
      },
      {
        id: ATTACHMENT,
        roomId: ROOM,
        authorId: OWNER,
        authorKind: 'human',
        authorName: 'Owner',
        kind: 9,
        tags: [
          ['h', ROOM],
          ['t', 'buzz-attachment'],
          [
            'imeta',
            'url https://alternate.invalid/media/a',
            'm image/png',
            'size 4',
            'thumb https://alternate.invalid/media/a-thumb',
          ],
          ['attachment', 'https://alternate.invalid/media/a', 'proof.png'],
        ],
        content: 'proof',
        createdAt: BASE + 2,
      },
      {
        id: PERMISSION,
        roomId: ROOM,
        authorId: AGENT,
        authorKind: 'agent',
        authorName: 'Bee',
        kind: 9,
        tags: [
          ['h', ROOM],
          ['t', 'buzz-write-permission-request'],
          ['permission', 'perm-1'],
          ['request', 'request-1'],
          ['agent', AGENT],
          ['requester', OWNER],
          ['tool', 'edit files'],
          ['repo', 'acme/beeline'],
        ],
        content: '',
        createdAt: BASE + 3,
      },
      {
        id: TARGET,
        roomId: ROOM,
        authorId: AGENT,
        authorKind: 'agent',
        authorName: 'Bee',
        kind: 9,
        tags: [
          ['h', ROOM],
          ['t', 'buzz-target-branch-proposal'],
          ['from', 'main'],
          ['to', 'release'],
          ['repo', 'acme/beeline'],
        ],
        content: '',
        createdAt: BASE + 4,
      },
      {
        id: FACT,
        roomId: ROOM,
        authorId: AGENT,
        authorKind: 'agent',
        authorName: 'Bee',
        kind: 9,
        tags: [
          ['h', ROOM],
          ['t', 'daemon-fact'],
          ['t', 'corner-branch-ended'],
          ['subchannel', CORNER],
          ['outcome', 'landed'],
          ['objective', 'Build monolith'],
          ['url', 'https://github.com/acme/beeline/pull/1'],
        ],
        content: 'landed',
        createdAt: BASE + 5,
      },
      {
        id: GITHUB,
        roomId: ROOM,
        authorId: OWNER,
        authorKind: 'human',
        authorName: 'Owner',
        kind: 9,
        tags: [
          ['h', ROOM],
          ['t', 'github-event'],
          ['service', 'beeline-events'],
          ['github-event-id', 'delivery-1'],
          ['github-event-type', 'pull-request'],
          ['github-event-action', 'opened'],
          ['github-event-actor', 'owner'],
          ['github-event-title', 'Build monolith'],
          ['github-event-url', 'https://github.com/acme/beeline/pull/1'],
        ],
        content: '',
        createdAt: BASE + 6,
      },
      {
        id: PLAN,
        roomId: CORNER,
        authorId: AGENT,
        authorKind: 'agent',
        authorName: 'Bee',
        kind: 9,
        tags: [
          ['h', CORNER],
          ['t', 'agent-activity'],
        ],
        content: JSON.stringify({
          sessionId: 's',
          update: {
            sessionUpdate: 'activity_summary',
            title: 'Plan',
            plan: { objective: 'Build monolith', items: [{ step: 'Import', status: 'completed' }] },
          },
        }),
        createdAt: BASE + 7,
      },
    ],
    readMarks: [
      { roomId: ROOM, identityId: OWNER, messageId: GITHUB, createdAt: BASE + 6 },
      { roomId: DELETED_ROOM, identityId: OWNER, messageId: GITHUB, createdAt: BASE + 6 },
    ],
    presences: [{ roomId: ROOM, agentId: AGENT, status: 'online', createdAt: BASE + 9 }],
    schedules: [
      {
        scheduleId: 'daily',
        agentId: AGENT,
        roomId: ROOM,
        revision: 1,
        schedule: {
          scheduleId: 'daily',
          revision: 1,
          status: 'active',
          expression: '0 9 * * *',
          timezone: 'UTC',
          mandate: 'Check',
        },
      },
      {
        scheduleId: 'deleted-room',
        agentId: AGENT,
        roomId: DELETED_ROOM,
        revision: 1,
        schedule: { scheduleId: 'deleted-room', revision: 1, status: 'active' },
      },
    ],
    github: {
      identityLinks: [
        {
          subject: '42',
          identityId: OWNER,
          issuer: 'https://github.com',
          audience: 'github-client',
        },
      ],
      identitySuccessions: [],
      userTokens: [{ subject: '42', encryptedToken: 'sealed-token' }],
      installations: [
        { installationId: 1, ownerId: OWNER, accountLogin: 'acme', accountType: 'Organization' },
      ],
      repositories: [
        { repositoryId: 2, installationId: 1, fullName: 'acme/beeline', defaultBranch: 'main' },
      ],
    },
    registry: {
      registrations: [{ pubkey: OWNER, tokens: ['push-token-12345678901234567890'] }],
      updateReceipts: [{ pubkey: OWNER, deviceId: 'device-1234567890', environment: 'physical' }],
    },
    media: [
      {
        legacyUrl: 'http://old.invalid/media/a',
        bytesBase64: Buffer.from('tiny').toString('base64'),
        ownerId: ORPHAN_MEDIA_OWNER,
        mimeType: 'image/png',
        name: 'proof.png',
      },
      {
        legacyUrl: 'http://old.invalid/media/a-thumb',
        bytesBase64: Buffer.from('thumb').toString('base64'),
        ownerId: ORPHAN_MEDIA_OWNER,
        mimeType: 'image/jpeg',
        name: 'proof-thumb.jpg',
      },
    ],
  };
}

describe('direct snapshot importer and RoomView parity', () => {
  let db: PgliteDatabase;
  beforeEach(async () => {
    db = new PgliteDatabase();
    await migrate(db);
  });
  afterEach(() => db.close());
  it('covers the production-shaped fixture and matches old RoomView JSON after intentional URL normalization', async () => {
    const source = snapshot();
    const report = await new SnapshotImporter(db).import(source, undefined, undefined, {
      includeMedia: true,
    });
    expect(report.imported).toMatchObject({
      identity: 4,
      agent: 1,
      workspace: 1,
      room: 4,
      membership: 11,
      event: 8,
      'read-mark': 1,
      presence: 1,
      schedule: 1,
      'github-identity-link': 1,
      'github-user-token': 1,
      'github-installation': 1,
      'github-repository': 1,
      'push-device': 1,
      'update-receipt': 1,
      media: 2,
    });
    expect(
      (
        await db.query<{ name: string }>(`SELECT name FROM identities WHERE id=$1`, [
          ORPHAN_MEDIA_OWNER,
        ])
      ).rows[0]?.name,
    ).toBe('Person dddddddd');
    const phone = new PhoneService(db, 'https://server.example');
    const actual = await phone.readRoom(ROOM, OWNER);
    expect(actual).not.toBeNull();
    expect(isRoomView(actual)).toBe(true);
    const oldMessages = source.events
      .filter((event) => event.roomId === ROOM)
      .flatMap((event) => {
        const projected = projectEvent(
          {
            id: event.id,
            pubkey: event.authorId,
            agent: event.authorKind === 'agent',
            name: event.authorName,
            kind: event.kind,
            tags: event.tags,
            content: event.content,
            createdAt: event.createdAt,
            rootId: event.rootId ?? event.id,
          },
          ROOM,
        );
        return projected ? [projected] : [];
      });
    expect(normalize(actual!.messages)).toEqual(normalize(oldMessages));
    expect(actual!.room.archived).toBe(false);
    expect(actual!.members.map((member) => member.identity.pubkey)).toEqual([OWNER, AGENT]);
    expect(actual!.viewer.identity).toMatchObject({
      pubkey: OWNER,
      name: 'Workspace Owner',
      handle: 'owner@hive.test',
    });
    expect(actual!.messages.find((message) => message.id === MESSAGE)?.author.name).toBe(
      'Workspace Owner',
    );
    expect(actual!.members.find((member) => member.identity.pubkey === AGENT)?.presence).toEqual({
      status: 'online',
      observedAt: BASE + 9,
      roomId: ROOM,
    });
    expect(actual!.corners).toHaveLength(1);
    expect(actual!.corners[0]).toMatchObject({
      agent: { pubkey: AGENT },
      lifecycle: { lifecycle: 'in-review', checks: 'passing', branch: 'fm/monolith' },
      status: 'idle',
    });
    expect(
      (await db.query<{ parent_id: string }>(`SELECT parent_id FROM rooms WHERE id=$1`, [CORNER]))
        .rows[0]?.parent_id,
    ).toBe(ROOM);
    expect((await phone.readRoom(DM, OWNER))?.directMessage?.participants).toEqual([OWNER, AGENT]);
    expect((await phone.readRoom(ARCHIVED, OWNER))?.room.archived).toBe(true);
    expect((await phone.readRoom(CORNER, AGENT))?.cornerPlan).toEqual({
      objective: 'Build monolith',
      items: [{ step: 'Import', status: 'completed' }],
    });
    const cornerView = await phone.readRoom(CORNER, AGENT);
    expect(cornerView?.corners.map((corner) => corner.corner.id)).toEqual([CORNER]);
    expect(cornerView?.repository).toMatchObject({
      key: 'acme/beeline',
      updatedAt: BASE + 12,
    });
    expect(cornerView?.repositoryResolution).toBe('repository');
    expect(cornerView?.watchFilters).toEqual([
      {
        kinds: [0, 9, 9000, 9001, 9002, 9007, 9008, 30078, 39000, 39001, 39002],
        '#h': [WORKSPACE, CORNER, ROOM],
      },
      { kinds: [0], authors: [AGENT, OWNER] },
      {
        kinds: [30078],
        '#d': [`agent-draft:${CORNER}`, `agent-thought:${CORNER}`, `agent-presence:${CORNER}`],
      },
    ]);
    expect((await phone.readRoom(CORNER, AGENT))?.cornerLifecycle).toMatchObject({
      lifecycle: 'in-review',
      checks: 'passing',
    });
    expect((await phone.readAgent(WORKSPACE, AGENT, OWNER))?.soul?.instructions).toBe(
      'Ship carefully',
    );
    expect((await phone.readAgent(WORKSPACE, AGENT, OWNER))?.selected).toEqual({
      model: 'gpt-5',
      effort: 'high',
    });
    expect((await phone.readWorkspace(WORKSPACE, OWNER))?.workspace.avatar).toMatch(
      /^https:\/\/server\.example\/v1\/media\//,
    );
    expect(
      (await measureDatabaseBreakdown(db)).media.find(
        (row) => row.type === 'referenced-by-kept-message',
      ),
    ).toMatchObject({ objects: 2, bytes: 9 });
    expect(
      (await phone.readChats(WORKSPACE, OWNER))?.chats.find((chat) => chat.room.id === ROOM)
        ?.unread,
    ).toBe(false);
    expect(
      (await db.query(`SELECT 1 FROM work_schedules WHERE schedule_id='daily'`)).rowCount,
    ).toBe(1);
    expect(
      (await db.query(`SELECT 1 FROM github_repositories WHERE full_name='acme/beeline'`)).rowCount,
    ).toBe(1);
    expect((await db.query(`SELECT 1 FROM github_user_tokens WHERE subject='42'`)).rowCount).toBe(
      1,
    );
    expect(
      (
        await db.query(
          `SELECT 1 FROM memberships WHERE identity_id=$1 AND removed_at IS NOT NULL`,
          [REMOVED],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('skips every legacy media object by default while retaining transcript references', async () => {
    const source = snapshot();
    const report = await new SnapshotImporter(db).import(source);
    expect(report.imported.media).toBeUndefined();
    expect(report.mediaBytes).toBe(0);
    expect((await db.query(`SELECT 1 FROM media`)).rowCount).toBe(0);
    const room = await new PhoneService(db, 'https://server.example').readRoom(ROOM, OWNER);
    expect(room?.messages.flatMap((message) => message.attachments ?? []).length).toBeGreaterThan(
      0,
    );
    expect(room?.messages.flatMap((message) => message.attachments ?? [])[0]?.url).toContain(
      'alternate.invalid',
    );
  });
  it('applies the production raw and conversation page budgets before projection', async () => {
    const source = snapshot();
    const visible = Array.from({ length: 29 }, (_, index) => ({
      id: (1_000 + index).toString(16).padStart(64, '0'),
      roomId: ROOM,
      authorId: OWNER,
      authorKind: 'human' as const,
      authorName: 'Owner',
      kind: 9,
      tags: [['h', ROOM]],
      content: `visible ${index}`,
      createdAt: BASE + 100 + index,
    }));
    source.events.push(
      ...visible,
      {
        id: (1_100).toString(16).padStart(64, '0'),
        roomId: ROOM,
        authorId: AGENT,
        authorKind: 'agent',
        authorName: 'Bee',
        kind: 9,
        tags: [['h', ROOM]],
        content: 'I lost my connection to the relay — reconnecting.',
        createdAt: BASE + 129,
      },
      ...Array.from({ length: 180 }, (_, index) => ({
        id: (2_000 + index).toString(16).padStart(64, '0'),
        roomId: ROOM,
        authorId: AGENT,
        authorKind: 'agent' as const,
        authorName: 'Bee',
        kind: 9,
        tags: [
          ['h', ROOM],
          ['t', 'body-control'],
        ],
        content: '{}',
        createdAt: BASE + 200 + index,
      })),
    );
    await new SnapshotImporter(db).import(source);
    const room = await new PhoneService(db, 'https://server.example').readRoom(ROOM, OWNER);
    expect(room?.messages.map((message) => message.id)).toEqual(visible.map((event) => event.id));
  });
  it('resumes the same import after interruption without duplicates', async () => {
    const importer = new SnapshotImporter(db);
    await expect(importer.import(snapshot(), 'restartable', 5)).rejects.toThrow(
      'injected importer interruption',
    );
    const report = await importer.import(snapshot(), 'restartable');
    expect(report.skipped.identity).toBe(4);
    expect(
      (await db.query<{ count: string }>(`SELECT count(*)::text count FROM messages`)).rows[0]
        ?.count,
    ).toBe('8');
    expect(
      (
        await db.query<{ state: string }>(
          `SELECT state FROM import_runs WHERE import_id='restartable'`,
        )
      ).rows[0]?.state,
    ).toBe('complete');
  });
});

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_key, item) =>
    typeof item === 'string' && (item.includes('/v1/media/') || item.includes('/media/a'))
      ? '<media>'
      : item,
  );
}
