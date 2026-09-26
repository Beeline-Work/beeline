import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorAssignment } from '@beeline/api-contract/daemon';
import { rewriteGrantedHostRoutes } from './host-mcp-route.js';
import { credentialMaskPaths } from './bwrap-sandbox.js';
import {
  CEREMONY_EXPIRED,
  installRegistryMcp,
  OWN_MACHINE_REFUSAL,
  REGISTRY_MCP_APPROVAL_REFUSAL,
  RegistryMcpHostBroker,
  registryMcpHostBindPaths,
  registryMcpHostDeclarations,
  registryMcpStatePath,
  registryMcpStateRoot,
} from './registry-mcp.js';

const homes: string[] = [];
const CONNECTOR = '22222222-2222-4222-8222-222222222222';
const assignment: Extract<ConnectorAssignment, { kind: 'install' }> = {
  kind: 'install',
  connectorId: CONNECTOR,
  connectorType: 'registry-mcp',
  registryServerName: 'app.linear/linear',
  registryVersion: '1.0.1',
  registryManifest: {
    name: 'app.linear/linear',
    version: '1.0.1',
    title: 'Linear',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
    packages: [],
    secretInputNames: [],
  },
};

const TURN = { roomId: 'room-1', requestId: 'request-1', generationId: 'generation-1' };
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
const TOOLS_CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 9,
  method: 'tools/call',
  params: { name: 'create_issue', arguments: {} },
});

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function socketCall(socketPath: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(JSON.stringify(payload)));
    socket.on('data', (chunk) => {
      output += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(JSON.parse(output) as Record<string, unknown>));
  });
}

describe('Registry MCP OAuth installer', () => {
  it('discovers DCR, creates an S256 PKCE request, and keeps provider secrets out of results', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    let callbackReady = false;
    const api = {
      execute: vi.fn(async (name: string) => {
        if (name === 'beginRegistryMcpOAuth')
          return {
            state: 'opaque-callback-state',
            redirectUri: 'https://beeline.example/v1/registry-mcp/oauth/callback',
          };
        if (name === 'claimRegistryMcpOAuthCode')
          return callbackReady
            ? { status: 'ready', code: 'short-lived-code' }
            : { status: 'pending' };
        throw new Error(`unexpected ${name}`);
      }),
    };
    const requests: { url: string; body?: string; authorization?: string }[] = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.body ? { body: String(init.body) } : {}),
        ...(new Headers(init?.headers).get('authorization')
          ? { authorization: new Headers(init?.headers).get('authorization')! }
          : {}),
      });
      if (url === 'https://mcp.linear.app/mcp') {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write"',
          },
        });
      }
      if (url.includes('oauth-protected-resource'))
        return Response.json({
          authorization_servers: ['https://mcp.linear.app'],
          scopes_supported: ['read', 'write'],
        });
      if (url === 'https://mcp.linear.app/.well-known/oauth-authorization-server')
        return Response.json({
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          code_challenge_methods_supported: ['S256'],
        });
      if (url === 'https://mcp.linear.app/register')
        return Response.json({
          client_id: 'dynamic-client',
        });
      if (url === 'https://mcp.linear.app/token')
        return Response.json({
          access_token: 'linear-access-secret',
          refresh_token: 'linear-refresh-secret',
          expires_in: 3600,
        });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    const pending = await installRegistryMcp({
      api,
      agentId: 'b'.repeat(64),
      assignment,
      home,
      transport,
    });
    expect(pending.status).toBe('installing');
    if (pending.status !== 'installing') throw new Error('expected OAuth sign-in');
    const authorization = new URL(pending.authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe('https://mcp.linear.app/authorize');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('state')).toBe('opaque-callback-state');
    expect(authorization.searchParams.get('scope')).toBe('read write');
    expect(authorization.searchParams.get('resource')).toBe('https://mcp.linear.app/mcp');
    const storedPending = JSON.parse(
      readFileSync(registryMcpStatePath(CONNECTOR, home), 'utf8'),
    ) as {
      verifier: string;
    };
    expect(authorization.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(storedPending.verifier).digest('base64url'),
    );
    expect(JSON.stringify(pending)).not.toContain(storedPending.verifier);
    expect(requests.map((request) => request.url)).toContain('https://mcp.linear.app/register');

    callbackReady = true;
    const connected = await installRegistryMcp({
      api,
      agentId: 'b'.repeat(64),
      assignment,
      home,
      transport,
    });
    expect(connected).toEqual({
      status: 'connected',
      steps: [
        { label: 'Discover remote authentication', status: 'done' },
        { label: 'Connect provider account', status: 'done' },
      ],
    });
    const tokenRequest = requests.find(
      (request) => request.url === 'https://mcp.linear.app/token',
    )!;
    expect(tokenRequest.body).toContain('code_verifier=');
    expect(tokenRequest.body).toContain('code=short-lived-code');
    expect(tokenRequest.body).toContain('resource=https%3A%2F%2Fmcp.linear.app%2Fmcp');
    expect(JSON.stringify(connected)).not.toMatch(
      /linear-(?:access|refresh)-secret|short-lived-code/,
    );
    const storedConnected = readFileSync(registryMcpStatePath(CONNECTOR, home), 'utf8');
    expect(storedConnected).toContain('linear-access-secret');
    expect(storedConnected).toContain('linear-refresh-secret');

    const declarations = registryMcpHostDeclarations(
      [
        {
          connectorId: CONNECTOR,
          serverName: 'app.linear/linear',
          displayName: 'Linear',
          routeName: 'registry_mcp_linear',
          target: 'registry-mcp:app.linear/linear',
        },
      ],
      join(home, 'turn-context.json'),
      join(home, '.beeline', 'registry-mcp-broker', 'test.sock'),
    );
    expect(declarations.registry_mcp_linear!.env).toMatchObject({
      BEELINE_REGISTRY_MCP_CONNECTOR: CONNECTOR,
      BEELINE_TURN_CONTEXT_FILE: join(home, 'turn-context.json'),
    });
    // Mounted behind the resource façade under its stable target, with the
    // broker named as the layer that spends the grant.
    const mounted = rewriteGrantedHostRoutes(
      declarations,
      ['registry_mcp_linear'],
      home,
      join(home, 'turn.resource-auth.json'),
    ).registry_mcp_linear!;
    expect(mounted.command).toBe(process.execPath);
    expect(mounted.env).toMatchObject({
      BEELINE_RESOURCE_TARGET: 'registry-mcp:app.linear/linear',
      BEELINE_RESOURCE_GATE: 'transport',
      BEELINE_RESOURCE_AUTH_FILE: join(home, 'turn.resource-auth.json'),
    });
    expect(JSON.stringify(declarations)).not.toMatch(
      /linear-(?:access|refresh)-secret|short-lived-code/,
    );
    expect(JSON.stringify(declarations)).not.toContain(registryMcpStatePath(CONNECTOR, home));
    expect(
      registryMcpHostBindPaths(
        assignment.registryManifest
          ? [
              {
                connectorId: CONNECTOR,
                serverName: 'app.linear/linear',
                displayName: 'Linear',
                routeName: 'registry_mcp_linear',
                target: 'registry-mcp:app.linear/linear',
              },
            ]
          : [],
        join(home, '.beeline', 'registry-mcp-broker', 'test.sock'),
      ),
    ).toEqual([join(home, '.beeline', 'registry-mcp-broker')]);

    let providerAuthorization: string | null = null;
    let providerCalls = 0;
    const asked: Array<{ target: string; consume: boolean; roomId: string }> = [];
    let allowed = true;
    const broker = new RegistryMcpHostBroker(
      home,
      vi.fn(async (_input, init) => {
        providerCalls += 1;
        providerAuthorization = new Headers(init?.headers).get('authorization');
        return Response.json({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
      }) as typeof fetch,
      async ({ target, consume, roomId }) => {
        asked.push({ target, consume, roomId });
        return allowed;
      },
    );
    await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one')).resolves.toEqual([
      JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } }),
    ]);
    expect(asked).toEqual([
      { target: 'registry-mcp:app.linear/linear', consume: false, roomId: 'room-1' },
    ]);
    expect(providerAuthorization).toBe('Bearer linear-access-secret');

    // A third-party requester with no standing grant is held for the owner.
    allowed = false;
    providerCalls = 0;
    await expect(broker.request(CONNECTOR, TOOLS_CALL, TURN, 'connection-one')).rejects.toThrow(
      REGISTRY_MCP_APPROVAL_REFUSAL,
    );
    expect(asked.at(-1)).toEqual({
      target: 'registry-mcp:app.linear/linear',
      consume: true,
      roomId: 'room-1',
    });
    expect(providerCalls).toBe(0);
    allowed = true;

    await broker.start();
    try {
      await expect(
        socketCall(broker.socketPath, {
          connectorId: CONNECTOR,
          line: TOOLS_CALL,
          connectionId: 'connection-one',
        }),
      ).resolves.toEqual({ error: REGISTRY_MCP_APPROVAL_REFUSAL });
      expect(providerCalls).toBe(0);
      await expect(
        socketCall(broker.socketPath, {
          connectorId: CONNECTOR,
          line: TOOLS_LIST,
          turn: TURN,
          connectionId: 'connection-one',
        }),
      ).resolves.toEqual({
        messages: [JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } })],
      });
      expect(providerCalls).toBe(1);
    } finally {
      await broker.stop();
    }
  });

  it('blames the step that failed when the provider refuses the token exchange', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    let callbackReady = false;
    const api = {
      execute: vi.fn(async (name: string) => {
        if (name === 'beginRegistryMcpOAuth')
          return { state: 'opaque', redirectUri: 'https://beeline.example/callback' };
        if (name === 'claimRegistryMcpOAuthCode')
          return callbackReady
            ? { status: 'ready', code: 'short-lived-code' }
            : { status: 'pending' };
        throw new Error(`unexpected ${name}`);
      }),
    };
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://mcp.linear.app/mcp')
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"',
          },
        });
      if (url.includes('oauth-protected-resource'))
        return Response.json({ authorization_servers: ['https://mcp.linear.app'] });
      if (url === 'https://mcp.linear.app/.well-known/oauth-authorization-server')
        return Response.json({
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          code_challenge_methods_supported: ['S256'],
        });
      if (url === 'https://mcp.linear.app/register')
        return Response.json({ client_id: 'dynamic-client' });
      if (url === 'https://mcp.linear.app/token') return new Response('', { status: 400 });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const input = {
      api,
      agentId: 'b'.repeat(64),
      assignment,
      home,
      transport,
      resolveHost: async () => ['93.184.216.34'],
    };
    expect(await installRegistryMcp(input)).toMatchObject({ status: 'installing' });
    callbackReady = true;
    expect(await installRegistryMcp(input)).toEqual({
      status: 'error',
      errorMessage: 'Provider authorization could not be completed; retry the connection',
      steps: [
        { label: 'Discover remote authentication', status: 'done' },
        {
          label: 'Connect provider account',
          status: 'failed',
          reason: 'Provider authorization could not be completed; retry the connection',
        },
      ],
    });
  });

  it('drops a provider session id the remote rejected instead of wedging the connector', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    mkdirSync(join(home, '.beeline', 'registry-mcp'), { recursive: true });
    writeFileSync(
      registryMcpStatePath(CONNECTOR, home),
      JSON.stringify({
        status: 'connected',
        connectorId: CONNECTOR,
        serverName: 'app.linear/linear',
        version: '1.0.1',
        remoteUrl: 'https://mcp.linear.app/mcp',
        accessToken: 'linear-access-secret',
      }),
    );
    const sent: (string | null)[] = [];
    let live = 'session-one';
    const broker = new RegistryMcpHostBroker(
      home,
      vi.fn(async (_input, init) => {
        const offered = new Headers(init?.headers).get('mcp-session-id');
        sent.push(offered);
        if (offered && offered !== live) return new Response('', { status: 404 });
        return Response.json(
          { jsonrpc: '2.0', id: 1, result: {} },
          { headers: { 'mcp-session-id': live } },
        );
      }) as typeof fetch,
      async () => true,
    );
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await broker.request(CONNECTOR, initialize, TURN, 'connection-one');
    await broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one');
    expect(sent).toEqual([null, 'session-one']);

    live = 'session-two';
    await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one')).rejects.toThrow(
      'remote refused call',
    );
    // The next call re-establishes rather than re-offering the dead id.
    await broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one');
    expect(sent).toEqual([null, 'session-one', 'session-one', null]);
    // A fresh `initialize` never carries the session it is replacing.
    await broker.request(CONNECTOR, initialize, TURN, 'connection-one');
    expect(sent.at(-1)).toBeNull();
  });

  it('keeps one provider session per bridge connection, not per connector', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    mkdirSync(join(home, '.beeline', 'registry-mcp'), { recursive: true });
    writeFileSync(
      registryMcpStatePath(CONNECTOR, home),
      JSON.stringify({
        status: 'connected',
        connectorId: CONNECTOR,
        serverName: 'app.linear/linear',
        version: '1.0.1',
        remoteUrl: 'https://mcp.linear.app/mcp',
        accessToken: 'linear-access-secret',
      }),
    );
    const offered: string[] = [];
    const dead = new Set<string>();
    let initializes = 0;
    const broker = new RegistryMcpHostBroker(
      home,
      vi.fn(async (_input, init) => {
        const session = new Headers(init?.headers).get('mcp-session-id');
        offered.push(session ?? '');
        if (session && dead.has(session)) return new Response('', { status: 404 });
        if (session)
          return Response.json(
            { jsonrpc: '2.0', id: 1, result: {} },
            { headers: { 'mcp-session-id': session } },
          );
        const fresh = ['session-a', 'session-b'][initializes++] ?? 'session-c';
        return Response.json(
          { jsonrpc: '2.0', id: 1, result: {} },
          { headers: { 'mcp-session-id': fresh } },
        );
      }) as typeof fetch,
      async () => true,
    );
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    // Two harness connections initialize against the same connector, and the
    // remote hands each its own session id.
    await broker.request(CONNECTOR, initialize, TURN, 'connection-one');
    await broker.request(CONNECTOR, initialize, TURN, 'connection-two');
    await broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one');
    await broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-two');
    expect(offered).toEqual(['', '', 'session-a', 'session-b']);

    // A 404 on connection one drops ONLY that connection's session: the
    // second connection keeps using its own.
    dead.add('session-a');
    await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one')).rejects.toThrow(
      'remote refused call',
    );
    await broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-two');
    expect(offered.at(-1)).toBe('session-b');
    await broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one');
    expect(offered.at(-1)).toBe('');
  });

  it('sends the metadata resource indicator on authorization, exchange and refresh', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    // The Registry manifest's remote and the provider's canonical resource
    // differ; RFC 8707 target consistency fails unless every leg agrees.
    const canonical = 'https://mcp.linear.app/mcp/';
    let callbackReady = false;
    const api = {
      execute: vi.fn(async (name: string) => {
        if (name === 'beginRegistryMcpOAuth')
          return { state: 'opaque', redirectUri: 'https://beeline.example/callback' };
        if (name === 'claimRegistryMcpOAuthCode')
          return callbackReady ? { status: 'ready', code: 'code-one' } : { status: 'pending' };
        throw new Error(`unexpected ${name}`);
      }),
    };
    const bodies: string[] = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://mcp.linear.app/mcp')
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"',
          },
        });
      if (url.includes('oauth-protected-resource'))
        return Response.json({
          resource: canonical,
          authorization_servers: ['https://mcp.linear.app'],
        });
      if (url === 'https://mcp.linear.app/.well-known/oauth-authorization-server')
        return Response.json({
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          code_challenge_methods_supported: ['S256'],
        });
      if (url === 'https://mcp.linear.app/register')
        return Response.json({ client_id: 'dynamic-client' });
      if (url === 'https://mcp.linear.app/token') {
        bodies.push(String(init?.body));
        return Response.json({
          access_token: 'access-one',
          refresh_token: 'refresh-one',
          expires_in: 0,
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const input = {
      api,
      agentId: 'b'.repeat(64),
      assignment,
      home,
      transport,
      resolveHost: async () => ['93.184.216.34'],
    };
    const pending = await installRegistryMcp(input);
    if (pending.status !== 'installing') throw new Error('expected OAuth sign-in');
    expect(new URL(pending.authorizationUrl).searchParams.get('resource')).toBe(canonical);

    callbackReady = true;
    expect(await installRegistryMcp(input)).toMatchObject({ status: 'connected' });
    expect(new URLSearchParams(bodies[0]!).get('resource')).toBe(canonical);

    // `expires_in: 0` makes the next broker call refresh before it forwards.
    const broker = new RegistryMcpHostBroker(home, transport, async () => true);
    await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one')).rejects.toThrow();
    expect(new URLSearchParams(bodies[1]!).get('resource')).toBe(canonical);
  });

  it('reads authorization-server metadata from a path-scoped issuer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    const asked: string[] = [];
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://mcp.linear.app/mcp')
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"',
          },
        });
      if (url.includes('oauth-protected-resource'))
        return Response.json({ authorization_servers: ['https://login.example.com/tenant1'] });
      if (url.includes('.well-known')) {
        asked.push(url);
        // RFC 8414: the well-known segment goes BEFORE the issuer's path.
        return url === 'https://login.example.com/.well-known/oauth-authorization-server/tenant1'
          ? Response.json({
              authorization_endpoint: 'https://login.example.com/tenant1/authorize',
              token_endpoint: 'https://login.example.com/tenant1/token',
              registration_endpoint: 'https://login.example.com/tenant1/register',
              code_challenge_methods_supported: ['S256'],
            })
          : new Response('', { status: 404 });
      }
      if (url === 'https://login.example.com/tenant1/register')
        return Response.json({ client_id: 'dynamic-client' });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const result = await installRegistryMcp({
      api: {
        execute: vi.fn(async () => ({
          state: 'opaque',
          redirectUri: 'https://beeline.example/callback',
        })),
      },
      agentId: 'b'.repeat(64),
      assignment,
      home,
      transport,
      resolveHost: async () => ['93.184.216.34'],
    });
    if (result.status !== 'installing') throw new Error('expected OAuth sign-in');
    expect(
      new URL(result.authorizationUrl).origin + new URL(result.authorizationUrl).pathname,
    ).toBe('https://login.example.com/tenant1/authorize');
    expect(asked[0]).toBe(
      'https://login.example.com/.well-known/oauth-authorization-server/tenant1',
    );
  });

  it('keeps the provider session through a transient refusal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    mkdirSync(join(home, '.beeline', 'registry-mcp'), { recursive: true });
    writeFileSync(
      registryMcpStatePath(CONNECTOR, home),
      JSON.stringify({
        status: 'connected',
        connectorId: CONNECTOR,
        serverName: 'app.linear/linear',
        version: '1.0.1',
        remoteUrl: 'https://mcp.linear.app/mcp',
        accessToken: 'linear-access-secret',
      }),
    );
    const sent: (string | null)[] = [];
    let refuse = 0;
    const broker = new RegistryMcpHostBroker(
      home,
      vi.fn(async (_input, init) => {
        sent.push(new Headers(init?.headers).get('mcp-session-id'));
        if (refuse) return new Response('', { status: refuse });
        return Response.json(
          { jsonrpc: '2.0', id: 1, result: {} },
          { headers: { 'mcp-session-id': 'session-one' } },
        );
      }) as typeof fetch,
      async () => true,
    );
    await broker.request(
      CONNECTOR,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      TURN,
      'connection-one',
    );
    for (const status of [429, 502, 401]) {
      refuse = status;
      await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one')).rejects.toThrow(
        'remote refused call',
      );
    }
    refuse = 0;
    await broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one');
    // The session the remote issued survived every one-call refusal: only a
    // 404 (a terminated session) may drop it.
    expect(sent).toEqual([null, 'session-one', 'session-one', 'session-one', 'session-one']);
  });

  it('has the provider store masked before any connect writes a token into it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    const store = registryMcpStateRoot(home);
    expect(credentialMaskPaths(undefined, home)).not.toContainEqual({ path: store, kind: 'dir' });
    const broker = new RegistryMcpHostBroker(home, vi.fn() as typeof fetch, async () => true);
    await broker.start();
    try {
      // The sandbox plan stats a real directory now, so the tmpfs mask is in
      // force for the very session that goes on to run the first connect.
      expect(credentialMaskPaths(undefined, home)).toContainEqual({ path: store, kind: 'dir' });
    } finally {
      await broker.stop();
    }
  });

  it('refuses a broker call when no authorizer is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    mkdirSync(join(home, '.beeline', 'registry-mcp'), { recursive: true });
    writeFileSync(
      registryMcpStatePath(CONNECTOR, home),
      JSON.stringify({
        status: 'connected',
        connectorId: CONNECTOR,
        serverName: 'app.linear/linear',
        version: '1.0.1',
        remoteUrl: 'https://mcp.linear.app/mcp',
        accessToken: 'linear-access-secret',
      }),
    );
    let providerCalls = 0;
    const broker = new RegistryMcpHostBroker(
      home,
      vi.fn(async () => {
        providerCalls += 1;
        return Response.json({});
      }) as typeof fetch,
    );
    await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN, 'connection-one')).rejects.toThrow(
      REGISTRY_MCP_APPROVAL_REFUSAL,
    );
    expect(providerCalls).toBe(0);
  });

  describe('discovery URLs that point back at this machine', () => {
    const discovery = (remoteUrl: string, metadataOrigin: string) =>
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === remoteUrl)
          return new Response('', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${metadataOrigin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        if (url.includes('oauth-protected-resource'))
          return Response.json({ authorization_servers: [metadataOrigin] });
        if (url === `${metadataOrigin}/.well-known/oauth-authorization-server`)
          return Response.json({
            authorization_endpoint: `${metadataOrigin}/authorize`,
            token_endpoint: `${metadataOrigin}/token`,
            registration_endpoint: `${metadataOrigin}/register`,
            code_challenge_methods_supported: ['S256'],
          });
        if (url === `${metadataOrigin}/register`)
          return Response.json({ client_id: 'dynamic-client' });
        throw new Error(`unexpected ${url}`);
      }) as typeof fetch;

    const api = {
      execute: vi.fn(async (name: string) => {
        if (name === 'beginRegistryMcpOAuth')
          return { state: 'opaque', redirectUri: 'https://beeline.example/callback' };
        throw new Error(`unexpected ${name}`);
      }),
    };

    const run = async (remoteUrl: string, metadataOrigin: string, addresses: readonly string[]) => {
      const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
      homes.push(home);
      return installRegistryMcp({
        api,
        agentId: 'b'.repeat(64),
        assignment: {
          ...assignment,
          registryManifest: {
            ...assignment.registryManifest!,
            remotes: [{ type: 'streamable-http', url: remoteUrl }],
          },
        },
        home,
        transport: discovery(remoteUrl, metadataOrigin),
        resolveHost: async (hostname) =>
          hostname === new URL(remoteUrl).hostname ? ['93.184.216.34'] : addresses,
      });
    };

    it('refuses a remote server whose login resolves onto this host', async () => {
      await expect(
        run('https://mcp.linear.app/mcp', 'https://login.evil.test', ['127.0.0.1']),
      ).resolves.toMatchObject({ status: 'error', errorMessage: OWN_MACHINE_REFUSAL });
    });

    it('keeps a LAN address reachable', async () => {
      await expect(
        run('https://mcp.linear.app/mcp', 'https://login.lan.test', ['10.1.2.3']),
      ).resolves.toMatchObject({ status: 'installing' });
    });

    it('keeps a tailnet address reachable', async () => {
      await expect(
        run('https://mcp.linear.app/mcp', 'https://login.tailnet.test', ['100.64.1.2']),
      ).resolves.toMatchObject({ status: 'installing' });
    });

    it('lets a connector that IS on this host keep using loopback', async () => {
      await expect(
        run('http://127.0.0.1:9000/mcp', 'http://127.0.0.1:9000', ['127.0.0.1']),
      ).resolves.toMatchObject({ status: 'installing' });
    });

    it('refuses a discovery redirect onto this machine', async () => {
      const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
      homes.push(home);
      const remoteUrl = 'https://mcp.linear.app/mcp';
      const metadataOrigin = 'https://login.evil.test';
      const transport = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === remoteUrl)
          return new Response('', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="${metadataOrigin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        if (url.includes('oauth-protected-resource'))
          return Response.json({ authorization_servers: [metadataOrigin] });
        if (url === `${metadataOrigin}/.well-known/oauth-authorization-server`)
          return new Response('', {
            status: 302,
            headers: { location: 'http://127.0.0.1:9/.well-known/oauth-authorization-server' },
          });
        throw new Error(`unexpected ${url}`);
      }) as typeof fetch;
      await expect(
        installRegistryMcp({
          api,
          agentId: 'b'.repeat(64),
          assignment: {
            ...assignment,
            registryManifest: {
              ...assignment.registryManifest!,
              remotes: [{ type: 'streamable-http', url: remoteUrl }],
            },
          },
          home,
          transport,
          resolveHost: async () => ['93.184.216.34'],
        }),
      ).resolves.toMatchObject({ status: 'error', errorMessage: OWN_MACHINE_REFUSAL });
    });
  });

  it('ends an expired attempt and only mints a fresh page on a later retry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    let claimStatus: 'pending' | 'expired' = 'pending';
    const states = ['first-state', 'second-state'];
    const api = {
      execute: vi.fn(async (name: string) => {
        if (name === 'beginRegistryMcpOAuth')
          return {
            state: states.shift() ?? 'exhausted',
            redirectUri: 'https://beeline.example/callback',
            expiresAt: 5_000,
          };
        if (name === 'claimRegistryMcpOAuthCode')
          return claimStatus === 'pending'
            ? { status: 'pending', expiresAt: 5_000 }
            : { status: claimStatus };
        throw new Error(`unexpected ${name}`);
      }),
    };
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://mcp.linear.app/mcp')
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"',
          },
        });
      if (url.includes('oauth-protected-resource'))
        return Response.json({ authorization_servers: ['https://mcp.linear.app'] });
      if (url === 'https://mcp.linear.app/.well-known/oauth-authorization-server')
        return Response.json({
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          code_challenge_methods_supported: ['S256'],
        });
      if (url === 'https://mcp.linear.app/register')
        return Response.json({ client_id: 'dynamic-client' });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const input = {
      api,
      agentId: 'b'.repeat(64),
      assignment,
      home,
      transport,
      resolveHost: async () => ['93.184.216.34'],
    };
    const first = await installRegistryMcp(input);
    if (first.status !== 'installing') throw new Error('expected OAuth sign-in');
    expect(new URL(first.authorizationUrl).searchParams.get('state')).toBe('first-state');
    // The helper's ceremony ceiling is the SERVER's attempt clock, verbatim.
    expect(first.attemptExpiresAt).toBe(5_000);

    const waiting = await installRegistryMcp(input);
    expect(waiting).toMatchObject({
      status: 'installing',
      attemptId: first.attemptId,
      attemptExpiresAt: 5_000,
    });

    claimStatus = 'expired';
    const expired = await installRegistryMcp(input);
    expect(expired).toMatchObject({ status: 'error', errorMessage: CEREMONY_EXPIRED });
    expect(
      api.execute.mock.calls.filter(([name]) => name === 'beginRegistryMcpOAuth'),
    ).toHaveLength(1);

    const reissued = await installRegistryMcp(input);
    if (reissued.status !== 'installing') throw new Error('expected a fresh OAuth sign-in');
    expect(new URL(reissued.authorizationUrl).searchParams.get('state')).toBe('second-state');
    expect(reissued.attemptId).not.toBe(first.attemptId);
  });

  it('fails closed when the remote does not advertise standard dynamic registration', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-mcp-'));
    homes.push(home);
    const transport = vi.fn(async () => new Response('', { status: 401 })) as typeof fetch;
    const result = await installRegistryMcp({
      api: { execute: vi.fn() },
      agentId: 'b'.repeat(64),
      assignment,
      home,
      transport,
    });
    expect(result).toMatchObject({
      status: 'error',
      errorMessage:
        'This remote does not support standard dynamic-registration OAuth with S256 PKCE',
    });
  });
});
