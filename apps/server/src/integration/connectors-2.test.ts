import { claimAgentCommand } from '.././agent-command.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrate } from '.././database.js';
import { isRoomView } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM, next } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: connectors', () => {
const fixture = monolithFixture();


  it('relays Squire-owned approval pages into the owner connector DM exactly once', async () => {
    const requestId = createHash('sha256').update('squire-purchase-approval').digest('hex');
    const payload = {
      roomId: ROOM,
      requestId,
      tool: 'inject_card',
      title: 'Purchase approval',
      detail: 'Noise-cancelling headphones · at Acme · 199.00 USD',
      approvalUrl: 'https://approve.trustysquire.test/approval/purchase-1',
      approvalId: 'purchase-1',
      linkKind: 'approval',
      expiresAt: Date.now() + 10 * 60_000,
    };
    const first = await fixture.daemonOperation('postSquireApproval', payload);
    expect(first.status).toBe(200);
    const duplicate = await fixture.daemonOperation('postSquireApproval', payload);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).id).toBe((await first.json()).id);

    const rows = await fixture.database.query<{
      room_id: string;
      author_id: string;
      card: {
        approvalUrl: string;
        title: string;
        detail: string;
        sourceRoomId: string;
        sourceMessageId: string;
        expiresAt: number;
      };
    }>(`SELECT room_id,author_id,card FROM messages WHERE card_type='squire-approval'`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.author_id).toBe(SYSTEM_IDENTITY_ID);
    expect(row.room_id).not.toBe(ROOM);
    expect(row.card).toMatchObject({
      approvalUrl: payload.approvalUrl,
      title: payload.title,
      detail: payload.detail,
      sourceRoomId: ROOM,
      sourceMessageId: requestId,
      expiresAt: payload.expiresAt,
    });
    const view = await fixture.phone.readRoom(row.room_id, HUMAN);
    expect(view?.messages.find((message) => message.squireApproval)?.squireApproval).toEqual(
      expect.objectContaining({ approvalUrl: payload.approvalUrl, detail: payload.detail }),
    );
  });


  it('wakes the paused turn with Squire’s own decision on an approval, approved or denied', async () => {
    const asked = (await (
      await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee buy the headphones', mentions: [AGENT] })
    ).json()) as { messageId: string };
    const approved = await fixture.daemonOperation('postSquireApprovalDecision', {
      roomId: ROOM,
      requestId: asked.messageId,
      approvalId: 'purchase-decided-1',
      status: 'approved',
      tool: 'inject_card',
      title: 'Purchase approval',
      detail: 'Noise-cancelling headphones · at Acme',
    });
    expect(approved.status).toBe(200);
    const rows = await fixture.database.query<{
      room_id: string;
      author_id: string;
      text: string;
      card: Record<string, unknown>;
      system_event: { kind?: string };
    }>(`SELECT room_id,author_id,text,card,system_event FROM messages WHERE card_type='squire-approval-decision'`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.room_id).toBe(ROOM);
    expect(row.author_id).toBe(SYSTEM_IDENTITY_ID);
    expect(row.text).toBe('The request to buy Noise-cancelling headphones was allowed');
    expect(row.system_event.kind).toBe('squire-approval-decided');
    expect(row.card).toMatchObject({
      approvalId: 'purchase-decided-1',
      tool: 'inject_card',
      title: 'Purchase approval',
      detail: 'Noise-cancelling headphones · at Acme',
      status: 'approved',
      agentId: AGENT,
    });
    const resume = await fixture.database.query<{ action: string; state: string }>(
      `SELECT action,state FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND action='resume'`,
      [ROOM, AGENT, asked.messageId],
    );
    expect(resume.rows).toEqual([{ action: 'resume', state: 'pending' }]);

    // A denial wakes the next paused turn the same way, carrying the denial.
    const askedAgain = (await (
      await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee buy it again', mentions: [AGENT] })
    ).json()) as { messageId: string };
    const denied = await fixture.daemonOperation('postSquireApprovalDecision', {
      roomId: ROOM,
      requestId: askedAgain.messageId,
      approvalId: 'purchase-decided-2',
      status: 'denied',
      tool: 'inject_card',
      title: 'Purchase approval',
      detail: 'A different item',
    });
    expect(denied.status).toBe(200);
    const deniedRow = (
      await fixture.database.query<{ text: string; card: Record<string, unknown> }>(
        `SELECT text,card FROM messages WHERE card_type='squire-approval-decision' AND card->>'approvalId'='purchase-decided-2'`,
      )
    ).rows[0]!;
    expect(deniedRow.text).toBe('The request to buy A different item was denied');
    expect(deniedRow.card).toMatchObject({ status: 'denied' });
    const resumeDenied = await fixture.database.query<{ action: string }>(
      `SELECT action FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND action='resume'`,
      [ROOM, AGENT, askedAgain.messageId],
    );
    expect(resumeDenied.rows).toEqual([{ action: 'resume' }]);

    // A vault approval nobody answered wakes the asking turn with its expiry.
    const askedVault = (await (
      await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee fetch the groq key', mentions: [AGENT] })
    ).json()) as { messageId: string };
    const expired = await fixture.daemonOperation('postSquireApprovalDecision', {
      roomId: ROOM,
      requestId: askedVault.messageId,
      approvalId: 'fetch-expired-1',
      status: 'expired',
      tool: 'fetch_credential',
      title: 'Credential access approval',
      detail: 'Reveal groq',
    });
    expect(expired.status).toBe(200);
    const expiredRow = (
      await fixture.database.query<{ text: string; card: Record<string, unknown> }>(
        `SELECT text,card FROM messages WHERE card_type='squire-approval-decision' AND card->>'approvalId'='fetch-expired-1'`,
      )
    ).rows[0]!;
    expect(expiredRow.text).toBe('The request to reveal a key expired');
    expect(expiredRow.card).toMatchObject({ status: 'expired', tool: 'fetch_credential' });
    const resumeExpired = await fixture.database.query<{ action: string }>(
      `SELECT action FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND action='resume'`,
      [ROOM, AGENT, askedVault.messageId],
    );
    expect(resumeExpired.rows).toEqual([{ action: 'resume' }]);
  });


  it('HOSTED-SQUIRE: expired sign-in remains actionable, retries with a fresh page and completes green', async () => {
    await fixture.database.query(`UPDATE agents SET machine_id='expiry-machine' WHERE agent_id=$1`, [AGENT]);
    const offer = await fixture.daemonOperation('offerConnector', { roomId: ROOM,
      connectorType: 'trusty-squire', reason: 'Use the hosted browser' });
    expect(offer.status).toBe(200);
    const { offerId, messageId } = await offer.json() as { offerId: string; messageId: string };
    const accept = await fixture.operation('acceptConnectorOffer', { offerId });
    expect(accept.status).toBe(200);
    const { connectorId } = await accept.json() as { connectorId: string };
    const assignment = async () => (await (await fixture.daemonOperation('getConnectorAssignments', {})).json() as {
      assignments: Array<{ pairingGeneration: number }> }).assignments[0]!;
    const first = await assignment();
    const expired = 'the Trusty Squire sign-in page expired before it was used · tap Retry to open a new one';
    expect((await fixture.daemonOperation('postConnectorStatus', { connectorId, pairingGeneration: first.pairingGeneration,
      steps: [{ label: 'waiting for sign-in', status: 'failed', reason: expired }], signIn: null,
      errorMessage: expired })).status).toBe(200);
    const read = async () => (await (await fixture.operation('readConnectorInstall', { connectorId })).json() as {
      status: { status: string; steps: Array<{ status: string; reason?: string }>; signIn?: { url: string }; errorMessage?: string } }).status;
    expect(await read()).toMatchObject({ status: 'error', steps: [{ status: 'failed', reason: expired }] });
    expect((await fixture.operation('acceptConnectorOffer', { offerId })).status).toBe(200);
    const next = await assignment();
    expect(next.pairingGeneration).toBeGreaterThan(first.pairingGeneration);
    expect(await read()).toMatchObject({ status: 'installing' });
    expect(await read()).not.toHaveProperty('errorMessage');
    expect((await fixture.daemonOperation('postConnectorStatus', { connectorId, pairingGeneration: next.pairingGeneration,
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      signIn: { method: 'oauth', url: 'https://trustysquire.ai/install?token=fresh' } })).status).toBe(200);
    expect(await read()).toMatchObject({ status: 'installing', signIn: { url: 'https://trustysquire.ai/install?token=fresh' } });
    expect((await fixture.daemonOperation('installConnector', { connectorId, pairingGeneration: next.pairingGeneration })).status).toBe(200);
    expect((await fixture.daemonOperation('postConnectorVault', { connections: [] })).status).toBe(200);
    expect(await read()).toMatchObject({ status: 'connected', steps: [] });
    expect(await read()).not.toHaveProperty('signIn');
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === messageId)?.connectorOffer?.status).toBe('accepted');
  });


  it.each(['trusty-squire', 'tailscale'] as const)('HOSTED-SQUIRE: %s reported install failure settles the phone card and allows an explicit retry', async (connectorType) => {
    await fixture.database.query(`UPDATE agents SET machine_id='proof-machine' WHERE agent_id=$1`, [AGENT]);
    const asked = (await (await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee connect Trusty Squire', mentions: [AGENT] })).json()) as { messageId: string };
    const offered = await fixture.daemonOperation('offerConnector', { roomId: ROOM, requestId: asked.messageId,
      connectorType, reason: 'make the welcome video' });
    expect(offered.status).toBe(200);
    const { offerId, messageId } = await offered.json() as { offerId: string; messageId: string };
    const accepted = await fixture.operation('acceptConnectorOffer', { offerId });
    expect(accepted.status).toBe(200);
    const { connectorId } = await accepted.json() as { connectorId: string };
    const assignments = await (await fixture.daemonOperation('getConnectorAssignments', { agentId: AGENT })).json() as {
      assignments: Array<{ pairingGeneration: number }> };
      const report = await fixture.daemonOperation('postConnectorStatus', { connectorId,
        pairingGeneration: assignments.assignments[0]!.pairingGeneration, steps: [], errorMessage: 'Squire MCP connection closed' });
      expect(report.status).toBe(200);

    const room = await fixture.phone.readRoom(ROOM, HUMAN);
    expect(isRoomView(room)).toBe(true);
    expect(room?.messages.find(message => message.id === messageId)?.connectorOffer?.status).toBe('failed');
    expect((await fixture.database.query(`SELECT 1 FROM connector_offers WHERE id=$1 AND status='failed'`, [offerId])).rowCount).toBe(1);
    expect((await fixture.database.query(`SELECT 1 FROM messages WHERE room_id=$1 AND card_type='connector-offer-decision'
      AND card->>'status'='failed'`, [ROOM])).rowCount).toBe(1);
    expect((await (await fixture.daemonOperation('getConnectorAssignments', { agentId: AGENT })).json() as { assignments: unknown[] }).assignments).toEqual([]);
    const retried = await fixture.operation('acceptConnectorOffer', { offerId });
    expect(retried.status).toBe(200);
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === messageId)?.connectorOffer?.status).toBe('connecting');
    // A failed retry frees the slot for a fresh offer by the resumed agent.
    const nextAssignments = await (await fixture.daemonOperation('getConnectorAssignments', { agentId: AGENT })).json() as { assignments: Array<{ pairingGeneration: number }> };
    expect((await fixture.daemonOperation('postConnectorStatus', { connectorId,
      pairingGeneration: nextAssignments.assignments[0]!.pairingGeneration, steps: [], errorMessage: 'Retry failed' })).status).toBe(200);
    const fresh = await fixture.daemonOperation('offerConnector', { roomId: ROOM, requestId: asked.messageId,
      connectorType, reason: 'retry the welcome video' });
    expect(fresh.status).toBe(200);
    const replacement = await fresh.json() as { offerId: string; messageId: string };
    expect(replacement.offerId).not.toBe(offerId);
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === messageId)?.connectorOffer)
      .toMatchObject({ status: 'failed', replacementMessageId: replacement.messageId });
    // Upgrade repairs pre-existing failed cards too, without rearming an install.
    await fixture.database.query(`UPDATE messages SET card=card-'replacementMessageId' WHERE id=$1`, [messageId]);
    await migrate(fixture.database);
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === messageId)?.connectorOffer)
      .toMatchObject({ status: 'failed', replacementMessageId: replacement.messageId });
    expect((await fixture.operation('acceptConnectorOffer', { offerId })).status).toBe(409);
  });


  it('APPROVAL-V3: declining a connector closes the offer and resumes its asking command', async () => {
    const offerId = '99999999-9999-4999-8999-999999999999';
    const messageId = 'e'.repeat(64);
    const asked = (await (await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee add a connector', mentions: [AGENT] })).json()) as { messageId: string };
    const command = (await fixture.database.query<{ id: string }>(`SELECT id FROM agent_commands WHERE turn_request_id=$1 AND agent_id=$2`, [asked.messageId, AGENT])).rows[0]!;
    await fixture.database.query(`INSERT INTO connector_offers(id,agent_id,workspace_id,room_id,addressee_id,connector_type,reason,machine_id,status,command_id) VALUES($1,$2,$3,$4,$5,'trusty-squire','Use a test connector','proof-machine','pending',$6)`, [offerId, AGENT, WORKSPACE, ROOM, HUMAN, command.id]);
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card) VALUES($1,$2,$3,'Connector ask','card','connector-offer',$4::jsonb)`, [messageId, ROOM, AGENT, JSON.stringify({ offerId, agent: { pubkey: AGENT, kind: 'agent', name: 'Bee' }, addressee: { pubkey: HUMAN, kind: 'human', name: 'Owner' }, connectorName: 'Trusty Squire', connectorType: 'trusty-squire', status: 'pending' })]);
    expect((await fixture.operation('decideApprovalCard', { roomId: ROOM, messageId, decision: 'deny' })).status).toBe(200);
    expect((await fixture.database.query(`SELECT status FROM connector_offers WHERE id=$1`, [offerId])).rows).toEqual([{ status: 'denied' }]);
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === messageId)?.connectorOffer).toMatchObject({ status: 'denied', acceptedBy: { pubkey: HUMAN } });
    expect((await fixture.database.query(`SELECT action FROM agent_commands WHERE room_id=$1 AND turn_request_id=$2 AND action='resume'`, [ROOM, asked.messageId])).rows).toEqual([{ action: 'resume' }]);
  });


  it("lets another human trigger the agent owner's mounted Squire without a card", async () => {
    const MACHINE = 'machine-squire-box';
    const SIBLING = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Wasp','wasp')`,
      [SIBLING],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,$3)`, [
      SIBLING,
      HUMAN,
      MACHINE,
    ]);
    await fixture.database.query(`UPDATE agents SET machine_id=$2 WHERE agent_id=$1`, [AGENT, MACHINE]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, SIBLING],
    );

    expect(
      (
        await fixture.operation('pairConnector', {
          workspaceId: WORKSPACE,
          connectorType: 'trusty-squire',
          helperAgentId: AGENT,
        })
      ).status,
    ).toBe(200);

    const machineGrants = await fixture.database.query<{
      agent_id: string;
      requested_by: string;
      decided_by: string;
      status: string;
      kind: string;
      target: string;
    }>(
      `SELECT agent_id,requested_by,decided_by,status,kind,target FROM agent_grants
       WHERE kind='mcp' AND target='squire' AND status='approved' ORDER BY agent_id`,
    );
    expect(machineGrants.rows).toEqual([
      expect.objectContaining({
        agent_id: AGENT,
        requested_by: HUMAN,
        decided_by: HUMAN,
        status: 'approved',
        kind: 'mcp',
        target: 'squire',
      }),
      expect.objectContaining({
        agent_id: SIBLING,
        requested_by: HUMAN,
        decided_by: HUMAN,
        status: 'approved',
        kind: 'mcp',
        target: 'squire',
      }),
    ]);

    const mounted = (await (await fixture.daemonOperation('listAgentGrants', { roomId: ROOM })).json()) as {
      grants: Array<{ kind: string; target: string; requestedBy: string }>;
    };
    expect(mounted.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'mcp', target: 'squire', requestedBy: HUMAN }),
      ]),
    );

    const memberToken = await fixture.phoneToken('squire-caller');
    const requesterId = createHash('sha256').update('github:squire-caller').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: requesterId,
      role: 'member',
    });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: requesterId });
    const sourceId = createHash('sha256').update('squire-non-owner-call').digest('hex');
    expect(
      (
        await fixture.operation(
          'sendRoomMessage',
          {
            roomId: ROOM,
            messageId: sourceId,
            text: '@bee use Squire',
            mentions: [AGENT],
          },
          memberToken,
        )
      ).status,
    ).toBe(200);

    const allowed = (await (
      await fixture.daemonOperation('authorizeSquireCall', { roomId: ROOM, requestId: sourceId })
    ).json()) as { allowed: boolean };
    expect(allowed.allowed).toBe(true);
    expect(
      (await fixture.database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows,
    ).toEqual([]);
  });


  it('keeps a live turn running when Squire allows its key reveal, then resumes it once with the approval named', async () => {
    // Reproduction squire-decision-live-turn: corner fbcbb6cc, 2026-10-30 02:24 UTC.
    // The decision completed the still-running turn's command, its next
    // heartbeat lost output authority, the helper dropped the turn, and the
    // resume for that same request id never ran.
    const asked = (await (
      await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee fetch the test login', mentions: [AGENT] })
    ).json()) as { messageId: string };
    const parent = (await fixture.database.query<{ id: string }>(
      `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3`,
      [ROOM, AGENT, asked.messageId],
    )).rows[0]!;
    await fixture.database.transaction((tx) => claimAgentCommand(tx, ROOM, AGENT, parent.id, 'live-generation'));
    const decision = {
      roomId: ROOM,
      requestId: asked.messageId,
      approvalId: 'reveal-live-1',
      status: 'approved',
      tool: 'fetch_credential',
      title: 'Reveal a key',
      detail: 'google.com / default',
    };
    expect((await fixture.daemonOperation('postSquireApprovalDecision', decision)).status).toBe(200);
    // A repeated relay of the same decision never queues a second turn.
    expect((await fixture.daemonOperation('postSquireApprovalDecision', decision)).status).toBe(200);
    const states = await fixture.database.query<{ action: string; state: string }>(
      `SELECT action,state FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 ORDER BY created_at`,
      [ROOM, AGENT, asked.messageId],
    );
    expect(states.rows).toEqual([
      { action: 'input', state: 'claimed' },
      { action: 'resume', state: 'pending' },
    ]);
    const heartbeat = await fixture.request('/v1/daemon/operations/postAgentTurnReceipt', 'POST', {
      roomId: ROOM, requestId: asked.messageId, status: 'working', generationId: 'live-generation', heartbeat: true,
    }, fixture.daemonToken);
    expect(heartbeat.status).toBe(200);
    const finished = await fixture.request('/v1/daemon/operations/postAgentTurnReceipt', 'POST', {
      roomId: ROOM, requestId: asked.messageId, status: 'complete', generationId: 'live-generation',
    }, fixture.daemonToken);
    expect(finished.status).toBe(200);
    const page = (await (await fixture.daemonOperation('getAgentCommands', { roomId: ROOM })).json()) as {
      commands: { action: string; turnRequestId: string; source: { body: string } }[];
    };
    const resume = page.commands.filter((command) => command.turnRequestId === asked.messageId);
    expect(resume).toHaveLength(1);
    expect(resume[0]!.action).toBe('resume');
    expect(resume[0]!.source.body).toContain(
      'Squire approval reveal-live-1 for fetch_credential: approved. Call fetch_credential with action "resume" and approval_id "reveal-live-1" now',
    );
  });


  it('starts a turn for an ended asker only when Squire allowed the request', async () => {
    const asked = (await (
      await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee fetch the other login', mentions: [AGENT] })
    ).json()) as { messageId: string };
    await fixture.database.query(
      `UPDATE agent_commands SET state='complete',completed_at=now() WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3`,
      [ROOM, AGENT, asked.messageId],
    );
    const decide = (approvalId: string, status: string) => fixture.daemonOperation('postSquireApprovalDecision', {
      roomId: ROOM, requestId: asked.messageId, approvalId, status,
      tool: 'fetch_credential', title: 'Reveal a key', detail: 'google.com / default',
    });
    const resumes = async () => (await fixture.database.query<{ state: string; source_message_id: string }>(
      `SELECT state,source_message_id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND turn_request_id=$3 AND action='resume'`,
      [ROOM, AGENT, asked.messageId],
    )).rows;
    expect((await decide('reveal-ended-denied', 'denied')).status).toBe(200);
    expect((await decide('reveal-ended-expired', 'expired')).status).toBe(200);
    expect(await resumes()).toEqual([]);
    const allowed = (await (await decide('reveal-ended-approved', 'approved')).json()) as { id: string };
    expect((await decide('reveal-ended-approved', 'approved')).status).toBe(200);
    expect(await resumes()).toEqual([{ state: 'pending', source_message_id: allowed.id }]);
  });
});
