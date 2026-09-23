import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      disk.set(key, value);
    }),
  },
}));
import { useRoomPins } from './room-list-preferences';
const values = new Map<string, ReturnType<typeof useRoomPins>>();
function Consumer({
  name,
  workspace = 'workspace',
  viewer = 'viewer',
}: {
  name: string;
  workspace?: string;
  viewer?: string;
}) {
  values.set(name, useRoomPins(viewer, workspace));
  return null;
}
let tree: any;
beforeEach(() => {
  disk.clear();
  values.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (tree) act(() => tree.unmount());
});
describe('device-local conversation pins', () => {
  it('serializes rapid writes across mounted surfaces and retains previously saved pins', async () => {
    disk.set('@beeline/room-pins/viewer/workspace', JSON.stringify(['saved']));
    await act(async () => {
      tree = create(
        <>
          <Consumer name="mobile" />
          <Consumer name="desktop" />
        </>,
      );
    });
    await act(async () => {
      await Promise.all([
        values.get('mobile')!.togglePin('a'),
        values.get('desktop')!.togglePin('b'),
      ]);
    });
    expect(values.get('mobile')!.pinned).toEqual(['saved', 'a', 'b']);
    expect(values.get('desktop')!.pinned).toEqual(['saved', 'a', 'b']);
    expect(JSON.parse(disk.get('@beeline/room-pins/viewer/workspace')!)).toEqual([
      'saved',
      'a',
      'b',
    ]);
  });
  it('isolates viewers and workspaces and restores pins when switching back', async () => {
    await act(async () => {
      tree = create(<Consumer name="current" />);
    });
    await act(async () => {
      await values.get('current')!.togglePin('a');
    });
    await act(async () => {
      tree.update(<Consumer name="current" workspace="other" />);
    });
    expect(values.get('current')!.pinned).toEqual([]);
    await act(async () => {
      tree.update(<Consumer name="current" viewer="other" />);
    });
    expect(values.get('current')!.pinned).toEqual([]);
    await act(async () => {
      tree.update(<Consumer name="current" />);
    });
    expect(values.get('current')!.pinned).toEqual(['a']);
  });
});
