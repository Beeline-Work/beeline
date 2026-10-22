import React from 'react';
import type { CornerState } from '@beeline/api-contract/phone';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * One header language for both chat surfaces — the Room and its Corners share
 * this screen's top bar, and both must speak the same ladder: an identity mark
 * leading, the name at its own tier, and every piece of header metadata (repo
 * binding and corner status) in one quiet meta voice on
 * the obsidian canvas.
 *
 * These are the shared primitives; neither branch of `[channelId].tsx`'s
 * header may hand-roll its own meta text or mark slot again. `DESIGN.md`
 * (repo root) is the design authority.
 */

/** The leading identity slot: the mark that states who owns the space —
 *  a Workspace for a Room, the one administering agent for a Corner. */
export function HeaderIdentitySlot({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.identitySlot} testID={testID}>
      {children}
    </View>
  );
}

/** A composed metadata row under the title: small, mono, hairline-quiet. */
export function HeaderMetaRow({
  children,
  testID,
}: {
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.metaRow} testID={testID}>
      {children}
    </View>
  );
}

export function CornerHeaderAgentText({
  name,
  stateWord,
  state,
  headerSuffix,
  waitingReason,
  blocker,
  viewerId,
  onReasonPress,
  style,
}: {
  name: string;
  stateWord?: string;
  state?: CornerState;
  headerSuffix?: string;
  waitingReason?: 'approve' | 'connect' | 'question';
  blocker?: import('@beeline/api-contract/phone').CornerBlocker;
  viewerId?: string;
  onReasonPress?: () => void;
  style?: StyleProp<TextStyle>;
}) {
  const waiting = (state ?? stateWord) === 'waiting';
  const label = waiting ? 'waiting' : stateWord;
  return (
    <Text numberOfLines={1} style={[styles.metaCaps, style]}>
      {label ? `${name.toUpperCase()} · ${label}` : name.toUpperCase()}
      {waiting && blocker?.kind === 'merge-hold' ? ` on ${blocker.personId === viewerId ? 'your' : `${blocker.personName ?? 'someone'}'s`} merge hold`
        : waiting && blocker?.kind === 'report' ? ' on a report'
        : waiting && waitingReason ? (
        <>
          {waitingReason === 'question' ? ' on a ' : ' to '}
          <Text accessibilityRole={onReasonPress ? "link" : undefined} onPress={onReasonPress}>{waitingReason}</Text>
        </>
      ) : null}
      {waiting && headerSuffix ? ` · ${headerSuffix}` : null}
    </Text>
  );
}

/** The one metadata voice: the `meta` type role, muted, single-line. Repo
 *  bindings and corner status both read through this
 *  token so the two headers can never drift apart again. */
export function HeaderMetaCaps({
  children,
  numberOfLines = 1,
  testID,
}: {
  children: React.ReactNode;
  numberOfLines?: number;
  testID?: string;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={styles.metaCaps} testID={testID}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    // One gutter value across the whole bar: the back chevron, the mark, and
    // the trailing control all part from what follows them by one step (sm).
    identitySlot: {
      marginRight: groknight.space.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: groknight.space.sm,
      marginTop: groknight.space.xs,
      minWidth: 0,
    },
    // The one subtitle voice is the calm `meta` role (DESIGN.md → Type):
    // sans, never mono, muted. Callers still pass caps copy.
    metaCaps: {
      ...theme.buzz.type.meta,
      flexShrink: 1,
      minWidth: 0,
      color: groknight.textMuted,
    },
  };
});
