import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowName, roomRowPreview, NO_ACTIVITY_PREVIEW } from '@/buzz/room-list-row';
import { compactRelativeTime } from '@/buzz/relative-time';
import { IdentityMark } from './IdentityMark';
import { HullActionSheetModal, HullActionSheetRow, HullActionSheetCancel } from './HullActionSheet';

export function ConversationRow({
  item,
  viewer,
  now,
  onPress,
  onPin,
  pinned = false,
  selected = false,
  testID,
}: {
  item: ChatListItem;
  viewer?: string;
  now: number;
  onPress: () => void;
  onPin: () => void;
  pinned?: boolean;
  selected?: boolean;
  testID: string;
}) {
  const name = roomRowName(item);
  const preview = roomRowPreview(item, viewer);
  const [menu, setMenu] = useState(false);
  const peer = item.directMessage?.peer;
  return (
    <>
      <Pressable
        onPress={onPress}
        onLongPress={() => setMenu(true)}
        accessibilityRole="button"
        accessibilityHint="Long press to pin or unpin this conversation"
        accessibilityLabel={`${name.sigil}${name.name}${item.unread ? ', unread messages' : ''}${pinned ? ', pinned' : ''}`}
        accessibilityState={selected ? { selected: true } : undefined}
        accessibilityActions={[
          { name: 'pin', label: pinned ? 'Unpin conversation' : 'Pin conversation' },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'pin') onPin();
        }}
        style={({ pressed }) => [
          styles.row,
          selected && styles.selected,
          pressed && styles.pressed,
        ]}
        testID={testID}
      >
        <View style={styles.heading}>
          {peer && (
            <IdentityMark
              seed={peer.pubkey}
              name={peer.name}
              face={peer.face}
              avatarUrl={peer.avatar}
              kind={peer.kind === 'agent' ? 'agent' : 'human'}
              size={28}
            />
          )}
          <Text numberOfLines={1} style={[styles.name, item.unread && styles.unreadName]}>
            {!peer && <Text style={styles.sigil}>#</Text>}
            {name.name}
          </Text>
          {pinned && <Ionicons name="pin-outline" size={14} color={styles.quiet.color} />}
          {selected && <Text style={styles.open}>Open</Text>}
          <Text style={styles.age}>
            {compactRelativeTime(item.latestMessage?.createdAt ?? item.room.updatedAt, now)}
          </Text>
          {item.unread && <View style={styles.dot} testID={`${testID}-unread`} />}
        </View>
        {preview.text !== NO_ACTIVITY_PREVIEW && preview.attribution !== 'none' && (
          <Text style={[styles.author, preview.attribution === 'self' && styles.quiet]}>
            {preview.attribution === 'self'
              ? 'you'
              : preview.attribution === 'other'
                ? preview.handle
                : ''}
          </Text>
        )}
        <Text numberOfLines={2} style={styles.preview} testID={`${testID}-preview`}>
          {preview.text}
        </Text>
      </Pressable>
      <HullActionSheetModal visible={menu} title={name.name} onClose={() => setMenu(false)}>
        <HullActionSheetRow
          label={pinned ? 'Unpin conversation' : 'Pin conversation'}
          onPress={() => {
            setMenu(false);
            onPin();
          }}
        />
        <HullActionSheetCancel onPress={() => setMenu(false)} />
      </HullActionSheetModal>
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.buzz.space.md,
    paddingTop: theme.buzz.space.lg,
    paddingBottom: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgBase,
  },
  heading: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm },
  name: { ...theme.buzz.type.body, flex: 1, color: theme.buzz.textPrimary },
  unreadName: { fontFamily: theme.buzz.type.bodyStrong.fontFamily },
  sigil: { color: theme.buzz.accent },
  author: { ...theme.buzz.type.meta, color: theme.buzz.accent, marginTop: theme.buzz.space.sm },
  preview: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    marginTop: theme.buzz.space.xs,
  },
  age: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  open: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.buzz.textPrimary },
  selected: {
    backgroundColor: theme.buzz.bgHighlight,
    borderLeftWidth: 1,
    borderLeftColor: theme.buzz.accent,
  },
  pressed: { backgroundColor: theme.buzz.bgPressed },
  quiet: { color: theme.buzz.ledgerQuiet },
}));
