import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
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
  const { theme } = useUnistyles();
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);

  const filteredMembers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return members;
    return members.filter((member) =>
      member.peerName.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [members, query]);
  const people = filteredMembers.filter((member) => member.peerKind === 'person');
  const agents = filteredMembers.filter((member) => member.peerKind === 'agent');

  return (
    <HullActionSheetModal
      accessibilityLabel="Close member picker"
      onClose={onClose}
      scrimTestID="direct-message-picker-scrim"
      subtitle="Choose a member of this Workspace."
      testID="direct-message-picker"
      title="Message"
      visible={visible}
    >
      <TextInput
        accessibilityLabel="Search Workspace members"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search members"
        placeholderTextColor={theme.buzz.textMuted}
        returnKeyType="search"
        style={styles.search}
        testID="direct-message-picker-search"
        value={query}
      />
      <ScrollView
        contentContainerStyle={styles.list}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        style={styles.listViewport}
        testID="direct-message-picker-list"
      >
        {people.length > 0 && <SectionHeading label="PEOPLE" />}
        {people.map((member) => (
          <MemberRow
            busy={busyPubkey === member.peerPubkey}
            disabled={Boolean(busyPubkey)}
            key={member.peerPubkey}
            member={member}
            onPress={() => onMessage(member)}
          />
        ))}
        {people.length === 0 && agents.length === 0 && (
          <Text accessibilityLiveRegion="polite" style={styles.empty}>
            {query.trim()
              ? `No members match “${query.trim()}”.`
              : 'No other members in this Workspace yet.'}
          </Text>
        )}
        {agents.length > 0 && <SectionHeading label="AGENTS" />}
        {agents.map((member) => (
          <MemberRow
            busy={busyPubkey === member.peerPubkey}
            disabled={Boolean(busyPubkey)}
            key={member.peerPubkey}
            member={member}
            onPress={() => onMessage(member)}
          />
        ))}
      </ScrollView>
      <HullActionSheetCancel onPress={onClose} testID="direct-message-picker-close" />
    </HullActionSheetModal>
  );
}

function SectionHeading({ label }: { label: string }) {
  return <Text style={styles.section}>{label}</Text>;
}

function MemberRow({
  busy,
  disabled,
  member,
  onPress,
}: {
  busy: boolean;
  disabled: boolean;
  member: WorkspaceMemberDisplayItem;
  onPress: () => void;
}) {
  const agent = member.peerKind === 'agent';
  return (
    <TouchableOpacity
      accessibilityLabel={`Message ${member.peerName}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={styles.row}
      testID={`message-workspace-member-${member.peerPubkey}`}
    >
      <IdentityMark
        {...(agent ? ({ kind: 'agent' } as const) : ({ kind: 'human' } as const))}
        seed={member.peerPubkey}
        avatarUrl={member.avatarUrl}
        face={member.face}
        name={member.peerName}
        size={36}
      />
      <Text numberOfLines={1} style={styles.name}>
        {member.peerName}
      </Text>
      <Text style={styles.action}>{busy ? 'OPENING…' : 'MESSAGE'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    search: {
      ...Typography.default(),
      ...groknight.type.meta,
      minHeight: 44,
      marginHorizontal: 10,
      paddingHorizontal: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.border,
      color: groknight.textPrimary,
      fontFamily: groknight.proseRegular,
    },
    listViewport: { maxHeight: 440, flexGrow: 0 },
    list: { paddingBottom: 4 },
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
    section: {
      ...Typography.mono('semiBold'),
      color: groknight.chrome,
      fontSize: 9,
      letterSpacing: 0.6,
      paddingTop: 14,
      paddingBottom: 4,
      paddingHorizontal: 10,
    },
  };
});
