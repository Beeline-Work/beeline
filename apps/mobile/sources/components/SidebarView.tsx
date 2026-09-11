import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { type Href, usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type ChatListView, type WorkspaceListView } from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  subscribeActiveCommunityId,
} from '@/buzz/community-storage';
import { compactRelativeTime } from '@/buzz/relative-time';
import { useHeaderHeight, useIsDesktop } from '@/utils/responsive';
import { ROOM_LABEL, ROOMS_LABEL, WORKSPACE_LABEL, WORKSPACES_LABEL } from '@/buzz/vocabulary';
import {
  roomListSections,
  roomRowName,
  roomRowNeedsAttention,
  roomRowPreview,
} from '@/buzz/room-list-row';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { CommunityRail, CommunitySwitcherTrigger } from '@/components/buzz/CommunityRail';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';

function selectedRoomId(pathname: string): string | null {
  const prefix = '/beeline/chat/';
  if (!pathname.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(pathname.slice(prefix.length).split('/')[0]!);
  } catch {
    return pathname.slice(prefix.length).split('/')[0] ?? null;
  }
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
  workspaceSwitcher: { flex: 1 },
  workspaceBlock: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  eyebrow: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary, marginBottom: 7 },
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
  search: {
    ...theme.buzz.type.meta,
    flex: 1,
    color: theme.colors.text,
    outlineStyle: 'none',
  } as any,
  shortcut: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  list: { flex: 1 },
  listContent: { paddingBottom: 8 },
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
  roomRowCompact: { alignItems: 'center' },
  roomRowSelected: { backgroundColor: theme.colors.surfaceSelected },
  roomStateSlot: { width: 7, height: 7, marginTop: 7 },
  roomStateSlotCompact: { marginTop: 0 },
  roomStateMark: { width: 7, height: 7 },
  roomStateNeedsYou: { backgroundColor: theme.colors.textLink },
  roomStateWorking: { backgroundColor: theme.colors.textSecondary },
  roomCopy: { flex: 1, minWidth: 0 },
  roomTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  roomTitle: { ...theme.buzz.type.bodyStrong, flex: 1, color: theme.colors.text },
  roomSigil: { color: theme.colors.textLink },
  roomTime: { ...theme.buzz.type.sectionHead, color: theme.colors.textSecondary },
  roomFact: { ...theme.buzz.type.meta, marginTop: 3, color: theme.colors.textSecondary },
  previewSelf: { color: theme.colors.textSecondary },
  previewAuthor: { color: theme.colors.textLink },
  empty: {
    ...theme.buzz.type.meta,
    paddingHorizontal: 18,
    paddingVertical: 24,
    color: theme.colors.textSecondary,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
  },
  settingsText: { ...theme.buzz.type.sectionHead, color: theme.colors.text },
}));

/** One server-backed desktop pane for Workspace and Room movement. */
export const SidebarView = React.memo(function SidebarView() {
  const styles = stylesheet;
  const safeArea = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const isDesktop = useIsDesktop();
  const router = useRouter();
  const pathname = usePathname();
  const activeRoomId = selectedRoomId(pathname);
  const searchRef = React.useRef<TextInput>(null);
  const switcherTriggerRef = React.useRef<any>(null);
  const switcherPanelRef = React.useRef<any>(null);
  const workspaceIdRef = React.useRef<string | null>(null);
  const [client, setClient] = React.useState<RoomViewClient | null>(null);
  const [identityPubkey, setIdentityPubkey] = React.useState<string | null>(null);
  const [workspaces, setWorkspaces] = React.useState<WorkspaceListView['workspaces']>([]);
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [surface, setSurface] = React.useState<ChatListView | null>(null);
  const [query, setQuery] = React.useState('');
  const [navigationError, setNavigationError] = React.useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = React.useState(false);
  const [attentionWorkspaceIds, setAttentionWorkspaceIds] = React.useState<ReadonlySet<string>>(
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
    if (!client || !workspaces.length) return;
    let cancelled = false;
    void Promise.all(
      workspaces.map(async (workspace) => {
        const chats = await client.chats(workspace.id).catch(() => null);
        return [
          workspace.id,
          Boolean(chats?.chats.some((item) => roomRowNeedsAttention(item))),
        ] as const;
      }),
    ).then((results) => {
      if (cancelled) return;
      setAttentionWorkspaceIds(
        new Set(results.filter(([, attention]) => attention).map(([id]) => id)),
      );
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
  const otherWorkspaceNeedsAttention = [...attentionWorkspaceIds].some((id) => id !== workspaceId);
  const openRoom = React.useCallback(
    (roomId: string) => router.push(`/beeline/chat/${encodeURIComponent(roomId)}` as Href),
    [router],
  );

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && workspaceSwitcherOpen) {
        event.preventDefault();
        setWorkspaceSwitcherOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
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

  React.useEffect(() => {
    if (!isDesktop || !workspaceSwitcherOpen || typeof document === 'undefined') return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (switcherTriggerRef.current?.contains?.(target)) return;
      if (switcherPanelRef.current?.contains?.(target)) return;
      setWorkspaceSwitcherOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isDesktop, workspaceSwitcherOpen]);

  const selectWorkspace = React.useCallback(
    (nextId: string) => {
      setWorkspaceSwitcherOpen(false);
      workspaceIdRef.current = nextId;
      setWorkspaceId(nextId);
      setSurface(null);
      setQuery('');
      if (identityPubkey) void saveActiveCommunityId(identityPubkey, nextId);
      if (client) {
        setNavigationError(null);
        void client
          .chats(nextId)
          .then((chats) => {
            setSurface(chats);
            const firstRoom = chats.chats[0]?.room.id;
            if (firstRoom) router.replace(`/beeline/chat/${encodeURIComponent(firstRoom)}` as Href);
          })
          .catch(() => setNavigationError(`Could not load ${ROOMS_LABEL.toLowerCase()}.`));
      }
    },
    [client, identityPubkey, router],
  );

  return (
    <View
      style={[
        styles.container,
        { paddingTop: safeArea.top + (isDesktop ? 0 : headerHeight) },
      ]}
      testID="desktop-navigation-pane"
    >
      {isDesktop ? (
        <View ref={switcherTriggerRef} style={styles.desktopWorkspaceHeader}>
          <CommunitySwitcherTrigger
            community={activeWorkspace ? workspaceRailItem(activeWorkspace) : null}
            expanded={workspaceSwitcherOpen}
            onPress={() => setWorkspaceSwitcherOpen((open) => !open)}
            attention={otherWorkspaceNeedsAttention}
            pickerTitle={WORKSPACES_LABEL}
          />
        </View>
      ) : (
        <View style={styles.workspaceBlock}>
          <Text style={styles.eyebrow}>{WORKSPACE_LABEL.toUpperCase()}</Text>
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
      {isDesktop && workspaceSwitcherOpen ? (
        <View ref={switcherPanelRef} style={styles.workspaceSwitcher}>
          <CommunityRail
            communities={workspaces.map(workspaceRailItem)}
            activeCommunityId={workspaceId}
            onSelect={(nextId) => {
              if (nextId) selectWorkspace(nextId);
            }}
            onAdd={() => {
              setWorkspaceSwitcherOpen(false);
              router.push('/beeline/community' as Href);
            }}
            onSettings={() => {
              setWorkspaceSwitcherOpen(false);
              router.push('/beeline/settings' as Href);
            }}
            viewerPubkey={identityPubkey ?? undefined}
            presentation="column"
          />
        </View>
      ) : (
        <>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={14} color={stylesheet.roomTime.color} />
            <TextInput
              ref={searchRef}
              value={query}
              onChangeText={setQuery}
              placeholder={`Search ${ROOMS_LABEL}`}
              placeholderTextColor={stylesheet.roomTime.color}
              style={styles.search}
              testID="desktop-room-search"
            />
            <Text style={styles.shortcut}>⌘K</Text>
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
              <Text style={styles.empty}>
                {surface
                  ? `No ${ROOMS_LABEL.toLowerCase()} match this search.`
                  : `Loading ${ROOMS_LABEL.toLowerCase()}…`}
              </Text>
            ) : (
              filteredChatSections.map((section) => (
                <React.Fragment key={section.kind}>
                  <RoomListSectionHeader
                    title={section.kind === 'rooms' ? ROOMS_LABEL : 'Direct messages'}
                  />
                  {section.data.map((item) => {
                    const rowName = roomRowName(item);
                    const preview = roomRowPreview(item, identityPubkey ?? undefined);
                    const attention = roomRowNeedsAttention(item);
                    return (
                  <Pressable
                    key={item.room.id}
                    accessibilityLabel={`Open ${item.directMessage ? 'direct message' : ROOM_LABEL} ${rowName.sigil}${rowName.name}`}
                    accessibilityRole="button"
                    onPress={() => openRoom(item.room.id)}
                    style={({ pressed }) => [
                      styles.roomRow,
                      !isDesktop && styles.roomRowCompact,
                      activeRoomId === item.room.id && styles.roomRowSelected,
                      pressed && styles.roomRowSelected,
                    ]}
                    testID={`desktop-room-${item.room.id}`}
                  >
                    <View
                      style={[styles.roomStateSlot, !isDesktop && styles.roomStateSlotCompact]}
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
                        {preview.attribution === 'self' && (
                          <Text style={styles.previewSelf}>you: </Text>
                        )}
                        {preview.attribution === 'other' && (
                          <Text style={styles.previewAuthor}>@{preview.handle}: </Text>
                        )}
                        {preview.text}
                      </Text>
                    </View>
                  </Pressable>
                    );
                  })}
                </React.Fragment>
              ))
            )}
          </ScrollView>
          {!isDesktop && (
            <Pressable
              accessibilityLabel="Open Beeline settings"
              accessibilityRole="button"
              onPress={() => router.push('/beeline/settings' as Href)}
              style={styles.settingsRow}
            >
              <Ionicons name="settings-outline" size={18} color={stylesheet.settingsText.color} />
              <Text style={styles.settingsText}>SETTINGS</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
});
