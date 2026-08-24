import React from 'react';
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { WorkspaceMemberDisplayItem } from '@/buzz/local-cache';
import { Typography } from '@/constants/Typography';
import { IdentityMark } from './IdentityMark';
import { HullSurface } from './MonoHull';

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
  const insets = useSafeAreaInsets();
  const people = members.filter((member) => member.peerKind === 'person');

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={[styles.root, { paddingBottom: Math.max(insets.bottom, 18) }]}>
        <Pressable
          accessibilityLabel="Close person picker"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID="direct-message-picker-scrim"
        />
        <HullSurface strength="raised" style={styles.sheet} testID="direct-message-picker">
          <View style={styles.heading}>
            <View style={styles.headingCopy}>
              <Text style={styles.title}>Message</Text>
              <Text style={styles.hint}>Choose a person in this Workspace.</Text>
            </View>
            <TouchableOpacity
              accessibilityLabel="Close person picker"
              accessibilityRole="button"
              onPress={onClose}
              style={styles.close}
              testID="direct-message-picker-close"
            >
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>
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
        </HullSurface>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    root: {
      flex: 1,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(10, 5, 14, 0.82)',
    },
    sheet: {
      width: '100%',
      maxWidth: 460,
      maxHeight: '78%',
      padding: 16,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgRaised,
    },
    heading: { minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    headingCopy: { flex: 1, minWidth: 0 },
    title: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      color: groknight.textPrimary,
      fontSize: 19,
      lineHeight: 24,
    },
    hint: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      marginTop: 3,
      color: groknight.textMuted,
      fontSize: 12,
      lineHeight: 17,
    },
    close: {
      width: 44,
      height: 44,
      marginTop: -10,
      marginRight: -10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeText: { ...Typography.default(), color: groknight.steel, fontSize: 24 },
    list: { paddingTop: 16, paddingBottom: 4 },
    row: {
      minHeight: 60,
      paddingHorizontal: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: 1,
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
