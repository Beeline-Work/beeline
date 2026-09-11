import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * What the corner was opened for, inscribed beneath the header for the corner's
 * whole life.
 *
 * The objective used to be a boxed OBJECTIVE panel, removed with the rest of
 * the header furniture in #844 on the grounds that the corner name was the
 * objective verbatim. Short corner names (#890) ended that: the header now
 * carries a slug, and the human's actual request survived only in the empty
 * state, so it vanished at the first message — exactly when the transcript
 * starts to bury what the work was for.
 *
 * So it comes back as prose, not as a panel: a brass `humanRail` hairline in
 * the margin, `textSecondary` copy at the prose margin, no border, no fill, no
 * label. The rail is the same mark the ledger gives a human's own words, which
 * is what this is — the person's request, held still while the agent works. A
 * box is for something the reader must act on (DESIGN.md), and this is only
 * ever a reminder.
 *
 * It wraps once rather than truncating to a fragment, the same rule the corner
 * header title follows, and renders nothing at all when there is no objective —
 * never a placeholder. The text is whatever `cornerObjectiveItems` has already
 * filtered; raw harness output never reaches this region.
 */
export const CornerObjectiveLine = React.memo(function CornerObjectiveLine({
  objective,
  testID = 'corner-objective-line',
}: {
  objective?: string;
  testID?: string;
}) {
  const line = objective?.trim();
  if (!line) return null;
  return (
    <View accessibilityRole="text" style={styles.line} testID={testID}>
      <View style={styles.rail} />
      <Text numberOfLines={2} style={styles.copy} testID={`${testID}-copy`}>
        {line}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // No border, no fill, no radius: the rail is the whole frame this line gets.
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minWidth: 0,
    // The transcript's content inset, so the copy sits on the prose margin.
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 4,
    gap: 8,
  },
  rail: {
    alignSelf: 'stretch',
    width: 2,
    backgroundColor: theme.buzz.humanRail,
  },
  copy: {
    ...Typography.default(),
    fontFamily: theme.buzz.proseRegular,
    flexShrink: 1,
    minWidth: 0,
    color: theme.buzz.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
}));
