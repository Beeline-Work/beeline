import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkspaceListView } from '@beeline/buzz-client';
import { DESKTOP_WORKSPACE_STRIP_WIDTH } from '@/buzz/desktop-workbench-state';
import { IdentityMark } from './IdentityMark';

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
            style={[styles.tile, workspace.id === activeWorkspaceId && styles.active]}
            testID={`desktop-strip-workspace-${workspace.id}`}
          >
            <IdentityMark
              avatarUrl={workspace.avatar}
              kind="workspace"
              name={workspace.name}
              seed={workspace.id}
              size={48}
            />
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
        style={styles.tile}
        testID="desktop-strip-account"
      >
        <IdentityMark
          avatarUrl={viewerAvatarUrl}
          face={viewerFace}
          kind="human"
          name={viewerName}
          seed={viewerPubkey ?? 'viewer'}
          size={48}
        />
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
  list: { alignItems: 'center', paddingTop: 16, gap: 12 },
  tile: { width: 56, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  active: {
    borderLeftWidth: 2,
    borderLeftColor: theme.buzz.accent,
  },
  add: { ...theme.buzz.type.hero, color: theme.buzz.accent },
}));
