import { MemberRosterRow } from './MemberRosterRow';
import { Button } from './Button';
import { RoomListSectionHeader } from './RoomListSectionHeader';
import { HullDialogInput } from '@/components/buzz/HullDialog';
import { useTextDraft } from '@/buzz/use-text-draft';
import React, { useMemo } from 'react';
import { ScrollView, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
import { HullActionSheetCancel, HullActionSheetModal } from './HullActionSheet';

type DirectMessagePickerSheetProps = {
  busyPubkey: string | null;
  members: WorkspaceMemberDisplayItem[];
  onClose: () => void;
  onMessage: (member: WorkspaceMemberDisplayItem) => void;
  visible: boolean;
  draftContext?: string;
};

/** Restores the existing Workspace-roster DM start flow behind the deck menu. */
export function DirectMessagePickerSheet({
  busyPubkey,
  members,
  onClose,
  onMessage,
  visible,
  draftContext = 'global',
}: DirectMessagePickerSheetProps) {
  const { theme } = useUnistyles();
  const [query, setQuery] = useTextDraft(`dm-search:${draftContext}`, '');
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
      <HullDialogInput
        accessibilityLabel="Search Workspace members"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search members"
        placeholderTextColor={theme.buzz.textMuted}
        returnKeyType="search"
        variant="sheetSearch"
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
        {people.length > 0 && <RoomListSectionHeader title="People" count={people.length} surface="sheet" />}
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
        {agents.length > 0 && <RoomListSectionHeader title="Agents" count={agents.length} surface="sheet" />}
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
    <MemberRosterRow
      kind={agent ? 'agent' : 'human'}
      name={member.peerName}
      title={member.peerName}
      pubkey={member.peerPubkey}
      avatarUrl={member.avatarUrl}
      face={member.face}
      disabled={disabled}
      onPress={onPress}
      divider="top"
      accessibilityLabel={`Message ${member.peerName}`}
      testID={`message-workspace-member-${member.peerPubkey}`}
      trailing={
        <Button
          label={busy ? 'Opening…' : 'Message'}
          variant="quiet"
          disabled={disabled}
          onPress={(event) => {
            event.stopPropagation();
            onPress();
          }}
        />
      }
    />
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    listViewport: { maxHeight: 440, flexGrow: 0 },
    list: { paddingBottom: 4 },
    empty: {
      ...groknight.type.meta,
      paddingVertical: 24,
      color: groknight.textMuted,
      textAlign: 'center',
    },
  };
});
