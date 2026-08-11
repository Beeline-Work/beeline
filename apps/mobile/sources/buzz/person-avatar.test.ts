import { describe, expect, it } from 'vitest';
import { personAvatarGeometry } from './person-avatar';

describe('deterministic person avatar', () => {
  it('is stable per pubkey and structurally different from another person', () => {
    const first = personAvatarGeometry('ab'.repeat(32));
    expect(personAvatarGeometry('ab'.repeat(32))).toEqual(first);
    expect(personAvatarGeometry('cd'.repeat(32))).not.toEqual(first);
    expect(first.headWidth).toBeGreaterThanOrEqual(31);
    expect(first.eyeOffset).toBeGreaterThanOrEqual(8);
  });
});
