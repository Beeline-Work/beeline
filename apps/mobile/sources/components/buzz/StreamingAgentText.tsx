/**
 * Live "alien typewriter" reveal for an in-flight agent reply: newly-arrived
 * text settles through a brief scramble/decode flicker instead of a linear
 * left-to-right typewriter. Subscribes directly to the body's coalesced
 * `#t=agent-draft` stream and holds its own local state — this component
 * never touches the parent screen's `messages`/`invertedMessages`, so a
 * streaming turn never triggers a transcript-list re-render (see
 * data/buzzy-corner-presentation-redesign/report.md §6-7).
 *
 * A non-streaming ACP harness (no `agent_message_chunk` deltas) simply never
 * publishes a draft, so this renders nothing until the final message lands
 * through the normal transcript pipeline — graceful, no crash.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import type { BuzzRigTransport } from '@/sync/transport';
import { agentDraftFromSessionEvent } from '@/buzz/agent-draft';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';

type StreamingAgentTextProps = {
  transport: BuzzRigTransport;
  channelId: string;
  requestId: string;
  textStyle?: TextStyle;
  testID?: string;
};

const SCRAMBLE_GLYPHS = '!<>-_\\/[]{}=+*^?#$%&@~01';
const REVEAL_CHARS_PER_TICK = 3;
const TICK_MS = 40;
const SCRAMBLE_WINDOW = 5;

function scrambledSuffix(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SCRAMBLE_GLYPHS[Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)];
  }
  return out;
}

export const StreamingAgentText = React.memo(function StreamingAgentText({
  transport,
  channelId,
  requestId,
  textStyle,
  testID = 'streaming-agent-text',
}: StreamingAgentTextProps) {
  const [display, setDisplay] = useState('');
  const targetRef = useRef('');
  const revealedRef = useRef(0);

  useEffect(() => {
    targetRef.current = '';
    revealedRef.current = 0;
    setDisplay('');
    let cancelled = false;
    let stopSubscribe: (() => void) | undefined;

    (async () => {
      try {
        const stop = await transport.agentDraftSubscribeReady(channelId, (event) => {
          if (cancelled) return;
          const draft = agentDraftFromSessionEvent(event);
          if (!draft || draft.requestId !== requestId) return;
          targetRef.current = draft.text;
        });
        if (cancelled) {
          stop();
          return;
        }
        stopSubscribe = stop;
      } catch (error) {
        console.warn(`StreamingAgentText: draft subscribe failed for ${channelId}:`, error);
      }
    })();

    const timer = setInterval(() => {
      const target = targetRef.current;
      if (revealedRef.current >= target.length) {
        setDisplay((prev) => (prev === target ? prev : target));
        return;
      }
      revealedRef.current = Math.min(target.length, revealedRef.current + REVEAL_CHARS_PER_TICK);
      const settled = target.slice(0, revealedRef.current);
      const windowLength = Math.min(SCRAMBLE_WINDOW, target.length - revealedRef.current);
      setDisplay(settled + scrambledSuffix(windowLength));
    }, TICK_MS);

    return () => {
      cancelled = true;
      stopSubscribe?.();
      clearInterval(timer);
    };
  }, [transport, channelId, requestId]);

  if (!display) return null;
  return (
    <Text style={[styles.text, textStyle]} testID={testID}>
      {display}
    </Text>
  );
});

const styles = StyleSheet.create({
  text: {
    ...Typography.mono(),
    width: '100%',
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
});
