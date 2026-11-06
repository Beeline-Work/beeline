import { useMemo } from 'react';
import { type ChatDisplayMessage, memberAgent } from '@/buzz/room-view-presentation';
import { buildSpeechLexicon } from '@/buzz/speech-lexicon';
import { orderRoomRoster } from '@/buzz/room-participants';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { fallbackMemberHandle, fallbackMemberName } from '@/buzz/member-display';
import { type MemberPickerCandidate } from '@/components/buzz/MemberPickerSheet';
import { normalizedRoomRole } from '@/buzz/room-management';
import { roomComposerTagHandles } from '@/buzz/composer-tags';
import { sameElementRefs, sameMessageRefMap, sameSelectedMembers, shallowEqualRecord, useStable } from '@/buzz/use-stable';
import { type RoomRosterParticipant } from '@/components/buzz/RoomRosterSheet';
import { RoomMemberOption } from './chat-surface-values';

type Props = [
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  conversationIdentities: Map<string, import("@beeline/api-contract/phone").RoomViewIdentity>,
  durableMessages: ChatDisplayMessage[],
  resolvedChannelName: string | null,
  userPubkey: string,
  workspaceRoster: { members: import("@beeline/api-contract/phone").RoomViewMember[]; agents: import("@beeline/api-contract/phone").WorkspaceAgentView[]; workspace: import("@beeline/api-contract/phone").ChatListWorkspace & { readonly about?: string; readonly createdAt: number; }; managerSettings?: { readonly allowFixSweep?: boolean; readonly visibility: "public" | "invite-only"; readonly rooms?: readonly import("@beeline/api-contract/phone").WorkspaceManagedRoomView[]; readonly roomsTruncated?: boolean; }; peopleTotal?: number; agentTotal?: number; membersTruncated: boolean; agentsTruncated: boolean; viewer: import("@beeline/api-contract/phone").RoomViewer; watchFilters: readonly import("@beeline/api-contract/phone").SurfaceWatchFilter[]; } | null,
  participantPickerKind: "agent" | "person" | null,
  heartbeatPresences: Record<string, import("@/buzz/agent-presence").RoomAgentPresence>,
];

export function useChatRoster([
  roomSurface, conversationIdentities, durableMessages, resolvedChannelName, userPubkey,
  workspaceRoster, participantPickerKind, heartbeatPresences,
]: Props): [
  roomParticipants: RoomRosterParticipant[],
  agentPresences: Record<string, import("@/buzz/agent-presence").RoomAgentPresence>,
  describedRoomParticipants: RoomRosterParticipant[],
  participantsHydrated: boolean,
  personProfileByPubkey: Map<string, { face?: string | undefined; avatar?: string | undefined; handle?: string | undefined; pubkey: string; name: string; }>,
  agentByPubkey: Map<string, import("@/buzz/agent-display").DisplayableAgent>,
  roomAgents: RoomRosterParticipant[],
  participantPickerCandidates: MemberPickerCandidate[] | null,
  roomMemberPubkeys: Set<string>,
  agentProfileModelByPubkey: Map<string, string>,
  speakerRoleByPubkey: Map<string, string>,
  composerTagHandles: Set<string>,
  speechHints: string[],
  roomMemberByPubkey: Map<string, { pubkey: string; role: "owner" | "admin" | "member" | "spectator"; }>,
  visibleRosterMembers: RoomRosterParticipant[],
  roomParticipantTotal: number,
  participantPickerWorkspacePeers: number,
] {

  const rawAvailableAgents = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'agent')
        .map((member) =>
          memberAgent(
            {
              ...member,
              identity: conversationIdentities.get(member.identity.pubkey) ?? member.identity,
            },
            roomSurface?.room.workspaceId ?? '',
          ),
        ),
    [conversationIdentities, roomSurface?.members, roomSurface?.room.workspaceId],
  );

  const availableAgents = useStable(rawAvailableAgents, (previous, next) =>
    previous.length === next.length &&
    previous.every((agent, index) => shallowEqualRecord(agent, next[index]!)),
  );

  const rawAvailablePeople = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'human')
        .map((member) => ({
          pubkey: member.identity.pubkey,
          role: member.role,
          identity: conversationIdentities.get(member.identity.pubkey) ?? member.identity,
        })),
    [conversationIdentities, roomSurface?.members],
  );

  const availablePeople = useStable(rawAvailablePeople, sameSelectedMembers);

  const selectedMembersRaw = useMemo(
    () =>
      (roomSurface?.members ?? []).map((member) => {
        const identity = conversationIdentities.get(member.identity.pubkey) ?? member.identity;
        return {
          pubkey: identity.pubkey,
          role: member.role,
          kind: identity.kind,
          identity: {
            kind: identity.kind,
            displayName: identity.name,
            handle: identity.handle,
          },
        };
      }),
    [conversationIdentities, roomSurface?.members],
  );

  // The membership projection rebuilds every wrapper object on each snapshot
  // commit. Downstream memos (memberOptions, roomParticipants) and ultimately
  // renderItem's dependency array only care about the VALUE, so preserve the
  // previous reference until a member/role/identity actually moved.
  const selectedMembers = useStable(selectedMembersRaw, sameSelectedMembers);

  const roomMembers = useMemo(
    () => selectedMembers.map((member) => ({ pubkey: member.pubkey, role: member.role })),
    [selectedMembers],
  );

  const roomMemberPubkeys = useMemo(
    () => new Set<string>(roomMembers.map((member) => member.pubkey)),
    [roomMembers],
  );

  // Only message text shapes the lexicon, so a presence tick that rebuilds the
  // message array does not re-prime the recogniser.
  const speechMessageText = useStable(
    durableMessages
      .filter((message) => !message.isSystemNotice && !message.deleted)
      .map((message) => message.text),
    sameElementRefs,
  );

  const speechHints = useMemo(
    () =>
      buildSpeechLexicon({
        roomName: resolvedChannelName,
        parentRoomName: roomSurface?.parent?.name,
        repositoryName: roomSurface?.repository?.name,
        memberNames: selectedMembers.map((member) => member.identity.displayName),
        memberHandles: selectedMembers.map((member) => member.identity.handle),
        messages: speechMessageText,
      }),
    [
      resolvedChannelName,
      roomSurface?.parent?.name,
      roomSurface?.repository?.name,
      selectedMembers,
      speechMessageText,
    ],
  );

  const rawPersonProfiles = useMemo(
    () =>
      (roomSurface?.members ?? [])
        .filter((member) => member.identity.kind === 'human')
        .map((member) => {
          const identity = conversationIdentities.get(member.identity.pubkey) ?? member.identity;
          return {
            pubkey: identity.pubkey,
            name: identity.name,
            ...(identity.handle ? { handle: identity.handle } : {}),
            ...(identity.avatar ? { avatar: identity.avatar } : {}),
            ...(identity.face ? { face: identity.face } : {}),
          };
        }),
    [conversationIdentities, roomSurface?.members],
  );

  const personProfiles = useStable(rawPersonProfiles, (previous, next) =>
    previous.length === next.length &&
    previous.every((profile, index) => shallowEqualRecord(profile, next[index]!)),
  );

  const participantsHydrated = roomSurface !== null;

  const agentByPubkey = useMemo(
    () => new Map(availableAgents.map((agent) => [agent.pubkey, agent])),
    [availableAgents],
  );

  const personProfileByPubkey = useMemo(
    () => new Map(personProfiles.map((profile) => [profile.pubkey, profile])),
    [personProfiles],
  );

  const memberOptions = useMemo<RoomMemberOption[]>(() => {
    const options = new Map<string, RoomMemberOption>();
    // The viewer, always and first. `availablePeople` is a Workspace roster
    // read; until it lands (or if it comes back partial) the reader was absent
    // from their own Room's participant list, because a roster entry is what
    // the list is built from. A later real entry overwrites this one.
    if (userPubkey) {
      const selfProfile = personProfileByPubkey.get(userPubkey);
      options.set(userPubkey, {
        pubkey: userPubkey,
        // The viewer is named like every other speaker; brass on the name is
        // the one thing that marks them (DESIGN.md).
        name: selfProfile?.name ?? fallbackMemberName(userPubkey),
        handle: selfProfile?.handle ?? fallbackMemberHandle(userPubkey),
        kind: 'person',
      });
    }
    for (const person of availablePeople) {
      const fallbackName = fallbackMemberName(person.pubkey);
      const profile = personProfileByPubkey.get(person.pubkey);
      options.set(person.pubkey, {
        pubkey: person.pubkey,
        name: profile?.name ?? fallbackName,
        handle: person.identity.handle ?? profile?.handle ?? fallbackMemberHandle(person.pubkey),
        kind: 'person',
        ...(person.identity.face ? { face: person.identity.face } : {}),
      });
    }
    for (const agent of availableAgents) {
      const display = resolveAgentDisplayIdentity(agent.pubkey, agent);
      options.set(agent.pubkey, {
        pubkey: agent.pubkey,
        name: display.name,
        handle: display.handle,
        kind: 'agent',
        agent,
      });
    }
    // The snapshot membership selector is the Room roster authority. Workspace
    // People and Agent reads only enrich/classify those keys, and can be partial
    // or stale. Any member absent from both secondary reads remains visible as
    // a person-shaped identity instead of disappearing from the count.
    for (const member of selectedMembers) {
      if (options.has(member.pubkey)) continue;
      const fallbackName = fallbackMemberName(member.pubkey);
      const profile = personProfileByPubkey.get(member.pubkey);
      options.set(member.pubkey, {
        pubkey: member.pubkey,
        name: profile?.name ?? fallbackName,
        handle: member.identity?.handle ?? profile?.handle ?? fallbackMemberHandle(member.pubkey),
        kind: 'person',
      });
    }
    return [...options.values()].sort((a, b) => {
      if (a.pubkey === userPubkey) return -1;
      if (b.pubkey === userPubkey) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [
    availableAgents,
    availablePeople,
    personProfileByPubkey,
    roomMembers,
    selectedMembers,
    userPubkey,
  ]);

  const roomParticipants = useMemo(
    () =>
      selectedMembers.map((member) => {
        const known = memberOptions.find((option) => option.pubkey === member.pubkey);
        if (known) return known;
        const name = member.identity?.displayName ?? member.identity?.handle;
        return {
          pubkey: member.pubkey,
          name: name ?? fallbackMemberName(member.pubkey),
          handle: member.identity?.handle ?? fallbackMemberHandle(member.pubkey),
          kind: member.kind === 'agent' ? 'agent' : 'person',
          ...(member.kind === 'agent' && agentByPubkey.get(member.pubkey)
            ? { agent: agentByPubkey.get(member.pubkey) }
            : {}),
        } satisfies RoomMemberOption;
      }),
    [agentByPubkey, memberOptions, selectedMembers, userPubkey],
  );

  // The picker's candidates are the WORKSPACE roster minus this Room's
  // members. The old picker filtered this Room's own member list, so its
  // "add" section was always empty and the only visible path led to the
  // pairing command (captain report C74). The transcript paints the shared
  // `/workspace/:id` entry, so Members, profile receipts and settings reach
  // every byline at once. A closed picker observes the canonical held answer;
  // only opening the roster sheet or member picker reads its missing/fresh
  // candidates. Room entry alone never reads data for a future picker.
  const participantPickerCandidates = useMemo<MemberPickerCandidate[] | null>(() => {
    if (!workspaceRoster) return null;
    return [...workspaceRoster.members, ...workspaceRoster.agents]
      .filter((member) => !roomMemberPubkeys.has(member.identity.pubkey))
      .map((member) => {
        const identity = member.identity;
        if (identity.kind === 'agent') {
          const display = resolveAgentDisplayIdentity(
            identity.pubkey,
            memberAgent(member, workspaceRoster.workspace.id),
          );
          return {
            pubkey: identity.pubkey,
            name: display.name,
            handle: display.handle,
            kind: 'agent' as const,
            ...('model' in member && typeof member.model === 'string' ? { model: member.model } : {}),
            ...(display.avatarUrl ? { avatarUrl: display.avatarUrl } : {}),
            ...(display.face ? { face: display.face } : {}),
          };
        }
        return {
          pubkey: identity.pubkey,
          name: identity.name,
          handle: identity.handle ?? fallbackMemberHandle(identity.pubkey),
          kind: 'person' as const,
          ...(identity.face ? { face: identity.face } : {}),
          ...(identity.avatar ? { avatarUrl: identity.avatar } : {}),
        };
      });
  }, [roomMemberPubkeys, workspaceRoster]);

  // Everyone of the listed kind in the Workspace besides the viewer, whether
  // or not they are already in this Room. An empty candidate list means two
  // different things — a Room that already holds them all, or a Workspace
  // with nobody else in it — and this count is what tells the sheet which
  // one to say (captain report C83).
  const participantPickerWorkspacePeers = useMemo(() => {
    if (!workspaceRoster) return 0;
    return [...workspaceRoster.members, ...workspaceRoster.agents].filter((member) => {
      if (member.identity.pubkey === userPubkey) return false;
      if (!participantPickerKind) return true;
      const kind = member.identity.kind === 'agent' ? 'agent' : 'person';
      return kind === participantPickerKind;
    }).length;
  }, [participantPickerKind, userPubkey, workspaceRoster]);

  // Agents carry their model and owner, people their Room role, for the
  // roster sheet and @-mention menu.
  /** Each agent's model as its Workspace profile holds it — the one source
   *  every agent byline reads, step rows and replies alike. */
  const agentProfileModelByPubkey = useStable(useMemo(
    () =>
      new Map(
        (workspaceRoster?.agents ?? []).flatMap((agent) =>
          agent.model ? [[agent.identity.pubkey, agent.model] as const] : [],
        ),
      ),
    [workspaceRoster],
  ), sameMessageRefMap);

  const describedRoomParticipants = useMemo(() => {
    const workspaceAgents = new Map(
      (workspaceRoster?.agents ?? []).map((agent) => [agent.identity.pubkey, agent]),
    );
    const roomRoles = new Map(roomMembers.map((member) => [member.pubkey, member]));
    return roomParticipants.map((participant) => {
      if (participant.kind !== 'agent') {
        const role = normalizedRoomRole(roomRoles.get(participant.pubkey));
        return role ? { ...participant, role } : participant;
      }
      const workspaceAgent = workspaceAgents.get(participant.pubkey);
      const ownerHandle = workspaceAgent?.owner?.handle;
      return {
        ...participant,
        ...(workspaceAgent?.model ? { model: workspaceAgent.model } : {}),
        ...(ownerHandle ? { ownerHandle } : {}),
      };
    });
  }, [roomMembers, roomParticipants, workspaceRoster]);

  const visibleRosterMembers = useMemo(
    () => orderRoomRoster(describedRoomParticipants),
    [describedRoomParticipants],
  );

  const roomParticipantTotal = roomParticipants.length;

  const roomAgents = useMemo(
    () => roomParticipants.filter((participant) => participant.kind === 'agent'),
    [roomParticipants],
  );

  // Room member handles: one backspace deletes a whole `@member` tag
  // (`buzz/composer-tags.ts`).
  const composerTagHandles = useMemo(
    () => roomComposerTagHandles(roomParticipants),
    [roomParticipants],
  );

  // kind:30078 is the sole delivery-availability truth. Transcript/activity
  // events can describe work, but they never mint or renew availability.
  const agentPresences = heartbeatPresences;

  const roomMemberByPubkey = useMemo(
    () =>
      new Map<string, (typeof roomMembers)[number]>(
        roomMembers.map((member) => [member.pubkey, member]),
      ),
    [roomMembers],
  );

  const speakerRoleByPubkey = useMemo(() => {
    const roles = new Map<string, string>();
    for (const member of roomMembers) {
      const role = normalizedRoomRole(member);
      if (role) roles.set(member.pubkey, role);
    }
    return roles;
  }, [roomMembers]);
  return [
    roomParticipants, agentPresences, describedRoomParticipants, participantsHydrated,
    personProfileByPubkey, agentByPubkey, roomAgents, participantPickerCandidates,
    roomMemberPubkeys, agentProfileModelByPubkey, speakerRoleByPubkey, composerTagHandles,
    speechHints, roomMemberByPubkey, visibleRosterMembers, roomParticipantTotal,
    participantPickerWorkspacePeers,
  ];
}
