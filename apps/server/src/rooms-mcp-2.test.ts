import { phoneFetch, describe, expect, it, vi, ensureMcpMember, MCP_TAG_INSTRUCTION, randomBytes, createHash, Client, StreamableHTTPClientTransport, tokenHash, BROWSER_REFUSALS, MCP_AGENT_TOOLS, claimAgentCommand, routeHumanMessage, deliverMcpMemberWebhooks, readFileSync, MCP_STARTER_ROUTINE, USER, AGENT, WORKSPACE, ROOM, PRIVATE, CORNER, PUBLIC_CORNER, opaque, fixtureScope1 } from './test-support-rooms-mcp.test-support.js';

describe('Rooms connector HTTP OAuth and MCP', () => {
const scope1 = fixtureScope1();

  it('logs each refused browser sign-in step with its reason, never parameter values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const registered = await (await scope1.post('/mcp/oauth/register', { client_name: 'Logged', redirect_uris: ['https://client.example/callback'] })).json() as { client_id: string };
      const challenge = createHash('sha256').update(opaque()).digest('base64url');
      const base = { client_id: registered.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256',
        code_challenge: challenge, state: 'state-sentinel-123', resource: scope1.origin + '/mcp' };
      const refused = async (step: string, reason: string, response: Response, params?: string[]) => {
        expect([step, reason, response.status]).toEqual([step, reason, 400]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [label, line] = warn.mock.calls[0] as [string, string];
        expect(label).toBe(`[rooms-mcp-oauth] ${step} refused`);
        expect(JSON.parse(line)).toEqual({ error: 'invalid_request', reason, ...(params ? { params } : {}) });
        for (const value of [registered.client_id, challenge, 'state-sentinel-123', 'client.example', 'evil.example', 'flow-sentinel-123', 'cookie-sentinel-123', 'ticket-sentinel-123'])
          expect(line).not.toContain(value);
        warn.mockClear();
      };
      const authorizeCases: [Record<string, string>, string][] = [
        [{ ...base, resource: 'https://evil.example/mcp' }, 'resource_mismatch'],
        [{ ...base, code_challenge: 'short' }, 'pkce_invalid'],
        [{ ...base, client_id: 'unknown-client' }, 'client_unknown'],
        [{ ...base, redirect_uri: 'https://evil.example/callback' }, 'redirect_uri_unregistered'],
        [{ ...base, response_type: 'token' }, 'response_type_invalid'],
      ];
      for (const [input, reason] of authorizeCases)
        await refused('authorize', reason, await phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + new URLSearchParams(input), { redirect: 'manual' }), Object.keys(input).sort());
      await refused('authorize', 'duplicate_parameter', await phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + new URLSearchParams(base) + '&state=state-sentinel-123', { redirect: 'manual' }), Object.keys(base).sort());
      const stale = { cookie: 'beeline_mcp=cookie-sentinel-123' };
      await refused('login', 'flow_missing_or_expired', await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=flow-sentinel-123&provider=google`, { headers: stale, redirect: 'manual' }));
      await refused('callback', 'flow_missing_or_expired', await phoneFetch(`${scope1.origin}/mcp/oauth/callback/google?state=flow-sentinel-123&ticket=ticket-sentinel-123`, { headers: stale, redirect: 'manual' }));
      await refused('consent', 'flow_missing_or_expired', await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=flow-sentinel-123`, { headers: stale }));
      await refused('consent submit', 'origin_mismatch', await scope1.post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin: 'https://evil.example' }));
      await refused('consent submit', 'flow_missing_or_expired', await scope1.post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin: scope1.origin }));
      // A live flow names the later branches too.
      const start = await phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + new URLSearchParams(base), { redirect: 'manual' });
      const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
      const flow = new URL(start.headers.get('location')!, scope1.origin).searchParams.get('flow')!;
      const scrub = async (step: string, reason: string, response: Response) => {
        expect(JSON.parse((warn.mock.calls[0] as [string, string])[1])).not.toHaveProperty('flow');
        expect((warn.mock.calls[0] as [string, string])[1]).not.toContain(flow);
        expect((warn.mock.calls[0] as [string, string])[1]).not.toContain(cookie.slice(12));
        await refused(step, reason, response);
      };
      let response = await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=other`, { headers: { cookie }, redirect: 'manual' });
      await scrub('login', 'provider_invalid', response);
      response = await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin: scope1.origin });
      await scrub('consent submit', 'flow_not_signed_in', response);
      await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
      response = await phoneFetch(`${scope1.origin}/mcp/oauth/callback/github?state=${flow}&ticket=ticket-sentinel-123`, { headers: { cookie }, redirect: 'manual' });
      await scrub('callback', 'provider_mismatch', response);
      response = await phoneFetch(`${scope1.origin}/mcp/oauth/callback/google?state=${flow}&ticket=ticket-sentinel-123`, { headers: { cookie }, redirect: 'manual' });
      await scrub('callback', 'ticket_exchange_failed', response);
      expect((await phoneFetch(`${scope1.origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
      response = await scope1.post('/mcp/oauth/consent', { flow, decision: 'maybe' }, { cookie, origin: scope1.origin });
      await scrub('consent submit', 'decision_invalid', response);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('R1: shows each refused browser step as a page naming the step and reason, never JSON or request values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const registered = await (await scope1.post('/mcp/oauth/register', { client_name: 'Shown', redirect_uris: ['https://client.example/callback'] })).json() as { client_id: string };
      const challenge = createHash('sha256').update(opaque()).digest('base64url');
      const base = { client_id: registered.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', code_challenge_method: 'S256',
        code_challenge: challenge, state: 'state-sentinel-123', resource: scope1.origin + '/mcp' };
      const shown = new Set<string>();
      const page = async (label: string, step: string, reason: string, response: Response) => {
        const body = await response.text();
        expect([reason, response.status, response.headers.get('content-type')]).toEqual([reason, 400, 'text/html; charset=utf-8']);
        expect(body).toContain(`<p class="head">${label}</p>`);
        expect(body).toContain(BROWSER_REFUSALS[reason]!.replace(/'/g, '&#39;'));
        expect(body).toMatch(new RegExp(`Reference: ${step} · ${reason} · \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ`));
        for (const value of [registered.client_id, challenge, 'state-sentinel-123', 'client.example', 'evil.example', 'flow-sentinel-123', 'cookie-sentinel-123', 'ticket-sentinel-123', 'Bad Handle!', 'private-wake-sentinel'])
          expect(body).not.toContain(value);
        shown.add(reason);
      };
      const authorize = (input: Record<string, string>, extra = '') => phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + new URLSearchParams(input) + extra, { redirect: 'manual' });
      const authorizeCases: [Record<string, string>, string, string?][] = [
        [base, 'query_too_long', `&pad=${'x'.repeat(8200)}`],
        [{ ...base, state: 'x'.repeat(2100) }, 'state_too_long'],
        [base, 'duplicate_parameter', '&state=state-sentinel-123'],
        [{ ...base, response_type: 'token' }, 'response_type_invalid'],
        [{ ...base, code_challenge: 'short' }, 'pkce_invalid'],
        [{ ...base, resource: 'https://evil.example/mcp' }, 'resource_mismatch'],
        [{ ...base, client_id: 'unknown-client' }, 'client_unknown'],
        [{ ...base, redirect_uri: 'https://evil.example/callback' }, 'redirect_uri_unregistered'],
        [{ ...base, scope: 'rooms:admin' }, 'scope_invalid'],
      ];
      for (const [input, reason, extra] of authorizeCases) await page('Starting the connection', 'authorize', reason, await authorize(input, extra));
      // An unexpected failure still names its step.
      vi.spyOn(scope1.db, 'query').mockRejectedValueOnce(new Error('database offline'));
      await page('Starting the connection', 'authorize', 'invalid_parameter', await authorize(base));
      const stale = { cookie: 'beeline_mcp=cookie-sentinel-123' };
      await page('Choosing how to sign in', 'login', 'flow_missing_or_expired', await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=flow-sentinel-123&provider=google`, { headers: stale, redirect: 'manual' }));
      await page('Showing what the app can do', 'consent', 'flow_missing_or_expired', await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=flow-sentinel-123`, { headers: stale }));
      const submit = (body: string, headers: Record<string, string>) => phoneFetch(scope1.origin + '/mcp/oauth/consent', { method: 'POST', redirect: 'manual', headers, body });
      const form = { 'content-type': 'application/x-www-form-urlencoded', origin: scope1.origin };
      await page('Saving your choice', 'consent submit', 'origin_mismatch', await scope1.post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin: 'https://evil.example' }));
      await page('Saving your choice', 'consent submit', 'flow_missing_or_expired', await scope1.post('/mcp/oauth/consent', { flow: 'flow-sentinel-123', decision: 'allow' }, { ...stale, origin: scope1.origin }));
      await page('Saving your choice', 'consent submit', 'body_too_large', await submit(`flow=${'x'.repeat(40_000)}`, form));
      await page('Saving your choice', 'consent submit', 'duplicate_parameter', await submit('flow=flow-sentinel-123&flow=flow-sentinel-123', form));
      await page('Saving your choice', 'consent submit', 'body_not_object', await submit('[]', { 'content-type': 'application/json', origin: scope1.origin }));
      await page('Saving your choice', 'consent submit', 'invalid_json', await submit('flow-sentinel-123', { 'content-type': 'application/json', origin: scope1.origin }));
      // A live flow reaches the later branches.
      const start = await authorize(base);
      const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
      const flow = new URL(start.headers.get('location')!, scope1.origin).searchParams.get('flow')!;
      const callback = (provider: string, ticket?: string) => phoneFetch(`${scope1.origin}/mcp/oauth/callback/${provider}?state=${flow}${ticket ? `&ticket=${ticket}` : ''}`, { headers: { cookie }, redirect: 'manual' });
      await page('Choosing how to sign in', 'login', 'provider_invalid', await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=other`, { headers: { cookie }, redirect: 'manual' }));
      await page('Saving your choice', 'consent submit', 'flow_not_signed_in', await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin: scope1.origin }));
      await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
      await page('Signing in with Google', 'callback', 'ticket_missing', await callback('google'));
      await page('Signing in with GitHub', 'callback', 'provider_mismatch', await callback('github', 'ticket-sentinel-123'));
      await page('Signing in with Google', 'callback', 'ticket_exchange_failed', await callback('google', 'ticket-sentinel-123'));
      expect((await callback('google', 'local-demo-ticket')).status).toBe(302);
      await page('Signing in with Google', 'callback', 'flow_already_signed_in', await callback('google', 'local-demo-ticket'));
      await page('Saving your choice', 'consent submit', 'app_trust_unconfirmed',
        await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin: scope1.origin }));
      await page('Saving your choice', 'consent submit', 'joiner_invalid', await scope1.post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Shown', joiner_handle: 'Bad Handle!' }, { cookie, origin: scope1.origin }));
      await page('Saving your choice', 'consent submit', 'decision_invalid', await scope1.post('/mcp/oauth/consent', { flow, decision: 'maybe' }, { cookie, origin: scope1.origin }));
      await page('Saving your choice', 'consent submit', 'wake_invalid',
        await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE], wake_url: 'http://localhost', wake_key: 'private-wake-sentinel' }, { cookie, origin: scope1.origin }));
      const previousKey = process.env.BEELINE_MCP_WEBHOOK_KEY;
      delete process.env.BEELINE_MCP_WEBHOOK_KEY;
      try {
        await page('Saving your choice', 'consent submit', 'wake_unavailable',
          await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE], wake_url: 'https://hooks.example/wake', wake_key: 'private-wake-sentinel' }, { cookie, origin: scope1.origin }));
        expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [registered.client_id])).rowCount).toBe(0);
      } finally {
        if (previousKey === undefined) delete process.env.BEELINE_MCP_WEBHOOK_KEY;
        else process.env.BEELINE_MCP_WEBHOOK_KEY = previousKey;
      }
      await page('Saving your choice', 'consent submit', 'workspaces_invalid',
        await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [] }, { cookie, origin: scope1.origin }));
      const takenHandle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [USER])).rows[0]!.handle;
      expect((await scope1.post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Shown', joiner_handle: takenHandle }, { cookie, origin: scope1.origin })).status).toBe(302);
      await page('Saving your choice', 'consent submit', 'handle_taken',
        await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin: scope1.origin }));
      await page('Returning to your session', 'handoff', 'handoff_invalid', await phoneFetch(`${scope1.origin}/mcp/oauth/handoff?state=state-sentinel-123&code=x`));
      // Every sentence is driven by a real refusal, and each reason reads differently.
      expect([...shown].sort()).toEqual(Object.keys(BROWSER_REFUSALS).sort());
      expect(new Set(Object.values(BROWSER_REFUSALS)).size).toBe(Object.keys(BROWSER_REFUSALS).length);
      // Client endpoints keep the OAuth JSON error.
      const token = await scope1.post('/mcp/oauth/token', { grant_type: 'password', resource: scope1.origin + '/mcp' });
      expect([token.status, token.headers.get('content-type'), await token.json()]).toEqual([400, 'application/json', { error: 'unsupported_grant_type' }]);
    } finally { vi.restoreAllMocks(); }
  });

  it('has a page sentence for every reason a browser step can refuse with', () => {
    const source = readFileSync(new URL('./rooms-mcp-oauth.ts', import.meta.url), 'utf8');
    const section = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
    // The browser branches, plus the body reader and flow lookup they call.
    const browser = section("path === '/mcp/oauth/authorize') {", "path === '/mcp/oauth/token') {")
      + section('export async function mcpBody(', 'function string(') + section('private async flow(', 'private async client(');
    const reasons = [...browser.matchAll(/new Refusal\([^,]+, '([a-z_]+)'/g)].map(match => match[1]!);
    expect(reasons.length).toBeGreaterThan(20);
    expect(reasons.filter(reason => !BROWSER_REFUSALS[reason])).toEqual([]);
  });

  it('binds single-use authorization codes to the client, redirect, verifier and resource', async () => {
    const grant = await scope1.authorize();
    for (const overrides of [{ code_verifier: opaque() }, { client_id: 'other' }, { redirect_uri: 'https://evil.example' }, { resource: scope1.origin + '/other' }]) {
      expect((await scope1.exchange(grant, overrides)).status).toBe(400);
    }
    expect((await scope1.exchange(grant)).status).toBe(200);
    expect((await scope1.exchange(grant)).status).toBe(400);
  });

  it('MCP-TOKEN-1: exchanges a code without resource or redirect_uri, as Cursor sends it', async () => {
    const grant = await scope1.authorize();
    const response = await scope1.exchange(grant, { resource: undefined, redirect_uri: undefined });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: 'Bearer' });
  });

  it.each([false, true])('MCP-STREAM-RESOURCE: an exchange without resource reaches the intended refusal (enabled=%s)', async enabled => {
    vi.stubEnv('BEELINE_NETWORK_ROUTER_V1', enabled ? '1' : '0');
    try {
      const grant = await scope1.authorize();
      const issued = await scope1.exchange(grant, { resource: undefined, redirect_uri: undefined });
      expect(issued.status).toBe(200);
      const { access_token: token } = await issued.json() as { access_token: string };
      const endpoint = scope1.origin + '/mcp/member-stream?mentions=0';
      // The fixture uses the real OAuth service and its default unready listener.
      // Missing request resource never makes the service's configured URL absent.
      const stream = await phoneFetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
      expect(stream.status).toBe(409);
      expect(await stream.json()).toEqual({ error: 'member_stream_unavailable' });
      await scope1.db.query('UPDATE rooms_mcp_tokens SET revoked_at=now() WHERE hash=$1', [tokenHash(token)]);
      for (const headers of [{}, { authorization: 'Bearer invalid-token' }, { authorization: `Bearer ${token}` }]) {
        const refused = await phoneFetch(endpoint, { headers });
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ error: 'invalid_token' });
        expect(refused.headers.get('www-authenticate')).toContain(`${scope1.origin}/.well-known/oauth-protected-resource/mcp`);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('accepts the server origin or MCP URL as resource, with or without a trailing slash, and refuses other hosts', async () => {
    for (const resource of [scope1.origin, scope1.origin + '/', scope1.origin + '/mcp/']) {
      expect([resource, (await scope1.exchange(await scope1.authorize(), { resource })).status]).toEqual([resource, 200]);
    }
    const grant = await scope1.authorize();
    for (const overrides of [{ resource: 'https://other.example/mcp' }, { resource: 'https://other.example' }, { redirect_uri: 'http://127.0.0.1:9876/other' }]) {
      expect((await scope1.exchange(grant, overrides)).status).toBe(400);
    }
    expect((await scope1.exchange(grant)).status).toBe(200);
  });

  it('keeps an authorization code valid for ten minutes', async () => {
    const grant = await scope1.authorize();
    await scope1.db.query("UPDATE rooms_mcp_codes SET expires_at=expires_at-interval '5 minutes' WHERE hash=$1", [tokenHash(grant.code!)]);
    expect((await scope1.exchange(grant)).status).toBe(200);
    const late = await scope1.authorize();
    await scope1.db.query("UPDATE rooms_mcp_codes SET expires_at=expires_at-interval '10 minutes' WHERE hash=$1", [tokenHash(late.code!)]);
    expect((await scope1.exchange(late)).status).toBe(400);
  });

  it('logs each refused token request with parameter names and reason, never values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const grant = await scope1.authorize();
      const form = (input: Record<string, string>, headers: Record<string, string> = {}) => phoneFetch(scope1.origin + '/mcp/oauth/token', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(input).toString() });
      const base = { grant_type: 'authorization_code', client_id: grant.clientId, code: grant.code!, code_verifier: grant.verifier };
      const cases: [Record<string, string>, Record<string, string>, string, string][] = [
        [{ ...base, redirect_uri: 'http://127.0.0.1:9876/other' }, {}, 'invalid_grant', 'redirect_uri_mismatch'],
        [{ ...base, resource: 'https://other.example/mcp' }, {}, 'invalid_grant', 'resource_mismatch'],
        [{ ...base, code_verifier: opaque() }, {}, 'invalid_grant', 'code_verifier_mismatch'],
        [{ ...base, code_verifier: 'short' }, {}, 'invalid_grant', 'code_verifier_invalid'],
        [{ ...base, code: opaque() }, {}, 'invalid_grant', 'code_unknown_or_used'],
        [{ ...base, client_secret: 'secret-value-123' }, {}, 'invalid_client', 'client_secret_unexpected'],
        [{ grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: 'refresh-value-123' }, {}, 'invalid_grant', 'refresh_token_invalid'],
        [{ grant_type: 'password', client_id: grant.clientId }, {}, 'unsupported_grant_type', 'grant_type_unsupported'],
        // A client-chosen grant_type or content-type never reaches the log verbatim.
        [{ grant_type: 'grant-sentinel-123', client_id: grant.clientId, client_secret: 'grant-sentinel-123' }, { 'content-type': 'application/x-www-form-urlencoded; x=y', 'x-ignored': 'z' }, 'unsupported_grant_type', 'grant_type_unsupported'],
      ];
      for (const [input, headers, error, reason] of cases) {
        warn.mockClear();
        const response = await form(input, headers);
        expect([reason, response.status, (await response.json() as { error: string }).error]).toEqual([reason, error === 'invalid_client' ? 401 : 400, error]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [label, line] = warn.mock.calls[0] as [string, string];
        expect(label).toBe('[rooms-mcp-oauth] token refused');
        const grantType = ['authorization_code', 'refresh_token'].includes(input.grant_type!) ? input.grant_type : 'other';
        expect(JSON.parse(line)).toMatchObject({ error, reason, grant_type: grantType, params: Object.keys(input).sort(), content_type: 'application/x-www-form-urlencoded' });
        for (const secret of [grant.code!, grant.verifier, 'secret-value-123', 'refresh-value-123', 'grant-sentinel-123', 'password', input.code_verifier!, input.code!].filter(Boolean))
          expect(line).not.toContain(secret);
      }
      // A JSON grant_type that cannot become a string still gets an OAuth error and one log line.
      warn.mockClear();
      const odd = await phoneFetch(scope1.origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: { toString: null }, client_id: grant.clientId }) });
      expect([odd.status, (await odd.json() as { error: string }).error]).toEqual([400, 'unsupported_grant_type']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0]![1] as string)).toMatchObject({ error: 'unsupported_grant_type', reason: 'grant_type_unsupported', grant_type: 'other',
        params: ['client_id', 'grant_type'], content_type: 'application/json' });
      // A body refused before parsing still logs its parameter names and the exact branch, never the values.
      warn.mockClear();
      const duplicate = await phoneFetch(scope1.origin + '/mcp/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=dup-one-123&code=dup-two-123&client_id=${grant.clientId}&code_verifier=dup-verifier-123` });
      expect([duplicate.status, (await duplicate.json() as { error: string }).error]).toEqual([400, 'invalid_request']);
      expect(warn).toHaveBeenCalledTimes(1);
      const duplicateLine = warn.mock.calls[0]![1] as string;
      expect(JSON.parse(duplicateLine)).toMatchObject({ error: 'invalid_request', reason: 'duplicate_parameter',
        params: ['client_id', 'code', 'code_verifier', 'grant_type'], content_type: 'application/x-www-form-urlencoded' });
      for (const value of ['dup-one-123', 'dup-two-123', 'dup-verifier-123', grant.clientId]) expect(duplicateLine).not.toContain(value);
      warn.mockClear();
      expect((await scope1.exchange(grant)).status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  it('does not grant on denial, replayed consent or a missing browser binding', async () => {
    const grant = await scope1.authorize(undefined, 'deny');
    expect(grant.code).toBeNull(); expect(grant.error).toBe('access_denied');
    expect((await scope1.post('/mcp/oauth/consent', { flow: grant.flow, decision: 'allow' }, { cookie: grant.cookie, origin: scope1.origin })).status).toBe(400);
    expect((await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=${grant.flow}`)).status).toBe(400);
  });

  it('R1: explains a taken consent handle without granting or changing the existing member', async () => {
    const existing = await scope1.connected();
    const handle = `pidoong_${randomBytes(4).toString('hex')}`;
    await existing.client.callTool({ name: 'set_profile', arguments: { name: 'Pidoong', handle } });
    const client = await (await scope1.post('/mcp/oauth/register', { client_name: 'ChatGPT', redirect_uris: ['http://127.0.0.1:9876/callback'] })).json() as { client_id: string };
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9876/callback', response_type: 'code',
      code_challenge: createHash('sha256').update(opaque()).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read rooms:write', state: 'collision' });
    const start = await phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, scope1.origin).searchParams.get('flow')!;
    await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await phoneFetch(`${scope1.origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    expect((await scope1.post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Pidoong', joiner_handle: handle }, { cookie, origin: scope1.origin })).status).toBe(302);
    const refused = await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin: scope1.origin });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Handle already taken');
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_members WHERE client_id=$1', [client.client_id])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_codes WHERE client_id=$1', [client.client_id])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT handle FROM identities WHERE id=$1', [existing.member])).rows[0]!.handle).toBe(handle);
  });

  it('previews and edits the joining member on consent', async () => {
    const registered = await scope1.post('/mcp/oauth/register', { client_name: 'Grok Bot', redirect_uris: ['http://127.0.0.1:9876/callback'] });
    const client = await registered.json() as { client_id: string };
    const verifier = opaque();
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9876/callback', response_type: 'code', resource: scope1.origin + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'rooms:read', state: 'edit-state' });
    const start = await phoneFetch(scope1.origin + '/mcp/oauth/authorize?' + query, { redirect: 'manual' });
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const flow = new URL(start.headers.get('location')!, scope1.origin).searchParams.get('flow')!;
    await phoneFetch(`${scope1.origin}/mcp/oauth/login?flow=${flow}&provider=google`, { headers: { cookie }, redirect: 'manual' });
    await phoneFetch(`${scope1.origin}/mcp/oauth/callback/google?state=${flow}&ticket=local-demo-ticket`, { headers: { cookie }, redirect: 'manual' });
    const page = await (await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(page).toContain('Webhook URL (optional)'); expect(page).toContain('Auth token (optional)');
    expect(page).not.toMatch(/Wake (link|key)/);
    expect(page).toContain('Joins as'); expect(page).toContain('Add Grok Bot to your team');
    expect(page).toContain('Starter instructions');
    expect(page).toContain('id="copy-routine" type="button">Copy</button>');
    for (const line of MCP_STARTER_ROUTINE.split('\n').filter(line => line.trim()))
      expect(page).toContain(`<li>${line.replaceAll("'", '&#39;')}</li>`);
    expect(page).toMatch(/<script nonce="[A-Za-z0-9+/=]+">/);
    expect(page).toContain('Read public Rooms in selected Workspaces'); expect(page).toContain('It joins their public Rooms'); expect(page).toContain('Post as Grok Bot');
    // The real Beeline icon, never a letter stand-in.
    expect(page).toContain('<img class="mark" src="data:image/svg+xml;base64,'); expect(page).not.toContain('>b</span>');
    const editPage = await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=${flow}&edit=1`, { headers: { cookie } });
    expect(editPage.headers.get('referrer-policy')).toBe('same-origin');
    expect(editPage.headers.get('content-security-policy')).not.toContain('form-action');
    const edit = await editPage.text();
    expect(edit).toContain('name="joiner_name"');
    for (const untrustedOrigin of ['https://evil.example', 'null', undefined]) {
      for (const decision of ['save', 'allow', 'deny']) {
        expect((await scope1.post('/mcp/oauth/consent', { flow, decision, joiner_name: 'Attacker', joiner_handle: 'attacker' },
          { cookie, ...(untrustedOrigin ? { origin: untrustedOrigin } : {}) })).status).toBe(400);
      }
    }
    expect((await scope1.post('/mcp/oauth/consent', { flow, decision: 'save', joiner_name: 'Firstmate', joiner_handle: 'firstmate' }, { cookie, origin: scope1.origin })).status).toBe(302);
    const renamed = await (await phoneFetch(`${scope1.origin}/mcp/oauth/consent?flow=${flow}`, { headers: { cookie } })).text();
    expect(renamed).toContain('Firstmate'); expect(renamed).toContain('@firstmate');
    const allowed = await scope1.post('/mcp/oauth/consent', { flow, decision: 'allow', trust_app: '1', workspace_selection: '1', workspace_ids: [WORKSPACE] }, { cookie, origin: scope1.origin });
    expect(allowed.status).toBe(302);
    const code = new URL(allowed.headers.get('location')!).searchParams.get('code')!;
    expect((await scope1.post('/mcp/oauth/token', { grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:9876/callback', resource: scope1.origin + '/mcp' })).status).toBe(200);
    const member = (await scope1.db.query<{ member_id: string }>('SELECT member_id FROM rooms_mcp_members WHERE owner_id=$1 AND client_id=$2', [USER, client.client_id])).rows[0]!.member_id;
    expect((await scope1.db.query<{ name: string; handle: string }>('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]).toEqual({ name: 'Firstmate', handle: 'firstmate' });
  });

  it('renders starter instructions as escaped ordered items with plain newline-separated copy text', async () => {
    const { consentHtml } = await scope1.authorize();
    const escape = (line: string) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const items = MCP_STARTER_ROUTINE.split('\n').filter(line => line.trim());
    const list = consentHtml.match(/<ol id="starter-routine" class="routine-text">([\s\S]*?)<\/ol>/);
    expect(list).not.toBeNull();
    expect(list![1]).toBe(items.map(line => `<li>${escape(line)}</li>`).join('\n'));
    expect(list![1].match(/<li>/g)).toHaveLength(items.length);
  });

  it('repeats the saved starter wake rule in server, setup and webhook instructions', async () => {
    const { client } = await scope1.connected();
    const setup = scope1.data(await client.callTool({ name: 'list_rooms', arguments: {} })).setup;
    const send = (await client.listTools()).tools.find(tool => tool.name === 'send_message')!;
    expect(send.description).toContain("asker's exact @handle to wake them");
    for (const text of [client.getInstructions(), setup, MCP_TAG_INSTRUCTION]) {
      expect(text).toContain(MCP_STARTER_ROUTINE);
      expect(text).toContain('Act only on your own tags and wakes from list_mentions. Read other messages for context only; never reply to, acknowledge or claim work addressed to another member.');
      expect(text).not.toContain('Tag another agent only to hand it a spelled-out job');
    }
  });

  it('R-WAKING-REPORTING: serves asker tags and order reporting rules to connected apps', async () => {
    const { client } = await scope1.connected();
    const instructions = client.getInstructions();
    for (const rule of [
      'Waking and reporting:',
      "start with the asker's exact @handle",
      'replyTo does not wake anyone',
      'When you finish, are blocked, fail, or need a decision on a chat request, tag the agent or person who asked you with the result.',
      'For orders under wakes, pass their id as commandId on tool calls; finish with report at that address, not a plain message.',
      'Corner reports go one step up to the opener at the opening surface; later chat requests do not change the commander.',
      'Choose the terminal status',
      'server adds its status prefix',
      'A plain post or send_message without a tag wakes nobody',
      'Tag an agent only when it must act on your reply',
      'Do not tag people just to mention them',
    ]) expect(instructions).toContain(rule);
    const tools = (await client.listTools()).tools;
    for (const name of ['send_message', 'post']) {
      expect(tools.find(tool => tool.name === name)?.description)
        .toContain("replyTo does not wake anyone; start with the asker's exact @handle");
    }
    const reportTool = tools.find(tool => tool.name === 'report')!;
    expect(reportTool.inputSchema.properties?.commandId).toMatchObject({ type: 'string', pattern: '^[0-9a-f]{64}$' });
    const report = reportTool.description;
    expect(report).toContain('Report a corner outcome to its opening commander at the opening surface.');
    expect(report).toContain('commandId binds the exact order');
    expect(report).toContain('a single pending order elsewhere');
    expect(report).toContain('refuses an ambiguous fallback and lists waiting orders');
    expect(report).not.toContain('oldest pending order elsewhere');
    expect(report).toContain('done:, blocked:, failed:, needs-decision:');
    expect(report).toContain('Later chat requests get ordinary replies here.');
  });

  it('hands finished local code to a corner implementer in every connected-app surface', async () => {
    const { client } = await scope1.connected();
    const instructions = client.getInstructions();
    for (const rule of [
      'The implementer pushes the corner branch with the Beeline GitHub App and opens the PR; the reviewer approves, then merge_corner lands it.',
      'Open a corner with an agent as implementer.',
      'feature/corner- followed by the first 12 hex characters of the corner id with hyphens removed',
      'A push or PR on that branch in the same repository links to the corner automatically; fork heads do not link.',
      'you may push your commits to that corner branch in the same repository',
      'post the patch into that corner, not the Room, with the base commit and the test commands you ran',
      "Your owner's approval of the connection covers sharing the patch with that corner.",
    ]) expect(instructions).toContain(rule);
    expect(instructions).not.toContain('you have no checkout');
    expect(instructions).not.toContain('Do not push with your own GitHub connection');
    const tools = (await client.listTools()).tools;
    const handoff = "Code work goes in a corner with another agent as implementer: use feature/corner- plus the first 12 hex characters of its id with hyphens removed; push existing commits there in the same repository with your own GitHub access, or post the patch in that corner, not the Room, with base commit and test commands for the implementer to apply and push with the Beeline GitHub App; your owner's connection approval covers sharing the patch.";
    for (const name of ['open_corner', 'post_artifact']) {
      expect(tools.find(tool => tool.name === name)?.description).toContain(handoff);
      expect(tools.find(tool => tool.name === name)?.description).not.toContain('you have no checkout');
    }
    const setup = scope1.data(await client.callTool({ name: 'list_rooms', arguments: {} })).setup;
    expect(setup).toContain('Repository writes go through a corner implementer.');
  });

  it('connects a real SDK client, reads, searches, posts as the member and wakes an agent', async () => {
    const { client, token, grant, member } = await scope1.connected();
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(9 + MCP_AGENT_TOOLS.length);
    const rooms = await client.callTool({ name: 'list_rooms', arguments: {} });
    expect(JSON.stringify(rooms)).toContain(ROOM); expect(JSON.stringify(rooms)).not.toContain(PRIVATE);
    const posted = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: '@demo-agent report the nebula test' } });
    expect(posted.isError).not.toBe(true);
    expect(JSON.parse((posted.content as { text: string }[])[0]!.text).data.woken).toEqual(['demo-agent']);
    const message = (await scope1.db.query<{ id: string; author_id: string }>(`SELECT id,author_id FROM messages WHERE room_id=$1 AND text=$2`, [ROOM, '@demo-agent report the nebula test'])).rows[0]!;
    expect(message.author_id).toBe(member);
    expect(message.author_id).not.toBe(USER);
    const command = (await scope1.db.query<{ id: string }>('SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [message.id, AGENT])).rows[0]!;
    expect(command).toBeDefined(); await claimAgentCommand(scope1.db, ROOM, AGENT, command.id, 'mcp-proof');
    expect((await scope1.db.query('SELECT state FROM agent_commands WHERE id=$1', [command.id])).rows[0]!.state).toBe('claimed');
    expect(JSON.stringify(await client.callTool({ name: 'read_messages', arguments: { room: ROOM, limit: 1 } }))).toContain('nebula test');
    const searched = JSON.stringify(await client.callTool({ name: 'search_messages', arguments: { query: 'nebula' } }));
    expect(searched).toContain('nebula test'); expect(searched).not.toContain('private nebula');
    expect(JSON.stringify(await client.callTool({ name: 'list_corners', arguments: { room: ROOM } }))).toContain(PUBLIC_CORNER);
    expect(JSON.stringify(await client.callTool({ name: 'corner_status', arguments: { corner: PUBLIC_CORNER } }))).toContain('Demo corner');
    expect((await scope1.phone.readRoom(ROOM, USER))!.messages.find(m => m.id === message.id)?.sourceClient).toEqual({ id: grant.clientId, name: 'Local MCP reviewer' });
    // One wake per tagged agent.
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [message.id, AGENT])).rowCount).toBe(1);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_audit WHERE client_id=$1 AND outcome=$2', [grant.clientId, 'succeeded'])).rowCount).toBeGreaterThan(0);
    await scope1.post('/mcp/oauth/revoke', { client_id: grant.clientId, token });
    expect((await phoneFetch(scope1.origin + '/mcp', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it.each(['send_message', 'post'])('keeps the wake chain across member replies through %s so a tag loop still stops at the depth limit', async replyTool => {
    const { client, grant, member } = await scope1.connected();
    await scope1.db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/loop' WHERE id=$1`, [grant.clientId]);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const latestMemberCommand = async () => (await scope1.db.query<{ agent_depth: number }>(
      'SELECT agent_depth FROM agent_commands WHERE room_id=$1 AND agent_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [ROOM, member])).rows[0];
    const agentCommand = async (sourceMessageId: string) => (await scope1.db.query<{ id: string; turn_request_id: string; agent_depth: number }>(
      'SELECT id,turn_request_id,agent_depth FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND source_message_id=$3',
      [ROOM, AGENT, sourceMessageId])).rows[0]!;
    // A person's tag wakes the webhook without a helper turn.
    await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} begin the handoff` }, USER);
    expect(await latestMemberCommand()).toBeUndefined();
    // The member replies through MCP and tags the demo agent: depth one, not a reset.
    const first = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: '@demo-agent step one' } });
    const firstId = JSON.parse((first.content as { text: string }[])[0]!.text).data.messageId as string;
    const firstCommand = await agentCommand(firstId);
    expect(firstCommand.agent_depth).toBe(1);
    // The demo agent answers, tagging the external member at depth two.
    await scope1.daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: firstCommand.id, generationId: 'loop-1' }, AGENT);
    await scope1.daemon.execute('postAgentTurnReceipt', { roomId: ROOM, agentId: AGENT, requestId: firstCommand.turn_request_id, generationId: 'loop-1', status: 'working' }, AGENT);
    await scope1.daemon.execute('postRoomMessage', { roomId: ROOM, requestId: firstCommand.turn_request_id, generationId: 'loop-1', text: `@${handle} step one done` }, AGENT);
    expect(await latestMemberCommand()).toBeUndefined();
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1', [member])).rowCount).toBe(2);
    // The member replies again: depth three, the last depth the limit allows.
    const second = await client.callTool(replyTool === 'post'
      ? { name: 'post', arguments: { address: ROOM, text: '@demo-agent step two' } }
      : { name: 'send_message', arguments: { room: ROOM, text: '@demo-agent step two' } });
    expect(second.isError).not.toBe(true);
    const secondId = (await scope1.db.query<{ id: string }>(
      'SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [ROOM, member])).rows[0]!.id;
    const secondCommand = await agentCommand(secondId);
    expect(secondCommand.agent_depth).toBe(3);
    // The final tag still reaches the external member, without a helper turn.
    const stopped = await latestMemberCommand();
    await scope1.daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: secondCommand.id, generationId: 'loop-2' }, AGENT);
    await scope1.daemon.execute('postAgentTurnReceipt', { roomId: ROOM, agentId: AGENT, requestId: secondCommand.turn_request_id, generationId: 'loop-2', status: 'working' }, AGENT);
    await scope1.daemon.execute('postRoomMessage', { roomId: ROOM, requestId: secondCommand.turn_request_id, generationId: 'loop-2', text: `@${handle} step two done` }, AGENT);
    expect(await latestMemberCommand()).toEqual(stopped);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1', [member])).rowCount).toBe(3);
    // Its reply retains that depth, so it cannot start a fourth helper hop.
    const reply = await client.callTool(replyTool === 'post'
      ? { name: 'post', arguments: { address: ROOM, text: '@demo-agent step three' } }
      : { name: 'send_message', arguments: { room: ROOM, text: '@demo-agent step three' } });
    expect(reply.isError).not.toBe(true);
    const replyId = (await scope1.db.query<{ id: string }>(
      'SELECT id FROM messages WHERE room_id=$1 AND author_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [ROOM, member])).rows[0]!.id;
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [replyId, AGENT])).rowCount).toBe(0);
  });

  it.each([
    ['Claude Code', [], 'Claude Code'],
    ['Codex', [], 'Codex'],
    ['OpenCode', [], 'OpenCode'],
    ['Cursor', [], 'Cursor'],
    ['Cursor', ['https://www.cursor.com/agents/mcp/oauth/callback'], 'Grok Bot'],
  ])('shows registered %s app identity for existing joined sessions', async (name, redirects, label) => {
    const { grant, member } = await scope1.connected();
    await scope1.db.query('UPDATE rooms_mcp_clients SET name=$2,redirects=$3 WHERE id=$1',
      [grant.clientId, name, JSON.stringify(redirects)]);
    // Old registrations kept these placeholders even after their client identity changed.
    await scope1.db.query("UPDATE agents SET selected_model='agent' WHERE agent_id=$1", [member]);
    await scope1.db.query("UPDATE identities SET name='My reviewer' WHERE id=$1", [member]);
    const roster = await scope1.phone.readWorkspaceMembers(WORKSPACE, USER, { q: 'My reviewer' });
    expect(roster?.agents.find(agent => agent.identity.pubkey === member)?.model).toBe(label);
    const profile = await scope1.phone.readAgent(WORKSPACE, member, USER);
    expect(profile?.selected?.model).toBe(label);
    expect(profile?.seededSoul).toContain(`Connected through ${label}.`);
    expect(profile?.agent.identity.name).toBe('My reviewer');
    await ensureMcpMember(scope1.db, { clientId: grant.clientId, ownerId: USER, modelLabel: name });
    expect((await scope1.db.query<{ selected_model: string }>('SELECT selected_model FROM agents WHERE agent_id=$1', [member])).rows[0]?.selected_model).toBe(label);
    expect((await scope1.phone.readAgent(WORKSPACE, member, USER))?.agent.identity.name).toBe('My reviewer');
  });


  it('sets this member’s own profile without changing its registered model label', async () => {
    const { client, member } = await scope1.connected();
    const updated = await client.callTool({ name: 'set_profile', arguments: { name: 'Firstmate', handle: 'firstmate_set', avatar: '' } });
    expect(updated.isError).not.toBe(true);
    const identity = (await scope1.db.query<{ name: string; handle: string }>('SELECT name,handle FROM identities WHERE id=$1', [member])).rows[0]!;
    expect(identity).toEqual({ name: 'Firstmate', handle: 'firstmate_set' });
    const config = (await scope1.db.query<{ selected_model: string }>('SELECT selected_model FROM agents WHERE agent_id=$1', [member])).rows[0]!;
    expect(config.selected_model).toBe('Local MCP reviewer');
  });

  it('is idempotent on the client key and posts nothing on a retry', async () => {
    const { client } = await scope1.connected();
    const first = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'idempotent handoff @demo-agent', idempotencyKey: 'job-1' } });
    const id = JSON.parse((first.content as { text: string }[])[0]!.text).data.messageId as string;
    expect((await scope1.db.query('SELECT 1 FROM messages WHERE id=$1', [id])).rowCount).toBe(1);
    const second = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: 'idempotent handoff @demo-agent', idempotencyKey: 'job-1' } });
    expect(JSON.parse((second.content as { text: string }[])[0]!.text).data.messageId).toBe(id);
    expect((await scope1.db.query('SELECT 1 FROM messages WHERE text=$1', ['idempotent handoff @demo-agent'])).rowCount).toBe(1);
  });

  it.each(['member', 'client', 'none'])('MCP-TAG-DEPTH: depth-three report preserves the tag with %s webhook', async callback => {
    await deliverMcpMemberWebhooks(scope1.db, async () => new Response('', { status: 200 }));
    const { client, grant, member } = await scope1.connected();
    const url = 'https://hooks.example/depth-three';
    if (callback === 'member')
      await client.callTool({ name: 'set_webhook', arguments: { url } });
    if (callback === 'client')
      await scope1.db.query('UPDATE rooms_mcp_clients SET callback_url=$2 WHERE id=$1', [grant.clientId, url]);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_event_subscriptions WHERE member_id=$1', [member])).rowCount).toBe(0);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const source = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: '@demo-agent report back' }, USER);
    const command = (await scope1.db.query<{ id: string; turn_request_id: string }>(
      "UPDATE agent_commands SET agent_depth=3,reason='report' WHERE source_message_id=$1 AND agent_id=$2 RETURNING id,turn_request_id",
      [source.messageId, AGENT])).rows[0]!;
    const generationId = `depth-three-${callback}`;
    await scope1.daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: command.id, generationId }, AGENT);
    await scope1.daemon.execute('postAgentTurnReceipt', { roomId: ROOM, agentId: AGENT, requestId: command.turn_request_id, generationId, status: 'working' }, AGENT);
    const result = await scope1.daemon.execute('postRoomMessage', { roomId: ROOM, requestId: command.turn_request_id, generationId, text: `@${handle} the work is finished` }, AGENT);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_mentions WHERE member_id=$1 AND message_id=$2', [member, result.id])).rowCount).toBe(1);
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE agent_id=$1', [member])).rowCount).toBe(0);
    const posts: { url: string; body: { messageId: string; memberId: string } }[] = [];
    await deliverMcpMemberWebhooks(scope1.db, async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return new Response('', { status: 200 });
    });
    expect(posts.filter(post => post.body.memberId === member)).toEqual(callback === 'none' ? [] : [
      { url, body: expect.objectContaining({ messageId: result.id, memberId: member }) },
    ]);
    const mentions = await client.callTool({ name: 'list_mentions', arguments: {} });
    expect(JSON.stringify(mentions)).toContain(result.id);
  });

  it('returns the webhook member in send_message woken without creating its command', async () => {
    const sender = await scope1.connected();
    const target = await scope1.connected();
    await scope1.db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/member' WHERE id=$1`, [target.grant.clientId]);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [target.member])).rows[0]!.handle;
    const result = await sender.client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `@${handle} hello`, idempotencyKey: 'webhook-wake' } });
    const data = JSON.parse((result.content as { text: string }[])[0]!.text).data;
    expect(data.woken).toEqual([handle]);
    const retry = await sender.client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `@${handle} hello`, idempotencyKey: 'webhook-wake' } });
    expect(JSON.parse((retry.content as { text: string }[])[0]!.text).data).toEqual(data);
    expect((await scope1.db.query('SELECT 1 FROM agent_commands WHERE agent_id=$1', [target.member])).rowCount).toBe(0);
    expect((await scope1.db.query('SELECT 1 FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [target.member, data.messageId])).rowCount).toBe(1);
  });

  it('fires one outgoing webhook per (message, member) and never for its own post', async () => {
    await deliverMcpMemberWebhooks(scope1.db, async () => new Response('', { status: 200 }));
    const { client, grant, member } = await scope1.connected();
    await scope1.db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/firstmate' WHERE id=$1`, [grant.clientId]);
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} ship the webhook` }, USER);
    const calls = async () => (await scope1.db.query('SELECT id FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, sent.messageId])).rowCount;
    expect(await calls()).toBe(1);
    // A repeated route of the same message never calls again.
    await routeHumanMessage(scope1.db, sent.messageId);
    expect(await calls()).toBe(1);
    const delivered: string[] = [];
    const count = await deliverMcpMemberWebhooks(scope1.db, async (url) => {
      delivered.push(String(url)); return new Response('', { status: 200 });
    });
    expect(count).toBe(1); expect(delivered).toEqual(['https://hooks.example/firstmate']);
    expect((await scope1.db.query('SELECT delivered_at FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rows[0]!.delivered_at).not.toBeNull();
    // Its own post tags itself; a member is never its own wake target, so no webhook call.
    const own = await client.callTool({ name: 'send_message', arguments: { room: ROOM, text: `@${handle} self note` } });
    const ownId = JSON.parse((own.content as { text: string }[])[0]!.text).data.messageId as string;
    expect((await scope1.db.query('SELECT 1 FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, ownId])).rowCount).toBe(0);
  });

  it('delivers nothing to a member removed from the Room before the drain', async () => {
    const { grant, member } = await scope1.connected();
    await scope1.db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/removed' WHERE id=$1`, [grant.clientId]);
    // Drain earlier tests' backlog so only this delivery is pending.
    await deliverMcpMemberWebhooks(scope1.db, async () => new Response('', { status: 200 }));
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} queued before removal` }, USER);
    // The wake is already queued, then the owner removes the member from the Room.
    await scope1.phone.execute('removeRoomMember', { roomId: ROOM, memberId: member }, USER);
    let calls = 0;
    const delivered = await deliverMcpMemberWebhooks(scope1.db, async () => { calls++; return new Response('', { status: 200 }); });
    // No HTTP call fires and the queued text never leaves the outbox.
    expect(delivered).toBe(0);
    expect(calls).toBe(0);
    expect((await scope1.db.query('SELECT delivered_at FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rows[0]!.delivered_at).not.toBeNull();
    expect((await scope1.db.query('SELECT outcome FROM subscription_webhook_calls WHERE member_id=$1 AND wake_message_id=$2', [member, sent.messageId])).rows[0]!.outcome).toBe('skipped');
  });

  it('claims a pending delivery once so overlapping drains never double-post', async () => {
    const { grant, member } = await scope1.connected();
    await scope1.db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/concurrent' WHERE id=$1`, [grant.clientId]);
    // Drain earlier tests' backlog so only this delivery is pending.
    await deliverMcpMemberWebhooks(scope1.db, async () => new Response('', { status: 200 }));
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const sent = await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} deliver once` }, USER);
    let calls = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Only the first HTTP request is held open; a duplicate attempt returns at
    // once, so an overlapping drain that re-claims the row is caught, not stuck.
    const transport = (async () => {
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const first = deliverMcpMemberWebhooks(scope1.db, transport);
    await firstStarted;
    // A second drain overlaps the first while its HTTP request is held open.
    const overlapping = await deliverMcpMemberWebhooks(scope1.db, transport);
    release();
    expect(await first).toBe(1);
    expect(overlapping).toBe(0);
    expect(calls).toBe(1);
    expect((await scope1.db.query('SELECT delivered_at FROM rooms_mcp_webhook_outbox WHERE member_id=$1 AND message_id=$2', [member, sent.messageId])).rows[0]!.delivered_at).not.toBeNull();
  });

  it('claims each delivery at send time so a slow batch cannot go stale and double-post', async () => {
    const { grant, member } = await scope1.connected();
    await scope1.db.query(`UPDATE rooms_mcp_clients SET callback_url='https://hooks.example/slow-batch' WHERE id=$1`, [grant.clientId]);
    // Drain earlier tests' backlog so only this batch is pending.
    await deliverMcpMemberWebhooks(scope1.db, async () => new Response('', { status: 200 }));
    const handle = (await scope1.db.query<{ handle: string }>('SELECT handle FROM identities WHERE id=$1', [member])).rows[0]!.handle;
    const texts = ['batch one', 'batch two', 'batch three'];
    for (const text of texts) await scope1.phone.execute('sendRoomMessage', { roomId: ROOM, text: `@${handle} ${text}` }, USER);
    const received: string[] = [];
    let inFlight = '';
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = (async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { text: string };
      received.push(payload.text);
      if (!inFlight) { inFlight = payload.text; started(); await gate; }
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const first = deliverMcpMemberWebhooks(scope1.db, transport);
    await firstStarted;
    // An active delivery remains claimed even past its former lease window.
    const inFlightId = (await scope1.db.query<{ message_id: string }>(
      'SELECT message_id FROM rooms_mcp_webhook_outbox WHERE body=$1 AND delivered_at IS NULL', [inFlight])).rows[0]!.message_id;
    await scope1.db.query(
      `UPDATE rooms_mcp_webhook_outbox SET claimed_at=now()-interval '2 minutes'
       WHERE delivered_at IS NULL AND message_id=$1`, [inFlightId]);
    const overlapping = await deliverMcpMemberWebhooks(scope1.db, transport);
    release();
    await first;
    // Each queued delivery is sent exactly once, by whichever drain claimed it.
    expect(overlapping).toBe(2);
    expect(received).toHaveLength(3);
    for (const text of texts) expect(received.filter(body => body.endsWith(text))).toHaveLength(1);
  });

  it('denies cross-user reads, searches, sends and corner reads without exposing private content', async () => {
    const { client } = await scope1.connected();
    for (const [name, args] of [
      ['read_messages', { room: PRIVATE }], ['search_messages', { room: PRIVATE, query: 'nebula' }],
      ['send_message', { room: PRIVATE, text: 'forbidden' }], ['list_corners', { room: PRIVATE }], ['corner_status', { corner: CORNER }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args }); expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private nebula');
    }
    expect((await scope1.db.query("SELECT 1 FROM messages WHERE room_id=$1 AND text='forbidden'", [PRIVATE])).rowCount).toBe(0);
  });

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
});
