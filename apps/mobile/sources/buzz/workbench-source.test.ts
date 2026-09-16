import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWorkbenchSource, setWorkbenchSource } from './workbench-source';
import { MockWorkbenchSource } from './workbench-source.mock';
import { connectionsForViewer } from './workbench';

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
describe('mock Workbench source', () => {
  beforeEach(() => {
    setWorkbenchSource(new MockWorkbenchSource());
  });

  afterEach(() => {
    setWorkbenchSource();
  });

  it('lists Trusty Squire live and Wallet/Tailscale as soon', async () => {
    const view = await getWorkbenchSource().readWorkbench({
      workspaceId: 'ws',
      viewerId: MEMBER_A,
    });
    expect(view.connectors.map((connector) => [connector.id, connector.available])).toEqual([
      ['trusty-squire', true],
      ['wallet', false],
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
    expect(view.connectors.find((connector) => connector.id === 'trusty-squire')?.status).toBeUndefined();
  });
});
