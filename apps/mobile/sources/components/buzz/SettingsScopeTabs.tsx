import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { WORKSPACE_SETTINGS_TILE, workspacePictureSeat } from '@/buzz/workspace-tile';

export type SettingsScope = 'you' | 'workspace';

// One tile for both sides: the person and Workspace settings tiles share this geometry.
const tile = WORKSPACE_SETTINGS_TILE;
const seat = workspacePictureSeat(tile);
export const SETTINGS_SCOPE_PICTURE_SIZE = seat.pictureSize;

type ScopeTab = {
  /** The picture, drawn at `SETTINGS_SCOPE_PICTURE_SIZE`. */
  picture: React.ReactNode;
  label: string;
  accessibilityLabel: string;
  /** What a press on the already selected tab does, when it does anything. */
  selectedAction?: { accessibilityHint: string; onPress: () => void };
  testID: string;
  /** The bezelled picture tile inside the tab. */
  tileTestID?: string;
};

/**
 * The Settings header: one segmented control that chooses between your own
 * settings and the workspace's. Both sides sit on one pale track; the selected
 * side rises onto a tile and its picture takes the brass ring. The caption
 * under the control says who you are on the selected side.
 */
export function SettingsScopeTabs({
  scope,
  onScopeChange,
  you,
  workspace,
  caption,
}: {
  scope: SettingsScope;
  onScopeChange: (scope: SettingsScope) => void;
  you: ScopeTab;
  workspace: ScopeTab | null;
  caption?: React.ReactNode;
}) {
  const tabs: [SettingsScope, ScopeTab | null][] = [['you', you], ['workspace', workspace]];
  return (
    <View style={styles.header}>
      <View accessibilityRole="tablist" style={styles.track}>
        {tabs.map(([key, tab]) => {
          if (!tab) return null;
          const selected = scope === key;
          const action = selected ? tab.selectedAction : undefined;
          return (
            <TouchableOpacity
              key={key}
              accessibilityHint={action?.accessibilityHint}
              accessibilityLabel={tab.accessibilityLabel}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              activeOpacity={selected && !action ? 1 : 0.7}
              onPress={() => (selected ? action?.onPress() : onScopeChange(key))}
              style={[styles.tab, selected && styles.tabSelected]}
              testID={tab.testID}
            >
              <View style={[styles.tile, selected && styles.tileSelected, !selected && styles.dimmed]}
                testID={tab.tileTestID}>
                <View style={styles.seat}>{tab.picture}</View>
              </View>
              <Text numberOfLines={1} style={[styles.label, selected && styles.labelSelected]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {caption ? <Text numberOfLines={2} style={styles.caption} testID="settings-scope-caption">{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    header: { alignItems: 'stretch', gap: hull.space.sm, paddingTop: hull.space.lg, paddingBottom: hull.space.sm },
    track: {
      flexDirection: 'row',
      gap: hull.space.xs,
      padding: hull.space.xs,
      borderRadius: 14,
      backgroundColor: hull.bgRaised,
    },
    tab: {
      flex: 1,
      minWidth: 0,
      alignItems: 'center',
      gap: hull.space.xs,
      paddingVertical: hull.space.sm,
      paddingHorizontal: hull.space.sm,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    // Tonal elevation, not a shadow (DESIGN.md → Flat by default): the tile is
    // one step lighter than the track on Bone and one step brighter on Obsidian.
    tabSelected: {
      backgroundColor: theme.buzz.dark ? hull.bgHover : hull.appTile,
      borderColor: hull.borderStrong,
    },
    tile: {
      width: tile.size,
      height: tile.size,
      borderRadius: tile.radius,
      borderWidth: tile.borderWidth,
      borderColor: hull.border,
      backgroundColor: hull.avatarGround,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileSelected: { borderColor: hull.accent },
    dimmed: { opacity: 0.5 },
    seat: {
      width: seat.pictureSize,
      height: seat.pictureSize,
      borderRadius: seat.pictureRadius,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, maxWidth: '100%' },
    labelSelected: { ...Typography.default('semiBold'), color: hull.textPrimary },
    caption: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      textAlign: 'center',
    },
  };
});
