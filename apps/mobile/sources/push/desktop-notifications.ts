import type { ChatListItem, RoomViewMessage } from '@beeline/buzz-client';
import { cornerTitle, directMessageTitle, roomTitle } from '@beeline/api-contract/phone';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { subscribeClientReset } from '@/sync/client-reset';
import { getOpenBuzzChannelId } from '@/buzz/open-room-tracker';
import { getBuzzPushEnabled } from './buzz-push-registration';
import { loadStoredPushLevel } from './push-level-storage';
import { desktopMessageMayNotify } from './desktop-notification-policy';
import { RoomViewClient, BuzzRigTransport } from '@/sync/transport';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { chatWatchFiltersKey } from '@/buzz/chat-list-delta';
import { acquireChatList, type ChatListHandle } from '@/buzz/chat-list-store';
import {
  applyCornerListRead,
  cornerReadMark,
  getRoomCornerSummary,
  getRoomCorners,
  roomOpenCornerRows,
  subscribeRoomCornerSummaries,
} from '@/buzz/room-corner-store';
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
    // owns their watch and covering reads. Corner rows come from the corner
    // store; the reads made here land there too.
    const lists = new Map<string, { handle: ChatListHandle; stop: () => void }>();
    // The parent Rooms with corners, as of the last follow.
    let cornerParentIds: readonly string[] = [];
    let cornerKey = '';
    let watchKey = '';
    let refreshing = false;
    let pendingRefresh = false;
    let following = false;
    let pendingFollow = false;
    // A Room's corner count lives in the corner store, so its changes follow too.
    const stopSummaries = subscribeRoomCornerSummaries(() => void follow());
    stopLists = () => {
      stopSummaries();
      for (const list of lists.values()) {
        list.stop();
        list.handle.release();
      }
      lists.clear();
    };

    function listedRoom(roomId: string): ChatListItem | undefined {
      for (const { handle } of lists.values()) {
        const item = handle.current()?.chats.find((chat) => chat.room.id === roomId);
        if (item) return item;
      }
      return undefined;
    }

    /** The parent Room id and corner row the corner store holds for `cornerId`. */
    function cornerFor(cornerId: string) {
      for (const parentId of cornerParentIds) {
        const row = roomOpenCornerRows(getRoomCorners(parentId))
          .find((item) => item.corner.id === cornerId);
        if (row) return { parentId, row };
      }
      return undefined;
    }

    function roomFor(roomId: string): Pick<ChatListItem, 'room' | 'directMessage'> | undefined {
      const listed = listedRoom(roomId);
      if (listed) return listed;
      const corner = cornerFor(roomId);
      return corner ? { room: corner.row.corner } : undefined;
    }

    function parentNameOf(roomId: string): string | undefined {
      const corner = cornerFor(roomId);
      return corner ? listedRoom(corner.parentId)?.room.name : undefined;
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
        const cornerCount = (room: ChatListItem) => getRoomCornerSummary(room.room.id)?.cornerCount ?? 0;
        const cornerParents = parents.filter((room) => cornerCount(room) > 0);
        const nextCornerKey = JSON.stringify(cornerParents.map((room) =>
          [room.room.id, cornerCount(room)]));
        if (nextCornerKey !== cornerKey) {
          await Promise.allSettled(
            cornerParents.map(async (room) => {
              const mark = cornerReadMark(room.room.id);
              applyCornerListRead(room.room.id, await reader.corners(room.room.id), mark);
            }),
          );
          if (disposed || current !== generation) return;
          cornerKey = nextCornerKey;
          cornerParentIds = cornerParents.map((room) => room.room.id);
        }
        const filters = [
          ...views.flatMap((view) => view.watchFilters),
          ...cornerParentIds.flatMap((parentId) =>
            roomOpenCornerRows(getRoomCorners(parentId)).map((item) => ({ '#h': [item.corner.id] }))),
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
  stopSession = subscribeClientReset(
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
