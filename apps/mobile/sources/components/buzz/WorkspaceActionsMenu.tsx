import React, { useState } from 'react';
import { TouchableOpacity } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from './HullActionSheet';
import { MEMBERS_LABEL } from '@/buzz/vocabulary';
import type { RoomDeckComposeAction } from './RoomDeckComposeMenu';

export function WorkspaceActionsMenu({
  onMembers,
  onSettings,
  onBookmarks,
  bookmarksSelected = false,
  onCompose,
  canManageWorkspace = false,
}: {
  onMembers: () => void;
  onSettings?: () => void;
  onBookmarks?: () => void;
  bookmarksSelected?: boolean;
  onCompose?: (action: RoomDeckComposeAction) => void;
  canManageWorkspace?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Workspace menu"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={styles.trigger}
        testID="workspace-menu"
      >
        <Ionicons name="ellipsis-horizontal" size={22} color={styles.glyph.color} />
      </TouchableOpacity>
      <HullActionSheetModal
        visible={open}
        title="Workspace"
        onClose={() => setOpen(false)}
        testID="workspace-menu-sheet"
      >
        <HullActionSheetRow
          label={MEMBERS_LABEL}
          onPress={() => choose(onMembers)}
          testID="workspace-menu-members"
        />
        {onBookmarks && (
          <HullActionSheetRow
            label="Bookmarks"
            selected={bookmarksSelected}
            onPress={() => choose(onBookmarks)}
            testID="workspace-menu-bookmarks"
          />
        )}
        {onCompose && (
          <>
            <HullActionSheetRow
              label="New direct message"
              onPress={() => choose(() => onCompose('message'))}
              testID="workspace-menu-message"
            />
            {canManageWorkspace && (
              <HullActionSheetRow
                label="New Room"
                onPress={() => choose(() => onCompose('room'))}
                testID="workspace-menu-room"
              />
            )}
            {canManageWorkspace && (
              <HullActionSheetRow
                label="Invite person"
                onPress={() => choose(() => onCompose('invite'))}
                testID="workspace-menu-invite"
              />
            )}
            <HullActionSheetRow
              label="Connect agent"
              onPress={() => choose(() => onCompose('agent'))}
              testID="workspace-menu-agent"
            />
            <HullActionSheetRow
              label="Join Workspace"
              onPress={() => choose(() => onCompose('join'))}
              testID="workspace-menu-join"
            />
          </>
        )}
        {onSettings && (
          <HullActionSheetRow
            label="Workspace settings"
            onPress={() => choose(onSettings)}
            testID="workspace-menu-settings"
          />
        )}
        <HullActionSheetCancel onPress={() => setOpen(false)} />
      </HullActionSheetModal>
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  trigger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  glyph: { color: theme.buzz.ledgerQuiet },
}));
