import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { BeelineMarkSpinner, MARK_CELL } from './BeelineMarkSpinner';
import { HullLivePulse } from './MonoHull';
import { SPINNER_STEP_MS, elapsedSeconds } from '@/buzz/turn-clock';

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
 * precisely what a turn in progress is.
 *
 * The shape of the line is the status-line idiom: a mark, the verb line, then
 * "(Ns · thinking)" ticking once per second. The mark is the Beeline ribbon
 * (`BeelineMarkSpinner`) drawing itself, never a cycling text glyph — a glyph
 * whose advance width changes per frame walks the label's left edge back and
 * forth, so the mark sits in one fixed `MARK_CELL` square and the label's x
 * never depends on it. The counter starts from the server receipt's own
 * `createdAt` (unix seconds), so it reads correctly even when the app opened
 * mid-turn. The ticking interval lives entirely inside this tiny leaf — it
 * never recreates the transcript.
 *
 * The same live treatment also covers the short local "sending…" bridge. It
 * expires at its deadline; this component never presents an inferred waiting
 * state in the absence of a server receipt.
 */
export function TurnProgressLine({
  label,
  startedAt,
  testID,
}: {
  label: string;
  /** Server receipt time, unix seconds, the elapsed counter ticks from. */
  startedAt?: number;
  testID?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SPINNER_STEP_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <View
      accessibilityLabel={startedAt != null ? `${label} (${elapsedSeconds(startedAt * 1_000, now)}s · thinking)` : label}
      accessibilityRole="progressbar"
      style={styles.bar}
      testID={testID}
    >
      <HullLivePulse style={styles.row}>
        <View style={styles.glyphCell} testID={testID ? `${testID}-glyph` : undefined}>
          <BeelineMarkSpinner live />
        </View>
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        {startedAt != null && (
          <Text style={styles.counter} testID={testID ? `${testID}-elapsed` : undefined}>
            {`${elapsedSeconds(startedAt * 1_000, now)}s · thinking`}
          </Text>
        )}
      </HullLivePulse>
    </View>
  );
}

/**
 * The one-line summary a finished turn leaves behind, briefly: the past-tense
 * verb, total seconds from the working receipt's server time, and the local
 * wall-clock "done" stamp. Static — no breath, no counter, the completed mark
 * — because the turn is over; the screen clears it after a few seconds.
 */
export function TurnSettledLine({ line, testID }: { line: string; testID?: string }) {
  return (
    <View accessibilityLabel={line} style={styles.bar} testID={testID}>
      <View style={styles.row}>
        <View style={styles.glyphCell} testID={testID ? `${testID}-glyph` : undefined}>
          <BeelineMarkSpinner />
        </View>
        <Text numberOfLines={1} style={styles.label}>
          {line}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
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
    // A fixed square, whatever the mark inside is doing: the label's left edge
    // must never move with the glyph.
    glyphCell: {
      width: MARK_CELL,
      height: MARK_CELL,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
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
    counter: {
      ...Typography.mono(),
      flexShrink: 0,
      color: groknight.accent,
      fontSize: 12,
      lineHeight: 18,
    },
  };
});
