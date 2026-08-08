/**
 * Buzz Chat — single channel/session chat screen (P2: subchannels + merge + provenance).
 *
 * P1: backfill + live subscribe + send.
 * P2: subchannel links in parent chat, Approve button in subchannels,
 *     merge-summary rendering, archived read-only mode, pubkey provenance.
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
import { identityNpub, encodeNpub, type MergeTarget } from '@buzzy/buzz-client';
import type { SessionEvent } from '@/sync/transport';

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
// Populated dynamically as we discover them.

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

        // Check if this channel is a subchannel (has parent)
        const detail = await t.sessionRead(decodedId);
        if (detail?.channelId) {
          setParentChannelId(detail.channelId);
        }

        // Check if channel is archived
        const archived = await t.isChannelArchived(decodedId);
        if (archived) setIsArchived(true);

        // P2: If in a subchannel, try to get merge target from control messages
        if (detail?.channelId) {
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
    addMessages([
      {
        id: `optimistic-${Date.now()}`,
        text,
        isUser: true,
        timestamp: Date.now(),
        pubkey: userPubkey,
      },
    ]);

    try {
      await transport.messageSubmit({ sessionId: decodedId, text });
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

      // ── Agent activity (assistant delta) ─────────────────────────
      if (eventHasTag(
        // Reconstruct from the display item — this is best-effort
        // We check by looking for agent-activity markers in our known events
        { type: 'raw', sessionId: decodedId, payload: { id: item.id } } as SessionEvent,
        't', 'agent-activity'
      )) {
        return (
          <View style={[styles.messageBubble, styles.agentBubble]}>
            <Text style={styles.provenanceLabel}>🤖 Agent</Text>
            <Text style={styles.messageText}>{item.text}</Text>
            {item.pubkey && (
              <Text style={styles.provenanceText}>{shortNpub(item.pubkey)}</Text>
            )}
          </View>
        );
      }

      // ── Regular message bubble ───────────────────────────────────
      const isBody = item.pubkey && BODY_PUBKEYS.has(item.pubkey);
      const isOwn = item.isUser;

      return (
        <View
          style={[
            styles.messageBubble,
            isOwn ? styles.userBubble : styles.otherBubble,
          ]}
        >
          {!isOwn && item.pubkey && (
            <Text style={styles.provenanceText}>
              {isBody ? '🛠 Body' : shortNpub(item.pubkey)}
            </Text>
          )}
          {isOwn && (
            <Text style={[styles.provenanceText, styles.ownProvenance]}>you</Text>
          )}
          <Text style={styles.messageText}>{item.text}</Text>
          <Text style={styles.messageTime}>
            {new Date(item.timestamp).toLocaleTimeString()}
          </Text>
        </View>
      );
    },
    [decodedId, handleSubchannelPress],
  );

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color="#0a84ff" />
        <Text style={styles.loadingText}>Loading channel…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.backButton}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {decodedId.slice(0, 12)}…
        </Text>
        {isArchived && (
          <View style={styles.archivedBadge}>
            <Text style={styles.archivedBadgeText}>Archived</Text>
          </View>
        )}
      </View>

      {/* P2: Merge approval bar for subchannels with a merge target */}
      {mergeTarget && !isArchived && (
        <View style={styles.approvalBar}>
          <Text style={styles.approvalBarText}>
            Ready to merge: {mergeTarget.branch} → {mergeTarget.tip.slice(0, 8)}
          </Text>
          {approvalState === 'none' && (
            <TouchableOpacity style={styles.approveButton} onPress={handleApprove}>
              <Text style={styles.approveButtonText}>Approve</Text>
            </TouchableOpacity>
          )}
          {approvalState === 'sending' && (
            <View style={styles.approvalPending}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.approvalStateText}>Sending…</Text>
            </View>
          )}
          {approvalState === 'sent' && (
            <View style={styles.approvalSent}>
              <Text style={styles.approvalStateText}>✓ Sent for approval</Text>
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
            <Text style={styles.emptyText}>No messages yet</Text>
            {subchannelIds.length > 0 && (
              <View style={styles.subchannelLinks}>
                <Text style={styles.subchannelLinksTitle}>Subchannels</Text>
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

      {/* P2: Archived channels are read-only — disable the input */}
      {isArchived ? (
        <View style={[styles.archivedInputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <Text style={styles.archivedInputText}>This channel is archived (read-only)</Text>
        </View>
      ) : (
        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Type a message…"
            placeholderTextColor="#666"
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
            <Text style={styles.sendButtonText}>Send</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  backButton: {
    fontSize: 16,
    color: '#0a84ff',
    minWidth: 60,
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    textAlign: 'center',
    fontFamily: 'monospace',
  },
  archivedBadge: {
    backgroundColor: '#555',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 60,
    alignItems: 'flex-end',
  },
  archivedBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#888',
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  messageBubble: {
    maxWidth: '80%',
    padding: 10,
    borderRadius: 12,
    marginBottom: 8,
  },
  userBubble: {
    backgroundColor: '#0a84ff',
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  otherBubble: {
    backgroundColor: '#1c1c1e',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  agentBubble: {
    backgroundColor: '#1a3a1a',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderLeftWidth: 2,
    borderLeftColor: '#4caf50',
  },
  messageText: {
    fontSize: 15,
    color: '#fff',
    lineHeight: 20,
  },
  messageTime: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 4,
    alignSelf: 'flex-end',
  },
  provenanceText: {
    fontSize: 10,
    color: '#8af',
    marginBottom: 4,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  ownProvenance: {
    color: '#8af',
    textAlign: 'right',
  },
  provenanceLabel: {
    fontSize: 11,
    color: '#4caf50',
    fontWeight: '600',
    marginBottom: 4,
  },
  // ── Subchannel link ─────────────────────────────────────────────
  subchannelLinkBubble: {
    backgroundColor: '#1a2a3a',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#0a84ff',
  },
  subchannelLinkTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0a84ff',
    marginBottom: 4,
  },
  subchannelLinkText: {
    fontSize: 13,
    color: '#aaa',
    marginBottom: 8,
    lineHeight: 18,
  },
  subchannelLinkButton: {
    backgroundColor: '#0a84ff',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  subchannelLinkButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  // ── Merge summary ───────────────────────────────────────────────
  mergeSummaryBubble: {
    backgroundColor: '#1a3a1a',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#4caf50',
  },
  mergeSummaryTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4caf50',
    marginBottom: 4,
  },
  mergeSummaryText: {
    fontSize: 13,
    color: '#ccc',
    lineHeight: 18,
  },
  mergeSummaryPubkey: {
    fontSize: 10,
    color: '#4caf50',
    marginTop: 4,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  // ── Archived notice ─────────────────────────────────────────────
  archivedBubble: {
    backgroundColor: '#333',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    alignSelf: 'center',
    maxWidth: '90%',
  },
  archivedText: {
    fontSize: 13,
    color: '#aaa',
    textAlign: 'center',
  },
  // ── Approval bar ────────────────────────────────────────────────
  approvalBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#1a2a1a',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  approvalBarText: {
    flex: 1,
    fontSize: 12,
    color: '#aaa',
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  approveButton: {
    backgroundColor: '#30d158',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  approveButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  approvalPending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  approvalStateText: {
    fontSize: 12,
    color: '#aaa',
    marginLeft: 6,
  },
  approvalSent: {
    backgroundColor: '#1a3a1a',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  // ── Subchannel links (empty state) ──────────────────────────────
  subchannelLinks: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  subchannelLinksTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#888',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  subchannelLinkItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  subchannelLinkItemText: {
    color: '#0a84ff',
    fontSize: 14,
    fontFamily: Platform.OS === 'web' ? 'monospace' : undefined,
  },
  // ── Input ─────────────────────────────────────────────────────────
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: 14,
    color: '#666',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#222',
    backgroundColor: '#111',
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 15,
    color: '#fff',
    backgroundColor: '#1a1a1a',
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: '#0a84ff',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginLeft: 8,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  archivedInputBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: '#222',
    backgroundColor: '#111',
    alignItems: 'center',
  },
  archivedInputText: {
    fontSize: 13,
    color: '#666',
    fontStyle: 'italic',
  },
});