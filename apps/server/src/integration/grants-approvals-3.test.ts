import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PushDeliveryLoop } from '.././background.js';
import { isAgentDetailView, isRoomView, type RoomView } from '@beeline/api-contract/phone';
import { taggedIdentityIdsSql } from '.././message-mentions.js';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM, next } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: grants-approvals', () => {
const fixture = monolithFixture();


  it('runs the grant loop: pending card with mention, coalescing, owner ALWAYS/ONCE/NO, gate refusals, listing, revoke', async () => {
    // New agents default to yolo on; this test exercises the pending-card path
    // an owner who has turned yolo off still goes through.
    await fixture.database.query(`UPDATE agents SET yolo_mode=false WHERE agent_id=$1`, [AGENT]);
    const send = vi.fn(async () => undefined);
    const pushes = new PushDeliveryLoop(fixture.database, { send });
    await pushes.runOnce();
    await fixture.database.query(
      `INSERT INTO push_devices(token,identity_id,platform,environment)
       VALUES('grant-owner-device-1234567890123456789012',$1,'android','physical')`,
      [HUMAN],
    );
    const memberToken = await fixture.phoneToken('member');
    const memberId = createHash('sha256').update('github:member').digest('hex');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId });
    // The member asks the agent for a deploy: they are the requester on every row.
    const ask = (await (
      await fixture.operation(
        'sendRoomMessage',
        { roomId: ROOM, text: '@bee deploy the preview', mentions: [AGENT] },
        memberToken,
      )
    ).json()) as { messageId: string };
    expect(ask.messageId).toMatch(/^[0-9a-f]{64}$/);
    // Drain the join note and the ask so the card's push is the only one left.
    await pushes.runOnce();
    send.mockClear();

    // Metacharacters in a command target are refused at request time.
    const refusedTarget = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      kind: 'command',
      target: 'fly deploy; rm -rf /',
      reason: 'publish the preview',
    });
    expect(refusedTarget.status).toBe(400);
    expect(((await refusedTarget.json()) as { error: string }).error).toContain(
      'shell metacharacters',
    );

    const first = (await (
      await fixture.daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        requestId: ask.messageId,
        kind: 'command',
        target: 'cat /home/other/.env',
        reason: 'publish the preview build',
      })
    ).json()) as { grantId: string; status: string; auto: boolean; messageId: string };
    expect(first).toEqual(
      expect.objectContaining({ status: 'pending', auto: false, messageId: expect.any(String) }),
    );
    // A second ask in the same turn joins the same card.
    const second = (await (
      await fixture.daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        requestId: ask.messageId,
        kind: 'command',
        target: 'cat /home/other/.ssh/id_rsa',
        reason: 'reach the Fly API',
        ttlSeconds: 3_600,
      })
    ).json()) as { grantId: string; status: string; messageId: string };
    expect(second.messageId).toBe(first.messageId);
    const cards = await fixture.database.query<{
      room_id: string;
      author_id: string;
      text: string;
      tagged_ids: string[];
      presentation: string;
      card: {
        grants: Array<Record<string, unknown>>;
        owner: { pubkey: string };
        requester: { pubkey: string };
      };
    }>(
      `SELECT room_id,author_id,text,${taggedIdentityIdsSql('messages')} tagged_ids,presentation,card
       FROM messages WHERE card_type='grant-request'`,
    );
    expect(cards.rows).toHaveLength(1);
    const card = cards.rows[0]!;
    expect(card.author_id).toBe(AGENT);
    expect(card.presentation).toBe('card');
    // The card names its owner in `card`, not as a tag: a grant request is
    // addressed by what it IS, and `background.ts` pushes it to that person.
    expect(card.tagged_ids).toEqual([]);
    expect(card.text).toBe(
      '@member wants Bee to use cat /home/other/.env and Bee to use cat /home/other/.ssh/id_rsa',
    );
    expect(card.card.owner.pubkey).toBe(HUMAN);
    expect(card.card.requester.pubkey).toBe(memberId);
    expect(card.card.grants.map((grant) => grant.status)).toEqual(['pending', 'pending']);
    expect(card.card.grants[1]!.expiresAt).toEqual(expect.any(Number));
    // Resource prompts are private. Squire approval instead
    // reaches its owner through the connector DM's direct-message push path.
    await pushes.runOnce();
    expect(card.room_id).not.toBe(ROOM);
    // The phone reads the card as a validated grantRequest message.
    const room = (await (await fixture.request(`/v1/phone/rooms/${card.room_id}`)).json()) as RoomView;
    expect(isRoomView(room)).toBe(true);
    const cardMessage = room.messages.find((message) => message.grantRequest);
    expect(cardMessage?.grantRequest?.grants).toHaveLength(2);
    expect(cardMessage?.mentionPubkeys).toBeUndefined();

    // A plain member cannot answer; nothing changes.
    const refused = await fixture.operation(
      'decideAgentGrant',
      { grantId: first.grantId, decision: 'always' },
      memberToken,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only the agent's owner can change this",
    });
    // Only pending answers are not yet on the profile.
    const profileBefore = (await (
      await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as { grants: unknown[]; canManageGrants: boolean };
    expect(profileBefore.grants).toEqual([]);
    expect(profileBefore.canManageGrants).toBe(true);
    const memberProfile = (await (
      await fixture.request(
        `/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`,
        'GET',
        undefined,
        memberToken,
      )
    ).json()) as { canManageGrants: boolean };
    expect(memberProfile.canManageGrants).toBe(false);

    // Owner taps ONCE on the command and NO on the host.
    const once = await fixture.operation('decideAgentGrant', { grantId: first.grantId, decision: 'once' });
    expect(once.status).toBe(200);
    expect(await once.json()).toEqual({ grantId: first.grantId, status: 'once', roomId: ROOM });
    const deny = await fixture.operation('decideAgentGrant', { grantId: second.grantId, decision: 'deny' });
    expect(await deny.json()).toEqual({ grantId: second.grantId, status: 'denied', roomId: ROOM });
    const again = await fixture.operation('decideAgentGrant', {
      grantId: first.grantId,
      decision: 'always',
    });
    expect(again.status).toBe(409);
    // The card settled in place: same message id, per-grant outcome, decider.
    const settled = await fixture.database.query<{ card: { grants: Array<Record<string, unknown>> } }>(
      `SELECT card FROM messages WHERE card_type='grant-request'`,
    );
    expect(settled.rows).toHaveLength(1);
    expect(settled.rows[0]!.card.grants.map((grant) => grant.status)).toEqual(['once', 'denied']);
    expect(settled.rows[0]!.card.grants[0]!.decidedBy).toEqual(
      expect.objectContaining({ pubkey: HUMAN, kind: 'human', name: 'Owner' }),
    );
    expect(settled.rows[0]!.card.grants[0]!.decidedAt).toEqual(expect.any(Number));
    // One system line per decision wakes the daemon: it mentions the agent and
    // reaches its inbox; it never pushes to a human.
    const decisions = (
      await fixture.database.query<{
        body: string;
        authorId: string;
        systemEvent: unknown;
      }>(
        `SELECT text body,author_id "authorId",system_event "systemEvent" FROM messages
        WHERE room_id=$1 AND card_type='grant-decision' ORDER BY created_at,id`,
        [ROOM],
      )
    ).rows;
    expect(decisions.map((item) => item.body)).toEqual([
      '@owner approved once command cat /home/other/.env',
      '@owner declined command cat /home/other/.ssh/id_rsa',
    ]);
    // The decision carries a RESUME kind: it answers the turn already paused on
    // the ask, and the helper must not start a second turn on it.
    expect(decisions.map((item) => item.systemEvent)).toEqual([
      {
        subject: { kind: 'person', id: HUMAN, name: '@owner' },
        verb: 'approved once',
        kind: 'grant-decided',
        object: { text: 'command cat /home/other/.env' },
      },
      {
        subject: { kind: 'person', id: HUMAN, name: '@owner' },
        verb: 'declined',
        kind: 'grant-decided',
        object: { text: 'command cat /home/other/.ssh/id_rsa' },
      },
    ]);
    // These items are in this agent's inbox because the server routed them here.
    expect(decisions.every((item) => item.authorId === HUMAN)).toBe(true);
    expect(await pushes.runOnce()).toBe(0);
    // The phone still validates the settled Room read.
    const settledRoom = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(settledRoom)).toBe(true);
    // C101: the settled request card already carries the answer, so the
    // decision line that wakes the daemon is never ALSO drawn in the Room -
    // one card, not a card plus a redundant restatement of it.
    expect(
      settledRoom.messages.filter((message) => /\b(approved|declined)\b/.test(message.text)),
    ).toEqual([]);
    const settledHistory = (await (await fixture.request(`/v1/phone/rooms/${ROOM}/history`)).json()) as {
      messages: Array<{ text: string }>;
    };
    expect(
      settledHistory.messages.filter((message) => /\b(approved|declined)\b/.test(message.text)),
    ).toEqual([]);

    // The daemon sees only the live once rule; consuming it spends it.
    const rules = (await (await fixture.daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
      grants: Array<Record<string, unknown>>;
    };
    expect(rules.grants).toEqual([
      expect.objectContaining({
        grantId: first.grantId,
        kind: 'command',
        status: 'once',
        target: 'cat /home/other/.env',
        requestedBy: memberId,
        requestedByName: 'Member',
      }),
    ]);
    expect((await fixture.daemonOperation('consumeAgentGrant', { grantId: first.grantId })).status).toBe(
      200,
    );
    expect((await fixture.daemonOperation('consumeAgentGrant', { grantId: first.grantId })).status).toBe(
      404,
    );
    expect(
      (
        (await (await fixture.daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
          grants: unknown[];
        }
      ).grants,
    ).toEqual([]);

    // ALWAYS makes a durable rule the profile lists and the owner can revoke.
    const third = (await (
      await fixture.daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        requestId: ask.messageId,
        kind: 'command',
        target: 'cat /home/other/.env.production',
        reason: 'run the suite',
      })
    ).json()) as { grantId: string; messageId: string };
    expect(third.messageId).not.toBe(first.messageId);
    await fixture.operation('decideAgentGrant', { grantId: third.grantId, decision: 'always' });
    const live = (await (await fixture.daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
      grants: Array<{ grantId: string; status: string }>;
    };
    expect(live.grants).toEqual([
      expect.objectContaining({ grantId: third.grantId, status: 'approved' }),
    ]);
    const profile = (await (
      await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as {
      grants: Array<{
        grantId: string;
        status: string;
        decidedBy?: { name: string };
        kind: string;
        target: string;
      }>;
    };
    expect(isAgentDetailView(profile)).toBe(true);
    expect(
      profile.grants.map((grant) => [grant.grantId, grant.status, grant.decidedBy?.name]),
    ).toEqual([
      [third.grantId, 'approved', 'Owner'],
      [second.grantId, 'denied', 'Owner'],
      [first.grantId, 'once', 'Owner'],
    ]);
    const memberRevoke = await fixture.operation(
      'revokeAgentGrant',
      { grantId: third.grantId },
      memberToken,
    );
    expect(memberRevoke.status).toBe(403);
    const revoked = await fixture.operation('revokeAgentGrant', { grantId: third.grantId });
    expect(await revoked.json()).toEqual({
      grantId: third.grantId,
      status: 'revoked',
      roomId: ROOM,
    });
    expect(
      (
        (await (await fixture.daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
          grants: unknown[];
        }
      ).grants,
    ).toEqual([]);
    expect((await fixture.operation('revokeAgentGrant', { grantId: third.grantId })).status).toBe(409);
  });


  it.each([false, true])(
    'auto-approves owner-machine host and command grants for another requester (yolo=%s)',
    async (yolo) => {
      await fixture.database.query(`UPDATE agents SET yolo_mode=$2 WHERE agent_id=$1`, [AGENT, yolo]);
      const token = await fixture.phoneToken('foreign-root');
      const requesterId = createHash('sha256').update('github:foreign-root').digest('hex');
      await fixture.operation('addWorkspaceMember', {
        workspaceId: WORKSPACE,
        memberId: requesterId,
        role: 'member',
      });
      await fixture.operation('addRoomMember', { roomId: ROOM, memberId: requesterId });
      const source = (await (
        await fixture.operation(
          'sendRoomMessage',
          {
            roomId: ROOM,
            text: '@bee use your machine',
            mentions: [AGENT],
          },
          token,
        )
      ).json()) as { messageId: string };
      for (const [kind, target] of [
        ['host', 'api.fly.io'],
        ['command', 'npm test'],
        ['path', '/home/owner/notes'],
        ['secret', 'OWNER_KEY'],
        ['mcp', 'openaiDeveloperDocs'],
      ] as const) {
        const grant = (await (
          await fixture.daemonOperation('requestAgentGrant', {
            roomId: ROOM,
            requestId: source.messageId,
            kind,
            target,
            reason: 'owner resource',
          })
        ).json()) as { grantId: string; status: string; auto: boolean; messageId?: string };
        expect(grant).toMatchObject({ status: 'approved', auto: true });
        expect(grant.messageId).toBeUndefined();
        expect(
          (
            await fixture.database.query(`SELECT requested_by FROM agent_grants WHERE id=$1`, [
              grant.grantId,
            ])
          ).rows[0],
        ).toEqual({ requested_by: requesterId });
      }
      expect(
        (await fixture.database.query(`SELECT id FROM messages WHERE card_type='grant-request'`)).rows,
      ).toEqual([]);
    },
  );


  it('approves grants on the spot under yolo with auto=true and no card, for the owner; rejects retired budget prompts', async () => {
    await fixture.database.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [AGENT]);
    const auto = (await (
      await fixture.daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        kind: 'secret',
        target: 'FLY_TOKEN',
        reason: 'deploy',
      })
    ).json()) as Record<string, unknown>;
    expect(auto).toEqual({ grantId: expect.any(String), status: 'approved', auto: true });
    const rows = await fixture.database.query<{ status: string; auto: boolean; decided_by: string | null }>(
      `SELECT status,auto,decided_by FROM agent_grants WHERE id::text=$1`,
      [auto.grantId as string],
    );
    expect(rows.rows).toEqual([{ status: 'approved', auto: true, decided_by: null }]);
    const lines = await fixture.database.query<{
      text: string;
      presentation: string;
      tagged_ids: string[];
      author_id: string;
      system_event: unknown;
    }>(
      `SELECT text,presentation,${taggedIdentityIdsSql('messages')} tagged_ids,author_id,system_event
       FROM messages WHERE room_id<>$1 AND card_type IN ('grant-request','grant-auto')`,
      [ROOM],
    );
    expect(lines.rows).toEqual([]);
    const profile = (await (
      await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/agents/${AGENT}`)
    ).json()) as { grants: Array<{ auto: boolean; status: string; decidedBy?: unknown }> };
    expect(profile.grants).toEqual([expect.objectContaining({ auto: true, status: 'approved' })]);
    expect(profile.grants[0]!.decidedBy).toBeUndefined();
    const budget = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      kind: 'budget',
      target: '$10 of API spend',
      reason: 'more tokens',
    });
    expect(budget.status).toBe(400);
    expect((await fixture.database.query(`SELECT id FROM agent_grants WHERE kind='budget'`)).rows).toEqual(
      [],
    );
    const mcp = (await (
      await fixture.daemonOperation('requestAgentGrant', {
        roomId: ROOM,
        kind: 'mcp',
        target: 'squire',
        reason: 'route Trusty Squire into this agent home',
      })
    ).json()) as Record<string, unknown>;
    expect(mcp).toEqual(expect.objectContaining({ status: 'approved', auto: true }));
  });


  it.each(['approved', 'denied', 'expired'] as const)('APPROVAL-V3: settles the System card for %s without changing the Room decision or resume', async status => {
    const asked = (await (await fixture.operation('sendRoomMessage', { roomId: ROOM, text: '@bee use the test credential', mentions: [AGENT] })).json()) as { messageId: string };
    await fixture.daemonOperation('postSquireApproval', { roomId: ROOM, requestId: asked.messageId, tool: 'fetch_credential', title: 'Credential access approval', detail: 'Reveal test',
      action: 'reveal a key', reason: 'Run the requested check.', facts: [{ label: 'Key', value: 'Test service' }], reference: 'vault://test/reference',
      approvalUrl: 'https://approve.example.test/test', approvalId: 'v3-test', linkKind: 'approval' });
    const posted = (await fixture.database.query<{ id: string; room_id: string }>(`SELECT id,room_id FROM messages WHERE card_type='squire-approval'`)).rows[0]!;
    expect((await fixture.phone.readRoom(posted.room_id, HUMAN))?.messages.find(message => message.id === posted.id)?.squireApproval).toMatchObject({ reason: 'Run the requested check.', action: 'reveal a key', facts: [{ label: 'Key', value: 'Test service' }] });
    const response = await fixture.daemonOperation('postSquireApprovalDecision', { roomId: ROOM, requestId: asked.messageId, approvalId: 'v3-test', status, tool: 'fetch_credential', title: 'Credential access approval', detail: 'Reveal test' });
    expect(response.status).toBe(200);
    const { id } = await response.json() as { id: string };
    const card = (await fixture.phone.readRoom(posted.room_id, HUMAN))?.messages.find(message => message.id === posted.id)?.squireApproval;
    expect(card).toMatchObject({ status, decidedAt: expect.any(Number) });
    expect(card?.decidedBy).toBeUndefined();
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === id)?.presentation).toBe('card');
    expect((await fixture.database.query(`SELECT action FROM agent_commands WHERE source_message_id=$1 AND turn_request_id=$2`, [id, asked.messageId])).rows).toEqual([{ action: 'resume' }]);
  });


  it('APPROVAL-V3: records No on a target proposal and attributes a confirmed branch change', async () => {
    await fixture.database.query(`UPDATE rooms SET repository_key='owner/repo',repository_remote='https://github.com/owner/repo.git',repository_target_branch='main' WHERE id=$1`, [ROOM]);
    const proposal = await fixture.daemonOperation('postTargetBranchProposal', { roomId: ROOM, requestId: 'v3-target', from: 'main', to: 'release', repository: 'owner/repo', purpose: 'Ship from the release branch.' });
    const { id } = await proposal.json() as { id: string };
    await expect(fixture.phone.execute('decideApprovalCard', { roomId: ROOM, messageId: id, decision: 'deny' }, AGENT)).rejects.toThrow('person');
    expect((await fixture.operation('decideApprovalCard', { roomId: ROOM, messageId: id, decision: 'deny' })).status).toBe(200);
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === id)?.targetBranch).toMatchObject({ status: 'denied', decidedBy: { pubkey: HUMAN }, purpose: 'Ship from the release branch.' });
    const next = await fixture.daemonOperation('postTargetBranchProposal', { roomId: ROOM, requestId: 'v3-target-again', from: 'main', to: 'release', repository: 'owner/repo' });
    const { id: nextId } = await next.json() as { id: string };
    expect((await fixture.operation('setRoomTargetBranch', { roomId: ROOM, targetBranch: 'release' })).status).toBe(200);
    expect((await fixture.phone.readRoom(ROOM, HUMAN))?.messages.find(message => message.id === nextId)?.targetBranch).toMatchObject({ status: 'allowed', decidedBy: { pubkey: HUMAN }, decidedAt: expect.any(Number) });
  });


  /**
   * C94. Goosy took 36 granted commands in a top-level Room and 4 in its corner,
   * every one auto-approved, and among them wrote into the captain's
   * live project, ran a script it had authored itself, and read the key names
   * out of his environment file. Yolo stays the scope gate — an ordinary command
   * still just runs — and only the two hard stops wait for a person.
   */
  it('keeps the two hard stops off yolo, records what a grant licensed, and binds a script to its bytes', async () => {
    await fixture.database.query(`UPDATE agents SET yolo_mode=true WHERE agent_id=$1`, [AGENT]);
    const ask = async (target: string, extra: Record<string, unknown> = {}) =>
      (await (
        await fixture.daemonOperation('requestAgentGrant', {
          roomId: ROOM,
          kind: 'command',
          target,
          reason: 'because',
          ...extra,
        })
      ).json()) as Record<string, unknown>;

    // An ordinary command still rides on yolo; its grant ledger is the audit record.
    const ordinary = await ask('npm test');
    expect(ordinary).toEqual(expect.objectContaining({ status: 'approved', auto: true }));
    const autoLine = await fixture.database.query<{ text: string; system_event: { consequence: string } }>(
      `SELECT text,system_event FROM messages WHERE card_type='grant-auto' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(autoLine.rows).toEqual([]);

    // An interpreter and a credential file each ask a person, under yolo.
    const script = 'import os\nos.remove("/tmp/x")\n';
    const interpreter = await ask('python3 fix.py', {
      script: {
        path: 'fix.py',
        sha256: createHash('sha256').update(script).digest('hex'),
        bytes: Buffer.byteLength(script),
        contents: script,
      },
    });
    expect(interpreter).toEqual(
      expect.objectContaining({
        status: 'pending',
        auto: false,
        escalations: ['unseen-script'],
        messageId: expect.any(String),
      }),
    );
    // A named secret is scope, not a stop: yolo already answered that question.
    expect(await ask('fly deploy -a preview --with FLY_TOKEN')).toEqual(
      expect.objectContaining({ status: 'approved', auto: true }),
    );
    const credential = await ask('cut -d= -f1 /home/op/proj/.env');
    expect(credential).toEqual(
      expect.objectContaining({ status: 'pending', auto: false, escalations: ['credential'] }),
    );

    // The card carries the script's contents, so the person approves what runs.
    const card = await fixture.database.query<{ card: { grants: Array<Record<string, unknown>> } }>(
      `SELECT card FROM messages WHERE card_type='grant-request' ORDER BY created_at DESC LIMIT 1`,
    );
    const carded = card.rows[0]!.card.grants.find(
      (entry) => entry.grantId === interpreter.grantId,
    ) as { script?: { contents: string; sha256: string } };
    expect(carded.script?.contents).toBe(script);

    // Approved, the binding reaches the runner so it can re-check the bytes.
    await fixture.operation('decideAgentGrant', { grantId: interpreter.grantId, decision: 'always' });
    const live = (await (await fixture.daemonOperation('listAgentGrants', { agentId: AGENT })).json()) as {
      grants: Array<{ grantId: string; script?: { sha256: string } }>;
    };
    expect(live.grants.find((entry) => entry.grantId === interpreter.grantId)!.script).toEqual(
      expect.objectContaining({ path: 'fix.py', contents: script }),
    );

    // The hash is the binding, so contents that do not hash to it are refused.
    const lying = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      kind: 'command',
      target: 'python3 lie.py',
      reason: 'because',
      script: {
        path: 'lie.py',
        sha256: 'a'.repeat(64),
        bytes: Buffer.byteLength(script),
        contents: script,
      },
    });
    expect(lying.status).toBe(400);
    expect(((await lying.json()) as { error: string }).error).toContain(
      'hash does not match its contents',
    );

    // A script too long to read honestly is refused, never truncated.
    const long = Array.from({ length: 400 }, (_, index) => `line ${index}`).join('\n');
    const refused = await fixture.daemonOperation('requestAgentGrant', {
      roomId: ROOM,
      kind: 'command',
      target: 'python3 huge.py',
      reason: 'because',
      script: {
        path: 'huge.py',
        sha256: createHash('sha256').update(long).digest('hex'),
        bytes: Buffer.byteLength(long),
        contents: long,
      },
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('will not be truncated');

    // Corner automatic grants also remain silent.
    const cornerId = '44444444-4444-4444-8444-444444444444';
    await fixture.database.query(
      `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Corner')`,
      [cornerId, WORKSPACE, ROOM, AGENT],
    );
    await fixture.daemonOperation('requestAgentGrant', {
      roomId: cornerId,
      kind: 'command',
      target: 'npm test',
      reason: 'because',
    });
    const cornerLine = await fixture.database.query<{ text: string }>(
      `SELECT text FROM messages WHERE card_type='grant-auto' AND card->>'grantId' IN (SELECT id::text FROM agent_grants WHERE room_id=$1)`,
      [cornerId],
    );
    expect(cornerLine.rows).toEqual([]);

    // A script in the agent's own state directory is not a credential file: a
    // plain read of an absolute scratch path is an ordinary yolo command again,
    // and an unread script named by that same path carries only its own stop.
    const scratchPath =
      '/home/op/.local/state/beeline/agents/a1/rooms/r1/scratch/agent-home/ops/watchdog.py';
    expect(await ask(`cat ${scratchPath}`)).toEqual(
      expect.objectContaining({ status: 'approved', auto: true }),
    );
    const scratchScript = 'print("watchdog")\n';
    expect(
      await ask(`python3 ${scratchPath}`, {
        script: {
          path: scratchPath,
          sha256: createHash('sha256').update(scratchScript).digest('hex'),
          bytes: Buffer.byteLength(scratchScript),
          contents: scratchScript,
        },
      }),
    ).toEqual(
      expect.objectContaining({ status: 'pending', auto: false, escalations: ['unseen-script'] }),
    );
    // The files directly in the agent's runtime folder hold its identity keys,
    // so a read there still stops even though the rest of the state tree is clear.
    expect(await ask('cat /home/op/.local/state/beeline/agents/a1/runtime.json')).toEqual(
      expect.objectContaining({ status: 'pending', auto: false, escalations: ['credential'] }),
    );
  });
});
