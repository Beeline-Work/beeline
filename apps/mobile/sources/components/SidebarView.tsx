import { useNeedsYouCount } from '@/buzz/needs-you';
import { PinnedConversationsEmpty } from '@/components/buzz/PinnedConversationsEmpty';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  loadActiveCommunityId,
  loadLastViewedChannel,
  saveActiveCommunityId,
  subscribeActiveCommunityId,
} from '@/buzz/community-storage';
import { navigateToRoom } from '@/buzz/corner-navigation';
import { selectDesktopWorkCorner, writeDesktopCornerDrag } from '@/buzz/desktop-work-pane';
import { desktopWorkspaceRoute } from '@/buzz/desktop-workbench-state';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import {
  filterConversations,
  roomListCounts,
  useRoomPins,
  useRoomListFilter,
} from '@/buzz/room-list-preferences';
import { roomListSections, roomRowNeedsAttention } from '@/buzz/room-list-row';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { ROOMS_LABEL, WORKSPACE_LABEL, WORKSPACES_LABEL } from '@/buzz/vocabulary';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import { CommunitySwitcherTrigger } from '@/components/buzz/CommunityRail';
import { ConversationRow } from '@/components/buzz/ConversationRow';
import { DesktopRoomCorners } from '@/components/buzz/DesktopRoomCorners';
import { DesktopWorkspaceRail } from '@/components/buzz/DesktopWorkspaceRail';
import { DesktopWorkspaceStrip } from '@/components/buzz/DesktopWorkspaceStrip';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { RoomListToolbar } from '@/components/buzz/RoomListToolbar';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { WorkspaceActionsMenu } from '@/components/buzz/WorkspaceActionsMenu';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { useHeaderHeight, useIsDesktop } from '@/utils/responsive';
import {
  type ChatListView,
  type RoomViewIdentity,
  type WorkspaceListView,
} from '@beeline/buzz-client';
import { Ionicons } from '@expo/vector-icons';
import { useGlobalSearchParams, usePathname, useRouter, type Href } from 'expo-router';
import * as React from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

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
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
  conversationCell: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  roomRowSelected: { backgroundColor: theme.colors.surfaceSelected },
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
  const { width: windowWidth } = useWindowDimensions();
  const showWorkspaceStrip = isDesktop && windowWidth >= 1360;
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
  const promotedCornerParentId = firstParam(routeParams.parent);
  const activeRoomId = promotedCornerParentId ?? selectedRoomId(pathname);
  const searchRef = React.useRef<TextInput>(null);
  const workspaceIdRef = React.useRef<string | null>(null);
  const [client, setClient] = React.useState<RoomViewClient | null>(null);
  const [identityPubkey, setIdentityPubkey] = React.useState<string | null>(null);
  const [viewerIdentity, setViewerIdentity] = React.useState<RoomViewIdentity | null>(null);
  const [workspaces, setWorkspaces] = React.useState<WorkspaceListView['workspaces']>([]);
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [surface, setSurface] = React.useState<ChatListView | null>(null);
  const [query, setQuery] = React.useState('');
  const [desktopSearchOpen, setDesktopSearchOpen] = React.useState(false);
  const [navigationError, setNavigationError] = React.useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = React.useState(false);
  const [attentionWorkspaceIds, setAttentionWorkspaceIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [workspaceRoomCounts, setWorkspaceRoomCounts] = React.useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [expandedRoomIds, setExpandedRoomIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

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

  const { pinned, pinsLoaded, togglePin, pinError } = useRoomPins(identityPubkey, workspaceId);
  const counts = React.useMemo(
    () => roomListCounts(surface?.chats ?? [], pinned),
    [surface?.chats, pinned],
  );
  const [filter, setFilter] = useRoomListFilter(
    workspaceId,
    pinsLoaded && Boolean(surface),
    Boolean(
      surface?.chats.some(
        (item) => !item.closed && !item.directMessage && pinned.includes(item.room.id),
      ),
    ),
  );
  const filteredChats = React.useMemo(
    () => filterConversations(surface?.chats ?? [], query, filter, pinned),
    [query, filter, pinned, surface?.chats],
  );
  const filteredChatSections = React.useMemo(
    () => roomListSections(filteredChats),
    [filteredChats],
  );
  // A corner route expands its parent. Opening a Room itself leaves its corner
  // list collapsed; the row's corner glyph toggles that list.
  React.useEffect(() => {
    const parentId = promotedCornerParentId;
    if (
      !parentId ||
      !(surface?.chats.find((item) => item.room.id === parentId)?.cornerCount ?? 0)
    ) {
      return;
    }
    setExpandedRoomIds((current) =>
      current.has(parentId) ? current : new Set([...current, parentId]),
    );
  }, [promotedCornerParentId, surface?.chats]);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  // ChatListView carries workspace.role; the server's viewer.permissions.manage
  // is the same boolean (`role !== 'member'`). Do not invent a second gate.
  const canManageWorkspace = isWorkspaceManagerRole(surface?.workspace.role);
  const viewerIsAgent = surface?.viewer.kind === 'agent';
  const canCreateRoom = !viewerIsAgent && canManageWorkspace;
  const workbenchSelected = pathname.startsWith('/beeline/settings/workbench');
  const workspaceSettingsSelected = pathname.startsWith('/beeline/settings/workspace');
  const traySelected = pathname.startsWith('/beeline/tray');
  const needsYouCount = useNeedsYouCount(workspaceId, surface);
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
        setDesktopSearchOpen(true);
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
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {showWorkspaceStrip && (
        <DesktopWorkspaceStrip
          workspaces={workspaces}
          activeWorkspaceId={workspaceId}
          viewerName={viewerIdentity?.name}
          viewerPubkey={identityPubkey ?? undefined}
          viewerFace={viewerIdentity?.face}
          viewerAvatarUrl={viewerIdentity?.avatar}
          onSelect={selectWorkspace}
          onAdd={() => router.push('/beeline/community' as Href)}
          onAccount={() => router.push('/beeline/settings' as Href)}
        />
      )}
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
                {workspaceId && (
                  <WorkspaceActionsMenu
                    traySelected={traySelected}
                    canManageWorkspace={canManageWorkspace}
                    onTray={() =>
                      router.push({
                        pathname: '/beeline/tray',
                        params: { communityId: workspaceId },
                      } as Href)
                    }
                    onMembers={() =>
                      router.push({
                        pathname: '/beeline/members',
                        params: { communityId: workspaceId },
                      } as Href)
                    }
                    onSettings={
                      canManageWorkspace
                        ? () =>
                            router.push({
                              pathname: '/beeline/settings/workspace',
                              params: { communityId: workspaceId },
                            } as Href)
                        : undefined
                    }
                    onCompose={
                      viewerIsAgent
                        ? undefined
                        : (action) =>
                            runRoomDeckComposeAction(action, {
                              communityId: workspaceId,
                              openMessagePicker: () =>
                                router.push({
                                  pathname: '/beeline/channels',
                                  params: {
                                    communityId: workspaceId,
                                    newDirectMessage: String(Date.now()),
                                  },
                                } as Href),
                              openRoomCreator: () =>
                                router.push({
                                  pathname: '/beeline/channels',
                                  params: {
                                    communityId: workspaceId,
                                    newRoom: String(Date.now()),
                                  },
                                } as Href),
                              invitePerson: () =>
                                router.push({
                                  pathname: '/beeline/members',
                                  params: { communityId: workspaceId, action: 'invite' },
                                } as Href),
                              navigate: (target) => router.push(target as Href),
                            })
                    }
                  />
                )}
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
          <RoomListToolbar
            desktop
            searchRef={searchRef}
            searchOpen={desktopSearchOpen}
            onSearchOpenChange={setDesktopSearchOpen}
            filter={filter}
            onFilter={setFilter}
            query={query}
            onQuery={setQuery}
            traySelected={traySelected}
            counts={counts}
            needsYouCount={needsYouCount}
            onTray={
              workspaceId
                ? () =>
                    router.push({
                      pathname: '/beeline/tray',
                      params: { communityId: workspaceId },
                    } as Href)
                : undefined
            }
          />
          {pinError && (
            <Text accessibilityRole="alert" style={styles.empty}>
              {pinError}
            </Text>
          )}
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
                filter === 'pinned' && !query.trim() ? (
                  <PinnedConversationsEmpty desktop onShowAll={() => setFilter('all')} />
                ) : (
                  <Text style={styles.empty}>
                    {query.trim() || filter !== 'all'
                      ? `No ${ROOMS_LABEL.toLowerCase()} or direct messages match this search.`
                      : `No ${ROOMS_LABEL.toLowerCase()} or direct messages yet.`}
                  </Text>
                )
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
                    count={section.kind === 'rooms' ? section.data.length : undefined}
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
                                    : {
                                        communityId: workspaceId,
                                        newDirectMessage: String(Date.now()),
                                      },
                              } as Href)
                    }
                  />
                  {section.data.map((item) => {
                    const active = activeRoomId === item.room.id;
                    return (
                      <View key={item.room.id} style={styles.conversationCell}>
                        <ConversationRow
                          item={item}
                          viewer={identityPubkey ?? undefined}
                          now={Date.now()}
                          selected={isDesktop && active}
                          desktop
                          cornersExpanded={expandedRoomIds.has(item.room.id)}
                          onToggleCorners={() =>
                            setExpandedRoomIds((current) => {
                              const next = new Set(current);
                              if (next.has(item.room.id)) next.delete(item.room.id);
                              else next.add(item.room.id);
                              return next;
                            })
                          }
                          pinned={pinned.includes(item.room.id)}
                          onPin={() => void togglePin(item.room.id)}
                          onPress={() => openRoom(item.room.id)}
                          testID={`desktop-room-${item.room.id}`}
                        />
                        {!item.directMessage &&
                          (item.cornerCount ?? 0) > 0 &&
                          expandedRoomIds.has(item.room.id) && (
                            <DesktopRoomCorners
                              key={`${workspaceId}/${item.room.id}`}
                              item={item}
                              onOpen={(cornerId) => {
                                selectDesktopWorkCorner({ roomId: item.room.id, cornerId });
                                if (activeRoomId !== item.room.id) openRoom(item.room.id);
                              }}
                              renderDrag={(cornerId, children) => (
                                <DesktopCornerDragSource roomId={item.room.id} cornerId={cornerId}>
                                  {children}
                                </DesktopCornerDragSource>
                              )}
                            />
                          )}
                      </View>
                    );
                  })}
                </React.Fragment>
              ))
            )}
          </ScrollView>
          {!showWorkspaceStrip && (
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
          )}
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
    </View>
  );
});
