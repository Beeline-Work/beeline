import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as { op: string; input: Record<string, unknown> }[],
  readWorkbenchOutput: {} as Record<string, unknown>,
  googleSignInOutput: null as null | { connected: boolean; authorizationUrl?: string },
}));

vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: async (op: string, input: Record<string, unknown>) => {
    state.calls.push({ op, input });
    if (op === 'readWorkbench') return state.readWorkbenchOutput;
    if (op === 'readConnectorInstall') return { connectorId: input.connectorId, status: { status: 'installing', steps: [], signIn: null } };
    if (op === 'readConnectionDetail') return { connection: { connectionId: input.connectionId, reference: 'key', label: 'Key', allowedHosts: [], state: 'active' }, grants: [], ledger: [] };
    if (op === 'revokeConnectionGrants') return { revoked: 1 };
    if (op === 'pairConnector') return { connectorId: 'conn-1' };
    if (op === 'beginGoogleSignIn') return { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=one' };
    if (op === 'readGoogleSignIn') return state.googleSignInOutput ??
      { connected: false, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=one' };
    return {};
  },
}));

import { MonolithWorkbenchSource } from './workbench-source';

/** A readWorkbench DTO whose Google rows carry the given statuses. */
function workbenchDto(googleRows: { connectorType: string; status: string }[]) {
  return {
    helpers: [],
    catalog: [
      { connectorType: 'trusty-squire', name: 'Trusty Squire', available: true },
      { connectorType: 'google-gmail', name: 'Gmail', available: true },
      { connectorType: 'google-calendar', name: 'Google Calendar', available: true },
      { connectorType: 'google-drive', name: 'Google Drive', available: true },
      { connectorType: 'google-youtube', name: 'YouTube', available: true },
    ],
    connectors: googleRows.map((row) => ({
      connectorId: `conn-${row.connectorType}`,
      connectorType: row.connectorType,
      status: { status: row.status, steps: [], signIn: null },
    })),
    connections: [],
  };
}

describe('MonolithWorkbenchSource pairConnector — the ONE Google entry', () => {
  afterEach(() => {
    state.calls.length = 0;
  });

  it('resolves the logical google id to the first unconnected tool', async () => {
    state.readWorkbenchOutput = workbenchDto([]);
    const result = await new MonolithWorkbenchSource().pairConnector({
      workspaceId: 'ws1',
      connectorId: 'google',
      helperId: 'helper-1',
    });
    expect(result).toEqual({ connectorId: 'conn-1' });
    const pair = state.calls.find((call) => call.op === 'pairConnector')!;
    expect(pair.input.connectorType).toBe('google-gmail');
    expect(pair.input.helperAgentId).toBe('helper-1');
  });

  it('tops up the first missing tool when part of the set is already connected', async () => {
    state.readWorkbenchOutput = workbenchDto([
      { connectorType: 'google-gmail', status: 'connected' },
      { connectorType: 'google-calendar', status: 'connected' },
    ]);
    await new MonolithWorkbenchSource().pairConnector({
      workspaceId: 'ws1',
      connectorId: 'google',
      helperId: 'helper-1',
    });
    expect(state.calls.find((call) => call.op === 'pairConnector')!.input.connectorType).toBe(
      'google-drive',
    );
  });

  it('passes concrete connector ids through without a catalog read', async () => {
    state.readWorkbenchOutput = workbenchDto([]);
    await new MonolithWorkbenchSource().pairConnector({
      workspaceId: 'ws1',
      connectorId: 'trusty-squire',
      helperId: 'helper-1',
    });
    expect(state.calls.find((call) => call.op === 'pairConnector')!.input.connectorType).toBe(
      'trusty-squire',
    );
    expect(state.calls.some((call) => call.op === 'readWorkbench')).toBe(false);
  });
});

describe('MonolithWorkbenchSource direct Google consent', () => {
  afterEach(() => { state.calls.length = 0; state.googleSignInOutput = null; });

  it('keeps Gmail top-up on sign-in while Calendar is already granted', async () => {
    const source = new MonolithWorkbenchSource();
    const input = { workspaceId: 'ws1', connectorId: 'google-account' };
    state.googleSignInOutput = { connected: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=gmail-top-up' };
    expect(await source.readInstallState(input)).toMatchObject({
      connected: false, signIn: { url: state.googleSignInOutput.authorizationUrl },
    });
    state.googleSignInOutput = { connected: true };
    expect(await source.readInstallState(input)).toMatchObject({ connected: true, signIn: null });
    // Cancelling the top-up also returns to the already-connected Calendar state.
    state.googleSignInOutput = { connected: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=retry' };
    expect((await source.readInstallState(input))?.connected).toBe(false);
    state.googleSignInOutput = { connected: true };
    expect((await source.readInstallState(input))?.connected).toBe(true);
  });

  it('keeps a connected legacy Gmail row visible beside a direct Calendar grant', async () => {
    state.readWorkbenchOutput = { ...workbenchDto([{ connectorType: 'google-gmail', status: 'connected' }]),
      googleAccount: { connected: true, connectedTypes: ['google-calendar'], pending: false } };
    const view = await new MonolithWorkbenchSource().readWorkbench({ workspaceId: 'ws1', viewerId: 'owner' });
    expect(view.connectors.find(row => row.id === 'google-gmail')?.status).toBe('connected');
    expect(view.connectors.find(row => row.id === 'google-calendar')?.status).toBe('connected');
    await new MonolithWorkbenchSource().disconnectConnector({ workspaceId: 'ws1', connectorId: 'google-gmail' });
    expect(state.calls.at(-1)).toEqual({ op: 'unpairConnector',
      input: { workspaceId: 'ws1', connectorId: 'conn-google-gmail' } });
    await new MonolithWorkbenchSource().disconnectConnector({ workspaceId: 'ws1', connectorId: 'google-calendar' });
    expect(state.calls.at(-1)).toEqual({ op: 'disconnectGoogleSignIn', input: {} });
  });

  it('begins and polls owner consent without reading or pairing a helper', async () => {
    state.readWorkbenchOutput = { ...workbenchDto([]), googleAccount: { connected: false,
      connectedTypes: [], pending: false } };
    const source = new MonolithWorkbenchSource();
    const view = await source.readWorkbench({ workspaceId: 'ws1', viewerId: 'owner' });
    expect(view.connectors.filter(row => row.id.startsWith('google-')).map(row => row.status))
      .toEqual(['disconnected', 'disconnected', 'disconnected', 'disconnected']);
    const started = await source.beginGoogleSignIn({ workspaceId: 'ws1', connectorType: 'google-calendar' });
    expect(new URL(started.authorizationUrl).host).toBe('accounts.google.com');
    expect(await source.readInstallState({ workspaceId: 'ws1', connectorId: 'google-account' }))
      .toMatchObject({ connected: false, signIn: { method: 'oauth' } });
    expect(state.calls.map(call => call.op)).toEqual([
      'readWorkbench', 'beginGoogleSignIn', 'readGoogleSignIn',
    ]);
    expect(state.calls[1]?.input).toEqual({ connectorType: 'google-calendar' });
  });
});

describe('MonolithWorkbenchSource connections', () => {
  afterEach(() => {
    state.calls.length = 0;
  });

  it('carries the vault service through as itself, and leaves it absent when the vault has none', async () => {
    state.readWorkbenchOutput = {
      ...workbenchDto([]),
      connections: [
        {
          reference: 'cred_github',
          label: 'Work key',
          service: 'github',
          allowedHosts: [],
          faviconDomain: null,
          state: 'active',
        },
        {
          reference: 'cred_unknown',
          label: 'Box',
          service: null,
          allowedHosts: ['127.0.0.1'],
          faviconDomain: null,
          state: 'active',
        },
        {
          reference: 'cred_resend',
          label: 'default',
          service: 'resend',
          allowedHosts: ['api.resend.com'],
          faviconDomain: 'resend.com',
          state: 'active',
        },
      ],
    };
    const view = await new MonolithWorkbenchSource().readWorkbench({
      workspaceId: 'ws1',
      viewerId: 'human-dani',
      refreshVault: true,
    });
    expect(state.calls.at(-1)?.input).toEqual({ workspaceId: 'ws1', refreshVault: true });
    expect(view.connections[0].service).toBe('github');
    expect(view.connections[1].service).toBeUndefined();
    // The server-derived brand domain rides through for the mark to fetch.
    expect(view.connections[2].faviconDomain).toBe('resend.com');
    expect(view.connections[0].faviconDomain).toBeUndefined();
  });

  it('shows each app as one row, whatever serves it, and no Registry row of its own', async () => {
    const dto = workbenchDto([]);
    state.readWorkbenchOutput = {
      ...dto,
      connectors: [
        {
          connectorId: 'registry-row-uuid',
          connectorType: 'registry-mcp',
          registryServerName: 'app.linear/linear',
          registryVersion: '1.0.1',
          displayName: 'Linear',
          status: { status: 'connected', steps: [], signIn: null },
        },
      ],
      apps: [
        {
          appId: 'app-linear',
          appKey: 'linear',
          name: 'Linear',
          domain: 'linear.app',
          transport: 'registry-mcp',
          route: 'registry-mcp',
          status: 'connected',
          helperName: 'Owner laptop',
          helperId: 'machine-one',
          useCount: 3,
          createdAt: 1,
        },
      ],
    };
    const view = await new MonolithWorkbenchSource().readWorkbench({
      workspaceId: 'ws1',
      viewerId: 'human-dani',
    });
    expect(view.connectors.map((connector) => connector.id)).not.toContain('registry-row-uuid');
    expect(view.apps).toEqual([
      {
        id: 'app-linear',
        key: 'linear',
        name: 'Linear',
        domain: 'linear.app',
        transport: 'registry-mcp',
        status: 'connected',
        helperName: 'Owner laptop',
        helperId: 'machine-one',
        useCount: 3,
        createdAt: 1,
      },
    ]);
  });

  it('reads an older server with no apps as none', async () => {
    state.readWorkbenchOutput = workbenchDto([]);
    const view = await new MonolithWorkbenchSource().readWorkbench({
      workspaceId: 'ws1',
      viewerId: 'human-dani',
    });
    expect(view.apps).toEqual([]);
  });
});

describe('MonolithWorkbenchSource apps', () => {
  afterEach(() => {
    state.calls.length = 0;
  });

  it('connects through the one front door and disconnects by app id', async () => {
    const source = new MonolithWorkbenchSource();
    await source.connectApp({ workspaceId: 'ws1', app: 'Linear', helperId: 'machine-one' });
    await source.connectApp({
      workspaceId: 'ws1',
      app: 'linear',
      helperId: 'machine-one',
      reconnect: true,
    });
    await source.disconnectApp({ workspaceId: 'ws1', appId: 'app-linear' });
    expect(state.calls).toEqual([
      {
        op: 'connectWorkbenchApp',
        input: { workspaceId: 'ws1', app: 'Linear', helperAgentId: 'machine-one' },
      },
      {
        op: 'connectWorkbenchApp',
        input: { workspaceId: 'ws1', app: 'linear', helperAgentId: 'machine-one', reconnect: true },
      },
      { op: 'disconnectWorkbenchApp', input: { workspaceId: 'ws1', appId: 'app-linear' } },
    ]);
  });
});

describe('MonolithWorkbenchSource disconnectConnector', () => {
  afterEach(() => {
    state.calls.length = 0;
  });

  it('resolves a catalog type to the helper row id before unpairing', async () => {
    state.readWorkbenchOutput = {
      ...workbenchDto([]),
      connectors: [
        {
          connectorId: 'row-uuid',
          connectorType: 'trusty-squire',
          status: { status: 'connected', steps: [], signIn: null },
        },
      ],
    };
    await new MonolithWorkbenchSource().disconnectConnector({
      workspaceId: 'ws1',
      connectorId: 'trusty-squire',
    });
    expect(state.calls.find((call) => call.op === 'unpairConnector')!.input).toEqual({
      workspaceId: 'ws1',
      connectorId: 'row-uuid',
    });
  });
});

describe('targeted screen reads', () => {
  afterEach(() => { state.calls.length = 0; });
  it('R12b: polls only the Squire install row', async () => {
    state.readWorkbenchOutput = workbenchDto([{ connectorType: 'trusty-squire', status: 'installing' }]);
    expect(await new MonolithWorkbenchSource().readInstallState({ workspaceId: 'ws1', connectorId: 'conn-trusty-squire' })).toMatchObject({ connected: false });
    expect(state.calls).toEqual([{ op: 'readConnectorInstall', input: { workspaceId: 'ws1', connectorId: 'conn-trusty-squire' } }]);
  });
  it('R12d: opens and revokes one key without reading Workbench', async () => {
    const source = new MonolithWorkbenchSource();
    await source.readConnectionDetail({ workspaceId: 'ws1', connectionId: 'key-id', viewerId: 'owner' });
    await source.revokeAllGrants({ workspaceId: 'ws1', connectionId: 'key-id' });
    expect(state.calls).toEqual([
      { op: 'readConnectionDetail', input: { workspaceId: 'ws1', connectionId: 'key-id' } },
      { op: 'revokeConnectionGrants', input: { workspaceId: 'ws1', connectionId: 'key-id' } },
    ]);
  });
});
