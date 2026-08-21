import { beforeEach, describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({
  getChannelCommunityId: vi.fn(),
  getChannelCreator: vi.fn(),
  isMember: vi.fn(),
  resolveRoomRepository: vi.fn(),
}));

vi.mock('@beeline/buzz-client', () => relay);

import { createGitHubRoomTokenAuthority } from './github-room-authority.js';
import type { AuthTenant } from './server.js';

const roomCommunityId = '11111111-1111-4111-8111-111111111111';
const tenant: AuthTenant = {
  host: 'relay.example',
  // This is deliberately not the Room UUID: production keeps its legacy
  // hostname here so identity links survive the public-host migration.
  community: 'legacy.relay.example',
  roomCommunityId,
  origin: 'https://relay.example',
};
const input = {
  agentPubkey: 'a'.repeat(64),
  roomId: 'room-1',
  relayAuthorizations: Array.from({ length: 16 }, (_, index) => `proof-${index}`),
};

beforeEach(() => {
  relay.getChannelCommunityId.mockReset().mockResolvedValue(roomCommunityId);
  relay.isMember.mockReset().mockResolvedValue(true);
  relay.resolveRoomRepository.mockReset().mockResolvedValue({
    binding: {
      key: 'github:42',
      name: 'widget',
      remote: 'git://github.com/acme/widget',
      githubInstallationId: 77,
      localOnly: false,
    },
    authoredBy: 'b'.repeat(64),
  });
  relay.getChannelCreator.mockReset().mockResolvedValue('c'.repeat(64));
});

describe('GitHub Room token authority', () => {
  it('uses the relay Room UUID instead of the durable identity-link namespace', async () => {
    await expect(createGitHubRoomTokenAuthority()(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: 'b'.repeat(64),
      fullName: 'acme/widget',
      githubInstallationId: 77,
    });
  });

  it('falls back to the current channel creator when the repository event has no author', async () => {
    relay.resolveRoomRepository.mockResolvedValue({
      binding: {
        key: 'github:42',
        name: 'widget',
        remote: 'git://github.com/acme/widget',
        localOnly: false,
      },
    });

    await expect(createGitHubRoomTokenAuthority()(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: 'c'.repeat(64),
      fullName: 'acme/widget',
    });
  });

  it.each([
    {
      name: 'Room belongs to another relay community',
      arrange: () => relay.getChannelCommunityId.mockResolvedValue('another-community'),
      reason: 'tenant_room_community_mismatch',
    },
    {
      name: 'agent is not a current Room member',
      arrange: () => relay.isMember.mockResolvedValue(false),
      reason: 'agent_not_room_member',
    },
    {
      name: 'Room has no resolvable repository binding',
      arrange: () => relay.resolveRoomRepository.mockResolvedValue(null),
      reason: 'room_repository_missing',
    },
    {
      name: 'Room repository remote is malformed',
      arrange: () =>
        relay.resolveRoomRepository.mockResolvedValue({
          binding: {
            key: 'github:42',
            name: 'widget',
            remote: 'https://github.com/acme/widget',
            localOnly: false,
          },
          authoredBy: 'b'.repeat(64),
        }),
      reason: 'room_repository_remote_malformed',
    },
    {
      name: 'Room repository has no human authority',
      arrange: () => {
        relay.resolveRoomRepository.mockResolvedValue({
          binding: {
            key: 'github:42',
            name: 'widget',
            remote: 'git://github.com/acme/widget',
            localOnly: false,
          },
        });
        relay.getChannelCreator.mockResolvedValue(null);
      },
      reason: 'room_repository_authority_missing',
    },
  ])('returns a distinct reason when $name', async ({ arrange, reason }) => {
    arrange();

    await expect(createGitHubRoomTokenAuthority()(tenant, input)).resolves.toEqual({
      authorized: false,
      reason,
    });
  });
});
