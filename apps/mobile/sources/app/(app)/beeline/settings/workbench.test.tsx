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
    Animated: {
      Value: (v: number) => ({
        _value: v,
        add: () => ({ _value: v }),
        interpolate: () => ({ _value: v }),
      }),
      timing: () => ({ start: () => undefined }),
      sequence: () => ({ start: () => undefined }),
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      View: host('Animated.View'),
    },
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
    // Board revision 2: the not-connected tool carries its ONE compact side
    // Connect button on the row — no state word beside it.
    expect(squire.props.value).toBeUndefined();
    expect(squire.props.actionControl).toMatchObject({
      label: 'Connect',
      testID: 'workbench-connector-trusty-squire-connect',
    });
    // The wallet row stays the `soon` fact: value only, no dot, no control.
    const wallet = renderer.root.findByProps({ testID: 'workbench-connector-wallet-head' });
    expect(wallet.props.value).toBe('soon');
    expect(wallet.props.actionControl).toBeUndefined();
    expect(wallet.props.statusGlyph).toBeUndefined();
    expect(
      renderer.root.findByProps({ testID: 'workbench-connector-tailscale' }).props.value,
    ).toBe('soon');
    expect(
      renderer.root.findByProps({ testID: 'workbench-connector-tailscale' }).props.actionControl,
    ).toBeUndefined();
  });

  it('connects a tool from its row and keeps the accordion for the facts', async () => {
    const renderer = await render();
    // The side Connect button exists on the collapsed row without expanding.
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    act(() => {
      squire.props.actionControl.onPress();
    });
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push.mock.calls[0][0].pathname).toBe('/beeline/settings/workbench/connect');
    expect(navigation.push.mock.calls[0][0].params.connectorId).toBe('trusty-squire');
    // The expanded pane carries the value proposition and named facts —
    // no full-width Connect button inside it anymore.
    act(() => {
      squire.props.onPress();
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
  });

  it('folds the four Google tool rows into the ONE Google entry whose Connect button sits on the row', async () => {
    const renderer = await render();
    // Exactly ONE Google row; the four tool kinds never render their own rows.
    const entry = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(entry.props.title).toBe('Google Workspace');
    expect(entry.props.value).toBeUndefined();
    expect(entry.props.actionControl).toMatchObject({
      label: 'Connect',
      testID: 'google-entry-connect',
    });
    expect(renderer.root.findAllByProps({ testID: /^google-entry-tool-/ })).toHaveLength(0);
    // The entry hands off with the LOGICAL google id; the source resolves it
    // to the first not-yet-connected tool before the server call.
    act(() => {
      entry.props.actionControl.onPress();
    });
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

  it('renders the error tone and failed dot for a connector in error state', async () => {
    const source = new MockWorkbenchSource();
    source.failNextPair('trusty-squire');
    setWorkbenchSource(source);
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(squire.props.value).toBe('error');
    expect(squire.props.valueTone).toBe('danger');
    expect(squire.props.statusGlyph).toBe('failed');
    // The dot itself renders inside the real SettingsRow (mocked here).
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