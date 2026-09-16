import React, { useLayoutEffect, type MutableRefObject } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useScrollFollowOnArrival, useScrollFollowOnLayoutChange } from './room-scroll-follow';

const NORMAL_TRANSCRIPT_GAP = 12;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function ArrivalTranscript({
  newestId,
  pinnedRef,
  openLandsOnTail = true,
  nativeLayoutMovedOffTail,
}: {
  newestId: string | null;
  pinnedRef: MutableRefObject<boolean>;
  openLandsOnTail?: boolean;
  nativeLayoutMovedOffTail?: () => void;
}) {
  const followDecision = useScrollFollowOnArrival({
    newestId,
    isPinnedToTail: pinnedRef.current,
    isUserDragging: false,
    openLandsOnTail,
  });

  useLayoutEffect(() => {
    nativeLayoutMovedOffTail?.();
  }, [nativeLayoutMovedOffTail]);

  return React.createElement('Transcript', { followDecision });
}

describe('desktop transcript arrival', () => {
  it('follows from the pre-append tail position when web layout moves the viewport first', () => {
    let renderer: ReactTestRenderer;
    const pinnedRef = { current: true };
    act(() => {
      renderer = create(
        React.createElement(ArrivalTranscript, { newestId: 'message-1', pinnedRef }),
      );
    });

    act(() => {
      renderer!.update(
        React.createElement(ArrivalTranscript, {
          newestId: 'message-2',
          pinnedRef,
          nativeLayoutMovedOffTail: () => {
            pinnedRef.current = false;
          },
        }),
      );
    });

    expect(pinnedRef.current).toBe(false);
    expect(renderer!.root.findByType('Transcript').props.followDecision).toBe('scroll');
  });

  it('asks for a tail landing when a chronological list gains its first newest row', () => {
    let renderer: ReactTestRenderer;
    const pinnedRef = { current: true };
    act(() => {
      renderer = create(React.createElement(ArrivalTranscript, { newestId: null, pinnedRef }));
    });
    expect(renderer!.root.findByType('Transcript').props.followDecision).toBe('hold');

    act(() => {
      renderer!.update(
        React.createElement(ArrivalTranscript, {
          newestId: 'message-1',
          pinnedRef,
          openLandsOnTail: false,
        }),
      );
    });

    expect(renderer!.root.findByType('Transcript').props.followDecision).toBe('scroll');
  });

  it('holds the same cold open when the transcript lands on the tail by itself', () => {
    let renderer: ReactTestRenderer;
    const pinnedRef = { current: true };
    act(() => {
      renderer = create(React.createElement(ArrivalTranscript, { newestId: null, pinnedRef }));
    });

    act(() => {
      renderer!.update(
        React.createElement(ArrivalTranscript, {
          newestId: 'message-1',
          pinnedRef,
          openLandsOnTail: true,
        }),
      );
    });

    expect(renderer!.root.findByType('Transcript').props.followDecision).toBe('hold');
  });

  it('holds a chronological transcript that opened empty', () => {
    let renderer: ReactTestRenderer;
    const pinnedRef = { current: true };
    act(() => {
      renderer = create(
        React.createElement(ArrivalTranscript, { newestId: null, pinnedRef, openLandsOnTail: false }),
      );
    });

    expect(renderer!.root.findByType('Transcript').props.followDecision).toBe('hold');
  });
});

function ClosedKeyboardTranscript({
  composerHeight,
  pinnedCorner = false,
  activeTurn = false,
  nativeLayoutMovedOffTail,
}: {
  composerHeight: number;
  pinnedCorner?: boolean;
  activeTurn?: boolean;
  nativeLayoutMovedOffTail?: () => void;
}) {
  const bottomInset = composerHeight + NORMAL_TRANSCRIPT_GAP;
  const followDecision = useScrollFollowOnLayoutChange({
    footprint: bottomInset,
    layoutKey: `${pinnedCorner ? 'corner' : 'no-corner'}:${activeTurn ? 'turn' : 'no-turn'}`,
    isPinnedToTail: true,
    isUserDragging: false,
  });

  useLayoutEffect(() => {
    nativeLayoutMovedOffTail?.();
  }, [nativeLayoutMovedOffTail]);

  return React.createElement('Transcript', {
    bottomInset,
    followDecision,
    keyboardHeight: 0,
    pinnedCorner,
    activeTurn,
  });
}

describe('closed-keyboard transcript layout', () => {
  it('follows a collapsing composer using its pre-layout tail state', () => {
    let renderer: ReactTestRenderer;
    let nativePinnedToTail = true;

    act(() => {
      renderer = create(React.createElement(ClosedKeyboardTranscript, { composerHeight: 108 }));
    });
    expect(renderer!.root.findByType('Transcript').props.bottomInset).toBe(
      108 + NORMAL_TRANSCRIPT_GAP,
    );

    act(() => {
      renderer!.update(
        React.createElement(ClosedKeyboardTranscript, {
          composerHeight: 44,
          // This models FlatList's layout callback changing its offset before
          // effects run. The shrink verdict must already have been captured.
          nativeLayoutMovedOffTail: () => {
            nativePinnedToTail = false;
          },
        }),
      );
    });

    const transcript = renderer!.root.findByType('Transcript');
    expect(transcript.props.keyboardHeight).toBe(0);
    expect(transcript.props.bottomInset).toBe(44 + NORMAL_TRANSCRIPT_GAP);
    expect(nativePinnedToTail).toBe(false);
    expect(transcript.props.followDecision).toBe('scroll');
  });

  it('keeps the actual composer inset when pinned-corner and turn lines mount', () => {
    let renderer: ReactTestRenderer;
    let nativePinnedToTail = true;
    act(() => {
      renderer = create(React.createElement(ClosedKeyboardTranscript, { composerHeight: 44 }));
    });

    act(() => {
      renderer!.update(
        React.createElement(ClosedKeyboardTranscript, {
          composerHeight: 44,
          pinnedCorner: true,
          activeTurn: true,
          nativeLayoutMovedOffTail: () => {
            nativePinnedToTail = false;
          },
        }),
      );
    });

    const transcript = renderer!.root.findByType('Transcript');
    expect(transcript.props.keyboardHeight).toBe(0);
    expect(transcript.props.pinnedCorner).toBe(true);
    expect(transcript.props.activeTurn).toBe(true);
    expect(transcript.props.bottomInset).toBe(44 + NORMAL_TRANSCRIPT_GAP);
    expect(nativePinnedToTail).toBe(false);
    expect(transcript.props.followDecision).toBe('scroll');
  });
});
