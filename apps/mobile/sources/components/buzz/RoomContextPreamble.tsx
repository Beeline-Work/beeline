import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import type { RoomContextEntry } from '@/buzz/corner-context';

/**
 * The Room discussion a corner was opened out of, inscribed above the corner's
 * own first line.
 *
 * A corner opened mid-conversation used to start blank: the reader arrived
 * from a Room where the work had just been described and found a transcript
 * whose first line was the agent already working, with no trace of what led
 * there. This is that trace — the bounded window the daemon also seeds the
 * agent's first turn with, so the person and the agent are looking at the same
 * thing.
 *
 * It is quoted, not repeated: everything sits at `ledgerGhost`, the dimmest
 * tier the ledger has, one tone below even the corner's quietest own line, so
 * scrolling up reads as leaving the corner rather than as more of it. Each
 * line is capped at three lines of prose — this is a reminder of a discussion,
 * not a second transcript — and the block carries no box, per DESIGN.md: a box
 * is for something the reader must act on.
 *
 * Rendered through the FlatList's `ListFooterComponent`, which on an inverted
 * list is the visual *top* (see the transcript-list note in AGENTS.md).
 */
export const RoomContextPreamble = React.memo(function RoomContextPreamble({
  entries,
  speakerLabel,
  testID = 'room-context-preamble',
}: {
  entries: readonly RoomContextEntry[];
  /** Display handle for a pubkey, resolved by the screen's own roster. */
  speakerLabel?: (pubkey: string | undefined, isAgent: boolean) => string | undefined;
  testID?: string;
}) {
  if (!entries.length) return null;
  return (
    <View style={styles.preamble} testID={testID}>
      <Text style={styles.eyebrow}>FROM THE ROOM</Text>
      {entries.map((entry) => {
        const label = speakerLabel?.(entry.pubkey, entry.isAgent);
        return (
          <Text key={entry.id} numberOfLines={3} style={styles.line} testID={`${testID}-entry`}>
            {label ? `${label}  ` : ''}
            {entry.text}
          </Text>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  preamble: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 22,
    gap: 10,
  },
  eyebrow: {
    ...Typography.mono(),
    color: groknight.ledgerGhost,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1.4,
  },
  line: {
    ...Typography.ledger(),
    color: groknight.ledgerGhost,
    fontSize: 14,
    lineHeight: 22,
  },
});
