import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChannelMember, ChannelRole } from '@beeline/buzz-client';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { shortMemberNpub } from '@/buzz/member-display';
import { canRemoveRoomParticipant, normalizedRoomRole } from '@/buzz/room-management';
import type { AgentPresentation } from '@/buzz/room-view-presentation';
import { MEMBERS_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { HullFloatingSurface, HullModal } from './HullDialog';
import { IdentityMark } from './IdentityMark';

export type RoomRosterParticipant = {
  pubkey: string;
  name: string;
  handle: string;
  kind: 'person' | 'agent';
  agent?: AgentPresentation;
  /** People only: the chosen face on record. An agent's assigned face rides
   *  on `agent` and is read through `resolveAgentDisplayIdentity`. */
  face?: string;
};

type RoomRosterSections = {
  people: readonly RoomRosterParticipant[];
  agents: readonly RoomRosterParticipant[];
};

/**
 * The Room's members, in the Members page's vocabulary so the two views read
 * as one: "Members" over two counted section heads, a 64pt row per identity
 * with its name at body size and one quiet `@handle · role` line that ends
 * in the agent's presence word. The gold ring on the tile means WORKING
 * (`workingByPubkey`, C77), never a presence lease, and there is no status
 * square beside the name (C76). A row whose viewer may remove it carries a
 * chevron and opens its one control in place; the list itself shows no
 * remove text.
 *
 * The shared HullModal boundary owns the no-flicker guarantee. This additional
 * memo remains a roster-specific CPU fast path: identity-stable sections and
 * collapsed online verdicts avoid rebuilding a potentially long member tree.
 */
export const RoomRosterSheet = React.memo(function RoomRosterSheet({
  bottomInset,
  canManage,
  isDirectMessage,
  memberByPubkey,
  membershipActionPubkey,
  membershipError,
  onAddAgents,
  onAddPeople,
  onClose,
  onRemove,
  onlineByPubkey,
  workingByPubkey,
  parentChannelId,
  personProfileByPubkey,
  rosterSections,
  total,
  userPubkey,
  viewerRole,
  visible,
}: {
  bottomInset: number;
  /** Whether the viewer may add people/agents to this Room (manager only). */
  canManage: boolean;
  isDirectMessage: boolean;
  memberByPubkey: ReadonlyMap<string, ChannelMember>;
  membershipActionPubkey: string | null;
  membershipError: string | null;
  /** Opens the member picker pre-scoped to agents. */
  onAddAgents: () => void;
  /** Opens the member picker pre-scoped to people. */
  onAddPeople: () => void;
  onClose: () => void;
  onRemove: (participant: RoomRosterParticipant) => void;
  /** Presence lease verdicts: the row's online/offline word only. */
  onlineByPubkey: Readonly<Record<string, boolean>>;
  /** Agents working right now (`selectWorkingAgents`): the gold ring only. */
  workingByPubkey: Readonly<Record<string, boolean>>;
  parentChannelId: string | null;
  personProfileByPubkey: ReadonlyMap<string, { avatar?: string }>;
  rosterSections: RoomRosterSections;
  total: number;
  userPubkey: string;
  viewerRole: ChannelRole | null;
  visible: boolean;
}) {
  const [openPubkey, setOpenPubkey] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) setOpenPubkey(null);
  }, [visible]);
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
            <Text style={styles.rosterModalEyebrow}>In this {ROOM_LABEL}</Text>
            <Text style={styles.rosterModalTitle}>{MEMBERS_LABEL}</Text>
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
            { key: 'people', label: 'People', options: rosterSections.people },
            { key: 'agents', label: 'Agents', options: rosterSections.agents },
          ].map((section, sectionIndex) =>
            // A manager keeps the section head of a top-level Room even when
            // the section is empty, because the head is where the add control
            // lives: with the Room header's `+` retired (C83), an agentless
            // Room would otherwise have no way to reach an agent at all.
            section.options.length > 0 ||
            (canManage && !parentChannelId && !isDirectMessage) ? (
              <View key={section.key}>
                <View
                  style={[
                    styles.rosterSectionHeadRow,
                    sectionIndex > 0 && styles.rosterSectionLabelSpaced,
                  ]}
                >
                  <Text
                    style={styles.rosterSectionLabel}
                    testID={`room-roster-${section.key}-head`}
                  >
                    {section.label} {section.options.length}
                  </Text>
                  {canManage && (
                    <TouchableOpacity
                      accessibilityLabel={`Add ${section.key}`}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                      onPress={section.key === 'people' ? onAddPeople : onAddAgents}
                      style={styles.rosterSectionAdd}
                      testID={`room-roster-add-${section.key}`}
                    >
                      <Text style={styles.rosterSectionAddGlyph}>+</Text>
                    </TouchableOpacity>
                  )}
                </View>
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
                  const open = openPubkey === participant.pubkey;
                  const removing = membershipActionPubkey === participant.pubkey;
                  const agentOnline =
                    participant.kind === 'agent' && Boolean(onlineByPubkey[participant.pubkey]);
                  // The ring means working, never merely present (C77).
                  const agentWorking =
                    participant.kind === 'agent' && Boolean(workingByPubkey[participant.pubkey]);
                  return (
                    <View key={participant.pubkey}>
                      <TouchableOpacity
                        accessibilityLabel={`${displayName}, ${participant.kind}${
                          participant.kind === 'agent'
                            ? agentOnline
                              ? ', online'
                              : ', offline'
                            : ''
                        }, at ${handle}`}
                        disabled={!canRemove}
                        onPress={() => setOpenPubkey(open ? null : participant.pubkey)}
                        style={styles.rosterRow}
                        testID={`room-roster-${participant.kind}-${participant.pubkey}`}
                      >
                        {display ? (
                          <IdentityMark
                            kind="agent"
                            seed={display.avatarSeed ?? participant.pubkey}
                            avatarUrl={display.avatarUrl}
                            face={display.face}
                            name={display.name}
                            size={38}
                            alive={agentWorking}
                          />
                        ) : (
                          <IdentityMark
                            kind="human"
                            seed={participant.pubkey}
                            avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                            face={participant.face}
                            name={displayName}
                            size={38}
                          />
                        )}
                        <View style={styles.rosterIdentity}>
                          <Text numberOfLines={1} style={styles.rosterName}>
                            {displayName}
                          </Text>
                          <Text numberOfLines={1} style={styles.rosterMeta}>
                            @{handle} · {targetRole ?? 'member'}
                            {participant.kind === 'agent'
                              ? agentOnline
                                ? ' · online'
                                : ' · offline'
                              : ''}
                          </Text>
                        </View>
                        {canRemove && (
                          <Text accessibilityElementsHidden style={styles.chevron}>
                            {open ? '⌄' : '›'}
                          </Text>
                        )}
                      </TouchableOpacity>
                      {open && canRemove && (
                        <View
                          style={styles.rosterDetail}
                          testID={`room-roster-${participant.pubkey}-detail`}
                        >
                          <TouchableOpacity
                            accessibilityLabel={`Remove ${displayName} from this ${ROOM_LABEL}`}
                            accessibilityRole="button"
                            disabled={Boolean(membershipActionPubkey)}
                            onPress={() => onRemove(participant)}
                            style={styles.rosterRemoveButton}
                            testID={`remove-room-member-${participant.pubkey}`}
                          >
                            <Text style={styles.rosterRemoveText}>
                              {removing ? 'Removing…' : `Remove from this ${ROOM_LABEL}`}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      )}
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

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    rosterModal: {
      width: '100%',
      maxWidth: 460,
      maxHeight: '100%',
      padding: hull.space.md,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      backgroundColor: hull.bgRaised,
    },
    rosterModalHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: hull.space.md },
    rosterModalHeadingCopy: { flex: 1, minWidth: 0 },
    rosterModalEyebrow: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.textMuted,
    },
    rosterModalTitle: {
      ...Typography.default(),
      ...hull.type.hero,
      marginTop: hull.space.xs,
      color: hull.textPrimary,
    },
    rosterModalClose: {
      width: 44,
      height: 44,
      marginTop: -10,
      marginRight: -10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rosterModalCloseText: { ...Typography.default(), ...hull.type.hero, color: hull.steel },
    rosterContent: { paddingTop: hull.space.md, paddingBottom: hull.space.xs },
    rosterSectionHeadRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: hull.space.sm,
    },
    rosterSectionLabel: {
      ...Typography.default(),
      ...hull.type.sectionHead,
      color: hull.textMuted,
    },
    rosterSectionAdd: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rosterSectionAddGlyph: { ...Typography.default(), ...hull.type.hero, color: hull.accent },
    rosterSectionLabelSpaced: { marginTop: hull.layout.sectionGap },
    rosterRow: {
      minHeight: hull.layout.row,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
    },
    rosterIdentity: { flex: 1, minWidth: 0 },
    rosterName: { ...Typography.default(), ...hull.type.body, color: hull.textPrimary },
    rosterMeta: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    chevron: { ...Typography.default(), ...hull.type.hero, color: hull.textMuted },
    rosterDetail: {
      paddingHorizontal: hull.space.sm,
      paddingBottom: hull.space.sm,
      alignItems: 'flex-start',
    },
    rosterRemoveButton: { minHeight: 44, justifyContent: 'center' },
    rosterRemoveText: { ...Typography.default(), ...hull.type.body, color: hull.dialogDanger },
    rosterEmpty: {
      ...Typography.default(),
      ...hull.type.meta,
      paddingVertical: hull.space.lg,
      color: hull.textMuted,
      textAlign: 'center',
    },
    membershipError: {
      marginTop: hull.space.sm,
      padding: hull.space.sm,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      backgroundColor: hull.bgHighlight,
    },
    membershipErrorText: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textSecondary,
    },
  };
});
