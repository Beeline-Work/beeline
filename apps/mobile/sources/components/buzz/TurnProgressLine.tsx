import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { BeelineMarkSpinner, MARK_CELL } from './BeelineMarkSpinner';
import { HullLivePulse } from './MonoHull';
import { SPINNER_STEP_MS, formatWorkingCounter } from '@/buzz/turn-clock';
import {
  TURN_LINE_BAR_MARGIN_BOTTOM,
  TURN_LINE_ROW_MIN_HEIGHT,
  roomBottomChromeStyles,
} from '@/buzz/room-bottom-chrome';

/** Smaller than the 18pt mark it sits beside. Hit slop keeps the 44pt target. */
const STOP_HIT_SLOP = 9;

/** One glyph in the label's own font. The measured copy needs a line box, not
 *  a word — nobody ever sees this character. */
const MEASURE_GLYPH = 'M';

/**
 * The ordinary per-turn indicator: the agent has taken this Room's question
 * and has not answered yet. One transient line pinned above the composer,
 * gone the moment the reply lands.
 *
 * It is the ONLY line here, and it reports a turn and nothing else. A turn is
 * a thing the reader is *waiting* for, so this names nobody's corner, carries
 * no `view →`, and cannot be pressed — there is nowhere to go. The retired
 * pinned corner line used to sit beneath it; conflating the two is what once
 * lit that gold line — pointed at a corner long since archived — for a plain
 * "who is Alan?" question. Corner state is read in the corners list now.
 *
 * Gold and the shared live breath are still correct here: `DESIGN.md` assigns
 * that pair to exactly one meaning, an agent is alive and working, which is
 * precisely what a turn in progress is.
 *
 * The shape of the line is the status-line idiom: a mark, the verb line, then
 * elapsed minutes and seconds ticking once per second. The mark is the Beeline
 * icon (`BeelineMarkSpinner`) painting itself and releasing — never a cycling
 * text glyph or a row of dots. A glyph whose advance width changes per frame
 * walks the label's left edge back and forth, so the mark sits in one fixed
 * `MARK_CELL` square and the label's x never depends on it. The counter starts from the server receipt's own
 * `createdAt` (unix seconds), so it reads correctly even when the app opened
 * mid-turn. The ticking interval lives entirely inside this tiny leaf — it
 * never recreates the transcript.
 *
 * The same live treatment also covers the short local "sending…" bridge. It
 * expires at its deadline; this component never presents an inferred waiting
 * state in the absence of a server receipt.
 *
 * The LINE still goes nowhere — it has no `onPress` and no destination, which
 * is what keeps it from stranding a reader in a dead channel. `onStop` is a
 * different thing in the trailing slot: not navigation but the one action a
 * turn in progress admits, withdrawing the question. It is passed only to the
 * requester or Room manager (`viewerMayStopTurn`), so for everyone else this component
 * renders exactly what it rendered before. A press is acknowledged here —
 * the control dims and the counter says `stopping` — before the cancelled
 * receipt lands; a failed stop enables it again.
 */
export function TurnProgressLine({
  label,
  startedAt,
  received = false,
  onStop,
  stopping = false,
  testID,
}: {
  label: string;
  /** Server receipt time, unix seconds, the elapsed counter ticks from. */
  startedAt?: number;
  /** A new human steer was committed against this running turn. */
  received?: boolean;
  /** Present only for a requester or Room manager; absent renders no control. */
  onStop?: () => void;
  /** The asker already pressed stop; the cancelled receipt has not landed yet. */
  stopping?: boolean;
  testID?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SPINNER_STEP_MS);
    return () => clearInterval(timer);
  }, []);

  const phase = stopping ? 'stopping' : 'thinking';
  const counter =
    startedAt != null ? formatWorkingCounter(startedAt * 1_000, now, phase) : undefined;
  const stateLabel = [counter, received ? 'received' : undefined].filter(Boolean).join(' · ');

  return (
    <View
      accessibilityLabel={stateLabel ? `${label} (${stateLabel})` : label}
      accessibilityLiveRegion="polite"
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
        {counter != null && (
          <Text style={styles.counter} testID={testID ? `${testID}-elapsed` : undefined}>
            {counter}
          </Text>
        )}
        {received && (
          <Text style={styles.counter} testID={testID ? `${testID}-received` : undefined}>
            · received
          </Text>
        )}
        {onStop && (
          <Pressable
            accessibilityLabel={stopping ? 'Stopping this turn' : 'Stop this turn'}
            accessibilityRole="button"
            accessibilityState={{ busy: stopping, disabled: stopping }}
            disabled={stopping}
            hitSlop={STOP_HIT_SLOP}
            onPress={stopping ? undefined : onStop}
            style={({ pressed }) => [
              styles.stop,
              pressed && !stopping && styles.stopPressed,
              stopping && styles.stopStopping,
            ]}
            testID={testID ? `${testID}-stop` : undefined}
          >
            <Text style={styles.stopLabel}>■ STOP</Text>
          </Pressable>
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

/**
 * The band's box with nothing in it, mounted always and shown never, so the
 * slot's height is known BEFORE any band is shown.
 *
 * The reserve cannot be read off the visible band. A band reports its height
 * only once it has been laid out, and a band taller than the reserve — the
 * reader's accessibility text scale makes one — has by then already taken the
 * extra out of the list's viewport and shrunk the transcript. This copy is
 * laid out in the same width, at the same text scale, out of the same
 * stylesheet, while the slot is still empty.
 *
 * It carries the tallest variant's parts — the mark cell, the mono label and
 * the stop control — because the row is as tall as its tallest child. It has
 * no counter, no breath, and no accessibility presence: it exists to be
 * measured, not to be read or heard.
 */
/**
 * Where the turn line lives: in the margin the transcript already leaves below
 * its newest message, painted over it rather than added beneath it.
 *
 * Earlier rounds gave the line its own strip, which forced a choice with no
 * good side. An in-flow band takes its height out of the list, so the
 * transcript shifted every time an agent started or stopped working. Holding a
 * strip open permanently stopped the shift but left an empty band above the
 * composer in every Room, whether or not anybody was working, and needed a
 * hidden duplicate of the line mounted purely to measure it.
 *
 * Neither was necessary: the room between the newest message and the composer
 * is already the ordinary speaker-change margin, which is taller than the
 * line. Painting into space that exists costs no height, so there is nothing
 * to reserve, nothing to measure, and nothing for the transcript to move by.
 */
export function TurnBandSlot({
  children,
  testID,
}: {
  children?: React.ReactNode;
  testID?: string;
}) {
  // The line paints into the margin the transcript already leaves below its
  // newest message — the same margin a speaker change leaves between any two
  // messages. It reserves nothing: with no held-open strip there is no empty
  // band when nobody is working, and with no height of its own to gain or
  // lose there is nothing for the transcript to move by.
  return (
    <View pointerEvents="box-none" style={styles.slot} testID={testID}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  const bottomChrome = roomBottomChromeStyles(groknight);
  return {
    // The line's surface is the transcript's own; see `room-bottom-chrome`.
    slot: bottomChrome.hangingTurnChrome,
    // The line sits inside the margin the transcript already leaves below its
    // newest message, so it adds no height and must stay one row.
    bar: {
      width: '100%',
      minWidth: 0,
      marginBottom: TURN_LINE_BAR_MARGIN_BOTTOM,
      paddingHorizontal: 8,
    },
    row: {
      minHeight: TURN_LINE_ROW_MIN_HEIGHT,
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
    // One discoverable stop action, shared by Room and corner working lines.
    stop: {
      minHeight: 26,
      justifyContent: 'center',
      marginLeft: 'auto',
      flexShrink: 0,
    },
    stopLabel: {
      ...groknight.type.sectionHead,
      color: groknight.accent,
    },
    stopPressed: {
      opacity: 0.6,
    },
    stopStopping: {
      opacity: 0.45,
    },
  };
});
