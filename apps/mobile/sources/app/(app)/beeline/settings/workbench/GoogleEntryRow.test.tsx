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

import { GoogleEntryRow } from './GoogleEntryRow';
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

function tool(
  id: WorkbenchConnector['id'],
  status?: WorkbenchConnector['status'],
): WorkbenchConnector {
  return {
    id,
    name: id.replace('google-', ''),
    description: 'Covers Gmail, Google Calendar, YouTube, and other Google services.',
    available: true,
    ...(status ? { status } : {}),
  };
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
    await Promise.resolve();
  });
  return renderer;
}

describe('GoogleEntryRow', () => {
  it('renders one Connect action and reveals only the service one-liner', async () => {
    const onPressConnect = vi.fn();
    const connectors = [
      tool('trusty-squire'),
      tool('google-gmail'),
      tool('google-calendar'),
      tool('google-drive'),
      tool('google-youtube'),
    ];
    const renderer = await render(
      React.createElement(GoogleEntryRow, { connectors, onPressConnect }),
    );
    const row = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(row.props.title).toBe('Google Workspace');
    expect(row.props.value).toBeUndefined();
    expect(row.props.action).toBe('Connect');
    expect(row.props.trailingPress.testID).toBe('google-entry-connect');
    expect(row.props.description).toBeUndefined();
    expect(onPressConnect).not.toHaveBeenCalled();
    await act(async () => {
      row.props.trailingPress.onPress();
    });
    expect(onPressConnect).toHaveBeenCalledTimes(1);
    await act(async () => {
      row.props.onPress();
    });
    const details = renderer.root.findByProps({ testID: 'google-entry-details' });
    expect(details).toBeDefined();
    const texts = details.findAllByType('Text' as any);
    expect(texts[0]!.props.children).toBe(
      'Covers Gmail, Google Calendar, YouTube, and other Google services.',
    );
    // Every folded tool is legible behind the disclosure, each with its own status.
    const toolStatuses = ['gmail', 'calendar', 'drive', 'youtube'].map((name) =>
      renderer.root.findByProps({ testID: `google-tool-google-${name}` }),
    );
    expect(
      toolStatuses.map((node) => node.props.children.map((c: any) => c.props.children)),
    ).toEqual([
      ['gmail', 'not connected'],
      ['calendar', 'not connected'],
      ['drive', 'not connected'],
      ['youtube', 'not connected'],
    ]);
  });

  it('shows a partially connected set as repair: side Connect tops up, pane counts what is live', async () => {
    const onPressConnect = vi.fn();
    const connectors = [
      tool('google-gmail', 'connected'),
      tool('google-calendar', 'connected'),
      tool('google-drive'),
      tool('google-youtube'),
    ];
    const renderer = await render(
      React.createElement(GoogleEntryRow, { connectors, onPressConnect }),
    );
    const row = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(row.props.value).toBeUndefined();
    expect(row.props.action).toBe('Connect');
    expect(row.props.description).toBeUndefined();
    await act(async () => {
      row.props.onPress();
    });
    for (const name of ['gmail', 'calendar', 'drive', 'youtube']) {
      expect(renderer.root.findAll((node: any) => node.props?.testID === `google-tool-google-${name}` && node.type === 'View')).toHaveLength(1);
    }
    expect(
      renderer.root
        .findByProps({ testID: 'google-tool-google-youtube' })
        .props.children.map((c: any) => c.props.children),
    ).toEqual(['youtube', 'not connected']);
  });

  it('shows a fully connected set as connected with its sign-in identity and no connect button', async () => {
    const onPressConnect = vi.fn();
    const connectedTool = (id: WorkbenchConnector['id']): WorkbenchConnector => ({
      ...tool(id, 'connected'),
      helperName: 'squire-box',
      signedInAs: 'dana@gmail.test',
    });
    const renderer = await render(
      React.createElement(GoogleEntryRow, {
        connectors: [
          connectedTool('google-gmail'),
          connectedTool('google-calendar'),
          connectedTool('google-drive'),
          connectedTool('google-youtube'),
        ],
        onPressConnect,
      }),
    );
    const row = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(row.props.value).toBe('connected');
    expect(row.props.statusGlyph).toBeUndefined();
    expect(row.props.action).toBeUndefined();
    expect(row.props.description).toBeUndefined();
  });

  it('does not paint a Trusty Squire browser-session failure as Google Workspace breakage', async () => {
    const busy =
      'another Trusty Squire session is already using the browser - close it first';
    const onPressConnect = vi.fn();
    const renderer = await render(
      React.createElement(GoogleEntryRow, {
        connectors: [
          { ...tool('trusty-squire'), status: 'error', errorMessage: busy },
          { ...tool('google-gmail'), status: 'error', errorMessage: busy },
          tool('google-calendar'),
          tool('google-drive'),
          tool('google-youtube'),
        ],
        onPressConnect,
      }),
    );
    const row = renderer.root.findByProps({ testID: 'google-entry-row' });
    expect(row.props.action).toBeUndefined();
    expect(row.props.trailingPress).toBeUndefined();
    expect(row.props.descriptionTone).not.toBe('danger');
    expect(row.props.description).toBe(
      'Connect Trusty Squire first — its browser session is busy',
    );
    expect(row.props.description).not.toMatch(
      /another Trusty Squire session is already using the browser/i,
    );
  });
});
