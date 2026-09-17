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
    description: 'one Google OAuth grant for your agents',
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
  it('renders the ONE Google entry: nothing connected shows connect and the per-tool lines', async () => {
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
    expect(row.props.value).toBe('connect');
    expect(row.props.description).toBe('one Google OAuth grant for your agents');
    // The connect action does not exist while the row is collapsed.
    expect(renderer.root.findAllByProps({ testID: 'google-entry-connect' })).toEqual([]);
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
    const connect = renderer.root.findByProps({ testID: 'google-entry-connect' });
    expect(connect.props.onPress).toBeTypeOf('function');
    expect(onPressConnect).not.toHaveBeenCalled();
    await act(async () => {
      connect.props.onPress();
    });
    expect(onPressConnect).toHaveBeenCalledTimes(1);
  });

  it('shows a partially connected set as repair with how much of the grant is live', async () => {
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
    expect(row.props.value).toBe('repair');
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
    // Repair still offers the ONE connect action (top up the missing tools).
    expect(renderer.root.findByProps({ testID: 'google-entry-connect' }).props.onPress).toBeTypeOf(
      'function',
    );
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
    expect(row.props.description).toContain('signed in as dana@gmail.test');
    await act(async () => {
      row.props.onPress();
    });
    expect(renderer.root.findByProps({ testID: 'google-entry-connected' }).props.children).toEqual([
      'Connected',
      ' as dana@gmail.test',
    ]);
    expect(renderer.root.findAllByProps({ testID: 'google-entry-connect' })).toEqual([]);
  });
});
