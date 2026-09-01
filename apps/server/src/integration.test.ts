import { createHash, createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { TokenAuth, tokenHash } from './auth.js';
import { PhoneService } from './phone-service.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { PushDeliveryLoop } from './background.js';
import { GitHubOperations } from './github-operations.js';
import type { GitHubAppClient, GitHubOAuthClient } from '@beeline/auth/github';
import { isCommunityInviteToken } from '@beeline/api-contract/phone';

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
    auth = new TokenAuth(database, async (proof) =>
      proof === 'recipient-proof'
        ? { subject: 'recipient', login: 'recipient', name: 'Recipient' }
        : { subject: 'owner', login: 'owner', name: 'Owner' },
    );
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
    sendPushTest = vi.fn(async () => undefined);
    const phone = new PhoneService(database, 'http://placeholder', github, sendPushTest);
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

  it('mints, resolves, and redeems an invite through the phone HTTP surface', async () => {
    const created = await request('/v1/phone/operations/createInvite', 'POST', {
      workspaceId: WORKSPACE,
    });
    expect(created.status).toBe(200);
    const invite = (await created.json()) as { token: string; expiresAt: number };
    expect(isCommunityInviteToken(invite.token)).toBe(true);
    expect(invite.token).toMatch(/^bzi_[0-9a-f]{64}$/);

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
      expiresAt: Math.floor(invite.expiresAt / 1_000),
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
    expect(pairingResult.code).toMatch(/^BUZZ-[0-9A-F]{8}-[0-9A-F]{8}$/);

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
      (
        await database.query(`SELECT 1 FROM push_devices WHERE token=$1`, [token])
      ).rowCount,
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
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Other agent')`,
      [otherAgent],
    );
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [otherAgent, HUMAN]);
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
