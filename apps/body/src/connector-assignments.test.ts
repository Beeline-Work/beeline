import { describe, expect, it, vi } from 'vitest';
import type { ConnectorAssignment } from '@beeline/api-contract/daemon';
import { ConnectorAssignmentLoop } from './connector-assignments.js';
import type {
  InstallSquireOptions,
  InstallSquireResult,
  SquireMcpClient,
  VaultConnectionMeta,
} from './connector-squire.js';

type ExecuteCall = { op: string; input: Record<string, unknown> };

function apiMock(assignments: readonly ConnectorAssignment[]) {
  const calls: ExecuteCall[] = [];
  return {
    calls,
    async execute(op: string, input: Record<string, unknown>) {
      calls.push({ op, input });
      if (op === 'getConnectorAssignments') return { assignments };
      return {};
    },
  };
}

const mcp = {} as SquireMcpClient;

/** The loop fires assignments without awaiting them; drain their microtasks. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const connectedInstall =
  (): ((options: InstallSquireOptions) => Promise<InstallSquireResult>) =>
  async (options) => {
    const steps = [
      { id: 'prereq', label: 'prerequisites', status: 'done' as const },
      { id: 'install', label: 'trusty-squire 1.4.2 installed', status: 'done' as const },
    ];
    await options.onProgress(steps);
    return {
      status: 'connected',
      steps,
      squireVersion: '1.4.2',
      signedInAs: 'dana@example.test',
      signIn: { method: 'oauth', url: 'https://squire.example/oauth' },
    };
  };

describe('ConnectorAssignmentLoop', () => {
  it('runs an install, reports steps as they settle, then the vault', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: connectedInstall(),
      readVault: async () => [
        { ref: 'cred_a', kind: 'vercel', label: 'Vercel', createdAt: 'now' } as VaultConnectionMeta,
      ],
    });
    await loop.runOnce();
    await settle();
    const ops = api.calls.map((call) => call.op);
    expect(ops).toEqual([
      'getConnectorAssignments',
      'postConnectorStatus', // the onProgress step report
      'installConnector',
      'postConnectorVault',
    ]);
    expect(api.calls[1].input).toMatchObject({
      agentId: 'agent-1',
      connectorId: 'conn-1',
      steps: [
        { id: 'prereq', status: 'done' },
        { id: 'install', status: 'done' },
      ],
    });
    expect(api.calls[2].input).toMatchObject({
      connectorId: 'conn-1',
      squireVersion: '1.4.2',
      signedInAs: 'dana@example.test',
    });
    expect(api.calls[3].input).toMatchObject({
      agentId: 'agent-1',
      connections: [{ ref: 'cred_a' }],
    });
  });

  it('reports a failed install with its error and never calls installConnector', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => ({
        status: 'error',
        steps: [{ id: 'install', label: 'install', status: 'failed', reason: 'npx failed' }],
        errorMessage: 'npx failed',
      }),
    });
    await loop.runOnce();
    await settle();
    expect(api.calls.map((call) => call.op)).toEqual(['getConnectorAssignments', 'postConnectorStatus']);
    expect(api.calls[1].input).toMatchObject({ errorMessage: 'npx failed' });
  });

  it('reports the still-signing-in state through postConnectorStatus only', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => ({
        status: 'installing',
        steps: [{ id: 'signin', label: 'waiting for sign-in', status: 'running' }],
        signIn: { method: 'streamed-page', url: 'https://squire.example/vnc' },
      }),
    });
    await loop.runOnce();
    await settle();
    expect(api.calls.map((call) => call.op)).toEqual(['getConnectorAssignments', 'postConnectorStatus']);
    expect(api.calls[1].input).toMatchObject({
      signIn: { method: 'streamed-page', url: 'https://squire.example/vnc' },
    });
  });

  it('runs sync and revoke-grants assignments without touching the install routine', async () => {
    const api = apiMock([
      { kind: 'sync', connectorId: 'conn-1' },
      { kind: 'revoke-grants', connectorId: 'conn-1', reference: 'cred_a' },
    ]);
    let installs = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        installs += 1;
        throw new Error('must not install');
      },
      readVault: async () => [],
      revokeGrants: async () => ({ revoked: 2, failed: 0 }),
    });
    await loop.runOnce();
    await settle();
    expect(installs).toBe(0);
    expect(api.calls.map((call) => call.op)).toEqual([
      'getConnectorAssignments',
      'postConnectorVault',
    ]);
  });

  it('ignores uninstall assignments (the server reaps those rows itself)', async () => {
    const api = apiMock([{ kind: 'uninstall', connectorId: 'conn-1' }]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
    });
    await loop.runOnce();
    await settle();
    expect(api.calls.map((call) => call.op)).toEqual(['getConnectorAssignments']);
  });

  it('never starts the same connector twice while an install is in flight', async () => {
    const api = apiMock([
      { kind: 'install', connectorId: 'conn-1' },
      { kind: 'install', connectorId: 'conn-1' },
    ]);
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        started += 1;
        await gate;
        return { status: 'installing', steps: [] };
      },
    });
    await loop.runOnce();
    await loop.runOnce(); // second poll while the first install is parked
    release();
    await settle();
    expect(started).toBe(1);
    loop.stop();
  });

  it('routes Google tool connectors through the Google installer without vault reporting', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'conn-g', connectorType: 'google-gmail' }]);
    const googleCalls: string[] = [];
    const squireCalls: string[] = [];
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        squireCalls.push('install');
        return { status: 'connected', steps: [] };
      },
      installGoogle: async (connectorType) => {
        googleCalls.push(connectorType);
        return {
          status: 'connected',
          steps: [{ label: 'helper reached', status: 'done' }],
          signedInAs: 'dana@gmail.test',
        };
      },
      googleHome: '/tmp/google-home',
      readVault: async () => {
        squireCalls.push('vault');
        return [];
      },
    });
    await loop.runOnce();
    await settle();
    expect(googleCalls).toEqual(['google-gmail']);
    // No Squire install and no vault report for a Google connector.
    expect(squireCalls).toEqual([]);
    const install = api.calls.find((call) => call.op === 'installConnector')!;
    expect(install.input.connectorId).toBe('conn-g');
    expect(install.input.signedInAs).toBe('dana@gmail.test');
    expect(api.calls.some((call) => call.op === 'postConnectorVault')).toBe(false);
    loop.stop();
  });

  it('runs Google tool installs as ONE sequential batch sharing ONE grant resolution', async () => {
    const api = apiMock([
      { kind: 'install', connectorId: 'g1', connectorType: 'google-gmail' },
      { kind: 'install', connectorId: 'g2', connectorType: 'google-calendar' },
    ]);
    const events: string[] = [];
    const sharedFactories: (() => Promise<unknown>)[] = [];
    const resolveSpy = vi.fn(() =>
      Promise.resolve({ source: 'manual', credentials: { accessToken: 't' } }),
    );
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      installGoogle: async (connectorType, _onProgress, shared) => {
        if (shared) sharedFactories.push(shared);
        events.push(`start:${connectorType}`);
        if (shared) await shared();
        events.push(`end:${connectorType}`);
        return { status: 'connected', steps: [], signedInAs: 'dana@gmail.test' };
      },
      googleHome: '/tmp/google-home',
    });
    (
      loop as unknown as { resolveGoogleCredentials: () => Promise<unknown> }
    ).resolveGoogleCredentials = resolveSpy;
    await loop.runOnce();
    await settle();
    // Sequential: the second tool starts only after the first finished.
    expect(events).toEqual([
      'start:google-gmail',
      'end:google-gmail',
      'start:google-calendar',
      'end:google-calendar',
    ]);
    // ONE grant resolution: every tool of the drain rode the same promise.
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(sharedFactories).toHaveLength(2);
    expect(sharedFactories[0]()).toBe(sharedFactories[1]());
    loop.stop();
  });

  it('reports a failed Google tool install and continues with its siblings', async () => {
    const api = apiMock([
      { kind: 'install', connectorId: 'g1', connectorType: 'google-gmail' },
      { kind: 'install', connectorId: 'g2', connectorType: 'google-drive' },
    ]);
    const installed: string[] = [];
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      installGoogle: async (connectorType) => {
        if (connectorType === 'google-gmail') {
          return {
            status: 'error' as const,
            steps: [{ label: 'authorized with Google', status: 'failed' as const, reason: 'scope refused' }],
            errorMessage: 'scope refused',
          };
        }
        installed.push(connectorType);
        return { status: 'connected' as const, steps: [], signedInAs: 'dana@gmail.test' };
      },
      googleHome: '/tmp/google-home',
    });
    await loop.runOnce();
    await settle();
    expect(installed).toEqual(['google-drive']);
    expect(
      api.calls.some(
        (call) => call.op === 'installConnector' && call.input.connectorId === 'g2',
      ),
    ).toBe(true);
    expect(
      api.calls.some(
        (call) =>
          call.op === 'postConnectorStatus' &&
          call.input.connectorId === 'g1' &&
          call.input.errorMessage === 'scope refused',
      ),
    ).toBe(true);
    loop.stop();
  });

  it('runs Google installs only after this drain’s Squire work settles', async () => {
    let releaseSquire!: () => void;
    const squireGate = new Promise<void>((resolve) => {
      releaseSquire = resolve;
    });
    const events: string[] = [];
    const api = apiMock([
      { kind: 'install', connectorId: 'conn-s', connectorType: 'trusty-squire' },
      { kind: 'install', connectorId: 'g1', connectorType: 'google-gmail' },
    ]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        events.push('squire-start');
        await squireGate;
        events.push('squire-end');
        return { status: 'connected', steps: [] };
      },
      installGoogle: async () => {
        events.push('google-start');
        return { status: 'connected', steps: [], signedInAs: 'dana@gmail.test' };
      },
      googleHome: '/tmp/google-home',
      readVault: async () => [],
    });
    void loop.runOnce();
    await settle();
    expect(events).toEqual(['squire-start']);
    releaseSquire();
    for (let index = 0; index < 50 && !events.includes('google-start'); index += 1) {
      await settle();
    }
    expect(events).toEqual(['squire-start', 'squire-end', 'google-start']);
    loop.stop();
  });

  it('survives a failed assignments read and re-arms its next poll', async () => {
    const calls: ExecuteCall[] = [];
    let fail = true;
    const api = {
      async execute(op: string, input: Record<string, unknown>) {
        calls.push({ op, input });
        if (fail) throw new Error('server unreachable');
        return { assignments: [] };
      },
    };
    let scheduled = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      schedule: (fn) => {
        scheduled += 1;
        return fn;
      },
      cancel: () => {},
    });
    await loop.runOnce(); // throws inside runOnce must be swallowed
    loop.stop();
    expect(scheduled).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
