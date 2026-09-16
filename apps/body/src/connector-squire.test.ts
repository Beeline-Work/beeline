import { describe, expect, it } from 'vitest';
import {
  connectionGrant,
  connectionLedgerEntry,
  installSquire,
  parseConnectOutput,
  readConnectionDetail,
  readConnectionLedger,
  readGrants,
  readVault,
  revokeGrants,
  vaultConnectionMeta,
  type StreamedShellRunner,
  type SquireMcpClient,
} from './connector-squire.js';

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

const okRunner = () => async () => ({ code: 0, stdout: '', stderr: '' });

/** A fake streaming runner that resolves immediately with a given result. */
function fakeStreamRunner(result: {
  stdout?: string;
  stderr?: string;
  signIn?: { method: 'streamed-page' | 'oauth'; url: string };
}): StreamedShellRunner {
  return async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signIn: result.signIn,
    abort: () => {},
  });
}

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

  it('reports the hosted --skip-browser install page as a streamed page', () => {
    const signIn = parseConnectOutput(
      'Open this in your browser to finish: https://trustysquire.ai/install?token=q2XtG7fnTfe7wKqmXeQUojqvHNwnpta3vv5p\n',
    );
    expect(signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=q2XtG7fnTfe7wKqmXeQUojqvHNwnpta3vv5p',
    });
  });
});

describe('installSquire', () => {
  it('reports every step and the sign-in method the connect command printed', async () => {
    const { client, calls } = mockSquire({
      list_credentials: () => ({ credentials: [] }),
    });
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stdout: 'Open this in your browser: https://trustysquire.ai/install?token=secret\n',
        signIn: { method: 'streamed-page', url: 'https://trustysquire.ai/install?token=secret' },
      }),
      mcp: client,
    });
    expect(result.status).toBe('connected');
    expect(result.signIn).toEqual({
      method: 'streamed-page',
      url: 'https://trustysquire.ai/install?token=secret',
    });
    expect(result.steps.map((step) => step.label)).toEqual([
      'helper reached',
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

  it('runs connect --force-relogin=google --target=codex --skip-browser via streaming runner, then probes the version', async () => {
    const streamInvocations: string[][] = [];
    const runInvocations: string[][] = [];
    await installSquire({
      workspaceId: 'ws-1',
      streamRun: async (cmd, args) => {
        streamInvocations.push([cmd, ...args]);
        return {
          stdout: 'https://squire.example/oauth/authorize?x=1',
          stderr: '',
          signIn: { method: 'oauth', url: 'https://squire.example/oauth/authorize?x=1' },
          abort: () => {},
        };
      },
      run: async (_cmd, args) => {
        runInvocations.push([...args]);
        return { code: 0, stdout: '1.1.13', stderr: '' };
      },
      mcp: mockSquire({ list_credentials: () => ({}) }).client,
    });
    expect(streamInvocations).toEqual([
      ['npx', '-y', '@trusty-squire/mcp', 'connect', '--force-relogin=google', '--target=codex', '--skip-browser'],
    ]);
    expect(runInvocations).toEqual([
      ['-y', '@trusty-squire/mcp', '--version'],
    ]);
  });

  it('fails with a clear reason when the streamed connect command errors with no URL', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stderr: 'some connect error',
        signIn: undefined,
      }),
    });
    expect(result.status).toBe('error');
    expect(result.steps.find((step) => step.label === 'trusty-squire installed')?.reason).toContain(
      'some connect error',
    );
  });

  it('fails the sign-in step when streamed connect prints no URL', async () => {
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({ signIn: undefined }),
    });
    expect(result.status).toBe('error');
    expect(
      result.steps.find((step) => step.label === 'trusty-squire installed')?.reason,
    ).toContain('no sign-in URL');
  });

  it('surfaces the signIn URL on the installing result before the pairing probe', async () => {
    const failing: SquireMcpClient = {
      async call() {
        throw new Error('squire unreachable');
      },
    };
    const result = await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: fakeStreamRunner({
        stdout: 'https://tunnel.example/vnc.html#p=x\n',
        signIn: { method: 'streamed-page', url: 'https://tunnel.example/vnc.html#p=x' },
      }),
      mcp: failing,
    });
    expect(result.status).toBe('installing');
    expect(result.signIn).toBeDefined();
    expect(result.signIn!.url).toBe('https://tunnel.example/vnc.html#p=x');
    expect(result.signIn!.method).toBe('streamed-page');
    expect(
      result.steps.find((step) => step.label === 'paired to workspace')?.reason,
    ).toContain('squire unreachable');
  });

  it('emits the waiting-for-sign-in step via onProgress before the connect process would exit', async () => {
    const progressSteps: string[][] = [];
    let capturedSignIn: { method: string; url: string } | undefined;
    const { client } = mockSquire({
      list_credentials: () => ({ credentials: [] }),
    });
    await installSquire({
      workspaceId: 'ws-1',
      run: okRunner(),
      streamRun: async () => ({
        stdout: 'https://vnc.trustysquire.ai/#p=secret\n',
        stderr: '',
        signIn: { method: 'streamed-page', url: 'https://vnc.trustysquire.ai/#p=secret' },
        abort: () => {},
      }),
      onProgress(steps) {
        progressSteps.push(steps.map((s) => s.label));
        const last = steps[steps.length - 1];
        if (last?.label === 'waiting for sign-in' && last.status === 'done') {
          capturedSignIn = { method: 'streamed-page', url: 'https://vnc.trustysquire.ai/#p=secret' };
        }
      },
      mcp: client,
    });
    // The waiting-for-sign-in step must appear before the final connected result.
    expect(capturedSignIn).toBeDefined();
    // The progress must have emitted the sign-in step label.
    expect(
      progressSteps.some((labels) => labels.includes('waiting for sign-in')),
    ).toBe(true);
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
