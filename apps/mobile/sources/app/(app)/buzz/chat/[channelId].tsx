/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * Grok Mono Hull design: neutral metal surfaces with redundant state encoding.
 */
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, type Href } from 'expo-router';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import {
  type Agent,
  type Community,
  type CommunityMember,
  type DirectMessage,
  type MergeTarget,
  type PersonProfile,
} from '@beeline/buzz-client';
import {
  projectChatEvent,
  transcriptMessages,
  upsertChatMessages,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { groknight } from '@/buzz/groknight';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { reconcileOptimisticMessage } from '@/buzz/reconcileOptimisticMessage';
import {
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
  roomParticipantPubkeys,
  sectionRoomRoster,
} from '@/buzz/room-participants';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { directMessagePeer, shortMemberNpub } from '@/buzz/member-display';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { ChangeReviewPanel } from '@/components/buzz/ChangeReviewPanel';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import {
  HullSurface,
  MonoButton,
  NewMessageMaterialize,
  PixelLoader,
} from '@/components/buzz/MonoHull';

type RoomMemberOption = {
  pubkey: string;
  label: string;
  kind: 'person' | 'agent';
  agent?: Agent;
};

/** Known body pubkeys for provenance display (hardcoded for dev). */
const BODY_PUBKEYS = new Set<string>();

function CornerActivityEntry({ item }: { item: AgentActivityItem }) {
  const [expanded, setExpanded] = useState(
    item.kind !== 'tool' || item.status === 'pending' || item.status === 'in_progress',
  );
  const glyph = item.kind === 'thinking' ? '·' : '›';
  const label = item.kind === 'thinking' ? 'THINKING' : item.title.toUpperCase();

  return (
    <View style={styles.activityEntry}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={styles.activityHeading}
      >
        <Text style={styles.activityGlyph}>{glyph}</Text>
        <Text numberOfLines={1} style={styles.activityTitle}>
          {label}
        </Text>
        {item.status && <Text style={styles.activityStatus}>{item.status.toUpperCase()}</Text>}
        <Text style={styles.activityDisclosure}>{expanded ? '⌃' : '⌄'}</Text>
      </Pressable>
      {expanded && item.text && (
        <Text selectable style={styles.activityOutput}>
          {item.text}
        </Text>
      )}
    </View>
  );
}

function CornerActivity({ message }: { message: ChatDisplayMessage }) {
  const activity = message.activity?.length
    ? message.activity
    : [{ kind: 'output' as const, title: 'Output', text: message.text }];
  return (
    <View style={styles.activityGroup} testID="corner-activity">
      {activity.map((item, index) => (
        <CornerActivityEntry key={`${message.id}-${index}`} item={item} />
      ))}
    </View>
  );
}

export default function BuzzChat() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ChatDisplayMessage>>(null);

  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [messages, setMessages] = useState<ChatDisplayMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [isArchived, setIsArchived] = useState(false);
  const [userPubkey, setUserPubkey] = useState<string>('');
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);
  const [approvalState, setApprovalState] = useState<'none' | 'sending' | 'sent' | 'merged'>(
    'none',
  );
  const [parentChannelId, setParentChannelId] = useState<string | undefined>(undefined);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<Agent[]>([]);
  const [availablePeople, setAvailablePeople] = useState<CommunityMember[]>([]);
  const [roomMemberPubkeys, setRoomMemberPubkeys] = useState<Set<string>>(new Set());
  const [addingMemberPubkey, setAddingMemberPubkey] = useState<string | null>(null);
  const [personProfiles, setPersonProfiles] = useState<PersonProfile[]>([]);
  const [viewerIsAgent, setViewerIsAgent] = useState(false);
  const [participantsHydrated, setParticipantsHydrated] = useState(false);
  const [roomName, setRoomName] = useState(ROOM_LABEL);
  const [participantPickerVisible, setParticipantPickerVisible] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [directMessage, setDirectMessage] = useState<DirectMessage | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const [permissionActionId, setPermissionActionId] = useState<string | null>(null);
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
    for (const person of availablePeople) {
      options.set(person.pubkey, {
        pubkey: person.pubkey,
        label: person.pubkey === userPubkey ? 'You' : shortMemberNpub(person.pubkey),
        kind: 'person',
      });
    }
    for (const agent of availableAgents) {
      options.set(agent.pubkey, {
        pubkey: agent.pubkey,
        label: resolveAgentDisplayIdentity(agent.pubkey, agent).name,
        kind: 'agent',
        agent,
      });
    }
    return [...options.values()].sort((a, b) => {
      if (a.pubkey === userPubkey) return -1;
      if (b.pubkey === userPubkey) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [availableAgents, availablePeople, userPubkey]);
  const participantPubkeys = useMemo(
    () =>
      roomParticipantPubkeys(
        roomMemberPubkeys,
        activeCommunityId ? availablePeople : undefined,
        activeCommunityId ? availableAgents : undefined,
      ),
    [activeCommunityId, availableAgents, availablePeople, roomMemberPubkeys],
  );
  const roomParticipants = useMemo(
    () => memberOptions.filter((option) => participantPubkeys.has(option.pubkey)),
    [memberOptions, participantPubkeys],
  );
  const roomRosterSections = useMemo(
    () => sectionRoomRoster(memberOptions, roomMemberPubkeys),
    [memberOptions, roomMemberPubkeys],
  );
  const mentionableAgents = useMemo(
    () =>
      roomParticipants
        .filter((participant) => participant.kind === 'agent')
        .map((participant) => ({ pubkey: participant.pubkey, name: participant.label })),
    [roomParticipants],
  );
  const isCorner = Boolean(parentChannelId);
  const isDirectMessage = Boolean(directMessage);
  const visibleMessages = useMemo(
    () => transcriptMessages(messages, isCorner),
    [isCorner, messages],
  );
  const activeCorner = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.corner?.status === 'starting' || message.corner?.status === 'working',
        ),
    [messages],
  );

  // Helper to add new messages, deduplicating by id.
  const addMessages = useCallback((newMsgs: ChatDisplayMessage[]) => {
    setMessages((prev) =>
      upsertChatMessages(
        prev,
        newMsgs.map((message) => ({ ...message, isNew: true })),
      ),
    );
  }, []);

  useEffect(() => {
    if (!decodedId) return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setLoading(true);
    setParticipantsHydrated(false);

    (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) {
          router.replace('/buzz/onboarding');
          return;
        }

        const url = await getEffectiveRelayUrl();
        const t = new BuzzRigTransport(identity, url);
        setTransport(t);
        setUserPubkey(identity.publicKey);

        const client = await t.ensureClient();
        const [
          availableCommunities,
          directCommunityId,
          channelMetadata,
          roomMembers,
          parentId,
          events,
          identityIsAgent,
          dm,
        ] = await Promise.all([
          client.listCommunities(),
          client.getChannelCommunityId(decodedId),
          client.getChannelMetadata(decodedId),
          client.listMembers(decodedId),
          t.getParentChannelId(decodedId),
          t.sessionEventsBackfill(decodedId, { limit: 50 }),
          client.isAgentIdentity(identity.publicKey),
          client.getDirectMessage(decodedId),
        ]);
        // Corners inherit their Workspace from the parent Room. Their create event
        // predates the redundant community tag, so resolve through the parent when
        // needed before loading cosmetic agent overlays.
        const channelCommunityId =
          directCommunityId ??
          (parentId ? await client.getChannelCommunityId(parentId) : null) ??
          null;
        if (!cancelled) {
          setCommunities(availableCommunities);
          setActiveCommunityId(channelCommunityId);
          const roomPubkeys = new Set(roomMembers.map((member) => member.pubkey));
          setRoomMemberPubkeys(roomPubkeys);
          setViewerIsAgent(identityIsAgent);
          setDirectMessage(dm);
          setRoomName(channelMetadata?.name?.trim() || ROOM_LABEL);
          if (parentId) setParentChannelId(parentId);
          let msgs: ChatDisplayMessage[] = [];
          for (const e of events) {
            const projected = projectChatEvent(e, identity.publicKey);
            if (projected.mergeTarget) setMergeTarget(projected.mergeTarget);
            if (projected.archiveChannel) setIsArchived(true);
            if (projected.message) msgs = upsertChatMessages(msgs, [projected.message]);
          }

          setMessages(msgs);
          setLoading(false);
        }

        void Promise.all([
          saveActiveCommunityId(identity.publicKey, channelCommunityId),
          saveLastViewedChannel(identity.publicKey, channelCommunityId, decodedId),
        ]).catch(() => undefined);

        // Subscribe as soon as the primary transcript is painted. The client
        // performs its WebSocket handshake lazily and does not block this path.
        unsubscribe = t.sessionEventsSubscribe(decodedId, (event) => {
          if (cancelled) return;
          const projected = projectChatEvent(event, identity.publicKey, true);
          if (projected.mergeTarget) setMergeTarget(projected.mergeTarget);
          if (projected.archiveChannel) {
            setIsArchived(true);
            setApprovalState('merged');
          }
          if (projected.message) addMessages([projected.message]);
        });

        const [communityAgents, communityMembers, archived, mergeInfo] = await Promise.all([
          channelCommunityId ? client.listAgents(channelCommunityId) : Promise.resolve([]),
          channelCommunityId ? client.communityMembers(channelCommunityId) : Promise.resolve([]),
          t.isChannelArchived(decodedId),
          parentId ? t.getSubchannelMergeTarget(decodedId) : Promise.resolve(null),
        ]);
        const agentPubkeys = new Set(communityAgents.map((agent) => agent.pubkey));
        const humanMembers = communityMembers.filter((member) => !agentPubkeys.has(member.pubkey));
        const humanProfiles = channelCommunityId
          ? await client.listPersonProfiles(
              channelCommunityId,
              humanMembers.map((member) => member.pubkey),
            )
          : [];
        if (!cancelled) {
          setAvailableAgents(communityAgents);
          setAvailablePeople(humanMembers);
          setPersonProfiles(humanProfiles);
          if (dm) {
            const peerPubkey = directMessagePeer(dm, identity.publicKey);
            const peerAgent = communityAgents.find((agent) => agent.pubkey === peerPubkey);
            setRoomName(
              peerAgent
                ? resolveAgentDisplayIdentity(peerPubkey, peerAgent).name
                : shortMemberNpub(peerPubkey),
            );
          }
          setParticipantsHydrated(true);
          if (archived) setIsArchived(true);
          if (mergeInfo) setMergeTarget(mergeInfo.target);
        }
      } catch (err) {
        console.warn('Failed to init BuzzChat:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [decodedId, addMessages]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !transport || isArchived) return;

    setSending(true);
    setInputText('');
    const optimisticId = `optimistic-${Date.now()}`;
    addMessages([
      {
        id: optimisticId,
        text,
        isUser: true,
        timestamp: Date.now(),
        pubkey: userPubkey,
      },
    ]);

    try {
      const mentionedAgent = parentChannelId
        ? undefined
        : mentionedAgentPubkey(text, mentionableAgents);
      const eventId = mentionedAgent
        ? await transport.messageSubmitMentioningAgent(decodedId, text, mentionedAgent)
        : await transport.messageSubmitWithEventId({ sessionId: decodedId, text });
      setMessages((prev) => reconcileOptimisticMessage(prev, optimisticId, eventId));
    } catch (err) {
      console.warn('Send failed:', err);
    } finally {
      setSending(false);
    }
  }, [
    inputText,
    transport,
    decodedId,
    addMessages,
    isArchived,
    userPubkey,
    parentChannelId,
    mentionableAgents,
  ]);

  const handleWritePermission = useCallback(
    async (message: ChatDisplayMessage, decision: 'allow' | 'deny') => {
      const permission = message.writePermission;
      if (!transport || !permission || permission.status !== 'pending' || viewerIsAgent) return;
      setPermissionActionId(permission.permissionId);
      try {
        await transport.respondToWritePermission(
          decodedId,
          permission.permissionId,
          permission.requestId,
          permission.agentPubkey,
          decision,
        );
        setMessages((current) =>
          current.map((item) =>
            item.id === message.id && item.writePermission
              ? {
                  ...item,
                  writePermission: {
                    ...item.writePermission,
                    status: decision === 'allow' ? 'allowed' : 'denied',
                  },
                }
              : item,
          ),
        );
        void Haptics.notificationAsync(
          decision === 'allow'
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        );
      } catch (err) {
        console.warn('Write permission response failed:', err);
      } finally {
        setPermissionActionId(null);
      }
    },
    [decodedId, transport, viewerIsAgent],
  );

  const handleAddRoomMember = useCallback(
    async (option: RoomMemberOption) => {
      if (
        !transport ||
        !activeCommunityId ||
        roomMemberPubkeys.has(option.pubkey) ||
        addingMemberPubkey
      )
        return;
      setAddingMemberPubkey(option.pubkey);
      setMembershipError(null);
      try {
        if (option.kind === 'agent') {
          await transport.inviteAgentToChannel(decodedId, option.pubkey, activeCommunityId);
        } else {
          await transport.inviteWorkspaceMemberToChannel(
            decodedId,
            option.pubkey,
            activeCommunityId,
          );
        }
        setRoomMemberPubkeys((current) => new Set([...current, option.pubkey]));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        setMembershipError(`Could not add @${option.label}: ${String(err)}`);
      } finally {
        setAddingMemberPubkey(null);
      }
    },
    [activeCommunityId, addingMemberPubkey, decodedId, roomMemberPubkeys, transport],
  );

  const handleStartDirectMessage = useCallback(
    async (option: RoomMemberOption) => {
      if (!transport || !activeCommunityId || option.pubkey === userPubkey) return;
      setAddingMemberPubkey(option.pubkey);
      setMembershipError(null);
      try {
        const { channelId: dmChannelId } = await transport.resolveDirectMessage(
          activeCommunityId,
          option.pubkey,
        );
        setParticipantPickerVisible(false);
        router.push(`/buzz/chat/${encodeURIComponent(dmChannelId)}` as Href);
      } catch (err) {
        setMembershipError(`Could not message @${option.label}: ${String(err)}`);
      } finally {
        setAddingMemberPubkey(null);
      }
    },
    [activeCommunityId, transport, userPubkey],
  );

  const handleCancel = useCallback(async () => {
    if (!transport) return;
    try {
      await transport.runAbort(decodedId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } catch (err) {
      console.warn('Cancel failed:', err);
    }
  }, [decodedId, transport]);

  const handleApprove = useCallback(async () => {
    if (!transport || !mergeTarget) return;
    setApprovalState('sending');
    try {
      const result = await transport.submitMergeApproval(decodedId, mergeTarget);
      if (result.success) {
        setApprovalState('sent');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (err) {
      console.warn('Approval failed:', err);
    }
  }, [transport, mergeTarget, decodedId]);

  const handleCommunitySelect = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ChatDisplayMessage }) => {
      if (item.writePermission) {
        const permission = item.writePermission;
        const permissionAgent = agentByPubkey.get(permission.agentPubkey);
        const display = resolveAgentDisplayIdentity(permission.agentPubkey, permissionAgent);
        const pending = permission.status === 'pending';
        const busy = permissionActionId === permission.permissionId;
        return (
          <HullSurface
            strength="raised"
            style={styles.writePermissionCard}
            testID={`write-permission-${permission.status}`}
          >
            <View style={styles.writePermissionHeading}>
              <AgentAvatar
                pubkey={permission.agentPubkey}
                avatarSeed={display.avatarSeed}
                avatarUrl={display.avatarUrl}
                name={display.name}
                size={30}
              />
              <View style={styles.writePermissionCopy}>
                <Text style={styles.writePermissionTitle}>
                  {display.name} wants to start editing files
                </Text>
                <Text style={styles.writePermissionTool} numberOfLines={2}>
                  FIRST WRITE · {permission.tool}
                </Text>
              </View>
            </View>
            <Text style={styles.writePermissionBoundary}>
              Allowing creates an isolated corner and worktree. It does not grant merge authority.
            </Text>
            {pending && !viewerIsAgent ? (
              <View style={styles.writePermissionActions}>
                <MonoButton
                  label="Deny"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void handleWritePermission(item, 'deny')}
                  style={styles.writePermissionButton}
                />
                <MonoButton
                  label="Allow editing"
                  loading={busy}
                  onPress={() => void handleWritePermission(item, 'allow')}
                  style={styles.writePermissionButton}
                />
              </View>
            ) : (
              <Text style={styles.writePermissionStatus}>
                {viewerIsAgent && pending
                  ? '⊘ A PERSON MUST RESPOND'
                  : permission.status === 'allowed'
                    ? '✓ EDITING ALLOWED · OPENING CORNER'
                    : permission.status === 'expired'
                      ? '□ REQUEST EXPIRED · STILL READ-ONLY'
                      : permission.status === 'failed'
                        ? '□ CORNER COULD NOT OPEN · STILL READ-ONLY'
                        : '□ EDITING DENIED · STILL READ-ONLY'}
              </Text>
            )}
          </HullSurface>
        );
      }

      if (item.corner) {
        const cornerAgent = item.corner.agentPubkey
          ? agentByPubkey.get(item.corner.agentPubkey)
          : undefined;
        const display = item.corner.agentPubkey
          ? resolveAgentDisplayIdentity(item.corner.agentPubkey, cornerAgent)
          : undefined;
        const statusLabel = item.corner.status.replace('-', ' ').toUpperCase();
        return (
          <TouchableOpacity
            accessibilityLabel={`${display?.name ?? 'Agent'} work ${statusLabel.toLowerCase()}. View corner`}
            onPress={() =>
              router.push(`/buzz/chat/${encodeURIComponent(item.corner!.subchannelId)}` as Href)
            }
            style={styles.cornerStatusCard}
            testID={`corner-status-${item.corner.status}`}
          >
            {item.corner.agentPubkey && (
              <AgentAvatar
                pubkey={item.corner.agentPubkey}
                avatarSeed={display?.avatarSeed}
                avatarUrl={display?.avatarUrl}
                name={display?.name ?? 'Agent'}
                size={30}
              />
            )}
            <View style={styles.cornerStatusCopy}>
              <Text style={styles.cornerStatusAgent}>{display?.name ?? 'Agent'}</Text>
              <Text style={styles.cornerStatusLabel}>{statusLabel}</Text>
            </View>
            <View style={styles.openCornerAction}>
              <Text style={styles.openCornerText}>VIEW {CORNER_LABEL.toUpperCase()}</Text>
              <Text style={styles.openCornerGlyph}>›</Text>
            </View>
          </TouchableOpacity>
        );
      }

      if (item.isAgentActivity && parentChannelId) {
        return <CornerActivity message={item} />;
      }

      // ── Merge summary ────────────────────────────────────────────
      if (item.isMergeSummary) {
        const mergeAgent = item.pubkey ? agentByPubkey.get(item.pubkey) : undefined;
        const mergeDisplay = mergeAgent
          ? resolveAgentDisplayIdentity(item.pubkey!, mergeAgent)
          : null;
        return (
          <View style={styles.mergeSummaryBubble}>
            <Text style={styles.mergeSummaryTitle}>✓ {CORNER_LABEL} merged</Text>
            <Text style={styles.mergeSummaryText}>{item.text}</Text>
            {item.pubkey && (
              <Text style={styles.mergeSummaryPubkey}>
                {mergeDisplay?.name ?? shortMemberNpub(item.pubkey)}
              </Text>
            )}
          </View>
        );
      }

      // ── Archived notice ──────────────────────────────────────────
      if (item.isArchivedNotice) {
        return (
          <View style={styles.archivedBubble}>
            <Text style={styles.archivedText}>□ CORNER ARCHIVED · READ-ONLY</Text>
          </View>
        );
      }

      // ── Regular message bubble ───────────────────────────────────
      const isBody = item.pubkey && BODY_PUBKEYS.has(item.pubkey);
      const isOwn = item.isUser;
      const knownAgent = item.pubkey ? agentByPubkey.get(item.pubkey) : undefined;
      const isAgent = item.isAgentActivity || isBody || Boolean(knownAgent);
      const display = isAgent
        ? resolveAgentDisplayIdentity(item.pubkey ?? 'unknown-agent', knownAgent)
        : null;

      if (parentChannelId) {
        return (
          <NewMessageMaterialize enabled={Boolean(item.isNew)}>
            <View style={styles.terminalTurn}>
              <View style={styles.terminalTurnHeading}>
                <Text style={styles.terminalTurnGlyph}>{isOwn || isAgent ? '›' : '·'}</Text>
                <Text style={styles.terminalTurnLabel}>
                  {isOwn ? 'USER' : isAgent ? 'FINAL' : 'MESSAGE'}
                </Text>
                {!isOwn && display && (
                  <Text numberOfLines={1} style={styles.terminalTurnAuthor}>
                    {display.name}
                  </Text>
                )}
              </View>
              <Text selectable style={styles.terminalTurnText}>
                {item.text}
              </Text>
            </View>
          </NewMessageMaterialize>
        );
      }

      return (
        <NewMessageMaterialize enabled={Boolean(item.isNew)}>
          <View style={[styles.roomMessageRow, isOwn && styles.roomMessageRowOwn]}>
            <View style={[styles.messageBubble, isOwn ? styles.ownBubble : styles.otherBubble]}>
              <View style={styles.authorRow}>
                {display ? (
                  <AgentAvatar
                    pubkey={item.pubkey ?? 'unknown-agent'}
                    avatarSeed={display.avatarSeed}
                    avatarUrl={display.avatarUrl}
                    name={display.name}
                    size={22}
                  />
                ) : item.pubkey && !isOwn ? (
                  <PersonAvatar
                    pubkey={item.pubkey}
                    avatarUrl={personProfileByPubkey.get(item.pubkey)?.avatar}
                    name={shortMemberNpub(item.pubkey)}
                    size={22}
                  />
                ) : null}
                <Text style={[styles.roleLabel, isAgent ? styles.roleAgent : styles.roleUser]}>
                  {isOwn ? 'YOU' : display ? display.name : shortMemberNpub(item.pubkey ?? '')}
                </Text>
              </View>
              <Text style={styles.messageText}>{item.text}</Text>
              {item.pubkey && !isOwn && !isAgent && (
                <Text style={styles.provenanceText}>{shortMemberNpub(item.pubkey)}</Text>
              )}
            </View>
          </View>
        </NewMessageMaterialize>
      );
    },
    [
      agentByPubkey,
      handleWritePermission,
      parentChannelId,
      permissionActionId,
      personProfileByPubkey,
      viewerIsAgent,
    ],
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loadingText}>LOADING {ROOM_LABEL.toUpperCase()}</Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleCommunitySelect}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      viewerPubkey={userPubkey || undefined}
      viewerAvatarUrl={personProfileByPubkey.get(userPubkey)?.avatar}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'translate-with-padding'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Header */}
        <HullSurface
          strength="quiet"
          style={[styles.header, { minHeight: insets.top + 60, paddingTop: insets.top + 8 }]}
        >
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Text style={[styles.backText, isCorner && styles.cornerBackText]}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text
              style={[styles.channelName, isCorner && styles.cornerChannelName]}
              numberOfLines={1}
            >
              {roomName}
            </Text>
            <Text
              style={[styles.headerMeta, isCorner && styles.cornerHeaderMeta]}
              numberOfLines={1}
            >
              {participantsHydrated
                ? formatRoomParticipantTotal(participantPubkeys.size)
                : 'LOADING MEMBERS'}
            </Text>
          </View>
          {!parentChannelId && !isDirectMessage && !viewerIsAgent && !isArchived && (
            <TouchableOpacity
              accessibilityLabel={`Add people or Agents to this ${ROOM_LABEL}`}
              onPress={() => {
                setMembershipError(null);
                setParticipantPickerVisible(true);
              }}
              style={styles.addMembersButton}
              testID="room-member-picker"
            >
              <Text style={styles.addMembersGlyph}>＋</Text>
            </TouchableOpacity>
          )}
          {isArchived && (
            <View style={styles.archivedBadge}>
              <Text style={styles.archivedBadgeText}>□ ARCHIVED</Text>
            </View>
          )}
        </HullSurface>

        {/* The one human gate: collapsing a corner into the protected line. */}
        {mergeTarget && !isArchived && (
          <HullSurface strength="raised" style={styles.approvalBar}>
            <View style={styles.approvalInfo}>
              <Text style={styles.prChip}>Review</Text>
              <Text style={styles.approvalBarText}>
                {mergeTarget.repo} · {mergeTarget.tip.slice(0, 8)}
              </Text>
            </View>
            {transport && (
              <ChangeReviewPanel
                transport={transport}
                sessionId={decodedId}
                tip={mergeTarget.tip}
              />
            )}
            {viewerIsAgent ? (
              <View style={styles.approvalSent}>
                <Text style={styles.approvalSentText}>NOT ALLOWED</Text>
              </View>
            ) : approvalState === 'none' ? (
              <TouchableOpacity
                accessibilityRole="button"
                onPress={handleApprove}
                style={styles.approveButton}
                testID="approve-corner"
              >
                <Text style={styles.approveButtonText}>Approve</Text>
              </TouchableOpacity>
            ) : approvalState === 'sending' ? (
              <View style={styles.approvalPending}>
                <PixelLoader compact />
                <Text style={styles.approvalStateText}>SENDING</Text>
              </View>
            ) : (
              <View style={styles.approvalSent}>
                <Text style={styles.approvalSentText}>✓ APPROVED</Text>
              </View>
            )}
          </HullSurface>
        )}

        <FlatList
          ref={flatListRef}
          data={visibleMessages}
          keyExtractor={(item: ChatDisplayMessage) => item.id}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          renderItem={renderItem}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={[styles.emptyText, isCorner && styles.cornerEmptyText]}>
                No messages yet
              </Text>
            </View>
          }
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        />

        {/* P2: Archived channels are read-only */}
        {isArchived ? (
          <View style={[styles.archivedInputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            <Text style={[styles.archivedInputText, isCorner && styles.cornerArchivedInputText]}>
              {parentChannelId ? 'Corner' : ROOM_LABEL} archived (read-only)
            </Text>
          </View>
        ) : (
          <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {!parentChannelId && activeCorner?.corner && (
              <View style={styles.agentLiveStatus} testID="agent-live-status">
                <PixelLoader compact />
                <Text style={styles.agentLiveStatusText}>
                  {activeCorner.corner.status === 'starting' ? 'thinking…' : 'working…'}
                </Text>
              </View>
            )}
            {parentChannelId && !viewerIsAgent && (
              <TouchableOpacity
                accessibilityLabel="Cancel active Agent turn"
                style={styles.cancelTurnButton}
                onPress={() => void handleCancel()}
              >
                <Text style={styles.cancelTurnText}>■ CANCEL</Text>
              </TouchableOpacity>
            )}
            <View
              style={[
                styles.composer,
                isCorner && styles.cornerComposer,
                composerFocused && styles.composerFocused,
              ]}
            >
              <Text style={[styles.composerPrefix, isCorner && styles.cornerComposerPrefix]}>
                ›
              </Text>
              <TextInput
                style={[styles.input, isCorner && styles.cornerInput]}
                value={inputText}
                onChangeText={setInputText}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                placeholder={parentChannelId ? 'Steer' : 'Message'}
                placeholderTextColor={groknight.dim}
                multiline={false}
                numberOfLines={1}
                returnKeyType="send"
                onSubmitEditing={() => void handleSend()}
              />
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  (!inputText.trim() || sending) && styles.sendButtonDisabled,
                ]}
                onPress={handleSend}
                disabled={!inputText.trim() || sending}
              >
                <Text
                  style={[
                    styles.sendButtonText,
                    isCorner && styles.cornerSendButtonText,
                    mergeTarget && styles.sendButtonTextQuiet,
                  ]}
                >
                  ⏎
                </Text>
              </TouchableOpacity>
            </View>
            {isCorner && (
              <Text style={styles.cornerFooter} numberOfLines={1}>
                <Text style={styles.cornerFooterRule}>╰─ </Text>
                <Text style={styles.cornerFooterValue}>Agent</Text>
                <Text style={styles.cornerFooterSeparator}> · edit · </Text>
                <Text style={mergeTarget ? styles.cornerFooterState : styles.cornerFooterActive}>
                  active
                </Text>
                <Text style={styles.cornerFooterRule}> ─╯</Text>
              </Text>
            )}
          </View>
        )}
      </KeyboardAvoidingView>

      <Modal
        animationType="fade"
        onRequestClose={() => setParticipantPickerVisible(false)}
        transparent
        visible={participantPickerVisible}
      >
        <View style={styles.memberModalRoot}>
          <Pressable
            accessibilityLabel="Close Room member picker"
            onPress={() => setParticipantPickerVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.memberModal}>
            <View style={styles.memberModalHeading}>
              <View style={styles.memberModalHeadingCopy}>
                <Text style={styles.memberModalTitle}>Add people</Text>
              </View>
              <TouchableOpacity
                accessibilityLabel="Close Room member picker"
                onPress={() => setParticipantPickerVisible(false)}
                style={styles.memberModalClose}
              >
                <Text style={styles.memberModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={styles.memberPickerContent}
              showsVerticalScrollIndicator={false}
            >
              {[
                { key: 'in-room', label: 'IN ROOM', options: roomRosterSections.inRoom },
                {
                  key: 'addable',
                  label: 'ADD',
                  options: roomRosterSections.addable,
                },
              ].map((section, sectionIndex) =>
                section.options.length > 0 ? (
                  <View key={section.key}>
                    <Text
                      style={[
                        styles.memberSectionLabel,
                        sectionIndex > 0 && styles.memberSectionLabelSpaced,
                      ]}
                    >
                      {section.label}
                    </Text>
                    {section.options.map((option) => {
                      const inRoom = section.key === 'in-room';
                      const adding = addingMemberPubkey === option.pubkey;
                      const isSelf = option.pubkey === userPubkey;
                      const display = option.agent
                        ? resolveAgentDisplayIdentity(option.pubkey, option.agent)
                        : undefined;
                      return (
                        <View
                          key={option.pubkey}
                          style={[styles.memberPickerRow, inRoom && styles.memberPickerRowPlaced]}
                          testID={`add-room-member-${option.pubkey}`}
                        >
                          <View style={styles.memberPickerIdentity}>
                            {display ? (
                              <AgentAvatar
                                pubkey={option.pubkey}
                                avatarSeed={display.avatarSeed}
                                avatarUrl={display.avatarUrl}
                                name={display.name}
                                size={28}
                              />
                            ) : (
                              <PersonAvatar
                                pubkey={option.pubkey}
                                avatarUrl={personProfileByPubkey.get(option.pubkey)?.avatar}
                                name={option.label}
                                size={28}
                              />
                            )}
                            <View style={styles.memberPickerCopy}>
                              <Text numberOfLines={1} style={styles.memberPickerName}>
                                @{option.label}
                              </Text>
                              <Text style={styles.memberPickerNpub}>
                                {option.kind === 'agent' ? 'AGENT' : 'PERSON'}
                              </Text>
                            </View>
                          </View>
                          <View style={styles.memberPickerActions}>
                            {!isSelf && (
                              <TouchableOpacity
                                accessibilityLabel={`Message ${option.label}`}
                                disabled={Boolean(addingMemberPubkey)}
                                onPress={() => void handleStartDirectMessage(option)}
                                style={styles.memberPickerActionButton}
                                testID={`message-room-member-${option.pubkey}`}
                              >
                                <Text style={styles.memberPickerAction}>MESSAGE</Text>
                              </TouchableOpacity>
                            )}
                            {!inRoom && (
                              <TouchableOpacity
                                accessibilityLabel={`Add ${option.label}`}
                                disabled={Boolean(addingMemberPubkey)}
                                onPress={() => void handleAddRoomMember(option)}
                                style={styles.memberPickerActionButton}
                              >
                                <Text style={styles.memberPickerAction}>
                                  {adding ? 'ADDING…' : '＋ ADD'}
                                </Text>
                              </TouchableOpacity>
                            )}
                            {isSelf && <Text style={styles.memberPickerAction}>YOU</Text>}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                ) : null,
              )}
              {memberOptions.length === 0 && (
                <Text style={styles.memberPickerEmpty}>Workspace roster is empty</Text>
              )}
            </ScrollView>

            {membershipError && (
              <View accessibilityRole="alert" style={styles.membershipError}>
                <Text style={styles.membershipErrorText}>! {membershipError}</Text>
              </View>
            )}
          </HullSurface>
        </View>
      </Modal>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: groknight.bgTerminal,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    ...Typography.mono('semiBold'),
    marginTop: 12,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
    color: groknight.textMuted,
  },

  // ── Header ──────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  backButton: {
    width: 44,
    height: 44,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    ...Typography.default(),
    fontSize: 22,
    color: groknight.muted,
  },
  cornerBackText: { ...Typography.mono(), color: groknight.textMuted },
  headerCenter: {
    flex: 1,
  },
  channelName: {
    ...Typography.default('semiBold'),
    fontSize: 20,
    lineHeight: 24,
    color: groknight.textPrimary,
  },
  cornerChannelName: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
  },
  headerMeta: {
    ...Typography.default(),
    fontSize: 11,
    lineHeight: 15,
    color: groknight.textMuted,
    marginTop: 2,
  },
  cornerHeaderMeta: { ...Typography.mono(), color: groknight.textMuted },
  addMembersButton: {
    width: 44,
    minHeight: 44,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addMembersGlyph: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 24,
    lineHeight: 28,
  },
  archivedBadge: {
    backgroundColor: groknight.bgHighlight,
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  archivedBadgeText: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  // ── Room membership picker ─────────────────────────────────────
  memberModalRoot: {
    flex: 1,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(5, 5, 6, 0.84)',
  },
  memberModal: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '78%',
    padding: 16,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgRaised,
  },
  memberModalHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  memberModalHeadingCopy: { flex: 1, minWidth: 0 },
  memberModalTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 17,
    lineHeight: 22,
  },
  memberModalClose: {
    width: 44,
    height: 44,
    marginTop: -10,
    marginRight: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberModalCloseText: { ...Typography.default(), color: groknight.steel, fontSize: 24 },
  memberPickerContent: { paddingTop: 18, paddingBottom: 4 },
  memberSectionLabel: {
    ...Typography.mono('semiBold'),
    marginBottom: 7,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.7,
  },
  memberSectionLabelSpaced: { marginTop: 18 },
  memberPickerRow: {
    minHeight: 58,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  memberPickerRowPlaced: { opacity: 0.58 },
  memberPickerIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  memberPickerCopy: { flex: 1, minWidth: 0 },
  memberPickerName: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 12,
  },
  memberPickerNpub: {
    ...Typography.mono(),
    marginTop: 2,
    color: groknight.textMuted,
    fontSize: 9,
  },
  memberPickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  memberPickerActionButton: {
    minHeight: 44,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberPickerAction: {
    ...Typography.mono('semiBold'),
    color: groknight.chrome,
    fontSize: 9,
    letterSpacing: 0.3,
  },
  memberPickerEmpty: {
    ...Typography.default(),
    paddingVertical: 24,
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

  // ── Message blocks ──────────────────────────────────────────────
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  roomMessageRow: {
    width: '100%',
    minWidth: 0,
    alignItems: 'flex-start',
  },
  roomMessageRowOwn: { alignItems: 'flex-end' },
  messageBubble: {
    minWidth: 92,
    maxWidth: '84%',
    paddingVertical: 8,
    paddingHorizontal: 11,
    marginBottom: 8,
    borderRadius: 12,
  },
  otherBubble: {
    backgroundColor: groknight.bgRaised,
    borderWidth: 1,
    borderColor: groknight.borderQuiet,
  },
  ownBubble: {
    backgroundColor: groknight.bgHighlight,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
  },
  authorRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 4,
  },
  roleLabel: {
    ...Typography.default('semiBold'),
    ...Typography.mono('semiBold'),
    fontSize: 11,
    lineHeight: 15,
    flexShrink: 1,
  },
  roleAgent: {
    color: groknight.textPrimary,
  },
  roleUser: {
    color: groknight.textMuted,
  },
  messageText: {
    ...Typography.default(),
    flexShrink: 1,
    fontSize: 14,
    color: groknight.textSecondary,
    lineHeight: 20,
  },
  provenanceText: {
    ...Typography.mono(),
    fontSize: 11,
    lineHeight: 15,
    color: groknight.textMuted,
    marginTop: 4,
  },

  // ── Corner terminal transcript ─────────────────────────────────
  activityGroup: {
    width: '100%',
    minWidth: 0,
    backgroundColor: groknight.bgTerminal,
  },
  activityEntry: {
    minWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  activityHeading: {
    minWidth: 0,
    minHeight: 42,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  activityGlyph: {
    ...Typography.mono(),
    width: 12,
    color: groknight.steel,
    fontSize: 11,
  },
  activityTitle: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
  },
  activityStatus: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.textMuted,
    fontSize: 9,
  },
  activityDisclosure: {
    ...Typography.mono(),
    width: 14,
    color: groknight.gutter,
    fontSize: 11,
    textAlign: 'right',
  },
  activityOutput: {
    ...Typography.mono(),
    width: '100%',
    minWidth: 0,
    paddingHorizontal: 12,
    paddingBottom: 11,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  terminalTurn: {
    width: '100%',
    minWidth: 0,
    marginBottom: 6,
    paddingHorizontal: 11,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  terminalTurnHeading: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 7,
  },
  terminalTurnGlyph: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 11,
  },
  terminalTurnLabel: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 10,
  },
  terminalTurnAuthor: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textMuted,
    fontSize: 10,
    textAlign: 'right',
  },
  terminalTurnText: {
    ...Typography.mono(),
    width: '100%',
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },

  // ── Parent Room corner status ──────────────────────────────────
  cornerStatusCard: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgRaised,
  },
  cornerStatusCopy: { flex: 1, minWidth: 0 },
  cornerStatusAgent: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 16,
  },
  cornerStatusLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.6,
  },
  openCornerAction: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  openCornerText: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  openCornerGlyph: { ...Typography.default(), color: groknight.textPrimary, fontSize: 18 },

  // ── Merge summary ───────────────────────────────────────────────
  mergeSummaryBubble: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  mergeSummaryTitle: {
    ...Typography.mono(),
    fontSize: 12,
    color: groknight.chrome,
    marginBottom: 4,
  },
  mergeSummaryText: {
    ...Typography.mono(),
    fontSize: 12,
    color: groknight.textSecondary,
    lineHeight: 16,
  },
  mergeSummaryPubkey: {
    ...Typography.mono(),
    fontSize: 11,
    lineHeight: 15,
    color: groknight.textMuted,
    marginTop: 4,
  },

  // ── Archived notice ─────────────────────────────────────────────
  archivedBubble: {
    backgroundColor: groknight.bgHighlight,
    borderRadius: 4,
    padding: 8,
    marginBottom: 6,
    alignSelf: 'center',
    maxWidth: '90%',
  },
  archivedText: {
    ...Typography.mono('semiBold'),
    fontSize: 11,
    lineHeight: 15,
    color: groknight.textPrimary,
    textAlign: 'center',
  },

  // ── Approval bar ────────────────────────────────────────────────
  approvalBar: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: groknight.bgTerminal,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    gap: 8,
  },
  approvalInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  prChip: {
    ...Typography.mono(),
    fontSize: 12,
    color: groknight.textPrimary,
  },
  approvalBarText: {
    ...Typography.mono(),
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    color: groknight.textMuted,
  },
  approveButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.accent,
    borderRadius: 7,
    backgroundColor: groknight.bgTerminal,
  },
  approveButtonText: {
    ...Typography.mono(),
    color: groknight.accent,
    fontSize: 12,
    lineHeight: 16,
  },
  approvalPending: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  approvalStateText: {
    ...Typography.mono(),
    fontSize: 11,
    color: groknight.textMuted,
  },
  approvalSent: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  approvalSentText: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 12,
  },

  // ── Composer ────────────────────────────────────────────────────
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    ...Typography.default(),
    fontSize: 13,
    color: groknight.muted,
  },
  cornerEmptyText: { ...Typography.mono(), color: groknight.textMuted },
  inputBar: {
    paddingHorizontal: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  agentLiveStatus: {
    minHeight: 30,
    marginBottom: 6,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  agentLiveStatusText: {
    ...Typography.mono('semiBold'),
    color: groknight.accent,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.35,
  },
  cancelTurnButton: {
    minHeight: 36,
    marginBottom: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  cancelTurnText: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  writePermissionCard: {
    minWidth: 0,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    gap: 10,
  },
  writePermissionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  writePermissionCopy: { flex: 1, minWidth: 0 },
  writePermissionTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 18,
  },
  writePermissionTool: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 13,
    letterSpacing: 0.4,
    marginTop: 2,
  },
  writePermissionBoundary: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  writePermissionActions: { flexDirection: 'row', gap: 8 },
  writePermissionButton: { flex: 1, minWidth: 0 },
  writePermissionStatus: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 9,
    lineHeight: 14,
    letterSpacing: 0.5,
  },
  composer: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  composerFocused: { borderWidth: 2, borderColor: groknight.focus, paddingHorizontal: 9 },
  cornerComposer: {
    borderRadius: 8,
    backgroundColor: groknight.bgTerminal,
  },
  composerPrefix: {
    ...Typography.default('semiBold'),
    fontSize: 14,
    color: groknight.steel,
    marginRight: 8,
  },
  cornerComposerPrefix: { ...Typography.mono(), color: groknight.textSecondary },
  input: {
    ...Typography.default(),
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: groknight.textSecondary,
    height: 40,
    paddingVertical: 0,
  },
  cornerInput: { ...Typography.mono(), color: groknight.textPrimary },
  sendButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: groknight.bgBase,
  },
  sendButtonText: {
    ...Typography.default(),
    color: groknight.textPrimary,
    fontSize: 16,
  },
  cornerSendButtonText: { ...Typography.mono(), color: groknight.textMuted },
  sendButtonTextQuiet: { color: groknight.textDisabled },
  cornerFooter: {
    ...Typography.mono(),
    marginTop: 3,
    paddingHorizontal: 8,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 13,
  },
  cornerFooterRule: { ...Typography.mono(), color: groknight.border },
  cornerFooterValue: { ...Typography.mono(), color: groknight.textMuted },
  cornerFooterSeparator: { ...Typography.mono(), color: groknight.faint },
  cornerFooterState: { ...Typography.mono(), color: groknight.tertiary },
  cornerFooterActive: { ...Typography.mono(), color: groknight.accent },
  archivedInputBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgBase,
    alignItems: 'center',
  },
  archivedInputText: {
    ...Typography.default('italic'),
    fontSize: 11,
    color: groknight.muted,
    fontStyle: 'italic',
  },
  cornerArchivedInputText: { ...Typography.mono('italic'), color: groknight.textMuted },
});
