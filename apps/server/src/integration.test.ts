import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { FACE_NAMES, FACE_SOULS, isFaceId, type FaceId } from '@beeline/api-contract/phone';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer, DEFAULT_MEDIA_MAXIMUM_BYTES } from './server.js';
import { PushDeliveryLoop } from './background.js';
import { GitHubOperations } from './github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import {
  isCommunityInviteToken,
  isAgentDetailView,
  isRoomView,
  isRoomViewMessage,
  DEFAULT_WORKSPACE_ID,
  WELCOME_ROOM_ID,
  ROOM_VIEW_MESSAGE_LIMIT,
  type RoomView,
} from '@beeline/api-contract/phone';
import { createMonolithAuth, type MonolithAuthMount } from './monolith-auth.js';
import { REVIEW_IDENTITY_ID, ReviewAccess } from './review-access.js';

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const REVIEW_SECRET = 'play-review-secret-value-0001';
const WELCOME_AGENT = 'c'.repeat(64);
const ROOM = '22222222-2222-4222-8222-222222222222';

describe('monolith integration', () => {
  let database: PgliteDatabase;
  let auth: TokenAuth;
  let origin: string;
  let server: ReturnType<typeof createBeelineServer>;
  let accessToken: string;
  let daemonToken: string;
  let sendPushTest: ReturnType<typeof vi.fn>;
  let mountedAuth: MonolithAuthMount;
  let completeInstallation: ReturnType<typeof vi.fn>;
  let processWebhook: ReturnType<typeof vi.fn>;
  let githubOperations: GitHubOperations;
  let phone: PhoneService;
  let githubApp: {
    deleteBranch: ReturnType<typeof vi.fn>;
    mergePullRequest: ReturnType<typeof vi.fn>;
  };
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database);
    await database.query(
      `INSERT INTO identities(id,kind,name,github_subject) VALUES($1,'human','Owner','owner'),($2,'agent','Bee',NULL)`,
      [HUMAN, AGENT],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, HUMAN]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
      [WORKSPACE, HUMAN, AGENT, ROOM],
    );
    auth = new TokenAuth(database, async (proof) => {
      const login = proof === 'proof' ? 'owner' : proof === 'recipient-proof' ? 'recipient' : proof;
      return { subject: login, login, name: login[0]!.toUpperCase() + login.slice(1) };
    });
    githubApp = {
      deleteBranch: vi.fn(async () => undefined),
      mergePullRequest: vi.fn(async () => undefined),
    };
    githubOperations = new GitHubOperations(
      database,
      {
        authorizationUrl: ({ state, redirectUri }: { state: string; redirectUri: string }) =>
          `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
        exchangeCode: async () => ({
          issuer: 'https://github.com' as const,
          audience: 'oauth-client-id',
          subject: 'owner',
          login: 'owner',
          displayName: 'Owner',
          accessToken: 'github-user-token',
        }),
      } as unknown as GitHubOAuthClient,
      githubApp as unknown as GitHubAppClient,
      'github-client-secret',
    );
    vi.spyOn(githubOperations, 'refresh').mockResolvedValue({});
    vi.spyOn(githubOperations, 'beginInstallation').mockResolvedValue({
      url: 'https://github.com/apps/beeline-test/installations/new?state=server-state',
    });
    vi.spyOn(githubOperations, 'createRepository').mockImplementation(async (_viewerId, input) => ({
      id: 102,
      fullName: `owner/${input.name}`,
      installationId: input.installationId,
      defaultBranch: 'main',
    }));
    sendPushTest = vi.fn(async () => undefined);
    phone = new PhoneService(database, 'http://placeholder', githubOperations, sendPushTest);
    const live = new LiveHub();
    const daemon = new DaemonService(database, live, async () => ({
      token: 'github-room-token',
      expiresAt: Date.now() + 60_000,
    }));
    mountedAuth = await createMonolithAuth(database, 'https://server.test', undefined, {
      createDaemonExchange: (agentId, transaction) =>
        auth.createDaemonExchange(agentId, transaction),
      env: {
        NODE_ENV: 'test',
        BUZZY_AUTH_TENANTS_JSON: JSON.stringify([
          {
            host: 'server.test',
            community: 'integration-community',
            roomCommunityIds: ['integration-community'],
            origin: 'https://server.test',
          },
        ]),
        BUZZY_AUTH_OIDC_ISSUER: 'https://accounts.example',
        BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT: 'https://accounts.example/authorize',
        BUZZY_AUTH_OIDC_TOKEN_ENDPOINT: 'https://accounts.example/token',
        BUZZY_AUTH_OIDC_JWKS_URI: 'https://accounts.example/jwks',
        BUZZY_AUTH_OIDC_CLIENT_ID: 'test-client',
      },
    });
    completeInstallation = vi.fn(async () => 'beeline://buzz/github-installation?installed=1');
    processWebhook = vi.fn(async () => undefined);
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon,
      live,
      review: new ReviewAccess({
        secret: REVIEW_SECRET,
        mint: () => auth.exchangeReviewIdentity(),
        log: () => undefined,
      }),
      authHandler: mountedAuth.handle,
      mediaMaximumBytes: 1024 * 1024,
      github: {
        webhookSecret: 'webhook-secret',
        roomToken: async () => ({ token: 'github-room-token', expiresAt: Date.now() + 60_000 }),
        completeInstallation,
        onWebhook: processWebhook,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (phone as unknown as { publicOrigin: string }).publicOrigin = origin;
    const phoneTokens = await auth.exchangeGitHubOidc('proof');
    accessToken = phoneTokens.accessToken;
    const exchange = await auth.createDaemonExchange(AGENT);
    daemonToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (mountedAuth) await mountedAuth.close();
    if (database) await database.close();
  });
  const request = async (path: string, method = 'GET', payload?: unknown, token = accessToken) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  const phoneToken = async (login: string) => (await auth.exchangeGitHubOidc(login)).accessToken;
  const operation = (name: string, payload: unknown, token = accessToken) =>
    request(`/v1/phone/operations/${name}`, 'POST', payload, token);
  const daemonOperation = (name: string, payload: unknown, token = daemonToken) =>
    request(`/v1/daemon/operations/${name}`, 'POST', payload, token);
  const webhook = async (event: string, delivery: string, payload: unknown) => {
    const bytes = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(bytes).digest('hex')}`;
    return fetch(`${origin}/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'x-hub-signature-256': signature,
        'x-github-delivery': delivery,
        'x-github-event': event,
        'content-type': 'application/json',
      },
      body: bytes,
    });
  };

  it('keeps workspace and Room mutations aligned with the phone HTTP contract', async () => {
    const aliceToken = await phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    expect(
      await (await operation('createWorkspace', { workspaceId, name: 'Audit' })).json(),
    ).toEqual({ id: workspaceId });
    expect(
      await (await operation('createWorkspace', { workspaceId, name: 'Audit' })).json(),
    ).toEqual({ id: workspaceId });
    expect(
      (
        await operation('updateWorkspace', {
          workspaceId,
          name: 'Audit renamed',
          visibility: 'public',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        (await (await request('/v1/phone/workspaces')).json()) as {
          workspaces: Array<{ id: string; name: string; visibility: string }>;
        }
      ).workspaces,
    ).toContainEqual(
      expect.objectContaining({ id: workspaceId, name: 'Audit renamed', visibility: 'public' }),
    );

    expect(
      await (
        await operation('addWorkspaceMember', {
          workspaceId,
          memberId: aliceId,
          role: 'owner',
        })
      ).json(),
    ).toEqual({ joined: true });
    const workspace = (await (await request(`/v1/phone/workspaces/${workspaceId}`)).json()) as {
      members: Array<{ identity: { pubkey: string }; role: string }>;
    };
    expect(workspace.members).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ pubkey: aliceId }),
        role: 'owner',
      }),
    );

    const created = (await (
      await operation('createRoom', { workspaceId, name: 'Private by default' })
    ).json()) as { id: string };
    expect(
      (await request(`/v1/phone/rooms/${created.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(404);
    expect(
      (
        await operation('updateRoom', {
          roomId: created.id,
          name: 'Renamed Room',
          visibility: 'public',
        })
      ).status,
    ).toBe(204);
    expect(
      await (await operation('addRoomMember', { roomId: created.id, memberId: aliceId })).json(),
    ).toEqual({ joined: true });
    expect(
      (await request(`/v1/phone/rooms/${created.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);
    expect(
      (await operation('removeRoomMember', { roomId: created.id, memberId: aliceId })).status,
    ).toBe(204);
    await operation('addRoomMember', { roomId: created.id, memberId: aliceId });
    expect((await operation('leaveRoom', { roomId: created.id }, aliceToken)).status).toBe(204);
    expect((await operation('deleteRoom', { roomId: created.id })).status).toBe(204);
    expect((await request(`/v1/phone/rooms/${created.id}`)).status).toBe(404);
    const chats = (await (await request(`/v1/phone/workspaces/${workspaceId}/chats`)).json()) as {
      chats: Array<{ room: { id: string } }>;
    };
    expect(chats.chats.some((chat) => chat.room.id === created.id)).toBe(false);

    expect((await operation('leaveWorkspace', { workspaceId })).status).toBe(204);
    expect((await request(`/v1/phone/workspaces/${workspaceId}`)).status).toBe(404);
  });

  it('serves Welcome and makes person invites reusable, retry-safe, and Room-complete', async () => {
    const aliceToken = await phoneToken('alice');
    const bobToken = await phoneToken('bob');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const bobId = createHash('sha256').update('github:bob').digest('hex');
    const migratedOwnerWorkspaces = (await (await request('/v1/phone/workspaces')).json()) as {
      workspaces: Array<{ name: string }>;
    };
    expect(migratedOwnerWorkspaces.workspaces).toContainEqual(
      expect.objectContaining({ name: 'Beeline Welcome' }),
    );
    const aliceWorkspaces = (await (
      await request('/v1/phone/workspaces', 'GET', undefined, aliceToken)
    ).json()) as { workspaces: Array<{ name: string }> };
    expect(aliceWorkspaces.workspaces).toContainEqual(
      expect.objectContaining({ name: 'Beeline Welcome' }),
    );

    const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await operation('createWorkspace', { workspaceId, name: 'Invites' });
    const room = (await (
      await operation('createRoom', { workspaceId, name: 'Existing Room' })
    ).json()) as { id: string };
    const invite = (await (await operation('createInvite', { workspaceId })).json()) as {
      token: string;
      expiresAt: number;
    };
    expect(invite.expiresAt).toBeLessThan(10_000_000_000);
    expect(
      await (await operation('resolveInvite', { token: invite.token }, aliceToken)).json(),
    ).toEqual(expect.objectContaining({ name: 'Invites' }));
    expect(
      await (await operation('redeemInvite', { token: invite.token }, aliceToken)).json(),
    ).toEqual({ joined: true, workspaceId });
    expect(
      await (await operation('redeemInvite', { token: invite.token }, aliceToken)).json(),
    ).toEqual({ joined: false, workspaceId });
    expect(
      await (await operation('redeemInvite', { token: invite.token }, bobToken)).json(),
    ).toEqual({ joined: true, workspaceId });

    const aliceChats = (await (
      await request(`/v1/phone/workspaces/${workspaceId}/chats`, 'GET', undefined, aliceToken)
    ).json()) as { chats: Array<{ room: { id: string } }> };
    expect(aliceChats.chats.map((chat) => chat.room.id)).toContain(room.id);
    const roomView = (await (await request(`/v1/phone/rooms/${room.id}`)).json()) as {
      members: Array<{ identity: { pubkey: string } }>;
    };
    expect(roomView.members.map((member) => member.identity.pubkey)).toEqual(
      expect.arrayContaining([HUMAN, aliceId, bobId]),
    );

    const laterRoom = (await (
      await operation('createRoom', { workspaceId, name: 'Later Room' })
    ).json()) as { id: string };
    expect(
      (await request(`/v1/phone/rooms/${laterRoom.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(404);
  });

  it('bounds Room membership and direct messages to current Workspace members', async () => {
    const aliceToken = await phoneToken('alice');
    const outsiderToken = await phoneToken('outsider');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const outsiderId = createHash('sha256').update('github:outsider').digest('hex');
    const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await operation('createWorkspace', { workspaceId, name: 'DMs' });
    await operation('addWorkspaceMember', { workspaceId, memberId: aliceId, role: 'member' });
    const room = (await (await operation('createRoom', { workspaceId, name: 'Room' })).json()) as {
      id: string;
    };

    expect(
      (await operation('addRoomMember', { roomId: room.id, memberId: outsiderId })).status,
    ).toBe(400);
    expect(
      (
        await operation(
          'resolveDirectMessage',
          { workspaceId, participantId: HUMAN },
          outsiderToken,
        )
      ).status,
    ).toBe(400);
    const first = (await (
      await operation('resolveDirectMessage', { workspaceId, participantId: aliceId })
    ).json()) as { id: string; created: boolean };
    const retry = (await (
      await operation('resolveDirectMessage', { workspaceId, participantId: HUMAN }, aliceToken)
    ).json()) as { id: string; created: boolean };
    expect(first).toEqual({ id: retry.id, created: true });
    expect(retry.created).toBe(false);
    expect((await operation('leaveRoom', { roomId: room.id })).status).toBe(403);
    expect((await operation('removeRoomMember', { roomId: room.id, memberId: HUMAN })).status).toBe(
      403,
    );
    expect((await operation('leaveWorkspace', { workspaceId })).status).toBe(403);
  });

  it('lets a Workspace manager remove a person from the Workspace and every live Room', async () => {
    const aliceToken = await phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const bobId = createHash('sha256').update('github:bob').digest('hex');
    await phoneToken('bob');
    const workspaceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await operation('createWorkspace', { workspaceId, name: 'Removals' });
    await operation('addWorkspaceMember', { workspaceId, memberId: aliceId, role: 'admin' });
    await operation('addWorkspaceMember', { workspaceId, memberId: bobId, role: 'admin' });
    const room = (await (
      await operation('createRoom', { workspaceId, name: 'Shared' })
    ).json()) as { id: string };
    await operation('addRoomMember', { roomId: room.id, memberId: bobId });
    await operation('addRoomMember', { roomId: room.id, memberId: aliceId });

    // The authority ladder is addWorkspaceMember's: nobody removes themselves,
    // an admin never removes an equal, an agent is not a person.
    expect(
      (await operation('removeWorkspaceMember', { workspaceId, memberId: HUMAN })).status,
    ).toBe(403);
    expect(
      (await operation('removeWorkspaceMember', { workspaceId, memberId: bobId }, aliceToken))
        .status,
    ).toBe(403);
    expect(
      (await operation('removeWorkspaceMember', { workspaceId, memberId: AGENT })).status,
    ).toBe(400);

    expect(
      (await operation('removeWorkspaceMember', { workspaceId, memberId: bobId })).status,
    ).toBe(204);
    const workspace = (await (await request(`/v1/phone/workspaces/${workspaceId}`)).json()) as {
      members: Array<{ identity: { pubkey: string } }>;
    };
    expect(workspace.members.map((member) => member.identity.pubkey)).not.toContain(bobId);
    const view = (await (await request(`/v1/phone/rooms/${room.id}`)).json()) as {
      members: Array<{ identity: { pubkey: string } }>;
      messages: Array<{ text: string; presentation: string; systemEvent?: { verb: string } }>;
    };
    expect(view.members.map((member) => member.identity.pubkey)).not.toContain(bobId);
    expect(view.messages).toContainEqual(
      expect.objectContaining({
        presentation: 'system',
        text: expect.stringMatching(/ removed /),
        systemEvent: expect.objectContaining({
          verb: 'removed',
          object: expect.objectContaining({ id: bobId }),
        }),
      }),
    );
    // Gone means gone: the second removal has no membership to act on.
    expect(
      (await operation('removeWorkspaceMember', { workspaceId, memberId: bobId })).status,
    ).toBe(400);
  });

  it('creates a deterministic agent direct message inside the Workspace', async () => {
    const dm = (await (
      await operation('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: AGENT })
    ).json()) as { id: string; created: boolean };
    expect(dm.created).toBe(true);
    const reopened = (await (
      await operation('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: AGENT })
    ).json()) as { id: string; created: boolean };
    expect(reopened).toEqual({ id: dm.id, created: false });

    // The agent is auto-added as a Room member so it serves the DM.
    const members = await database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships WHERE room_id=$1 AND removed_at IS NULL ORDER BY identity_id`,
      [dm.id],
    );
    expect(members.rows.map((row) => row.identity_id).sort()).toEqual([AGENT, HUMAN].sort());

    // The helper learns the Room is conversational-only from the daemon op.
    const repositoryState = (await (
      await daemonOperation('getRoomRepositoryState', { roomId: dm.id })
    ).json()) as { resolution: string; directParticipants?: string[] };
    expect(repositoryState.resolution).toBe('none');
    expect([...(repositoryState.directParticipants ?? [])].sort()).toEqual([AGENT, HUMAN].sort());

    // A human message in the DM implicitly addresses its one agent.
    const sent = await operation('sendRoomMessage', {
      roomId: dm.id,
      messageId: 'c'.repeat(64),
      text: 'Are you there?',
    });
    expect(sent.status).toBe(200);
    const stored = await database.query<{ mention_ids: string[] }>(
      `SELECT mention_ids FROM messages WHERE id=$1`,
      ['c'.repeat(64)],
    );
    expect(stored.rows[0]?.mention_ids).toEqual([AGENT]);

    // The chat list names a DM row by its peer, so it carries the one other
    // participant's identity instead of leaving the client the stored name.
    const chats = (await (await request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
      chats: Array<{
        room: { id: string };
        directMessage?: { peer: { pubkey: string; kind: string } };
      }>;
    };
    expect(chats.chats.find((chat) => chat.room.id === dm.id)?.directMessage).toMatchObject({
      peer: { pubkey: AGENT, kind: 'agent' },
    });
    expect(chats.chats.find((chat) => chat.room.id === ROOM)?.directMessage).toBeUndefined();
  });

  it('refuses a direct message with an agent outside the Workspace', async () => {
    const outsider = 'd'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Outsider')`, [
      outsider,
    ]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [outsider, HUMAN]);
    const response = await operation('resolveDirectMessage', {
      workspaceId: WORKSPACE,
      participantId: outsider,
    });
    expect(response.status).toBe(400);
  });

  it('emits one workspace push and Room join notes across explicit member adds', async () => {
    const aliceToken = await phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const workspaceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await operation('createWorkspace', { workspaceId, name: 'Tubing Crew' });
    const room = (await (
      await operation('createRoom', { workspaceId, name: 'Planning' })
    ).json()) as { id: string };
    await operation('registerPushDevice', {
      token: 'owner-explicit-add-device-token-1234567890',
      platform: 'ios',
      environment: 'physical',
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(database, { send });
    expect(await loop.runOnce()).toBe(0);

    expect(
      await (
        await operation('addWorkspaceMember', {
          workspaceId,
          memberId: aliceId,
          role: 'member',
        })
      ).json(),
    ).toEqual({ joined: true });
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenLastCalledWith(
      'owner-explicit-add-device-token-1234567890',
      expect.objectContaining({ text: 'alice joined Tubing Crew' }),
    );

    expect(
      await (await operation('addRoomMember', { roomId: room.id, memberId: aliceId })).json(),
    ).toEqual({ joined: true });
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      'owner-explicit-add-device-token-1234567890',
      expect.objectContaining({ text: 'alice joined Planning' }),
    );
    const roomView = (await (
      await request(`/v1/phone/rooms/${room.id}`, 'GET', undefined, aliceToken)
    ).json()) as { messages: Array<{ text: string; presentation: string }> };
    expect(roomView.messages).toContainEqual(
      expect.objectContaining({ text: 'alice joined', presentation: 'system' }),
    );
    const chats = (await (await request(`/v1/phone/workspaces/${workspaceId}/chats`)).json()) as {
      chats: Array<{ room: { id: string }; latestMessage?: { text: string }; unread: boolean }>;
    };
    expect(chats.chats).toContainEqual(
      expect.objectContaining({
        room: expect.objectContaining({ id: room.id }),
        latestMessage: expect.objectContaining({ text: 'alice joined' }),
        unread: true,
      }),
    );
  });

  it('proves send -> read -> daemon prompt -> reply -> WebSocket invalidation and overlays', async () => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, [
      `bearer.${accessToken}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId: ROOM }));
    await next(socket, 'subscribed');
    const sent = await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      messageId: 'c'.repeat(64),
      text: 'Please inspect this',
    });
    expect(sent.status).toBe(200);
    const { messageId } = (await sent.json()) as { messageId: string };
    expect(messageId).toBe('c'.repeat(64));
    const room = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ id: string; text: string }>;
    };
    expect(room.messages).toContainEqual(
      expect.objectContaining({ id: messageId, text: 'Please inspect this' }),
    );
    const threaded = await request('/v1/phone/operations/sendRoomReply', 'POST', {
      roomId: ROOM,
      messageId: 'd'.repeat(64),
      parentMessageId: messageId,
      text: 'What is your soul?',
      mentions: [AGENT],
    });
    expect(threaded.status).toBe(200);
    const { messageId: threadedMessageId } = (await threaded.json()) as { messageId: string };
    expect(threadedMessageId).toBe('d'.repeat(64));
    const threadedRoom = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{
        id: string;
        text: string;
        reply?: { channelId: string; eventId: string; rootId: string };
      }>;
    };
    expect(threadedRoom.messages).toContainEqual(
      expect.objectContaining({
        id: threadedMessageId,
        text: 'What is your soul?',
        reply: { channelId: ROOM, eventId: messageId, rootId: messageId },
      }),
    );
    const conversation = await request(
      '/v1/daemon/operations/getRoomConversation',
      'POST',
      { roomId: ROOM },
      daemonToken,
    );
    expect(
      ((await conversation.json()) as { items: Array<{ body: string }> }).items.at(-1)?.body,
    ).toBe('What is your soul?');
    const invalidated = next(socket, 'invalidate');
    const reply = await request(
      '/v1/daemon/operations/postRoomMessage',
      'POST',
      { roomId: ROOM, requestId: threadedMessageId, text: 'I am Terra.' },
      daemonToken,
    );
    expect(reply.status).toBe(200);
    expect(await invalidated).toEqual(
      expect.objectContaining({ type: 'invalidate', roomId: ROOM, reason: 'message' }),
    );
    const answeredRoom = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ requestId?: string; text: string }>;
    };
    expect(answeredRoom.messages).toContainEqual(
      expect.objectContaining({ requestId: threadedMessageId, text: 'I am Terra.' }),
    );
    const drafted = next(socket, 'draft');
    await request(
      '/v1/daemon/operations/postAgentDraft',
      'POST',
      { agentId: AGENT, roomId: ROOM, turnId: 'turn-1', text: 'Working' },
      daemonToken,
    );
    expect(await drafted).toEqual(expect.objectContaining({ type: 'draft', text: 'Working' }));
    const toolRequestId = 'tool-request';
    expect(
      (
        await daemonOperation('postAgentTurnReceipt', {
          agentId: AGENT,
          roomId: ROOM,
          requestId: toolRequestId,
          status: 'working',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: ROOM,
          requestId: toolRequestId,
          activity: [
            {
              kind: 'tool',
              title: 'Bash',
              operation: 'execute',
              command: 'npm test -- ActivityTimeline',
              status: 'exit 0',
              output: 'first result line\nlast result line',
              files: [{ path: 'apps/mobile/sources/components/buzz/ActivityTimeline.tsx' }],
            },
          ],
        })
      ).status,
    ).toBe(200);
    const activityRoom = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ presentation: string; activity?: unknown }>;
    };
    expect(activityRoom.messages).toContainEqual(
      expect.objectContaining({
        presentation: 'activity',
        activity: [
          {
            kind: 'tool',
            title: 'Bash',
            operation: 'execute',
            command: 'npm test -- ActivityTimeline',
            status: 'exit 0',
            output: 'first result line\nlast result line',
            files: [{ path: 'apps/mobile/sources/components/buzz/ActivityTimeline.tsx' }],
          },
        ],
      }),
    );
    socket.close();
  });

  it('hands a corner reader the draft its turn is already writing when they subscribe', async () => {
    // The captain's report: a corner turn eight minutes into its tool work,
    // opened from the Room list. Everything the corner shows — the objective,
    // the collapsed tool group, the clock — is read durably over HTTP. The
    // draft is the one thing that was only ever pushed, so a reader who was
    // not already listening saw prose nowhere.
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-draft-request',
      name: 'Room join push',
      objective: 'Trace the Room-join push producer and correct it',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const turnId = 'corner-draft-turn';
    expect(
      (
        await daemonOperation('postAgentTurnReceipt', {
          agentId: AGENT,
          roomId: cornerId,
          requestId: turnId,
          status: 'working',
        })
      ).status,
    ).toBe(200);
    // The turn narrates, then disappears into tool calls. Every one of those
    // rows is durable and readable later; the narration is not.
    expect(
      (
        await daemonOperation('postAgentDraft', {
          agentId: AGENT,
          roomId: cornerId,
          turnId,
          text: "I'll trace the Room-join push producer and its existing coverage",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: cornerId,
          requestId: turnId,
          activity: [
            { kind: 'tool', title: 'Bash', operation: 'execute', command: 'rg push', status: 'exit 0' },
          ],
        })
      ).status,
    ).toBe(200);

    const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, [
      `bearer.${accessToken}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const drafted = next(socket, 'draft');
    socket.send(JSON.stringify({ type: 'subscribe', roomId: cornerId }));
    await next(socket, 'subscribed');
    expect(await drafted).toEqual({
      type: 'draft',
      roomId: cornerId,
      agentId: AGENT,
      turnId,
      text: "I'll trace the Room-join push producer and its existing coverage",
    });
    socket.close();
  });

  it('never resurrects the draft of a turn that has stopped working', async () => {
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'settled-corner-request',
      name: 'Settled corner',
      objective: 'A turn that has already answered',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    const turnId = 'settled-corner-turn';
    await daemonOperation('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: cornerId,
      requestId: turnId,
      status: 'working',
    });
    await daemonOperation('postAgentDraft', {
      agentId: AGENT,
      roomId: cornerId,
      turnId,
      text: 'half an answer',
    });
    await daemonOperation('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: cornerId,
      requestId: turnId,
      status: 'complete',
    });
    expect(await new PhoneService(database, origin).liveDraftSnapshot(cornerId)).toEqual([]);

    // A working turn nobody has heartbeated inside the horizon is equally
    // dead: its words must not reappear as provisional prose on every open.
    await daemonOperation('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: cornerId,
      requestId: turnId,
      status: 'working',
    });
    expect(await new PhoneService(database, origin).liveDraftSnapshot(cornerId)).toHaveLength(1);
    await database.query(
      `UPDATE agent_turns SET created_at=now()-interval '5 minutes' WHERE room_id=$1 AND request_id=$2`,
      [cornerId, turnId],
    );
    expect(await new PhoneService(database, origin).liveDraftSnapshot(cornerId)).toEqual([]);
  });

  it('prompts a conversation past one page with its newest rows, and recovers the objective from its oldest', async () => {
    // 250 ordered rows: row 1 is the parent-to-corner handoff the objective is
    // recovered from, and the newest rows are what a turn must be prompted with.
    const OBJECTIVE = [
      'Handoff from the parent Room: add a `--dry-run` flag to the importer CLI.',
      'It must print the plan it would apply and exit 0 without touching the database.',
      'Keep the existing default behaviour byte-for-byte when the flag is absent.',
    ].join(' ');
    const rowId = (index: number) =>
      createHash('sha256').update(`page-fixture-${index}`).digest('hex');
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    for (let index = 1; index <= 250; index += 1) {
      // Heavy activity rows and human decisions ride the same page as ordinary
      // conversation, exactly as a long working Room carries them.
      const presentation =
        index % 25 === 0 ? 'system' : index % 3 === 0 ? 'activity' : 'message';
      await database.query(
        `INSERT INTO messages(id,room_id,author_id,text,presentation,mention_ids,activity,created_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,to_timestamp($8::bigint/1000.0))`,
        [
          rowId(index),
          ROOM,
          index % 2 === 0 ? HUMAN : AGENT,
          index === 1 ? OBJECTIVE : `row ${index}`,
          presentation,
          JSON.stringify(index % 2 === 0 ? [AGENT] : []),
          presentation === 'activity'
            ? JSON.stringify({ calls: Array.from({ length: 12 }, (_, call) => ({ title: `call ${call}` })) })
            : null,
          base + index * 1000,
        ],
      );
    }
    const bodies = async (payload: unknown) =>
      (
        (await (
          await daemonOperation('getRoomConversation', payload)
        ).json()) as { items: Array<{ body: string }> }
      ).items.map((item) => item.body);

    // Before: the default read answered with rows 1..200 and the Room's final
    // 80 were rows 121..200. After: the default read is the newest page.
    const recent = await bodies({ roomId: ROOM, limit: 200 });
    expect(recent).toHaveLength(200);
    expect(recent[0]).toBe('row 51');
    expect(recent.at(-1)).toBe('row 250');
    // Ascending transcript order inside the page is what a prompt renders.
    expect(recent).toEqual(Array.from({ length: 200 }, (_, index) => `row ${index + 51}`));
    // The Room turn's own final-80 slice now ends on the newest message.
    const finalEighty = recent.slice(-80);
    expect(finalEighty[0]).toBe('row 171');
    expect(finalEighty.at(-1)).toBe('row 250');

    // Startup objective recovery still reads the oldest end.
    const earliest = await bodies({ roomId: ROOM, limit: 200, window: 'earliest' });
    expect(earliest).toHaveLength(200);
    expect(earliest[0]).toBe(OBJECTIVE);
    expect(earliest.at(-1)).toBe('row 200');
    // The whole handoff survives the trip, not just its first sentence.
    expect(earliest.find((body) => body.includes('--dry-run'))).toBe(OBJECTIVE);

    // A shorter page is still the newest rows, and the default limit too.
    expect(await bodies({ roomId: ROOM, limit: 5 })).toEqual([
      'row 246',
      'row 247',
      'row 248',
      'row 249',
      'row 250',
    ]);
    expect((await bodies({ roomId: ROOM })).at(-1)).toBe('row 250');

    // The inbox keeps its ascending cursor semantics: a walk from the start
    // still begins at row 1 and pages forward.
    const firstInbox = (await (
      await daemonOperation('getRoomInbox', { roomId: ROOM, limit: 100 })
    ).json()) as { items: Array<{ body: string }>; cursor: string };
    expect(firstInbox.items[0]?.body).toBe('row 2');
    const secondInbox = (await (
      await daemonOperation('getRoomInbox', { roomId: ROOM, limit: 100, after: firstInbox.cursor })
    ).json()) as { items: Array<{ body: string }> };
    expect(Number(secondInbox.items[0]!.body.split(' ')[1])).toBeGreaterThan(
      Number(firstInbox.items.at(-1)!.body.split(' ')[1]),
    );
    // A conversation read carrying a cursor is a forward walk, not a page.
    const walked = (await (
      await daemonOperation('getRoomConversation', {
        roomId: ROOM,
        limit: 100,
        after: firstInbox.cursor,
      })
    ).json()) as { items: Array<{ body: string }> };
    expect(walked.items.at(-1)!.body).not.toBe('row 250');

    // Nothing is dropped or duplicated across the two windows: together they
    // cover every one of the 250 rows exactly once.
    expect(new Set([...earliest, ...recent]).size).toBe(250);
  });

  it('never reports unread for the viewer’s own latest message', async () => {
    const sent = await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'c'.repeat(64),
      text: 'My own note',
    });
    expect(sent.status).toBe(200);
    const readChats = async () =>
      (
        (await (await request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{ room: { id: string }; unread: boolean }>;
        }
      ).chats.find((chat) => chat.room.id === ROOM)!;
    expect((await readChats()).unread).toBe(false);

    await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'd'.repeat(64),
      text: 'Agent reply',
    });
    expect((await readChats()).unread).toBe(true);

    const agentMessage = (
      (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
        messages: Array<{ id: string; text: string }>;
      }
    ).messages.find((message) => message.text === 'Agent reply');
    expect(
      (await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: agentMessage!.id }))
        .status,
    ).toBe(204);
    expect((await readChats()).unread).toBe(false);
  });

  it('repairs millisecond-truncated read marks and treats their marked message as read', async () => {
    const messageId = 'e'.repeat(64);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'Precise reply','2026-09-03T01:30:33.596223Z')`,
      [messageId, ROOM, AGENT],
    );
    expect((await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId })).status).toBe(204);
    expect(
      (
        await database.query<{ exact: boolean }>(
          `SELECT mark.message_created_at=message.created_at exact
           FROM room_read_marks mark JOIN messages message ON message.id=mark.message_id
           WHERE mark.room_id=$1 AND mark.identity_id=$2`,
          [ROOM, HUMAN],
        )
      ).rows[0]?.exact,
    ).toBe(true);

    // This is the timestamp a millisecond-precision client used to persist.
    await database.query(
      `UPDATE room_read_marks SET message_created_at='2026-09-03T01:30:33.596Z'
       WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, HUMAN],
    );

    await migrate(database);

    const chat = (
      (await (await request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
        chats: Array<{ room: { id: string }; unread: boolean }>;
      }
    ).chats.find((item) => item.room.id === ROOM);
    expect(chat?.unread).toBe(false);
    expect(
      (
        await database.query<{ exact: boolean }>(
          `SELECT mark.message_created_at=message.created_at exact
           FROM room_read_marks mark JOIN messages message ON message.id=mark.message_id
           WHERE mark.room_id=$1 AND mark.identity_id=$2`,
          [ROOM, HUMAN],
        )
      ).rows[0]?.exact,
    ).toBe(true);
  });

  it('counts only open corners in the Room list', async () => {
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name,archived_at) VALUES
        ('33333333-3333-4333-8333-333333333333',$1,$2,'Done corner',now()),
        ('44444444-4444-4444-8444-444444444444',$1,$2,'Open corner',NULL)`,
      [WORKSPACE, ROOM],
    );
    const chat = (
      (await (await request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
        chats: Array<{ room: { id: string }; cornerCount: number }>;
      }
    ).chats.find((item) => item.room.id === ROOM);
    expect(chat?.cornerCount).toBe(1);
  });

  it('keeps a Room view valid when live activity joins a full transcript', async () => {
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(to_hex(item),64,'0'),$1,$2,'Stored ' || item,to_timestamp(1700000000 + item)
       FROM generate_series(1,$3) AS stored(item)`,
      [ROOM, HUMAN, ROOM_VIEW_MESSAGE_LIMIT],
    );
    const requestId = 'e'.repeat(64);
    expect(
      (
        await daemonOperation('postAgentTurnReceipt', {
          agentId: AGENT,
          roomId: ROOM,
          requestId,
          status: 'working',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: ROOM,
          requestId,
          activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
        })
      ).status,
    ).toBe(200);

    const roomView = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(roomView)).toBe(true);
    expect(roomView.messages).toHaveLength(ROOM_VIEW_MESSAGE_LIMIT);
    expect(roomView.messages).toContainEqual(
      expect.objectContaining({
        author: expect.objectContaining({ pubkey: AGENT }),
        presentation: 'activity',
        activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
      }),
    );
    expect(roomView.messages.map((message) => message.id)).not.toContain('0'.repeat(63) + '1');
  });

  it('keeps settled corner tool rows in the corner read but never in the parent Room', async () => {
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'tool-corner',
      name: 'Tool ledger',
      objective: 'Tool ledger',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(to_hex(item),64,'0'),$1,$2,'Stored ' || item,to_timestamp(1700000000 + item)
       FROM generate_series(1,$3) AS stored(item)`,
      [cornerId, HUMAN, ROOM_VIEW_MESSAGE_LIMIT + 1],
    );
    expect(
      (
        await daemonOperation('postAgentTurnReceipt', {
          roomId: cornerId,
          agentId: AGENT,
          requestId: 'corner-turn-1',
          status: 'working',
        })
      ).status,
    ).toBe(200);
    for (let tool = 1; tool <= 15; tool++) {
      expect(
        (
          await daemonOperation('postAgentActivity', {
            agentId: AGENT,
            roomId: cornerId,
            requestId: 'corner-turn-1',
            activity: [
              {
                kind: 'tool',
                title: 'Bash',
                operation: 'execute',
                command: `npm test -- ActivityTimeline ${tool}`,
                status: 'exit 0',
              },
            ],
          })
        ).status,
      ).toBe(200);
      // Colloquial narration segments land BETWEEN tool rows as durable
      // messages with no request id, so they never settle the turn receipt.
      if (tool === 5 || tool === 10) {
        expect(
          (
            await daemonOperation('postRoomMessage', {
              roomId: cornerId,
              text: `Narration after tool ${tool}: updating only the ledger, then committing.`,
              presentation: 'message',
            })
          ).status,
        ).toBe(200);
      }
    }
    expect(
      (
        await daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: cornerId,
          requestId: 'corner-turn-1',
          activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await daemonOperation('postRoomMessage', {
          roomId: cornerId,
          requestId: 'corner-turn-1',
          text: 'Corner done.',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await daemonOperation('postAgentTurnReceipt', {
          roomId: cornerId,
          agentId: AGENT,
          requestId: 'corner-turn-1',
          status: 'complete',
        })
      ).status,
    ).toBe(200);

    const corner = (await (await request(`/v1/phone/rooms/${cornerId}`)).json()) as RoomView;
    expect(isRoomView(corner)).toBe(true);
    expect(corner.messages).toHaveLength(ROOM_VIEW_MESSAGE_LIMIT);
    expect(corner.toolRows).toHaveLength(15);
    expect(corner.toolRows).toContainEqual(
      expect.objectContaining({
        presentation: 'activity',
        activity: [
          expect.objectContaining({
            kind: 'tool',
            title: 'Bash',
            command: 'npm test -- ActivityTimeline 1',
          }),
        ],
      }),
    );
    // Live-only lanes (thinking) settle away with the turn; the tool row is the
    // only activity row that survives.
    expect(
      corner.messages.filter(
        (message) => message.presentation === 'activity' && message.activity?.[0]?.kind !== 'tool',
      ),
    ).toEqual([]);
    expect(corner.messages).toContainEqual(
      expect.objectContaining({ text: 'Corner done.', presentation: 'message' }),
    );
    // Narration ledger lines survive the turn as ordinary indexed messages
    // (no request id of their own), interleavable with the collapsed tool
    // rows by creation time.
    const narration = corner.messages.filter((message) =>
      message.text.startsWith('Narration after tool'),
    );
    expect(narration).toHaveLength(2);
    for (const line of narration) {
      expect(line.presentation).toBe('message');
      expect(line.requestId).toBeUndefined();
    }
    expect(corner.toolRows).toHaveLength(15);

    const parent = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(
      parent.messages.filter(
        (message) => message.presentation === 'activity' && !message.durableFact,
      ),
    ).toEqual([]);
  });

  it('implicitly addresses an untagged human follow-up to the agent that just replied', async () => {
    const peer = 'e'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    const reply = await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: '1'.repeat(64),
      text: 'I am Bee.',
    });
    expect(reply.status).toBe(200);

    const sent = await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '2'.repeat(64),
      text: 'Who are you?',
    });
    expect(sent.status).toBe(200);
    const inbox = await daemonOperation('getRoomInbox', { roomId: ROOM });
    expect(
      ((await inbox.json()) as { items: Array<{ id: string; mentionIds: string[] }> }).items,
    ).toContainEqual(expect.objectContaining({ id: '2'.repeat(64), mentionIds: [AGENT] }));
  });

  it('implicitly addresses a threaded human reply to the parent agent regardless of position', async () => {
    const parent = await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: '3'.repeat(64),
      text: 'Thread parent.',
    });
    const parentId = ((await parent.json()) as { id: string }).id;
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '4'.repeat(64),
      text: 'An intervening human message.',
      mentions: [AGENT],
    });

    const sent = await operation('sendRoomReply', {
      roomId: ROOM,
      messageId: '5'.repeat(64),
      parentMessageId: parentId,
      text: 'Answer this thread.',
    });
    expect(sent.status).toBe(200);
    const stored = await database.query<{ mention_ids: string[]; reply_to_message_id: string }>(
      `SELECT mention_ids,reply_to_message_id FROM messages WHERE id=$1`,
      ['5'.repeat(64)],
    );
    expect(stored.rows[0]).toEqual({ mention_ids: [AGENT], reply_to_message_id: parentId });
  });

  it('implicitly addresses an untagged human message to the only agent in the Room', async () => {
    const sent = await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '6'.repeat(64),
      text: 'Please take this.',
    });
    expect(sent.status).toBe(200);
    const stored = await database.query<{ mention_ids: string[] }>(
      `SELECT mention_ids FROM messages WHERE id=$1`,
      ['6'.repeat(64)],
    );
    expect(stored.rows[0]?.mention_ids).toEqual([AGENT]);
  });

  it('leaves an untagged human message unaddressed with two agents and no prior agent message', async () => {
    const peer = 'f'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );

    const sent = await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '7'.repeat(64),
      text: 'This is for nobody in particular.',
    });
    expect(sent.status).toBe(200);
    const stored = await database.query<{ mention_ids: string[] }>(
      `SELECT mention_ids FROM messages WHERE id=$1`,
      ['7'.repeat(64)],
    );
    expect(stored.rows[0]?.mention_ids).toEqual([]);
  });

  it('manages agent tool schedules over daemon HTTP with agent scoping', async () => {
    const created = await daemonOperation('createAgentSchedule', {
      agentId: AGENT,
      roomId: ROOM,
      prompt: "message 'hello @bananaman614305'",
      cadence: { kind: 'interval', everyMinutes: 1 },
      maxRuns: 5,
    });
    expect(created.status).toBe(200);
    const { scheduleId, nextRunAt } = (await created.json()) as {
      scheduleId: string;
      nextRunAt: number;
    };
    expect(scheduleId).toMatch(/[0-9a-f-]{36}/);
    expect(nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const listed = await daemonOperation('listAgentSchedules', { agentId: AGENT, roomId: ROOM });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      schedules: [
        {
          scheduleId,
          prompt: "message 'hello @bananaman614305'",
          cadence: { kind: 'interval', everyMinutes: 1 },
          maxRuns: 5,
          runCount: 0,
          nextRunAt,
        },
      ],
    });
    // The daemon token's agent cannot be impersonated and cannot delete...
    const foreignCreate = await daemonOperation('createAgentSchedule', {
      agentId: 'f'.repeat(64),
      roomId: ROOM,
      prompt: 'Impersonation.',
      cadence: { kind: 'interval', everyMinutes: 1 },
    });
    expect(foreignCreate.status).toBeGreaterThanOrEqual(400);
    const deleted = await daemonOperation('deleteAgentSchedule', {
      agentId: AGENT,
      roomId: ROOM,
      scheduleId,
    });
    expect(deleted.status).toBe(200);
    const gone = await daemonOperation('listAgentSchedules', { agentId: AGENT, roomId: ROOM });
    await expect(gone.json()).resolves.toEqual({ schedules: [] });
    const missing = await daemonOperation('deleteAgentSchedule', {
      agentId: AGENT,
      roomId: ROOM,
      scheduleId,
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });

  it('reports daemon bundle readiness over public monolith HTTP', async () => {
    const sourceSha = 'd03cff8f'.padEnd(40, '0');
    const posted = await request(
      '/v1/daemon/operations/postAgentPresence',
      'POST',
      {
        agentId: AGENT,
        roomId: ROOM,
        status: 'online',
        releaseVersion: 'v0.0.22',
        sourceSha,
      },
      daemonToken,
    );
    expect(posted.status).toBe(200);

    const response = await fetch(`${origin}/v1/releases/daemon-readiness`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      daemons: [
        {
          agentPubkey: AGENT,
          state: 'ready',
          version: 'v0.0.22',
          sha: sourceSha,
          observedAt: expect.any(Number),
        },
      ],
      summary: { total: 1, ready: 1, neverSeen: 0 },
    });
  });

  it('reports a registered agent that never ran as never-seen and rolls it back', async () => {
    const ghost = await request('/v1/phone/operations/createAgentPairingCode', 'POST', {
      workspaceId: WORKSPACE,
    });
    const { code } = (await ghost.json()) as { code: string };
    const connectPayload = JSON.stringify({
      pairing_code: code,
      harness: 'claude',
      model: 'claude-test-model',
      soul: 'Helper soul.',
      agent_name: 'Ghost Helper',
    });
    const claimed = await new Promise<{ status: number; body: Record<string, string> }>(
      (resolve, reject) => {
        const outgoing = httpRequest(`${origin}/auth/agent/connect`, {
          method: 'POST',
          headers: {
            host: 'server.test',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(connectPayload),
          },
        });
        outgoing.once('error', reject);
        outgoing.once('response', (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>,
            }),
          );
        });
        outgoing.end(connectPayload);
      },
    );
    expect(claimed.status).toBe(200);
    const grant = {
      agentPubkey: claimed.body.agent_pubkey!,
      exchangeToken: claimed.body.daemon_exchange_token!,
    };

    // A real fleet member on the release, so the ghost is the only odd one out.
    const realPresence = await request(
      '/v1/daemon/operations/postAgentPresence',
      'POST',
      {
        agentId: AGENT,
        roomId: ROOM,
        status: 'online',
        releaseVersion: 'v0.0.22',
        sourceSha: 'd03cff8f'.padEnd(40, '0'),
      },
      daemonToken,
    );
    expect(realPresence.status).toBe(200);

    const readiness = await fetch(`${origin}/v1/releases/daemon-readiness`);
    expect(readiness.status).toBe(200);
    const body = (await readiness.json()) as {
      daemons: Array<{ agentPubkey: string; state: string; observedAt?: number }>;
      summary: { total: number; ready: number; neverSeen: number };
    };
    const ghostEntry = body.daemons.find((daemon) => daemon.agentPubkey === grant.agentPubkey);
    expect(ghostEntry?.state).toBe('never-seen');
    expect(ghostEntry?.observedAt).toBeUndefined();
    expect(body.summary).toMatchObject({ total: 2, ready: 1, neverSeen: 1 });

    const rolledBack = await request('/v1/auth/daemon/rollback', 'POST', {
      exchangeToken: grant.exchangeToken,
    });
    expect(rolledBack.status).toBe(204);
    const afterReadiness = await fetch(`${origin}/v1/releases/daemon-readiness`);
    const afterBody = (await afterReadiness.json()) as typeof body;
    expect(
      afterBody.daemons.find((daemon) => daemon.agentPubkey === grant.agentPubkey),
    ).toBeUndefined();
    expect(afterBody.summary).toMatchObject({ total: 1, ready: 1, neverSeen: 0 });

    const refuse = await request('/v1/auth/daemon/rollback', 'POST', {
      exchangeToken: grant.exchangeToken,
    });
    expect(refuse.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to roll back an agent that has already reported presence', async () => {
    await request(
      '/v1/daemon/operations/postAgentPresence',
      'POST',
      { agentId: AGENT, roomId: ROOM, status: 'online' },
      daemonToken,
    );
    const refused = await request('/v1/auth/daemon/rollback', 'POST', {});
    expect(refused.status).toBe(400);
  });

  it('treats concurrent retries of the same message write as one successful send', async () => {
    const payload = {
      roomId: ROOM,
      messageId: 'd'.repeat(64),
      text: 'Send this once',
      mentions: [AGENT],
    };

    const [foreground, outbox] = await Promise.all([
      request('/v1/phone/operations/sendRoomMessage', 'POST', payload),
      request('/v1/phone/operations/sendRoomMessage', 'POST', payload),
    ]);

    expect([foreground.status, outbox.status]).toEqual([200, 200]);
    expect(await foreground.json()).toEqual({ messageId: payload.messageId });
    expect(await outbox.json()).toEqual({ messageId: payload.messageId });
    const stored = await database.query<{ count: string }>(
      `SELECT count(*)::text FROM messages WHERE id=$1`,
      [payload.messageId],
    );
    expect(stored.rows[0]?.count).toBe('1');

    const conflicting = await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      ...payload,
      text: 'Different payload',
    });
    expect(conflicting.status).toBe(400);
  });

  it('mints, resolves, and redeems an invite through the phone HTTP surface', async () => {
    const created = await request('/v1/phone/operations/createInvite', 'POST', {
      workspaceId: WORKSPACE,
    });
    expect(created.status).toBe(200);
    const invite = (await created.json()) as { token: string; expiresAt: number };
    expect(isCommunityInviteToken(invite.token)).toBe(true);
    expect(invite.token).toMatch(/^inv_[0-9a-f]{64}$/);

    const recipient = await auth.exchangeGitHubOidc('recipient-proof');
    const resolved = await request(
      '/v1/phone/operations/resolveInvite',
      'POST',
      { token: invite.token },
      recipient.accessToken,
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      name: 'Hive',
      expiresAt: invite.expiresAt,
    });

    const redeemed = await request(
      '/v1/phone/operations/redeemInvite',
      'POST',
      { token: invite.token },
      recipient.accessToken,
    );
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ joined: true, workspaceId: WORKSPACE });
    const membership = await database.query<{ role: string }>(
      `SELECT role FROM memberships WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, recipient.identityId],
    );
    expect(membership.rows).toEqual([{ role: 'member' }]);
  });

  it('publishes one note per joined Room and one push when a person redeems an invite', async () => {
    const recipient = await auth.exchangeGitHubOidc('recipient-proof');
    const secondRoom = (await (
      await operation('createRoom', { workspaceId: WORKSPACE, name: 'Workshop' })
    ).json()) as { id: string };
    await operation('registerPushDevice', {
      token: 'owner-person-join-device-token-1234567890',
      platform: 'ios',
      environment: 'physical',
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(database, { send });
    expect(await loop.runOnce()).toBe(0);
    const invite = (await (await operation('createInvite', { workspaceId: WORKSPACE })).json()) as {
      token: string;
    };

    const redeemed = await request(
      '/v1/phone/operations/redeemInvite',
      'POST',
      { token: invite.token },
      recipient.accessToken,
    );
    expect(redeemed.status).toBe(200);

    const notes = await database.query<{
      room_id: string;
      text: string;
      presentation: string;
    }>(
      `SELECT room_id,text,presentation FROM messages
       WHERE author_id=$1 AND card_type='member-joined' AND room_id=ANY($2::uuid[])
       ORDER BY room_id`,
      [recipient.identityId, [ROOM, secondRoom.id]],
    );
    expect(notes.rows).toEqual(
      [ROOM, secondRoom.id]
        .sort()
        .map((room_id) => ({ room_id, text: 'recipient joined', presentation: 'system' })),
    );

    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'owner-person-join-device-token-1234567890',
      expect.objectContaining({ text: 'recipient joined Hive' }),
    );
  });

  it('publishes one note per joined Room and one push through agent connect', async () => {
    const secondRoom = (await (
      await operation('createRoom', { workspaceId: WORKSPACE, name: 'Workshop' })
    ).json()) as { id: string };
    await operation('registerPushDevice', {
      token: 'owner-agent-join-device-token-1234567890',
      platform: 'android',
      environment: 'physical',
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(database, { send });
    expect(await loop.runOnce()).toBe(0);
    const pairing = (await (
      await operation('createAgentPairingCode', { workspaceId: WORKSPACE })
    ).json()) as { code: string };

    // Neither a name nor a soul is typed any more: the claim seeds both.
    const connectPayload = JSON.stringify({
      pairing_code: pairing.code,
      harness: 'codex',
      model: 'gpt-5.6',
    });
    const connected = await new Promise<{ status: number; body: Record<string, string> }>(
      (resolve, reject) => {
        const outgoing = httpRequest(`${origin}/auth/agent/connect`, {
          method: 'POST',
          headers: {
            host: 'server.test',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(connectPayload),
          },
        });
        outgoing.once('error', reject);
        outgoing.once('response', (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>,
            }),
          );
        });
        outgoing.end(connectPayload);
      },
    );
    expect(connected.status).toBe(200);
    const grant = connected.body as {
      agent_pubkey: string;
      agent_name: string;
      agent_face: string;
      soul: string;
    };
    expect(isFaceId(grant.agent_face)).toBe(true);
    expect(grant.soul).toBe(FACE_SOULS[grant.agent_face as FaceId]);
    expect(FACE_NAMES[grant.agent_face as FaceId]).toContain(grant.agent_name);

    const notes = await database.query<{
      room_id: string;
      text: string;
      presentation: string;
    }>(
      `SELECT room_id,text,presentation FROM messages
       WHERE author_id=$1 AND card_type='member-joined' ORDER BY room_id`,
      [grant.agent_pubkey],
    );
    expect(notes.rows).toEqual(
      [ROOM, secondRoom.id].sort().map((room_id) => ({
        room_id,
        text: `${grant.agent_name} joined`,
        presentation: 'system',
      })),
    );

    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'owner-agent-join-device-token-1234567890',
      expect.objectContaining({ text: `${grant.agent_name} joined Hive` }),
    );
  });

  it('always hands an agent its seeded soul, at both daemon seams (no Workspace switch)', async () => {
    await database.query(`UPDATE agents SET soul=$2::jsonb WHERE agent_id=$1`, [
      AGENT,
      JSON.stringify({ name: 'Bee', instructions: 'You are a fox.', avatarSeed: AGENT }),
    ]);
    const soulOf = async () =>
      (
        (await (
          await daemonOperation('getAgentConfiguration', { agentId: AGENT, roomId: ROOM })
        ).json()) as { soul?: { instructions: string } }
      ).soul;
    const rosterSoulOf = async () =>
      (
        (await (
          await daemonOperation('getWorkspaceRoster', { workspaceId: WORKSPACE })
        ).json()) as { members: Array<{ identityId: string; soul?: unknown }> }
      ).members.find((member) => member.identityId === AGENT)?.soul;

    const view = (await (await request(`/v1/phone/workspaces/${WORKSPACE}`)).json()) as {
      managerSettings?: { visibility?: string };
    };
    expect(view.managerSettings).toEqual({ visibility: expect.any(String) });
    expect(await soulOf()).toMatchObject({ instructions: 'You are a fox.' });
    expect(await rosterSoulOf()).toBeDefined();
  });

  it('creates Rooms with or without an installed repository binding', async () => {
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_login,account_type) VALUES(42,$1,'owner','User')`,
      [HUMAN],
    );
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(77,42,'owner/worker','trunk')`,
    );

    const plain = await request('/v1/phone/operations/createRoom', 'POST', {
      workspaceId: WORKSPACE,
      name: 'Plain Room',
    });
    expect(plain.status).toBe(200);
    const plainId = ((await plain.json()) as { id: string }).id;
    expect(
      (await new PhoneService(database, origin).readRoom(plainId, HUMAN))?.repository,
    ).toBeUndefined();

    const bound = await request('/v1/phone/operations/createRoom', 'POST', {
      workspaceId: WORKSPACE,
      name: 'Repository Room',
      repositoryId: 77,
    });
    expect(bound.status).toBe(200);
    const boundId = ((await bound.json()) as { id: string }).id;
    expect((await new PhoneService(database, origin).readRoom(boundId, HUMAN))?.repository).toEqual(
      expect.objectContaining({
        key: 'github:77',
        name: 'owner/worker',
        remote: 'git://github.com/owner/worker',
        targetBranch: 'trunk',
        githubInstallationId: 42,
      }),
    );
    const chats = (await (await request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
      chats: Array<{ room: { id: string }; repositoryName?: string }>;
    };
    expect(chats.chats.find((item) => item.room.id === boundId)?.repositoryName).toBe(
      'owner/worker',
    );
  });

  it('rotates refresh tokens and rejects stale phone and daemon credentials', async () => {
    const initial = await auth.exchangeGitHubOidc('proof');
    const refreshed = await request(
      '/v1/auth/refresh',
      'POST',
      { refreshToken: initial.refreshToken },
      '',
    );
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { accessToken: string }).accessToken).not.toBe(
      initial.accessToken,
    );
    const stale = await request(
      '/v1/auth/refresh',
      'POST',
      { refreshToken: initial.refreshToken },
      '',
    );
    expect(stale.status).toBe(401);
    await database.query(`UPDATE daemon_tokens SET revoked_at=now()`);
    expect(
      (
        await request(
          '/v1/daemon/operations/getDaemonBootstrap',
          'POST',
          { agentId: AGENT },
          daemonToken,
        )
      ).status,
    ).toBe(401);
  });

  it('runs the face ceremony: set, read back on every identity view, refuse an unknown id, clear', async () => {
    const operation = (name: string, payload: unknown = {}) =>
      request(`/v1/phone/operations/${name}`, 'POST', payload);
    const viewerFace = async () =>
      ((await (await operation('getManagedIdentity')).json()) as { face?: string }).face;

    expect(await viewerFace()).toBeUndefined();

    expect((await operation('updateIdentityFace', { faceId: 'owl' })).status).toBe(204);
    expect(await viewerFace()).toBe('owl');

    const sent = await operation('sendRoomMessage', { roomId: ROOM, text: 'hoot' });
    expect(sent.status).toBe(200);
    const room = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      viewer: { identity: { pubkey: string; face?: string } };
      members: { identity: { pubkey: string; face?: string } }[];
      messages: { text: string; author: { pubkey: string; face?: string } }[];
    };
    expect(room.viewer.identity.face).toBe('owl');
    expect(room.members.find((member) => member.identity.pubkey === HUMAN)?.identity.face).toBe(
      'owl',
    );
    expect(room.messages.find((message) => message.text === 'hoot')?.author.face).toBe('owl');
    const workspace = (await (await request(`/v1/phone/workspaces/${WORKSPACE}`)).json()) as {
      viewer: { identity: { face?: string } };
      members: { identity: { pubkey: string; face?: string } }[];
    };
    expect(workspace.viewer.identity.face).toBe('owl');
    expect(
      workspace.members.find((member) => member.identity.pubkey === HUMAN)?.identity.face,
    ).toBe('owl');

    const refused = await operation('updateIdentityFace', { faceId: 'dragon' });
    expect(refused.status).toBe(400);
    expect(await viewerFace()).toBe('owl');
    expect((await operation('updateIdentityFace', {})).status).toBe(400);
    expect(await viewerFace()).toBe('owl');

    expect((await operation('updateIdentityFace', { faceId: null })).status).toBe(204);
    expect(await viewerFace()).toBeUndefined();
    const cleared = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      viewer: { identity: { face?: string } };
    };
    expect(cleared.viewer.identity).not.toHaveProperty('face');
  });

  it('proves every auth identity phone operation through bearer-authenticated HTTP', async () => {
    const operation = (name: string, payload: unknown = {}) =>
      request(`/v1/phone/operations/${name}`, 'POST', payload);

    await expect((await operation('getAuthCapabilities')).json()).resolves.toEqual({
      github: true,
    });
    await expect((await operation('getManagedIdentity')).json()).resolves.toEqual({
      personId: HUMAN,
      name: 'Owner',
      handle: 'owner',
    });

    const profile = await operation('updatePersonProfile', {
      name: 'Captain',
      avatar: 'https://images.example/captain.png',
    });
    expect(profile.status).toBe(200);
    await expect(profile.json()).resolves.toEqual({
      personId: HUMAN,
      name: 'Captain',
      handle: 'owner',
      avatar: 'https://images.example/captain.png',
    });
    const cleared = await operation('updatePersonProfile', { avatar: '' });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual({
      personId: HUMAN,
      name: 'Captain',
      handle: 'owner',
    });

    const claimed = await operation('claimManagedHandle', { handle: 'captain.owner' });
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({ handle: 'captain.owner' });
    expect((await operation('claimManagedHandle', { handle: 'Not Valid' })).status).toBe(400);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Other','already-taken')`,
      ['d'.repeat(64)],
    );
    expect((await operation('claimManagedHandle', { handle: 'already-taken' })).status).toBe(409);
    await expect((await operation('adoptGitHubHandle')).json()).resolves.toMatchObject({
      personId: HUMAN,
      handle: 'owner',
    });
    await expect((await operation('getIdentityRecovery')).json()).resolves.toEqual({
      candidates: [],
    });

    const state = 's'.repeat(43);
    const started = await operation('beginGitHubIdentityBind', {
      redirectUri: 'beeline://buzz/github-callback',
      state,
    });
    expect(started.status).toBe(200);
    expect(((await started.json()) as { url: string }).url).toContain(`state=${state}`);
    const completed = await operation('completeGitHubIdentityBind', {
      challenge: 'github-code',
      proof: state,
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({ personId: HUMAN, recovered: false });

    const link = await database.query<{ audience: string }>(
      `SELECT audience FROM identity_external_links WHERE provider='github' AND subject='owner'`,
    );
    expect(link.rows[0]?.audience).toBe('github');
  });

  it('recovers a GitHub identity conflict and exposes the predecessor over HTTP', async () => {
    const predecessor = 'c'.repeat(64);
    await database.query(`UPDATE identities SET github_subject=NULL WHERE id=$1`, [HUMAN]);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject) VALUES($1,'human','Old Owner','old-owner','owner')`,
      [predecessor],
    );
    await database.query(
      `UPDATE identity_external_links SET identity_id=$1,audience='old-oauth-client'
       WHERE provider='github' AND subject='owner'`,
      [predecessor],
    );
    const state = 'r'.repeat(43);
    await request('/v1/phone/operations/beginGitHubIdentityBind', 'POST', {
      redirectUri: 'beeline://buzz/github-callback',
      state,
    });
    expect(
      (
        await request('/v1/phone/operations/completeGitHubIdentityBind', 'POST', {
          challenge: 'github-code',
          proof: state,
        })
      ).status,
    ).toBe(409);
    const recovered = await request('/v1/phone/operations/recoverGitHubIdentity', 'POST', {
      challenge: 'github-code',
      proof: state,
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toEqual({ personId: HUMAN, recovered: true });
    await expect(
      (await request('/v1/phone/operations/getIdentityRecovery', 'POST', {})).json(),
    ).resolves.toEqual({ candidates: [{ personId: predecessor, handle: 'old-owner' }] });
  });

  it('stores and serves media bytes through token auth with the configured cap', async () => {
    expect(DEFAULT_MEDIA_MAXIMUM_BYTES).toBe(25 * 1024 * 1024);
    const upload = await fetch(`${origin}/v1/phone/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'image/png',
        'x-file-name': 'tiny.png',
      },
      body: Buffer.from('png-bytes'),
    });
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()) as { url: string };
    const sent = await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      text: 'image',
      attachments: [{ url: attachment.url, name: 'tiny.png', mimeType: 'image/png', size: 9 }],
    });
    expect(sent.status).toBe(200);
    const media = await fetch(attachment.url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(media.status).toBe(200);
    expect(Buffer.from(await media.arrayBuffer()).toString()).toBe('png-bytes');
    expect(
      (
        await fetch(`${origin}/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).status,
    ).toBe(404);
    const tooLarge = await fetch(`${origin}/v1/phone/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: Buffer.alloc(1024 * 1024 + 1),
    });
    expect(tooLarge.status).toBe(400);
  });

  it('delivers an agent attach_file attachment onto the final reply as a valid RoomView', async () => {
    // 1. Daemon media upload, authenticated as the agent, same storage as phone uploads.
    const upload = await fetch(`${origin}/v1/daemon/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${daemonToken}`,
        'content-type': 'text/plain',
        'x-file-name': 'notes.txt',
      },
      body: Buffer.from('agent-file-bytes'),
    });
    expect(upload.status).toBe(201);
    const attachment = (await upload.json()) as {
      url: string;
      name: string;
      mimeType: string;
      size: number;
    };
    expect(attachment).toMatchObject({
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 16,
    });
    expect(
      await (
        await fetch(`${origin}/v1/daemon/media`, { method: 'POST', body: 'x' })
      ).status,
    ).toBe(401);

    // 2. Only media owned by the authenticated agent may be queued.
    expect(
      (
        await daemonOperation('postAgentAttachment', {
          roomId: ROOM,
          attachment: {
            ...attachment,
            url: `${origin}/v1/media/22222222-2222-4222-8222-222222222222`,
          },
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await daemonOperation('postAgentAttachment', {
          roomId: ROOM,
          attachment: { ...attachment, url: 'https://elsewhere.example/file.txt' },
        })
      ).status,
    ).toBe(503);

    // 3. Queue then drain onto the agent's final reply.
    expect(
      (await daemonOperation('postAgentAttachment', { roomId: ROOM, attachment })).status,
    ).toBe(200);
    const reply = await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'c'.repeat(64),
      text: 'Here is the file.',
    });
    expect(reply.status).toBe(200);
    const replyId = ((await reply.json()) as { id: string }).id;
    // A second post must not repeat the drained attachment.
    await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'd'.repeat(64),
      text: 'No file this time.',
    });

    // 4. A phone reads it back as a valid RoomView attachment.
    const roomView = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(roomView)).toBe(true);
    const withFile = roomView.messages.filter((message) => message.attachments?.length);
    expect(withFile).toHaveLength(1);
    expect(isRoomViewMessage(withFile[0])).toBe(true);
    expect(withFile[0]).toMatchObject({
      id: replyId,
      text: 'Here is the file.',
      author: expect.objectContaining({ pubkey: AGENT }),
    });
    expect(withFile[0]!.attachments![0]).toMatchObject({
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 16,
    });
    expect(typeof withFile[0]!.attachments![0].size).toBe('number');
    const media = await fetch(withFile[0]!.attachments![0].url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(Buffer.from(await media.arrayBuffer()).toString()).toBe('agent-file-bytes');
  });

  it('deduplicates push delivery claims in Postgres', async () => {
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('device-token-12345678901234567890',$1,'ios','physical')`,
      [HUMAN],
    );
    const floor = new PushDeliveryLoop(database, { send: vi.fn().mockResolvedValue(undefined) });
    expect(await floor.runOnce()).toBe(0);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,mention_ids)
       VALUES($1,$2,$3,'push me',$4::jsonb)`,
      ['d'.repeat(64), ROOM, AGENT, JSON.stringify([HUMAN])],
    );
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(database, { send });
    expect(await loop.runOnce()).toBe(1);
    expect(await loop.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('round-trips push, update, and agent operations through the phone HTTP contract', async () => {
    const pairing = await request('/v1/phone/operations/createAgentPairingCode', 'POST', {
      workspaceId: WORKSPACE,
    });
    expect(pairing.status).toBe(200);
    const pairingResult = (await pairing.json()) as { code: string; expiresAt: number };
    expect(pairingResult.code).toMatch(/^[0-9A-F]{8}-[0-9A-F]{8}$/);

    // The connect lane exchanges an app-minted code as the new agent. Exercise
    // the same named operation with an agent-scoped bearer so this legacy API
    // remains contract-valid until that cutover lands.
    const agentAccessToken = 'bat_agent_http_contract';
    await database.query(
      `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
       VALUES($1,$2,$3,now()+interval '15 minutes')`,
      [tokenHash(agentAccessToken), AGENT, '33333333-3333-4333-8333-333333333333'],
    );
    const claimed = await request(
      '/v1/phone/operations/claimAgentPairing',
      'POST',
      { code: pairingResult.code },
      agentAccessToken,
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual(
      expect.objectContaining({ workspaceId: WORKSPACE, pairedBy: HUMAN, joined: true }),
    );

    const soul = await request('/v1/phone/operations/updateAgentSoul', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      name: 'Honeybee',
      instructions: 'Be precise and practical.',
      avatarSeed: 'honeybee-seed',
    });
    expect(soul.status).toBe(204);
    expect(await soul.text()).toBe('');

    const model = await request('/v1/phone/operations/updateAgentModelSelection', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      model: 'gpt-5.6',
      effort: 'high',
    });
    expect(model.status).toBe(204);
    expect(await model.text()).toBe('');

    const effortOnly = await request('/v1/phone/operations/updateAgentModelSelection', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      effort: 'max',
    });
    expect(effortOnly.status).toBe(204);

    const modelAndClearEffort = await request(
      '/v1/phone/operations/updateAgentModelSelection',
      'POST',
      { workspaceId: WORKSPACE, agentId: AGENT, model: 'gpt-5.6-codex', effort: null },
    );
    expect(modelAndClearEffort.status).toBe(204);

    const agent = await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`);
    expect(agent.status).toBe(200);
    expect(await agent.json()).toEqual(
      expect.objectContaining({
        soul: expect.objectContaining({
          name: 'Honeybee',
          instructions: 'Be precise and practical.',
          avatarSeed: 'honeybee-seed',
        }),
        selected: { model: 'gpt-5.6-codex' },
      }),
    );

    const token = 'device-token-production-shaped-1234567890';
    const registered = await request('/v1/phone/operations/registerPushDevice', 'POST', {
      token,
      platform: 'android',
      environment: 'physical',
    });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({ accepted: true });

    const tested = await request('/v1/phone/operations/sendPushTest', 'POST', {});
    expect(tested.status).toBe(204);
    expect(await tested.text()).toBe('');
    expect(sendPushTest).toHaveBeenCalledWith(HUMAN);

    const reported = await request('/v1/phone/operations/reportRunningUpdate', 'POST', {
      deviceId: '44444444-4444-4444-8444-444444444444',
      updateId: 'update-1',
      channel: 'production',
      group: 'group-1',
      runtimeVersion: '21',
      releaseVersion: '1.2.3',
      sourceSha: 'a'.repeat(40),
    });
    expect(reported.status).toBe(204);
    expect(await reported.text()).toBe('');

    const unregistered = await request('/v1/phone/operations/unregisterPushDevice', 'POST', {
      token,
      platform: 'android',
      environment: 'physical',
    });
    expect(unregistered.status).toBe(204);
    expect(await unregistered.text()).toBe('');

    const removed = await request('/v1/phone/operations/removeAgent', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
    });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');

    expect(
      (await database.query(`SELECT 1 FROM push_devices WHERE token=$1`, [token])).rowCount,
    ).toBe(0);
    expect(
      (
        await database.query(
          `SELECT 1 FROM device_update_receipts WHERE identity_id=$1 AND device_id=$2`,
          [HUMAN, '44444444-4444-4444-8444-444444444444'],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await database.query(
          `SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
          [WORKSPACE, AGENT],
        )
      ).rowCount,
    ).toBe(0);

    // The helper's own tokens now answer with the one settled fact it may
    // retire itself on, instead of a 401 it would retry against forever.
    const refused = await daemonOperation('getDaemonBootstrap', { agentId: AGENT });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'agent_removed' });
    const unknownToken = await daemonOperation('getDaemonBootstrap', { agentId: AGENT }, 'bdt_nope');
    expect(unknownToken.status).toBe(401);
    expect(await unknownToken.json()).toEqual({ error: 'daemon_token_required' });
  });

  it('does not let a workspace manager mutate or revoke another workspace agent', async () => {
    const otherWorkspace = '55555555-5555-4555-8555-555555555555';
    const otherAgent = 'e'.repeat(64);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other')`, [otherWorkspace]);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Other agent')`, [
      otherAgent,
    ]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      otherAgent,
      HUMAN,
    ]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [otherWorkspace, otherAgent],
    );

    for (const [name, input] of [
      [
        'updateAgentSoul',
        {
          workspaceId: WORKSPACE,
          agentId: otherAgent,
          name: 'Stolen',
          instructions: 'Changed across tenants',
          avatarSeed: 'seed',
        },
      ],
      [
        'updateAgentModelSelection',
        { workspaceId: WORKSPACE, agentId: otherAgent, model: 'wrong-model' },
      ],
      ['removeAgent', { workspaceId: WORKSPACE, agentId: otherAgent }],
    ] as const) {
      const response = await request(`/v1/phone/operations/${name}`, 'POST', input);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'agent not found in workspace' });
    }
  });

  it('serves bounded GitHub room tokens and deduplicates signed webhooks', async () => {
    const roomToken = await request(`/v1/phone/github/room-token/${ROOM}`);
    expect(roomToken.status).toBe(200);
    expect(((await roomToken.json()) as { token: string }).token).toBe('github-room-token');
    const payload = Buffer.from(JSON.stringify({ action: 'opened' }));
    const signature = `sha256=${createHmac('sha256', 'webhook-secret').update(payload).digest('hex')}`;
    const send = () =>
      fetch(`${origin}/v1/github/webhook`, {
        method: 'POST',
        headers: {
          'x-hub-signature-256': signature,
          'x-github-delivery': 'delivery-1',
          'x-github-event': 'pull_request',
          'content-type': 'application/json',
        },
        body: payload,
      });
    expect((await send()).status).toBe(202);
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(processWebhook).toHaveBeenCalledOnce();
  });

  it('turns signed GitHub branch events into corner notes and closes a merged corner', async () => {
    processWebhook.mockImplementation((event, payload) =>
      githubOperations.processWebhook(event, payload),
    );
    await database.query(
      `INSERT INTO github_installations(
         installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
       ) VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await database.query(
      `UPDATE rooms SET repository_key='owner/widgets',
         repository_remote='https://github.com/owner/widgets.git',
         repository_resolution='repository',github_installation_id=77 WHERE id=$1`,
      [ROOM],
    );
    const daemonRoomToken = await daemonOperation('getRoomGitHubToken', { roomId: ROOM });
    expect(daemonRoomToken.status).toBe(200);
    expect(await daemonRoomToken.json()).toMatchObject({ token: 'github-room-token' });
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-request',
      name: 'Ship widget',
      objective: 'Ship widget',
      repository: 'owner/widgets',
      targetBranch: 'main',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    expect(
      (
        await daemonOperation('postCornerLifecycle', {
          cornerId,
          status: 'working',
          objective: 'A later lifecycle write must not replace the fixed summary',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await daemonOperation('postCornerPlan', {
          cornerId,
          objective: 'A later plan write must not replace the fixed summary',
          items: [],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await daemonOperation('postCornerRemoteState', {
          cornerId,
          branch: 'fm/widget',
          state: 'working',
          checks: 'unknown',
        })
      ).status,
    ).toBe(200);

    const base = {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
    };
    expect(
      (
        await webhook('pull_request', 'corner-pr-open', {
          ...base,
          action: 'opened',
          pull_request: {
            number: 42,
            title: 'Ship the widget',
            html_url: 'https://github.com/owner/widgets/pull/42',
            head: { ref: 'fm/widget', sha: '0'.repeat(40) },
            base: { ref: 'main' },
            mergeable_state: 'clean',
            merged: false,
          },
        })
      ).status,
    ).toBe(202);
    await webhook('push', 'corner-push', {
      ...base,
      ref: 'refs/heads/fm/widget',
      after: '1'.repeat(40),
      compare: 'https://github.com/owner/widgets/compare/a...b',
      commits: [{ id: '1' }, { id: '2' }],
    });
    await webhook('check_run', 'corner-check-started', {
      ...base,
      action: 'in_progress',
      check_run: {
        id: 6,
        name: 'typecheck',
        status: 'in_progress',
        html_url: 'https://github.com/owner/widgets/actions/runs/6',
        check_suite: { head_branch: 'fm/widget', head_sha: '1'.repeat(40) },
      },
    });
    await webhook('check_suite', 'corner-checks-failed', {
      ...base,
      action: 'completed',
      check_suite: {
        id: 7,
        status: 'completed',
        conclusion: 'failure',
        head_branch: 'fm/widget',
        head_sha: '1'.repeat(40),
        app: { name: 'Beeline CI' },
        url: 'https://github.com/owner/widgets/actions/runs/7',
      },
    });
    const redApproval = await request('/v1/phone/operations/approveCornerMerge', 'POST', {
      cornerId,
    });
    expect(redApproval.status).toBe(409);
    expect(await redApproval.json()).toEqual({
      error: 'corner checks are failing: Beeline CI check suite; retry with force=true',
    });
    const forcedApproval = await request('/v1/phone/operations/approveCornerMerge', 'POST', {
      cornerId,
      force: true,
    });
    expect(await forcedApproval.json()).toEqual({
      status: 'merge-requested',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    });
    await webhook('check_suite', 'corner-checks-passed', {
      ...base,
      action: 'completed',
      check_suite: {
        id: 7,
        status: 'completed',
        conclusion: 'success',
        head_branch: 'fm/widget',
        head_sha: '1'.repeat(40),
        app: { name: 'Beeline CI' },
        url: 'https://github.com/owner/widgets/actions/runs/8',
      },
    });
    await webhook('check_run', 'corner-check-passed', {
      ...base,
      action: 'completed',
      check_run: {
        id: 6,
        name: 'typecheck',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/owner/widgets/actions/runs/6',
        check_suite: { head_branch: 'fm/widget', head_sha: '1'.repeat(40) },
      },
    });
    await webhook('status', 'corner-checks-passed', {
      ...base,
      state: 'success',
      sha: '1'.repeat(40),
      target_url: 'https://github.com/owner/widgets/actions/runs/8',
      branches: [{ name: 'fm/widget' }],
    });
    const cornerBeforeMerge = (await (await request(`/v1/phone/rooms/${cornerId}`)).json()) as {
      messages: Array<{ text: string; presentation: string }>;
      cornerLifecycle: {
        checks: string;
        pr: { url: string; mergeability: string };
        checksSummary: { failing: string[]; checks: Array<{ name: string; status: string }> };
      };
    };
    expect(cornerBeforeMerge.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          presentation: 'system',
          text: 'GitHub opened a pull request Ship the widget',
          systemEvent: {
            subject: { kind: 'github', name: 'GitHub' },
            verb: 'opened a pull request',
            object: { text: 'Ship the widget', url: 'https://github.com/owner/widgets/pull/42' },
          },
        }),
        expect.objectContaining({
          text: expect.stringMatching(/^GitHub pushed 2 commits to fm\/widget · at [0-9a-f]{12}$/),
        }),
        expect.objectContaining({
          text: 'GitHub started a check typecheck',
          systemEvent: expect.objectContaining({ verb: 'started a check' }),
        }),
        expect.objectContaining({ text: 'GitHub failed a check Beeline CI check suite' }),
        expect.objectContaining({
          text: 'GitHub passed a check Beeline CI check suite',
          systemEvent: expect.objectContaining({
            verb: 'passed a check',
            object: expect.objectContaining({ text: 'Beeline CI check suite' }),
          }),
        }),
      ]),
    );
    // No system line carries a colon, an em dash, a trailing period, or a URL.
    for (const message of cornerBeforeMerge.messages.filter((m) => m.presentation === 'system')) {
      expect(message.text).not.toMatch(/[:—]|\.$|https?:\/\//);
    }
    expect(cornerBeforeMerge.cornerLifecycle).toMatchObject({
      checks: 'passing',
      pr: { url: 'https://github.com/owner/widgets/pull/42', mergeability: 'clean' },
      checksSummary: {
        failing: [],
        checks: expect.arrayContaining([
          expect.objectContaining({ name: 'Beeline CI check suite', status: 'passed' }),
        ]),
      },
    });
    expect(
      (
        await daemonOperation('postCornerRemoteState', {
          cornerId,
          branch: 'fm/widget',
          state: 'working',
          checks: 'unknown',
        })
      ).status,
    ).toBe(200);
    const cornerAfterDaemonRestart = (await (
      await request(`/v1/phone/rooms/${cornerId}`)
    ).json()) as {
      cornerLifecycle: {
        lifecycle: string;
        checks: string;
        pr?: { url: string; mergeability?: string };
        checksSummary?: { status: string; checks: Array<{ name: string; status: string }> };
      };
    };
    expect(cornerAfterDaemonRestart.cornerLifecycle).toMatchObject({
      lifecycle: 'in-review',
      checks: 'passing',
      pr: { url: 'https://github.com/owner/widgets/pull/42', mergeability: 'clean' },
      checksSummary: {
        status: 'passing',
        checks: expect.arrayContaining([
          expect.objectContaining({ name: 'Beeline CI check suite', status: 'passed' }),
        ]),
      },
    });
    // Corners hit by the pre-fix restart have already lost their PR payload. The next
    // pull-request webhook must recover them by their durable feature branch.
    await database.query(`UPDATE corner_facts SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
      cornerId,
      JSON.stringify({ branch: 'fm/widget', checks: 'unknown', lifecycle: 'working' }),
    ]);
    await webhook('pull_request', 'corner-pr-recovery', {
      ...base,
      action: 'synchronize',
      pull_request: {
        number: 42,
        title: 'Ship the widget',
        html_url: 'https://github.com/owner/widgets/pull/42',
        head: { ref: 'fm/widget', sha: '1'.repeat(40) },
        base: { ref: 'main' },
        mergeable_state: 'clean',
        merged: false,
      },
    });
    const cornerAfterWebhookRecovery = (await (
      await request(`/v1/phone/rooms/${cornerId}`)
    ).json()) as {
      cornerLifecycle: { lifecycle: string; pr?: { url: string; mergeability?: string } };
    };
    expect(cornerAfterWebhookRecovery.cornerLifecycle).toMatchObject({
      lifecycle: 'in-review',
      pr: { url: 'https://github.com/owner/widgets/pull/42', mergeability: 'clean' },
    });
    const cornerAgentInbox = await daemonOperation('getRoomInbox', {
      roomId: cornerId,
      limit: 200,
    });
    expect(await cornerAgentInbox.json()).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            type: 'system',
            body: 'GitHub passed a check Beeline CI check suite',
          }),
        ]),
      }),
    );

    const duplicateApproval = await request('/v1/phone/operations/approveCornerMerge', 'POST', {
      cornerId,
    });
    expect(await duplicateApproval.json()).toEqual({
      status: 'already-requested',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    });
    expect(githubApp.mergePullRequest).toHaveBeenCalledOnce();

    expect(
      (
        await webhook('pull_request', 'corner-pr-merged', {
          ...base,
          action: 'closed',
          pull_request: {
            number: 42,
            title: 'Ship the widget',
            html_url: 'https://github.com/owner/widgets/pull/42',
            head: { ref: 'fm/widget', sha: '1'.repeat(40) },
            base: { ref: 'main' },
            merged: true,
            merged_at: '2026-09-02T14:00:00Z',
            merged_by: { login: 'owner' },
            commits: 3,
            changed_files: 5,
          },
        })
      ).status,
    ).toBe(202);
    const close = await daemonOperation('getCornerCloseRequests', { cornerId });
    expect(close.status).toBe(200);
    expect(await close.json()).toEqual(
      expect.objectContaining({
        closeRequested: true,
        items: expect.arrayContaining([
          expect.objectContaining({
            body: 'owner merged Ship the widget',
            systemEvent: expect.objectContaining({
              subject: { kind: 'github', name: 'owner' },
              verb: 'merged',
              object: { text: 'Ship the widget', url: 'https://github.com/owner/widgets/pull/42' },
            }),
          }),
        ]),
      }),
    );
    const parent = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{
        text: string;
        presentation: string;
        daemonFact?: {
          type: string;
          cornerId: string;
          name?: string;
          objective: string;
          outcome?: string;
          pullRequest?: { number?: number; title?: string; url: string; targetBranch?: string };
        };
      }>;
      corners: Array<{ corner: { id: string } }>;
    };
    expect(parent.messages).toContainEqual(
      expect.objectContaining({
        presentation: 'card',
        // The card keeps its component; its header sentence is the one grammar.
        text: 'owner merged Ship the widget',
        systemEvent: {
          subject: { kind: 'github', name: 'owner' },
          verb: 'merged',
          kind: 'merged',
          object: { text: 'Ship the widget', url: 'https://github.com/owner/widgets/pull/42' },
        },
        daemonFact: {
          type: 'corner-complete',
          cornerId,
          name: 'Ship widget',
          objective: 'Ship widget',
          outcome: 'landed',
          pullRequest: {
            number: 42,
            title: 'Ship the widget',
            url: 'https://github.com/owner/widgets/pull/42',
            targetBranch: 'main',
          },
        },
      }),
    );
    expect(parent.corners.map((item) => item.corner.id)).not.toContain(cornerId);
    expect(
      (
        await database.query<{ archived: boolean }>(
          `SELECT archived_at IS NOT NULL archived FROM rooms WHERE id=$1`,
          [cornerId],
        )
      ).rows[0]?.archived,
    ).toBe(true);
    expect(
      (
        await database.query<{ approved_by: string; force: boolean }>(
          `SELECT approved_by,force FROM corner_merge_approvals WHERE corner_id=$1`,
          [cornerId],
        )
      ).rows[0],
    ).toEqual({ approved_by: HUMAN, force: true });
    const approvalAfterMerge = await request('/v1/phone/operations/approveCornerMerge', 'POST', {
      cornerId,
    });
    expect(await approvalAfterMerge.json()).toEqual({
      status: 'already-merged',
      pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
    });
    expect(githubApp.deleteBranch).toHaveBeenCalledWith(77, 101, 'owner/widgets', 'fm/widget');
  });

  it('serves a corner only to its opening agent and rejects another member’s corner writes', async () => {
    const peer = 'c'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    const exchange = await auth.createDaemonExchange(peer);
    const peerToken = (await auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'single-owner-corner',
      name: 'Bee corner',
      objective: 'Only Bee serves this',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };

    const ownerCorners = await daemonOperation('listRoomCorners', { roomId: ROOM });
    expect(await ownerCorners.json()).toEqual({
      corners: [
        expect.objectContaining({
          cornerId,
          parentRoomId: ROOM,
          createdBy: AGENT,
          archived: false,
        }),
      ],
    });
    const peerCorners = await daemonOperation('listRoomCorners', { roomId: ROOM }, peerToken);
    expect(await peerCorners.json()).toEqual({ corners: [] });

    const rejectedState = await daemonOperation(
      'postCornerRemoteState',
      { cornerId, branch: 'feature/peer', state: 'working', checks: 'unknown' },
      peerToken,
    );
    expect(rejectedState.status).toBe(403);
    const rejectedTurn = await daemonOperation(
      'postAgentTurnReceipt',
      { roomId: cornerId, agentId: peer, requestId: 'peer-turn', status: 'working' },
      peerToken,
    );
    expect(rejectedTurn.status).toBe(403);

    const phoneCorners = await request(`/v1/phone/rooms/${ROOM}/corners`);
    expect(await phoneCorners.json()).toEqual(
      expect.objectContaining({
        corners: [expect.objectContaining({ agent: expect.objectContaining({ pubkey: AGENT }) })],
      }),
    );
  });

  it('derives an owner for a legacy corner from its first agent-authored message', async () => {
    const legacyCornerId = '33333333-3333-4333-8333-333333333333';
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Legacy corner')`,
      [legacyCornerId, WORKSPACE, ROOM, HUMAN],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`,
      [WORKSPACE, legacyCornerId, HUMAN, AGENT],
    );
    await database.query(
      `INSERT INTO corner_facts(corner_id,objective) VALUES($1,'Legacy objective')`,
      [legacyCornerId],
    );
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'Legacy objective','message')`,
      ['f'.repeat(64), legacyCornerId, AGENT],
    );
    await migrate(database);

    const corners = await daemonOperation('listRoomCorners', { roomId: ROOM });
    expect(await corners.json()).toEqual({
      corners: [
        expect.objectContaining({ cornerId: legacyCornerId, createdBy: AGENT, archived: false }),
      ],
    });
    expect(
      (
        await database.query<{ owner_agent_id: string }>(
          `SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1`,
          [legacyCornerId],
        )
      ).rows[0],
    ).toEqual({ owner_agent_id: AGENT });
  });

  it('caps unthreaded agent-to-agent wake-ups and lets a new human message reset the chain', async () => {
    const peer = 'e'.repeat(64);
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    const peerExchange = await auth.createDaemonExchange(peer);
    const peerToken = (await auth.exchangeDaemonToken(peerExchange.exchangeToken))!.daemonToken;
    const humanMessage = '9'.repeat(64);
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: humanMessage,
      text: 'Agents, work this through.',
      mentions: [AGENT],
    });
    let previous = humanMessage;
    let speaker = AGENT;
    let speakerToken = daemonToken;
    let target = peer;
    let targetToken = peerToken;
    for (let turn = 1; turn <= 4; turn++) {
      const response = await daemonOperation(
        'postRoomMessage',
        {
          roomId: ROOM,
          requestId: humanMessage,
          text: `Agent turn ${turn}`,
          mentionIds: [target],
          triggerMessageId: previous,
        },
        speakerToken,
      );
      expect(response.status).toBe(200);
      previous = ((await response.json()) as { id: string }).id;
      const ownInbox = await daemonOperation('getRoomInbox', { roomId: ROOM }, speakerToken);
      expect(
        ((await ownInbox.json()) as { items: Array<{ id: string }> }).items.some(
          (item) => item.id === previous,
        ),
      ).toBe(false);
      const peerInbox = await daemonOperation('getRoomInbox', { roomId: ROOM }, targetToken);
      const peerItems = (await peerInbox.json()) as {
        items: Array<{ id: string; mentionIds: string[] }>;
      };
      if (turn < 4)
        expect(peerItems.items).toContainEqual(
          expect.objectContaining({ id: previous, mentionIds: [target] }),
        );
      else {
        expect(peerItems.items).not.toContainEqual(expect.objectContaining({ id: previous }));
        expect(peerItems.items.map((item) => item.id)).not.toContain(previous);
      }
      [speaker, target] = [target, speaker];
      [speakerToken, targetToken] = [targetToken, speakerToken];
    }
    const stored = await database.query<{
      mention_ids: string[];
      agent_hop_count: number;
      note_count: string;
    }>(
      `SELECT message.mention_ids,message.agent_hop_count,
         (SELECT count(*)::text FROM messages note
          WHERE note.room_id=message.room_id AND note.card_type='agent-hop-cap') note_count
       FROM messages message WHERE message.id=$1`,
      [previous],
    );
    expect(stored.rows[0]).toEqual({ mention_ids: [], agent_hop_count: 3, note_count: '0' });

    const withheldTrigger = await daemonOperation(
      'postRoomMessage',
      {
        roomId: ROOM,
        triggerMessageId: previous,
        text: 'This was not delivered to me.',
        mentionIds: [peer],
      },
      daemonToken,
    );
    expect(withheldTrigger.status).toBe(400);
    await expect(withheldTrigger.json()).resolves.toEqual({
      error: 'turn trigger is invalid for agent',
    });
    expect(
      (
        await database.query<{ count: string }>(
          `SELECT count(*)::text FROM messages WHERE text='This was not delivered to me.'`,
        )
      ).rows[0],
    ).toEqual({ count: '0' });

    const resetMessage = '8'.repeat(64);
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: resetMessage,
      text: 'New human direction.',
      mentions: [AGENT],
    });
    const reset = await daemonOperation(
      'postRoomMessage',
      {
        roomId: ROOM,
        requestId: resetMessage,
        triggerMessageId: resetMessage,
        text: 'Fresh response.',
        mentionIds: [peer],
      },
      daemonToken,
    );
    expect(reset.status).toBe(200);
    const resetId = ((await reset.json()) as { id: string }).id;
    const resetInbox = await daemonOperation('getRoomInbox', { roomId: ROOM }, peerToken);
    expect(
      ((await resetInbox.json()) as { items: Array<{ id: string; mentionIds: string[] }> }).items,
    ).toContainEqual(expect.objectContaining({ id: resetId, mentionIds: [peer] }));
    expect(
      (
        await database.query<{ agent_hop_count: number }>(
          `SELECT agent_hop_count FROM messages WHERE id=$1`,
          [resetId],
        )
      ).rows[0],
    ).toEqual({ agent_hop_count: 0 });
  });

  it('settles a working turn when its final untagged agent reply is stored', async () => {
    const requestId = '7'.repeat(64);
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: 'Please answer.',
      mentions: [AGENT],
    });
    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
    });
    const finalReply = await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId,
      triggerMessageId: requestId,
      text: 'Done.',
      mentionIds: [],
    });
    expect(finalReply.status).toBe(200);
    expect(
      (await new PhoneService(database, origin).readRoom(ROOM, HUMAN))?.latestAgentTurns,
    ).toContainEqual(
      expect.objectContaining({ requestId, agentPubkey: AGENT, status: 'complete' }),
    );
  });

  it('keeps working receipts fresh without letting heartbeats resurrect terminal turns', async () => {
    const requestId = '6'.repeat(64);
    const generationId = `${AGENT}:${ROOM}`;
    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
      generationId,
    });
    await database.query(
      `UPDATE agent_turns SET created_at=now()-interval '2 minutes'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );

    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
      generationId,
      heartbeat: true,
    });
    const fresh = await database.query<{ status: string; age_seconds: number }>(
      `SELECT status,extract(epoch FROM now()-created_at)::float age_seconds
       FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    expect(fresh.rows[0]?.status).toBe('working');
    expect(fresh.rows[0]?.age_seconds).toBeLessThan(5);

    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'complete',
      generationId,
    });
    await database.query(
      `UPDATE agent_turns SET created_at=now()-interval '1 minute'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
      generationId,
      heartbeat: true,
    });
    const terminal = await database.query<{ status: string; old: boolean }>(
      `SELECT status,created_at<now()-interval '30 seconds' old
       FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    expect(terminal.rows[0]).toEqual({ status: 'complete', old: true });

    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId: 'heartbeat-without-turn',
      status: 'working',
      generationId,
      heartbeat: true,
    });
    expect(
      await database.query(`SELECT 1 FROM agent_turns WHERE request_id='heartbeat-without-turn'`),
    ).toHaveProperty('rowCount', 0);
  });

  it('refreshes a working receipt from activity but leaves a terminal receipt untouched', async () => {
    const requestId = '5'.repeat(64);
    await daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
    await database.query(
      `UPDATE agent_turns SET created_at=now()-interval '2 minutes'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    await daemonOperation('postAgentActivity', {
      roomId: ROOM,
      requestId,
      activity: [{ kind: 'thinking', title: 'Still working', status: 'in_progress' }],
    });
    expect(
      (
        await database.query<{ fresh: boolean }>(
          `SELECT created_at>now()-interval '5 seconds' fresh FROM agent_turns
           WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [ROOM, requestId, AGENT],
        )
      ).rows[0],
    ).toEqual({ fresh: true });

    await daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'failed' });
    await database.query(
      `UPDATE agent_turns SET created_at=now()-interval '1 minute'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    await daemonOperation('postAgentActivity', {
      roomId: ROOM,
      requestId,
      activity: [{ kind: 'thinking', title: 'Late activity', status: 'complete' }],
    });
    expect(
      (
        await database.query<{ status: string; old: boolean }>(
          `SELECT status,created_at<now()-interval '30 seconds' old FROM agent_turns
           WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [ROOM, requestId, AGENT],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', old: true });
  });

  it('inscribes a failed turn as one system line, coalesces its retry, and settles it on success', async () => {
    const requestId = '8'.repeat(64);
    await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: "@bee what's up",
      mentions: [AGENT],
    });
    await daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
    const failed = await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'failed',
      reason: 'provider error 429 concurrency_limit',
    });
    expect(failed.status).toBe(200);
    expect(
      (
        await database.query(
          `SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
          [ROOM, requestId],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', failure_reason: 'provider error 429 concurrency_limit' });
    const lines = () =>
      database.query<{
        id: string;
        author_id: string;
        text: string;
        mention_ids: string[];
        card: Record<string, string>;
      }>(
        `SELECT id,author_id,text,mention_ids,card FROM messages WHERE room_id=$1 AND presentation='system' AND card_type='turn-failed'`,
        [ROOM],
      );
    const first = (await lines()).rows;
    expect(first).toEqual([
      expect.objectContaining({
        author_id: AGENT,
        text: 'Bee could not answer · provider error 429 concurrency_limit',
        mention_ids: [],
        card: { requestId, agentId: AGENT, state: 'failed' },
      }),
    ]);
    // A retry of the same request within ten minutes updates the same line in place.
    const stack = `ACP session timed out after 120s\n    at AcpClient.request (/opt/acp.js:1:1)`;
    await daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'failed',
      reason: `${stack} ${'x'.repeat(400)}`,
    });
    const retried = (await lines()).rows;
    expect(retried).toHaveLength(1);
    expect(retried[0]!.id).toBe(first[0]!.id);
    expect(
      retried[0]!.text.startsWith(
        'Bee could not answer · ACP session timed out after 120s at AcpClient.request',
      ),
    ).toBe(true);
    expect(retried[0]!.text.length).toBeLessThanOrEqual('Bee could not answer · '.length + 200);
    // A later durable reply settles the line instead of leaving a stale failure stamped in the transcript.
    await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId,
      triggerMessageId: requestId,
      text: 'Not much!',
      mentionIds: [],
    });
    expect((await lines()).rows).toEqual([
      expect.objectContaining({
        id: first[0]!.id,
        text: 'Bee answered after a retry',
        card: { requestId, agentId: AGENT, state: 'recovered' },
      }),
    ]);
    const room = (await new PhoneService(database, origin).readRoom(ROOM, HUMAN))!;
    expect(room.messages).toContainEqual(
      expect.objectContaining({
        id: first[0]!.id,
        presentation: 'system',
        text: 'Bee answered after a retry',
      }),
    );
    expect(room.latestAgentTurns).toContainEqual(
      expect.objectContaining({ requestId, agentPubkey: AGENT, status: 'complete' }),
    );
    // A failure with no human trigger (an unknown request id) carries no Room line.
    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId: '9'.repeat(64),
      status: 'failed',
      reason: 'ACP agent exited (code 1)',
    });
    expect((await lines()).rows).toHaveLength(1);
    // A failure older than the coalescing window starts a fresh line.
    await database.query(`UPDATE messages SET created_at=now()-interval '11 minutes' WHERE id=$1`, [
      first[0]!.id,
    ]);
    await database.query(`UPDATE messages SET card=card||'{"state":"failed"}'::jsonb WHERE id=$1`, [
      first[0]!.id,
    ]);
    await daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'failed',
      reason: 'ACP agent exited (code 1)',
    });
    expect((await lines()).rows).toHaveLength(2);
  });

  it('never 503s the repo picker when GitHub refresh fails and flags reconnect', async () => {
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,account_avatar_url,repository_selection,status) VALUES(77,$1,'42','owner','User','https://avatars.test/owner','selected','active')`,
      [HUMAN],
    );
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','trunk')`,
    );
    vi.spyOn(githubOperations, 'refresh').mockRejectedValue(
      new Error('GitHub user installations failed: HTTP 401'),
    );
    const listed = await request('/v1/phone/operations/listGitHubRepositories', 'POST', {
      refresh: true,
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      installed: true,
      githubReconnectNeeded: true,
      repositories: [
        { id: 101, fullName: 'owner/widgets', installationId: 77, defaultBranch: 'trunk' },
      ],
    });
  });

  it('keeps the phone GitHub repository contract aligned through the real HTTP surface', async () => {
    await database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,account_avatar_url,repository_selection,status) VALUES(77,$1,'42','owner','User','https://avatars.test/owner','selected','active')`,
      [HUMAN],
    );
    await database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','trunk')`,
    );

    const listed = await request('/v1/phone/operations/listGitHubRepositories', 'POST', {});
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      installed: true,
      installations: [
        {
          installationId: 77,
          accountId: '42',
          accountLogin: 'owner',
          accountType: 'User',
          accountAvatarUrl: 'https://avatars.test/owner',
          repositorySelection: 'selected',
          status: 'active',
          repositoryCount: 1,
          manageUrl: 'https://github.com/settings/installations/77',
        },
      ],
      repositories: [
        { id: 101, fullName: 'owner/widgets', installationId: 77, defaultBranch: 'trunk' },
      ],
    });

    const begun = await request('/v1/phone/operations/beginGitHubInstallation', 'POST', {
      redirectUri: 'beeline://buzz/github-installation',
    });
    expect(begun.status).toBe(200);
    expect(await begun.json()).toEqual({
      url: 'https://github.com/apps/beeline-test/installations/new?state=server-state',
    });

    const created = await request('/v1/phone/operations/createGitHubRepository', 'POST', {
      installationId: 77,
      name: 'new-repo',
      private: true,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      id: 102,
      fullName: 'owner/new-repo',
      installationId: 77,
      defaultBranch: 'main',
    });

    const linked = await request('/v1/phone/operations/setRoomRepository', 'POST', {
      roomId: ROOM,
      key: 'github:101',
      name: 'owner/widgets',
      remote: 'git://github.com/owner/widgets',
      targetBranch: 'trunk',
      githubInstallationId: 77,
    });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toEqual(
      expect.objectContaining({
        channelId: ROOM,
        binding: {
          key: 'github:101',
          name: 'owner/widgets',
          remote: 'git://github.com/owner/widgets',
          localOnly: false,
          githubInstallationId: 77,
        },
        targetBranch: 'trunk',
        githubEventsEnabled: true,
        source: 'config',
      }),
    );

    const targeted = await request('/v1/phone/operations/setRoomTargetBranch', 'POST', {
      roomId: ROOM,
      targetBranch: 'release',
    });
    expect(targeted.status).toBe(200);
    expect((await targeted.json()).targetBranch).toBe('release');

    const events = await request('/v1/phone/operations/setRoomGitHubEvents', 'POST', {
      roomId: ROOM,
      enabled: false,
    });
    expect(events.status).toBe(200);
    expect((await events.json()).githubEventsEnabled).toBe(false);

    const room = await request(`/v1/phone/rooms/${ROOM}`);
    expect((await room.json()).repository).toEqual(
      expect.objectContaining({
        key: 'github:101',
        name: 'owner/widgets',
        targetBranch: 'release',
        githubEventsEnabled: false,
      }),
    );

    const invalid = await request('/v1/phone/operations/setRoomRepository', 'POST', {
      roomId: ROOM,
      key: 'github:999',
      name: 'owner/not-installed',
      remote: 'git://github.com/owner/not-installed',
      targetBranch: 'main',
      githubInstallationId: 77,
    });
    expect(invalid.status).toBe(403);
    expect(await invalid.json()).toEqual({
      error: 'GitHub repository access denied',
    });
  });

  it('completes the GitHub App callback on the monolith route', async () => {
    const response = await fetch(
      `${origin}/v1/github/install/callback?state=server-state&installation_id=77`,
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('beeline://buzz/github-installation?installed=1');
    expect(completeInstallation).toHaveBeenCalledWith('server-state', 77);
  });
  it('stores a model-written human mention as a real mention and pushes it', async () => {
    const send = vi.fn(async () => undefined);
    const loop = new PushDeliveryLoop(database, { send });
    await loop.runOnce(); // establish the durable floor before the new events
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('owner-device-token-12345678901234567890',$1,'ios','physical')`,
      [HUMAN],
    );
    const sent = await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '5'.repeat(64),
      text: 'Proofbot, list the root files.',
      mentions: [AGENT],
    });
    expect(sent.status).toBe(200);
    const unknown = 'f'.repeat(64);
    const reply = await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'human-mention-turn',
      triggerMessageId: '5'.repeat(64),
      text: '@Owner Repository root files: README.md',
      mentionIds: [HUMAN, unknown],
    });
    expect(reply.status).toBe(200);
    const stored = await database.query<{ mention_ids: string[] }>(
      `SELECT mention_ids FROM messages WHERE room_id=$1 AND author_id=$2 AND text LIKE '@Owner%'`,
      [ROOM, AGENT],
    );
    expect(stored.rows).toHaveLength(1);
    // The human member is a real mention; an unknown name stays plain text.
    expect(stored.rows[0]!.mention_ids).toEqual([HUMAN]);
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'owner-device-token-12345678901234567890',
      expect.objectContaining({
        roomId: ROOM,
        text: 'Bee: @Owner Repository root files: README.md',
      }),
    );
  });

  it('delivers at most one human mention per agent turn', async () => {
    const human2 = createHash('sha256').update('github:peer').digest('hex');
    await database.query(
      `INSERT INTO identities(id,kind,name,github_subject) VALUES($1,'human','Peer','peer')`,
      [human2],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, ROOM, human2],
    );
    const sent = await operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '5'.repeat(64),
      text: 'Bee, loop in whoever else decides.',
      mentions: [AGENT],
    });
    expect(sent.status).toBe(200);
    const reply = await daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'two-human-tags-turn',
      triggerMessageId: '5'.repeat(64),
      text: '@Owner @Peer both need a decision, ideally just one of you.',
      mentionIds: [HUMAN, human2],
    });
    expect(reply.status).toBe(200);
    const stored = await database.query<{ mention_ids: string[] }>(
      `SELECT mention_ids FROM messages WHERE room_id=$1 AND author_id=$2`,
      [ROOM, AGENT],
    );
    expect(stored.rows).toHaveLength(1);
    // Only the first human tag is delivered; the second stays plain text.
    expect(stored.rows[0]!.mention_ids).toEqual([HUMAN]);
  });

  it("reports a corner's working receipt on its parent Room row, and stops at archive", async () => {
    // The Room row's own state word is the turn receipt, the corner's
    // included — a helper working in a corner is work happening in that Room,
    // and the label must not wait for the corner to say so in the parent.
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-room-label',
      name: 'Ship the widget',
      objective: 'Ship the widget end to end',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    const roomRow = async () =>
      (
        (await (await request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{ room: { id: string }; agentState?: string }>;
        }
      ).chats.find((chat) => chat.room.id === ROOM)!;
    expect((await roomRow()).agentState).toBeUndefined();

    await daemonOperation('postAgentTurnReceipt', {
      roomId: cornerId,
      requestId: '4'.repeat(64),
      status: 'working',
    });
    expect((await roomRow()).agentState).toBe('working');

    // An archived corner is finished work: whatever its last receipt says, it
    // no longer speaks for its Room, exactly as it no longer counts in it.
    await database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    expect((await roomRow()).agentState).toBeUndefined();
  });

  it('delivers no human mention on a corner-complete post', async () => {
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-complete-tag-turn',
      name: 'Ship the widget',
      objective: 'Ship the widget end to end',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const reply = await daemonOperation('postRoomMessage', {
      roomId: cornerId,
      requestId: 'corner-complete-tag-done',
      text: '@Owner all done, merging now.',
      mentionIds: [HUMAN],
    });
    expect(reply.status).toBe(200);
    const stored = await database.query<{ mention_ids: string[] }>(
      `SELECT mention_ids FROM messages WHERE room_id=$1 AND author_id=$2`,
      [cornerId, AGENT],
    );
    expect(stored.rows).toHaveLength(1);
    // The merge summary card and its push cover corner completion; a human tag
    // on the settling corner post stays plain text.
    expect(stored.rows[0]!.mention_ids).toEqual([]);
  });

  it('posts one corner-open daemon-fact card and pushes it to human members', async () => {
    const send = vi.fn(async () => undefined);
    const loop = new PushDeliveryLoop(database, { send });
    await loop.runOnce(); // establish the durable floor before the new events
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('owner-device-token-12345678901234567890',$1,'ios','physical')`,
      [HUMAN],
    );
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-open-card',
      name: 'Ship the widget',
      objective: 'Ship the widget end to end',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const cards = await database.query<{ author_id: string; card: Record<string, unknown> }>(
      `SELECT author_id,card FROM messages WHERE room_id=$1 AND card_type='daemon-fact'`,
      [ROOM],
    );
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]!.author_id).toBe(AGENT);
    expect(cards.rows[0]!.card).toEqual({
      type: 'corner-open',
      cornerId,
      name: 'Ship the widget',
      objective: 'Ship the widget end to end',
    });
    // The NAME titles the corner; the objective stays the statement of work.
    const corner = await database.query<{ name: string; objective: string }>(
      `SELECT r.name,cf.objective FROM rooms r JOIN corner_facts cf ON cf.corner_id=r.id WHERE r.id=$1`,
      [cornerId],
    );
    expect(corner.rows[0]).toEqual({
      name: 'Ship the widget',
      objective: 'Ship the widget end to end',
    });
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'owner-device-token-12345678901234567890',
      expect.objectContaining({ text: 'Bee opened a corner: Ship the widget' }),
    );
  });

  it('rejects an open-corner objective longer than 24 words, naming the count', async () => {
    const response = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-objective-too-long',
      name: 'Too long',
      objective: Array.from({ length: 25 }, (_, index) => `word${index + 1}`).join(' '),
    });
    expect(response.status).toBe(503);
    // The refusal names the limit AND what arrived: nobody could see why the
    // old catch-all sentence fired, and the same turn failed twice (C90).
    expect(await response.json()).toEqual({
      error: 'the objective is 25 words; the limit is 24',
    });
    const corners = await database.query(
      `SELECT id FROM rooms WHERE parent_id=$1 AND name LIKE 'word1 %'`,
      [ROOM],
    );
    expect(corners.rows).toEqual([]);
  });

  it('requires a corner name of at most three words and normalises an untidy one', async () => {
    const missing = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-name-missing',
      objective: 'Ship the widget',
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'the name is required; give a title of at most 3 words',
    });

    const tooLong = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-name-too-long',
      name: 'far too many words here',
      objective: 'Ship the widget',
    });
    expect(tooLong.status).toBe(503);
    expect(await tooLong.json()).toEqual({ error: 'the name is 5 words; the limit is 3' });

    // Untidy is not wrong: line breaks and double spaces are flattened, and
    // the objective that used to be refused outright now opens a corner.
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-name-normalised',
      name: '  widget \n ledger ',
      objective: 'Ship the widget\nend to  end',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const corner = await database.query<{ name: string; objective: string }>(
      `SELECT r.name,cf.objective FROM rooms r JOIN corner_facts cf ON cf.corner_id=r.id WHERE r.id=$1`,
      [cornerId],
    );
    expect(corner.rows[0]).toEqual({
      name: 'widget ledger',
      objective: 'Ship the widget end to end',
    });
  });

  it('titles a legacy corner card by the first three words of its objective', async () => {
    const created = await daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-legacy-card',
      name: 'Legacy corner',
      objective: 'Rework the room list so every corner row carries a state mark',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    // A card written before the name existed carries only the objective.
    await database.query(
      `UPDATE messages SET card=card-'name' WHERE room_id=$1 AND card->>'cornerId'=$2`,
      [ROOM, cornerId],
    );
    const room = (await new PhoneService(database, origin).readRoom(ROOM, HUMAN))!;
    const card = room.messages.find((message) => message.daemonFact?.cornerId === cornerId);
    expect(card?.daemonFact).toMatchObject({
      name: 'Rework the room',
      objective: 'Rework the room list so every corner row carries a state mark',
    });
  });

  it('reads the selection with an empty catalog, defaults a connect-wizard soul avatarSeed to the pubkey, and passes the detail guard', async () => {
    await database.query(
      `UPDATE agents SET soul=$2::jsonb,selected_model='gpt-5.6' WHERE agent_id=$1`,
      [AGENT, JSON.stringify({ name: 'Scout', instructions: 'Be brisk and kind.' })],
    );
    const phone = new PhoneService(database, 'http://placeholder');
    const view = await phone.readAgent(WORKSPACE, AGENT, HUMAN);
    expect(view?.soul).toEqual({
      name: 'Scout',
      instructions: 'Be brisk and kind.',
      avatarSeed: AGENT,
    });
    // The selection reaches the phone even before the daemon has posted any
    // catalog: the MODEL / EFFORT rows show the current value regardless.
    expect(view?.catalog).toEqual([]);
    expect(view?.selected).toEqual({ model: 'gpt-5.6' });
    // The phone build's surface guard must accept the readAgent output as-is.
    expect(isAgentDetailView(view)).toBe(true);
  });

  it('gates the agent yolo switch to the owner or a workspace admin and posts one system line per Room', async () => {
    const adminToken = await phoneToken('admin');
    const adminId = createHash('sha256').update('github:admin').digest('hex');
    const memberToken = await phoneToken('member');
    const memberId = createHash('sha256').update('github:member').digest('hex');
    await operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: adminId,
      role: 'admin',
    });
    await operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    // A second live Room the agent sits in, plus an archived one it must not touch.
    const second = (await (
      await operation('createRoom', { workspaceId: WORKSPACE, name: 'Second' })
    ).json()) as { id: string };
    await operation('addRoomMember', { roomId: second.id, memberId: AGENT });
    const archived = (await (
      await operation('createRoom', { workspaceId: WORKSPACE, name: 'Archived' })
    ).json()) as { id: string };
    await operation('addRoomMember', { roomId: archived.id, memberId: AGENT });
    await database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [archived.id]);
    // A DM between the admin and the agent: the only Room where a plain line
    // authored by the owner would push to the admin's device.
    const dm = (await (
      await operation(
        'resolveDirectMessage',
        { workspaceId: WORKSPACE, participantId: AGENT },
        adminToken,
      )
    ).json()) as { id: string };
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
       VALUES('yolo-admin-device',$1,'android','physical',now()-interval '1 hour')`,
      [adminId],
    );
    await database.query(
      `INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 hour')
       ON CONFLICT(id) DO UPDATE SET started_at=EXCLUDED.started_at`,
    );

    const before = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as {
      yolo: unknown;
    };
    expect(before.yolo).toEqual({ enabled: false, canChange: true });
    const memberView = (await (
      await request(
        `/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`,
        'GET',
        undefined,
        memberToken,
      )
    ).json()) as { yolo: unknown };
    expect(memberView.yolo).toEqual({ enabled: false, canChange: false });

    // A plain member is refused with the plain message and nothing changes.
    const refused = await operation(
      'updateAgentYolo',
      { workspaceId: WORKSPACE, agentId: AGENT, enabled: true },
      memberToken,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only the agent's owner or a workspace admin can change this",
    });
    expect(
      (await database.query(`SELECT yolo_mode FROM agents WHERE agent_id=$1`, [AGENT])).rows,
    ).toEqual([{ yolo_mode: false }]);

    // The owner (the identity that connected the agent) flips it on.
    const owner = await operation('updateAgentYolo', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      enabled: true,
    });
    expect(owner.status).toBe(204);
    const on = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as {
      yolo: { enabled: boolean; setBy?: { name: string }; setAt?: number; canChange: boolean };
    };
    expect(on.yolo).toEqual({
      enabled: true,
      setBy: { name: 'Owner' },
      setAt: expect.any(Number),
      canChange: true,
    });
    expect(
      isAgentDetailView(
        await (await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)).json(),
      ),
    ).toBe(true);
    const onLines = await database.query<{
      room_id: string;
      text: string;
      presentation: string;
      mention_ids: string[];
      author_id: string;
    }>(
      `SELECT room_id,text,presentation,mention_ids,author_id FROM messages WHERE card_type='agent-yolo' ORDER BY created_at`,
    );
    expect(onLines.rows.map((row) => row.room_id).sort()).toEqual([ROOM, second.id, dm.id].sort());
    for (const row of onLines.rows) {
      expect(row).toEqual(
        expect.objectContaining({
          text: 'Owner turned yolo on for Bee · grant requests are now approved automatically',
          presentation: 'system',
          mention_ids: [],
          author_id: HUMAN,
        }),
      );
    }
    // The line reads as a system notice on the Room surface.
    const room = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ text: string; presentation: string }>;
    };
    expect(room.messages).toContainEqual(
      expect.objectContaining({
        text: 'Owner turned yolo on for Bee · grant requests are now approved automatically',
        presentation: 'system',
      }),
    );
    // Repeating the same state is a no-op: no second line.
    expect(
      (
        await operation('updateAgentYolo', {
          workspaceId: WORKSPACE,
          agentId: AGENT,
          enabled: true,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await database.query(
          `SELECT count(*)::int count FROM messages WHERE card_type='agent-yolo'`,
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
    // The yolo line never pushes, even in the DM where a plain owner line would.
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(database, { send }).runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();

    // The daemon-side agent view carries the flag.
    const configuration = await daemonOperation('getAgentConfiguration', {
      agentId: AGENT,
      roomId: ROOM,
    });
    expect(await configuration.json()).toEqual(expect.objectContaining({ yoloMode: true }));

    // A workspace admin who does not own the agent flips it off.
    const admin = await operation(
      'updateAgentYolo',
      { workspaceId: WORKSPACE, agentId: AGENT, enabled: false },
      adminToken,
    );
    expect(admin.status).toBe(204);
    const off = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as {
      yolo: { enabled: boolean; setBy?: { name: string } };
    };
    expect(off.yolo).toEqual(
      expect.objectContaining({ enabled: false, setBy: { name: 'Admin' }, canChange: true }),
    );
    expect(
      (
        await database.query(
          `SELECT text FROM messages WHERE card_type='agent-yolo' AND room_id=$1 ORDER BY created_at`,
          [ROOM],
        )
      ).rows.map((row) => row.text),
    ).toEqual([
      'Owner turned yolo on for Bee · grant requests are now approved automatically',
      'Admin turned yolo off for Bee · grant requests now ask before running',
    ]);
  });
  it('runs the grant loop: pending card with mention, coalescing, owner ALWAYS/ONCE/NO, gate refusals, listing, revoke', async () => {
    const send = vi.fn(async () => undefined);
    const pushes = new PushDeliveryLoop(database, { send });
    await pushes.runOnce();
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('grant-owner-device-1234567890123456789012',$1,'ios','physical')`,
      [HUMAN],
    );
    const memberToken = await phoneToken('member');
    const memberId = createHash('sha256').update('github:member').digest('hex');
    await operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    await operation('addRoomMember', { roomId: ROOM, memberId });
    // The member asks the agent for a deploy: they are the requester on every row.
    const ask = (await (
      await operation(
        'sendRoomMessage',
        { roomId: ROOM, text: '@Bee deploy the preview', mentions: [AGENT] },
        memberToken,
      )
    ).json()) as { messageId: string };
    expect(ask.messageId).toMatch(/^[0-9a-f]{64}$/);
    // Drain the join note and the ask so the card's push is the only one left.
    await pushes.runOnce();
    send.mockClear();

    // Metacharacters in a command target are refused at request time.
    const refusedTarget = await daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      kind: 'command',
      target: 'fly deploy; rm -rf /',
      reason: 'publish the preview',
    });
    expect(refusedTarget.status).toBe(400);
    expect(((await refusedTarget.json()) as { error: string }).error).toContain(
      'shell metacharacters',
    );

    const first = (await (
      await daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        kind: 'command',
        target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
        reason: 'publish the preview build',
      })
    ).json()) as { grantId: string; status: string; auto: boolean; messageId: string };
    expect(first).toEqual(
      expect.objectContaining({ status: 'pending', auto: false, messageId: expect.any(String) }),
    );
    // A second ask in the same turn joins the same card.
    const second = (await (
      await daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        kind: 'host',
        target: 'api.fly.io',
        reason: 'reach the Fly API',
        ttlSeconds: 3_600,
      })
    ).json()) as { grantId: string; status: string; messageId: string };
    expect(second.messageId).toBe(first.messageId);
    const cards = await database.query<{
      author_id: string;
      text: string;
      mention_ids: string[];
      presentation: string;
      card: {
        grants: Array<Record<string, unknown>>;
        owner: { pubkey: string };
        requester: { pubkey: string };
      };
    }>(
      `SELECT author_id,text,mention_ids,presentation,card FROM messages WHERE card_type='grant-request'`,
    );
    expect(cards.rows).toHaveLength(1);
    const card = cards.rows[0]!;
    expect(card.author_id).toBe(AGENT);
    expect(card.presentation).toBe('card');
    expect(card.mention_ids).toEqual([HUMAN]);
    expect(card.text).toBe(
      'Bee asked Owner for command fly deploy -a beeline-preview --with FLY_TOKEN and host api.fly.io',
    );
    expect(card.card.owner.pubkey).toBe(HUMAN);
    expect(card.card.requester.pubkey).toBe(memberId);
    expect(card.card.grants.map((grant) => grant.status)).toEqual(['pending', 'pending']);
    expect(card.card.grants[1]!.expiresAt).toEqual(expect.any(Number));
    // The card is a tagged mention of the owner, so the ordinary push fires once.
    expect(await pushes.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'grant-owner-device-1234567890123456789012',
      expect.objectContaining({
        text: 'Bee asked Owner for command fly deploy -a beeline-preview --with FLY_TOKEN and host api.fly.io',
      }),
    );
    // The phone reads the card as a validated grantRequest message.
    const room = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(room)).toBe(true);
    const cardMessage = room.messages.find((message) => message.grantRequest);
    expect(cardMessage?.grantRequest?.grants).toHaveLength(2);
    expect(cardMessage?.mentionPubkeys).toEqual([HUMAN]);

    // A plain member cannot answer; nothing changes.
    const refused = await operation(
      'decideAgentGrant',
      { grantId: first.grantId, decision: 'always' },
      memberToken,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only the agent's owner or a workspace admin can change this",
    });
    // Only pending answers are not yet on the profile.
    const profileBefore = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as { grants: unknown[]; canManageGrants: boolean };
    expect(profileBefore.grants).toEqual([]);
    expect(profileBefore.canManageGrants).toBe(true);
    const memberProfile = (await (
      await request(
        `/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`,
        'GET',
        undefined,
        memberToken,
      )
    ).json()) as { canManageGrants: boolean };
    expect(memberProfile.canManageGrants).toBe(false);

    // Owner taps ONCE on the command and NO on the host.
    const once = await operation('decideAgentGrant', { grantId: first.grantId, decision: 'once' });
    expect(once.status).toBe(200);
    expect(await once.json()).toEqual({ grantId: first.grantId, status: 'once', roomId: ROOM });
    const deny = await operation('decideAgentGrant', { grantId: second.grantId, decision: 'deny' });
    expect(await deny.json()).toEqual({ grantId: second.grantId, status: 'denied', roomId: ROOM });
    const again = await operation('decideAgentGrant', {
      grantId: first.grantId,
      decision: 'always',
    });
    expect(again.status).toBe(409);
    // The card settled in place: same message id, per-grant outcome, decider.
    const settled = await database.query<{ card: { grants: Array<Record<string, unknown>> } }>(
      `SELECT card FROM messages WHERE card_type='grant-request'`,
    );
    expect(settled.rows).toHaveLength(1);
    expect(settled.rows[0]!.card.grants.map((grant) => grant.status)).toEqual(['once', 'denied']);
    expect(settled.rows[0]!.card.grants[0]!.decidedBy).toEqual(
      expect.objectContaining({ pubkey: HUMAN, kind: 'human', name: 'Owner' }),
    );
    expect(settled.rows[0]!.card.grants[0]!.decidedAt).toEqual(expect.any(Number));
    // One system line per decision wakes the daemon: it mentions the agent and
    // reaches its inbox; it never pushes to a human.
    const inbox = (await (
      await daemonOperation('getRoomInbox', { roomId: ROOM, after: undefined })
    ).json()) as {
      items: Array<{
        type: string;
        body: string;
        mentionIds: string[];
        authorId: string;
        systemEvent?: unknown;
      }>;
    };
    const decisions = inbox.items.filter(
      (item) => item.type === 'system' && /\b(approved|declined)\b/.test(item.body),
    );
    expect(decisions.map((item) => item.body)).toEqual([
      'Owner approved once command fly deploy -a beeline-preview --with FLY_TOKEN',
      'Owner declined host api.fly.io',
    ]);
    // The decision carries a RESUME kind: it answers the turn already paused on
    // the ask, and the helper must not start a second turn on it.
    expect(decisions.map((item) => item.systemEvent)).toEqual([
      {
        subject: { kind: 'person', id: HUMAN, name: 'Owner' },
        verb: 'approved once',
        kind: 'grant-decided',
        object: { text: 'command fly deploy -a beeline-preview --with FLY_TOKEN' },
      },
      {
        subject: { kind: 'person', id: HUMAN, name: 'Owner' },
        verb: 'declined',
        kind: 'grant-decided',
        object: { text: 'host api.fly.io' },
      },
    ]);
    expect(
      decisions.every((item) => item.mentionIds.includes(AGENT) && item.authorId === HUMAN),
    ).toBe(true);
    expect(await pushes.runOnce()).toBe(0);
    // The phone still validates the settled Room read.
    const settledRoom = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(settledRoom)).toBe(true);
    // C101: the settled request card already carries the answer, so the
    // decision line that wakes the daemon is never ALSO drawn in the Room -
    // one card, not a card plus a redundant restatement of it.
    expect(
      settledRoom.messages.filter((message) => /\b(approved|declined)\b/.test(message.text)),
    ).toEqual([]);
    const settledHistory = (await (
      await request(`/v1/phone/rooms/${ROOM}/history`)
    ).json()) as { messages: Array<{ text: string }> };
    expect(
      settledHistory.messages.filter((message) => /\b(approved|declined)\b/.test(message.text)),
    ).toEqual([]);

    // The daemon sees only the live once rule; consuming it spends it.
    const rules = (await (await daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
      grants: Array<Record<string, unknown>>;
    };
    expect(rules.grants).toEqual([
      expect.objectContaining({
        grantId: first.grantId,
        kind: 'command',
        status: 'once',
        target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
        requestedBy: memberId,
        requestedByName: 'Member',
      }),
    ]);
    expect((await daemonOperation('consumeAgentGrant', { grantId: first.grantId })).status).toBe(
      200,
    );
    expect((await daemonOperation('consumeAgentGrant', { grantId: first.grantId })).status).toBe(
      404,
    );
    expect(
      (
        (await (await daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
          grants: unknown[];
        }
      ).grants,
    ).toEqual([]);

    // ALWAYS makes a durable rule the profile lists and the owner can revoke.
    const third = (await (
      await daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        kind: 'command',
        target: 'npm test',
        reason: 'run the suite',
      })
    ).json()) as { grantId: string; messageId: string };
    expect(third.messageId).not.toBe(first.messageId);
    await operation('decideAgentGrant', { grantId: third.grantId, decision: 'always' });
    const live = (await (await daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
      grants: Array<{ grantId: string; status: string }>;
    };
    expect(live.grants).toEqual([
      expect.objectContaining({ grantId: third.grantId, status: 'approved' }),
    ]);
    const profile = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as {
      grants: Array<{
        grantId: string;
        status: string;
        decidedBy?: { name: string };
        kind: string;
        target: string;
      }>;
    };
    expect(isAgentDetailView(profile)).toBe(true);
    expect(
      profile.grants.map((grant) => [grant.grantId, grant.status, grant.decidedBy?.name]),
    ).toEqual([
      [third.grantId, 'approved', 'Owner'],
      [second.grantId, 'denied', 'Owner'],
      [first.grantId, 'once', 'Owner'],
    ]);
    const memberRevoke = await operation(
      'revokeAgentGrant',
      { grantId: third.grantId },
      memberToken,
    );
    expect(memberRevoke.status).toBe(403);
    const revoked = await operation('revokeAgentGrant', { grantId: third.grantId });
    expect(await revoked.json()).toEqual({
      grantId: third.grantId,
      status: 'revoked',
      roomId: ROOM,
    });
    expect(
      (
        (await (await daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
          grants: unknown[];
        }
      ).grants,
    ).toEqual([]);
    expect((await operation('revokeAgentGrant', { grantId: third.grantId })).status).toBe(409);
  });

  it('approves grants on the spot under yolo with auto=true and no card, except budget which always asks', async () => {
    await database.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [AGENT]);
    const auto = (await (
      await daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        kind: 'secret',
        target: 'FLY_TOKEN',
        reason: 'deploy',
      })
    ).json()) as Record<string, unknown>;
    expect(auto).toEqual({ grantId: expect.any(String), status: 'approved', auto: true });
    const rows = await database.query<{ status: string; auto: boolean; decided_by: string | null }>(
      `SELECT status,auto,decided_by FROM agent_grants WHERE id::text=$1`,
      [auto.grantId as string],
    );
    expect(rows.rows).toEqual([{ status: 'approved', auto: true, decided_by: null }]);
    const lines = await database.query<{
      text: string;
      presentation: string;
      mention_ids: string[];
      author_id: string;
      system_event: unknown;
    }>(
      `SELECT text,presentation,mention_ids,author_id,system_event FROM messages WHERE room_id=$1 AND card_type IN ('grant-request','grant-auto')`,
      [ROOM],
    );
    expect(lines.rows).toEqual([
      {
        text: 'Bee was granted secret FLY_TOKEN · auto-approved under yolo',
        presentation: 'system',
        mention_ids: [],
        author_id: AGENT,
        system_event: {
          subject: { kind: 'agent', id: AGENT, name: 'Bee' },
          verb: 'was granted',
          object: { text: 'secret FLY_TOKEN' },
          consequence: 'auto-approved under yolo',
        },
      },
    ]);
    const profile = (await (
      await request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as { grants: Array<{ auto: boolean; status: string; decidedBy?: unknown }> };
    expect(profile.grants).toEqual([expect.objectContaining({ auto: true, status: 'approved' })]);
    expect(profile.grants[0]!.decidedBy).toBeUndefined();
    // Budget still asks: a pending card, not an auto approval.
    const budget = (await (
      await daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        kind: 'budget',
        target: '$10 of API spend',
        reason: 'more tokens',
      })
    ).json()) as Record<string, unknown>;
    expect(budget).toEqual(
      expect.objectContaining({ status: 'pending', auto: false, messageId: expect.any(String) }),
    );
  });

  /**
   * C94. Goosy took 36 granted commands in a top-level Room and 4 in its corner,
   * every one auto-approved under yolo, and among them wrote into the captain's
   * live project, ran a script it had authored itself, and read the key names
   * out of his environment file. Yolo stays the scope gate — an ordinary command
   * still just runs — and only the two hard stops wait for a person.
   */
  it('keeps the two hard stops off yolo, records what a grant licensed, and binds a script to its bytes', async () => {
    await database.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [AGENT]);
    const ask = async (target: string, extra: Record<string, unknown> = {}) =>
      (await (
        await daemonOperation('requestAgentGrant', {
          roomId: ROOM,
          kind: 'command',
          target,
          reason: 'because',
          ...extra,
        })
      ).json()) as Record<string, unknown>;

    // An ordinary command still rides on yolo, and the line now says what that
    // licensed: in a Room, nothing outside the agent's own scratch.
    const ordinary = await ask('npm test');
    expect(ordinary).toEqual(
      expect.objectContaining({ status: 'approved', auto: true }),
    );
    const autoLine = await database.query<{ text: string; system_event: { consequence: string } }>(
      `SELECT text,system_event FROM messages WHERE card_type='grant-auto' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(autoLine.rows[0]!.text).toBe(
      'Bee was granted command npm test · auto-approved under yolo, reads only outside its scratch',
    );

    // An interpreter and a credential file each ask a person, under yolo.
    const script = 'import os\nos.remove("/tmp/x")\n';
    const interpreter = await ask('python3 fix.py', {
      script: {
        path: 'fix.py',
        sha256: createHash('sha256').update(script).digest('hex'),
        bytes: Buffer.byteLength(script),
        contents: script,
      },
    });
    expect(interpreter).toEqual(
      expect.objectContaining({
        status: 'pending',
        auto: false,
        escalations: ['unseen-script'],
        messageId: expect.any(String),
      }),
    );
    // A named secret is scope, not a stop: yolo already answered that question.
    expect(await ask('fly deploy -a preview --with FLY_TOKEN')).toEqual(
      expect.objectContaining({ status: 'approved', auto: true }),
    );
    const credential = await ask('cut -d= -f1 /home/op/proj/.env');
    expect(credential).toEqual(
      expect.objectContaining({ status: 'pending', auto: false, escalations: ['credential'] }),
    );

    // The card carries the script's contents, so the person approves what runs.
    const card = await database.query<{ card: { grants: Array<Record<string, unknown>> } }>(
      `SELECT card FROM messages WHERE card_type='grant-request' ORDER BY created_at DESC LIMIT 1`,
    );
    const carded = card.rows[0]!.card.grants.find(
      (entry) => entry.grantId === interpreter.grantId,
    ) as { script?: { contents: string; sha256: string } };
    expect(carded.script?.contents).toBe(script);

    // Approved, the binding reaches the runner so it can re-check the bytes.
    await operation('decideAgentGrant', { grantId: interpreter.grantId, decision: 'always' });
    const live = (await (await daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
      grants: Array<{ grantId: string; script?: { sha256: string } }>;
    };
    expect(live.grants.find((entry) => entry.grantId === interpreter.grantId)!.script).toEqual(
      expect.objectContaining({ path: 'fix.py', contents: script }),
    );

    // The hash is the binding, so contents that do not hash to it are refused.
    const lying = await daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      kind: 'command',
      target: 'python3 lie.py',
      reason: 'because',
      script: {
        path: 'lie.py',
        sha256: 'a'.repeat(64),
        bytes: Buffer.byteLength(script),
        contents: script,
      },
    });
    expect(lying.status).toBe(400);
    expect(((await lying.json()) as { error: string }).error).toContain(
      'hash does not match its contents',
    );

    // A script too long to read honestly is refused, never truncated.
    const long = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
    const refused = await daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      kind: 'command',
      target: 'python3 huge.py',
      reason: 'because',
      script: {
        path: 'huge.py',
        sha256: createHash('sha256').update(long).digest('hex'),
        bytes: Buffer.byteLength(long),
        contents: long,
      },
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('will not be truncated');

    // In a corner the same auto line says the opposite, because a corner IS the
    // writable surface.
    const cornerId = '44444444-4444-4444-8444-444444444444';
    await database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`,
      [cornerId, WORKSPACE, ROOM, AGENT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, cornerId, AGENT],
    );
    await daemonOperation('requestAgentGrant', {
      roomId: cornerId,
      kind: 'command',
      target: 'npm test',
      reason: 'because',
    });
    const cornerLine = await database.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND card_type='grant-auto'`,
      [cornerId],
    );
    expect(cornerLine.rows[0]!.text).toBe(
      'Bee was granted command npm test · auto-approved under yolo, free to write the worktree and act on the host',
    );
  });

  const redeemReview = (secret: unknown) =>
    fetch(`${origin}/v1/auth/review/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });

  it('signs the Google Play reviewer in from the link alone, and hides every miss behind a 404', async () => {
    const redeemed = await redeemReview(REVIEW_SECRET);
    expect(redeemed.status).toBe(200);
    const session = (await redeemed.json()) as { identityId: string; accessToken: string };
    expect(session.identityId).toBe(REVIEW_IDENTITY_ID);

    // The session is the same one a GitHub ticket issues: it reads the app.
    const workspaces = await request('/v1/phone/workspaces', 'GET', undefined, session.accessToken);
    expect(workspaces.status).toBe(200);
    const view = (await workspaces.json()) as { workspaces: { name: string }[] };
    expect(view.workspaces.map((workspace) => workspace.name)).toContain('Beeline Welcome');

    // A wrong secret is an ordinary 404 carrying nothing a guesser can use, and
    // it is the same answer for a malformed one and for a missing field.
    for (const wrong of [`${REVIEW_SECRET}x`, 'nope', undefined, 12]) {
      const refused = await redeemReview(wrong);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toEqual({ error: 'not_found' });
    }
  });

  it('refuses the review identity every GitHub and repository write', async () => {
    const session = (await (await redeemReview(REVIEW_SECRET)).json()) as { accessToken: string };
    for (const [name, payload] of [
      ['beginGitHubInstallation', {}],
      ['createGitHubRepository', { installationId: 1, name: 'demo' }],
      ['setRoomRepository', { roomId: ROOM, key: 'github:1', name: 'a/b', remote: 'git://github.com/a/b', targetBranch: 'main' }],
      ['beginGitHubIdentityBind', {}],
      ['adoptGitHubHandle', {}],
    ] as const) {
      const refused = await operation(name, payload, session.accessToken);
      expect([refused.status, name]).toEqual([403, name]);
    }
  });

  it('wakes the agents that subscribed to arrivals in that Room, and no one else', async () => {
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Owl')`,
      [WELCOME_AGENT],
    );
    // The greeter subscribed to `joined` in #welcome; the ordinary Room's agent
    // subscribed to nothing and must not spend a turn on a join it never asked for.
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role,event_subscriptions)
       VALUES($1,NULL,$2,'member','[]'::jsonb),($1,$3,$2,'member','["joined"]'::jsonb)`,
      [DEFAULT_WORKSPACE_ID, WELCOME_AGENT, WELCOME_ROOM_ID],
    );

    await redeemReview(REVIEW_SECRET);
    const joined = await database.query<{
      mention_ids: string[];
      text: string;
      system_event: { verb: string; kind?: string };
    }>(
      `SELECT mention_ids,text,system_event FROM messages
       WHERE room_id=$1 AND card_type='member-joined' AND author_id=$2`,
      [WELCOME_ROOM_ID, REVIEW_IDENTITY_ID],
    );
    expect(joined.rows).toHaveLength(1);
    expect(joined.rows[0]!.system_event.kind).toBe('joined');
    // The sentence a person reads is unchanged by the kind, and it names the
    // newcomer by handle exactly as every other join line does.
    expect(joined.rows[0]!.text).toBe('play-review joined');
    expect(joined.rows[0]!.mention_ids).toEqual([WELCOME_AGENT]);

    const otherRoom = await database.query<{ mention_ids: string[] }>(
      `SELECT mention_ids FROM messages WHERE room_id=$1 AND card_type='member-joined'`,
      [ROOM],
    );
    expect(otherRoom.rows.every((row) => row.mention_ids.length === 0)).toBe(true);
  });

  it('subscribes a connecting agent in the Rooms its claim joined it to', async () => {
    const pairing = (await (
      await operation('createAgentPairingCode', { workspaceId: WORKSPACE })
    ).json()) as { code: string };
    const agentPubkey = 'f'.repeat(64);
    const claim = await phone.claimAgentConnectPairing({
      code: pairing.code,
      agentPubkey,
      model: 'openrouter/z-ai/glm-5.3-flash',
      eventSubscriptions: ['joined', 'not-a-kind'],
    });
    expect(claim.status).toBe('claimed');
    const memberships = await database.query<{
      room_id: string | null;
      event_subscriptions: string[];
    }>(
      `SELECT room_id,event_subscriptions FROM memberships WHERE identity_id=$1
       ORDER BY room_id NULLS FIRST`,
      [agentPubkey],
    );
    // Per Room, never per identity — and a kind the server does not know is dropped.
    expect(memberships.rows).toEqual([
      { room_id: null, event_subscriptions: [] },
      { room_id: ROOM, event_subscriptions: ['joined'] },
    ]);
  });
});

function next(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (value.type !== type) return;
      cleanup();
      resolve(value);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('websocket event timeout'));
    }, 3000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}
