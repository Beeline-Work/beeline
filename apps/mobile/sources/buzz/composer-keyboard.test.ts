import { describe, expect, it } from 'vitest';
import {
  composerBottomPadding,
  mentionKeyboardAction,
  transcriptKeyboardDismissMode,
} from './composer-keyboard';

describe('composer mention keyboard handling', () => {
  it('consumes only picker controls', () => {
    expect(mentionKeyboardAction('Enter')).toBe('select');
    expect(mentionKeyboardAction('ArrowDown')).toBe('next');
    expect(mentionKeyboardAction('ArrowUp')).toBe('previous');
    expect(mentionKeyboardAction('Escape')).toBe('dismiss');
  });

  it('leaves printable punctuation, including >, to the text input', () => {
    expect(mentionKeyboardAction('>')).toBeNull();
    expect(mentionKeyboardAction('<')).toBeNull();
    expect(mentionKeyboardAction('/')).toBeNull();
  });
});

describe('transcript drag dismissal', () => {
  it('follows the finger on iOS and drops on the first drag elsewhere', () => {
    expect(transcriptKeyboardDismissMode('ios')).toBe('interactive');
    expect(transcriptKeyboardDismissMode('android')).toBe('on-drag');
    expect(transcriptKeyboardDismissMode('web')).toBe('on-drag');
  });
});

describe('composer bottom padding', () => {
  it('preserves the device safe area while the software keyboard is closed', () => {
    expect(composerBottomPadding(34, 0)).toBe(34);
    expect(composerBottomPadding(0, 0)).toBe(8);
  });

  it('does not stack the device safe area above an open software keyboard', () => {
    expect(composerBottomPadding(34, 301)).toBe(8);
    expect(composerBottomPadding(0, 301)).toBe(8);
  });
});
