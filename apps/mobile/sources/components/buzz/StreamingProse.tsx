import React, { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { type TextStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import {
  liveDraftStore,
  type LiveDraftSnapshot,
  type LiveDraftStore,
} from '@/buzz/live-draft-store';
import { pendingTailLength, type StreamState } from '@/buzz/streaming-prose';
import { MonoMarkdown } from './MonoMarkdown';
import { STREAMING_TAIL_FADE_MS, useStreamingTailAnimation } from './streaming-tail-animation';

type Presentation = StreamState & {
  revision: number;
  windowKey: number;
  windowEndsAt: number;
};

const now = () => globalThis.performance?.now?.() ?? Date.now();

function presentSnapshot(
  current: Presentation,
  snapshot: LiveDraftSnapshot,
  animate: boolean,
): Presentation {
  if (snapshot.revision === current.revision) {
    if (!animate && current.settled < current.text.length) {
      return {
        ...current,
        settled: current.text.length,
        progress: 1,
        windowKey: current.windowKey + 1,
        windowEndsAt: 0,
      };
    }
    return current;
  }

  const at = now();
  const append = snapshot.text.startsWith(current.text);
  const windowRunning = current.windowEndsAt > at && current.settled < current.text.length;
  if (!animate || !snapshot.reveal || !append) {
    return {
      text: snapshot.text,
      settled: snapshot.text.length,
      progress: 1,
      revision: snapshot.revision,
      windowKey: current.windowKey + 1,
      windowEndsAt: 0,
    };
  }

  if (windowRunning) {
    return {
      ...current,
      text: snapshot.text,
      revision: snapshot.revision,
    };
  }

  return {
    text: snapshot.text,
    settled: current.text.length,
    progress: 0,
    revision: snapshot.revision,
    windowKey: current.windowKey + 1,
    windowEndsAt: at + STREAMING_TAIL_FADE_MS,
  };
}

/**
 * The only subscriber to one cumulative draft lane.
 *
 * React runs once per text commit from the 33/50 store. The 160ms tail reveal
 * is a Reanimated shared value on native and a Web Animation on desktop; this
 * component has no per-frame state, interval, or list-data update.
 */
export function StreamingProse({
  streamKey,
  store = liveDraftStore,
  textStyle,
  testID,
}: {
  streamKey: string;
  store?: LiveDraftStore;
  textStyle: TextStyle;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  const animate = !reducedMotion;
  const [, renderSettlement] = useReducer((version: number) => version + 1, 0);
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(streamKey, listener),
    () => store.getSnapshot(streamKey),
    () => store.getSnapshot(streamKey),
  );
  const presentationRef = useRef<Presentation>({
    text: '',
    settled: 0,
    progress: 1,
    revision: 0,
    windowKey: 0,
    windowEndsAt: 0,
  });
  presentationRef.current = presentSnapshot(presentationRef.current, snapshot, animate);
  const presentation = presentationRef.current;
  const tailLength = pendingTailLength(presentation);

  // One render at the end of the window restores the arrived suffix's parsed
  // formatting. Reveal frames themselves stay entirely on the UI runtime.
  useEffect(() => {
    if (!animate || tailLength <= 0 || presentation.windowEndsAt <= 0) return;
    const delay = Math.max(0, presentation.windowEndsAt - now());
    const timer = setTimeout(() => {
      const current = presentationRef.current;
      if (current.windowKey !== presentation.windowKey) return;
      presentationRef.current = {
        ...current,
        settled: current.text.length,
        progress: 1,
        windowEndsAt: 0,
      };
      renderSettlement();
    }, delay);
    return () => clearTimeout(timer);
  }, [animate, presentation.windowEndsAt, presentation.windowKey, tailLength]);

  const tailAnimation = useStreamingTailAnimation({
    active: animate && tailLength > 0,
    windowKey: presentation.windowKey,
  });
  const tail =
    tailLength > 0
      ? {
          length: tailLength,
          style: tailAnimation.style,
          component: tailAnimation.component,
          windowKey: presentation.windowKey,
        }
      : undefined;

  return (
    <MonoMarkdown
      incremental
      markdown={presentation.text}
      tail={tail}
      testID={testID}
      textStyle={textStyle}
    />
  );
}
