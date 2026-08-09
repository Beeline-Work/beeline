import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Community } from '@buzzy/buzz-client';
import { groknight } from '@/buzz/groknight';

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

type CommunityInviteEntryProps = {
  community: Community | null;
  creatingInvite: boolean;
  onCreateCommunity: () => void;
  onInvitePeople: () => void;
};

export function CommunityInviteEntry({
  community,
  creatingInvite,
  onCreateCommunity,
  onInvitePeople,
}: CommunityInviteEntryProps) {
  if (community) {
    return (
      <View style={styles.communityEntry} testID="community-invite-entry">
        <View style={styles.copy}>
          <Text style={styles.eyebrow}>bring people in</Text>
          <Text style={styles.detail} numberOfLines={1}>
            Share a private link to {community.name}
          </Text>
        </View>
        <TouchableOpacity
          accessibilityLabel={`Invite people to ${community.name}`}
          accessibilityRole="button"
          disabled={creatingInvite}
          onPress={onInvitePeople}
          style={[styles.primaryButton, creatingInvite && styles.disabled]}
          testID="invite-people-action"
        >
          <Text style={styles.primaryButtonText}>
            {creatingInvite ? 'creating invite…' : 'invite people'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.standaloneEntry} testID="standalone-invite-entry">
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>want to invite people?</Text>
        <Text style={styles.detail}>
          Standalone channels cannot be shared. Create a community, then invite people with a
          private link.
        </Text>
      </View>
      <TouchableOpacity
        accessibilityLabel="Create a community to invite people"
        accessibilityRole="button"
        onPress={onCreateCommunity}
        style={styles.primaryButton}
        testID="create-community-to-invite-action"
      >
        <Text style={styles.primaryButtonText}>create community</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  communityEntry: {
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderActive,
    backgroundColor: groknight.bgCode,
  },
  standaloneEntry: {
    minHeight: 76,
    paddingHorizontal: 14,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderActive,
    backgroundColor: groknight.bgCode,
  },
  copy: { flex: 1, minWidth: 0 },
  eyebrow: {
    color: groknight.accent,
    fontFamily: mono,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  detail: {
    marginTop: 4,
    color: groknight.muted,
    fontFamily: mono,
    fontSize: 10,
    lineHeight: 15,
  },
  primaryButton: {
    minHeight: 38,
    paddingHorizontal: 13,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.accent,
  },
  primaryButtonText: {
    color: groknight.bgTerminal,
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '800',
  },
  disabled: { opacity: 0.45 },
});
