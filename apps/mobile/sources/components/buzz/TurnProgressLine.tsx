import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { groknight } from '@/buzz/groknight';
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
 */
export function TurnProgressLine({ label, testID }: { label: string; testID?: string }) {
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      style={styles.bar}
      testID={testID}
    >
      <HullLivePulse style={styles.row}>
        <View style={styles.dot} />
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
      </HullLivePulse>
    </View>
  );
}

const styles = StyleSheet.create({
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
  label: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.accent,
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0.4,
  },
});
