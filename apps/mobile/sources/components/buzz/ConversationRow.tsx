import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import {
  roomRowAttentionReason,
  roomRowName,
  roomRowPreview,
  NO_ACTIVITY_PREVIEW,
} from '@/buzz/room-list-row';
import { compactRelativeTime } from '@/buzz/relative-time';
import { CornerGlyph } from './CornerGlyph';
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
  cornersExpanded = false,
  onToggleCorners,
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
  cornersExpanded?: boolean;
  onToggleCorners?: () => void;
  testID: string;
}) {
  const name = roomRowName(item);
  const preview = roomRowPreview(item, viewer);
  const reason = roomRowAttentionReason(item);
  const needsYou = Boolean(reason);
  const status = needsYou ? 'needs you' : item.unread ? 'new messages' : null;
  const hasCorners = !item.directMessage && (item.cornerCount ?? 0) > 0;
  const cornerRotation = useSharedValue(cornersExpanded ? 1 : 0);
  React.useEffect(() => {
    cornerRotation.value = withTiming(cornersExpanded ? 1 : 0, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [cornerRotation, cornersExpanded]);
  const cornerRotationStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${cornerRotation.value * 135}deg` }],
  }));

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onPin}
      accessibilityRole="button"
      accessibilityHint="Long press to toggle this conversation's pin"
      accessibilityLabel={`${name.sigil}${name.name}${status ? `, ${status}` : ''}${pinned ? ', pinned' : ''}`}
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
        !desktop && styles.mobileRow,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
      testID={testID}
    >
      <View style={styles.copy}>
        <View style={styles.heading}>
          {pinned && (
            <View style={styles.pin} testID={`${testID}-pinned`}>
              <PinGlyph color={styles.sigil.color} size={10} />
            </View>
          )}
          <Text numberOfLines={1} style={[styles.name, item.unread && styles.unreadName]}>
            <Text style={styles.sigil}>{name.sigil}</Text>
            {name.name}
          </Text>
        </View>
        <View style={styles.previewLine}>
          <Text
            numberOfLines={1}
            style={[
              styles.preview,
              item.unread && !reason && styles.unreadPreview,
              reason && styles.reason,
            ]}
            testID={`${testID}-preview`}
          >
            {reason ? (
              reason
            ) : (
              <>
                {preview.attribution !== 'none' && preview.text !== NO_ACTIVITY_PREVIEW && (
                  <Text style={preview.attribution === 'self' ? styles.quiet : styles.author}>
                    {preview.attribution === 'self' ? 'you' : `@${preview.handle}`}
                    <Text style={styles.quiet}>{'\u00a0\u00b7\u00a0'}</Text>
                  </Text>
                )}
                {preview.text}
              </>
            )}
          </Text>
          <Text style={styles.age}>
            {compactRelativeTime(item.latestMessage?.createdAt ?? item.room.updatedAt, now)}
          </Text>
        </View>
      </View>
      <View style={styles.statusCell}>
        <View style={styles.statusSlot}>
          {status && (
            <View
              accessibilityLabel={status}
              accessibilityRole="image"
              style={[styles.statusMark, needsYou && styles.needsRing]}
              testID={`${testID}-${needsYou ? 'needs-you' : 'unread'}`}
            >
              <View style={styles.dot} />
            </View>
          )}
        </View>
        <View style={styles.statusSlot}>
          {hasCorners && (
            <Pressable
              accessibilityLabel={`${cornersExpanded ? 'Collapse' : 'Expand'} ${item.cornerCount} corners`}
              accessibilityRole="button"
              accessibilityState={{ expanded: cornersExpanded }}
              hitSlop={8}
              onPress={(event) => {
                event.stopPropagation();
                onToggleCorners?.();
              }}
              style={styles.cornerToggle}
              testID={`${testID}-corners`}
            >
              <Animated.View style={cornerRotationStyle}>
                <CornerGlyph size={13} />
              </Animated.View>
            </Pressable>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 62,
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: 9,
    flexDirection: 'row',
    gap: 12,
    backgroundColor: 'transparent',
  },
  desktopRow: { minHeight: 62, paddingLeft: 20 },
  mobileRow: { minHeight: 68, paddingHorizontal: 14, paddingVertical: 10 },
  copy: { flex: 1, minWidth: 0 },
  heading: { minHeight: 23, flexDirection: 'row', alignItems: 'center' },
  pin: { width: 14, alignItems: 'flex-start', justifyContent: 'center' },
  name: {
    fontFamily: theme.buzz.proseRegular,
    fontSize: 16,
    lineHeight: 23,
    flex: 1,
    color: theme.buzz.textPrimary,
  },
  unreadName: { fontFamily: theme.buzz.proseSemibold },
  sigil: { color: theme.buzz.accent },
  previewLine: {
    minHeight: 20,
    marginTop: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  preview: {
    fontFamily: theme.buzz.proseRegular,
    fontSize: 13,
    lineHeight: 19,
    flex: 1,
    color: theme.buzz.textSecondary,
  },
  unreadPreview: { color: theme.buzz.textPrimary },
  reason: { color: theme.buzz.accent },
  author: { color: theme.buzz.accent },
  quiet: { color: theme.buzz.ledgerQuiet },
  age: {
    fontFamily: theme.buzz.proseRegular,
    fontSize: 13,
    lineHeight: 19,
    color: theme.buzz.ledgerQuiet,
    flexShrink: 0,
  },
  statusCell: { width: 14, alignItems: 'center', justifyContent: 'space-between' },
  statusSlot: { width: 14, height: 19, alignItems: 'center', justifyContent: 'center' },
  statusMark: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.buzz.accent },
  needsRing: {
    borderWidth: 1,
    borderColor: theme.buzz.accent,
  },
  cornerToggle: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  selected: {
    backgroundColor: theme.buzz.bgHighlight,
    borderLeftWidth: 1,
    borderLeftColor: theme.buzz.accent,
  },
  pressed: { backgroundColor: theme.buzz.bgPressed },
}));
