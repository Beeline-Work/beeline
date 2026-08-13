/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * Grok Mono Hull design: neutral metal surfaces with redundant state encoding.
 */
import React, { useEffect, useState, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import {
  Alert,
  View,
  Text,
  Image,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Platform,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, type Href } from 'expo-router';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import {
  type Agent,
  type ChannelMember,
  type Community,
  type CommunityMember,
  type DirectMessage,
  type MergeTarget,
  type PersonProfile,
  type AttachmentReference,
  personHandle,
} from '@beeline/buzz-client';
import {
  projectChatEvent,
  transcriptMessages,
  upsertChatMessages,
  type ChatDisplayMessage,
} from '@/sync/transport/buzz-event-projection';
import { groknight } from '@/buzz/groknight';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { reconcileOptimisticMessage } from '@/buzz/reconcileOptimisticMessage';
import {
  activeMentionAtCursor,
  filterMentionCandidates,
  formatRoomParticipantTotal,
  mentionedAgentPubkey,
  replaceActiveMention,
  roomParticipantPubkeys,
  sectionRoomParticipants,
  sectionRoomRoster,
} from '@/buzz/room-participants';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { directMessagePeer, shortMemberNpub } from '@/buzz/member-display';
import {
  canRemoveRoomParticipant,
  normalizedRoomRole,
  roomLifecycleAction,
} from '@/buzz/room-management';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import {
  formatAttachmentSize,
  uploadChatAttachment,
  type PickedChatAttachment,
} from '@/buzz/chat-attachment';
import { isNearChatBottom } from '@/buzz/chat-scroll';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { ChangeReviewPanel } from '@/components/buzz/ChangeReviewPanel';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import { WritePermissionOutcome } from '@/components/buzz/WritePermissionOutcome';
import { ActivityTimeline } from '@/components/buzz/ActivityTimeline';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import {
  HullSurface,
  MonoButton,
  NewMessageMaterialize,
  PixelLoader,
} from '@/components/buzz/MonoHull';

type RoomMemberOption = {
  pubkey: string;
  name: string;
  handle: string;
  kind: 'person' | 'agent';
  agent?: Agent;
};

/** Known body pubkeys for provenance display (hardcoded for dev). */
const BODY_PUBKEYS = new Set<string>();

function CornerActivity({ message, active }: { message: ChatDisplayMessage; active: boolean }) {
  const activity = message.activity?.length
    ? message.activity
    : [{ kind: 'output' as const, title: 'Output', text: message.text }];
  return (
    <View style={styles.activityGroup} testID="corner-activity">
      <ActivityTimeline active={active} items={activity} testID="corner-activity-timeline" />
    </View>
  );
}

function AttachmentCard({ attachment }: { attachment: AttachmentReference }) {
  const image = attachment.mimeType.startsWith('image/') && attachment.thumbnailUrl;
  const open = () => {
    void Linking.openURL(attachment.url).catch(() => {
      Alert.alert('Could not open attachment', 'The file link could not be opened on this device.');
    });
  };
  return (
    <Pressable
      accessibilityLabel={`Open attachment ${attachment.name}`}
      accessibilityRole="link"
      onPress={open}
      style={styles.attachmentCard}
      testID={`chat-attachment-${attachment.name}`}
    >
      {image ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          source={{ uri: attachment.thumbnailUrl }}
          style={styles.attachmentThumbnail}
        />
      ) : (
        <View style={styles.attachmentFileGlyph}>
          <Text style={styles.attachmentFileGlyphText}>▧</Text>
        </View>
      )}
      <View style={styles.attachmentCopy}>
        <Text numberOfLines={1} style={styles.attachmentName}>
          {attachment.name}
        </Text>
        <Text numberOfLines={1} style={styles.attachmentMeta}>
          {attachment.mimeType.toUpperCase()} · {formatAttachmentSize(attachment.size)}
        </Text>
      </View>
      <Text style={styles.attachmentOpenGlyph}>↗</Text>
    </Pressable>
  );
}

export default function BuzzChat() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<ChatDisplayMessage>>(null);
  const composerRef = useRef<TextInput>(null);
  const followsLatestMessageRef = useRef(true);
  const hasPositionedInitialMessagesRef = useRef(false);
  const keyboardFollowPendingRef = useRef(false);
  const previousKeyboardHeightRef = useRef(0);
  const keyboardHeight = useKeyboardState((state) => (state.isVisible ? state.height : 0));

  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [messages, setMessages] = useState<ChatDisplayMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [inputSelection, setInputSelection] = useState({ start: 0, end: 0 });
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<PickedChatAttachment | null>(null);
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
  const [roomMembers, setRoomMembers] = useState<ChannelMember[]>([]);
  const [addingMemberPubkey, setAddingMemberPubkey] = useState<string | null>(null);
  const [personProfiles, setPersonProfiles] = useState<PersonProfile[]>([]);
  const [viewerIsAgent, setViewerIsAgent] = useState(false);
  const [participantsHydrated, setParticipantsHydrated] = useState(false);
  const [roomName, setRoomName] = useState(ROOM_LABEL);
  const [rosterVisible, setRosterVisible] = useState(false);
  const [roomActionsVisible, setRoomActionsVisible] = useState(false);
  const [participantPickerVisible, setParticipantPickerVisible] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipActionPubkey, setMembershipActionPubkey] = useState<string | null>(null);
  const [roomLifecycleBusy, setRoomLifecycleBusy] = useState(false);
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
      const shortNpub = shortMemberNpub(person.pubkey);
      const profileName = personProfileByPubkey.get(person.pubkey)?.name;
      options.set(person.pubkey, {
        pubkey: person.pubkey,
        name: person.pubkey === userPubkey ? 'You' : (profileName ?? shortNpub),
        handle: profileName
          ? personHandle(profileName, person.pubkey)
          : shortNpub.replace(/[^a-zA-Z0-9_-]/g, ''),
        kind: 'person',
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
    return [...options.values()].sort((a, b) => {
      if (a.pubkey === userPubkey) return -1;
      if (b.pubkey === userPubkey) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [availableAgents, availablePeople, personProfileByPubkey, userPubkey]);
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
  const visibleRosterSections = useMemo(
    () => sectionRoomParticipants(roomParticipants),
    [roomParticipants],
  );
  const roomParticipantTotal = roomParticipants.length;
  const roomMemberByPubkey = useMemo(
    () => new Map(roomMembers.map((member) => [member.pubkey, member])),
    [roomMembers],
  );
  const viewerRoomRole = normalizedRoomRole(roomMemberByPubkey.get(userPubkey));
  const lifecycleAction = roomLifecycleAction(viewerRoomRole);
  const mentionableAgents = useMemo(
    () =>
      roomParticipants
        .filter((participant) => participant.kind === 'agent')
        .map((participant) => ({ pubkey: participant.pubkey, name: participant.name })),
    [roomParticipants],
  );
  const activeMention = useMemo(
    () =>
      !parentChannelId && inputSelection.start === inputSelection.end
        ? activeMentionAtCursor(inputText, inputSelection.start)
        : null,
    [inputSelection.end, inputSelection.start, inputText, parentChannelId],
  );
  const mentionMenuKey = activeMention
    ? `${inputText}:${activeMention.start}:${activeMention.end}`
    : null;
  const mentionSuggestions = useMemo(
    () =>
      activeMention
        ? filterMentionCandidates(roomParticipants, activeMention.query)
        : { matches: [], overflow: 0 },
    [activeMention, roomParticipants],
  );
  const mentionMenuVisible = Boolean(
    composerFocused &&
    mentionMenuKey &&
    mentionMenuKey !== dismissedMentionKey &&
    mentionSuggestions.matches.length > 0,
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
  const activeAgentTurn = useMemo(
    () => [...messages].reverse().find((message) => message.agentTurn?.status === 'working'),
    [messages],
  );
  const activeActivityId = useMemo(() => {
    if (!activeAgentTurn) return undefined;
    const latest = visibleMessages.at(-1);
    return isCorner && !isArchived && latest?.isAgentActivity ? latest.id : undefined;
  }, [activeAgentTurn, isArchived, isCorner, visibleMessages]);

  const scrollToLatestMessage = useCallback((animated: boolean) => {
    requestAnimationFrame(() => flatListRef.current?.scrollToEnd({ animated }));
  }, []);

  const handleMessageListScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (keyboardFollowPendingRef.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    followsLatestMessageRef.current = isNearChatBottom({
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
      offsetY: contentOffset.y,
    });
  }, []);

  const handleMessageListContentSizeChange = useCallback(() => {
    if (!hasPositionedInitialMessagesRef.current) {
      hasPositionedInitialMessagesRef.current = true;
      followsLatestMessageRef.current = true;
      scrollToLatestMessage(false);
      return;
    }
    if (followsLatestMessageRef.current || keyboardFollowPendingRef.current) {
      scrollToLatestMessage(true);
    }
  }, [scrollToLatestMessage]);

  useLayoutEffect(() => {
    const keyboardIsOpening = keyboardHeight > 0 && previousKeyboardHeightRef.current <= 0;
    previousKeyboardHeightRef.current = keyboardHeight;
    if (!keyboardIsOpening) return;

    keyboardFollowPendingRef.current = followsLatestMessageRef.current;
    if (!keyboardFollowPendingRef.current) return;

    scrollToLatestMessage(false);
    const settleTimer = setTimeout(() => {
      scrollToLatestMessage(false);
      requestAnimationFrame(() => {
        keyboardFollowPendingRef.current = false;
      });
    }, 350);

    return () => clearTimeout(settleTimer);
  }, [keyboardHeight, scrollToLatestMessage]);

  useEffect(() => {
    setHighlightedMentionIndex(0);
  }, [mentionMenuKey]);

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
    hasPositionedInitialMessagesRef.current = false;
    followsLatestMessageRef.current = true;
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
        // Self-listing repairs any missing direct Room projections left by an
        // interrupted or historical Workspace invite. Await it before backfill
        // so a notification deep-link cannot race into an empty transcript.
        const availableCommunities = await client.listCommunities();
        const [
          directCommunityId,
          channelMetadata,
          roomMembers,
          parentId,
          events,
          identityIsAgent,
          dm,
        ] = await Promise.all([
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
          setRoomMembers(roomMembers);
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
            const peerProfile = humanProfiles.find((profile) => profile.pubkey === peerPubkey);
            setRoomName(
              peerAgent
                ? resolveAgentDisplayIdentity(peerPubkey, peerAgent).name
                : (peerProfile?.name ?? shortMemberNpub(peerPubkey)),
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
    if ((!text && !pendingAttachment) || !transport || isArchived) return;

    setSending(true);
    followsLatestMessageRef.current = true;

    try {
      const attachments = pendingAttachment
        ? [await uploadChatAttachment(await transport.ensureClient(), pendingAttachment)]
        : [];
      setInputText('');
      setInputSelection({ start: 0, end: 0 });
      setPendingAttachment(null);
      const optimisticId = `optimistic-${Date.now()}`;
      addMessages([
        {
          id: optimisticId,
          text,
          isUser: true,
          timestamp: Date.now(),
          pubkey: userPubkey,
          ...(attachments.length ? { attachments } : {}),
        },
      ]);
      const mentionedAgent = parentChannelId
        ? undefined
        : mentionedAgentPubkey(text, mentionableAgents);
      const eventId = mentionedAgent
        ? await transport.messageSubmitMentioningAgent(decodedId, text, mentionedAgent, attachments)
        : await transport.messageSubmitWithEventId({
            sessionId: decodedId,
            text,
            attachments,
          });
      setMessages((prev) => reconcileOptimisticMessage(prev, optimisticId, eventId));
    } catch (err) {
      console.warn('Send failed:', err);
      Alert.alert('Attachment not sent', err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [
    inputText,
    pendingAttachment,
    transport,
    decodedId,
    addMessages,
    isArchived,
    userPubkey,
    parentChannelId,
    mentionableAgents,
  ]);

  const pickPhoto = useCallback(async () => {
    if (Platform.OS === 'ios') {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Photo access needed', 'Allow photo access to attach an image.');
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setPendingAttachment({
      uri: asset.uri,
      name: asset.fileName?.trim() || `photo-${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      size: asset.fileSize ?? 0,
      width: asset.width,
      height: asset.height,
    });
  }, []);

  const pickDocument = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: '*/*',
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setPendingAttachment({
      uri: asset.uri,
      name: asset.name?.trim() || `file-${Date.now()}`,
      mimeType: asset.mimeType ?? 'application/octet-stream',
      size: asset.size ?? 0,
    });
  }, []);

  const chooseAttachment = useCallback(() => {
    Alert.alert('Attach to message', 'Choose a photo or a document.', [
      { text: 'Photo', onPress: () => void pickPhoto() },
      { text: 'Document', onPress: () => void pickDocument() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pickDocument, pickPhoto]);

  const selectMention = useCallback(
    (participant: RoomMemberOption) => {
      if (!activeMention) return;
      const inserted = replaceActiveMention(inputText, activeMention, participant.handle);
      const nextSelection = { start: inserted.cursor, end: inserted.cursor };
      const completedMention = activeMentionAtCursor(inserted.text, inserted.cursor);
      setInputText(inserted.text);
      setInputSelection(nextSelection);
      setDismissedMentionKey(
        completedMention
          ? `${inserted.text}:${completedMention.start}:${completedMention.end}`
          : null,
      );
      setHighlightedMentionIndex(0);
      requestAnimationFrame(() => composerRef.current?.focus());
      void Haptics.selectionAsync();
    },
    [activeMention, inputText],
  );

  const handleComposerSubmit = useCallback(() => {
    const selected = mentionMenuVisible
      ? mentionSuggestions.matches[highlightedMentionIndex]
      : undefined;
    if (selected) {
      selectMention(selected);
      return;
    }
    void handleSend();
  }, [handleSend, highlightedMentionIndex, mentionMenuVisible, mentionSuggestions, selectMention]);

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
        setRoomMembers((current) => [
          ...current.filter((member) => member.pubkey !== option.pubkey),
          { pubkey: option.pubkey, role: 'member' },
        ]);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (err) {
        setMembershipError(`Could not add @${option.name}: ${String(err)}`);
      } finally {
        setAddingMemberPubkey(null);
      }
    },
    [activeCommunityId, addingMemberPubkey, decodedId, roomMemberPubkeys, transport],
  );

  const handleRemoveRoomMember = useCallback(
    (participant: RoomMemberOption) => {
      const targetRole = normalizedRoomRole(roomMemberByPubkey.get(participant.pubkey));
      if (
        !transport ||
        !canRemoveRoomParticipant(viewerRoomRole, targetRole, participant.pubkey === userPubkey)
      )
        return;
      Alert.alert(
        `Remove ${participant.name}?`,
        `Their membership will be removed and this ${ROOM_LABEL} will disappear from their workspace list.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              setMembershipActionPubkey(participant.pubkey);
              setMembershipError(null);
              void transport
                .removeRoomMember(decodedId, participant.pubkey)
                .then(() => {
                  setRoomMemberPubkeys((current) => {
                    const next = new Set(current);
                    next.delete(participant.pubkey);
                    return next;
                  });
                  setRoomMembers((current) =>
                    current.filter((member) => member.pubkey !== participant.pubkey),
                  );
                  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                })
                .catch((err) => {
                  setMembershipError(`Could not remove ${participant.name}: ${String(err)}`);
                })
                .finally(() => setMembershipActionPubkey(null));
            },
          },
        ],
      );
    },
    [decodedId, roomMemberByPubkey, transport, userPubkey, viewerRoomRole],
  );

  const returnToRoomList = useCallback(() => {
    setRosterVisible(false);
    setRoomActionsVisible(false);
    router.replace({
      pathname: '/buzz/channels',
      ...(activeCommunityId ? { params: { communityId: activeCommunityId } } : {}),
    });
  }, [activeCommunityId]);

  const handleRoomLifecycle = useCallback(() => {
    if (!transport || !lifecycleAction || roomLifecycleBusy) return;
    const deleting = lifecycleAction === 'delete';
    Alert.alert(
      deleting ? `Delete ${roomName}?` : `Leave ${roomName}?`,
      deleting
        ? `This ${ROOM_LABEL} will disappear from the workspace list. Its messages and room data remain stored for future recovery.`
        : `You will lose access to this ${ROOM_LABEL}. Other members will keep their access.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: deleting ? `Delete ${ROOM_LABEL}` : `Leave ${ROOM_LABEL}`,
          style: 'destructive',
          onPress: () => {
            setRoomLifecycleBusy(true);
            setMembershipError(null);
            const operation = deleting
              ? transport.archiveRoom(decodedId)
              : transport.leaveRoom(decodedId);
            void operation
              .then(() => {
                void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                returnToRoomList();
              })
              .catch((err) => {
                setMembershipError(
                  `Could not ${deleting ? 'delete' : 'leave'} ${ROOM_LABEL}: ${String(err)}`,
                );
              })
              .finally(() => setRoomLifecycleBusy(false));
          },
        },
      ],
    );
  }, [decodedId, lifecycleAction, returnToRoomList, roomLifecycleBusy, roomName, transport]);

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
        setMembershipError(`Could not message @${option.name}: ${String(err)}`);
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
                  {display.name} needs to change repository files
                </Text>
                <Text style={styles.writePermissionTool} numberOfLines={2}>
                  WRITE REQUEST · {permission.tool}
                </Text>
              </View>
            </View>
            <Text style={styles.writePermissionBoundary}>
              The write is refused in this read-only Room. Allowing opens an isolated corner and
              worktree; merge authority stays human-only.
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
                  label="Open edit corner"
                  loading={busy}
                  onPress={() => void handleWritePermission(item, 'allow')}
                  style={styles.writePermissionButton}
                />
              </View>
            ) : (
              <WritePermissionOutcome
                status={permission.status}
                subchannelId={permission.subchannelId}
                awaitingPerson={viewerIsAgent && pending}
                onOpenCorner={(subchannelId) =>
                  router.push(`/buzz/chat/${encodeURIComponent(subchannelId)}` as Href)
                }
              />
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
        return <CornerActivity active={item.id === activeActivityId} message={item} />;
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
      const personName = item.pubkey ? personProfileByPubkey.get(item.pubkey)?.name : undefined;

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
                {!isOwn && !display && personName && (
                  <Text numberOfLines={1} style={styles.terminalTurnAuthor}>
                    {personName}
                  </Text>
                )}
              </View>
              {item.text ? (
                !isOwn && isAgent ? (
                  <MonoMarkdown markdown={item.text} tone="final" testID="corner-final-markdown" />
                ) : (
                  <Text selectable style={styles.terminalTurnText}>
                    {item.text}
                  </Text>
                )
              ) : null}
              {item.attachments?.map((attachment) => (
                <AttachmentCard attachment={attachment} key={`${item.id}-${attachment.url}`} />
              ))}
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
                    name={personName ?? shortMemberNpub(item.pubkey)}
                    size={22}
                  />
                ) : null}
                <Text style={[styles.roleLabel, isAgent ? styles.roleAgent : styles.roleUser]}>
                  {isOwn
                    ? 'YOU'
                    : display
                      ? display.name
                      : (personName ?? shortMemberNpub(item.pubkey ?? ''))}
                </Text>
              </View>
              {item.text ? <Text style={styles.messageText}>{item.text}</Text> : null}
              {item.attachments?.map((attachment) => (
                <AttachmentCard attachment={attachment} key={`${item.id}-${attachment.url}`} />
              ))}
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
      activeActivityId,
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
          <TouchableOpacity
            accessibilityLabel={`View ${formatRoomParticipantTotal(roomParticipantTotal)} in this ${ROOM_LABEL}`}
            accessibilityRole="button"
            disabled={!participantsHydrated}
            onPress={() => setRosterVisible(true)}
            style={styles.headerCenter}
            testID="room-participant-roster-trigger"
          >
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
                ? `${formatRoomParticipantTotal(roomParticipantTotal)}  ·  IN THIS ROOM  ›`
                : 'LOADING MEMBERS'}
            </Text>
          </TouchableOpacity>
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
          {!parentChannelId &&
            !isDirectMessage &&
            !viewerIsAgent &&
            !isArchived &&
            lifecycleAction && (
              <TouchableOpacity
                accessibilityLabel={`${ROOM_LABEL} actions`}
                accessibilityRole="button"
                onPress={() => {
                  setMembershipError(null);
                  setRoomActionsVisible(true);
                }}
                style={styles.roomActionsButton}
                testID="room-actions-menu"
              >
                <Text style={styles.roomActionsGlyph}>•••</Text>
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
          contentContainerStyle={[
            styles.messageListContent,
            { paddingBottom: 12 + keyboardHeight },
          ]}
          renderItem={renderItem}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={[styles.emptyText, isCorner && styles.cornerEmptyText]}>
                No messages yet
              </Text>
            </View>
          }
          onContentSizeChange={handleMessageListContentSizeChange}
          onScroll={handleMessageListScroll}
          scrollEventThrottle={16}
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
            {!parentChannelId && (activeCorner?.corner || activeAgentTurn?.agentTurn) && (
              <View style={styles.agentLiveStatus} testID="agent-live-status">
                <PixelLoader compact />
                <Text style={styles.agentLiveStatusText}>
                  {activeAgentTurn?.agentTurn
                    ? 'thinking…'
                    : activeCorner?.corner?.status === 'starting'
                      ? 'thinking…'
                      : 'working…'}
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
            {mentionMenuVisible && (
              <View
                accessibilityLabel="Mention a Room participant"
                style={styles.mentionMenu}
                testID="mention-suggestions"
              >
                <Text style={styles.mentionMenuLabel}>MENTION</Text>
                {mentionSuggestions.matches.map((participant, index) => {
                  const selected = index === highlightedMentionIndex;
                  const display = participant.agent
                    ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
                    : undefined;
                  return (
                    <TouchableOpacity
                      accessibilityLabel={`${participant.name}, @${participant.handle}, ${participant.kind}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={participant.pubkey}
                      onPress={() => selectMention(participant)}
                      style={[styles.mentionRow, selected && styles.mentionRowSelected]}
                      testID={`mention-suggestion-${participant.handle}`}
                    >
                      {display ? (
                        <AgentAvatar
                          pubkey={participant.pubkey}
                          avatarSeed={display.avatarSeed}
                          avatarUrl={display.avatarUrl}
                          name={display.name}
                          size={28}
                        />
                      ) : (
                        <PersonAvatar
                          pubkey={participant.pubkey}
                          avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                          name={participant.name}
                          size={28}
                        />
                      )}
                      <View style={styles.mentionIdentity}>
                        <Text numberOfLines={1} style={styles.mentionName}>
                          {participant.name}
                        </Text>
                        <Text numberOfLines={1} style={styles.mentionHandle}>
                          @{participant.handle}
                        </Text>
                      </View>
                      <Text style={styles.mentionKind}>
                        {participant.kind === 'agent' ? 'AGENT' : 'PERSON'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                {mentionSuggestions.overflow > 0 && (
                  <Text style={styles.mentionOverflow} testID="mention-suggestion-overflow">
                    AND {mentionSuggestions.overflow} OTHERS
                  </Text>
                )}
              </View>
            )}
            {pendingAttachment && (
              <View style={styles.pendingAttachment} testID="pending-chat-attachment">
                <View style={styles.pendingAttachmentCopy}>
                  <Text numberOfLines={1} style={styles.pendingAttachmentName}>
                    {pendingAttachment.name}
                  </Text>
                  <Text style={styles.pendingAttachmentMeta}>
                    {sending ? 'UPLOADING' : formatAttachmentSize(pendingAttachment.size)}
                  </Text>
                </View>
                <TouchableOpacity
                  accessibilityLabel={`Remove ${pendingAttachment.name}`}
                  disabled={sending}
                  onPress={() => setPendingAttachment(null)}
                  style={styles.pendingAttachmentRemove}
                >
                  <Text style={styles.pendingAttachmentRemoveText}>×</Text>
                </TouchableOpacity>
              </View>
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
              <TouchableOpacity
                accessibilityLabel="Attach photo or document"
                accessibilityRole="button"
                disabled={sending}
                onPress={chooseAttachment}
                style={styles.attachButton}
                testID="chat-attach-button"
              >
                <Text style={styles.attachButtonText}>＋</Text>
              </TouchableOpacity>
              <TextInput
                ref={composerRef}
                style={[styles.input, isCorner && styles.cornerInput]}
                value={inputText}
                onChangeText={setInputText}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                onKeyPress={(event) => {
                  if (!mentionMenuVisible) return;
                  const key = event.nativeEvent.key;
                  if (key === 'ArrowDown' || key === 'ArrowUp') {
                    event.preventDefault();
                    const direction = key === 'ArrowDown' ? 1 : -1;
                    setHighlightedMentionIndex((current) => {
                      const count = mentionSuggestions.matches.length;
                      return (current + direction + count) % count;
                    });
                  } else if (key === 'Escape' || key === 'Esc') {
                    event.preventDefault();
                    setDismissedMentionKey(mentionMenuKey);
                  }
                }}
                onSelectionChange={(event) => setInputSelection(event.nativeEvent.selection)}
                placeholder={parentChannelId ? 'Steer' : 'Message'}
                placeholderTextColor={groknight.dim}
                multiline={false}
                numberOfLines={1}
                returnKeyType="send"
                selection={inputSelection}
                onSubmitEditing={handleComposerSubmit}
              />
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  ((!inputText.trim() && !pendingAttachment) || sending) &&
                    styles.sendButtonDisabled,
                ]}
                onPress={handleSend}
                disabled={(!inputText.trim() && !pendingAttachment) || sending}
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
        onRequestClose={() => setRosterVisible(false)}
        transparent
        visible={rosterVisible}
      >
        <View style={styles.rosterModalRoot}>
          <Pressable
            accessibilityLabel={`Close ${ROOM_LABEL} roster`}
            onPress={() => setRosterVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.rosterModal} testID="room-roster-sheet">
            <View style={styles.rosterModalHeading}>
              <View style={styles.rosterModalHeadingCopy}>
                <Text style={styles.rosterModalEyebrow}>IN THIS ROOM</Text>
                <Text style={styles.rosterModalTitle}>
                  {formatRoomParticipantTotal(roomParticipantTotal)}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel={`Close ${ROOM_LABEL} roster`}
                onPress={() => setRosterVisible(false)}
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
                { key: 'people', label: 'PEOPLE', options: visibleRosterSections.people },
                { key: 'agents', label: 'AGENTS', options: visibleRosterSections.agents },
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
                      const targetRole = normalizedRoomRole(
                        roomMemberByPubkey.get(participant.pubkey),
                      );
                      const canRemove =
                        !parentChannelId &&
                        !isDirectMessage &&
                        canRemoveRoomParticipant(
                          viewerRoomRole,
                          targetRole,
                          participant.pubkey === userPubkey,
                        );
                      const removing = membershipActionPubkey === participant.pubkey;
                      return (
                        <View
                          accessibilityLabel={`${displayName}, ${participant.kind}, at ${handle}`}
                          key={participant.pubkey}
                          style={styles.rosterRow}
                          testID={`room-roster-${participant.kind}-${participant.pubkey}`}
                        >
                          {display ? (
                            <AgentAvatar
                              pubkey={participant.pubkey}
                              avatarSeed={display.avatarSeed}
                              avatarUrl={display.avatarUrl}
                              name={display.name}
                              size={38}
                            />
                          ) : (
                            <PersonAvatar
                              pubkey={participant.pubkey}
                              avatarUrl={personProfileByPubkey.get(participant.pubkey)?.avatar}
                              name={displayName}
                              size={38}
                            />
                          )}
                          <View style={styles.rosterIdentity}>
                            <Text numberOfLines={1} style={styles.rosterName}>
                              {displayName}
                            </Text>
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
                                onPress={() => handleRemoveRoomMember(participant)}
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
              {roomParticipantTotal === 0 && (
                <Text style={styles.rosterEmpty}>No visible participants</Text>
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

      <Modal
        animationType="fade"
        onRequestClose={() => setRoomActionsVisible(false)}
        transparent
        visible={roomActionsVisible}
      >
        <View style={styles.roomActionsModalRoot}>
          <Pressable
            accessibilityLabel={`Close ${ROOM_LABEL} actions`}
            onPress={() => setRoomActionsVisible(false)}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.roomActionsModal}>
            <View style={styles.roomActionsModalHeading}>
              <View style={styles.roomActionsModalCopy}>
                <Text style={styles.roomActionsModalEyebrow}>{ROOM_LABEL.toUpperCase()}</Text>
                <Text numberOfLines={1} style={styles.roomActionsModalTitle}>
                  {roomName}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityLabel={`Close ${ROOM_LABEL} actions`}
                onPress={() => setRoomActionsVisible(false)}
                style={styles.roomActionsModalClose}
              >
                <Text style={styles.roomActionsModalCloseText}>×</Text>
              </TouchableOpacity>
            </View>
            {lifecycleAction === 'delete' ? (
              <TouchableOpacity
                accessibilityLabel={`Delete ${ROOM_LABEL}`}
                accessibilityRole="button"
                disabled={roomLifecycleBusy}
                onPress={handleRoomLifecycle}
                style={styles.roomLifecycleAction}
                testID="delete-room-action"
              >
                <View style={styles.roomLifecycleCopy}>
                  <Text style={styles.roomLifecycleTitle}>
                    {roomLifecycleBusy ? 'DELETING…' : `DELETE ${ROOM_LABEL.toUpperCase()}`}
                  </Text>
                  <Text style={styles.roomLifecycleHint}>Archive; relay data is retained.</Text>
                </View>
                <Text style={styles.roomLifecycleGlyph}>□</Text>
              </TouchableOpacity>
            ) : lifecycleAction === 'leave' ? (
              <TouchableOpacity
                accessibilityLabel={`Leave ${ROOM_LABEL}`}
                accessibilityRole="button"
                disabled={roomLifecycleBusy}
                onPress={handleRoomLifecycle}
                style={styles.roomLifecycleAction}
                testID="leave-room-action"
              >
                <View style={styles.roomLifecycleCopy}>
                  <Text style={styles.roomLifecycleTitle}>
                    {roomLifecycleBusy ? 'LEAVING…' : `LEAVE ${ROOM_LABEL.toUpperCase()}`}
                  </Text>
                  <Text style={styles.roomLifecycleHint}>Other members keep their access.</Text>
                </View>
                <Text style={styles.roomLifecycleGlyph}>↗</Text>
              </TouchableOpacity>
            ) : null}
            {membershipError && (
              <View accessibilityRole="alert" style={styles.membershipError}>
                <Text style={styles.membershipErrorText}>! {membershipError}</Text>
              </View>
            )}
          </HullSurface>
        </View>
      </Modal>

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
                                name={option.name}
                                size={28}
                              />
                            )}
                            <View style={styles.memberPickerCopy}>
                              <Text numberOfLines={1} style={styles.memberPickerName}>
                                @{option.name}
                              </Text>
                              <Text style={styles.memberPickerNpub}>
                                {option.kind === 'agent' ? 'AGENT' : 'PERSON'}
                              </Text>
                            </View>
                          </View>
                          <View style={styles.memberPickerActions}>
                            {!isSelf && (
                              <TouchableOpacity
                                accessibilityLabel={`Message ${option.name}`}
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
                                accessibilityLabel={`Add ${option.name}`}
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
    minHeight: 44,
    minWidth: 0,
    justifyContent: 'center',
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
  roomActionsButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roomActionsGlyph: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.2,
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
  // ── Read-only Room roster ──────────────────────────────────────
  rosterModalRoot: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 18,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(5, 5, 6, 0.84)',
  },
  rosterModal: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '82%',
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
  rosterActions: {
    flexShrink: 0,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  rosterRemoveButton: {
    minHeight: 44,
    paddingLeft: 12,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  rosterRemoveText: {
    ...Typography.mono('semiBold'),
    color: groknight.chrome,
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
  // ── Room lifecycle menu ─────────────────────────────────────────
  roomActionsModalRoot: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 18,
    alignItems: 'center',
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(5, 5, 6, 0.84)',
  },
  roomActionsModal: {
    width: '100%',
    maxWidth: 460,
    padding: 16,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgRaised,
  },
  roomActionsModalHeading: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  roomActionsModalCopy: { flex: 1, minWidth: 0 },
  roomActionsModalEyebrow: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  roomActionsModalTitle: {
    ...Typography.default('semiBold'),
    marginTop: 4,
    color: groknight.textPrimary,
    fontSize: 19,
    lineHeight: 24,
  },
  roomActionsModalClose: {
    width: 44,
    height: 44,
    marginTop: -10,
    marginRight: -10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roomActionsModalCloseText: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 24,
  },
  roomLifecycleAction: {
    minHeight: 66,
    marginTop: 18,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  roomLifecycleCopy: { flex: 1, minWidth: 0 },
  roomLifecycleTitle: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.6,
  },
  roomLifecycleHint: {
    ...Typography.default(),
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  roomLifecycleGlyph: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 17,
    lineHeight: 22,
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
  attachmentCard: {
    minWidth: 0,
    width: '100%',
    minHeight: 58,
    marginTop: 8,
    padding: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgBase,
  },
  attachmentThumbnail: {
    width: 46,
    height: 46,
    backgroundColor: groknight.bgHighlight,
  },
  attachmentFileGlyph: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgHighlight,
  },
  attachmentFileGlyphText: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 20,
  },
  attachmentCopy: { flex: 1, minWidth: 0 },
  attachmentName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 16,
  },
  attachmentMeta: {
    ...Typography.mono(),
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 11,
  },
  attachmentOpenGlyph: {
    ...Typography.default(),
    width: 22,
    color: groknight.steel,
    fontSize: 14,
    textAlign: 'center',
  },

  // ── Corner terminal transcript ─────────────────────────────────
  activityGroup: {
    width: '100%',
    minWidth: 0,
    marginBottom: 2,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  terminalTurn: {
    width: '100%',
    minWidth: 0,
    marginTop: 7,
    marginBottom: 3,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderTopWidth: 1,
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
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 10,
    letterSpacing: 0.7,
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
  mentionMenu: {
    marginBottom: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: 4,
    backgroundColor: groknight.bgBase,
  },
  mentionMenuLabel: {
    ...Typography.mono('semiBold'),
    paddingHorizontal: 10,
    paddingVertical: 5,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.7,
  },
  mentionRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
  },
  mentionRowSelected: {
    backgroundColor: groknight.selection,
  },
  mentionIdentity: {
    flex: 1,
    minWidth: 0,
  },
  mentionName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 12,
    lineHeight: 15,
  },
  mentionHandle: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 13,
  },
  mentionKind: {
    ...Typography.mono('semiBold'),
    color: groknight.faint,
    fontSize: 8,
    letterSpacing: 0.5,
  },
  mentionOverflow: {
    ...Typography.mono('semiBold'),
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.4,
  },
  pendingAttachment: {
    minWidth: 0,
    minHeight: 44,
    marginBottom: 6,
    paddingLeft: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  pendingAttachmentCopy: { flex: 1, minWidth: 0 },
  pendingAttachmentName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
  },
  pendingAttachmentMeta: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 11,
  },
  pendingAttachmentRemove: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingAttachmentRemoveText: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 20,
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
  attachButton: {
    width: 40,
    height: 40,
    marginLeft: -6,
    marginRight: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachButtonText: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 18,
    lineHeight: 22,
  },
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
