import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ failed: false, reconnect: vi.fn() }));
vi.mock('@/sync/transport/live-connection', () => ({
  useConnectionFailure: () => state.failed,
  reconnectNow: state.reconnect,
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('./IndexRow', () => ({ IndexRow: (props: Record<string, unknown>) => React.createElement('IndexRow', props) }));
import { ConnectionStatus } from './ConnectionStatus';

it('shows one recovery row only after failure and removes it on the next success', async () => {
  let tree: any;
  try {
    await act(async () => { tree = create(<ConnectionStatus />); });
    expect(tree.toJSON()).toBeNull();
    state.failed = true;
    await act(async () => tree.update(<ConnectionStatus />));
    const rows = tree.root.findAllByType('IndexRow');
    expect(rows).toHaveLength(1);
    expect(rows[0].props.title).toBe('Beeline isn’t connected');
    await act(async () => rows[0].props.onPress());
    expect(state.reconnect).toHaveBeenCalledOnce();
    state.failed = false;
    await act(async () => tree.update(<ConnectionStatus />));
    expect(tree.toJSON()).toBeNull();
  } finally { if (tree) await act(async () => tree.unmount()); }
});
