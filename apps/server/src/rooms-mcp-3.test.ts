import { phoneFetch, describe, expect, it, vi, backfillMcpMemberRoomsAndAvatars, ensureMcpMember, randomBytes, createHash, randomUUID, Client, StreamableHTTPClientTransport, tokenHash, createAgentCommand, routeHumanMessage, routeAgentResult, openSecrets, deliverMcpMemberWebhooks, runMaintenance, PREREGISTERED_MCP_CLIENTS, readFileSync, sharp, FACE_SOULS, USER, AGENT, WORKSPACE, ROOM, PRIVATE, opaque, fixtureScope1, fixtureScope2, fixtureScope3 } from './rooms-mcp.test-support.js';

describe('Rooms connector HTTP OAuth and MCP', () => {
const scope1 = fixtureScope1();

  it('Reproduction R1: grants every tool after one Allow, with no scope or a read-only scope, and limits per token', async () => {
    for (const scope of ['', 'rooms:read']) {
      const { client } = await scope1.connected(scope);
      const profile = await client.callTool({ name: 'set_profile', arguments: { name: `Grok ${scope || 'none'}` } });
      expect(profile.isError).toBeFalsy();
      const sent = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `full rights ${scope || 'none'}` } });
      expect(sent.isError).toBeFalsy();
    }
    expect((await scope1.db.query("SELECT 1 FROM messages WHERE text LIKE 'full rights %'")).rowCount).toBe(2);
    const { token } = await scope1.connected('rooms:read');
    await scope1.db.query('UPDATE rooms_mcp_tokens SET calls=60,window_at=now() WHERE hash=$1', [tokenHash(token)]);
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(429);
  });

  it('Reproduction R1: lets a stored read-only connection post and refresh without reconnecting', async () => {
    const grant = await scope1.authorize();
    const tokens = await (await scope1.exchange(grant)).json() as { access_token: string; refresh_token: string };
    // Seed the pre-fix state: every stored row for this connection holds read only.
    for (const table of ['rooms_mcp_tokens', 'rooms_mcp_families', 'rooms_mcp_connections']) {
      await scope1.db.query(`UPDATE ${table} SET scope='rooms:read' WHERE client_id=$1`, [grant.clientId]);
    }
    const member = (await scope1.db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [grant.clientId])).rows[0]!.member_id;
    await scope1.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')
      ON CONFLICT (room_id,identity_id) WHERE room_id IS NOT NULL DO NOTHING`, [WORKSPACE, ROOM, member]);
    const call = async (token: string, name: string, args: Record<string, unknown>) => {
      const client = new Client({ name: 'rooms-review-proof', version: '1.0.0' }); scope1.clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(scope1.origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client.callTool({ name, arguments: args });
    };
    expect((await call(tokens.access_token, 'set_profile', { name: 'Grok Bot' })).isError).toBeFalsy();
    const refreshed = await scope1.post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: grant.clientId, resource: scope1.origin + '/mcp', scope: 'rooms:read rooms:write' });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as { access_token: string; refresh_token: string; scope: string };
    expect(next.scope).toBe('rooms:read rooms:write');
    expect((await call(next.access_token, 'send_message', { room: ROOM, text: 'posted after refresh' })).isError).toBeFalsy();
    const narrowed = await scope1.post('/mcp/oauth/token', { grant_type: 'refresh_token', refresh_token: next.refresh_token,
      client_id: grant.clientId, resource: scope1.origin + '/mcp', scope: 'rooms:read' });
    expect(narrowed.status).toBe(200);
    const last = await narrowed.json() as { access_token: string };
    expect((await call(last.access_token, 'send_message', { room: ROOM, text: 'posted after narrow refresh' })).isError).toBeFalsy();
    expect((await scope1.phone.readWorkbench({ workspaceId: WORKSPACE }, USER)).aiClients)
      .toContainEqual(expect.objectContaining({ clientId: grant.clientId, scopes: ['rooms:read', 'rooms:write'] }));
  });

  it('rejects expired grants and never accepts an MCP grant as a phone session', async () => {
    const { token } = await scope1.connected();
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${token}`, origin: 'https://unregistered.example' } })).status).toBe(403);
    expect((await phoneFetch(scope1.origin + '/v1/phone/workspaces', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    await scope1.db.query("UPDATE rooms_mcp_tokens SET expires_at=now()-interval '1 second' WHERE hash=$1", [tokenHash(token)]);
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const grant = await scope1.authorize();
    await scope1.db.query("UPDATE rooms_mcp_codes SET expires_at=now()-interval '1 second' WHERE hash=$1", [tokenHash(grant.code!)]);
    expect((await scope1.exchange(grant)).status).toBe(400);
  });

  it('pages messages without crossing Room cursors and rejects oversized input', async () => {
    const { client } = await scope1.connected();
    for (let i=0; i<3; i++) await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `page ${i}` }, USER);
    const first = await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } });
    const data = JSON.parse((first.content as { text: string }[])[0]!.text).data;
    expect(data.messages).toHaveLength(1); expect(data.nextCursor).toBeTruthy();
    const next = await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1, cursor: data.nextCursor } });
    expect(JSON.parse((next.content as { text: string }[])[0]!.text).data.messages[0].id).not.toBe(data.messages[0].id);
    const foreignCursor = await client.callTool({ name: 'read_messages', arguments: { room: ROOM, cursor: 'd'.repeat(64) } });
    expect(JSON.parse((foreignCursor.content as { text: string }[])[0]!.text).data.messages).toEqual([]);
    expect((await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'x'.repeat(16001) } })).isError).toBe(true);
  });

  it('bounds messages and drops access immediately when membership ends', async () => {
    const { client, member } = await scope1.connected();
    expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1000 } })).isError).toBe(true);
    // Removing the member from the Room revokes its next read and post at once.
    await scope1.db.query('UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2', [ROOM, member]);
    expect((await client.callTool({ name: 'read_messages', arguments: { room: ROOM } })).isError).toBe(true);
    expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).not.toContain(ROOM);
  });

  it('MCP-WORKSPACE-1: legacy connections retain all-Workspace behavior until explicit re-consent', async () => {
    const grant = await scope1.authorize();
    await scope1.db.query('UPDATE rooms_mcp_members SET workspace_ids=NULL WHERE client_id=$1', [grant.clientId]);
    const laterWorkspace = randomUUID(), laterRoom = randomUUID();
    await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'New legacy Workspace')`, [laterWorkspace]);
    await scope1.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [laterWorkspace, USER]);
    await scope1.db.query(`INSERT INTO rooms(id,workspace_id,name,visibility) VALUES($1,$2,'Legacy public Room','public')`, [laterRoom, laterWorkspace]);
    try {
      const member = await ensureMcpMember(scope1.db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      expect((await scope1.db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND room_id=$2 AND removed_at IS NULL', [member, laterRoom])).rowCount).toBe(1);
      expect((await scope1.db.query<{ workspace_ids: string[] | null }>('SELECT workspace_ids FROM rooms_mcp_members WHERE client_id=$1', [grant.clientId])).rows[0]!.workspace_ids).toBeNull();
      await scope1.authorize(undefined, 'allow', grant.clientId);
      await ensureMcpMember(scope1.db, { clientId: grant.clientId, ownerId: USER, modelLabel: 'Local MCP reviewer' });
      expect((await scope1.db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND workspace_id=$2 AND removed_at IS NULL', [member, laterWorkspace])).rowCount).toBe(2);
    } finally { await scope1.db.query('DELETE FROM workspaces WHERE id=$1', [laterWorkspace]); }
  });

  it('MCP-WORKSPACE-1: approving the default checked fields joins every current Workspace', async () => {
    const secondWorkspace = randomUUID();
    await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Default selected Workspace')`, [secondWorkspace]);
    await scope1.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [secondWorkspace, USER]);
    try {
      const { consentHtml, flow, cookie, clientId } = await scope1.prepareAuthorization();
      const checkboxes = consentHtml.match(/<input\b[^>]*name="workspace_ids"[^>]*>/g) ?? [];
      expect(checkboxes).toHaveLength(2);
      expect(checkboxes.every(input => /\bchecked\b/.test(input))).toBe(true);
      const workspaceIds = checkboxes.map(input => /value="([^"]+)"/.exec(input)![1]);
      expect((await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: workspaceIds }, { cookie, origin: scope1.origin })).status).toBe(302);
      const member = (await scope1.db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rows[0]!.member_id;
      const joined = (await scope1.db.query<{ workspace_id: string }>('SELECT workspace_id FROM memberships WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL', [member])).rows.map(row => row.workspace_id);
      expect(joined.sort()).toEqual([WORKSPACE, secondWorkspace].sort());
    } finally { await scope1.db.query('DELETE FROM workspaces WHERE id=$1', [secondWorkspace]); }
  });

  it('MCP-ONBOARD-1: new sign-in creates an owned Workspace and public general on Allow, then reads and posts through MCP', async () => {
    const ticket = 'local-new-' + opaque(), owner = tokenHash('google:' + ticket);
    expect((await scope1.db.query('SELECT 1 FROM identities WHERE id=$1', [owner])).rowCount).toBe(0);
    const grant = await scope1.prepareAuthorization(undefined, undefined, undefined, ticket);
    expect((await scope1.db.query('SELECT 1 FROM identities WHERE id=$1', [owner])).rowCount).toBe(1);
    expect((await scope1.db.query('SELECT 1 FROM memberships WHERE identity_id=$1', [owner])).rowCount).toBe(0);
    expect(grant.consentHtml).toContain('Allow will create your Workspace, Robin&#39;s team, with a public #general Room.');
    expect(grant.consentHtml).toContain('Joins as');
    expect(grant.consentHtml).toContain('It can');
    expect(grant.consentHtml).not.toContain('Select at least one Workspace');
    expect(grant.consentHtml).not.toMatch(/<input[^>]*type="checkbox"[^>]*name="workspace_ids"/);
    expect(grant.consentHtml).toContain('id="trust_app"');
    const result = await phoneFetch(scope1.origin + '/mcp/oauth/consent', { method: 'POST', redirect: 'manual',
      headers: { cookie: grant.cookie, origin: scope1.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ flow: grant.flow, decision: 'allow', trust_app: '1', workspace_selection: '1' }) });
    expect(result.status).toBe(302);
    const target = new URL(result.headers.get('location')!);
    const tokenResponse = await scope1.exchange({ ...grant, code: target.searchParams.get('code'), error: null });
    expect(tokenResponse.status).toBe(200);
    const { access_token } = await tokenResponse.json() as { access_token: string };
    const workspace = (await scope1.db.query<{ id: string; name: string; role: string }>(`SELECT w.id,w.name,m.role
      FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
      WHERE m.identity_id=$1 AND m.room_id IS NULL AND m.removed_at IS NULL`, [owner])).rows;
    expect(workspace).toEqual([{ id: expect.any(String), name: "Robin's team", role: 'owner' }]);
    const room = (await scope1.db.query<{ id: string; name: string; visibility: string }>(
      'SELECT id,name,visibility FROM rooms WHERE workspace_id=$1', [workspace[0]!.id])).rows;
    expect(room).toEqual([{ id: expect.any(String), name: 'general', visibility: 'public' }]);
    const member = (await scope1.db.query<{ member_id: string }>(
      'SELECT member_id FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [grant.clientId, owner])).rows[0]!.member_id;
    expect((await scope1.db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND workspace_id=$2 AND removed_at IS NULL', [member, workspace[0]!.id])).rowCount).toBe(2);
    const client = new Client({ name: 'new-person-proof', version: '1' }); scope1.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(scope1.origin + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${access_token}` } } }));
    const listed = await client.callTool({ name: 'list_rooms', arguments: {} });
    expect(JSON.stringify(listed)).toContain(room[0]!.id);
    const text = 'Hello from the newly joined agent';
    const sent = await client.callTool({ name: 'send_message', arguments: { room: room[0]!.id, text } });
    expect(sent.isError).not.toBe(true);
    expect((await scope1.db.query('SELECT author_id,text FROM messages WHERE room_id=$1 AND text=$2', [room[0]!.id, text])).rows)
      .toEqual([{ author_id: member, text }]);
    // A replay cannot create a second Workspace or grant a second code.
    expect((await scope1.post('/mcp/oauth/consent', { flow: grant.flow, decision: 'allow', trust_app: '1', workspace_selection: '1' }, { cookie: grant.cookie, origin: scope1.origin })).status).toBe(400);
    expect((await scope1.db.query('SELECT 1 FROM memberships WHERE identity_id=$1 AND room_id IS NULL', [owner])).rowCount).toBe(1);
  });

  it.each(['deny', 'origin', 'selection', 'malformed', 'webhook'])('MCP-ONBOARD-2: new-person %s refusal leaves no Workspace or grant', async refusal => {
    const ticket = 'local-new-' + opaque(), owner = tokenHash('google:' + ticket);
    const { flow, cookie, clientId } = await scope1.prepareAuthorization(undefined, undefined, undefined, ticket);
    const before = (await scope1.db.query('SELECT count(*) AS count FROM workspaces')).rows;
    const input: Record<string, unknown> = { flow, decision: 'allow', trust_app: '1', workspace_selection: '1' };
    if (refusal === 'deny') input.decision = 'deny';
    if (refusal === 'selection') delete input.workspace_selection;
    if (refusal === 'malformed') input.workspace_ids = ['not-a-workspace'];
    if (refusal === 'webhook') input.wake_url = 'http://localhost';
    const result = await scope1.post('/mcp/oauth/consent', input, { cookie, origin: refusal === 'origin' ? 'https://evil.example' : scope1.origin });
    expect(result.status).toBe(refusal === 'deny' ? 302 : 400);
    if (refusal === 'deny') expect(new URL(result.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect((await scope1.db.query('SELECT 1 FROM memberships WHERE identity_id=$1', [owner])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_codes WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT count(*) AS count FROM workspaces')).rows).toEqual(before);
  });

  it('MCP-WORKSPACE-1: rejects empty, malformed, duplicate and foreign selections without granting membership', async () => {
    const prepared = await scope1.prepareAuthorization();
    const { flow, cookie, clientId } = prepared;
    for (const selection of [
      {}, { workspace_selection: '1' }, { workspace_selection: '1', workspace_ids: [] },
      { workspace_selection: '1', workspace_ids: ['not-a-workspace'] },
      { workspace_selection: '1', workspace_ids: [randomUUID()] },
      { workspace_selection: '1', workspace_ids: [WORKSPACE, WORKSPACE] },
      { workspace_selection: '1', workspace_ids: { id: WORKSPACE } },
    ]) {
      const response = await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', ...selection }, { cookie, origin: scope1.origin });
      expect(response.status).toBe(400);
      expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
      expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_codes WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    }
    // Eligibility is rechecked on POST, not trusted from the earlier page.
    const staleWorkspace = randomUUID();
    await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Departed Workspace')`, [staleWorkspace]);
    await scope1.db.query(`INSERT INTO memberships(workspace_id,identity_id,role,removed_at) VALUES($1,$2,'member',now())`, [staleWorkspace, USER]);
    try {
      expect((await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [staleWorkspace] }, { cookie, origin: scope1.origin })).status).toBe(400);
      expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rowCount).toBe(0);
    } finally { await scope1.db.query('DELETE FROM workspaces WHERE id=$1', [staleWorkspace]); }
  });

  it('MCP-WORKSPACE-1: accepts repeated workspace form fields but still rejects duplicate security parameters', async () => {
    const secondWorkspace = randomUUID();
    await scope1.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Second form Workspace')`, [secondWorkspace]);
    await scope1.db.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [secondWorkspace, USER]);
    try {
      const { flow, cookie, clientId } = await scope1.prepareAuthorization();
      const body = new URLSearchParams({ flow, decision: 'allow', trust_app: '1', workspace_selection: '1' });
      body.append('workspace_ids', WORKSPACE); body.append('workspace_ids', secondWorkspace);
      const submit = (value: URLSearchParams) => phoneFetch(scope1.origin + '/mcp/oauth/consent', { method: 'POST', redirect: 'manual',
        headers: { cookie, origin: scope1.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: value });
      const duplicateFlow = new URLSearchParams(body); duplicateFlow.append('flow', flow);
      expect((await submit(duplicateFlow)).status).toBe(400);
      expect((await submit(body)).status).toBe(302);
      const saved = (await scope1.db.query<{ workspace_ids: string[] }>('SELECT workspace_ids FROM rooms_mcp_members WHERE client_id=$1', [clientId])).rows[0]!;
      expect([...saved.workspace_ids].sort()).toEqual([WORKSPACE, secondWorkspace].sort());
    } finally { await scope1.db.query('DELETE FROM workspaces WHERE id=$1', [secondWorkspace]); }
  });

  it('joins every public top-level Room on Allow, and other Rooms through Members', async () => {
    const { member, client } = await scope1.connected();
    const rooms = async () => (await scope1.db.query<{ room_id: string }>(
      'SELECT room_id FROM memberships WHERE identity_id=$1 AND room_id IS NOT NULL AND removed_at IS NULL ORDER BY room_id', [member])).rows.map(row => row.room_id);
    // Every public top-level Room, never an invite-only Room or a corner.
    expect(await rooms()).toEqual([ROOM]);
    expect(JSON.stringify(await client.callTool({ name: 'list_rooms', arguments: {} }))).toContain(ROOM);
    // A public Room made later includes it, like any agent.
    const later = (await scope1.phone.execute('createRoom', { workspaceId: WORKSPACE, name: `later-${member.slice(0, 6)}` }, USER)).id;
    expect(await rooms()).toContain(later);
    // An invite-only Room takes it through the normal Members path.
    const closed = (await scope1.phone.execute('createRoom', { workspaceId: WORKSPACE, name: `closed-${member.slice(0, 6)}`, visibility: 'invite-only' }, USER)).id;
    expect(await rooms()).not.toContain(closed);
    await scope1.phone.execute('addRoomMember', { roomId: closed, memberId: member }, USER);
    expect(await rooms()).toContain(closed);
    await scope1.phone.execute('removeRoomMember', { roomId: later, memberId: member }, USER);
    expect(await rooms()).not.toContain(later);
  });

  it('signs Meta Muse in with its published client id, which maintenance never deletes', async () => {
    const muse = PREREGISTERED_MCP_CLIENTS[0];
    expect(muse.id).toBe('6Zxge0aVJeCxF8Jvshy-oYTjYPJmrFHdTnwVfvkaF0o');
    const row = (await scope1.db.query<{ name: string; redirects: string[]; preregistered: boolean; auth_method: string; logo: string | null }>(
      'SELECT name,redirects,preregistered,auth_method,logo FROM rooms_mcp_clients WHERE id=$1', [muse.id])).rows[0]!;
    expect(row).toMatchObject({ name: 'Meta Muse', redirects: ['https://agent.meta.ai/api/hatch/oauth/callback'], preregistered: true, auth_method: 'none' });
    expect(row.logo).toMatch(/^data:image\/png;base64,/);
    // Nobody registers anything: the published id signs in at once.
    const grant = await scope1.authorize('rooms:read rooms:write', 'allow', muse.id, muse.redirects[0]);
    expect(grant.code).toBeTruthy();
    expect((await scope1.exchange(grant, { redirect_uri: muse.redirects[0] })).status).toBe(200);
    // Unused for 30 days: an ordinary registration expires, the published one stays.
    const unused = await (await scope1.post('/mcp/oauth/register', { client_name: 'Unused', redirect_uris: ['https://example.com/cb'] })).json() as { client_id: string };
    await scope1.db.query(`UPDATE rooms_mcp_connections SET revoked_at=now()-interval '40 days' WHERE client_id=$1`, [muse.id]);
    await scope1.db.query(`DELETE FROM rooms_mcp_tokens WHERE client_id=$1`, [muse.id]);
    await scope1.db.query(`UPDATE rooms_mcp_clients SET created_at=now()-interval '40 days' WHERE id=ANY($1)`, [[muse.id, unused.client_id]]);
    await runMaintenance(scope1.db);
    await scope1.db.query(`DELETE FROM rooms_mcp_connections WHERE client_id=$1`, [muse.id]);
    await runMaintenance(scope1.db);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_clients WHERE id=$1', [unused.client_id])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_clients WHERE id=$1 AND preregistered', [muse.id])).rowCount).toBe(1);
  });

  it.each([
    ['Cursor', ['https://www.cursor.com/agents/mcp/oauth/callback', 'http://localhost:8787/callback'], 'Grok Bot'],
    ['Cursor', ['cursor://anysphere.cursor-mcp/oauth/callback'], 'Cursor'],
    ['Cursor', ['https://cursor.com/agents/oauth/callback'], 'Cursor'],
    ['Meta Muse', ['https://agent.meta.ai/api/hatch/oauth/callback'], 'Muse'],
    ['Codex', ['http://127.0.0.1:9876/callback'], 'Codex'],
    ['Claude Code', ['http://127.0.0.1:9876/callback'], 'Claude Code'],
    ['Dots', ['http://127.0.0.1:9876/callback'], 'ChatGPT'],
  ])('R-MCP-DEFAULT-PICTURES: %s %j shows app pictures on Allow and its member', async (name, redirects, display) => {
    const registered = await (await scope1.post('/mcp/oauth/register', { client_name: name, redirect_uris: redirects })).json() as { client_id: string };
    const grant = await scope1.authorize('rooms:read rooms:write', 'allow', registered.client_id, redirects[0]);
    const html = grant.consentHtml;
    expect(html).toContain(`Add ${display} to your team`);
    expect(html).toMatch(/<img class="mark client" src="data:image/);
    expect(html).toMatch(/<img class="plate" src="data:image/);
    expect(html).not.toContain('class="mark client initial"');
    const member = (await scope1.db.query<{ member_id: string; name: string; avatar: string }>(
      'SELECT m.member_id,i.name,i.avatar FROM rooms_mcp_members m JOIN identities i ON i.id=m.member_id WHERE m.client_id=$1 AND m.owner_id=$2', [registered.client_id, USER])).rows[0]!;
    expect(member.name).toBe(display);
    expect((await phoneFetch(scope1.origin + member.avatar)).status).toBe(200);
    // A default from the old bundled mark is upgraded; custom provenance wins,
    // including legacy request ids that predate drawing.source.
    await scope1.db.query("UPDATE agent_avatars SET bytes=$2 WHERE agent_id=$1", [member.member_id, Buffer.from('old default')]);
    await backfillMcpMemberRoomsAndAvatars(scope1.db);
    const updated = (await scope1.db.query<{ bytes: Buffer; id: string }>('SELECT bytes,id FROM agent_avatars WHERE agent_id=$1', [member.member_id])).rows[0]!;
    expect(Buffer.from(updated.bytes).toString()).not.toBe('old default');
    await backfillMcpMemberRoomsAndAvatars(scope1.db);
    expect((await scope1.db.query<{ id: string }>('SELECT id FROM agent_avatars WHERE agent_id=$1', [member.member_id])).rows[0]!.id).toBe(updated.id);
    for (const [request, drawing] of [['rooms-mcp-set_profile', { source: 'set_profile' }], ['mcp-set-profile-hotfix', []], ['rooms-mcp-client-logo', { source: 'set_profile' }]]) {
      await scope1.db.query("UPDATE agent_avatars SET request_id=$2,drawing=$3::jsonb WHERE agent_id=$1", [member.member_id, request, JSON.stringify(drawing)]);
      await backfillMcpMemberRoomsAndAvatars(scope1.db);
      expect((await scope1.db.query<{ id: string }>('SELECT id FROM agent_avatars WHERE agent_id=$1', [member.member_id])).rows[0]!.id).toBe(updated.id);
    }
  });

  it('shows the client logo as the member picture until the member sets its own', async () => {
    const muse = PREREGISTERED_MCP_CLIENTS[0];
    const grant = await scope1.authorize('rooms:read rooms:write', 'allow', muse.id, muse.redirects[0]);
    const tokens = await (await scope1.exchange(grant, { redirect_uri: muse.redirects[0] })).json() as { access_token: string };
    const member = (await scope1.db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE client_id=$1 AND owner_id=$2', [muse.id, USER])).rows[0]!.member_id;
    const avatar = async () => (await scope1.db.query<{ avatar: string | null }>('SELECT avatar FROM identities WHERE id=$1', [member])).rows[0]!.avatar;
    const logo = await avatar();
    expect(logo).toMatch(/^\/v1\/agent-avatars\/[0-9a-f-]{36}$/);
    const served = await phoneFetch(scope1.origin + logo);
    expect(served.status).toBe(200); expect(served.headers.get('content-type')).toBe('image/webp');
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width).toBe(256);
    const client = new Client({ name: 'muse-proof', version: '1.0.0' }); scope1.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(scope1.origin + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
    const own = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer();
    const set = await client.callTool({ name: 'set_profile', arguments: { avatar: `data:image/png;base64,${own.toString('base64')}` } });
    expect(set.isError).not.toBe(true);
    const chosen = await avatar();
    expect(chosen).toMatch(/^\/v1\/agent-avatars\/[0-9a-f-]{36}$/); expect(chosen).not.toBe(logo);
    // Reconnecting never puts the logo back over the member's own picture.
    const reconnect = await scope1.authorize('rooms:read rooms:write', 'allow', muse.id, muse.redirects[0]);
    const portrait = (await scope1.db.query<{ bytes: Buffer }>('SELECT bytes FROM agent_avatars WHERE agent_id=$1', [member])).rows[0]!;
    expect(reconnect.consentHtml).toContain('data:image/webp;base64,' + Buffer.from(portrait.bytes).toString('base64'));
    expect(await avatar()).toBe(chosen);
  });

  it('R1: pushes the asking agent’s exact back-tag instructions per tag to the webhook a member set, with its sealed bearer secret', async () => {
    await deliverMcpMemberWebhooks(scope1.db, async () => new Response('', { status: 200 }));
    const { client, member } = await scope1.connected();
    const previous = process.env.BEELINE_MCP_WEBHOOK_KEY;
    delete process.env.BEELINE_MCP_WEBHOOK_KEY;
    try {
      // Without a sealing key no secret can be stored.
      expect((await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/muse', secret: 'tag-secret' } })).isError).toBe(true);
      process.env.BEELINE_MCP_WEBHOOK_KEY = 'test-key';
      expect((await client.callTool({ name: 'set_webhook', arguments: { url: 'http://hooks.example/muse' } })).isError).toBe(true);
      const set = await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/muse', secret: ' Bearer tag-secret ' } });
      expect(set.isError).not.toBe(true);
      expect(JSON.stringify(set)).not.toContain('tag-secret');
      const stored = (await scope1.db.query<{ callback_url: string; callback_secret: string }>('SELECT callback_url,callback_secret FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!;
      expect(stored.callback_url).toBe('https://hooks.example/muse'); expect(stored.callback_secret).not.toContain('tag-secret');
      const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} please answer` }, AGENT);
      await routeAgentResult(scope1.db, undefined, sent.messageId, { roomId: ROOM, agentId: AGENT });
      const posts: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
      await deliverMcpMemberWebhooks(scope1.db, async (url, init) => {
        posts.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
        return new Response('', { status: 200 });
      });
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ url: 'https://hooks.example/muse', authorization: 'Bearer tag-secret',
        body: { memberId: member, roomId: ROOM, messageId: sent.messageId, text: `@${handle} please answer` } });
      expect(String(posts[0]!.body.instruction)).toContain('send_message');
      expect(String(posts[0]!.body.instruction)).toContain('Start your reply with @demo-agent to wake the asking agent.');
      expect(String(posts[0]!.body.instruction)).toContain('A reply without the tag does not wake them');
      // Removing the webhook stops the push.
      await client.callTool({ name: 'set_webhook', arguments: { url: '' } });
      const quiet = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} again` }, USER);
      await routeHumanMessage(scope1.db, quiet.messageId);
      expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, quiet.messageId])).rowCount).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.BEELINE_MCP_WEBHOOK_KEY; else process.env.BEELINE_MCP_WEBHOOK_KEY = previous;
    }
  });

  it.each([
    [' Bearer abc123 ', 'abc123'], [' bearer abc123 ', 'abc123'],
    ['bEaReR abc123', 'abc123'], ['bearerabc123', 'bearerabc123'],
    ['Bearer bad token', null], ['Bearer ', null], ['Bearer abc\ttoken', null],
  ])('MCP-WEBHOOK-TOKEN: set_webhook normalizes or refuses %j', async (input, expected) => {
    vi.stubEnv('BEELINE_MCP_WEBHOOK_KEY', 'local-token-test-key');
    try {
      const { client, member } = await scope1.connected();
      const result = await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/token', secret: input } });
      if (expected === null) expect(result.isError).toBe(true);
      else {
        expect(result.isError).not.toBe(true);
        const stored = (await scope1.db.query<{ callback_secret: string }>('SELECT callback_secret FROM rooms_mcp_members WHERE member_id=$1', [member])).rows[0]!;
        expect(openSecrets<string>('local-token-test-key', stored.callback_secret)).toBe(expected);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('WEBHOOK-CLEAR-1: clearing a member webhook disables fallback and cancels queued tags', async () => {
    const { client, member, grant } = await scope1.connected();
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    await scope1.db.query("UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/registration' WHERE id=$1", [grant.clientId]);
    const posts: string[] = [];
    const deliver = () => deliverMcpMemberWebhooks(scope1.db, async url => { posts.push(url); return new Response('', { status: 200 }); });
    // A never-configured member keeps the registration fallback.
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} initial fallback` }, USER);
    expect(await deliver()).toBe(1);
    expect(posts).toEqual(['https://hooks.example/registration']);
    expect(scope1.data(await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/member' } })).webhook).toBe('https://hooks.example/member');
    const queued = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} queued before clearing` }, USER);
    expect(scope1.data(await client.callTool({ name: 'set_webhook', arguments: { url: '' } })).webhook).toBeNull();
    expect(await deliver()).toBe(0);
    const human = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} after clearing` }, USER);
    const agent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} please answer after clearing` }, AGENT);
    await routeAgentResult(scope1.db, undefined, agent.messageId, { roomId: ROOM, agentId: AGENT });
    const dm = await scope1.phone.execute('resolveDirectMessage', { workspaceId: WORKSPACE, participantId: member }, USER);
    await scope1.phone.execute('sendRoomMessage', { roomId: dm.id, text: 'after clearing in a DM' }, USER);
    expect(await deliver()).toBe(0);
    expect(posts).toHaveLength(1);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, human.messageId])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT outcome FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, queued.messageId])).rows[0]!.outcome).toBe('skipped');
    // Explicitly enabling a new receiver must not replay the cancelled queue.
    await client.callTool({ name: 'set_webhook', arguments: { url: 'https://hooks.example/new' } });
    expect(await deliver()).toBe(0);
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} freshly enabled` }, USER);
    expect(await deliver()).toBe(1);
    expect(posts).toEqual(['https://hooks.example/registration', 'https://hooks.example/new']);
  });

  it('publishes every preregistered client id on the public connect page', () => {
    const page = readFileSync(new URL('../../../web/connect/index.html', import.meta.url), 'utf8');
    for (const client of PREREGISTERED_MCP_CLIENTS) {
      expect(page).toContain(client.id);
      expect(page).toContain(client.name);
    }
    expect(page).toContain('https://join.usebeeline.app');
    expect(readFileSync(new URL('../../../web/sitemap.xml', import.meta.url), 'utf8')).toContain('<loc>https://usebeeline.app/connect/</loc>');
  });

  it('owner-unknown: identifies the approving owner before and after setup, even without Rooms', async () => {
    const { client, member } = await scope1.connected();
    const listed = () => client.callTool({ name: 'list_rooms', arguments: {} }).then(scope1.data);
    expect((await listed()).owner).toEqual({ name: 'Demo', handle: 'demo' });
    expect((await listed()).setup).toContain('Preserve the approved @handle');
    const profile = await client.callTool({ name: 'set_profile', arguments: { name: 'Existing Bot' } });
    expect(profile.isError).toBeFalsy();
    expect(await listed()).toMatchObject({ owner: { name: 'Demo', handle: 'demo' } });
    expect((await listed()).setup).toBeUndefined();
    await scope1.db.query('UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NOT NULL', [member]);
    expect(await listed()).toMatchObject({ rooms: [], owner: { name: 'Demo', handle: 'demo' } });
  });

  it('repeats the setup rule in read results until the member calls set_profile', async () => {
    const { client } = await scope1.connected();
    expect(scope1.data(await client.callTool({ name: 'list_rooms', arguments: {} })).setup).toContain('set_profile');
    expect(scope1.data(await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } })).setup).toContain('tags your @handle');
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === 'list_rooms')!.description).toContain('verify your approved member identity and owner');
    expect(tools.find(t => t.name === 'set_profile')!.description).toMatch(/^After verifying list_rooms/);
    expect(tools.find(t => t.name === 'set_profile')!.description).toContain('display name and profile picture you already use in your own app');
    expect(tools.find(t => t.name === 'set_profile')!.description).toContain('https URL or data URI');
    expect(client.getInstructions()).toContain('Read the owner field in list_rooms');
    expect(client.getInstructions()).toContain('display name and profile picture you already use in your own app');
    await client.callTool({ name: 'set_profile', arguments: { name: 'Named', handle: `named_${randomBytes(3).toString('hex')}` } });
    expect(scope1.data(await client.callTool({ name: 'list_rooms', arguments: {} })).setup).toBeUndefined();
    expect(scope1.data(await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } })).setup).toBeUndefined();
  });

  it('tells a member in no Rooms how its owner adds it', async () => {
    const { client, member } = await scope1.connected();
    await scope1.db.query('UPDATE memberships SET removed_at=now() WHERE identity_id=$1 AND room_id IS NOT NULL', [member]);
    const listed = scope1.data(await client.callTool({ name: 'list_rooms', arguments: {} }));
    expect(listed.rooms).toEqual([]); expect(listed.note).toContain('under Members in the Beeline app');
  });

  it('lists the tags owed a reply across Rooms, oldest first, after a cursor', async () => {
    const { client, member } = await scope1.connected();
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const second = (await scope1.phone.execute('createRoom', { workspaceId: WORKSPACE, name: `mentions-${member.slice(0, 6)}` }, USER)).id;
    const first = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} first question` }, USER);
    const next = await scope1.phone.execute('sendRoomMessage', { roomId: second, text: `@${handle} second question` }, USER);
    await scope1.phone.execute('sendRoomMessage', { roomId: second, text: 'no tag here' }, USER);
    const page = scope1.data(await client.callTool({ name: 'list_mentions', arguments: {} }));
    expect(page.mentions.map((m: { id: string }) => m.id)).toEqual([first.messageId, next.messageId]);
    expect(page.mentions[0]).toMatchObject({ room_id: ROOM, author_id: USER, text: `@${handle} first question` });
    expect(scope1.data(await client.callTool({ name: 'list_mentions', arguments: { cursor: page.nextCursor } })).mentions).toEqual([]);
    const third = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} third` }, USER);
    expect(scope1.data(await client.callTool({ name: 'list_mentions', arguments: { cursor: page.nextCursor } })).mentions.map((m: { id: string }) => m.id)).toEqual([third.messageId]);
  });

  it('SESSION-JOIN-1: a long poll returns at once when a tag arrives, and after its wait otherwise', async () => {
    const { client, member } = await scope1.connected();
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    // A client learns the name and handle its owner allowed.
    expect(scope1.data(await client.callTool({ name: 'list_rooms', arguments: {} })).you).toEqual({ id: member, name: expect.any(String), handle });
    const first = scope1.data(await client.callTool({ name: 'list_mentions', arguments: {} }));
    const now = new Date().toISOString();
    let started = Date.now();
    const empty = scope1.data(await client.callTool({ name: 'list_mentions', arguments: { cursor: first.nextCursor, waitSeconds: 1, wakesAfter: now } }));
    expect(empty.mentions).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    started = Date.now();
    const waiting = client.callTool({ name: 'list_mentions', arguments: { cursor: first.nextCursor, waitSeconds: 20, wakesAfter: now } });
    await new Promise(resolve => setTimeout(resolve, 300));
    const tag = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} are you there?` }, USER);
    const page = scope1.data(await waiting);
    expect(page.mentions.map((m: { id: string }) => m.id)).toEqual([tag.messageId]);
    expect(Date.now() - started).toBeLessThan(5000);
    const refused = await client.callTool({ name: 'list_mentions', arguments: { waitSeconds: 26 } });
    expect(refused.isError).toBe(true);
  });

  it.each([{ fallback: false, app: 'Claude Code' }, { fallback: true, app: 'Claude Code' }, { fallback: false, app: 'Codex' }])('SESSION-JOIN-1: a headless $app session signs in with fallback consent=$fallback and collects its code by state', async ({ fallback, app }) => {
    const label = app === 'Codex' ? 'codex' : fallback ? 'fallback' : 'api';
    const memberName = `payments ${label}`, memberHandle = `payments_${label}`;
    const handoff = scope1.origin + '/mcp/oauth/handoff';
    const registered = await scope1.post('/mcp/oauth/register', { client_name: app, redirect_uris: [handoff] });
    expect(registered.status).toBe(201);
    const client = await registered.json() as { client_id: string };
    const verifier = opaque(), state = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: handoff, response_type: 'code', resource: scope1.origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write', state,
      member_name: `payments  ${label}\u0007` });
    if (fallback) query.set('claude_inbound_fallback', '1');
    expect(await (await scope1.post('/mcp/oauth/handoff', { state })).json()).toEqual({ error: 'authorization_pending' });
    const start = await phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, scope1.origin).searchParams.get('flow')!;
    await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await phoneFetch(`${scope1.origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    await scope1.db.query(`UPDATE identities SET handle=$2 WHERE id=$1`, [AGENT, memberHandle]);
    const page = await (await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(page).toContain(`Add ${app} to your team`);
    expect(page.includes('Would you like to run the following command?')).toBe(app === 'Codex');
    expect(page.includes('choose “Yes, proceed”')).toBe(app === 'Codex');
    expect(page).toContain(memberName);
    expect(page).toContain('Agents and people who tag this session in your Rooms can send it messages');
    expect(page.includes('user-level "crossSessionInbound": "accept" setting')).toBe(fallback);
    // Another member in the Workspace holds the plain handle already.
    expect(page).toContain(`@${memberHandle}_2`);
    await scope1.db.query(`UPDATE identities SET handle='demo-agent' WHERE id=$1`, [AGENT]);
    const allowed = await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin: scope1.origin });
    const target = new URL(allowed.headers.get('location')!);
    expect(target.origin + target.pathname).toBe(handoff);
    // The person's browser lands on Beeline's own page, which keeps the code for the session.
    const landed = await phoneFetch(target);
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain('Go back to your session');
    expect((await scope1.post('/mcp/oauth/handoff', { state: opaque() })).status).toBe(400);
    const collected = await (await scope1.post('/mcp/oauth/handoff', { state })).json() as { code: string };
    expect(collected.code).toBe(target.searchParams.get('code'));
    expect(await (await scope1.post('/mcp/oauth/handoff', { state })).json()).toEqual({ error: 'authorization_pending' });
    // The code alone is not enough: the verifier stays with the session.
    expect((await scope1.post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code: collected.code, code_verifier: opaque() })).status).toBe(400);
    const tokens = await scope1.post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code: collected.code, code_verifier: verifier });
    expect(tokens.status).toBe(200);
    const member = (await scope1.db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE owner_id=$1 AND client_id=$2', [USER, client.client_id])).rows[0]!.member_id;
    expect((await scope1.db.query('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]).toEqual({ name: memberName, handle: `${memberHandle}_2` });
    expect((await phoneFetch(`${scope1.origin}/mcp/oauth/handoff?state=short&code=x`)).status).toBe(400);
  });

  it('threads a reply under a message in the same Room and refuses a foreign one', async () => {
    const { client, member } = await scope1.connected();
    const parent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: 'thread parent' }, USER);
    const reply = scope1.data(await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'threaded answer', replyTo: parent.messageId } }));
    const row = (await scope1.db.query<{ reply_to_message_id: string; root_message_id: string; author_id: string; source_client: unknown }>(
      'SELECT reply_to_message_id,root_message_id,author_id,source_client FROM messages WHERE id=$1', [reply.messageId])).rows[0]!;
    expect(row).toMatchObject({ reply_to_message_id: parent.messageId, root_message_id: parent.messageId, author_id: member });
    expect(row.source_client).toBeTruthy();
    const foreign = (await scope1.db.query<{ id: string }>('SELECT id FROM messages WHERE room_id=$1 LIMIT 1', [PRIVATE])).rows[0]!.id;
    expect((await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'nope', replyTo: foreign } })).isError).toBe(true);
  });

  it('stores a set_profile JPEG as a served portrait, refuses non-images, and keeps the old picture', async () => {
    const { client, member } = await scope1.connected();
    const jpeg = await sharp({ create: { width: 96, height: 96, channels: 3, background: 'orange' } }).jpeg().toBuffer();
    const set = await client.callTool({ name: 'set_profile', arguments: { avatar: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
    expect(set.isError).not.toBe(true);
    const avatar = (await scope1.db.query<{ avatar: string }>('SELECT avatar FROM identities WHERE id=$1', [member])).rows[0]!.avatar;
    // The app renders an agent picture only for this path (isGeneratedAgentAvatarUrl).
    expect(avatar).toMatch(/\/v1\/agent-avatars\/[0-9a-f-]{36}$/);
    expect(scope1.data(set).avatar).toBe(scope1.origin + avatar);
    const served = await phoneFetch(scope1.origin + avatar);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width).toBe(256);
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PGh0bWw+', `data:image/png;base64,${Buffer.from('not an image').toString('base64')}`, 'http://example.com/a.png']) {
      const refused = await client.callTool({ name: 'set_profile', arguments: { avatar: bad } });
      expect(refused.isError).toBe(true);
      expect((refused.content as { text: string }[])[0]!.text).toMatch(/^Request refused: avatar/);
      expect((await scope1.db.query<{ avatar: string }>('SELECT avatar FROM identities WHERE id=$1', [member])).rows[0]!.avatar).toBe(avatar);
    }
  });

  it('names the client on an AI-client member profile instead of an animal soul', async () => {
    const { member } = await scope1.connected();
    const profile = (await scope1.phone.readAgent(WORKSPACE, member, USER))!;
    expect(profile.soul).toBeUndefined();
    expect(profile.seededSoul).toContain('Local MCP reviewer');
    expect(Object.values(FACE_SOULS)).not.toContain(profile.seededSoul);
  });

  it.each([false, true])('commits the post and routing record atomically (reply=%s)', async reply => {
    const { client, member } = await scope1.connected();
    const parent = reply ? await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: 'atomic reply parent' }, USER) : undefined;
    const args = { room: ROOM, text: '@demo-agent please handle this atomic post', idempotencyKey: `atomic-${reply}`,
      ...(parent ? { replyTo: parent.messageId } : {}) };
    const id = createHash('sha256').update(`rooms-mcp-message:${member}:${args.idempotencyKey}`).digest('hex');
    await scope1.db.query(`CREATE FUNCTION reject_mcp_route_proof() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'proof: pending route storage unavailable'; END $$;
      CREATE TRIGGER reject_mcp_route_proof BEFORE INSERT ON rooms_mcp_pending_routes
      FOR EACH ROW EXECUTE FUNCTION reject_mcp_route_proof()`);
    try {
      expect((await client.callTool({ name: 'send_message', arguments: args })).isError).toBe(true);
      expect((await scope1.db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(0);
      expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [id])).rowCount).toBe(0);
    } finally {
      await scope1.db.query('DROP TRIGGER reject_mcp_route_proof ON rooms_mcp_pending_routes; DROP FUNCTION reject_mcp_route_proof()');
    }
    await scope1.db.query("UPDATE rooms_mcp_idempotency SET claimed_at=now()-interval '2 minutes' WHERE member_id=$1", [member]);
    const retry = scope1.data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.woken).toEqual(['demo-agent']);
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [id, AGENT])).rowCount).toBe(1);
  });

  it('resumes a saved post after interruption before routing, without posting twice', async () => {
    const { client, member } = await scope1.connected();
    const args = { room: ROOM, text: '@demo-agent please resume this saved post', idempotencyKey: 'saved-post' };
    const id = createHash('sha256').update(`rooms-mcp-message:${member}:${args.idempotencyKey}`).digest('hex');
    const execute = scope1.phone.execute.bind(scope1.phone);
    const fault = vi.spyOn(scope1.phone, 'execute').mockImplementation(async (...args) => {
      await execute(...args);
      throw new Error('proof: request interrupted after message commit');
    });
    try {
      expect((await client.callTool({ name: 'send_message', arguments: args })).isError).toBe(true);
    } finally { fault.mockRestore(); }
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [id])).rowCount).toBe(1);
    await scope1.db.query("UPDATE rooms_mcp_idempotency SET claimed_at=now()-interval '2 minutes' WHERE member_id=$1", [member]);
    const retry = scope1.data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.woken).toEqual(['demo-agent']);
    expect((await scope1.db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(1);
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [id, AGENT])).rowCount).toBe(1);
    expect(scope1.data(await client.callTool({ name: 'send_message', arguments: args }))).toEqual(retry);
  });

  it('retries a cached routing failure instead of returning it forever', async () => {
    const { client } = await scope1.connected();
    const args = { room: ROOM, text: '@demo-agent please retry this failed wake', idempotencyKey: 'cached-failed-wake' };
    const query = scope1.db.query.bind(scope1.db);
    let injected = false;
    const fault = vi.spyOn(scope1.db, 'query').mockImplementation(async (sql, values) => {
      if (!injected && sql.includes('SELECT text,room_id FROM messages')) {
        injected = true;
        throw new Error('proof: transient wake routing failure');
      }
      return query(sql, values);
    });
    let first: ReturnType<typeof scope1.data>;
    try {
      first = scope1.data(await client.callTool({ name: 'send_message', arguments: args }));
      expect(first.routing).toBe('retrying');
    } finally { fault.mockRestore(); }
    expect(injected).toBe(true);
    const retry = scope1.data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.messageId).toBe(first!.messageId);
    expect(retry.woken).toEqual(['demo-agent']);
    expect(retry.routing).toBeUndefined();
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [retry.messageId, AGENT])).rowCount).toBe(1);
  });

  it('review proof: an interrupted routing record cannot lose a tagged wake on retry', async () => {
    const { client, member } = await scope1.connected();
    const args = { room: ROOM, text: '@demo-agent please handle this interrupted post', idempotencyKey: 'interrupted-route' };
    const id = createHash('sha256').update(`rooms-mcp-message:${member}:${args.idempotencyKey}`).digest('hex');
    const query = scope1.db.query.bind(scope1.db);
    let injected = false;
    const fault = vi.spyOn(scope1.db, 'query').mockImplementation(async (sql, values) => {
      if (!injected && sql.includes('INSERT INTO rooms_mcp_pending_routes')) {
        injected = true;
        throw new Error('review proof: interrupted routing insert');
      }
      return query(sql, values);
    });
    try {
      expect((await client.callTool({ name: 'send_message', arguments: args })).isError).toBe(true);
    } finally { fault.mockRestore(); }
    expect(injected).toBe(true);
    await scope1.db.query("UPDATE rooms_mcp_idempotency SET claimed_at=now()-interval '2 minutes' WHERE member_id=$1", [member]);
    const retry = scope1.data(await client.callTool({ name: 'send_message', arguments: args }));
    expect(retry.messageId).toBe(id);
    expect(retry.woken).toEqual(['demo-agent']);
    expect((await scope1.db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(1);
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [id, AGENT])).rowCount).toBe(1);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [id])).rowCount).toBe(0);
  });
describe('in a Room of 20,000 messages', () => {
const scope2 = fixtureScope2(scope1);

    it('answers send_message in under 3 s and wakes the tagged agent once', async () => {
      const { client } = await scope1.connected(undefined, [WORKSPACE, scope2.bigWorkspace]);
      const started = Date.now();
      const sent = scope1.data(await client.callTool({ name: 'send_message', arguments: { room: scope2.BIG, text: '@demo-agent please review the plan' } }));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(sent.woken).toEqual(['demo-agent']);
      expect(await scope2.commands(sent.messageId)).toBe(1);
    }, 60_000);

    it('returns one message to a retry sent while the first call is in flight, and wakes once', async () => {
      const { client } = await scope1.connected(undefined, [WORKSPACE, scope2.bigWorkspace]);
      const args = { room: scope2.BIG, text: '@demo-agent retried handoff', idempotencyKey: 'in-flight' };
      const [a, b] = await Promise.all([client.callTool({ name: 'send_message', arguments: args }), client.callTool({ name: 'send_message', arguments: args })]);
      expect(scope1.data(a).messageId).toBe(scope1.data(b).messageId);
      expect((await scope1.db.query('SELECT 1 FROM messages WHERE room_id=$1 AND text=$2', [scope2.BIG, args.text])).rowCount).toBe(1);
      expect(await scope2.commands(scope1.data(a).messageId)).toBe(1);
      expect(scope1.data(await client.callTool({ name: 'send_message', arguments: args })).messageId).toBe(scope1.data(a).messageId);
      expect(await scope2.commands(scope1.data(a).messageId)).toBe(1);
    }, 60_000);

    it('still wakes the tagged agent when the provenance read fails', async () => {
      const { client } = await scope1.connected(undefined, [WORKSPACE, scope2.bigWorkspace]);
      const transaction = scope1.db.transaction.bind(scope1.db);
      const fault = vi.spyOn(scope1.db, 'transaction').mockImplementation(work => transaction(async tx => {
        const query = tx.query.bind(tx);
        tx.query = ((sql: string, values?: unknown[]) => {
          if (sql.includes('SELECT to_jsonb(command) command FROM rooms_mcp_mentions')) throw new Error('proof: provenance read failed');
          return query(sql, values);
        }) as typeof tx.query;
        return work(tx);
      }));
      try {
        const sent = scope1.data(await client.callTool({ name: 'send_message', arguments: { room: scope2.BIG, text: '@demo-agent wake without provenance' } }));
        expect(sent.woken).toEqual(['demo-agent']);
        expect(await scope2.commands(sent.messageId)).toBe(1);
        const command = (await scope1.db.query<{ agent_depth: number }>('SELECT agent_depth FROM agent_commands WHERE source_message_id=$1', [sent.messageId])).rows[0]!;
        expect(command.agent_depth).toBe(1);
        expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_pending_routes WHERE message_id=$1', [sent.messageId])).rowCount).toBe(0);
      } finally {
        fault.mockRestore();
      }
    }, 60_000);
});
describe('agent tools for a connected app', () => {
const scope3 = fixtureScope3(scope1);

    it('R-MCP-PROCEDURE: loads a saved procedure through the legacy tool name', async () => {
      const { client } = await scope1.connected();
      await scope3.ok(client, 'remember', { address: ROOM, kind: 'procedure', action: 'save',
        slug: 'mcp-procedure', description: 'Check the saved procedure', markdown: 'Read the saved instructions.' });
      const loaded = await scope3.ok(client, 'load_workspace_skill', { address: ROOM, slug: 'mcp-procedure' });
      expect(loaded.slug).toBe('mcp-procedure');
      expect(loaded.markdown).toContain('Read the saved instructions.');
      const read = await scope3.ok(client, 'read', { address: ROOM, facet: 'procedure', slug: 'mcp-procedure' });
      expect(read).toEqual(loaded);
      const described = await scope3.ok(client, 'app_tool', { address: ROOM, app: 'beeline:workflow', tool: 'describe', args: { slug: 'mcp-procedure' } });
      expect(described).toEqual(loaded);
    });

    // Reproduction (R-MCP-ACK-ONE): no_reply_needed(address) marked every non-order wake at the address handled,
    // including wakes the app had not seen, and could not clear a wake whose claim had expired.
    it('R-MCP-ACK-ONE: no_reply_needed with commandId marks only that wake handled', async () => {
      const { client, member } = await scope1.connected();
      const wake = (text: string) => createAgentCommand(scope1.db, { roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'report',
        privatePayload: { kind: 'report', authorId: AGENT, fromRoomId: ROOM, text } });
      const first = (await wake('done: first'))!, second = (await wake('done: second'))!;
      const order = (await createAgentCommand(scope1.db, { roomId: ROOM, agentId: member, sourceMessageId: null, reason: 'order',
        privatePayload: { kind: 'order', authorId: AGENT, fromRoomId: ROOM, text: 'Do the thing' } }))!;
      expect((await scope3.call(client, 'no_reply_needed', { address: ROOM, commandId: order.id })).text).toContain('answer it with report');
      expect(await scope3.ok(client, 'no_reply_needed', { address: ROOM, commandId: first.id })).toEqual({ cleared: 1 });
      const ids = () => scope3.ok(client, 'list_mentions', {}).then(page => (page.wakes as { id: string }[]).map(item => item.id));
      expect(await ids()).toEqual(expect.arrayContaining([second.id, order.id]));
      expect(await ids()).not.toContain(first.id);
      // Elapsed time never steals a claimed wake from its owner.
      await scope1.db.query(`UPDATE agent_commands SET state='claimed',lease_expires_at=now()-interval '1 minute' WHERE id=$1`, [second.id]);
      expect(await ids()).not.toContain(second.id);
      expect(await scope3.ok(client, 'no_reply_needed', { address: ROOM })).toEqual({ cleared: 0 });
      await scope1.db.query(`UPDATE agent_commands SET state='pending',generation_id=NULL,lease_expires_at=NULL WHERE id=$1`, [second.id]);
      expect(await scope3.ok(client, 'no_reply_needed', { address: ROOM })).toEqual({ cleared: 1 });
      expect(await ids()).toEqual([order.id]);
    });

    // Reproduction (R-MCP-LIMITS): search advertised limit 20 while the server refuses anything above 10.
    it('R-MCP-LIMITS: every advertised search limit is accepted', async () => {
      const { client, member } = await scope1.connected();
      const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
      // A person's tag gives the app's turn a requester, as it does for an agent.
      await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} what did the release migration change?` }, USER);
      const search = (await client.listTools()).tools.find(tool => tool.name === 'search')!;
      const maximum = (search.inputSchema.properties as Record<string, { maximum?: number }>).limit!.maximum!;
      for (const scope of ['history', 'memory'])
        await scope3.ok(client, 'search', { address: ROOM, scope, query: 'release migration', limit: maximum });
    });
});
});
