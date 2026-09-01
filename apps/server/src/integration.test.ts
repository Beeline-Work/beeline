import { createHash, createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { PushDeliveryLoop } from './background.js';

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
      const login = proof === 'proof' ? 'owner' : proof;
      return { subject: login, login, name: login[0]!.toUpperCase() + login.slice(1) };
    });
    const phone = new PhoneService(database, 'http://placeholder');
    const live = new LiveHub();
    const daemon = new DaemonService(database, live);
    server = createBeelineServer({
      database,
      auth,
      phone,
      daemon,
      live,
      mediaMaximumBytes: 1024 * 1024,
      github: {
        webhookSecret: 'webhook-secret',
        roomToken: async () => ({ token: 'github-room-token', expiresAt: Date.now() + 60_000 }),
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
    ).toBe(200);
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
    ).toBe(200);
    expect(
      await (await operation('addRoomMember', { roomId: created.id, memberId: aliceId })).json(),
    ).toEqual({ joined: true });
    expect(
      (await request(`/v1/phone/rooms/${created.id}`, 'GET', undefined, aliceToken)).status,
    ).toBe(200);
    expect(
      (await operation('removeRoomMember', { roomId: created.id, memberId: aliceId })).status,
    ).toBe(200);
    await operation('addRoomMember', { roomId: created.id, memberId: aliceId });
    expect((await operation('leaveRoom', { roomId: created.id }, aliceToken)).status).toBe(200);
    expect((await operation('deleteRoom', { roomId: created.id })).status).toBe(200);
    expect((await request(`/v1/phone/rooms/${created.id}`)).status).toBe(404);
    const chats = (await (await request(`/v1/phone/workspaces/${workspaceId}/chats`)).json()) as {
      chats: Array<{ room: { id: string } }>;
    };
    expect(chats.chats.some((chat) => chat.room.id === created.id)).toBe(false);

    expect((await operation('leaveWorkspace', { workspaceId })).status).toBe(200);
    expect((await request(`/v1/phone/workspaces/${workspaceId}`)).status).toBe(404);
  });

  it('serves Welcome and makes person invites reusable, retry-safe, and Room-complete', async () => {
    const aliceToken = await phoneToken('alice');
    const bobToken = await phoneToken('bob');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    const bobId = createHash('sha256').update('github:bob').digest('hex');
    const migratedOwnerWorkspaces = (await (
      await request('/v1/phone/workspaces')
    ).json()) as { workspaces: Array<{ name: string }> };
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

  it('stores and serves media bytes through token auth with the configured cap', async () => {
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
