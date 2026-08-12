import { describe, expect, it } from 'vitest';
import { agentAvatarGeometry } from './agent-avatar';

describe('deterministic agent avatar', () => {
  it('returns identical geometry for the same pubkey and distinct geometry for another', () => {
    const first = agentAvatarGeometry('ab'.repeat(32));
    expect(agentAvatarGeometry('ab'.repeat(32))).toEqual(first);
    expect(agentAvatarGeometry('cd'.repeat(32))).not.toEqual(first);
    expect(first.hullVariant).toBeGreaterThanOrEqual(0);
    expect(first.hullVariant).toBeLessThan(6);
    expect(first.sensorVariant).toBeGreaterThanOrEqual(0);
    expect(first.sensorVariant).toBeLessThan(6);
  });

  it('spreads a group across unmistakable silhouette and sensor families', () => {
    const geometries = Array.from({ length: 24 }, (_, index) =>
      agentAvatarGeometry(index.toString(16).padStart(64, '0')),
    );
    expect(new Set(geometries.map((geometry) => geometry.hullVariant)).size).toBeGreaterThanOrEqual(
      5,
    );
    expect(
      new Set(geometries.map((geometry) => geometry.sensorVariant)).size,
    ).toBeGreaterThanOrEqual(5);
    expect(
      new Set(geometries.map((geometry) => `${geometry.hullVariant}:${geometry.sensorVariant}`))
        .size,
    ).toBeGreaterThanOrEqual(12);
  });
});
