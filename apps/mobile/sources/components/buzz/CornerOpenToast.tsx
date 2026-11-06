import { IndexRow, InlineRow } from './IndexRow';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  cornerOpensListed,
  listCornerOpens,
  useCornerOpenStatus,
  type CornerOpenStatus,
} from '@/buzz/corner-open-status';
import { CORNER_LABEL } from '@/buzz/vocabulary';

/** Whole seconds a pending create has waited, ticking once a second. */
export function useCornerOpenSeconds(status: CornerOpenStatus): number {
  const startedAt = status.status === 'pending' ? status.startedAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** The pending line under "Opening corner…": the wait, or the second-tap answer. */
export function cornerOpenWaitLine(status: CornerOpenStatus, seconds: number): string {
  if (status.status !== 'pending') return '';
  return status.again ? 'Still opening…' : `Waiting for server · ${seconds}s`;
}

/** Pending corner creation is visible here; request failures use the app banner. */
export function CornerOpenToast() {
  const status = useCornerOpenStatus();
  const seconds = useCornerOpenSeconds(status);
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  if (status.status !== 'pending' || cornerOpensListed(status.roomId)) return null;
  return (
    <View pointerEvents="box-none" style={[styles.dock, { bottom: insets.bottom + theme.buzz.space.md }]}>
      <InlineRow
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={styles.plate}
        testID='corner-open-pending'
      >
        <View style={styles.message}>
          <Text style={styles.title}>
            {`Opening ${CORNER_LABEL}…`}
          </Text>
          <Text style={styles.detail}>
            {cornerOpenWaitLine(status, seconds)}
          </Text>
        </View>
      </InlineRow>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    position: 'absolute',
    left: theme.buzz.space.md,
    right: theme.buzz.space.md,
  },
  plate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.md,
    paddingHorizontal: theme.buzz.space.md,
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgTerminal,
  },
  message: { flex: 1 },
  title: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  detail: { ...theme.buzz.type.meta, color: theme.buzz.textMuted },

}));

/** The Corners page shows only its pending create, without a second failure row. */
export function CornerOpenRow({ roomId }: { roomId: string }) {
  const status = useCornerOpenStatus();
  const seconds = useCornerOpenSeconds(status);
  useEffect(() => listCornerOpens(roomId), [roomId]);
  if (status.status !== 'pending' || status.roomId !== roomId) return null;
  return <IndexRow title={`Opening ${CORNER_LABEL}…`} description={cornerOpenWaitLine(status, seconds)} testID="corner-open-row-pending" />;
}
