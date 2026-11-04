import { describe, expect, it } from 'vitest';
import { showsDesktopSessionChrome, usesPersistentDesktopFrame } from './desktop-shell-policy';

describe('packaged desktop frame policy', () => {
  it('uses the same width class as the Room deck in native and browser windows', () => {
    for (const inDesktopShell of [false, true]) {
      expect(usesPersistentDesktopFrame(inDesktopShell, false)).toBe(false);
      expect(usesPersistentDesktopFrame(inDesktopShell, true)).toBe(true);
    }
  });

  it('shows no authenticated chrome until a native desktop session exists', () => {
    expect(showsDesktopSessionChrome(true, true, 'checking')).toBe(false);
    expect(showsDesktopSessionChrome(true, true, 'signed-out')).toBe(false);
    expect(showsDesktopSessionChrome(true, true, 'signed-in')).toBe(true);
  });

  it('does not overlay desktop session chrome on a compact native screen', () => {
    for (const session of ['checking', 'signed-out', 'signed-in'] as const) {
      expect(showsDesktopSessionChrome(true, false, session)).toBe(false);
    }
  });

  it('leaves the existing phone and tablet decision untouched outside Tauri', () => {
    expect(usesPersistentDesktopFrame(false, false)).toBe(false);
    expect(usesPersistentDesktopFrame(false, true)).toBe(true);
    expect(showsDesktopSessionChrome(false, false, 'signed-out')).toBe(false);
    expect(showsDesktopSessionChrome(false, true, 'signed-out')).toBe(true);
  });
});
