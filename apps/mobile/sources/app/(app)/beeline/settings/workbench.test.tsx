import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const layout = vi.hoisted(() => ({ desktop: false }));
const searchParams = vi.hoisted(() => ({
  params: { workspaceId: 'workspace-1', viewerId: 'human-dani' } as Record<string, string>,
}));
const focus = vi.hoisted(() => ({
  effect: undefined as undefined | (() => void | (() => void)),
}));
const appState = vi.hoisted(() => ({
  listener: undefined as undefined | ((state: string) => void),
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => searchParams.params,
  useFocusEffect: (effect: () => void | (() => void)) => {
    focus.effect = effect;
    React.useEffect(effect, [effect]);
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/utils/responsive', () => ({
  useIsDesktop: () => layout.desktop,
}));

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithUrl: 'https://server.example.test' }),
}));

vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: {
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appState.listener = listener;
        return { remove: () => undefined };
      },
    },
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    Image: host('Image'),
    Pressable: host('Pressable'),
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
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

import WorkbenchScreen from './workbench';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { setWalletSource } from '@/buzz/wallet-source';
import { MockWalletSource } from '@/buzz/wallet-source.mock';

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
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  focus.effect = undefined;
  appState.listener = undefined;
  layout.desktop = false;
  setWorkbenchSource(new MockWorkbenchSource());
  setWalletSource(new MockWalletSource());
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
  it('refetches edited and deleted keys after focus and Squire-flow returns', async () => {
    vi.useFakeTimers();
    const data = new MockWorkbenchSource();
    let vault = await data.readWorkbench({ workspaceId: 'workspace-1', viewerId: 'human-dani' });
    let cached = vault;
    let firstRead = true;
    const source = new MockWorkbenchSource();
    const reads: Array<{ refreshVault?: boolean }> = [];
    source.readWorkbench = async (input) => {
      reads.push(input);
      if (input.refreshVault) {
        if (firstRead) {
          firstRead = false;
          return cached;
        }
        return {
          ...cached,
          connections: cached.connections.map((connection) => ({ ...connection, stale: true })),
        };
      }
      cached = vault;
      return cached;
    };
    setWorkbenchSource(source);
    const renderer = await render();

    expect(reads.at(-1)?.refreshVault).toBe(true);
    expect(
      renderer.root.findByProps({ testID: 'workbench-connection-cred_vercel' }).props.title,
    ).toBe('vercel');
    vault = {
      ...vault,
      connections: vault.connections.map((connection) =>
        connection.ref === 'cred_vercel'
          ? {
              ...connection,
              service: 'vercel-renamed',
              name: 'Vercel renamed',
              hosts: ['api.vercel-renamed.example'],
            }
          : connection,
      ),
    };
    await act(async () => {
      appState.listener?.('active');
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });
    const edited = renderer.root.findByProps({ testID: 'workbench-connection-cred_vercel' });
    expect(edited.props.title).toBe('vercel-renamed');
    expect(edited.props.description).toBe('api.vercel-renamed.example');

    vault = {
      ...vault,
      connections: vault.connections.filter((entry) => entry.ref !== 'cred_vercel'),
    };
    await act(async () => {
      focus.effect?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
    });
    expect(
      renderer.root.findAllByProps({ testID: 'workbench-connection-cred_vercel' }),
    ).toHaveLength(0);
  });

  it('draws the shared page header on every surface: small Settings over large Workbench', async () => {
    layout.desktop = true;
    const desktopRenderer = await render();
    const desktopHeader = desktopRenderer.root.findByProps({ testID: 'workbench-header' });
    expect(desktopHeader.props.title).toBe('Workbench');
    expect(desktopHeader.props.eyebrow).toBe('Settings');
    expect(desktopHeader.props.onBack).toBeUndefined();

    layout.desktop = false;
    const phoneRenderer = await render();
    const phoneHeader = phoneRenderer.root.findByProps({ testID: 'workbench-header' });
    expect(phoneHeader.props.title).toBe('Workbench');
    expect(phoneHeader.props.eyebrow).toBe('Settings');
    expect(phoneHeader.props.onBack).toBeTypeOf('function');
  });

  it('renders one state or action for each tool row', async () => {
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(squire.props.title).toBe('Trusty Squire');
    expect(squire.props.leading.props.avatarUrl).toBe(
      'https://server.example.test/v1/connectors/logo/trusty-squire.svg',
    );
    expect(squire.props.value).toBeUndefined();
    expect(squire.props.action).toBe('Connect');
    expect(squire.props.trailingPress.testID).toBe(
      'workbench-connector-trusty-squire-connect',
    );
    const wallet = renderer.root.findByProps({ testID: 'workbench-connector-wallet-head' });
    expect(wallet.props.leading.props.avatarUrl).toBe(
      'https://server.example.test/v1/connectors/logo/wallet.svg',
    );
    expect(wallet.props.action).toBe('Connect');
    expect(wallet.props.value).toBeUndefined();
    const tailscale = renderer.root.findByProps({ testID: 'workbench-connector-tailscale-head' });
    expect(tailscale.props.value).toBeUndefined();
    expect(tailscale.props.action).toBe('Connect');
  });

  it('connects a tool from its row and keeps the accordion for the facts', async () => {
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    act(() => {
      squire.props.trailingPress.onPress();
    });
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(navigation.push.mock.calls[0][0].pathname).toBe('/beeline/settings/workbench/connect');
    expect(navigation.push.mock.calls[0][0].params.connectorId).toBe('trusty-squire');
    act(() => {
      squire.props.onPress();
    });
    const details = renderer.root.findByProps({
      testID: 'workbench-connector-trusty-squire-details',
    });
    const texts = details.findAll((node: any) => typeof node.props?.children === 'string');
    const prose = texts.map((node: any) => node.props.children);
    expect(prose).toContain(
      'With Trusty Squire, just by linking your Google account, Beeline agents can sign up for software services for you without you having to be involved.',
    );
  });

  it('keeps a Google account group with a separate Connect action per product', async () => {
    const renderer = await render();
    const entry = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(entry.props.title).toBe('Google Workspace');
    expect(entry.props.leading.props.company).toBe('google');
    expect(entry.props.leading.props.domain).toBe('google.com');
    expect(entry.props.value).toBeUndefined();
    expect(entry.props.action).toBe('Connect');
    expect(entry.props.trailingPress.testID).toBe('google-entry-connect');
    act(() => entry.props.trailingPress.onPress());
    expect(navigation.push.mock.calls.at(-1)![0].params.connectorId).toBe('google');
    act(() => entry.props.onPress());
    const gmail = renderer.root.findByProps({ testID: 'google-tool-google-gmail' });
    expect(gmail.props.action).toBe('Connect');
    act(() => gmail.props.trailingPress.onPress());
    const push = navigation.push.mock.calls.at(-1)![0];
    expect(push.pathname).toBe('/beeline/settings/workbench/connect');
    expect(push.params.connectorId).toBe('google-gmail');
  });

  it('collapses an expanded cell on a second tap', async () => {
    const renderer = await render();
    const row = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    act(() => row.props.onPress());
    expect(
      renderer.root.findAllByProps({ testID: 'workbench-connector-trusty-squire-details' }).length,
    ).toBeGreaterThan(0);
    act(() =>
      renderer.root
        .findByProps({ testID: 'workbench-connector-trusty-squire-head' })
        .props.onPress(),
    );
    expect(
      renderer.root.findAllByProps({ testID: 'workbench-connector-trusty-squire-details' }),
    ).toHaveLength(0);
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

  it('titles a key row with its vault service and puts the domains under the name', async () => {
    const renderer = await render();
    const vercel = renderer.root.findByProps({ testID: 'workbench-connection-cred_vercel' });
    expect(vercel.props.title).toBe('vercel');
    expect(vercel.props.description).toBe('api.vercel.com');
    expect(vercel.props.leading.props.company).toBe('vercel');
    expect(vercel.props.leading.props.domain).toBe('vercel.com');
    expect(vercel.props.leading.props.testID).toBe('workbench-connection-cred_vercel-mark');
    // A key with no hosts draws no quiet line rather than a `—` placeholder.
    // Its server-derived favicon domain is `null`, so the mark keeps its
    // lettermark and fetches nothing.
    const google = renderer.root.findByProps({ testID: 'workbench-connection-cred_google' });
    expect(google.props.title).toBe('google');
    expect(google.props.description).toBeUndefined();
    expect(google.props.leading.props.company).toBe('google');
    expect(google.props.leading.props.domain).toBeUndefined();
  });

  it('titles a key by its vault service, never the vault label', async () => {
    const renderer = await render();
    // `Work key`, no hosts, service `github`: the row names the SERVICE, not
    // the label, and the mark reads `G` from that service.
    const github = renderer.root.findByProps({ testID: 'workbench-connection-cred_github' });
    expect(github.props.title).toBe('github');
    expect(github.props.description).toBeUndefined();
    expect(github.props.leading.props.company).toBe('github');
    expect(github.props.leading.props.domain).toBeUndefined();
  });

  it('gives a key row the same state instrument the tool rows carry', async () => {
    const renderer = await render();
    const vercel = renderer.root.findByProps({ testID: 'workbench-connection-cred_vercel' });
    expect(vercel.props.value).toBe('active');
    expect(vercel.props.statusGlyph).toBe('live');
    expect(vercel.props.valueTone).toBeUndefined();
  });

  it('shows the none-yet state with a short sovereignty note for a member with no connections', async () => {
    searchParams.params = { workspaceId: 'workspace-1', viewerId: 'human-terra' };
    const renderer = await render();
    const empty = renderer.root.findByProps({ testID: 'workbench-connections-empty' });
    expect(empty.props.title).toBe('None yet');
    expect(empty.props.description).toBeUndefined();
    expect(
      renderer.root.findAllByProps({ testID: 'workbench-connection-cred_vercel' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: 'workbench-connection-cred_google' }),
    ).toHaveLength(0);
  });

  it('shows the exact error and reuses Connect as recovery', async () => {
    const source = new MockWorkbenchSource();
    source.failNextPair('trusty-squire');
    setWorkbenchSource(source);
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(squire.props.value).toBeUndefined();
    expect(squire.props.action).toBe('Connect');
    expect(squire.props.description).toBe(
      'another Trusty Squire session is already using the browser — close it first',
    );
    expect(squire.props.descriptionTone).toBe('danger');
  });

  it('paints a failed Google tool as its own breakage with its own error', async () => {
    const source = new MockWorkbenchSource();
    source.failNextPair('trusty-squire');
    source.failNextPair('google-gmail');
    setWorkbenchSource(source);
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(squire.props.description).toContain(
      'another Trusty Squire session is already using the browser',
    );
    expect(squire.props.action).toBe('Connect');
    const google = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(google.props.title).toBe('Google Workspace');
    expect(google.props.action).toBe('Connect');
    expect(google.props.descriptionTone).toBe('danger');
    expect(google.props.description).toContain(
      'another Trusty Squire session is already using the browser',
    );
    act(() => google.props.onPress());
    const gmail = renderer.root.findByProps({ testID: 'google-tool-google-gmail' });
    expect(gmail.props.action).toBe('Connect');
    expect(gmail.props.descriptionTone).toBe('danger');
  });

  it('creates a wallet from Connect and opens the dashboard', async () => {
    const renderer = await render();
    const wallet = renderer.root.findByProps({ testID: 'workbench-connector-wallet-head' });
    await act(async () => {
      await wallet.props.trailingPress.onPress();
    });
    expect(navigation.push.mock.calls.at(-1)![0]).toEqual({
      pathname: '/beeline/settings/workbench/wallet',
      params: { workspaceId: 'workspace-1' },
    });
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

  it('offers adapter reconnect and disconnect on a connected Squire row', async () => {
    const source = new MockWorkbenchSource();
    await source.pairConnector({
      workspaceId: 'workspace-1',
      connectorId: 'trusty-squire',
      helperId: 'helper-squire-box',
    });
    setWorkbenchSource(source);
    const renderer = await render();
    const squire = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(squire.props.action).toBeUndefined();
    expect(squire.props.value).toBe('connected');
    act(() => squire.props.onPress());
    expect(
      renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-reconnect' }).props
        .title,
    ).toBe('Reconnect');
    expect(
      renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-disconnect' }).props
        .title,
    ).toBe('Disconnect');
    await act(async () => {
      renderer.root.findByProps({
        testID: 'workbench-connector-trusty-squire-disconnect',
      }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const after = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(after.props.action).toBe('Connect');
  });
});
