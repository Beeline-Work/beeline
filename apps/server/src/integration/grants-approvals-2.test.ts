import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import * as approvalSources from '.././approval-card-source.js';
import * as serverSentry from '.././sentry.js';
import { createAgentCommand } from '.././agent-command.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type RoomHistoryView, type RoomView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, WELCOME_AGENT, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: grants-approvals', () => {
const fixture = monolithFixture();


  it('grant-src-1: creates and reads approval cards with the source message actual Room', async () => {
    const capture = vi.spyOn(serverSentry, 'captureServerError').mockImplementation(() => undefined);
    await fixture.database.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [AGENT]);
    const opened = await fixture.operation('createHumanCorner', { roomId: ROOM, title: 'Grant-source' });
    const { id: sourceRoom } = await opened.json() as { id: string };
    const source = await fixture.operation('sendRoomMessage', {
      roomId: sourceRoom, text: 'Please run the checks', mentions: [],
    });
    const { messageId: root } = await source.json() as { messageId: string };
    const requestId = createHash('sha256').update('grant-src-1-turn').digest('hex');
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Agent request')`,
      [requestId, ROOM, SYSTEM_IDENTITY_ID]);
    const command = await createAgentCommand(fixture.database, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: requestId,
      turnRequestId: requestId, reason: 'fixture',
    });
    await fixture.database.query(`UPDATE agent_commands SET root_source_message_id=$2 WHERE id=$1`, [command!.id, root]);
    const ask = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM, requestId, kind: 'command', target: 'python3 check.py', reason: 'Run checks',
      script: { path: 'check.py', contents: 'print(1)', bytes: 8,
        sha256: createHash('sha256').update('print(1)').digest('hex') },
    });
    expect(ask.status).toBe(200);
    const { messageId: cardId } = await ask.json() as { messageId: string };
    const stored = (await fixture.database.query<{ room_id: string; card: { sourceRoomId: string; sourceMessageId: string } }>(
      `SELECT room_id,card FROM messages WHERE id=$1`, [cardId],
    )).rows[0]!;
    expect(stored.card).toMatchObject({ sourceRoomId: sourceRoom, sourceMessageId: root });
    // Recreate the production card's stale pair; reading must repair it too.
    await fixture.database.query(`UPDATE messages SET card=jsonb_set(card,'{sourceRoomId}',to_jsonb($2::text)) WHERE id=$1`, [cardId, ROOM]);
    const view = await fixture.request(`/v1/phone/rooms/${stored.room_id}`, 'GET', undefined, fixture.accessToken);
    expect(view.status).toBe(200);
    const painted = await view.json() as RoomView;
    expect(painted.messages.find(row => row.id === cardId)?.grantRequest)
      .toMatchObject({ sourceRoomId: sourceRoom, sourceMessageId: root });
    const staleJump = await fixture.request(`/v1/phone/rooms/${ROOM}/history?around=${root}`, 'GET', undefined, fixture.accessToken);
    expect(staleJump.status).toBe(200);
    expect((await staleJump.json() as RoomHistoryView).messages.some(row => row.id === root)).toBe(false);
    const jump = await fixture.request(`/v1/phone/rooms/${sourceRoom}/history?around=${root}`, 'GET', undefined, fixture.accessToken);
    expect(jump.status).toBe(200);
    expect((await jump.json() as RoomHistoryView).messages.some(row => row.id === root)).toBe(true);
    const outsider = await fixture.phoneToken('grant-source-outsider');
    expect((await fixture.request(`/v1/phone/rooms/${sourceRoom}/history?around=${root}`, 'GET', undefined, outsider)).status).toBe(404);
    const absent = await fixture.request(`/v1/phone/rooms/${sourceRoom}/history?around=${'f'.repeat(64)}`, 'GET', undefined, fixture.accessToken);
    expect((await absent.json() as RoomHistoryView).messages).toEqual([]);
    const approval = await fixture.daemonOperation('postSquireApproval', {
      roomId: ROOM, requestId, tool: 'test', title: 'Approve access', detail: 'Request access',
      approvalUrl: 'https://approve.trustysquire.test/approval/grant-src-1',
      approvalId: 'grant-src-1', linkKind: 'approval',
    });
    expect(approval.status).toBe(200);
    const squireCard = (await fixture.database.query<{ card: unknown }>(
      `SELECT card FROM messages WHERE card_type='squire-approval'`,
    )).rows[0]!.card;
    expect(squireCard).toMatchObject({ sourceRoomId: sourceRoom, sourceMessageId: root });
    expect(capture).not.toHaveBeenCalled();
    // Force a bad stamp at creation while retaining the already-resolved row.
    const checkSource = approvalSources.approvalCardSource;
    const stamp = vi.spyOn(approvalSources, 'approvalCardSource').mockImplementation((kind, source, row) =>
      checkSource(kind, { ...source, sourceRoomId: ROOM }, row));
    const badApproval = await fixture.daemonOperation('postSquireApproval', {
      roomId: ROOM, requestId, tool: 'test', title: 'Approve access', detail: 'Private text must not reach telemetry',
      approvalUrl: 'https://approve.trustysquire.test/approval/grant-src-bad',
      approvalId: 'grant-src-bad', linkKind: 'approval',
    });
    expect(badApproval.status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(expect.any(Error), {
      cardKind: 'squire-approval', sourceRoomId: ROOM, sourceMessageId: root,
      actualRoomId: sourceRoom, actualMessageId: root,
    });
    stamp.mockRestore();
    capture.mockClear();
    // A private root command id must never be passed off as a message id.
    await fixture.database.query(`UPDATE agent_commands SET root_source_message_id=id WHERE id=$1`, [command!.id]);
    const fallback = await fixture.daemonOperation('postSquireApproval', {
      roomId: ROOM, requestId, tool: 'test', title: 'Approve access', detail: 'Request access',
      approvalUrl: 'https://approve.trustysquire.test/approval/grant-src-private',
      approvalId: 'grant-src-private', linkKind: 'approval',
    });
    expect(fallback.status).toBe(200);
    const fallbackId = (await fallback.json() as { id: string }).id;
    expect((await fixture.database.query<{ card: unknown }>(`SELECT card FROM messages WHERE id=$1`, [fallbackId])).rows[0]!.card)
      .toMatchObject({ sourceRoomId: ROOM, sourceMessageId: requestId });
    expect(capture).not.toHaveBeenCalled();
    capture.mockRestore();
  });


  it('rejects obsolete repository grant requests without posting a permission card', async () => {
    const source = (await (
      await fixture.operation('sendRoomMessage', {
        roomId: ROOM,
        text: '@bee open the corner',
        mentions: [AGENT],
      })
    ).json()) as { messageId: string };
    const asked = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      requestId: source.messageId,
      kind: 'repository',
      target: 'owner/widgets',
      reason: 'open the corner',
    });
    expect(asked.status).toBeGreaterThanOrEqual(400);
    expect(
      (await fixture.database.query(`SELECT 1 FROM agent_grants WHERE kind='repository'`)).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='grant-request'`,
          [ROOM],
        )
      ).rows,
    ).toEqual([]);
  });


  it('requires a person for shared cache isolation, then applies and revokes the standing grant', async () => {
    const adminToken = await fixture.phoneToken('cache-manager');
    const adminId = createHash('sha256').update('github:cache-manager').digest('hex');
    const memberToken = await fixture.phoneToken('cache-member');
    const memberId = createHash('sha256').update('github:cache-member').digest('hex');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId: adminId, role: 'admin' });
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    await fixture.database.query(
      `UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`,
      [ROOM, adminId],
    );
    const invalid = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM, kind: 'shared_asset', target: 'some/file', reason: 'broken cache',
    });
    expect(invalid.status).toBe(400);
    const ask = (await (await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM, kind: 'shared_asset', target: 'package-cache',
      reason: 'The shared npm cache contains a corrupt package tarball',
    })).json()) as { grantId: string; status: string; auto: boolean; messageId: string };
    expect(ask).toMatchObject({ status: 'pending', auto: false });
    expect((await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM, kind: 'shared_asset', target: 'package-cache', reason: 'same failure',
    })).status).toBe(409);
    const card = await fixture.database.query<{ room_id: string; card_type: string }>(
      `SELECT room_id,card_type FROM messages WHERE id=$1`, [ask.messageId],
    );
    expect(card.rows[0]).toEqual({ room_id: ROOM, card_type: 'grant-request' });
    const mirrored = await fixture.database.query<{ room_id: string }>(
      `SELECT room_id FROM messages WHERE card_type='grant-request' AND room_id<>$2
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(card->'grants') entry
         WHERE entry->>'grantId'=$1)`, [ask.grantId, ROOM],
    );
    expect(mirrored.rows).toHaveLength(1);
    const managerTray = await fixture.operation('readNeedsYou', { workspaceId: WORKSPACE }, adminToken);
    expect(JSON.stringify(await managerTray.json())).toContain('package-cache');
    const memberTray = await fixture.operation('readNeedsYou', { workspaceId: WORKSPACE }, memberToken);
    expect(JSON.stringify(await memberTray.json())).not.toContain('package-cache');
    expect((await fixture.database.query(`SELECT status FROM agent_grants WHERE id=$1`, [ask.grantId])).rows)
      .toEqual([{ status: 'pending' }]);
    expect((await fixture.operation('decideAgentGrant', { grantId: ask.grantId, decision: 'always' }, memberToken)).status)
      .toBe(403);
    expect((await fixture.operation('decideAgentGrant', { grantId: ask.grantId, decision: 'once' }, adminToken)).status)
      .toBe(400);
    expect((await fixture.operation('decideAgentGrant', { grantId: ask.grantId, decision: 'always' }, adminToken)).status)
      .toBe(200);
    const settledCards = await fixture.database.query<{ status: string }>(
      `SELECT entry->>'status' status FROM messages message,
         jsonb_array_elements(message.card->'grants') entry
       WHERE message.card_type='grant-request' AND entry->>'grantId'=$1`, [ask.grantId],
    );
    expect(settledCards.rows).toEqual([{ status: 'approved' }, { status: 'approved' }]);
    const live = (await (await fixture.daemonOperation('listAgentGrants', { agentId: AGENT, roomId: ROOM })).json()) as {
      grants: Array<{ grantId: string; kind: string; target: string }>;
    };
    expect(live.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: ask.grantId, kind: 'shared_asset', target: 'package-cache' }),
    ]));
    expect((await fixture.phone.readWorkspaceMembers(WORKSPACE, adminId, { memberId: HUMAN }))?.grants)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ grantId: ask.grantId, status: 'approved' }),
      ]));
    expect((await fixture.operation('revokeAgentGrant', { grantId: ask.grantId }, adminToken)).status).toBe(200);
    const afterRevoke = (await (await fixture.daemonOperation('listAgentGrants', { agentId: AGENT, roomId: ROOM })).json()) as {
      grants: Array<{ grantId: string }>;
    };
    expect(afterRevoke.grants.some((grant) => grant.grantId === ask.grantId)).toBe(false);
    await fixture.database.query(`UPDATE agents SET owner_id=$2 WHERE agent_id=$1`, [AGENT, memberId]);
    const denied = (await (await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM, kind: 'shared_asset', target: 'codex-download-cache',
      reason: 'The download cache has an incompatible binary',
    })).json()) as { grantId: string };
    expect((await fixture.operation('decideAgentGrant', { grantId: denied.grantId, decision: 'deny' }, memberToken)).status)
      .toBe(200);
    expect((await fixture.database.query(`SELECT status FROM agent_grants WHERE id=$1`, [denied.grantId])).rows)
      .toEqual([{ status: 'denied' }]);
  });


  it('lets an older helper pass both corner authorization calls without a grant card', async () => {
    await fixture.database.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [AGENT]);
    const requesterLogin = 'legacy-corner-requester';
    const requesterToken = await fixture.phoneToken(requesterLogin);
    const requesterId = createHash('sha256').update(`github:${requesterLogin}`).digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: requesterId,
      role: 'member',
    });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: requesterId });
    const opened = await fixture.operation(
      'createHumanCorner',
      { roomId: ROOM, title: 'Older-helper-corner' },
      requesterToken,
    );
    expect(opened.status).toBe(200);
    const { id: cornerId } = (await opened.json()) as { id: string };
    const source = (await (
      await fixture.operation(
        'sendRoomMessage',
        { roomId: cornerId, text: '@bee answer here', mentions: [AGENT] },
        requesterToken,
      )
    ).json()) as { messageId: string };
    for (const name of ['authorizeRepositoryCall', 'authorizeHostCall']) {
      const response = await fixture.daemonOperation(name, {
        roomId: cornerId,
        requestId: source.messageId,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ allowed: true });
      const withoutTurn = await fixture.request(
        `/v1/daemon/operations/${name}`,
        'POST',
        {
          roomId: cornerId,
        },
        fixture.daemonToken,
      );
      expect(withoutTurn.status).toBe(403);
    }
    expect(
      (await fixture.database.query(`SELECT 1 FROM agent_grants WHERE room_id=$1`, [cornerId])).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.database.query(
          `SELECT 1 FROM messages WHERE room_id=$1 AND card_type IN ('grant-request','grant-auto')`,
          [cornerId],
        )
      ).rows,
    ).toEqual([]);
  });


  it('keeps owner tools available in a public Workspace and rejects calls without live command authority', async () => {
    await fixture.database.query(`UPDATE workspaces SET visibility='public' WHERE id=$1`, [WORKSPACE]);
    const source = (await (
      await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee work', mentions: [AGENT] })
    ).json()) as { messageId: string };
    expect(
      (
        await (
          await fixture.daemonOperation('authorizeSquireCall', {
            roomId: ROOM,
            requestId: source.messageId,
          })
        ).json()
      ).allowed,
    ).toBe(true);
    const response = await phoneFetch(`${fixture.origin}/v1/daemon/operations/authorizeResourceCall`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.daemonToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM, target: 'paid-api' }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      (await fixture.database.query(`SELECT id FROM agent_grants WHERE target='paid-api'`)).rows,
    ).toEqual([]);
  });


  it('lets delegated turns use the same owner tool after a later owner turn', async () => {
    await fixture.database.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [AGENT]);
    const token = await fixture.phoneToken('delegated-member');
    const member = createHash('sha256').update('github:delegated-member').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: member,
      role: 'member',
    });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: member });
    const source = (await (
      await fixture.operation(
        'sendRoomMessage',
        { roomId: ROOM, text: '@bee use the resource', mentions: [AGENT] },
        token,
      )
    ).json()) as { messageId: string };
    const parent = (
      await fixture.database.query<any>(
        `SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
        [source.messageId, AGENT],
      )
    ).rows[0]!;
    const delegated = createHash('sha256').update('delegated-resource-task').digest('hex');
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Delegating agent')`, [WELCOME_AGENT]);
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES($1,$2,$3,'delegated task','message')`,
      [delegated, ROOM, WELCOME_AGENT],
    );
    await createAgentCommand(fixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: delegated,
      parent,
      reason: 'agent_mention',
    });
    // A newer owner turn must not replace the delegated turn's requester.
    const owner = (await (
      await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee my task', mentions: [AGENT] })
    ).json()) as { messageId: string };
    expect(
      (
        await (
          await fixture.daemonOperation('authorizeSquireCall', { roomId: ROOM, requestId: owner.messageId })
        ).json()
      ).allowed,
    ).toBe(true);
    const held = await (
      await fixture.daemonOperation('authorizeSquireCall', { roomId: ROOM, requestId: delegated })
    ).json();
    expect(held.allowed).toBe(true);
    expect(
      (await fixture.database.query(`SELECT 1 FROM agent_grants WHERE target='squire'`)).rowCount,
    ).toBe(0);
  });


  it('reuses an owner command grant on a third-party turn while requiring command authority', async () => {
    const ownerAsk = (await (
      await fixture.operation('sendRoomMessage', {
        roomId: ROOM,
        text: '@bee run tests',
        mentions: [AGENT],
      })
    ).json()) as { messageId: string };
    const grant = await (
      await fixture.daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        requestId: ownerAsk.messageId,
        kind: 'command',
        target: 'npm test',
        reason: 'test',
      })
    ).json();
    expect(grant.auto).toBe(true);
    const token = await fixture.phoneToken('command-member');
    const member = createHash('sha256').update('github:command-member').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: member,
      role: 'member',
    });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: member });
    const ask = (await (
      await fixture.operation(
        'sendRoomMessage',
        { roomId: ROOM, text: '@bee run tests', mentions: [AGENT] },
        token,
      )
    ).json()) as { messageId: string };
    expect(
      (
        await (
          await fixture.daemonOperation('listTurnAgentGrants', { roomId: ROOM, requestId: ask.messageId })
        ).json()
      ).grants.map((g: any) => g.grantId),
    ).toContain(grant.grantId);
    expect(
      (
        await (
          await fixture.daemonOperation('listTurnAgentGrants', {
            roomId: ROOM,
            requestId: ownerAsk.messageId,
          })
        ).json()
      ).grants.map((g: any) => g.grantId),
    ).toContain(grant.grantId);
    await fixture.database.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [AGENT]);
    expect(
      (
        await (
          await fixture.daemonOperation('listTurnAgentGrants', {
            roomId: ROOM,
            requestId: ownerAsk.messageId,
          })
        ).json()
      ).grants.map((g: any) => g.grantId),
    ).toContain(grant.grantId);
  });
});
