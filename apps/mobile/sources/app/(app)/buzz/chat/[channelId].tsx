/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * GrokNight Terminal design: near-black flat surfaces, role accent bars,
 * diamond tool bullets, gold approval gates, monospace typography.
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
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import { encodeNpub, type MergeTarget } from '@buzzy/buzz-client';
import type { SessionEvent } from '@/sync/transport';
import { groknight } from '@/buzz/groknight';
import { reconcileOptimisticMessage } from '@/buzz/reconcileOptimisticMessage';

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
};

/** Known body pubkeys for provenance display (hardcoded for dev). */
const BODY_PUBKEYS = new Set<string>();

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

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
  const [approvalState, setApprovalState] = useState<'none' | 'sending' | 'sent' | 'merged'>('none');
  const [subchannelIds, setSubchannelIds] = useState<string[]>([]);
  const [parentChannelId, setParentChannelId] = useState<string | undefined>(undefined);
  const [mergeSummaryText, setMergeSummaryText] = useState<string | null>(null);

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

        const t = new BuzzRigTransport(identity);
        setTransport(t);
        setUserPubkey(identity.publicKey);

        // Check if this channel is a subchannel (has parent).
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

        // P2: Backfill parent messages to find subchannel links (if this is a parent)
        try {
          const subIds = await t.listSubchannels(decodedId);
          setSubchannelIds(subIds);
        } catch {
          // Not a parent channel — that's fine
        }

        // Backfill existing messages
        const events = await t.sessionEventsBackfill(decodedId, { limit: 50 });
        if (!cancelled) {
          const msgs: DisplayMessage[] = [];
          let foundMergeSummary: string | null = null;

          for (const e of events) {
            const pk = eventPubkey(e);
            const text = eventText(e);
            const isAgentActivity = e.type === 'assistant_delta';
            const hasBodyControl = eventHasTag(e, 't', 'body-control');
            const hasMergeSummary = eventHasTag(e, 't', 'merge-summary');
            const hasStatusArchived = eventHasTag(e, 'status', 'archived');

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
            });
          }

          if (foundMergeSummary) setMergeSummaryText(foundMergeSummary);
          setMessages(msgs);
        }

        // Subscribe to live messages
        unsubscribe = t.sessionEventsSubscribe(decodedId, (event) => {
          if (cancelled) return;

          const pk = eventPubkey(event);
          const text = eventText(event);
          const isAgentActivity = event.type === 'assistant_delta';
          const hasBodyControl = eventHasTag(event, 't', 'body-control');
          const hasMergeSummary = eventHasTag(event, 't', 'merge-summary');
          const hasStatusArchived = eventHasTag(event, 'status', 'archived');

          if (hasMergeSummary) {
            setMergeSummaryText(text);
            addMessages([{
              id: eventId(event, `merge-live-${Math.random()}`),
              text,
              isUser: false,
              timestamp: eventTimestamp(event),
              pubkey: pk,
              isMergeSummary: true,
            }]);
            return;
          }

          if (hasBodyControl) {
            const subId = eventTagValue(event, 'subchannel');
            if (subId && !hasStatusArchived) {
              addMessages([{
                id: eventId(event, `sub-live-${Math.random()}`),
                text,
                isUser: false,
                timestamp: eventTimestamp(event),
                pubkey: pk,
                subchannelId: subId,
                isSubchannelLink: true,
              }]);
              return;
            }
            if (hasStatusArchived) {
              setIsArchived(true);
              addMessages([{
                id: eventId(event, `archive-live-${Math.random()}`),
                text,
                isUser: false,
                timestamp: eventTimestamp(event),
                pubkey: pk,
                isArchivedNotice: true,
              }]);
              return;
            }
          }

          addMessages([{
            id: eventId(event, `live-${Math.random()}`),
            text,
            isUser: pk === userPubkey,
            timestamp: eventTimestamp(event),
            pubkey: pk,
            isAgentActivity: event.type === 'assistant_delta',
          }]);
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
  }, [decodedId, addMessages, userPubkey]);

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
      const eventId = await transport.messageSubmitWithEventId({
        sessionId: decodedId,
        text,
      });
      setMessages((prev) =>
        reconcileOptimisticMessage(prev, optimisticId, eventId),
      );
    } catch (err) {
      console.warn('Send failed:', err);
    } finally {
      setSending(false);
    }
  }, [inputText, transport, decodedId, addMessages, isArchived, userPubkey]);

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

  const renderItem = useCallback(
    ({ item }: { item: DisplayMessage }) => {
      // ── Subchannel link (open-edit control message) ──────────────
      if (item.isSubchannelLink && item.subchannelId) {
        return (
          <View style={styles.subchannelLinkBubble}>
            <Text style={styles.subchannelLinkTitle}>🛠 Edit Session</Text>
            <Text style={styles.subchannelLinkText} numberOfLines={2}>
              {item.text}
            </Text>
            <TouchableOpacity
              style={styles.subchannelLinkButton}
              onPress={() => handleSubchannelPress(item.subchannelId!)}
            >
              <Text style={styles.subchannelLinkButtonText}>
                Open Subchannel
              </Text>
            </TouchableOpacity>
          </View>
        );
      }

      // ── Merge summary ────────────────────────────────────────────
      if (item.isMergeSummary) {
        return (
          <View style={styles.mergeSummaryBubble}>
            <Text style={styles.mergeSummaryTitle}>✓ Merged</Text>
            <Text style={styles.mergeSummaryText}>{item.text}</Text>
            {item.pubkey && (
              <Text style={styles.mergeSummaryPubkey}>
                {shortNpub(item.pubkey)}
              </Text>
            )}
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
        <View style={[
          styles.messageBubble,
          isAgent ? styles.agentBlock : styles.userBlock,
        ]}>
          <Text style={[styles.roleLabel, isAgent ? styles.roleAgent : styles.roleUser]}>
            {isOwn ? 'YOU' : (isAgent ? 'BUZZY' : shortNpub(item.pubkey ?? ''))}
          </Text>
          <Text style={styles.messageText}>{item.text}</Text>
          {item.pubkey && !isOwn && !isAgent && (
            <Text style={styles.provenanceText}>{shortNpub(item.pubkey)}</Text>
          )}
        </View>
      );
    },
    [decodedId, handleSubchannelPress],
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={groknight.magenta} />
        <Text style={styles.loadingText}>session loading…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.channelName} numberOfLines={1}>
            {decodedId.slice(0, 12)}…
          </Text>
          {mergeTarget && (
            <Text style={styles.headerMeta}>
              <Text style={styles.pathTag}>{mergeTarget.repo}</Text>
            </Text>
          )}
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
            <Text style={styles.prChip}>{mergeTarget.repo} · {mergeTarget.branch}</Text>
            <Text style={styles.approvalBarText}>
              {mergeTarget.branch} → {mergeTarget.tip.slice(0, 8)}
            </Text>
          </View>
          {approvalState === 'none' && (
            <TouchableOpacity style={styles.approveButton} onPress={handleApprove}>
              <Text style={styles.approveButtonText}>◆ APPROVE MERGE</Text>
            </TouchableOpacity>
          )}
          {approvalState === 'sending' && (
            <View style={styles.approvalPending}>
              <ActivityIndicator size="small" color={groknight.gold} />
              <Text style={styles.approvalStateText}>sending…</Text>
            </View>
          )}
          {approvalState === 'sent' && (
            <View style={styles.approvalSent}>
              <Text style={styles.approvalSentText}>✓ approval sent</Text>
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
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>empty channel</Text>
            {subchannelIds.length > 0 && (
              <View style={styles.subchannelLinks}>
                <Text style={styles.subchannelLinksTitle}>subchannels</Text>
                {subchannelIds.map((sid) => (
                  <TouchableOpacity
                    key={sid}
                    style={styles.subchannelLinkItem}
                    onPress={() => handleSubchannelPress(sid)}
                  >
                    <Text style={styles.subchannelLinkItemText}>
                      🛠 {sid.slice(0, 12)}…
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        }
        onContentSizeChange={() =>
          flatListRef.current?.scrollToEnd({ animated: false })
        }
      />

      {/* P2: Archived channels are read-only */}
      {isArchived ? (
        <View style={[styles.archivedInputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Text style={styles.archivedInputText}>channel archived (read-only)</Text>
        </View>
      ) : (
        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <View style={styles.composer}>
            <Text style={styles.composerPrefix}>›</Text>
            <TextInput
              style={styles.input}
              value={inputText}
              onChangeText={setInputText}
              placeholder="steer the agent…"
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
              <Text style={styles.sendButtonText}>⏎</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </KeyboardAvoidingView>
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
    marginTop: 12,
    fontSize: 13,
    color: groknight.muted,
    fontFamily: mono,
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
    fontSize: 22,
    color: groknight.muted,
    fontFamily: mono,
  },
  headerCenter: {
    flex: 1,
  },
  channelName: {
    fontSize: 13,
    fontWeight: '800',
    color: groknight.textPrimary,
    letterSpacing: 0.3,
    fontFamily: mono,
  },
  headerMeta: {
    fontSize: 10,
    color: groknight.muted,
    marginTop: 2,
    fontFamily: mono,
  },
  pathTag: {
    color: groknight.orange,
  },
  archivedBadge: {
    backgroundColor: groknight.bgHighlight,
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  archivedBadgeText: {
    color: groknight.muted,
    fontSize: 10,
    fontFamily: mono,
    letterSpacing: 0.3,
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
    borderLeftColor: groknight.magenta,
  },
  userBlock: {
    borderLeftWidth: 2,
    borderLeftColor: groknight.textSecondary,
  },
  roleLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  roleAgent: {
    color: groknight.magenta,
  },
  roleUser: {
    color: groknight.muted,
  },
  messageText: {
    fontSize: 13,
    color: groknight.textSecondary,
    lineHeight: 18,
    fontFamily: mono,
  },
  provenanceText: {
    fontSize: 9,
    color: groknight.dim,
    marginTop: 4,
    fontFamily: mono,
  },

  // ── Subchannel link ─────────────────────────────────────────────
  subchannelLinkBubble: {
    backgroundColor: groknight.bgHighlight,
    borderRadius: 4,
    padding: 12,
    marginBottom: 6,
    borderLeftWidth: 2,
    borderLeftColor: groknight.blue,
  },
  subchannelLinkTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: groknight.blue,
    marginBottom: 4,
    fontFamily: mono,
  },
  subchannelLinkText: {
    fontSize: 12,
    color: groknight.muted,
    marginBottom: 8,
    lineHeight: 16,
    fontFamily: mono,
  },
  subchannelLinkButton: {
    backgroundColor: groknight.bgHover,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.border,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
  },
  subchannelLinkButtonText: {
    color: groknight.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: mono,
    letterSpacing: 0.3,
  },

  // ── Merge summary ───────────────────────────────────────────────
  mergeSummaryBubble: {
    backgroundColor: groknight.bgBase,
    borderRadius: 4,
    padding: 10,
    marginBottom: 6,
    borderLeftWidth: 2,
    borderLeftColor: groknight.green,
  },
  mergeSummaryTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: groknight.green,
    marginBottom: 4,
    fontFamily: mono,
  },
  mergeSummaryText: {
    fontSize: 12,
    color: groknight.textSecondary,
    lineHeight: 16,
    fontFamily: mono,
  },
  mergeSummaryPubkey: {
    fontSize: 9,
    color: groknight.dim,
    marginTop: 4,
    fontFamily: mono,
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
    fontSize: 11,
    color: groknight.muted,
    textAlign: 'center',
    fontFamily: mono,
  },

  // ── Approval bar ────────────────────────────────────────────────
  approvalBar: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: groknight.bgBase,
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
    fontSize: 10,
    fontWeight: '700',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 3,
    letterSpacing: 0.3,
    color: groknight.green,
    backgroundColor: groknight.greenDarkBg,
    borderWidth: 1,
    borderColor: '#9ece6a44',
    fontFamily: mono,
    overflow: 'hidden',
  },
  approvalBarText: {
    flex: 1,
    fontSize: 10,
    color: groknight.muted,
    fontFamily: mono,
  },
  approveButton: {
    borderWidth: 1,
    borderColor: groknight.gold,
    borderRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    backgroundColor: '#ffdb8d12',
  },
  approveButtonText: {
    color: groknight.gold,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    fontFamily: mono,
  },
  approvalPending: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  approvalStateText: {
    fontSize: 11,
    color: groknight.muted,
    fontFamily: mono,
  },
  approvalSent: {
    borderWidth: 1,
    borderColor: groknight.green,
    borderRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    backgroundColor: '#9ece6a12',
  },
  approvalSentText: {
    color: groknight.green,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: mono,
  },

  // ── Subchannel links (empty state) ──────────────────────────────
  subchannelLinks: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  subchannelLinksTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: groknight.muted,
    marginBottom: 8,
    letterSpacing: 0.8,
    fontFamily: mono,
  },
  subchannelLinkItem: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  subchannelLinkItemText: {
    color: groknight.blue,
    fontSize: 12,
    fontFamily: mono,
  },

  // ── Composer ────────────────────────────────────────────────────
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 13,
    color: groknight.muted,
    fontFamily: mono,
  },
  inputBar: {
    paddingHorizontal: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
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
  composerPrefix: {
    fontSize: 14,
    fontWeight: '800',
    color: groknight.magenta,
    marginRight: 8,
    fontFamily: mono,
  },
  input: {
    flex: 1,
    fontSize: 12,
    color: groknight.textSecondary,
    fontFamily: mono,
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
    color: groknight.gutter,
    fontSize: 16,
  },
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
    fontSize: 11,
    color: groknight.muted,
    fontStyle: 'italic',
    fontFamily: mono,
  },
});
