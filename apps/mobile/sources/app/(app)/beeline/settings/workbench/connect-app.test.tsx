vi.mock('@expo/vector-icons', async () => { const R = await import('react'); return { Ionicons: (props: any) => R.createElement('Ionicons', props) }; });
vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const searchParams = vi.hoisted(() => ({
  params: {
    workspaceId: 'workspace-1',
    viewerId: 'human-dani',
  } as Record<string, string>,
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => searchParams.params,
}));

vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: async () => 'https://relay.test',
  loadBuzzIdentity: async () => ({ publicKey: 'human-dani' }),
}));
vi.mock('@/buzz/surface-storage', async () =>
  (await import('@/test/mock-surface-storage')).mockSurfaceStorage());

vi.mock('@/components/buzz/Button', async () => {
  const R = await import('react');
  // The one Button, as a host press target carrying its label.
  return {
    Button: ({ label, ...props }: any) =>
      R.createElement('TouchableOpacity', { ...props, label }, R.createElement('Text', null, label)),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style) : style,  create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    Image: host('Image'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
    ActivityIndicator: host('ActivityIndicator'),
    Animated: {
      View: host('Animated.View'),
      Text: host('Animated.Text'),
      Value: class {
        value = 1;
        setValue(v: number) {
          this.value = v;
        }
        interpolate() {
          return {};
        }
      },
      loop: () => ({ start: () => {}, stop: () => {} }),
      sequence: (...args: unknown[]) => args,
      timing: () => ({ start: () => {}, stop: () => {} }),
    },
  };
});

vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return {
    SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props),
  };
});

vi.mock('@/components/buzz/PageHeader', async () => {
  const ReactModule = await import('react');
  return {
    PageHeader: (props: any) => ReactModule.createElement('PageHeader', props),
  };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

const signIn = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/buzz/app-sign-in', () => ({ openAppSignIn: signIn.open }));

const safeArea = vi.hoisted(() => ({ bottom: 0 }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: safeArea.bottom, left: 0 }),
}));

vi.mock('@/components/buzz/PulsingText', async () => {
  const ReactModule = await import('react');
  return {
    PulsingText: (props: any) => ReactModule.createElement('PulsingText', props),
  };
});

import ConnectAppScreen from './connect-app';
import { setWorkbenchSource } from '@/buzz/workbench-source';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';
import { mobileSurfaceCache } from '@/buzz/surface-storage';

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
afterEach(() => vi.clearAllMocks());

let source: MockWorkbenchSource;
beforeEach(() => {
  mobileSurfaceCache.clear();
  source = new MockWorkbenchSource();
  setWorkbenchSource(source);
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ConnectAppScreen));
    await Promise.resolve();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  return renderer;
}

async function search(renderer: ReactTestRenderer, query: string): Promise<void> {
  await act(async () => renderer.root.findByProps({ testID: 'connect-app-input' }).props.onChangeText(query));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)); });
}

describe('Connect an app', () => {
  it('Reproduction 9e6bb32e: shows an empty search and no Connect action for the screenshot query', async () => {
    const renderer = await render();
    await search(renderer, 'fuckface');
    expect(renderer.root.findAllByProps({ testID: 'connect-app-fuckface' })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('No connections found');
    expect(renderer.root.findAllByProps({ label: 'Connect' })).toHaveLength(0);
    expect(source.appRequests).toHaveLength(0);
  });

  it('finds Resend beyond Popular and connects the selected result', async () => {
    const renderer = await render();
    await search(renderer, 'resend');
    await act(async () => { renderer.root.findByProps({ testID: 'connect-app-resend' })
      .findByType('TouchableOpacity' as never).props.onPress(); await Promise.resolve(); });
    expect(source.appRequests).toEqual([{ app: 'Resend', helperId: 'helper-squire-box' }]);
  });
  it('centres the search text in its bordered box without the dialog rule', async () => {
    const renderer = await render();
    const input = renderer.root.findAll((node: any) => node.type === 'TextInput' && node.props.testID === 'connect-app-input')[0]!;
    const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity as 1).filter(Boolean));
    let rule = input.parent!;
    while (rule.type !== 'View') rule = rule.parent!;
    const wrapper = flat(rule.props.style);
    expect(wrapper.marginTop).toBe(0);
    expect(wrapper.borderBottomWidth).toBe(0);
    const field = flat(input.props.style);
    expect(field.minHeight).toBe(0);
    expect(field.paddingVertical).toBe(0);
  });
  it('lets its last item scroll clear of the system navigation bar', async () => {
    safeArea.bottom = 48;
    try {
      const renderer = await render();
      const scroll = renderer.root.findByProps({ testID: 'connect-app-scroll' });
      const contentStyle = Object.assign({}, ...[scroll.props.contentContainerStyle].flat(Infinity as 1));
      expect(contentStyle.paddingBottom).toBe(0 + 48);
    } finally {
      safeArea.bottom = 0;
    }
  });

  it('shows the Gmail recommendation with its provider mark', async () => {
    source.setAppCatalog([{ appKey: 'gmail', description: 'Read and send Gmail messages.',
      logo: 'https://cdn.composio.dev/gmail.png' }]);
    const renderer = await render();
    expect(JSON.stringify(renderer.toJSON())).toContain('Sign in to Gmail');
    expect(renderer.root.findAllByType('Image' as never).length).toBeGreaterThan(0);
  });

  it('warns about Instagram account requirements before connecting a searched app', async () => {
    const renderer = await render();
    await search(renderer, 'Instagram');
    expect(renderer.root.findByProps({ testID: 'connect-app-instagram' })).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain('Business or Creator account linked to a Facebook Page');
  });

  it('shows a searchable recommendation list with connected state', async () => {
    source.setApps([{ id: 'app-gmail', key: 'gmail', name: 'Gmail', domain: 'gmail.com', transport: 'composio', status: 'connected', useCount: 0 }]);
    const renderer = await render();
    const header = renderer.root.findByProps({ testID: 'connect-app-header' });
    expect(header.props.eyebrow).toBe('Connectors');
    expect(header.props.title).toBe('Search');
    expect(renderer.root.findAllByType('TextInput' as never)).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'connect-app-gmail' }).findAllByType('TouchableOpacity' as never)).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'connect-app-slack' }).findAllByType('TouchableOpacity' as never)).toHaveLength(1);
    await search(renderer, 'slack');
    expect(renderer.root.findAllByProps({ testID: 'connect-app-gmail' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'connect-app-slack' }).length).toBeGreaterThan(0);
  });

  it('connects the selected app through the authenticated source', async () => {
    const renderer = await render();
    await act(async () => { renderer.root.findByProps({ testID: 'connect-app-slack' }).findByType('TouchableOpacity' as never).props.onPress(); await Promise.resolve(); });
    expect(source.appRequests).toEqual([{ app: 'Slack', helperId: 'helper-squire-box' }]);
    expect(navigation.back).toHaveBeenCalledTimes(1);
  });

  it('opens the server-issued sign-in URL without showing a route', async () => {
    source.connectApp = async () => ({ appId: 'app-slack', authorizationUrl: 'https://signin.example.test/one' });
    const renderer = await render();
    await act(async () => { renderer.root.findByProps({ testID: 'connect-app-slack' }).findByType('TouchableOpacity' as never).props.onPress(); await Promise.resolve(); });
    expect(signIn.open).toHaveBeenCalledWith('https://signin.example.test/one', { workspaceId: 'workspace-1', viewerId: 'human-dani', appId: 'app-slack' });
    expect(navigation.back).not.toHaveBeenCalled();
  });

  it('keeps the server error visible and never claims connection', async () => {
    source.connectApp = async () => { throw new Error('Monolith beginAppSignIn failed (503): App provider request failed (403)'); };
    const renderer = await render();
    await act(async () => { renderer.root.findByProps({ testID: 'connect-app-slack' }).findByType('TouchableOpacity' as never).props.onPress(); await Promise.resolve(); });
    expect(navigation.back).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('The app provider refused this connection (403).');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Monolith');
  });

  it('opens the detail for a connected app from search', async () => {
    source.setApps([{ id: 'app-gmail', key: 'gmail', name: 'Gmail', transport: 'composio', status: 'connected', useCount: 0 }]);
    const renderer = await render();
    await act(async () => { renderer.root.findByProps({ testID: 'connect-app-gmail' }).props.onPress(); await Promise.resolve(); });
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/beeline/settings/workbench/app',
      params: { workspaceId: 'workspace-1', viewerId: 'human-dani', appId: 'app-gmail' } });
  });
});
