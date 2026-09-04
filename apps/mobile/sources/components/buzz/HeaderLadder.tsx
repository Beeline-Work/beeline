import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * One header language for both chat surfaces — the Room and its Corners share
 * this screen's top bar, and both must speak the same ladder: an identity mark
 * leading, the name at its own tier, and every piece of metadata (repo
 * binding, participant count, corner status) in one quiet meta voice on
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

/** The one metadata voice: the `meta` type role, muted, single-line. Repo
 *  bindings, participant counts, and corner status all read through this
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
    // the trailing control all part from what follows them by 12.
    identitySlot: {
      marginRight: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 2,
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
