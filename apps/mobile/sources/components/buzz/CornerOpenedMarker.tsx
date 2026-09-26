import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CornerBranchGlyph } from './CornerBranchGlyph';
import { LEDGER_MARGINALIA_WIDTH } from './Ledger';

/** A one-line target grows its tap area, not its drawn height. */
const HIT_SLOP = { top: 6, bottom: 6 } as const;

/**
 * The line a message carries once a corner was opened from it: the branch
 * mark, `Corner opened · <title>`, and a brass `Open →` that goes straight
 * into that corner. Inscribed, not framed — it is a fact about the message
 * above, in the ledger's quiet tier, with the one brass word as its action.
 * The whole line is the target so the tap never has to find the word.
 */
export function CornerOpenedMarker({
  title,
  closed = false,
  onOpen,
  testID,
}: {
  title: string;
  /** The corner has since closed; the line still opens it, read-only. */
  closed?: boolean;
  onOpen: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={`Open corner ${title}`}
      accessibilityRole="link"
      hitSlop={HIT_SLOP}
      onPress={onOpen}
      style={({ pressed }) => [styles.marker, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.glyph}>
        <CornerBranchGlyph />
      </View>
      <Text numberOfLines={1} style={styles.line}>
        {closed ? 'Corner closed' : 'Corner opened'}
        {' · '}
        <Text style={styles.title}>{title}</Text>
      </Text>
      <Text style={styles.open}>Open →</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  marker: {
    width: '100%',
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    // Hangs off the entry above: the same rhythm as the gap between two
    // messages, so it reads as part of that message, not a row of its own.
    paddingTop: theme.buzz.space.xs,
    paddingBottom: theme.buzz.space.sm,
    paddingRight: LEDGER_MARGINALIA_WIDTH,
  },
  pressed: { opacity: 0.6 },
  glyph: { flexShrink: 0 },
  line: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.ledgerQuiet,
    flexShrink: 1,
    minWidth: 0,
  },
  title: { color: theme.buzz.ledgerBody },
  open: {
    ...theme.buzz.type.meta,
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.accent,
    flexShrink: 0,
  },
}));
