import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Community } from '@beeline/buzz-client';
import { groknight } from '@/buzz/groknight';
import { WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';

type CommunityInviteEntryProps = {
  community: Community | null;
  creatingInvite: boolean;
  allowPeopleInvites?: boolean;
  showManageAgents?: boolean;
  onInvitePeople: () => void;
  onManageAgents?: () => void;
};

export function CommunityInviteEntry({
  community,
  creatingInvite,
  allowPeopleInvites = true,
  showManageAgents = false,
  onInvitePeople,
  onManageAgents,
}: CommunityInviteEntryProps) {
  if (!community || (!allowPeopleInvites && !showManageAgents)) return null;

  return (
    <View style={styles.communityEntry} testID="community-invite-entry">
      {showManageAgents && onManageAgents ? (
        <TouchableOpacity
          accessibilityLabel={`Open members for ${community.name}`}
          accessibilityRole="button"
          onPress={onManageAgents}
          style={styles.action}
          testID="members-action"
        >
          <Text style={styles.actionIcon}>⌬</Text>
          <Text style={styles.actionText}>Members</Text>
        </TouchableOpacity>
      ) : allowPeopleInvites ? (
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
            {creatingInvite ? 'Opening share…' : 'Invite people'}
          </Text>
        </TouchableOpacity>
      ) : null}
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
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 18,
    backgroundColor: groknight.bgTerminal,
  },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  actionIcon: { ...Typography.default(), color: groknight.steel, fontSize: 13 },
  actionText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 13,
  },
  disabled: { backgroundColor: groknight.bgBase },
});
