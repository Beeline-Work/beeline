import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tablet: true,
  showRoomList: true,
  toggle: vi.fn(),
}));

vi.mock('@/utils/responsive', () => ({ useIsTablet: () => mocks.tablet }));
vi.mock('@/buzz/desktop-layout-state', () => ({
  useDesktopLayout: () => ({ showRoomList: mocks.showRoomList }),
  toggleDesktopRoomList: mocks.toggle,
}));
vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { buzz: { ledgerQuiet: 'quiet' } } }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('./Button', () => ({ Button: 'Button' }));

import { DesktopRoomListToggle } from './DesktopRoomListToggle';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('desktop Room list toggle', () => {
  it('disappears when resizing to a compact window with no permanent sidebar', async () => {
    mocks.tablet = true;
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(<DesktopRoomListToggle />); });
    expect(tree.root.findAllByType('Button')).toHaveLength(1);

    mocks.tablet = false;
    await act(async () => { tree.update(<DesktopRoomListToggle />); });
    expect(tree.toJSON()).toBeNull();

    mocks.tablet = true;
    await act(async () => { tree.update(<DesktopRoomListToggle />); });
    expect(tree.root.findAllByType('Button')).toHaveLength(1);
    await act(async () => { tree.unmount(); });
  });

  it('keeps both sidebar actions available in a regular or wide window', async () => {
    mocks.tablet = true;
    for (const showRoomList of [true, false]) {
      mocks.showRoomList = showRoomList;
      mocks.toggle.mockClear();
      let tree!: ReactTestRenderer;
      await act(async () => { tree = create(<DesktopRoomListToggle />); });
      const button = tree.root.findByType('Button');
      expect(button.props.accessibilityLabel).toBe(showRoomList ? 'Hide room list' : 'Show room list');
      await act(async () => { button.props.onPress(); });
      expect(mocks.toggle).toHaveBeenCalledOnce();
      await act(async () => { tree.unmount(); });
    }
  });
});
