import type { AttachmentReference } from '@beeline/buzz-client';

export interface DesktopArtifactSelection {
  attachment: AttachmentReference;
  authorHandle?: string;
}

const listeners = new Set<(selection: DesktopArtifactSelection) => boolean>();

/**
 * The desktop work pane is a sibling surface of the Room route, so artifact
 * selection travels as a tiny module event — the same presentation-only
 * pattern as corner selection (`desktop-work-pane.ts`). The URL stays on the
 * Room; the pane shows the artifact sandboxed in an iframe. The pane keeps no
 * copy here: what it shows lives only in its one pane state.
 *
 * Returns false when no second pane took the artifact (a narrow window, a
 * direct message), so the caller opens the full-screen viewer instead.
 */
export function openArtifactInDesktopWorkPane(selection: DesktopArtifactSelection): boolean {
  for (const listener of listeners) {
    if (listener(selection)) return true;
  }
  return false;
}

export function subscribeDesktopArtifact(
  listener: (selection: DesktopArtifactSelection) => boolean,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
