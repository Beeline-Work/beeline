import { SettingsRow } from '@/components/buzz/SettingsRow';
import { appErrorCopy } from '@/buzz/app-error-copy';
import { desktopColumnWidths } from '@/buzz/desktop-layout-tokens';
import { ContentTarget, InlineRow } from '@/components/buzz/IndexRow';
import { Button } from '@/components/buzz/Button';
import { useLatencyRouteFrame } from '@/buzz/latency-route-hook';
import { messageJumpHref, roomHref } from '@/buzz/corner-navigation';
import { useIsDesktop } from '@/utils/responsive';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  FlatList,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import type { MessageBookmarkView, NeedsYouItemView, NeedsYouActionView } from '@beeline/api-contract/phone';
import { isWorkspaceListView, isWorkspaceView } from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { useActiveCommunityId } from '@/buzz/use-active-community';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration, subscribeClientReset } from '@/sync/client-reset';
import { cornerHref } from '@/buzz/corner-navigation';
import { compactRelativeTime } from '@/buzz/relative-time';
import { CORNER_META_SIZE, CornerGlyph } from '@/components/buzz/CornerGlyph';
import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';
import { PageHeader } from '@/components/buzz/PageHeader';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import brand from '@/buzz/brand.json';
import { openExternalUrl } from '@/utils/open-external-url';
import { useRoutedTray, prepareTrayCommand, acknowledgeRoutedTrayPaint,
  type PreparedTrayCommand, type TrayCommand } from '@/buzz/router-tray';

const EMPTY_NEEDS: readonly NeedsYouItemView[] = [];

/** How long a removal or a section clear can be undone. */
const UNDO_MS = 6_000;

/** How far a section clear's Undo bar sits above a bookmark removal's bar. */
const UNDO_STACK = 56;


function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function sourceTitle(bookmark: MessageBookmarkView): string {
  return bookmark.roomName.replace(/^#/, '').trim();
}

/** A saved preview draws `**bold**` as bold and drops any unpaired `**`. */
function boldRuns(text: string): { text: string; bold: boolean }[] {
  return text.split(/\*\*(?=\S)([^\n]*?\S)\*\*/).flatMap((part, index) => {
    const run = index % 2 ? part : part.replace(/\*\*/g, '');
    return run ? [{ text: run, bold: index % 2 === 1 }] : [];
  });
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
type PendingClear = { readonly expiresAt: number; readonly workspaceId: string;
  readonly prepared?: PreparedTrayCommand } & (
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
  const [trayFocused, setTrayFocused] = useState(false);
  const routed = useRoutedTray(workspaceId, trayFocused);
  const { needs, bookmarks, savedNext } = routed;
  const [selectedTarget, setSelected] = useState<Target | null>(null);
  const selected = (routed.value) && selectedTarget?.workspaceId === workspaceId ? selectedTarget : null;
  const loading = !routeWorkspaceId && activeWorkspaceId === undefined || routed.loading || !!workspaceId && !routed.value;
  useLatencyRouteFrame('/beeline/tray', !loading, true);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<MessageBookmarkView | null>(null);
  // Oldest first; the Undo bar offers the newest.
  const [pending, setPending] = useState<readonly PendingClear[]>([]);
  const pendingRef = useRef<readonly PendingClear[]>([]);
  const [workspaceName, setWorkspaceName] = useState<string | null>(first(params.workspaceName) || null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const focused = useRef(false);
  const paintContext = useRef({ workspaceId, ready: false });
  paintContext.current = { workspaceId, ready: !loading && !noWorkspace };
  const viewableQuestions = useRef<readonly string[]>([]);
  const paintFrame = useRef<number | null>(null);
  const acknowledgePaint = useCallback(() => {
    if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    const context = paintContext.current;
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null;
      if (!focused.current || AppState.currentState !== 'active' || !context.ready || !paintContext.current.ready ||
        context.workspaceId !== paintContext.current.workspaceId) return;
      void (acknowledgeRoutedTrayPaint)(context.workspaceId, viewableQuestions.current)
        .catch(() => undefined);
    });
  }, []);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    setTrayFocused(true);
    acknowledgePaint();
    return () => {
      focused.current = false;
      setTrayFocused(false);
      viewableQuestions.current = [];
      if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    };
  }, [acknowledgePaint]));
  const onViewableItemsChanged = useRef(({ viewableItems }: {
    viewableItems: readonly { item: Row; isViewable?: boolean }[];
  }) => {
    viewableQuestions.current = viewableItems.flatMap(({ item, isViewable }) =>
      isViewable !== false && item.type === 'needs' && !item.item.approval && item.item.expiresAt === undefined
        ? [item.item.messageId] : []);
    acknowledgePaint();
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;

  // The previous account's sections and lost Workspace do not carry over.
  useEffect(() => subscribeClientReset(() => {
    lostWorkspaceRef.current = null;
    pendingRef.current = [];
    setPending([]);
    setRemoved(null);
    setSelected(null);
    setLostWorkspaceId(null);
  }), []);

  const loadMoreSaved = useCallback(() => {
    try { routed.loadMoreSaved(); } catch (cause) { setError(appErrorCopy(cause)); }
  }, [routed.loadMoreSaved]);

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

  useEffect(() => {
    setInspectError(desktop && selected ? 'Could not open this corner.' : null);
  }, [desktop, selected]);

  const open = useCallback(
    (target: Target, via: 'bookmark' | 'needs-you') => {
      const responseId = `${via}:${target.messageId}`;
      // Start the Room read now, as a push tap does; the Room takes it by this id.
      router.push(messageJumpHref(target.roomId, target.messageId, responseId, target.workspaceId));
    },
    [router],
  );

  /** Tapped or dismissed: the cell leaves this tray, and every other device's. */
  const clear = useCallback(async (item: NeedsYouItemView, dismissReminder = false) => {
    const generation = clientResetGeneration();

      try {
        await prepareTrayCommand(item.workspaceId, { operation: 'clearNeedsYou', input: {
          workspaceId: item.workspaceId, messageId: item.messageId,
          ...(dismissReminder ? { dismissReminder: true } : {}),
        } })!.deliver();
      } catch (cause) { if (generation === clientResetGeneration()) setError(appErrorCopy(cause)); }
      return;
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
      if (action.kind !== 'external') {
        const command: TrayCommand = action.kind === 'grant'
          ? { operation: 'decideAgentGrant', input: { grantId: action.grantId, decision: action.decision } }
          : action.kind === 'write-access'
            ? { operation: 'decideWritePermission', input: { roomId: item.roomId,
              permissionId: action.permissionId, requestId: action.requestId, agentId: action.agentId,
              repository: action.repository, decision: action.decision } }
            : action.kind === 'choice'
              ? { operation: 'answerChoice', input: { choiceId: action.choiceId, optionId: action.optionId } }
              : { operation: 'skipChoice', input: { choiceId: action.choiceId } };
        await prepareTrayCommand(item.workspaceId, command)!.deliver();
        if (generation === clientResetGeneration()) AccessibilityInfo.announceForAccessibility('Decision sent');
        return;
      }
      // Squire owns its mandate and sign-in ceremony.
      await openExternalUrl(action.url);
    } catch (cause) {
      if (generation === clientResetGeneration())
        setError(appErrorCopy(cause));
    }
  }, []);

  const dismissNeed = useCallback(
    (item: NeedsYouItemView) => {
      AccessibilityInfo.announceForAccessibility('Dismissed from Needs you');
      void clear(item, true);
    },
    [clear],
  );

  /** Send one Workspace-scoped operation after Undo expires. */
  const commitClear = useCallback(async (clear: PendingClear) => {
    const generation = clientResetGeneration();
    if (clear.prepared) {
      try { await clear.prepared.deliver(); }
      catch (cause) { if (generation === clientResetGeneration()) setError(appErrorCopy(cause)); }
      return;
    }
    return;
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

  const visibleNeeds = needs ?? EMPTY_NEEDS;
  const visibleBookmarks = bookmarks;
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
      let prepared: PreparedTrayCommand | undefined;
      try {
        prepared = prepareTrayCommand(workspaceId, kind === 'needs'
          ? { operation: 'clearNeedsYouSection', input: { workspaceId } }
          : { operation: 'clearMessageBookmarks', input: { workspaceId } });
      } catch (cause) { setError(appErrorCopy(cause)); return; }
      if (prepared) void prepared.ready.catch(cause => setError(appErrorCopy(cause)));
      pendingRef.current = [...pendingRef.current, { ...clear, prepared }];
      setPending(pendingRef.current);
      AccessibilityInfo.announceForAccessibility(`${clearedLabel(clear)}. Undo available.`);
    },
    [visibleBookmarks, visibleNeeds, workspaceId, savedNext],
  );

  /** Undo the newest held clear; an older one still in its window shows next. */
  const undoClear = useCallback(() => {
    const clear = pendingRef.current.at(-1);
    if (clear?.prepared) void clear.prepared.cancel().catch(cause => setError(appErrorCopy(cause)));
    pendingRef.current = pendingRef.current.slice(0, -1);
    setPending(pendingRef.current);
    AccessibilityInfo.announceForAccessibility('Restored');
  }, []);

  const remove = useCallback(async (bookmark: MessageBookmarkView) => {
    const generation = clientResetGeneration();

      try {
        await prepareTrayCommand(bookmark.workspaceId, { operation: 'setMessageBookmark', input: {
          roomId: bookmark.roomId, messageId: bookmark.messageId, bookmarked: false,
        } })!.deliver();
        if (generation === clientResetGeneration()) setRemoved(bookmark);
      } catch (cause) { if (generation === clientResetGeneration()) setError(appErrorCopy(cause)); }
      return;
  }, []);

  const undo = useCallback(async () => {
    if (!removed?.available) return;
    const bookmark = removed;
    const generation = clientResetGeneration();

      try {
        await prepareTrayCommand(bookmark.workspaceId, { operation: 'setMessageBookmark', input: {
          roomId: bookmark.roomId, messageId: bookmark.messageId, bookmarked: true,
        } })!.deliver();
        if (generation === clientResetGeneration()) setRemoved(null);
      } catch (cause) { if (generation === clientResetGeneration()) setError(appErrorCopy(cause)); }
      return;
  }, [removed]);

  const rows = useMemo((): Row[] => {
    if (loading || noWorkspace) return [];
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
  }, [loading, visibleBookmarks, visibleNeeds, noWorkspace, savedNext]);

  const renderSaved = (bookmark: MessageBookmarkView) => {
    const source = `${bookmark.roomKind === 'corner' ? 'corner ' : '#'}${sourceTitle(bookmark)}`;
    return (
      <ContentTarget
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
          <Text numberOfLines={1} style={styles.author}>
            {bookmark.available ? bookmark.author?.name : 'Source unavailable'}
          </Text>
          <Text numberOfLines={1} style={styles.time}>{compactRelativeTime(bookmark.bookmarkedAt, now)}</Text>
        </View>
        {bookmark.available ? (
          <Text numberOfLines={desktop ? 2 : 3} style={[styles.excerpt, styles.quote]}
            testID={`bookmark-text-${bookmark.messageId}`}>
            {boldRuns(bookmark.text ?? '').map((run, index) => run.bold
              ? <Text key={index} style={styles.excerptBold}>{run.text}</Text>
              : run.text)}
          </Text>
        ) : (
          <Text style={styles.unavailable}>Deleted or no longer accessible</Text>
        )}
        {sourceTitle(bookmark) ? (
          <InlineRow style={styles.source} testID={`bookmark-source-${bookmark.messageId}`}>
            {bookmark.roomKind === 'corner'
              ? <CornerGlyph size={CORNER_META_SIZE} testID={`bookmark-corner-mark-${bookmark.messageId}`} />
              : <Text style={styles.originSigil}>#</Text>}
            <Text numberOfLines={1} style={styles.origin}>{sourceTitle(bookmark)}</Text>
          </InlineRow>
        ) : null}
        {desktop && bookmark.available ? (
          <View style={styles.rowFooter}>
            <Button
              accessibilityLabel="Remove bookmark"
              accessibilityRole="button"
              onPress={(event) => {
                event.stopPropagation();
                void remove(bookmark);
              }}
              label={'REMOVE'}
              variant="quiet"
              appearance={{ control: styles.remove, label: styles.removeText }}
            />
          </View>
        ) : null}
        {!bookmark.available ? (
          <Button
            accessibilityLabel="Remove unavailable bookmark"
            accessibilityRole="button"
            onPress={() => void remove(bookmark)}
            label={'REMOVE'}
            variant="quiet"
            appearance={{ control: styles.remove, label: styles.removeText }}
          />
        ) : null}
      </ContentTarget>
    );
  };

  const list = (
    <FlatList
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={viewabilityConfig}
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
            <Button
              accessibilityRole="button"
              onPress={() => router.replace('/beeline/channels')}
              label={'BACK TO ROOMS'}
              variant="quiet"
              appearance={{ control: styles.remove, label: styles.removeText }}
            />
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
                    <Button
                      accessibilityLabel={`Clear ${row.title}`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => clearSection(row.clear!)}
                      testID={`tray-clear-${row.clear}`}
                      label={'CLEAR'}
                      variant="quiet"
                      appearance={{
                        control: ({ pressed }) => [styles.sectionClear, pressed && { opacity: 0.7 }],
                        label: styles.removeText,
                      }}
                    />
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
              <Button
                accessibilityRole="button"
                onPress={() => void loadMoreSaved()}
                testID="bookmarks-more"
                label={'LOAD MORE SAVED'}
                variant="quiet"
                appearance={{ control: styles.emptyBlock, label: styles.removeText }}
              />
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
    desktop ? (
      <View style={styles.paneFallback} testID="tray-pane">
        {selectedBookmark && !selectedBookmark.available ? (
          <View style={styles.emptyBlock}>
            <Text style={styles.emptyTitle}>Source unavailable</Text>
            <Text style={styles.empty}>This bookmark no longer exposes message content.</Text>
            <Button
              accessibilityLabel="Remove unavailable bookmark"
              accessibilityRole="button"
              onPress={() => void remove(selectedBookmark)}
              label={'REMOVE'}
              variant="quiet"
              appearance={{ control: styles.remove, label: styles.removeText }}
            />
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
      {error || routed.error || routed.savedError ? (
        <SettingsRow title={error ?? routed.error ?? routed.savedError!} action="Retry" onPress={() => {setError(null);routed.retry();}}
          />
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
            <Button
              accessibilityRole="button"
              onPress={() => void undo()}
              label={'UNDO'}
              variant="quiet"
              appearance={{ control: styles.undoAction, label: styles.undoActionText }}
            />
          ) : null}
        </View>
      ) : null}
      {/* A held clear keeps its UNDO in reach above a bookmark removal's bar. */}
      {newestClear ? (
        <View accessibilityLiveRegion="polite" testID="tray-clear-undo"
          style={[styles.undo, desktop && styles.desktopUndo,
            { bottom: 16 + insets.bottom + (removed ? UNDO_STACK : 0) }]}>
          <Text style={styles.undoText}>{clearedLabel(newestClear)}</Text>
          <Button
            accessibilityRole="button"
            onPress={undoClear}
            label={'UNDO'}
            variant="quiet"
            appearance={{ control: styles.undoAction, label: styles.undoActionText }}
          />
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
    maxWidth: desktopColumnWidths.list, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: theme.buzz.border,
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
    minHeight: 78, padding: theme.buzz.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.buzz.border,
  },
  rowSelected: { backgroundColor: theme.buzz.bgHighlight },
  rowUnavailable: { opacity: 0.68 },
  // A saved row reads like a Needs you cell: who and age, the quoted words, then where.
  originLine: { flexDirection: 'row', alignItems: 'baseline', gap: theme.buzz.space.sm },
  source: { minWidth: 0, alignItems: 'center', gap: theme.buzz.space.sm, marginTop: theme.buzz.space.xs },
  originSigil: { ...theme.buzz.type.meta, color: brand.mark },
  origin: { ...theme.buzz.type.meta, flexShrink: 1, color: theme.buzz.ledgerQuiet },
  time: { ...theme.buzz.type.meta, flexShrink: 0, color: theme.buzz.ledgerQuiet },
  author: { ...theme.buzz.type.bodyStrong, flex: 1, color: theme.buzz.textPrimary },
  excerpt: {
    ...theme.buzz.type.body, color: theme.buzz.textPrimary, marginTop: theme.buzz.space.xs,
  },
  excerptBold: { ...theme.buzz.type.bodyStrong },
  quote: {
    paddingLeft: theme.buzz.space.sm, borderLeftWidth: 2, borderLeftColor: theme.buzz.borderStrong,
  },
  unavailable: {
    ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: theme.buzz.space.xs,
  },
  rowFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: theme.buzz.space.sm },
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
