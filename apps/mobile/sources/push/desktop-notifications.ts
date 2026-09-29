import type { ChatListItem, RoomViewMessage } from '@beeline/buzz-client';
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
import { isTauri } from '@/utils/isTauri';

/** The Tauri process must remain running and connected. A quit app has no desktop remote token. */
export function startDesktopNotifications(): () => void {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let generation = 0;
  let stopSession: (() => void) | undefined;
  let stopRooms: (() => void) | undefined;
  let stopWorkspaces: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function startForIdentity() {
    const current = ++generation;
    stopRooms?.();
    stopWorkspaces?.();
    if (timer) clearInterval(timer);
    const identity = await loadBuzzIdentity();
    if (!identity || disposed || current !== generation) return;
    // Permission belongs to the installed native app. This request is
    // independent of the phone's FCM/APNs device-token registration.
    const native = await import('@tauri-apps/plugin-notification');
    if (!(await native.isPermissionGranted())) await native.requestPermission();
    if (disposed || current !== generation) return;
    const transport = new BuzzRigTransport(identity);
    const relay = await transport.ensureClient();
    const reader = new RoomViewClient({ baseUrl: await getEffectiveRelayUrl(), identity });
    let rooms = new Map<string, ChatListItem>();
    let watchKey = '';
    let refreshing = false;
    let pendingRefresh = false;
    const seen = new Set<string>();
    const startedAt = Date.now();

    async function display(roomId: string, message: RoomViewMessage) {
      if (disposed || current !== generation || seen.has(message.id)) return;
      seen.add(message.id);
      if (seen.size > 1_000) seen.delete(seen.values().next().value!);
      // Replayed socket frames and edits must not turn old content into a new alert.
      if ((message.createdAtMs ?? message.createdAt * 1000) < startedAt) return;
      const room = rooms.get(roomId);
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
        title: room.directMessage ? message.author.name : room.room.name,
        body: (room.directMessage ? message.text : `${message.author.name}: ${message.text}`).slice(
          0,
          240,
        ),
      });
    }

    async function refresh() {
      if (refreshing) {
        pendingRefresh = true;
        return;
      }
      refreshing = true;
      try {
        const workspaces = await reader.workspaces();
        const lists = await Promise.all(
          workspaces.workspaces.map((workspace) => reader.chats(workspace.id)),
        );
        if (disposed || current !== generation) return;
        const parents = lists.flatMap((chats) => chats.chats);
        // A corner is its own Room and its messages do not ride the parent's
        // socket filter. Read each active parent with corners so the same
        // signed-in member can receive an exact tag there too.
        const cornerReads = await Promise.allSettled(
          parents
            .filter((room) => (room.cornerCount ?? room.openCorners?.length ?? 0) > 0)
            .map((room) => reader.corners(room.room.id)),
        );
        if (disposed || current !== generation) return;
        const corners = cornerReads.flatMap((result) =>
          result.status === 'fulfilled' ? result.value.corners : [],
        );
        rooms = new Map([
          ...parents.map((room) => [room.room.id, room] as const),
          ...corners.map(
            (item) =>
              [item.corner.id, { room: item.corner, unread: false } as ChatListItem] as const,
          ),
        ]);
        const filters = [
          ...lists.flatMap((chats) => chats.watchFilters),
          ...corners.map((item) => ({ '#h': [item.corner.id] })),
        ];
        const nextKey = chatWatchFiltersKey(filters);
        if (nextKey === watchKey) return;
        const nextStop = filters.length
          ? await relay.surfaceSubscribe(filters, (event) => {
              const live =
                'monolithLive' in event ? (event as MonolithSurfaceEvent).monolithLive : undefined;
              if (live?.type === 'message-delta')
                void display(live.roomId, live.message).catch(report);
              if (live?.type === 'invalidate' && !live.messageId) void refresh().catch(report);
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
        refreshing = false;
        if (pendingRefresh && !disposed && current === generation) {
          pendingRefresh = false;
          void refresh();
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
    await refresh();
    timer = setInterval(() => void refresh(), 30_000);
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
    stopRooms?.();
    stopWorkspaces?.();
    if (timer) clearInterval(timer);
  };
}
