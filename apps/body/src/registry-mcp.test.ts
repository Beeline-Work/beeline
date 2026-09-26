import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorAssignment } from '@beeline/api-contract/daemon';
import {
  installRegistryMcp,
  OWN_MACHINE_REFUSAL,
  REGISTRY_MCP_APPROVAL_REFUSAL,
  RegistryMcpHostBroker,
  registryMcpHostBindPaths,
  registryMcpHostDeclarations,
  registryMcpStatePath,
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
    await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN)).resolves.toEqual([
      JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } }),
    ]);
    expect(asked).toEqual([
      { target: 'registry-mcp:app.linear/linear', consume: false, roomId: 'room-1' },
    ]);
    expect(providerAuthorization).toBe('Bearer linear-access-secret');

    // A third-party requester with no standing grant is held for the owner.
    allowed = false;
    providerCalls = 0;
    await expect(broker.request(CONNECTOR, TOOLS_CALL, TURN)).rejects.toThrow(
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
        socketCall(broker.socketPath, { connectorId: CONNECTOR, line: TOOLS_CALL }),
      ).resolves.toEqual({ error: REGISTRY_MCP_APPROVAL_REFUSAL });
      expect(providerCalls).toBe(0);
      await expect(
        socketCall(broker.socketPath, { connectorId: CONNECTOR, line: TOOLS_LIST, turn: TURN }),
      ).resolves.toEqual({
        messages: [JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } })],
      });
      expect(providerCalls).toBe(1);
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
    await expect(broker.request(CONNECTOR, TOOLS_LIST, TURN)).rejects.toThrow(
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
  });

  it('mints a fresh authorization request once its attempt has expired', async () => {
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
          };
        if (name === 'claimRegistryMcpOAuthCode') return { status: claimStatus };
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

    const waiting = await installRegistryMcp(input);
    expect(waiting).toMatchObject({ status: 'installing', attemptId: first.attemptId });

    claimStatus = 'expired';
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
