import { describe, expect, it } from 'vitest';
import { agentAvatarGeometry } from './agent-avatar';

describe('deterministic agent avatar', () => {
  it('returns identical geometry for the same pubkey and distinct geometry for another', () => {
    const first = agentAvatarGeometry('ab'.repeat(32));
    expect(agentAvatarGeometry('ab'.repeat(32))).toEqual(first);
    expect(agentAvatarGeometry('cd'.repeat(32))).not.toEqual(first);
    expect(first.bodyVariant).toBeGreaterThanOrEqual(0);
    expect(first.bodyVariant).toBeLessThan(3);
    expect(first.wingVariant).toBeGreaterThanOrEqual(0);
    expect(first.wingVariant).toBeLessThan(3);
    expect(first.stripeCount).toBeGreaterThanOrEqual(2);
    expect(first.stripeCount).toBeLessThanOrEqual(4);
    expect(first.rotation).toBeGreaterThanOrEqual(-8);
    expect(first.rotation).toBeLessThanOrEqual(8);
  });

  it('spreads a group across bee silhouettes, wings, and stripe rhythms', () => {
    const geometries = Array.from({ length: 24 }, (_, index) =>
      agentAvatarGeometry(index.toString(16).padStart(64, '0')),
    );
    expect(new Set(geometries.map((geometry) => geometry.bodyVariant)).size).toBe(3);
    expect(new Set(geometries.map((geometry) => geometry.wingVariant)).size).toBe(3);
    expect(new Set(geometries.map((geometry) => geometry.stripeCount)).size).toBe(3);
    expect(
      new Set(
        geometries.map(
          (geometry) =>
            `${geometry.bodyVariant}:${geometry.wingVariant}:${geometry.stripeCount}:${geometry.rotation}`,
        ),
      ).size,
    ).toBeGreaterThanOrEqual(12);
  });
});
