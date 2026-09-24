import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowName, roomRowPreview, NO_ACTIVITY_PREVIEW } from '@/buzz/room-list-row';
import { compactRelativeTime } from '@/buzz/relative-time';
import { IdentityMark } from './IdentityMark';
import { PinGlyph } from './PinGlyph';

export function ConversationRow({
  item,
  viewer,
  now,
  onPress,
  onPin,
  pinned = false,
  selected = false,
  desktop = false,
  testID,
}: {
  item: ChatListItem;
  viewer?: string;
  now: number;
  onPress: () => void;
  onPin: () => void;
  pinned?: boolean;
  selected?: boolean;
  desktop?: boolean;
  testID: string;
}) {
  const name = roomRowName(item);
  const preview = roomRowPreview(item, viewer);
  const peer = item.directMessage?.peer;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onPin}
      accessibilityRole="button"
      accessibilityHint="Long press to toggle this conversation's pin"
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
        desktop && styles.desktopRow,
        desktop && (item.cornerCount ?? 0) > 0 && styles.desktopRowWithCorners,
        !desktop && styles.cardRow,
        !desktop && (peer || !item.cornerCount) && styles.previewCardRow,
        desktop && item.unread && styles.unread,
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
        <Text
          numberOfLines={1}
          style={[styles.name, !desktop && styles.cardName, item.unread && styles.unreadName]}
        >
          {!peer && <Text style={styles.sigil}>#</Text>}
          {name.name}
        </Text>
        {pinned && (
          <View testID={`${testID}-pinned`}>
            <PinGlyph color={styles.sigil.color} size={18} />
          </View>
        )}
        {selected && <Text style={styles.open}>Open</Text>}
        <Text style={styles.age}>
          {compactRelativeTime(item.latestMessage?.createdAt ?? item.room.updatedAt, now)}
        </Text>
        {item.unread && <View style={styles.dot} testID={`${testID}-unread`} />}
      </View>
      <Text
        numberOfLines={2}
        style={[
          styles.preview,
          !desktop && styles.cardPreview,
          desktop && styles.desktopPreview,
          item.unread && styles.unreadPreview,
        ]}
        testID={`${testID}-preview`}
      >
        {!peer && preview.attribution !== 'none' && preview.text !== NO_ACTIVITY_PREVIEW && (
          <Text style={preview.attribution === 'self' ? styles.quiet : styles.author}>
            {preview.attribution === 'self' ? 'you' : preview.handle}
            <Text style={styles.quiet}>{'\u00a0·\u00a0'}</Text>
          </Text>
        )}
        {preview.text}
      </Text>
    </Pressable>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    paddingHorizontal: theme.buzz.space.md,
    paddingTop: theme.buzz.space.lg,
    paddingBottom: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgBase,
  },
  desktopRow: { paddingTop: 18, paddingBottom: 18, minHeight: 98 },
  desktopRowWithCorners: { paddingBottom: theme.buzz.space.xs, minHeight: 94 },
  // Mobile rows sit inside the Room list card, which owns the fill and border.
  cardRow: { padding: theme.buzz.roomCard.padding, backgroundColor: 'transparent' },
  // Without the corner summary below it, the preview is the card's last line.
  previewCardRow: { paddingTop: theme.buzz.roomCard.previewCardTop },
  heading: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm },
  name: { ...theme.buzz.type.body, flex: 1, color: theme.buzz.textPrimary },
  cardName: {
    fontFamily: theme.buzz.type.hero.fontFamily,
    fontSize: theme.buzz.roomCard.nameSize,
    lineHeight: theme.buzz.roomCard.nameLineHeight,
  },
  unread: { backgroundColor: theme.buzz.bgUnread },
  unreadPreview: { color: theme.buzz.textPrimary },
  unreadName: { fontFamily: theme.buzz.type.bodyStrong.fontFamily },
  sigil: { color: theme.buzz.accent },
  author: { color: theme.buzz.accent },
  preview: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    marginTop: theme.buzz.space.xs,
  },
  cardPreview: {
    fontSize: theme.buzz.roomCard.previewSize,
    lineHeight: theme.buzz.roomCard.previewLineHeight,
  },
  desktopPreview: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    lineHeight: 20,
    marginTop: theme.buzz.space.sm,
  },
  age: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  open: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: theme.buzz.bgBase,
    backgroundColor: theme.buzz.accent,
  },
  selected: {
    backgroundColor: theme.buzz.bgHighlight,
    borderLeftWidth: 1,
    borderLeftColor: theme.buzz.accent,
  },
  pressed: { backgroundColor: theme.buzz.bgPressed },
  quiet: { color: theme.buzz.ledgerQuiet },
}));
