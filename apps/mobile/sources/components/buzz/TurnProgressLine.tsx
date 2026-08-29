import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullLivePulse } from './MonoHull';

/**
 * The ordinary per-turn indicator: the agent has taken this Room's question
 * and has not answered yet. One transient line pinned above the composer,
 * gone the moment the reply lands.
 *
 * It is deliberately NOT `CornerLiveBar`, and the difference is the whole
 * point. A turn is a thing the reader is *waiting* for, so this names nobody's
 * corner, carries no `view →`, and cannot be pressed — there is nowhere to go.
 * A corner is a thing that *exists*, so the corner line names it and opens it.
 * Conflating them is what once lit the gold corner line — pointed at a corner
 * that had long since been archived — for a plain "who is Alan?" question.
 *
 * Gold and the shared live breath are still correct here: `DESIGN.md` assigns
 * that pair to exactly one meaning, an agent is alive and working, which is
 * precisely what a turn in progress is. The redundant channels are the word
 * `thinking…` and the motion, and the line simply disappears when the turn is
 * over rather than demoting to a resting state — an unanswered question is not
 * a state a Room sits in.
 *
 * `tone="quiet"` is the one deliberate exception: it is what a locally-armed
 * pre-receipt ack (see `selectComposerAckState`) becomes once its bound
 * elapses with no real receipt. That is a fact worth surfacing but it is not
 * "an agent is alive and working" — showing gold and a pulse for it would be
 * the same false claim the corner/turn split above exists to prevent. Quiet
 * holds still and reads as muted concern, never as a livelier working state.
 */
export function TurnProgressLine({
  label,
  testID,
  tone = 'live',
}: {
  label: string;
  testID?: string;
  tone?: 'live' | 'quiet';
}) {
  const quiet = tone === 'quiet';
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      style={styles.bar}
      testID={testID}
    >
      <HullLivePulse active={!quiet} style={styles.row}>
        <View style={quiet ? [styles.dot, styles.dotQuiet] : styles.dot} />
        <Text numberOfLines={1} style={quiet ? [styles.label, styles.labelQuiet] : styles.label}>
          {label}
        </Text>
      </HullLivePulse>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  // Same geometry as the pinned corner line, so the two never jump the
  // composer around when one replaces the other. No border, no fill: a status
  // light in a fixed place needs no frame to be found.
  bar: {
    width: '100%',
    minWidth: 0,
    marginBottom: 4,
    paddingHorizontal: 8,
  },
  row: {
    minHeight: 26,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 5,
    height: 5,
    flexShrink: 0,
    backgroundColor: groknight.accent,
  },
  dotQuiet: {
    backgroundColor: groknight.textMuted,
  },
  label: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.accent,
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0.4,
  },
  labelQuiet: {
    color: groknight.textMuted,
  },
  });
});
