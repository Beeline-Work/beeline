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

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
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

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
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
  source = new MockWorkbenchSource();
  setWorkbenchSource(source);
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ConnectAppScreen));
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('Connect an app', () => {
  it('shows a searchable Popular picker with connected state and ink Connect buttons', async () => {
    source.setApps([{ id: 'app-gmail', key: 'gmail', name: 'Gmail', domain: 'gmail.com', transport: 'composio', status: 'connected', useCount: 0 }]);
    const renderer = await render();
    const header = renderer.root.findByProps({ testID: 'connect-app-header' });
    expect(header.props.eyebrow).toBe('Workbench');
    expect(header.props.title).toBe('Connect an app');
    expect(renderer.root.findAllByType('TextInput' as never)).toHaveLength(1);
    expect(renderer.root.findByProps({ testID: 'connect-app-gmail' }).findAllByType('TouchableOpacity' as never)).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'connect-app-slack' }).findAllByType('TouchableOpacity' as never)).toHaveLength(1);
    await act(async () => renderer.root.findByProps({ testID: 'connect-app-input' }).props.onChangeText('slack'));
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
    expect(signIn.open).toHaveBeenCalledWith('https://signin.example.test/one', { workspaceId: 'workspace-1', viewerId: 'human-dani' });
    expect(navigation.back).not.toHaveBeenCalled();
  });

  it('keeps the server error visible and never claims connection', async () => {
    source.connectApp = async () => { throw new Error('Sign-in is unavailable'); };
    const renderer = await render();
    await act(async () => { renderer.root.findByProps({ testID: 'connect-app-slack' }).findByType('TouchableOpacity' as never).props.onPress(); await Promise.resolve(); });
    expect(navigation.back).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('Sign-in is unavailable');
  });
});
