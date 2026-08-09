import { describe, expect, it } from 'vitest';
import { agentAvatarGeometry } from './agent-avatar';

describe('deterministic agent avatar', () => {
  it('returns identical geometry for the same pubkey and distinct geometry for another', () => {
    const first = agentAvatarGeometry('ab'.repeat(32));
    expect(agentAvatarGeometry('ab'.repeat(32))).toEqual(first);
    expect(agentAvatarGeometry('cd'.repeat(32))).not.toEqual(first);
    expect(first.rotation % 45).toBe(0);
  });
});
