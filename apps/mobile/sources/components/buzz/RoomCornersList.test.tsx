import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CornerListItem } from '@beeline/buzz-client';
import { INSPECTOR_CORNER_LIST_CAP } from '@/buzz/inspector-corners';
import { RoomCornersList } from './RoomCornersList';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    FlatList: (props: any) =>
      ReactModule.createElement(
        'FlatList',
        props,
        ...(props.data ?? []).map((item: any, index: number) =>
          ReactModule.createElement(
            ReactModule.Fragment,
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index }),
          ),
        ),
        props.ListFooterComponent,
        (props.data ?? []).length === 0 ? props.ListEmptyComponent : null,
      ),
    Pressable: host('Pressable'),
    Platform: { OS: 'web' },
    Text: host('Text'),
    View: host('View'),
  };
});

const theme = vi.hoisted(() => ({
  buzz: {
    border: '#333',
    textPrimary: '#fff',
    textMuted: '#aaa',
    type: { body: {}, meta: {} },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) => (typeof factory === 'function' ? factory(theme) : factory),
  },
}));
vi.mock('expo-router', () => ({ router: { push: routerPush } }));
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return { StateCircle: (props: any) => ReactModule.createElement('StateCircle', props) };
});

function corner(id: string, state: CornerListItem['state'], name = id): CornerListItem {
  return {
    corner: {
      id,
      workspaceId: 'workspace',
      name,
      archived: state === 'archived',
      createdAt: 1,
      updatedAt: 2,
    },
    lifecycle: { lifecycle: state === 'archived' ? 'done' : 'active', checks: 'unknown' },
    state,
    stateAt: 2,
    agent: { pubkey: `agent-${id}`, name: `Opener ${id}`, kind: 'agent' },
  } as CornerListItem;
}

function text(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as any)
    .flatMap((node: any) => node.props.children)
    .join(' ')
    .replace(/\s+/g, ' ');
}

function render(corners: readonly CornerListItem[]) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <RoomCornersList corners={corners} parentRoomName="#alpha" parentRoomId="room-1" />,
    );
  });
  return tree;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('RoomCornersList', () => {
  it('caps live work at five and reveals archived work behind the same see-more as the inspector', () => {
    expect(INSPECTOR_CORNER_LIST_CAP).toBe(5);
    const corners = [
      ...Array.from({ length: 6 }, (_, index) => corner(`live-${index}`, 'working')),
      corner('done', 'archived'),
    ];
    const tree = render(corners);
    for (const id of ['live-0', 'live-1', 'live-2', 'live-3', 'live-4']) {
      expect(tree.root.findByProps({ testID: `room-corner-${id}` })).toBeTruthy();
    }
    expect(() => tree.root.findByProps({ testID: 'room-corner-live-5' })).toThrow();
    expect(() => tree.root.findByProps({ testID: 'room-corner-done' })).toThrow();
    const more = tree.root.findByProps({ testID: 'room-corners-more' });
    expect(text(tree)).toContain('2 more');
    act(() => more.props.onPress());
    expect(tree.root.findByProps({ testID: 'room-corner-live-5' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'room-corner-done' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'room-corners-more' })).toHaveLength(0);
  });

  it('shows archived corners when the Room has no live work', () => {
    const tree = render([
      corner('done', 'archived', 'Landed work'),
      corner('older', 'archived', 'Older work'),
    ]);
    expect(tree.root.findByProps({ testID: 'room-corner-done' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'room-corner-older' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'room-corners-more' })).toHaveLength(0);
    expect(text(tree)).not.toContain('archived · 2');
  });

  it('pages a long archived-only list five at a time', () => {
    const corners = Array.from({ length: 7 }, (_, index) =>
      corner(`done-${index}`, 'archived', `Done ${index}`),
    );
    const tree = render(corners);
    for (const id of ['done-0', 'done-1', 'done-2', 'done-3', 'done-4']) {
      expect(tree.root.findByProps({ testID: `room-corner-${id}` })).toBeTruthy();
    }
    expect(() => tree.root.findByProps({ testID: 'room-corner-done-5' })).toThrow();
    expect(text(tree)).toContain('2 more');
    act(() => tree.root.findByProps({ testID: 'room-corners-more' }).props.onPress());
    expect(tree.root.findByProps({ testID: 'room-corner-done-5' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'room-corner-done-6' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'room-corners-more' })).toHaveLength(0);
  });

  it('keeps archived behind archived · N while live work is showing', () => {
    const tree = render([corner('live', 'working'), corner('done', 'archived')]);
    expect(tree.root.findByProps({ testID: 'room-corner-live' })).toBeTruthy();
    expect(() => tree.root.findByProps({ testID: 'room-corner-done' })).toThrow();
    expect(text(tree)).toContain('archived · 1');
    act(() => tree.root.findByProps({ testID: 'room-corners-more' }).props.onPress());
    expect(tree.root.findByProps({ testID: 'room-corner-done' })).toBeTruthy();
  });

  it('names an empty Room instead of inventing a list', () => {
    const tree = render([]);
    expect(tree.root.findByProps({ testID: 'room-corners-empty' })).toBeTruthy();
    expect(text(tree)).toContain('No corners yet');
    expect(tree.root.findAllByProps({ testID: 'room-corners-more' })).toHaveLength(0);
  });

  it('opens a row into that corner', () => {
    const tree = render([corner('live', 'working', 'Fix fixture')]);
    act(() => tree.root.findByProps({ testID: 'room-corner-live' }).props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'live', parent: 'room-1', title: 'Fix fixture' },
    });
  });
});
