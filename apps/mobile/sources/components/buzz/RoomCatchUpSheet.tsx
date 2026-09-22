import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullActionSheetModal, HULL_SHEET_INSET } from '@/components/buzz/HullActionSheet';
import { catchUpClock, type CatchUpReport } from '@/buzz/room-catch-up-report';

/**
 * The catch-up sheet: a bottom-anchored modal with exactly two blocks.
 *
 * 1. Summary — prose over the unread range, the range itself stated in the
 *    sheet head (`42 msgs · 08:04–09:46`);
 * 2. Needs you — decisions and action items in ONE list, each attributed to
 *    whoever is waiting (`Niglet · 09:46`).
 *
 * Nothing else: no filters, no jump controls, no third block. The only way
 * out is dismissal, which is the sheet's own backdrop and grip.
 *
 * Both doors into it — the catch-up strip under the Room header and a
 * long-press on the disc's badge — pass the same report, built once at the
 * one seam (`buzz/room-catch-up-report.ts`).
 */
export function RoomCatchUpSheet({
  onClose,
  report,
  visible,
}: {
  onClose: () => void;
  report: CatchUpReport | null;
  visible: boolean;
}) {
  if (!report) return null;
  return (
    <HullActionSheetModal
      accessibilityLabel="Close catch up"
      modalTestID="catch-up-sheet-modal"
      onClose={onClose}
      subtitle={report.rangeLabel}
      testID="catch-up-sheet"
      title="Catch up"
      visible={visible}
    >
      <View style={styles.block} testID="catch-up-sheet-summary">
        <Text style={styles.blockHead}>Summary</Text>
        <Text style={styles.summary}>{report.summary}</Text>
      </View>
      <View style={styles.block} testID="catch-up-sheet-needs-you">
        <Text style={styles.blockHead}>Needs you</Text>
        {report.needsYou.length === 0 ? (
          <Text style={styles.empty}>Nothing is waiting on you.</Text>
        ) : (
          report.needsYou.map((item) => (
            <View key={item.id} style={styles.item} testID={`catch-up-needs-you-${item.kind}`}>
              <Text style={styles.itemText}>{item.text}</Text>
              <Text style={styles.itemAttribution}>
                {`${item.requesterName} · ${catchUpClock(item.at)}`}
              </Text>
            </View>
          ))
        )}
      </View>
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    block: {
      paddingHorizontal: HULL_SHEET_INSET,
      paddingBottom: groknight.space.md,
    },
    blockHead: {
      ...Typography.default('semiBold'),
      ...groknight.type.sectionHead,
      color: groknight.ledgerQuiet,
      paddingBottom: groknight.space.sm,
    },
    summary: {
      ...Typography.default('regular'),
      ...groknight.type.body,
      color: groknight.ledgerBody,
    },
    empty: {
      ...Typography.default('regular'),
      ...groknight.type.meta,
      color: groknight.ledgerGhost,
    },
    // One list for decisions and action items alike: what is being asked, and
    // who is waiting. Splitting them was the mock this replaces.
    item: {
      paddingBottom: groknight.space.sm,
    },
    itemText: {
      ...Typography.default('regular'),
      ...groknight.type.body,
      color: groknight.ledgerBody,
    },
    itemAttribution: {
      ...Typography.default('regular'),
      ...groknight.type.meta,
      color: groknight.ledgerQuiet,
      fontVariant: ['tabular-nums'],
    },
  };
});
