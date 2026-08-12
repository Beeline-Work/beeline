import { describe, expect, it } from 'vitest';
import { personAvatarGeometry } from './person-avatar';

describe('deterministic person avatar', () => {
  it('is stable per pubkey and structurally different from another person', () => {
    const first = personAvatarGeometry('ab'.repeat(32));
    expect(personAvatarGeometry('ab'.repeat(32))).toEqual(first);
    expect(personAvatarGeometry('cd'.repeat(32))).not.toEqual(first);
    expect(first.petalCount).toBeGreaterThanOrEqual(5);
    expect(first.petalCount).toBeLessThanOrEqual(8);
    expect(first.petalLength).toBeGreaterThanOrEqual(27);
    expect(first.petalWidth).toBeGreaterThanOrEqual(15);
  });

  it('spreads people across distinct flower structures', () => {
    const geometries = Array.from({ length: 32 }, (_, index) =>
      personAvatarGeometry(index.toString(16).padStart(64, '0')),
    );
    expect(new Set(geometries.map((geometry) => geometry.petalCount)).size).toBe(4);
    expect(new Set(geometries.map((geometry) => geometry.petalTone)).size).toBe(2);
    expect(
      new Set(
        geometries.map(
          (geometry) =>
            `${geometry.petalCount}:${geometry.petalLength}:${geometry.petalWidth}:${geometry.rotation}`,
        ),
      ).size,
    ).toBeGreaterThanOrEqual(16);
  });
});
