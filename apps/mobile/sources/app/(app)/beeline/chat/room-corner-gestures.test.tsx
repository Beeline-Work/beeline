import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChannelHeaderTitle } from '@/components/buzz/ChannelHeaderTitle';
import { openRandomNamedCorner } from '@/buzz/open-random-corner';
import { randomCornerName } from '@/buzz/random-corner-name';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const originalConsoleError = console.error;
beforeAll(() => {
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

function RoomHeaderGestures({
  onOpenCorners,
  onOpenRandomCorner,
  onOpenSettings,
  onRename,
}: {
  onOpenCorners: () => void;
  onOpenRandomCorner: () => void;
  onOpenSettings: () => void;
  onRename: () => void;
}) {
  return (
    <>
      <ChannelHeaderTitle
        kind="room"
        onLongPress={onRename}
        onPress={onOpenSettings}
        title="#beeline"
      />
      <React.Fragment>
        {React.createElement('TouchableOpacity', {
          accessibilityHint: 'Long press to open a new corner',
          testID: 'room-corners-menu',
          onPress: onOpenCorners,
          onLongPress: onOpenRandomCorner,
        })}
      </React.Fragment>
    </>
  );
}

describe('Room header corner long-press gestures', () => {
  it('always yields three words ending in corner', () => {
    for (let i = 0; i < 40; i += 1) {
      const name = randomCornerName(() => (i % 10) / 10);
      const words = name.split(' ');
      expect(words).toHaveLength(3);
      expect(words[2]).toBe('corner');
    }
  });

  it('long-presses the Room corner button and opens a random three-word name ending in corner', async () => {
    const createCorner = vi.fn(async (_roomId: string, title: string) => {
      expect(title.split(' ')).toHaveLength(3);
      expect(title.endsWith(' corner')).toBe(true);
      return 'corner-id';
    });
    const openCorner = vi.fn();
    const onOpenCorners = vi.fn();
    const onRename = vi.fn();
    const tree = render(
      <RoomHeaderGestures
        onOpenCorners={onOpenCorners}
        onOpenRandomCorner={() =>
          void openRandomNamedCorner({
            createCorner,
            roomId: 'room-id',
            openCorner,
            random: () => 0,
          })
        }
        onOpenSettings={vi.fn()}
        onRename={onRename}
      />,
    );

    await act(async () => {
      await tree.root.findByProps({ testID: 'room-corners-menu' }).props.onLongPress();
    });

    expect(onOpenCorners).not.toHaveBeenCalled();
    expect(createCorner).toHaveBeenCalledWith('room-id', 'quiet amber corner');
    expect(openCorner).toHaveBeenCalledWith('corner-id', 'quiet amber corner');
    process.stdout.write(
      'long-press room-corners-menu → created "quiet amber corner" → opened corner-id\n',
    );
  });

  it('long-presses the title to rename', () => {
    const onRename = vi.fn();
    const onOpenSettings = vi.fn();
    const tree = render(
      <RoomHeaderGestures
        onOpenCorners={vi.fn()}
        onOpenRandomCorner={vi.fn()}
        onOpenSettings={onOpenSettings}
        onRename={onRename}
      />,
    );
    act(() => tree.root.findByProps({ testID: 'chat-title' }).props.onLongPress());
    expect(onRename).toHaveBeenCalledOnce();
    expect(onOpenSettings).not.toHaveBeenCalled();
    process.stdout.write('long-press chat-title → rename\n');
  });
});
