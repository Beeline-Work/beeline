import { appErrorCopy } from '@/buzz/app-error-copy';
import { invalidatesWorkspaceList } from '@/buzz/workspace-list-invalidation';
import { takePendingBrowserShare } from '@/buzz/pending-browser-share';
import { RoomViewHttpError } from '@beeline/buzz-client';
import { acquireChatList, type ChatListHandle } from '@/buzz/chat-list-store';
import { saveActiveCommunityId } from '@/buzz/community-storage';
import { loadPendingInvite } from '@/buzz/pending-invite';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { clientResetGeneration } from '@/sync/client-reset';
import { BuzzRigTransport } from '@/sync/transport';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { isWorkspaceListView, isWorkspaceView, type ChatListView, type Identity } from '@beeline/buzz-client';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { startTransition, useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { AGE_TICK_MS } from './channels';

type Props = [
  drawn: boolean,
  setConfirmedWorkspaceCount: import("react/index").Dispatch<import("react/index").SetStateAction<number | null>>,
  deckMissedRef: import("react/index").RefObject<{ workspaces: boolean; }>,
  deckVisible: () => boolean,
  refreshMissed: () => void,
  setError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  identity: Identity,
  relayUrl: string,
  deckFocusedRef: import("react/index").RefObject<boolean>,
  transport: BuzzRigTransport,
  setDeletedWorkspaceNotice: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  selectedId: string | undefined,
  chatStore: import("react/index").RefObject<ChatListHandle | null>,
  setChatList: import("react/index").Dispatch<import("react/index").SetStateAction<ChatListView | null>>,
  setMemberPickerVisible: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setRefreshing: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  readWorkspaceRef: import("react/index").RefObject<(() => Promise<void>) | null>,
  setNeedsYouSignal: import("react/index").Dispatch<import("react/index").SetStateAction<number>>,
  retryGeneration: number,
  setAgeNow: import("react/index").Dispatch<import("react/index").SetStateAction<number>>,
  activeCommunityId: string,
  memberPickerVisible: boolean,
];
export function useChannelsSubscriptions([
  drawn, setConfirmedWorkspaceCount, deckMissedRef, deckVisible, refreshMissed, setError, identity,
  relayUrl, deckFocusedRef, transport, setDeletedWorkspaceNotice, selectedId, chatStore,
  setChatList, setMemberPickerVisible, setRefreshing, readWorkspaceRef, setNeedsYouSignal,
  retryGeneration, setAgeNow, activeCommunityId, memberPickerVisible,
]: Props): [

] {


  useEffect(() => {
    if (!drawn) return;
    setConfirmedWorkspaceCount(null);
    let cancelled = false;
    const identityGeneration = clientResetGeneration();
    deckMissedRef.current = { workspaces: false };
    const activation = AppState.addEventListener('change', (state) => {
      if (
        state === 'active' &&
        !cancelled &&
        identityGeneration === clientResetGeneration() &&
        deckVisible()
      )
        refreshMissed();
    });
    let unsubscribeWorkspaces: (() => void) | undefined;
    let unsubscribeChats: (() => void) | undefined;
    let readWorkspace: (() => Promise<void>) | undefined;
    let releaseChats: (() => void) | undefined;
    void (async () => {
      setError(null);
      const nextIdentity = identity;
      const nextRelayUrl = relayUrl;
      const pendingInvite = await loadPendingInvite();
      if (cancelled) return;
      // An invite opened before sign-in outranks every other landing.
      if (pendingInvite && deckFocusedRef.current) {
        if (!cancelled)
          router.replace({ pathname: '/join/[token]', params: { token: pendingInvite } });
        return;
      }
      if (cancelled) return;
      const browserShareId = deckFocusedRef.current ? await takePendingBrowserShare() : null;
      if (cancelled) return;
      if (browserShareId && deckFocusedRef.current) {
        router.replace({ pathname: '/beeline/browser-share', params: { id: browserShareId } });
        return;
      }
      const nextTransport = transport;
      const http = new RoomViewClient({ baseUrl: nextRelayUrl, identity: nextIdentity });
      const relayPromise = nextTransport.ensureClient();

      const workspaceCacheAddress = surfaceAddress(
        nextRelayUrl,
        nextIdentity.publicKey,
        '/workspaces',
      );
      const cachedWorkspaces = mobileSurfaceCache.peek(workspaceCacheAddress, isWorkspaceListView);
      if (cancelled) return;
      let selectedWorkspaceRemoved = false;

      readWorkspace = async () => {
        if (cancelled) return;
        try {
          deckMissedRef.current.workspaces = false;
          const value = await mobileSurfaceCache.fetch(workspaceCacheAddress, isWorkspaceListView, () =>
            http.workspaces(),
          );
          if (cancelled) return;

          // Null: an eviction overtook the read; there is nothing to paint.
          if (!value) return;
          setConfirmedWorkspaceCount(value.workspaces.length);
          if (value.deletedNotices?.length) {
            setDeletedWorkspaceNotice('This workspace was deleted by its owner');
          }
          if (!selectedId || !value.workspaces.some((workspace) => workspace.id === selectedId)) {
            selectedWorkspaceRemoved = true;
            unsubscribeChats?.();
            unsubscribeChats = undefined;
            chatStore.current = null;
            if (chats) void chats.remove();
            setChatList(null);
            setMemberPickerVisible(false);
            setRefreshing(false);
            setError(null);
            const nextId = value.workspaces[0]?.id ?? null;
            void saveActiveCommunityId(nextIdentity.publicKey, nextId);
            if (nextId && deckFocusedRef.current) {
              router.replace({
                pathname: '/beeline/channels',
                params: { communityId: nextId },
              } as never);
            }
          }
        } catch (reason) {
          if (!cancelled) {
            setError(appErrorCopy(reason));
          }
        }
      };
      readWorkspaceRef.current = readWorkspace;

      // The app-level Room list owns its live watch, covering reads and disk
      // copy; the deck paints it and reports whether it is on view.
      const chats = selectedId
        ? acquireChatList(
            {
              relayUrl: nextRelayUrl,
              viewerPubkey: nextIdentity.publicKey,
              workspaceId: selectedId,
            },
            {
              visible: deckVisible,
              onRead: () => {
                if (selectedWorkspaceRemoved) return;
                setNeedsYouSignal((signal) => signal + 1);
                setRefreshing(false);
                setError(null);
              },
              onError: (reason) => {
                if (selectedWorkspaceRemoved) return;
                setRefreshing(false);
                setError(appErrorCopy(reason));
                // A deleted Workspace's old route may be restored from storage
                // before the authoritative workspace read has reconciled it.
                if (
                  reason instanceof RoomViewHttpError &&
                  (reason.status === 403 || reason.status === 404)
                )
                  void readWorkspace?.();
              },
            },
          )
        : null;
      releaseChats = () => chats?.release();
      if (chats) {
        chatStore.current = chats;
        const paint = () => {
          if (!selectedWorkspaceRemoved) setChatList(chats.current());
        };
        paint();
        // A store another screen already read is current: it seeds the badge.
        if (chats.confirmed()) setNeedsYouSignal((signal) => signal + 1);
        // Saved Rooms are the first usable deck; paint them immediately.
        // Confirmed live reconciliation still yields to Room or push navigation.
        unsubscribeChats = chats.subscribe(() => {
          if (chats.confirmed() || !deckVisible()) startTransition(paint);
          else paint();
        });
      }
      const relay = await relayPromise;
      if (cancelled) return;

      const workspaceListenReady = relay
        .surfaceSubscribe(
          cachedWorkspaces?.watchFilters ?? [
            { kinds: [9000, 9001, 9007], '#p': [nextIdentity.publicKey] },
          ],
          (event) => {
            if (
              cancelled ||
              identityGeneration !== clientResetGeneration() ||
              !invalidatesWorkspaceList(event)
            )
              return;
            if (deckVisible()) void readWorkspace?.();
            else deckMissedRef.current.workspaces = true;
          },
        )
        .then((stop) => {
          if (cancelled) stop();
          else unsubscribeWorkspaces = stop;
        });
      await workspaceListenReady;
      await readWorkspace();
    })().catch((reason) => {
      if (!cancelled) setError(appErrorCopy(reason));
    });
    return () => {
      cancelled = true;
      activation.remove();
      unsubscribeWorkspaces?.();
      unsubscribeChats?.();
      releaseChats?.();
      readWorkspaceRef.current = null;
      chatStore.current = null;
    };
  }, [drawn, identity, relayUrl, transport, selectedId, deckVisible, refreshMissed, retryGeneration]);


  useFocusEffect(
    useCallback(() => {
      deckFocusedRef.current = true;
      refreshMissed();
      setAgeNow(Date.now());
      const timer = setInterval(() => setAgeNow(Date.now()), AGE_TICK_MS);
      return () => {
        deckFocusedRef.current = false;
        clearInterval(timer);
      };
    }, [activeCommunityId, refreshMissed]),
  );

  useEffect(() => {
    if (!memberPickerVisible || !identity || !relayUrl || !activeCommunityId) return;
    let cancelled = false;
    const http = new RoomViewClient({ baseUrl: relayUrl, identity });
    const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', {
      workspaceId: activeCommunityId,
    });
    void mobileSurfaceCache
      .read(address, isWorkspaceView)
      .then(
        (cached) =>
          cached ??
          mobileSurfaceCache.fetch(address, isWorkspaceView, () =>
            http.workspace(activeCommunityId),
          ),
      )
      .catch((reason) => {
        if (!cancelled) setError(appErrorCopy(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [activeCommunityId, identity, memberPickerVisible, relayUrl]);
return [

  ];
}
