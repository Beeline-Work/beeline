import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
 * It wraps to its full height rather than truncating to a fragment, and renders
 * nothing at all when there is neither an objective nor a brief — never a
 * placeholder. The text is whatever `cornerObjectiveItems` has already
 * filtered; raw harness output never reaches this region.
 *
 * The objective is only a navigation label; the corner's brief carries the
 * authority. When the corner has one, a `Brief` link hangs in the right gutter
 * and opens its latest revision full-screen.
 */
export const CornerObjectiveLine = React.memo(function CornerObjectiveLine({
  objective,
  onOpenBrief,
  testID = 'corner-objective-line',
}: {
  objective?: string;
  /** Present only when the corner has a brief. */
  onOpenBrief?: () => void;
  testID?: string;
}) {
  const line = objective?.trim();
  if (!line && !onOpenBrief) return null;
  return (
    <View style={styles.line} testID={testID}>
      <View style={styles.rail} />
      <Text accessibilityRole="text" style={styles.copy} testID={`${testID}-copy`}>
        {line}
      </Text>
      {onOpenBrief ? <CornerBriefLink onPress={onOpenBrief} testID={`${testID}-brief`} /> : null}
    </View>
  );
});

/**
 * The corner brief's link: one brass word, a 44pt touch target whose extra
 * height hangs outside the line so the inscription keeps its quiet rhythm.
 * Shared by the phone's objective line and the desktop work pane.
 */
export function CornerBriefLink({
  onPress,
  testID = 'corner-brief-link',
}: {
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel="Open brief"
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.briefLink, pressed && styles.briefLinkPressed]}
      testID={testID}
    >
      <Text style={styles.briefLinkText}>Brief</Text>
    </Pressable>
  );
}

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
    ...theme.buzz.type.meta,
    flex: 1,
    minWidth: 0,
    color: theme.buzz.textSecondary,
  },
  briefLink: {
    flexShrink: 0,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
    // Center the word on the first line of copy; the rest of the 44pt target
    // overhangs the line instead of pushing the transcript down.
    marginVertical: -(44 - theme.buzz.type.meta.lineHeight) / 2,
  },
  briefLinkPressed: { opacity: 0.6 },
  briefLinkText: {
    ...theme.buzz.type.meta,
    color: theme.buzz.accent,
  },
}));
