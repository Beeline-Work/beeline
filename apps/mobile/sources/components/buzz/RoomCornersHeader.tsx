import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CHANGES_LABEL, CORNER_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import Svg, { Line } from 'react-native-svg';
import { MineCornersToggle } from '@/components/buzz/MineCornersToggle';

const BACK_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

const SCREEN_TITLE = `${CHANGES_LABEL.charAt(0).toUpperCase()}${CHANGES_LABEL.slice(1)}`;

export function RoomCornersHeader({
  title,
  count,
  mine,
  onMine,
  onBack,
  onAdd,
}: {
  title: string;
  count: number;
  mine: boolean;
  onMine: (mine: boolean) => void;
  onBack: () => void;
  onAdd: () => void;
}) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        accessibilityLabel="Back"
        accessibilityRole="button"
        hitSlop={BACK_HIT_SLOP}
        onPress={onBack}
        style={styles.back}
      >
        <ChevronGlyph color={styles.backText.color} direction="left" size={CHEVRON_BACK_SIZE} />
      </TouchableOpacity>
      <View style={styles.headerCopy}>
        <Text numberOfLines={1} style={styles.eyebrow}>
          {title}
        </Text>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
          {SCREEN_TITLE}
        </Text>
      </View>
      <MineCornersToggle mine={mine} onChange={onMine} testID="room-corners-mine" />
      <Text
        accessibilityLabel={`${count} ${count === 1 ? CORNER_LABEL : CHANGES_LABEL}`}
        style={styles.count}
      >
        {count}
      </Text>
      <TouchableOpacity
        accessibilityLabel="Create a corner"
        accessibilityRole="button"
        hitSlop={BACK_HIT_SLOP}
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
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    header: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: hull.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    backText: { color: hull.textPrimary },
    headerCopy: { flex: 1, minWidth: 0 },
    eyebrow: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    title: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    // F6: reserved so the title column ends at the same x for 9 corners and
    // for 10, the way an index gutter is supposed to read.
    count: {
      ...Typography.default(),
      ...hull.type.meta,
      minWidth: hull.space.lg,
      paddingHorizontal: hull.space.sm,
      color: hull.textMuted,
      textAlign: 'right',
    },
    add: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    addGlyph: { color: hull.accent },
  };
});
