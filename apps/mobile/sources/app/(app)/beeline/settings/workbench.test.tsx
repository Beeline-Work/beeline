import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const layout = vi.hoisted(() => ({ desktop: false }));
const searchParams = vi.hoisted(() => ({
  params: { workspaceId: 'workspace-1', viewerId: 'human-dani' } as Record<string, string>,
}));
const workspace = vi.hoisted(() => ({
  resolve: vi.fn(async (id?: string): Promise<string | null> => id || 'workspace-1'),
}));
vi.mock('@/buzz/wallet-workspace', () => ({ resolveWalletWorkspaceId: workspace.resolve }));
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
  workspace.resolve.mockImplementation(async (id?: string) => id || 'workspace-1');
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
    expect(desktopHeader.props.onBack).toBeTypeOf('function');

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
    expect(squire.props.leading.props.style).toBeTruthy();
    expect(squire.props.value).toBeUndefined();
    expect(squire.props.action).toBe('Connect');
    expect(squire.props.trailingPress.testID).toBe('workbench-connector-trusty-squire-connect');
    const wallet = renderer.root.findByProps({ testID: 'workbench-connector-wallet-head' });
    expect(wallet.props.leading.props.style).toBeTruthy();
    expect(wallet.props.action).toBe('Connect');
    expect(wallet.props.value).toBeUndefined();
    expect(renderer.root.findAllByProps({ testID: 'workbench-connector-tailscale-head' })).toHaveLength(0);
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

  it('removes the Google Workspace tool row; Google products connect as apps', async () => {
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'google-entry-row' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'workbench-connector-google-gmail-head' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'workbench-connect-app' })).toBeTruthy();
  });

  it('shows connected apps as rows before the one Connect an app action', async () => {
    const source = new MockWorkbenchSource();
    source.setApps([
      { id: 'app-gmail', key: 'gmail', name: 'Gmail', domain: 'gmail.com', transport: 'composio', status: 'connected', useCount: 1 },
      { id: 'app-slack', key: 'slack', name: 'Slack', domain: 'slack.com', transport: 'composio', status: 'connected', useCount: 2 },
    ]);
    setWorkbenchSource(source);
    const renderer = await render();
    const connect = renderer.root.findByProps({ testID: 'workbench-connect-app' });
    const gmail = renderer.root.findByProps({ testID: 'workbench-app-gmail' });
    const slack = renderer.root.findByProps({ testID: 'workbench-app-slack' });
    expect(gmail.props.title).toBe('Gmail');
    expect(slack.props.value).toBe('connected');
    expect(connect.props.title).toBe('Connect an app');
    expect(renderer.root.findAllByProps({ testID: 'workbench-connector-composio' })).toHaveLength(0);
    act(() => gmail.props.onPress());
    expect(navigation.push.mock.calls.at(-1)![0]).toMatchObject({ pathname: '/beeline/settings/workbench/app', params: { appId: 'app-gmail' } });
    act(() => connect.props.onPress());
    expect(navigation.push.mock.calls.at(-1)![0].pathname).toBe('/beeline/settings/workbench/connect-app');
  });

  it('shows the five reported Android rows with app marks and the failed state', async () => {
    const source = new MockWorkbenchSource();
    source.setApps(['Neon', 'Notion', 'Linear', 'YouTube', 'Runway'].map((name, index) => ({
      id: `app-${name.toLowerCase()}`, key: name.toLowerCase(), name,
      logo: 'https://invalid.example/logo.png', transport: 'composio' as const,
      status: index === 4 ? 'error' as const : 'connected' as const,
      ...(index === 4 ? { errorMessage: 'App provider request failed (403)' } : {}),
      useCount: 0,
    })));
    setWorkbenchSource(source);
    const renderer = await render();
    for (const name of ['Neon', 'Notion', 'Linear', 'YouTube', 'Runway']) {
      const row = renderer.root.findByProps({ testID: `workbench-app-${name.toLowerCase()}` });
      expect(row.findByType('Image').props.source.uri).toBeUndefined();
      expect(row.findAllByType('Text').some((text: { props: { children: unknown } }) => text.props.children === name[0])).toBe(false);
    }
    expect(renderer.root.findByProps({ testID: 'workbench-app-runway' }).props.value).toBe('error');
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
      'TOOLS',
    );
    expect(renderer.root.findByProps({ testID: 'workbench-keys-head' }).props.children).toBe(
      'KEYS',
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
    expect(renderer.root.findAllByProps({ testID: 'workbench-connections' })).toHaveLength(0);
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

  it('does not restore a Google Workspace row after a tool error', async () => {
    const source = new MockWorkbenchSource();
    source.failNextPair('trusty-squire');
    source.failNextPair('google-gmail');
    setWorkbenchSource(source);
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'google-entry-row' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'workbench-connect-app' })).toBeTruthy();
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

  it('resolves a Workspace for the personal Settings entry before opening Wallet', async () => {
    searchParams.params = { viewerId: 'human-dani' };
    const renderer = await render();
    const wallet = renderer.root.findByProps({ testID: 'workbench-connector-wallet-head' });
    await act(async () => {
      await wallet.props.trailingPress.onPress();
    });
    expect(workspace.resolve).toHaveBeenCalledWith('');
    expect(navigation.push.mock.calls.at(-1)![0].params.workspaceId).toBe('workspace-1');
  });

  it('opens an already connected Wallet from a Workspace-bearing chat entry', async () => {
    const source = new MockWorkbenchSource();
    const read = source.readWorkbench.bind(source);
    source.readWorkbench = async (input) => {
      const view = await read(input);
      return {
        ...view,
        connectors: view.connectors.map((connector) =>
          connector.id === 'wallet' ? { ...connector, status: 'connected' as const } : connector,
        ),
      };
    };
    setWorkbenchSource(source);
    const renderer = await render();
    await act(async () => {
      await renderer.root.findByProps({ testID: 'workbench-connector-wallet-head' }).props.onPress();
    });
    expect(workspace.resolve).toHaveBeenCalledWith('workspace-1');
    expect(navigation.push.mock.calls.at(-1)![0].params.workspaceId).toBe('workspace-1');
  });

  it('does not create or open Wallet when the viewer has no Workspace', async () => {
    searchParams.params = { viewerId: 'human-dani' };
    workspace.resolve.mockResolvedValue(null);
    const source = new MockWalletSource();
    const createWallet = vi.spyOn(source, 'createWallet');
    setWalletSource(source);
    const renderer = await render();
    await act(async () => {
      await renderer.root
        .findByProps({ testID: 'workbench-connector-wallet-head' })
        .props.trailingPress.onPress();
    });
    expect(createWallet).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ testID: 'workbench-wallet-workspace-missing' }),
    ).toBeTruthy();
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
      renderer.root
        .findByProps({
          testID: 'workbench-connector-trusty-squire-disconnect',
        })
        .props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const after = renderer.root.findByProps({ testID: 'workbench-connector-trusty-squire-head' });
    expect(after.props.action).toBe('Connect');
  });
});
