import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (styles: any) => styles({ buzz: { type: { meta: {} } } }),
    hairlineWidth: 1,
  },
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Text: host('Text'), View: host('View') };
});

vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HullActionSheetCancel: (props: any) => ReactModule.createElement('Cancel', props),
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement('Sheet', props, props.visible ? props.children : null),
    HullActionSheetRow: (props: any) => ReactModule.createElement('Row', props),
  };
});

import { RoomReviewerActions } from './RoomReviewerActions';

const ECHO = 'echo-agent';
const BEE = 'bee-agent';
const agents = [
  { pubkey: ECHO, kind: 'agent' as const, name: 'Echo', handle: 'echo' },
  { pubkey: BEE, kind: 'agent' as const, name: 'Bee', handle: 'bee' },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());

function render(overrides: Partial<React.ComponentProps<typeof RoomReviewerActions>> = {}) {
  const updateRoom = vi.fn().mockResolvedValue(undefined);
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <RoomReviewerActions
        agents={agents}
        canManage
        hasRepository
        reviewerAgentId={ECHO}
        roomId="room-1"
        roomName="#beeline"
        updateRoom={updateRoom}
        {...overrides}
      />,
    );
  });
  return { renderer, updateRoom };
}

describe('RoomReviewerActions', () => {
  it('shows the current reviewer for a repository Room manager', () => {
    const { renderer } = render();
    expect(renderer.root.findByProps({ testID: 'room-reviewer-action' }).props).toMatchObject({
      label: 'Reviewer',
      metadata: '@echo',
    });
  });

  it('hides the reviewer row without a repository or manager permission', () => {
    expect(render({ hasRepository: false }).renderer.root.findAllByType('Row')).toHaveLength(0);
    expect(render({ canManage: false }).renderer.root.findAllByType('Row')).toHaveLength(0);
  });

  it('picks and clears Room agents through updateRoom', async () => {
    const { renderer, updateRoom } = render();

    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    await act(async () => {
      renderer.root.findByProps({ testID: `room-reviewer-agent-${BEE}` }).props.onPress();
      await Promise.resolve();
    });
    expect(updateRoom).toHaveBeenLastCalledWith({ roomId: 'room-1', reviewerAgentId: BEE });
    expect(renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.metadata).toBe(
      '@bee',
    );

    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    await act(async () => {
      renderer.root.findByProps({ testID: 'room-reviewer-none' }).props.onPress();
      await Promise.resolve();
    });
    expect(updateRoom).toHaveBeenLastCalledWith({ roomId: 'room-1', reviewerAgentId: null });
    expect(renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.metadata).toBe(
      'None',
    );
  });
});
