import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
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
import { isCommunityInviteToken } from '@beeline/api-contract/phone';
import { createMonolithAuth, type MonolithAuthMount } from './monolith-auth.js';

const HUMAN = createHash('sha256').update('github:owner').digest('hex');
const AGENT = 'b'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
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
    const github = new GitHubOperations(
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
      {} as GitHubAppClient,
      'github-client-secret',
    );
    vi.spyOn(github, 'refresh').mockResolvedValue(undefined);
    vi.spyOn(github, 'beginInstallation').mockResolvedValue({
      url: 'https://github.com/apps/beeline-test/installations/new?state=server-state',
    });
    vi.spyOn(github, 'createRepository').mockImplementation(async (_viewerId, input) => ({
      id: 102,
      fullName: `owner/${input.name}`,
      installationId: input.installationId,
      defaultBranch: 'main',
    }));
    sendPushTest = vi.fn(async () => undefined);
    const phone = new PhoneService(database, 'http://placeholder', github, sendPushTest);
    const live = new LiveHub();
    const daemon = new DaemonService(database, live);
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

  it('emits one workspace push and one Room note across explicit member adds', async () => {
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
    const conversation = await request(
      '/v1/daemon/operations/getRoomConversation',
      'POST',
      { roomId: ROOM },
      daemonToken,
    );
    expect(
      ((await conversation.json()) as { items: Array<{ body: string }> }).items.at(-1)?.body,
    ).toBe('Please inspect this');
    const invalidated = next(socket, 'invalidate');
    const reply = await request(
      '/v1/daemon/operations/postRoomMessage',
      'POST',
      { roomId: ROOM, requestId: messageId, text: 'Done' },
      daemonToken,
    );
    expect(reply.status).toBe(200);
    expect(await invalidated).toEqual(
      expect.objectContaining({ type: 'invalidate', roomId: ROOM, reason: 'message' }),
    );
    const drafted = next(socket, 'draft');
    await request(
      '/v1/daemon/operations/postAgentDraft',
      'POST',
      { agentId: AGENT, roomId: ROOM, turnId: 'turn-1', text: 'Working' },
      daemonToken,
    );
    expect(await drafted).toEqual(expect.objectContaining({ type: 'draft', text: 'Working' }));
    socket.close();
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
        expect.objectContaining({
          agentPubkey: AGENT,
          state: 'ready',
          releaseVersion: 'v0.0.22',
          sourceSha,
        }),
      ],
    });
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
       WHERE author_id=$1 AND card_type='member-joined' ORDER BY room_id`,
      [recipient.identityId],
    );
    expect(notes.rows).toEqual(
      [ROOM, secondRoom.id]
        .sort()
        .map((room_id) => ({ room_id, text: 'recipient joined', presentation: 'system' })),
    );

    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(database, { send });
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
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
    const pairing = (await (
      await operation('createAgentPairingCode', { workspaceId: WORKSPACE })
    ).json()) as { code: string };

    const connectPayload = JSON.stringify({
      pairing_code: pairing.code,
      harness: 'codex',
      model: 'gpt-5.6',
      soul: 'Practical and kind.',
      agent_name: 'Terra',
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
    const grant = connected.body as { agent_pubkey: string };

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
      [ROOM, secondRoom.id]
        .sort()
        .map((room_id) => ({ room_id, text: 'Terra joined', presentation: 'system' })),
    );

    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(database, { send });
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'owner-agent-join-device-token-1234567890',
      expect.objectContaining({ text: 'Terra joined Hive' }),
    );
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

  it('deduplicates push delivery claims in Postgres', async () => {
    await database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment) VALUES('device-token-12345678901234567890',$1,'ios','physical')`,
      [AGENT],
    );
    await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      text: 'push me',
    });
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
