import React from 'react';
// @ts-expect-error Renderer declarations are absent in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ mode: 'router' as 'pending' | 'router' | 'legacy', focused: true,
  entries: new Map<string, {view: any;listeners: Set<() => void>;}>(), acquire: vi.fn(), release: vi.fn(), retry: vi.fn(),
  live: new Set<(event: any) => void>(), workbench: vi.fn(), wallet: vi.fn(), history: vi.fn(), refreshWallet: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]) }));
vi.mock('./use-surface-focus', () => ({ useSurfaceFocus: () => fixture.focused }));
vi.mock('./router-family', () => ({ useRouterFamily: () => fixture.mode }));
vi.mock('./router-owner', () => ({ acquireRouterLane: (...args: any[]) => fixture.acquire(...args), retryRouterLane: (...args: any[]) => fixture.retry(...args) }));
vi.mock('@/auth/buzz-identity-storage', () => ({ getEffectiveRelayUrl: async () => 'https://synthetic.invalid', loadBuzzIdentity: async () => ({ publicKey: 'owner' }) }));
vi.mock('./surface-storage', async () => (await import('@/test/mock-surface-storage')).mockSurfaceStorage());
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({ register: async (_: unknown, listener: (event: any) => void) => {
      fixture.live.add(listener);return () => fixture.live.delete(listener);
    } }) }));
vi.mock('./workbench-source', () => ({ getWorkbenchSource: () => ({ readWorkbench: fixture.workbench }) }));
vi.mock('./wallet-source', () => ({ getWalletSource: () => ({ readWallet: fixture.wallet, readHistory: fixture.history, refreshWallet: fixture.refreshWallet }) }));
import { useSharedWorkbench } from './workbench-surface';
import { useSharedWallet } from './wallet-surface';
import { mobileSurfaceCache } from './surface-storage';
import { resetClientState } from '@/sync/client-reset';

let tree: any, workbench: ReturnType<typeof useSharedWorkbench>, wallet: ReturnType<typeof useSharedWallet>;
function entry(family: string) {
  let held = fixture.entries.get(family);
  if (!held) {held = { view: { state: 'LIVE', value: family === 'owner-wallet' ? { wallet: { address: 'observed-owner', coins: [], totalUsd: '$123' },
          summary: { createdAt: 1, delegationActive: true, delegationExpiresAt: null }, observedAt: 1 } :
        { connectors: [{ id: 'tailscale', status: 'connected', signedInAs: 'before' }], connections: [], helpers: [], apps: [] }, error: null, cut: null }, listeners: new Set() };
    fixture.entries.set(family, held);}
  return held;
}
function Workbench({ workspace = 'one' }: {workspace?: string;}) {workbench = useSharedWorkbench({ workspaceId: workspace, viewerId: 'owner' });return null;}
function Wallet() {wallet = useSharedWallet('one');return null;}
async function publish(family: string, value: any) {await act(async () => {
    const held = entry(family);held.view = { ...held.view, value };for (const wake of held.listeners) wake();
  });}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;resetClientState();mobileSurfaceCache.clear();
  fixture.mode = 'router';fixture.focused = true;fixture.entries.clear();fixture.live.clear();vi.clearAllMocks();
  fixture.acquire.mockImplementation((input: {family: string;}) => {
    const held = entry(input.family);return { current: () => held.view, release: () => fixture.release(input.family),
      subscribe: (wake: () => void) => {held.listeners.add(wake);return () => held.listeners.delete(wake);} };
  });
});
afterEach(() => {if (tree) act(() => tree.unmount());tree = undefined;});
describe('F08 mounted negotiated owner consumers', () => {
  it('two Workbench consumers share exact facts; 1,000 legacy changes read nothing and a connector change leaves Wallet untouched', async () => {
    await act(async () => {tree = create(/*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Workbench, null), /*#__PURE__*/React.createElement(Workbench, null), /*#__PURE__*/React.createElement(Wallet, null)));});
    expect(fixture.acquire.mock.calls.map(([input]) => input)).toEqual([
    { family: 'owner-workbench' }, { family: 'owner-workbench' }, { family: 'owner-wallet' }]);
    expect(entry('owner-workbench').listeners.size).toBe(2);
    const balance = wallet.value;
    for (let n = 0; n < 1000; n++) for (const listener of fixture.live) listener({ monolithLive: { type: 'resource-change', resource: 'workbench', roomId: '' } });
    await publish('owner-workbench', { ...entry('owner-workbench').view.value, connectors: [{ id: 'tailscale', status: 'connected', signedInAs: 'committed' }] });
    expect(workbench.value?.connectors[0]?.signedInAs).toBe('committed');expect(wallet.value).toBe(balance);
    expect(fixture.workbench).not.toHaveBeenCalled();expect(fixture.wallet).not.toHaveBeenCalled();expect(fixture.history).not.toHaveBeenCalled();
    expect(fixture.refreshWallet).not.toHaveBeenCalled();expect(fixture.live.size).toBe(0);
  });
  it('Workspace changes keep the authenticated owner key and do not open another snapshot', async () => {
    await act(async () => {tree = create(/*#__PURE__*/React.createElement(Workbench, { workspace: "one" }));});
    await act(async () => tree.update(/*#__PURE__*/React.createElement(Workbench, { workspace: "two" })));
    expect(fixture.acquire).toHaveBeenCalledTimes(1);expect(workbench.value).toBe(entry('owner-workbench').view.value);
    expect(fixture.workbench).not.toHaveBeenCalled();
  });
  it('pending negotiation and blur hide prior owner values without a legacy read; provider refresh requires the existing gesture', async () => {
    fixture.mode = 'pending';await act(async () => {tree = create(/*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Workbench, null), /*#__PURE__*/React.createElement(Wallet, null)));});
    expect(workbench.value).toBeNull();expect(wallet.value).toBeNull();expect(fixture.acquire).not.toHaveBeenCalled();
    fixture.mode = 'router';await act(async () => tree.update(/*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Workbench, null), /*#__PURE__*/React.createElement(Wallet, null))));
    expect(fixture.refreshWallet).not.toHaveBeenCalled();
    await act(async () => {await wallet.refresh();});expect(fixture.refreshWallet).toHaveBeenCalledTimes(1);
    fixture.focused = false;await act(async () => tree.update(/*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Workbench, null), /*#__PURE__*/React.createElement(Wallet, null))));
    expect(workbench.value).toBeNull();expect(wallet.value).toBeNull();
    expect(fixture.workbench).not.toHaveBeenCalled();expect(fixture.wallet).not.toHaveBeenCalled();
  });
});
