import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkbenchSource,
  setWorkbenchSource,
  MonolithWorkbenchSource,
} from './workbench-source';
import { MockWorkbenchSource } from './workbench-source.mock';
import { connectionsForViewer } from './workbench';

/**
 * Fake of the monolith phone-operation transport for the REAL source tests
 * below: shapes exactly as the server answers them — `pairConnector` returns
 * the ROW's UUID id, while each `readWorkbench` connector row carries BOTH
 * that id and its `connectorType`.
 */
const fakeServer = vi.hoisted(() => {
  const state = {
    rows: [] as Array<{
      connectorId: string;
      connectorType: string;
      status: {
        connectorId: string;
        status: string;
        helperName: string;
        errorMessage?: string;
        steps: { label: string; status: string }[];
        signIn: { method: string; url: string } | null;
      };
    }>,
    wallet: false,
  };
  return state;
});

vi.mock('@/sync/transport/monolith-operation', () => ({
  monolithPhoneOperation: async (name: string, input: Record<string, unknown>) => {
    if (name === 'readWorkbench') {
      return {
        workspaceId: input.workspaceId,
        helpers: [],
        catalog: [
          { connectorType: 'wallet', name: 'Coinbase Wallet', available: false },
          ...fakeServer.rows.map((row) => ({
            connectorType: row.connectorType,
            name: row.connectorType,
            available: true,
          })),
        ],
        connectors: fakeServer.rows,
        connections: [],
        ...(fakeServer.wallet
          ? { wallet: { createdAt: 1, delegationActive: true, delegationExpiresAt: null } }
          : {}),
      };
    }
    if (name === 'pairConnector') {
      fakeServer.rows = fakeServer.rows.filter((row) => row.connectorType !== input.connectorType);
      const row = {
        connectorId: 'row-uuid-1',
        connectorType: String(input.connectorType),
        status: {
          connectorId: 'row-uuid-1',
          status: 'installing',
          helperName: 'squire-box',
          steps: [{ label: 'install', status: 'running' }],
          signIn: null,
        },
      };
      fakeServer.rows.push(row);
      return { connectorId: row.connectorId, status: row.status };
    }
    throw new Error(`unexpected operation ${name}`);
  },
}));

const MEMBER_A = 'human-dani';
const MEMBER_B = 'human-terra';

/**
 * The mock Workbench source stands in for the real monolith operations.
 * These tests pin its contract — the shapes the screens render — and the
 * sovereignty rule the client projection carries: member B's Workbench never
 * lists member A's connections, even though the payload the server sends is
 * already viewer-scoped. The REAL source (`MonolithWorkbenchSource`) is the
 * default `getWorkbenchSource()`; screens never import either module
 * directly, so tests swap through the one seam.
 */
describe('real monolith Workbench source — install-state row resolution', () => {
  beforeEach(() => {
    fakeServer.rows = [];
    fakeServer.wallet = false;
  });

  it('follows the row id pairConnector returned (the connect-screen stall regression)', async () => {
    const source = new MonolithWorkbenchSource();
    const { connectorId } = await source.pairConnector({
      workspaceId: 'ws',
      connectorId: 'trusty-squire',
      helperId: 'helper-squire-box',
    });
    expect(connectorId).toBe('row-uuid-1');
    const state = await source.readInstallState({ connectorId, workspaceId: 'ws' });
    // The stalled screen read this as null forever and never left the picker.
    expect(state).not.toBeNull();
    expect(state?.connectorId).toBe('row-uuid-1');
    expect(state?.helperName).toBe('squire-box');
    expect(state?.steps.map((step) => step.status)).toEqual(['active']);
  });

  it('still resolves by connector type (the sign-in overlay back-compat)', async () => {
    const source = new MonolithWorkbenchSource();
    await source.pairConnector({
      workspaceId: 'ws',
      connectorId: 'trusty-squire',
      helperId: 'helper-squire-box',
    });
    const state = await source.readInstallState({
      connectorId: 'trusty-squire',
      workspaceId: 'ws',
    });
    expect(state?.connectorId).toBe('row-uuid-1');
  });

  it('reports no install state for an unknown id', async () => {
    const source = new MonolithWorkbenchSource();
    expect(
      await source.readInstallState({ connectorId: 'row-unknown', workspaceId: 'ws' }),
    ).toBeNull();
  });

  it('projects exact connector errors and direct wallet state', async () => {
    fakeServer.rows = [
      {
        connectorId: 'row-error',
        connectorType: 'trusty-squire',
        status: {
          connectorId: 'row-error',
          status: 'error',
          helperName: 'squire-box',
          errorMessage:
            'another Trusty Squire session is already using the browser — close it first',
          steps: [],
          signIn: null,
        },
      },
    ];
    const source = new MonolithWorkbenchSource();
    let view = await source.readWorkbench({ workspaceId: 'ws', viewerId: MEMBER_A });
    expect(view.connectors.find((entry) => entry.id === 'trusty-squire')?.errorMessage).toBe(
      'another Trusty Squire session is already using the browser — close it first',
    );
    expect(view.connectors.find((entry) => entry.id === 'wallet')).toMatchObject({
      available: true,
      status: 'disconnected',
    });
    fakeServer.wallet = true;
    view = await source.readWorkbench({ workspaceId: 'ws', viewerId: MEMBER_A });
    expect(view.connectors.find((entry) => entry.id === 'wallet')?.status).toBe('connected');
  });
});

describe('mock Workbench source', () => {
  beforeEach(() => {
    setWorkbenchSource(new MockWorkbenchSource());
  });

  afterEach(() => {
    setWorkbenchSource();
  });

  it('lists direct wallet creation separately from helper connector availability', async () => {
    const view = await getWorkbenchSource().readWorkbench({
      workspaceId: 'ws',
      viewerId: MEMBER_A,
    });
    expect(view.connectors.map((connector) => [connector.id, connector.available])).toEqual([
      ['trusty-squire', true],
      ['wallet', true],
      ['tailscale', false],
      ['google-gmail', true],
      ['google-calendar', true],
      ['google-drive', true],
      ['google-youtube', true],
    ]);
  });

  it('scopes connections to the viewer before the screens see them', async () => {
    const source = getWorkbenchSource();
    const forA = connectionsForViewer(
      await source.readWorkbench({ workspaceId: 'ws', viewerId: MEMBER_A }),
      MEMBER_A,
    );
    const forB = connectionsForViewer(
      await source.readWorkbench({ workspaceId: 'ws', viewerId: MEMBER_B }),
      MEMBER_B,
    );
    expect(forA.map((connection) => connection.name)).toEqual(['Vercel', 'Google']);
    expect(forB).toEqual([]);
    expect(forB.some((connection) => connection.ownerId === MEMBER_A)).toBe(false);
  });

  it('refuses to pair an offline helper', async () => {
    await expect(
      getWorkbenchSource().pairConnector({
        workspaceId: 'ws',
        connectorId: 'trusty-squire',
        helperId: 'helper-office-mini',
      }),
    ).rejects.toThrow('offline');
  });

  it('reports install steps one status at a time and then the sign-in surface', async () => {
    const source = getWorkbenchSource();
    const { connectorId } = await source.pairConnector({
      workspaceId: 'ws',
      connectorId: 'trusty-squire',
      helperId: 'helper-squire-box',
    });
    const mid = await source.readInstallState({ connectorId, workspaceId: 'ws' });
    expect(mid?.steps.map((step) => step.status)).toEqual([
      'active',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(mid?.signIn).toBeNull();
    let last = mid;
    for (let tick = 0; tick < 5 && !last?.signIn; tick += 1) {
      last = await source.readInstallState({ connectorId, workspaceId: 'ws' });
    }
    expect(last?.signIn?.method).toBe('streamed');
    expect(last?.signIn?.url).toContain('https://');
    expect(last?.connected).toBe(false);
    const done = await source.readInstallState({ connectorId, workspaceId: 'ws' });
    expect(done?.connected).toBe(true);
  });

  it('injects a failed step with the helper reason for the failure UI', async () => {
    const source = getWorkbenchSource();
    (source as MockWorkbenchSource).failNextPair('trusty-squire');
    const failing = await source.pairConnector({
      workspaceId: 'ws',
      connectorId: 'trusty-squire',
      helperId: 'helper-squire-box',
    });
    const before = await source.readInstallState({
      connectorId: failing.connectorId,
      workspaceId: 'ws',
    });
    expect(before?.steps.some((step) => step.status === 'failed')).toBe(false);
    const state = await source.readInstallState({
      connectorId: failing.connectorId,
      workspaceId: 'ws',
    });
    const failed = state?.steps.find((step) => step.status === 'failed');
    expect(failed?.reason).toContain('helper');
  });

  it('reads connection detail only for the owner and revokes all grants', async () => {
    const source = getWorkbenchSource();
    const forOwner = await source.readConnectionDetail({
      workspaceId: 'ws',
      ref: 'cred_vercel',
      viewerId: MEMBER_A,
    });
    expect(forOwner?.connection.name).toBe('Vercel');
    expect(forOwner?.grants.length).toBeGreaterThan(0);
    expect(forOwner?.ledger.length).toBeGreaterThan(0);

    const forOther = await source.readConnectionDetail({
      workspaceId: 'ws',
      ref: 'cred_vercel',
      viewerId: MEMBER_B,
    });
    expect(forOther).toBeNull();

    const { revoked } = await source.revokeAllGrants({ workspaceId: 'ws', ref: 'cred_vercel' });
    expect(revoked).toBe(2);
    const after = await source.readConnectionDetail({
      workspaceId: 'ws',
      ref: 'cred_vercel',
      viewerId: MEMBER_A,
    });
    expect(after?.grants).toEqual([]);
  });

  it('reports no connected machines before anything is paired (the honest empty state)', async () => {
    const source = getWorkbenchSource();
    const helpers = await source.listHelpers({ workspaceId: 'ws' });
    expect(helpers.length).toBeGreaterThan(0);
    const view = await source.readWorkbench({ workspaceId: 'ws', viewerId: MEMBER_A });
    expect(
      view.connectors.find((connector) => connector.id === 'trusty-squire')?.status,
    ).toBeUndefined();
  });
});
