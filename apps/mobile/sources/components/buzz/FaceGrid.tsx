import { Button } from './Button';
import { InlineRow } from './IndexRow';
import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { space } from '@/buzz/groknight';
import { FACE_IDS, type FaceId } from '@/buzz/faces';
import { IdentityMark } from './IdentityMark';

export const FACE_TILE_SIZE = 64;

type FaceGridProps = {
  /** The identity seed the tiles are drawn for. */
  seed: string;
  selected: string | null;
  onSelect: (face: FaceId) => void;
  disabled?: boolean;
  /** `${testIDPrefix}-<face>` names each tile. */
  testIDPrefix: string;
  columns?: 3 | 4;
  tileSize?: number;
};

/** The face picker uses shared buttons; selection changes only their variant. */
export function FaceGrid({
  seed,
  selected,
  onSelect,
  disabled,
  testIDPrefix,
  columns = 3,
  tileSize = FACE_TILE_SIZE,
}: FaceGridProps) {
  const rows: FaceId[][] = [];
  for (let index = 0; index < FACE_IDS.length; index += columns) {
    rows.push(FACE_IDS.slice(index, index + columns));
  }
  return (
    <View style={styles.grid} testID={`${testIDPrefix}-grid`}>
      {rows.map((row) => (
        <InlineRow key={row[0]} style={styles.row}>
          {row.map((face) => {
            const isSelected = face === selected;
            return (
              <Button label="" variant={isSelected ? 'brass' : 'secondary'}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected, disabled: Boolean(disabled) }}
                accessibilityLabel={face}
                disabled={disabled}
                hitSlop={2}
                key={face}
                onPress={() => onSelect(face)}
                style={{ width: tileSize, height: tileSize }}
                testID={`${testIDPrefix}-${face}`}
                icon={<IdentityMark
                  kind="human"
                  seed={seed}
                  face={face}
                  name={face}
                  size={tileSize - space.md * 2 - 2}
                />}
              />
            );
          })}
        </InlineRow>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { alignItems: 'center', gap: theme.buzz.space.sm },
  row: { flexDirection: 'row', gap: theme.buzz.space.sm },
}));
