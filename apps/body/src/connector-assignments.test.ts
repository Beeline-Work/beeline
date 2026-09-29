import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorAssignment } from '@beeline/api-contract/daemon';
import { CEREMONY_EXPIRED, ConnectorAssignmentLoop } from './connector-assignments.js';
import { installRegistryMcp } from './registry-mcp.js';
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
  (): ((options: InstallSquireOptions) => Promise<InstallSquireResult>) => async (options) => {
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
  it('ends a Registry sign-in nobody completed instead of re-arming forever', async () => {
    const assignment: ConnectorAssignment = {
      kind: 'install',
      connectorId: 'registry-1',
      connectorType: 'registry-mcp',
      registryServerName: 'app.linear/linear',
      registryVersion: '1.0.1',
      registryManifest: {
        name: 'app.linear/linear',
        version: '1.0.1',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
        packages: [],
        secretInputNames: [],
      },
    };
    const api = apiMock([assignment]);
    const timers: (() => void)[] = [];
    const cancelled: unknown[] = [];
    const attemptEndsAt = 1_000 + 10 * 60_000;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      installRegistry: async () => ({
        status: 'installing',
        steps: [],
        authorizationUrl: 'https://mcp.linear.app/authorize?state=a',
        attemptId: 'attempt-one',
        attemptExpiresAt: attemptEndsAt,
      }),
      schedule: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      cancel: (handle) => {
        cancelled.push(handle);
      },
    });
    const clock = vi.spyOn(Date, 'now');
    try {
      const started = 1_000;
      clock.mockReturnValue(started);
      await loop.runOnce();
      await settle();
      expect(timers.length).toBe(0);

      // Still inside the ceremony's life: the watch keeps re-arming.
      clock.mockReturnValue(attemptEndsAt - 1);
      await loop.runOnce();
      await settle();
      const waiting = api.calls.filter((call) => call.op === 'postConnectorStatus');
      expect(waiting.at(-1)?.input.errorMessage).toBeUndefined();
      expect(waiting.at(-1)?.input.signIn).toBeDefined();
      expect(cancelled).toEqual([]);

      // Past the SERVER's attempt expiry the row ends and says why, rather
      // than spending a claim round trip and a row UPDATE every two seconds
      // for the daemon's life.
      clock.mockReturnValue(attemptEndsAt);
      await loop.runOnce();
      await settle();
      const expired = api.calls.filter((call) => call.op === 'postConnectorStatus').at(-1);
      expect(expired?.input.errorMessage).toBe(CEREMONY_EXPIRED);
      expect(expired?.input.signIn).toBeNull();
      expect(cancelled).toEqual([]);

      // And the row is done: a later pass arms no further watch.
      clock.mockReturnValue(attemptEndsAt + 60_000);
      await loop.runOnce();
      await settle();
      expect(timers.length).toBe(0);
    } finally {
      clock.mockRestore();
      loop.stop();
    }
  });

  it('ends a real expired Registry attempt before another authorization page can be minted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'beeline-registry-ceremony-'));
    const assignment: ConnectorAssignment = {
      kind: 'install',
      connectorId: '22222222-2222-4222-8222-222222222222',
      connectorType: 'registry-mcp',
      registryServerName: 'app.linear/linear',
      registryVersion: '1.0.1',
      registryManifest: {
        name: 'app.linear/linear',
        version: '1.0.1',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
        packages: [],
        secretInputNames: [],
      },
      pairingGeneration: 1,
    };
    let assignments: ConnectorAssignment[] = [assignment];
    let begins = 0;
    let claimsExpired = false;
    const posts: Record<string, unknown>[] = [];
    const api = {
      async execute(op: string, input: Record<string, unknown>) {
        if (op === 'getConnectorAssignments') return { assignments };
        if (op === 'beginRegistryMcpOAuth')
          return {
            state: `state-${++begins}`,
            redirectUri: 'https://beeline.example/callback',
            expiresAt: Date.now() + 600_000,
          };
        if (op === 'claimRegistryMcpOAuthCode')
          return claimsExpired
            ? { status: 'expired' }
            : { status: 'pending', expiresAt: Date.now() + 600_000 };
        if (op === 'postConnectorStatus') {
          posts.push(input);
          if (input.errorMessage) assignments = [];
          return {};
        }
        throw new Error(`unexpected ${op}`);
      },
    };
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://mcp.linear.app/mcp')
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://mcp.linear.app/resource"',
          },
        });
      if (url === 'https://mcp.linear.app/resource')
        return Response.json({ authorization_servers: ['https://mcp.linear.app'] });
      if (url === 'https://mcp.linear.app/.well-known/oauth-authorization-server')
        return Response.json({
          authorization_endpoint: 'https://mcp.linear.app/authorize',
          token_endpoint: 'https://mcp.linear.app/token',
          registration_endpoint: 'https://mcp.linear.app/register',
          code_challenge_methods_supported: ['S256'],
        });
      if (url === 'https://mcp.linear.app/register') return Response.json({ client_id: 'client' });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      registryHome: home,
      installRegistry: (input) =>
        installRegistryMcp({ ...input, transport, resolveHost: async () => ['93.184.216.34'] }),
      schedule: () => 1,
      cancel: () => {},
    });
    try {
      await loop.runOnce();
      await settle();
      expect(begins).toBe(1);
      expect(posts.at(-1)?.signIn).toMatchObject({ attemptId: expect.any(String) });

      claimsExpired = true;
      await loop.runOnce();
      await settle();
      expect(posts.at(-1)).toMatchObject({ errorMessage: CEREMONY_EXPIRED, signIn: null });
      expect(begins).toBe(1);

      await loop.runOnce();
      await settle();
      expect(begins).toBe(1);

      assignments = [{ ...assignment, pairingGeneration: 2 }];
      await loop.runOnce();
      await settle();
      expect(begins).toBe(2);
      expect(posts.at(-1)?.signIn).toMatchObject({ url: expect.stringContaining('state=state-2') });
    } finally {
      loop.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a re-paired Registry connector starts a fresh ceremony after the old one expired', async () => {
    const assignment: ConnectorAssignment = {
      kind: 'install',
      connectorId: 'registry-1',
      connectorType: 'registry-mcp',
      registryServerName: 'app.linear/linear',
      registryVersion: '1.0.1',
      registryManifest: {
        name: 'app.linear/linear',
        version: '1.0.1',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }],
        packages: [],
        secretInputNames: [],
      },
      pairingGeneration: 1,
    };
    const calls: ExecuteCall[] = [];
    const timers: (() => void)[] = [];
    let assignmentValue = assignment;
    let attemptId = 'attempt-one';
    const api = {
      calls,
      async execute(op: string, input: Record<string, unknown>) {
        calls.push({ op, input });
        if (op === 'getConnectorAssignments') return { assignments: [assignmentValue] };
        return {};
      },
    };
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      mcp,
      installRegistry: async () => ({
        status: 'installing',
        steps: [],
        authorizationUrl: `https://mcp.linear.app/authorize?state=${attemptId}`,
        attemptId,
        attemptExpiresAt: Date.now() + 10 * 60_000,
      }),
      schedule: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      cancel: () => {},
    });
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(1_000);
      await loop.runOnce();
      await settle();

      // The first ceremony runs out on the server's clock and is ended.
      clock.mockReturnValue(1_000 + 10 * 60_000);
      await loop.runOnce();
      await settle();
      const expired = api.calls.filter((call) => call.op === 'postConnectorStatus').at(-1);
      expect(expired?.input.errorMessage).toBe(CEREMONY_EXPIRED);

      // A human re-pairs: generation 2 re-arms the row. The latched expiry of
      // generation 1 must not swallow it — the helper publishes a FRESH
      // sign-in page and the row keeps waiting.
      assignmentValue = { ...assignment, pairingGeneration: 2 };
      attemptId = 'attempt-two';
      clock.mockReturnValue(1_000 + 10 * 60_000 + 60_000);
      await loop.runOnce();
      await settle();
      const reArmed = api.calls.filter((call) => call.op === 'postConnectorStatus').at(-1);
      expect(reArmed?.input.errorMessage).toBeUndefined();
      expect(reArmed?.input.signIn?.url).toBe('https://mcp.linear.app/authorize?state=attempt-two');
      expect(reArmed?.input.pairingGeneration).toBe(2);
    } finally {
      clock.mockRestore();
      loop.stop();
    }
  });

  it('routes a Tailscale assignment through its own sign-in ceremony', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'tail-1', connectorType: 'tailscale' }]);
    let tailConnected: (() => void) | undefined;
    let installs = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      watchTailscaleSignIn: (onConnected) => {
        tailConnected = onConnected;
        return () => undefined;
      },
      install: async () => {
        throw new Error('must not run the Squire installer');
      },
      installTailscale: async ({ onProgress }) => {
        installs += 1;
        if (installs === 2)
          return { status: 'connected', steps: [{ label: 'Tailnet signed in', status: 'done' }] };
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
    expect(api.calls.filter((call) => call.op === 'getConnectorAssignments')).toHaveLength(1);
    tailConnected?.();
    await settle();
    expect(api.calls.filter((call) => call.op === 'getConnectorAssignments')).toHaveLength(2);
    expect(api.calls.some((call) => call.op === 'installConnector')).toBe(true);
    loop.stop();
  });

  it('re-runs Tailscale install on sync when the CLI may be missing', async () => {
    const api = apiMock([{ kind: 'sync', connectorId: 'tail-1', connectorType: 'tailscale' }]);
    let installed = 0;
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
      install: async () => {
        throw new Error('must not run the Squire installer');
      },
      installTailscale: async () => {
        installed += 1;
        return {
          status: 'connected',
          steps: [{ label: 'Tailscale installed', status: 'done' }],
          signedInAs: 'sol@example.test',
        };
      },
    });

    await loop.runOnce();
    await settle();

    expect(installed).toBe(1);
    expect(api.calls.some((call) => call.op === 'installConnector')).toBe(true);
    loop.stop();
  });

  it('drains on wake without scheduling a recovery poll', async () => {
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
    expect(scheduled).toBe(0);
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
    expect(api.calls.map((call) => call.op)).toEqual([
      'getConnectorAssignments',
      'postConnectorStatus',
    ]);
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
    expect(api.calls.map((call) => call.op)).toEqual([
      'getConnectorAssignments',
      'postConnectorStatus',
    ]);
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
    const api = apiMock([{ kind: 'revoke-grants', connectorId: 'conn-1', reference: 'cred_a' }]);
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
    await vi.waitFor(() => expect(started).toBe(1));
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

  it('drains on the sign-in process exit event without a server polling timer', async () => {
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
      // A live ceremony waits for its process exit event without a timer.
      expect(started).toBe(0);
      expect(armed).toHaveLength(0);

      // The human finished and connect exited.
      connect.abort();
      for (let attempt = 0; attempt < 200 && isProcessAlive(claimed?.pid); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await vi.waitFor(() => expect(started).toBe(1));
      expect(started).toBe(1);
      expect(
        api.calls.some(
          (call) => call.op === 'installConnector' && call.input.connectorId === 'conn-1',
        ),
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

  it('refuses a stale Google install without switching it to Squire', async () => {
    const api = apiMock([{ kind: 'install', connectorId: 'old', connectorType: 'google-gmail' }]);
    const install = vi.fn();
    const loop = new ConnectorAssignmentLoop({ api: api as never, agentId: 'agent-1',
      mcp, install });
    await loop.runOnce();
    await vi.waitFor(() => expect(api.calls).toContainEqual(expect.objectContaining({
      op: 'postConnectorStatus', input: expect.objectContaining({
        errorMessage: 'Reconnect through Connect an app',
      }),
    })));
    expect(install).not.toHaveBeenCalled();
    loop.stop();
  });

  it('survives a failed assignments read and retries on the next wake', async () => {
    const calls: ExecuteCall[] = [];
    let fail = true;
    const api = {
      async execute(op: string, input: Record<string, unknown>) {
        calls.push({ op, input });
        if (fail) throw new Error('server unreachable');
        return { assignments: [] };
      },
    };
    const loop = new ConnectorAssignmentLoop({
      api: api as never,
      agentId: 'agent-1',
    });
    await loop.runOnce(); // throws inside runOnce must be swallowed
    fail = false;
    loop.wake();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    loop.stop();
  });
});
