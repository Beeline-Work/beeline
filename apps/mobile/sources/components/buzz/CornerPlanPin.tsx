import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';

/** Rows beyond this scroll inside the pin's own fixed-height frame instead of
 *  growing it — the plan is a reference, not a competitor for the transcript. */
const PLAN_PIN_MAX_HEIGHT = 132;

/**
 * The corner's execution plan, pinned above the transcript.
 *
 * Placement is the top of the corner, not the bottom: the bottom is already
 * spoken for by `CornerLiveBar`/`TurnProgressLine` — the composer-adjacent
 * "what's happening right now" strip — and stacking a multi-line checklist
 * there would crowd exactly where the reader's thumb is about to compose. The
 * plan is closer to a table of contents than a live status: it changes far
 * less often than the turn indicator, so it earns the stable position at the
 * top, under the header, where it never fights the composer for space and
 * never needs to move to stay visible.
 *
 * It renders only when a plan exists (no empty pin), reads as one continuous
 * region rather than a repeating list per DESIGN.md, and never grows past
 * `PLAN_PIN_MAX_HEIGHT` — a long plan scrolls inside its own frame rather
 * than pushing the transcript down.
 */
export function CornerPlanPin({
  plan,
  testID,
}: {
  plan: NonNullable<AgentActivityItem['plan']>;
  testID?: string;
}) {
  if (!plan.items.length) return null;
  return (
    <View style={styles.pin} testID={testID}>
      <Text style={styles.eyebrow}>PLAN</Text>
      {plan.objective ? (
        <Text numberOfLines={1} style={styles.objective}>
          {plan.objective}
        </Text>
      ) : null}
      <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
        {plan.items.map((item, index) => {
          const done = item.status === 'completed';
          const active = item.status === 'in_progress';
          return (
            <View key={`${index}-${item.step}`} style={styles.row}>
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
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
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
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingVertical: 2 },
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
