import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * The corner's objective, pinned above the transcript for the life of the
 * corner.
 *
 * **Always on.** A corner exists to do one named thing, and the reader must be
 * able to see what that is without scrolling — so the objective renders as one
 * line from the moment the corner opens, before the agent has planned
 * anything. The objective is the immutable summary supplied to `open_corner`;
 * mutable plan steps deliberately do not render here.
 *
 * Placement is the top, not the bottom: the composer-adjacent bottom is
 * already `CornerLiveBar`/`TurnProgressLine`'s "what is happening right now"
 * strip, and stacking a checklist there would crowd exactly where the reader's
 * thumb is about to compose. The objective changes less often than the turn
 * indicator — it reads closer to a table of contents than a live status.
 *
 * The objective is two lines until explicitly expanded. It renders nothing at
 * all when the fixed summary is unavailable; there is no empty placeholder.
 */
export const CornerPlanPin = React.memo(function CornerPlanPin({
  objective,
  testID,
}: {
  /** The complete, fixed text naming what this corner is for. */
  objective?: string;
  testID?: string;
}) {
  const [objectiveExpanded, setObjectiveExpanded] = React.useState(false);
  if (!objective) return null;
  return (
    <View style={styles.pin} testID={testID}>
      <Text style={styles.eyebrow}>OBJECTIVE</Text>
      <Pressable
        accessibilityHint={
          objectiveExpanded ? 'Collapses the objective' : 'Shows the full objective'
        }
        accessibilityLabel="Corner objective"
        accessibilityRole="button"
        accessibilityState={{ expanded: objectiveExpanded }}
        onPress={() => setObjectiveExpanded((expanded) => !expanded)}
        testID={`${testID}-objective-toggle`}
      >
        <Text
          numberOfLines={objectiveExpanded ? undefined : 2}
          style={styles.objective}
          testID={`${testID}-objective`}
        >
          {objective}
        </Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    pin: {
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 6,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
    },
    eyebrow: {
      ...Typography.mono(),
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 1,
    },
    objective: {
      ...Typography.default(),
      color: groknight.textPrimary,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 2,
      marginBottom: 4,
    },
  };
});
