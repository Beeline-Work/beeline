/**
 * Persistent objective banner pinned at the top of a live corner: what this
 * corner was opened to do, plus (when the agent's ACP harness surfaces a
 * plan) a live checklist whose items strike through as their status flips
 * to completed. Subscribes directly to the body's `#t=corner-objective`
 * record and holds its own local state, mirroring StreamingAgentText — a
 * checklist update never touches the parent screen's transcript state.
 *
 * Renders nothing until the body's first `corner-objective` record arrives
 * (published the moment the corner goes live), so there is no empty flash.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BuzzRigTransport } from '@/sync/transport';
import {
  cornerObjectiveFromSessionEvent,
  cornerObjectiveProgress,
  cornerObjectiveStepPresentation,
  type CornerObjective,
} from '@/buzz/corner-objective';
import { HullSurface } from '@/components/buzz/MonoHull';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';

type CornerObjectiveBannerProps = {
  transport: BuzzRigTransport;
  channelId: string;
  testID?: string;
};

/** Above this many steps, the checklist starts collapsed to keep the transcript from being swallowed. */
const COLLAPSE_THRESHOLD = 4;
const COLLAPSED_VISIBLE_STEPS = 2;

export const CornerObjectiveBanner = React.memo(function CornerObjectiveBanner({
  transport,
  channelId,
  testID = 'corner-objective-banner',
}: CornerObjectiveBannerProps) {
  const [objective, setObjective] = useState<CornerObjective | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setObjective(undefined);
    setExpanded(false);
    let cancelled = false;
    let stopSubscribe: (() => void) | undefined;

    const apply = (event: Parameters<typeof cornerObjectiveFromSessionEvent>[0]) => {
      if (cancelled) return;
      const next = cornerObjectiveFromSessionEvent(event);
      if (next) setObjective((current) => (current && current.observedAt > next.observedAt ? current : next));
    };

    (async () => {
      try {
        const stop = await transport.cornerObjectiveSubscribeReady(channelId, apply);
        if (cancelled) {
          stop();
          return;
        }
        stopSubscribe = stop;
      } catch (error) {
        console.warn(`CornerObjectiveBanner: subscribe failed for ${channelId}:`, error);
      }
      try {
        const backfill = await transport.cornerObjectiveBackfill(channelId);
        backfill.forEach(apply);
      } catch (error) {
        console.warn(`CornerObjectiveBanner: backfill failed for ${channelId}:`, error);
      }
    })();

    return () => {
      cancelled = true;
      stopSubscribe?.();
    };
  }, [transport, channelId]);

  if (!objective) return null;

  const { steps } = objective;
  const { done, total } = cornerObjectiveProgress(steps);
  const collapsible = total > COLLAPSE_THRESHOLD;
  const visibleSteps = collapsible && !expanded ? steps.slice(0, COLLAPSED_VISIBLE_STEPS) : steps;
  const hiddenCount = steps.length - visibleSteps.length;

  return (
    <HullSurface strength="quiet" style={styles.container} testID={testID}>
      <View style={styles.headerRow}>
        <Text style={styles.objectiveText} numberOfLines={3}>
          {objective.objective}
        </Text>
        {total > 0 && (
          <Text style={styles.progressChip} testID={`${testID}-progress`}>
            {done}/{total}
          </Text>
        )}
      </View>
      {visibleSteps.map((step, index) => {
        const { glyph, struckThrough } = cornerObjectiveStepPresentation(step);
        return (
          <View key={`${index}-${step.content}`} style={styles.stepRow}>
            <Text style={[styles.stepGlyph, struckThrough && styles.stepGlyphDone]}>{glyph}</Text>
            <Text
              style={[styles.stepText, struckThrough && styles.stepTextDone]}
              numberOfLines={2}
            >
              {step.content}
            </Text>
          </View>
        );
      })}
      {collapsible && (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((value) => !value)}
          style={styles.toggle}
          testID={`${testID}-toggle`}
        >
          <Text style={styles.toggleText}>
            {expanded ? 'SHOW FEWER' : `+${hiddenCount} MORE`}
          </Text>
        </Pressable>
      )}
    </HullSurface>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  objectiveText: {
    ...Typography.mono('semiBold'),
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: groknight.textPrimary,
  },
  progressChip: {
    ...Typography.mono(),
    fontSize: 11,
    color: groknight.textMuted,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  stepGlyph: {
    ...Typography.mono(),
    fontSize: 11,
    color: groknight.textSecondary,
    width: 14,
  },
  stepGlyphDone: {
    color: groknight.textMuted,
  },
  stepText: {
    ...Typography.mono(),
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    color: groknight.textSecondary,
  },
  stepTextDone: {
    color: groknight.textMuted,
    textDecorationLine: 'line-through',
  },
  toggle: {
    alignSelf: 'flex-start',
    paddingTop: 2,
  },
  toggleText: {
    ...Typography.mono(),
    fontSize: 10,
    letterSpacing: 0.3,
    color: groknight.textMuted,
  },
});
