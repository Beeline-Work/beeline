/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * GrokNight alien-hull design: near-black flat surfaces, brushed chrome,
 * and a restrained cyan accent for active/live states and merge approval.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
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
import { CHANGE_LABEL, CHANGES_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { reconcileOptimisticMessage } from '@/buzz/reconcileOptimisticMessage';
import { countRoomParticipants } from '@/buzz/room-participants';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { Typography } from '@/constants/Typography';
import { ChangeReviewPanel } from '@/components/buzz/ChangeReviewPanel';

type DisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  pubkey?: string;
  /** Subchannel ID if this is a subchannel-link control message. */
  subchannelId?: string;
  /** True if this is a merge-summary control message from the body. */
  isMergeSummary?: boolean;
  /** True if this is a body control message with subchannel link. */
  isSubchannelLink?: boolean;
  /** True if this is an archived notification. */
  isArchivedNotice?: boolean;
  /** True if this is an agent-activity frame from the body. */
  isAgentActivity?: boolean;
  /** Explicit human → agent work request; never a direct subchannel create. */
  requestAgentPubkey?: string;
};

type SubchannelDisplay = {
  id: string;
  openerPubkey: string;
  archived: boolean;
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
  const [subchannels, setSubchannels] = useState<SubchannelDisplay[]>([]);
  const [parentChannelId, setParentChannelId] = useState<string | undefined>(undefined);
  const [mergeSummaryText, setMergeSummaryText] = useState<string | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(null);
  const [availableAgents, setAvailableAgents] = useState<Agent[]>([]);
  const [requestingAgent, setRequestingAgent] = useState<Agent | null>(null);
  const [viewerIsAgent, setViewerIsAgent] = useState(false);
  const [roomName, setRoomName] = useState(ROOM_LABEL);
  const [participantCounts, setParticipantCounts] = useState({ humans: 0, agents: 0 });

  // Helper to add new messages, deduplicating by id.
  const addMessages = useCallback((newMsgs: DisplayMessage[]) => {
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const unique = newMsgs.filter((m) => !existingIds.has(m.id));
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
          let foundMergeSummary: string | null = null;

          for (const e of events) {
            const pk = eventPubkey(e);
            const text = eventText(e);
            const isAgentActivity = e.type === 'assistant_delta';
            if (isAgentActivity && !text.trim()) continue;
            const hasBodyControl = eventHasTag(e, 't', 'body-control');
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
              foundMergeSummary = text;
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

            // P2: Parse body-control messages for subchannel links
            if (hasBodyControl) {
              const subId = eventTagValue(e, 'subchannel');
              if (subId && !hasStatusArchived) {
                // This is a subchannel-open link
                msgs.push({
                  id: eventId(e, `sub-${Math.random()}`),
                  text,
                  isUser: false,
                  timestamp: eventTimestamp(e),
                  pubkey: pk,
                  subchannelId: subId,
                  isSubchannelLink: true,
                  requestAgentPubkey: eventTagValue(e, 'agent') ?? pk,
                });
                continue;
              }
              if (hasStatusArchived) {
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

          if (foundMergeSummary) setMergeSummaryText(foundMergeSummary);
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

        // P2: Discover child channels when this is a parent channel.
        try {
          const lifecycle = await t.listSubchannelLifecycle(decodedId);
          setSubchannels(lifecycle);
        } catch {
          // Not a parent channel — that's fine.
        }

        // Subscribe to live messages
        unsubscribe = t.sessionEventsSubscribe(decodedId, (event) => {
          if (cancelled) return;

          const pk = eventPubkey(event);
          const text = eventText(event);
          const isAgentActivity = event.type === 'assistant_delta';
          if (isAgentActivity && !text.trim()) return;
          const hasBodyControl = eventHasTag(event, 't', 'body-control');
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
            setMergeSummaryText(text);
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
            if (subId && !hasStatusArchived) {
              setSubchannels((current) =>
                current.some((sub) => sub.id === subId)
                  ? current
                  : [
                      ...current,
                      {
                        id: subId,
                        openerPubkey: eventTagValue(event, 'agent') ?? pk ?? '',
                        archived: false,
                      },
                    ],
              );
              addMessages([
                {
                  id: eventId(event, `sub-live-${Math.random()}`),
                  text,
                  isUser: false,
                  timestamp: eventTimestamp(event),
                  pubkey: pk,
                  subchannelId: subId,
                  isSubchannelLink: true,
                  requestAgentPubkey: eventTagValue(event, 'agent') ?? pk,
                },
              ]);
              return;
            }
            if (hasStatusArchived) {
              if (subId) {
                setSubchannels((current) =>
                  current.map((sub) => (sub.id === subId ? { ...sub, archived: true } : sub)),
                );
              } else {
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

  const handleApprove = useCallback(async () => {
    if (!transport || !mergeTarget) return;
    setApprovalState('sending');
    try {
      const result = await transport.submitMergeApproval(decodedId, mergeTarget);
      if (result.success) {
        setApprovalState('sent');
      }
    } catch (err) {
      console.warn('Approval failed:', err);
    }
  }, [transport, mergeTarget, decodedId]);

  const handleSubchannelPress = useCallback((subId: string) => {
    router.push(`/buzz/chat/${encodeURIComponent(subId)}`);
  }, []);

  const handleCommunitySelect = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: DisplayMessage }) => {
      // ── Subchannel link (open-edit control message) ──────────────
      if (item.isSubchannelLink && item.subchannelId) {
        return (
          <View style={styles.subchannelLinkBubble}>
            <View style={styles.subchannelLinkHeading}>
              <Text style={styles.subchannelLinkTitle}>{CHANGE_LABEL}</Text>
              <Text style={styles.liveBadge}>● Live</Text>
            </View>
            {item.requestAgentPubkey && (
              <Text style={styles.openerBadge}>opened by {shortNpub(item.requestAgentPubkey)}</Text>
            )}
            <Text style={styles.subchannelLinkText} numberOfLines={2}>
              {item.text}
            </Text>
            <TouchableOpacity
              style={styles.subchannelLinkButton}
              onPress={() => handleSubchannelPress(item.subchannelId!)}
            >
              <Text style={styles.subchannelLinkButtonText}>Open change</Text>
            </TouchableOpacity>
          </View>
        );
      }

      // ── Merge summary ────────────────────────────────────────────
      if (item.isMergeSummary) {
        return (
          <View style={styles.mergeSummaryBubble}>
            <Text style={styles.mergeSummaryTitle}>✓ {CHANGE_LABEL} merged</Text>
            <Text style={styles.mergeSummaryText}>{item.text}</Text>
            {item.pubkey && <Text style={styles.mergeSummaryPubkey}>{shortNpub(item.pubkey)}</Text>}
          </View>
        );
      }

      // ── Archived notice ──────────────────────────────────────────
      if (item.isArchivedNotice) {
        return (
          <View style={styles.archivedBubble}>
            <Text style={styles.archivedText}>📦 {item.text}</Text>
          </View>
        );
      }

      // ── Regular message bubble ───────────────────────────────────
      const isBody = item.pubkey && BODY_PUBKEYS.has(item.pubkey);
      const isOwn = item.isUser;
      const isAgent = item.isAgentActivity || isBody;

      return (
        <View style={[styles.messageBubble, isAgent ? styles.agentBlock : styles.userBlock]}>
          <Text style={[styles.roleLabel, isAgent ? styles.roleAgent : styles.roleUser]}>
            {isOwn ? 'You' : isAgent ? 'Beeline' : shortNpub(item.pubkey ?? '')}
          </Text>
          {item.requestAgentPubkey && (
            <Text style={styles.workRequestBadge}>
              Asking {shortNpub(item.requestAgentPubkey)} to start {CHANGE_LABEL}
            </Text>
          )}
          <Text style={styles.messageText}>{item.text}</Text>
          {item.pubkey && !isOwn && !isAgent && (
            <Text style={styles.provenanceText}>{shortNpub(item.pubkey)}</Text>
          )}
        </View>
      );
    },
    [handleSubchannelPress],
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={groknight.accent} />
        <Text style={styles.loadingText}>{ROOM_LABEL} loading…</Text>
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
        <View style={styles.header}>
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
              <Text style={styles.archivedBadgeText}>archived</Text>
            </View>
          )}
        </View>

        {/* P2: Merge approval bar for subchannels with a merge target */}
        {mergeTarget && !isArchived && (
          <View style={styles.approvalBar}>
            <View style={styles.approvalInfo}>
              <Text style={styles.prChip}>Review {CHANGE_LABEL}</Text>
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
            <Text style={styles.humanBoundaryText}>Only People can approve.</Text>
            {viewerIsAgent ? (
              <View style={styles.approvalSent}>
                <Text style={styles.approvalSentText}>Agents cannot approve</Text>
              </View>
            ) : approvalState === 'none' ? (
              <TouchableOpacity style={styles.approveButton} onPress={handleApprove}>
                <Text style={styles.approveButtonText}>Approve {CHANGE_LABEL}</Text>
              </TouchableOpacity>
            ) : approvalState === 'sending' ? (
              <View style={styles.approvalPending}>
                <ActivityIndicator size="small" color={groknight.accent} />
                <Text style={styles.approvalStateText}>sending…</Text>
              </View>
            ) : (
              <View style={styles.approvalSent}>
                <Text style={styles.approvalSentText}>✓ Approved · waiting for merge</Text>
              </View>
            )}
          </View>
        )}

        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item: DisplayMessage) => item.id}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          renderItem={renderItem}
          ListHeaderComponent={
            !parentChannelId && subchannels.length > 0 ? (
              <View style={styles.lifecyclePanel}>
                <Text style={styles.lifecycleTitle}>{CHANGES_LABEL}</Text>
                <Text style={styles.lifecycleHint}>
                  People ask → Agent works → People approve → done
                </Text>
                {subchannels.map((sub) => (
                  <TouchableOpacity
                    key={sub.id}
                    style={styles.lifecycleRow}
                    onPress={() => handleSubchannelPress(sub.id)}
                  >
                    <Text
                      style={[styles.lifecycleState, sub.archived && styles.lifecycleStateArchived]}
                    >
                      {sub.archived ? 'Closed' : 'Live'}
                    </Text>
                    <View style={styles.lifecycleInfo}>
                      <Text style={styles.lifecycleBranch}>↳ {sub.id.slice(0, 12)}…</Text>
                      <Text style={styles.lifecycleAgent}>agent {shortNpub(sub.openerPubkey)}</Text>
                    </View>
                    <Text style={styles.chevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null
          }
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
            <Text style={styles.archivedInputText}>{ROOM_LABEL} archived (read-only)</Text>
          </View>
        ) : (
          <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            {!parentChannelId && !viewerIsAgent && availableAgents.length > 0 && (
              <View style={styles.askAgentBar}>
                <Text style={styles.askAgentLabel}>Ask an Agent</Text>
                {availableAgents.map((agent) => {
                  const active = requestingAgent?.pubkey === agent.pubkey;
                  return (
                    <TouchableOpacity
                      key={agent.agentId}
                      style={[styles.askAgentChip, active && styles.askAgentChipActive]}
                      onPress={() => setRequestingAgent(active ? null : agent)}
                    >
                      <Text
                        style={[styles.askAgentChipText, active && styles.askAgentChipTextActive]}
                      >
                        @{agent.displayName}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            <View style={styles.composer}>
              <Text style={styles.composerPrefix}>›</Text>
              <TextInput
                style={styles.input}
                value={inputText}
                onChangeText={setInputText}
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
    ...Typography.default(),
    marginTop: 12,
    fontSize: 13,
    color: groknight.muted,
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
    marginRight: 8,
    paddingRight: 4,
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
    fontSize: 13,
    fontWeight: '800',
    color: groknight.textPrimary,
  },
  headerMeta: {
    ...Typography.default(),
    fontSize: 10,
    color: groknight.muted,
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
    ...Typography.default(),
    color: groknight.muted,
    fontSize: 10,
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
    paddingLeft: 12,
    marginBottom: 6,
  },
  /** Left accent bar via borderLeft — 2px, color-coded by role */
  agentBlock: {
    borderLeftWidth: 2,
    borderLeftColor: groknight.accent,
  },
  userBlock: {
    borderLeftWidth: 2,
    borderLeftColor: groknight.textSecondary,
  },
  roleLabel: {
    ...Typography.default('semiBold'),
    fontSize: 9,
    fontWeight: '600',
    marginBottom: 3,
  },
  roleAgent: {
    color: groknight.accent,
  },
  roleUser: {
    color: groknight.muted,
  },
  messageText: {
    ...Typography.default(),
    fontSize: 13,
    color: groknight.textSecondary,
    lineHeight: 18,
  },
  provenanceText: {
    ...Typography.mono(),
    fontSize: 9,
    color: groknight.dim,
    marginTop: 4,
  },
  workRequestBadge: {
    ...Typography.default('semiBold'),
    alignSelf: 'flex-start',
    color: groknight.accent,
    marginBottom: 5,
    fontSize: 10,
    fontWeight: '600',
  },

  // ── Subchannel link ─────────────────────────────────────────────
  subchannelLinkBubble: {
    paddingHorizontal: 10,
    paddingVertical: 14,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  subchannelLinkTitle: {
    ...Typography.default('semiBold'),
    fontSize: 11,
    fontWeight: '700',
    color: groknight.chrome,
  },
  subchannelLinkHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  liveBadge: {
    ...Typography.default('semiBold'),
    color: groknight.accent,
    fontWeight: '600',
    fontSize: 10,
  },
  openerBadge: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 9,
    marginBottom: 6,
  },
  subchannelLinkText: {
    ...Typography.default(),
    fontSize: 12,
    color: groknight.muted,
    marginBottom: 8,
    lineHeight: 16,
  },
  subchannelLinkButton: {
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  subchannelLinkButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 11,
    fontWeight: '700',
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
    fontWeight: '700',
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
    fontSize: 9,
    color: groknight.dim,
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
    ...Typography.default(),
    fontSize: 11,
    color: groknight.muted,
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
    ...Typography.default('semiBold'),
    fontSize: 14,
    fontWeight: '700',
    color: groknight.textPrimary,
  },
  approvalBarText: {
    ...Typography.default(),
    flex: 1,
    fontSize: 10,
    color: groknight.muted,
  },
  humanBoundaryText: {
    ...Typography.default(),
    color: groknight.steel,
    fontSize: 11,
    lineHeight: 15,
  },
  approveButton: {
    borderWidth: 1,
    borderColor: groknight.accent,
    borderRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    backgroundColor: groknight.accent,
  },
  approveButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.bgTerminal,
    fontSize: 12,
    fontWeight: '800',
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
    color: groknight.muted,
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

  // ── Parent channel lifecycle ───────────────────────────────────
  lifecyclePanel: {
    marginBottom: 16,
    paddingTop: 8,
  },
  lifecycleTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingTop: 9,
  },
  lifecycleHint: {
    ...Typography.default(),
    color: groknight.dim,
    fontSize: 11,
    paddingHorizontal: 10,
    paddingTop: 3,
    paddingBottom: 7,
  },
  lifecycleRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 9,
  },
  lifecycleState: {
    ...Typography.default('semiBold'),
    color: groknight.accent,
    fontSize: 10,
    fontWeight: '600',
  },
  lifecycleStateArchived: {
    color: groknight.muted,
  },
  lifecycleInfo: { flex: 1, minWidth: 0 },
  lifecycleBranch: { ...Typography.mono(), color: groknight.chrome, fontSize: 11 },
  lifecycleAgent: { ...Typography.mono(), color: groknight.dim, fontSize: 9, marginTop: 2 },
  chevron: { ...Typography.default(), color: groknight.steel, fontSize: 18 },

  // ── Legacy subchannel links (empty state) ───────────────────────
  subchannelLinks: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  subchannelLinksTitle: {
    ...Typography.default('semiBold'),
    fontSize: 11,
    fontWeight: '700',
    color: groknight.muted,
    marginBottom: 8,
  },
  subchannelLinkItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  subchannelLinkItemText: {
    ...Typography.default(),
    color: groknight.chrome,
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
    fontWeight: '600',
  },
  askAgentChip: {
    borderWidth: 1,
    borderColor: groknight.borderActive,
    borderRadius: 3,
    paddingHorizontal: 7,
    paddingVertical: 4,
    backgroundColor: groknight.bgBase,
  },
  askAgentChipActive: {
    borderColor: groknight.textSecondary,
    backgroundColor: groknight.bgHighlight,
  },
  askAgentChipText: { ...Typography.default(), color: groknight.chrome, fontSize: 10 },
  askAgentChipTextActive: { color: groknight.textPrimary, fontWeight: '700' },
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
  composerPrefix: {
    ...Typography.default('semiBold'),
    fontSize: 14,
    fontWeight: '800',
    color: groknight.steel,
    marginRight: 8,
  },
  input: {
    ...Typography.default(),
    flex: 1,
    fontSize: 12,
    color: groknight.textSecondary,
    paddingVertical: 2,
    maxHeight: 80,
  },
  sendButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sendButtonDisabled: {
    opacity: 0.3,
  },
  sendButtonText: {
    ...Typography.default(),
    color: groknight.accent,
    fontSize: 16,
  },
  sendButtonTextQuiet: { color: groknight.textSecondary },
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
