import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChannelMember, ChannelRole } from '@beeline/buzz-client';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { shortMemberNpub } from '@/buzz/member-display';
import { canRemoveRoomParticipant, normalizedRoomRole } from '@/buzz/room-management';
import { formatRoomParticipantTotal } from '@/buzz/room-participants';
import type { AgentPresentation } from '@/buzz/room-view-presentation';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { groknight } from '@/buzz/groknight';
import { HullFloatingSurface, HullModal } from './HullDialog';
import { IdentityMark } from './IdentityMark';

export type RoomRosterParticipant = {
  pubkey: string;
  name: string;
  handle: string;
  kind: 'person' | 'agent';
  agent?: AgentPresentation;
};

type RoomRosterSections = {
  people: readonly RoomRosterParticipant[];
  agents: readonly RoomRosterParticipant[];
};

/**
 * A Room's roster only receives identity-stable sections and collapsed online
 * verdicts. Live relay activity can still refresh the chat screen, but React
 * now skips this open sheet until something a reader can see actually changes.
 */
export const RoomRosterSheet = React.memo(function RoomRosterSheet({
  bottomInset,
  isDirectMessage,
  memberByPubkey,
  membershipActionPubkey,
  membershipError,
  onClose,
  onRemove,
  onlineByPubkey,
  parentChannelId,
  personProfileByPubkey,
  rosterSections,
  total,
  userPubkey,
  viewerRole,
  visible,
}: {
  bottomInset: number;
  isDirectMessage: boolean;
  memberByPubkey: ReadonlyMap<string, ChannelMember>;
  membershipActionPubkey: string | null;
  membershipError: string | null;
  onClose: () => void;
  onRemove: (participant: RoomRosterParticipant) => void;
  onlineByPubkey: Readonly<Record<string, boolean>>;
  parentChannelId: string | null;
  personProfileByPubkey: ReadonlyMap<string, { avatar?: string }>;
  rosterSections: RoomRosterSections;
  total: number;
  userPubkey: string;
  viewerRole: ChannelRole | null;
  visible: boolean;
}) {
  return (
    <HullModal
      accessibilityLabel={`Close ${ROOM_LABEL} roster`}
      contentStyle={{
        maxHeight: '82%',
        paddingHorizontal: 16,
        paddingBottom: Math.max(bottomInset, 18),
      }}
      onRequestClose={onClose}
      placement="bottom"
      visible={visible}
    >
      <HullFloatingSurface style={styles.rosterModal} testID="room-roster-sheet">
        <View style={styles.rosterModalHeading}>
          <View style={styles.rosterModalHeadingCopy}>
            <Text style={styles.rosterModalEyebrow}>IN THIS ROOM</Text>
            <Text style={styles.rosterModalTitle}>{formatRoomParticipantTotal(total)}</Text>
          </View>
          <TouchableOpacity
            accessibilityLabel={`Close ${ROOM_LABEL} roster`}
            onPress={onClose}
            style={styles.rosterModalClose}
          >
            <Text style={styles.rosterModalCloseText}>×</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.rosterContent}
          showsVerticalScrollIndicator={false}
        >
          {[
            { key: 'people', label: 'PEOPLE', options: rosterSections.people },
            { key: 'agents', label: 'AGENTS', options: rosterSections.agents },
          ].map((section, sectionIndex) =>
            section.options.length > 0 ? (
              <View key={section.key}>
                <Text
                  style={[
                    styles.rosterSectionLabel,
                    sectionIndex > 0 && styles.rosterSectionLabelSpaced,
                  ]}
                >
                  {section.label} {section.options.length}
                </Text>
                {section.options.map((participant) => {
                  const display = participant.agent
                    ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
                    : undefined;
                  const displayName = display
                    ? display.name
                    : participant.pubkey === userPubkey
                      ? 'You'
                      : participant.name;
                  const handle = display?.handle ?? shortMemberNpub(participant.pubkey);
                  const targetRole = normalizedRoomRole(memberByPubkey.get(participant.pubkey));
                  const canRemove =
                    !parentChannelId &&
                    !isDirectMessage &&
                    canRemoveRoomParticipant(
                      viewerRole,
                      targetRole,
                      participant.pubkey === userPubkey,
                    );
                  const removing = membershipActionPubkey === participant.pubkey;
                  const agentOnline =
                    participant.kind === 'agent' && Boolean(onlineByPubkey[participant.pubkey]);
                  return (
                    <View
                      accessibilityLabel={`${displayName}, ${participant.kind}${
                        participant.kind === 'agent' ? (agentOnline ? ', online' : ', offline') : ''
                      }, at ${handle}`}
                      key={participant.pubkey}
                      style={styles.rosterRow}
                      testID={`room-roster-${participant.kind}-${participant.pubkey}`}
                    >
                      {display ? (
                        <IdentityMark
                          kind="agent"
                          seed={display.avatarSeed ?? participant.pubkey}
                          avatarUrl={display.avatarUrl}
                          name={display.name}
                          size={38}
                          alive={agentOnline}
                        />
                      ) : (
                        <IdentityMark
                          kind="human"
                          seed={participant.pubkey}
                          avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                          name={displayName}
                          size={38}
                        />
                      )}
                      <View style={styles.rosterIdentity}>
                        <View style={styles.rosterNameRow}>
                          {participant.kind === 'agent' ? (
                            <RosterPresenceLight online={agentOnline} />
                          ) : null}
                          <Text numberOfLines={1} style={styles.rosterName}>
                            {displayName}
                          </Text>
                        </View>
                        <Text numberOfLines={1} style={styles.rosterHandle}>
                          @{handle}
                        </Text>
                      </View>
                      <View style={styles.rosterActions}>
                        <Text style={styles.rosterKind}>
                          {participant.kind === 'agent' ? 'AGENT' : 'PERSON'}
                          {targetRole && targetRole !== 'member'
                            ? ` · ${targetRole.toUpperCase()}`
                            : ''}
                        </Text>
                        {canRemove && (
                          <TouchableOpacity
                            accessibilityLabel={`Remove ${displayName} from this ${ROOM_LABEL}`}
                            accessibilityRole="button"
                            disabled={Boolean(membershipActionPubkey)}
                            onPress={() => onRemove(participant)}
                            style={styles.rosterRemoveButton}
                            testID={`remove-room-member-${participant.pubkey}`}
                          >
                            <Text style={styles.rosterRemoveText}>
                              {removing ? 'REMOVING…' : 'REMOVE'}
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : null,
          )}
          {total === 0 && <Text style={styles.rosterEmpty}>No visible members</Text>}
        </ScrollView>
        {membershipError && (
          <View accessibilityRole="alert" style={styles.membershipError}>
            <Text style={styles.membershipErrorText}>! {membershipError}</Text>
          </View>
        )}
      </HullFloatingSurface>
    </HullModal>
  );
});

const RosterPresenceLight = React.memo(function RosterPresenceLight({
  online,
}: {
  online: boolean;
}) {
  return (
    <View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no"
      style={[
        styles.agentPresenceLight,
        online ? styles.agentPresenceOnline : styles.agentPresenceOffline,
      ]}
    />
  );
});

const styles = StyleSheet.create(() => ({
  agentPresenceLight: {
    width: 9,
    height: 9,
    borderRadius: groknight.radius,
    borderWidth: 1,
    borderColor: groknight.textSecondary,
  },
  agentPresenceOnline: { backgroundColor: groknight.textSecondary },
  agentPresenceOffline: { backgroundColor: 'transparent' },
  rosterModal: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '100%',
    padding: 16,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgRaised,
  },
  rosterModalHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rosterModalHeadingCopy: { flex: 1, minWidth: 0 },
  rosterModalEyebrow: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  rosterModalTitle: {
    ...Typography.default('semiBold'),
    marginTop: 4,
    color: groknight.textPrimary,
    fontSize: 19,
    lineHeight: 24,
  },
  rosterModalClose: {
    width: 44,
    height: 44,
    marginTop: -10,
    marginRight: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rosterModalCloseText: { ...Typography.default(), color: groknight.steel, fontSize: 24 },
  rosterContent: { paddingTop: 18, paddingBottom: 4 },
  rosterSectionLabel: {
    ...Typography.mono('semiBold'),
    marginBottom: 7,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.7,
  },
  rosterSectionLabelSpaced: { marginTop: 20 },
  rosterRow: {
    minHeight: 62,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  rosterIdentity: { flex: 1, minWidth: 0 },
  rosterNameRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  rosterName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 17,
  },
  rosterHandle: {
    ...Typography.mono(),
    marginTop: 2,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  rosterKind: {
    ...Typography.mono('semiBold'),
    color: groknight.steel,
    fontSize: 8,
    lineHeight: 12,
    letterSpacing: 0.7,
  },
  rosterActions: { flexShrink: 0, alignItems: 'flex-end', justifyContent: 'center' },
  rosterRemoveButton: {
    minHeight: 44,
    paddingLeft: 12,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  rosterRemoveText: {
    ...Typography.mono('semiBold'),
    color: groknight.dialogDanger,
    fontSize: 9,
    lineHeight: 13,
    letterSpacing: 0.4,
  },
  rosterEmpty: {
    ...Typography.default(),
    paddingVertical: 28,
    color: groknight.textMuted,
    fontSize: 12,
    textAlign: 'center',
  },
  membershipError: {
    marginTop: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  membershipErrorText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 16,
  },
}));
