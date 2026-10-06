import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkspaceListView } from '@beeline/buzz-client';
import { DESKTOP_WORKSPACE_STRIP_WIDTH } from '@/buzz/desktop-workbench-state';
import { WORKSPACE_RAIL_TILE, workspacePictureSeat } from '@/buzz/workspace-tile';
import { IdentityMark } from './IdentityMark';

const tile = WORKSPACE_RAIL_TILE;
const seat = workspacePictureSeat(tile);

export function DesktopWorkspaceStrip({
  workspaces,
  activeWorkspaceId,
  viewerName,
  viewerPubkey,
  viewerFace,
  viewerAvatarUrl,
  onSelect,
  onAdd,
  onAccount,
}: {
  workspaces: WorkspaceListView['workspaces'];
  activeWorkspaceId: string | null;
  viewerName?: string;
  viewerPubkey?: string;
  viewerFace?: string;
  viewerAvatarUrl?: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onAccount: () => void;
}) {
  const [accountLabelVisible, setAccountLabelVisible] = useState(false);
  return (
    <View style={styles.rail} testID="desktop-workspace-strip">
      <ScrollView contentContainerStyle={styles.list}>
        {workspaces.map((workspace) => (
          <Pressable
            key={workspace.id}
            accessibilityLabel={`Switch to ${workspace.name}`}
            accessibilityRole="button"
            accessibilityState={{ selected: workspace.id === activeWorkspaceId }}
            onPress={() => onSelect(workspace.id)}
            style={[styles.workspaceTile, workspace.id === activeWorkspaceId && styles.active]}
            testID={`desktop-strip-workspace-${workspace.id}`}
          >
            <View style={styles.pictureSeat}>
              <IdentityMark
                avatarUrl={workspace.avatar}
                kind="workspace"
                name={workspace.name}
                seed={workspace.id}
                size={seat.pictureSize}
              />
            </View>
          </Pressable>
        ))}
        <Pressable
          accessibilityLabel="Create or join a Workspace"
          accessibilityRole="button"
          onPress={onAdd}
          style={styles.tile}
          testID="desktop-strip-add-workspace"
        >
          <Text style={styles.add}>+</Text>
        </Pressable>
      </ScrollView>
      <Pressable
        accessibilityLabel={viewerName ? `${viewerName} — Settings` : 'Settings'}
        accessibilityRole="button"
        onPress={onAccount}
        onHoverIn={() => setAccountLabelVisible(true)}
        onHoverOut={() => setAccountLabelVisible(false)}
        onFocus={() => setAccountLabelVisible(true)}
        onBlur={() => setAccountLabelVisible(false)}
        style={styles.account}
        testID="desktop-strip-account"
      >
        <IdentityMark
          avatarUrl={viewerAvatarUrl}
          face={viewerFace}
          kind="human"
          name={viewerName}
          seed={viewerPubkey ?? 'viewer'}
          size={32}
        />
        <Text style={styles.caption}>Settings</Text>
        {accountLabelVisible && (
          <View
            pointerEvents="none"
            style={styles.accountLabel}
            testID="desktop-strip-account-label"
          >
            <Text style={styles.labelTitle}>Settings</Text>
            {viewerName ? <Text style={styles.labelName}>{viewerName}</Text> : null}
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: DESKTOP_WORKSPACE_STRIP_WIDTH,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgTerminal,
  },
  account: {
    alignSelf: 'center',
    alignItems: 'center',
    minHeight: 44,
    gap: theme.buzz.space.sm,
    marginBottom: theme.buzz.space.md,
  },
  caption: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  accountLabel: {
    position: 'absolute',
    left: DESKTOP_WORKSPACE_STRIP_WIDTH,
    bottom: 0,
    minWidth: 184,
    maxWidth: 260,
    padding: theme.buzz.space.sm,
    backgroundColor: theme.buzz.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    zIndex: 2,
  },
  labelTitle: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
  labelName: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  list: { alignItems: 'center', paddingTop: 16, gap: theme.buzz.space.sm },
  tile: { width: 56, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  workspaceTile: {
    width: tile.size,
    height: tile.size,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tile.radius,
    borderWidth: tile.borderWidth,
    borderColor: theme.buzz.border,
  },
  pictureSeat: {
    width: seat.pictureSize,
    height: seat.pictureSize,
    borderRadius: seat.pictureRadius,
    overflow: 'hidden',
  },
  active: { borderColor: theme.buzz.accent },
  add: { ...theme.buzz.type.hero, color: theme.buzz.accent },
}));
