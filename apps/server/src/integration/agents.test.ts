import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import * as serverSentry from '.././sentry.js';
import { claimAgentCommand } from '.././agent-command.js';
import { request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { FACE_NAMES, FACE_SOULS, isFaceId, type FaceId } from '@beeline/api-contract/phone';
import { migrate } from '.././database.js';
import { tokenHash } from '.././auth.js';
import { PhoneService } from '.././phone-service.js';
import { LiveHub } from '.././live.js';
import { PushDeliveryLoop } from '.././background.js';
import { isAgentDetailView, type RoomView } from '@beeline/api-contract/phone';
import { announceAgentLifecycle } from '.././connection-presence.js';
import { monolithFixture, wokenBy, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: agents', () => {
const fixture = monolithFixture();


  it('generates and refines durable avatars through an authorized slash-command turn', async () => {
    const before = await fixture.phone.readAgent(WORKSPACE, AGENT, HUMAN);
    expect(before?.avatarGenerationId).toBeUndefined();
    const drawing = [
      { type: 'path', d: 'M20,30 L50,10 L80,30 L70,80 L50,92 L30,80 Z', fill: 'bone' },
      { type: 'polygon', points: '26,36 44,42 40,49', fill: 'ink' },
      { type: 'polygon', points: '74,36 56,42 60,49', fill: 'ink' },
    ];
    const send = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      text: '@bee /draw-avatar "a star god"',
    });
    expect(send.status).toBe(200);
    const message = (await send.json()) as { messageId: string };
    const command = (
      await fixture.database.query<{ id: string; turn_request_id: string }>(
        'SELECT id,turn_request_id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2',
        [message.messageId, AGENT],
      )
    ).rows[0]!;
    expect(command).toBeDefined();
    const input = {
      roomId: ROOM,
      drawing,
      requestId: command.turn_request_id,
      generationId: 'avatar-turn',
    };
    const call = (body: unknown) =>
      fixture.request('/v1/daemon/operations/postAgentAvatar', 'POST', body, fixture.daemonToken);
    expect((await call(input)).status).not.toBe(200);
    await claimAgentCommand(fixture.database, ROOM, AGENT, command.id, 'avatar-turn');
    expect((await call({ ...input, agentId: 'c'.repeat(64) })).status).not.toBe(200);
    expect((await call({ ...input, drawing: [] })).status).not.toBe(200);
    expect((await fixture.phone.readAgent(WORKSPACE, AGENT, HUMAN))?.avatarGenerationId).toBeUndefined();
    const completionMessages = () =>
      fixture.database.query(
        `SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id
       WHERE r.workspace_id=$1 AND r.direct_participants @> $2::jsonb
         AND m.text LIKE '%Your avatar is ready.%'`,
        [WORKSPACE, JSON.stringify([HUMAN, AGENT])],
      );
    expect((await completionMessages()).rowCount).toBe(0);
    const saved = await call(input);
    expect(saved.status).toBe(200);
    const first = await fixture.phone.readAgent(WORKSPACE, AGENT, HUMAN);
    expect(first?.avatarGenerationId).toBeTruthy();
    expect((await completionMessages()).rowCount).toBe(1);
    expect(isAgentDetailView(first)).toBe(true);
    const url = first!.agent.identity.avatar!;
    expect(url).toContain('/v1/agent-avatars/');
    const picture = await phoneFetch(url);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/webp');
    const bytes = new Uint8Array(await picture.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(100);
    // Corrupt generation leaves both persisted face and success marker untouched.
    expect(
      (await call({ ...input, drawing: [{ type: 'image', href: 'file:///etc/passwd' }] })).status,
    ).not.toBe(200);
    expect((await fixture.phone.readAgent(WORKSPACE, AGENT, HUMAN))?.agent.identity.avatar).toBe(url);
    expect((await fixture.phone.readAgent(WORKSPACE, AGENT, HUMAN))?.avatarGenerationId).toBe(
      first?.avatarGenerationId,
    );
    expect((await completionMessages()).rowCount).toBe(1);
    const soulSave = await fixture.operation('updateAgentSoul', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      name: 'Bee',
      instructions: 'A star god',
      avatarSeed: AGENT,
      avatar: 'https://example.com/old-avatar.png',
    });
    expect(soulSave.status).toBe(200);
    const committedSoul = await soulSave.json();
    expect(isAgentDetailView(committedSoul)).toBe(true);
    expect(committedSoul.agent.identity.avatar).toBe(url);
    expect((await fixture.phone.readAgent(WORKSPACE, AGENT, HUMAN))?.agent.identity.avatar).toBe(url);
    const context = await fixture.daemonOperation('getAgentAvatar', { roomId: ROOM });
    expect((await context.json()).drawing).toEqual(drawing);
    const refined = [
      ...drawing,
      { type: 'path', d: 'M36,68 L50,74 L64,68', fill: 'none', stroke: 'ink', strokeWidth: 2 },
    ];
    expect((await call({ ...input, drawing: refined })).status).toBe(200);
    const reopened = await new PhoneService(fixture.database, fixture.origin).readAgent(WORKSPACE, AGENT, HUMAN);
    expect(reopened?.avatarGenerationId).not.toBe(first?.avatarGenerationId);
    expect(reopened?.agent.identity.avatar).not.toBe(url);
    expect(
      (await fixture.database.query('SELECT id FROM agent_avatars WHERE agent_id=$1', [AGENT])).rowCount,
    ).toBe(1);
    expect((await phoneFetch(url)).status).toBe(404);
    await fixture.database.query("UPDATE agent_commands SET state='complete' WHERE id=$1", [command.id]);
    expect((await call(input)).status).not.toBe(200);
  });


  it('creates a deterministic agent direct message inside the Workspace', async () => {
    await announceAgentLifecycle(fixture.database, new LiveHub(), ROOM, AGENT, {
      lifecycleId: 'routing-fixture',
    });
    const dm = (await (
      await fixture.operation('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: AGENT })
    ).json()) as { id: string; created: boolean };
    expect(dm.created).toBe(true);
    const reopened = (await (
      await fixture.operation('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: AGENT })
    ).json()) as { id: string; created: boolean };
    expect(reopened).toEqual({ id: dm.id, created: false });

    // The agent is auto-added as a Room member so it serves the DM.
    const members = await fixture.database.query<{ identity_id: string }>(
      `SELECT identity_id FROM memberships WHERE room_id=$1 AND removed_at IS NULL ORDER BY identity_id`,
      [dm.id],
    );
    expect(members.rows.map((row) => row.identity_id).sort()).toEqual([AGENT, HUMAN].sort());

    // The helper learns the Room is conversational-only from the daemon op.
    const repositoryState = (await (
      await fixture.daemonOperation('getRoomRepositoryState', { roomId: dm.id })
    ).json()) as { resolution: string; directParticipants?: string[] };
    expect(repositoryState.resolution).toBe('none');
    expect([...(repositoryState.directParticipants ?? [])].sort()).toEqual([AGENT, HUMAN].sort());

    // The Room itself supplies authorship intent: its sole agent is addressed
    // even by the first untagged human message.
    const sent = await fixture.operation('sendRoomMessage', {
      roomId: dm.id,
      messageId: 'c'.repeat(64),
      text: 'Are you there?',
    });
    expect(sent.status).toBe(200);
    // Nothing in 'Are you there?' names the helper. The DM itself is the
    // address, and the command the server created is where that shows.
    expect(await wokenBy(fixture.database, 'c'.repeat(64))).toEqual([AGENT]);

    // A retried phone delivery is idempotent after the server-derived mention
    // is applied and cannot create a second inbox item.
    expect(
      (
        await fixture.operation('sendRoomMessage', {
          roomId: dm.id,
          messageId: 'c'.repeat(64),
          text: 'Are you there?',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.database.query<{ count: number }>(
          `SELECT count(*)::int count FROM messages WHERE id=$1`,
          ['c'.repeat(64)],
        )
      ).rows[0]?.count,
    ).toBe(1);

    // A fresh daemon token models the helper restarting after the message was
    // committed. The durable mention still makes that first message intake.
    const restartedExchange = await fixture.auth.createDaemonExchange(AGENT);
    const restartedToken = (await fixture.auth.exchangeDaemonToken(restartedExchange.exchangeToken))!
      .daemonToken;
    const bootstrap = (await (await fixture.daemonOperation('getDaemonBootstrap', {})).json()) as {
      rooms: Array<{ roomId: string }>;
    };
    expect(bootstrap.rooms).toContainEqual(expect.objectContaining({ roomId: dm.id }));
    const restartedInbox = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: dm.id }, restartedToken)
    ).json()) as { items: Array<{ id: string }> };
    expect(restartedInbox.items).toEqual([expect.objectContaining({ id: 'c'.repeat(64) })]);

    const addressed = await fixture.operation('sendRoomMessage', {
      roomId: dm.id,
      messageId: 'd'.repeat(64),
      text: '@bee Are you there?',
    });
    expect(addressed.status).toBe(200);
    const addressedInbox = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: dm.id })
    ).json()) as { items: Array<{ id: string }> };
    expect(addressedInbox.items).toContainEqual(expect.objectContaining({ id: 'd'.repeat(64) }));

    // The oldest queued input owns the combined DM turn.
    const replyResponse = await fixture.daemonOperation('postRoomMessage', {
      roomId: dm.id,
      requestId: 'c'.repeat(64),
      triggerMessageId: 'd'.repeat(64),
      text: 'I am here.',
    });
    expect(replyResponse.status).toBe(200);
    const agentReply = (await replyResponse.json()) as { id: string };
    const directReplyId = 'e'.repeat(64);
    expect(
      (
        await fixture.operation('sendRoomReply', {
          roomId: dm.id,
          messageId: directReplyId,
          parentMessageId: agentReply.id,
          text: 'Thanks.',
        })
      ).status,
    ).toBe(200);
    expect(await wokenBy(fixture.database, directReplyId)).toEqual([AGENT]);
    const directReplyInbox = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: dm.id })
    ).json()) as { items: Array<{ id: string }> };
    expect(directReplyInbox.items).toContainEqual(expect.objectContaining({ id: directReplyId }));

    const humanParentReplyId = 'f'.repeat(64);
    expect(
      (
        await fixture.operation('sendRoomReply', {
          roomId: dm.id,
          messageId: humanParentReplyId,
          parentMessageId: 'c'.repeat(64),
          text: 'One more thing.',
        })
      ).status,
    ).toBe(200);
    expect(await wokenBy(fixture.database, humanParentReplyId)).toEqual([AGENT]);

    // The chat list names a DM row by its peer, so it carries the one other
    // participant's identity instead of leaving the client the stored name.
    const chats = (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
      chats: Array<{
        room: { id: string };
        directMessage?: {
          peer: { pubkey: string; kind: string };
          presence?: { status: string; observedAt: number };
        };
      }>;
    };
    expect(chats.chats.find((chat) => chat.room.id === dm.id)?.directMessage).toMatchObject({
      peer: { pubkey: AGENT, kind: 'agent' },
      presence: { status: 'online' },
    });
    expect(chats.chats.find((chat) => chat.room.id === ROOM)?.directMessage).toBeUndefined();
  });


  it('lets a Room member agent add an idempotent supported reaction that renders by identity', async () => {
    // Reproduction reaction-target-7801448616: exercise both public HTTP paths.
    const capture = vi.spyOn(serverSentry, 'captureServerError');
    const missing = '0'.repeat(64);
    expect((await fixture.daemonOperation('reactToRoomMessage', {
      roomId: ROOM, messageId: missing, emoji: '🎉',
    })).status).toBe(404);
    expect((await fixture.operation('reactToMessage', {
      roomId: ROOM, messageId: missing, emoji: '🎉',
    })).status).toBe(404);
    for (const [name, input] of [
      ['deleteRoomMessage', { roomId: ROOM, messageId: missing }],
      ['setMessageBookmark', { roomId: ROOM, messageId: missing, bookmarked: true }],
      ['clearNeedsYou', { workspaceId: WORKSPACE, messageId: missing }],
    ] as const) {
      expect((await fixture.operation(name, input)).status).toBe(404);
    }
    expect(capture).not.toHaveBeenCalled();
    capture.mockRestore();
    const messageId = '7'.repeat(64);
    expect(
      (await fixture.operation('sendRoomMessage', { roomId: ROOM, messageId, text: 'Agent react here' }))
        .status,
    ).toBe(200);

    expect(
      (await fixture.daemonOperation('reactToRoomMessage', { roomId: ROOM, messageId, emoji: '🎉' }))
        .status,
    ).toBe(200);
    expect(
      (await fixture.daemonOperation('reactToRoomMessage', { roomId: ROOM, messageId, emoji: '🎉' }))
        .status,
    ).toBe(200);

    const room = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(room.messages.find((message) => message.id === messageId)?.reactions).toEqual([
      {
        emoji: '🎉',
        count: 1,
        reacted: false,
        members: [{ pubkey: AGENT, kind: 'agent', name: 'Bee', handle: 'bee' }],
      },
    ]);

    expect(
      (await fixture.daemonOperation('reactToRoomMessage', { roomId: ROOM, messageId, emoji: '🔥' }))
        .status,
    ).toBe(400);

    const outsider = '6'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Outside','outside')`,
      [outsider],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [outsider, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, outsider],
    );
    const exchange = await fixture.auth.createDaemonExchange(outsider);
    const outsiderToken = (await fixture.auth.exchangeDaemonToken(exchange.exchangeToken))!.daemonToken;
    expect(
      (
        await fixture.daemonOperation(
          'reactToRoomMessage',
          { roomId: ROOM, messageId, emoji: '✅' },
          outsiderToken,
        )
      ).status,
    ).toBe(403);
  });


  it('refuses a direct message with an agent outside the Workspace', async () => {
    const outsider = 'd'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Outsider')`, [
      outsider,
    ]);
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [outsider, HUMAN]);
    const response = await fixture.operation('resolveDirectMessage', {
      workspaceId: WORKSPACE,
      participantId: outsider,
    });
    expect(response.status).toBe(400);
  });


  it('repairs millisecond-truncated read marks and treats their marked message as read', async () => {
    const messageId = 'e'.repeat(64);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,'Precise reply','2026-09-03T01:30:33.596223Z')`,
      [messageId, ROOM, AGENT],
    );
    expect((await fixture.request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId })).status).toBe(204);
    expect(
      (
        await fixture.database.query<{ exact: boolean }>(
          `SELECT mark.message_created_at=message.created_at exact
           FROM room_read_marks mark JOIN messages message ON message.id=mark.message_id
           WHERE mark.room_id=$1 AND mark.identity_id=$2`,
          [ROOM, HUMAN],
        )
      ).rows[0]?.exact,
    ).toBe(true);

    // This is the timestamp a millisecond-precision client used to persist.
    await fixture.database.query(
      `UPDATE room_read_marks SET message_created_at='2026-09-03T01:30:33.596Z'
       WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, HUMAN],
    );

    await migrate(fixture.database);

    const chat = (
      (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
        chats: Array<{ room: { id: string }; unread: boolean }>;
      }
    ).chats.find((item) => item.room.id === ROOM);
    expect(chat?.unread).toBe(false);
    expect(
      (
        await fixture.database.query<{ exact: boolean }>(
          `SELECT mark.message_created_at=message.created_at exact
           FROM room_read_marks mark JOIN messages message ON message.id=mark.message_id
           WHERE mark.room_id=$1 AND mark.identity_id=$2`,
          [ROOM, HUMAN],
        )
      ).rows[0]?.exact,
    ).toBe(true);
  });


  it('reports a registered agent that never ran as never-seen and rolls it back', async () => {
    const ghost = await fixture.request('/v1/phone/operations/createAgentPairingCode', 'POST', {
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
        const outgoing = httpRequest(`${fixture.origin}/auth/agent/connect`, {
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
    await announceAgentLifecycle(fixture.database, new LiveHub(), ROOM, AGENT, {
      lifecycleId: 'release-readiness',
      releaseVersion: 'v0.0.22',
      sourceSha: 'd03cff8f'.padEnd(40, '0'),
    });

    const readiness = await phoneFetch(`${fixture.origin}/v1/releases/daemon-readiness`);
    expect(readiness.status).toBe(200);
    const body = (await readiness.json()) as {
      daemons: Array<{ agentPubkey: string; state: string; observedAt?: number }>;
      summary: { total: number; ready: number; neverSeen: number };
    };
    const ghostEntry = body.daemons.find((daemon) => daemon.agentPubkey === grant.agentPubkey);
    expect(ghostEntry?.state).toBe('never-seen');
    expect(ghostEntry?.observedAt).toBeUndefined();
    expect(body.summary).toMatchObject({ total: 2, ready: 1, neverSeen: 1 });

    const rolledBack = await fixture.request('/v1/auth/daemon/rollback', 'POST', {
      exchangeToken: grant.exchangeToken,
    });
    expect(rolledBack.status).toBe(204);
    const afterReadiness = await phoneFetch(`${fixture.origin}/v1/releases/daemon-readiness`);
    const afterBody = (await afterReadiness.json()) as typeof body;
    expect(
      afterBody.daemons.find((daemon) => daemon.agentPubkey === grant.agentPubkey),
    ).toBeUndefined();
    expect(afterBody.summary).toMatchObject({ total: 1, ready: 1, neverSeen: 0 });

    const refuse = await fixture.request('/v1/auth/daemon/rollback', 'POST', {
      exchangeToken: grant.exchangeToken,
    });
    expect(refuse.status).toBeGreaterThanOrEqual(400);
  });


  it('refuses to roll back an agent that has already reported presence', async () => {
    await announceAgentLifecycle(fixture.database, new LiveHub(), ROOM, AGENT, {
      lifecycleId: 'rollback-refusal',
    });
    const refused = await fixture.request('/v1/auth/daemon/rollback', 'POST', {});
    expect(refused.status).toBe(400);
  });


  it('connects an agent without a System DM note or push', async () => {
    const secondRoom = (await (
      await fixture.operation('createRoom', { workspaceId: WORKSPACE, name: 'workshop' })
    ).json()) as { id: string };
    await fixture.operation('registerPushDevice', {
      token: 'owner-agent-join-device-token-1234567890',
      platform: 'android',
      environment: 'physical',
    });
    await fixture.database.query(`UPDATE identities SET push_level='full' WHERE id=$1`, [HUMAN]);
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    expect(await loop.runOnce()).toBe(0);
    const pairing = (await (
      await fixture.operation('createAgentPairingCode', { workspaceId: WORKSPACE })
    ).json()) as { code: string };

    // Neither a name nor a soul is typed any more: the claim seeds both. This
    // wizard defers the join to the finish call below, made once its rename
    // decision settles.
    const connectPayload = JSON.stringify({
      pairing_code: pairing.code,
      harness: 'codex',
      model: 'gpt-5.6',
      defer_join: true,
    });
    const connected = await new Promise<{ status: number; body: Record<string, string> }>(
      (resolve, reject) => {
        const outgoing = httpRequest(`${fixture.origin}/auth/agent/connect`, {
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
    const grant = connected.body as unknown as {
      agent_pubkey: string;
      agent_name: string;
      agent_face: string;
      soul: string;
      workspace_joined: boolean;
    };
    expect(isFaceId(grant.agent_face)).toBe(true);
    expect(grant.soul).toBe(FACE_SOULS[grant.agent_face as FaceId]);
    expect(FACE_NAMES[grant.agent_face as FaceId]).toContain(grant.agent_name);

    // The wizard's rename window has closed (kept, in this test): now the
    // agent joins the Rooms it inherited and the "joined" line is written.
    const finishPayload = JSON.stringify({
      pairing_code: pairing.code,
      workspace_joined: grant.workspace_joined,
    });
    const finished = await new Promise<{ status: number }>((resolve, reject) => {
      const outgoing = httpRequest(`${fixture.origin}/auth/agent/connect/finish`, {
        method: 'POST',
        headers: {
          host: 'server.test',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(finishPayload),
        },
      });
      outgoing.once('error', reject);
      outgoing.once('response', (incoming) => {
        incoming.resume();
        incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0 }));
      });
      outgoing.end(finishPayload);
    });
    expect(finished.status).toBe(200);

    const roomNotes = await fixture.database.query<{
      room_id: string;
      text: string;
      presentation: string;
    }>(
      `SELECT room_id,text,presentation FROM messages
       WHERE author_id=$1 AND card_type='member-joined' ORDER BY room_id`,
      [grant.agent_pubkey],
    );
    expect(roomNotes.rows).toEqual([]);
    const dmNotes = await fixture.database.query<{ author_id: string; text: string; count: number }>(
      `SELECT message.author_id,message.text,count(*)::int count
       FROM messages message JOIN rooms room ON room.id=message.room_id
       WHERE room.workspace_id=$1 AND room.direct_participants IS NOT NULL
         AND message.card_type='workspace-member-joined'
       GROUP BY message.author_id,message.text`,
      [WORKSPACE],
    );
    expect(dmNotes.rows).toEqual([]);
    expect(await loop.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();

  });


  it('always hands an agent its seeded soul, at both daemon seams (no Workspace switch)', async () => {
    await fixture.database.query(`UPDATE agents SET soul=$2::jsonb WHERE agent_id=$1`, [
      AGENT,
      JSON.stringify({ name: 'Bee', instructions: 'You are a fox.', avatarSeed: AGENT }),
    ]);
    const soulOf = async () =>
      (
        (await (
          await fixture.daemonOperation('getAgentConfiguration', { agentId: AGENT, roomId: ROOM })
        ).json()) as { soul?: { instructions: string } }
      ).soul;
    const rosterSoulOf = async () =>
      (
        (await (
          await fixture.daemonOperation('getWorkspaceRoster', { workspaceId: WORKSPACE })
        ).json()) as { members: Array<{ identityId: string; soul?: unknown }> }
      ).members.find((member) => member.identityId === AGENT)?.soul;

    const view = (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}`)).json()) as {
      managerSettings?: { visibility?: string; rooms?: unknown[] };
    };
    expect(view.managerSettings).toEqual({
      visibility: expect.any(String),
      allowFixSweep: true,
      rooms: expect.any(Array),
      roomsTruncated: false,
    });
    expect(await soulOf()).toMatchObject({ instructions: 'You are a fox.' });
    expect(await rosterSoulOf()).toBeDefined();
  });


  it('projects every agent message with the current author name, handle, and face', async () => {
    await fixture.database.query(
      `UPDATE identities SET name='Lumen',handle='lumen',face_id='owl' WHERE id=$1`,
      [AGENT],
    );
    const id = '9'.repeat(64);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,legacy_event)
       VALUES($1,$2,$3,'Actually dont we need to go to a corner before actually starting work?','{}'::jsonb)`,
      [id, ROOM, AGENT],
    );

    const room = (await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN))!;
    expect(room.messages.find((message) => message.id === id)?.author).toEqual({
      pubkey: AGENT,
      kind: 'agent',
      name: 'Lumen',
      handle: 'lumen',
      face: 'owl',
    });
  });


  it('round-trips push, update, and agent operations through the phone HTTP contract', async () => {
    const pairing = await fixture.request('/v1/phone/operations/createAgentPairingCode', 'POST', {
      workspaceId: WORKSPACE,
    });
    expect(pairing.status).toBe(200);
    const pairingResult = (await pairing.json()) as { code: string; expiresAt: number };
    expect(pairingResult.code).toMatch(/^[0-9A-F]{8}-[0-9A-F]{8}$/);

    // The connect lane exchanges an app-minted code as the new agent. Exercise
    // the same named operation with an agent-scoped bearer so this legacy API
    // remains contract-valid until that cutover lands.
    const agentAccessToken = 'bat_agent_http_contract';
    await fixture.database.query(
      `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
       VALUES($1,$2,$3,now()+interval '15 minutes')`,
      [tokenHash(agentAccessToken), AGENT, '33333333-3333-4333-8333-333333333333'],
    );
    const claimed = await fixture.request(
      '/v1/phone/operations/claimAgentPairing',
      'POST',
      { code: pairingResult.code },
      agentAccessToken,
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual(
      expect.objectContaining({ workspaceId: WORKSPACE, pairedBy: HUMAN, joined: true }),
    );

    const soul = await fixture.request('/v1/phone/operations/updateAgentSoul', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      name: 'Honeybee',
      instructions: 'Be precise and practical.',
      avatarSeed: 'honeybee-seed',
    });
    expect(soul.status).toBe(200);
    expect(await soul.json()).toEqual(expect.objectContaining({
      soul: expect.objectContaining({ name: 'Honeybee', avatarSeed: 'honeybee-seed' }),
    }));
    expect(
      (await fixture.database.query(`SELECT name,handle FROM identities WHERE id=$1`, [AGENT])).rows,
    ).toEqual([{ name: 'Honeybee', handle: 'bee' }]);

    await fixture.database.query(`UPDATE agents SET model_catalog=$2::jsonb WHERE agent_id=$1`, [
      AGENT,
      JSON.stringify([
        {
          id: 'model',
          category: 'model',
          options: [{ id: 'gpt-5.6' }, { id: 'gpt-5.6-codex' }],
        },
        {
          id: 'effort',
          category: 'reasoning_effort',
          options: [{ id: 'high' }, { id: 'max' }],
        },
      ]),
    ]);

    const model = await fixture.request('/v1/phone/operations/updateAgentModelSelection', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      model: 'gpt-5.6',
      effort: 'high',
    });
    expect(model.status).toBe(200);
    expect(await model.json()).toEqual(expect.objectContaining({
      selected: { model: 'gpt-5.6', effort: 'high' },
    }));

    const effortOnly = await fixture.request('/v1/phone/operations/updateAgentModelSelection', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      effort: 'max',
    });
    expect(effortOnly.status).toBe(200);
    expect(await effortOnly.json()).toEqual(expect.objectContaining({
      selected: { model: 'gpt-5.6', effort: 'max' },
    }));

    const modelAndClearEffort = await fixture.request(
      '/v1/phone/operations/updateAgentModelSelection',
      'POST',
      { workspaceId: WORKSPACE, agentId: AGENT, model: 'gpt-5.6-codex', effort: null },
    );
    expect(modelAndClearEffort.status).toBe(200);
    expect(await modelAndClearEffort.json()).toEqual(expect.objectContaining({
      selected: { model: 'gpt-5.6-codex' },
    }));

    const agent = await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`);
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
    const registered = await fixture.request('/v1/phone/operations/registerPushDevice', 'POST', {
      token,
      platform: 'android',
      environment: 'physical',
    });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toEqual({ accepted: true });

    const tested = await fixture.request('/v1/phone/operations/sendPushTest', 'POST', {});
    expect(tested.status).toBe(204);
    expect(await tested.text()).toBe('');
    expect(fixture.sendPushTest).toHaveBeenCalledWith(HUMAN);

    const reported = await fixture.request('/v1/phone/operations/reportRunningUpdate', 'POST', {
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

    const unregistered = await fixture.request('/v1/phone/operations/unregisterPushDevice', 'POST', {
      token,
      platform: 'android',
      environment: 'physical',
    });
    expect(unregistered.status).toBe(204);
    expect(await unregistered.text()).toBe('');

    const removed = await fixture.request('/v1/phone/operations/removeAgent', 'POST', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
    });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');

    expect(
      (await fixture.database.query(`SELECT 1 FROM push_devices WHERE token=$1`, [token])).rowCount,
    ).toBe(0);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM device_update_receipts WHERE identity_id=$1 AND device_id=$2`,
          [HUMAN, '44444444-4444-4444-8444-444444444444'],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2 AND removed_at IS NULL`,
          [WORKSPACE, AGENT],
        )
      ).rowCount,
    ).toBe(0);

    // The helper's own tokens now answer with the one settled fact it may
    // retire itself on, instead of a 401 it would retry against forever.
    const refused = await fixture.daemonOperation('getDaemonBootstrap', { agentId: AGENT });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'agent_removed' });
    const unknownToken = await fixture.daemonOperation(
      'getDaemonBootstrap',
      { agentId: AGENT },
      'bdt_nope',
    );
    expect(unknownToken.status).toBe(401);
    expect(await unknownToken.json()).toEqual({ error: 'daemon_token_required' });
  });


  it('preserves the existing handle when a pairing joins another Workspace', async () => {
    const secondWorkspace = '66666666-6666-4666-8666-666666666666';
    const lumen = 'f'.repeat(64);
    const agentAccessToken = 'bat_agent_handle_pairing';
    await fixture.database.query(`UPDATE identities SET name='Lumen',handle='nora' WHERE id=$1`, [AGENT]);
    await fixture.database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Second')`, [secondWorkspace]);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Lumen','lumen')`,
      [lumen],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [lumen, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
      [secondWorkspace, HUMAN, lumen],
    );
    await fixture.database.query(
      `INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
       VALUES($1,$2,$3,now()+interval '15 minutes')`,
      [tokenHash(agentAccessToken), AGENT, '44444444-4444-4444-8444-444444444444'],
    );
    const pairing = await fixture.request('/v1/phone/operations/createAgentPairingCode', 'POST', {
      workspaceId: secondWorkspace,
    });
    const { code } = (await pairing.json()) as { code: string };

    const claimed = await fixture.request(
      '/v1/phone/operations/claimAgentPairing',
      'POST',
      { code },
      agentAccessToken,
    );

    expect(claimed.status).toBe(200);
    expect(
      (await fixture.database.query(`SELECT handle FROM identities WHERE id=$1`, [AGENT])).rows,
    ).toEqual([{ handle: 'nora' }]);
  });
});
