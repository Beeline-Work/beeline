import { describe, expect, it } from 'vitest';
import {
  checkRemoteLoginPrerequisites,
  connectionGrant,
  connectionLedgerEntry,
  installSquire,
  missingPrerequisiteStep,
  parseConnectOutput,
  readConnectionDetail,
  readConnectionLedger,
  readGrants,
  readVault,
  revokeGrants,
  vaultConnectionMeta,
  type SquireMcpClient,
} from './connector-squire.js';
import type { LoginPrerequisiteCheck } from '@beeline/api-contract/daemon';

/** A scripted mock of the Squire MCP: no real Squire, ever. */
function mockSquire(handlers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: { tool: string; args?: Record<string, unknown> }[] = [];
  const client: SquireMcpClient = {
    async call(tool, args) {
      calls.push({ tool, args });
      const handler = handlers[tool];
      if (!handler) throw new Error(`unknown tool: ${tool}`);
      return handler(args);
    },
  };
  return { client, calls };
}

/** A probe that finds every prerequisite: the hermetic default for install tests. */
const allPrerequisitesFound = async (binary: string) => ({
  binary,
  found: true,
  path: `/usr/bin/${binary}`,
});

const okRunner = () => async () => ({ code: 0, stdout: '', stderr: '' });

describe('parseConnectOutput', () => {
  it('reports a streamed noVNC page when Squire prints one', () => {
    const signIn = parseConnectOutput(
      'Remote sign-in ready: https://tunnel.example/vnc.html#p=hunter2\nOpen it in a browser.',
    );
    expect(signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.example/vnc.html#p=hunter2',
    });
  });

  it('reports an OAuth URL when Squire prints one', () => {
    const signIn = parseConnectOutput(
      'Sign in: https://squire.example/oauth/authorize?state=abc (oauth)',
    );
    expect(signIn).toEqual({ method: 'oauth', url: 'https://squire.example/oauth/authorize?state=abc' });
  });

  it('is undefined when connect printed no URL', () => {
    expect(parseConnectOutput('nothing useful here')).toBeUndefined();
  });
});

describe('remote-login prerequisites', () => {
  it('checks the four headless binaries', async () => {
    const seen: string[] = [];
    const checks = await checkRemoteLoginPrerequisites(async (binary) => {
      seen.push(binary);
      return { binary, found: true, path: `/usr/bin/${binary}` };
    });
    expect(seen).toEqual(['Xvfb', 'x11vnc', 'websockify', 'cloudflared']);
    expect(checks.every((check) => check.found)).toBe(true);
  });

  it('names the missing binaries in the failed step', () => {
    const checks: LoginPrerequisiteCheck[] = [
      { binary: 'Xvfb', found: true, path: '/usr/bin/Xvfb' },
      { binary: 'x11vnc', found: false },
      { binary: 'websockify', found: false },
      { binary: 'cloudflared', found: true, path: '/usr/bin/cloudflared' },
    ];
    const step = missingPrerequisiteStep(checks);
    expect(step.status).toBe('failed');
    expect(step.reason).toContain('x11vnc, websockify');
  });
});

describe('installSquire', () => {
  it('reports every step and the sign-in method the connect command printed', async () => {
    const { client, calls } = mockSquire({
      list_credentials: () => ({ credentials: [] }),
    });
    const result = await installSquire({
      workspaceId: 'ws-1',
      probeBinary: allPrerequisitesFound,
      run: async () => ({
        code: 0,
        stdout: 'noVNC sign-in: https://tunnel.example/vnc.html#p=secret\n',
        stderr: '',
      }),
      mcp: client,
    });
    expect(result.status).toBe('connected');
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://tunnel.example/vnc.html#p=secret',
    });
    expect(result.steps.map((step) => step.label)).toEqual([
      'helper reached',
      'remote sign-in prerequisites',
      'trusty-squire installed',
      'waiting for sign-in',
      'paired to workspace',
    ]);
    expect(result.steps.every((step) => step.status === 'done')).toBe(true);
    expect(calls[0]).toEqual({
      tool: 'list_credentials',
      args: { fields: 'summary' },
    });
  });

  it('runs connect non-interactively with the skip-browser flag, then probes the version', async () => {
    const invocations: string[][] = [];
    await installSquire({
      workspaceId: 'ws-1',
      probeBinary: allPrerequisitesFound,
      run: async (_command, args) => {
        invocations.push([...args]);
        return {
          code: 0,
          stdout: 'https://squire.example/oauth/authorize?x=1',
          stderr: '',
        };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(invocations).toEqual([
      ['-y', '@trusty-squire/mcp', 'connect', '--target=pi', '--skip-browser'],
      ['-y', '@trusty-squire/mcp', '--version'],
    ]);
  });

  it('produces a named failed step when a prerequisite is missing', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      probeBinary: async (binary) => ({ binary, found: binary !== 'websockify' }),
      run: okRunner(),
    });
    expect(result.status).toBe('error');
    const failed = result.steps.find((step) => step.status === 'failed');
    expect(failed?.reason).toContain('websockify');
    expect(result.errorMessage).toContain('remote sign-in surface');
  });

  it('fails with a clear reason when the connect command fails', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      probeBinary: allPrerequisitesFound,
      run: async () => ({ code: 1, stdout: '', stderr: 'npm 404' }),
    });
    expect(result.status).toBe('error');
    expect(result.steps.find((step) => step.label === 'trusty-squire installed')?.reason).toContain(
      'npm 404',
    );
  });

  it('fails the sign-in step when connect prints no URL', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      probeBinary: allPrerequisitesFound,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    expect(result.status).toBe('error');
    expect(
      result.steps.find((step) => step.label === 'waiting for sign-in')?.reason,
    ).toContain('no sign-in URL');
  });

  it('stays installing when the pairing probe cannot reach the vault', async () => {
    const failing: SquireMcpClient = {
      async call() {
        throw new Error('squire unreachable');
      },
    };
    const result = await installSquire({
      workspaceId: 'ws-1',
      probeBinary: allPrerequisitesFound,
      run: async () => ({ code: 0, stdout: 'https://tunnel.example/vnc.html#p=x', stderr: '' }),
      mcp: failing,
    });
    expect(result.status).toBe('installing');
    expect(result.signIn).toBeDefined();
    expect(
      result.steps.find((step) => step.label === 'paired to workspace')?.reason,
    ).toContain('squire unreachable');
  });
});

describe('vault reads through the Squire MCP', () => {
  it('shapes vault metadata without secret values', async () => {
    const { client, calls } = mockSquire({
      list_credentials: () => ({
        credentials: [
          {
            reference: 'cred_1',
            service: 'openai',
            label: 'Work key',
            field_names: ['api_key'],
            allowed_hosts: ['api.openai.com'],
            created_at: 1700000000,
            stale: false,
            state: 'active',
          },
        ],
      }),
    });
    const vault = await readVault(client);
    expect(vault[0]).toMatchObject({ reference: 'cred_1', service: 'openai', label: 'Work key' });
    expect(JSON.stringify(vault)).not.toContain('api_key_value');
    expect(calls[0]?.tool).toBe('list_credentials');
  });

  it('reads the ledger view for one connection', async () => {
    const { client, calls } = mockSquire({
      audit_log: () => ({
        entries: [
          {
            id: 'e1',
            timestamp: 1700000100,
            action: 'credential_used',
            status: 200,
            bytes: 512,
            anomaly: false,
          },
          { id: 'e2', timestamp: 1700000200, action: 'rate_limited', anomaly: true, anomaly_reason: '429' },
        ],
      }),
    });
    const ledger = await readConnectionLedger(client, 'cred_1');
    expect(calls[0]).toEqual({ tool: 'audit_log', args: { reference: 'cred_1', view: 'ledger' } });
    expect(ledger).toHaveLength(2);
    expect(ledger[1]?.anomaly).toBe(true);
    expect(ledger[1]?.anomalyReason).toBe('429');
  });

  it('revokes every live grant on one connection and counts failures', async () => {
    const { client, calls } = mockSquire({
      list_app_access: () => ({
        grants: [
          { grant_id: 'g1', credential_ref: 'cred_1', created_at: 1 },
          { grant_id: 'g2', credential_ref: 'cred_1', created_at: 2 },
          { grant_id: 'g3', credential_ref: 'cred_other', created_at: 3 },
          { grant_id: 'g4', credential_ref: 'cred_1', created_at: 4, revoked_at: 9 },
        ],
      }),
      revoke_app_access: (args) => (args?.grant_id === 'g2' ? { revoked: false } : { revoked: true }),
    });
    const result = await revokeGrants(client, 'cred_1');
    expect(result).toEqual({ revoked: 1, failed: 1 });
    const revokeCalls = calls.filter((call) => call.tool === 'revoke_app_access');
    expect(revokeCalls.map((call) => call.args?.grant_id).sort()).toEqual(['g1', 'g2']);
  });

  it('builds grant and ledger shapes directly', () => {
    expect(connectionGrant({ grant_id: 'g1', credential_ref: 'c', rate_limit_per_hour: 10 }))
      .toMatchObject({ grantId: 'g1', rateLimitPerHour: 10 });
    expect(connectionLedgerEntry({ event_id: 'x', kind: 'grant_revoked' })).toMatchObject({
      id: 'x',
      action: 'grant_revoked',
    });
  });

  it('assembles one connection detail with metadata, grants and ledger', async () => {
    const { client } = mockSquire({
      list_credentials: () => ({
        credentials: [{ reference: 'cred_1', service: 'openai', label: 'Work key' }],
      }),
      list_app_access: () => ({ grants: [{ grant_id: 'g1', credential_ref: 'cred_1' }] }),
      audit_log: () => ({ entries: [{ id: 'e1', action: 'credential_used' }] }),
    });
    const detail = await readConnectionDetail(client, 'cred_1');
    expect('error' in detail).toBe(false);
    if (!('error' in detail)) {
      expect(detail.metadata.reference).toBe('cred_1');
      expect(detail.grants).toHaveLength(1);
      expect(detail.ledger).toHaveLength(1);
    }
  });

  it('names an unknown connection instead of guessing', async () => {
    const { client } = mockSquire({ list_credentials: () => ({ credentials: [] }) });
    const detail = await readConnectionDetail(client, 'cred_missing');
    expect('error' in detail && detail.error).toContain('cred_missing');
  });

  it('vault metadata tolerates stale and error states', () => {
    expect(vaultConnectionMeta({ reference: 'c', stale: true, state: 'error' })).toMatchObject({
      stale: true,
      state: 'error',
    });
    expect(readGrants).toBeTypeOf('function');
  });
});
