import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChannelMember } from '@beeline/buzz-client';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { normalizedRoomRole } from '@/buzz/room-management';
import { roomRosterWindow } from '@/buzz/room-participants';
import type { AgentPresentation } from '@/buzz/room-view-presentation';
import { CORNER_LABEL, MEMBERS_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { Typography } from '@/constants/Typography';
import { HullFloatingSurface, HullModal } from './HullDialog';
import { MemberRosterRow } from './MemberRosterRow';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

export type RoomRosterParticipant = {
  pubkey: string;
  name: string;
  handle: string;
  kind: 'person' | 'agent';
  agent?: AgentPresentation;
  /** Agents only: paint-ready metadata from the Workspace roster. */
  model?: string;
  /** The owner's raw handle; the shared subtitle formatter owns the "by @" copy. */
  ownerHandle?: string;
  /** People only: the chosen face on record. An agent's assigned face rides
   *  on `agent` and is read through `resolveAgentDisplayIdentity`. */
  face?: string;
};

/**
 * Why a row opens on nothing to do. Every row carries a chevron, so every row
 * owes the viewer a reason when it holds no control — a chevron that opened an
 * empty panel would be the silent no-op the house forbids.
 */
function rosterRowNote({
  inCorner,
  isDirectMessage,
  isViewer,
}: {
  inCorner: boolean;
  isDirectMessage: boolean;
  isViewer: boolean;
}): string {
  if (isViewer) return 'This is you.';
  if (isDirectMessage) return 'A direct message keeps both members.';
  if (inCorner) return `A ${CORNER_LABEL} follows its ${ROOM_LABEL}'s members.`;
  // Everything else reaching this line is a viewer who cannot manage members.
  return `Only a manager can remove members from this ${ROOM_LABEL}.`;
}

/**
 * The Room's members, in the Members page's vocabulary so the two views read
 * as one: "Members" over ONE counted section head that includes the viewer, a
 * 64pt row per identity with its handle at body size and one quiet metadata
 * line: a person's Room role, or an agent's model and owner. People lead and
 * agents follow inside that single list. The gold ring on the tile means
 * WORKING (`workingByPubkey`, C77), never delivery availability, and there is
 * no status square beside the name (C76). Every row carries a chevron and
 * opens in place — its remove control when the viewer may remove it, otherwise
 * the one line saying why it cannot — and the list itself shows no remove
 * text. Ten rows show; the rest wait behind one overflow row.
 *
 * The shared HullModal boundary owns the no-flicker guarantee. This additional
 * memo remains a roster-specific CPU fast path: an identity-stable member list
 * and collapsed online verdicts avoid rebuilding a potentially long tree.
 */
export const RoomRosterSheet = React.memo(function RoomRosterSheet({
  bottomInset,
  canManage,
  isDirectMessage,
  memberByPubkey,
  members,
  membershipActionPubkey,
  membershipError,
  onAddMembers,
  onClose,
  onRemove,
  onlineByPubkey,
  workingByPubkey,
  parentChannelId,
  personProfileByPubkey,
  userPubkey,
  visible,
}: {
  bottomInset: number;
  /** Whether the viewer may add people/agents to this Room (manager only). */
  canManage: boolean;
  isDirectMessage: boolean;
  memberByPubkey: ReadonlyMap<string, ChannelMember>;
  /** Every member of this Room, viewer included: people first, agents after. */
  members: readonly RoomRosterParticipant[];
  membershipActionPubkey: string | null;
  membershipError: string | null;
  /** Opens the one member picker, listing both kinds. */
  onAddMembers: () => void;
  onClose: () => void;
  onRemove: (participant: RoomRosterParticipant) => void;
  /** Delivery-availability verdicts: the row's online/offline word only. */
  onlineByPubkey: Readonly<Record<string, boolean>>;
  /** Agents working right now (`selectWorkingAgents`): the gold ring only. */
  workingByPubkey: Readonly<Record<string, boolean>>;
  parentChannelId: string | null;
  personProfileByPubkey: ReadonlyMap<string, { avatar?: string }>;
  userPubkey: string;
  visible: boolean;
}) {
  const [openPubkey, setOpenPubkey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!visible) {
      setOpenPubkey(null);
      setExpanded(false);
    }
  }, [visible]);
  const canAddMembers = canManage && !parentChannelId && !isDirectMessage;
  const roster = roomRosterWindow(members, expanded);
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
          {/* One head over one list. A manager keeps it on an empty Room
              because the head is where the add control lives: with the Room
              header's `+` retired (C83), an agentless Room would otherwise
              have no way to reach an agent at all. */}
          <View style={styles.rosterSectionHeadRow}>
            <Text style={styles.rosterSectionLabel} testID="room-roster-members-head">
              {MEMBERS_LABEL} {members.length}
            </Text>
            {canAddMembers && (
              <TouchableOpacity
                accessibilityLabel="Add members"
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                onPress={onAddMembers}
                style={styles.rosterSectionAdd}
                testID="room-roster-add-members"
              >
                <Text style={styles.rosterSectionAddGlyph}>+</Text>
              </TouchableOpacity>
            )}
          </View>
          {roster.visible.map((participant) => {
            const display = participant.agent
              ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
              : undefined;
            const isViewer = participant.pubkey === userPubkey;
            const displayName = display ? display.name : isViewer ? 'You' : participant.name;
            const handle = display?.handle ?? participant.handle;
            const targetRole = normalizedRoomRole(memberByPubkey.get(participant.pubkey));
            const canRemove = canAddMembers && !isViewer;
            const open = openPubkey === participant.pubkey;
            const removing = membershipActionPubkey === participant.pubkey;
            const agentOnline =
              participant.kind === 'agent' && Boolean(onlineByPubkey[participant.pubkey]);
            // The ring means working, never merely present (C77).
            const agentWorking =
              participant.kind === 'agent' && Boolean(workingByPubkey[participant.pubkey]);
            // Every row discloses, so every row wears the mark.
            const trailing = (
              <ChevronGlyph
                color={styles.chevron.color}
                direction={open ? 'down' : 'right'}
                size={CHEVRON_ROW_SIZE}
              />
            );
            return (
              <View key={participant.pubkey}>
                {participant.kind === 'agent' ? (
                  <MemberRosterRow
                    alive={agentWorking}
                    avatarUrl={display?.avatarUrl}
                    divider="top"
                    face={display?.face}
                    handle={handle}
                    kind="agent"
                    model={participant.model}
                    name={display?.name ?? participant.name}
                    online={agentOnline}
                    onPress={() => setOpenPubkey(open ? null : participant.pubkey)}
                    ownerHandle={participant.ownerHandle}
                    pubkey={participant.pubkey}
                    seed={display?.avatarSeed}
                    testID={`room-roster-agent-${participant.pubkey}`}
                    trailing={trailing}
                  />
                ) : (
                  <MemberRosterRow
                    avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                    divider="top"
                    face={participant.face}
                    handle={handle}
                    kind="human"
                    name={displayName}
                    onPress={() => setOpenPubkey(open ? null : participant.pubkey)}
                    pubkey={participant.pubkey}
                    role={targetRole ?? 'member'}
                    testID={`room-roster-person-${participant.pubkey}`}
                    trailing={trailing}
                  />
                )}
                {open && (
                  <View
                    style={styles.rosterDetail}
                    testID={`room-roster-${participant.pubkey}-detail`}
                  >
                    {canRemove ? (
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
                    ) : (
                      <Text style={styles.rosterNote}>
                        {rosterRowNote({
                          inCorner: Boolean(parentChannelId),
                          isDirectMessage,
                          isViewer,
                        })}
                      </Text>
                    )}
                  </View>
                )}
              </View>
            );
          })}
          {roster.overflowLabel && (
            <TouchableOpacity
              accessibilityLabel={`Show the rest: ${roster.overflowLabel}`}
              accessibilityRole="button"
              onPress={() => setExpanded(true)}
              style={styles.rosterMore}
              testID="room-roster-more"
            >
              <Text style={styles.rosterMoreLabel}>{roster.overflowLabel}</Text>
              <ChevronGlyph
                color={styles.chevron.color}
                direction="right"
                size={CHEVRON_ROW_SIZE}
              />
            </TouchableOpacity>
          )}
          {members.length === 0 && <Text style={styles.rosterEmpty}>No visible members</Text>}
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
    chevron: { color: hull.textMuted },
    rosterMore: {
      minHeight: 44,
      paddingHorizontal: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    rosterMoreLabel: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    rosterDetail: {
      paddingHorizontal: hull.space.sm,
      paddingBottom: hull.space.sm,
      alignItems: 'flex-start',
    },
    rosterRemoveButton: { minHeight: 44, justifyContent: 'center' },
    rosterRemoveText: { ...Typography.default(), ...hull.type.body, color: hull.dialogDanger },
    rosterNote: {
      ...Typography.default(),
      ...hull.type.meta,
      minHeight: 44,
      paddingTop: hull.space.sm,
      color: hull.textMuted,
    },
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
