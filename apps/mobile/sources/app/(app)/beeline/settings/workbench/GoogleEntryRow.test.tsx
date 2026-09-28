import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { WorkbenchConnector } from '@/buzz/workbench';

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), Path: host('Path') };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View'),
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.android } };
});
vi.mock('@/components/buzz/SettingsRow', async () => {
  const ReactModule = await import('react');
  return { SettingsRow: (props: any) => ReactModule.createElement('SettingsRow', props) };
});
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (make: any) => make({
  buzz: { type: { meta: {} }, textMuted: '', border: '', space: { md: 16, sm: 8 } },
}), hairlineWidth: 1 } }));

import { GoogleEntryRow } from './GoogleEntryRow';

const connectors = (status?: WorkbenchConnector['status']): WorkbenchConnector[] =>
  (['google-gmail', 'google-calendar', 'google-drive', 'google-youtube'] as const)
    .map((id) => ({ id, name: id, description: '', available: true, status,
      signedInAs: status === 'connected' ? 'owner@example.test' : undefined }));

it('offers one Connect action for all four tools and a quiet cancelled state', async () => {
  const connect = vi.fn();
  let renderer: any;
  await act(async () => { renderer = create(<GoogleEntryRow connectors={connectors()}
    onPressConnect={connect} onPressDisconnect={vi.fn()} />); });
  const row = renderer.root.findByProps({ testID: 'google-entry-row' });
  expect(row.props.description).toBe('Gmail, Calendar, Drive and YouTube. One sign-in connects all four.');
  await act(async () => row.props.trailingPress.onPress());
  expect(connect).toHaveBeenCalledWith('google');
  expect(renderer.root.findAll((node: any) =>
    typeof node.props?.testID === 'string' && node.props.testID.startsWith('google-tool-')))
    .toHaveLength(0);
  await act(async () => renderer.update(<GoogleEntryRow connectors={connectors()}
    onPressConnect={connect} onPressDisconnect={vi.fn()}
    notice="Sign-in didn’t finish. Tap Connect to try again." />));
  const cancelled = renderer.root.findByProps({ testID: 'google-entry-row' });
  expect(cancelled.props.action).toBe('Connect');
  expect(cancelled.props.descriptionTone).toBeUndefined();
  expect(cancelled.props.description).toContain('Sign-in didn’t finish');
  await act(async () => renderer.unmount());
});

it('shows the account and one connected state, with a single disconnect', async () => {
  const disconnect = vi.fn();
  let renderer: any;
  await act(async () => { renderer = create(<GoogleEntryRow connectors={connectors('connected')}
    onPressConnect={vi.fn()} onPressDisconnect={disconnect}
    notice="Sign-in didn’t finish. Tap Connect to try again." />); });
  const row = renderer.root.findByProps({ testID: 'google-entry-row' });
  expect(row.props.value).toBe('connected');
  expect(row.props.description).toContain('owner@example.test');
  expect(row.props.action).toBeUndefined();
  await act(async () => row.props.onPress());
  await act(async () => renderer.root.findByProps({ testID: 'google-entry-disconnect' }).props.onPress());
  expect(disconnect).toHaveBeenCalledWith('google-gmail');
  await act(async () => renderer.unmount());
});
