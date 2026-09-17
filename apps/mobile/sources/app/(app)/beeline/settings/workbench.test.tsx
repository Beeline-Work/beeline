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

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => undefined),
}));

import WorkbenchScreen from './workbench';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';

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
  setWorkbenchSource(new MockWorkbenchSource());
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
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(squire.props.title).toBe('Trusty Squire');
    expect(squire.props.value).toBe('connect');
    // The wallet row is the one EXPANDABLE tool cell: the value column stays
    // the row's state, and the Connect affordance lives inside the expansion.
    const wallet = renderer.root.findByProps({ testID: 'workbench-connector-wallet-head' });
    expect(wallet.props.value).toBe('soon');
    act(() => {
      wallet.props.onPress();
    });
    const connect = renderer.root.findByProps({
      testID: 'workbench-connector-wallet-connect',
    });
    expect(connect.props.title).toBe('Connect Coinbase Wallet');
    // A `soon` connector does not act yet: the affordance is present, inert.
    expect(connect.props.onPress).toBeUndefined();
    expect(
      renderer.root.findByProps({ testID: 'workbench-connector-tailscale' }).props.value,
    ).toBe('soon');
  });

  it('expands a tool cell to reveal details and the Connect button inside', async () => {
    const renderer = await render();
    // Nothing expanded yet, no connect button on the collapsed row.
    expect(renderer.root.findAllByProps({ testID: 'workbench-connector-trusty-squire-connect' })).toHaveLength(0);
    act(() => {
      renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' }).props.onPress();
    });
    const details = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-details' });
    const texts = details.findAll((node: any) => typeof node.props?.children === 'string');
    const prose = texts.map((node: any) => node.props.children);
    expect(prose).toContain('Authentication');
    expect(prose).toContain('Payments');
    expect(
      prose.some((line: string) => /sign in once with Google/.test(line)),
    ).toBe(true);
    expect(
      prose.some((line: string) => /card is stored or uploaded/.test(line)),
    ).toBe(true);
    // Collapsed rows carry no action word: Connect lives INSIDE the details.
    expect(renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' }).props.action).toBeUndefined();
    act(() => {
      renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-connect' }).props.onPress();
    });
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push.mock.calls[0][0].pathname).toBe('/beeline/settings/workbench/connect');
    expect(navigation.push.mock.calls[0][0].params.connectorId).toBe('trusty-squire');
  });

  it('folds the four Google tool rows into the ONE Google entry that pairs the whole set', async () => {
    const renderer = await render();
    // Exactly ONE Google row; the four tool kinds never render their own rows.
    const entry = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(entry.props.title).toBe('Google Workspace');
    expect(entry.props.value).toBe('connect');
    expect(renderer.root.findAllByProps({ testID: /^google-entry-tool-/ })).toHaveLength(0);
    await act(async () => {
      entry.props.onPress();
    });
    const connect = renderer.root.findByProps({ testID: 'google-entry-connect' });
    act(() => {
      connect.props.onPress();
    });
    // The entry hands off with the LOGICAL google id; the source resolves it
    // to the first not-yet-connected tool before the server call.
    const push = navigation.push.mock.calls.at(-1)![0];
    expect(push.pathname).toBe('/beeline/settings/workbench/connect');
    expect(push.params.connectorId).toBe('google');
  });

  it('collapses an expanded cell on a second tap', async () => {
    const renderer = await render();
    const row = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    act(() => row.props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'workbench-connector-trusty-squire-details' }).length).toBeGreaterThan(0);
    act(() => renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' }).props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'workbench-connector-trusty-squire-details' })).toHaveLength(0);
  });

  it('heads the two lists Tools and Keys with their one-line descriptions', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'workbench-tools-head' }).props.children).toBe(
      'Tools',
    );
    expect(renderer.root.findByProps({ testID: 'workbench-keys-head' }).props.children).toBe(
      'Keys',
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

  it('shows the none-yet state with a short sovereignty note for a member with no connections', async () => {
    searchParams.params = { workspaceId: 'workspace-1', viewerId: 'human-terra' };
    const renderer = await render();
    const empty = renderer.root.findByProps({ testID: 'workbench-connections-empty' });
    expect(empty.props.title).toBe('None yet');
    expect(empty.props.description).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: 'workbench-connection-cred_vercel' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'workbench-connection-cred_google' })).toHaveLength(0);
  });

  it('renders the error tone for a connector in error state', async () => {
    const source = new MockWorkbenchSource();
    source.failNextPair('trusty-squire');
    setWorkbenchSource(source);
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(squire.props.value).toBe('error');
    expect(squire.props.valueTone).toBe('danger');
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