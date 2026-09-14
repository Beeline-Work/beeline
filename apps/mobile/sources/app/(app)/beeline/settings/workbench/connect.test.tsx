import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const webBrowser = vi.hoisted(() => ({
  openBrowserAsync: vi.fn(async () => 'closed'),
  openAuthSessionAsync: vi.fn(async () => 'closed'),
}));
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

vi.mock('expo-web-browser', () => webBrowser);

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

import ConnectTrustySquireScreen from './connect';
import { getWorkbenchSource, setWorkbenchSource } from '@/buzz/workbench-source';

type MockHooks = {
  failNextPair(connectorId: string): void;
  setSignInMethod(method: 'streamed' | 'oauth' | undefined): void;
};

const mockHooks = (): MockHooks => getWorkbenchSource() as unknown as MockHooks;

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
  setWorkbenchSource();
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
    renderer.root.findByProps({ testID: `connect-helper-${helperId}` }).props.onPress();
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

describe('Connect Trusty Squire flow', () => {
  it('lists helpers with platform, agents and online status, dimming offline ones', async () => {
    const renderer = await render();
    const online = renderer.root.findByProps({ testID: 'connect-helper-helper-squire-box' });
    expect(online.props.title).toBe('squire-box');
    expect(online.props.description).toBe('linux · 3 agents · online');
    expect(online.props.value).toBe('pair');
    expect(online.props.disabled).toBe(false);
    const offline = renderer.root.findByProps({ testID: 'connect-helper-helper-office-mini' });
    expect(offline.props.value).toBe('offline');
    expect(offline.props.disabled).toBe(true);
  });

  it('shows the helper’s step-by-step install progress and then the sign-in button', async () => {
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

  it('opens the streamed sign-in URL the server relays, verbatim, in the in-app browser', async () => {
    const renderer = await render();
    await pair(renderer);
    await untilSignin(renderer);
    await act(async () => {
      renderer.root.findByProps({ testID: 'connect-sign-in' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(webBrowser.openBrowserAsync).toHaveBeenCalledWith(
      'https://login.example-squire.test/vnc.html#helper=helper-squire-box',
    );
    expect(webBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  });

  it('opens an OAuth URL through the auth session when the helper reports OAuth', async () => {
    mockHooks().setSignInMethod('oauth');
    const renderer = await render();
    await pair(renderer);
    await untilSignin(renderer);
    await act(async () => {
      renderer.root.findByProps({ testID: 'connect-sign-in' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(webBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      'https://login.example-squire.test/vnc.html#helper=helper-squire-box',
    );
    expect(webBrowser.openBrowserAsync).not.toHaveBeenCalled();
  });

  it('reports a failed step in red with the helper’s reason and a Retry', async () => {
    mockHooks().failNextPair('trusty-squire');
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
