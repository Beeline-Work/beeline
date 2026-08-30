import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullLivePulse } from '@/components/buzz/MonoHull';

type CornerPlan = {
  readonly objective?: string;
  readonly items: readonly {
    readonly step: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
  }[];
};

/** Three rows, then it scrolls inside its own frame. The panel is a fixture,
 *  not a competitor for the transcript — a ten-step plan must cost the reader
 *  the same screen as a three-step one. */
const PLAN_PIN_VISIBLE_ROWS = 3;
const PLAN_PIN_ROW_HEIGHT = 20;
const PLAN_PIN_MAX_HEIGHT = PLAN_PIN_VISIBLE_ROWS * PLAN_PIN_ROW_HEIGHT;

/**
 * The corner's objective, pinned above the transcript for the life of the
 * corner.
 *
 * **Always on.** A corner exists to do one named thing, and the reader must be
 * able to see what that is without scrolling — so the objective renders as one
 * line from the moment the corner opens, before the agent has planned
 * anything. When the agent does publish a multi-step plan it renders under
 * that line as a checklist: the step in flight is gold and breathing, finished
 * steps are struck through and grey, the rest sit at the quiet floor.
 *
 * Placement is the top, not the bottom: the composer-adjacent bottom is
 * already `CornerLiveBar`/`TurnProgressLine`'s "what is happening right now"
 * strip, and stacking a checklist there would crowd exactly where the reader's
 * thumb is about to compose. The plan changes far less often than the turn
 * indicator — it reads closer to a table of contents than a live status.
 *
 * Two rules keep it from becoming the region that ate the corner, which is how
 * the first attempt at this panel (PR #165) failed: every line is capped to
 * one line of text, the objective is two lines until explicitly expanded, and
 * the checklist never grows past
 * `PLAN_PIN_MAX_HEIGHT` — a long plan scrolls inside its own frame rather than
 * pushing the transcript down. It renders nothing at all when there is neither
 * an objective nor a plan; there is no empty pin and no placeholder copy.
 */
export const CornerPlanPin = React.memo(function CornerPlanPin({
  objective,
  plan,
  testID,
}: {
  /** The complete, single-line text naming what this corner is for. */
  objective?: string;
  plan?: CornerPlan;
  testID?: string;
}) {
  const [objectiveExpanded, setObjectiveExpanded] = React.useState(false);
  const items = plan?.items ?? [];
  // The create-event objective is write-once. Plan objective only supports
  // legacy corners whose immutable task metadata is absent.
  const headline = objective ?? plan?.objective;
  if (!headline && !items.length) return null;
  return (
    <View style={styles.pin} testID={testID}>
      <Text style={styles.eyebrow}>OBJECTIVE</Text>
      {headline ? (
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
            {headline}
          </Text>
        </Pressable>
      ) : null}
      {items.length ? (
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {items.map((item, index) => {
            const done = item.status === 'completed';
            const active = item.status === 'in_progress';
            const row = (
              <View style={styles.row}>
                <Text style={[styles.mark, done && styles.markDone, active && styles.markActive]}>
                  {done ? '✓' : active ? '◐' : '□'}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.step, done && styles.stepDone, active && styles.stepActive]}
                >
                  {item.step}
                </Text>
              </View>
            );
            const key = `${index}-${item.step}`;
            // The step in flight breathes on the shared live cycle — the same
            // calm heartbeat `CornerLiveBar` uses, so "gold and moving" means
            // one thing across the whole corner. Reduced motion drops the
            // motion and keeps the gold; the glyph and the tone still report
            // the state on their own.
            return active ? (
              <HullLivePulse key={key} style={styles.activeRow}>
                {row}
              </HullLivePulse>
            ) : (
              <React.Fragment key={key}>{row}</React.Fragment>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
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
  list: {
    maxHeight: PLAN_PIN_MAX_HEIGHT,
  },
  activeRow: { alignSelf: 'stretch' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    height: PLAN_PIN_ROW_HEIGHT,
  },
  mark: {
    ...Typography.mono(),
    color: groknight.ledgerQuiet,
    fontSize: 10,
    lineHeight: 16,
  },
  markDone: { color: groknight.textMuted },
  markActive: { color: groknight.accent },
  step: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.ledgerQuiet,
    fontSize: 12,
    lineHeight: 16,
  },
  stepDone: { color: groknight.textMuted, textDecorationLine: 'line-through' },
  stepActive: { color: groknight.accent },
  });
});
