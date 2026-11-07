import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  state: 'active', platform: 'web', listeners: new Set<(state: string) => void>(),
  authorize: vi.fn(async () => 'fixture-access'),
}));
vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', Pressable: 'Pressable', NativeModules: {},
  Platform: { get OS() { return host.platform; } },
  AppState: {
    get currentState() { return host.state; },
    addEventListener: (_: string, listener: (state: string) => void) => {
      host.listeners.add(listener);
      return { remove: () => host.listeners.delete(listener) };
    },
  },
}));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class extends Error {},
  monolithSession: { authorization: () => host.authorize() },
}));
vi.mock('@/buzz/runtime-config', () => ({ getBuzzRuntimeConfig: () => ({ monolithUrl: 'http://fixture.invalid' }) }));
vi.mock('react-native-safe-area-context', () => {
  const SafeAreaInsetsContext = React.createContext({ top: 24, bottom: 0, left: 0, right: 0 });
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => React.useContext(SafeAreaInsetsContext) };
});
vi.mock('./Button', () => ({ Button: 'Button' }));
vi.mock('./ChevronGlyph', () => ({ ChevronGlyph: 'ChevronGlyph', CHEVRON_ROW_SIZE: 16 }));
vi.mock('./HullSwitch', () => ({ HullSwitch: 'HullSwitch' }));
vi.mock('./StateDot', () => ({ StateDot: 'StateDot' }));

import { ConnectionStatus } from './ConnectionStatus';
import { resetSharedLiveConnection, sharedLiveConnection } from '@/sync/transport/live-connection';
import { MonolithRequestTimeoutError } from '@/auth/monolith-session';

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  requests: { id: string }[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn((frame: string) => {
    const value = JSON.parse(frame);
    if (value.t === 'req') this.requests.push(value);
  });
  constructor() { Socket.instances.push(this); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.close(); this.onclose?.(); }
  reply(index = 0) { this.onmessage?.({ data: JSON.stringify({ t: 'res', id: this.requests[index].id, ok: true, result: {} }) }); }
}
let tree: any;
const banners = () => tree.root.findAllByProps({ testID: 'connection-status-disconnected' });
async function open() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const socket = Socket.instances.at(-1)!;
  await act(async () => socket.open());
  return socket;
}
async function appState(state: string) {
  await act(async () => {
    host.state = state;
    for (const listener of host.listeners) listener(state);
  });
}
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket); Socket.instances = [];
  host.state = 'active'; host.authorize.mockReset().mockResolvedValue('fixture-access');
  await act(async () => { tree = create(<ConnectionStatus />); });
});
afterEach(async () => {
  await act(async () => { tree.unmount(); resetSharedLiveConnection(); });
  vi.useRealTimers(); vi.unstubAllGlobals();
});

// Both hosts share the same socket owner and app-wide banner.
describe.each(['web', 'android'])('%s connection banner lifecycle', platform => {
  beforeEach(() => { host.platform = platform; });

  it('never renders on normal open or foreground reads while connecting or awaiting answers', async () => {
    const connection = sharedLiveConnection();
    const initial = connection.request('readWorkspaces', {});
    expect(banners()).toHaveLength(0);
    const socket = await open();
    expect(banners()).toHaveLength(0);
    await act(async () => { socket.reply(); await initial; });
    await connection.register([], () => { void connection.request('readWorkspaces', {}); });
    await appState('background'); socket.close();
    await appState('active');
    expect(banners()).toHaveLength(0);
    const replacement = await open();
    expect(banners()).toHaveLength(0);
    await act(async () => { replacement.reply(); });
    expect(banners()).toHaveLength(0);
  });

  it('clears an old failure before resuming and ignores a pre-resume request deadline', async () => {
    const connection = sharedLiveConnection();
    const failed = connection.request('readWorkspaces', {}).catch(error => error);
    const socket = await open();
    await act(async () => { socket.drop(); await failed; });
    expect(banners()).toHaveLength(1);
    const stale = connection.request('readWorkspaces', {}, { timeoutMs: 100 }).catch(error => error);
    await open();
    await appState('background'); await appState('active');
    expect(banners()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await stale; });
    expect(banners()).toHaveLength(0);
  });

  it('shows a real foreground read failure after resume and clears on its next answer', async () => {
    const connection = sharedLiveConnection();
    await appState('background'); await appState('active');
    const read = connection.request('readWorkspaces', {}).catch(error => error);
    const socket = await open();
    expect(banners()).toHaveLength(0);
    await act(async () => { socket.drop(); await read; });
    expect(banners()).toHaveLength(1);
    const recovered = connection.request('readWorkspaces', {});
    const replacement = await open();
    expect(banners()).toHaveLength(1);
    await act(async () => { replacement.reply(); await recovered; });
    expect(banners()).toHaveLength(0);
  });

  it('shows a real write failure, but not a connection replacement cancelling another read', async () => {
    const connection = sharedLiveConnection();
    const initial = connection.request('readWorkspaces', {});
    const socket = await open();
    await act(async () => { socket.reply(); await initial; });
    const cancelled = connection.request('readWorkspaces', {}).catch(error => error);
    const replacement = connection.reconnectAfterFailedSend(connection.diagnostics().generation);
    await act(async () => { await cancelled; });
    expect(banners()).toHaveLength(0);
    const next = await open(); await replacement;
    next.send.mockImplementationOnce(() => { throw new Error('socket write failed'); });
    await act(async () => {
      await connection.request('reactToMessage', { roomId: 'a', messageId: 'm', emoji: '👍' }).catch(() => undefined);
    });
    expect(banners()).toHaveLength(1);
  });

  it('never renders for authorization failures before any socket exists', async () => {
    host.authorize.mockRejectedValueOnce(new MonolithRequestTimeoutError());
    await act(async () => { await sharedLiveConnection().request('readWorkspaces', {}).catch(() => undefined); });
    expect(Socket.instances).toHaveLength(0);
    expect(banners()).toHaveLength(0);
  });
});
