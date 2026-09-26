/**
 * What a composer-fill request — a starter prompt, a catch-up ask — should do.
 *
 * Words somebody typed are never overwritten, because the composer has no
 * undo. A caller with nothing else to show for the tap asks for
 * `focusOnRefusal`, so a refused fill still brings the person to the draft
 * they already have instead of doing nothing at all; a caller whose own
 * surface stays on screen (a sheet) leaves it off.
 */
export type ComposerMention = { readonly handle: string; readonly pubkey: string };

export type ComposerFillPlan = {
  readonly focus: boolean;
  readonly fill:
    | {
        readonly text: string;
        readonly selection: { readonly start: number; readonly end: number };
        readonly mention?: ComposerMention;
      }
    | null;
};

export function planComposerFill(input: {
  readonly draft: string;
  readonly text: string;
  readonly mention?: ComposerMention;
  readonly focusOnRefusal?: boolean;
}): ComposerFillPlan {
  if (input.draft.trim()) return { focus: Boolean(input.focusOnRefusal), fill: null };
  const handle = input.mention?.handle.replace(/^@/, '');
  return {
    focus: true,
    fill: {
      text: input.text,
      selection: { start: input.text.length, end: input.text.length },
      ...(handle && input.mention ? { mention: { handle, pubkey: input.mention.pubkey } } : {}),
    },
  };
}
