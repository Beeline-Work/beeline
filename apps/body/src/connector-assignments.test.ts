import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorAssignment } from '@beeline/api-contract/daemon';
import { CEREMONY_EXPIRED, ConnectorAssignmentLoop } from './connector-assignments.js';
import {
  CONNECT_TIMEOUT_MS,
  defaultStreamedRunner,
  isProcessAlive,
  releaseSquireConnectSession,
  squireConnectSession,
  type InstallSquireOptions,
  type InstallSquireResult,
  type SquireMcpClient,
  type VaultConnectionMeta,
} from './connector-squire.js';

/**
 * A live stand-in for the connect process: it prints one `--json` report and
 * stays alive, exactly as Squire does while a human signs in.
 */
function spawnReportedConnect() {
  const line = JSON.stringify({
    state: 'needs-sign-in',
    terminal: false,
    reason: null,
    sign_in_url: 'https://tunnel.test/#p=hunter22',
    account: null,
    holder: { kind: 'none' },
    browser_location: { kind: 'virtual', url: 'https://tunnel.test/#p=hunter22' },
  });
  return defaultStreamedRunner(process.execPath, [
    '-e',
    `process.stdout.write(${JSON.stringify(`${line}\n`)}); setInterval(() => {}, 30_000);`,
  ]);
}

type ExecuteCall = { op: string; input: Record<string, unknown> };

function apiMock(
  assignments: readonly ConnectorAssignment[],
  status: {
    connectorId: string;
    steps: { label: string; status: string }[];
    signIn?: { method: string; url: string };
  } = { connectorId: '', steps: [] },
) {
  const calls: ExecuteCall[] = [];
  return {
    calls,
    status,
    async execute(op: string, input: Record<string, unknown>) {
      calls.push({ op, input });
      if (op === 'getConnectorAssignments') return { assignments };
      if (op === 'getConnectorStatus') return status;
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
    };
  };

describe('ConnectorAssignmentLoop', () => {
  it('routes a Tailscale assignment through its own sign-in ceremony', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'tail-1', connectorType: 'tailscale' }]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      install: async () => {
        throw new Error('must not run the Squire installer');
      },
      installTailscale: async ({ onProgress }) => {
        await onProgress([{ label: 'Tailnet signed in', status: 'running' }]);
        return {
          status: 'installing',
          steps: [{ label: 'Tailnet signed in', status: 'running' }],
          signIn: { method: 'oauth', url: 'https://login.tailscale.com/a/test' },
        };
      },
    });

    await loop.runOnce();
    await settle();

    expect(api.calls.filter((call) => call.op === 'postConnectorStatus')).toEqual([
      {
        op: 'postConnectorStatus',
        input: {
          agentId: 'agent-1',
          connectorId: 'tail-1',
          steps: [{ label: 'Tailnet signed in', status: 'running' }],
        },
      },
      {
        op: 'postConnectorStatus',
        input: {
          agentId: 'agent-1',
          connectorId: 'tail-1',
          steps: [{ label: 'Tailnet signed in', status: 'running' }],
          signIn: { method: 'oauth', url: 'https://login.tailscale.com/a/test' },
        },
      },
    ]);
    loop.stop();
  });

  it('drains immediately on wake without waiting for the recovery poll', async () => {
    const api = apiMock([]);
    let scheduled = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      intervalMs: 60_000,
      schedule: () => {
        scheduled += 1;
        return 1;
      },
      cancel: () => {},
    });
    loop.start();
    await settle();
    expect(api.calls.filter((call) => call.op === 'getConnectorAssignments')).toHaveLength(1);
    loop.wake();
    await settle();
    expect(api.calls.filter((call) => call.op === 'getConnectorAssignments')).toHaveLength(2);
    expect(scheduled).toBe(1);
    loop.stop();
  });

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
      'revokeConnectionGrants',
    ]);
  });

  it('leaves revoke queued when the provider drop fails', async () => {
    const api = apiMock([
      { kind: 'revoke-grants', connectorId: 'conn-1', reference: 'cred_a' },
    ]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      revokeGrants: async () => ({ revoked: 0, failed: 1 }),
    });
    await loop.runOnce();
    await settle();
    expect(api.calls.map((call) => call.op)).toEqual(['getConnectorAssignments']);
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

  it('leaves a live connect alone instead of restarting the ceremony under the human', async () => {
    // The server re-issues `install` on every poll for as long as the row is
    // `installing`, which is the whole sign-in. Starting a second connect
    // releases this helper's claim, and that SIGTERMs the process group the
    // noVNC tunnel on the phone is running in.
    const connect = await spawnReportedConnect();
    expect(connect.report?.sign_in_url).toBe('https://tunnel.test/#p=hunter22');
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    let started = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        started += 1;
        return { status: 'installing', steps: [] };
      },
    });
    await loop.runOnce();
    await settle();
    expect(started).toBe(0);
    expect(api.calls.some((call) => call.op === 'postConnectorStatus')).toBe(false);

    // The human finished (or closed the page) and connect exited: the next
    // assignment is an ordinary fresh install again.
    connect.abort();
    releaseSquireConnectSession();
    await loop.runOnce();
    await settle();
    expect(started).toBe(1);
    loop.stop();
  });

  it('stops the row instead of raising another display when the ceremony expired', async () => {
    // The server re-issues `install` for the whole time the row is
    // `installing`. A published ceremony nobody used must end the row, or the
    // helper brings up a fresh Xvfb/x11vnc/websockify/cloudflared rig every
    // five minutes for the daemon's lifetime.
    const connect = await spawnReportedConnect();
    const claimed = squireConnectSession();
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }], {
      connectorId: 'conn-1',
      steps: [{ label: 'waiting for sign-in', status: 'pending' }],
      signIn: { method: 'streamed-page', url: 'https://tunnel.test/#p=hunter22' },
    });
    let started = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        started += 1;
        return { status: 'installing', steps: [] };
      },
    });
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(claimed!.claimedAt + CONNECT_TIMEOUT_MS);
      await loop.runOnce();
      await settle();
      expect(started).toBe(0);
      const post = api.calls.find((call) => call.op === 'postConnectorStatus');
      expect(post?.input.errorMessage).toBe(CEREMONY_EXPIRED);
      expect(post?.input.signIn).toBeNull();
      expect(isProcessAlive(claimed?.pid)).toBe(false);
    } finally {
      clock.mockRestore();
      connect.abort();
      releaseSquireConnectSession();
      loop.stop();
    }
  });

  it('drains the moment the sign-in this helper owns exits, not on the recovery poll', async () => {
    // Nothing on the wire says the human finished signing in: the row stays
    // `installing` until a LATER run reaches Squire's already-connected
    // short-circuit. The connect process exiting is that signal, so the phone
    // must not wait out the five-minute recovery interval for it.
    const connect = await spawnReportedConnect();
    const claimed = squireConnectSession();
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    const armed: (() => void)[] = [];
    let started = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      intervalMs: 10 * 60_000,
      schedule: (fn) => {
        armed.push(fn);
        return armed.length;
      },
      cancel: () => {},
      install: async (options) => {
        started += 1;
        return connectedInstall()(options);
      },
    });
    try {
      await loop.runOnce();
      await settle();
      expect(started).toBe(0);
      // While the ceremony is live the watch only re-arms itself.
      expect(armed).toHaveLength(1);
      armed.pop()!();
      await settle();
      expect(started).toBe(0);
      expect(armed).toHaveLength(1);

      // The human finished and connect exited.
      connect.abort();
      for (let attempt = 0; attempt < 200 && isProcessAlive(claimed?.pid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      armed.pop()!();
      await settle();
      expect(started).toBe(1);
      expect(
        api.calls.some((call) =>
          call.op === 'installConnector' && call.input.connectorId === 'conn-1'),
      ).toBe(true);
    } finally {
      connect.abort();
      releaseSquireConnectSession();
      loop.stop();
    }
  });

  it('supersedes a live connect when the human asked for this connector again', async () => {
    // `pairConnector` re-arms the row to its default all-pending steps, which
    // is the only thing that tells a fresh human request from the poll the
    // server re-issues every ten seconds while the row is `installing`.
    const connect = await spawnReportedConnect();
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }], {
      connectorId: 'conn-1',
      steps: [
        { label: 'helper reached', status: 'pending' },
        { label: 'trusty-squire installed', status: 'pending' },
      ],
    });
    let started = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        started += 1;
        return { status: 'installing', steps: [] };
      },
    });
    try {
      await loop.runOnce();
      await settle();
      expect(started).toBe(1);

      // The row still carrying settled steps is the ceremony we published, so
      // the next re-issued poll leaves it alone.
      api.status.steps = [
        { label: 'helper reached', status: 'done' },
        { label: 'waiting for sign-in', status: 'pending' },
      ];
      await loop.runOnce();
      await settle();
      expect(started).toBe(1);
    } finally {
      connect.abort();
      releaseSquireConnectSession();
      loop.stop();
    }
  });

  it('stops protecting a ceremony once it has outlived its own tunnel', async () => {
    // A human who never finishes leaves connect — and the Xvfb/x11vnc/
    // websockify/cloudflared rig under it — alive. Past the ceremony's life the
    // tunnel is no use to anybody, so the next install reclaims the display.
    const connect = await spawnReportedConnect();
    const claimed = squireConnectSession();
    expect(claimed?.pid).toBeDefined();
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    let started = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => {
        started += 1;
        return { status: 'installing', steps: [] };
      },
    });
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(claimed!.claimedAt + CONNECT_TIMEOUT_MS - 1);
      await loop.runOnce();
      await settle();
      expect(started).toBe(0);

      clock.mockReturnValue(claimed!.claimedAt + CONNECT_TIMEOUT_MS);
      await loop.runOnce();
      await settle();
      expect(started).toBe(1);
    } finally {
      clock.mockRestore();
      connect.abort();
      releaseSquireConnectSession();
      loop.stop();
    }
  });

  it('reports the run\u2019s own verdict on the ceremony, so a dead tunnel does not outlive it', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async (options) => {
        await options.onProgress([{ label: 'helper reached', status: 'done' }]);
        return { status: 'installing', steps: [{ label: 'helper reached', status: 'done' }] };
      },
    });
    await loop.runOnce();
    await settle();
    const posts = api.calls.filter((call) => call.op === 'postConnectorStatus');
    // Steps-only progress of THIS run says nothing about the surface it just
    // published; the run's final report says it printed none.
    expect(posts[0]?.input.signIn).toBeUndefined();
    expect(posts.at(-1)?.input.signIn).toBeNull();
    loop.stop();
  });

  it('clears the ceremony when a later Squire run fails before printing one', async () => {
    // Run 1 published a tunnel; run 2 dies before printing anything. The dead
    // tunnel must not survive on the row under an `error` status.
    const api = apiMock([{ kind: 'install', connectorId: 'conn-1' }]);
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      install: async () => ({
        status: 'error',
        steps: [{ label: 'trusty-squire installed', status: 'failed' }],
        errorMessage: 'another Trusty Squire session is already using the browser',
      }),
    });
    await loop.runOnce();
    await settle();
    const posts = api.calls.filter((call) => call.op === 'postConnectorStatus');
    expect(posts.at(-1)?.input.errorMessage).toContain('already using the browser');
    expect(posts.at(-1)?.input.signIn).toBeNull();
    loop.stop();
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

  it('runs Google tool installs sequentially with a grant lookup for each connector', async () => {
    const api = apiMock([
      { kind: 'install', connectorId: 'g1', connectorType: 'google-gmail' },
      { kind: 'install', connectorId: 'g2', connectorType: 'google-calendar' },
    ]);
    const events: string[] = [];
    const sharedFactories: (() => Promise<unknown>)[] = [];
    const resolveSpy = vi.fn((_connectorId: string) =>
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
      loop as unknown as { resolveGoogleCredentials: (connectorId: string) => Promise<unknown> }
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
    expect(resolveSpy.mock.calls.map(([connectorId]) => connectorId)).toEqual(['g1', 'g2']);
    expect(sharedFactories).toHaveLength(2);
    loop.stop();
  });

  it('does not reuse a sibling grant for a tool waiting on fresh OAuth', async () => {
    const assignments: ConnectorAssignment[] = [
      { kind: 'install', connectorId: 'ready', connectorType: 'google-calendar' },
      { kind: 'install', connectorId: 'retry', connectorType: 'google-gmail' },
    ];
    const calls: ExecuteCall[] = [];
    const api = {
      async execute(op: string, input: Record<string, unknown>) {
        calls.push({ op, input });
        if (op === 'getConnectorAssignments') return { assignments };
        if (op === 'getGoogleOAuthGrant') return input.connectorId === 'ready'
          ? { status: 'ready', credentials: { accessToken: 'old-token' } }
          : { status: 'pending' };
        return {};
      },
    };
    const loop = new ConnectorAssignmentLoop({
      api: api as never, agentId: 'agent-1', mcp,
      installGoogle: async (_kind, _onProgress, resolve) => {
        const grant = await resolve!();
        return grant.source === 'pending'
          ? { status: 'installing', steps: [] }
          : { status: 'connected', steps: [] };
      },
    });
    await loop.runOnce();
    await settle();
    expect(calls.filter((call) => call.op === 'getGoogleOAuthGrant').map((call) =>
      call.input.connectorId)).toEqual(['ready', 'retry']);
    expect(calls.filter((call) => call.op === 'installConnector').map((call) =>
      call.input.connectorId)).toEqual(['ready']);
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

  it('runs Google OAuth installs independently of Squire work', async () => {
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
    expect(events).toEqual(['squire-start', 'google-start']);
    releaseSquire();
    for (let index = 0; index < 50 && !events.includes('squire-end'); index += 1) {
      await settle();
    }
    expect(events).toEqual(['squire-start', 'google-start', 'squire-end']);
    loop.stop();
  });

  it('clears the YouTube token when its product is unpaired', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-youtube-unpair-'));
    const path = join(home, 'google-credentials.json');
    writeFileSync(path, JSON.stringify({ accessToken: 'old-token' }));
    const api = apiMock([
      { kind: 'uninstall', connectorId: 'yt', connectorType: 'google-youtube' },
      { kind: 'refresh-google-grant', connectorId: 'mail', connectorType: 'google-gmail' },
    ]);
    const loop = new ConnectorAssignmentLoop({ api: api as never,
      agentId: 'agent-1', googleHome: home, mcp });
    await loop.runOnce();
    expect(existsSync(path)).toBe(false);
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
