import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { MessageBookmarkView, NeedsYouItemView } from '@beeline/api-contract/phone';
import type { RoomView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { announceNeedsYouChanged } from '@/buzz/needs-you';
import { compactRelativeTime } from '@/buzz/relative-time';
import { CORNER_META_SIZE, CornerGlyph } from '@/components/buzz/CornerGlyph';
import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { DesktopRoomInspector } from '@/components/DesktopRoomInspector';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import brand from '@/buzz/brand.json';

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function sourceTitle(bookmark: MessageBookmarkView): string {
  return bookmark.roomName.replace(/^#/, '');
}

function sourceLabel(bookmark: MessageBookmarkView): string {
  return `${bookmark.roomKind === 'corner' ? 'corner ' : '#'}${sourceTitle(bookmark)}`;
}

/** The message a tray row points at: what the desktop pane opens. */
type Target = {
  readonly messageId: string;
  readonly roomId: string;
  readonly workspaceId: string;
};

type Row =
  | { readonly key: string; readonly type: 'head'; readonly title: string; readonly count: number }
  | { readonly key: string; readonly type: 'needs'; readonly item: NeedsYouItemView }
  | { readonly key: string; readonly type: 'needs-empty' }
  | { readonly key: string; readonly type: 'saved'; readonly bookmark: MessageBookmarkView }
  | { readonly key: string; readonly type: 'saved-empty' };

/**
 * The tray: exactly two sections, Needs you then Saved. Needs you is the
 * server's per-person projection (`readNeedsYou`); Saved is every bookmark,
 * newest first. Opening a Needs-you cell counts as handling it — someone who
 * wants to come back to it bookmarks it.
 */
export default function TrayScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === 'web' && width >= 760;
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const workspaceId = first(params.communityId);
  const [needs, setNeeds] = useState<readonly NeedsYouItemView[]>([]);
  const [bookmarks, setBookmarks] = useState<readonly MessageBookmarkView[]>([]);
  const [selected, setSelected] = useState<Target | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<MessageBookmarkView | null>(null);
  const [client, setClient] = useState<RoomViewClient | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [inspectRoom, setInspectRoom] = useState<RoomView | null>(null);
  const [paneCornerId, setPaneCornerId] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    setNow(Date.now());
    // Each section reads on its own: a failed Saved read must not hide what
    // needs the person, and the other way round.
    const [needsResult, savedResult] = await Promise.allSettled([
      monolithPhoneOperation('readNeedsYou', { workspaceId }),
      monolithPhoneOperation('listMessageBookmarks', { workspaceId }),
    ]);
    if (needsResult.status === 'fulfilled') setNeeds(needsResult.value.items);
    if (savedResult.status === 'fulfilled') setBookmarks(savedResult.value.bookmarks);
    const failed = [needsResult, savedResult].find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected')
      setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
    setLoading(false);
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), 6_000);
    return () => clearTimeout(timer);
  }, [removed]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity || cancelled) return;
      const http = new RoomViewClient({
        baseUrl: await getEffectiveRelayUrl(),
        identity,
      });
      if (cancelled) return;
      if (desktop) setClient(http);
      try {
        const workspace = await http.workspace(workspaceId);
        if (!cancelled) setWorkspaceName(workspace.workspace.name);
      } catch {
        if (!cancelled) setWorkspaceName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop, workspaceId]);

  const selectedUnavailable = selected
    ? bookmarks.some((bookmark) => bookmark.messageId === selected.messageId && !bookmark.available)
    : false;
  useEffect(() => {
    if (!desktop || !client || !selected || selectedUnavailable) {
      setInspectRoom(null);
      setPaneCornerId(null);
      setInspectError(null);
      return;
    }
    let cancelled = false;
    setInspectError(null);
    setPaneCornerId(selected.roomId);
    void (async () => {
      try {
        const source = await client.room(selected.roomId);
        if (cancelled) return;
        const workRoom =
          source.parent?.id && source.parent.id !== source.room.id
            ? await client.room(source.parent.id)
            : source;
        if (cancelled) return;
        setInspectRoom(workRoom);
        setPaneCornerId(source.room.id);
      } catch (cause) {
        if (cancelled) return;
        setInspectRoom(null);
        setInspectError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, desktop, selected, selectedUnavailable]);

  const open = useCallback(
    (target: Target, via: 'bookmark' | 'needs-you') => {
      router.push({
        pathname: '/beeline/chat/[channelId]',
        params: {
          channelId: target.roomId,
          communityId: target.workspaceId,
          notificationResponseId: `${via}:${target.messageId}`,
          notificationMessageId: target.messageId,
        },
      } as Href);
    },
    [router],
  );

  const openInMain = useCallback(
    (cornerId: string) => {
      if (inspectRoom && cornerId !== inspectRoom.room.id) {
        router.push(cornerHref(cornerId, inspectRoom.room.id));
        return;
      }
      if (selected && cornerId === selected.roomId) {
        open(
          selected,
          bookmarks.some((bookmark) => bookmark.messageId === selected.messageId)
            ? 'bookmark'
            : 'needs-you',
        );
        return;
      }
      router.push({
        pathname: '/beeline/chat/[channelId]',
        params: {
          channelId: cornerId,
          ...(selected?.workspaceId ? { communityId: selected.workspaceId } : {}),
        },
      } as Href);
    },
    [bookmarks, inspectRoom, open, router, selected],
  );

  /** Tapped or dismissed: the cell leaves this tray, and every other device's. */
  const clear = useCallback(async (item: NeedsYouItemView) => {
    setNeeds((current) => current.filter((entry) => entry.messageId !== item.messageId));
    try {
      await monolithPhoneOperation('clearNeedsYou', {
        workspaceId: item.workspaceId,
        messageId: item.messageId,
      });
      announceNeedsYouChanged();
    } catch (cause) {
      setNeeds((current) =>
        [item, ...current].sort((left, right) => right.createdAt - left.createdAt),
      );
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const openNeed = useCallback(
    (item: NeedsYouItemView) => {
      void clear(item);
      if (desktop) setSelected(item);
      else open(item, 'needs-you');
    },
    [clear, desktop, open],
  );

  const dismissNeed = useCallback(
    (item: NeedsYouItemView) => {
      AccessibilityInfo.announceForAccessibility('Dismissed from Needs you');
      void clear(item);
    },
    [clear],
  );

  const remove = useCallback(async (bookmark: MessageBookmarkView) => {
    setBookmarks((current) => current.filter((item) => item.messageId !== bookmark.messageId));
    setRemoved(bookmark);
    AccessibilityInfo.announceForAccessibility('Bookmark removed. Undo available.');
    try {
      await monolithPhoneOperation('setMessageBookmark', {
        roomId: bookmark.roomId,
        messageId: bookmark.messageId,
        bookmarked: false,
      });
    } catch (cause) {
      setRemoved(null);
      setBookmarks((current) => [bookmark, ...current]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const undo = useCallback(async () => {
    if (!removed?.available) return;
    const bookmark = removed;
    setRemoved(null);
    setBookmarks((current) => [bookmark, ...current]);
    AccessibilityInfo.announceForAccessibility('Bookmark restored');
    try {
      await monolithPhoneOperation('setMessageBookmark', {
        roomId: bookmark.roomId,
        messageId: bookmark.messageId,
        bookmarked: true,
      });
    } catch (cause) {
      setBookmarks((current) => current.filter((item) => item.messageId !== bookmark.messageId));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [removed]);

  const rows = useMemo((): Row[] => {
    if (loading) return [];
    return [
      { key: 'head-needs', type: 'head', title: 'Needs you', count: needs.length },
      ...(needs.length
        ? needs.map((item): Row => ({ key: `needs-${item.messageId}`, type: 'needs', item }))
        : [{ key: 'needs-empty', type: 'needs-empty' } as const]),
      { key: 'head-saved', type: 'head', title: 'Saved', count: bookmarks.length },
      ...(bookmarks.length
        ? bookmarks.map((bookmark): Row => ({
            key: `saved-${bookmark.messageId}`,
            type: 'saved',
            bookmark,
          }))
        : [{ key: 'saved-empty', type: 'saved-empty' } as const]),
    ];
  }, [bookmarks, loading, needs]);

  const renderSaved = (bookmark: MessageBookmarkView) => (
    <Pressable
      accessibilityLabel={`${sourceLabel(bookmark)}, ${bookmark.author?.name ?? 'Unavailable message'}`}
      accessibilityRole={bookmark.available || desktop ? 'button' : undefined}
      accessibilityState={
        desktop ? { selected: selected?.messageId === bookmark.messageId } : undefined
      }
      // A desktop pane explains an unavailable source; a phone has nowhere to go.
      onPress={
        desktop
          ? () => setSelected(bookmark)
          : bookmark.available
            ? () => open(bookmark, 'bookmark')
            : undefined
      }
      style={({ pressed }) => [
        styles.row,
        desktop && selected?.messageId === bookmark.messageId && styles.rowSelected,
        pressed && styles.rowSelected,
        !bookmark.available && styles.rowUnavailable,
      ]}
      testID={`bookmark-${bookmark.messageId}`}
    >
      <View style={styles.originLine} testID={`bookmark-save-line-${bookmark.messageId}`}>
        <View style={styles.originSource}>
          {bookmark.roomKind === 'corner' ? (
            <CornerGlyph
              size={CORNER_META_SIZE}
              testID={`bookmark-corner-mark-${bookmark.messageId}`}
            />
          ) : (
            <Text style={styles.originSigil}>#</Text>
          )}
          <Text numberOfLines={1} style={styles.origin}>
            {sourceTitle(bookmark)}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.time}>
          SAVED {compactRelativeTime(bookmark.bookmarkedAt, now)}
        </Text>
      </View>
      <Text numberOfLines={1} style={styles.author}>
        {bookmark.available ? bookmark.author?.name : 'Source unavailable'}
      </Text>
      {bookmark.available ? (
        <Text numberOfLines={desktop ? 2 : 3} style={styles.excerpt}>
          {bookmark.text}
        </Text>
      ) : (
        <Text style={styles.unavailable}>Deleted or no longer accessible</Text>
      )}
      <View style={styles.rowFooter}>
        {!desktop ? <Text style={styles.open}>OPEN →</Text> : null}
        {desktop && bookmark.available ? (
          <Pressable
            accessibilityLabel="Remove bookmark"
            accessibilityRole="button"
            onPress={(event) => {
              event.stopPropagation();
              void remove(bookmark);
            }}
            style={styles.remove}
          >
            <Text style={styles.removeText}>REMOVE</Text>
          </Pressable>
        ) : null}
      </View>
      {!bookmark.available ? (
        <Pressable
          accessibilityLabel="Remove unavailable bookmark"
          accessibilityRole="button"
          onPress={() => void remove(bookmark)}
          style={styles.remove}
        >
          <Text style={styles.removeText}>REMOVE</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );

  const list = (
    <FlatList
      contentContainerStyle={styles.listContent}
      data={rows}
      keyExtractor={(row) => row.key}
      ListEmptyComponent={
        loading ? (
          <View style={styles.loadingBlock} testID="tray-loader">
            <SurfaceGlyphLoader />
          </View>
        ) : null
      }
      renderItem={({ item: row }) => {
        switch (row.type) {
          case 'head':
            return (
              <View style={styles.sectionHead} testID={`tray-section-${row.key.slice(5)}`}>
                <Text style={styles.sectionTitle}>{row.title}</Text>
                <Text style={styles.sectionCount}>{row.count}</Text>
              </View>
            );
          case 'needs':
            return (
              <View style={styles.cellDivider}>
                <NeedsYouCell
                  desktop={desktop}
                  item={row.item}
                  now={now}
                  onDismiss={dismissNeed}
                  onOpen={openNeed}
                />
              </View>
            );
          case 'needs-empty':
            return (
              <View style={styles.emptyBlock} testID="needs-you-empty">
                <Ionicons
                  color={styles.emptyIcon.color}
                  name="checkmark-circle-outline"
                  size={22}
                />
                <Text style={styles.emptyTitle}>Nothing needs you</Text>
                <Text style={styles.empty}>
                  Nobody has tagged you with a question or a request.
                </Text>
              </View>
            );
          case 'saved':
            return renderSaved(row.bookmark);
          case 'saved-empty':
            return (
              <View style={styles.emptyBlock} testID="bookmarks-empty">
                <Ionicons color={styles.emptyIcon.color} name="bookmark-outline" size={22} />
                <Text style={styles.emptyTitle}>No bookmarks yet</Text>
                {/* One instruction, for the surface doing the reading: the desktop
                    strip needs a pointer over the row, and there is no long press
                    to offer there. */}
                <Text style={styles.empty}>
                  {desktop
                    ? 'Hover a message and press its bookmark mark.'
                    : 'Long press a message and pick Bookmark.'}
                </Text>
              </View>
            );
        }
      }}
      style={[styles.list, desktop && styles.desktopList]}
      testID="tray-list"
    />
  );

  const selectedBookmark = selected
    ? bookmarks.find((bookmark) => bookmark.messageId === selected.messageId)
    : undefined;
  const pane =
    desktop && selected && inspectRoom && client ? (
      <DesktopRoomInspector
        room={inspectRoom}
        client={client}
        selectedCornerId={paneCornerId}
        focusMessageId={paneCornerId === selected.roomId ? selected.messageId : null}
        onSelectCorner={setPaneCornerId}
        onOpenInMain={openInMain}
        onClose={() => setSelected(null)}
        onNewCorner={() => undefined}
      />
    ) : desktop ? (
      <View style={styles.paneFallback} testID="tray-pane">
        {selectedBookmark && !selectedBookmark.available ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>Source unavailable</Text>
            <Text style={styles.empty}>This bookmark no longer exposes message content.</Text>
            <Pressable
              accessibilityLabel="Remove unavailable bookmark"
              accessibilityRole="button"
              onPress={() => void remove(selectedBookmark)}
              style={styles.remove}
            >
              <Text style={styles.removeText}>REMOVE</Text>
            </Pressable>
          </View>
        ) : selected && inspectError ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>Could not open this corner</Text>
            <Text style={styles.empty}>{inspectError}</Text>
          </View>
        ) : selected ? (
          <View style={styles.loadingBlock} testID="tray-corner-loader">
            <SurfaceGlyphLoader />
          </View>
        ) : null}
      </View>
    ) : null;

  return (
    <View style={[styles.screen, { paddingTop: desktop ? 0 : insets.top }]}>
      <PageHeader
        backAccessibilityLabel="Back to Rooms"
        eyebrow={workspaceName ?? 'Workspace'}
        onBack={desktop ? undefined : () => router.back()}
        testID="tray-header"
        title="Tray"
        trailing={`${needs.length} NEED YOU · ${bookmarks.length} SAVED`}
      />
      {error ? (
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.error}>
          <Text style={styles.errorText}>{error} · Retry</Text>
        </Pressable>
      ) : null}
      <View style={styles.body}>
        {list}
        {pane}
      </View>
      {removed ? (
        <View accessibilityLiveRegion="polite" style={styles.undo} testID="bookmark-undo">
          <Text style={styles.undoText}>Bookmark removed</Text>
          {removed.available ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void undo()}
              style={styles.undoAction}
            >
              <Text style={styles.undoActionText}>UNDO</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.buzz.bgBase },
  body: { flex: 1, flexDirection: 'row' },
  list: { flex: 1 },
  desktopList: {
    maxWidth: 390,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.buzz.border,
  },
  listContent: { paddingBottom: 24 },
  sectionHead: {
    minHeight: 30,
    marginTop: 22,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  sectionTitle: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  sectionCount: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  cellDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  row: {
    minHeight: 128,
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  rowSelected: { backgroundColor: theme.buzz.bgHighlight },
  rowUnavailable: { opacity: 0.68 },
  originLine: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  originSource: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  originSigil: { ...theme.buzz.type.meta, color: brand.mark },
  origin: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary },
  time: { ...theme.buzz.type.meta, flexShrink: 0, color: theme.buzz.ledgerQuiet },
  author: {
    ...theme.buzz.type.meta,
    color: theme.buzz.accent,
    marginTop: 12,
  },
  excerpt: {
    ...theme.buzz.type.body,
    color: theme.buzz.textSecondary,
    marginTop: 5,
  },
  unavailable: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    marginTop: 5,
  },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  open: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
  remove: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  removeText: { ...theme.buzz.type.sectionHead, color: theme.buzz.textSecondary },
  paneFallback: { flex: 1, justifyContent: 'center' },
  loadingBlock: { padding: 28, alignItems: 'center', justifyContent: 'center' },
  emptyBlock: { padding: 28, alignItems: 'flex-start', justifyContent: 'center' },
  emptyIcon: { color: theme.buzz.accent },
  emptyTitle: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    marginTop: 10,
  },
  empty: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    marginTop: 6,
  },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  undo: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    backgroundColor: theme.buzz.bgTerminal,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
  },
  undoText: {
    ...theme.buzz.type.meta,
    flex: 1,
    color: theme.buzz.textPrimary,
  },
  undoAction: { minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  undoActionText: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
}));
