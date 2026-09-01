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
import { createBeelineServer, DEFAULT_MEDIA_MAXIMUM_BYTES } from './server.js';
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
    auth = new TokenAuth(database, async (proof) => ({
      subject: proof === 'proof' ? 'owner' : proof,
      login: proof === 'proof' ? 'owner' : proof,
      name: proof === 'proof' ? 'Owner' : proof,
    }));
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

  it('keeps same-timestamp message ordering in the server-owned unread mark', async () => {
    await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      messageId: '4'.repeat(64),
      text: 'read first',
    });
    await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      messageId: '5'.repeat(64),
      text: 'same second but later',
    });
    await database.query(
      `UPDATE messages SET created_at='2026-09-01T12:00:00Z' WHERE id=ANY($1::text[])`,
      [['4'.repeat(64), '5'.repeat(64)]],
    );
    expect(
      (
        await request(`/v1/phone/rooms/${ROOM}/read`, 'POST', {
          messageId: '4'.repeat(64),
        })
      ).status,
    ).toBe(204);

    const chats = (await (await request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
      chats: Array<{ unread: boolean; latestMessage?: { id: string } }>;
      watchFilters: Array<{ '#h'?: string[] }>;
    };
    expect(chats.chats[0]).toMatchObject({
      unread: true,
      latestMessage: { id: '5'.repeat(64) },
    });
    expect(chats.watchFilters.flatMap((filter) => filter['#h'] ?? [])).toContain(ROOM);
  });

  it('projects daemon permission requests live and lets the human requester decide', async () => {
    const memberTokens = await auth.exchangeGitHubOidc('member');
    await request('/v1/phone/operations/addWorkspaceMember', 'POST', {
      workspaceId: WORKSPACE,
      memberId: memberTokens.identityId,
      role: 'member',
    });
    await request('/v1/phone/operations/addRoomMember', 'POST', {
      roomId: ROOM,
      memberId: memberTokens.identityId,
    });
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/v1/phone/live`, [
      `bearer.${memberTokens.accessToken}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId: ROOM }));
    await next(socket, 'subscribed');
    const messageInvalidated = next(socket, 'invalidate');
    await request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      messageId: '8'.repeat(64),
      text: 'live for another member',
    });
    expect(await messageInvalidated).toMatchObject({
      type: 'invalidate',
      roomId: ROOM,
      reason: 'phone-write',
    });
    const invalidated = next(socket, 'invalidate');
    const permissionId = 'permission-http-audit';
    const requestId = '8'.repeat(64);
    const requested = await request(
      '/v1/daemon/operations/postPermissionRequest',
      'POST',
      {
        roomId: ROOM,
        principalId: memberTokens.identityId,
        permissionId,
        requestId,
        scope: {
          type: 'operation.execute',
          connectorId: 'edit files',
          target: 'owner/repository',
          payloadDigest: '7'.repeat(64),
        },
      },
      daemonToken,
    );
    expect(requested.status).toBe(200);
    const requestedBody = (await requested.json()) as { id: string };
    expect(await invalidated).toMatchObject({
      type: 'invalidate',
      roomId: ROOM,
      reason: 'permission',
    });
    const retried = await request(
      '/v1/daemon/operations/postPermissionRequest',
      'POST',
      {
        roomId: ROOM,
        principalId: memberTokens.identityId,
        permissionId,
        requestId,
        scope: {
          type: 'operation.execute',
          connectorId: 'edit files',
          target: 'owner/repository',
          payloadDigest: '7'.repeat(64),
        },
      },
      daemonToken,
    );
    expect(await retried.json()).toMatchObject({ id: requestedBody.id });
    const room = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ permission?: Record<string, unknown> }>;
    };
    expect(room.messages.find((message) => message.permission)?.permission).toMatchObject({
      permissionId,
      requestId,
      repository: 'owner/repository',
      status: 'pending',
      requester: { pubkey: memberTokens.identityId, kind: 'human' },
      agent: { pubkey: AGENT, kind: 'agent' },
    });
    const mismatched = await request(
      '/v1/phone/operations/decideWritePermission',
      'POST',
      {
        roomId: ROOM,
        permissionId,
        requestId,
        agentId: AGENT,
        decision: 'allow',
        repository: 'other/repository',
      },
      memberTokens.accessToken,
    );
    expect(mismatched.status).toBe(400);
    const decided = await request(
      '/v1/phone/operations/decideWritePermission',
      'POST',
      {
        roomId: ROOM,
        permissionId,
        requestId,
        agentId: AGENT,
        decision: 'allow',
        repository: 'owner/repository',
      },
      memberTokens.accessToken,
    );
    expect(decided.status).toBe(200);
    const authority = await request(
      '/v1/daemon/operations/getPermissionAuthority',
      'POST',
      { roomId: ROOM, principalId: memberTokens.identityId, permissionId },
      daemonToken,
    );
    expect(await authority.json()).toMatchObject({ status: 'authorized' });
    socket.close();
  });

  it('projects the thinking receipt and digest only for the active agent turn', async () => {
    const requestId = '9'.repeat(64);
    expect(
      (
        await request(
          '/v1/daemon/operations/postAgentTurnReceipt',
          'POST',
          { agentId: AGENT, roomId: ROOM, requestId, status: 'working' },
          daemonToken,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          '/v1/daemon/operations/postAgentActivity',
          'POST',
          {
            agentId: AGENT,
            roomId: ROOM,
            requestId,
            activity: [{ kind: 'summary', title: 'Inspected the requested files' }],
          },
          daemonToken,
        )
      ).status,
    ).toBe(200);
    const working = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      latestAgentTurns: Array<{ requestId: string; status: string }>;
      messages: Array<{ activity?: Array<{ kind: string; title: string }> }>;
    };
    expect(working.latestAgentTurns).toContainEqual(
      expect.objectContaining({ requestId, status: 'working' }),
    );
    expect(working.messages.some((message) => message.activity?.[0]?.kind === 'summary')).toBe(
      true,
    );

    await request(
      '/v1/daemon/operations/postAgentTurnReceipt',
      'POST',
      { agentId: AGENT, roomId: ROOM, requestId, status: 'complete' },
      daemonToken,
    );
    const complete = (await (await request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      latestAgentTurns: Array<{ requestId: string; status: string }>;
      messages: Array<{ activity?: unknown[] }>;
    };
    expect(complete.latestAgentTurns).toContainEqual(
      expect.objectContaining({ requestId, status: 'complete' }),
    );
    expect(complete.messages.some((message) => message.activity)).toBe(false);
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

  it('stores authenticated uploads and serves capability URLs with the configured cap', async () => {
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
    const capabilityRead = await fetch(attachment.url);
    expect(capabilityRead.status).toBe(200);
    expect(capabilityRead.headers.get('cache-control')).toContain('immutable');
    expect(Buffer.from(await capabilityRead.arrayBuffer()).toString()).toBe('png-bytes');
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
