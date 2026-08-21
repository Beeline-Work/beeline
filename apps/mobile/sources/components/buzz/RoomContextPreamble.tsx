import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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
 * **Collapsed by default, and that is the point.** A freshly opened corner has
 * almost no transcript of its own, so ten quoted Room lines were the entire
 * first screen — the reader arrived at their new corner and met an undigested
 * dump of what they had just finished saying, with the corner's actual
 * objective nowhere in sight. Reported as "at corner open there is no goal
 * summary, just a literal dump of the last room turns, indecipherable". The
 * block now opens as one ghost line in the same `⋯ … · tap to expand`
 * vocabulary the transcript already uses for tool output, so the objective pin
 * leads and the context is there for whoever wants it.
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
  const [expanded, setExpanded] = useState(false);
  if (!entries.length) return null;
  const count = entries.length;
  return (
    <View style={styles.preamble} testID={testID}>
      <Pressable
        accessibilityLabel={
          expanded
            ? 'Collapse the Room discussion this corner came from'
            : `${count} earlier ${count === 1 ? 'message' : 'messages'} from the Room. Expand`
        }
        accessibilityRole="button"
        onPress={() => setExpanded((open) => !open)}
        style={styles.disclosureRow}
        testID={`${testID}-disclosure`}
      >
        {/* Two Texts, one line, exactly as `LedgerGhostLine` does it: a single
            truncating Text eats the affordance copy first, and the affordance
            is the whole reason the collapsed line exists. */}
        <Text numberOfLines={1} style={styles.disclosure} testID={`${testID}-summary`}>
          ⋯ {count} earlier {count === 1 ? 'message' : 'messages'} from the Room
        </Text>
        <Text style={styles.disclosureAffordance} testID={`${testID}-affordance`}>
          {' '}
          · tap to {expanded ? 'collapse' : 'expand'}
        </Text>
      </Pressable>
      {expanded
        ? entries.map((entry) => {
            const label = speakerLabel?.(entry.pubkey, entry.isAgent);
            return (
              <Text key={entry.id} numberOfLines={3} style={styles.line} testID={`${testID}-entry`}>
                {label ? `${label}  ` : ''}
                {entry.text}
              </Text>
            );
          })
        : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  preamble: {
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 22,
    gap: 10,
  },
  disclosureRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  disclosure: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 16,
  },
  disclosureAffordance: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 16,
  },
  line: {
    ...Typography.ledger(),
    color: groknight.ledgerGhost,
    fontSize: 14,
    lineHeight: 22,
  },
  });
});
