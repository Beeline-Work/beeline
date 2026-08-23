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
 * there. This is that trace.
 *
 * **Two shapes, by data availability.**
 *
 * - When the daemon's hidden model call produced an organized `summary` of
 *   the discussion (carried on the corner's create event), that renders
 *   directly — no disclosure, no per-message replay. This is the form the
 *   "literal dump of the last room turns" complaint asked for: a persistent,
 *   well-organized account of what was agreed, not a second transcript.
 * - Older corners (and corners whose metadata generation fell back) have no
 *   summary, so they keep the quoted-window shape: collapsed by default as
 *   one `⋯ … · tap to expand` ghost line in the vocabulary the transcript
 *   already uses for tool output.
 *
 * Both sit at the dimmest tiers — this is context, not corner work — and the
 * block carries no box, per DESIGN.md: a box is for something the reader must
 * act on.
 *
 * Rendered through the FlatList's `ListFooterComponent`, which on an inverted
 * list is the visual *top* (see the transcript-list note in AGENTS.md).
 */
export const RoomContextPreamble = React.memo(function RoomContextPreamble({
  entries,
  summary,
  speakerLabel,
  testID = 'room-context-preamble',
}: {
  entries: readonly RoomContextEntry[];
  /** Model-generated summary of the discussion, from the daemon. When present
   *  it replaces the raw quoted window entirely. */
  summary?: string;
  /** Display handle for a pubkey, resolved by the screen's own roster. */
  speakerLabel?: (pubkey: string | undefined, isAgent: boolean) => string | undefined;
  testID?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const trimmedSummary = summary?.trim();
  if (trimmedSummary) {
    return (
      <View style={styles.preamble} testID={testID}>
        <Text style={styles.label} testID={`${testID}-label`}>
          FROM THE ROOM
        </Text>
        <Text style={styles.summary} testID={`${testID}-summary-text`}>
          {trimmedSummary}
        </Text>
      </View>
    );
  }
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
  label: {
    ...Typography.mono(),
    color: groknight.ledgerGhost,
    fontSize: 10,
    letterSpacing: 1,
  },
  summary: {
    ...Typography.ledger(),
    color: groknight.textSecondary,
    fontSize: 14,
    lineHeight: 22,
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
