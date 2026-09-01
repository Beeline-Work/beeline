import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { signEvent } from '@beeline/nostr';
import {
  KIND_STREAM_MESSAGE,
  TAG_COMMUNITY_INVITE,
  createIdentity,
  inviteTokenHash,
} from '@beeline/buzz-client';
import {
  buildCommunityInviteUrl,
  createCommunityInviteUrl,
  loadCommunityInvitePreview,
  parseCommunityInviteToken,
  resolveCommunityInviteRelayUrl,
} from './community-invite';

const buzzClientMocks = vi.hoisted(() => ({
  createBuzzClient: vi.fn(),
  findCommunityInvite: vi.fn(),
}));

vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  return {
    ...actual,
    createBuzzClient: buzzClientMocks.createBuzzClient,
    findCommunityInvite: buzzClientMocks.findCommunityInvite,
  };
});

const token = `bzi_${'ab'.repeat(32)}`;

beforeEach(() => {
  buzzClientMocks.createBuzzClient.mockReset();
  buzzClientMocks.findCommunityInvite.mockReset();
});

describe('community invite links', () => {
  it('loads the signed-in monolith Workspace rail from the phone read surface', () => {
    const source = readFileSync(new URL('../app/(app)/join/[token].tsx', import.meta.url), 'utf8');
    const monolithBranch = source.slice(
      source.indexOf('if (getBuzzRuntimeConfig().monolithEnabled) {'),
      source.indexOf('if (!cancelled) {'),
    );
    expect(monolithBranch).toContain('.workspaces()');
    expect(monolithBranch).toContain('view.workspaces.map(workspaceRailItem)');
    expect(monolithBranch.indexOf('.workspaces()')).toBeLessThan(
      monolithBranch.indexOf('createBuzzClient'),
    );
  });

  it('builds the public join URL from the configured relay origin', () => {
    expect(buildCommunityInviteUrl(token, 'https://usebeeline.app')).toBe(
      `https://usebeeline.app/join/${token}`,
    );
    expect(buildCommunityInviteUrl(token, 'http://127.0.0.1:3010/')).toBe(
      `http://127.0.0.1:3010/join/${token}`,
    );
  });

  it('reuses the client invite flow and returns its shareable URL', async () => {
    const createInvite = vi.fn().mockResolvedValue({ token });

    await expect(
      createCommunityInviteUrl(
        { createInvite },
        'community-123',
        'https://usebeeline.app',
      ),
    ).resolves.toBe(`https://usebeeline.app/join/${token}`);
    expect(createInvite).toHaveBeenCalledWith('community-123');
  });

  it('accepts public, custom-scheme, and raw invite values', () => {
    expect(parseCommunityInviteToken(token)).toBe(token);
    expect(parseCommunityInviteToken(`https://usebeeline.app/join/${token}`)).toBe(token);
    expect(parseCommunityInviteToken(`https://relay.buzzrouter.com/join/${token}`)).toBe(token);
    expect(parseCommunityInviteToken(`http://127.0.0.1:3010/join/${token}`)).toBe(token);
    expect(parseCommunityInviteToken(`beeline://join/${token}`)).toBe(token);
  });

  it('rejects unrelated routes and malformed tokens', () => {
    expect(parseCommunityInviteToken(`https://example.com/invite/${token}`)).toBeNull();
    expect(parseCommunityInviteToken(`buzzy://join/${token}`)).toBeNull();
    expect(parseCommunityInviteToken(`buzzy-preview://join/${token}`)).toBeNull();
    expect(parseCommunityInviteToken(`buzzy-dev://join/${token}`)).toBeNull();
    expect(parseCommunityInviteToken(`buzzy-nightly://join/${token}`)).toBeNull();
    expect(parseCommunityInviteToken('bzi_short')).toBeNull();
    expect(parseCommunityInviteToken(undefined)).toBeNull();
  });

  it('uses either production invite origin instead of a stale configured relay', () => {
    expect(
      resolveCommunityInviteRelayUrl(
        `https://usebeeline.app/join/${token}`,
        token,
        'https://relay.buzzrouter.com',
      ),
    ).toBe('https://usebeeline.app');
    expect(
      resolveCommunityInviteRelayUrl(
        `https://relay.buzzrouter.com/join/${token}`,
        token,
        'http://10.0.2.2:3010',
      ),
    ).toBe('https://relay.buzzrouter.com');
    expect(
      resolveCommunityInviteRelayUrl(`beeline://join/${token}`, token, 'http://10.0.2.2:3010'),
    ).toBe('http://10.0.2.2:3010');
    expect(
      resolveCommunityInviteRelayUrl(
        `https://relay.example/join/bzi_${'cd'.repeat(32)}`,
        token,
        'https://usebeeline.app',
      ),
    ).toBe('https://usebeeline.app');
  });

  it('signs the initial invite preview query with its reader identity', async () => {
    const reader = createIdentity('invite-reader');
    const owner = createIdentity('invite-owner');
    const communityId = 'workspace-123';
    const createdAt = Math.floor(Date.now() / 1000);
    const inviteEvent = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: createdAt,
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ['h', communityId],
          ['t', TAG_COMMUNITY_INVITE],
          ['d', inviteTokenHash(token)],
          ['community', communityId],
          ['expiration', String(createdAt + 3600)],
        ],
        content: '',
      },
      owner.secretKey,
    );
    const community = {
      communityId,
      name: 'NIP-98 Workspace',
      createdBy: owner.publicKey,
      ownerPubkey: owner.publicKey,
      createdAt,
      raw: inviteEvent,
    };
    const client = {
      getCommunity: vi.fn().mockResolvedValue(community),
      communityMembers: vi.fn().mockResolvedValue([
        { pubkey: owner.publicKey, role: 'owner' },
      ]),
    };
    buzzClientMocks.findCommunityInvite.mockResolvedValue({
      tokenHash: inviteTokenHash(token),
      communityId,
      expiresAt: createdAt + 3600,
      mintedBy: owner.publicKey,
      event: inviteEvent,
    });
    buzzClientMocks.createBuzzClient.mockReturnValue(client);

    await expect(
      loadCommunityInvitePreview('https://relay.example/', token, reader),
    ).resolves.toMatchObject({ community });

    expect(buzzClientMocks.findCommunityInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://relay.example',
        host: 'relay.example',
        identity: reader,
      }),
      inviteTokenHash(token),
      reader.publicKey,
    );
    expect(buzzClientMocks.createBuzzClient).toHaveBeenCalledWith({
      baseUrl: 'https://relay.example',
      host: 'relay.example',
      identity: reader,
    });

    buzzClientMocks.findCommunityInvite.mockClear();
    buzzClientMocks.createBuzzClient.mockClear();
    await loadCommunityInvitePreview('https://relay.example/', token);
    const [httpOptions, , queryPubkey] = buzzClientMocks.findCommunityInvite.mock.calls[0]!;
    expect(httpOptions.identity).toMatchObject({ publicKey: queryPubkey });
    expect(httpOptions.identity.secretKey).toBeInstanceOf(Uint8Array);
    expect(buzzClientMocks.createBuzzClient).toHaveBeenCalledWith({
      baseUrl: 'https://relay.example',
      host: 'relay.example',
      identity: httpOptions.identity,
    });
  });
});
