import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { groknight } from '@/buzz/groknight';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';

export type WritePermissionStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';

export function writePermissionStatusLabel(
  status: WritePermissionStatus,
  subchannelId?: string,
  awaitingPerson = false,
): string {
  if (awaitingPerson && status === 'pending') return '⊘ A PERSON MUST RESPOND';
  if (status === 'allowed') {
    return subchannelId ? '✓ CORNER OPEN · EDITING IS ISOLATED' : '✓ ALLOWED · OPENING CORNER';
  }
  if (status === 'expired') return '□ REQUEST EXPIRED · STILL READ-ONLY';
  if (status === 'failed') return '□ CORNER COULD NOT OPEN · STILL READ-ONLY';
  if (status === 'denied') return '□ EDITING DENIED · STILL READ-ONLY';
  return '□ WAITING FOR A PERSON';
}

export function WritePermissionOutcome(props: {
  status: WritePermissionStatus;
  subchannelId?: string;
  awaitingPerson?: boolean;
  onOpenCorner: (subchannelId: string) => void;
}) {
  if (props.status === 'allowed' && props.subchannelId) {
    return (
      <TouchableOpacity
        accessibilityLabel={`Open ${CORNER_LABEL}`}
        accessibilityRole="button"
        onPress={() => props.onOpenCorner(props.subchannelId!)}
        style={styles.cornerOpenChip}
        testID="write-permission-open-corner"
      >
        <Text style={styles.cornerOpenState}>✓ {CORNER_LABEL.toUpperCase()} OPEN</Text>
        <Text style={styles.cornerOpenAction}>VIEW ›</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.outcome}>
      <Text style={styles.status}>
        {writePermissionStatusLabel(props.status, props.subchannelId, props.awaitingPerson)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  outcome: { minWidth: 0, gap: 8 },
  status: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 9,
    lineHeight: 14,
    letterSpacing: 0.5,
  },
  cornerOpenChip: {
    minWidth: 0,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 5,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  cornerOpenState: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  cornerOpenAction: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 0.4,
  },
});
