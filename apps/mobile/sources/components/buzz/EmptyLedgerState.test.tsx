import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Pressable: host('Pressable'),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});
vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/components/buzz/RoomGlyph', () => ({ RoomGlyph: () => null }));

import { EmptyLedgerState } from './EmptyLedgerState';
import { roomStarterIntro, roomStarterPrompts } from '@/buzz/starter-prompts';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

function textOf(node: any): string {
  return node.children
    .map((child: any) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

describe('the empty #general', () => {
  it('says the Room is empty and offers Connect an agent and Invite someone to the Workspace', async () => {
    const prompts = roomStarterPrompts({
      canManageWorkspace: true,
      workspaceAgentCount: 0,
      workspaceName: 'Northstar Lab',
    });
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        React.createElement(EmptyLedgerState, {
          variant: 'room',
          name: '#general',
          onPress: () => undefined,
          starterIntro: roomStarterIntro(prompts),
          starterPrompts: prompts.map((prompt) => ({ ...prompt, onPress: () => undefined })),
        }),
      );
    });
    const byId = (testID: string) =>
      tree.root.find((node: any) => node.type === 'Text' && node.props.testID === testID);
    expect(textOf(byId('empty-room-title'))).toBe('#general is empty');
    expect(textOf(byId('empty-room-intro'))).toBe(
      'Connect an agent, then ask it for something here.',
    );
    const rows = tree.root
      .findAll((node: any) => node.type === 'Pressable')
      .map((row: any) => textOf(row));
    expect(rows).toEqual([
      'Connect an agent so this Room has someone to ask',
      'Invite someone to Northstar Lab',
    ]);
  });
});
