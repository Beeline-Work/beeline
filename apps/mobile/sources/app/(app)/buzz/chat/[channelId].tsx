/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * Grok Mono Hull design: neutral metal surfaces with redundant state encoding.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
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
  type MergeTarget,
} from '@beeline/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import { groknight } from '@/buzz/groknight';
import { CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { reconcileOptimisticMessage } from '@/buzz/reconcileOptimisticMessage';
import { countRoomParticipants } from '@/buzz/room-participants';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { ChangeReviewPanel } from '@/components/buzz/ChangeReviewPanel';
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
  /** Explicit human → agent work request; never a direct subchannel create. */
  requestAgentPubkey?: string;
  /** True only for subscription/optimistic inserts, never initial backfill. */
  isNew?: boolean;
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
  return eventHasTag(e, 't', 'body-control')
    || Boolean(eventTagValue(e, 'subchannel'))
    || /^Agent opened(?: #| a work branch for:)/.test(text);
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
  const [roomAgentPubkeys, setRoomAgentPubkeys] = useState<Set<string>>(new Set());
  const [invitingAgentPubkey, setInvitingAgentPubkey] = useState<string | null>(null);
  const [requestingAgent, setRequestingAgent] = useState<Agent | null>(null);
  const [viewerIsAgent, setViewerIsAgent] = useState(false);
  const [roomName, setRoomName] = useState(ROOM_LABEL);
  const [participantCounts, setParticipantCounts] = useState({ humans: 0, agents: 0 });
  const [composerFocused, setComposerFocused] = useState(false);

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
        const [availableCommunities, channelCommunityId, channelMetadata, roomMembers] =
          await Promise.all([
            client.listCommunities(),
            client.getChannelCommunityId(decodedId),
            client.getChannelMetadata(decodedId),
            client.listMembers(decodedId),
          ]);
        const [communityAgents, identityIsAgent] = await Promise.all([
          channelCommunityId ? client.listAgents(channelCommunityId) : Promise.resolve([]),
          client.isAgentIdentity(identity.publicKey),
        ]);
        if (!cancelled) {
          setCommunities(availableCommunities);
          setActiveCommunityId(channelCommunityId);
          setAvailableAgents(communityAgents);
          setRoomAgentPubkeys(
            new Set(
              roomMembers
                .map((member) => member.pubkey)
                .filter((pubkey) => communityAgents.some((agent) => agent.pubkey === pubkey)),
            ),
          );
          setViewerIsAgent(identityIsAgent);
          setRoomName(channelMetadata?.name?.trim() || ROOM_LABEL);
          setParticipantCounts(countRoomParticipants(roomMembers, communityAgents));
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
            const requestAgentPubkey = eventHasTag(e, 't', 'buzz-agent-request')
              ? eventTagValue(e, 'p')
              : undefined;

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
              requestAgentPubkey,
            });
          }

          setMessages(msgs);
          setLoading(false);
        }

        // Check if this channel is a subchannel (has parent).
        // The parent linkage lives on the 9007 create event, not on 39000 metadata.
        const parentId = await t.getParentChannelId(decodedId);
        if (parentId) {
          setParentChannelId(parentId);
        }

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
          const requestAgentPubkey = eventHasTag(event, 't', 'buzz-agent-request')
            ? eventTagValue(event, 'p')
            : undefined;

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
              requestAgentPubkey,
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
        requestAgentPubkey: requestingAgent?.pubkey,
      },
    ]);

    try {
      const eventId =
        requestingAgent && !parentChannelId
          ? await transport.submitAgentRequest(decodedId, text, requestingAgent.pubkey)
          : await transport.messageSubmitWithEventId({ sessionId: decodedId, text });
      setMessages((prev) => reconcileOptimisticMessage(prev, optimisticId, eventId));
      setRequestingAgent(null);
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
    requestingAgent,
    parentChannelId,
  ]);

  const handleAgentChip = useCallback(
    async (agent: Agent) => {
      if (!transport || !activeCommunityId) return;
      if (roomAgentPubkeys.has(agent.pubkey)) {
        setRequestingAgent((current) => (current?.pubkey === agent.pubkey ? null : agent));
        return;
      }
      setInvitingAgentPubkey(agent.pubkey);
      try {
        await transport.inviteAgentToChannel(decodedId, agent.pubkey, activeCommunityId);
        setRoomAgentPubkeys((current) => new Set([...current, agent.pubkey]));
        setRequestingAgent(agent);
      } catch (err) {
        console.warn('Agent invite failed:', err);
      } finally {
        setInvitingAgentPubkey(null);
      }
    },
    [activeCommunityId, decodedId, roomAgentPubkeys, transport],
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
        return (
          <View style={styles.mergeSummaryBubble}>
            <Text style={styles.mergeSummaryTitle}>✓ {CORNER_LABEL} merged</Text>
            <Text style={styles.mergeSummaryText}>{item.text}</Text>
            {item.pubkey && <Text style={styles.mergeSummaryPubkey}>{shortNpub(item.pubkey)}</Text>}
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
      const isAgent = item.isAgentActivity || isBody;

      return (
        <NewMessageMaterialize enabled={Boolean(item.isNew)}>
          <View style={[styles.messageBubble, isAgent ? styles.agentBlock : styles.userBlock]}>
            <Text style={[styles.roleLabel, isAgent ? styles.roleAgent : styles.roleUser]}>
              {isOwn ? '◇ YOU' : isAgent ? '◆ BEELINE' : `◇ ${shortNpub(item.pubkey ?? '')}`}
            </Text>
            {item.requestAgentPubkey && (
              <Text style={styles.workRequestBadge}>
                REQUEST ◆ {shortNpub(item.requestAgentPubkey)} · START A CORNER
              </Text>
            )}
            <Text style={styles.messageText}>{item.text}</Text>
            {item.pubkey && !isOwn && !isAgent && (
              <Text style={styles.provenanceText}>{shortNpub(item.pubkey)}</Text>
            )}
          </View>
        </NewMessageMaterialize>
      );
    },
    [],
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
              {participantCounts.humans} {participantCounts.humans === 1 ? 'human' : 'humans'} ·{' '}
              {participantCounts.agents} {participantCounts.agents === 1 ? 'agent' : 'agents'}
              {mergeTarget && (
                <>
                  {' · '}
                  <Text style={styles.pathTag}>{mergeTarget.repo}</Text>
                </>
              )}
            </Text>
          </View>
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
            {!parentChannelId && !viewerIsAgent && availableAgents.length > 0 && (
              <View style={styles.askAgentBar}>
                <Text style={styles.askAgentLabel}>Ask an Agent</Text>
                {availableAgents.map((agent) => {
                  const active = requestingAgent?.pubkey === agent.pubkey;
                  const invited = roomAgentPubkeys.has(agent.pubkey);
                  const inviting = invitingAgentPubkey === agent.pubkey;
                  return (
                    <TouchableOpacity
                      key={agent.agentId}
                      style={[styles.askAgentChip, active && styles.askAgentChipActive]}
                      disabled={Boolean(invitingAgentPubkey)}
                      onPress={() => void handleAgentChip(agent)}
                    >
                      <Text
                        style={[styles.askAgentChipText, active && styles.askAgentChipTextActive]}
                      >
                        {inviting ? 'INVITING…' : invited ? `@${agent.displayName}` : `＋ ${agent.displayName}`}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
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
                  requestingAgent
                    ? `ask ${requestingAgent.displayName} to start work…`
                    : parentChannelId
                      ? 'steer the live Agent…'
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
  pathTag: {
    ...Typography.mono(),
    color: groknight.chrome,
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
  roleLabel: {
    ...Typography.default('semiBold'),
    ...Typography.mono('semiBold'),
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 3,
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
  workRequestBadge: {
    ...Typography.mono('semiBold'),
    alignSelf: 'flex-start',
    color: groknight.textSecondary,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    paddingHorizontal: 7,
    paddingVertical: 4,
    marginBottom: 5,
    fontSize: 11,
    lineHeight: 15,
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
  askAgentBar: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 7,
  },
  askAgentLabel: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 11,
  },
  askAgentChip: {
    borderWidth: 1,
    minHeight: 44,
    justifyContent: 'center',
    borderColor: groknight.border,
    borderRadius: 3,
    paddingHorizontal: 7,
    paddingVertical: 4,
    backgroundColor: groknight.bgBase,
  },
  askAgentChipActive: {
    borderColor: groknight.textSecondary,
    backgroundColor: groknight.bgHighlight,
  },
  askAgentChipText: { ...Typography.default(), color: groknight.chrome, fontSize: 11 },
  askAgentChipTextActive: { ...Typography.default('semiBold'), color: groknight.textPrimary },
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
