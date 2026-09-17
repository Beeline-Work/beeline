import { describe, expect, it } from 'vitest';
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
