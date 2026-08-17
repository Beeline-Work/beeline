import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { groknight } from '@/buzz/groknight';
import { CORNER_LABEL } from '@/buzz/vocabulary';
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
  if (status === 'allowed') {
    return subchannelId ? '◇ CORNER OPEN · EDITING IS ISOLATED' : '◇ ALLOWED · OPENING CORNER';
  }
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
 * Only the affordance lifts. When the corner is open the line is tappable, and
 * `view →` hangs in the same right gutter the timestamps do — a half-step
 * brighter than the label, with a faint tonal flash on press and no border at
 * any point. The arrow says enterable; the diamond says corner.
 */
export function WritePermissionOutcome(props: {
  status: WritePermissionStatus;
  subchannelId?: string;
  awaitingPerson?: boolean;
  onOpenCorner: (subchannelId: string) => void;
}) {
  const label = writePermissionStatusLabel(props.status, props.subchannelId, props.awaitingPerson);

  if (props.status === 'allowed' && props.subchannelId) {
    return (
      <Pressable
        accessibilityLabel={`Open ${CORNER_LABEL}`}
        accessibilityRole="button"
        onPress={() => props.onOpenCorner(props.subchannelId!)}
        style={styles.outcome}
        testID="write-permission-open-corner"
      >
        {({ pressed }) => (
          <>
            <Text numberOfLines={1} style={[styles.status, pressed && styles.statusPressed]}>
              {label}
            </Text>
            <Text style={[styles.enter, pressed && styles.enterPressed]}>view →</Text>
          </>
        )}
      </Pressable>
    );
  }

  return (
    <View style={styles.outcome}>
      <Text style={styles.status}>{label}</Text>
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
  /** A tonal flash, not a highlight: the whole line acknowledges the touch. */
  statusPressed: { color: groknight.ledgerBody },
  enter: {
    ...Typography.mono(),
    position: 'absolute',
    right: 0,
    top: 3,
    width: LEDGER_MARGINALIA_WIDTH,
    textAlign: 'right',
    color: groknight.ledgerBody,
    fontSize: 9,
    lineHeight: 18,
  },
  enterPressed: { color: groknight.ledgerBright },
});
