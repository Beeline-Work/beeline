import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PushDeliveryLoop } from '.././background.js';
import { isRoomView, type RoomView } from '@beeline/api-contract/phone';
import { taggedIdentityIdsSql } from '.././message-mentions.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: connectors', () => {
const fixture = monolithFixture();


  it.each(['pending', 'connecting'] as const)(
    'CONNECTOR-OFFER-1: reuses a %s offer and preserves agent and intent boundaries', async (status) => {
      await fixture.daemonOperation('postAgentMachineReport', {
        machineId: 'connector-offer-repro', machineName: 'test-machine',
      });
      const input = { roomId: ROOM, connectorType: 'trusty-squire', reason: 'complete setup' };
      const created = await fixture.daemonOperation('offerConnector', input);
      expect(created.status).toBe(200);
      const offer = await created.json() as { offerId: string; messageId: string };
      await fixture.database.query(`UPDATE connector_offers SET status=$2 WHERE id=$1`, [offer.offerId, status]);
      const originalCard = (await fixture.database.query(`SELECT card FROM messages WHERE id=$1`, [offer.messageId])).rows;

      const repeated = await fixture.daemonOperation('offerConnector', input);
      expect(await repeated.json()).toMatchObject({ offerId: offer.offerId, messageId: offer.messageId, joined: true });
      expect(repeated.status).toBe(200);

      // An existing reconnect/switch card must not be joined by an add request.
      for (const intent of ['reconnect', 'switch']) {
        await fixture.database.query(`UPDATE connector_offers SET intent=$2 WHERE id=$1`, [offer.offerId, intent]);
        const incompatible = await fixture.daemonOperation('offerConnector', input);
        expect(incompatible.status).toBe(409);
        expect(await incompatible.json()).toMatchObject({ error: expect.stringContaining('another Trusty Squire card is already open') });
      }
      await fixture.database.query(`UPDATE connector_offers SET intent='add' WHERE id=$1`, [offer.offerId]);

      const other = 'd'.repeat(64);
      await fixture.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Fixture','fixture')`, [other]);
      await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [other, HUMAN]);
      await fixture.database.query(`UPDATE connector_offers SET agent_id=$2 WHERE id=$1`, [offer.offerId, other]);
      const differentAgent = await fixture.daemonOperation('offerConnector', input);
      expect(differentAgent.status).toBe(409);
      expect(await differentAgent.json()).toMatchObject({ error: expect.stringContaining('already offered Trusty Squire here') });

      expect((await fixture.database.query(`SELECT id,status,message_id FROM connector_offers WHERE room_id=$1`, [ROOM])).rows)
        .toEqual([{ id: offer.offerId, status, message_id: offer.messageId }]);
      expect((await fixture.database.query(`SELECT card FROM messages WHERE id=$1`, [offer.messageId])).rows).toEqual(originalCard);
      expect((await fixture.database.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='connector-offer'`, [ROOM])).rows)
        .toEqual([{ id: offer.messageId }]);
    },
  );


  it('runs the connector offer loop (R5): card addressed to the person, one affirmative tap gated to addressee or manager, pairing on the offering machine, settled card naming who acted, hidden resume line', async () => {
    const send = vi.fn(async () => undefined);
    const pushes = new PushDeliveryLoop(fixture.database, { send });
    await pushes.runOnce();
    const person = async (login: string, role: 'member' | 'admin') => {
      const token = await fixture.phoneToken(login);
      const id = createHash('sha256').update(`github:${login}`).digest('hex');
      await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId: id, role });
      await fixture.operation('addRoomMember', { roomId: ROOM, memberId: id });
      return { token, id };
    };
    const zeke = await person('zeke', 'member'); // the addressee: the key will be theirs
    const bystander = await person('bystander', 'member'); // neither addressee nor manager
    const mara = await person('mara', 'admin'); // a Workspace manager
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('offer-addressee-device-12345678901234567890',$1,'android','physical')`,
      [zeke.id],
    );
    // The offering agent has reported its machine: that is where the tool installs.
    expect(
      (
        await fixture.daemonOperation('postAgentMachineReport', {
          machineId: 'machine-otter-1',
          machineName: 'otter-laptop',
        })
      ).status,
    ).toBe(200);
    const ask = (await (
      await fixture.operation(
        'sendRoomMessage',
        {
          roomId: ROOM,
          text: '@bee can you install trusty squire so you can get the keys for me?',
          mentions: [AGENT],
        },
        zeke.token,
      )
    ).json()) as { messageId: string };
    await pushes.runOnce();
    send.mockClear();

    // workbench_status: the agent learns what the Workbench can add and that
    // the person it answers has nothing yet — names only, never a secret.
    const status = (await (
      await fixture.daemonOperation('readAgentWorkbench', { roomId: ROOM })
    ).json()) as {
      addressee: { identityId: string; name: string; handle?: string };
      owner: { identityId: string; name: string; handle?: string };
      catalog: Array<{
        connectorType: string;
        offerable: boolean;
        available: boolean;
        purpose: string;
        paired?: unknown;
      }>;
      connections: unknown[];
      machine: { machineId: string; name: string };
    };
    expect(status.addressee).toEqual({ identityId: zeke.id, name: 'Zeke', handle: 'zeke' });
    expect(status.owner).toEqual({ identityId: HUMAN, name: 'Owner', handle: 'owner' });
    expect(status.machine).toEqual({ machineId: 'machine-otter-1', name: 'otter-laptop' });
    expect(status.connections).toEqual([]);
    const squire = status.catalog.find((entry) => entry.connectorType === 'trusty-squire');
    expect(squire).toEqual(
      expect.objectContaining({ offerable: true, available: true, purpose: expect.any(String) }),
    );
    expect(squire?.paired).toBeUndefined();
    // The wallet is offerable: accepting its card is the addressee's grant to sign.
    expect(status.catalog.find((entry) => entry.connectorType === 'wallet')?.offerable).toBe(true);
    expect(status.catalog.find((entry) => entry.connectorType === 'tailscale')?.offerable).toBe(
      true,
    );

    // Refusals at offer time are the tool's error, not a card.
    expect(
      (
        await fixture.daemonOperation('offerConnector', {
          roomId: ROOM,
          requestId: ask.messageId,
          connectorType: 'nonsense',
          reason: 'hold funds',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture.daemonOperation('offerConnector', {
          roomId: ROOM,
          requestId: ask.messageId,
          connectorType: 'trusty-squire',
          reason: '   ',
        })
      ).status,
    ).toBe(400);

    // The offer: ONE card, spoken by the agent, addressed to the person it answers.
    const offer = (await (
      await fixture.daemonOperation('offerConnector', {
        roomId: ROOM,
        requestId: ask.messageId,
        connectorType: 'trusty-squire',
        reason: 'provision the 1inch API key into its vault',
      })
    ).json()) as { offerId: string; status: string; messageId: string; joined: boolean };
    expect(offer).toEqual({
      offerId: expect.any(String),
      status: 'pending',
      messageId: expect.any(String),
      joined: false,
    });
    // A repeat of the same offer joins the open card instead of posting a second.
    const repeat = (await (
      await fixture.daemonOperation('offerConnector', {
        roomId: ROOM,
        requestId: ask.messageId,
        connectorType: 'trusty-squire',
        reason: 'provision the 1inch API key into its vault',
      })
    ).json()) as { offerId: string; messageId: string; joined: boolean };
    expect(repeat).toEqual({
      offerId: offer.offerId,
      status: 'pending',
      messageId: offer.messageId,
      joined: true,
    });
    const cards = await fixture.database.query<{
      id: string;
      author_id: string;
      text: string;
      tagged_ids: string[];
      presentation: string;
      card: Record<string, any>;
    }>(
      `SELECT id,author_id,text,${taggedIdentityIdsSql('messages')} tagged_ids,presentation,card
       FROM messages WHERE card_type='connector-offer'`,
    );
    expect(cards.rows).toHaveLength(1);
    const card = cards.rows[0]!;
    expect(card.id).toBe(offer.messageId);
    expect(card.author_id).toBe(AGENT);
    expect(card.presentation).toBe('card');
    expect(card.tagged_ids).toEqual([]);
    expect(card.text).toBe(
      '@bee offered @zeke Trusty Squire · provision the 1inch API key into its vault',
    );
    expect(card.card).toEqual(
      expect.objectContaining({
        offerId: offer.offerId,
        status: 'pending',
        connectorType: 'trusty-squire',
        connectorName: 'Trusty Squire',
        reason: 'provision the 1inch API key into its vault',
        helper: { machineId: 'machine-otter-1', name: 'otter-laptop' },
      }),
    );
    expect(card.card.agent.pubkey).toBe(AGENT);
    expect(card.card.addressee.pubkey).toBe(zeke.id);
    // The consequence and the standing boundary, together, in one server-owned line.
    expect(card.card.consequence).toMatch(/^This changes your Connectors\./);
    expect(card.card.consequence).toContain('still no raw key in chat');
    expect(card.card.consequence).toContain('provision the 1inch API key into its vault');
    // The offer is linked to the turn it paused, so the accept can resume it.
    const linked = await fixture.database.query<{ command_id: string | null; addressee_id: string }>(
      `SELECT command_id,addressee_id FROM connector_offers WHERE id::text=$1`,
      [offer.offerId],
    );
    expect(linked.rows[0]!.addressee_id).toBe(zeke.id);
    expect(linked.rows[0]!.command_id).toEqual(expect.any(String));
    // Cards stay on the indexed surfaces; only the four push categories
    // (DMs, tags, replies, member lifecycle) reach a device.
    expect(await pushes.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // The phone reads a validated connectorOffer message.
    const pending = (await (
      await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET', undefined, zeke.token)
    ).json()) as RoomView;
    expect(isRoomView(pending)).toBe(true);
    const pendingCard = pending.messages.find((message) => message.connectorOffer);
    expect(pendingCard?.connectorOffer).toEqual(
      expect.objectContaining({ offerId: offer.offerId, status: 'pending' }),
    );

    // Neither the addressee nor a manager: the tap is refused and nothing changes.
    const refused = await fixture.operation(
      'acceptConnectorOffer',
      { offerId: offer.offerId },
      bystander.token,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'Only the person the agent addressed or a workspace admin can add this tool',
    });
    expect(
      (
        await fixture.database.query(`SELECT 1 FROM workspace_connectors WHERE workspace_id=$1`, [
          WORKSPACE,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await fixture.database.query<{ status: string }>(
          `SELECT status FROM connector_offers WHERE id::text=$1`,
          [offer.offerId],
        )
      ).rows[0]!.status,
    ).toBe('pending');

    // The addressee does not own the offering helper, so Squire pairing is refused.
    const refusedCrossOwner = await fixture.operation(
      'acceptConnectorOffer',
      { offerId: offer.offerId },
      zeke.token,
    );
    expect(refusedCrossOwner.status).toBe(403);
    expect(await refusedCrossOwner.json()).toEqual({
      error: 'connector not found (access denied)',
    });
    // The helper owner accepts: the connector pairs on that machine through
    // the same row Connect writes.
    const accepted = await fixture.operation('acceptConnectorOffer', { offerId: offer.offerId });
    expect(accepted.status).toBe(200);
    const acceptance = (await accepted.json()) as {
      connectorId: string;
      roomId: string;
      status: string;
    };
    expect(acceptance).toEqual({
      offerId: offer.offerId,
      status: 'connecting',
      roomId: ROOM,
      connectorId: expect.any(String),
    });
    const connector = (
      await fixture.database.query<{
        owner_identity_id: string;
        helper_agent_id: string;
        machine_id: string;
        status: string;
        connector_type: string;
      }>(
        `SELECT owner_id owner_identity_id,agent_id helper_agent_id,machine_id,
           CASE WHEN (squire_work->>'install')::boolean THEN 'installing'
             ELSE squire_report->>'status' END status,'trusty-squire' connector_type
         FROM agents WHERE 'squire:' || COALESCE(machine_id,agent_id)=$1`,
        [acceptance.connectorId],
      )
    ).rows[0];
    expect(connector).toEqual({
      owner_identity_id: HUMAN,
      helper_agent_id: AGENT,
      machine_id: 'machine-otter-1',
      status: 'installing',
      connector_type: 'trusty-squire',
    });
    // The offering agent's daemon sees the install on its next poll.
    const assignments = (await (
      await fixture.daemonOperation('getConnectorAssignments', { agentId: AGENT })
    ).json()) as { assignments: Array<{ kind: string; connectorId: string }> };
    expect(assignments.assignments).toEqual([
      expect.objectContaining({ kind: 'install', connectorId: acceptance.connectorId }),
    ]);
    // The same actor can retry the ceremony after an install failure without
    // minting a second connector row or prematurely resuming the turn.
    const retry = await fixture.operation('acceptConnectorOffer', { offerId: offer.offerId });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      ...acceptance,
      status: 'connecting',
    });
    // A second tap is a conflict, not a second pairing.
    expect(
      (await fixture.operation('acceptConnectorOffer', { offerId: offer.offerId }, mara.token)).status,
    ).toBe(409);
    // Accepting starts the full ceremony but does not answer the paused turn.
    // The card records who is connecting, while no hidden decision or resume
    // exists until the helper reports that sign-in actually completed.
    const connecting = await fixture.database.query<{ id: string; card: Record<string, any> }>(
      `SELECT id,card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(connecting.rows).toHaveLength(1);
    expect(connecting.rows[0]!.id).toBe(offer.messageId);
    expect(connecting.rows[0]!.card).toEqual(
      expect.objectContaining({
        status: 'connecting',
        acceptedAt: expect.any(Number),
        connectorId: acceptance.connectorId,
      }),
    );
    expect(connecting.rows[0]!.card.acceptedBy).toEqual(
      expect.objectContaining({ pubkey: HUMAN, kind: 'human', name: 'Owner', handle: 'owner' }),
    );
    expect(
      await fixture.database.query(
        `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='connector-offer-decision'`,
        [ROOM],
      ),
    ).toEqual(expect.objectContaining({ rowCount: 0 }));
    expect(
      await fixture.database.query(
        `SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='resume'`,
        [ROOM, AGENT],
      ),
    ).toEqual(expect.objectContaining({ rowCount: 0 }));

    // A working vault alone cannot complete an outstanding sign-in ceremony.
    expect((await fixture.daemonOperation('postConnectorVault', { connections: [] })).status).toBe(200);
    expect((await fixture.database.query(`SELECT status FROM connector_offers WHERE id=$1`,
      [offer.offerId])).rows[0]).toEqual({ status: 'connecting' });

    // Completing sign-in is the acceptance boundary: the helper's connected
    // report settles the card and only then resumes the paused agent.
    expect(
      (await fixture.daemonOperation('installConnector', { connectorId: acceptance.connectorId, pairingGeneration: 2 })).status,
    ).toBe(200);
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const settled = await fixture.database.query<{ id: string; card: Record<string, any> }>(
      `SELECT id,card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(settled.rows[0]!.card).toEqual(
      expect.objectContaining({ status: 'accepted', connectorId: acceptance.connectorId }),
    );
    // One hidden line resumes the paused turn: it reaches the agent's inbox as
    // a RESUME kind and is never drawn in the Room (C101).
    const inbox = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: ROOM, after: undefined })
    ).json()) as {
      items: Array<{ type: string; body: string; authorId: string; systemEvent?: unknown }>;
    };
    const decision = inbox.items.filter(
      (item) => item.type === 'system' && /\badded\b/.test(item.body),
    );
    expect(decision.map((item) => item.body)).toEqual(['@owner added Trusty Squire']);
    expect(decision[0]!.authorId).toBe(HUMAN);
    expect(decision[0]!.systemEvent).toEqual({
      subject: { kind: 'person', id: HUMAN, name: '@owner' },
      verb: 'added',
      kind: 'connector-offer-decided',
      object: { text: 'Trusty Squire' },
    });
    const resume = await fixture.database.query<{ action: string; state: string }>(
      `SELECT action,state FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='resume'`,
      [ROOM, AGENT],
    );
    expect(resume.rows).toEqual([{ action: 'resume', state: 'pending' }]);
    expect(await pushes.runOnce()).toBe(0);
    for (const token of [zeke.token, fixture.accessToken]) {
      const room = (await (
        await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET', undefined, token)
      ).json()) as RoomView;
      expect(isRoomView(room)).toBe(true);
      expect(
        room.messages.filter((message) => /\badded Trusty Squire\b/.test(message.text)),
      ).toEqual([]);
      const settledCard = room.messages.find((message) => message.connectorOffer);
      expect(settledCard?.connectorOffer).toEqual(
        expect.objectContaining({
          status: 'accepted',
          acceptedBy: expect.objectContaining({ pubkey: HUMAN, name: 'Owner' }),
          connectorId: acceptance.connectorId,
        }),
      );
    }
    const history = (await (await fixture.request(`/v1/phone/rooms/${ROOM}/history`)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(
      history.messages.filter((message) => /\badded Trusty Squire\b/.test(message.text)),
    ).toEqual([]);
    // The helper owner now has the tool; a fresh offer of it is refused, and
    // workbench_status says so.
    const duplicate = await fixture.daemonOperation('offerConnector', {
      roomId: ROOM,
      requestId: ask.messageId,
      connectorType: 'trusty-squire',
      reason: 'provision the 1inch API key into its vault',
    });
    expect(duplicate.status).toBe(409);
    const after = (await (
      await fixture.daemonOperation('readAgentWorkbench', { roomId: ROOM })
    ).json()) as { catalog: Array<{ connectorType: string; paired?: Record<string, unknown> }> };
    expect(after.catalog.find((entry) => entry.connectorType === 'trusty-squire')?.paired).toBeUndefined();

    // Workspace managers can settle ordinary connector offers, but Google
    // credentials belong to the agent's human owner.
    const gmailAsk = (await (
      await fixture.operation(
        'sendRoomMessage',
        { roomId: ROOM, text: '@bee read my inbox for me', mentions: [AGENT] },
        zeke.token,
      )
    ).json()) as { messageId: string };
    const gmail = await fixture.daemonOperation('offerConnector', {
      roomId: ROOM,
      requestId: gmailAsk.messageId,
      connectorType: 'google-gmail',
      reason: 'read the inbox you asked about',
    });
    expect(gmail.status).toBe(400);
  });


  it('offers a switch of the bound Squire account and re-arms it with force-relogin on the tap', async () => {
    expect(
      (
        await fixture.daemonOperation('postAgentMachineReport', {
          machineId: 'machine-otter-switch',
          machineName: 'otter-laptop',
        })
      ).status,
    ).toBe(200);
    const ask = (await (
      await fixture.operation('sendRoomMessage', {
        roomId: ROOM,
        text: '@bee switch squire to my work google account',
        mentions: [AGENT],
      })
    ).json()) as { messageId: string };
    const offerSwitch = () =>
      fixture.daemonOperation('offerConnector', {
        roomId: ROOM,
        requestId: ask.messageId,
        connectorType: 'trusty-squire',
        reason: 'sign up for Vercel with your work account',
        intent: 'switch',
      });
    // Nothing is bound yet: there is no account to switch.
    const unbound = await offerSwitch();
    expect(unbound.status).toBe(400);
    expect(((await unbound.json()) as { error: string }).error).toContain('no connected Trusty Squire');
    expect(
      (
        await fixture.daemonOperation('offerConnector', {
          roomId: ROOM,
          requestId: ask.messageId,
          connectorType: 'tailscale',
          reason: 'x',
          intent: 'switch',
        })
      ).status,
    ).toBe(400);

    await fixture.daemonOperation('postAgentMachineReport', { machineId: 'machine-otter-switch', machineName: 'otter-laptop' });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const connector = { id: 'squire:machine-otter-switch' };
    const posted = await offerSwitch();
    expect(posted.status).toBe(200);
    const offer = (await posted.json()) as { offerId: string; messageId: string; joined: boolean };
    expect(offer.joined).toBe(false);
    // Posting asks; it does not touch the bound session yet.
    expect(
      (
        await fixture.database.query<{ status: string; force_relogin_provider: string | null }>(
          `SELECT CASE WHEN (squire_work->>'install')::boolean THEN 'installing' ELSE squire_report->>'status' END status,squire_work->>'forceReloginProvider' force_relogin_provider FROM agents WHERE 'squire:' || COALESCE(machine_id,agent_id)=$1`,
          [connector.id],
        )
      ).rows[0],
    ).toEqual({ status: 'connected', force_relogin_provider: null });
    const card = (
      await fixture.database.query<{ text: string; card: Record<string, any> }>(
        `SELECT text,card FROM messages WHERE id=$1`,
        [offer.messageId],
      )
    ).rows[0]!;
    expect(card.text).toBe(
      "@bee asked @owner to switch Trusty Squire's Google account · sign up for Vercel with your work account",
    );
    expect(card.card).toEqual(
      expect.objectContaining({
        status: 'pending',
        intent: 'switch',
        provider: 'google',
        connectorType: 'trusty-squire',
        consequence:
          "You'll sign in to Google again, with the account Trusty Squire should use. The account signed in now is replaced for every task on this machine. Then I can sign up for Vercel with your work account",
      }),
    );
    expect(((await (await offerSwitch()).json()) as { joined: boolean }).joined).toBe(true);

    // The tap re-arms the SAME connector with Squire's own --force-relogin.
    const accepted = await fixture.operation('acceptConnectorOffer', { offerId: offer.offerId });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { connectorId: string }).connectorId).toBe(connector.id);
    expect(
      (
        await fixture.database.query<{ status: string; force_relogin_provider: string | null }>(
          `SELECT CASE WHEN (squire_work->>'install')::boolean THEN 'installing' ELSE squire_report->>'status' END status,squire_work->>'forceReloginProvider' force_relogin_provider FROM agents WHERE 'squire:' || COALESCE(machine_id,agent_id)=$1`,
          [connector.id],
        )
      ).rows[0],
    ).toEqual({ status: 'installing', force_relogin_provider: 'google' });
    const assignments = (await (
      await fixture.daemonOperation('getConnectorAssignments', { agentId: AGENT })
    ).json()) as {
      assignments: Array<{ kind: string; connectorId: string; forceReloginProvider?: string }>;
    };
    expect(assignments.assignments).toEqual([
      expect.objectContaining({
        kind: 'install',
        connectorId: connector.id,
        forceReloginProvider: 'google',
      }),
    ]);

    // The helper's connected report settles the card and clears the flag.
    expect((await fixture.daemonOperation('installConnector', { connectorId: connector.id, pairingGeneration: Number((await fixture.database.query<{ generation: string }>(`SELECT squire_work->>'generation' generation FROM agents WHERE agent_id=$1`, [AGENT])).rows[0]!.generation) })).status).toBe(
      200,
    );
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const settled = (
      await fixture.database.query<{ card: Record<string, any> }>(`SELECT card FROM messages WHERE id=$1`, [
        offer.messageId,
      ])
    ).rows[0]!;
    expect(settled.card).toEqual(expect.objectContaining({ status: 'accepted', intent: 'switch' }));
    expect(
      (
        await fixture.database.query<{ force_relogin_provider: string | null }>(
          `SELECT squire_work->>'forceReloginProvider' force_relogin_provider FROM agents WHERE 'squire:' || COALESCE(machine_id,agent_id)=$1`,
          [connector.id],
        )
      ).rows[0]!.force_relogin_provider,
    ).toBeNull();
  });


  it('posts a reconnect card from a Squire google_session wall and resumes the stuck turn once it reconnects', async () => {
    // Squire is ALREADY connected for this owner/agent — the scenario is a
    // live task hitting a stale session in the shared browser, not a missing
    // tool.
    await fixture.daemonOperation('postAgentMachineReport', { machineId: 'machine-otter-wall', machineName: 'otter-laptop' });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const connector = { id: 'squire:machine-otter-wall' };

    const notActioned = await fixture.daemonOperation('postSquireLoginWall', {
      roomId: ROOM,
      wall: 'awaiting_human',
      message: 'Google is asking you to tap 42 on your phone.',
    });
    expect(notActioned.status).toBe(200);
    expect(await notActioned.json()).toEqual({
      id: '',
      createdAt: expect.any(Number),
      cardPosted: false,
    });
    expect(
      (await fixture.database.query(`SELECT 1 FROM messages WHERE card_type='connector-offer'`)).rowCount,
    ).toBe(0);

    const posted = await fixture.daemonOperation('postSquireLoginWall', {
      roomId: ROOM,
      wall: 'google_session',
      message: 'no live Google session on this profile',
    });
    expect(posted.status).toBe(200);
    const result = (await posted.json()) as {
      id: string;
      createdAt: number;
      cardPosted: boolean;
      offerId: string;
    };
    expect(result.cardPosted).toBe(true);
    expect(result.offerId).toEqual(expect.any(String));

    // A second wall on the same session, before the first reconnect settles,
    // joins the open card rather than posting a second.
    const joined = await fixture.daemonOperation('postSquireLoginWall', {
      roomId: ROOM,
      wall: 'google_session',
      message: 'still no live Google session',
    });
    expect((await joined.json()) as { offerId: string; cardPosted: boolean }).toEqual({
      id: result.offerId,
      createdAt: expect.any(Number),
      cardPosted: false,
      offerId: result.offerId,
    });

    const cards = await fixture.database.query<{ id: string; card: Record<string, any> }>(
      `SELECT id,card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]!.card).toEqual(
      expect.objectContaining({
        offerId: result.offerId,
        status: 'connecting',
        connectorType: 'trusty-squire',
        intent: 'reconnect',
        provider: 'google',
        connectorId: connector.id,
        reason: 'Sign in to Google once, so Trusty Squire can sign in to websites and APIs for you hands-free.',
      }),
    );
    expect(cards.rows[0]!.card.addressee).toEqual(
      expect.objectContaining({ pubkey: HUMAN, kind: 'human' }),
    );
    expect(cards.rows[0]!.card.consequence).toContain('Sign in to Google once');
    expect(cards.rows[0]!.card.acceptedBy).toBeUndefined();
    const visible = (await fixture.database.query<{ text: string }>(`SELECT text FROM messages WHERE card_type='connector-offer'`)).rows[0]!.text;
    expect(visible).not.toContain('no live Google session on this profile');

    // The connector is re-armed to force the shared browser's stale Google
    // session through Squire's own connect ceremony — never the ordinary
    // "add a connector" pairing, which must never pass --force-relogin.
    const armed = await fixture.database.query<{ status: string; force_relogin_provider: string | null }>(
      `SELECT CASE WHEN (squire_work->>'install')::boolean THEN 'installing' ELSE squire_report->>'status' END status,squire_work->>'forceReloginProvider' force_relogin_provider FROM agents WHERE 'squire:' || COALESCE(machine_id,agent_id)=$1`,
      [connector.id],
    );
    expect(armed.rows[0]).toEqual({ status: 'installing', force_relogin_provider: 'google' });
    const assignments = (await (
      await fixture.daemonOperation('getConnectorAssignments', { agentId: AGENT })
    ).json()) as {
      assignments: Array<{ kind: string; connectorId: string; forceReloginProvider?: string }>;
    };
    expect(assignments.assignments).toEqual([
      expect.objectContaining({
        kind: 'install',
        connectorId: connector.id,
        forceReloginProvider: 'google',
      }),
    ]);

    // The offer is linked to the turn it paused, exactly like offerConnector's.
    const linked = await fixture.database.query<{ command_id: string | null }>(
      `SELECT command_id FROM connector_offers WHERE id::text=$1`,
      [result.offerId],
    );
    expect(linked.rows[0]!.command_id).toEqual(expect.any(String));

    // The helper's connected report settles the card, clears the force-relogin
    // flag, and resumes the SAME paused agent turn — the existing
    // connector-offer settle-in-place and hidden resume path, unchanged.
    expect((await fixture.daemonOperation('installConnector', { connectorId: connector.id, pairingGeneration: Number((await fixture.database.query<{ generation: string }>(`SELECT squire_work->>'generation' generation FROM agents WHERE agent_id=$1`, [AGENT])).rows[0]!.generation) })).status).toBe(
      200,
    );
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const settled = await fixture.database.query<{ card: Record<string, any> }>(
      `SELECT card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(settled.rows[0]!.card).toEqual(
      expect.objectContaining({ status: 'accepted', connectorId: connector.id }),
    );
    const clearedFlag = await fixture.database.query<{ force_relogin_provider: string | null }>(
      `SELECT squire_work->>'forceReloginProvider' force_relogin_provider FROM agents WHERE 'squire:' || COALESCE(machine_id,agent_id)=$1`,
      [connector.id],
    );
    expect(clearedFlag.rows[0]!.force_relogin_provider).toBeNull();
    const decision = (await fixture.database.query<{ text: string }>(`SELECT text FROM messages WHERE card_type='connector-offer-decision'`)).rows;
    expect(decision.map(row => row.text).join(' ')).toContain('reconnected automatically');
    expect(settled.rows[0]!.card.acceptedBy).toBeUndefined();
    const resume = await fixture.database.query<{ action: string; state: string }>(
      `SELECT action,state FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND action='resume'`,
      [ROOM, AGENT],
    );
    expect(resume.rows).toEqual([{ action: 'resume', state: 'pending' }]);
  });


  it('posts a reconnect card from a Squire google_session wall hit inside a corner turn', async () => {
    // Squire is reconnecting an EXISTING connection either way, never
    // offering a new one, so a corner turn gets the same card its parent
    // Room would — unlike offerConnector, which really does refuse a corner.
    const cornerId = '44444444-4444-4444-8444-444444444444';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`,
      [cornerId, WORKSPACE, ROOM, HUMAN],
    );
    await fixture.daemonOperation('postAgentMachineReport', { machineId: 'machine-otter-corner', machineName: 'otter-laptop' });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const connector = { id: 'squire:machine-otter-corner' };

    const posted = await fixture.daemonOperation('postSquireLoginWall', {
      roomId: cornerId,
      wall: 'google_session',
      message: 'no live Google session on this profile',
    });
    expect(posted.status).toBe(200);
    const result = (await posted.json()) as { cardPosted: boolean; offerId: string };
    expect(result.cardPosted).toBe(true);

    const cards = await fixture.database.query<{ room_id: string; card: Record<string, any> }>(
      `SELECT room_id,card FROM messages WHERE card_type='connector-offer'`,
    );
    expect(cards.rows).toHaveLength(1);
    expect(cards.rows[0]!.room_id).toBe(cornerId);
    expect(cards.rows[0]!.card).toEqual(
      expect.objectContaining({ status: 'connecting', intent: 'reconnect', provider: 'google' }),
    );
    const armed = await fixture.database.query<{ force_relogin_provider: string | null }>(
      `SELECT squire_work->>'forceReloginProvider' force_relogin_provider FROM agents WHERE 'squire:' || COALESCE(machine_id,agent_id)=$1`,
      [connector.id],
    );
    expect(armed.rows[0]).toEqual({ force_relogin_provider: 'google' });
  });


  it('Reproduction squire-false-card: automatic completion never credits an owner tap', async () => {
    await fixture.daemonOperation('postAgentMachineReport', { machineId: 'auto-machine', machineName: 'squire' });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    await fixture.daemonOperation('postSquireLoginWall', { roomId: ROOM, wall: 'google_session', message: 'Run raw tool instructions' });
    const work = (await fixture.database.query<{ generation: string }>(`SELECT squire_work->>'generation' generation FROM agents WHERE agent_id=$1`, [AGENT])).rows[0]!;
    await fixture.daemonOperation('installConnector', { connectorId: 'squire:auto-machine', pairingGeneration: Number(work.generation) });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const card = (await fixture.database.query<{ card: Record<string, any> }>(`SELECT card FROM messages WHERE card_type='connector-offer'`)).rows[0]!.card;
    expect(card.status).toBe('accepted');
    expect(card.acceptedBy).toBeUndefined();
    const decision = (await fixture.database.query<{ text: string }>(`SELECT text FROM messages WHERE card_type='connector-offer-decision'`)).rows[0]!.text;
    expect(decision).toContain('reconnected automatically');
  });


  it.each(['oauth_sign_in', 'awaiting_human'])('Reproduction squire-false-card: %s posts no card and queues no reconnect', async wall => {
    await fixture.daemonOperation('postAgentMachineReport', { machineId: 'machine-otter-oauth', machineName: 'otter-laptop' });
    await fixture.daemonOperation('postConnectorVault', { connections: [] });
    const posted = await fixture.daemonOperation('postSquireLoginWall', { roomId: ROOM, wall,
      message: 'Call operate_observe and run npx connect' });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({ cardPosted: false });
    expect((await fixture.database.query(`SELECT 1 FROM messages WHERE card_type='connector-offer'`)).rows).toHaveLength(0);
    expect((await fixture.database.query(`SELECT 1 FROM agents WHERE squire_work->>'install'='true'`)).rows).toHaveLength(0);
  });


  it('workbench_status reports the helper owner Workbench, not the addressee Workbench', async () => {
    const zekeToken = await fixture.phoneToken('zeke');
    const zekeId = createHash('sha256').update('github:zeke').digest('hex');
    await fixture.operation('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: zekeId,
      role: 'member',
    });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId: zekeId });
    expect(
      (
        await fixture.daemonOperation('postAgentMachineReport', {
          machineId: 'machine-chode-1',
          machineName: 'chode',
        })
      ).status,
    ).toBe(200);
    await fixture.database.query(
      `INSERT INTO workspace_connectors(
         id,workspace_id,owner_identity_id,connector_type,helper_agent_id,machine_id,status
       ) VALUES
         (gen_random_uuid(),$1,$2,'tailscale',$3,'machine-chode-1','connected')`,
      [WORKSPACE, HUMAN, AGENT],
    );
    await fixture.operation(
      'sendRoomMessage',
      { roomId: ROOM, text: '@bee can you reach the tailnet?', mentions: [AGENT] },
      zekeToken,
    );

    const status = (await (
      await fixture.daemonOperation('readAgentWorkbench', { roomId: ROOM })
    ).json()) as {
      addressee: { identityId: string };
      owner?: { identityId: string; handle?: string };
      catalog: Array<{
        connectorType: string;
        paired?: { status: string; onThisMachine: boolean };
      }>;
    };
    expect(status.addressee.identityId).toBe(zekeId);
    expect(status.owner).toEqual({ identityId: HUMAN, name: 'Owner', handle: 'owner' });
    expect(status.catalog.find((entry) => entry.connectorType === 'tailscale')?.paired).toEqual({
      status: 'connected',
      helperName: 'chode',
      onThisMachine: true,
    });
    expect(
      status.catalog.find((entry) => entry.connectorType === 'trusty-squire')?.paired,
    ).toBeUndefined();
  });
});
