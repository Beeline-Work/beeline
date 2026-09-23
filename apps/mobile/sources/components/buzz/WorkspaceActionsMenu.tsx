import React, { useState } from 'react';
import { TouchableOpacity } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from './HullActionSheet';
import { MEMBERS_LABEL } from '@/buzz/vocabulary';

export function WorkspaceActionsMenu({
  onMembers,
  onSettings,
}: {
  onMembers: () => void;
  onSettings?: () => void;
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
