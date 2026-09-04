import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

type RoomMemberPickerActionsProps = {
  /** Workspace members and agents not yet in this Room. */
  addableCount: number;
  busy: boolean;
  canManage: boolean;
  /**
   * Whether an empty addable list is worth a line. A Room picker says so (a
   * one-person workspace has nobody to add, captain report C59); the
   * Workspace-level picker has no Room to add to and stays quiet.
   */
  showEmpty?: boolean;
  onAddAgent: () => void;
  onInvitePerson: () => void;
};

/**
 * The bottom of the "Add people or agents" picker: the two Workspace-level
 * ways in. A manager always sees them; everyone else sees who to ask. The
 * agent row connects a NEW agent through the pairing command — an agent
 * already in the Workspace is a checkbox row above this, never this entry
 * (captain report C74).
 */
export function RoomMemberPickerActions({
  addableCount,
  busy,
  canManage,
  showEmpty = true,
  onAddAgent,
  onInvitePerson,
}: RoomMemberPickerActionsProps) {
  return (
    <View testID="room-member-picker-actions">
      {showEmpty && addableCount === 0 && (
        <Text style={styles.quiet} testID="room-member-picker-empty">
          Nobody else in this workspace yet.
        </Text>
      )}
      {canManage ? (
        <>
          <TouchableOpacity
            accessibilityLabel="Invite a person"
            disabled={busy}
            onPress={onInvitePerson}
            style={styles.row}
            testID="room-member-picker-invite-person"
          >
            <Text style={styles.sigil}>+</Text>
            <Text style={styles.label}>Invite a person…</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Connect a new agent"
            disabled={busy}
            onPress={onAddAgent}
            style={styles.row}
            testID="room-member-picker-add-agent"
          >
            <Text style={styles.sigil}>+</Text>
            <Text style={styles.label}>Connect a new agent…</Text>
          </TouchableOpacity>
        </>
      ) : (
        <Text style={styles.quiet} testID="room-member-picker-ask-manager">
          Ask a workspace manager to invite people
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    quiet: {
      ...Typography.default(),
      ...hull.type.meta,
      paddingVertical: hull.space.md,
      paddingHorizontal: hull.space.md,
      color: hull.textMuted,
    },
    row: {
      minHeight: hull.layout.row,
      paddingHorizontal: hull.space.md,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
    },
    sigil: { ...Typography.default(), ...hull.type.body, color: hull.accent },
    label: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
  };
});
