import React from 'react';
import { TouchableOpacity } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CHANGES_LABEL } from '@/buzz/vocabulary';
import { PageHeader } from '@/components/buzz/PageHeader';
import Svg, { Line } from 'react-native-svg';

const ADD_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

const SCREEN_TITLE = `${CHANGES_LABEL.charAt(0).toUpperCase()}${CHANGES_LABEL.slice(1)}`;

/**
 * The Corners page header: the shared `PageHeader` (Room name over Corners,
 * the same inset, type and divider as Tray and Workbench) with the
 * create-a-corner button at its trailing edge.
 */
export function RoomCornersHeader({
  title,
  onBack,
  onAdd,
}: {
  title: string;
  onBack: () => void;
  onAdd: () => void;
}) {
  return (
    <PageHeader
      action={
        <TouchableOpacity
          accessibilityLabel="Create a corner"
          accessibilityRole="button"
          hitSlop={ADD_HIT_SLOP}
          onPress={onAdd}
          style={styles.add}
          testID="room-corners-add"
        >
          <Svg height={20} viewBox="0 0 24 24" width={20}>
            <Line
              stroke={styles.addGlyph.color}
              strokeLinecap="round"
              strokeWidth={2}
              x1="12"
              x2="12"
              y1="4"
              y2="20"
            />
            <Line
              stroke={styles.addGlyph.color}
              strokeLinecap="round"
              strokeWidth={2}
              x1="4"
              x2="20"
              y1="12"
              y2="12"
            />
          </Svg>
        </TouchableOpacity>
      }
      eyebrow={title}
      onBack={onBack}
      prominent
      title={SCREEN_TITLE}
    />
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    add: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    addGlyph: { color: hull.accent },
  };
});
