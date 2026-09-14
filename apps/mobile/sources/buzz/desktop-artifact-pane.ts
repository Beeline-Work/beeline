import type { AttachmentReference } from '@beeline/buzz-client';

export interface DesktopArtifactSelection {
  attachment: AttachmentReference;
  authorHandle?: string;
}

const listeners = new Set<(selection: DesktopArtifactSelection | null) => void>();
let current: DesktopArtifactSelection | null = null;

/**
 * The desktop work pane is a sibling surface of the Room route, so artifact
 * selection travels as a tiny module event — the same presentation-only
 * pattern as corner selection (`desktop-work-pane.ts`). The URL stays on the
 * Room; the pane shows the artifact sandboxed in an iframe.
 */
export function openArtifactInDesktopWorkPane(selection: DesktopArtifactSelection): void {
  current = selection;
  for (const listener of listeners) listener(selection);
}

export function clearDesktopArtifactPane(): void {
  current = null;
  for (const listener of listeners) listener(null);
}

export function currentDesktopArtifact(): DesktopArtifactSelection | null {
  return current;
}

export function subscribeDesktopArtifact(
  listener: (selection: DesktopArtifactSelection | null) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
