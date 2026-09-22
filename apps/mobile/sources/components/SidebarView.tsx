import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { type Href, useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  type ChatListView,
  type CornerListItem,
  type RoomViewIdentity,
  type WorkspaceListView,
} from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';
import { navigateToRoom } from '@/buzz/corner-navigation';
import {
  loadActiveCommunityId,
  loadLastViewedChannel,
  saveActiveCommunityId,
  subscribeActiveCommunityId,
} from '@/buzz/community-storage';
import { compactRelativeTime } from '@/buzz/relative-time';
import { useHeaderHeight, useIsDesktop } from '@/utils/responsive';
import {
  MEMBERS_LABEL,
  ROOM_LABEL,
  ROOMS_LABEL,
  WORKSPACE_LABEL,
  WORKSPACES_LABEL,
  formatRoomCornerCount,
} from '@/buzz/vocabulary';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import {
  displayGroupedCornerTitle,
  NO_ACTIVITY_PREVIEW,
  roomListSections,
  roomRowName,
  roomRowNeedsAttention,
  roomRowPreview,
} from '@/buzz/room-list-row';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { CommunitySwitcherTrigger } from '@/components/buzz/CommunityRail';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { MembersGlyph } from '@/components/buzz/MembersGlyph';
import { DesktopWorkspaceRail } from '@/components/buzz/DesktopWorkspaceRail';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { selectDesktopWorkCorner, writeDesktopCornerDrag } from '@/buzz/desktop-work-pane';
import {
  desktopWorkspaceRoute,
  loadDesktopRoomCornersExpanded,
  saveDesktopRoomCornersExpanded,
} from '@/buzz/desktop-workbench-state';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { subscribeBookmarkChanges } from '@/buzz/bookmark-events';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from '@/components/buzz/ChevronGlyph';

function selectedRoomId(pathname: string): string | null {
  const prefix = '/beeline/chat/';
  if (!pathname.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(pathname.slice(prefix.length).split('/')[0]!);
  } catch {
    return pathname.slice(prefix.length).split('/')[0] ?? null;
  }
}

function firstParam(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value)?.trim() || null;
}

function DesktopCornerDragSource({
  roomId,
  cornerId,
  children,
}: React.PropsWithChildren<{ roomId: string; cornerId: string }>) {
  if (Platform.OS !== 'web') return children;
  return React.createElement(
    'div',
    {
      draggable: true,
      onDragStart: (event: React.DragEvent<HTMLElement>) =>
        writeDesktopCornerDrag(event.dataTransfer, { roomId, cornerId }),
    },
    children,
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.divider,
    backgroundColor: theme.colors.groupped.background,
  },
  desktopWorkspaceHeader: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  workspaceBlock: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  workspaceRow: { flexDirection: 'row', gap: 6 },
  workspaceButton: {
    minWidth: 34,
    maxWidth: 150,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.divider,
  },
  workspaceSelected: { backgroundColor: theme.colors.surfaceSelected },
  workspaceText: { ...theme.buzz.type.meta, color: theme.colors.textSecondary },
  workspaceTextSelected: { ...theme.buzz.type.bodyStrong, color: theme.colors.text },
  searchWrap: {
    marginHorizontal: 12,
    marginVertical: 10,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.divider,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
  },
  searchWrapFocused: { borderColor: theme.buzz.accent },
  search: {
    ...theme.buzz.type.meta,
    flex: 1,
    color: theme.colors.text,
    outlineStyle: 'none',
  } as any,
  shortcut: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
  roomRowShell: { position: 'relative' },
  roomRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  roomRowWithCornerToggle: { paddingRight: 52 },
  roomCornersToggle: {
    position: 'absolute',
    right: 4,
    top: 10,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 3,
  },
  roomCornersTogglePressed: { backgroundColor: theme.colors.surfaceSelected },
  roomCornersToggleGlyph: { color: theme.colors.textSecondary },
  roomRowCompact: { alignItems: 'center' },
  roomRowSelected: { backgroundColor: theme.colors.surfaceSelected },
  roomStateSlot: { width: 7, height: 7, marginTop: 7 },
  roomStateSlotCompact: { marginTop: 0 },
  roomStateMark: { width: 7, height: 7 },
  roomStateNeedsYou: { backgroundColor: theme.colors.textLink },
  roomStateWorking: { backgroundColor: theme.colors.textSecondary },
  cornerStateWaiting: { backgroundColor: theme.buzz.accent },
  cornerStateQuiet: { backgroundColor: theme.buzz.ledgerQuiet },
  cornerStateGhost: { backgroundColor: theme.buzz.ledgerGhost },
  roomCopy: { flex: 1, minWidth: 0 },
  roomTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  roomTitle: { ...theme.buzz.type.bodyStrong, flex: 1, color: theme.colors.text },
  roomSigil: { color: theme.colors.textLink },
  roomTime: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  roomFact: { ...theme.buzz.type.meta, marginTop: 3, color: theme.colors.textSecondary },
  cornerRow: {
    minHeight: 45,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingLeft: 34,
    paddingRight: 16,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  cornerTitle: { ...theme.buzz.type.meta, color: theme.colors.text, flex: 1 },
  cornerMeta: { ...theme.buzz.type.machine, color: theme.colors.textSecondary, marginTop: 2 },
  cornerMetaWaiting: { color: theme.buzz.accent },
  cornerMetaQuiet: { color: theme.buzz.ledgerQuiet },
  cornerMetaGhost: { color: theme.buzz.ledgerGhost },
  previewSelf: { color: theme.colors.textSecondary },
  previewAuthor: { color: theme.colors.textLink },
  empty: {
    ...theme.buzz.type.meta,
    paddingHorizontal: 18,
    paddingVertical: 24,
    color: theme.colors.textSecondary,
  },
  loading: {
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 24,
    gap: 8,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
  },
  settingsText: { ...theme.buzz.type.sectionHead, color: theme.colors.text },
  desktopWorkspaceHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  desktopWorkspaceHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  headerGlyph: {
    minHeight: 32,
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 3,
  },
  headerGlyphColor: { color: theme.colors.textSecondary },
  settingsFaceSlot: { width: 22, height: 22, borderRadius: 11 },
  settingsViewerName: {
    ...theme.buzz.type.meta,
    color: theme.colors.textSecondary,
    flexShrink: 1,
  },
}));

/** One server-backed desktop pane for Workspace and Room movement. */
export const SidebarView = React.memo(function SidebarView() {
  const styles = stylesheet;
  const safeArea = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const isDesktop = useIsDesktop();
  const router = useRouter();
  const pathname = usePathname();
  const routeParams = useGlobalSearchParams<{
    communityId?: string | string[];
    parent?: string | string[];
  }>();
  const routeWorkspaceId = firstParam(routeParams.communityId);
  // A corner promoted into the main pane still belongs beneath its parent
  // Room in the permanent list. The route's parent hint is presentation-only,
  // but it is enough to keep that already-loaded navigation family expanded.
  const activeRoomId = firstParam(routeParams.parent) ?? selectedRoomId(pathname);
  const searchRef = React.useRef<TextInput>(null);
  const workspaceIdRef = React.useRef<string | null>(null);
  const [client, setClient] = React.useState<RoomViewClient | null>(null);
  const [identityPubkey, setIdentityPubkey] = React.useState<string | null>(null);
  const [viewerIdentity, setViewerIdentity] = React.useState<RoomViewIdentity | null>(null);
  const [workspaces, setWorkspaces] = React.useState<WorkspaceListView['workspaces']>([]);
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [surface, setSurface] = React.useState<ChatListView | null>(null);
  const [query, setQuery] = React.useState('');
  const [searchFocused, setSearchFocused] = React.useState(false);
  const [navigationError, setNavigationError] = React.useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = React.useState(false);
  const [attentionWorkspaceIds, setAttentionWorkspaceIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [workspaceRoomCounts, setWorkspaceRoomCounts] = React.useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [activeCorners, setActiveCorners] = React.useState<readonly CornerListItem[]>([]);
  const [roomCornersExpanded, setRoomCornersExpanded] = React.useState<
    Readonly<Record<string, boolean>>
  >({});
  const [bookmarkCount, setBookmarkCount] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setNavigationError(null);
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity) return;
      const http = new RoomViewClient({ baseUrl: await getEffectiveRelayUrl(), identity });
      const list = await http.workspaces();
      const stored = await loadActiveCommunityId(identity.publicKey);
      const selected = list.workspaces.some((workspace) => workspace.id === stored)
        ? stored
        : (list.workspaces[0]?.id ?? null);
      if (cancelled) return;
      setClient(http);
      setIdentityPubkey(identity.publicKey);
      setViewerIdentity(list.viewer);
      setWorkspaces(list.workspaces);
      workspaceIdRef.current = selected;
      setWorkspaceId(selected);
    })().catch(() => {
      if (!cancelled) setNavigationError(`Could not load ${WORKSPACE_LABEL.toLowerCase()}s.`);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  React.useEffect(() => {
    if (!client || !workspaceId) return;
    let cancelled = false;
    setNavigationError(null);
    void client
      .chats(workspaceId)
      .then((chats) => {
        if (!cancelled) setSurface(chats);
      })
      .catch(() => {
        if (!cancelled) setNavigationError(`Could not load ${ROOMS_LABEL.toLowerCase()}.`);
      });
    return () => {
      cancelled = true;
    };
  }, [client, pathname, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId) {
      setBookmarkCount(0);
      return;
    }
    let cancelled = false;
    void monolithPhoneOperation('listMessageBookmarks', { workspaceId })
      .then((result) => {
        if (!cancelled) setBookmarkCount(result.bookmarks.length);
      })
      .catch(() => {
        if (!cancelled) setBookmarkCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, workspaceId]);

  React.useEffect(
    () =>
      subscribeBookmarkChanges((change) => {
        if (change.workspaceId !== workspaceId) return;
        setBookmarkCount((count) => Math.max(0, count + (change.bookmarked ? 1 : -1)));
      }),
    [workspaceId],
  );

  React.useEffect(() => {
    if (!isDesktop || !client || !activeRoomId) {
      setActiveCorners([]);
      return;
    }
    let cancelled = false;
    void client
      .corners(activeRoomId)
      .then((view) => {
        if (!cancelled)
          setActiveCorners(view.corners.filter((corner) => corner.state !== 'archived'));
      })
      .catch(() => {
        if (!cancelled) setActiveCorners([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRoomId, client, isDesktop, pathname]);

  React.useEffect(() => {
    if (!isDesktop || !activeRoomId) return;
    let cancelled = false;
    void loadDesktopRoomCornersExpanded(activeRoomId).then((expanded) => {
      if (cancelled) return;
      setRoomCornersExpanded((current) =>
        current[activeRoomId] === undefined ? { ...current, [activeRoomId]: expanded } : current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activeRoomId, isDesktop]);

  React.useEffect(() => {
    if (!identityPubkey) return;
    return subscribeActiveCommunityId(identityPubkey, (nextWorkspaceId) => {
      if (!nextWorkspaceId || !workspaces.some((workspace) => workspace.id === nextWorkspaceId)) {
        return;
      }
      if (workspaceIdRef.current === nextWorkspaceId) return;
      workspaceIdRef.current = nextWorkspaceId;
      setWorkspaceId(nextWorkspaceId);
      setSurface(null);
      setQuery('');
    });
  }, [identityPubkey, workspaces]);

  React.useEffect(() => {
    if (
      !routeWorkspaceId ||
      !workspaces.some((workspace) => workspace.id === routeWorkspaceId) ||
      workspaceIdRef.current === routeWorkspaceId
    ) {
      return;
    }
    workspaceIdRef.current = routeWorkspaceId;
    setWorkspaceId(routeWorkspaceId);
    setSurface(null);
    setQuery('');
    if (identityPubkey) void saveActiveCommunityId(identityPubkey, routeWorkspaceId);
  }, [identityPubkey, routeWorkspaceId, workspaces]);

  React.useEffect(() => {
    if (!client || !workspaces.length) return;
    let cancelled = false;
    void Promise.all(
      workspaces.map(async (workspace) => {
        const chats = await client.chats(workspace.id).catch(() => null);
        return [
          workspace.id,
          Boolean(chats?.chats.some((item) => roomRowNeedsAttention(item))),
          chats?.chats.length ?? 0,
        ] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setAttentionWorkspaceIds(
        new Set(results.filter(([, attention]) => attention).map(([id]) => id)),
      );
      setWorkspaceRoomCounts(new Map(results.map(([id, , roomCount]) => [id, roomCount])));
    });
    return () => {
      cancelled = true;
    };
  }, [client, pathname, workspaces]);

  const filteredChats = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return surface?.chats ?? [];
    return (surface?.chats ?? []).filter((item) =>
      `${item.room.name} ${item.latestMessage?.text ?? ''}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, surface?.chats]);
  const filteredChatSections = React.useMemo(
    () => roomListSections(filteredChats),
    [filteredChats],
  );
  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  // ChatListView carries workspace.role; the server's viewer.permissions.manage
  // is the same boolean (`role !== 'member'`). Do not invent a second gate.
  const canManageWorkspace = isWorkspaceManagerRole(surface?.workspace.role);
  const viewerIsAgent = surface?.viewer.kind === 'agent';
  const canCreateRoom = !viewerIsAgent && canManageWorkspace;
  const workbenchSelected = pathname.startsWith('/beeline/settings/workbench');
  const workspaceSettingsSelected = pathname.startsWith('/beeline/settings/workspace');
  const bookmarksSelected = pathname.startsWith('/beeline/bookmarks');
  const membersSelected = pathname.startsWith('/beeline/members');
  const profileSettingsSelected =
    pathname.startsWith('/beeline/settings') && !workbenchSelected && !workspaceSettingsSelected;
  const otherWorkspaceNeedsAttention = [...attentionWorkspaceIds].some((id) => id !== workspaceId);
  const openRoom = React.useCallback(
    (roomId: string) => {
      dispatchRoomOpenTap(roomId, {
        navigate: (id) => {
          navigateToRoom(router, id);
        },
      });
    },
    [router],
  );

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (event.key === 'Escape' && workspaceSwitcherOpen) {
        event.preventDefault();
        setWorkspaceSwitcherOpen(false);
        return;
      }
      if (
        !editing &&
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        setWorkspaceSwitcherOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!editing && event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const index = Math.max(
          0,
          filteredChats.findIndex((item) => item.room.id === activeRoomId),
        );
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = filteredChats[(index + delta + filteredChats.length) % filteredChats.length];
        if (next) openRoom(next.room.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeRoomId, filteredChats, openRoom, workspaceSwitcherOpen]);

  const selectWorkspace = React.useCallback(
    (nextId: string) => {
      setWorkspaceSwitcherOpen(false);
      if (nextId === workspaceIdRef.current) return;
      workspaceIdRef.current = nextId;
      setWorkspaceId(nextId);
      setSurface(null);
      setQuery('');
      if (identityPubkey) void saveActiveCommunityId(identityPubkey, nextId);
      if (client) {
        setNavigationError(null);
        void Promise.all([
          client.chats(nextId),
          identityPubkey ? loadLastViewedChannel(identityPubkey, nextId) : Promise.resolve(null),
        ])
          .then(([chats, lastViewedRoomId]) => {
            if (workspaceIdRef.current !== nextId) return;
            setSurface(chats);
            router.push(
              desktopWorkspaceRoute(
                nextId,
                chats.chats.map((chat) => chat.room.id),
                lastViewedRoomId,
              ) as Href,
            );
          })
          .catch(() => {
            if (workspaceIdRef.current === nextId)
              setNavigationError(`Could not load ${ROOMS_LABEL.toLowerCase()}.`);
          });
      }
    },
    [client, identityPubkey, router],
  );

  return (
    <View
      style={[styles.container, { paddingTop: safeArea.top + (isDesktop ? 0 : headerHeight) }]}
      testID="desktop-navigation-pane"
    >
      {isDesktop ? (
        <View style={styles.desktopWorkspaceHeader}>
          <View style={styles.desktopWorkspaceHeaderRow}>
            <CommunitySwitcherTrigger
              community={activeWorkspace ? workspaceRailItem(activeWorkspace) : null}
              expanded={workspaceSwitcherOpen}
              onPress={() => setWorkspaceSwitcherOpen((open) => !open)}
              attention={otherWorkspaceNeedsAttention}
              pickerTitle={WORKSPACES_LABEL}
            />
            <View style={styles.desktopWorkspaceHeaderActions}>
              {workspaceId ? (
                <Pressable
                  accessibilityLabel={`${WORKSPACE_LABEL} ${MEMBERS_LABEL.toLowerCase()}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: membersSelected }}
                  onPress={() =>
                    router.push({
                      pathname: '/beeline/members',
                      params: { communityId: workspaceId },
                    } as Href)
                  }
                  style={({ pressed }) => [
                    styles.headerGlyph,
                    (membersSelected || pressed) && styles.roomRowSelected,
                  ]}
                  testID="desktop-members"
                >
                  <MembersGlyph
                    color={styles.headerGlyphColor.color}
                    size={16}
                    testID="desktop-members-glyph"
                  />
                </Pressable>
              ) : null}
              {workspaceId ? (
                <Pressable
                  accessibilityLabel={`Bookmarks, ${bookmarkCount} saved message${bookmarkCount === 1 ? '' : 's'}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: bookmarksSelected }}
                  onPress={() =>
                    router.push({
                      pathname: '/beeline/bookmarks',
                      params: { communityId: workspaceId },
                    } as Href)
                  }
                  style={({ pressed }) => [
                    styles.headerGlyph,
                    (bookmarksSelected || pressed) && styles.roomRowSelected,
                  ]}
                  testID="desktop-bookmarks"
                >
                  <Ionicons
                    name="bookmark-outline"
                    size={16}
                    color={styles.headerGlyphColor.color}
                    {...(Platform.OS === 'web' ? { 'aria-hidden': true } : {})}
                  />
                </Pressable>
              ) : null}
              {canManageWorkspace && workspaceId ? (
                <Pressable
                  accessibilityLabel={`Open ${WORKSPACE_LABEL} settings`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: workspaceSettingsSelected }}
                  onPress={() =>
                    router.push({
                      pathname: '/beeline/settings/workspace',
                      params: { communityId: workspaceId },
                    } as Href)
                  }
                  style={({ pressed }) => [
                    styles.headerGlyph,
                    (workspaceSettingsSelected || pressed) && styles.roomRowSelected,
                  ]}
                  testID="desktop-workspace-settings"
                >
                  <Ionicons
                    name="settings-outline"
                    size={16}
                    color={styles.headerGlyphColor.color}
                    {...(Platform.OS === 'web' ? { 'aria-hidden': true } : {})}
                  />
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.workspaceBlock}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.workspaceRow}
          >
            {workspaces.map((workspace) => {
              const selected = workspace.id === workspaceId;
              return (
                <Pressable
                  key={workspace.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => selectWorkspace(workspace.id)}
                  style={[styles.workspaceButton, selected && styles.workspaceSelected]}
                  testID={`desktop-workspace-${workspace.id}`}
                >
                  <Text
                    numberOfLines={1}
                    style={[styles.workspaceText, selected && styles.workspaceTextSelected]}
                  >
                    {workspace.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}
      <>
        <View style={[styles.searchWrap, searchFocused && styles.searchWrapFocused]}>
          <Ionicons
            name="search"
            size={14}
            color={stylesheet.roomTime.color}
            {...(Platform.OS === 'web' ? { 'aria-hidden': true } : {})}
          />
          <TextInput
            ref={searchRef}
            value={query}
            onChangeText={setQuery}
            onBlur={() => setSearchFocused(false)}
            onFocus={() => setSearchFocused(true)}
            accessibilityLabel={
              isDesktop ? `Search ${ROOMS_LABEL} and direct messages` : `Search ${ROOMS_LABEL}`
            }
            placeholder={
              isDesktop ? `Search ${ROOMS_LABEL} and direct messages` : `Search ${ROOMS_LABEL}`
            }
            placeholderTextColor={stylesheet.roomTime.color}
            style={styles.search}
            testID="desktop-room-search"
          />
          <Text style={styles.shortcut} {...(Platform.OS === 'web' ? { 'aria-hidden': true } : {})}>
            ⌘K
          </Text>
        </View>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {navigationError ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setRefreshNonce((value) => value + 1)}
            >
              <Text style={styles.empty}>{navigationError} Select to retry.</Text>
            </Pressable>
          ) : !filteredChats.length ? (
            surface ? (
              <Text style={styles.empty}>
                {query.trim()
                  ? `No ${ROOMS_LABEL.toLowerCase()} or direct messages match this search.`
                  : `No ${ROOMS_LABEL.toLowerCase()} or direct messages yet.`}
              </Text>
            ) : (
              <View style={styles.loading} testID="desktop-rooms-loader">
                <SurfaceGlyphLoader compact />
                <Text style={styles.empty}>
                  Loading {ROOMS_LABEL.toLowerCase()} and direct messages…
                </Text>
              </View>
            )
          ) : (
            filteredChatSections.map((section) => (
              <React.Fragment key={section.kind}>
                <RoomListSectionHeader
                  title={section.kind === 'rooms' ? ROOMS_LABEL : 'Direct messages'}
                  actionTestID={
                    section.kind === 'rooms' ? 'desktop-new-room' : 'desktop-new-direct-message'
                  }
                  actionAccessibilityLabel={
                    section.kind === 'rooms' ? 'Create a new Room' : 'Start a direct message'
                  }
                  onAction={
                    !workspaceId || viewerIsAgent
                      ? undefined
                      : section.kind === 'rooms' && !canCreateRoom
                        ? undefined
                        : () =>
                            router.push({
                              pathname: '/beeline/channels',
                              params:
                                section.kind === 'rooms'
                                  ? { communityId: workspaceId, newRoom: String(Date.now()) }
                                  : { communityId: workspaceId, newDirectMessage: String(Date.now()) },
                            } as Href)
                  }
                />
                {section.data.map((item) => {
                  const rowName = roomRowName(item);
                  const preview = roomRowPreview(item, identityPubkey ?? undefined);
                  const hasPreview = preview.text !== NO_ACTIVITY_PREVIEW;
                  const attention = roomRowNeedsAttention(item);
                  const active = activeRoomId === item.room.id;
                  const cornerCount = formatRoomCornerCount(item.cornerCount);
                  const cornersExpanded = roomCornersExpanded[item.room.id] ?? true;
                  const showCornerToggle = isDesktop && active && Boolean(cornerCount);
                  return (
                    <React.Fragment key={item.room.id}>
                      <View style={styles.roomRowShell}>
                        <Pressable
                          accessibilityLabel={`Open ${item.directMessage ? 'direct message' : ROOM_LABEL} ${rowName.sigil}${rowName.name}`}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                          onPress={() => openRoom(item.room.id)}
                          style={({ pressed }) => [
                            styles.roomRow,
                            showCornerToggle && styles.roomRowWithCornerToggle,
                            !isDesktop && styles.roomRowCompact,
                            active && styles.roomRowSelected,
                            pressed && styles.roomRowSelected,
                          ]}
                          testID={`desktop-room-${item.room.id}`}
                        >
                          <View
                            style={[
                              styles.roomStateSlot,
                              !isDesktop && styles.roomStateSlotCompact,
                            ]}
                            {...(Platform.OS === 'web'
                              ? { 'aria-hidden': true }
                              : { accessibilityElementsHidden: true })}
                          >
                            {(attention || (isDesktop && item.agentState === 'working')) && (
                              <View
                                style={[
                                  styles.roomStateMark,
                                  attention ? styles.roomStateNeedsYou : styles.roomStateWorking,
                                ]}
                                testID={`desktop-room-state-${item.room.id}`}
                              />
                            )}
                          </View>
                          <View style={styles.roomCopy}>
                            <View style={styles.roomTitleLine}>
                              <Text numberOfLines={1} style={styles.roomTitle}>
                                <Text style={styles.roomSigil}>{rowName.sigil}</Text>
                                {rowName.name}
                              </Text>
                              <Text style={styles.roomTime}>
                                {item.latestMessage
                                  ? compactRelativeTime(item.latestMessage.createdAt, Date.now())
                                  : ''}
                              </Text>
                            </View>
                            <Text numberOfLines={1} style={styles.roomFact}>
                              {hasPreview && preview.attribution === 'self' && (
                                <Text style={styles.previewSelf}>you: </Text>
                              )}
                              {hasPreview && preview.attribution === 'other' && (
                                <Text style={styles.previewAuthor}>@{preview.handle}: </Text>
                              )}
                              {preview.text}
                            </Text>
                          </View>
                        </Pressable>
                        {showCornerToggle ? (
                          <Pressable
                            accessibilityLabel={`${cornersExpanded ? 'Hide' : 'Show'} ${cornerCount} in ${rowName.sigil}${rowName.name}`}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: cornersExpanded }}
                            onPress={() => {
                              const expanded = !cornersExpanded;
                              setRoomCornersExpanded((current) => ({
                                ...current,
                                [item.room.id]: expanded,
                              }));
                              void saveDesktopRoomCornersExpanded(item.room.id, expanded);
                            }}
                            style={({ pressed }) => [
                              styles.roomCornersToggle,
                              pressed && styles.roomCornersTogglePressed,
                            ]}
                            testID={`desktop-room-corners-toggle-${item.room.id}`}
                          >
                            <ChevronGlyph
                              color={styles.roomCornersToggleGlyph.color}
                              direction={cornersExpanded ? 'up' : 'down'}
                              size={CHEVRON_ROW_SIZE}
                              testID={`desktop-room-corners-toggle-glyph-${item.room.id}`}
                            />
                          </Pressable>
                        ) : null}
                      </View>
                      {isDesktop &&
                        active &&
                        cornersExpanded &&
                        activeCorners.map((corner) => (
                          <DesktopCornerDragSource
                            key={corner.corner.id}
                            roomId={item.room.id}
                            cornerId={corner.corner.id}
                          >
                            <Pressable
                              accessibilityLabel={`Open corner ${corner.corner.name}`}
                              accessibilityRole="button"
                              onPress={() =>
                                selectDesktopWorkCorner({
                                  roomId: item.room.id,
                                  cornerId: corner.corner.id,
                                })
                              }
                              style={styles.cornerRow}
                              testID={`desktop-corner-${corner.corner.id}`}
                            >
                              <View style={styles.roomStateSlot}>
                                <View
                                  style={[
                                    styles.roomStateMark,
                                    corner.state === 'waiting'
                                      ? styles.cornerStateWaiting
                                      : corner.state === 'archived'
                                        ? styles.cornerStateGhost
                                        : styles.cornerStateQuiet,
                                  ]}
                                />
                              </View>
                              <View style={styles.roomCopy}>
                                <Text numberOfLines={1} style={styles.cornerTitle}>
                                  {displayGroupedCornerTitle(
                                    item.room.name,
                                    corner.corner.name,
                                    corner.corner.id,
                                  )}
                                </Text>
                                <Text
                                  numberOfLines={1}
                                  style={[
                                    styles.cornerMeta,
                                    corner.state === 'waiting'
                                      ? styles.cornerMetaWaiting
                                      : corner.state === 'archived'
                                        ? styles.cornerMetaGhost
                                        : styles.cornerMetaQuiet,
                                  ]}
                                >
                                  {corner.state}
                                </Text>
                              </View>
                            </Pressable>
                          </DesktopCornerDragSource>
                        ))}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))
          )}
        </ScrollView>
        <Pressable
          accessibilityLabel={
            viewerIdentity?.name ? `${viewerIdentity.name} — Settings` : 'Settings'
          }
          accessibilityRole="button"
          accessibilityState={{ selected: profileSettingsSelected }}
          onPress={() => router.push('/beeline/settings' as Href)}
          style={({ pressed }) => [
            styles.settingsRow,
            (profileSettingsSelected || pressed) && styles.roomRowSelected,
          ]}
          testID="profile-settings-navigation"
        >
          {isDesktop ? (
            identityPubkey ? (
              <>
                <IdentityMark
                  seed={identityPubkey}
                  kind="human"
                  size={22}
                  name={viewerIdentity?.name}
                  avatarUrl={viewerIdentity?.avatar}
                  face={viewerIdentity?.face}
                />
                {viewerIdentity?.name ? (
                  <Text
                    numberOfLines={1}
                    style={styles.settingsViewerName}
                    testID="profile-settings-name"
                  >
                    {viewerIdentity.name}
                  </Text>
                ) : null}
              </>
            ) : (
              <View style={styles.settingsFaceSlot} />
            )
          ) : (
            <>
              <Ionicons
                name="person-outline"
                size={18}
                color={stylesheet.settingsText.color}
                {...(Platform.OS === 'web' ? { 'aria-hidden': true } : {})}
              />
              <Text style={styles.settingsText}>SETTINGS</Text>
            </>
          )}
        </Pressable>
      </>
      {isDesktop && (
        <DesktopWorkspaceRail
          activeWorkspaceId={workspaceId}
          onAdd={() => {
            setWorkspaceSwitcherOpen(false);
            router.push('/beeline/community' as Href);
          }}
          onClose={() => setWorkspaceSwitcherOpen(false)}
          onOpenAccount={() => {
            setWorkspaceSwitcherOpen(false);
            router.push('/beeline/settings' as Href);
          }}
          onSelect={selectWorkspace}
          open={workspaceSwitcherOpen}
          viewerAvatarUrl={viewerIdentity?.avatar}
          viewerFace={viewerIdentity?.face}
          viewerName={viewerIdentity?.name}
          viewerPubkey={identityPubkey ?? undefined}
          workspaces={workspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            avatar: workspace.avatar,
            roomCount: workspaceRoomCounts.get(workspace.id) ?? 0,
            needsAttention: attentionWorkspaceIds.has(workspace.id),
          }))}
        />
      )}
    </View>
  );
});
