import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Community } from '@buzzy/buzz-client';
import { groknight } from '@/buzz/groknight';
import { ROOM_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

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
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>{WORKSPACE_LABEL} crew</Text>
        <Text style={styles.detail} numberOfLines={1}>
          Agents work across every {ROOM_LABEL} in {community.name}; People steer and approve.
        </Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          accessibilityLabel={`Connect an Agent to ${community.name}`}
          accessibilityRole="button"
          onPress={onManageAgents}
          style={styles.secondaryButton}
          testID="manage-agents-action"
        >
          <Text style={styles.secondaryButtonText}>connect Agent</Text>
        </TouchableOpacity>
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
  copy: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
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
  secondaryButton: {
    minHeight: 38,
    paddingHorizontal: 10,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.accent,
    backgroundColor: groknight.bgTerminal,
  },
  secondaryButtonText: {
    color: groknight.accent,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '800',
  },
  disabled: { opacity: 0.45 },
});
