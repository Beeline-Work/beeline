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
  return (
    <View style={styles.outcome}>
      <Text style={styles.status}>
        {writePermissionStatusLabel(props.status, props.subchannelId, props.awaitingPerson)}
      </Text>
      {props.status === 'allowed' && props.subchannelId && (
        <TouchableOpacity
          accessibilityLabel={`Open ${CORNER_LABEL}`}
          accessibilityRole="button"
          onPress={() => props.onOpenCorner(props.subchannelId!)}
          style={styles.openCornerAction}
          testID="write-permission-open-corner"
        >
          <Text style={styles.openCornerText}>OPEN {CORNER_LABEL.toUpperCase()}</Text>
          <Text style={styles.openCornerGlyph}>›</Text>
        </TouchableOpacity>
      )}
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
  openCornerAction: {
    minHeight: 38,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 5,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  openCornerText: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  openCornerGlyph: { ...Typography.default(), color: groknight.textPrimary, fontSize: 18 },
});
