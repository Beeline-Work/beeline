import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ value: 'connected' as 'connected' | 'connecting' | 'disconnected', reconnect: vi.fn() }));
vi.mock('react-native', () => ({ Text: (p: any) => React.createElement('Text', p, p.children), View: (p: any) => React.createElement('View', p, p.children) }));
vi.mock('@/sync/transport/live-connection', () => ({
  useConnectionState: () => state.value,
  reconnectNow: state.reconnect,
}));
vi.mock('./BeelineMarkSpinner', () => ({ BeelineMarkSpinner: () => React.createElement('BeelineMarkSpinner') }));
vi.mock('./Button', () => ({ Button: (p: any) => React.createElement('Button', p, p.label) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: (p: any) => React.createElement('Ionicons', p) }));
vi.mock('./IndexRow', () => ({ IndexRow: (p: any) => React.createElement('IndexRow', p), InlineRow: (p: any) => React.createElement('InlineRow', p, p.children) }));
import { ConnectionStatus } from './ConnectionStatus';

describe('Disconnected recovery row', () => {
  it('retains shared row copy and the existing Reconnect callback', () => {
    let view!: ReturnType<typeof create>;
    state.value = 'disconnected';
    act(() => { view = create(<ConnectionStatus />); });
    expect(view.root.findByProps({ testID: 'connection-status-disconnected' })).toBeTruthy();
    const row = view.root.findByType('IndexRow');
    expect(row.props.inset).toBe('flush');
    expect(row.props.title).toBe('Beeline isn’t connected');
    expect(row.props.description).toBe('Showing saved messages');
    expect(row.props.action).toBe('Reconnect');
    expect(view.root.findAllByProps({ testID: 'connection-status-disconnected-glyph' })).toHaveLength(0);
    act(() => view.root.findByProps({ testID: 'connection-status-reconnect' }).props.onPress());
    expect(state.reconnect).toHaveBeenCalledOnce();
    act(() => view.unmount());
  });
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
