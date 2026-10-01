import React, { useEffect, useRef } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import {
  CHANNEL_MENTION_PUBKEY,
  SYSTEM_MENTION_LABEL,
  SYSTEM_MENTION_PUBKEY,
} from '@/buzz/room-participants';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { memberRosterSubtitle } from '@/components/buzz/MemberRosterRow';
import type { RoomRosterParticipant } from '@/components/buzz/RoomRosterSheet';

/** One-line mention row height; also the unit of the scroll cap. */
export const MENTION_ROW_HEIGHT = 44;

/**
 * The composer's @-mention menu. The MENTION label stays fixed; rows scroll
 * under a cap of 3 rows while the keyboard is open (so the text input stays
 * above it) and 5 rows otherwise.
 */
export function MentionSuggestionMenu({
  matches,
  overflow,
  highlightedIndex,
  keyboardOpen,
  personAvatar,
  onSelect,
}: {
  matches: readonly RoomRosterParticipant[];
  overflow: number;
  highlightedIndex: number;
  keyboardOpen: boolean;
  personAvatar: (pubkey: string) => string | undefined;
  onSelect: (participant: RoomRosterParticipant) => void;
}) {
  const visibleRows = keyboardOpen ? 3 : 5;
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);

  useEffect(() => {
    const top = highlightedIndex * MENTION_ROW_HEIGHT;
    const bottom = top + MENTION_ROW_HEIGHT;
    const windowHeight = visibleRows * MENTION_ROW_HEIGHT;
    let target: number | undefined;
    if (top < scrollOffset.current) target = top;
    else if (bottom > scrollOffset.current + windowHeight) target = bottom - windowHeight;
    if (target === undefined) return;
    // Record the offset now: onScroll may not fire before the next highlight change.
    scrollOffset.current = target;
    scrollRef.current?.scrollTo({ y: target, animated: false });
  }, [highlightedIndex, visibleRows]);

  return (
    <View
      accessibilityLabel="Mention a Room participant"
      style={styles.mentionMenu}
      testID="mention-suggestions"
    >
      <Text style={styles.mentionMenuLabel}>MENTION</Text>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          scrollOffset.current = event.nativeEvent.contentOffset.y;
        }}
        ref={scrollRef}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: visibleRows * MENTION_ROW_HEIGHT }}
        testID="mention-suggestion-scroll"
      >
        {matches.map((participant, index) => {
          const selected = index === highlightedIndex;
          // The two reserved rows (`@channel`, `@system`) are tokens, not
          // identities: a glyph instead of a face, and words for what they do.
          const reserved =
            participant.pubkey === CHANNEL_MENTION_PUBKEY ||
            participant.pubkey === SYSTEM_MENTION_PUBKEY;
          const display = participant.agent
            ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
            : undefined;
          // A member row reads like the roster: the handle, then model and
          // owner for an agent, or the Room role for a person.
          const subtitle = reserved
            ? undefined
            : participant.kind === 'agent'
              ? memberRosterSubtitle({
                  kind: 'agent',
                  model: participant.model,
                  ownerHandle: participant.ownerHandle,
                })
              : memberRosterSubtitle({ kind: 'human', role: participant.role });
          return (
            <TouchableOpacity
              accessibilityLabel={
                participant.pubkey === SYSTEM_MENTION_PUBKEY
                  ? `${SYSTEM_MENTION_LABEL}, @${participant.handle}`
                  : subtitle !== undefined
                    ? `@${participant.handle}, ${subtitle}, ${participant.kind}`
                    : `${participant.name}, @${participant.handle}, ${participant.kind}`
              }
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={participant.pubkey}
              onPress={() => onSelect(participant)}
              style={[styles.mentionRow, selected && styles.mentionRowSelected]}
              testID={`mention-suggestion-${participant.handle}`}
            >
              {reserved ? (
                <View style={styles.mentionChannelGlyph}>
                  <Text style={styles.mentionChannelGlyphText}>
                    {participant.pubkey === SYSTEM_MENTION_PUBKEY ? '!' : '@'}
                  </Text>
                </View>
              ) : display ? (
                <IdentityMark
                  kind="agent"
                  seed={display.avatarSeed ?? participant.pubkey}
                  avatarUrl={display.avatarUrl}
                  face={display.face}
                  name={display.name}
                  size={24}
                />
              ) : (
                <IdentityMark
                  kind="human"
                  seed={participant.pubkey}
                  avatarUrl={personAvatar(participant.pubkey)}
                  face={participant.face}
                  name={participant.name}
                  size={24}
                />
              )}
              {subtitle !== undefined ? (
                <View style={styles.mentionIdentity}>
                  <Text numberOfLines={1} style={styles.mentionName}>
                    @{participant.handle}
                  </Text>
                  <Text numberOfLines={1} style={styles.mentionHandle}>
                    {subtitle}
                  </Text>
                </View>
              ) : (
                <>
                  <View style={styles.mentionIdentity}>
                    <Text numberOfLines={1} style={styles.mentionName}>
                      {participant.pubkey === CHANNEL_MENTION_PUBKEY
                        ? 'Everyone in this Room'
                        : SYSTEM_MENTION_LABEL}
                    </Text>
                    <Text numberOfLines={1} style={styles.mentionHandle}>
                      @{participant.handle}
                    </Text>
                  </View>
                  <Text style={styles.mentionKind}>
                    {participant.pubkey === CHANNEL_MENTION_PUBKEY ? 'ROOM' : 'REPORT'}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          );
        })}
        {overflow > 0 && (
          <Text style={styles.mentionOverflow} testID="mention-suggestion-overflow">
            AND {overflow} OTHERS
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    mentionMenu: {
      marginBottom: 6,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      borderRadius: groknight.radius,
      backgroundColor: groknight.bgBase,
    },
    mentionMenuLabel: {
      ...groknight.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      paddingHorizontal: 10,
      paddingVertical: 5,
      color: groknight.textMuted,
    },
    mentionRow: {
      height: MENTION_ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingHorizontal: 9,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
    },
    mentionRowSelected: {
      backgroundColor: groknight.selection,
    },
    mentionIdentity: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    mentionChannelGlyph: {
      width: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      borderRadius: groknight.radius,
    },
    mentionChannelGlyphText: {
      ...groknight.type.meta,
      fontFamily: groknight.proseSemibold,
      color: groknight.accent,
    },
    mentionName: {
      ...groknight.type.meta,
      fontFamily: groknight.proseSemibold,
      flexShrink: 1,
      maxWidth: '60%',
      color: groknight.textPrimary,
    },
    mentionHandle: {
      ...groknight.type.machine,
      flexShrink: 1,
      color: groknight.textMuted,
    },
    mentionKind: {
      ...groknight.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.faint,
    },
    mentionOverflow: {
      ...groknight.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      color: groknight.textMuted,
    },
  };
});
