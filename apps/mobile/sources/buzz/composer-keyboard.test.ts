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
  it('keeps the Android edge gap above the safe area while the keyboard is closed', () => {
    expect(composerBottomPadding('android', 24, 0)).toBe(32);
    expect(composerBottomPadding('android', 0, 0)).toBe(8);
  });

  it('keeps the existing iOS safe-area spacing while the keyboard is closed', () => {
    expect(composerBottomPadding('ios', 34, 0)).toBe(34);
    expect(composerBottomPadding('ios', 0, 0)).toBe(8);
  });

  it('does not stack the device safe area above an open software keyboard', () => {
    expect(composerBottomPadding('android', 24, 301)).toBe(8);
    expect(composerBottomPadding('ios', 34, 301)).toBe(8);
  });
});
