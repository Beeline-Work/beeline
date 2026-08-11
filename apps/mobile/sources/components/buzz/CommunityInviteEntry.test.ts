import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

import { CommunityInviteEntry } from './CommunityInviteEntry';

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('community invite entry', () => {
  it('exposes People invites and Agent linking from an active Workspace', () => {
    const onInvitePeople = vi.fn();
    const onManageAgents = vi.fn();
    const renderer = render(
      React.createElement(CommunityInviteEntry, {
        community: { communityId: 'community-1', name: 'Night Shift' } as any,
        creatingInvite: false,
        onInvitePeople,
        onManageAgents,
      }),
    );

    expect(renderer.root.findByProps({ testID: 'community-invite-entry' })).toBeDefined();
    act(() => renderer.root.findByProps({ testID: 'invite-people-action' }).props.onPress());
    expect(onInvitePeople).toHaveBeenCalledOnce();
    act(() => renderer.root.findByProps({ testID: 'manage-agents-action' }).props.onPress());
    expect(onManageAgents).toHaveBeenCalledOnce();
  });

  it('keeps Agent linking but hides People invites in a Personal Workspace', () => {
    const renderer = render(
      React.createElement(CommunityInviteEntry, {
        community: { communityId: 'personal-1', name: 'Personal' } as any,
        creatingInvite: false,
        allowPeopleInvites: false,
        onInvitePeople: vi.fn(),
        onManageAgents: vi.fn(),
      }),
    );

    expect(renderer.root.findAllByProps({ testID: 'invite-people-action' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'manage-agents-action' })).toBeDefined();
  });
});
