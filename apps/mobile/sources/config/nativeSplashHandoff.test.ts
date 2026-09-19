import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');

describe('native splash handoff', () => {
  it('hands directly from the OS splash to the real app tree', () => {
    expect(layout).toContain('SplashScreen.preventAutoHideAsync()');
    expect(layout).toContain('if (initialized) hideNativeSplash()');
    expect(layout).toContain('if (!initialized) return null');
    expect(layout).not.toContain('BootPaint');
    expect(layout).not.toContain('painted');
    expect(layout).not.toContain('PixelLoader');
  });
});
