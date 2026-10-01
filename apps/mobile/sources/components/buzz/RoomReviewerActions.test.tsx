import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { mockBuzzTheme } = vi.hoisted(() => ({
  mockBuzzTheme: {
    buzz: { type: { meta: {} }, space: {}, border: '', radius: 0, textPrimary: '', dim: '' },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (styles: any) => styles(mockBuzzTheme),
    hairlineWidth: 1,
  },
  useUnistyles: () => ({ theme: mockBuzzTheme }),
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
    expect(renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.description).toBeUndefined();
  });

  it('hides the reviewer row without a repository or manager permission', () => {
    expect(render({ hasRepository: false }).renderer.root.findAllByType('Row')).toHaveLength(0);
    expect(render({ canManage: false }).renderer.root.findAllByType('Row')).toHaveLength(0);
  });

  it('adds agents to the end of the reviewer list, takes them off, and clears it', async () => {
    const { renderer, updateRoom } = render();
    const press = async (testID: string) => {
      await act(async () => {
        renderer.root.findByProps({ testID }).props.onPress();
        await Promise.resolve();
      });
    };
    const metadata = () =>
      renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.metadata;

    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    await press(`room-reviewer-agent-${BEE}`);
    expect(updateRoom).toHaveBeenLastCalledWith({
      roomId: 'room-1',
      reviewerAgentId: ECHO,
      reviewerFallbackIds: [BEE],
    });
    expect(metadata()).toBe('@echo, then @bee');
    expect(renderer.root.findByProps({ testID: `room-reviewer-agent-${BEE}` }).props.metadata).toBe('#2');

    await press(`room-reviewer-agent-${ECHO}`);
    expect(updateRoom).toHaveBeenLastCalledWith({
      roomId: 'room-1',
      reviewerAgentId: BEE,
      reviewerFallbackIds: [],
    });
    expect(metadata()).toBe('@bee');

    await press('room-reviewer-none');
    expect(updateRoom).toHaveBeenLastCalledWith({
      roomId: 'room-1',
      reviewerAgentId: null,
      reviewerFallbackIds: [],
    });
    expect(metadata()).toBe('None');
  });

  it('shows the saved reviewer list in order and offers no class option', () => {
    const { renderer } = render({ reviewerAgentId: BEE, reviewerFallbackIds: [ECHO] });
    expect(renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.metadata).toBe(
      '@bee, then @echo',
    );
    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'room-reviewer-class' })).toHaveLength(0);
    expect(
      renderer.root
        .findAllByType('Row')
        .map((row: { props: { label: string } }) => row.props.label)
        .filter((label: string) => /class/i.test(label)),
    ).toEqual([]);
  });
});
