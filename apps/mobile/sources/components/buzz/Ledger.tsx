import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { MonoMarkdown } from './MonoMarkdown';

/**
 * The obsidian ledger — the one transcript primitive a Room and a Corner both
 * render.
 *
 * An alien prophecy inscribed on a single slab, not a chat app. Everything the
 * shape of a message — a bubble, a card, a frame, a rule between turns, a name
 * on its own row — is gone. What is left is one flowing column of terminal type
 * with a ghosted margin down its right edge.
 *
 * **Weight goes down; tone and indentation do all the work.** The whole ledger
 * is set at one size in one regular weight (`Typography.ledger()`), and every
 * distinction the reader needs is carried by the `groknight.ledger*` luminance
 * ladder and by where the block sits:
 *
 *   bright + bloom, left column   an agent writing — the prophecy
 *   mid-grey, left column         another person writing
 *   mid-grey, inset right         you, steering
 *   quiet                         the inline handle that opens a voice's run
 *   ghost                         the right-gutter stamp, collapsed machine noise
 *
 * Nothing here is loud by being fat. Bold is banned outright: it fought the
 * inscribed feel, and it is the one axis a light-on-black slab cannot spend.
 *
 * The surfaces differ in exactly one place, and it tracks a real difference
 * between them. A Corner has one administering agent (`openSubchannel` in
 * `apps/body/src/body.ts` signs every corner with a single identity), named
 * once in the top bar — so a Corner's agent turns carry no handle at all and
 * read as pure flowing text. A Room can hold several agents and several people,
 * so a voice states its handle inline, once, when it takes over. Same
 * component, one prop.
 */

/** The right margin the ghosted stamp hangs in, clear of the flowing column. */
export const LEDGER_MARGINALIA_WIDTH = 36;

type LedgerBodyProps = {
  itemId: string;
  bodyText: string | undefined;
  bodyTestID: string;
  /**
   * The voice's handle, set inline as the first thing on the first line so the
   * entry reads as one log line rather than a name-on-its-own-row header.
   * Omitted on a continuation of the same voice, and omitted entirely in a
   * Corner, whose single agent is named in the top bar.
   */
  handle?: string;
  /** A run's opening entry gets air above it; a continuation keeps flowing. */
  continued?: boolean;
  marginalia?: React.ReactNode;
  replyReference?: React.ReactNode;
  attachments?: React.ReactNode;
  /** The turn's tool run, collapsed — rendered under the prose it belongs to. */
  machineNoise?: React.ReactNode;
};

/**
 * The ghosted margin: a fixed-width clock stamp, and (when a voice first
 * announces itself in a Room) the author's short npub under it.
 *
 * Hung in the right margin rather than set into the flow, so the centre stays a
 * clean column — editor line numbers, verse numbers. It is absolutely
 * positioned against the entry so it can never push the prose around, and it
 * takes the dimmest tier because none of it is information the reader is
 * looking for; it is information the reader occasionally checks.
 */
export function LedgerMarginalia({
  stamp,
  detail,
  testID,
}: {
  stamp: string;
  /** A Room appends the author's short npub here; display names are not unique. */
  detail?: string | null;
  testID?: string;
}) {
  if (!stamp && !detail) return null;
  return (
    <View pointerEvents="none" style={styles.marginalia} testID={testID}>
      {stamp ? (
        <Text numberOfLines={1} style={styles.marginaliaStamp}>
          {stamp}
        </Text>
      ) : null}
      {detail ? (
        <Text numberOfLines={1} style={styles.marginaliaDetail}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One turn, written straight onto the slab.
 *
 * `luminous` is the ladder's top step and belongs to the agent alone: its
 * output is the thing the slab exists to show, so it takes the brightest tone
 * and a whisper of bloom. Everyone else writing in the left column takes the
 * ordinary mid-grey. No frame, no rule, no glyph, no box — a run of entries is
 * separated from the next voice by air and nothing else.
 */
export function LedgerEntry({
  itemId,
  bodyText,
  bodyTestID,
  handle,
  continued = false,
  luminous = false,
  marginalia,
  replyReference,
  attachments,
  machineNoise,
}: LedgerBodyProps & { luminous?: boolean }) {
  return (
    <View
      style={[styles.entry, continued ? styles.entryContinued : styles.entryOpens]}
      testID={`chat-message-${itemId}`}
    >
      {marginalia}
      {replyReference}
      {bodyText ? (
        <MonoMarkdown
          markdown={bodyText}
          textStyle={luminous ? styles.ledgerTextLuminous : styles.ledgerText}
          leadingInline={
            handle ? (
              <Text style={styles.handle} testID={`chat-handle-${itemId}`}>
                {handle.toUpperCase()}{'  '}
              </Text>
            ) : null
          }
          testID={bodyTestID}
        />
      ) : handle ? (
        <Text style={styles.handle} testID={`chat-handle-${itemId}`}>
          {handle.toUpperCase()}
        </Text>
      ) : null}
      {machineNoise}
      {attachments}
    </View>
  );
}

/**
 * You, steering.
 *
 * Identified by geometry alone: pulled to the right margin and one luminance
 * step down from the agent output it interrupts. No caption, no signature, no
 * rule — on a linear log, "the block that is inset and dim is mine" is learned
 * once and never has to be restated. A run of your own messages keeps flowing
 * as one passage for the same reason a voice announces itself once.
 */
export function LedgerSteer({
  itemId,
  bodyText,
  bodyTestID,
  continued = false,
  marginalia,
  replyReference,
  attachments,
  offlineQueued = false,
}: Omit<LedgerBodyProps, 'handle' | 'machineNoise'> & { offlineQueued?: boolean }) {
  return (
    <View
      style={[styles.entry, continued ? styles.entryContinued : styles.entryOpens]}
      testID={`chat-message-${itemId}`}
    >
      {marginalia}
      <View style={styles.steer}>
        {replyReference}
        {bodyText ? (
          <MonoMarkdown markdown={bodyText} textStyle={styles.steerText} testID={bodyTestID} />
        ) : null}
        {attachments}
        {offlineQueued ? (
          <Text style={styles.steerNote}>SENT TO ROOM · AGENT OFFLINE</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A wall of tool output, folded into one ghost line.
 *
 * The dimmest tier, one line, with its own disclosure — a `git push` rejection
 * dump, a stack trace, an npm error wall never prints down the slab. The label
 * says what happened and the body stays behind a tap
 * (`DESIGN.md`, "Machine noise").
 */
export function LedgerGhostLine({
  label,
  body,
  testID,
}: {
  label: string;
  body: string;
  testID?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.ghostBlock} testID={testID}>
      <Pressable
        accessibilityLabel={expanded ? `Collapse ${label}` : `${label}. Expand`}
        accessibilityRole="button"
        onPress={() => setExpanded((open) => !open)}
        style={styles.ghostRow}
      >
        {/* Two Texts, one line. A single truncating Text would eat the
            disclosure copy first — the affordance is the whole point of the
            line, so it is the part that must never be the one to go. Both hold
            plain string children, clear of the Android blank-flex-Text bug. */}
        <Text numberOfLines={1} style={styles.ghostLine}>
          ⋯ {label}
        </Text>
        <Text style={styles.ghostAffordance}> · tap to {expanded ? 'collapse' : 'expand'}</Text>
      </Pressable>
      {expanded ? (
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.ghostBody} testID={testID ? `${testID}-body` : undefined}>
            {body}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Air is the only separator in the transcript — no rules, no dividers, no
   * boxes between turns.
   *
   * `marginBottom` is the gap that appears *above* an entry on screen: the
   * transcript FlatList is `inverted`, so each cell's own bottom margin lands
   * at its visual top. `continued` describes the entry immediately above, so
   * that is the side the run/stanza distinction has to be spent on.
   */
  entry: {
    width: '100%',
    minWidth: 0,
    paddingRight: LEDGER_MARGINALIA_WIDTH,
  },
  entryContinued: { marginBottom: 9 },
  entryOpens: { marginBottom: 27 },
  /**
   * The prophecy. Brightest tone on the slab plus a wide, low-alpha halo of its
   * own tone at zero offset — a diffuse emission, not a drop shadow, so the
   * text reads as lit from within rather than sitting on the surface. Luminance
   * only: no hue and no extra weight enter the transcript.
   */
  ledgerTextLuminous: {
    ...Typography.ledger(),
    width: '100%',
    minWidth: 0,
    color: groknight.ledgerBright,
    fontSize: 16,
    lineHeight: 26,
    textShadowColor: groknight.ledgerGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 7,
  },
  /** Everyone else in the left column: same face, same size, one step down. */
  ledgerText: {
    ...Typography.ledger(),
    width: '100%',
    minWidth: 0,
    color: groknight.ledgerBody,
    fontSize: 16,
    lineHeight: 26,
  },
  /**
   * Inline with the prose, never a row of its own — nested inside the first
   * paragraph's own `Text` so it wraps as part of the log line. (A `flex: 1`
   * `Text` that only wraps other `Text` inside a row `View` renders blank on
   * Android; this shape avoids that class of bug entirely.)
   */
  handle: {
    ...Typography.ledger(),
    color: groknight.ledgerQuiet,
    fontSize: 16,
    lineHeight: 26,
    letterSpacing: 0.6,
  },
  /** Absolute, so the stamp can never reflow the column it annotates. */
  marginalia: {
    position: 'absolute',
    top: 4,
    right: 0,
    width: LEDGER_MARGINALIA_WIDTH,
    alignItems: 'flex-end',
  },
  marginaliaStamp: {
    ...Typography.mono(),
    color: groknight.ledgerGhost,
    fontSize: 9,
    lineHeight: 12,
  },
  marginaliaDetail: {
    ...Typography.mono(),
    marginTop: 1,
    color: groknight.ledgerGhost,
    fontSize: 8,
    lineHeight: 11,
  },
  /**
   * An explicit width, not shrink-to-fit: MonoMarkdown's own root is
   * `width: '100%'`, so an auto-width parent would have nothing to size itself
   * from and would collapse to a few characters wide.
   */
  steer: {
    alignSelf: 'flex-end',
    minWidth: 0,
    width: '86%',
  },
  /** Dimmer and inset. That is the whole signal; there is no label. */
  steerText: {
    ...Typography.ledger(),
    minWidth: 0,
    color: groknight.ledgerBody,
    fontSize: 16,
    lineHeight: 26,
  },
  steerNote: {
    ...Typography.mono(),
    marginTop: 8,
    textAlign: 'right',
    color: groknight.ledgerGhost,
    fontSize: 9,
    lineHeight: 13,
    letterSpacing: 0.4,
  },
  ghostBlock: { width: '100%', minWidth: 0, marginTop: 6 },
  ghostRow: { minWidth: 0, flexDirection: 'row', alignItems: 'baseline' },
  ghostLine: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 20,
  },
  ghostAffordance: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 20,
  },
  ghostBody: {
    ...Typography.mono(),
    marginTop: 4,
    color: groknight.ledgerGhost,
    fontSize: 10,
    lineHeight: 15,
  },
});
