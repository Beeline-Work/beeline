import React from 'react';
import { Pressable, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { cornerStatusLine } from '@/buzz/corner-status-line';
import { Typography } from '@/constants/Typography';

/**
 * A corner's PR state, inscribed above the transcript, never framed: one dim
 * mono line at the prose margin (`PR #840 · 6/15 tests passed · running`) with
 * `↗` hung in the right gutter where the timestamps live. The whole line is
 * one link into GitHub — the user reviews and merges there, or tells the agent
 * to merge in the corner. Nothing renders until a pull request exists.
 */
export const CornerStatusLine = React.memo(function CornerStatusLine({
  lifecycle,
  archived,
  onOpenPullRequest,
}: {
  lifecycle?: CornerLifecycleView;
  archived: boolean;
  onOpenPullRequest(url: string): void;
}) {
  const line = cornerStatusLine(lifecycle, archived);
  const url = lifecycle?.pr?.url;
  if (!line || !url) return null;
  return (
    <Pressable
      accessibilityLabel={`${line}. Opens the pull request on GitHub`}
      accessibilityRole="link"
      onPress={() => onOpenPullRequest(url)}
      style={({ pressed }) => [styles.line, pressed && styles.linePressed]}
      testID="corner-status-line"
    >
      <Text numberOfLines={1} style={styles.copy} testID="corner-status-copy">
        {line}
      </Text>
      <Text style={styles.affordance} testID="corner-status-affordance">
        ↗
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    line: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 0,
      // The transcript's content inset, so the line sits on the prose margin.
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    linePressed: { opacity: 0.6 },
    copy: {
      ...Typography.mono(),
      flexShrink: 1,
      minWidth: 0,
      color: hull.ledgerQuiet,
      fontSize: 12,
      lineHeight: 18,
      letterSpacing: 0.4,
    },
    // The ledger's marginalia gutter (`LEDGER_MARGINALIA_WIDTH`), right-aligned.
    affordance: {
      ...Typography.mono(),
      flexShrink: 0,
      width: 36,
      textAlign: 'right',
      color: hull.accent,
      fontSize: 12,
      lineHeight: 18,
    },
  };
});
