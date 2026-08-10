import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Community } from '@buzzy/buzz-client';
import { groknight } from '@/buzz/groknight';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';

type CommunityInviteEntryProps = {
  community: Community | null;
  creatingInvite: boolean;
  onInvitePeople: () => void;
  onManageAgents: () => void;
};

export function CommunityInviteEntry({
  community,
  creatingInvite,
  onInvitePeople,
  onManageAgents,
}: CommunityInviteEntryProps) {
  if (!community) return null;

  return (
    <View style={styles.communityEntry} testID="community-invite-entry">
      <TouchableOpacity
        accessibilityLabel={`Connect an Agent to ${community.name}`}
        accessibilityRole="button"
        onPress={onManageAgents}
        style={styles.action}
        testID="manage-agents-action"
      >
        <Text style={styles.actionIcon}>⌬</Text>
        <Text style={styles.actionText}>Connect an Agent</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityLabel={`Invite people to ${community.name}`}
        accessibilityRole="button"
        disabled={creatingInvite}
        onPress={onInvitePeople}
        style={[styles.action, creatingInvite && styles.disabled]}
        testID="invite-people-action"
      >
        <Text style={styles.actionIcon}>＋</Text>
        <Text style={styles.actionText}>
          {creatingInvite ? 'Creating invite…' : 'Invite people'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  communityEntry: {
    minHeight: 46,
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    backgroundColor: groknight.bgTerminal,
  },
  action: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  actionIcon: { color: groknight.steel, fontSize: 13 },
  actionText: { color: groknight.textSecondary, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.45 },
});
