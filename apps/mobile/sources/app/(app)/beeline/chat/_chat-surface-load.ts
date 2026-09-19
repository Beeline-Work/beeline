/** Shared 6k chrome load. The deck starts it; the Room route consumes it. */
import { markRoomOpen } from '@/buzz/room-open-trace';

type ChatSurfaceModule = typeof import('./_chat-surface');

let pending: Promise<ChatSurfaceModule> | null = null;

export function preloadChatSurface(): Promise<ChatSurfaceModule> {
  if (!pending) {
    markRoomOpen('surface-preload-start');
    pending = import('./_chat-surface').then((mod) => {
      markRoomOpen('surface-preload-end');
      return mod;
    });
  }
  return pending;
}
