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
    top: 4,
    right: 4,
    maxWidth: '86%',
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.78)',
  },
  total: { color: theme.buzz.accent, fontSize: 10, lineHeight: 13, fontVariant: ['tabular-nums'] },
  row: { color: '#d8d8de', fontSize: 9, lineHeight: 12, fontVariant: ['tabular-nums'] },
}));
