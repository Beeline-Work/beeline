import { controls, roomView, flushEffects } from './test-support-useRoomSurfaceSession.test-support.js';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it } from 'vitest';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import BuzzChat from './[channelId]';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { type RoomViewMessage } from '@beeline/buzz-client';
import { type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';



it('isolates transcript windows, outbox and late send completion when a route changes Room', async () => {
  let current!: {
    session: UseRoomSurfaceSessionResult;
    overlay: ReturnType<typeof import('@/buzz/room-send-frame').useRoomSendFrame>;
    history: ReturnType<typeof useRoomMessageStore>;
  };
  controls.scopeProbe = (session, overlay, history) => {
    current = { session, overlay, history };
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(BuzzChat));
  });
  await flushEffects();
  const source = current;
  const view = roomView('room-a');
  const row = {
    id: 'source-message',
    text: 'source only',
    createdAt: 1,
    author: view.viewer.identity,
    presentation: 'message',
  } as RoomViewMessage;
  await act(async () => controls.responses[0]!.apply({ ...view, messages: [row] }));
  await act(async () =>
    current.overlay.append([{ id: 'pending', text: 'pending source' } as ChatDisplayMessage]),
  );
  const visible = () =>
    renderer.root.findAllByType('probe-row').map((node: any) => node.props.children);
  expect(visible()).toEqual(['source only', 'pending source']);
  const sourceOutbox = current.session.outbox.current();
  controls.routeChannelId = 'room-b';
  controls.cached = null;
  await act(async () => renderer.update(React.createElement(BuzzChat)));
  // Even before the destination responds, it must not draw the source tail.
  expect(visible()).toEqual([]);
  await flushEffects();
  await act(async () => controls.responses.at(-1)!.apply(roomView('room-b')));
  expect(visible()).toEqual([]);
  expect(current.session.outbox.current()).not.toBe(sourceOutbox);
  await act(async () => {
    source.overlay.append([{ id: 'late-preview', text: 'late source' } as ChatDisplayMessage]);
    source.session.applyRoomMessageResult({ ...row, id: 'late-ack', text: 'late acknowledgement' });
  });
  expect(visible()).toEqual([]);
  expect(current.session.roomSurface?.room.id).toBe('room-b');
  expect(current.session.roomSurface?.messages).toEqual([]);
  await act(async () => renderer.unmount());
});
