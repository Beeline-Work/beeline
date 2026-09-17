import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const searchParams = vi.hoisted(() => ({
  params: {
    workspaceId: 'workspace-1',
    viewerId: 'human-dani',
    connectorId: 'trusty-squire',
  } as Record<string, string>,
}));

vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => searchParams.params,
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

vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    HullSurface: host('HullSurface'),
    PixelLoader: host('PixelLoader'),
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

import ConnectTrustySquireScreen from './connect';
import { getWorkbenchSource, setWorkbenchSource } from '@/buzz/workbench-source';
import { MockWorkbenchSource } from '@/buzz/workbench-source.mock';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  setWorkbenchSource(new MockWorkbenchSource());
  searchParams.params = {
    workspaceId: 'workspace-1',
    viewerId: 'human-dani',
    connectorId: 'trusty-squire',
  };
});

afterEach(() => {
  vi.clearAllTimers();
});

async function render(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(ConnectTrustySquireScreen));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

/** One install poll per 700 ms of fake time, plus its microtask tail. */
async function advancePolls(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      vi.advanceTimersByTime(700);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

async function pair(renderer: ReactTestRenderer, helperId = 'helper-squire-box'): Promise<void> {
  await act(async () => {
    renderer.root.findByProps({ testID: `connect-machine-${helperId}` }).props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function untilSignin(renderer: ReactTestRenderer): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    if (renderer.root.findAllByProps({ testID: 'connect-sign-in' }).length) return;
    await advancePolls();
  }
  throw new Error('sign-in step never arrived');
}

describe('Connect Trusty Squire flow — ONE connect path', () => {
  it('with no connected machine, honestly says what to run and offers no picker', async () => {
    setWorkbenchSource(Object.assign(new MockWorkbenchSource(), { listHelpers: async () => [] }));
    const renderer = await render();
    const empty = renderer.root.findByProps({ testID: 'connect-no-helper' });
    expect(empty).toBeDefined();
    const texts = empty.findAll((node: any) => typeof node.props?.children === 'string');
    expect(texts.some((node: any) => node.props.children === 'npx usebeeline connect')).toBe(true);
    expect(renderer.root.findAllByProps({ testID: 'connect-machine-picker' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'connect-machine-helper-squire-box' })).toHaveLength(0);
  });

  it('with exactly one machine, still shows the explicit machine selector first', async () => {
    setWorkbenchSource(
      Object.assign(new MockWorkbenchSource(), {
        listHelpers: async () => [{ id: 'helper-squire-box', name: 'squire-box', online: true }],
      }),
    );
    const renderer = await render();
    expect(navigation.push).not.toHaveBeenCalled();
    // No install starts until the user picks the machine: the selector is
    // explicit even for a single-helper workspace.
    expect(renderer.root.findByProps({ testID: 'connect-machine-picker' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'connect-install-progress' })).toHaveLength(0);
  });

  it('with more than one machine, asks once with a single machine list', async () => {
    const renderer = await render();
    const online = renderer.root.findByProps({ testID: 'connect-machine-helper-squire-box' });
    expect(online.props.title).toBe('squire-box');
    expect(online.props.description).toBe('online');
    expect(online.props.action).toBe('install');
    expect(online.props.value).toBeUndefined();
    expect(online.props.disabled).toBe(false);
    const offline = renderer.root.findByProps({ testID: 'connect-machine-helper-office-mini' });
    expect(offline.props.value).toBe('offline');
    expect(offline.props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ testID: 'connect-helper-picker' })).toHaveLength(0);
  });

  it('the ONE Google entry pairs as Google Workspace and lands on the first tool', async () => {
    searchParams.params.connectorId = 'google';
    const renderer = await render();
    expect(
      renderer.root.findAllByProps({ testID: 'connect-machine-picker' }).length,
    ).toBeGreaterThan(0);
    // Install state polls through the resolved tool connector: the mock's
    // pair of `google` targets google-gmail, so its steps/sign-in arrive.
    await pair(renderer);
    await advancePolls(2);
    expect(renderer.root.findByProps({ testID: 'connect-install-progress' })).toBeDefined();
  });

  it('shows the machine’s step-by-step install progress and then the sign-in button', async () => {
    const renderer = await render();
    await pair(renderer);
    await advancePolls(2);
    expect(renderer.root.findByProps({ testID: 'connect-install-progress' })).toBeDefined();
    const active = renderer.root.findAll(
      (node: any) => node.props?.testID === 'connect-step-1-active',
    );
    expect(active.length).toBeGreaterThan(0);
    await untilSignin(renderer);
    expect(renderer.root.findByProps({ testID: 'connect-sign-in' })).toBeDefined();
  });

  it('sign-in is a full-screen route, never a browser call inside the step list', async () => {
    const renderer = await render();
    await pair(renderer);
    await untilSignin(renderer);
    await act(async () => {
      renderer.root.findByProps({ testID: 'connect-sign-in' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigation.push).toHaveBeenCalledTimes(1);
    const [route] = navigation.push.mock.calls[0] as [
      { pathname: string; params: Record<string, string> },
    ];
    expect(route.pathname).toBe('/beeline/settings/workbench/connect-signin');
    expect(route.params.method).toBe('streamed');
    expect(route.params.url).toContain('https://');
  });

  it('streams each step’s CLI command and captured output under the checklist', async () => {
    const renderer = await render();
    await pair(renderer);
    await advancePolls(2);
    const text = (n: any) => [n.props.children].flat().join('');
    expect(text(renderer.root.findByProps({ testID: 'connect-step-0-command' }))).toContain('squire status');
    expect(text(renderer.root.findByProps({ testID: 'connect-step-0-output' }))).toContain('ok');
    expect(text(renderer.root.findByProps({ testID: 'connect-step-1-command' }))).toContain('npm install');
  });

  it('the running step renders as a pulsing gold marker', async () => {
    const renderer = await render();
    await pair(renderer);
    await advancePolls(2);
    const pulsing = renderer.root.findAll((node: any) => node.props?.testID === undefined && node.type === 'PulsingText');
    expect(pulsing.length).toBeGreaterThan(0);
  });

  it('reports a failed step in red with the helper’s reason and Retry re-pairs', async () => {
    (getWorkbenchSource() as MockWorkbenchSource).failNextPair('trusty-squire');
    const renderer = await render();
    await pair(renderer);
    for (let tick = 0; tick < 12; tick += 1) {
      if (renderer.root.findAllByProps({ testID: 'connect-retry' }).length) break;
      await advancePolls();
    }
    expect(renderer.root.findByProps({ testID: 'connect-retry' })).toBeDefined();
    const failed = renderer.root.findByProps({ testID: 'connect-step-2-failed' });
    expect(failed).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: 'connect-step-2-reason' }).props.children,
    ).toContain('helper');
    expect(renderer.root.findAllByProps({ testID: 'connect-sign-in' })).toHaveLength(0);
    // The failed step carries its own captured output, so a failure never
    // hangs silently without something to debug.
    expect(renderer.root.findByProps({ testID: 'connect-step-2-output' }).props.children).toContain('npm ERR!');
    await act(async () => {
      renderer.root.findByProps({ testID: 'connect-retry' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ testID: 'connect-install-progress' }).length).toBe(0);
    await advancePolls(2);
    expect(renderer.root.findByProps({ testID: 'connect-install-progress' })).toBeDefined();
  });

  it('returns to the Workbench once the install reports connected', async () => {
    const renderer = await render();
    await pair(renderer);
    await untilSignin(renderer);
    for (let tick = 0; tick < 6; tick += 1) {
      if (navigation.replace.mock.calls.length) break;
      await advancePolls();
    }
    expect(navigation.replace).toHaveBeenCalledWith('/beeline/settings/workbench');
  });
});
