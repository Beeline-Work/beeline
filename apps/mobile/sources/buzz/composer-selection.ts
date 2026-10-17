type Selection = { start: number; end: number };
type Composer = {
  focus(): void;
  setNativeProps?: (props: { selection: Selection }) => void;
  setSelectionRange?: (start: number, end: number) => void;
};

/** Restore the cursor after an explicit composer replacement. */
export function focusComposerSelection(composer: Composer | null, selection: Selection, platform: string): void {
  if (platform === 'web') {
    composer?.setSelectionRange?.(selection.start, selection.end);
    composer?.focus();
  } else {
    composer?.focus();
    composer?.setNativeProps?.({ selection });
  }
}
