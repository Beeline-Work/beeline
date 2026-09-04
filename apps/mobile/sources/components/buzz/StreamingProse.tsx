import React, { useEffect, useMemo, useState } from 'react';
import { type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useReducedMotion } from 'react-native-reanimated';
import {
  advanceStream,
  mixHex,
  openStream,
  pendingTailLength,
  type StreamState,
} from '@/buzz/streaming-prose';
import { MonoMarkdown } from './MonoMarkdown';

/** One arrival window. Characters that land inside it fade up together. */
const TAIL_FADE_MS = 160;
const TAIL_FADE_STEPS = 4;

/**
 * A turn as it is being written (C98).
 *
 * The caller supplies the provisional tone; this component adds the one thing
 * a static render cannot say — that the words are still arriving. The tail
 * that landed since the last window walks its colour up from the transcript
 * ground to the body tone, so new text materialises where it was written and
 * everything already read holds perfectly still.
 *
 * Honest by construction. Nothing is revealed on a timer: the text rendered is
 * exactly the text the producer has sent, and a window opens only because
 * characters actually arrived. A harness that rewrites what it wrote settles
 * whole rather than pretending the replacement is new (`buzz/streaming-prose.ts`).
 *
 * Cheap by construction. A delta inside a running window changes only the tail
 * length; the block tree is rebuilt but the parse is memoised on the text, and
 * the fade costs four renders per window however fast the harness streams.
 */
export function StreamingProse({
  markdown,
  textStyle,
  testID,
}: {
  markdown: string;
  textStyle: TextStyle;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  const animate = !reducedMotion;
  const [stream, setStream] = useState<StreamState>(() => openStream(markdown, animate));
  // Derived from props during render, the sanctioned way: a delta must not
  // wait a frame to be shown, and the tail must never flash at full tone
  // before its window opens.
  if (stream.text !== markdown) setStream(advanceStream(stream, markdown, animate));

  const pending = pendingTailLength(stream) > 0;
  useEffect(() => {
    if (!pending || !animate) return;
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      const done = step >= TAIL_FADE_STEPS;
      if (done) clearInterval(timer);
      setStream((current) =>
        done
          ? { ...current, settled: current.text.length, progress: 1 }
          : { ...current, progress: step / TAIL_FADE_STEPS },
      );
    }, TAIL_FADE_MS / TAIL_FADE_STEPS);
    return () => clearInterval(timer);
  }, [animate, pending]);

  const tailLength = pendingTailLength(stream);
  const ground = String(styles.ground.color);
  const tone = String(textStyle.color ?? ground);
  const tail = useMemo(
    () =>
      tailLength > 0
        ? { length: tailLength, style: { color: mixHex(ground, tone, stream.progress) } }
        : undefined,
    [ground, stream.progress, tailLength, tone],
  );

  return (
    <MonoMarkdown markdown={stream.text} tail={tail} testID={testID} textStyle={textStyle} />
  );
}

const styles = StyleSheet.create((theme) => ({
  /** The transcript ground the arriving characters rise out of. */
  ground: { color: theme.buzz.bgBase },
}));
