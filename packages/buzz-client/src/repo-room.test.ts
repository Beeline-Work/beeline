import { describe, expect, it } from 'vitest';
import { repositoryRoomId } from './repo-room.js';
import type { RepositoryBinding } from './types.js';

const binding: RepositoryBinding = {
  key: 'a'.repeat(64),
  name: 'project',
  remote: 'git://example.com/team/project',
  localOnly: false,
};

describe('repository Room identity', () => {
  it('converges matching repo clones within one Workspace', () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    expect(repositoryRoomId(workspace, binding)).toBe(repositoryRoomId(workspace, { ...binding }));
    expect(repositoryRoomId(workspace, binding)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('does not converge the same repo across Workspaces', () => {
    expect(repositoryRoomId('11111111-1111-4111-8111-111111111111', binding)).not.toBe(
      repositoryRoomId('22222222-2222-4222-8222-222222222222', binding),
    );
  });
});
