/**
 * The mention picker is the only composer feature allowed to consume a key.
 * Keeping this whitelist separate from the TextInput event makes printable
 * punctuation (notably `>`, used in commands and quoted text) an explicit
 * pass-through rather than an accidental participant in picker handling.
 */
export type MentionKeyboardAction = 'select' | 'next' | 'previous' | 'dismiss';

export function mentionKeyboardAction(key: string): MentionKeyboardAction | null {
  switch (key) {
    case 'Enter':
      return 'select';
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Escape':
    case 'Esc':
      return 'dismiss';
    default:
      return null;
  }
}

/**
 * How a drag on the transcript treats the composer keyboard. iOS users expect
 * the keyboard to track the finger and stay dismissible mid-drag, which is
 * what `interactive` gives; every other platform has no such gesture and drops
 * the keyboard as soon as the drag begins.
 */
export type TranscriptKeyboardDismissMode = 'interactive' | 'on-drag';

export function transcriptKeyboardDismissMode(os: string): TranscriptKeyboardDismissMode {
  return os === 'ios' ? 'interactive' : 'on-drag';
}

const COMPOSER_EDGE_GAP = 8;

/**
 * The software keyboard already covers the device's bottom unsafe area. Keep
 * the home-indicator/navigation inset while the keyboard is closed, then use
 * only the ordinary composer gap while it is open. Interpolate from the same
 * progress value that moves the keyboard-avoiding view so Android does not
 * snap this inset at keyboardWillShow/keyboardDidHide and visibly overshoot.
 */
export function composerBottomPadding(
  os: string,
  safeAreaBottom: number,
  keyboardProgress: number,
): number {
  'worklet';
  const closedPadding =
    os === 'android'
      ? safeAreaBottom + COMPOSER_EDGE_GAP
      : Math.max(safeAreaBottom, COMPOSER_EDGE_GAP);
  const progress = Math.max(0, Math.min(keyboardProgress, 1));
  return closedPadding + (COMPOSER_EDGE_GAP - closedPadding) * progress;
}
