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
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_MANIFEST_TAG,
  encodeNpub,
  type Agent,
  type Community,
  type CommunityMember,
  type MergeTarget,
  type PersonProfile,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
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

type DisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  pubkey?: string;
  /** True if this is a merge-summary control message from the body. */
  isMergeSummary?: boolean;
  /** True if this is an archived notification. */
  isArchivedNotice?: boolean;
  /** True if this is an agent-activity frame from the body. */
  isAgentActivity?: boolean;
  /** True only for subscription/optimistic inserts, never initial backfill. */
  isNew?: boolean;
};

type RoomMemberOption = {
  pubkey: string;
  label: string;
  kind: 'person' | 'agent';
  agent?: Agent;
};

/** Known body pubkeys for provenance display (hardcoded for dev). */
const BODY_PUBKEYS = new Set<string>();

/** Short npub display (first 12 chars of npub1...). */
function shortNpub(pubkeyHex: string): string {
  try {
    const npub = encodeNpub(pubkeyHex);
    return `${npub.slice(0, 8)}…`;
  } catch {
    return `${pubkeyHex.slice(0, 8)}…`;
  }
}

/** Extract a usable timestamp from a SessionEvent. */
function eventTimestamp(e: SessionEvent): number {
  if (e.type === 'assistant_delta' && e.seq) return e.seq;
  if (e.type === 'raw') {
    const p = e.payload as Record<string, unknown> | undefined;
    if (p && typeof p.createdAt === 'number') return p.createdAt;
  }
  return Date.now();
}

/** Extract text content from a SessionEvent. */
function eventText(e: SessionEvent): string {
  if (e.type === 'assistant_delta') return e.text;
  if (e.type === 'raw') {
    const p = e.payload as Record<string, unknown> | undefined;
    if (p && typeof p.content === 'string') return p.content;
    return String(e.payload ?? '');
  }
  return String(e.payload ?? '');
}

/** Extract a stable id from a SessionEvent. */
function eventId(e: SessionEvent, fallback: string): string {
  if (e.type === 'raw') {
    const p = e.payload as Record<string, unknown> | undefined;
    if (p && typeof p.id === 'string') return p.id;
  }
  if (e.type === 'assistant_delta') {
    if (e.id) return e.id;
    if (e.seq) return `delta-${e.seq}`;
  }
  return fallback;
}

/** Extract pubkey from a SessionEvent. */
function eventPubkey(e: SessionEvent): string | undefined {
  if (e.type === 'assistant_delta') return e.pubkey;
  if (e.type === 'raw') {
    const p = e.payload as Record<string, unknown> | undefined;
    if (p && typeof p.pubkey === 'string') return p.pubkey;
  }
  return undefined;
}

/** Extract tag values from raw event payload. */
function eventTagValue(e: SessionEvent, tagName: string): string | undefined {
  if (e.type === 'raw') {
    const p = e.payload as Record<string, unknown> | undefined;
    if (p && typeof p === 'object') {
      const ev = p as { tags?: string[][] };
      if (ev.tags) {
        const tag = ev.tags.find((t: string[]) => t[0] === tagName);
        if (tag && tag[1]) return tag[1];
      }
    }
  }
  return undefined;
}

/** Check if event carries specific t tag values. */
function eventHasTag(e: SessionEvent, tagName: string, tagValue?: string): boolean {
  if (e.type === 'raw') {
    const p = e.payload as Record<string, unknown> | undefined;
    if (p && typeof p === 'object') {
      const ev = p as { tags?: string[][] };
      if (ev.tags) {
        const tTags = ev.tags.filter((t: string[]) => t[0] === tagName);
        if (tagValue) return tTags.some((t: string[]) => t[1] === tagValue);
        return tTags.length > 0;
      }
    }
  }
  return false;
}

/**
 * Body parent-link records are not conversation. The text fallback covers old
 * mobile projections that retained content but dropped the raw Nostr tags.
 */
function isCornerControlMessage(e: SessionEvent, text: string): boolean {
  return (
    eventHasTag(e, 't', 'body-control') ||
    Boolean(eventTagValue(e, 'subchannel')) ||
    /^Agent opened(?: #| a work branch for:)/.test(text)
  );
}

export default function BuzzChat() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList<DisplayMessage>>(null);

  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
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
  const [roomName, setRoomName] = useState(ROOM_LABEL);
  const [participantPickerVisible, setParticipantPickerVisible] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
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
        label: person.pubkey === userPubkey ? 'You' : shortNpub(person.pubkey),
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

  // Helper to add new messages, deduplicating by id.
  const addMessages = useCallback((newMsgs: DisplayMessage[]) => {
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const unique = newMsgs
        .filter((m) => !existingIds.has(m.id))
        .map((message) => ({ ...message, isNew: true }));
      return [...prev, ...unique].sort((a, b) => a.timestamp - b.timestamp);
    });
  }, []);

  useEffect(() => {
    if (!decodedId) return;

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

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
        const [availableCommunities, directCommunityId, channelMetadata, roomMembers, parentId] =
          await Promise.all([
            client.listCommunities(),
            client.getChannelCommunityId(decodedId),
            client.getChannelMetadata(decodedId),
            client.listMembers(decodedId),
            t.getParentChannelId(decodedId),
          ]);
        // Corners inherit their Workspace from the parent Room. Their create event
        // predates the redundant community tag, so resolve through the parent when
        // needed before loading cosmetic agent overlays.
        const channelCommunityId =
          directCommunityId ??
          (parentId ? await client.getChannelCommunityId(parentId) : null) ??
          null;
        const [communityAgents, communityMembers, identityIsAgent] = await Promise.all([
          channelCommunityId ? client.listAgents(channelCommunityId) : Promise.resolve([]),
          channelCommunityId ? client.communityMembers(channelCommunityId) : Promise.resolve([]),
          client.isAgentIdentity(identity.publicKey),
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
          setCommunities(availableCommunities);
          setActiveCommunityId(channelCommunityId);
          setAvailableAgents(communityAgents);
          const roomPubkeys = new Set(roomMembers.map((member) => member.pubkey));
          setAvailablePeople(humanMembers);
          setPersonProfiles(humanProfiles);
          setRoomMemberPubkeys(roomPubkeys);
          setViewerIsAgent(identityIsAgent);
          setRoomName(channelMetadata?.name?.trim() || ROOM_LABEL);
          if (parentId) setParentChannelId(parentId);
        }
        await Promise.all([
          saveActiveCommunityId(identity.publicKey, channelCommunityId),
          saveLastViewedChannel(identity.publicKey, channelCommunityId, decodedId),
        ]);

        // Render the primary chat history before slower P2 channel enrichment.
        const events = await t.sessionEventsBackfill(decodedId, { limit: 50 });
        if (!cancelled) {
          const msgs: DisplayMessage[] = [];
          for (const e of events) {
            const pk = eventPubkey(e);
            const text = eventText(e);
            const isAgentActivity = e.type === 'assistant_delta';
            if (isAgentActivity && !text.trim()) continue;
            // Parent-link control records are identified redundantly. Some relay
            // projections preserve the subchannel binding but omit duplicate `t`
            // markers, so the binding itself must never fall through as chat copy.
            const hasBodyControl = isCornerControlMessage(e, text);
            const isChangeReviewMetadata =
              eventHasTag(e, 't', CHANGE_REVIEW_MANIFEST_TAG) ||
              eventHasTag(e, 't', CHANGE_REVIEW_FILE_TAG);
            if (isChangeReviewMetadata) continue;
            const hasMergeSummary = eventHasTag(e, 't', 'merge-summary');
            const hasStatusArchived = eventHasTag(e, 'status', 'archived');

            if (hasMergeSummary) {
              msgs.push({
                id: eventId(e, `merge-${Math.random()}`),
                text,
                isUser: false,
                timestamp: eventTimestamp(e),
                pubkey: pk,
                isMergeSummary: true,
              });
              continue;
            }

            // Control records drive navigation and lifecycle state. They are never
            // conversation copy and must not leak raw IDs, branches, or worktree paths.
            if (hasBodyControl) {
              const controlledSubchannelId = eventTagValue(e, 'subchannel');
              if (hasStatusArchived && !controlledSubchannelId) {
                msgs.push({
                  id: eventId(e, `archive-${Math.random()}`),
                  text,
                  isUser: false,
                  timestamp: eventTimestamp(e),
                  pubkey: pk,
                  isArchivedNotice: true,
                });
                continue;
              }
              continue;
            }

            // Regular message
            msgs.push({
              id: eventId(e, `backfill-${Math.random()}`),
              text,
              isUser: pk === identity.publicKey,
              timestamp: eventTimestamp(e),
              pubkey: pk,
              isAgentActivity: e.type === 'assistant_delta',
            });
          }

          setMessages(msgs);
          setLoading(false);
        }

        // Check if this channel is a subchannel (has parent).
        // The parent linkage lives on the 9007 create event, not on 39000 metadata.
        // Check if channel is archived
        const archived = await t.isChannelArchived(decodedId);
        if (archived) setIsArchived(true);

        // P2: If in a subchannel, try to get merge target from control messages
        if (parentId) {
          const mergeInfo = await t.getSubchannelMergeTarget(decodedId);
          if (mergeInfo) {
            setMergeTarget(mergeInfo.target);
          }
        }

        // Subscribe to live messages
        unsubscribe = t.sessionEventsSubscribe(decodedId, (event) => {
          if (cancelled) return;

          const pk = eventPubkey(event);
          const text = eventText(event);
          const isAgentActivity = event.type === 'assistant_delta';
          if (isAgentActivity && !text.trim()) return;
          const hasBodyControl = isCornerControlMessage(event, text);
          const isChangeReviewMetadata =
            eventHasTag(event, 't', CHANGE_REVIEW_MANIFEST_TAG) ||
            eventHasTag(event, 't', CHANGE_REVIEW_FILE_TAG);
          if (isChangeReviewMetadata) return;
          const hasMergeSummary = eventHasTag(event, 't', 'merge-summary');
          const hasStatusArchived = eventHasTag(event, 'status', 'archived');
          const isMergeReady = eventHasTag(event, 't', 'merge-ready');

          if (isMergeReady) {
            const repo = eventTagValue(event, 'repo');
            const branch = eventTagValue(event, 'branch');
            const tip = eventTagValue(event, 'tip');
            if (repo && branch && tip) setMergeTarget({ repo, branch, tip });
          }

          if (hasMergeSummary) {
            addMessages([
              {
                id: eventId(event, `merge-live-${Math.random()}`),
                text,
                isUser: false,
                timestamp: eventTimestamp(event),
                pubkey: pk,
                isMergeSummary: true,
              },
            ]);
            return;
          }

          if (hasBodyControl) {
            const subId = eventTagValue(event, 'subchannel');
            if (hasStatusArchived) {
              if (!subId) {
                setIsArchived(true);
                setApprovalState('merged');
              }
              addMessages([
                {
                  id: eventId(event, `archive-live-${Math.random()}`),
                  text,
                  isUser: false,
                  timestamp: eventTimestamp(event),
                  pubkey: pk,
                  isArchivedNotice: true,
                },
              ]);
              return;
            }
          }

          addMessages([
            {
              id: eventId(event, `live-${Math.random()}`),
              text,
              isUser: pk === identity.publicKey,
              timestamp: eventTimestamp(event),
              pubkey: pk,
              isAgentActivity: event.type === 'assistant_delta',
            },
          ]);
        });
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
    ({ item }: { item: DisplayMessage }) => {
      // Legacy projections may already have materialized a parent-link record as
      // a plain message before its Nostr tags reach this screen. Keep the room
      // transcript clean at the final person-facing boundary as well.
      if (/^Agent opened(?: #| a work branch for:)/.test(item.text)) return null;

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
                {mergeDisplay?.name ?? shortNpub(item.pubkey)}
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
      return (
        <NewMessageMaterialize enabled={Boolean(item.isNew)}>
          <View style={[styles.messageBubble, isAgent ? styles.agentBlock : styles.userBlock]}>
            <View style={styles.authorRow}>
              {display ? (
                <AgentAvatar
                  pubkey={item.pubkey ?? 'unknown-agent'}
                  avatarSeed={display.avatarSeed}
                  avatarUrl={display.avatarUrl}
                  name={display.name}
                  size={24}
                />
              ) : item.pubkey ? (
                <PersonAvatar
                  pubkey={item.pubkey}
                  avatarUrl={personProfileByPubkey.get(item.pubkey)?.avatar}
                  name={isOwn ? 'You' : shortNpub(item.pubkey)}
                  size={24}
                />
              ) : null}
              <Text style={[styles.roleLabel, isAgent ? styles.roleAgent : styles.roleUser]}>
                {isOwn ? '◇ YOU' : display ? display.name : `◇ ${shortNpub(item.pubkey ?? '')}`}
              </Text>
            </View>
            <Text style={styles.messageText}>{item.text}</Text>
            {item.pubkey && !isOwn && !isAgent && (
              <Text style={styles.provenanceText}>{shortNpub(item.pubkey)}</Text>
            )}
          </View>
        </NewMessageMaterialize>
      );
    },
    [agentByPubkey, personProfileByPubkey],
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
        style={[styles.container, { paddingTop: insets.top }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Header */}
        <HullSurface strength="quiet" style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.channelName} numberOfLines={1}>
              {roomName}
            </Text>
            <Text style={styles.headerMeta} numberOfLines={1}>
              {formatRoomParticipantTotal(participantPubkeys.size)}
            </Text>
          </View>
          {!parentChannelId && !viewerIsAgent && !isArchived && (
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
              <Text style={styles.addMembersText}>MEMBERS</Text>
            </TouchableOpacity>
          )}
          {isArchived && (
            <View style={styles.archivedBadge}>
              <Text style={styles.archivedBadgeText}>□ ARCHIVED</Text>
            </View>
          )}
        </HullSurface>

        {roomParticipants.length > 0 && (
          <View style={styles.participantBar} accessibilityLabel="Room participants">
            <Text style={styles.participantLabel}>IN THIS {ROOM_LABEL.toUpperCase()}</Text>
            <View style={styles.participantList}>
              {roomParticipants.map((participant) => {
                const display = participant.agent
                  ? resolveAgentDisplayIdentity(participant.pubkey, participant.agent)
                  : undefined;
                return (
                  <View key={participant.pubkey} style={styles.participantIdentity}>
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
                        name={participant.label}
                        size={28}
                      />
                    )}
                    <Text style={styles.participantName} numberOfLines={1}>
                      {participant.label}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* The one human gate: collapsing a corner into the protected line. */}
        {mergeTarget && !isArchived && (
          <HullSurface strength="raised" style={styles.approvalBar}>
            <View style={styles.approvalInfo}>
              <Text style={styles.prChip}>Review this {CORNER_LABEL}</Text>
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
            <Text style={styles.humanBoundaryText}>
              The Agent works freely inside this {CORNER_LABEL}. A person approves only the final
              collapse into the protected line.
            </Text>
            {viewerIsAgent ? (
              <View style={styles.approvalSent}>
                <Text style={styles.approvalSentText}>⊘ AGENTS CANNOT APPROVE OR COLLAPSE</Text>
              </View>
            ) : approvalState === 'none' ? (
              <MonoButton label="Approve corner collapse" onPress={handleApprove} />
            ) : approvalState === 'sending' ? (
              <View style={styles.approvalPending}>
                <PixelLoader compact />
                <Text style={styles.approvalStateText}>SENDING APPROVAL</Text>
              </View>
            ) : (
              <View style={styles.approvalSent}>
                <Text style={styles.approvalSentText}>✓ APPROVED · WAITING FOR COLLAPSE</Text>
              </View>
            )}
          </HullSurface>
        )}

        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item: DisplayMessage) => item.id}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          renderItem={renderItem}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No messages yet</Text>
            </View>
          }
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
        />

        {/* P2: Archived channels are read-only */}
        {isArchived ? (
          <View style={[styles.archivedInputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            <Text style={styles.archivedInputText}>
              {parentChannelId ? 'Corner' : ROOM_LABEL} archived (read-only)
            </Text>
          </View>
        ) : (
          <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {parentChannelId && !viewerIsAgent && (
              <TouchableOpacity
                accessibilityLabel="Cancel active Agent turn"
                style={styles.cancelTurnButton}
                onPress={() => void handleCancel()}
              >
                <Text style={styles.cancelTurnText}>■ CANCEL TURN</Text>
              </TouchableOpacity>
            )}
            <View style={[styles.composer, composerFocused && styles.composerFocused]}>
              <Text style={styles.composerPrefix}>›</Text>
              <TextInput
                style={styles.input}
                value={inputText}
                onChangeText={setInputText}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                placeholder={
                  parentChannelId
                    ? 'steer the live Agent…'
                    : mentionableAgents.length > 1 || roomParticipants.length > 2
                      ? 'message the room; @name targets an Agent…'
                      : `continue ${ROOM_LABEL.toLowerCase()} discussion…`
                }
                placeholderTextColor={groknight.dim}
                multiline
              />
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  (!inputText.trim() || sending) && styles.sendButtonDisabled,
                ]}
                onPress={handleSend}
                disabled={!inputText.trim() || sending}
              >
                <Text style={[styles.sendButtonText, mergeTarget && styles.sendButtonTextQuiet]}>
                  ⏎
                </Text>
              </TouchableOpacity>
            </View>
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
                <Text style={styles.memberModalTitle}>Add to this {ROOM_LABEL}</Text>
                <Text style={styles.memberModalSubtitle}>
                  Workspace roster. Current members stay at the top; add others below. Members only.
                </Text>
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
                { key: 'in-room', label: 'IN THIS ROOM', options: roomRosterSections.inRoom },
                {
                  key: 'addable',
                  label: 'ADD FROM WORKSPACE',
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
                      const display = option.agent
                        ? resolveAgentDisplayIdentity(option.pubkey, option.agent)
                        : undefined;
                      return (
                        <TouchableOpacity
                          accessibilityLabel={`${inRoom ? 'Already in Room' : 'Add'} ${option.label}`}
                          disabled={inRoom || Boolean(addingMemberPubkey)}
                          key={option.pubkey}
                          onPress={() => void handleAddRoomMember(option)}
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
                                {option.kind === 'agent' ? 'LINKED AGENT' : 'WORKSPACE PERSON'}
                              </Text>
                            </View>
                          </View>
                          <Text style={styles.memberPickerAction}>
                            {adding ? 'ADDING…' : inRoom ? 'IN ROOM' : '＋ ADD'}
                          </Text>
                        </TouchableOpacity>
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
    paddingVertical: 10,
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
  headerCenter: {
    flex: 1,
  },
  channelName: {
    ...Typography.default('semiBold'),
    fontSize: 20,
    lineHeight: 24,
    color: groknight.textPrimary,
  },
  headerMeta: {
    ...Typography.default(),
    fontSize: 11,
    lineHeight: 15,
    color: groknight.textMuted,
    marginTop: 2,
  },
  addMembersButton: {
    minWidth: 62,
    minHeight: 44,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgHighlight,
  },
  addMembersGlyph: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 15,
    lineHeight: 16,
  },
  addMembersText: {
    ...Typography.mono('semiBold'),
    marginTop: 1,
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 10,
    letterSpacing: 0.4,
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
  participantBar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  participantLabel: {
    ...Typography.default('semiBold'),
    marginBottom: 6,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.7,
  },
  participantList: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  participantIdentity: {
    minWidth: 0,
    maxWidth: 180,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  participantName: {
    ...Typography.default('semiBold'),
    flexShrink: 1,
    color: groknight.textSecondary,
    fontSize: 11,
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
  memberModalSubtitle: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 17,
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
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  messageBubble: {
    position: 'relative',
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 6,
  },
  agentBlock: {
    backgroundColor: groknight.bgRaised,
    borderWidth: 1,
    borderColor: groknight.borderQuiet,
  },
  userBlock: {
    backgroundColor: groknight.bgVoid,
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
    fontSize: 13,
    color: groknight.textSecondary,
    lineHeight: 18,
  },
  provenanceText: {
    ...Typography.mono(),
    fontSize: 11,
    lineHeight: 15,
    color: groknight.textMuted,
    marginTop: 4,
  },

  // ── Merge summary ───────────────────────────────────────────────
  mergeSummaryBubble: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  mergeSummaryTitle: {
    ...Typography.default('semiBold'),
    fontSize: 12,
    color: groknight.chrome,
    marginBottom: 4,
  },
  mergeSummaryText: {
    ...Typography.default(),
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
    backgroundColor: groknight.bgRaised,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    gap: 8,
  },
  approvalInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  prChip: {
    ...Typography.default('semiBold'),
    fontSize: 14,
    color: groknight.textPrimary,
  },
  approvalBarText: {
    ...Typography.default(),
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    color: groknight.textMuted,
  },
  humanBoundaryText: {
    ...Typography.default(),
    color: groknight.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  approvalPending: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  approvalStateText: {
    ...Typography.default(),
    fontSize: 11,
    color: groknight.textMuted,
  },
  approvalSent: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  approvalSentText: {
    ...Typography.default('semiBold'),
    color: groknight.chrome,
    fontSize: 12,
    fontWeight: '600',
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
  inputBar: {
    paddingHorizontal: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
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
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  composerFocused: { borderWidth: 2, borderColor: groknight.focus, paddingHorizontal: 9 },
  composerPrefix: {
    ...Typography.default('semiBold'),
    fontSize: 14,
    color: groknight.steel,
    marginRight: 8,
  },
  input: {
    ...Typography.default(),
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: groknight.textSecondary,
    paddingVertical: 2,
    maxHeight: 80,
  },
  sendButton: {
    width: 44,
    height: 44,
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
  sendButtonTextQuiet: { color: groknight.textDisabled },
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
});
