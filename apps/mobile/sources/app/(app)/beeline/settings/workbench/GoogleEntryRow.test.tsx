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
      Value: (v: number) => ({ _value: v, add: () => ({ _value: v }), interpolate: () => ({ _value: v }) }),
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
  it('renders the ONE Google entry: its Connect button sits on the row, facts stay in the pane', async () => {
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
    // Board revision 2: no state word while not connected — the ONE compact
    // side Connect button carries the affordance, right on the row.
    expect(row.props.value).toBeUndefined();
    expect(row.props.actionControl).toMatchObject({
      label: 'Connect',
      testID: 'google-entry-connect',
    });
    expect(row.props.description).toBe(
      'Covers Gmail, Google Calendar, YouTube, and other Google services.',
    );
    expect(onPressConnect).not.toHaveBeenCalled();
    await act(async () => {
      row.props.actionControl.onPress();
    });
    expect(onPressConnect).toHaveBeenCalledTimes(1);
    // The accordion keeps the per-tool state lines beneath the row.
    await act(async () => {
      row.props.onPress();
    });
    const details = renderer.root.findByProps({ testID: 'google-entry-details' });
    expect(details).toBeDefined();
    const textOf = (node: any) =>
      Array.isArray(node.props?.children) ? node.props.children.join('') : node.props?.children;
    const seen = new Set<string>();
    const toolLines = renderer.root
      .findAllByProps({ testID: 'google-entry-tool-google-gmail' })
      .map(textOf)
      .filter((text: string) => (seen.has(text) ? false : (seen.add(text), true)));
    expect(toolLines).toEqual(['· gmail · connect']);
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
    // Repair connects exactly like a first connect — same button, no word.
    expect(row.props.value).toBeUndefined();
    expect(row.props.actionControl).toMatchObject({ label: 'Connect' });
    expect(row.props.description).toBe('2 of 4 tools connected');
    await act(async () => {
      row.props.onPress();
    });
    const textOf = (node: any) =>
      Array.isArray(node.props?.children) ? node.props.children.join('') : node.props?.children;
    const seen = new Set<string>();
    const toolLines = renderer.root
      .findAll((node: any) => typeof node.props?.testID === 'string' && node.props.testID.startsWith('google-entry-tool-'))
      .map((node: any) => [node.props.testID, textOf(node)])
      .filter(([id]: [string]) => (seen.has(id) ? false : (seen.add(id), true)));
    expect(Object.fromEntries(toolLines)).toEqual({
      'google-entry-tool-google-gmail': '· gmail · connected',
      'google-entry-tool-google-calendar': '· calendar · connected',
      'google-entry-tool-google-drive': '· drive · connect',
      'google-entry-tool-google-youtube': '· youtube · connect',
    });
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
    expect(row.props.statusGlyph).toBe('live');
    expect(row.props.actionControl).toBeUndefined();
    expect(row.props.description).toContain('signed in as dana@gmail.test');
  });
});
