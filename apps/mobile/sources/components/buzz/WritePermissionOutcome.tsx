import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';
import { LEDGER_MARGINALIA_WIDTH } from './Ledger';

export type WritePermissionStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';

/**
 * `◇` is the corner glyph from the lifecycle family (`buzz/corners.ts`), so a
 * faceted diamond means corner work on this surface exactly as it does in the
 * Room list and the corner cards.
 */
export function writePermissionStatusLabel(
  status: WritePermissionStatus,
  subchannelId?: string,
  awaitingPerson = false,
): string {
  if (awaitingPerson && status === 'pending') return '⊘ A PERSON MUST RESPOND';
  if (status === 'allowed') return '◇ ALLOWED · OPENING CORNER';
  if (status === 'expired') return '□ REQUEST EXPIRED · STILL READ-ONLY';
  if (status === 'failed') return '□ CORNER COULD NOT OPEN · STILL READ-ONLY';
  if (status === 'denied') return '□ EDITING DENIED · STILL READ-ONLY';
  return '□ WAITING FOR A PERSON';
}

/**
 * A permission's outcome, inscribed rather than framed.
 *
 * This used to be a bordered, filled chip, and it was the last box left sitting
 * in the transcript flow — it read as a plate laid on the slab and fought
 * everything around it. A status is not something the reader must find and act
 * on, so it earns no box (`DESIGN.md`, "Shape"): it is one dim line at the same
 * left margin as the prose above it, in the ledger's quiet tier.
 *
 * It reports a decision and never navigates. An *open* corner is live state,
 * not a decision, and lives in the pinned `CornerLiveBar` above the composer —
 * a note inscribed at the moment the corner opened scrolls away and then lies,
 * still saying "open" long after the corner merged. Two places claiming to
 * report one fact is how they end up disagreeing, so this reports only the one
 * it can keep true forever: what was decided.
 */
export function WritePermissionOutcome(props: {
  status: WritePermissionStatus;
  subchannelId?: string;
  awaitingPerson?: boolean;
}) {
  return (
    <View style={styles.outcome}>
      <Text style={styles.status}>
        {writePermissionStatusLabel(props.status, props.subchannelId, props.awaitingPerson)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * The prose margin, and the same reserved right gutter every ledger entry
   * keeps — so this line starts exactly where the words above it start and the
   * affordance lands exactly where the timestamps do. No border, no fill, no
   * inset, no minimum height pretending to be a control.
   */
  outcome: {
    width: '100%',
    minWidth: 0,
    marginBottom: 22,
    paddingVertical: 3,
    paddingRight: LEDGER_MARGINALIA_WIDTH,
  },
  status: {
    ...Typography.mono(),
    color: groknight.ledgerQuiet,
    fontSize: 11,
    lineHeight: 18,
    letterSpacing: 0.5,
  },
});
