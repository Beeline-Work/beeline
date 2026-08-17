import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { MonoMarkdown } from './MonoMarkdown';

/**
 * The obsidian ledger — the one transcript primitive a Room and a Corner both
 * render.
 *
 * The screen is a single unbroken slab; the agent's output is what is written
 * across it. So an agent turn is plain flowing text: no bubble, no card, no
 * per-message frame, no rule. Only luminance separates it from the black —
 * ledger text is the brightest tone on the surface and carries a whisper of
 * glow, which is why it reads as lit rather than printed. Rhythm alone
 * separates one paragraph from the next.
 *
 * A human's turn is the one thing that must be findable while scrolling a long
 * ledger, so it inverts every axis the ledger uses at once: a hairline rule
 * interrupts the page above it, the block pulls to the right margin, the type
 * goes semibold, and a signature names who. Four redundant signals, still zero
 * boxes — a repeating content unit never earns a border, fill, or radius
 * (DESIGN.md, "Shape").
 *
 * The only thing that differs between the two surfaces is attribution, and it
 * differs because the surfaces genuinely differ: a Corner has exactly one
 * administering agent (`openSubchannel` in `apps/body/src/body.ts` signs every
 * corner with a single agent identity), so it names that agent once in the top
 * bar and passes no attribution here. A Room can hold several agents, so it
 * passes `LedgerAttribution` and each agent's voice stays identifiable in the
 * flow. Same component, same shape language, one prop.
 */

type LedgerBodyProps = {
  itemId: string;
  bodyText: string | undefined;
  bodyTestID: string;
  /**
   * A Room's quiet inline speaker mark. Omitted in a Corner, where the single
   * agent is named in the top bar instead of on every paragraph.
   */
  attribution?: React.ReactNode;
  replyReference?: React.ReactNode;
  attachments?: React.ReactNode;
};

/**
 * Who is writing, stated quietly: a small faceted mark, the name in mono, and
 * (for a registered agent) its presence light. Deliberately dimmer and smaller
 * than the prose underneath — it labels the voice without competing with what
 * the voice says.
 */
export function LedgerAttribution({
  mark,
  name,
  detail,
  presence,
  testID,
}: {
  mark?: React.ReactNode;
  name: string;
  /** A Room appends the author's short npub here; names are not unique. */
  detail?: string | null;
  presence?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.attribution} testID={testID}>
      {mark}
      {presence}
      <Text numberOfLines={1} style={styles.attributionName}>
        {name.toUpperCase()}
      </Text>
      {detail ? (
        <Text numberOfLines={1} style={styles.attributionDetail}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/** One agent paragraph, written straight onto the slab. */
export function LedgerEntry({
  itemId,
  bodyText,
  bodyTestID,
  attribution,
  replyReference,
  attachments,
}: LedgerBodyProps) {
  return (
    <View style={styles.ledgerEntry} testID={`chat-message-${itemId}`}>
      {attribution}
      {replyReference}
      {bodyText ? (
        <MonoMarkdown markdown={bodyText} textStyle={styles.ledgerText} testID={bodyTestID} />
      ) : null}
      {attachments}
    </View>
  );
}

/**
 * A person steering: the ledger's margin note, and its loudest voice.
 *
 * Who is named once per block, and where depends on the surface for the same
 * reason attribution does. A Corner is one agent writing and a person
 * occasionally interrupting, so the interruption signs off at the end —
 * `— YOU`. A Room is several people and several agents, and there the name has
 * to arrive *before* the words for a fast scroll to work, so it takes the same
 * leading attribution an agent entry does. One or the other; never both.
 *
 * `continued` folds a run of messages from one person into a single block — no
 * second rule, no second name — for the same reason an agent announces itself
 * once per run rather than once per paragraph.
 */
export function LedgerSteer({
  itemId,
  signature,
  attribution,
  continued = false,
  bodyText,
  bodyTestID,
  replyReference,
  attachments,
  offlineQueued = false,
}: LedgerBodyProps & {
  signature: string;
  continued?: boolean;
  offlineQueued?: boolean;
}) {
  return (
    <View
      style={[styles.steerBlock, continued && styles.steerBlockContinued]}
      testID={`chat-message-${itemId}`}
    >
      {continued ? null : <View style={styles.steerRule} />}
      <View style={styles.steer}>
        {attribution}
        {replyReference}
        {bodyText ? (
          <MonoMarkdown markdown={bodyText} textStyle={styles.steerText} testID={bodyTestID} />
        ) : null}
        {attachments}
        {offlineQueued ? (
          <Text style={styles.steerNote}>SENT TO ROOM · AGENT OFFLINE</Text>
        ) : null}
        {attribution || continued ? null : (
          <Text numberOfLines={1} style={styles.steerSignature} testID={`chat-steer-by-${itemId}`}>
            — {signature}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Vertical rhythm alone separates one ledger paragraph from the next.
  ledgerEntry: {
    width: '100%',
    minWidth: 0,
    marginBottom: 22,
  },
  /**
   * The luminous line. `textPrimary` on the near-black slab, plus a shadow of
   * the same tone at zero offset — a diffuse halo, not a drop shadow, so the
   * text reads as emitting rather than sitting on the surface. Luminance and
   * weight only: no hue enters the transcript (DESIGN.md, "Luminance").
   */
  ledgerText: {
    ...Typography.default(),
    width: '100%',
    minWidth: 0,
    color: groknight.textPrimary,
    fontSize: 14,
    lineHeight: 22,
    textShadowColor: groknight.ledgerGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  attribution: {
    marginBottom: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  attributionName: {
    ...Typography.mono('semiBold'),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 13,
    letterSpacing: 0.9,
  },
  attributionDetail: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.textDisabled,
    fontSize: 9,
    lineHeight: 13,
  },
  steerBlock: {
    width: '100%',
    minWidth: 0,
    marginTop: 6,
    marginBottom: 26,
  },
  // A continuation of the same person's block, so it closes the gap the rule
  // would otherwise have opened.
  steerBlockContinued: {
    marginTop: 0,
    marginBottom: 22,
  },
  // The one rule on the page: the ledger stops here because a person spoke.
  // A hairline divider, the same device list rows already use — not a box.
  steerRule: {
    width: '100%',
    height: StyleSheet.hairlineWidth,
    marginBottom: 16,
    backgroundColor: groknight.border,
  },
  // An explicit width, not shrink-to-fit: MonoMarkdown's own root is
  // `width: '100%'`, so an auto-width parent would have nothing but the
  // signature to size itself from and would collapse to a few characters wide.
  steer: {
    alignSelf: 'flex-end',
    minWidth: 0,
    width: '82%',
  },
  // Bold, not brighter: the agent's glow stays the brightest thing on the
  // slab, and a steer is found by weight, inset, and the rule above it.
  steerText: {
    ...Typography.default('semiBold'),
    minWidth: 0,
    color: groknight.textPrimary,
    fontSize: 15,
    lineHeight: 23,
  },
  steerNote: {
    ...Typography.mono('semiBold'),
    marginTop: 8,
    textAlign: 'right',
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 13,
    letterSpacing: 0.4,
  },
  steerSignature: {
    ...Typography.mono(),
    marginTop: 8,
    textAlign: 'right',
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 13,
    letterSpacing: 0.8,
  },
});
