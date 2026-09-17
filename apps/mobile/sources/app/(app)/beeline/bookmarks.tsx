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
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { Typography } from '@/constants/Typography';
import { compactRelativeTime } from '@/buzz/relative-time';
import { publishBookmarkChange } from '@/buzz/bookmark-events';

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function sourceLabel(bookmark: MessageBookmarkView): string {
  return `${bookmark.roomKind === 'corner' ? '◇ ' : '#'}${bookmark.roomName.replace(/^#/, '')}`;
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

  const selected = useMemo(
    () => bookmarks.find((bookmark) => bookmark.messageId === selectedId) ?? null,
    [bookmarks, selectedId],
  );

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
          <Text style={styles.empty}>Loading bookmarks…</Text>
        ) : (
          <View style={styles.emptyBlock} testID="bookmarks-empty">
            <Ionicons color={styles.emptyIcon.color} name="bookmark-outline" size={22} />
            <Text style={styles.emptyTitle}>No bookmarks yet</Text>
            <Text style={styles.empty}>Long press a message, or use its desktop action strip.</Text>
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
            <Text numberOfLines={1} style={styles.origin}>
              {sourceLabel(bookmark)}
            </Text>
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

  return (
    <View style={[styles.screen, { paddingTop: desktop ? 0 : insets.top }]}>
      <View style={styles.header}>
        {!desktop ? (
          <Pressable
            accessibilityLabel="Back to Rooms"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.back}
          >
            <Ionicons color={styles.headerTitle.color} name="chevron-back" size={22} />
          </Pressable>
        ) : null}
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>Bookmarks</Text>
          <Text style={styles.headerMeta}>PRIVATE · {bookmarks.length} SAVED</Text>
        </View>
      </View>
      {error ? (
        <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.error}>
          <Text style={styles.errorText}>{error} · Retry</Text>
        </Pressable>
      ) : null}
      <View style={styles.body}>
        {list}
        {desktop ? (
          <View style={styles.preview} testID="bookmark-preview">
            {selected?.available ? (
              <>
                <Text style={styles.previewPath}>{sourceLabel(selected)}</Text>
                <Text style={styles.previewAuthor}>{selected.author?.name}</Text>
                <Text style={styles.previewText}>{selected.text}</Text>
                <View style={styles.previewFooter}>
                  <Pressable
                    accessibilityLabel="Remove bookmark"
                    accessibilityRole="button"
                    onPress={() => void remove(selected)}
                    style={styles.previewAction}
                  >
                    <Text style={styles.previewActionText}>REMOVE</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Open in ${sourceLabel(selected)}`}
                    accessibilityRole="link"
                    onPress={() => open(selected)}
                    style={styles.previewAction}
                  >
                    <Text style={styles.previewOpen}>OPEN IN {sourceLabel(selected)} →</Text>
                  </Pressable>
                </View>
              </>
            ) : selected ? (
              <View style={styles.emptyBlock}>
                <Text style={styles.emptyTitle}>Source unavailable</Text>
                <Text style={styles.empty}>This bookmark no longer exposes message content.</Text>
                <Pressable onPress={() => void remove(selected)} style={styles.previewAction}>
                  <Text style={styles.previewActionText}>REMOVE</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
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
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
    paddingHorizontal: 12,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { ...Typography.default('semiBold'), color: theme.buzz.textPrimary, fontSize: 16 },
  headerMeta: { ...Typography.mono(), color: theme.buzz.ledgerQuiet, fontSize: 10, marginTop: 2 },
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
  origin: { ...Typography.mono('semiBold'), flex: 1, color: theme.buzz.textPrimary, fontSize: 11 },
  time: { ...Typography.mono(), color: theme.buzz.ledgerQuiet, fontSize: 10 },
  author: {
    ...Typography.default('semiBold'),
    color: theme.buzz.accent,
    fontSize: 14,
    marginTop: 12,
  },
  excerpt: {
    ...Typography.default(),
    color: theme.buzz.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 5,
  },
  unavailable: {
    ...Typography.default(),
    color: theme.buzz.ledgerQuiet,
    fontSize: 14,
    marginTop: 5,
  },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  saved: { ...Typography.mono(), color: theme.buzz.ledgerGhost, fontSize: 9, letterSpacing: 0.5 },
  open: { ...Typography.mono('semiBold'), color: theme.buzz.accent, fontSize: 10 },
  remove: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', marginTop: 4 },
  removeText: { ...Typography.mono('semiBold'), color: theme.buzz.textSecondary, fontSize: 10 },
  preview: { flex: 1, padding: 32, justifyContent: 'center' },
  previewPath: { ...Typography.mono('semiBold'), color: theme.buzz.ledgerQuiet, fontSize: 11 },
  previewAuthor: {
    ...Typography.default('semiBold'),
    color: theme.buzz.accent,
    fontSize: 16,
    marginTop: 22,
  },
  previewText: {
    ...Typography.default(),
    color: theme.buzz.textPrimary,
    fontSize: 18,
    lineHeight: 28,
    marginTop: 10,
    maxWidth: 720,
  },
  previewFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.buzz.border,
    paddingTop: 14,
  },
  previewAction: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  previewActionText: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.textSecondary,
    fontSize: 10,
  },
  previewOpen: { ...Typography.mono('semiBold'), color: theme.buzz.accent, fontSize: 10 },
  emptyBlock: { padding: 28, alignItems: 'flex-start', justifyContent: 'center' },
  emptyIcon: { color: theme.buzz.accent },
  emptyTitle: {
    ...Typography.default('semiBold'),
    color: theme.buzz.textPrimary,
    fontSize: 16,
    marginTop: 10,
  },
  empty: {
    ...Typography.default(),
    color: theme.buzz.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 6,
  },
  error: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...Typography.default('semiBold'), color: theme.buzz.textSecondary, fontSize: 13 },
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
    ...Typography.default('semiBold'),
    flex: 1,
    color: theme.buzz.textPrimary,
    fontSize: 14,
  },
  undoAction: { minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  undoActionText: { ...Typography.mono('semiBold'), color: theme.buzz.accent, fontSize: 10 },
}));
