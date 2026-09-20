/**
 * The Room-open trace, on screen.
 *
 * The timings were only ever written to the device log, which needs a cable and
 * developer tools, so the person who actually feels the app slow could never
 * read them. This paints the same run in the corner of the Room, small enough
 * to ignore and legible enough to screenshot.
 *
 * It renders nothing unless the build opted in with EXPO_PUBLIC_ROOM_OPEN_TRACE,
 * which is off in every build we ship by default.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  observeRoomOpenTrace,
  roomOpenElapsed,
  roomOpenTraceEnabled,
} from '@/buzz/room-open-trace';

export function RoomOpenTraceOverlay({ testID }: { testID?: string }) {
  const enabled = roomOpenTraceEnabled();
  const [rows, setRows] = React.useState<Array<{ phase: string; ms: number }>>([]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    return observeRoomOpenTrace((run) => setRows(roomOpenElapsed(run)));
  }, [enabled]);

  if (!enabled || rows.length === 0) return null;
  const total = rows[rows.length - 1]?.ms ?? 0;

  return (
    <View pointerEvents="none" style={styles.panel} testID={testID ?? 'room-open-trace'}>
      <Text style={styles.total}>open {total}ms</Text>
      {rows.map((row, index) => {
        // The gap from the previous mark is the number that matters: it is the
        // cost of that step, not the running total.
        const previous = index === 0 ? 0 : (rows[index - 1]?.ms ?? 0);
        return (
          <Text key={`${row.phase}-${index}`} style={styles.row}>
            {`${String(row.ms).padStart(5)}  +${String(row.ms - previous).padStart(4)}  ${row.phase}`}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    position: 'absolute',
    top: theme.buzz.space.xs,
    right: theme.buzz.space.xs,
    maxWidth: '86%',
    paddingHorizontal: theme.buzz.space.xs,
    paddingVertical: theme.buzz.space.xs,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgTerminal,
    opacity: 0.94,
  },
  // Tracked type roles, not raw sizes: this panel is diagnostic, and a
  // diagnostic is not a licence to invent a fourteenth text size.
  total: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  row: { ...theme.buzz.type.mono, color: theme.buzz.textMuted },
}));
