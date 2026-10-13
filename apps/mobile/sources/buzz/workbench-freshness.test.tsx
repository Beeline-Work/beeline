import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  live: new Set<(event: any) => void>(), focus: new Set<() => void>(),
  wallet: { address: 'owner-wallet', coins: [], totalUsd: '$100' },
  history: { entries: [] as any[] },
  detail: { connection: { ref: 'key', name: 'Old key' }, grants: [] as any[] },
  reads: { wallet: vi.fn(), history: vi.fn(), detail: vi.fn() },
}));
vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void) => {
  React.useEffect(() => { state.focus.add(effect); effect(); return () => { state.focus.delete(effect); }; }, [effect]);
} }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: async () => 'https://relay.test',
  loadBuzzIdentity: async () => ({ publicKey: 'owner' }),
}));
vi.mock('@/buzz/surface-storage', async () => (await import('@/test/mock-surface-storage')).mockSurfaceStorage());
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  register: async (_: unknown, callback: (event: any) => void) => {
    state.live.add(callback); return () => { state.live.delete(callback); };
  },
}) }));
vi.mock('./wallet-source', () => ({ getWalletSource: () => ({
  readWallet: state.reads.wallet, readHistory: state.reads.history,
}) }));
vi.mock('./workbench-source', () => ({ getWorkbenchSource: () => ({ readConnectionDetail: state.reads.detail }) }));
import { mobileSurfaceCache } from './surface-storage';
import { useSharedWallet, useSharedWalletHistory } from './wallet-surface';
import { useSharedConnectionDetail } from './workbench-surface';

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mobileSurfaceCache.clear(); state.live.clear(); state.focus.clear();
  state.wallet = { address: 'owner-wallet', coins: [], totalUsd: '$100' };
  state.history = { entries: [] };
  state.detail = { connection: { ref: 'key', name: 'Old key' }, grants: [] };
  state.reads.wallet.mockReset().mockImplementation(async () => state.wallet);
  state.reads.history.mockReset().mockImplementation(async () => state.history);
  state.reads.detail.mockReset().mockImplementation(async () => state.detail);
});

const cases = [
  { name: 'wallet balance', hook: () => useSharedWallet('ws'), read: state.reads.wallet,
    update: () => { state.wallet = { ...state.wallet, totalUsd: '$60' }; }, text: (value: any) => value?.totalUsd, expected: '$60' },
  { name: 'wallet history', hook: () => useSharedWalletHistory('ws'), read: state.reads.history,
    update: () => { state.history = { entries: [{ amount: '-$40' }] }; }, text: (value: any) => value?.entries[0]?.amount ?? 'No transactions', expected: '-$40' },
  { name: 'connection detail', hook: () => useSharedConnectionDetail({ workspaceId: 'ws', viewerId: 'owner' }, 'key'), read: state.reads.detail,
    update: () => { state.detail = { connection: { ref: 'key', name: 'Updated key' }, grants: [] }; }, text: (value: any) => value?.connection.name, expected: 'Updated key' },
];
for (const test of cases) {
  function Screen() { const { value } = test.hook(); return React.createElement('Text', {}, test.text(value)); }
  async function render() { let result!: ReactTestRenderer;
    await act(async () => { result = create(React.createElement(Screen)); }); return result; }
  const text = (renderer: ReactTestRenderer) => renderer.root.findByType('Text').props.children;
  it(`${test.name} rereads the held cache when reopened and refocused`, async () => {
    const first = await render(); expect(test.read).toHaveBeenCalledTimes(1);
    await act(async () => first.unmount()); test.update();
    const reopened = await render(); expect(test.read).toHaveBeenCalledTimes(2);
    expect(text(reopened)).toBe(test.expected);
    await act(async () => { for (const focus of state.focus) focus(); });
    expect(test.read).toHaveBeenCalledTimes(3);
    await act(async () => reopened.unmount()); expect(state.live.size).toBe(0);
  });
  for (const live of [ { type: 'resource-change', resource: 'workbench', workspaceId: 'ws' },
    { type: 'invalidate', roomId: '', reason: 'reconnect' } ]) {
    it(`${test.name} refreshes on ${live.type} without polling`, async () => {
      const renderer = await render(); test.update();
      await act(async () => { for (const listener of state.live) listener({ monolithLive: live }); });
      expect(text(renderer)).toBe(test.expected); expect(test.read).toHaveBeenCalledTimes(2);
      await act(async () => renderer.unmount()); expect(state.live.size).toBe(0);
    });
  }
}

it('switches Wallet Workspace without writing the new answer into the old cache address', async () => {
  let workspaceId = 'ws';
  state.reads.wallet.mockImplementation(async (input) => ({ ...state.wallet, totalUsd: input.workspaceId }));
  function Screen() { const { value } = useSharedWallet(workspaceId); return React.createElement('Text', {}, value?.totalUsd); }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Screen)); });
  workspaceId = 'other';
  await act(async () => { renderer.update(React.createElement(Screen)); });
  expect(renderer.root.findByType('Text').props.children).toBe('other');
  expect(mobileSurfaceCache.peek({ endpoint: '/workspace/:id/wallet', params: { workspaceId: 'ws' } } as any, ((value: unknown) => Boolean(value)) as any)).toMatchObject({ totalUsd: 'ws' });
  await act(async () => renderer.unmount());
});
