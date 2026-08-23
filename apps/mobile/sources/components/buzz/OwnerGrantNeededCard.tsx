import React, { memo, useCallback } from 'react';
import { Share, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type OwnerGrantNeeded = {
  /** The repository waiting for its owner's grant (`owner/repo`). */
  repository: string;
  /** The App's state-less public install URL, shareable with anyone. */
  installUrl: string;
};

export const OWNER_GRANT_TITLE = 'OWNER GRANT NEEDED';
export const OWNER_GRANT_COPY = 'Ask the repo owner to grant Beeline access — share this link:';
export const OWNER_GRANT_SHARE_LABEL = 'SHARE INSTALL LINK';

/** The message Share receives; pure so tests pin it without a renderer. */
export function ownerGrantShareMessage(
  grant: Pick<OwnerGrantNeeded, 'repository' | 'installUrl'>,
): string {
  return `${OWNER_GRANT_COPY}\n${grant.installUrl}\n(${grant.repository})`;
}

/**
 * The typed "the App does not cover this repository yet" state.
 *
 * Only a repository's OWNER can install a GitHub App on their personal
 * account — an admin who is not the owner can never self-serve the grant, so
 * this state hands the linking user a shareable one-tap install link instead
 * of an error wall. The Room's binding stays pending server-side and completes
 * automatically once the owner installs (webhook or reconcile), which the Room
 * announces through its normal repository feed. This card is deliberately one
 * of DESIGN.md's sanctioned boxed regions: it is a single, non-repeating state
 * the reader must find and act on.
 */
export const OwnerGrantNeededCard = memo(function OwnerGrantNeededCard({
  repository,
  installUrl,
  testIDPrefix = 'owner-grant',
}: OwnerGrantNeeded & { testIDPrefix?: string }) {
  const { theme } = useUnistyles();
  const groknight = theme.buzz;
  const share = useCallback(() => {
    void Share.share({ message: ownerGrantShareMessage({ repository, installUrl }) });
  }, [repository, installUrl]);
  return (
    <View style={styles.card} testID={`${testIDPrefix}-card`}>
      <Text style={styles.title}>{OWNER_GRANT_TITLE}</Text>
      <Text style={styles.body}>
        {OWNER_GRANT_COPY} {repository}
      </Text>
      <Text selectable style={styles.link} testID={`${testIDPrefix}-url`}>
        {installUrl}
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={share}
        style={styles.shareButton}
        testID={`${testIDPrefix}-share`}
      >
        <Text style={styles.shareLabel}>{OWNER_GRANT_SHARE_LABEL}</Text>
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
    card: {
      borderWidth: 1,
      borderColor: groknight.accent,
      padding: 12,
      gap: 7,
      marginVertical: 8,
    },
    title: { ...Typography.mono(), color: groknight.accent, fontSize: 9 },
    body: { ...Typography.default(), color: groknight.textPrimary, fontSize: 12 },
    link: { ...Typography.mono(), color: groknight.textSecondary, fontSize: 11 },
    shareButton: { minHeight: 36, justifyContent: 'center', alignItems: 'flex-start' },
    shareLabel: { ...Typography.mono(), color: groknight.accent, fontSize: 10 },
  });
});
