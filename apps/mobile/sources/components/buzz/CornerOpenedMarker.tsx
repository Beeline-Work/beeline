import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { LEDGER_MARGINALIA_WIDTH } from './Ledger';
import { RepositoryLifecycleRow } from './PrLifecycleCard';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { lifecycleItem } from '@/buzz/pr-lifecycle';

/** The corner's current state, anchored beneath the message that requested it. */
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

/** Each requested corner keeps its own visible line and stable key. */
export function CornerOpenedMarkers({
  message,
  onOpenCorner,
  onOpenUrl,
}: {
  message: ChatDisplayMessage;
  onOpenCorner(id: string): void;
  onOpenUrl(url: string): void;
}) {
  const items = (message.cornerMarkers ?? []).flatMap((marker) => {
    const item = lifecycleItem(marker);
    return item ? [item] : [];
  });
  if (!items.length) return null;
  return (
    <View style={styles.line}>
      {items.map((item) => (
        <RepositoryLifecycleRow
          key={item.id}
          glyph
          item={item}
          testID={`corner-opened-marker-${item.cornerId}`}
          onOpenCorner={onOpenCorner}
          onOpenUrl={onOpenUrl}
        />
      ))}
    </View>
  );
}
