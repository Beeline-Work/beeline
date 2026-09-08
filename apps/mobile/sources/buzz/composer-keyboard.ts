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
