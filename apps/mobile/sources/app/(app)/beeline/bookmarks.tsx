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
import type { MessageBookmarkView } from '@beeline/api-contract/phone';
import type { RoomView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerHref } from '@/buzz/corner-navigation';
import { compactRelativeTime } from '@/buzz/relative-time';
import { publishBookmarkChange } from '@/buzz/bookmark-events';
import { CORNER_META_SIZE, CornerGlyph } from '@/components/buzz/CornerGlyph';
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

export default function BookmarksScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === 'web' && width >= 760;
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const workspaceId = first(params.communityId);
  const [bookmarks, setBookmarks] = useState<readonly MessageBookmarkView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<MessageBookmarkView | null>(null);
  const [client, setClient] = useState<RoomViewClient | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [inspectRoom, setInspectRoom] = useState<RoomView | null>(null);
  const [paneCornerId, setPaneCornerId] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const result = await monolithPhoneOperation('listMessageBookmarks', { workspaceId });
      setBookmarks(result.bookmarks);
      setSelectedId((current) =>
        result.bookmarks.some((bookmark) => bookmark.messageId === current)
          ? current
          : (result.bookmarks[0]?.messageId ?? null),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
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

  const selected = useMemo(
    () => bookmarks.find((bookmark) => bookmark.messageId === selectedId) ?? null,
    [bookmarks, selectedId],
  );

  useEffect(() => {
    if (!desktop || !client || !selected?.available) {
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
  }, [client, desktop, selected]);

  const open = useCallback(
    (bookmark: MessageBookmarkView) => {
      if (!bookmark.available) return;
      router.push({
        pathname: '/beeline/chat/[channelId]',
        params: {
          channelId: bookmark.roomId,
          communityId: bookmark.workspaceId,
          notificationResponseId: `bookmark:${bookmark.messageId}`,
          notificationMessageId: bookmark.messageId,
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
      if (selected?.available && cornerId === selected.roomId) {
        open(selected);
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
    [inspectRoom, open, router, selected],
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
      publishBookmarkChange({ workspaceId: bookmark.workspaceId, bookmarked: false });
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
      publishBookmarkChange({ workspaceId: bookmark.workspaceId, bookmarked: true });
    } catch (cause) {
      setBookmarks((current) => current.filter((item) => item.messageId !== bookmark.messageId));
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [removed]);

  const list = (
    <FlatList
      contentContainerStyle={styles.listContent}
      data={loading ? [] : bookmarks}
      keyExtractor={(bookmark) => bookmark.messageId}
      ListEmptyComponent={
        loading ? (
          <View style={styles.loadingBlock} testID="bookmarks-loader">
            <SurfaceGlyphLoader />
          </View>
        ) : (
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
        )
      }
      renderItem={({ item: bookmark }) => (
        <Pressable
          accessibilityLabel={`${sourceLabel(bookmark)}, ${bookmark.author?.name ?? 'Unavailable message'}`}
          accessibilityRole={bookmark.available ? 'button' : undefined}
          accessibilityState={
            bookmark.available ? { selected: selectedId === bookmark.messageId } : undefined
          }
          onPress={
            bookmark.available
              ? () => (desktop ? setSelectedId(bookmark.messageId) : open(bookmark))
              : undefined
          }
          style={({ pressed }) => [
            styles.row,
            desktop && selectedId === bookmark.messageId && styles.rowSelected,
            pressed && styles.rowSelected,
            !bookmark.available && styles.rowUnavailable,
          ]}
          testID={`bookmark-${bookmark.messageId}`}
        >
          <View style={styles.originLine}>
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
            <Text style={styles.time}>
              {compactRelativeTime(bookmark.messageCreatedAt, Date.now())}
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
            <Text style={styles.saved}>
              SAVED {compactRelativeTime(bookmark.bookmarkedAt, Date.now()).toUpperCase()}
            </Text>
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
      )}
      style={[styles.list, desktop && styles.desktopList]}
      testID="bookmarks-list"
    />
  );

  const pane =
    desktop && selected?.available && inspectRoom && client ? (
      <DesktopRoomInspector
        room={inspectRoom}
        client={client}
        selectedCornerId={paneCornerId}
        focusMessageId={
          selected.available && paneCornerId === selected.roomId ? selected.messageId : null
        }
        onSelectCorner={setPaneCornerId}
        onOpenInMain={openInMain}
        onClose={() => setSelectedId(null)}
        onNewCorner={() => undefined}
      />
    ) : desktop ? (
      <View style={styles.paneFallback} testID="bookmark-pane">
        {selected && !selected.available ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>Source unavailable</Text>
            <Text style={styles.empty}>This bookmark no longer exposes message content.</Text>
            <Pressable
              accessibilityLabel="Remove unavailable bookmark"
              accessibilityRole="button"
              onPress={() => void remove(selected)}
              style={styles.remove}
            >
              <Text style={styles.removeText}>REMOVE</Text>
            </Pressable>
          </View>
        ) : selected?.available && inspectError ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>Could not open this corner</Text>
            <Text style={styles.empty}>{inspectError}</Text>
          </View>
        ) : selected?.available ? (
          <View style={styles.loadingBlock} testID="bookmark-corner-loader">
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
        testID="bookmarks-header"
        title="Bookmarks"
        trailing={`${bookmarks.length} SAVED`}
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
  time: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
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
  saved: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerGhost },
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
