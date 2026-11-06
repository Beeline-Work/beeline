import { createAgentCommand, claimAgentCommand } from '.././agent-command.js';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { insertCornerFacts } from '.././test-support.js';
import { PhoneService } from '.././phone-service.js';
import { LiveHub } from '.././live.js';
import { PushDeliveryLoop } from '.././background.js';
import { announceAgentLifecycle } from '.././connection-presence.js';
import { taggedIdentityIdsSql } from '.././message-mentions.js';
import { monolithFixture, taggedBy, wokenBy, HUMAN, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: message-routing', () => {
const fixture = monolithFixture();

  it('answers a membership-check outage while ordering as a 503, never a membership refusal', async () => {
    const steerCorner = '55555555-5555-4555-8555-555555555555';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Steer target')`,
      [steerCorner, WORKSPACE, ROOM],
    );
    await insertCornerFacts(fixture.database, { cornerId: steerCorner, ownerAgentId: AGENT, lifecycle: '{}' });
    const messageId = createHash('sha256').update('steer-outage').digest('hex');
    await fixture.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
      messageId,
      ROOM,
      HUMAN,
      '@bee steer the corner',
    ]);
    const requestId = 'steer-outage';
    const command = await createAgentCommand(fixture.database, {
      roomId: ROOM,
      agentId: AGENT,
      sourceMessageId: messageId,
      reason: 'human_tag',
      turnRequestId: requestId,
    });
    await claimAgentCommand(fixture.database, ROOM, AGENT, command!.id, `${requestId}-g`);
    // The membership check is a database read; its failure is an outage, not a
    // refusal, so it must reach the route's 503 default intact.
    const query = fixture.database.query.bind(fixture.database);
    const querySpy = vi.spyOn(fixture.database, 'query').mockImplementation(async (sql, values) => {
      if (sql.includes(') corner_reviewer,')) throw new Error('database is unavailable');
      return query(sql, values);
    });
    try {
      const outage = await fixture.request(
        '/v1/daemon/operations/order',
        'POST',
        {
          roomId: ROOM,
          requestId,
          generationId: `${requestId}-g`,
          text: 'Steer into the corner',
          address: steerCorner,
        },
        fixture.daemonToken,
      );
      expect(outage.status).toBe(503);
      expect(await outage.json()).toEqual({ error: 'database is unavailable' });
    } finally {
      querySpy.mockRestore();
    }
  });


  it('never turns a bare agent name into a mention of the agent that just replied', async () => {
    const peer = 'e'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    const reply = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: '1'.repeat(64),
      text: 'I am Bee.',
    });
    expect(reply.status).toBe(200);

    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '2'.repeat(64),
      text: 'Lumen seems to think we need a corner.',
    });
    expect(sent.status).toBe(200);
    expect(await taggedBy(fixture.database, '2'.repeat(64))).toEqual([]);
  });


  it('derives agent mentions only from their exact typed handle', async () => {
    const cases = [
      ['@bee, please inspect this.', [AGENT]],
      ['@bee- please inspect this.', [AGENT]],
      ['@bee-urgent, please inspect this.', []],
      ['@bee--urgent, please inspect this.', []],
      ['@bee..urgent, please inspect this.', []],
      ['𐐀@bee please inspect this.', []],
      ['@bee-𐐀 please inspect this.', []],
      ['Bee, please inspect this.', []],
      ['@Bee please inspect this.', []],
      ['@beeline, please inspect this.', []],
    ] as const;
    for (const [index, [text, expected]] of cases.entries()) {
      const messageId = (index + 8).toString(16).padStart(64, '0');
      const sent = await fixture.operation('sendRoomMessage', {
        roomId: ROOM,
        messageId,
        text,
        mentions: [AGENT],
      });
      expect(sent.status).toBe(200);
      expect(await taggedBy(fixture.database, messageId)).toEqual(expected);
    }
  });


  it('derives human mentions from exact typed handles, never supplied ids', async () => {
    const peer = 'f'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Peer','peer')`,
      [peer],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    for (const [messageId, text, expected] of [
      ['d'.repeat(64), 'Hello Peer.', []],
      ['e'.repeat(64), '@peer, hello.', [peer]],
    ] as const) {
      const sent = await fixture.operation('sendRoomMessage', {
        roomId: ROOM,
        messageId,
        text,
        mentions: [AGENT, peer],
      });
      expect(sent.status).toBe(200);
      expect(await taggedBy(fixture.database, messageId)).toEqual(expected);
    }
    const outsider = '7'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Outsider','outsider')`,
      [outsider],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, outsider],
    );
    const outsideRoom = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '7'.repeat(64),
      text: '@outsider, hello.',
      mentions: [outsider],
    });
    expect(outsideRoom.status).toBe(200);
    expect(await taggedBy(fixture.database, '7'.repeat(64))).toEqual([]);
    const duplicatePeer = '0'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Another peer','peer')`,
      [duplicatePeer],
    );
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, duplicatePeer, ROOM],
    );
    const ambiguous = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '1'.repeat(64),
      text: '@peer, hello.',
      mentions: [peer, duplicatePeer],
    });
    expect(ambiguous.status).toBe(200);
    expect(await taggedBy(fixture.database, '1'.repeat(64))).toEqual([]);
  });


  it('does not tag or push the author named in a forward caption', async () => {
    const recipient = createHash('sha256').update('github:recipient').digest('hex');
    await fixture.auth.exchangeGitHubOidc('recipient-proof');
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, recipient, ROOM],
    );
    const send = vi.fn(async () => undefined);
    const pushes = new PushDeliveryLoop(fixture.database, { send });
    await pushes.runOnce();
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('recipient-device-token-12345678901234567890',$1,'android','physical')`,
      [recipient],
    );

    const humanForward = '7'.repeat(64);
    const agentForward = '8'.repeat(64);
    const channelForward = '9'.repeat(64);
    for (const [messageId, author] of [
      [humanForward, 'recipient'],
      [agentForward, 'bee'],
      [channelForward, 'channel'],
    ] as const) {
      const sent = await fixture.operation('sendRoomMessage', {
        roomId: ROOM,
        messageId,
        text: `> ship it\n\nFORWARDED FROM #general · @${author}`,
        mentions: [],
      });
      expect(sent.status).toBe(200);
      expect(await taggedBy(fixture.database, messageId)).toEqual([]);
    }
    const projected = (await fixture.phone.readRoom(ROOM, HUMAN))!;
    for (const messageId of [humanForward, agentForward, channelForward]) {
      expect(
        projected.messages.find((message) => message.id === messageId)?.mentionPubkeys,
      ).toBeUndefined();
    }
    expect(await wokenBy(fixture.database, agentForward)).toEqual([]);
    expect(await pushes.runOnce()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });


  it('does not persist a typed agent outside the Room as a mention', async () => {
    const outsideAgent = 'd'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Outside','outside')`,
      [outsideAgent],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [
      outsideAgent,
      HUMAN,
    ]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, outsideAgent],
    );

    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '3'.repeat(64),
      text: '@outside please inspect this.',
      mentions: [outsideAgent],
    });
    expect(sent.status).toBe(200);
    expect(await taggedBy(fixture.database, '3'.repeat(64))).toEqual([]);
  });


  it.each([false, true])('routes an untagged threaded reply only for a solo-agent Room (extra human: %s)', async extraHuman => {
    if (extraHuman) {
      const peer = 'c'.repeat(64);
      await fixture.database.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Peer','peer')`, [peer]);
      await fixture.database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
         VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
        [WORKSPACE, peer, ROOM],
      );
    }
    await announceAgentLifecycle(fixture.database, new LiveHub(), ROOM, AGENT, {
      lifecycleId: 'routing-fixture',
    });
    const requestId = '3'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: '@bee Start this exchange.',
      mentions: [AGENT],
    });
    const parent = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId,
      triggerMessageId: requestId,
      text: 'Thread parent.',
    });
    const parentId = ((await parent.json()) as { id: string }).id;
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '4'.repeat(64),
      text: '@bee An intervening human message.',
      mentions: [AGENT],
    });

    const sent = await fixture.operation('sendRoomReply', {
      roomId: ROOM,
      messageId: '5'.repeat(64),
      parentMessageId: parentId,
      text: 'Answer this thread.',
    });
    expect(sent.status).toBe(200);
    const stored = await fixture.database.query<{ tagged_ids: string[]; reply_to_message_id: string }>(
      `SELECT ${taggedIdentityIdsSql('m')} tagged_ids,m.reply_to_message_id FROM messages m WHERE m.id=$1`,
      ['5'.repeat(64)],
    );
    expect(stored.rows[0]).toEqual({ tagged_ids: [], reply_to_message_id: parentId });
    const inbox = await fixture.daemonOperation('getRoomInbox', { roomId: ROOM });
    const items = ((await inbox.json()) as { items: Array<{ id: string }> }).items;
    expect(items.some(item => item.id === '5'.repeat(64))).toBe(!extraHuman);
  });


  it('does not notify an untagged direct parent agent', async () => {
    const peer = 'd'.repeat(64);
    const parentId = 'e'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text)
       VALUES($1,$2,$3,'Older direct answer.'),
             ($4,$2,$5,'@owner Later answer.')`,
      [parentId, ROOM, AGENT, 'f'.repeat(64), peer],
    );

    const sent = await fixture.operation('sendRoomReply', {
      roomId: ROOM,
      messageId: 'a'.repeat(64),
      parentMessageId: parentId,
      text: 'Please continue the older answer.',
    });
    expect(sent.status).toBe(200);
    const notices = await fixture.database.query<{ author_id: string; text: string }>(
      `SELECT author_id,text FROM messages WHERE room_id=$1 AND presentation='system'`,
      [ROOM],
    );
    expect(notices.rows).toEqual([]);
  });


  it('routes a reply only to the explicitly tagged agent', async () => {
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
    const peerExchange = await fixture.auth.createDaemonExchange(peer);
    const peerToken = (await fixture.auth.exchangeDaemonToken(peerExchange.exchangeToken))!.daemonToken;
    const first = '9'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: first,
      text: '@bee Start this exchange.',
      mentions: [AGENT],
    });
    const parent = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: first,
      triggerMessageId: first,
      text: 'My first answer.',
    });
    const parentId = ((await parent.json()) as { id: string }).id;
    const peerRequest = 'a'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: peerRequest,
      text: '@Peer Please answer too.',
      mentions: [peer],
    });
    await fixture.daemonOperation(
      'postRoomMessage',
      {
        roomId: ROOM,
        requestId: peerRequest,
        triggerMessageId: peerRequest,
        text: 'My later answer.',
      },
      peerToken,
    );
    const reply = '6'.repeat(64);
    await fixture.operation('sendRoomReply', {
      roomId: ROOM,
      messageId: reply,
      parentMessageId: parentId,
      text: 'Please continue the first answer.',
    });
    expect(
      (
        await fixture.database.query<{ agent_id: string; reason: string }>(
          `SELECT agent_id,reason FROM agent_commands WHERE source_message_id=$1`,
          [reply],
        )
      ).rows,
    ).toEqual([]);

    const continued = await fixture.request(
      '/v1/daemon/operations/postRoomMessage',
      'POST',
      {
        roomId: ROOM,
        requestId: reply,
        triggerMessageId: reply,
        text: 'Continuing the first answer.',
      },
      fixture.daemonToken,
    );
    expect(continued.status).toBe(403);
    const pileOn = await fixture.request(
      '/v1/daemon/operations/postRoomMessage',
      'POST',
      {
        roomId: ROOM,
        requestId: reply,
        triggerMessageId: reply,
        text: 'I should not answer this reply.',
      },
      peerToken,
    );
    expect(pileOn.status).toBe(403);

    const taggedReply = '7'.repeat(64);
    const tagged = await fixture.operation('sendRoomReply', {
      roomId: ROOM,
      messageId: taggedReply,
      parentMessageId: parentId,
      text: '@peer Please continue the first answer.',
    });
    expect(tagged.status).toBe(200);
    expect(
      (
        await fixture.request(
          '/v1/daemon/operations/postRoomMessage',
          'POST',
          {
            roomId: ROOM,
            requestId: taggedReply,
            triggerMessageId: taggedReply,
            text: 'The structurally addressed parent agent must not answer.',
          },
          fixture.daemonToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.daemonOperation(
          'postRoomMessage',
          {
            roomId: ROOM,
            requestId: taggedReply,
            triggerMessageId: taggedReply,
            text: 'The explicitly addressed agent answers.',
          },
          peerToken,
        )
      ).status,
    ).toBe(200);
  });


  it('does not address an agent when an untagged reply targets a human', async () => {
    const parentId = '8'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: parentId,
      text: 'Human thread parent.',
      mentions: [AGENT],
    });
    await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: parentId,
      text: 'An agent replied most recently.',
    });

    const replyId = '9'.repeat(64);
    const sent = await fixture.operation('sendRoomReply', {
      roomId: ROOM,
      messageId: replyId,
      parentMessageId: parentId,
      text: 'This is for the human.',
    });
    expect(sent.status).toBe(200);
    const stored = await fixture.database.query<{ tagged_ids: string[]; reply_to_message_id: string }>(
      `SELECT ${taggedIdentityIdsSql('m')} tagged_ids,m.reply_to_message_id FROM messages m WHERE m.id=$1`,
      [replyId],
    );
    expect(stored.rows[0]).toEqual({ tagged_ids: [], reply_to_message_id: parentId });
  });


  it('keeps explicit agent mentions on replies to humans', async () => {
    const parentId = 'a'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: parentId,
      text: 'Another human thread parent.',
    });

    const replyId = 'b'.repeat(64);
    const sent = await fixture.operation('sendRoomReply', {
      roomId: ROOM,
      messageId: replyId,
      parentMessageId: parentId,
      text: '@bee This one is explicitly for the agent.',
      mentions: [AGENT],
    });
    expect(sent.status).toBe(200);
    expect(await taggedBy(fixture.database, replyId)).toEqual([AGENT]);
  });


  it('does not add the only Room agent when the human did not mention it', async () => {
    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '6'.repeat(64),
      text: 'Please take this.',
    });
    expect(sent.status).toBe(200);
    expect(await taggedBy(fixture.database, '6'.repeat(64))).toEqual([]);
  });


  it('leaves an untagged human message unaddressed with two agents and no prior agent message', async () => {
    const peer = 'f'.repeat(64);
    await fixture.database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Peer')`, [peer]);
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );

    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '7'.repeat(64),
      text: 'This is for nobody in particular.',
    });
    expect(sent.status).toBe(200);
    expect(await taggedBy(fixture.database, '7'.repeat(64))).toEqual([]);
  });


  it('settles a working turn when its final untagged agent reply is stored', async () => {
    const requestId = '7'.repeat(64);
    await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: requestId,
      text: '@bee Please answer.',
      mentions: [AGENT],
    });
    await fixture.daemonOperation('postAgentTurnReceipt', {
      roomId: ROOM,
      requestId,
      status: 'working',
    });
    const finalReply = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId,
      triggerMessageId: requestId,
      text: 'Done.',
    });
    expect(finalReply.status).toBe(200);
    expect(
      (await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN))?.latestAgentTurns,
    ).toContainEqual(
      expect.objectContaining({ requestId, agentPubkey: AGENT, status: 'complete' }),
    );
  });

  it('resolves a model-written human tag at the server boundary, highlights it, and pushes it', async () => {
    const send = vi.fn(async () => undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    await loop.runOnce(); // establish the durable floor before the new events
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('owner-device-token-12345678901234567890',$1,'android','physical')`,
      [HUMAN],
    );
    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '5'.repeat(64),
      text: '@bee list the root files.',
      mentions: [AGENT],
    });
    expect(sent.status).toBe(200);
    const unknown = 'f'.repeat(64);
    const reply = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'human-mention-turn',
      triggerMessageId: '5'.repeat(64),
      text: '@owner Repository root files: README.md',
    });
    expect(reply.status).toBe(200);
    const stored = await fixture.database.query<{ tagged_ids: string[] }>(
      `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m
       WHERE m.room_id=$1 AND m.author_id=$2 AND m.text LIKE '@owner%'`,
      [ROOM, AGENT],
    );
    expect(stored.rows).toHaveLength(1);
    // The human member is a real mention; an unknown name stays plain text.
    expect(stored.rows[0]!.tagged_ids).toEqual([HUMAN]);
    const projected = (await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN))!;
    expect(
      projected.messages.find((message) => message.text.startsWith('@owner'))?.mentionPubkeys,
    ).toEqual([HUMAN]);
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'owner-device-token-12345678901234567890',
      expect.objectContaining({
        roomId: ROOM,
        text: 'Bee: @owner Repository root files: README.md',
      }),
    );
  });


  it('routes an exact model-written agent tag resolved at the shared write boundary', async () => {
    const peer = 'f'.repeat(64);
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Peer','retired-peer')`,
      [peer],
    );
    await fixture.database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [peer, HUMAN]);
    await fixture.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
       VALUES($1,NULL,$2,'member'),($1,$3,$2,'member')`,
      [WORKSPACE, peer, ROOM],
    );
    const peerExchange = await fixture.auth.createDaemonExchange(peer);
    const peerToken = (await fixture.auth.exchangeDaemonToken(peerExchange.exchangeToken))!.daemonToken;
    await fixture.database.query(`UPDATE identities SET handle='fuckface' WHERE id=$1`, [peer]);
    const spoofed = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      text: 'Peer should not receive this untagged message.',
    });
    expect(spoofed.status).toBe(200);
    const spoofedBody = (await spoofed.json()) as { id: string };
    // Untagged words name nobody, whatever the caller hoped.
    expect(await taggedBy(fixture.database, spoofedBody.id)).toEqual([]);
    const reply = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      text: '@bee cannot self-route. @retired-peer and @FUCKFACE are stale. @fuckface investigate the failed build.',
    });
    expect(reply.status).toBe(200);
    const body = (await reply.json()) as { id: string };
    expect(await taggedBy(fixture.database, body.id)).toEqual([peer]);
    const inbox = (await (
      await fixture.daemonOperation('getRoomInbox', { roomId: ROOM }, peerToken)
    ).json()) as {
      items: Array<{ id: string }>;
    };
    expect(inbox.items).toContainEqual(expect.objectContaining({ id: body.id }));
    expect(inbox.items).not.toContainEqual(expect.objectContaining({ id: spoofedBody.id }));
  });


  it('delivers every human an agent tags, with the push a human-authored tag gets', async () => {
    // Signed in before any device is registered, so this newcomer's own
    // welcome-join notification is not one of the pushes counted below.
    const scribeToken = await fixture.phoneToken('scribe');
    const scribe = createHash('sha256').update('github:scribe').digest('hex');
    const human2 = createHash('sha256').update('github:peer').digest('hex');
    await fixture.database.query(
      `INSERT INTO identities(id,kind,name,handle,github_subject)
       VALUES($1,'human','Peer','bananaman614305','peer')`,
      [human2],
    );
    for (const identity of [human2, scribe])
      await fixture.database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, ROOM, identity],
      );
    for (const identity of [human2, scribe])
      await fixture.database.query(
        `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`,
        [WORKSPACE, identity],
      );
    for (const [token, identity] of [
      ['owner-two-tag-device-token-1234567890', HUMAN],
      ['peer-two-tag-device-token-12345678901', human2],
    ] as const)
      await fixture.database.query(
        `INSERT INTO push_devices(token,identity_id,platform,environment)
         VALUES($1,$2,'android','physical')`,
        [token, identity],
      );
    const floor = new PushDeliveryLoop(fixture.database, { send: vi.fn().mockResolvedValue(undefined) });
    await floor.runOnce();
    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: '5'.repeat(64),
      text: '@bee loop in whoever else decides.',
      mentions: [AGENT],
    });
    expect(sent.status).toBe(200);
    const reply = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'two-human-tags-turn',
      triggerMessageId: '5'.repeat(64),
      text: '@owner here is where things stand.\n@bananaman614305 you are up next.',
    });
    expect(reply.status).toBe(200);
    // The agent's own durable reply — a server-authored system line about the
    // Room is not a turn's delivery and carries no mention of its own.
    const stored = await fixture.database.query<{ tagged_ids: string[] }>(
      `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m
       WHERE m.room_id=$1 AND m.author_id=$2 AND m.presentation='message'`,
      [ROOM, AGENT],
    );
    expect(stored.rows).toHaveLength(1);
    // Both tags are stored, so both are what the phone highlights and what the
    // push fan-out reads. A correct handle never becomes plain text in silence.
    expect(stored.rows[0]!.tagged_ids).toEqual([HUMAN, human2]);
    const projected = (await new PhoneService(fixture.database, fixture.origin).readRoom(ROOM, HUMAN))!;
    expect(
      projected.messages.find(
        (message) =>
          message.author.pubkey === AGENT &&
          message.text.includes('@bananaman614305 you are up next.'),
      )?.mentionPubkeys,
    ).toEqual([HUMAN, human2]);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(fixture.database, { send }).runOnce()).toBe(2);
    expect(send.mock.calls.map(([token]) => token).sort()).toEqual([
      'owner-two-tag-device-token-1234567890',
      'peer-two-tag-device-token-12345678901',
    ]);

    // Parity: the same two tags written by a HUMAN reach exactly the same two
    // devices. The author's kind is not an input to mention delivery.
    const human = await fixture.operation(
      'sendRoomMessage',
      {
        roomId: ROOM,
        messageId: '6'.repeat(64),
        text: '@owner and @bananaman614305, same question.',
        mentions: [HUMAN, human2],
      },
      scribeToken,
    );
    expect(human.status).toBe(200);
    const humanSend = vi.fn().mockResolvedValue(undefined);
    expect(await new PushDeliveryLoop(fixture.database, { send: humanSend }).runOnce()).toBe(2);
    expect(humanSend.mock.calls.map(([token]) => token).sort()).toEqual([
      'owner-two-tag-device-token-1234567890',
      'peer-two-tag-device-token-12345678901',
    ]);
  });


  it('tags and pushes a human question from an agent in a corner', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    await loop.runOnce();
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('corner-question-owner-device-token-1234567890',$1,'android','physical')`,
      [HUMAN],
    );
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'corner-question-tag-turn',
      name: 'Ship-the-widget',
      objective: 'Ship the widget end to end',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    // The server-owned corner-open card has its own push. Advance past it so
    // the next delivery proves the agent's question itself is a candidate.
    await loop.runOnce();
    send.mockClear();
    const reply = await fixture.daemonOperation('postRoomMessage', {
      roomId: cornerId,
      requestId: 'corner-question-tag-reply',
      text: '@owner which release should I target?',
    });
    expect(reply.status).toBe(200);
    const stored = await fixture.database.query<{ tagged_ids: string[] }>(
      `SELECT ${taggedIdentityIdsSql('m')} tagged_ids FROM messages m
       WHERE m.room_id=$1 AND m.author_id=$2`,
      [cornerId, AGENT],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.tagged_ids).toEqual([HUMAN]);
    const projected = (await new PhoneService(fixture.database, fixture.origin).readRoom(cornerId, HUMAN))!;
    expect(
      projected.messages.find((message) => message.text.includes('which release'))?.mentionPubkeys,
    ).toEqual([HUMAN]);
    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledWith(
      'corner-question-owner-device-token-1234567890',
      expect.objectContaining({ channelId: cornerId, cornerId }),
    );
  });
});
