import { beforeEach, describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({
  getChannelCreator: vi.fn(),
  isMember: vi.fn(),
  resolveRoomRepository: vi.fn(),
}));

vi.mock('@beeline/buzz-client', () => relay);

import { createGitHubRoomTokenAuthority } from './github-room-authority.js';
import type { AuthTenant } from './server.js';

// Captured read-only from production on 2026-08-21. The relay hosts both SQL
// communities, while this Room's client-authored kind:9007 `community` tag is
// a6814772-1f7f-4a59-850b-5579039efb17 and is deliberately not an authority.
const legacyRelayCommunityId = '3a47eeff-fdff-4a1e-9eb9-b48cb4ed90ed';
const roomCommunityId = 'e8299f28-f095-472f-941a-80d1195b9a24';
const roomId = '484556f2-7e81-4ad6-a851-0e57bdba6a67';
const agentPubkey = 'a3447f1163edeb8dff75a67c3492c808821fe21b8a0c35d363769e45efeca601';
const roomStore = {
  relayCommunityIdForRoom: vi.fn(),
  resolveCurrentPubkey: vi.fn(),
};
const tenant: AuthTenant = {
  host: 'relay.example',
  // This is deliberately not the Room UUID: production keeps its legacy
  // hostname here so identity links survive the public-host migration.
  community: 'legacy.relay.example',
  roomCommunityIds: [legacyRelayCommunityId, roomCommunityId],
  origin: 'https://relay.example',
};
const input = {
  agentPubkey,
  roomId,
  relayAuthorizations: Array.from({ length: 16 }, (_, index) => `proof-${index}`),
};

beforeEach(() => {
  roomStore.relayCommunityIdForRoom.mockReset().mockResolvedValue(roomCommunityId);
  // No succession recorded by default: the binding author IS the current key.
  roomStore.resolveCurrentPubkey.mockReset().mockImplementation(
    async (_community: string, pubkey: string) => pubkey,
  );
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
  it('uses the server-stamped SQL community instead of either client namespace', async () => {
    await expect(createGitHubRoomTokenAuthority(roomStore)(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: 'b'.repeat(64),
      currentAuthorizedBy: 'b'.repeat(64),
      fullName: 'acme/widget',
      githubInstallationId: 77,
    });
    expect(roomStore.relayCommunityIdForRoom).toHaveBeenCalledWith(roomId);
  });

  it('authorizes Rooms from either relay community served by one tenant', async () => {
    roomStore.relayCommunityIdForRoom.mockResolvedValue(legacyRelayCommunityId);

    await expect(createGitHubRoomTokenAuthority(roomStore)(tenant, input)).resolves.toMatchObject({
      authorized: true,
      fullName: 'acme/widget',
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

    await expect(createGitHubRoomTokenAuthority(roomStore)(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: 'c'.repeat(64),
      currentAuthorizedBy: 'c'.repeat(64),
      fullName: 'acme/widget',
    });
  });

  it('resolves a replaced binding author to its successor key for authority lookups', async () => {
    roomStore.resolveCurrentPubkey.mockResolvedValue('d'.repeat(64));

    await expect(createGitHubRoomTokenAuthority(roomStore)(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: 'b'.repeat(64),
      currentAuthorizedBy: 'd'.repeat(64),
      fullName: 'acme/widget',
      githubInstallationId: 77,
    });
    expect(roomStore.resolveCurrentPubkey).toHaveBeenCalledWith(
      tenant.community,
      'b'.repeat(64),
    );
  });

  it('keeps the raw author when succession resolution fails (pre-succession behavior)', async () => {
    roomStore.resolveCurrentPubkey.mockRejectedValue(new Error('ledger unavailable'));

    await expect(createGitHubRoomTokenAuthority(roomStore)(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: 'b'.repeat(64),
      currentAuthorizedBy: 'b'.repeat(64),
      fullName: 'acme/widget',
      githubInstallationId: 77,
    });
  });

  it.each([
    {
      name: 'Room belongs to another relay community',
      arrange: () => roomStore.relayCommunityIdForRoom.mockResolvedValue('another-community'),
      reason: 'tenant_room_community_mismatch',
    },
    {
      name: 'Room has no authoritative relay row',
      arrange: () => roomStore.relayCommunityIdForRoom.mockResolvedValue(null),
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

    await expect(createGitHubRoomTokenAuthority(roomStore)(tenant, input)).resolves.toEqual({
      authorized: false,
      reason,
    });
  });
});
