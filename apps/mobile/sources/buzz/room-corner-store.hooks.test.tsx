import React from 'react';
// @ts-expect-error No renderer declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it } from 'vitest';
import type { CornerListItem } from '@beeline/api-contract/phone';
import {
  acceptCornerStatusFrame,
  noteCornerLaneSubscribed,
  resetRoomCornerStore,
  useRoomCornerSummaries,
  useRoomCornerSummary,
} from './room-corner-store';
import { resetClientState } from '@/sync/client-reset';

const row = (state: string) => ({
  corner: { id: 'corner-a', name: 'a' },
  lifecycle: { lifecycle: 'unknown', checks: 'unknown' },
  state,
}) as unknown as CornerListItem;

const frame = (sequence: number, state: string) => ({
  roomId: 'parent', sequence, cornerCount: 1,
  openCorners: [{ id: 'corner-a', name: 'a', state: state as 'working', mine: true as const }],
  corners: [row(state)],
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetRoomCornerStore();
});

it('gives every Room list reader the newest summary, and none after a client reset', async () => {
  let seen: readonly { id: string; state: string }[] | undefined;
  let all: ReadonlyMap<string, unknown> | undefined;
  function Dropdown() {
    seen = useRoomCornerSummary('parent')?.openCorners;
    all = useRoomCornerSummaries();
    return null;
  }
  let tree: any;
  await act(async () => { tree = create(<Dropdown />); });
  expect(seen).toBeUndefined();
  await act(async () => {
    noteCornerLaneSubscribed('parent', false);
    acceptCornerStatusFrame(frame(1, 'working'));
  });
  expect(seen).toEqual([expect.objectContaining({ id: 'corner-a', state: 'working' })]);
  expect([...all!.keys()]).toEqual(['parent']);
  await act(async () => resetClientState());
  expect(seen).toBeUndefined();
  expect(all?.size).toBe(0);
  await act(async () => tree.unmount());
});
