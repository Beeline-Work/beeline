import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { LEDGER_MARGINALIA_WIDTH } from './Ledger';
import { RepositoryLifecycleRow } from './PrLifecycleCard';

/**
 * The line a message carries once a corner was opened from it. It is the
 * Room's `Opened corner #name` row with the branch mark in front, so the
 * same fact reads the same wherever it shows. The whole line opens the corner.
 */
export function CornerOpenedMarker({
  title,
  closed = false,
  onOpen,
  testID,
}: {
  title: string;
  /** The corner has since closed; the line still opens it, read-only. */
  closed?: boolean;
  onOpen: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.line}>
      <RepositoryLifecycleRow
        glyph
        testID={testID}
        item={{
          id: testID ?? title,
          title,
          state: closed ? 'Closed' : 'Opened',
          kind: 'corner',
          kindLine: 'corner',
          cornerId: title,
          actor: '',
          updatedBy: '',
        }}
        onOpenCorner={onOpen}
        onOpenUrl={() => undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  // Clear of the Ledger's timestamp column, like the message it hangs off.
  line: { paddingRight: LEDGER_MARGINALIA_WIDTH },
}));
