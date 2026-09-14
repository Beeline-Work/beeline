import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const searchParams = vi.hoisted(() => ({
  params: { workspaceId: 'workspace-1', viewerId: 'human-dani' } as Record<string, string>,
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => searchParams.params,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props),
  };
});

import WorkbenchScreen from './workbench';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.params = { workspaceId: 'workspace-1', viewerId: 'human-dani' };
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(WorkbenchScreen));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('Workbench settings screen', () => {
  it('renders the connector rows: Trusty Squire to connect, Wallet and Tailscale as soon', async () => {
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire' });
    expect(squire.props.title).toBe('Trusty Squire');
    expect(squire.props.value).toBe('connect');
    expect(squire.props.disabled).toBe(false);
    expect(renderer.root.findByProps({ testID: 'workbench-connector-wallet' }).props.value).toBe(
      'soon',
    );
    expect(
      renderer.root.findByProps({ testID: 'workbench-connector-tailscale' }).props.value,
    ).toBe('soon');
    expect(renderer.root.findByProps({ testID: 'workbench-connector-wallet' }).props.disabled).toBe(
      true,
    );
  });

  it('lists the viewer’s own connections with kind and host', async () => {
    const renderer = await render();
    const vercel = renderer.root.findByProps({ testID: 'workbench-connection-cred_vercel' });
    expect(vercel.props.title).toBe('Vercel');
    expect(vercel.props.description).toBe('token · api.vercel.com');
    expect(vercel.props.value).toBe('active');
    expect(
      renderer.root.findByProps({ testID: 'workbench-connection-cred_google' }),
    ).toBeDefined();
  });

  it('shows the none-yet state with the sovereignty note for a member with no connections', async () => {
    searchParams.params = { workspaceId: 'workspace-1', viewerId: 'human-terra' };
    const renderer = await render();
    const empty = renderer.root.findByProps({ testID: 'workbench-connections-empty' });
    expect(empty.props.title).toBe('None yet');
    expect(empty.props.description).toContain('Connections from other members are not listed');
    expect(renderer.root.findAllByProps({ testID: 'workbench-connection-cred_vercel' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'workbench-connection-cred_google' })).toHaveLength(0);
  });

  it('opens the connect flow on the Trusty Squire row', async () => {
    const renderer = await render();
    act(() => {
      renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire' }).props.onPress();
    });
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push.mock.calls[0][0].pathname).toBe(
      '/beeline/settings/workbench/connect',
    );
  });

  it('opens a connection detail on a connection row', async () => {
    const renderer = await render();
    act(() => {
      renderer.root.findByProps({ testID: 'workbench-connection-cred_vercel' }).props.onPress();
    });
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push.mock.calls[0][0].pathname).toBe(
      '/beeline/settings/workbench/connection',
    );
    expect(navigation.push.mock.calls[0][0].params.ref).toBe('cred_vercel');
  });
});
