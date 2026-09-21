import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { serviceMonogram } from '@/buzz/workbench';

/** The leading plate's side, and the width of the column it sits in. */
const SERVICE_MARK_SIZE = 28;

/**
 * ServiceMark — the leading mark on a key row: the company that key is for.
 *
 * A key belongs to whatever service the vault signed up for, so there is no
 * fixed catalog of art to draw from the way the tool connectors have one, and
 * a phone must not fetch a third party's favicon just to decorate a row —
 * that would tell that company which of its customers opened this screen.
 * What the plate CAN carry is the company's own letter, in the house face on
 * the house plate: one square at the shared radius, one hairline, the quiet
 * tone, sized to the row's leading column.
 */
export function ServiceMark({ company, testID }: { company: string; testID?: string }) {
  return (
    <View style={styles.plate} testID={testID}>
      <Text style={styles.monogram}>{serviceMonogram(company)}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    plate: {
      width: SERVICE_MARK_SIZE,
      height: SERVICE_MARK_SIZE,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      backgroundColor: hull.bgRaised,
    },
    monogram: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
  };
});
