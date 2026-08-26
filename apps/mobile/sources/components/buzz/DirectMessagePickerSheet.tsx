import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkspaceMemberDisplayItem } from '@/buzz/local-cache';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from './IdentityMark';
import { HullActionSheetCancel, HullActionSheetModal } from './HullActionSheet';

type DirectMessagePickerSheetProps = {
  busyPubkey: string | null;
  members: WorkspaceMemberDisplayItem[];
  onClose: () => void;
  onMessage: (member: WorkspaceMemberDisplayItem) => void;
  visible: boolean;
};

/** Restores the existing Workspace-roster DM start flow behind the deck menu. */
export function DirectMessagePickerSheet({
  busyPubkey,
  members,
  onClose,
  onMessage,
  visible,
}: DirectMessagePickerSheetProps) {
  const people = members.filter((member) => member.peerKind === 'person');

  return (
    <HullActionSheetModal
      accessibilityLabel="Close person picker"
      onClose={onClose}
      scrimTestID="direct-message-picker-scrim"
      subtitle="Choose a person in this Workspace."
      testID="direct-message-picker"
      title="Message"
      visible={visible}
    >
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {people.map((member) => {
          const busy = busyPubkey === member.peerPubkey;
          return (
            <TouchableOpacity
              accessibilityLabel={`Message ${member.peerName}`}
              accessibilityRole="button"
              disabled={Boolean(busyPubkey)}
              key={member.peerPubkey}
              onPress={() => onMessage(member)}
              style={styles.row}
              testID={`message-workspace-member-${member.peerPubkey}`}
            >
              <IdentityMark
                kind="human"
                seed={member.peerPubkey}
                avatarUrl={member.avatarUrl}
                name={member.peerName}
                size={36}
              />
              <Text numberOfLines={1} style={styles.name}>
                {member.peerName}
              </Text>
              <Text style={styles.action}>{busy ? 'OPENING…' : 'MESSAGE'}</Text>
            </TouchableOpacity>
          );
        })}
        {people.length === 0 && (
          <Text style={styles.empty}>No other people in this Workspace yet.</Text>
        )}
      </ScrollView>
      <HullActionSheetCancel onPress={onClose} testID="direct-message-picker-close" />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    list: { maxHeight: 440, paddingBottom: 4 },
    row: {
      minHeight: 60,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.border,
    },
    name: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      flex: 1,
      minWidth: 0,
      color: groknight.textSecondary,
      fontSize: 13,
    },
    action: {
      ...Typography.mono('semiBold'),
      color: groknight.chrome,
      fontSize: 9,
      letterSpacing: 0.3,
    },
    empty: {
      ...Typography.default(),
      paddingVertical: 24,
      color: groknight.textMuted,
      textAlign: 'center',
      fontSize: 12,
    },
  };
});
