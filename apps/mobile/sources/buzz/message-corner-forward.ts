import { openRandomNamedCorner, type OpenRandomNamedCornerInput } from './open-random-corner';

/** Forward text waiting for a new corner's composer, keyed by corner id. */
const stagedDrafts = new Map<string, string>();

/** Hand a composer draft to the corner screen that opens next. */
export function stageCornerComposerDraft(cornerId: string, text: string): void {
  stagedDrafts.set(cornerId, text);
}

/** Read a staged draft once; a second mount of the same corner starts empty. */
export function takeCornerComposerDraft(cornerId: string): string | undefined {
  const text = stagedDrafts.get(cornerId);
  stagedDrafts.delete(cornerId);
  return text;
}

export type ForwardMessageToNewCornerInput = OpenRandomNamedCornerInput & {
  confirm: () => Promise<boolean>;
  /** The message already formatted as a forward. */
  forwardText: string;
};

/**
 * Mobile swipe-right on a message: after the person confirms, create a
 * human-owned corner and open it with the message staged as a forward in its
 * composer. Declining creates nothing.
 */
export async function forwardMessageToNewCorner(
  input: ForwardMessageToNewCornerInput,
): Promise<{ id: string; title: string } | null> {
  if (!(await input.confirm())) return null;
  return openRandomNamedCorner({
    ...input,
    openCorner: (cornerId, title) => {
      stageCornerComposerDraft(cornerId, input.forwardText);
      input.openCorner(cornerId, title);
    },
  });
}
