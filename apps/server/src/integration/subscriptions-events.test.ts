import { setRoomEventSubscriptions } from '.././agent-subscriptions.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { taggedIdentityIdsSql } from '.././message-mentions.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, WELCOME_AGENT, ROOM, next } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: subscriptions-events', () => {
const fixture = monolithFixture();


  it('hands a corner reader the draft its turn is already writing when they subscribe', async () => {
    // The captain's report: a corner turn eight minutes into its tool work,
    // opened from the Room list. Everything the corner shows — the objective,
    // the collapsed tool group, the clock — is read durably over HTTP. The
    // draft is the one thing that was only ever pushed, so a reader who was
    // not already listening saw prose nowhere.
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-draft-request',
      name: 'Room-join-push',
      objective: 'Trace the Room-join push producer and correct it',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const turnId = 'corner-draft-turn';
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
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
        await fixture.daemonOperation('postAgentDraft', {
          agentId: AGENT,
          roomId: cornerId,
          turnId,
          text: "I'll trace the Room-join push producer and its existing coverage",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: cornerId,
          requestId: turnId,
          activity: [
            {
              kind: 'tool',
              title: 'Bash',
              operation: 'execute',
              command: 'rg push',
              status: 'exit 0',
            },
          ],
        })
      ).status,
    ).toBe(200);

    const socket = new WebSocket(`${fixture.origin.replace('http', 'ws')}/v1/phone/live`, [
      `bearer.${fixture.accessToken}`,
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


  it('manages agent tool schedules over daemon HTTP with agent scoping', async () => {
    const created = await fixture.daemonOperation('createAgentSchedule', { title: 'Scheduled check',
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
    const listed = await fixture.daemonOperation('listAgentSchedules', { agentId: AGENT, roomId: ROOM });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      schedules: [
        {
          title: 'Scheduled check',
          scheduleId,
          agentId: AGENT,
          agentHandle: 'bee',
          prompt: "message 'hello @bananaman614305'",
          cadence: { kind: 'interval', everyMinutes: 1 },
          maxRuns: 5,
          runCount: 0,
          nextRunAt,
        },
      ],
    });
    // The daemon token's agent cannot be impersonated and cannot delete...
    const foreignCreate = await fixture.daemonOperation('createAgentSchedule', { title: 'Scheduled check',
      agentId: 'f'.repeat(64),
      roomId: ROOM,
      prompt: 'Impersonation.',
      cadence: { kind: 'interval', everyMinutes: 1 },
    });
    expect(foreignCreate.status).toBeGreaterThanOrEqual(400);
    const deleted = await fixture.daemonOperation('deleteAgentSchedule', {
      agentId: AGENT,
      roomId: ROOM,
      scheduleId,
    });
    expect(deleted.status).toBe(200);
    const gone = await fixture.daemonOperation('listAgentSchedules', { agentId: AGENT, roomId: ROOM });
    await expect(gone.json()).resolves.toEqual({ schedules: [] });
    const missing = await fixture.daemonOperation('deleteAgentSchedule', {
      agentId: AGENT,
      roomId: ROOM,
      scheduleId,
    });
    expect(missing.status).toBeGreaterThanOrEqual(400);
  });


  it('wakes a subscribed Room agent exactly once when an invite brings someone in', async () => {
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Owl')`, [
      WELCOME_AGENT,
    ]);
    // A greeter subscribed to `joined` in one public Room. System events are
    // subscribable per Room, so the invite arrival's public-Room projection
    // emits its `joined` event exactly where someone subscribed and the
    // subscriber wakes exactly once.
    const greeterRoom = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,visibility) VALUES($1,$2,$3,'lobby','public')`,
      [greeterRoom, WORKSPACE, HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, WELCOME_AGENT, greeterRoom],
    );
    await setRoomEventSubscriptions(fixture.database, greeterRoom, WELCOME_AGENT, ['joined']);
    const invite = (await (await fixture.operation('createInvite', { workspaceId: WORKSPACE })).json()) as {
      token: string;
    };
    const newcomer = await fixture.auth.exchangeGitHubOidc('greeted-newcomer');
    expect(
      (await fixture.operation('redeemInvite', { token: invite.token }, newcomer.accessToken)).status,
    ).toBe(200);

    const joined = await fixture.database.query<{
      tagged_ids: string[];
      text: string;
      system_event: { verb: string; kind?: string };
      woke: string[];
    }>(
      `SELECT ${taggedIdentityIdsSql('messages')} tagged_ids,text,system_event,
              ARRAY(SELECT agent_id FROM agent_commands
                    WHERE source_message_id=messages.id ORDER BY agent_id) woke
       FROM messages
       WHERE room_id=$1 AND card_type='member-joined' AND author_id=$2`,
      [greeterRoom, newcomer.identityId],
    );
    expect(joined.rows).toEqual([
      expect.objectContaining({
        tagged_ids: [],
        text: '@greeted-newcomer joined · invited by @owner',
        system_event: expect.objectContaining({ kind: 'joined' }),
        woke: [WELCOME_AGENT],
      }),
    ]);

    const workspaceDms = await fixture.database.query<{
      text: string;
      system_event: { kind?: string };
      woke: string[];
    }>(
      `SELECT message.text,message.system_event,
              ARRAY(SELECT agent_id FROM agent_commands
                    WHERE source_message_id=message.id ORDER BY agent_id) woke
       FROM messages message
       JOIN rooms room ON room.id=message.room_id
       WHERE room.workspace_id=$1 AND room.direct_participants IS NOT NULL
         AND message.card_type='workspace-member-joined'`,
      [WORKSPACE],
    );
    expect(workspaceDms.rows).toEqual([]);

    // No agent subscribed to `joined` in the ordinary Room, so the projection
    // is silent there: the join event is emitted only where someone listens.
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='member-joined' AND author_id=$2`,
          [ROOM, newcomer.identityId],
        )
      ).rowCount,
    ).toBe(0);
  });


  it('wakes an ordinary Workspace Room subscriber for a Workspace-scoped arrival', async () => {
    // The same mechanism for a manager-added member: subscription, not how
    // the person arrived, is what surfaces a join event.
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Finch')`, [
      WELCOME_AGENT,
    ]);
    const publicRoom = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,visibility) VALUES($1,$2,$3,'Open Room','public')`,
      [publicRoom, WORKSPACE, HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,$2,$3,'member')`,
      [WORKSPACE, publicRoom, WELCOME_AGENT],
    );
    await setRoomEventSubscriptions(fixture.database, publicRoom, WELCOME_AGENT, ['joined']);

    const newcomer = await fixture.phoneToken('arrival-newcomer');
    const newcomerId = createHash('sha256').update('github:arrival-newcomer').digest('hex');
    expect(
      (
        await fixture.operation('addWorkspaceMember', {
          workspaceId: WORKSPACE,
          memberId: newcomerId,
          role: 'member',
        })
      ).status,
    ).toBe(200);
    expect(newcomer).toBeTruthy();

    const joined = await fixture.database.query<{
      tagged_ids: string[];
      text: string;
      system_event: { kind?: string };
      woke: string[];
    }>(
      `SELECT ${taggedIdentityIdsSql('messages')} tagged_ids,text,system_event,
              ARRAY(SELECT agent_id FROM agent_commands
                    WHERE source_message_id=messages.id ORDER BY agent_id) woke
       FROM messages WHERE room_id=$1 AND card_type='member-joined'`,
      [publicRoom],
    );
    expect(joined.rows).toEqual([
      expect.objectContaining({
        tagged_ids: [],
        system_event: expect.objectContaining({ kind: 'joined' }),
        woke: [WELCOME_AGENT],
      }),
    ]);
  });


  it('lets an agent subscribe itself, and wakes it on the next arrival', async () => {
    // The captain's objection, answered: nobody edits a database row for the
    // agent. It calls the operation its own tool calls, in the Room it is in.
    expect(
      await (await fixture.daemonOperation('listEventSubscriptions', { roomId: ROOM })).json(),
    ).toEqual({ kinds: [] });
    const set = await fixture.daemonOperation('setEventSubscriptions', {
      roomId: ROOM,
      kinds: ['joined', 'joined'],
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ kinds: ['joined'] });
    expect(
      await (await fixture.daemonOperation('listEventSubscriptions', { roomId: ROOM })).json(),
    ).toEqual({ kinds: ['joined'] });

    // The very next join in that Room mentions it, which is what starts a turn.
    const newcomer = await fixture.phoneToken('newcomer');
    const newcomerId = createHash('sha256').update('github:newcomer').digest('hex');
    expect(newcomer).toBeTruthy();
    await fixture.database.query(`UPDATE rooms SET visibility='invite-only' WHERE id=$1`, [ROOM]);
    expect(
      (
        await fixture.operation('addWorkspaceMember', {
          workspaceId: WORKSPACE,
          memberId: newcomerId,
          role: 'member',
        })
      ).status,
    ).toBe(200);
    expect(
      await (await fixture.operation('addRoomMember', { roomId: ROOM, memberId: newcomerId })).json(),
    ).toEqual({ joined: true });
    const joins = await fixture.database.query<{
      system_event: { kind?: string };
      woke: string[];
    }>(
      `SELECT ARRAY(SELECT agent_id FROM agent_commands
                    WHERE source_message_id=messages.id ORDER BY agent_id) woke,
              system_event
       FROM messages WHERE room_id=$1 AND author_id=$2 AND card_type='member-joined'`,
      [ROOM, newcomerId],
    );
    expect(joins.rows).toEqual([
      {
        system_event: expect.objectContaining({ kind: 'joined' }),
        woke: [AGENT],
      },
    ]);
    const ordinaryLine = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation)
       VALUES($1,$2,$3,'Owner noted the weather.','system')`,
      [ordinaryLine, ROOM, HUMAN],
    );
    const inbox = (await (await fixture.daemonOperation('getRoomInbox', { roomId: ROOM })).json()) as {
      items: Array<{
        id: string;
        systemEvent?: { kind?: string };
      }>;
    };
    expect(inbox.items.map((item) => item.id)).not.toContain(ordinaryLine);
    expect(inbox.items).toContainEqual(
      expect.objectContaining({ systemEvent: expect.objectContaining({ kind: 'joined' }) }),
    );
  });


  it('emits an agent event with the cause the server read, and refuses one outside a turn', async () => {
    const peer = 'e'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Bat')`, [peer]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    // No live receipt: an event is emitted from inside a turn or not at all.
    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId: 'event-without-turn',
      status: 'working',
    });
    await fixture.database.query(
      `DELETE FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, 'event-without-turn', AGENT],
    );
    const outsideTurn = await fixture.request(
      '/v1/daemon/operations/postRoomEvent',
      'POST',
      {
        roomId: ROOM,
        requestId: 'event-without-turn',
        generationId: 'fixture-generation',
        kind: 'agent:handoff',
        consequence: 'the branch is ready',
      },
      fixture.daemonToken,
    );
    expect(outsideTurn.status).toBe(400);
    expect(((await outsideTurn.json()) as { error: string }).error).toMatch(/no turn running/);

    const trigger = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      text: `@Bee please hand off`,
    });
    expect(trigger.status).toBe(200);
    const requestId = ((await trigger.json()) as { messageId: string }).messageId;
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          agentId: AGENT,
          roomId: ROOM,
          requestId,
          status: 'working',
        })
      ).status,
    ).toBe(200);

    const emitted = await fixture.daemonOperation('postRoomEvent', {
      roomId: ROOM,
      requestId,
      kind: 'agent:handoff',
      consequence: 'the branch is ready',
      mentionAgentIds: [peer],
    });
    expect(emitted.status).toBe(200);
    const row = await fixture.database.query<{
      text: string;
      tagged_ids: string[];
      system_event: { kind?: string; subject: { id?: string } };
      event_cause_id: string | null;
      event_root_cause_id: string | null;
      event_depth: number | null;
    }>(
      `SELECT text,ARRAY(SELECT agent_id FROM agent_commands
                         WHERE source_message_id=messages.id) woke,
         system_event,event_cause_id,event_root_cause_id,event_depth
       FROM messages WHERE id=$1`,
      [((await emitted.json()) as { id: string }).id],
    );
    const line = row.rows[0]!;
    // The sentence names the agent that said it, per A6: a receiving model must
    // see WHO, not a bare clause.
    expect(line.text).toBe('@bee emitted handoff · the branch is ready');
    expect(line.system_event.kind).toBe('agent:handoff');
    expect(line.system_event.subject.id).toBe(AGENT);
    expect(line.woke).toEqual([peer]);
    // The cause came from the receipt, not from the helper.
    expect(line.event_cause_id).toBe(requestId);
    expect(line.event_root_cause_id).toBe(requestId);
    expect(line.event_depth).toBe(1);
  });


  it('refuses a server kind, a stranger mention and more than three mentions', async () => {
    const trigger = await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@Bee go' });
    const requestId = ((await trigger.json()) as { messageId: string }).messageId;
    await fixture.daemonOperation('postAgentTurnReceipt', {
      agentId: AGENT,
      roomId: ROOM,
      requestId,
      status: 'working',
    });
    const stranger = 'f'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Elsewhere')`, [
      stranger,
    ]);
    for (const [payload, expected] of [
      [{ kind: 'joined', consequence: 'hi' }, /a fact the server states/],
      [{ kind: 'agent:Handoff', consequence: 'hi' }, /agent:<slug>/],
      [{ kind: 'agent:x', consequence: '   ' }, /one sentence/],
      [
        { kind: 'agent:x', consequence: 'hi', mentionAgentIds: [stranger] },
        /not an agent member of this Room/,
      ],
      [
        { kind: 'agent:x', consequence: 'hi', mentionAgentIds: ['1', '2', '3', '4'] },
        /at most 3 agents/,
      ],
    ] as const) {
      const refused = await fixture.daemonOperation('postRoomEvent', { roomId: ROOM, ...payload });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(expected);
    }
    const written = await fixture.database.query(
      `SELECT 1 FROM messages WHERE system_event->>'kind' LIKE 'agent:%'`,
    );
    expect(written.rowCount).toBe(0);
  });


  it('subscribes a connecting agent in the Rooms its finish joined it to', async () => {
    const pairing = (await (
      await fixture.operation('createAgentPairingCode', { workspaceId: WORKSPACE })
    ).json()) as { code: string };
    const agentPubkey = 'f'.repeat(64);
    const claim = await fixture.phone.claimAgentConnectPairing({
      code: pairing.code,
      agentPubkey,
      model: 'openrouter/z-ai/glm-5.3-flash',
      deferJoin: true,
    });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('claim failed');
    await expect(
      fixture.phone.finishAgentConnectPairing({
        code: pairing.code,
        workspaceJoined: claim.workspaceJoined,
        eventSubscriptions: ['joined', 'not-a-kind'],
      }),
    ).resolves.toEqual({ status: 'finished' });
    const memberships = await fixture.database.query<{
      room_id: string | null;
      event_subscriptions: string[];
    }>(
      `SELECT room_id,event_subscriptions FROM room_access WHERE identity_id=$1
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
