import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
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

import { GoogleToolRow } from './GoogleToolRow';
import type { WorkbenchConnector } from '@/buzz/workbench';

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

const notConnected: WorkbenchConnector = {
  id: 'google-gmail',
  name: 'Gmail',
  description: 'one Google OAuth grant for your agents',
  available: true,
};

const connected: WorkbenchConnector = {
  ...notConnected,
  status: 'connected',
  helperName: 'squire-box',
  signedInAs: 'dana@gmail.test',
};

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
    await Promise.resolve();
  });
  return renderer;
}

describe('GoogleToolRow', () => {
  it('collapses to a SettingsRow with capabilities hidden; expanding shows them and the ONE connect action', async () => {
    const onPressConnect = vi.fn();
    const renderer = await render(
      React.createElement(GoogleToolRow, { connector: notConnected, onPressConnect }),
    );
    const row = renderer.root.findByProps({ testID: 'google-tool-google-gmail-row' });
    expect(row.props.title).toBe('Gmail');
    expect(row.props.value).toBe('connect');
    // The connect action does not exist while the row is collapsed.
    expect(renderer.root.findAllByProps({ testID: 'google-tool-google-gmail-connect' })).toEqual(
      [],
    );
    await act(async () => {
      row.props.onPress();
    });
    const details = renderer.root.findByProps({ testID: 'google-tool-google-gmail-details' });
    expect(details).toBeDefined();
    const connect = renderer.root.findByProps({ testID: 'google-tool-google-gmail-connect' });
    expect(connect.props.onPress).toBeTypeOf('function');
    // The RN mock passes testID through both the host element and its child,
    // so de-duplicate the matched nodes.
    const capabilityText = (node: any) =>
      Array.isArray(node.props?.children)
        ? node.props.children.join('')
        : node.props?.children;
    const seen = new Set<string>();
    const capabilities = renderer.root
      .findAllByProps({ testID: 'google-tool-google-gmail-capability' })
      .map(capabilityText)
      .filter((text: string) => (seen.has(text) ? false : (seen.add(text), true)));
    expect(capabilities).toEqual([
      '· draft and send messages',
      '· read messages and threads',
    ]);
    expect(onPressConnect).not.toHaveBeenCalled();
    await act(async () => {
      connect.props.onPress();
    });
    expect(onPressConnect).toHaveBeenCalledTimes(1);
  });

  it('shows a connected tool as connected with its sign-in identity and no connect button', async () => {
    const onPressConnect = vi.fn();
    const renderer = await render(
      React.createElement(GoogleToolRow, { connector: connected, onPressConnect }),
    );
    const row = renderer.root.findByProps({ testID: 'google-tool-google-gmail-row' });
    expect(row.props.value).toBe('connected');
    expect(row.props.description).toContain('signed in as dana@gmail.test');
    await act(async () => {
      row.props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'google-tool-google-gmail-connected' }).props.children,
    ).toEqual(['Connected', ' as dana@gmail.test']);
    expect(renderer.root.findAllByProps({ testID: 'google-tool-google-gmail-connect' })).toEqual(
      [],
    );
  });
});
