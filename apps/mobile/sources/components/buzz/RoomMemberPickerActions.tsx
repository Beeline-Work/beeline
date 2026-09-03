import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

type RoomMemberPickerActionsProps = {
  /** Workspace members and agents not yet in this Room. */
  addableCount: number;
  busy: boolean;
  canManage: boolean;
  onAddAgent: () => void;
  onInvitePerson: () => void;
};

/**
 * The bottom of the "Add people or Agents" picker: a one-person workspace
 * (captain report C59) used to show only "@You" and no way out. A manager
 * always sees the two workspace-level invite rows here; everyone else sees
 * who to ask.
 */
export function RoomMemberPickerActions({
  addableCount,
  busy,
  canManage,
  onAddAgent,
  onInvitePerson,
}: RoomMemberPickerActionsProps) {
  return (
    <View testID="room-member-picker-actions">
      {addableCount === 0 && (
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
            <Text style={styles.label}>+ Invite a person…</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Add an agent"
            disabled={busy}
            onPress={onAddAgent}
            style={styles.row}
            testID="room-member-picker-add-agent"
          >
            <Text style={styles.label}>+ Add an agent…</Text>
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
  const groknight = theme.buzz;
  return {
    quiet: {
      ...Typography.default(),
      paddingVertical: 14,
      paddingHorizontal: 10,
      color: groknight.textMuted,
      fontSize: 12,
    },
    row: {
      minHeight: 44,
      paddingHorizontal: 10,
      justifyContent: 'center',
      borderTopWidth: 1,
      borderColor: groknight.border,
    },
    label: {
      ...Typography.mono('semiBold'),
      color: groknight.chrome,
      fontSize: 11,
      letterSpacing: 0.3,
    },
  };
});
