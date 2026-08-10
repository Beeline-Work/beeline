import { describe, expect, it } from 'vitest';
import { workspaceAvatarGeometry } from './workspace-avatar';

describe('deterministic Workspace avatar', () => {
  it('returns identical geometry for the same id and distinct geometry for another', () => {
    const first = workspaceAvatarGeometry('11111111-1111-4111-8111-111111111111');
    expect(workspaceAvatarGeometry('11111111-1111-4111-8111-111111111111')).toEqual(first);
    expect(workspaceAvatarGeometry('22222222-2222-4222-8222-222222222222')).not.toEqual(first);
    expect(first.rotation % 60).toBe(0);
    expect(first.filledMask & (1 << first.accentIndex)).not.toBe(0);
  });
});
