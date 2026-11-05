import { phoneFetch, BackgroundWork, describe, expect, it, vi, createServer, Webhook, MCP_ORDER_WAKE_HINT, MCP_REVIEW_WAKE_HINT, MCP_WAKE_HINT, backfillMcpMemberRoomsAndAvatars, ensureMcpMember, postMcpWebhook, randomBytes, createHash, randomUUID, Client, StreamableHTTPClientTransport, tokenHash, recordSigninAttempt, pendingMcpWakes, createAgentCommand, routeHumanMessage, openSecrets, deliverMcpMemberWebhooks, runMcpWebhookDelivery, USER, OTHER, AGENT, WORKSPACE, ROOM, opaque, fixtureScope1, type AddressInfo } from './rooms-mcp.test-support.js';

describe('Rooms connector HTTP OAuth and MCP', () => {
const scope1 = fixtureScope1();

  // Run the repeated global backfill proof before unrelated HTTP clients accumulate.
  it('MCP-WORKSPACE-1: limits initial membership through exchange and refresh, and preserves memberships when reconnect deselects', async () => {
    const secondWorkspace = randomUUID(), secondRoom = randomUUID();
    await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other eligible Workspace')`, [secondWorkspace]);
    await scope1.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [secondWorkspace, USER]);
    await scope1.db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'Excluded public Room','public')`, [secondRoom, secondWorkspace]);
    try {
      const grant = await scope1.authorize();
      expect(grant.consentHtml).toContain('Workspaces');
      expect(grant.consentHtml).toContain('Other eligible Workspace');
      const member = (await scope1.db.query<{ member_id: string; workspace_ids: string[] }>(
        'SELECT member_id,workspace_ids FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [grant.clientId, USER])).rows[0]!;
      expect(member.workspace_ids).toEqual([WORKSPACE]);
      const response = await scope1.exchange(grant);
      expect(response.status).toBe(200);
      const tokens = await response.json() as { access_token: string; refresh_token: string };
      const client = new Client({ name: 'workspace-selection-proof', version: '1.0.0' }); scope1.clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(scope1.origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
      const activeWorkspaces = async () => (await scope1.db.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL ORDER BY workspace_id', [member.member_id])).rows.map(row => row.workspace_id);
      expect(await activeWorkspaces()).toEqual([WORKSPACE]);
      expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).not.toContain(secondRoom);
      expect((await client.callTool({ name: 'read_messages', arguments: { room: secondRoom } })).isError).toBe(true);
      expect((await client.callTool({ name: 'send_message', arguments: { room: secondRoom, text: 'must not send' } })).isError).toBe(true);
      expect((await scope1.post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
        client_id: grant.clientId, resource: scope1.origin + '/mcp' })).status).toBe(200);
      await ensureMcpMember(scope1.db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      await backfillMcpMemberRoomsAndAvatars(scope1.db);
      expect(await activeWorkspaces()).toEqual([WORKSPACE]);
      // Reconnecting may add a Workspace; deselection preserves existing memberships.
      const both = await scope1.authorize(undefined, 'allow', grant.clientId, undefined, { workspace_ids: [WORKSPACE, secondWorkspace] });
      expect((await scope1.exchange(both)).status).toBe(200);
      expect(await activeWorkspaces()).toEqual([WORKSPACE, secondWorkspace].sort());
      const narrowed = await scope1.authorize(undefined, 'allow', grant.clientId, undefined, { workspace_ids: [secondWorkspace] });
      expect((await scope1.exchange(narrowed)).status).toBe(200);
      expect(await activeWorkspaces()).toEqual([WORKSPACE, secondWorkspace].sort());
      expect((await scope1.db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND workspace_id=$2 AND removed_at IS NULL', [member.member_id, WORKSPACE])).rowCount).toBeGreaterThan(0);
      expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM } })).isError).not.toBe(true);
      await ensureMcpMember(scope1.db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      await backfillMcpMemberRoomsAndAvatars(scope1.db);
      expect(await activeWorkspaces()).toEqual([WORKSPACE, secondWorkspace].sort());
      const reconnect = await scope1.prepareAuthorization(undefined, grant.clientId);
      const checkboxes = reconnect.consentHtml.match(/<input\b[^>]*type="checkbox"[^>]*name="workspace_ids"[^>]*>/g) ?? [];
      expect(checkboxes.find(input => input.includes(secondWorkspace))).toMatch(/\bchecked\b/);
      expect(checkboxes).toHaveLength(2);
      for (const checkbox of checkboxes) expect(checkbox).toMatch(/\bchecked disabled\b/);
      expect(reconnect.consentHtml.match(/already connected/g)).toHaveLength(2);
      // Disabled checkboxes submit their stable IDs through matching hidden fields.
      const hidden = reconnect.consentHtml.match(/<input\b[^>]*type="hidden"[^>]*name="workspace_ids"[^>]*>/g) ?? [];
      expect(hidden).toHaveLength(2);
      const ids = hidden.map(input => /value="([^"]+)"/.exec(input)![1]);
      expect((await scope1.post('/mcp/oauth/consent', { flow: reconnect.flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: ids }, { cookie: reconnect.cookie, origin: scope1.origin })).status).toBe(302);
      expect(await activeWorkspaces()).toEqual([WORKSPACE, secondWorkspace].sort());
    } finally {
      await scope1.db.query('DELETE FROM workspaces WHERE id=$1', [secondWorkspace]);
    }
  });

  it.each(['server/join', 'short', 'short/', 'short/join'])('JOIN-1: %s authorizes, initializes, reads and posts with the same resource', async alias => {
    const short = alias.startsWith('short');
    const host = short ? `localhost:${new URL(scope1.origin).port}` : new URL(scope1.origin).host;
    const path = alias.endsWith('/join') ? '/join' : '/';
    const endpoint = (short ? `http://${host}` : scope1.origin) + path;
    const resource = alias === 'short' ? endpoint.slice(0, -1) : endpoint;
    const grant = await scope1.authorize('rooms:read rooms:write', 'allow', undefined, undefined, {}, resource);
    const issued = await scope1.exchange(grant, { resource });
    expect(issued.status).toBe(200);
    const { access_token: token } = await issued.json() as { access_token: string };
    // Muse preserves resource spelling and never follows redirects. A token
    // obtained with either the bare or slashed origin must POST directly to '/'.
    const direct = await phoneFetch(endpoint, { method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'muse-resource-proof', version: '1' },
      } }),
    });
    expect(direct.status).toBe(200);
    expect(direct.headers.get('location')).toBeNull();
    expect((await direct.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('beeline-rooms');
    const client = new Client({ name: 'join-alias-proof', version: '1' });
    scope1.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).toContain('Demo');
    expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM } })).isError).not.toBe(true);
    const text = `JOIN-1 synthetic post via ${alias}`;
    expect((await client.callTool({ name: 'send_message', arguments: { room: ROOM, text } })).isError).not.toBe(true);
    expect(JSON.stringify(await scope1.phone.readRoom(ROOM, USER))).toContain(text);
  }, 60_000);

  it.each(['webhook', 'events', 'bridge', 'none', 'expired bridge', 'expired events'])(
    'R2: tag receipt accounts for connected member route %s', async route => {
      const fixture = await scope1.eventFixture();
      const { member, token, params, grant, client } = fixture;
      const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      if (route === 'webhook') await scope1.db.query("UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/tags' WHERE id=$1", [grant.clientId]);
      if (route.includes('events')) {
        expect((await scope1.eventCall(token, 'events/subscribe', params)).error).toBeUndefined();
        if (route === 'expired events') await scope1.db.query("UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE member_id=$1", [member]);
      }
      if (route.includes('bridge')) {
        const now = new Date().toISOString();
        await client.callTool({ name: 'list_mentions', arguments: { waitSeconds: 1, wakesAfter: now } });
        if (route === 'expired bridge') await scope1.db.query("UPDATE rooms_mcp_members SET last_bridge_poll_at=now()-interval '61 seconds' WHERE member_id=$1", [member]);
      }
      const sender = await scope1.connected();
      const response = await sender.client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `@${handle} check this tag` } }) as { content: { text: string }[] };
      const receipt = JSON.parse(response.content[0]!.text).data;
      const live = ['webhook', 'events', 'bridge'].includes(route);
      expect(receipt.woken).toEqual(live ? [handle] : []);
      expect(receipt.notWoken).toEqual(live ? [] : [{ handle, reason: 'no live wake route; sees it on next list_mentions' }]);
      expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2', [member, receipt.messageId])).rowCount).toBe(1);
    }, 60_000);

  it('MCP-EVENTS-1: discovers, verifies, refreshes and unsubscribes on the authenticated MCP endpoint', async () => {
    const fixture = await scope1.eventFixture();
    const { token, params, posts, member } = fixture;
    const initialized = await scope1.eventCall(token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'events-test', version: '1' } });
    expect(initialized.result.capabilities.events).toEqual({});
    expect((await scope1.eventCall(token, 'server/discover')).result.capabilities.events).toEqual({});
    expect((await scope1.eventCall(token, 'events/list')).result.events).toMatchObject([
      { name: 'mention', delivery: ['webhook'] },
      { name: 'wake', delivery: ['webhook'] },
    ]);
    expect((await scope1.eventCall(token, 'events/list', { cursor: 'invalid' })).error?.code).toBe(-32602);
    const first = await scope1.eventCall(token, 'events/subscribe', params);
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({ cursor: null, truncated: false });
    expect(posts.map(p => p.body.type)).toEqual(['verification']);
    expect(posts[0]!.headers['X-MCP-Subscription-Id']).toBe(first.result.id);
    const saved = (await scope1.db.query<{ secret: string }>('SELECT secret FROM rooms_mcp_event_subscriptions WHERE id=$1', [first.result.id])).rows[0]!;
    expect(saved.secret).not.toContain(fixture.secret);
    const refresh = await scope1.eventCall(token, 'events/subscribe', { ...params, ttlMs: 60_000 });
    expect(refresh.result.id).toBe(first.result.id);
    expect(Date.parse(refresh.result.refreshBefore) - Date.now()).toBeLessThanOrEqual(60_000);
    expect(posts).toHaveLength(1);
    const noExpiry = await scope1.eventCall(token, 'events/subscribe', { ...params, ttlMs: null });
    expect(noExpiry.result.refreshBefore).toEqual(expect.any(String));
    expect((await scope1.db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE member_id=$1', [member])).rowCount).toBe(1);
    const { secret: _secret, ...delivery } = params.delivery;
    expect((await scope1.eventCall(token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery })).result).toEqual({});
    expect((await scope1.eventCall(token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery })).result).toEqual({});
    expect((await scope1.db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE member_id=$1', [member])).rowCount).toBe(0);
  });

  it('MCP-WEBHOOK-DEADLINE: an empty owner stays idle for a day, then a committed delivery wakes it once', async () => {
    await scope1.db.query('DELETE FROM rooms_mcp_webhook_outbox');
    const { token, params, member } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    let now = 0;
    const work = new BackgroundWork(() => now, () => {});
    const drain = vi.fn(() => runMcpWebhookDelivery(scope1.db, transport));
    work.addDeadline('mcp-webhooks', drain);
    await work.run(true);
    for (now = 60_000; now <= 24 * 60 * 60_000; now += 60_000) await work.run(false);
    expect(drain).toHaveBeenCalledOnce(); expect(transport).not.toHaveBeenCalled();
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' committed delivery' }, USER);
    work.wake('mcp-webhooks'); await work.run(false);
    expect(transport).toHaveBeenCalledOnce(); expect(drain).toHaveBeenCalledTimes(2);
    now += 24 * 60 * 60_000; await work.run(false);
    expect(drain).toHaveBeenCalledTimes(2);
  });


  it('MCP-WEBHOOK-DEADLINE: a bounded legacy bearer batch continues only for remaining rows', async () => {
    await scope1.db.query('DELETE FROM rooms_mcp_webhook_outbox');
    const { client, member } = await scope1.eventFixture();
    await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/bearer', secret: 'legacy-bearer' } });
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    for (const text of ['first', 'second'])
      await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' ' + text }, USER);
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    expect(await runMcpWebhookDelivery(scope1.db, transport, 1)).toBe(1);
    expect(transport).toHaveBeenCalledOnce();
    expect(await runMcpWebhookDelivery(scope1.db, transport, 1)).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(2);
  });


  it('MCP-WEBHOOK-DEADLINE: shutdown drains its active delivery and leaves the next row unclaimed', async () => {
    await scope1.db.query('DELETE FROM rooms_mcp_webhook_outbox');
    const { token, params, member } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    for (const text of ['active', 'queued'])
      await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' ' + text }, USER);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const transport = vi.fn(async () => { entered(); await held; return new Response(null, { status: 204 }); });
    const controller = new AbortController();
    const flight = runMcpWebhookDelivery(scope1.db, transport, 50, controller.signal);
    await ready; controller.abort(); release();
    expect(await flight).toBeUndefined(); expect(transport).toHaveBeenCalledOnce();
    expect((await scope1.db.query('SELECT attempts,claimed_at FROM rooms_mcp_event_deliveries WHERE delivered_at IS NULL')).rows)
      .toEqual([{ attempts: 0, claimed_at: null }]);
    expect(await runMcpWebhookDelivery(scope1.db, transport)).toBeUndefined(); expect(transport).toHaveBeenCalledTimes(2);
  });


  it('MCP-WEBHOOK-DEADLINE: persisted finite delivery attempts keep identity and terminate', async () => {
    await scope1.db.query('DELETE FROM rooms_mcp_webhook_outbox');
    const { token, params, member } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' finite dispatch' }, USER);
    const bodies: string[] = [], ids: string[] = [];
    const transport: typeof postMcpWebhook = async (_url, init) => {
      bodies.push(init.body); ids.push(init.headers['webhook-id']!);
      return new Response(null, { status: 503 });
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      await scope1.db.query("UPDATE rooms_mcp_event_deliveries SET next_attempt_at=now()-interval '1 second' WHERE delivered_at IS NULL");
      const delay = await runMcpWebhookDelivery(scope1.db, transport);
      expect(bodies).toHaveLength(attempt);
      if (attempt < 5) { expect(delay).toBeGreaterThan(25_000); expect(delay).toBeLessThanOrEqual(240_000); }
      else expect(delay).toBeUndefined();
    }
    expect(new Set(bodies).size).toBe(1); expect(new Set(ids).size).toBe(1);
    expect(await runMcpWebhookDelivery(scope1.db, transport)).toBeUndefined(); expect(bodies).toHaveLength(5);
  });


  it('MCP-WEBHOOK-DEADLINE: an in-flight persisted claim supplies its actual expiry', async () => {
    await scope1.db.query('DELETE FROM rooms_mcp_webhook_outbox');
    const { token, params, member } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' abandoned claim' }, USER);
    await scope1.db.query('UPDATE rooms_mcp_event_deliveries SET claimed_at=now(),attempts=1 WHERE delivered_at IS NULL');
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const delay = await runMcpWebhookDelivery(scope1.db, transport);
    expect(delay).toBeGreaterThan(50_000); expect(delay).toBeLessThanOrEqual(60_000);
    expect(transport).not.toHaveBeenCalled();
    await scope1.db.query("UPDATE rooms_mcp_event_deliveries SET claimed_at=now()-interval '61 seconds' WHERE delivered_at IS NULL");
    expect(await runMcpWebhookDelivery(scope1.db, transport)).toBeUndefined(); expect(transport).toHaveBeenCalledOnce();
  });


  it('MCP-EVENTS-1: a human tag reaches a local receiver once, and the connected member replies under its own byline', async () => {
    const fixture = await scope1.eventFixture();
    const { token, params, member, secret, url, client } = fixture;
    const received: any[] = [];
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, String(v)]));
      const event = new Webhook(secret).verify(body, headers) as any;
      received.push(event);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(event.type === 'verification' ? { challenge: event.challenge } : {}));
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    // Local receiver stand-in only: production retains HTTPS + public DNS pinning.
    scope1.eventTransport = async (target, init) => {
      expect(target).toBe(url);
      return phoneFetch(`http://127.0.0.1:${(receiver.address() as AddressInfo).port}`, { method: 'POST', ...init });
    };
    try {
      const subscription = (await scope1.eventCall(token, 'events/subscribe', params)).result;
      const other = await scope1.connected();
      const otherSecret = 'whsec_' + randomBytes(32).toString('base64');
      scope1.eventTransport = async (_target, init) => Response.json({ challenge: JSON.parse(init.body).challenge });
      expect((await scope1.eventCall(other.token, 'events/subscribe', { ...params,
        delivery: { ...params.delivery, url: 'https://hooks.example/other', secret: otherSecret } })).error).toBeUndefined();
      expect((await scope1.eventCall(other.token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url } })).result).toEqual({});
      expect((await scope1.db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE id=$1', [subscription.id])).rowCount).toBe(1);
      await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/bearer', secret: 'legacy-bearer' } });
      const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' reply here' }, USER);
      await routeHumanMessage(scope1.db, sent.messageId);
      expect((await scope1.db.query('SELECT subscription_id FROM rooms_mcp_event_deliveries WHERE message_id=$1', [sent.messageId])).rows).toEqual([{ subscription_id: subscription.id }]);
      let bearerCalls = 0;
      const deliveryTransport: typeof postMcpWebhook = async (target, init) => {
        if (target === 'https://hooks.example/bearer') {
          bearerCalls++; expect(init.headers.authorization).toBe('Bearer legacy-bearer'); return new Response(null, { status: 204 });
        }
        expect(target).toBe(url);
        expect(init.headers['X-MCP-Subscription-Id']).toBe(subscription.id);
        return phoneFetch(`http://127.0.0.1:${(receiver.address() as AddressInfo).port}`, { method: 'POST', ...init });
      };
      expect(await deliverMcpMemberWebhooks(scope1.db, deliveryTransport)).toBe(2);
      expect(bearerCalls).toBe(1);
      expect(received).toHaveLength(2);
      expect(received[1]).toMatchObject({ name: 'mention', cursor: null,
        data: { roomId: ROOM, messageId: sent.messageId, memberId: member, replyRule: `answer in this Room with replyTo ${sent.messageId}`, idempotencyKey: `mention:${member}:${sent.messageId}`, author: { id: USER }, text: '@' + handle + ' reply here' } });
      expect(await deliverMcpMemberWebhooks(scope1.db, deliveryTransport)).toBe(0);
      const reply = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'Event received.', replyTo: sent.messageId } });
      expect(reply.isError).not.toBe(true);
      const view = await scope1.phone.readRoom(ROOM, USER);
      expect(JSON.stringify(view)).toContain('Event received.');
      expect((await scope1.db.query('SELECT author_id FROM messages WHERE room_id=$1 AND text=$2', [ROOM, 'Event received.'])).rows).toEqual([{ author_id: member }]);
    } finally { receiver.closeAllConnections(); await new Promise<void>(resolve => receiver.close(() => resolve())); }
  });

  it.each(['challenge', 'private HTTPS', 'url', 'secret', 'member', 'cursor', 'ttl', 'name'])('MCP-EVENTS-1: refuses invalid %s before activation', async kind => {
    const { token, params, member } = await scope1.eventFixture();
    let input: Record<string, unknown> = params;
    if (kind === 'challenge') scope1.eventTransport = async () => Response.json({ challenge: 'wrong' });
    if (kind === 'private HTTPS') {
      scope1.eventTransport = postMcpWebhook;
      input = { ...params, delivery: { ...params.delivery, url: 'https://127.0.0.1/private' } };
    }
    if (kind === 'url') input = { ...params, delivery: { ...params.delivery, url: 'http://127.0.0.1/private' } };
    if (kind === 'secret') input = { ...params, delivery: { ...params.delivery, secret: 'whsec_c2hvcnQ=' } };
    if (kind === 'member') input = { ...params, arguments: { memberId: OTHER } };
    if (kind === 'cursor') input = { ...params, cursor: '1000' };
    if (kind === 'ttl') input = { ...params, ttlMs: -1 };
    if (kind === 'name') input = { ...params, name: 'order' };
    const result = await scope1.eventCall(token, 'events/subscribe', input);
    expect(result.error?.code).toBe(['challenge', 'private HTTPS'].includes(kind) ? -32015 : -32602);
    if (kind === 'challenge') expect(result.error?.data?.reason).toBe('challenge_failed');
    expect((await scope1.db.query('SELECT id FROM rooms_mcp_event_subscriptions WHERE member_id=$1', [member])).rowCount).toBe(0);
  });

  it.each(['expiration', 'removal', 'disconnect', 'unsubscribe', 'deleted message'])('MCP-EVENTS-1: queued text stays private after %s', async kind => {
    const { token, params, member, grant } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' private after revocation' }, USER);
    if (kind === 'expiration') await scope1.db.query("UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE member_id=$1", [member]);
    if (kind === 'removal') await scope1.phone.execute('removeRoomMember', { roomId: ROOM, memberId: member }, USER);
    if (kind === 'disconnect') await scope1.phone.execute('disconnectAiClient', { clientId: grant.clientId }, USER);
    if (kind === 'unsubscribe') await scope1.eventCall(token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url: params.delivery.url } });
    if (kind === 'deleted message') await scope1.db.query('UPDATE messages SET deleted_at=now() WHERE id=$1', [sent.messageId]);
    const deliver = vi.fn(async () => new Response(null, { status: 204 }));
    await deliverMcpMemberWebhooks(scope1.db, deliver);
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([410, 413])('MCP-EVENTS-1: terminal callback response %s retires the delivery', async status => {
    const { token, params, member } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' terminal response' }, USER);
    const transport = vi.fn(async () => new Response(null, { status }));
    await deliverMcpMemberWebhooks(scope1.db, transport);
    await scope1.db.query('UPDATE rooms_mcp_event_deliveries SET next_attempt_at=now()');
    await deliverMcpMemberWebhooks(scope1.db, transport);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('MCP-EVENTS-1: a concurrent drain cannot redeliver an in-flight event', async () => {
    const { token, params, member } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' concurrent drain' }, USER);
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const transport = vi.fn(async () => { entered(); await ready; return new Response(null, { status: 204 }); });
    const first = deliverMcpMemberWebhooks(scope1.db, transport);
    await started;
    try {
      expect(await deliverMcpMemberWebhooks(scope1.db, transport)).toBe(0);
    } finally { release(); }
    expect(await first).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('MCP-EVENTS-1: secret rotation keeps both signatures briefly; retries preserve event identity', async () => {
    const { token, params, member, secret } = await scope1.eventFixture();
    await scope1.eventCall(token, 'events/subscribe', params);
    const replacement = 'whsec_' + randomBytes(32).toString('base64');
    scope1.eventTransport = async (_url, init) => {
      const body = new Webhook(replacement).verify(init.body, init.headers) as any;
      return Response.json({ challenge: body.challenge });
    };
    await scope1.eventCall(token, 'events/subscribe', { ...params, delivery: { ...params.delivery, secret: replacement } });
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' retry me' }, USER);
    const attempts: string[] = [];
    const transport: typeof postMcpWebhook = async (_url, init) => {
      expect(() => new Webhook(secret).verify(init.body, init.headers)).not.toThrow();
      expect(() => new Webhook(replacement).verify(init.body, init.headers)).not.toThrow();
      attempts.push(init.body);
      return new Response(null, { status: attempts.length === 1 ? 503 : 204 });
    };
    expect(await deliverMcpMemberWebhooks(scope1.db, transport)).toBe(0);
    expect(await deliverMcpMemberWebhooks(scope1.db, transport)).toBe(0);
    await scope1.db.query('UPDATE rooms_mcp_event_deliveries SET next_attempt_at=now() WHERE delivered_at IS NULL');
    expect(await deliverMcpMemberWebhooks(scope1.db, transport)).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
  });

  it('MCP-WAKE-1: a subscribed member gets one signed wake for an order, a report, and a corner assignment', async () => {
    const fixture = await scope1.eventFixture();
    const { token, params, member, secret, url } = fixture;
    const other = await scope1.connected();
    const wakeSecret = 'whsec_' + randomBytes(32).toString('base64');
    const wakeUrl = 'https://hooks.example/wake/' + opaque();
    scope1.eventTransport = async (_target, init) => Response.json({ challenge: JSON.parse(init.body).challenge });
    const source = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: 'Hold a turn for a private order.' }, USER);
    const commander = (await createAgentCommand(scope1.db, {
      roomId: ROOM, agentId: AGENT, sourceMessageId: source.messageId, reason: 'human_message',
    }))!;
    await scope1.daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: commander.id, generationId: 'wake-proof' }, AGENT);
    const authority = { roomId: ROOM, requestId: commander.turn_request_id, generationId: 'wake-proof' };
    const place = async (text: string, agent: string) => await scope1.daemon.execute('order',
      { ...authority, address: ROOM, agent, text }, AGENT) as { id: string };
    const queued = async (commandId: string) => (await scope1.db.query<{ subscription_id: string; body: string }>(
      `SELECT subscription_id, body FROM rooms_mcp_event_deliveries WHERE command_id=$1 ORDER BY subscription_id`,
      [commandId])).rows;
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const otherHandle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [other.member])).rows[0]!.handle;
    const early = await place('queued before any subscription', handle);
    expect(await queued(early.id)).toEqual([]);
    const mention = (await scope1.eventCall(token, 'events/subscribe', params)).result;
    const wake = (await scope1.eventCall(other.token, 'events/subscribe', {
      name: 'wake', arguments: {}, cursor: null,
      delivery: { mode: 'webhook', url: wakeUrl, secret: wakeSecret },
    })).result;
    const text = 'private order for the subscribed member';
    const ordered = await place(text, handle);
    const rows = await queued(ordered.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscription_id).toBe(mention.id);
    expect(JSON.parse(rows[0]!.body)).toMatchObject({ name: 'wake', cursor: null, data: {
      roomId: ROOM, address: ROOM, commandId: ordered.id, id: ordered.id, reason: 'order', kind: 'order', text,
      next: (await pendingMcpWakes(scope1.db, member)).find(item => item.id === ordered.id)!.next,
    } });
    expect((await scope1.db.query(`SELECT 1 FROM rooms_mcp_event_deliveries WHERE subscription_id=$1`, [wake.id])).rowCount).toBe(0);
    const retried = await place(text, handle);
    expect(retried.id).toBe(ordered.id);
    expect(await queued(ordered.id)).toHaveLength(1);
    const received: Array<{ url: string; event: { name?: string; data?: { text?: string } } }> = [];
    const transport: typeof postMcpWebhook = async (target, init) => {
      const signing = target === url ? secret : wakeSecret;
      received.push({ url: target, event: new Webhook(signing).verify(init.body, init.headers) as { name?: string; data?: { text?: string } } });
      return new Response(null, { status: 204 });
    };
    expect(await deliverMcpMemberWebhooks(scope1.db, transport)).toBe(1);
    expect(received.map(item => item.url)).toEqual([url]);
    expect(received[0]!.event.data!.text).toBe(text);
    expect(await deliverMcpMemberWebhooks(scope1.db, transport)).toBe(0);
    const opened = await scope1.daemon.execute('createCorner', {
      ...authority, requestId: commander.turn_request_id, name: 'Wake-corner', objective: 'Carry the private assignment',
      implementer: handle, brief: { spec: 'Private corner assignment for the subscribed implementer', repositoryWork: false },
    }, AGENT);
    const cornerCommand = (await scope1.db.query<{ id: string }>(
      `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND reason='corner_objective'`,
      [opened.cornerId, member])).rows[0]!;
    expect(await queued(cornerCommand.id)).toHaveLength(1);
    expect(JSON.parse((await queued(cornerCommand.id))[0]!.body).data).toMatchObject({
      roomId: opened.cornerId, address: opened.cornerId, commandId: cornerCommand.id, kind: 'order',
      text: 'Private corner assignment for the subscribed implementer',
      next: MCP_ORDER_WAKE_HINT,
    });
    const report = await createAgentCommand(scope1.db, {
      roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'report',
      privatePayload: { text: 'done: the report reached the commander', authorId: AGENT, fromRoomId: ROOM, kind: 'report' },
    });
    expect(await queued(report!.id)).toHaveLength(1);
    // Subscribed delivery must not make an unclaimed app appear to be running.
    expect((await scope1.phone.readRoom(ROOM, USER))!.latestAgentTurns.filter(
      turn => turn.agentPubkey === member && turn.status === 'working',
    )).toEqual([]);
    expect(JSON.parse((await queued(report!.id))[0]!.body).data).toMatchObject({
      kind: 'report', reason: 'report', text: 'done: the report reached the commander',
      next: MCP_WAKE_HINT,
    });
    expect(await deliverMcpMemberWebhooks(scope1.db, transport)).toBe(2);
    expect(received).toHaveLength(3);
    expect(received.map(item => item.event.data?.text)).toEqual(expect.arrayContaining([
      text, 'Private corner assignment for the subscribed implementer', 'done: the report reached the commander',
    ]));
    const heard = await place('only the wake subscription hears this', otherHandle);
    const heardRows = await queued(heard.id);
    expect(heardRows).toHaveLength(1);
    expect(heardRows[0]!.subscription_id).toBe(wake.id);
    expect(JSON.parse(heardRows[0]!.body).data.text).toBe('only the wake subscription hears this');
    await scope1.db.query(`UPDATE rooms_mcp_event_subscriptions SET expires_at=now()-interval '1 second' WHERE id=$1`, [mention.id]);
    expect(await queued((await place('order after the subscription expired', handle)).id)).toEqual([]);
    await scope1.db.query(`UPDATE rooms_mcp_event_subscriptions SET expires_at=now()+interval '1 day' WHERE id=$1`, [mention.id]);
    const wakeTooUrl = 'https://hooks.example/wake-too/' + opaque();
    const both = (await scope1.eventCall(token, 'events/subscribe', {
      ...params, name: 'wake', delivery: { ...params.delivery, url: wakeTooUrl, secret },
    })).result;
    expect((await queued((await place('wake subscription replaces the mention webhook', handle)).id))
      .map(row => row.subscription_id)).toEqual([both.id]);
    await scope1.eventCall(token, 'events/unsubscribe', { name: 'wake', arguments: {}, delivery: { mode: 'webhook', url: wakeTooUrl } });
    await scope1.eventCall(token, 'events/unsubscribe', { name: 'mention', arguments: {}, delivery: { mode: 'webhook', url } });
    expect(await queued((await place('order after unsubscribe', handle)).id)).toEqual([]);
    await scope1.db.query(`UPDATE rooms_mcp_connections SET revoked_at=now() WHERE client_id=$1`, [other.grant.clientId]);
    const revoked = await place('order after the connection was revoked', otherHandle);
    expect(revoked.id).toEqual(expect.any(String));
    expect(await queued(revoked.id)).toEqual([]);
    await scope1.db.query(`UPDATE agent_commands SET state='complete', completed_at=now() WHERE id=$1`, [commander.id]);
    await scope1.db.query(`UPDATE agent_turns SET status='complete' WHERE agent_id=$1 AND generation_id='wake-proof'`, [AGENT]);
    // Reproduction (MCP-REVIEW-WAKE-1): a reviewer dispatch carried the generic "no_reply_needed" hint.
    await scope1.eventCall(token, 'events/subscribe', { ...params, name: 'wake', delivery: { ...params.delivery, url: wakeTooUrl, secret } });
    const review = await createAgentCommand(scope1.db, {
      roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'corner_review_dispatch',
      privatePayload: { text: `Current handoff target: PR #7 at ${'a'.repeat(40)}.`, authorId: AGENT, fromRoomId: ROOM, kind: 'lifecycle' },
    });
    expect(JSON.parse((await queued(review!.id))[0]!.body).data).toMatchObject({ reason: 'corner_review_dispatch', next: MCP_REVIEW_WAKE_HINT });
    expect((await pendingMcpWakes(scope1.db, member)).find(item => item.id === review!.id)).toMatchObject({ next: MCP_REVIEW_WAKE_HINT });
    expect(MCP_REVIEW_WAKE_HINT).toContain('approve_merge with the head SHA');
  });

  it.each(['consent', 'profile'])('MCP-WAKE-SETUP: %s saves once, delivers tags and never reads the key back', async path => {
    vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY', 'local-wake-test-key');
    const secret = 'wake-key-sentinel-' + opaque();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const grant = await scope1.authorize(undefined, 'allow', undefined, undefined,
        path === 'consent' ? { wake_url: 'https://hooks.example/wake', wake_key: ' Bearer ' + secret + ' ' } : {});
      expect((await scope1.exchange(grant)).status).toBe(200);
      const member = (await scope1.db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [grant.clientId])).rows[0]!.member_id;
      const operation = async (viewer: string, key?: string, url = 'https://hooks.example/wake') => {
        const token = opaque();
        await scope1.db.query(`INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at)
          VALUES($1,$2,$3,now()+interval '1 hour')`, [tokenHash(token), viewer, randomUUID()]);
        return scope1.post('/v1/phone/operations/updateAgentWake', { workspaceId: WORKSPACE, agentId: member, url, ...(key ? { key } : {}) },
          { authorization: 'Bearer ' + token });
      };
      expect((await operation(OTHER, 'attacker-key')).status).toBe(403);
      if (path === 'profile') {
        const saved = await operation(USER, ' bearer ' + secret + ' ');
        expect(saved.status).toBe(200);
        expect(JSON.stringify(await saved.json())).not.toContain(secret);
      }
      const stored = (await scope1.db.query<{ callback_secret: string }>('SELECT callback_secret FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!;
      expect(openSecrets<string>('local-wake-test-key', stored.callback_secret)).toBe(secret);
      expect((await operation(USER, 'Bearer bad token')).status).toBe(400);
      const profile = await scope1.phone.readAgent(WORKSPACE, member, USER);
      expect(profile?.wake).toEqual({ url: 'https://hooks.example/wake', keySet: true });
      expect(JSON.stringify(profile)).not.toContain(secret);
      expect((await scope1.phone.readAgent(WORKSPACE, member, OTHER))?.wake).toBeUndefined();
      const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@' + handle + ' hello' }, USER);
      expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rowCount).toBe(1);
      const received: Array<{ url: string; authorization: string | null }> = [];
      await deliverMcpMemberWebhooks(scope1.db, async (url, init) => {
        if (url === 'https://hooks.example/wake') received.push({ url, authorization: new Headers(init.headers).get('authorization') });
        return new Response('', { status: 200 });
      });
      expect(received).toEqual([{ url: 'https://hooks.example/wake', authorization: 'Bearer ' + secret }]);
      expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toContain(secret);
      const cleared = await operation(USER, undefined, '');
      expect(cleared.status).toBe(200);
      expect((await cleared.json() as { wake: unknown }).wake).toEqual({ url: null, keySet: false });
      expect((await operation(USER, secret, 'http://localhost/wake')).status).toBe(400);
      expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls, ...errors.mock.calls])).not.toContain(secret);
    } finally { warn.mockRestore(); log.mockRestore(); errors.mockRestore(); vi.unstubAllEnvs(); }
  });

  it('R-MCP-SIGNIN-LEDGER: records an exchanged ticket when browser sign-in reaches MCP consent', async () => {
    const flowHash = tokenHash(opaque());
    const at = new Date(), expiresAt = new Date(at.getTime() + 120_000);
    await recordSigninAttempt(scope1.db, { stage: 'started', provider: 'google', flowHash, at, expiresAt });
    await recordSigninAttempt(scope1.db, { stage: 'provider_returned', flowHash, at });
    await recordSigninAttempt(scope1.db, { stage: 'ticket_issued', flowHash, ticketHash: tokenHash('local-demo-ticket'), at, expiresAt });
    await scope1.authorize();
    const rows = await scope1.db.query(`SELECT stage FROM signin_attempt_events WHERE attempt_id=(
      SELECT attempt_id FROM signin_attempt_correlations WHERE flow_hash=$1)`, [flowHash]);
    expect(rows.rows.map(row => row.stage).sort())
      .toEqual(['provider_returned', 'started', 'ticket_exchanged', 'ticket_issued']);
  });

  it('rotates refresh tokens and revokes their family on reuse', async () => {
    const grant = await scope1.authorize();
    const initial = await (await scope1.exchange(grant)).json() as { access_token: string; refresh_token: string };
    const refresh = (token: string, clientId = grant.clientId) => scope1.post('/mcp/oauth/token', {
      grant_type: 'refresh_token', refresh_token: token, client_id: clientId, resource: scope1.origin + '/mcp',
    });
    expect((await refresh(initial.refresh_token, 'wrong-client')).status).toBe(400);
    const response = await refresh(initial.refresh_token);
    expect(response.status).toBe(200);
    const next = await response.json() as typeof initial;
    expect(next.refresh_token).not.toBe(initial.refresh_token);
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${next.access_token}` } })).status).not.toBe(401);
    expect((await refresh(initial.refresh_token)).status).toBe(400);
    expect((await refresh(next.refresh_token)).status).toBe(400);
    for (const token of [initial.access_token, next.access_token]) {
      expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    }
  });

  it('lists only the viewer connections and disconnects access and refresh credentials together', async () => {
    const grant = await scope1.authorize();
    const tokens = await (await scope1.exchange(grant)).json() as { access_token: string; refresh_token: string };
    expect((await scope1.phone.readWorkbench({ workspaceId: WORKSPACE }, OTHER)).aiClients).not.toContainEqual(expect.objectContaining({ clientId: grant.clientId }));
    expect((await scope1.phone.readWorkbench({ workspaceId: WORKSPACE }, USER)).aiClients).toContainEqual(expect.objectContaining({ clientId: grant.clientId }));
    await scope1.phone.execute('disconnectAiClient', { clientId: grant.clientId }, OTHER);
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).not.toBe(401);
    const otherGrant = await scope1.authorize('rooms:read', 'allow', grant.clientId);
    const otherTokens = await (await scope1.exchange(otherGrant)).json() as typeof tokens;
    const phoneToken = opaque();
    await scope1.db.query("INSERT INTO phone_access_tokens(token_hash,identity_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [tokenHash(phoneToken), USER, WORKSPACE]);
    const disconnected = await scope1.post('/v1/phone/operations/disconnectAiClient', { clientId: grant.clientId }, { authorization: `Bearer ${phoneToken}` });
    expect(disconnected.status).toBe(204);
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await scope1.post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: grant.clientId })).status).toBe(400);
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${otherTokens.access_token}` } })).status).toBe(401);
    expect((await scope1.post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: otherTokens.refresh_token, client_id: grant.clientId })).status).toBe(400);
    expect((await scope1.phone.readWorkbench({ workspaceId: WORKSPACE }, USER)).aiClients).not.toContainEqual(expect.objectContaining({ clientId: grant.clientId }));
  });

  it('advertises resource discovery and OAuth metadata without credentials', async () => {
    const unauthorized = await phoneFetch(scope1.origin + '/mcp'); expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    const metadata = await (await phoneFetch(scope1.origin + '/.well-known/oauth-authorization-server')).json();
    expect(metadata).toMatchObject({ code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'] });
    expect(await (await phoneFetch(scope1.origin + '/.well-known/oauth-authorization-server/mcp')).json()).toEqual(metadata);
    const resource = await (await phoneFetch(scope1.origin + '/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource).toMatchObject({ resource: scope1.origin + '/mcp', authorization_servers: [scope1.origin] });
    expect(await (await phoneFetch(scope1.origin + '/.well-known/oauth-protected-resource')).json()).toEqual(resource);
  });

  it('logs each refused registration once with its reason and non-secret metadata', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const refused = [
        ['javascript:alert(1)', 'invalid_redirect_uri'], ['data:text/html,x', 'invalid_redirect_uri'], ['file:///tmp/cb', 'invalid_redirect_uri'],
        ['vbscript:x', 'invalid_redirect_uri'], ['http://client.example/cb', 'invalid_redirect_uri'], ['https://client.example/cb#x', 'invalid_redirect_uri'],
        ['https://user:pw@client.example/cb', 'invalid_redirect_uri'], ['cursor://anysphere.cursor-mcp/cb#x', 'invalid_redirect_uri'], ['not a uri', 'invalid_redirect_uri'],
        ...['blob:https://x/y', 'about:blank', 'filesystem:https://x/y', 'ftp://x/cb', 'mailto:a@b', 'intent://cb', 'cursor://user:pw@host/cb', 'cursor://host/cb#', ' cursor://host/cb', 'cursor://host/\ncb'].map(uri => [uri, 'invalid_redirect_uri']),
      ];
      for (const [uri, error] of refused) {
        warn.mockClear();
        const response = await scope1.post('/mcp/oauth/register', { client_name: 'Refused', redirect_uris: [uri] });
        expect([uri, response.status, await response.json()]).toEqual([uri, 400, { error }]);
        expect(warn).toHaveBeenCalledTimes(1);
      }
      warn.mockClear();
      const method = await scope1.post('/mcp/oauth/register', { client_name: 'Hosted bot', redirect_uris: ['https://user:secret-user@bot.example/oauth/cb?x=secret-path'], token_endpoint_auth_method: 'private_key_jwt', grant_types: ['authorization_code', 'client_credentials'] });
      expect([method.status, await method.json()]).toEqual([400, { error: 'invalid_client_metadata' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      const [label, line] = warn.mock.calls[0] as [string, string];
      expect(label).toBe('[rooms-mcp-oauth] registration refused');
      expect(JSON.parse(line)).toEqual({ error: 'invalid_client_metadata', client_name: 'Hosted bot', redirect_uris: ['https://bot.example'],
        token_endpoint_auth_method: 'private_key_jwt', grant_types: ['authorization_code', 'client_credentials'] });
      expect(line).not.toContain('secret-path');
      expect(line).not.toContain('secret-user');
      for (const invalid of [{ redirect_uris: [] }, { redirect_uris: Array(11).fill('https://bot.example/cb') }, { redirect_uris: 'https://bot.example/cb' },
        { grant_types: ['client_credentials'] }, { grant_types: 'authorization_code' }, { response_types: ['token'] }, { response_types: 'code' }, { client_name: '' }, { webhook_uri: 'http://bot.example/cb' }]) {
        warn.mockClear();
        expect((await scope1.post('/mcp/oauth/register', { redirect_uris: ['https://bot.example/cb'], ...invalid })).status).toBe(400);
        expect(warn).toHaveBeenCalledTimes(1);
      }
      warn.mockClear();
      expect((await phoneFetch(scope1.origin + '/mcp/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"client_secret":"leak' })).status).toBe(400);
      expect(warn.mock.calls[0]![1]).toContain('invalid_json');
      expect(warn.mock.calls[0]![1]).not.toContain('leak');
    } finally { warn.mockRestore(); }
  });

  it('logs admission refusals once without reading or logging a rate-limited body', async () => {
    await scope1.db.query('INSERT INTO rooms_mcp_admission(key,calls) VALUES($1,300)', [tokenHash('127.0.0.1')]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await scope1.post('/mcp/oauth/register', { client_secret: 'never-log-this' });
      expect([response.status, await response.json()]).toEqual([429, { error: 'temporarily_unavailable' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[rooms-mcp-oauth] registration refused', JSON.stringify({ error: 'temporarily_unavailable' }));
      warn.mockClear();
      const token = await phoneFetch(scope1.origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic c2VjcmV0LWlkOnNlY3JldC12YWx1ZQ==' },
        body: 'grant_type=authorization_code&code=code-never-log&code_verifier=verifier-never-log' });
      expect([token.status, await token.json()]).toEqual([429, { error: 'temporarily_unavailable' }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[rooms-mcp-oauth] token refused', JSON.stringify({ error: 'temporarily_unavailable', reason: 'rate_limited',
        client_auth: 'basic', content_type: 'application/x-www-form-urlencoded' }));
    } finally { warn.mockRestore(); }
  });

  it('shows a fake Claude as unverified, with its redirect host and no vendor mark', async () => {
    const registered = await scope1.post('/mcp/oauth/register', { client_name: 'Claude', redirect_uris: ['https://evil.example/phish/callback'] });
    expect(registered.status).toBe(201);
    const { client_id } = await registered.json() as { client_id: string };
    const verifier = opaque();
    const redirectUri = 'https://evil.example/phish/callback';
    const query = new URLSearchParams({ client_id, redirect_uri: redirectUri, response_type: 'code', resource: scope1.origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write', state: 'phish' });
    const start = await phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, scope1.origin).searchParams.get('flow')!;
    await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await phoneFetch(`${scope1.origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    const page = await (await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(page).toContain('Add an unsupported app to your team');
    expect(page).toContain('This is not a supported agent');
    expect(page).toContain('>evil.example</p>');
    expect(page).toContain('I set this app up myself and trust <b>evil.example</b>');
    expect(page).toContain('value="allow" disabled');
    expect(page).not.toMatch(/<img class="mark client"/);
    expect(page).toContain('class="mark client initial"');
    expect(page).not.toContain('Anthropic');
    expect(page).toContain('Act like your other agents');
    const allow = (trust_app?: string) => scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE], ...(trust_app === undefined ? {} : { trust_app }) }, { cookie, origin: scope1.origin });
    expect((await allow()).status).toBe(400);
    expect((await allow('0')).status).toBe(400);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_codes WHERE client_id=$1', [client_id])).rowCount).toBe(0);
    const allowed = await allow('1');
    expect(allowed.status).toBe(302);
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    const token = await scope1.post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri: redirectUri, resource: scope1.origin + '/mcp' });
    expect(token.status).toBe(200);
    const issued = await token.json() as { access_token: string; refresh_token: string; scope: string };
    expect(issued.scope).toBe('rooms:read rooms:write');
    const client = new Client({ name: 'fake-claude', version: '1.0.0' }); scope1.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(scope1.origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${issued.access_token}` } } }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('send_message');
    expect(names).toContain('order');
    expect(names).toContain('merge_corner');
    expect(names).toContain('approve_merge');
    const refreshed = await scope1.post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id, resource: scope1.origin + '/mcp' });
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json() as { scope: string }).scope).toBe('rooms:read rooms:write');
  });

  it.each([
    ['https://claude.ai/callback', 'Claude Duet', 'claude.ai'],
    ['https://claude.com/callback', 'Claude Duet', 'claude.com'],
    ['https://chatgpt.com/callback', 'ChatGPT', 'chatgpt.com'],
    ['https://cursor.com/callback', 'Cursor', 'cursor.com'],
    ['https://agent.meta.ai/callback', 'Muse', 'agent.meta.ai'],
  ])('brands supported callback %s from the list, not the submitted name', async (redirect, display, host) => {
    const registered = await (await scope1.post('/mcp/oauth/register', { client_name: 'Untrusted supplied name', redirect_uris: [redirect] })).json() as { client_id: string };
    const grant = await scope1.prepareAuthorization(undefined, registered.client_id, redirect);
    expect(grant.consentHtml).toContain(`Add ${display} to your team`);
    expect(grant.consentHtml).toContain(`Supported agent · sends its code to <b>${host}</b>`);
    expect(grant.consentHtml).toMatch(/<img class="mark client" src="data:image/);
    expect(grant.consentHtml).not.toContain('Untrusted supplied name');
    expect(grant.consentHtml).not.toContain('id="trust_app"');
    expect((await scope1.post('/mcp/oauth/consent', { flow: grant.flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie: grant.cookie, origin: scope1.origin })).status).toBe(302);
  });

  it('refuses a same-host redirect whose path differs at authorize and token exchange', async () => {
    const redirectUri = 'https://client.example/callback';
    const registered = await (await scope1.post('/mcp/oauth/register', { client_name: 'Path', redirect_uris: [redirectUri] })).json() as { client_id: string };
    const start = (redirect: string) => phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + new URLSearchParams({ client_id: registered.client_id, redirect_uri: redirect,
      response_type: 'code', resource: scope1.origin + '/mcp', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(opaque()).digest('base64url') }), { redirect: 'manual' });
    for (const redirect of [`${redirectUri}/extra`, 'https://client.example/callback2', 'https://client.example/other', `${redirectUri}?next=1`])
      expect([redirect, (await start(redirect)).status]).toEqual([redirect, 400]);
    const grant = await scope1.authorize(undefined, 'allow', registered.client_id, redirectUri);
    expect((await scope1.exchange(grant, { redirect_uri: `${redirectUri}/extra` })).status).toBe(400);
    expect((await scope1.exchange(grant, { redirect_uri: redirectUri })).status).toBe(200);
  });

  it.each(['https://example.com/cb', 'http://127.0.0.1:9876/cb', 'http://[::1]:9876/cb', 'http://localhost:9876/cb'])(
    'keeps accepting web and loopback redirect %s without issuing a secret', async redirect => {
      const response = await scope1.post('/mcp/oauth/register', { redirect_uris: [redirect] });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [redirect] });
    });

  it('registers a client whose logo cannot be loaded and keeps the bundled logo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [name, logo_uri, stored] of [['Cursor', 'https://127.0.0.1/favicon.svg', 'data:image/png;base64,'], ['Grok Bot', 'http://grok.example/logo.png', 'data:image/png;base64,'], ['Cursor', 42, 'data:image/png;base64,']] as const) {
        warn.mockClear();
        const response = await scope1.post('/mcp/oauth/register', { client_name: name, logo_uri, redirect_uris: ['https://www.cursor.com/callback'], token_endpoint_auth_method: 'none' });
        expect(response.status).toBe(201);
        const { client_id } = await response.json() as { client_id: string };
        const { logo } = (await scope1.db.query<{ logo: string | null }>('SELECT logo FROM rooms_mcp_clients WHERE id=$1', [client_id])).rows[0]!;
        if (stored) expect(logo).toMatch(/^data:image\/png;base64,/); else expect(logo).toBeNull();
        expect(warn).toHaveBeenCalledWith('[rooms-mcp-oauth] registration logo skipped', expect.stringContaining(name));
      }
    } finally { warn.mockRestore(); }
  });

  it('signs in a native client through a private-use redirect scheme', async () => {
    for (const redirect of ['cursor://anysphere.cursor-mcp/oauth/callback', 'com.example.app:/oauth/callback']) {
    const registered = await scope1.post('/mcp/oauth/register', { client_name: 'Cursor', redirect_uris: [redirect] });
    expect(registered.status).toBe(201);
    const { client_id } = await registered.json() as { client_id: string };
    const grant = await scope1.authorize(undefined, 'allow', client_id, redirect);
    expect((await scope1.exchange(grant, { redirect_uri: redirect })).status).toBe(200);
    }
  });
});
