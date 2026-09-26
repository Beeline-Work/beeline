import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorAssignment } from '@beeline/api-contract/daemon';
import {
  installRegistryMcp,
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

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

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
      home,
      join(home, '.beeline', 'registry-mcp-broker', 'test.sock'),
    );
    expect(declarations.registry_mcp_linear).toMatchObject({
      beeline_route: 'host',
      beeline_resource_target: 'registry-mcp:app.linear/linear',
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
    const broker = new RegistryMcpHostBroker(
      home,
      vi.fn(async (_input, init) => {
        providerAuthorization = new Headers(init?.headers).get('authorization');
        return Response.json({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
      }) as typeof fetch,
    );
    await expect(
      broker.request(
        CONNECTOR,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/list',
          params: {},
        }),
      ),
    ).resolves.toEqual([JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } })]);
    expect(providerAuthorization).toBe('Bearer linear-access-secret');

    await broker.start();
    try {
      const socketResult = await new Promise<{ messages: string[] }>((resolve, reject) => {
        const socket = createConnection(broker.socketPath);
        let output = '';
        socket.setEncoding('utf8');
        socket.on('connect', () =>
          socket.end(
            JSON.stringify({
              connectorId: CONNECTOR,
              line: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }),
            }),
          ),
        );
        socket.on('data', (chunk) => {
          output += chunk;
        });
        socket.on('error', reject);
        socket.on('close', () => resolve(JSON.parse(output) as { messages: string[] }));
      });
      expect(socketResult.messages).toEqual([
        JSON.stringify({ jsonrpc: '2.0', id: 7, result: { tools: [] } }),
      ]);
    } finally {
      await broker.stop();
    }
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
