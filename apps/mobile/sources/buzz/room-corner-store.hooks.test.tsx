import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it } from 'vitest';
import type { CornerListItem } from '@beeline/api-contract/phone';
import {
  acceptCornerStatusFrame,
  noteCornerLaneReleased,
  noteCornerLaneSubscribed,
  resetRoomCornerStore,
  useCurrentCornerRow,
  useRoomOpenCorners,
} from './room-corner-store';

const row = (state: string) => ({
  corner: { id: 'corner-a', name: 'a' },
  lifecycle: { lifecycle: 'unknown', checks: 'unknown' },
  state,
}) as unknown as CornerListItem;

const frame = (sequence: number, state: string) => ({
  roomId: 'parent', sequence, cornerCount: 1, waitingCornerCount: 0,
  openCorners: [{ id: 'corner-a', name: 'a', state: state as 'working', mine: true as const }],
  corners: [row(state)],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetRoomCornerStore();
});

it('gives a corner header its server row while the parent lane keeps it current', async () => {
  let seen: CornerListItem | undefined;
  function Header() {
    seen = useCurrentCornerRow('parent', 'corner-a');
    return null;
  }
  let tree: any;
  await act(async () => { tree = create(<Header />); });
  expect(seen).toBeUndefined();
  await act(async () => {
    noteCornerLaneSubscribed('parent', false);
    acceptCornerStatusFrame(frame(1, 'working'));
  });
  expect(seen?.state).toBe('working');
  await act(async () => { acceptCornerStatusFrame(frame(2, 'review')); });
  expect(seen?.state).toBe('review');
  // Once nothing holds the lane, the header falls back to its own facts.
  await act(async () => { noteCornerLaneReleased('parent'); });
  expect(seen).toBeUndefined();
  await act(async () => tree.unmount());
});

it('gives the Room list dropdown the newest summary, or the chat row\'s own copy', async () => {
  let seen: readonly { id: string; state: string }[] | undefined;
  function Dropdown() {
    seen = useRoomOpenCorners('parent', [{ id: 'from-chat-list', name: 'x', state: 'waiting' }]);
    return null;
  }
  let tree: any;
  await act(async () => { tree = create(<Dropdown />); });
  expect(seen?.map((corner) => corner.id)).toEqual(['from-chat-list']);
  await act(async () => {
    noteCornerLaneSubscribed('parent', false);
    acceptCornerStatusFrame(frame(1, 'working'));
  });
  expect(seen).toEqual([expect.objectContaining({ id: 'corner-a', state: 'working' })]);
  await act(async () => tree.unmount());
});
