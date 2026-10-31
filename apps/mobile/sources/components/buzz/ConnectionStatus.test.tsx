import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ value: 'connected' as 'connected' | 'connecting' | 'disconnected', reconnect: vi.fn() }));
vi.mock('react-native', () => ({ Text: (p: any) => React.createElement('Text', p, p.children), View: (p: any) => React.createElement('View', p, p.children) }));
vi.mock('@/sync/transport/live-connection', () => ({ sharedLiveConnection: () => ({
  connectionStatus: () => state.value,
  subscribeConnectionStatus: () => () => undefined,
  reconnectNow: state.reconnect,
}) }));
vi.mock('./MonoHull', () => ({ PixelLoader: () => React.createElement('PixelLoader') }));
vi.mock('./Button', () => ({ Button: (p: any) => React.createElement('Button', p, p.label) }));
import { ConnectionStatus } from './ConnectionStatus';

describe('ConnectionStatus', () => {
  it('maps all socket states and reconnects now', () => {
    state.value = 'connected';
    let view!: ReturnType<typeof create>;
    act(() => { view = create(<ConnectionStatus />); });
    expect(view.toJSON()).toBeNull();
    state.value = 'connecting';
    act(() => { view = create(<ConnectionStatus />); });
    expect(view.root.findByProps({ testID: 'connection-status-connecting' })).toBeTruthy();
    state.value = 'disconnected';
    act(() => { view = create(<ConnectionStatus />); });
    expect(view.root.findByProps({ testID: 'connection-status-disconnected' })).toBeTruthy();
    act(() => view.root.findByProps({ testID: 'connection-status-reconnect' }).props.onPress());
    expect(state.reconnect).toHaveBeenCalledOnce();
  });

  it('replaces the Room-list offline error row and its retired copy', () => {
    const source = readFileSync(new URL('../../app/(app)/beeline/channels.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<ConnectionStatus />');
    expect(source).not.toContain("Couldn't reach Beeline");
    expect(source).not.toContain('No internet');
    expect(source).not.toContain("Beeline isn't answering");
  });
});
