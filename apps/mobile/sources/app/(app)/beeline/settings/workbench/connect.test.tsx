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
  it('an in-chat offer resumes the already paired install instead of asking for a helper again', async () => {
    searchParams.params = {
      workspaceId: 'workspace-1',
      viewerId: 'human-dani',
      connectorId: 'trusty-squire',
      pairedConnectorId: 'connector-row-1',
      offerId: 'offer-1',
      roomId: 'room-1',
    };
    const listHelpers = vi.fn(async () => {
      throw new Error('the offer already chose its helper');
    });
    const readInstallState = vi.fn(async () => ({
      connectorId: 'connector-row-1',
      helperName: 'squire-box',
      steps: [{ label: 'waiting for sign-in', status: 'active' as const }],
      signIn: { method: 'streamed' as const, url: 'https://signin.example.test' },
      connected: false,
    }));
    setWorkbenchSource(Object.assign(new MockWorkbenchSource(), { listHelpers, readInstallState }));

    const renderer = await render();
    expect(listHelpers).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'connect-machine-picker' })).toHaveLength(0);
    await advancePolls();
    expect(readInstallState).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      connectorId: 'connector-row-1',
    });
    expect(renderer.root.findByProps({ testID: 'connect-install-progress' })).toBeDefined();
  });

  it('with no connected machine, honestly says what to run and offers no picker', async () => {
    setWorkbenchSource(Object.assign(new MockWorkbenchSource(), { listHelpers: async () => [] }));
    const renderer = await render();
    const empty = renderer.root.findByProps({ testID: 'connect-no-helper' });
    expect(empty).toBeDefined();
    const texts = empty.findAll((node: any) => typeof node.props?.children === 'string');
    expect(texts.some((node: any) => node.props.children === 'npx usebeeline connect')).toBe(true);
    expect(renderer.root.findAllByProps({ testID: 'connect-machine-picker' })).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: 'connect-machine-helper-squire-box' }),
    ).toHaveLength(0);
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
    expect(online.props.action).toBe('pair');
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
    expect(renderer.root.findByProps({ testID: 'connect-selected-machine' }).props.children)
      .toBe('squire-box');
    await advancePolls(2);
    expect(renderer.root.findByProps({ testID: 'connect-install-progress' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'connect-selected-machine' }).props.children)
      .toBe('squire-box');
    const active = renderer.root.findAll(
      (node: any) => node.props?.testID === 'connect-step-1-active',
    );
    expect(active.length).toBeGreaterThan(0);
    await untilSignin(renderer);
    expect(renderer.root.findByProps({ testID: 'connect-sign-in' })).toBeDefined();
  });

  it('names Tailscale on its sign-in action and passes that name to the overlay', async () => {
    searchParams.params.connectorId = 'tailscale';
    const renderer = await render();
    await pair(renderer);
    await untilSignin(renderer);
    const button = renderer.root.findByProps({ testID: 'connect-sign-in' });
    expect(button.findByType('Text').props.children).toEqual(['Sign in to ', 'Tailscale']);

    await act(async () => {
      button.props.onPress();
      await Promise.resolve();
    });
    expect(navigation.push.mock.calls.at(-1)?.[0].params.connectorName).toBe('Tailscale');
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
    expect(route.params.connectorName).toBe('Trusty Squire');
    expect(route.params.machineName).toBe('squire-box');
  });

  it('shows where the sign-in page opened, from the helper report', async () => {
    searchParams.params = {
      workspaceId: 'workspace-1',
      viewerId: 'human-dani',
      connectorId: 'trusty-squire',
      pairedConnectorId: 'connector-row-1',
    };
    const readInstallState = vi.fn(async () => ({
      connectorId: 'connector-row-1',
      helperName: 'squire-box',
      steps: [{ label: 'waiting for sign-in', status: 'active' as const }],
      signIn: {
        method: 'streamed' as const,
        url: 'https://trustysquire.ai/install?token=secret',
        browserLocation: { kind: 'virtual' as const, url: 'https://tunnel.example.test/#p=x' },
      },
      connected: false,
    }));
    setWorkbenchSource(Object.assign(new MockWorkbenchSource(), { readInstallState }));
    const renderer = await render();
    await advancePolls();
    const line = renderer.root.findByProps({ testID: 'connect-sign-in-location' });
    expect([line.props.children].flat().join('')).toBe(
      'Sign-in page opened on a virtual display · https://tunnel.example.test/#p=x',
    );
  });

  it('streams each step’s CLI command and captured output under the checklist', async () => {
    const renderer = await render();
    await pair(renderer);
    await advancePolls(2);
    const text = (n: any) => [n.props.children].flat().join('');
    expect(text(renderer.root.findByProps({ testID: 'connect-step-0-command' }))).toContain(
      'squire status',
    );
    expect(text(renderer.root.findByProps({ testID: 'connect-step-0-output' }))).toContain('ok');
    expect(text(renderer.root.findByProps({ testID: 'connect-step-1-command' }))).toContain(
      'npm install',
    );
  });

  it('the running step renders as a pulsing gold marker', async () => {
    const renderer = await render();
    await pair(renderer);
    await advancePolls(2);
    const pulsing = renderer.root.findAll(
      (node: any) => node.props?.testID === undefined && node.type === 'PulsingText',
    );
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
    expect(renderer.root.findByProps({ testID: 'connect-step-2-reason' }).props.children).toContain(
      'helper',
    );
    expect(renderer.root.findAllByProps({ testID: 'connect-sign-in' })).toHaveLength(0);
    // The failed step carries its own captured output, so a failure never
    // hangs silently without something to debug.
    expect(renderer.root.findByProps({ testID: 'connect-step-2-output' }).props.children).toContain(
      'npm ERR!',
    );
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

  it('returns an in-chat offer ceremony to its Room once the helper reports connected', async () => {
    searchParams.params = {
      workspaceId: 'workspace-1',
      viewerId: 'human-dani',
      connectorId: 'trusty-squire',
      pairedConnectorId: 'connector-row-1',
      offerId: 'offer-1',
      roomId: 'room-1',
    };
    const readInstallState = vi.fn(async () => ({
      connectorId: 'connector-row-1',
      helperName: 'squire-box',
      steps: [{ label: 'connected', status: 'done' as const }],
      connected: true,
    }));
    setWorkbenchSource(Object.assign(new MockWorkbenchSource(), { readInstallState }));
    await render();
    await advancePolls();
    expect(navigation.replace).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'room-1' },
    });
  });

  describe('failure surfaces — never a silent stall', () => {
    async function untilError(renderer: ReactTestRenderer): Promise<void> {
      for (let tick = 0; tick < 24; tick += 1) {
        if (renderer.root.findAllByProps({ testID: 'connect-error' }).length) return;
        await advancePolls();
      }
      throw new Error('connect-error never appeared');
    }

    it('surfaces a pair POST that never settles, and still follows a late resolve', async () => {
      let resolvePair: () => void = () => {};
      const base = new MockWorkbenchSource();
      const realPair = base.pairConnector.bind(base);
      setWorkbenchSource(
        Object.assign(base, {
          pairConnector: (input: Parameters<typeof realPair>[0]) =>
            new Promise<{ connectorId: string }>((resolve) => {
              resolvePair = () => {
                void realPair(input).then(resolve);
              };
            }),
        }),
      );
      const renderer = await render();
      await act(async () => {
        renderer.root.findByProps({ testID: 'connect-machine-helper-squire-box' }).props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findAllByProps({ testID: 'connect-error' })).toHaveLength(0);
      // The transport sets no timeout of its own: the hung await must reach
      // the user through the one error channel, not sit on the picker.
      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(renderer.root.findByProps({ testID: 'connect-error' }).props.children).toContain(
        'pairing',
      );
      // A late resolve still starts the poll and clears the stale notice.
      await act(async () => {
        resolvePair();
        await Promise.resolve();
        await Promise.resolve();
      });
      await advancePolls(2);
      expect(renderer.root.findByProps({ testID: 'connect-install-progress' })).toBeDefined();
      expect(renderer.root.findAllByProps({ testID: 'connect-error' })).toHaveLength(0);
    });

    it('surfaces an install row that never appears instead of polling null forever', async () => {
      setWorkbenchSource(
        Object.assign(new MockWorkbenchSource(), { readInstallState: async () => null }),
      );
      const renderer = await render();
      await pair(renderer);
      await untilError(renderer);
      expect(renderer.root.findByProps({ testID: 'connect-error' }).props.children).toContain(
        'Lost track',
      );
    });

    it('surfaces an install poll that keeps failing instead of swallowing errors', async () => {
      setWorkbenchSource(
        Object.assign(new MockWorkbenchSource(), {
          readInstallState: async () => {
            throw new Error('transport gone');
          },
        }),
      );
      const renderer = await render();
      await pair(renderer);
      await untilError(renderer);
      expect(renderer.root.findByProps({ testID: 'connect-error' }).props.children).toContain(
        'Lost contact',
      );
    });
  });
});
