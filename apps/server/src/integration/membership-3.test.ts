import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PhoneService } from '.././phone-service.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: membership', () => {
const fixture = monolithFixture();


  it("stops a running turn at a Room member's word, but not a spectator's", async () => {
    const requestId = '9'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: '@bee summarise the release',
      mentions: [AGENT],
    });
    await fixture.daemonOperation('postAgentTurnReceipt', { roomId: ROOM, requestId, status: 'working' });

    // The running turn names its requester for the transcript; the stop
    // control itself is open to anyone who may act in the Room.
    const working = await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN);
    expect(working!.latestAgentTurns).toContainEqual(
      expect.objectContaining({ requestId, status: 'working', requestedBy: HUMAN }),
    );

    // A Workspace spectator is refused, and the turn keeps running.
    const aliceToken = await fixture.phoneToken('alice');
    const aliceId = createHash('sha256').update('github:alice').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: aliceId,
      role: 'member',
    });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: aliceId });
    await fixture.database.query(
      `UPDATE memberships SET role='spectator' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, aliceId],
    );
    const refused = await fixture.operation(
      'cancelAgentTurn',
      { roomId: ROOM, requestId, agentId: AGENT },
      aliceToken,
    );
    expect(refused.status).toBe(403);
    expect(
      (
        await fixture.database.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [
          ROOM,
          requestId,
        ])
      ).rows[0],
    ).toEqual({ status: 'working' });

    // A Room member's stop settles all three facts at once.
    expect(
      (await fixture.operation('cancelAgentTurn', { roomId: ROOM, requestId, agentId: AGENT })).status,
    ).toBe(204);
    expect(
      (
        await fixture.database.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [
          ROOM,
          requestId,
        ])
      ).rows[0],
    ).toEqual({ status: 'cancelled' });
    const stopLine = (
      await fixture.database.query<{
        text: string;
        woke: string[];
        request_id: string;
        system_event: { kind?: string };
      }>(
        `SELECT text,request_id,system_event,
           ARRAY(SELECT agent_id FROM agent_commands
                 WHERE source_message_id=messages.id) woke
         FROM messages
         WHERE room_id=$1 AND presentation='system' AND system_event->>'kind'='turn-cancelled'`,
        [ROOM],
      )
    ).rows;
    expect(stopLine).toEqual([
      expect.objectContaining({
        text: '@owner stopped @bee · turn cancelled',
        // `@bee` in that sentence is how the line READS, not how it is
        // addressed: the stop command beside it is the daemon's wake-up, and
        // the request id is how it knows which session to cancel.
        woke: [AGENT],
        request_id: requestId,
      }),
    ]);

    // `cancelled` is terminal: the run that lands a moment later cannot
    // overwrite the stop, and its lateness is not inscribed as a failure.
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          roomId: ROOM,
          requestId,
          status: 'complete',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          roomId: ROOM,
          requestId,
          status: 'failed',
          reason: 'harness exited during cancellation',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.database.query(
          `SELECT status,failure_reason FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
          [ROOM, requestId],
        )
      ).rows[0],
    ).toEqual({ status: 'cancelled', failure_reason: 'stop' });
    expect(
      (
        await fixture.database.query(
          `SELECT count(*)::int n FROM messages WHERE room_id=$1 AND card_type='turn-failed'
             AND card->>'requestId'=$2`,
          [ROOM, requestId],
        )
      ).rows[0],
    ).toEqual({ n: 0 });

    // The partial answer the model had already written is published — stopping
    // is not undoing — and publishing it does NOT promote the stopped turn back
    // to `complete`, which is the one way a durable reply could have undone the
    // stop behind the requester's back.
    expect(
      (
        await fixture.daemonOperation('postRoomMessage', {
          roomId: ROOM,
          requestId,
          triggerMessageId: requestId,
          text: 'Half of an answer, cut off mid-',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.database.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`, [
          ROOM,
          requestId,
        ])
      ).rows[0],
    ).toEqual({ status: 'cancelled' });

    // A turn that is no longer running has nothing left to stop.
    expect(
      (await fixture.operation('cancelAgentTurn', { roomId: ROOM, requestId, agentId: AGENT })).status,
    ).toBe(404);
  });


  it('lists and dispatches Room workflows only for human Workspace managers', async () => {
    const list = vi.spyOn(fixture.githubOperations, 'listRoomWorkflows').mockResolvedValue({
      defaultBranch: 'main',
      workflows: [{ name: 'Release', lastRunAt: 1_789_214_400, conclusion: 'success' }],
    });
    const dispatch = vi
      .spyOn(fixture.githubOperations, 'dispatchRoomWorkflow')
      .mockResolvedValue(undefined);

    const listed = await fixture.operation('listRoomWorkflows', { roomId: ROOM });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      defaultBranch: 'main',
      workflows: [{ name: 'Release', lastRunAt: 1_789_214_400, conclusion: 'success' }],
    });
    const dispatched = await fixture.operation('dispatchRoomWorkflow', {
      roomId: ROOM,
      workflowName: 'Release',
    });
    expect(dispatched.status).toBe(204);
    expect(list).toHaveBeenCalledWith(ROOM);
    expect(dispatch).toHaveBeenCalledWith(ROOM, 'Release');

    const adminToken = await fixture.phoneToken('workflow-admin');
    const adminId = createHash('sha256').update('github:workflow-admin').digest('hex');
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'admin')`,
      [WORKSPACE, adminId],
    );
    expect((await fixture.operation('listRoomWorkflows', { roomId: ROOM }, adminToken)).status).toBe(200);

    const memberToken = await fixture.phoneToken('workflow-member');
    const memberId = createHash('sha256').update('github:workflow-member').digest('hex');
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, memberId, ROOM],
    );
    expect((await fixture.operation('listRoomWorkflows', { roomId: ROOM }, memberToken)).status).toBe(403);
    expect(
      (
        await fixture.operation(
          'dispatchRoomWorkflow',
          { roomId: ROOM, workflowName: 'Release' },
          memberToken,
        )
      ).status,
    ).toBe(403);

    // An agent never gains this phone authority, even if corrupt data assigns it an admin role.
    await fixture.database.query(
      `UPDATE memberships SET role='admin' WHERE workspace_id=$1 AND room_id IS NULL AND identity_id=$2`,
      [WORKSPACE, AGENT],
    );
    await expect(
      fixture.phone.execute('dispatchRoomWorkflow', { roomId: ROOM, workflowName: 'Release' }, AGENT),
    ).rejects.toThrow('workspace admins only');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
