import { cornerObjectiveSql } from '.././corner-objective.js';
import { cornerCommissionerSql } from '.././corner-opening.js';
import { advanceCorner } from '.././corner-lifecycle.js';
import { createAgentCommand } from '.././agent-command.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { migrate } from '.././database.js';
import { insertCornerFacts } from '.././test-support.js';
import { cornerOwnerSql } from '.././corner-worker.js';
import { PhoneService } from '.././phone-service.js';
import { PushDeliveryLoop } from '.././background.js';
import { type RoomView } from '@beeline/api-contract/phone';
import { taggedIdentityIdsSql } from '.././message-mentions.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: corner-turns', () => {
const fixture = monolithFixture();


  it('credits the opener, not a copied parent owner, on a phone-opened corner merge; recording a branch stores no owner', async () => {
    fixture.processWebhook.mockImplementation((event, payload) =>
      fixture.githubOperations.processWebhook(event, payload),
    );
    const candy = 'e'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Candy')`, [
      candy,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'owner')`,
      [WORKSPACE, candy, ROOM],
    );
    await fixture.database.query(
      `INSERT INTO github_installations(
         installation_id,owner_id,account_id,account_login,account_type,repository_selection,status
       ) VALUES(77,$1,'42','owner','User','selected','active')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch)
       VALUES(101,77,'owner/widgets','main')`,
    );
    await fixture.database.query(
      `UPDATE rooms SET repository_key='owner/widgets',
         repository_remote='https://github.com/owner/widgets.git',
         repository_resolution='repository',github_installation_id=77 WHERE id=$1`,
      [ROOM],
    );
    // The phone's + button opens a corner with no owner agent and copies the
    // parent's memberships, so Candy arrives in the corner as an owner.
    const created = await fixture.operation('createHumanCorner', { roomId: ROOM, title: 'Hidden-river' });
    expect(created.status).toBe(200);
    const { id: cornerId } = (await created.json()) as { id: string };
    const branch = `feature/corner-${cornerId.replaceAll('-', '').slice(0, 12)}`;
    expect(
      (
        await fixture.daemonOperation('postCornerRemoteState', {
          cornerId,
          branch,
          state: 'working',
          checks: 'unknown',
        })
      ).status,
    ).toBe(200);
    const merged = await fixture.webhook('pull_request', 'phone-corner-pr-merged', {
      installation: { id: 77 },
      repository: { id: 101, full_name: 'owner/widgets' },
      action: 'closed',
      pull_request: {
        number: 1,
        title: 'Hidden-river',
        html_url: 'https://github.com/owner/widgets/pull/1',
        head: { ref: branch, sha: '1'.repeat(40) },
        base: { ref: 'main' },
        merged: true,
        merged_at: '2026-09-30T14:00:00Z',
        merge_commit_sha: 'f'.repeat(40),
        merged_by: { login: 'owner' },
      },
    });
    expect(merged.status).toBe(202);
    expect(
      (
        await fixture.database.query<{ card_type: string; author_id: string }>(
          `SELECT card_type,author_id FROM messages
           WHERE (room_id=$1 AND card_type='daemon-fact' AND card->>'type'='corner-complete')
              OR (room_id=$2 AND card_type='github-corner-note' AND system_event->>'verb'='merged')
           ORDER BY card_type`,
          [ROOM, cornerId],
        )
      ).rows,
    ).toEqual([
      // No assignment names an agent owner here, so the person who opened it is credited.
      { card_type: 'github-corner-note', author_id: HUMAN },
    ]);
    expect(
      (
        await fixture.database.query<{ owner_agent_id: string | null }>(
          `SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`,
          [cornerId],
        )
      ).rows,
    ).toEqual([{ owner_agent_id: null }]);
  });


  it('keeps an unaddressed corner follow-up silent after its responder retires', async () => {
    const peer = 'c'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Peer','peer')`,
      [peer],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    const peerToken = (await fixture.auth.exchangeDaemonToken(
      (await fixture.auth.createDaemonExchange(peer)).exchangeToken,
    ))!.daemonToken;
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'retired-corner-responder',
      name: 'Retired-responder',
      objective: 'Keep continuity local to active corner members',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    expect(
      (
        await fixture.daemonOperation(
          'postRoomMessage',
          { roomId: cornerId, text: '@owner I last answered this person.' },
          peerToken,
        )
      ).status,
    ).toBe(200);
    expect((await fixture.operation('removeAgent', { workspaceId: WORKSPACE, agentId: peer })).status).toBe(
      204,
    );

    const followUp = 'e'.repeat(64);
    expect(
      (
        await fixture.operation('sendRoomMessage', {
          roomId: cornerId,
          messageId: followUp,
          text: 'Please continue.',
        })
      ).status,
    ).toBe(200);
    const inbox = (await (
      await fixture.daemonOperation('getCornerCloseRequests', { cornerId })
    ).json()) as { items: Array<{ id: string }> };
    expect(inbox.items).not.toContainEqual(expect.objectContaining({ id: followUp }));
    expect(
      (
        await fixture.database.query<{ count: string }>(
          `SELECT count(*)::text count FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
          [cornerId, followUp],
        )
      ).rows[0],
    ).toEqual({ count: '0' });
    expect(
      (
        await fixture.database.query<{ count: string }>(
          `SELECT count(*)::text count FROM messages
           WHERE room_id=$1 AND presentation='system'
             AND text='Peer could not be reached · not a member of this corner'`,
          [cornerId],
        )
      ).rows[0],
    ).toEqual({ count: '0' });
  });


  it('reads a corner owner from its opening order', async () => {
    const legacyCornerId = '33333333-3333-4333-8333-333333333333';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Legacy corner')`,
      [legacyCornerId, WORKSPACE, ROOM, HUMAN],
    );
    await insertCornerFacts(fixture.database, { cornerId: legacyCornerId, ownerAgentId: AGENT });
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'Legacy objective','message')`,
      ['f'.repeat(64), legacyCornerId, AGENT],
    );
    await migrate(fixture.database);

    const corners = await fixture.daemonOperation('listRoomCorners', { roomId: ROOM });
    expect(await corners.json()).toEqual({
      corners: [
        expect.objectContaining({ cornerId: legacyCornerId, createdBy: AGENT, archived: false }),
      ],
    });
    expect(
      (
        await fixture.database.query<{ owner_agent_id: string }>(
          `SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`,
          [legacyCornerId],
        )
      ).rows[0],
    ).toEqual({ owner_agent_id: AGENT });
    const cornerView = (await (await fixture.request(`/v1/phone/rooms/${legacyCornerId}`)).json()) as RoomView;
    expect(cornerView.cornerOpenerAgentId).toBe(AGENT);
  });


  it('keeps working receipts fresh without letting heartbeats resurrect terminal turns', async () => {
    const requestId = '6'.repeat(64);
    const generationId = `${AGENT}:${ROOM}`;
    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
      generationId,
    });
    await fixture.database.query(
      `UPDATE agent_turns SET started_at=now()-interval '2 minutes',
         created_at=now()-interval '2 minutes'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );

    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
      generationId,
      heartbeat: true,
    });
    const fresh = await fixture.database.query<{ status: string; age_seconds: number }>(
      `SELECT status,extract(epoch FROM now()-created_at)::float age_seconds
       FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    expect(fresh.rows[0]?.status).toBe('working');
    expect(fresh.rows[0]?.age_seconds).toBeLessThan(5);
    const projected = (
      await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN)
    )?.latestAgentTurns.find((turn) => turn.requestId === requestId);
    expect(projected).toBeDefined();
    expect(projected!.createdAt).toBeGreaterThan(projected!.startedAt!);
    expect(projected!.createdAt - projected!.startedAt!).toBeGreaterThanOrEqual(119);

    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'complete',
      generationId,
    });
    await fixture.database.query(
      `UPDATE agent_turns SET created_at=now()-interval '1 minute'
       WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
      generationId,
      heartbeat: true,
    });
    const terminal = await fixture.database.query<{ status: string; old: boolean }>(
      `SELECT status,created_at<now()-interval '30 seconds' old
       FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
      [ROOM, requestId, AGENT],
    );
    expect(terminal.rows[0]).toEqual({ status: 'complete', old: true });

    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId: 'heartbeat-without-turn',
      status: 'working',
      generationId,
    });
    await fixture.database.query(`DELETE FROM agent_turns WHERE request_id='heartbeat-without-turn'`);
    const missingHeartbeat = await fixture.request(
      '/v1/daemon/operations/postAgentTurnReceipt',
      'POST',
      {
        roomId: ROOM,
        requestId: 'heartbeat-without-turn',
        status: 'working',
        generationId,
        heartbeat: true,
      },
      fixture.daemonToken,
    );
    expect(missingHeartbeat.status).toBe(200);
    expect(
      await fixture.database.query(`SELECT 1 FROM agent_turns WHERE request_id='heartbeat-without-turn'`),
    ).toHaveProperty('rowCount', 0);
  });


  it.each(['owner', 'admin'] as const)(
    'lets anyone in the Room stop another requester’s turn, whatever their Room role (%s)',
    async (role) => {
      const requestId = 'e'.repeat(64);
      const aliceToken = await fixture.phoneToken('alice');
      const aliceId = createHash('sha256').update('github:alice').digest('hex');
      await fixture.operation('addWorkspaceMember', {
        workspaceId: WORKSPACE,
        memberId: aliceId,
        role: 'member',
      });
      await fixture.operation('addRoomMember', { roomId: ROOM, memberId: aliceId });
      await fixture.operation(
        'sendRoomMessage',
        { roomId: ROOM, messageId: requestId, text: '@bee help', mentions: [AGENT] },
        aliceToken,
      );
      await fixture.daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
      await fixture.database.query(`UPDATE memberships SET role=$3 WHERE room_id=$1 AND identity_id=$2`, [
        ROOM,
        HUMAN,
        role,
      ]);
      expect(
        (await fixture.operation('cancelAgentTurn', { roomId: ROOM, requestId, agentId: AGENT })).status,
      ).toBe(204);
      expect(
        (
          await fixture.database.query(
            `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
            [ROOM, requestId],
          )
        ).rows[0],
      ).toEqual({ status: 'cancelled' });
      const lines = (
        await fixture.database.query(
          `SELECT author_id FROM messages WHERE room_id=$1 AND system_event->>'kind'='turn-cancelled'`,
          [ROOM],
        )
      ).rows;
      expect(lines).toEqual([{ author_id: HUMAN }]);
    },
  );


  it('lets the requester stop a corner turn that answers a parent-Room message', async () => {
    const cornerId = '33333333-3333-4333-8333-333333333333';
    const requestId = 'a'.repeat(64);
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Stop corner')`,
      [cornerId, WORKSPACE, ROOM, AGENT],
    );

    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: '@bee take this into a corner',
      mentions: [AGENT],
    });
    // A corner carries the parent message's opaque request id into its own
    // command. The stop endpoint must resolve the requester through that
    // parent message rather than treating the corner as an unowned turn.
    await createAgentCommand(fixture.database, {
      roomId: cornerId,
      agentId: AGENT,
      sourceMessageId: requestId,
      turnRequestId: requestId,
      reason: 'corner_objective',
    });
    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: cornerId,
      requestId,
      status: 'working',
    });

    const working = await new PhoneService(fixture.database, fixture.origin).readRoom(cornerId, HUMAN);
    expect(working!.latestAgentTurns).toContainEqual(
      expect.objectContaining({ requestId, status: 'working', requestedBy: HUMAN }),
    );
    expect(
      (await fixture.operation('cancelAgentTurn', { roomId: cornerId, requestId, agentId: AGENT })).status,
    ).toBe(204);
    expect(
      (
        await fixture.database.query(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
          [cornerId, requestId, AGENT],
        )
      ).rows,
    ).toEqual([{ status: 'cancelled' }]);
    expect(
      (
        await fixture.database.query<{
          woke: string[];
          request_id: string;
          system_event: { kind?: string };
        }>(
          `SELECT request_id,system_event,
             ARRAY(SELECT agent_id FROM agent_commands
                   WHERE source_message_id=messages.id AND action='stop') woke
           FROM messages
           WHERE room_id=$1 AND presentation='system' AND system_event->>'kind'='turn-cancelled'`,
          [cornerId],
        )
      ).rows,
    ).toEqual([expect.objectContaining({ woke: [AGENT], request_id: requestId })]);
  });


  it('ends an explicit hiccup failure once without reopening its command', async () => {
    const requestId = '8'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: "@bee what's up",
      mentions: [AGENT],
    });
    await fixture.daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });
    const failed = await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'failed',
      reason: 'provider error 429 concurrency_limit',
      reasonKind: 'hiccup',
    });
    expect(failed.status).toBe(200);
    expect(await failed.json()).not.toHaveProperty('hiccupRestart');
    expect(
      (
        await fixture.database.query(
          `SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
          [ROOM, requestId],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', failure_reason: 'provider error 429 concurrency_limit' });
    const lines = () =>
      fixture.database.query<{
        id: string;
        author_id: string;
        text: string;
        tagged_ids: string[];
        card: Record<string, string>;
      }>(
        `SELECT id,author_id,text,${taggedIdentityIdsSql('messages')} tagged_ids,card
         FROM messages WHERE room_id=$1 AND presentation='system' AND card_type='turn-failed'`,
        [ROOM],
      );
    const first = (await lines()).rows;
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toBe('@bee could not finish this request · provider error 429 concurrency_limit');
    expect(
      (
        await fixture.database.query<{ state: string }>(
          `SELECT state FROM agent_commands WHERE turn_request_id=$1 AND agent_id=$2`,
          [requestId, AGENT],
        )
      ).rows[0],
    ).toEqual({ state: 'complete' });
    const replay=await fixture.daemonOperation('postAgentTurnReceipt',{roomId:ROOM,requestId,status:'failed',reason:'provider error 429 concurrency_limit',reasonKind:'hiccup'});
    expect(replay.status).toBe(200);
    expect((await lines()).rows).toHaveLength(1);
    const commands=await (await fixture.daemonOperation('getAgentCommands',{roomId:ROOM})).json() as {commands:{turnRequestId:string}[]};
    expect(commands.commands.some(command=>command.turnRequestId===requestId)).toBe(false);
    const room = (await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN))!;
    expect(room.messages.filter(message=>message.id===first[0]!.id).map(message=>message.text)).toEqual([first[0]!.text]);
    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId: '9'.repeat(64),
      status: 'failed',
      reason: 'ACP agent exited (code 1)',
    });
    expect((await lines()).rows).toHaveLength(2);
  });


  it('keeps cached repositories usable without a reconnect flag during a transient refresh failure', async () => {
    await fixture.database.query(
      `INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,account_avatar_url,repository_selection,status) VALUES(77,$1,'42','owner','User','https://avatars.test/owner','selected','active')`,
      [HUMAN],
    );
    await fixture.database.query(
      `INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','trunk')`,
    );
    vi.spyOn(fixture.githubOperations, 'refresh').mockRejectedValue(
      new Error('GitHub user installations failed: HTTP 401'),
    );
    const listed = await fixture.request('/v1/phone/operations/listGitHubRepositories', 'POST', {
      refresh: true,
    });
    expect(listed.status).toBe(200);
    const payload = await listed.json();
    expect(payload).not.toHaveProperty('githubReconnectNeeded');
    expect(payload).toMatchObject({
      installed: true,
      repositories: [
        // Stored before GitHub's flag was recorded: read as private.
        {
          id: 101,
          fullName: 'owner/widgets',
          installationId: 77,
          defaultBranch: 'trunk',
          private: true,
        },
      ],
    });
  });


  it("reports a corner's working receipt on its parent Room row, and stops at archive", async () => {
    // The Room row's own state word is the turn receipt, the corner's
    // included — a helper working in a corner is work happening in that Room,
    // and the label must not wait for the corner to say so in the parent.
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-room-label',
      name: 'Ship-the-widget',
      objective: 'Ship the widget end to end',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId: 'corner-room-label',
      status: 'complete',
    });
    const roomRow = async () =>
      (
        (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{ room: { id: string }; agentState?: string }>;
        }
      ).chats.find((chat) => chat.room.id === ROOM)!;
    // Creating the corner dispatches its initial work before helper pickup.
    // Completing the parent receipt must not hide that pending corner work.
    expect((await roomRow()).agentState).toBe('working');

    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: cornerId,
      requestId: '4'.repeat(64),
      status: 'working',
    });
    expect((await roomRow()).agentState).toBe('working');

    // An archived corner is finished work: whatever its last receipt says, it
    // no longer speaks for its Room, exactly as it no longer counts in it.
    await fixture.database.query(`UPDATE rooms SET archived_at=now() WHERE id=$1`, [cornerId]);
    expect((await roomRow()).agentState).toBeUndefined();
  });


  it('posts one corner-open daemon-fact card at a requesting message and does not push it', async () => {
    const send = vi.fn(async () => undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    await loop.runOnce(); // establish the durable floor before the new events
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
      [HUMAN],
    );
    const requestId = 'corner-open-card';
    const sourceMessageId = createHash('sha256').update(requestId).digest('hex');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Open a corner for the widget')`,
      [sourceMessageId, ROOM, HUMAN],
    );
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId,
      name: 'Ship-the-widget',
      objective: 'Ship the widget end to end',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const cards = await fixture.database.query<{ author_id: string; card: Record<string, unknown> }>(
      `SELECT author_id,card FROM messages WHERE room_id=$1 AND card_type='daemon-fact'`,
      [ROOM],
    );
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]!.author_id).toBe(AGENT);
    expect(cards.rows[0]!.card).toEqual({
      type: 'corner-open',
      cornerId,
      sourceMessageId,
      name: 'Ship-the-widget',
      objective: 'Ship-the-widget',
    });
    // The NAME titles the corner; the objective stays the statement of work.
    const corner = await fixture.database.query<{
      name: string;
      objective: string;
      commissioned_by: string;
    }>(
      `SELECT r.name,${cornerObjectiveSql('r')} objective,${cornerCommissionerSql('r.id')} commissioned_by
       FROM rooms r JOIN corner_facts cf ON cf.corner_id=r.id WHERE r.id=$1`,
      [cornerId],
    );
    expect(corner.rows[0]).toEqual({
      name: 'Ship-the-widget',
      objective: 'Ship the widget end to end',
      commissioned_by: HUMAN,
    });
    const roomView = await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN);
    expect(roomView).toBeDefined();
    expect('corners' in (roomView ?? {})).toBe(false);
    const cornerList = await new PhoneService(fixture.database, fixture.origin).readCorners(ROOM, HUMAN);
    expect(cornerList?.corners.find((item) => item.corner.id === cornerId)).toEqual(
      expect.objectContaining({
        initiator: expect.objectContaining({ pubkey: HUMAN, kind: 'human' }),
        agent: expect.objectContaining({ pubkey: AGENT, kind: 'agent' }),
      }),
    );
    expect(await loop.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });


  it("marks the viewer's corners in the Room list with the push Followed rule", async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-chat-mine',
      name: 'Pick-a-shape',
      objective: 'Pick a shape for the widget',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    await fixture.settleCornerWork(cornerId);
    // Someone else started it: the viewer neither commissioned nor follows it.
    await fixture.database.query(`UPDATE agent_commands SET root_source_message_id='agent-initiated' WHERE room_id=$1 AND reason='corner_objective'`, [
      cornerId,
    ]);
    await fixture.database.query(`DELETE FROM corner_follows WHERE corner_id=$1 AND identity_id=$2`, [
      cornerId,
      HUMAN,
    ]);
    const listed = async () => {
      await advanceCorner(fixture.database, cornerId, { kind: 'reconcile' });
      return (
        (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{
            room: { id: string };
            openCorners: Array<{ id: string; state: string; mine?: true }>;
          }>;
        }
      ).chats
        .find((item) => item.room.id === ROOM)
        ?.openCorners.find((item) => item.id === cornerId);
    };
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('chat-mine-untagged',$1,$2,'Still thinking.',now()+interval '1 second')`,
      [cornerId, AGENT],
    );
    expect(await listed()).not.toHaveProperty('mine');
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('chat-mine-tagged',$1,$2,'@owner square or round?',now()+interval '2 seconds')`,
      [cornerId, AGENT],
    );
    expect(await listed()).toEqual(expect.objectContaining({ state: 'idle', mine: true }));
    // The tag keeps the corner the viewer's after they answer and it moves on.
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('chat-mine-answer',$1,$2,'Round.',now()+interval '3 seconds')`,
      [cornerId, HUMAN],
    );
    expect(await listed()).toEqual(expect.objectContaining({ mine: true }));
  });


  it("lifts a Room up the Room list when one of the viewer's corners starts waiting", async () => {
    const busy = '22222222-2222-4222-8222-2222222222b1';
    await fixture.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Busy')`, [
      busy,
      WORKSPACE,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [WORKSPACE, busy, HUMAN],
    );
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-lifts-room',
      name: 'Pick-a-size',
      objective: 'Pick a size for the widget',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    await fixture.settleCornerWork(cornerId);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('busy-chatter',$1,$2,'Chatter.',now()+interval '5 seconds')`,
      [busy, AGENT],
    );
    const listed = async () => {
      await advanceCorner(fixture.database, cornerId, { kind: 'reconcile' });
      return (
        (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{
            room: { id: string };
            openCorners?: Array<{ id: string; state: string; mine?: true }>;
          }>;
        }
      ).chats;
    };
    const order = async () =>
      (await listed()).map((item) => item.room.id).filter((id) => id === ROOM || id === busy);
    expect(await order()).toEqual([busy, ROOM]);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('corner-hands-back',$1,$2,'needs-decision: @owner small or large?',now()+interval '10 seconds')`,
      [cornerId, AGENT],
    );
    const corner = (await listed())
      .find((item) => item.room.id === ROOM)
      ?.openCorners?.find((item) => item.id === cornerId);
    expect(corner).toEqual(expect.objectContaining({ state: 'waiting', mine: true }));
    expect(await order()).toEqual([ROOM, busy]);
    // Answered, the corner owes nobody: idle is not the viewer's activity.
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       VALUES('corner-answered',$1,$2,'Large.',now()+interval '11 seconds')`,
      [cornerId, HUMAN],
    );
    expect(await order()).toEqual([busy, ROOM]);
  });


  it('reads a quiet corner idle until it owes someone, and pulls the dropdown open only until seen', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-owed-idle',
      name: 'Pick-a-finish',
      objective: 'Pick a finish for the widget',
    });
    const { cornerId } = (await created.json()) as { cornerId: string };
    await fixture.settleCornerWork(cornerId);
    const listed = async () => {
      await advanceCorner(fixture.database, cornerId, { kind: 'reconcile' });
      return (
        (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{
            room: { id: string };
            openCorners?: Array<{ id: string; state: string; mine?: true; attention?: true }>;
          }>;
        }
      ).chats
        .find((item) => item.room.id === ROOM)
        ?.openCorners?.find((item) => item.id === cornerId);
    };
    const page = async () =>
      (await new PhoneService(fixture.database, fixture.origin).readCorners(ROOM, HUMAN))?.corners.find(
        (item) => item.corner.id === cornerId,
      );
    const owed = async () =>
      (await new PhoneService(fixture.database, fixture.origin).readRoom(cornerId, HUMAN))?.cornerOwed;
    const say = (id: string, author: string, text: string, at: string) =>
      fixture.database.query(
        `INSERT INTO messages(id,room_id,author_id,text,created_at)
         VALUES($1,$2,$3,$4,now()+$5::interval)`,
        [id, cornerId, author, text, at],
      );

    // The agent finished its turn and asks nothing of anyone.
    await say('owed-done', AGENT, 'Done for now.', '1 second');
    expect(await listed()).toEqual(expect.objectContaining({ state: 'idle', mine: true }));
    expect(await listed()).not.toHaveProperty('attention');
    expect(await page()).toEqual(expect.objectContaining({ state: 'idle' }));
    expect(await owed()).toBe(false);

    // An explicit decision asks the viewer and pulls their dropdown open.
    await say('owed-tag', AGENT, 'needs-decision: @owner matte or gloss?', '2 seconds');
    expect(await listed()).toEqual(
      expect.objectContaining({ state: 'waiting', mine: true, attention: true }),
    );
    expect(await page()).toEqual(expect.objectContaining({ state: 'waiting' }));
    expect(await owed()).toBe(true);

    // The viewer opens the corner: still waiting, but no longer pulling.
    expect(
      (await fixture.request(`/v1/phone/rooms/${cornerId}/read`, 'POST', { messageId: 'owed-tag' })).status,
    ).toBe(204);
    expect(await listed()).toEqual(expect.objectContaining({ state: 'waiting' }));
    expect(await listed()).not.toHaveProperty('attention');

    // The viewer answers: nothing is owed, the corner is idle.
    await say('owed-answer', HUMAN, 'Matte.', '3 seconds');
    expect(await listed()).toEqual(expect.objectContaining({ state: 'idle' }));
    expect(await owed()).toBe(false);
  });


  it('Reproduction F1-8: explicit current-turn artifact resolves and missing ids return 400', async () => {
    const mediaId = '77777777-7777-4777-8777-777777777777';
    const requestId = 'f1-pending-artifact';
    await fixture.database.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
      VALUES($1,$2,'artifact','f1-artifact','text/plain','Plan',4,$3,'ready',now()+interval '1 day')`, [mediaId, AGENT, 'a'.repeat(64)]);
    expect((await fixture.daemonOperation('postAgentAttachment', { roomId: ROOM, requestId, attachment: { url: `${fixture.origin}/v1/media/${mediaId}`, name: 'Plan', mimeType: 'text/plain', size: 4 } })).status).toBe(200);
    const input = { roomId: ROOM, requestId, name: 'Artifact-work', objective: 'Apply plan', brief: { content: 'Apply the plan', attachments: [{ objectId: mediaId, purpose: 'Plan', required: true }] } };
    const opened = await fixture.daemonOperation('createCorner', input);
    console.info(`Reproduction F1-8: wrong=503; right=200 for pending artifact; observed=${opened.status}`);
    expect(opened.status).toBe(200);
    const missing = await fixture.daemonOperation('createCorner', { ...input, idempotencyKey: 'missing-id', brief: { ...input.brief, attachments: [{ objectId: '88888888-8888-4888-8888-888888888888', purpose: 'Missing', required: true }] } });
    expect(missing.status).toBe(400);
    const otherTurn = await fixture.daemonOperation('createCorner', { ...input, requestId: 'other-turn', idempotencyKey: 'other-turn' });
    expect(otherTurn.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: expect.stringContaining('missing or unavailable in this Room') });
  });


  it('automatically binds a planning artifact posted in the opening turn', async () => {
    const objectId = '65432109-0000-4000-8000-000000000099';
    const bytes = Buffer.from('<html><body>approved mock</body></html>');
    const sha = createHash('sha256').update(bytes).digest('hex');
    await fixture.database.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES($1,$2,'media',$3,'text/html','planning-mock.html',$4,$5,'ready',now()+interval '1 hour')`,
      [objectId, AGENT, `media/${AGENT}/${sha}`, bytes.length, sha],
    );
    const requestId = 'auto-bind-planning-artifact';
    expect(
      (
        await fixture.daemonOperation('postAgentAttachment', {
          roomId: ROOM,
          requestId,
          attachment: {
            url: `${fixture.origin}/v1/media/${objectId}`,
            name: 'planning-mock.html',
            mimeType: 'text/html',
            size: bytes.length,
          },
        })
      ).status,
    ).toBe(200);
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId,
      idempotencyKey: `${requestId}:open`,
      name: 'Bound-mock',
      objective: 'Build the approved mock',
      repository: 'example/repository',
      brief: { content: 'Implement the approved visual mock exactly.' },
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    expect(
      await (await fixture.daemonOperation('getCornerRestoreState', { cornerId })).json(),
    ).toMatchObject({
      brief: {
        attachments: [
          {
            objectId,
            title: 'planning-mock.html',
            purpose: 'Planning artifact posted during brief preparation',
            required: true,
            sha256: sha,
          },
        ],
      },
    });
  });
});
