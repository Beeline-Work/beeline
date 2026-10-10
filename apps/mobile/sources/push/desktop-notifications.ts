import type { ChatListItem, RoomViewMessage } from '@beeline/buzz-client';
import { cornerTitle, directMessageTitle, roomTitle } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { monolithSession } from '@/auth/monolith-session';
import { getOpenBuzzChannelId } from '@/buzz/open-room-tracker';
import { getBuzzPushEnabled } from './buzz-push-registration';
import { loadStoredPushLevel } from './push-level-storage';
import { desktopMessageMayNotify } from './desktop-notification-policy';
import { RoomViewClient, BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { chatWatchFiltersKey } from '@/buzz/chat-list-delta';
import { acquireChatList, type ChatListHandle } from '@/buzz/chat-list-store';
import { isTauri } from '@/utils/isTauri';

/**
 * The notification's title, from the same chat-title module as the in-app
 * header and list: `@peer` for a DM, `#room/corner` for a corner (when its
 * parent Room is known), `#room` for a Room.
 */
export function desktopNotificationTitle(
  room: Pick<ChatListItem, 'room' | 'directMessage'>,
  parentRoomName?: string,
): string {
  if (room.directMessage) return directMessageTitle(room.directMessage.peer);
  if (parentRoomName !== undefined)
    return cornerTitle(parentRoomName, room.room.name, room.room.id);
  return roomTitle(room.room.name) ?? room.room.name;
}

/** The Tauri process must remain running and connected. A quit app has no desktop remote token. */
export function startDesktopNotifications(): () => void {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let generation = 0;
  let stopSession: (() => void) | undefined;
  let stopRooms: (() => void) | undefined;
  let stopLists: (() => void) | undefined;
  let stopWorkspaces: (() => void) | undefined;
  let stopConnected: (() => void) | undefined;

  async function startForIdentity() {
    const current = ++generation;
    stopLists?.();
    stopLists = undefined;
    stopRooms?.();
    stopWorkspaces?.();
    stopConnected?.();
    const identity = await loadBuzzIdentity();
    if (!identity || disposed || current !== generation) return;
    // Permission belongs to the installed native app. This request is
    // independent of the phone's FCM/APNs device-token registration.
    const native = await import('@tauri-apps/plugin-notification');
    if (!(await native.isPermissionGranted())) await native.requestPermission();
    if (disposed || current !== generation) return;
    const transport = new BuzzRigTransport(identity);
    const relay = await transport.ensureClient();
    const relayUrl = await getEffectiveRelayUrl();
    if (disposed || current !== generation) return;
    const reader = new RoomViewClient({ baseUrl: relayUrl, identity });
    // Each Workspace's Rooms come from the app-level Room list store, which
    // owns their watch and covering reads. Corners are read here.
    const lists = new Map<string, { handle: ChatListHandle; stop: () => void }>();
    let corners = new Map<string, ChatListItem>();
    // Each corner's parent Room id; its name is taken from the store when shown.
    let cornerParentIds = new Map<string, string>();
    let cornerKey = '';
    let watchKey = '';
    let refreshing = false;
    let pendingRefresh = false;
    let following = false;
    let pendingFollow = false;
    stopLists = () => {
      for (const list of lists.values()) {
        list.stop();
        list.handle.release();
      }
      lists.clear();
    };

    function roomFor(roomId: string): ChatListItem | undefined {
      for (const { handle } of lists.values()) {
        const item = handle.current()?.chats.find((chat) => chat.room.id === roomId);
        if (item) return item;
      }
      return corners.get(roomId);
    }

    function parentNameOf(roomId: string): string | undefined {
      const parentId = cornerParentIds.get(roomId);
      return parentId === undefined ? undefined : roomFor(parentId)?.room.name;
    }
    const seen = new Set<string>();
    const startedAt = Date.now();

    async function display(roomId: string, message: RoomViewMessage) {
      if (disposed || current !== generation || seen.has(message.id)) return;
      seen.add(message.id);
      if (seen.size > 1_000) seen.delete(seen.values().next().value!);
      // Replayed socket frames and edits must not turn old content into a new alert.
      if ((message.createdAtMs ?? message.createdAt * 1000) < startedAt) return;
      const room = roomFor(roomId);
      if (!room) return;
      // Most live rows need no network or plugin work. In particular a
      // foreground message must never wait on the notification path.
      if (document.hasFocus() || getOpenBuzzChannelId() === roomId) return;
      if (
        !room.directMessage &&
        !message.mentionPubkeys?.includes(identity!.publicKey) &&
        !message.reply
      )
        return;
      const enabled = await getBuzzPushEnabled(identity!.publicKey);
      if (!enabled) return;
      const managed = await monolithPhoneOperation('getManagedIdentity', {}).catch(() => null);
      const level = managed?.pushLevel ?? (await loadStoredPushLevel(identity!.publicKey));
      let repliedToViewer = false;
      if (
        !room.directMessage &&
        message.reply &&
        !message.mentionPubkeys?.includes(identity!.publicKey)
      ) {
        // The canonical reply pointer is eventId. Never substitute rootId: that
        // would notify a root author for replies to somebody else's child.
        const view = await reader.room(roomId).catch(() => null);
        repliedToViewer =
          view?.messages.some(
            (row) => row.id === message.reply?.eventId && row.author.pubkey === identity!.publicKey,
          ) ?? false;
      }
      if (
        !desktopMessageMayNotify({
          message,
          room,
          viewerPubkey: identity!.publicKey,
          level,
          repliedToViewer,
          openChannelId: getOpenBuzzChannelId(),
          windowFocused: document.hasFocus(),
        })
      )
        return;
      const notification = await import('@tauri-apps/plugin-notification');
      if (!(await notification.isPermissionGranted()) || disposed || current !== generation) return;
      notification.sendNotification({
        title: desktopNotificationTitle(room, parentNameOf(roomId)),
        body: (room.directMessage ? message.text : `${message.author.name}: ${message.text}`).slice(
          0,
          240,
        ),
      });
    }

    /** Read the Workspace list, hold each Workspace's Room list, and read each once more. */
    async function refresh() {
      if (refreshing) {
        pendingRefresh = true;
        return;
      }
      refreshing = true;
      try {
        const workspaces = await reader.workspaces();
        if (disposed || current !== generation) return;
        const ids = new Set(workspaces.workspaces.map((workspace) => workspace.id));
        for (const [id, list] of lists) {
          if (ids.has(id)) continue;
          list.stop();
          list.handle.release();
          lists.delete(id);
        }
        for (const id of ids) {
          const held = lists.get(id);
          if (held) {
            held.handle.force();
            continue;
          }
          const handle = acquireChatList(
            { relayUrl, viewerPubkey: identity!.publicKey, workspaceId: id },
            // Notifications need the list current whenever the app runs.
            { visible: () => true, onError: report },
          );
          lists.set(id, { handle, stop: handle.subscribe(() => void follow()) });
        }
        // A covering refresh reads the corners again too.
        cornerKey = '';
        await follow();
      } catch (error) {
        report(error);
      } finally {
        refreshing = false;
        if (pendingRefresh && !disposed && current === generation) {
          pendingRefresh = false;
          void refresh();
        }
      }
    }

    /** Follow the held Room lists: read the corners they name and watch every Room for messages. */
    async function follow() {
      if (following) {
        pendingFollow = true;
        return;
      }
      following = true;
      try {
        const views = [...lists.values()].flatMap(({ handle }) => {
          const view = handle.current();
          return view ? [view] : [];
        });
        const parents = views.flatMap((view) => view.chats);
        // A corner is its own Room and its messages do not ride the parent's
        // socket filter. Read each active parent with corners so the same
        // signed-in member can receive an exact tag there too.
        const cornerParents = parents.filter(
          (room) => (room.cornerCount ?? room.openCorners?.length ?? 0) > 0,
        );
        const nextCornerKey = JSON.stringify(cornerParents.map((room) =>
          [room.room.id, room.cornerCount ?? room.openCorners?.length ?? 0]));
        if (nextCornerKey !== cornerKey) {
          const cornerReads = await Promise.allSettled(
            cornerParents.map((room) => reader.corners(room.room.id)),
          );
          if (disposed || current !== generation) return;
          const cornerReadsWithParent = cornerReads.flatMap((result, index) =>
            result.status === 'fulfilled'
              ? result.value.corners.map((item) => ({
                  item,
                  parentId: cornerParents[index]!.room.id,
                }))
              : [],
          );
          cornerKey = nextCornerKey;
          cornerParentIds = new Map(
            cornerReadsWithParent.map(({ item, parentId }) => [item.corner.id, parentId]),
          );
          corners = new Map(
            cornerReadsWithParent.map(({ item }) =>
              [item.corner.id, { room: item.corner, unread: false } as ChatListItem] as const),
          );
        }
        const filters = [
          ...views.flatMap((view) => view.watchFilters),
          ...[...corners.keys()].map((id) => ({ '#h': [id] })),
        ];
        const nextKey = chatWatchFiltersKey(filters);
        if (nextKey === watchKey) return;
        const nextStop = filters.length
          ? await relay.surfaceSubscribe(filters, (event) => {
              const live =
                'monolithLive' in event ? (event as MonolithSurfaceEvent).monolithLive : undefined;
              if (live?.type === 'message-delta')
                void display(live.roomId, live.message).catch(report);
            })
          : undefined;
        if (disposed || current !== generation) {
          nextStop?.();
          return;
        }
        stopRooms?.();
        stopRooms = nextStop;
        watchKey = nextKey;
      } catch (error) {
        report(error);
      } finally {
        following = false;
        if (pendingFollow && !disposed && current === generation) {
          pendingFollow = false;
          void follow();
        }
      }
    }

    const workspaceStop = await relay.surfaceSubscribe(
      [{ '#p': [identity.publicKey] }],
      () => void refresh(),
    );
    if (disposed || current !== generation) {
      workspaceStop();
      return;
    }
    stopWorkspaces = workspaceStop;
    // Clients never poll: the #p subscription's invalidate events and the
    // room/corner subscriptions' message-deltas are the ordinary drive. The
    // one exception is a genuine reconnect, where the socket itself may have
    // missed events while it was down — a single covering re-read then, not
    // a recurring timer, is what reconciles it.
    let initialReadDone = false;
    stopConnected = transport.subscribeConnected(() => {
      if (!initialReadDone || disposed || current !== generation) return;
      void refresh().catch(report);
    });
    await refresh();
    initialReadDone = true;
  }

  function report(error: unknown) {
    console.warn('[desktop-notifications]', error);
  }
  stopSession = monolithSession.subscribeIdentityChange(
    () => void startForIdentity().catch(report),
  );
  void startForIdentity().catch(report);
  return () => {
    disposed = true;
    generation += 1;
    stopSession?.();
    stopLists?.();
    stopRooms?.();
    stopWorkspaces?.();
    stopConnected?.();
  };
}
