import { Button } from '@/components/buzz/Button';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { messageJumpHref, roomHref } from '@/buzz/corner-navigation';
import { useIsDesktop } from '@/utils/responsive';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { MessageBookmarkView, NeedsYouItemView, NeedsYouActionView } from '@beeline/api-contract/phone';
import { isWorkspaceListView, isWorkspaceView, type RoomView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { cornerHref } from '@/buzz/corner-navigation';
import {
  forgetTray,
  holdNeedsYou,
  loadNeedsYouList,
  loadSavedList,
  loadTrayList,
  removeNeedsYou,
  subscribeTrayGap,
  updateSavedList,
  useTrayList,
} from '@/buzz/needs-you-store';
import { compactRelativeTime } from '@/buzz/relative-time';
import { CORNER_META_SIZE, CornerGlyph } from '@/components/buzz/CornerGlyph';
import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import { DesktopRoomInspector } from '@/components/DesktopRoomInspector';
import { prefetchPushRoom } from '@/push/push-room-prefetch';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import brand from '@/buzz/brand.json';
import { openExternalUrl } from '@/utils/open-external-url';

const EMPTY_NEEDS: readonly NeedsYouItemView[] = [];

/** How long a removal or a section clear can be undone. */
const UNDO_MS = 6_000;

/** How far a section clear's Undo bar sits above a bookmark removal's bar. */
const UNDO_STACK = 56;

/** The server's refusal once the person has left, or been removed from, the Workspace. */
function lostWorkspace(reason: unknown): boolean {
  return (reason as { code?: unknown } | null)?.code === 'workspace membership required';
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function sourceTitle(bookmark: MessageBookmarkView): string {
  return bookmark.roomName.replace(/^#/, '');
}

function clearedLabel(clear: PendingClear): string {
  if (clear.kind === 'saved' && clear.more) return 'Cleared saved bookmarks';
  const count = clear.items.length;
  const noun = clear.kind === 'needs' ? 'item' : 'bookmark';
  return `Cleared ${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The message a tray row points at: what the desktop pane opens. */
type Target = {
  readonly messageId: string;
  readonly roomId: string;
  readonly workspaceId: string;
};

/** A section clear held back until its own Undo window closes. */
type PendingClear = { readonly expiresAt: number; readonly workspaceId: string } & (
  | { readonly kind: 'needs'; readonly items: readonly NeedsYouItemView[] }
  | { readonly kind: 'saved'; readonly items: readonly MessageBookmarkView[]; readonly more: boolean }
);

type Row =
  | { readonly key: string; readonly type: 'head'; readonly title: string;
      readonly count: number; readonly clear?: PendingClear['kind'] }
  | { readonly key: string; readonly type: 'needs'; readonly item: NeedsYouItemView }
  | { readonly key: string; readonly type: 'needs-empty' }
  | { readonly key: string; readonly type: 'saved'; readonly bookmark: MessageBookmarkView }
  | { readonly key: string; readonly type: 'saved-empty' }
  | { readonly key: string; readonly type: 'saved-more' };

function emptySection(
  title: string,
  detail: string,
  icon: 'checkmark-circle-outline' | 'bookmark-outline',
  testID: string,
) {
  return (
    <View style={styles.emptyBlock} testID={testID}>
    <Ionicons color={styles.emptyIcon.color} name={icon} size={22} />
    <Text style={styles.emptyTitle}>{title}</Text>
    <Text style={styles.empty}>{detail}</Text>
  </View>
  );
}

/**
 * The tray: exactly two sections, Needs you then Saved. Needs you is the
 * server's per-person projection (`readNeedsYou`); Saved is every bookmark,
 * newest first. Opening a Needs-you cell counts as handling it — someone who
 * wants to come back to it bookmarks it.
 */
export default function TrayScreen() {
  useLatencyRouteFrame('/beeline/tray');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const desktop = useIsDesktop();
  const params = useLocalSearchParams<{ communityId?: string | string[]; workspaceName?: string | string[] }>();
  const routeWorkspaceId = first(params.communityId);
  // A link without a Workspace id opens the Workspace the Rooms list treats
  // as active. `undefined` while resolving; `null` when there is none.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null | undefined>(undefined);
  const currentWorkspaceId = useActiveCommunityId();
  const workspaceId = routeWorkspaceId || activeWorkspaceId || '';
  // A Workspace the person is no longer a member of: its items open nothing.
  const [lostWorkspaceId, setLostWorkspaceId] = useState<string | null>(null);
  const lostWorkspaceRef = useRef<string | null>(null);
  const workspaceLost = Boolean(workspaceId) && lostWorkspaceId === workspaceId;
  const noWorkspace = (!routeWorkspaceId && activeWorkspaceId === null) || workspaceLost;
  // The badge reads this same slot, so its count follows the visible list.
  const { needs, bookmarks, next: savedNext } = useTrayList(workspaceId);
  const loadingSaved = useRef(false);
  const savedScroll = useRef(false);
  const [selected, setSelected] = useState<Target | null>(null);
  const [loading, setLoading] = useState(true);
  const loadedWorkspaceRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  useLatencyRouteFrame('/beeline/tray', !loading, true);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<MessageBookmarkView | null>(null);
  // Oldest first; the Undo bar offers the newest.
  const [pending, setPending] = useState<readonly PendingClear[]>([]);
  const pendingRef = useRef<readonly PendingClear[]>([]);
  const [client, setClient] = useState<RoomViewClient | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(first(params.workspaceName) || null);
  const [inspectRoom, setInspectRoom] = useState<RoomView | null>(null);
  const [paneCornerId, setPaneCornerId] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (force = false) => {
    if (!workspaceId) return;
    const generation = ++loadGenerationRef.current;
    savedScroll.current = false;
    setError(null);
    setNow(Date.now());
    const result = await Promise.allSettled([loadTrayList(workspaceId, force)]).then(([answer]) => answer);
    if (generation !== loadGenerationRef.current) return;
    if (
      result.status === 'rejected' &&
      (lostWorkspace(result.reason) || lostWorkspaceRef.current === workspaceId)
    ) {
      lostWorkspaceRef.current = workspaceId;
      setLostWorkspaceId(workspaceId);
      forgetTray(workspaceId);
      pendingRef.current = pendingRef.current.filter((clear) => clear.workspaceId !== workspaceId);
      setPending(pendingRef.current);
      setSelected(null);
      setLoading(false);
      loadedWorkspaceRef.current = null;
      return;
    }
    lostWorkspaceRef.current = null;
    setLostWorkspaceId(null);
    if (result.status === 'rejected')
      setError(result.reason instanceof Error ? result.reason.message : String(result.reason));
    else if (result.value.needsError || result.value.savedError)
      setError(result.value.needsError ?? result.value.savedError ?? null);
    if (result.status === 'fulfilled')
      loadedWorkspaceRef.current = workspaceId;
    setLoading(false);
  }, [workspaceId]);

  // The previous account's sections and lost Workspace do not carry over.
  useEffect(() => subscribeClientReset(() => {
    loadGenerationRef.current += 1;
    loadedWorkspaceRef.current = null;
    lostWorkspaceRef.current = null;
    pendingRef.current = [];
    setPending([]);
    setRemoved(null);
    setSelected(null);
    setLostWorkspaceId(null);
    void load();
  }), [load]);

  useEffect(() => workspaceId ? subscribeTrayGap(workspaceId, (reason) => {
    if (reason === 'needs-you-gap') void loadNeedsYouList(workspaceId).catch(() => load(true));
    else if (reason === 'bookmark-gap') void loadSavedList(workspaceId).catch(() => load(true));
    else void load(true);
  }) : undefined,
    [workspaceId, load]);

  const loadMoreSaved = useCallback(async () => {
    if (!workspaceId || !savedNext || loadingSaved.current) return;
    const generation = loadGenerationRef.current;
    loadingSaved.current = true;
    try {
      await loadSavedList(workspaceId, savedNext);
    } catch (cause) {
      if (generation === loadGenerationRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loadingSaved.current = false;
    }
  }, [workspaceId, savedNext]);

  // A held tray paints its last projection immediately. Socket gaps signal
  // one covering read through the roomless registration above.
  useFocusEffect(
    useCallback(() => {
      if (loadedWorkspaceRef.current !== workspaceId) void load();
      return undefined;
    }, [load]),
  );

  useEffect(() => {
    if (routeWorkspaceId || currentWorkspaceId === undefined) return;
    let cancelled = false;
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity) {
        if (!cancelled) setActiveWorkspaceId(null);
        return;
      }
      const relayUrl = await getEffectiveRelayUrl();
      const list = await mobileSurfaceCache.read(
        surfaceAddress(relayUrl, identity.publicKey, '/workspaces'), isWorkspaceListView);
      if (cancelled) return;
      setActiveWorkspaceId(
        list?.workspaces.some((workspace) => workspace.id === currentWorkspaceId)
          ? currentWorkspaceId
          : (list?.workspaces[0]?.id ?? currentWorkspaceId),
      );
    })().catch(() => {
      if (!cancelled) setActiveWorkspaceId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, routeWorkspaceId]);

  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [removed]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [identity, relayUrl] = await Promise.all([loadBuzzIdentity(), getEffectiveRelayUrl()]);
      if (!identity || cancelled) return;
      const http = new RoomViewClient({
        baseUrl: relayUrl,
        identity,
      });
      if (cancelled) return;
      if (desktop) setClient(http);
      if (!workspaceId) return;
      const [list, workspace] = await Promise.all([
        mobileSurfaceCache.read(surfaceAddress(relayUrl, identity.publicKey, '/workspaces'), isWorkspaceListView),
        mobileSurfaceCache.read(surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', { workspaceId }), isWorkspaceView),
      ]);
      if (!cancelled) setWorkspaceName(first(params.workspaceName) ||
        (list?.workspaces.find((item) => item.id === workspaceId)?.name ?? workspace?.workspace.name ?? null));
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop, workspaceId, params.workspaceName]);

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
      const responseId = `${via}:${target.messageId}`;
      // Start the Room read now, as a push tap does; the Room takes it by this id.
      prefetchPushRoom(responseId, target.roomId);
      router.push(messageJumpHref(target.roomId, target.messageId, responseId, target.workspaceId));
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
      router.push(roomHref(cornerId, selected?.workspaceId));
    },
    [bookmarks, inspectRoom, open, router, selected],
  );

  /** Tapped or dismissed: the cell leaves this tray, and every other device's. */
  const clear = useCallback(async (item: NeedsYouItemView) => {
    const removal = removeNeedsYou(item.workspaceId, [item.messageId]);
    try {
      await monolithPhoneOperation('clearNeedsYou', {
        workspaceId: item.workspaceId,
        messageId: item.messageId,
      });
      removal.settle();
    } catch (cause) {
      // A failure that lands after an account switch belongs to the previous account.
      if (removal.restore()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const openNeed = useCallback(
    (item: NeedsYouItemView) => {
      // Opening an approval does not dismiss or decide it.
      if (!item.approval) void clear(item);
      if (desktop) setSelected(item);
      else open(item, 'needs-you');
    },
    [clear, desktop, open],
  );

  const decideNeed = useCallback(async (item: NeedsYouItemView, action: NeedsYouActionView) => {
    const generation = clientResetGeneration();
    setError(null);
    try {
      switch (action.kind) {
        case 'grant':
          await monolithPhoneOperation('decideAgentGrant', { grantId: action.grantId, decision: action.decision });
          break;
        case 'write-access':
          await monolithPhoneOperation('decideWritePermission', { roomId: item.roomId,
            permissionId: action.permissionId, requestId: action.requestId, agentId: action.agentId,
            repository: action.repository, decision: action.decision });
          break;
        case 'choice':
          await monolithPhoneOperation('answerChoice', { choiceId: action.choiceId, optionId: action.optionId });
          break;
        case 'skip-choice':
          await monolithPhoneOperation('skipChoice', { choiceId: action.choiceId });
          break;
        case 'external':
          // Squire owns its mandate and sign-in ceremony. No thread navigation.
          await openExternalUrl(action.url);
          return;
      }
      if (generation !== clientResetGeneration()) return;
      // Re-read on completion only: a multi-grant card may still need another decision.
      await loadNeedsYouList(item.workspaceId);
      AccessibilityInfo.announceForAccessibility('Decision sent');
    } catch (cause) {
      if (generation === clientResetGeneration())
        setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const dismissNeed = useCallback(
    (item: NeedsYouItemView) => {
      AccessibilityInfo.announceForAccessibility('Dismissed from Needs you');
      void clear(item);
    },
    [clear],
  );

  /** Send one Workspace-scoped operation after Undo expires. */
  const commitClear = useCallback(async (clear: PendingClear) => {
    const generation = clientResetGeneration();
    const ids = new Set(clear.items.map((item) => item.messageId));
    if (clear.kind === 'needs') {
      const removal = removeNeedsYou(clear.workspaceId, ids);
      try {
        await monolithPhoneOperation('clearNeedsYouSection', { workspaceId: clear.workspaceId });
        removal.settle();
      } catch (cause) {
        if (removal.restore()) setError(cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }
    const edit = updateSavedList(clear.workspaceId,
      (current) => current.filter((item) => !ids.has(item.messageId)));
    try {
      await monolithPhoneOperation('clearMessageBookmarks', { workspaceId: clear.workspaceId });
      if (generation !== clientResetGeneration()) return;
      edit.settle();
      updateSavedList(clear.workspaceId, () => [], null).settle();
    } catch (cause) {
      if (generation !== clientResetGeneration() || lostWorkspaceRef.current === clear.workspaceId) return;
      edit.cancel();
      updateSavedList(clear.workspaceId, (current) =>
        [...clear.items, ...current].sort((left, right) => right.bookmarkedAt - left.bookmarkedAt),
      ).settle();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** Send the held clears `which` picks, and stop holding them. */
  const flushClears = useCallback(
    (which: (clear: PendingClear) => boolean) => {
      const due = pendingRef.current.filter(which);
      if (!due.length) return;
      pendingRef.current = pendingRef.current.filter((clear) => !which(clear));
      setPending(pendingRef.current);
      for (const clear of due) void commitClear(clear);
    },
    [commitClear],
  );

  // Each held clear goes out when its own Undo window closes; all of them go
  // out when the Tray loses focus.
  useEffect(() => {
    const timers = pending.map((clear) =>
      setTimeout(
        () => flushClears((held) => held === clear),
        Math.max(0, clear.expiresAt - Date.now()),
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [flushClears, pending]);
  useFocusEffect(useCallback(() => () => flushClears(() => true), [flushClears]));

  // Held section clears hide their cells in the store, so the badge drops too.
  // A layout effect, so the cells never paint once more after the clear.
  useLayoutEffect(() => {
    const held = new Map<string, string[]>();
    for (const clear of pending) {
      if (clear.kind !== 'needs') continue;
      held.set(clear.workspaceId, [
        ...(held.get(clear.workspaceId) ?? []),
        ...clear.items.map((item) => item.messageId),
      ]);
    }
    for (const [id, ids] of held) holdNeedsYou(id, ids);
    return () => {
      for (const id of held.keys()) holdNeedsYou(id, []);
    };
  }, [pending]);
  const visibleNeeds = needs ?? EMPTY_NEEDS;
  const visibleBookmarks = useMemo(() => {
    const held = new Set(
      pending.flatMap((clear) =>
        clear.kind === 'saved' ? clear.items.map((item) => item.messageId) : [],
      ),
    );
    return held.size ? bookmarks.filter((item) => !held.has(item.messageId)) : bookmarks;
  }, [bookmarks, pending]);
  const newestClear = pending.at(-1);

  /** Clear a section now, with Undo. This only dismisses approval cards from the tray. */
  const clearSection = useCallback(
    (kind: PendingClear['kind']) => {
      setRemoved(null);
      const held = { expiresAt: Date.now() + UNDO_MS, workspaceId };
      const clear: PendingClear =
        kind === 'needs'
          ? { ...held, kind, items: visibleNeeds }
          : { ...held, kind, items: visibleBookmarks, more: !!savedNext };
      if (!clear.items.length) return;
      pendingRef.current = [...pendingRef.current, clear];
      setPending(pendingRef.current);
      AccessibilityInfo.announceForAccessibility(`${clearedLabel(clear)}. Undo available.`);
    },
    [visibleBookmarks, visibleNeeds, workspaceId, savedNext],
  );

  /** Undo the newest held clear; an older one still in its window shows next. */
  const undoClear = useCallback(() => {
    pendingRef.current = pendingRef.current.slice(0, -1);
    setPending(pendingRef.current);
    AccessibilityInfo.announceForAccessibility('Restored');
  }, []);

  const remove = useCallback(async (bookmark: MessageBookmarkView) => {
    const generation = clientResetGeneration();
    const edit = updateSavedList(bookmark.workspaceId,
      (current) => current.filter((item) => item.messageId !== bookmark.messageId));
    setRemoved(bookmark);
    AccessibilityInfo.announceForAccessibility('Bookmark removed. Undo available.');
    try {
      await monolithPhoneOperation('setMessageBookmark', {
        roomId: bookmark.roomId,
        messageId: bookmark.messageId,
        bookmarked: false,
      });
      edit.settle();
    } catch (cause) {
      if (generation !== clientResetGeneration()) return;
      edit.cancel();
      setRemoved(null);
      updateSavedList(bookmark.workspaceId, (current) => [bookmark, ...current]).settle();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const undo = useCallback(async () => {
    if (!removed?.available) return;
    const bookmark = removed;
    const generation = clientResetGeneration();
    setRemoved(null);
    const edit = updateSavedList(bookmark.workspaceId, (current) => [bookmark, ...current]);
    AccessibilityInfo.announceForAccessibility('Bookmark restored');
    try {
      await monolithPhoneOperation('setMessageBookmark', {
        roomId: bookmark.roomId,
        messageId: bookmark.messageId,
        bookmarked: true,
      });
      edit.settle();
    } catch (cause) {
      if (generation !== clientResetGeneration()) return;
      edit.cancel();
      updateSavedList(bookmark.workspaceId,
        (current) => current.filter((item) => item.messageId !== bookmark.messageId)).settle();
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [removed]);

  const rows = useMemo((): Row[] => {
    if (loading || workspaceLost) return [];
    const cells = (items: NeedsYouItemView[]) =>
      items.map((item): Row => ({ key: `needs-${item.messageId}`, type: 'needs', item }));
    const approvals = visibleNeeds.filter((item) => item.approval);
    const questions = visibleNeeds.filter((item) => !item.approval);
    return [
      {
        key: 'head-needs',
        type: 'head',
        title: 'Needs you',
        count: visibleNeeds.length,
        ...(visibleNeeds.length ? { clear: 'needs' as const } : {}),
      },
      // Approvals before questions, each in the server's order.
      ...(visibleNeeds.length
        ? [...cells(approvals), ...cells(questions)]
        : [{ key: 'needs-empty', type: 'needs-empty' } as const]),
      {
        key: 'head-saved',
        type: 'head',
        title: 'Saved',
        count: visibleBookmarks.length,
        ...(visibleBookmarks.length ? { clear: 'saved' as const } : {}),
      },
      ...(visibleBookmarks.length
        ? visibleBookmarks.map((bookmark): Row => ({
            key: `saved-${bookmark.messageId}`,
            type: 'saved',
            bookmark,
          }))
        : [{ key: 'saved-empty', type: 'saved-empty' } as const]),
      ...(savedNext ? [{ key: 'saved-more', type: 'saved-more' } as const] : []),
    ];
  }, [loading, visibleBookmarks, visibleNeeds, workspaceLost, savedNext]);

  const renderSaved = (bookmark: MessageBookmarkView) => {
    const source = `${bookmark.roomKind === 'corner' ? 'corner ' : '#'}${sourceTitle(bookmark)}`;
    return (
      <Pressable
        accessibilityLabel={`${source}, ${bookmark.author?.name ?? 'Unavailable message'}`}
        accessibilityRole={bookmark.available || desktop ? 'button' : undefined}
        accessibilityState={desktop ? { selected: selected?.messageId === bookmark.messageId } : undefined}
        // A desktop pane explains an unavailable source; a phone has nowhere to go.
        onPress={desktop ? () => setSelected(bookmark)
          : bookmark.available ? () => open(bookmark, 'bookmark') : undefined}
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
              <CornerGlyph size={CORNER_META_SIZE} testID={`bookmark-corner-mark-${bookmark.messageId}`} />
            ) : (
              <Text style={styles.originSigil}>#</Text>
            )}
            <Text numberOfLines={1} style={styles.origin}>{sourceTitle(bookmark)}</Text>
          </View>
          <Text numberOfLines={1} style={styles.time}>SAVED {compactRelativeTime(bookmark.bookmarkedAt, now)}</Text>
        </View>
        <Text numberOfLines={1} style={styles.author}>{bookmark.available ? bookmark.author?.name : 'Source unavailable'}</Text>
        {bookmark.available ? (
          <Text numberOfLines={desktop ? 2 : 3} style={styles.excerpt}>{bookmark.text}</Text>
        ) : (
          <Text style={styles.unavailable}>Deleted or no longer accessible</Text>
        )}
        <View style={styles.rowFooter}>
          {!desktop ? <Text style={styles.open}>OPEN →</Text> : null}
          {desktop && bookmark.available ? (
            <Pressable accessibilityLabel="Remove bookmark" accessibilityRole="button"
              onPress={(event) => { event.stopPropagation(); void remove(bookmark); }} style={styles.remove}>
              <Text style={styles.removeText}>REMOVE</Text>
            </Pressable>
          ) : null}
        </View>
        {!bookmark.available ? (
          <Pressable accessibilityLabel="Remove unavailable bookmark" accessibilityRole="button"
            onPress={() => void remove(bookmark)} style={styles.remove}>
            <Text style={styles.removeText}>REMOVE</Text>
          </Pressable>
        ) : null}
      </Pressable>
    );
  };

  const list = (
    <FlatList
      onScroll={(event) => { if (event.nativeEvent.contentOffset.y > 20) savedScroll.current = true; }}
      onEndReached={() => { if (savedScroll.current) void loadMoreSaved(); }}
      onEndReachedThreshold={0.5}
      contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}
      data={rows}
      keyExtractor={(row) => row.key}
      ListEmptyComponent={
        noWorkspace ? (
          <View style={styles.emptyBlock} testID="tray-no-workspace">
            <Text style={styles.emptyTitle}>No Workspace to show</Text>
            <Text style={styles.empty}>
              {workspaceLost
                ? 'You are no longer a member of this Workspace.'
                : 'This link did not name a Workspace, and none is open.'}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => router.replace('/beeline/channels')}
              style={styles.remove}>
              <Text style={styles.removeText}>BACK TO ROOMS</Text>
            </Pressable>
          </View>
        ) : loading ? (
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
                <View style={styles.sectionEnd}>
                  <Text style={styles.sectionCount}>{row.count}</Text>
                  {row.clear ? (
                    <Pressable accessibilityLabel={`Clear ${row.title}`} accessibilityRole="button"
                      hitSlop={8} onPress={() => clearSection(row.clear!)}
                      style={({ pressed }) => [styles.sectionClear, pressed && { opacity: 0.7 }]}
                      testID={`tray-clear-${row.clear}`}>
                      <Text style={styles.removeText}>CLEAR</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          case 'needs':
            return (
              <View style={styles.cellDivider}>
                <NeedsYouCell desktop={desktop} item={row.item} now={now}
                  onDismiss={dismissNeed} onOpen={openNeed} onAction={decideNeed} />
              </View>
            );
          case 'needs-empty':
            return emptySection('Nothing needs you',
              'Nobody has tagged you with a question or a request.', 'checkmark-circle-outline', 'needs-you-empty');
          case 'saved':
            return renderSaved(row.bookmark);
          case 'saved-more':
            return (
              <Pressable accessibilityRole="button" onPress={() => void loadMoreSaved()}
              style={styles.emptyBlock} testID="bookmarks-more">
              <Text style={styles.removeText}>LOAD MORE SAVED</Text>
            </Pressable>
            );
          case 'saved-empty':
            return emptySection('No bookmarks yet', desktop
              ? 'Hover a message and press its bookmark mark.'
              : 'Long press a message and pick Bookmark.', 'bookmark-outline', 'bookmarks-empty');
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
    desktop && selected && inspectRoom && client && paneCornerId ? (
      <DesktopRoomInspector
        room={inspectRoom}
        client={client}
        content={{ kind: 'corner', cornerId: paneCornerId }}
        focusMessageId={paneCornerId === selected.roomId ? selected.messageId : null}
        onOpenCorner={setPaneCornerId}
        onOpenInMain={openInMain}
        onClose={() => setSelected(null)}
      />
    ) : desktop ? (
      <View style={styles.paneFallback} testID="tray-pane">
        {selectedBookmark && !selectedBookmark.available ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>Source unavailable</Text>
            <Text style={styles.empty}>This bookmark no longer exposes message content.</Text>
            <Pressable accessibilityLabel="Remove unavailable bookmark" accessibilityRole="button"
              onPress={() => void remove(selectedBookmark)} style={styles.remove}>
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
      <PageHeader backAccessibilityLabel="Back to Rooms" eyebrow={workspaceName ?? 'Workspace'}
        onBack={desktop ? undefined : () => router.back()} prominent testID="tray-header" title="Tray" />
      {error ? (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
          <Button
            label="Retry"
            variant="secondary"
            style={{ alignSelf: 'flex-end' }}
            onPress={() => void load(true)}
          />
        </View>
      ) : null}
      <View style={styles.body}>
        {list}
        {pane}
      </View>
      {removed ? (
        <View accessibilityLiveRegion="polite" style={[styles.undo, { bottom: 16 + insets.bottom }]}
          testID="bookmark-undo">
          <Text style={styles.undoText}>Bookmark removed</Text>
          {removed.available ? (
            <Pressable accessibilityRole="button" onPress={() => void undo()} style={styles.undoAction}>
              <Text style={styles.undoActionText}>UNDO</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {/* A held clear keeps its UNDO in reach above a bookmark removal's bar. */}
      {newestClear ? (
        <View accessibilityLiveRegion="polite" testID="tray-clear-undo"
          style={[styles.undo, desktop && styles.desktopUndo,
            { bottom: 16 + insets.bottom + (removed ? UNDO_STACK : 0) }]}>
          <Text style={styles.undoText}>{clearedLabel(newestClear)}</Text>
          <Pressable accessibilityRole="button" onPress={undoClear} style={styles.undoAction}>
            <Text style={styles.undoActionText}>UNDO</Text>
          </Pressable>
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
    maxWidth: 390, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.buzz.border,
  },
  sectionHead: {
    minHeight: 44, marginTop: theme.buzz.space.lg, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.buzz.border,
  },
  sectionTitle: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  sectionCount: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  sectionEnd: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.md },
  sectionClear: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  cellDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.buzz.border,
  },
  row: {
    minHeight: 128, padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.buzz.border,
  },
  rowSelected: { backgroundColor: theme.buzz.bgHighlight },
  rowUnavailable: { opacity: 0.68 },
  originLine: { flexDirection: 'row', alignItems: 'baseline', gap: theme.buzz.space.sm },
  originSource: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  originSigil: { ...theme.buzz.type.meta, color: brand.mark },
  origin: { ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary },
  time: { ...theme.buzz.type.meta, flexShrink: 0, color: theme.buzz.ledgerQuiet },
  author: {
    ...theme.buzz.type.meta, color: theme.buzz.accent, marginTop: theme.buzz.space.sm,
  },
  excerpt: {
    ...theme.buzz.type.body, color: theme.buzz.textSecondary, marginTop: theme.buzz.space.xs,
  },
  unavailable: {
    ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: theme.buzz.space.xs,
  },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: theme.buzz.space.sm },
  open: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
  remove: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  removeText: { ...theme.buzz.type.sectionHead, color: theme.buzz.textSecondary },
  paneFallback: { flex: 1, justifyContent: 'center' },
  loadingBlock: { padding: theme.buzz.space.xl, alignItems: 'center', justifyContent: 'center' },
  emptyBlock: { padding: theme.buzz.space.xl, alignItems: 'flex-start', justifyContent: 'center' },
  emptyIcon: { color: theme.buzz.accent },
  emptyTitle: {
    ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary, marginTop: theme.buzz.space.sm,
  },
  empty: {
    ...theme.buzz.type.meta, color: theme.buzz.textSecondary, marginTop: theme.buzz.space.sm,
  },
  error: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: theme.buzz.bgHighlight,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  undo: {
    position: 'absolute', left: 16, right: 16, bottom: 16, minHeight: 48,
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgTerminal, borderWidth: 1,
    borderColor: theme.buzz.borderStrong, borderRadius: theme.buzz.radius,
  },
  // The bulk Undo bar sits at the foot of the desktop list column.
  desktopUndo: { maxWidth: 390 - 32 },
  undoText: {
    ...theme.buzz.type.meta, flex: 1, color: theme.buzz.textPrimary,
  },
  undoAction: { minWidth: 64, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  undoActionText: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
}));
