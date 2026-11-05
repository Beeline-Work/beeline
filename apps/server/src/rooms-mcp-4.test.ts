import { cornerOwnerSql, describe, expect, it, MCP_ORDER_WAKE_HINT, MCP_REVIEW_WAKE_HINT, randomUUID, MCP_AGENT_EXCLUSIONS, MCP_APP_ROUTE_OPERATIONS, createAgentCommand, deliverMcpMemberWebhooks, USER, OTHER, AGENT, WORKSPACE, ROOM, CORNER, PUBLIC_CORNER, fixtureScope1, fixtureScope3 } from './rooms-mcp.test-support.js';

describe('Rooms connector HTTP OAuth and MCP', () => {
const scope1 = fixtureScope1();
describe('agent tools for a connected app', () => {
const scope3 = fixtureScope3(scope1);

    it('R-MCP-PARITY: exposes every agent tool except the documented exclusions', async () => {
      const surface = await import('../../body/src/minimal-tool-surface.js');
      const agentTools = new Set([
        ...surface.minimalTools(true), ...surface.minimalTools(false), surface.RUNNER_TOOL, surface.SILENT_TOOL,
        ...surface.scratchTools(true), ...surface.repositoryTools(),
      ].map(definition => definition.name));
      for (const name of [...Object.values(surface.REPOSITORY_ROUTES), ...Object.values(surface.SCRATCH_ROUTES),
        ...Object.values(surface.CAPABILITY_ROUTES).flatMap(routes => Object.values(routes))]) agentTools.add(name);
      const { client } = await scope1.connected();
      const exposed = new Set([...(await client.listTools()).tools.map(definition => definition.name), ...MCP_APP_ROUTE_OPERATIONS]);
      const missing = [...agentTools].filter(name => !exposed.has(name) && !MCP_AGENT_EXCLUSIONS[name]);
      expect(missing).toEqual([]);
      expect(Object.keys(MCP_AGENT_EXCLUSIONS).filter(name => exposed.has(name))).toEqual([]);
      // Every exclusion names a real agent tool, so the table cannot hide a typo.
      expect(Object.keys(MCP_AGENT_EXCLUSIONS).filter(name => !agentTools.has(name))).toEqual([]);
      // Reproduction (R-MCP-ROUTES): names alone hid that beeline:workflow had no describe action, which the
      // helper's start description tells agents to call first. Every helper app action is listed or excluded.
      for (const [app, routes] of Object.entries(surface.CAPABILITY_ROUTES)) {
        const listed = await scope3.call(client, 'app_tool', { address: ROOM, app: `beeline:${app}` });
        const actions = listed.error ? [] : (JSON.parse(listed.text).data.tools as { name: string }[]).map(entry => entry.name);
        const missingActions = Object.entries(routes).filter(([action, op]) => !actions.includes(action) && !MCP_AGENT_EXCLUSIONS[op]);
        expect(missingActions, app).toEqual([]);
      }
    });

    it('R-MCP-EXCLUDED: refuses wallet spending and host grants with a plain reason', async () => {
      const { client } = await scope1.connected();
      for (const name of ['wallet_pay', 'wallet_swap', 'wallet_contract_call', 'wallet_sign_typed_data',
        'create_link_spend_request', 'wait_link_spend_request', 'request_grant', 'run_granted_command']) {
        const refused = await scope3.call(client, name, {});
        expect(refused.error, name).toBe(true);
        expect(refused.text).toMatch(name.includes('grant') ? /host grants are kept out of connected apps/ : /wallet spending is kept out of connected apps/);
      }
      for (const tool of ['pay', 'swap', 'contract_call', 'sign_typed_data', 'link_request', 'link_wait']) {
        const refused = await scope3.call(client, 'app_tool', { address: ROOM, app: 'beeline:wallet', tool, args: { amount: '1', to: '0x0' } });
        expect(refused.error, tool).toBe(true);
        expect(refused.text).toContain('wallet spending is kept out of connected apps');
      }
      const listed = await scope3.ok(client, 'app_tool', { address: ROOM, app: 'beeline:wallet' });
      expect(listed.tools.map((entry: { name: string }) => entry.name)).toEqual(['address', 'balance', 'chains', 'history', 'quote']);
      expect((await scope1.db.query("SELECT 1 FROM agent_grants WHERE kind='mcp' AND target='wallet'")).rowCount).toBe(0);
    });

    it('R-MCP-ORDER: orders an agent and receives its report as a wake', async () => {
      const { client, member } = await scope1.connected();
      const ordered = await scope3.ok(client, 'order', { address: ROOM, agent: 'demo-agent', text: 'Check the nebula numbers.' });
      expect(ordered.accepted).toBe(true);
      const order = (await scope1.db.query<{ id: string; turn_request_id: string; private_payload: { authorId: string } }>(
        `SELECT id,turn_request_id,private_payload FROM agent_commands WHERE id=$1`, [ordered.id])).rows[0]!;
      expect(order.private_payload.authorId).toBe(member);
      // The app's own call left no open turn behind.
      expect((await scope1.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state<>'complete'`, [member])).rowCount).toBe(0);
      const generationId = 'gen-report';
      await scope1.daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: order.id, generationId } as never, AGENT);
      await scope1.daemon.execute('report', { roomId: ROOM, requestId: order.turn_request_id, generationId, status: 'done', text: 'done: the numbers match' } as never, AGENT);
      const wakes = (await scope3.ok(client, 'list_mentions', {})).wakes as { address: string; reason: string; text: string }[];
      expect(wakes).toContainEqual(expect.objectContaining({ address: ROOM, reason: 'report', text: expect.stringContaining('the numbers match') }));
      expect((await scope3.ok(client, 'no_reply_needed', { address: ROOM })).cleared).toBe(1);
      expect((await scope3.ok(client, 'list_mentions', {})).wakes).toEqual([]);
    });

    it('R-MCP-REPORT: reports an order back to the agent that sent it', async () => {
      const { client, member, grant } = await scope1.connected();
      await scope1.db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/orders' WHERE id=$1`, [grant.clientId]);
      const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      expect((await scope3.call(client, 'report', { address: ROOM, status: 'done', text: 'done: nothing was ordered' })).text)
        .toContain('no order is waiting for your report');
      const turn = await scope3.agentTurn('@demo-agent hand the audit to the app');
      const sent = await scope1.daemon.execute('order', { ...turn, address: ROOM, agent: handle, text: 'Audit the corner list.' } as never, AGENT) as { id: string };
      // The order reaches the app's webhook at once; no helper claims it.
      expect((await scope1.db.query<{ body: string }>('SELECT body FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2',
        [member, sent.id])).rows[0]?.body).toContain('Order (order): Audit the corner list.');
      // Reproduction: the delivered body once named the command id as a message to reply to, under tag instructions.
      const delivered: Record<string, unknown>[] = [];
      await deliverMcpMemberWebhooks(scope1.db, async (_url, init) => { delivered.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); });
      const orderBody = delivered.find(body => body.commandId === sent.id)!;
      expect(orderBody).toMatchObject({ memberId: member, roomId: ROOM, address: ROOM, id: sent.id, kind: 'order', reason: 'order',
        text: expect.stringContaining('Audit the corner list.'), next: MCP_ORDER_WAKE_HINT, cursor: null });
      expect(orderBody).not.toHaveProperty('replyRule');
      expect(orderBody).not.toHaveProperty('messageId');
      expect(String(orderBody.instruction)).not.toMatch(/tagged you|replyTo [0-9a-f]{64}|send_message/);
      expect(String(orderBody.instruction)).toContain('call report');
      const wakes = (await scope3.ok(client, 'list_mentions', {})).wakes as { address: string; kind?: string; text?: string }[];
      expect(wakes).toContainEqual(expect.objectContaining({ address: ROOM, kind: 'order', text: expect.stringContaining('Audit the corner list') }));
      // Another call in that Room leaves the order waiting for its report.
      await scope3.ok(client, 'read', { facet: 'members', address: ROOM });
      await scope3.ok(client, 'post', { address: ROOM, text: 'Auditing now.' });
      expect((await scope1.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND private_payload->>'kind'='order' AND state='pending'`, [member])).rowCount).toBe(1);
      expect((await scope3.call(client, 'report', { address: ROOM, status: 'done', text: '' })).error).toBe(true);
      await scope3.ok(client, 'report', { address: ROOM, status: 'done', text: 'three corners, all green' });
      const back = (await scope1.db.query<{ private_payload: { kind: string; text: string } }>(
        `SELECT private_payload FROM agent_commands WHERE agent_id=$1 AND reason='report' ORDER BY created_at DESC LIMIT 1`, [AGENT])).rows[0]!;
      expect(back.private_payload).toMatchObject({ kind: 'report', text: 'done: three corners, all green' });
      expect((await scope1.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND state<>'complete'`, [member])).rowCount).toBe(0);
      // A reviewer dispatch by legacy webhook carries the same review hint as MCP Events and list_mentions.
      const review = await createAgentCommand(scope1.db, {
        roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'corner_review_dispatch',
        privatePayload: { text: `Current handoff target: PR #7 at ${'a'.repeat(40)}.`, authorId: AGENT, fromRoomId: ROOM, kind: 'lifecycle' },
      });
      delivered.length = 0;
      await deliverMcpMemberWebhooks(scope1.db, async (_url, init) => { delivered.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); });
      expect(delivered.find(body => body.commandId === review!.id)).toMatchObject({ reason: 'corner_review_dispatch', next: MCP_REVIEW_WAKE_HINT });
    });

    it.each(['standalone', 'order'] as const)('R-MCP-ARTIFACT: a Room member posts files into its corner without a corner membership (%s)', async mode => {
      const { client, member } = await scope1.connected();
      const corner = await scope3.reportCorner(member);
      const order = mode === 'order' ? await createAgentCommand(scope1.db, { roomId: corner, agentId: member,
        sourceMessageId: null, reason: 'order', privatePayload: {
          kind: 'order', authorId: AGENT, fromRoomId: ROOM, text: 'Post the corner mock.',
        } }) : null;
      const command = order ? { commandId: order.id } : {};
      const noCornerMemberships = async () => expect((await scope1.db.query(
        'SELECT 1 FROM memberships WHERE room_id=$1', [corner])).rowCount).toBe(0);
      await noCornerMemberships();
      const posted = await scope3.ok(client, 'post_artifact', { ...command, address: corner, title: 'mock.html',
        html: '<!doctype html><title>Mock</title><p>Corner mock</p>', text: 'Here is the mock.' });
      expect((await scope1.db.query('SELECT room_id,text,attachments FROM messages WHERE id=$1', [posted.id])).rows[0])
        .toMatchObject({ room_id: corner, text: 'Here is the mock.', attachments: [
          { name: 'mock.html', mimeType: 'text/html', url: expect.stringContaining('/media/') },
        ] });
      const second = await scope3.ok(client, 'post_artifact', { ...command, address: corner, title: 'mock.txt',
        mime: 'text/plain', bytes: Buffer.from('Mock notes').toString('base64') });
      expect((await scope1.db.query('SELECT room_id,attachments FROM messages WHERE id=$1', [second.id])).rows[0])
        .toMatchObject({ room_id: corner, attachments: [{ name: 'mock.txt', mimeType: 'text/plain' }] });
      expect((await scope1.db.query('SELECT 1 FROM messages WHERE room_id=$1 AND author_id=$2', [ROOM, member])).rowCount).toBe(0);
      expect((await scope1.db.query('SELECT 1 FROM agent_pending_attachments WHERE agent_id=$1', [member])).rowCount).toBe(0);
      await noCornerMemberships();
    });

    it('R-MCP-ARTIFACT: refuses inaccessible and archived corners before uploading', async () => {
      const { client, member } = await scope1.connected();
      const corner = await scope3.reportCorner(member);
      const artifact = { title: 'private.html', html: '<p>Private mock</p>' };
      expect((await scope3.call(client, 'post_artifact', { ...artifact, address: CORNER })).text).toContain('Access denied');
      await scope1.db.query('UPDATE rooms SET archived_at=now() WHERE id=$1', [corner]);
      expect((await scope3.call(client, 'post_artifact', { ...artifact, address: corner })).text).toContain('Access denied');
      await scope1.db.query('UPDATE rooms SET archived_at=NULL WHERE id=$1', [corner]);
      await scope1.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [ROOM, member]);
      expect((await scope3.call(client, 'post_artifact', { ...artifact, address: corner })).text).toContain('Access denied');
      expect((await scope1.db.query('SELECT 1 FROM objects WHERE owner_id=$1', [member])).rowCount).toBe(0);
      expect((await scope1.db.query('SELECT 1 FROM messages WHERE author_id=$1', [member])).rowCount).toBe(0);
    });

    // Reproduction (R-MCP-PROGRESS): an outside agent could only post whole messages, so a corner showed none of
    // its work while it ran; created agents' narration lands as corner activity.
    it('E1: explicit order preserves requester and generation through merge yes and report', async () => {
      const { client, member } = await scope1.connected();
      const corner = await scope3.reportCorner(member);
      const source = 'e1'.repeat(32), unrelated = 'e2'.repeat(32);
      await scope1.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$3,$4,'Please finish this order'),($2,$3,$5,'Unrelated later tag')`,
        [source, unrelated, ROOM, USER, OTHER]);
      await scope1.db.query(`INSERT INTO rooms_mcp_mentions(member_id,room_id,message_id) VALUES($1,$2,$3)`, [member, corner, unrelated]);
      const order = await createAgentCommand(scope1.db, { roomId: corner, agentId: member, sourceMessageId: source,
        reason: 'order', privatePayload: { kind: 'order', authorId: AGENT, fromRoomId: ROOM, text: 'Finish this order' } });
      const head = 'd'.repeat(40);
      await scope1.db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [corner,
        JSON.stringify({ lifecycle: 'in-review', checks: 'passing', pr: { number: 7, headSha: head } })]);
      await scope3.ok(client, 'post', { address: corner, commandId: order!.id, progress: true, text: 'Checking the order.' });
      const before = (await scope1.db.query<{ generation_id: string; root_source_message_id: string; state: string }>(
        `SELECT generation_id,root_source_message_id,state FROM agent_commands WHERE id=$1`, [order!.id])).rows[0]!;
      expect(before).toMatchObject({ state: 'claimed', root_source_message_id: source });
      await scope3.ok(client, 'record_merge_yes', { address: corner, commandId: order!.id });
      expect((await scope1.db.query(`SELECT approved_by,head_sha FROM corner_merge_approvals WHERE corner_id=$1`, [corner])).rows[0])
        .toMatchObject({ approved_by: USER, head_sha: head });
      expect((await scope1.db.query(`SELECT generation_id FROM agent_commands WHERE id=$1`, [order!.id])).rows[0])
        .toEqual({ generation_id: before.generation_id });
      await scope3.ok(client, 'report', { address: corner, commandId: order!.id, status: 'done', text: 'done: order complete' });
      expect((await scope1.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [order!.id])).rows[0]).toEqual({ state: 'complete' });
      expect((await scope3.call(client, 'record_merge_yes', { address: corner, commandId: order!.id })).error).toBe(true);
    });

    it('E1: ambiguous fallback refuses; explicit order fences wrong member, address and generation', async () => {
      const { client, member } = await scope1.connected();
      const first = await scope3.reportCorner(member), second = await scope3.reportCorner(member);
      const orders = [];
      for (const corner of [first, second]) orders.push(await createAgentCommand(scope1.db, { roomId: corner, agentId: member, sourceMessageId: null,
        reason: 'corner_objective', privatePayload: { kind: 'order', authorId: AGENT, fromRoomId: ROOM, text: 'Finish' } }));
      expect((await scope3.call(client, 'report', { address: ROOM, status: 'done', text: 'done: ambiguous' })).text).toContain('ambiguous report');
      expect((await scope3.call(client, 'post', { address: second, commandId: orders[0]!.id, text: 'wrong address' })).error).toBe(true);
      expect((await scope3.call(client, 'post', { address: first, commandId: '0'.repeat(64), text: 'fabricated' })).error).toBe(true);
      await scope1.db.query(`UPDATE agent_commands SET agent_id=$2 WHERE id=$1`, [orders[0]!.id, AGENT]);
      expect((await scope3.call(client, 'post', { address: first, commandId: orders[0]!.id, text: 'wrong member' })).error).toBe(true);
      await scope1.db.query(`UPDATE agent_commands SET agent_id=$2 WHERE id=$1`, [orders[0]!.id, member]);
      await scope1.db.query(`UPDATE agent_commands SET state='claimed',generation_id='helper-generation',lease_expires_at=now()+interval '1 minute' WHERE id=$1`, [orders[0]!.id]);
      expect((await scope3.call(client, 'post', { address: first, commandId: orders[0]!.id, text: 'another active lease' })).error).toBe(true);
      await scope1.db.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`, [orders[0]!.id]);
      expect((await scope3.call(client, 'post', { address: first, commandId: orders[0]!.id, progress: true, text: 'Expired clocks cannot steal work' })).error).toBe(true);
      await scope1.db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL WHERE id=$1`, [orders[0]!.id]);
      await scope3.ok(client, 'post', { address: first, commandId: orders[0]!.id, progress: true, text: 'Explicitly returned work' });
      expect((await scope1.db.query<{ generation_id: string }>(`SELECT generation_id FROM agent_commands WHERE id=$1`, [orders[0]!.id])).rows[0]!.generation_id).toMatch(/^mcp:/);
      await scope3.ok(client, 'report', { address: first, commandId: orders[0]!.id, status: 'done', text: 'done: first' });
      await scope3.ok(client, 'report', { address: second, commandId: orders[1]!.id, status: 'done', text: 'done: second' });
    });

    it('R-MCP-PROGRESS: post progress:true records a progress line in the corner, not a message', async () => {
      const { client, member } = await scope1.connected();
      const corner = await scope3.reportCorner(member);
      expect(await scope3.ok(client, 'post', { address: corner, text: 'Read the brief; running the tests next.', progress: true }))
        .toEqual({ recorded: true, address: corner });
      const rows = (await scope1.db.query<{ presentation: string; text: string; activity: { kind: string; title: string; text: string }[] | null }>(
        `SELECT presentation,text,activity FROM messages WHERE room_id=$1 AND author_id=$2 ORDER BY created_at`, [corner, member])).rows;
      expect(rows).toEqual([{ presentation: 'activity', text: '', activity: [{ kind: 'output', title: 'Update', text: 'Read the brief; running the tests next.' }] }]);
      // The one-call turn closed, and no wake was queued for anyone.
      expect((await scope1.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND status='working'`, [corner, member])).rowCount).toBe(0);
      expect((await scope1.db.query(`SELECT 1 FROM agent_commands WHERE room_id=$1 AND agent_id<>$2 AND state='pending'`, [corner, member])).rowCount).toBe(0);
      expect((await scope3.call(client, 'post', { address: ROOM, text: 'not a corner', progress: true })).text).toContain('progress lines go in a corner');
    });

    it.each(['corner', 'parent'])('R1: reports a corner objective through the %s address and clears working', async address => {
      const { client, member } = await scope1.connected();
      const corner = await scope3.reportCorner(member);
      const objective = await createAgentCommand(scope1.db, { roomId: corner, agentId: member, sourceMessageId: null,
        reason: 'corner_objective', privatePayload: { kind: 'order', authorId: AGENT, fromRoomId: ROOM, text: 'Finish the corner' } });
      expect(await scope3.cornerWorking(corner)).toBe(true);
      await scope3.ok(client, 'report', { address: address === 'corner' ? corner : ROOM, status: 'done', text: 'done: corner work finished' });
      expect((await scope1.db.query<{ state: string }>('SELECT state FROM agent_commands WHERE id=$1', [objective!.id])).rows[0]!.state).toBe('complete');
      expect(await scope3.cornerWorking(corner)).toBe(false);
      expect((await scope1.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND reason='report' AND private_payload->>'originCornerId'=$2`, [AGENT, corner])).rowCount).toBe(1);
    });

    it('R1: no pending order reports to the opening commander, while nonmembers are refused', async () => {
      const { client, member } = await scope1.connected();
      const corner = await scope3.reportCorner(member);
      await scope3.ok(client, 'report', { address: corner, status: 'done', text: 'done: finished without a pending order' });
      expect((await scope1.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1 AND reason='report' AND private_payload->>'originCornerId'=$2`, [AGENT, corner])).rowCount).toBe(1);
      expect((await scope3.call(client, 'report', { address: CORNER, status: 'done', text: 'done: forbidden corner' })).text).toContain('Access denied');
    });

    it('R1: prefers the given address, then the oldest pending order elsewhere', async () => {
      const { client, member } = await scope1.connected();
      const first = await scope3.reportCorner(member), second = await scope3.reportCorner(member);
      const orders = [];
      for (const corner of [first, second]) orders.push(await createAgentCommand(scope1.db, { roomId: corner, agentId: member, sourceMessageId: null,
        reason: 'corner_objective', privatePayload: { kind: 'order', authorId: AGENT, fromRoomId: ROOM, text: 'Finish' } }));
      await scope3.ok(client, 'report', { address: second, status: 'done', text: 'done: second first' });
      expect((await scope1.db.query<{ state: string }>('SELECT state FROM agent_commands WHERE id=$1', [orders[0]!.id])).rows[0]!.state).toBe('pending');
      await scope3.ok(client, 'report', { address: ROOM, status: 'done', text: 'done: oldest remaining' });
      expect((await scope1.db.query<{ state: string }>('SELECT state FROM agent_commands WHERE id=$1', [orders[0]!.id])).rows[0]!.state).toBe('complete');
    });

    it('R-MCP-GATES: keeps reviewer, merge, hold and implementer gates for the app', async () => {
      const { client, member } = await scope1.connected();
      // Not the configured reviewer: no PASS.
      const pass = await scope3.call(client, 'approve_merge', { address: PUBLIC_CORNER, headSha: 'a'.repeat(40) });
      expect(pass.error).toBe(true);
      expect(pass.text).toMatch(/NOT_CONFIGURED_REVIEWER|reviewer/);
      // No pull request and no checks: the merge gate stays closed.
      expect(await scope3.ok(client, 'merge_corner', { address: PUBLIC_CORNER })).toMatchObject({ status: 'blocked' });
      // Agent callers must cite a readable person's request.
      const hold = await scope3.call(client, 'set_corner_hold', { address: PUBLIC_CORNER });
      expect(hold.error).toBe(true);
      expect(hold.text).toContain('close the PR to stop it');
      // A person's tag makes that person the requester, as it does for an agent turn.
      const handle0 = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const request = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle0} hold the demo corner` }, USER);
      const held = await scope3.ok(client, 'set_corner_hold', { address: PUBLIC_CORNER, sourceMessageId: request.messageId });
      expect(held.holdId).toMatch(/^[0-9a-f-]{36}$/);
      expect(await scope3.ok(client, 'set_corner_hold', { address: PUBLIC_CORNER, releaseHoldId: held.holdId })).toBeDefined();
      // An app has no checkout, so repository work needs another implementer.
      const repoRoom = randomUUID();
      await scope1.db.query(`INSERT INTO rooms(id,workspace_id,name,visibility,repository_key,repository_remote,repository_resolution)
        VALUES($1,$2,'Repo','public','acme/repo','https://github.com/acme/repo.git','repository')`, [repoRoom, WORKSPACE]);
      await scope1.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [WORKSPACE, repoRoom, member, AGENT]);
      const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const self = await scope3.call(client, 'open_corner', { room: repoRoom, implementer: handle, brief: { spec: 'Fix the login copy.' } });
      expect(self.error).toBe(true);
      expect(self.text).toContain('cannot implement repository work; name another agent as implementer');
      expect((await scope1.db.query('SELECT 1 FROM rooms WHERE parent_id=$1', [repoRoom])).rowCount).toBe(0);
    });

    it('R-MCP-CORNER: opens a corner with another implementer and posts in it', async () => {
      const { client } = await scope1.connected();
      const opened = await scope3.ok(client, 'open_corner', { room: ROOM, name: 'nebula-check', objective: 'Check the nebula numbers',
        implementer: 'demo-agent', brief: { spec: '## Intent\nCheck the nebula numbers.', repositoryWork: false } });
      expect(opened.status).toBe('starting');
      const corner = opened.address as string;
      expect((await scope1.db.query<{ owner_agent_id: string }>(`SELECT ${cornerOwnerSql('$1::uuid')} owner_agent_id`, [corner])).rows[0]?.owner_agent_id).toBeDefined();
      const posted = await scope3.ok(client, 'post', { address: corner, text: 'Numbers attached below.' });
      expect(posted.stored).toBe(true);
      await scope3.ok(client, 'react_to_message', { address: corner, messageId: posted.id, emoji: '👀' });
      expect((await scope3.ok(client, 'read', { facet: 'brief', address: corner })).revisions?.length ?? 1).toBeGreaterThan(0);
    });
});
});
