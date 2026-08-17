import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { MonoMarkdown } from './MonoMarkdown';

/**
 * The Corner transcript's two row shapes — deliberately NOT the Room's
 * `TranscriptRow`.
 *
 * A corner has exactly one administering agent (`openSubchannel` in
 * `apps/body/src/body.ts` signs every corner with the single agent identity),
 * so that agent never re-introduces itself per message: its faceted mark and
 * name live once in the corner's top bar, and its turns render here as plain
 * flowing text. The result is a ledger written by one hand, not a chat feed —
 * no avatar, no label, no glyph, no per-message box, and a lot of quiet.
 *
 * A human's steer is the one thing that must be findable while scrolling a
 * long ledger, so it inverts every axis the ledger uses at once: a hairline
 * rule interrupts the page above it, the block pulls to the right margin, the
 * type goes semibold in the brightest text tone, and a signature names who.
 * Four redundant signals, still zero boxes — a repeating content unit never
 * earns a border, fill, or radius (DESIGN.md, "Shape").
 */

type LedgerBodyProps = {
  itemId: string;
  bodyText: string | undefined;
  bodyTestID: string;
  replyReference?: React.ReactNode;
  attachments?: React.ReactNode;
};

/** One agent paragraph in the ledger. Identity is the top bar's job, not this row's. */
export function CornerLedgerEntry({
  itemId,
  bodyText,
  bodyTestID,
  replyReference,
  attachments,
}: LedgerBodyProps) {
  return (
    <View style={styles.ledgerEntry} testID={`chat-message-${itemId}`}>
      {replyReference}
      {bodyText ? (
        <MonoMarkdown markdown={bodyText} textStyle={styles.ledgerText} testID={bodyTestID} />
      ) : null}
      {attachments}
    </View>
  );
}

/** A human steering the corner: the ledger's margin note, and its loudest voice. */
export function CornerSteer({
  itemId,
  signature,
  bodyText,
  bodyTestID,
  replyReference,
  attachments,
  offlineQueued = false,
}: LedgerBodyProps & { signature: string; offlineQueued?: boolean }) {
  return (
    <View style={styles.steerBlock} testID={`chat-message-${itemId}`}>
      <View style={styles.steerRule} />
      <View style={styles.steer}>
        {replyReference}
        {bodyText ? (
          <MonoMarkdown markdown={bodyText} textStyle={styles.steerText} testID={bodyTestID} />
        ) : null}
        {attachments}
        {offlineQueued ? (
          <Text style={styles.steerNote}>SENT TO ROOM · AGENT OFFLINE</Text>
        ) : null}
        <Text numberOfLines={1} style={styles.steerSignature} testID={`chat-steer-by-${itemId}`}>
          — {signature}
        </Text>
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
  ledgerText: {
    ...Typography.default(),
    width: '100%',
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 22,
  },
  steerBlock: {
    width: '100%',
    minWidth: 0,
    marginTop: 6,
    marginBottom: 26,
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
