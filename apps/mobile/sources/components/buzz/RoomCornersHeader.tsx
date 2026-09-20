import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CHANGES_LABEL, CORNER_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';

const BACK_HIT_SLOP = { top: 4, bottom: 4, left: 4, right: 4 } as const;

const SCREEN_TITLE = `${CHANGES_LABEL.charAt(0).toUpperCase()}${CHANGES_LABEL.slice(1)}`;

export function RoomCornersHeader({
  title,
  count,
  onBack,
}: {
  title: string;
  count: number;
  onBack: () => void;
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
        <Text style={styles.backText}>‹</Text>
      </TouchableOpacity>
      <View style={styles.headerCopy}>
        <Text numberOfLines={1} style={styles.eyebrow}>
          {title}
        </Text>
        <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>
          {SCREEN_TITLE}
        </Text>
      </View>
      <Text
        accessibilityLabel={`${count} ${count === 1 ? CORNER_LABEL : CHANGES_LABEL}`}
        style={styles.count}
      >
        {count}
      </Text>
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
    backText: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
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
  };
});
