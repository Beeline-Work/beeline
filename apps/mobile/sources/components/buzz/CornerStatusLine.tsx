import { TranscriptNavigationRow } from './IndexRow';
import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { cornerStatusLine } from '@/buzz/corner-status-line';

/** A 44px transcript link to the corner's pull request. */
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
    <View style={styles.line}>
      <TranscriptNavigationRow testID="corner-status-line" singleDestination divider={false}
        trailing={{ accessibilityLabel: `${line}. Opens the pull request on GitHub`,
          onPress: () => onOpenPullRequest(url), testID: 'corner-status-affordance' }}>
        <Text numberOfLines={1} style={styles.copy} testID="corner-status-copy">{line}</Text>
      </TranscriptNavigationRow>
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    line: {
      width: '100%',
      minWidth: 0,
      minHeight: 44,
    },
    copy: {
      ...hull.type.meta,
      flexShrink: 1,
      minWidth: 0,
      color: hull.ledgerQuiet,
    },
  };
});
