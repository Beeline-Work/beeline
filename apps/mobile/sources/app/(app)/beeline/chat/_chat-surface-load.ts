/** Shared 6k chrome load. The Room route starts it after the newest-row pixel
 *  so a pending `import()` cannot occupy the tap-to-pixel JS thread. */
import { markRoomOpen } from '@/buzz/room-open-trace';

type ChatSurfaceModule = typeof import('./_chat-surface');

export type ChatSurfaceImporter = () => Promise<ChatSurfaceModule>;

const defaultImporter: ChatSurfaceImporter = () => import('./_chat-surface');

let importer: ChatSurfaceImporter = defaultImporter;
let pending: Promise<ChatSurfaceModule> | null = null;
let generation = 0;

export function preloadChatSurface(): Promise<ChatSurfaceModule> {
  if (!pending) {
    const started = generation;
    markRoomOpen('surface-preload-start');
    pending = importer()
      .then((mod) => {
        markRoomOpen('surface-preload-end');
        return mod;
      })
      .catch((error: unknown) => {
        if (started === generation) {
          pending = null;
          markRoomOpen('surface-preload-error');
        }
        throw error;
      });
  }
  return pending;
}

/** Start chrome evaluation only once the caller reports the newest-row pixel
 *  and the current interaction has settled. A rejected chunk is not cached. */
export function attachChatSurfaceAfterPaint(
  onReady: (mod: ChatSurfaceModule) => void,
  whenIdle: (run: () => void) => () => void,
): () => void {
  let cancelled = false;
  const stopIdle = whenIdle(() => {
    if (cancelled) return;
    markRoomOpen('surface-import-start');
    const deliver = (mod: ChatSurfaceModule) => {
      if (cancelled) return;
      markRoomOpen('surface-import-end');
      onReady(mod);
    };
    void preloadChatSurface()
      .then(deliver)
      .catch(() => {
        if (cancelled) return;
        // Rejected chunk is not cached; one retry, then keep the thin shell.
        void preloadChatSurface().then(deliver).catch(() => undefined);
      });
  });
  return () => {
    cancelled = true;
    stopIdle();
  };
}

export function resetChatSurfacePreloadForTests(next?: ChatSurfaceImporter): void {
  generation += 1;
  pending = null;
  importer = next ?? defaultImporter;
}
