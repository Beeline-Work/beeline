import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullLivePulse } from './MonoHull';

/**
 * The Room's one active-corner affordance: a single line pinned directly above
 * the composer, naming who is working and what on — `beebee active:
 * feat/ux-fix-now` — with `view →` in the same right gutter every other piece
 * of marginalia hangs in.
 *
 * A corner being open is *state*, not an event, so it does not belong in the
 * transcript scroll: a note inscribed when the corner opened scrolls away and
 * then lies, still saying "open" long after the corner merged. This is always
 * on screen for exactly as long as the state it reports is true, and tapping
 * it enters the corner. Nothing else in the Room reports corner status — the
 * inline stamps are gone.
 *
 * While the work is live the whole line is gold and breathes on the shared
 * live clock: a calm heartbeat, not a sweep, not a progress bar, and never a
 * dashed rule. It is the reserved accent doing exactly the job `DESIGN.md`
 * assigns it — an agent is alive — and the accent is never the only signal:
 * the copy says `active`, and the motion says "still going" a third time.
 * A corner that is open but idle drops to the quiet tier and stops moving, so
 * the difference between "running" and "waiting" is legible without reading.
 * Reduced motion and a backgrounded app both settle it, via `HullLivePulse`.
 */
export function CornerLiveBar({
  label,
  live,
  onPress,
  testID,
}: {
  label: string;
  live: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  const row = (
    <View style={styles.row}>
      <Text numberOfLines={1} style={[styles.label, live ? styles.labelLive : styles.labelIdle]}>
        {label}
      </Text>
      {onPress ? (
        <Text style={[styles.enter, live && styles.enterLive]}>view →</Text>
      ) : null}
    </View>
  );

  // Mounted only when something is genuinely live: a quiet Room must never pay
  // for a clock it does not use.
  const body = live ? <HullLivePulse>{row}</HullLivePulse> : row;

  if (!onPress) {
    return (
      <View accessibilityLabel={label} accessibilityRole="text" style={styles.bar} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={`${label}. Open the corner`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.bar}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  /**
   * No border, no fill, no radius. A status light is not a control the reader
   * has to hunt for — it is always in the same place, so it needs no frame to
   * be found, and framing it would put a plate on the slab.
   */
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
  label: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0.4,
  },
  labelLive: { color: groknight.accent },
  labelIdle: { color: groknight.ledgerQuiet },
  enter: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 18,
  },
  enterLive: { color: groknight.accent },
  });
});
