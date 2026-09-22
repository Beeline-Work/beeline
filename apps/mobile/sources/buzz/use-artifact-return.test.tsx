import React, { useCallback, useState } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { CodeBlock } from '@/components/buzz/CodeBlock';
import { visibleTranscriptWindow } from './transcript-presentation';
import { useArtifactReturn } from './use-artifact-return';

const { push, focus } = vi.hoisted(() => ({
  push: vi.fn(),
  focus: { current: undefined as undefined | (() => void) },
}));

vi.mock('expo-router', () => ({
  router: { push },
  useFocusEffect: (callback: () => void) => {
    focus.current = callback;
  },
}));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'android', select: (obj: any) => obj.android ?? obj.default },
    StyleSheet: { create: (styles: unknown) => styles },
    Text: host('Text'),
    View: host('View'),
    ScrollView: host('ScrollView'),
    Pressable: host('Pressable'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
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

const prose = (id: string): ChatDisplayMessage => ({
  id,
  text: id,
  isUser: false,
  timestamp: Number(id.replace(/\D/g, '')) || 1,
});

function invokeFocus(): void {
  const callback = focus.current as undefined | (() => void);
  if (!callback) throw new Error('focus callback was not registered');
  callback();
}

function ArtifactReturnHarness({
  residentMessages,
  scrollToIndex,
}: {
  residentMessages: readonly ChatDisplayMessage[];
  scrollToIndex(index: number, viewPosition: number): void;
}) {
  const [visibleCount, setVisibleCount] = useState(30);
  const transcriptMessages = visibleTranscriptWindow(residentMessages, visibleCount).reverse();
  const onScroll = useCallback(
    (index: number, viewPosition: number) => scrollToIndex(index, viewPosition),
    [scrollToIndex],
  );
  const onOpen = useArtifactReturn({
    transcriptMessages,
    residentMessages,
    onReveal: setVisibleCount,
    onScroll,
  });

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(CodeBlock, {
      code: 'one\ntwo\nthree\nfour\nfive',
      language: 'text',
      roomId: 'room-7',
      messageId: residentMessages[0]!.id,
      blockIndex: 0,
      onOpen,
    }),
    React.createElement('Transcript', { messages: transcriptMessages }),
  );
}

describe('BuzzChatSurface artifact return', () => {
  it('opens from the oldest visible row, survives an arrival, and re-centers it on Back', async () => {
    push.mockClear();
    focus.current = undefined;
    const initial = Array.from({ length: 30 }, (_, index) =>
      prose(`message-${String(index).padStart(2, '0')}`),
    );
    const originId = initial[0]!.id;
    const scrollToIndex = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(ArtifactReturnHarness, {
          residentMessages: initial,
          scrollToIndex,
        }),
      );
    });

    await act(async () => renderer.root.findByProps({ testID: 'code-open' }).props.onPress());
    expect(push).toHaveBeenCalledWith({
      pathname: '/artifact-viewer',
      params: { roomId: 'room-7', messageId: originId, blockIndex: '0' },
    });

    const afterArrival = [...initial, prose('message-30')];
    act(() => {
      renderer.update(
        React.createElement(ArtifactReturnHarness, {
          residentMessages: afterArrival,
          scrollToIndex,
        }),
      );
    });
    expect(visibleTranscriptWindow(afterArrival, 30).some(({ id }) => id === originId)).toBe(false);

    // One Back focus first widens the resident tail. While the screen remains
    // focused, useFocusEffect re-runs its changed callback after that render.
    const beforeBack = focus.current as undefined | (() => void);
    act(invokeFocus);
    expect(focus.current).not.toBe(beforeBack);
    act(invokeFocus);
    const restored = renderer.root.findByType('Transcript' as any).props.messages;
    expect(restored[30]!.id).toBe(originId);
    expect(scrollToIndex).toHaveBeenCalledWith(30, 0.5);

    act(invokeFocus);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });
});
