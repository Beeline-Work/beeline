import * as React from 'react';
import { View } from 'react-native';
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
  return { ScrollView: host('ScrollView'), Text: host('Text'), View: host('View') };
});

vi.mock('./HullActionSheet', async () => {
  const ReactModule = await import('react');
  return {
    HullActionSheetCancel: (props: any) => ReactModule.createElement('Cancel', props),
    HullActionSheetModal: (props: any) =>
      ReactModule.createElement(
        'Sheet',
        props,
        props.visible ? props.children : null,
        props.visible ? props.footer : null,
      ),
    HullActionSheetRow: (props: any) => ReactModule.createElement('Row', props),
  };
});
import { RoomReviewerActions, RoomReviewerSurfaceNotice } from './RoomReviewerActions';

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

function renderedNotice(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAllByType('View').filter((node) => node.props.testID === testID);
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
    expect(renderer.root.findByProps({ testID: `room-reviewer-agent-${BEE}` }).props.metadata).toBe(
      '#2',
    );

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

  it('warns on the settings row when a reviewer is set and the repo allows auto-merge', () => {
    const { renderer } = render({ allowAutoMerge: true });
    const text = renderer.root
      .findByProps({ testID: 'room-reviewer-auto-merge-warning' })
      .findByType('Text').props.children;
    expect(text).toEqual(['! ', expect.stringContaining('This repository allows auto-merge')]);
  });

  it('shows no standing warning without a reviewer or with auto-merge off', () => {
    expect(renderedNotice(render({ allowAutoMerge: true, reviewerAgentId: undefined }).renderer,
      'room-reviewer-auto-merge-warning')).toHaveLength(0);
    expect(renderedNotice(render({ allowAutoMerge: false }).renderer,
      'room-reviewer-auto-merge-warning')).toHaveLength(0);
  });

  it('warns inside the picker before a reviewer is even chosen, so the choice is informed', () => {
    const { renderer } = render({ allowAutoMerge: true, reviewerAgentId: undefined });
    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    const text = renderer.root
      .findByProps({ testID: 'room-reviewer-auto-merge-picker-warning' })
      .findByType('Text').props.children;
    expect(text).toEqual(['! ', expect.stringContaining('This repository allows auto-merge')]);
  });

  it('still saves a reviewer after warning that the repository allows auto-merge', async () => {
    const { renderer, updateRoom } = render({ allowAutoMerge: true, reviewerAgentId: undefined });
    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    expect(renderedNotice(renderer, 'room-reviewer-auto-merge-picker-warning')).toHaveLength(1);
    await act(async () => {
      renderer.root.findByProps({ testID: `room-reviewer-agent-${BEE}` }).props.onPress();
      await Promise.resolve();
    });
    expect(updateRoom).toHaveBeenCalledWith({
      roomId: 'room-1', reviewerAgentId: BEE, reviewerFallbackIds: [],
    });
    expect(renderedNotice(renderer, 'room-reviewer-auto-merge-warning')).toHaveLength(1);
  });

  it('shows an inline Room notice when auto-merge becomes allowed for an existing reviewer', () => {
    let renderer!: ReactTestRenderer;
    const renderNotice = (
      allowAutoMerge: boolean,
      reviewerAgentId?: string,
      canManage = true,
      isCorner = false,
    ) => (
      <View>
        <RoomReviewerSurfaceNotice
          allowAutoMerge={allowAutoMerge}
          canManage={canManage}
          isCorner={isCorner}
          reviewerAgentId={reviewerAgentId}
        />
      </View>
    );
    act(() => { renderer = create(renderNotice(false, ECHO)); });
    expect(renderedNotice(renderer, 'room-auto-merge-reviewer-notice')).toHaveLength(0);

    act(() => renderer.update(renderNotice(true, ECHO)));
    const [notice] = renderedNotice(renderer, 'room-auto-merge-reviewer-notice');
    expect(notice).toBeDefined();
    expect(notice.props.accessibilityRole).toBe('alert');
    const text = notice.findByType('Text').props.children.join('');
    expect(text).toContain('This repository allows auto-merge');
    expect(text).toContain("If auto-merge is turned on for a corner's pull request");
    expect(text).toContain('GitHub merges it as soon as checks pass');
    expect(text).toContain('before the Beeline reviewer is asked to look');
    expect(text).toContain("Turn off auto-merge in this repository's GitHub settings");

    act(() => renderer.update(renderNotice(true)));
    expect(renderedNotice(renderer, 'room-auto-merge-reviewer-notice')).toHaveLength(0);
    act(() => renderer.update(renderNotice(true, ECHO, false)));
    expect(renderedNotice(renderer, 'room-auto-merge-reviewer-notice')).toHaveLength(0);
    act(() => renderer.update(renderNotice(true, ECHO, true, true)));
    expect(renderedNotice(renderer, 'room-auto-merge-reviewer-notice')).toHaveLength(0);
  });

  it('shows no picker warning when the repo does not allow auto-merge', () => {
    const { renderer } = render({ allowAutoMerge: false, reviewerAgentId: undefined });
    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    expect(renderedNotice(renderer, 'room-reviewer-auto-merge-picker-warning')).toHaveLength(0);
  });

  it('scrolls the agent list in a window of five rows with Done pinned below it', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      pubkey: `agent-${index}`,
      kind: 'agent' as const,
      name: `Agent ${index}`,
      handle: `agent${index}`,
    }));
    const { renderer } = render({ agents: many, reviewerAgentId: undefined });
    act(() => renderer.root.findByProps({ testID: 'room-reviewer-action' }).props.onPress());
    const sheet = renderer.root.findByProps({ testID: 'room-reviewer-sheet' });
    expect(sheet.props.scrollBody).toBe(false);
    const list = renderer.root.findByProps({ testID: 'room-reviewer-list' });
    expect(list.props.nestedScrollEnabled).toBe(true);
    expect(list.props.style.maxHeight).toBe(5 * 52);
    expect(list.findAllByType('Row')).toHaveLength(13);
    expect(list.findAllByProps({ testID: 'room-reviewer-close' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'room-reviewer-close' }).length).toBeGreaterThan(
      0,
    );
  });
});
