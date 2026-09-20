import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MessageReactionView, RoomViewIdentity } from '@beeline/buzz-client';
import { emojiTextStyle } from '@/buzz/emoji-text';
import { IdentityMark } from './IdentityMark';
import { HULL_SHEET_INSET, HullActionSheetCancel, HullActionSheetModal } from './HullActionSheet';
import { HullFloatingSurface } from './HullDialog';

function rosterSubtitle(identity: RoomViewIdentity): string {
  return [identity.handle ? `@${identity.handle.replace(/^@/, '')}` : undefined, identity.kind]
    .filter(Boolean)
    .join(' · ');
}

function ReactionMembers({
  members,
  messageId,
  sheet = false,
}: {
  members: readonly RoomViewIdentity[];
  messageId: string;
  sheet?: boolean;
}) {
  return (
    <View style={styles.memberList}>
      {members.map((member) => (
        <View
          accessibilityLabel={`${member.name}, ${rosterSubtitle(member)}`}
          key={member.pubkey}
          style={[styles.memberRow, sheet && styles.sheetMemberRow]}
          testID={`reaction-member-${messageId}-${member.pubkey}`}
        >
          <IdentityMark
            kind={member.kind}
            seed={member.pubkey}
            avatarUrl={member.avatar}
            face={member.face}
            name={member.name}
            size={32}
          />
          <View style={styles.memberCopy}>
            <Text numberOfLines={1} style={styles.memberName}>
              {member.name}
            </Text>
            <Text numberOfLines={1} style={styles.memberMeta}>
              {rosterSubtitle(member)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * A reaction keeps its quick toggle on press. Identity detail follows the
 * native input model: long press opens a bottom sheet on touch layouts, while
 * hover or keyboard focus reveals a compact popover on desktop/web.
 */
export function MessageReactionRoster({
  desktop,
  messageId,
  onReact,
  reaction,
}: {
  desktop: boolean;
  messageId: string;
  onReact(): void;
  reaction: MessageReactionView;
}) {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const suppressPressUntil = useRef(0);
  const reactors = reaction.members ?? [];
  const rosterAvailable = reactors.length > 0;
  const reactionLabel = `${reaction.emoji}, ${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`;
  const desktopRosterVisible = desktop && rosterAvailable && (hovered || focused);

  return (
    <View
      style={styles.anchor}
      {...(desktop
        ? ({
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          } as any)
        : {})}
      testID={`reaction-roster-anchor-${messageId}-${reaction.emoji}`}
    >
      <Pressable
        accessibilityHint={
          rosterAvailable
            ? desktop
              ? 'Hover or focus to see who reacted'
              : 'Long press to see who reacted'
            : undefined
        }
        accessibilityLabel={reactionLabel}
        accessibilityRole="button"
        accessibilityState={{ selected: reaction.reacted }}
        hitSlop={8}
        onBlur={() => setFocused(false)}
        onFocus={() => setFocused(true)}
        onLongPress={
          !desktop && rosterAvailable
            ? () => {
                suppressPressUntil.current = Date.now() + 750;
                setSheetVisible(true);
              }
            : undefined
        }
        onPress={() => {
          if (Date.now() < suppressPressUntil.current) return;
          onReact();
        }}
        style={[styles.chip, reaction.reacted && styles.chipMine]}
        testID={`reaction-chip-${messageId}-${reaction.emoji}`}
      >
        <Text style={styles.emoji}>{reaction.emoji}</Text>
        <Text style={styles.count}>{reaction.count}</Text>
      </Pressable>

      {desktopRosterVisible ? (
        <HullFloatingSurface
          accessibilityLabel={`${reactionLabel}. Reacted by ${reactors.map((member) => member.name).join(', ')}`}
          style={styles.popover}
          testID={`reaction-popover-${messageId}-${reaction.emoji}`}
        >
          <Text style={styles.popoverTitle}>Reacted with {reaction.emoji}</Text>
          <ReactionMembers members={reactors} messageId={messageId} />
        </HullFloatingSurface>
      ) : null}

      {!desktop && sheetVisible ? (
        <HullActionSheetModal
          accessibilityLabel="Close reaction roster"
          onClose={() => setSheetVisible(false)}
          subtitle={`${reaction.count} member${reaction.count === 1 ? '' : 's'}`}
          testID={`reaction-sheet-${messageId}-${reaction.emoji}`}
          title={`Reacted with ${reaction.emoji}`}
          visible={sheetVisible}
        >
          <ScrollView style={styles.sheetList}>
            <ReactionMembers members={reactors} messageId={messageId} sheet />
          </ScrollView>
          <HullActionSheetCancel
            onPress={() => setSheetVisible(false)}
            testID={`reaction-sheet-close-${messageId}-${reaction.emoji}`}
          />
        </HullActionSheetModal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    anchor: { position: 'relative' },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.xs,
      minHeight: 28,
      paddingHorizontal: hull.space.sm,
      borderWidth: 1,
      borderColor: hull.border,
      borderRadius: hull.radius,
      backgroundColor: hull.bgBase,
    },
    chipMine: {
      borderColor: hull.accent,
      backgroundColor: hull.bgHighlight,
    },
    emoji: emojiTextStyle(hull.type.body),
    count: { ...hull.type.meta, color: hull.textSecondary },
    popover: {
      position: 'absolute',
      bottom: 34,
      left: 0,
      zIndex: 12,
      width: 232,
      paddingVertical: hull.space.sm,
      paddingHorizontal: hull.space.md,
    },
    popoverTitle: {
      ...hull.type.meta,
      color: hull.ledgerQuiet,
      marginBottom: hull.space.xs,
    },
    sheetList: { maxHeight: 360 },
    memberList: { width: '100%' },
    memberRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    sheetMemberRow: { paddingHorizontal: HULL_SHEET_INSET },
    memberCopy: { flex: 1, minWidth: 0 },
    memberName: { ...hull.type.body, color: hull.textPrimary },
    memberMeta: { ...hull.type.meta, color: hull.ledgerQuiet },
  };
});
