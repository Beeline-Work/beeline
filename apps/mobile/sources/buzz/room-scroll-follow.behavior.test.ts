import React, { useLayoutEffect } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { useScrollFollowOnLayoutChange } from './room-scroll-follow';

const NORMAL_TRANSCRIPT_GAP = 12;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
