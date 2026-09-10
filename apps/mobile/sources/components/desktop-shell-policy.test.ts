import { describe, expect, it } from 'vitest';
import { showsDesktopSessionChrome, usesPersistentDesktopFrame } from './desktop-shell-policy';

describe('packaged desktop frame policy', () => {
  it('keeps the native desktop frame through compact, regular, and wide windows', () => {
    for (const tabletLayout of [false, true]) {
      expect(usesPersistentDesktopFrame(true, tabletLayout)).toBe(true);
    }
  });

  it('shows no authenticated chrome until a native desktop session exists', () => {
    expect(showsDesktopSessionChrome(true, false, 'checking')).toBe(false);
    expect(showsDesktopSessionChrome(true, false, 'signed-out')).toBe(false);
    expect(showsDesktopSessionChrome(true, false, 'signed-in')).toBe(true);
  });

  it('leaves the existing phone and tablet decision untouched outside Tauri', () => {
    expect(usesPersistentDesktopFrame(false, false)).toBe(false);
    expect(usesPersistentDesktopFrame(false, true)).toBe(true);
    expect(showsDesktopSessionChrome(false, false, 'signed-out')).toBe(false);
    expect(showsDesktopSessionChrome(false, true, 'signed-out')).toBe(true);
  });
});
