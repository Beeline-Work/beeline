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
  it('asks only for the app and the machine — never for a route', async () => {
    const renderer = await render();
    const header = renderer.root.findByProps({ testID: 'connect-app-header' });
    expect(header.props.eyebrow).toBe('Workbench');
    expect(header.props.title).toBe('Connect an app');
    expect(renderer.root.findAllByType('TextInput' as never)).toHaveLength(1);
    const rows = renderer.root.findAll(
      (node: any) =>
        node.type === 'SettingsRow' &&
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('connect-app-machine-'),
    );
    expect(rows.length).toBeGreaterThan(0);
    // Nothing is connectable until the app is named.
    expect(rows.every((row: any) => row.props.disabled === true)).toBe(true);
  });

  it('connects the named app on the chosen machine and returns to Workbench', async () => {
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'connect-app-input' }).props.onChangeText(' Linear ');
    });
    const [online] = renderer.root.findAll(
      (node: any) =>
        node.type === 'SettingsRow' &&
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('connect-app-machine-') &&
        node.props.disabled === false,
    );
    expect(online.props.action).toBe('connect');
    await act(async () => {
      online.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(source.appRequests).toEqual([
      { app: 'Linear', helperId: online.props.testID.replace('connect-app-machine-', '') },
    ]);
    expect(navigation.back).toHaveBeenCalledTimes(1);
  });

  it('keeps the person on the page with the server’s reason when connecting fails', async () => {
    source.connectApp = async () => {
      throw new Error('The MCP Registry could not be searched, so no route was chosen.');
    };
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'connect-app-input' }).props.onChangeText('Linear');
    });
    const [online] = renderer.root.findAll(
      (node: any) =>
        node.type === 'SettingsRow' &&
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('connect-app-machine-') &&
        node.props.disabled === false,
    );
    await act(async () => {
      online.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigation.back).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'connect-app-error' }).props.children).toBe(
      'The MCP Registry could not be searched, so no route was chosen.',
    );
  });
});
