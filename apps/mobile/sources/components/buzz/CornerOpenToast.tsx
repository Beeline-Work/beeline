import Svg, { Path } from 'react-native-svg';
import { InlineRow } from './IndexRow';
import { ErrorBanner } from './ErrorBanner';
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CORNER_OPEN_DEADLINE_SECONDS,
  cornerOpenEnded,
  cornerOpensListed,
  listCornerOpens,
  useCornerOpenStatus,
  type CornerOpenStatus,
} from '@/buzz/corner-open-status';
import { CORNER_LABEL } from '@/buzz/vocabulary';

const CORNER_HEADING = `${CORNER_LABEL.charAt(0).toUpperCase()}${CORNER_LABEL.slice(1)}`;

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

/**
 * The corner-open notice (corner-open network-failure mock): a plate at the
 * foot of the screen. While a create is in flight from a screen with no
 * corner list it says so; when the server never answered it names the cause
 * and offers Retry, which repeats the same attempt. Tapping the message
 * dismisses a failure. Mounted once, over every screen.
 */
export function CornerOpenToast() {
  const status = useCornerOpenStatus();
  const seconds = useCornerOpenSeconds(status);
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  if (status.status === 'idle') return null;
  if (status.status === 'pending' && cornerOpensListed(status.roomId)) return null;
  if (status.status === 'failed')
    return (
      <View pointerEvents="box-none" style={[styles.dock, { bottom: insets.bottom + theme.buzz.space.md }]}>
        <InlineRow style={styles.plate}><ErrorBanner inline
          title="Couldn't reach Beeline"
          retryLabel="Retry"
          onRetry={status.retry}
          retryTestID="corner-open-retry"
          secondaryAction={{ label: '', accessibilityLabel: 'Dismiss', iconOnly: true, onPress: cornerOpenEnded,
            icon: <Svg width={18} height={18} viewBox="0 0 18 18"><Path d="M4 4L14 14M14 4L4 14" stroke={theme.buzz.textPrimary} strokeWidth={1.5} /></Svg> }}
          testID="corner-open-failed"
        /></InlineRow>
      </View>
    );
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
  row: {
    flexDirection: 'row',
    gap: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.md,
    paddingHorizontal: theme.buzz.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  rowPending: { backgroundColor: theme.buzz.bgHighlight },
  rowTitle: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  glyph: { width: 7, height: 7, marginTop: theme.buzz.space.sm },
  glyphPending: { backgroundColor: theme.buzz.accent },
  glyphFailed: { backgroundColor: theme.buzz.brandMark },
}));

/**
 * The Corners page's own view of a create for its Room (mock frames 1–2): a
 * brass placeholder row while it waits, a failure row once the server never
 * answered. The toast carries Retry; this row only says what happened.
 */
export function CornerOpenRow({ roomId }: { roomId: string }) {
  const status = useCornerOpenStatus();
  const seconds = useCornerOpenSeconds(status);
  useEffect(() => listCornerOpens(roomId), [roomId]);
  if (status.status === 'idle' || status.roomId !== roomId) return null;
  const failed = status.status === 'failed';
  return (
    <View
      style={[styles.row, !failed && styles.rowPending]}
      testID={failed ? 'corner-open-row-failed' : 'corner-open-row-pending'}
    >
      <View style={[styles.glyph, failed ? styles.glyphFailed : styles.glyphPending]} />
      <View style={styles.message}>
        <Text style={styles.rowTitle}>
          {failed ? `${CORNER_HEADING} not opened` : `Opening ${CORNER_LABEL}…`}
        </Text>
        <Text style={styles.detail}>
          {failed
            ? status.timedOut
              ? `No response from server after ${CORNER_OPEN_DEADLINE_SECONDS}s`
              : 'No connection to the server'
            : cornerOpenWaitLine(status, seconds)}
        </Text>
      </View>
    </View>
  );
}
