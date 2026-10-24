import { Button } from '@/components/buzz/Button';
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Community } from '@beeline/buzz-client';
import { MEMBERS_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';

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
        <Button
          accessibilityLabel={`Open members for ${community.name}`}
          accessibilityRole="button"
          onPress={onManageAgents}
          testID="members-action"
          label={MEMBERS_LABEL}
          variant="quiet"
        />
      ) : allowPeopleInvites ? (
        <Button
          accessibilityLabel={`Invite people to ${community.name}`}
          accessibilityRole="button"
          disabled={creatingInvite}
          onPress={onInvitePeople}
          testID="invite-people-action"
          label={creatingInvite ? 'Opening share…' : 'Invite people'}
          variant="quiet"
          icon={
            <>
          <Text style={styles.actionIcon}>＋</Text>
          </>
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  communityEntry: {
    minHeight: 46,
    marginTop: groknight.space.sm,
    paddingHorizontal: 16,
    paddingVertical: groknight.space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: groknight.space.md,
    backgroundColor: groknight.bgTerminal,
  },
  action: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: groknight.space.xs,
  },
  actionIcon: { ...theme.buzz.type.body, color: groknight.steel },
  actionText: {
    ...theme.buzz.type.bodyStrong,
    color: groknight.textSecondary,
  },
  disabled: { backgroundColor: groknight.bgBase },
  });
});
