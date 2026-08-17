import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FONT_DIRECTION_ID,
  FONT_DIRECTIONS,
  fontDirection,
  readActiveFontDirectionId,
} from './font-exploration';

const assetModule = readFileSync(new URL('./font-exploration-assets.ts', import.meta.url), 'utf8');
const rootLayout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');

function familiesOf(): string[] {
  return FONT_DIRECTIONS.flatMap((direction) => [
    direction.body.regular,
    direction.body.italic,
    direction.body.semiBold,
    direction.mono.regular,
    direction.mono.italic,
    direction.mono.semiBold,
  ]);
}

describe('font exploration directions', () => {
  it('registers every family a direction can ask for', () => {
    // A family that is named but never handed to Fonts.loadAsync silently falls
    // back to the platform font, which would make a candidate look worse than
    // it is in a screenshot the captain is judging.
    for (const family of new Set(familiesOf())) {
      const registered =
        assetModule.includes(`'${family}':`) || rootLayout.includes(`'${family}':`);
      expect(registered, `${family} is never loaded`).toBe(true);
    }
  });

  it('names each direction and its licenses for the on-device toggle', () => {
    for (const direction of FONT_DIRECTIONS) {
      expect(direction.name.length, direction.id).toBeGreaterThan(0);
      expect(direction.blurb.length, direction.id).toBeGreaterThan(0);
      expect(direction.licenses, direction.id).toContain('OFL 1.1');
    }
  });

  it('falls back to the baseline direction outside the native runtime', () => {
    // No MMKV in a plain node test, so the guarded require yields no store and
    // Typography still resolves rather than failing to import.
    expect(readActiveFontDirectionId()).toBe(DEFAULT_FONT_DIRECTION_ID);
    expect(fontDirection('not-a-direction' as never).id).toBe(FONT_DIRECTIONS[0].id);
  });
});
