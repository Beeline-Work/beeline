import { describe, expect, it, vi } from 'vitest';
import {
  buildCommunityInviteUrl,
  createCommunityInviteUrl,
  parseCommunityInviteToken,
} from './community-invite';

const token = `bzi_${'ab'.repeat(32)}`;

describe('community invite links', () => {
  it('builds the public join URL from the configured relay origin', () => {
    expect(buildCommunityInviteUrl(token, 'https://relay.buzzrouter.com')).toBe(
      `https://relay.buzzrouter.com/join/${token}`,
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
        'https://relay.buzzrouter.com',
      ),
    ).resolves.toBe(`https://relay.buzzrouter.com/join/${token}`);
    expect(createInvite).toHaveBeenCalledWith('community-123');
  });

  it('accepts public, custom-scheme, and raw invite values', () => {
    expect(parseCommunityInviteToken(token)).toBe(token);
    expect(parseCommunityInviteToken(`https://relay.buzzrouter.com/join/${token}`)).toBe(token);
    expect(parseCommunityInviteToken(`http://127.0.0.1:3010/join/${token}`)).toBe(token);
    expect(parseCommunityInviteToken(`buzzy://join/${token}`)).toBe(token);
  });

  it('rejects unrelated routes and malformed tokens', () => {
    expect(parseCommunityInviteToken(`https://example.com/invite/${token}`)).toBeNull();
    expect(parseCommunityInviteToken('bzi_short')).toBeNull();
    expect(parseCommunityInviteToken(undefined)).toBeNull();
  });
});
