import React from 'react';
import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { splitChannelHeaderTitle, type ChannelHeaderKind } from '@/buzz/channel-header-title';

/**
 * The ONE header title for a Room, a DM and a corner (C72). It speaks the
 * Room list's language: the kind sigil (`#` / `@`) in brass, the name in the
 * primary tone, set in the calm type roles — `hero` for a Room or DM, `body`
 * strength for a corner's objective (which may wrap once). Never mono, never
 * an ad-hoc size: the screen only chooses the kind and how many lines.
 */
export function ChannelHeaderTitle({
  title,
  kind,
  numberOfLines = 1,
  testID = 'chat-title',
}: {
  title: string;
  kind: ChannelHeaderKind;
  numberOfLines?: number;
  testID?: string;
}) {
  const mark = splitChannelHeaderTitle(title, kind);
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[styles.name, kind === 'corner' && styles.cornerName]}
      testID={testID}
    >
      {mark.sigil && (
        <Text style={styles.sigil} testID={`${testID}-sigil`}>
          {mark.sigil}
        </Text>
      )}
      {mark.name}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  name: { ...theme.buzz.type.hero, color: theme.buzz.textPrimary },
  cornerName: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  // The sigil inherits the name's face and size; only its tone differs.
  sigil: { color: theme.buzz.accent },
}));
