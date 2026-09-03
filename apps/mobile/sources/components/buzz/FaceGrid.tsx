import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { FACE_IDS, type FaceId } from '@/buzz/faces';
import { IdentityMark } from './IdentityMark';

export const FACE_TILE_SIZE = 64;
export const FACE_TILE_BORDER = 2;
const FACE_GRID_COLUMNS = 3;

type FaceGridProps = {
  /** The identity seed the tiles are drawn for. */
  seed: string;
  selected: string | null;
  onSelect: (face: FaceId) => void;
  disabled?: boolean;
  /** `${testIDPrefix}-<face>` names each tile. */
  testIDPrefix: string;
};

/**
 * The face ceremony grid: the twelve animals in a fixed 3×4 grid of 64px
 * tiles. Selection is a border COLOUR flip (faint → brass) on a border whose
 * width never changes, so choosing a tile never shifts its siblings.
 */
export function FaceGrid({ seed, selected, onSelect, disabled, testIDPrefix }: FaceGridProps) {
  const { theme } = useUnistyles();
  const rows: FaceId[][] = [];
  for (let index = 0; index < FACE_IDS.length; index += FACE_GRID_COLUMNS) {
    rows.push(FACE_IDS.slice(index, index + FACE_GRID_COLUMNS));
  }
  return (
    <View style={styles.grid} testID={`${testIDPrefix}-grid`}>
      {rows.map((row) => (
        <View key={row[0]} style={styles.row}>
          {row.map((face) => {
            const isSelected = face === selected;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected, disabled: Boolean(disabled) }}
                accessibilityLabel={face}
                disabled={disabled}
                hitSlop={2}
                key={face}
                onPress={() => onSelect(face)}
                style={[
                  styles.tile,
                  { borderColor: isSelected ? theme.buzz.accent : theme.buzz.faint },
                ]}
                testID={`${testIDPrefix}-${face}`}
              >
                <IdentityMark
                  kind="human"
                  seed={seed}
                  face={face}
                  name={face}
                  size={FACE_TILE_SIZE - FACE_TILE_BORDER * 2 - 8}
                />
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { alignItems: 'center', gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
  tile: {
    width: FACE_TILE_SIZE,
    height: FACE_TILE_SIZE,
    borderWidth: FACE_TILE_BORDER,
    borderRadius: theme.buzz.radius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.bgRaised,
  },
}));
